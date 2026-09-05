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
import time
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

# Serializes token refresh across every in-process caller (the receipt poller,
# the bill poller, and admin routes all share this event loop). Intuit rotates
# the refresh_token on every refresh and kills the old one immediately, so two
# refreshes racing on the same stored token means the loser gets invalid_grant —
# and, on a route, that dropped the whole connection. Holding this lock makes at
# most one refresh in flight at a time; the loser then re-reads the row and finds
# it already fresh instead of spending a dead token. (Single-process deployment;
# a multi-worker setup would additionally need a DB advisory lock.)
#
# One lock per event loop: production runs a single loop (one lock), while the
# test suite spins a fresh loop per async test — a single module-global
# asyncio.Lock bound to the first loop would raise when reused under another.
_refresh_locks: dict = {}


def _get_refresh_lock() -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    lock = _refresh_locks.get(loop)
    if lock is None:
        lock = _refresh_locks[loop] = asyncio.Lock()
    return lock


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


class QboUnreachable(QboApiError):
    """No HTTP answer came back from Intuit at all — a connect failure, a
    timeout, a dropped connection. Subclasses QboApiError so every route's
    existing 502 mapping applies unchanged. Before this, httpx's exception
    escaped the route as FastAPI's plain-text 500, which the sending window
    reported as "Unexpected token 'I', \"Internal S\"... is not valid JSON": the
    reason never reached anyone, and nothing was recorded on the invoice."""

    def __init__(self, exc: Exception, what: str = "", waited: float | None = None):
        # Name the call and how long it waited: "POST invoice" hanging for the
        # full timeout while "GET query" answers is a different problem (Intuit
        # slow on that operation) from every call failing (nothing from this
        # server reaches Intuit), and the message is what the admin sees.
        during = f" during {what}" if what else ""
        after = f" after {waited:.0f}s" if waited is not None else ""
        super().__init__(0, f"QuickBooks could not be reached{during}{after} "
                            f"({type(exc).__name__}). Check the connection and try again.")


class QboBadResponse(QboApiError):
    """Intuit answered 2xx with a body that is not JSON (an edge proxy page, a
    truncated reply). Same reasoning as QboUnreachable."""

    def __init__(self, status: int):
        super().__init__(status, "QuickBooks returned a response that could not be read. Try again.")


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
    except InvalidToken:
        # A LOCAL decrypt failure (e.g. a key rotation that didn't re-encrypt
        # this row, or a removed key) is NOT the same as the user revoking
        # access. Do NOT delete the connection -- keep realm_id + ciphertext so
        # restoring the key (or running backend.rotate_encryption_key) recovers
        # access; deleting would lose the realm and force a full re-auth.
        # SECURITY_REVIEW.md M3.
        print("[LTP] qbo: refresh token failed to decrypt (encryption key "
              "mismatch?); keeping connection row for recovery", flush=True)
        raise QboReconnectRequired(
            "QuickBooks token could not be decrypted; restore the encryption "
            "key or reconnect QuickBooks."
        )

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

    # Serialize the read-refresh-persist sequence so concurrent callers can't both
    # spend the same rotating refresh token. Whoever loses the lock re-checks
    # freshness below and usually skips the network refresh entirely.
    async with _get_refresh_lock():
        # A refresh may have completed (in this process) while we waited for the
        # lock. Re-read THIS row from the DB — db.refresh() forces a fresh SELECT,
        # bypassing the session's identity-map cache that would otherwise return
        # our own stale copy — and if it now carries a still-valid access token,
        # adopt it and skip the network call. The common self-heal when two callers
        # align: the loser adopts the winner's already-committed token instead of
        # spending the (now-dead) rotating refresh token.
        if await _adopt_if_fresh(conn, db, force):
            try:
                return crypto.decrypt_token(conn.access_token_enc)
            except InvalidToken:
                pass  # unreadable — fall through and refresh for real

        payload = {"grant_type": "refresh_token", "refresh_token": refresh_token}
        # Intuit authenticates the client via HTTP Basic auth, not body params.
        auth = (client_id, client_secret)
        headers = {"Accept": "application/json"}
        try:
            if httpx_client is None:
                async with httpx.AsyncClient(timeout=15.0) as cli:
                    resp = await cli.post(QBO_TOKEN_URL, data=payload, auth=auth, headers=headers)
            else:
                resp = await httpx_client.post(QBO_TOKEN_URL, data=payload, auth=auth, headers=headers, timeout=15.0)
        except httpx.HTTPError as e:
            # The refresh token was NOT spent (nothing answered), so the
            # connection stays; the caller reports and the next call retries.
            print(f"[LTP] qbo: token endpoint unreachable: {type(e).__name__}: {e}", flush=True)
            raise QboUnreachable(e, what="the token refresh")

        if resp.status_code == 400:
            # invalid_grant. Before treating this as a real revocation, re-read the
            # row FRESH: if its stored refresh token no longer matches the one we
            # just spent, another caller rotated it (concurrent refresh) and THIS
            # 400 is a benign race — recover with the freshly-persisted token
            # instead of dropping the connection. (conn is refreshed in place.)
            recovered = await _recover_after_rotation(conn, db, refresh_token)
            if recovered is not None:
                print("[LTP] qbo: refresh 400 raced a concurrent rotation; "
                      "recovered with the freshly-persisted token", flush=True)
                return recovered
            # A genuine invalid_grant — refresh token expired/revoked or
            # credentials changed. Log a truncated snippet server-side for ops;
            # never put the raw provider body in the exception message, which is
            # reflected to the client by the routes (SECURITY_REVIEW.md H10).
            print(f"[LTP] qbo: refresh rejected by Intuit: {resp.text[:200]}", flush=True)
            await _drop_connection(conn, db)
            raise QboReconnectRequired("Intuit refused the token refresh; reconnect required.")
        return await _persist_refresh(conn, db, resp, now)


async def _adopt_if_fresh(conn: models.QboConnection, db: AsyncSession, force: bool) -> bool:
    """Re-read the caller's connection row FRESH from the DB (db.refresh forces a
    SELECT, bypassing the identity-map cache that would return our own stale copy)
    and report whether it now holds a still-valid access token — i.e. another
    caller refreshed while we waited for the lock. Mutates `conn` in place with the
    fresh values. Never raises (a best-effort re-read failure just says "not
    fresh", and the caller refreshes for real)."""
    if force:
        return False
    try:
        await db.refresh(conn)
    except Exception:  # pragma: no cover - re-read is best-effort
        return False
    exp = _aware(conn.access_token_expires_at)
    return exp is not None and exp > datetime.now(timezone.utc) + timedelta(seconds=_EXPIRY_BUFFER_SECONDS)


async def _recover_after_rotation(conn: models.QboConnection, db: AsyncSession, spent_refresh_token: str):
    """After a refresh 400, re-read the row FRESH (db.refresh, in place): if its
    stored refresh token differs from the one we spent, another caller rotated it
    and committed — return the recovered access-token plaintext. Return None when
    the token is unchanged (a genuine invalid_grant) so the caller drops. Never
    raises."""
    try:
        await db.refresh(conn)
        current_refresh = crypto.decrypt_token(conn.refresh_token_enc)
        if current_refresh == spent_refresh_token:
            return None  # nobody else rotated — the 400 is real
        exp = _aware(conn.access_token_expires_at)
        if exp is None or exp <= datetime.now(timezone.utc) + timedelta(seconds=_EXPIRY_BUFFER_SECONDS):
            return None  # rotated but already stale again — let caller drop/reconnect
        return crypto.decrypt_token(conn.access_token_enc)
    except Exception:  # pragma: no cover - recovery is best-effort
        return None


async def _persist_refresh(conn: models.QboConnection, db: AsyncSession, resp, now: datetime) -> str:
    """Handle a token-endpoint response that isn't a 400. Persists + COMMITS the
    rotated tokens on success; raises QboApiError on a non-200. Extracted so the
    locked refresh body stays readable."""
    if resp.status_code != 200:
        # Network blip / 5xx — surface so caller can decide. Don't drop the
        # connection; the refresh may succeed next time.
        print(f"[LTP] qbo: token endpoint returned {resp.status_code}: "
              f"{resp.text[:200]}", flush=True)
        raise QboApiError(resp.status_code, "QuickBooks token endpoint returned an error.")

    try:
        data = resp.json()
    except ValueError:
        print(f"[LTP] qbo: token endpoint returned non-JSON: {resp.text[:200]}", flush=True)
        raise QboBadResponse(resp.status_code)
    new_access = data.get("access_token")
    if not new_access:
        raise QboApiError(200, "QuickBooks token refresh returned no access token.")

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
    # COMMIT the rotation on the caller's own session (not a second session — that
    # self-deadlocks against this session's own row lock) while still holding the
    # refresh lock, so the rotated token is durable and visible to a concurrent
    # loser BEFORE the lock releases. The loser's _adopt_if_fresh then adopts it
    # instead of spending the dead refresh token. Committing the caller's pending
    # work here is safe and desirable: a rotated token must never be lost to a
    # later rollback (Intuit already invalidated the old one).
    await db.commit()
    return new_access


async def _drop_connection(conn: models.QboConnection, db: AsyncSession) -> None:
    """Delete the unusable connection row so GET /api/qbo/status reports
    disconnected and the admin is prompted to reconnect."""
    try:
        await db.delete(conn)
        await db.flush()
    except Exception as e:  # pragma: no cover - best effort cleanup
        print(f"[LTP] qbo: failed to drop stale connection: {e}", flush=True)


# ── Connection-level error snapshot (Settings → Error Log) ───────────────────

async def record_connection_error(db: AsyncSession, message: str) -> None:
    """Persist the most recent connection-level QuickBooks error on the singleton
    connection row so it surfaces in Settings → Error Log. For background contexts
    (the auto-receipt poller) that hit an auth/API failure with no entity to
    stamp. Best-effort with its own commit — call AFTER rolling back the failed
    operation's transaction so this snapshot isn't undone with it. No-op when
    QuickBooks is disconnected (nothing to annotate)."""
    try:
        r = await db.execute(select(models.QboConnection).where(models.QboConnection.id == 1))
        conn = r.scalar_one_or_none()
        if conn is None:
            return
        conn.last_error = (message or "QuickBooks error")[:300]
        conn.last_error_at = datetime.now(timezone.utc)
        await db.commit()
    except Exception as e:  # pragma: no cover - diagnostics must never crash a caller
        print(f"[LTP] qbo: failed to record connection error: {e}", flush=True)


async def clear_connection_error(db: AsyncSession) -> None:
    """Clear a previously recorded connection error once QuickBooks is healthy
    again (a clean poll cycle or a successful reconnect). Best-effort, own commit;
    no-op when disconnected or already clear so healthy cycles stay write-free."""
    try:
        r = await db.execute(select(models.QboConnection).where(models.QboConnection.id == 1))
        conn = r.scalar_one_or_none()
        if conn is None or conn.last_error is None:
            return
        conn.last_error = None
        conn.last_error_at = None
        await db.commit()
    except Exception as e:  # pragma: no cover
        print(f"[LTP] qbo: failed to clear connection error: {e}", flush=True)


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

    async def _send(token: str) -> httpx.Response:
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

    async def _do(token: str) -> httpx.Response:
        # A transport failure (connect refused, DNS, timeout, connection reset)
        # gets the same one retry a 5xx gets, then becomes a typed error the
        # routes already know how to answer — never a bare exception.
        started = time.monotonic()
        try:
            return await _send(token)
        except httpx.HTTPError as first:
            print(f"[LTP] qbo: {method} {resource} transport error after "
                  f"{time.monotonic() - started:.1f}s ({type(first).__name__}: {first}); "
                  f"retrying once", flush=True)
            await asyncio.sleep(2.0)
            again = time.monotonic()
            try:
                return await _send(token)
            except httpx.HTTPError as e:
                waited = time.monotonic() - again
                print(f"[LTP] qbo: {method} {resource} transport error again after "
                      f"{waited:.1f}s ({type(e).__name__}: {e}); giving up", flush=True)
                raise QboUnreachable(e, what=f"{method} {resource}", waited=waited)

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
        try:
            return resp.json()
        except ValueError:
            print(f"[LTP] qbo: {method} {resource} answered {resp.status_code} with "
                  f"non-JSON: {resp.text[:200]}", flush=True)
            raise QboBadResponse(resp.status_code)
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


async def get_item(conn, db, item_id, *, client_id, client_secret, httpx_client=None) -> dict:
    data = await _request(conn, db, "GET", f"item/{item_id}", client_id=client_id,
                          client_secret=client_secret, httpx_client=httpx_client)
    return data.get("Item", {}) or {}


async def update_item(conn, db, payload, *, client_id, client_secret, httpx_client=None) -> dict:
    """Update an item. Pass sparse=True + Id + SyncToken in the payload to patch
    only the supplied fields (used to re-point IncomeAccountRef)."""
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


# Estimate helpers — the QB Estimate entity is API-identical to Invoice (same
# Line/SalesItemLineDetail/TaxCodeRef, same TxnTaxDetail.TotalTax, same sparse
# delete). We create a temporary estimate only to read QB-computed tax for a
# quote, then delete it — the business doesn't keep QB estimates.
async def create_estimate(conn, db, payload, *, client_id, client_secret, httpx_client=None) -> dict:
    return await _request(conn, db, "POST", "estimate", client_id=client_id,
                          client_secret=client_secret, json=payload, httpx_client=httpx_client)


async def get_estimate(conn, db, estimate_id, *, client_id, client_secret, httpx_client=None) -> dict:
    data = await _request(conn, db, "GET", f"estimate/{estimate_id}", client_id=client_id,
                          client_secret=client_secret, httpx_client=httpx_client)
    return data.get("Estimate", {}) or {}


async def delete_estimate(conn, db, estimate_id, sync_token, *, client_id, client_secret, httpx_client=None) -> dict:
    return await _request(conn, db, "POST", "estimate", client_id=client_id,
                          client_secret=client_secret,
                          params={"operation": "delete"},
                          json={"Id": str(estimate_id), "SyncToken": str(sync_token)},
                          httpx_client=httpx_client)


async def list_income_accounts(conn, db, *, client_id, client_secret, httpx_client=None) -> list[dict]:
    """Income accounts available to back new Items' IncomeAccountRef."""
    return await query(
        conn, db,
        "SELECT Id, Name FROM Account WHERE AccountType = 'Income' AND Active = true",
        client_id=client_id, client_secret=client_secret, httpx_client=httpx_client,
    )


# ── Vendor + Bill helpers (accounts-payable side; mirror customer/invoice) ───

async def create_vendor(conn, db, payload, *, client_id, client_secret, httpx_client=None) -> dict:
    return await _request(conn, db, "POST", "vendor", client_id=client_id,
                          client_secret=client_secret, json=payload, httpx_client=httpx_client)


async def get_vendor(conn, db, vendor_id, *, client_id, client_secret, httpx_client=None) -> dict:
    data = await _request(conn, db, "GET", f"vendor/{vendor_id}", client_id=client_id,
                          client_secret=client_secret, httpx_client=httpx_client)
    return data.get("Vendor", {}) or {}


async def update_vendor(conn, db, payload, *, client_id, client_secret, httpx_client=None) -> dict:
    """Update a vendor. Pass sparse=True + Id + SyncToken to patch supplied fields."""
    return await _request(conn, db, "POST", "vendor", client_id=client_id,
                          client_secret=client_secret, json=payload, httpx_client=httpx_client)


async def create_bill(conn, db, payload, *, client_id, client_secret, httpx_client=None) -> dict:
    return await _request(conn, db, "POST", "bill", client_id=client_id,
                          client_secret=client_secret, json=payload, httpx_client=httpx_client)


async def update_bill(conn, db, payload, *, client_id, client_secret, httpx_client=None) -> dict:
    """Full update (sparse=false expected in payload). Requires Id + SyncToken."""
    return await _request(conn, db, "POST", "bill", client_id=client_id,
                          client_secret=client_secret, json=payload, httpx_client=httpx_client)


async def get_bill(conn, db, bill_id, *, client_id, client_secret, httpx_client=None) -> dict:
    data = await _request(conn, db, "GET", f"bill/{bill_id}", client_id=client_id,
                          client_secret=client_secret, httpx_client=httpx_client)
    return data.get("Bill", {}) or {}


async def list_expense_accounts(conn, db, *, client_id, client_secret, httpx_client=None) -> list[dict]:
    """Postable accounts a crew-payout bill line may expense to. Includes the
    common labor buckets — Expense, Other Expense, and Cost of Goods Sold."""
    return await query(
        conn, db,
        "SELECT Id, Name, AccountType FROM Account WHERE AccountType IN "
        "('Expense', 'Other Expense', 'Cost of Goods Sold') AND Active = true",
        client_id=client_id, client_secret=client_secret, httpx_client=httpx_client,
    )


async def list_ap_accounts(conn, db, *, client_id, client_secret, httpx_client=None) -> list[dict]:
    """Accounts-Payable accounts a bill's APAccountRef may point at (multi-AP
    companies). Omitting APAccountRef posts to the company's default AP account."""
    return await query(
        conn, db,
        "SELECT Id, Name, AccountType FROM Account WHERE AccountType = 'Accounts Payable' AND Active = true",
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
