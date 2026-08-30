"""QuickBooks Online connection + invoice push routes.

    GET  /api/qbo/connect            → admin starts OAuth (redirect to Intuit)
    GET  /api/qbo/callback           → Intuit redirects back; persist the
                                        company-wide connection (encrypted)
    POST /api/qbo/disconnect         → admin disconnects (revoke + delete row)
    GET  /api/qbo/status             → non-secret connection status
    POST /api/qbo/accounts/refresh   → admin re-fetches the Income account list
                                        (cached on the connection row; no
                                        background sync — explicit button only)
    POST /api/qbo/invoices/{id}/push → admin pushes/updates an invoice in QB

OAuth reuses the Authlib client registered in backend/main.py (app.state.oauth)
under the name "intuit", exactly like the Google flow in routes/auth.py — same
signed-cookie state/nonce CSRF protection. The single difference from Gmail is
that this connection is COMPANY-WIDE (one realm), not per-user, so it lives in
the qbo_connection singleton table.

Security notes:
  - connect / disconnect / push are admin-only (require_admin).
  - the callback additionally re-asserts an admin session so a stranger can't
    complete a half-finished flow, and validates realmId is present.
  - /status returns booleans + masked metadata only — never tokens.
  - the push endpoint RETURNS error responses (rather than raising) so the
    failure activity stamp commits with the request transaction.
"""
import os
import re
from datetime import date as _date, datetime, timedelta, timezone

from authlib.integrations.starlette_client import OAuthError
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend import crypto, livesync, models, payouts, qbo_payouts, qbo_sync, quickbooks, webpush
from backend.auth_deps import require_admin, require_session
from backend.database import get_db


qbo_router = APIRouter(prefix="/api/qbo", tags=["quickbooks"])


# Default refresh-token lifetime if Intuit doesn't return x_refresh_token_expires_in
# (it normally does — ~8726400s ≈ 101 days).
_DEFAULT_REFRESH_TTL_SECONDS = 100 * 24 * 3600


def _qbo_environment() -> str:
    env = (os.environ.get("QBO_ENVIRONMENT", "sandbox") or "sandbox").strip().lower()
    return "production" if env in ("production", "prod") else "sandbox"


# ── OAuth: connect ───────────────────────────────────────────────────────────

@qbo_router.get("/connect")
async def connect(request: Request, _admin: models.User = Depends(require_admin)):
    """Admin-only. Redirect the browser to Intuit's authorize page. Authlib
    stores state + nonce in the signed Starlette session cookie (CSRF)."""
    oauth = request.app.state.oauth
    redirect_uri = os.environ.get("QBO_REDIRECT_URI", "")
    if not redirect_uri:
        raise HTTPException(status_code=500, detail="QBO_REDIRECT_URI is not configured on the server")
    if not os.environ.get("QBO_CLIENT_ID"):
        raise HTTPException(status_code=500, detail="QBO_CLIENT_ID is not configured on the server")
    return await oauth.intuit.authorize_redirect(request, redirect_uri)


# ── OAuth: callback ──────────────────────────────────────────────────────────

@qbo_router.get("/callback")
async def callback(
    request: Request,
    db: AsyncSession = Depends(get_db),
    admin: models.User = Depends(require_admin),
):
    """Intuit redirects here with ?code=...&realmId=...&state=.... Validate the
    state (Authlib), then persist the company-wide connection with the tokens
    encrypted at rest."""
    oauth = request.app.state.oauth
    try:
        token = await oauth.intuit.authorize_access_token(request)
    except OAuthError:
        # State mismatch / user denied — bounce back to Settings with a flag.
        return RedirectResponse(url="/#/settings?qbo=error", status_code=302)

    realm_id = request.query_params.get("realmId")
    if not realm_id:
        return RedirectResponse(url="/#/settings?qbo=error", status_code=302)

    access_token = token.get("access_token")
    refresh_token = token.get("refresh_token")
    if not access_token or not refresh_token:
        return RedirectResponse(url="/#/settings?qbo=error", status_code=302)

    now = datetime.now(timezone.utc)
    access_expires = now + timedelta(seconds=int(token.get("expires_in", 3600)))
    refresh_ttl = int(token.get("x_refresh_token_expires_in", _DEFAULT_REFRESH_TTL_SECONDS))
    refresh_expires = now + timedelta(seconds=refresh_ttl)

    result = await db.execute(select(models.QboConnection).where(models.QboConnection.id == 1))
    conn = result.scalar_one_or_none()
    if conn is not None and conn.realm_id and conn.realm_id != str(realm_id):
        # Realm pinning: an existing connection is bound to ONE QuickBooks
        # company. Refuse to silently re-point it to a different realmId — a
        # crafted/replayed callback could otherwise swap which company we sync
        # to. Require an explicit Disconnect first. SECURITY_REVIEW.md H9.
        print(f"[LTP] qbo: callback realmId mismatch "
              f"(bound …{conn.realm_id[-4:]}, got …{str(realm_id)[-4:]}); refusing",
              flush=True)
        return RedirectResponse(url="/#/settings?qbo=realm_mismatch", status_code=302)
    if conn is None:
        conn = models.QboConnection(id=1)
        db.add(conn)
    conn.realm_id = str(realm_id)
    conn.access_token_enc = crypto.encrypt_token(access_token)
    conn.refresh_token_enc = crypto.encrypt_token(refresh_token)
    conn.access_token_expires_at = access_expires
    conn.refresh_token_expires_at = refresh_expires
    conn.environment = _qbo_environment()
    conn.connected_by_user_id = admin.id
    # A fresh (re)connection retires any stale connection error so the Settings
    # Error Log reflects the healthy state immediately, not next poll cycle.
    conn.last_error = None
    conn.last_error_at = None
    await db.flush()

    return RedirectResponse(url="/#/settings?qbo=connected", status_code=302)


# ── Disconnect ───────────────────────────────────────────────────────────────

@qbo_router.post("/disconnect")
async def disconnect(
    db: AsyncSession = Depends(get_db),
    _admin: models.User = Depends(require_admin),
):
    """Admin-only. Best-effort revoke the token at Intuit, then delete the
    connection row. Idempotent (works whether connected or not)."""
    result = await db.execute(select(models.QboConnection).where(models.QboConnection.id == 1))
    conn = result.scalar_one_or_none()
    if conn is None:
        return {"ok": True, "connected": False}
    client_id, client_secret = qbo_sync.creds()
    await quickbooks.revoke(conn, db, client_id=client_id, client_secret=client_secret)
    await db.delete(conn)
    await db.flush()
    return {"ok": True, "connected": False}


# ── Status ───────────────────────────────────────────────────────────────────

@qbo_router.get("/status")
async def status(
    db: AsyncSession = Depends(get_db),
    _user: models.User = Depends(require_session),
):
    """Non-secret connection status for the Settings panel + the invoice UI
    gate. Never returns tokens or the full realm id."""
    result = await db.execute(select(models.QboConnection).where(models.QboConnection.id == 1))
    conn = result.scalar_one_or_none()
    if conn is None:
        return {"connected": False, "configured": bool(os.environ.get("QBO_CLIENT_ID"))}

    now = datetime.now(timezone.utc)
    refresh_exp = quickbooks._aware(conn.refresh_token_expires_at)
    needs_reconnect = refresh_exp is not None and refresh_exp <= now

    connected_by = None
    sender_gmail_connected = False
    if conn.connected_by_user_id:
        r = await db.execute(select(models.User).where(models.User.id == conn.connected_by_user_id))
        u = r.scalar_one_or_none()
        connected_by = u.name if u else None
        # Auto-receipts are emailed from this admin's Gmail (backend/qbo_receipts.py).
        sender_gmail_connected = bool(u and u.gmail_refresh_token)

    # Receipts that are paid-and-queued but waiting on the sender's Gmail
    # (the "cache the task until the connection is reestablished" state).
    pending_receipts = await db.scalar(
        select(func.count()).select_from(models.Invoice)
        .where(models.Invoice.receipt_email_status == "pending")
    )

    # Payout vendor-bill payment state (from the bill-payment poller).
    paid_bills = await db.scalar(
        select(func.count()).select_from(models.PayoutBill)
        .where(models.PayoutBill.qb_paid_at.isnot(None))
    )
    unpaid_bills = await db.scalar(
        select(func.count()).select_from(models.PayoutBill)
        .where(models.PayoutBill.qb_bill_id.isnot(None), models.PayoutBill.qb_paid_at.is_(None))
    )
    mismatch_bills = await db.scalar(
        select(func.count()).select_from(models.PayoutBill)
        .where(models.PayoutBill.qb_sync_status == "synced",
               models.PayoutBill.qb_total_amt.isnot(None),
               func.abs(models.PayoutBill.qb_total_amt - models.PayoutBill.amount) > 0.01)
    )
    # Recent payout vendor-bill FAULTS (sync errors + amount mismatches) for the
    # Settings → Error Log "QuickBooks Faults" panel. Payout bills aren't loaded
    # client-side (unlike invoices/quotes, which are activity-scanned there), so
    # surface their faults through /status instead.
    payout_errors = await _collect_payout_faults(db)

    realm = conn.realm_id or ""
    masked_realm = ("…" + realm[-4:]) if len(realm) > 4 else realm

    accounts_updated = quickbooks._aware(conn.income_accounts_updated_at)
    return {
        "connected": True,
        "configured": bool(os.environ.get("QBO_CLIENT_ID")),
        "environment": conn.environment,
        "realmMasked": masked_realm,
        "connectedBy": connected_by,
        "connectedAt": conn.connected_at.isoformat() if conn.connected_at else None,
        "accessTokenExpiresAt": quickbooks._aware(conn.access_token_expires_at).isoformat() if conn.access_token_expires_at else None,
        "refreshTokenExpiresAt": refresh_exp.isoformat() if refresh_exp else None,
        "needsReconnect": needs_reconnect,
        # Last connection-level error captured from a background context (chiefly
        # the auto-receipt poller). Shown in Settings → Error Log; null when the
        # last poll cycle was clean. Per-invoice sync failures live on the
        # invoice's own activity, not here.
        "lastError": conn.last_error or None,
        "lastErrorAt": quickbooks._aware(conn.last_error_at).isoformat() if conn.last_error_at else None,
        # Auto-receipt surface for the Settings panel.
        "senderGmailConnected": sender_gmail_connected,
        "pendingReceipts": int(pending_receipts or 0),
        # Payout vendor-bill payment state (bill-payment poller).
        "paidBills": int(paid_bills or 0),
        "unpaidBills": int(unpaid_bills or 0),
        "amountMismatchCount": int(mismatch_bills or 0),
        # Per-bill faults for the Error Log (same shape as the invoice/quote QB
        # faults collected client-side): {context, message, errorDetail, date, time}.
        "payoutErrors": payout_errors,
        # Admin-refreshed Income account list (feeds the mapping dropdowns in
        # Settings and the per-item pickers). [] until the first refresh.
        "incomeAccounts": conn.income_accounts or [],
        "incomeAccountsUpdatedAt": accounts_updated.isoformat() if accounts_updated else None,
        # Expense/COGS + Accounts-Payable account lists for the payout vendor-bill
        # mapping (default expense account, per-role overrides, AP account).
        "expenseAccounts": conn.expense_accounts or [],
        "apAccounts": conn.ap_accounts or [],
        "expenseAccountsUpdatedAt": quickbooks._aware(conn.expense_accounts_updated_at).isoformat() if conn.expense_accounts_updated_at else None,
    }


# ── Income accounts: explicit refresh ────────────────────────────────────────

@qbo_router.post("/accounts/refresh")
async def refresh_income_accounts(
    db: AsyncSession = Depends(get_db),
    _admin: models.User = Depends(require_admin),
):
    """Admin-only. Re-fetch the QB company's active Income accounts (for invoice
    item mapping) PLUS the Expense/COGS and Accounts-Payable accounts (for the
    payout vendor-bill mapping), caching all three on the connection row.
    Deliberately button-driven (no background sync): the chart of accounts is
    near-static, so the lists refresh only when an admin asks."""
    client_id, client_secret = qbo_sync.creds()
    try:
        conn = await quickbooks.load_connection(db)
        raw_income = await quickbooks.list_income_accounts(
            conn, db, client_id=client_id, client_secret=client_secret)
        raw_expense = await quickbooks.list_expense_accounts(
            conn, db, client_id=client_id, client_secret=client_secret)
        raw_ap = await quickbooks.list_ap_accounts(
            conn, db, client_id=client_id, client_secret=client_secret)
    except quickbooks.QboNotConnected:
        return JSONResponse(status_code=409, content={"reason": "not_connected",
                            "error": "QuickBooks is not connected. Connect it in Settings."})
    except quickbooks.QboReconnectRequired:
        return JSONResponse(status_code=409, content={"reason": "reconnect",
                            "error": "QuickBooks connection expired. Reconnect it in Settings."})
    except quickbooks.QboApiError as e:
        return JSONResponse(status_code=502, content={"reason": "qbo_error", "error": e.safe_message})

    def _norm(rows, with_type=False):
        out = []
        for a in rows:
            if a.get("Id") is None:
                continue
            item = {"id": str(a.get("Id")), "name": a.get("Name") or ""}
            if with_type:
                item["type"] = a.get("AccountType") or ""
            out.append(item)
        return out

    accounts = _norm(raw_income)
    now = datetime.now(timezone.utc)
    conn.income_accounts = accounts
    conn.income_accounts_updated_at = now
    conn.expense_accounts = _norm(raw_expense, with_type=True)
    conn.ap_accounts = _norm(raw_ap, with_type=True)
    conn.expense_accounts_updated_at = now
    await db.flush()
    return {
        "ok": True,
        "incomeAccounts": accounts,
        "incomeAccountsUpdatedAt": now.isoformat(),
        "expenseAccounts": conn.expense_accounts,
        "apAccounts": conn.ap_accounts,
        "expenseAccountsUpdatedAt": now.isoformat(),
    }


# ── Push an invoice ──────────────────────────────────────────────────────────

class PushRequest(BaseModel):
    # Opaque change-signature the frontend computes at push time. Stored verbatim
    # on the invoice so the builder shows "Update QuickBooks" only when its live
    # signature differs (i.e. something QB-relevant changed).
    signature: str | None = None


@qbo_router.post("/invoices/{invoice_id}/push")
async def push_invoice_route(
    invoice_id: int,
    body: PushRequest | None = None,
    db: AsyncSession = Depends(get_db),
    admin: models.User = Depends(require_admin),
):
    """Admin-only. Create or update this invoice in QuickBooks. Returns the
    sync result on success; on a QuickBooks error returns a structured error
    response (not raised) so the failure activity stamp commits with the
    request transaction."""
    result = await db.execute(select(models.Invoice).where(models.Invoice.id == invoice_id))
    invoice = result.scalar_one_or_none()
    if invoice is None:
        raise HTTPException(status_code=404, detail=f"invoice {invoice_id} not found")

    try:
        push_result = await qbo_sync.push_invoice(db, invoice, user=admin)
        if body and body.signature:
            invoice.qb_synced_signature = body.signature
            push_result["qbSyncedSignature"] = body.signature
        # A successful push writes the whole qb_* block plus an activity stamp on
        # the invoice row. Publishing it is what lets other windows pick up the
        # new sync state instead of waiting on the 30s sweep.
        livesync.mark_dirty(db, "invoices")
        return push_result
    except quickbooks.QboNotConnected:
        return JSONResponse(status_code=409, content={"reason": "not_connected",
                            "error": "QuickBooks is not connected. Connect it in Settings."})
    except quickbooks.QboReconnectRequired:
        return JSONResponse(status_code=409, content={"reason": "reconnect",
                            "error": "QuickBooks connection expired. Reconnect it in Settings."})
    except qbo_sync.InvoiceNotSyncable as e:
        return JSONResponse(status_code=400, content={"reason": "not_syncable", "error": str(e)})
    except quickbooks.QboApiError as e:
        # Record the failure on the invoice + stamp activity, then RETURN (so
        # get_db commits the stamp). qbo_sync flushed partial find-or-create
        # progress already; that's fine to keep.
        invoice.qb_sync_status = "error"
        invoice.qb_last_error = e.safe_message[:300]
        livesync.mark_dirty(db, "invoices")
        qbo_sync._stamp(invoice, admin, "qbo_sync_failed",
                        "QuickBooks sync failed",
                        [{"cat": "Error", "detail": e.safe_message[:300]}])
        return JSONResponse(status_code=502, content={"reason": "qbo_error", "error": e.safe_message})


class UnwindSendRequest(BaseModel):
    # The QB invoice the caller believes it created moments ago. The unwind is
    # refused if the row no longer points at it — someone else re-pushed in
    # between, and that invoice is not ours to delete.
    qbInvoiceId: str


@qbo_router.post("/invoices/{invoice_id}/unwind-send")
async def unwind_send_route(
    invoice_id: int,
    body: UnwindSendRequest,
    db: AsyncSession = Depends(get_db),
    admin: models.User = Depends(require_admin),
):
    """Admin-only. Undo a QuickBooks push whose send then failed.

    Sending a taxable invoice pushes to QuickBooks FIRST, because QuickBooks
    computes the sales tax and the emailed PDF is rendered from the saved row
    (see modules/invoices.js::executeSend). If the email then fails, that push
    has already created a live invoice in QuickBooks for a document nobody
    received. This deletes it and returns the row to never-pushed, so the failure
    leaves nothing behind to clean up by hand.

    The caller must only reach here when the push CREATED the invoice (never an
    update — that record pre-existed and is not ours to delete) and when the send
    definitively did not happen. A network error is not that: the server may have
    sent successfully and lost the response, so those are reported, not unwound.

    Unlike /delete, the local row survives — only its QuickBooks link is cleared.
    Idempotent, and safe to fail: a QB invoice that is already gone counts as
    deleted, and any other QuickBooks error leaves the link intact so the caller
    can tell the user exactly what is still out there.
    """
    result = await db.execute(select(models.Invoice).where(models.Invoice.id == invoice_id))
    invoice = result.scalar_one_or_none()
    if invoice is None:
        raise HTTPException(status_code=404, detail=f"invoice {invoice_id} not found")
    if not invoice.qb_invoice_id:
        return {"ok": True, "unwound": False, "reason": "not_synced"}
    if str(invoice.qb_invoice_id) != str(body.qbInvoiceId):
        return JSONResponse(status_code=409, content={
            "reason": "moved",
            "error": "This invoice now points at a different QuickBooks invoice; not deleting it.",
            "qbInvoiceId": invoice.qb_invoice_id,
        })

    deleted_id = invoice.qb_invoice_id
    try:
        await qbo_sync.delete_from_quickbooks(db, invoice)
    except quickbooks.QboNotConnected:
        return JSONResponse(status_code=409, content={"reason": "not_connected",
                            "error": "QuickBooks is not connected.", "qbInvoiceId": deleted_id})
    except quickbooks.QboReconnectRequired:
        return JSONResponse(status_code=409, content={"reason": "reconnect",
                            "error": "QuickBooks connection expired. Reconnect it in Settings.",
                            "qbInvoiceId": deleted_id})
    except quickbooks.QboApiError as e:
        return JSONResponse(status_code=502, content={"reason": "qbo_error",
                            "error": e.safe_message, "qbInvoiceId": deleted_id})

    # Back to never-pushed. Leaving any of these set would have the app believe
    # it is still synced to an invoice that no longer exists — the next push
    # would try to UPDATE a deleted id instead of creating a fresh invoice.
    invoice.qb_invoice_id = None
    invoice.qb_sync_token = None
    invoice.qb_sync_status = None
    invoice.qb_synced_at = None
    invoice.qb_synced_signature = None
    invoice.qb_last_error = None
    invoice.qb_tax_total = None
    invoice.qb_total_amt = None
    livesync.mark_dirty(db, "invoices")
    qbo_sync._stamp(invoice, admin, "qbo_unwound",
                    "QuickBooks export undone — the email failed, so the invoice was removed",
                    [{"cat": "QB Invoice Id", "detail": deleted_id}])
    return {"ok": True, "unwound": True, "qbInvoiceId": deleted_id}


@qbo_router.post("/invoices/{invoice_id}/delete")
async def delete_invoice_route(
    invoice_id: int,
    db: AsyncSession = Depends(get_db),
    admin: models.User = Depends(require_admin),
):
    """Admin-only. Delete this invoice's QuickBooks counterpart. The local row is
    deleted separately by the frontend (normal CRUD DELETE) once this succeeds.
    Idempotent — a not-yet-synced or already-gone invoice returns 200."""
    result = await db.execute(select(models.Invoice).where(models.Invoice.id == invoice_id))
    invoice = result.scalar_one_or_none()
    if invoice is None:
        raise HTTPException(status_code=404, detail=f"invoice {invoice_id} not found")
    try:
        return await qbo_sync.delete_from_quickbooks(db, invoice)
    except quickbooks.QboNotConnected:
        return JSONResponse(status_code=409, content={"reason": "not_connected",
                            "error": "QuickBooks is not connected."})
    except quickbooks.QboReconnectRequired:
        return JSONResponse(status_code=409, content={"reason": "reconnect",
                            "error": "QuickBooks connection expired. Reconnect it in Settings."})
    except quickbooks.QboApiError as e:
        return JSONResponse(status_code=502, content={"reason": "qbo_error", "error": e.safe_message})


# ── Export crew payouts as vendor bills ──────────────────────────────────────

class PayoutExportRequest(BaseModel):
    periodStart: str
    periodEnd: str
    contactIds: list[int] | None = None   # None/empty = all crew with a payout


# Strictest possible day-status window: a payout run bills bi-weekly, and even a
# long multi-period project spans well under a year. Bounding the caller-supplied
# range (day-status accepts an arbitrary project date span, so it can't go through
# _resolve_period) caps the O(periods × projects) re-derivation and blocks the
# "0000-01-01 … 9999-12-31" scrape/DoS an authenticated caller could otherwise send.
_DAY_STATUS_MAX_SPAN_DAYS = 400

_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _iso_date_or_none(s):
    """Parse a strict YYYY-MM-DD string to a date, or None if malformed. Rejects
    junk (slashes, times, out-of-range) before it can reach a query, a push body,
    or a notification string."""
    if not isinstance(s, str) or not _ISO_DATE_RE.match(s):
        return None
    try:
        return _date.fromisoformat(s)
    except ValueError:
        return None


async def _resolve_period(db, period_start, period_end):
    """Validate that (period_start, period_end) is exactly a pay period derived
    from Settings, and return its {start,end,index,pay_day,label}. Returns
    (None, message) if the pay period isn't configured or the range doesn't line
    up — the money always posts on real pay-period boundaries, never an ad-hoc
    window, and this catches client/server config drift."""
    anchor = await qbo_sync._settings_get(db, "payPeriodAnchor")
    if not anchor:
        return None, "Set the pay-period start date in Settings before exporting payouts."
    length = await qbo_sync._settings_get(db, "payPeriodLengthDays") or 14
    offset = await qbo_sync._settings_get(db, "payPeriodPayDayOffsetDays") or 0
    bounds = payouts.pay_period_bounds(anchor, length, period_start)
    if bounds is None:
        return None, "Invalid pay-period configuration — check the anchor date in Settings."
    if bounds["start"] != period_start or bounds["end"] != period_end:
        return None, "The selected range isn't a pay period — use the This/Last Pay Period presets."
    numbering = payouts.pay_period_number_in_year(anchor, length, bounds["index"]) or {}
    return {
        "start": bounds["start"], "end": bounds["end"], "index": bounds["index"],
        "pay_day": payouts.pay_period_pay_day(bounds["end"], offset),
        "label": payouts.pay_period_label(bounds["start"], bounds["end"]),
        "year": numbering.get("year"), "year2": numbering.get("year2"),
        "number": numbering.get("number"),
    }, None


_PAYOUT_FAULT_TYPES = ("qbo_payout_failed", "qbo_payout_mismatch")


def _payout_fault(pb, name):
    """Shape one PayoutBill's most-recent fault into the Error-Log fault record
    the frontend already renders: {context, message, errorDetail, date, time}.
    message is the human summary from the activity stamp; errorDetail is the raw
    sanitized QuickBooks message (qb_last_error)."""
    entries = [a for a in (pb.activity or []) if isinstance(a, dict) and a.get("type") in _PAYOUT_FAULT_TYPES]
    a = entries[-1] if entries else {}
    label = pb.doc_number or ("bill " + str(pb.id))
    return {
        "context": (name + " · " + label) if name else label,
        "message": a.get("message") or pb.qb_last_error or "Payout bill error",
        "errorDetail": pb.qb_last_error or "",
        "date": a.get("date") or "",
        "time": a.get("time") or "",
    }


async def _collect_payout_faults(db, limit=20):
    """Recent payout vendor bills that are in `error` OR carry an amount mismatch,
    newest first, as Error-Log fault records with the crew member's name."""
    bills = (await db.execute(
        select(models.PayoutBill).where(or_(
            models.PayoutBill.qb_sync_status == "error",
            and_(models.PayoutBill.qb_total_amt.isnot(None),
                 func.abs(models.PayoutBill.qb_total_amt - models.PayoutBill.amount) > 0.01),
        )).order_by(models.PayoutBill.updated_at.desc()).limit(limit)
    )).scalars().all()
    if not bills:
        return []
    cids = {b.contact_id for b in bills}
    names = {}
    for c in (await db.execute(select(models.Contact).where(models.Contact.id.in_(cids)))).scalars().all():
        names[c.id] = ((c.first_name or "") + " " + (c.last_name or "")).strip()
    return [_payout_fault(b, names.get(b.contact_id, "")) for b in bills]


def _account_status(account_id, cache):
    """('unset'|'unknown'|'invalid'|'ok', name). 'unknown' = cache empty/stale so
    we can't verify; 'invalid' = cache known but the id isn't a valid account."""
    if not account_id:
        return "unset", None
    if not cache:
        return "unknown", None
    for a in cache:
        if str(a.get("id")) == str(account_id):
            return "ok", a.get("name")
    return "invalid", None


def _period_out(period):
    return {"start": period["start"], "end": period["end"], "index": period["index"],
            "payDay": period["pay_day"], "label": period["label"]}


@qbo_router.post("/payouts/preview")
async def payout_preview_route(
    body: PayoutExportRequest,
    db: AsyncSession = Depends(get_db),
    _admin: models.User = Depends(require_admin),
):
    """Admin-only, NO side effects. Re-derive the pay period's payouts from the
    stored schedule snapshots (server truth), and return a per-crew bill preview
    plus a validation report (global blocks/warnings + per-contact status) so the
    export can be reviewed before anything is written to QuickBooks."""
    period, perr = await _resolve_period(db, body.periodStart, body.periodEnd)
    if period is None:
        return JSONResponse(status_code=400, content={"reason": "bad_period", "error": perr})

    drafts = await payouts.load_payout_drafts(db, period["start"], period["end"])
    services = (await db.execute(select(models.Service))).scalars().all()
    accounts = await qbo_payouts.resolve_payout_accounts(db, services)
    conn = (await db.execute(select(models.QboConnection).where(models.QboConnection.id == 1))).scalar_one_or_none()

    connected = conn is not None
    expense_cache = (conn.expense_accounts if conn else None) or []
    ap_cache = (conn.ap_accounts if conn else None) or []

    blocks, warnings = [], []
    if not connected:
        blocks.append("QuickBooks is not connected — connect it in Settings.")
    else:
        refresh_exp = quickbooks._aware(conn.refresh_token_expires_at)
        if refresh_exp is not None and refresh_exp <= datetime.now(timezone.utc):
            blocks.append("QuickBooks connection expired — reconnect it in Settings.")
    exp_status, _ = _account_status(accounts["default_expense"], expense_cache)
    if exp_status == "unset":
        blocks.append("Set a default payout expense account in Settings.")
    elif exp_status == "invalid":
        blocks.append("The default payout expense account isn't a valid QuickBooks expense account — pick another in Settings.")
    elif exp_status == "unknown":
        warnings.append("Couldn't verify the default expense account — refresh the account list in Settings.")
    if accounts["ap"]:
        ap_status, _ = _account_status(accounts["ap"], ap_cache)
        if ap_status == "invalid":
            blocks.append("The configured Accounts-Payable account isn't valid — pick another in Settings.")
    anchor = await qbo_sync._settings_get(db, "payPeriodAnchor")
    if anchor and anchor > period["end"]:
        warnings.append("The pay-period start date is after this period — check the pay-period settings.")

    existing_bills = {}
    for pb in (await db.execute(select(models.PayoutBill).where(
            models.PayoutBill.period_start == period["start"],
            models.PayoutBill.period_end == period["end"]))).scalars().all():
        existing_bills[pb.contact_id] = pb
    ledger = {}
    for ln in (await db.execute(select(models.PayoutBillLine))).scalars().all():
        ledger.setdefault(ln.contact_id, {})[(ln.project_id, ln.date)] = ln

    contacts_out = []
    for d in drafts:
        cid = d["contact_id"]
        row = d["contact"].get("row")
        card = {
            "contactId": cid, "name": d["name"], "pendingCount": len(d["pending"]),
            "vendorStatus": "linked" if (row is not None and getattr(row, "qb_vendor_id", None)) else "new",
        }
        cwarn = []
        if d["pending"]:
            cwarn.append(f"{len(d['pending'])} day(s) not signed off — excluded.")
        try:
            plan = qbo_payouts.plan_bill(cid, d, period, accounts)
        except qbo_payouts.PayoutNotBillable as e:
            card.update({"blocked": True, "reason": str(e), "total": 0.0, "lineCount": 0,
                         "days": [], "billStatus": "blocked", "existingBill": None, "warnings": cwarn})
            contacts_out.append(card)
            continue

        pb = existing_bills.get(cid)
        owned = ledger.get(cid, {})
        dup = sorted({day["date"] for day in plan["billable"]
                      if (day["project_id"], day["date"]) in owned
                      and (pb is None or owned[(day["project_id"], day["date"])].payout_bill_id != pb.id)})
        days_out = [{"date": day["date"], "projectName": day["project_name"],
                     "tier": day["tier"], "amount": day["payable"]} for day in plan["billable"]]
        if dup:
            card.update({"blocked": True, "reason": "already billed on another pay period: " + ", ".join(dup),
                         "total": plan["total"], "lineCount": len(plan["lines"]), "days": days_out,
                         "billStatus": "blocked", "existingBill": None, "warnings": cwarn})
            contacts_out.append(card)
            continue

        paid = pb is not None and pb.qb_paid_at is not None
        if pb is None or not pb.qb_bill_id:
            bill_status = "new"
        elif paid:
            bill_status = "paid" if pb.line_signature == plan["signature"] else "paid_changed"
        elif pb.qb_sync_status == "error":
            bill_status = "error"
        elif pb.line_signature == plan["signature"]:
            bill_status = "up_to_date"
        else:
            bill_status = "needs_update"
        # A paid bill is blocked from re-export — never overwrite it.
        reason = None
        if bill_status == "paid":
            reason = "Already paid in QuickBooks."
        elif bill_status == "paid_changed":
            reason = "Paid in QuickBooks but the payout changed since — QuickBooks won't be overwritten; adjust the bill in QB."
        card.update({
            "blocked": paid, "reason": reason, "total": plan["total"],
            "lineCount": len(plan["lines"]), "days": days_out, "billStatus": bill_status,
            "existingBill": ({"docNumber": pb.doc_number, "qbBillId": pb.qb_bill_id,
                              "syncedAt": pb.qb_synced_at.isoformat() if pb.qb_synced_at else None,
                              "paidAt": pb.qb_paid_at.isoformat() if pb.qb_paid_at else None,
                              "amount": pb.amount, "status": pb.qb_sync_status} if pb else None),
            "warnings": cwarn,
        })
        contacts_out.append(card)

    grand = payouts.js_round2(sum(c["total"] for c in contacts_out if not c.get("blocked")))
    return {
        "period": _period_out(period), "connected": connected,
        "environment": conn.environment if conn else None,
        "expenseAccountConfigured": bool(accounts["default_expense"]),
        "apAccountConfigured": bool(accounts["ap"]),
        "blocks": blocks, "warnings": warnings,
        "contacts": contacts_out, "grandTotal": grand,
    }


@qbo_router.post("/payouts/push")
async def payout_push_route(
    body: PayoutExportRequest,
    db: AsyncSession = Depends(get_db),
    admin: models.User = Depends(require_admin),
):
    """Admin-only. Create/update the selected crew members' vendor bills for the
    pay period. Re-derives the money server-side (never trusts the client), pushes
    each contact in isolation (one failure doesn't abort the rest), and returns a
    per-contact result. QuickBooks errors are captured per contact and returned;
    only a lost/expired CONNECTION aborts the whole batch (409)."""
    period, perr = await _resolve_period(db, body.periodStart, body.periodEnd)
    if period is None:
        return JSONResponse(status_code=400, content={"reason": "bad_period", "error": perr})

    services = (await db.execute(select(models.Service))).scalars().all()
    accounts = await qbo_payouts.resolve_payout_accounts(db, services)
    if not accounts["default_expense"]:
        return JSONResponse(status_code=400, content={"reason": "no_expense_account",
                            "error": "Set a default payout expense account in Settings before exporting."})

    drafts = await payouts.load_payout_drafts(db, period["start"], period["end"])
    by_id = {d["contact_id"]: d for d in drafts}
    selected = body.contactIds if body.contactIds else list(by_id.keys())

    results = []
    try:
        for cid in selected:
            d = by_id.get(cid)
            if d is None:
                results.append({"contactId": cid, "action": "skipped", "reason": "no payout in this period"})
                continue
            contact = d["contact"].get("row")
            if contact is None:
                results.append({"contactId": cid, "action": "skipped", "reason": "crew member not found"})
                continue
            try:
                results.append(await qbo_payouts.push_payout_bill(db, contact, d, period, accounts, user=admin))
            except qbo_payouts.PayoutNotBillable as e:
                results.append({"contactId": cid, "action": "skipped", "reason": str(e)})
    except quickbooks.QboNotConnected:
        return JSONResponse(status_code=409, content={"reason": "not_connected",
                            "error": "QuickBooks is not connected. Connect it in Settings."})
    except quickbooks.QboReconnectRequired:
        return JSONResponse(status_code=409, content={"reason": "reconnect",
                            "error": "QuickBooks connection expired. Reconnect it in Settings."})

    return {"ok": True, "connected": True, "period": _period_out(period), "results": results}


@qbo_router.post("/payouts/day-status")
async def payout_day_status_route(
    body: PayoutExportRequest,
    db: AsyncSession = Depends(get_db),
    _user: models.User = Depends(require_session),
):
    """Per-shift export/paid status for the Payouts tab. Returns a map keyed
    "{contactId}|{projectId}|{date}" -> {status, paid, paidAt, docNumber, qbBillId}
    for every day that's been exported (i.e. is in the bill ledger) within the
    requested date range. status ∈ exported | needs_reexport | paid | paid_changed
    (a day absent from the map is simply not exported). Staleness is computed per
    overlapping bill by re-deriving its period and comparing the live signature.

    The range is caller-supplied (a project's date span, so it can't be forced
    onto a single pay period) — but it is strictly validated and span-bounded so a
    signed-in user can't hand in "0000-01-01 … 9999-12-31" to scrape the whole
    ledger or force an unbounded re-derivation (see _DAY_STATUS_MAX_SPAN_DAYS)."""
    d_start, d_end = _iso_date_or_none(body.periodStart), _iso_date_or_none(body.periodEnd)
    if d_start is None or d_end is None:
        return JSONResponse(status_code=400, content={"reason": "bad_range",
                            "error": "periodStart/periodEnd must be YYYY-MM-DD dates."})
    if d_end < d_start:
        return JSONResponse(status_code=400, content={"reason": "bad_range",
                            "error": "periodEnd is before periodStart."})
    if (d_end - d_start).days > _DAY_STATUS_MAX_SPAN_DAYS:
        return JSONResponse(status_code=400, content={"reason": "range_too_wide",
                            "error": f"Date range exceeds {_DAY_STATUS_MAX_SPAN_DAYS} days."})
    start, end = body.periodStart, body.periodEnd
    lines = (await db.execute(select(models.PayoutBillLine).where(
        models.PayoutBillLine.date >= start, models.PayoutBillLine.date <= end))).scalars().all()
    if not lines:
        return {"days": {}}

    bill_ids = {ln.payout_bill_id for ln in lines}
    bills = {b.id: b for b in (await db.execute(
        select(models.PayoutBill).where(models.PayoutBill.id.in_(bill_ids)))).scalars().all()}

    # Live signature per bill (for drift detection), computed once per distinct
    # period. Projects + crew are loaded ONCE here and re-derived in memory per
    # period — never re-queried per period (the old N+1 that made a wide range a
    # DoS). The bounded span above caps how many distinct periods this can be.
    services = (await db.execute(select(models.Service))).scalars().all()
    accounts = await qbo_payouts.resolve_payout_accounts(db, services)
    projects_snapshot, crew_snapshot = await payouts.load_projects_and_crew(db)
    live_sig = {}
    periods = {}
    for b in bills.values():
        periods.setdefault((b.period_start, b.period_end), []).append(b)
    for (ps, pe), blist in periods.items():
        period, _ = await _resolve_period(db, ps, pe)
        if period is None:
            continue  # config drifted — leave live_sig unset (treated as fresh)
        drafts = {d["contact_id"]: d for d in
                  payouts.derive_payout_drafts(projects_snapshot, crew_snapshot, ps, pe)}
        for b in blist:
            d = drafts.get(b.contact_id)
            if d is None:
                continue
            try:
                live_sig[b.id] = qbo_payouts.plan_bill(b.contact_id, d, period, accounts)["signature"]
            except qbo_payouts.PayoutNotBillable:
                pass

    days = {}
    for ln in lines:
        b = bills.get(ln.payout_bill_id)
        if b is None or not b.qb_bill_id:
            continue
        stale = b.id in live_sig and live_sig[b.id] != b.line_signature
        if b.qb_paid_at is not None:
            status = "paid_changed" if stale else "paid"
        else:
            status = "needs_reexport" if stale else "exported"
        days["%s|%s|%s" % (ln.contact_id, ln.project_id, ln.date)] = {
            "status": status, "paid": b.qb_paid_at is not None,
            "paidAt": b.qb_paid_at.isoformat() if b.qb_paid_at else None,
            "docNumber": b.doc_number, "qbBillId": b.qb_bill_id,
        }
    return {"days": days}


class PayoutEditNotice(BaseModel):
    contactId: int
    projectId: int | None = None
    date: str
    where: str | None = None   # "payouts" | "schedule"


@qbo_router.post("/payouts/notify-edit")
async def payout_notify_edit_route(
    body: PayoutEditNotice,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(require_session),
):
    """Record + broadcast that a producer changed a day that's already been PAID
    in QuickBooks (an override confirmed in the Payouts tab or Schedule Builder).
    Stamps the paid bill's activity and web-pushes admins. Best-effort.

    Session-gated (schedule edits are member-accessible) but deliberately inert
    unless the (contact, date[, project]) resolves to a bill line whose bill is
    actually PAID — so a signed-in caller can't use it to storm admins with
    push notifications, forge "edited after paid" entries onto unpaid/nonexistent
    bills, or inject text (the date is format-validated and the message is built
    entirely from server-side values)."""
    if _iso_date_or_none(body.date) is None:
        return JSONResponse(status_code=400, content={"reason": "bad_date",
                            "error": "date must be a YYYY-MM-DD string."})

    q = select(models.PayoutBillLine).where(
        models.PayoutBillLine.contact_id == body.contactId, models.PayoutBillLine.date == body.date)
    if body.projectId is not None:
        q = q.where(models.PayoutBillLine.project_id == body.projectId)
    ln = (await db.execute(q)).scalars().first()
    pb = None
    if ln is not None:
        pb = (await db.execute(select(models.PayoutBill).where(models.PayoutBill.id == ln.payout_bill_id))).scalar_one_or_none()

    # Only a genuinely PAID bill is an override worth recording/notifying. Anything
    # else (no ledger line, or an unpaid bill) is a no-op — nothing is stamped and
    # no push is sent, which closes the storm / forgery / entity-0 push vectors.
    if pb is None or pb.qb_paid_at is None:
        return {"ok": True, "notified": False}

    cr = (await db.execute(select(models.Contact).where(models.Contact.id == body.contactId))).scalar_one_or_none()
    name = ((cr.first_name or "") + " " + (cr.last_name or "")).strip() if cr else "A crew member"
    doc = pb.doc_number
    where = "the schedule" if body.where == "schedule" else "a payout"
    msg = (f"{name} · {body.date}" + (f" ({doc})" if doc else "")
           + f" was changed in {where} after being paid in QuickBooks")
    qbo_payouts._stamp(pb, user, "qbo_payout_edited_after_paid",
                       f"Paid payout edited: {name} · {body.date}",
                       [{"cat": "Edited in", "detail": where},
                        {"cat": "By", "detail": (user.name or user.email or "")}])
    await db.flush()
    try:
        await webpush.notify_entity(db, "payout", pb.id,
                                    "Paid payout edited", msg, "/#/labor/payouts")
    except Exception as e:  # pragma: no cover - best-effort
        print(f"[LTP] webpush: paid-edit notify failed: {e}", flush=True)
    return {"ok": True, "notified": True}


# ── Compute a quote's sales tax via a temporary estimate ──────────────────────

@qbo_router.post("/quotes/{quote_id}/estimate-tax")
async def estimate_quote_tax_route(
    quote_id: int,
    body: PushRequest | None = None,
    db: AsyncSession = Depends(get_db),
    admin: models.User = Depends(require_admin),
):
    """Admin-only. Compute this quote's sales tax the QuickBooks-authoritative
    way by creating a TEMPORARY QB Estimate, reading its computed tax, and
    deleting it (the business doesn't keep QB estimates). Stores qb_tax_total +
    the frontend change-signature on the quote. Returns the result on success;
    on a QuickBooks error returns a structured error response (not raised) so any
    activity stamp commits with the request transaction."""
    result = await db.execute(select(models.Quote).where(models.Quote.id == quote_id))
    quote = result.scalar_one_or_none()
    if quote is None:
        raise HTTPException(status_code=404, detail=f"quote {quote_id} not found")
    try:
        calc = await qbo_sync.get_quote_estimate_tax(db, quote, user=admin)
        if body and body.signature:
            quote.qb_tax_signature = body.signature
            livesync.mark_dirty(db, "quotes")
            calc["qbTaxSignature"] = body.signature
        return calc
    except quickbooks.QboNotConnected:
        return JSONResponse(status_code=409, content={"reason": "not_connected",
                            "error": "QuickBooks is not connected. Connect it in Settings."})
    except quickbooks.QboReconnectRequired:
        return JSONResponse(status_code=409, content={"reason": "reconnect",
                            "error": "QuickBooks connection expired. Reconnect it in Settings."})
    except qbo_sync.InvoiceNotSyncable as e:
        return JSONResponse(status_code=400, content={"reason": "not_syncable", "error": str(e)})
    except quickbooks.QboApiError as e:
        return JSONResponse(status_code=502, content={"reason": "qbo_error", "error": e.safe_message})
