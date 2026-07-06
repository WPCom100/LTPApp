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

from backend import crypto, models, qbo_sync, quickbooks
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
        # Auto-receipt surface for the Settings panel.
        "senderGmailConnected": sender_gmail_connected,
        "pendingReceipts": int(pending_receipts or 0),
        # Admin-refreshed Income account list (feeds the mapping dropdowns in
        # Settings and the per-item pickers). [] until the first refresh.
        "incomeAccounts": conn.income_accounts or [],
        "incomeAccountsUpdatedAt": accounts_updated.isoformat() if accounts_updated else None,
    }


# ── Income accounts: explicit refresh ────────────────────────────────────────

@qbo_router.post("/accounts/refresh")
async def refresh_income_accounts(
    db: AsyncSession = Depends(get_db),
    _admin: models.User = Depends(require_admin),
):
    """Admin-only. Re-fetch the QB company's active Income accounts and cache
    them on the connection row. Deliberately button-driven (no background
    sync): the chart of accounts is near-static, so the list refreshes only
    when an admin asks for it."""
    client_id, client_secret = qbo_sync.creds()
    try:
        conn = await quickbooks.load_connection(db)
        raw = await quickbooks.list_income_accounts(
            conn, db, client_id=client_id, client_secret=client_secret
        )
    except quickbooks.QboNotConnected:
        return JSONResponse(status_code=409, content={"reason": "not_connected",
                            "error": "QuickBooks is not connected. Connect it in Settings."})
    except quickbooks.QboReconnectRequired:
        return JSONResponse(status_code=409, content={"reason": "reconnect",
                            "error": "QuickBooks connection expired. Reconnect it in Settings."})
    except quickbooks.QboApiError as e:
        return JSONResponse(status_code=502, content={"reason": "qbo_error", "error": e.safe_message})

    accounts = [
        {"id": str(a.get("Id")), "name": a.get("Name") or ""}
        for a in raw if a.get("Id") is not None
    ]
    conn.income_accounts = accounts
    conn.income_accounts_updated_at = datetime.now(timezone.utc)
    await db.flush()
    return {
        "ok": True,
        "incomeAccounts": accounts,
        "incomeAccountsUpdatedAt": conn.income_accounts_updated_at.isoformat(),
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
