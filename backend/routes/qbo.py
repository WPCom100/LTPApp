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
from datetime import datetime, timedelta, timezone

from authlib.integrations.starlette_client import OAuthError
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend import crypto, models, payouts, qbo_payouts, qbo_sync, quickbooks
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
        qbo_sync._stamp(invoice, admin, "qbo_sync_failed",
                        "QuickBooks sync failed",
                        [{"cat": "Error", "detail": e.safe_message[:300]}])
        return JSONResponse(status_code=502, content={"reason": "qbo_error", "error": e.safe_message})


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
