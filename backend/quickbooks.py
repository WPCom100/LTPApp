"""QuickBooks Online REST client.

End-to-end responsibility for talking to the Intuit QuickBooks Online API on
behalf of the single company-wide connection (the `qbo_connection` singleton
row), INCLUDING the OAuth2 token lifecycle (proactive refresh, persist the
rotated refresh_token, clear + signal reconnect on irrecoverable failure).

This is the deliberate twin of backend/gmail.py — same shape, same defensive
posture — but for QuickBooks instead of Gmail. Two meaningful differences from
the Google flow:

  1. Intuit's token endpoint authenticates the CLIENT via HTTP Basic auth
     (client_id:client_secret in the Authorization header), NOT via client_id /
     client_secret in the form body the way Google does.

  2. Intuit rotates the refresh_token on essentially every refresh, and the old
     one stops working immediately. Persisting the rotated token is therefore
     not "defense in depth" as it is for Gmail — it's mandatory, or the next
     refresh fails.

Why httpx and not python-quickbooks / intuit-oauth
==================================================
Same reasoning as gmail.py: those libraries are synchronous and pull a large
dependency tree for what we use as a handful of HTTPS calls. httpx is already a
FastAPI transitive dep and keeps the security boundary small to audit. All the
app's QuickBooks traffic flows through this one module.

Security
========
Tokens are stored as Fernet ciphertext (backend/crypto.py) and only ever
decrypted in-process here. Nothing in this module logs a token; error bodies
are truncated before they reach a log line or the client. The client secret is
passed in by the caller (read from env in the route), never imported here, so
this module stays free of app/config coupling — same pattern as gmail.send.
"""
import asyncio
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend import crypto, models
from backend.crypto import InvalidToken


# Intuit OAuth2 endpoints (shared by sandbox + production).
QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
QBO_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke"

# API host depends on the connection's environment. The realm-scoped base path
# (/v3/company/{realmId}) is appended by api_base().
QBO_API_HOST_PRODUCTION = "https://quickbooks.api.intuit.com"
QBO_API_HOST_SANDBOX = "https://sandbox-quickbooks.api.intuit.com"

# Pin a reasonably-recent minor version so available fields are stable across
# Intuit rollouts. Sent on every data request.
QBO_MINOR_VERSION = "70"

# Same proactive-refresh buffer as gmail.py: refresh when within this many
# seconds of expiry rather than waiting for a 401 round-trip.
_EXPIRY_BUFFER_SECONDS = 60


class QboError(Exception):
    """Base class for QuickBooks-helper errors. Routes catch this hierarchy."""


class QboNotConnected(QboError):
    """No qbo_connection row exists — QuickBooks was never connected (or was
    disconnected). The route layer translates this to 409 reason="not_connected"
    so the frontend points the admin at Settings → Connect QuickBooks."""


class QboReconnectRequired(QboError):
    """The stored connection is unusable and an admin must reconnect:
      - Fernet decrypt failure (rotated key / tampered ciphertext)
      - Intuit returns invalid_grant on refresh (refresh token expired after
        ~100 days, the app was disconnected at Intuit, credentials changed)
    On this error the connection row is deleted so status flips to disconnected.
    Route translates to 409 reason="reconnect"."""


class QboApiError(QboError):
    """QuickBooks accepted the request but returned a Fault, OR returned a 5xx /
    429 after our one retry. The route logs a `qbo_sync_failed` activity entry
    and returns 502. `safe_message` is pre-truncated/sanitized for the client."""

    def __init__(self, status: int, body: str, fault_code: str | None = None):
        self.status = status
        self.body = body
        self.fault_code = fault_code
        self.safe_message = _summarize_fault(status, body)
        super().__init__(f"QuickBooks API error ({status}): {self.safe_message}")


# ── Fault parsing ────────────────────────────────────────────────────────────

def _summarize_fault(status: int, body: str) -> str:
    """Pull a short human message out of an Intuit Fault payload. Intuit wraps
    errors as {"Fault": {"Error": [{"Message", "Detail", "code"}], "type"}}.
    Falls back to a truncated raw body. Never includes tokens (none appear in
    fault bodies) and caps length so it's safe to surface to the client."""
    try:
        import json
        data = json.loads(body)
        fault = data.get("Fault") or data.get("fault") or {}
        errors = fault.get("Error") or fault.get("error") or []
        if errors:
            e0 = errors[0]
            msg = e0.get("Message") or e0.get("message") or ""
            detail = e0.get("Detail") or e0.get("detail") or ""
            combined = (msg + (f": {detail}" if detail else "")).strip()
            if combined:
                return combined[:300]
    except (ValueError, AttributeError, KeyError, TypeError):
        pass
    return (body or f"HTTP {status}")[:300]


def fault_code(body: str) -> str | None:
    """Return Intuit's first Error[].code from a Fault body, or None. Used by the
    sync engine to detect stale-SyncToken (5010) and duplicate-name (6240)."""
    try:
        import json
        errors = (json.loads(body).get("Fault") or {}).get("Error") or []
        if errors:
            return str(errors[0].get("code")) if errors[0].get("code") is not None else None
    except (ValueError, AttributeError, KeyError, TypeError):
        pass
    return None


# ── Connection loading ───────────────────────────────────────────────────────

async def load_connection(db: AsyncSession) -> models.QboConnection:
    """Return the singleton qbo_connection row (id=1). Raises QboNotConnected
    when QuickBooks has never been connected / was disconnected."""
    result = await db.execute(
        select(models.QboConnection).where(models.QboConnection.id == 1)
    )
    conn = result.scalar_one_or_none()
    if conn is None:
        raise QboNotConnected("QuickBooks is not connected")
    return conn


def api_base(conn: models.QboConnection) -> str:
    """Realm-scoped API base, e.g. https://sandbox-quickbooks.api.intuit.com/v3/company/123."""
    host = QBO_API_HOST_SANDBOX if conn.environment == "sandbox" else QBO_API_HOST_PRODUCTION
    return f"{host}/v3/company/{conn.realm_id}"


def _aware(dt: datetime | None) -> datetime | None:
    """SQLite drops tzinfo on DateTime(timezone=True) reads; normalize to UTC."""
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


# ── Token refresh ────────────────────────────────────────────────────────────

async def refresh_if_needed(
    conn: models.QboConnection,
    db: AsyncSession,
    *,
    client_id: str,
    client_secret: str,
    httpx_client: httpx.AsyncClient | None = None,
    force: bool = False,
) -> str:
    """Ensure the access token is fresh; return it in plaintext. Refreshes via
    Intuit's token endpoint when expired (or within _EXPIRY_BUFFER_SECONDS), or
    when force=True (used after a 401). Persists the rotated refresh_token.

    Raises QboReconnectRequired on any condition that means we can't speak to
    QuickBooks without an admin re-consenting; the connection row is deleted in
    that case so status reflects "disconnected"."""
    try:
        refresh_token = crypto.decrypt_token(conn.refresh_token_enc)
    except InvalidToken as e:
        await _drop_connection(conn, db)
        raise QboReconnectRequired(f"stored refresh token unreadable: {e}")

    now = datetime.now(timezone.utc)
    expires_at = _aware(conn.access_token_expires_at)
    fresh_enough = (
        not force
        and expires_at is not None
        and expires_at > now + timedelta(seconds=_EXPIRY_BUFFER_SECONDS)
    )
    if fresh_enough:
        try:
            return crypto.decrypt_token(conn.access_token_enc)
        except InvalidToken as e:
            # Access token unreadable — fall through to refresh, which replaces
            # it with one we can decrypt.
            print(f"[LTP] qbo: stored access token unreadable ({e}); refreshing", flush=True)

    payload = {"grant_type": "refresh_token", "refresh_token": refresh_token}
    # Intuit authenticates the client via HTTP Basic auth, not body params.
    auth = (client_id, client_secret)
    headers = {"Accept": "application/json"}
    if httpx_client is None:
        async with httpx.AsyncClient(timeout=15.0) as cli:
            resp = await cli.post(QBO_TOKEN_URL, data=payload, auth=auth, headers=headers)
    else:
        resp = await httpx_client.post(QBO_TOKEN_URL, data=payload, auth=auth, headers=headers, timeout=15.0)

    if resp.status_code == 400:
        # invalid_grant — refresh token expired/revoked or credentials changed.
        body = resp.text
        print(f"[LTP] qbo: refresh rejected by Intuit: {body[:200]}", flush=True)
        await _drop_connection(conn, db)
        raise QboReconnectRequired(f"intuit refused refresh: {body[:200]}")
    if resp.status_code != 200:
        # Network blip / 5xx — surface so caller can decide. Don't drop the
        # connection; the refresh may succeed next time.
        raise QboApiError(resp.status_code, f"token endpoint: {resp.text}")

    data = resp.json()
    new_access = data.get("access_token")
    if not new_access:
        raise QboApiError(200, f"refresh response missing access_token: {data}")

    conn.access_token_enc = crypto.encrypt_token(new_access)
    expires_in = int(data.get("expires_in", 3600))
    conn.access_token_expires_at = now + timedelta(seconds=expires_in)
    rotated_refresh = data.get("refresh_token")
    if rotated_refresh:
        # Intuit rotates the refresh token aggressively; persist immediately or
        # the next refresh fails.
        conn.refresh_token_enc = crypto.encrypt_token(rotated_refresh)
        rt_expires_in = data.get("x_refresh_token_expires_in")
        if rt_expires_in:
            try:
                conn.refresh_token_expires_at = now + timedelta(seconds=int(rt_expires_in))
            except (TypeError, ValueError):
                pass
    await db.flush()
    return new_access


async def _drop_connection(conn: models.QboConnection, db: AsyncSession) -> None:
    """Delete the unusable connection row so GET /api/qbo/status reports
    disconnected and the admin is prompted to reconnect."""
    try:
        await db.delete(conn)
        await db.flush()
    except Exception as e:  # pragma: no cover - best effort cleanup
        print(f"[LTP] qbo: failed to drop stale connection: {e}", flush=True)


# ── Request wrapper ──────────────────────────────────────────────────────────

async def _request(
    conn: models.QboConnection,
    db: AsyncSession,
    method: str,
    resource: str,
    *,
    client_id: str,
    client_secret: str,
    json: dict | None = None,
    params: dict | None = None,
    httpx_client: httpx.AsyncClient | None = None,
) -> dict:
    """Issue a single realm-scoped API call with the full retry policy:
      - 401 → force-refresh the access token, retry once.
      - 429 → honor Retry-After (or back off ~2s), retry once.
      - 5xx → back off 2s, retry once.
      - Fault / other non-2xx → QboApiError.
    `resource` is the path segment after /company/{realm}, e.g. "invoice",
    "customer", "item", "query"."""
    access_token = await refresh_if_needed(
        conn, db, client_id=client_id, client_secret=client_secret,
        httpx_client=httpx_client,
    )
    url = f"{api_base(conn)}/{resource}"
    req_params = {"minorversion": QBO_MINOR_VERSION}
    if params:
        req_params.update(params)

    async def _do(token: str) -> httpx.Response:
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        }
        if json is not None:
            headers["Content-Type"] = "application/json"
        if httpx_client is None:
            async with httpx.AsyncClient(timeout=30.0) as cli:
                return await cli.request(method, url, headers=headers, params=req_params, json=json)
        return await httpx_client.request(method, url, headers=headers, params=req_params, json=json, timeout=30.0)

    resp = await _do(access_token)

    if resp.status_code == 401:
        access_token = await refresh_if_needed(
            conn, db, client_id=client_id, client_secret=client_secret,
            httpx_client=httpx_client, force=True,
        )
        resp = await _do(access_token)
    elif resp.status_code == 429:
        retry_after = resp.headers.get("Retry-After")
        try:
            delay = float(retry_after) if retry_after else 2.0
        except ValueError:
            delay = 2.0
        await asyncio.sleep(min(delay, 10.0))
        resp = await _do(access_token)
    elif 500 <= resp.status_code < 600:
        await asyncio.sleep(2.0)
        resp = await _do(access_token)

    if 200 <= resp.status_code < 300:
        return resp.json()
    raise QboApiError(resp.status_code, resp.text, fault_code(resp.text))


# ── Query helper ─────────────────────────────────────────────────────────────

def escape_query_value(value: str) -> str:
    """Escape a value for inline use in a QBO query string. Single quotes are
    the SQL-injection vector for the query endpoint; doubling them is Intuit's
    escaping rule. Always run user/catalog-derived values through this."""
    return (value or "").replace("\\", "\\\\").replace("'", "\\'")


async def query(
    conn: models.QboConnection,
    db: AsyncSession,
    sql: str,
    *,
    client_id: str,
    client_secret: str,
    httpx_client: httpx.AsyncClient | None = None,
) -> list[dict]:
    """Run a QBO SQL-like query and return the matched entity list (possibly
    empty). Caller is responsible for escaping any inlined values via
    escape_query_value()."""
    data = await _request(
        conn, db, "GET", "query",
        client_id=client_id, client_secret=client_secret,
        params={"query": sql}, httpx_client=httpx_client,
    )
    qr = data.get("QueryResponse", {}) or {}
    # The result key is the entity name (Customer / Item / Invoice). Return the
    # first list value found.
    for val in qr.values():
        if isinstance(val, list):
            return val
    return []


# ── Thin entity helpers (each one line over _request) ────────────────────────

async def create_customer(conn, db, payload, *, client_id, client_secret, httpx_client=None) -> dict:
    return await _request(conn, db, "POST", "customer", client_id=client_id,
                          client_secret=client_secret, json=payload, httpx_client=httpx_client)


async def get_customer(conn, db, customer_id, *, client_id, client_secret, httpx_client=None) -> dict:
    data = await _request(conn, db, "GET", f"customer/{customer_id}", client_id=client_id,
                          client_secret=client_secret, httpx_client=httpx_client)
    return data.get("Customer", {}) or {}


async def update_customer(conn, db, payload, *, client_id, client_secret, httpx_client=None) -> dict:
    """Update a customer. Pass sparse=True + Id + SyncToken in the payload to
    patch only the supplied fields (leaving everything else untouched)."""
    return await _request(conn, db, "POST", "customer", client_id=client_id,
                          client_secret=client_secret, json=payload, httpx_client=httpx_client)


async def create_item(conn, db, payload, *, client_id, client_secret, httpx_client=None) -> dict:
    return await _request(conn, db, "POST", "item", client_id=client_id,
                          client_secret=client_secret, json=payload, httpx_client=httpx_client)


async def create_invoice(conn, db, payload, *, client_id, client_secret, httpx_client=None) -> dict:
    return await _request(conn, db, "POST", "invoice", client_id=client_id,
                          client_secret=client_secret, json=payload, httpx_client=httpx_client)


async def update_invoice(conn, db, payload, *, client_id, client_secret, httpx_client=None) -> dict:
    """Full update (sparse=false expected in payload). Requires Id + SyncToken."""
    return await _request(conn, db, "POST", "invoice", client_id=client_id,
                          client_secret=client_secret, json=payload, httpx_client=httpx_client)


async def get_invoice(conn, db, invoice_id, *, client_id, client_secret, httpx_client=None) -> dict:
    data = await _request(conn, db, "GET", f"invoice/{invoice_id}", client_id=client_id,
                          client_secret=client_secret, httpx_client=httpx_client)
    return data.get("Invoice", {}) or {}


async def delete_invoice(conn, db, invoice_id, sync_token, *, client_id, client_secret, httpx_client=None) -> dict:
    return await _request(conn, db, "POST", "invoice", client_id=client_id,
                          client_secret=client_secret,
                          params={"operation": "delete"},
                          json={"Id": str(invoice_id), "SyncToken": str(sync_token)},
                          httpx_client=httpx_client)


async def list_income_accounts(conn, db, *, client_id, client_secret, httpx_client=None) -> list[dict]:
    """Income accounts available to back new Items' IncomeAccountRef."""
    return await query(
        conn, db,
        "SELECT Id, Name FROM Account WHERE AccountType = 'Income' AND Active = true",
        client_id=client_id, client_secret=client_secret, httpx_client=httpx_client,
    )


async def revoke(conn, db, *, client_id, client_secret, httpx_client=None) -> bool:
    """Best-effort revoke of the refresh token at Intuit on disconnect. Returns
    True on success; never raises (disconnect should always proceed locally)."""
    try:
        refresh_token = crypto.decrypt_token(conn.refresh_token_enc)
    except InvalidToken:
        return False
    body = {"token": refresh_token}
    auth = (client_id, client_secret)
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    try:
        if httpx_client is None:
            async with httpx.AsyncClient(timeout=15.0) as cli:
                resp = await cli.post(QBO_REVOKE_URL, json=body, auth=auth, headers=headers)
        else:
            resp = await httpx_client.post(QBO_REVOKE_URL, json=body, auth=auth, headers=headers, timeout=15.0)
        return 200 <= resp.status_code < 300
    except httpx.HTTPError as e:  # pragma: no cover - network best effort
        print(f"[LTP] qbo: revoke failed (continuing with local disconnect): {e}", flush=True)
        return False
