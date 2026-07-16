import asyncio
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from sqlalchemy import delete
from starlette.middleware.sessions import SessionMiddleware
from authlib.integrations.starlette_client import OAuth

from backend import models, qbo_receipts
from backend.database import init_db, async_session
from backend.routes.api import router as api_router
from backend.routes.auth import router as auth_router
from backend.routes.pdf import api_pdf_router, public_pdf_router
from backend.routes.view import view_router
from backend.routes.crew import crew_public_router, crew_admin_router
from backend.routes.email import email_router
from backend.routes.qbo import qbo_router
from backend.routes.push import push_router
from backend.rate_limit import RateLimitMiddleware
from backend.csrf import CsrfOriginMiddleware


# ── Session sweeper ────────────────────────────────────────────────────────
# Expired sessions are filtered out at auth check-time but never deleted, so
# the table grows unbounded. This background task wakes hourly, deletes any
# row past expires_at, and logs the count if non-zero. Hourly is plenty for
# any realistic scale; tune via LTP_SESSION_SWEEP_INTERVAL_SECONDS.
SESSION_SWEEP_INTERVAL = int(os.environ.get("LTP_SESSION_SWEEP_INTERVAL_SECONDS", "3600"))


async def _sweep_expired_sessions_once() -> int:
    """Delete every session whose expires_at is in the past. Returns the
    rowcount deleted (0 if none). Uses ORM-level delete() so rowcount works
    consistently across SQLite and Postgres dialects."""
    async with async_session() as db:
        result = await db.execute(
            delete(models.Session).where(models.Session.expires_at < datetime.now(timezone.utc))
        )
        await db.commit()
        # Some dialect drivers return -1 if rowcount isn't supported; treat
        # those as "we don't know, assume 0 for logging purposes".
        rc = result.rowcount
        return rc if rc and rc > 0 else 0


async def _session_sweeper_loop():
    """Long-running background task started by lifespan(). Each iteration:
    sweep once, sleep. Exceptions inside the body are caught and logged so
    one transient DB blip doesn't permanently kill the sweeper."""
    while True:
        try:
            deleted = await _sweep_expired_sessions_once()
            if deleted:
                print(f"[LTP] sweeper: deleted {deleted} expired session(s)", flush=True)
        except asyncio.CancelledError:
            raise  # propagate shutdown signal
        except Exception as e:
            print(f"[LTP] sweeper error (will retry next interval): {e}", flush=True)
        try:
            await asyncio.sleep(SESSION_SWEEP_INTERVAL)
        except asyncio.CancelledError:
            raise


# ── QuickBooks auto-receipt poller ──────────────────────────────────────────
# Wakes every couple of hours, asks QuickBooks which linked invoices are now
# paid (Balance 0), and emails each client their payment receipt exactly once.
# Sender = the admin who connected QuickBooks; if their Gmail is unavailable the
# receipt is cached and retried next cycle. See backend/qbo_receipts.py. Tune
# the cadence via LTP_QBO_RECEIPT_POLL_INTERVAL_SECONDS (default 2 hours).
QBO_RECEIPT_POLL_INTERVAL = int(os.environ.get("LTP_QBO_RECEIPT_POLL_INTERVAL_SECONDS", str(2 * 3600)))


async def _qbo_receipt_poll_loop():
    """Long-running background task started by lifespan(). Each iteration runs
    one poll cycle, then sleeps. Exceptions inside a cycle are caught and logged
    so one transient blip (DB/QuickBooks/Gmail) doesn't permanently kill the
    poller; per-invoice failures are already isolated inside run_receipt_poll."""
    while True:
        try:
            summary = await qbo_receipts.run_receipt_poll()
            if not summary.get("skipped") and (summary.get("sent") or summary.get("pending") or summary.get("failed")):
                print(f"[LTP] qbo-receipts: {summary['sent']} sent, "
                      f"{summary['pending']} cached, {summary['failed']} failed "
                      f"(of {summary['checked']} checked)", flush=True)
        except asyncio.CancelledError:
            raise  # propagate shutdown signal
        except Exception as e:
            print(f"[LTP] qbo-receipts error (will retry next interval): {e}", flush=True)
        try:
            await asyncio.sleep(QBO_RECEIPT_POLL_INTERVAL)
        except asyncio.CancelledError:
            raise


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    # In-memory debounce dict for the public view route. Keys are
    # (entity_kind, entity_id, debounce_key) tuples; values are the
    # most-recent view timestamp. backend/view_tracking.py manages reads
    # and writes; we just initialize the slot here. See its DEBOUNCE_WINDOW
    # constant for the TTL. Lost on pod restart — acceptable for audit
    # purposes (worst case: one extra log entry per token per pod reboot).
    app.state.client_view_seen = {}
    sweeper = asyncio.create_task(_session_sweeper_loop(), name="ltp_session_sweeper")
    receipt_poller = asyncio.create_task(_qbo_receipt_poll_loop(), name="ltp_qbo_receipt_poller")
    try:
        yield
    finally:
        # Graceful shutdown: cancel, then await so each task actually finishes
        # its current iteration (asyncio.Task.cancel() alone just sets a flag).
        for task in (sweeper, receipt_poller):
            task.cancel()
        for task in (sweeper, receipt_poller):
            try:
                await task
            except (asyncio.CancelledError, Exception):
                # Swallow CancelledError (expected); ignore any teardown error.
                pass


app = FastAPI(title="LTP Business Suite", version="2.0.0", lifespan=lifespan)


# ── Payload size limit ─────────────────────────────────────────────────────
# Without this, any authenticated user can POST gigabytes of JSON and pin a
# worker until OOM kills it (single-pod Railway = total app outage).
#
# We can't trust the Content-Length header alone — clients can send
# Transfer-Encoding: chunked with no Content-Length and bypass a header
# check entirely. The middleware below wraps the ASGI `receive` callable
# and counts actual bytes, aborting with 413 if the body exceeds the limit.
#
# 10 MB is intentionally generous for the app's data model (quotes/invoices
# with hundreds of line items, settings with embedded logos). Tune via
# LTP_MAX_PAYLOAD_BYTES env var if needed; we log the value at startup.
MAX_PAYLOAD_BYTES = int(os.environ.get("LTP_MAX_PAYLOAD_BYTES", str(10 * 1024 * 1024)))


class PayloadSizeLimitMiddleware:
    """Pure ASGI middleware. Counts bytes as the body streams in. Reject
    EITHER a request whose Content-Length declares too much OR one whose
    actual streamed bytes overflow (covers chunked transfer encoding)."""

    def __init__(self, app, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        # Fast path: trust Content-Length when present and over the limit.
        # Note: header name comes as lowercased bytes in scope["headers"].
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    if int(value) > self.max_bytes:
                        return await self._reject(send)
                except ValueError:
                    pass
                break

        rejected = {"yes": False}
        total = {"n": 0}

        async def counting_receive():
            if rejected["yes"]:
                # Already replied — downstream shouldn't be waiting, but be
                # safe and feed it an end-of-body marker.
                return {"type": "http.request", "body": b"", "more_body": False}
            msg = await receive()
            if msg["type"] == "http.request":
                total["n"] += len(msg.get("body", b""))
                if total["n"] > self.max_bytes:
                    rejected["yes"] = True
            return msg

        sent_started = {"yes": False}

        async def gated_send(msg):
            if rejected["yes"] and not sent_started["yes"]:
                sent_started["yes"] = True
                await self._reject(send)
                return
            if rejected["yes"]:
                # Drop any further response chunks the app tries to send
                # after we've already issued our 413.
                return
            if msg["type"] == "http.response.start":
                sent_started["yes"] = True
            await send(msg)

        await self.app(scope, counting_receive, gated_send)

    async def _reject(self, send):
        body = (
            b'{"error":"Payload too large","limit_bytes":'
            + str(self.max_bytes).encode("ascii")
            + b"}"
        )
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


# ── Security headers ───────────────────────────────────────────────────────
# Sets the standard set on every response: CSP (defense-in-depth against
# stored XSS — see components/sanitize.js for the primary mitigation),
# nosniff, frame-ancestors (clickjacking), Referrer-Policy, and HSTS on HTTPS.
#
# CSP is the most error-prone: any external origin the app loads must be
# explicitly allowlisted, or browsers refuse to load it.
#
# Allowed external origins:
#   - cdnjs.cloudflare.com         React, ReactDOM, DOMPurify (with SRI)
#   - fonts.googleapis.com         <link> stylesheet for Playfair Display + DM Sans
#   - fonts.gstatic.com            actual font file downloads
#   - *.googleusercontent.com      profile pictures from /auth/me userinfo (lh3/lh4/lh5/...)
#
# The inline <style> block in index.html requires 'unsafe-inline' for
# style-src — acceptable risk (CSS XSS is much less powerful than JS XSS).
# The inline <script> mount was extracted to /mount.js precisely so we can
# keep script-src strict (no 'unsafe-inline').
# Whether we serve over HTTPS — drives Secure cookies, SessionMiddleware
# https_only, and HSTS. TWO independent signals so a single misconfigured env
# var can't silently turn transport security OFF (SECURITY_REVIEW.md H7): an
# explicit LTP_FORCE_HTTPS switch (set this in production), OR an https://
# redirect URI. Per-request transport (X-Forwarded-Proto) is additionally
# honored for the app-session cookie in routes/auth.py.
_FORCE_HTTPS = os.environ.get("LTP_FORCE_HTTPS", "").strip().lower() in ("1", "true", "yes", "on")
_IS_HTTPS = _FORCE_HTTPS or os.environ.get("LTP_OAUTH_REDIRECT_URI", "").startswith("https://")
# img-src: tightened from a bare `https:` wildcard (an easy XSS data-exfil
# channel — encode stolen data into an image URL to an attacker host) to a host
# allowlist (SECURITY_REVIEW.md M2). Covers Google profile avatars, the storage
# host used by email-signature icons in the Send preview, and the LTP logo
# host. `data:` stays for canvas signatures + base64-pasted logos (a data: URL
# issues no network request, so it is not an exfil vector). A deploy whose
# Settings.logoUrl lives on another host adds it via LTP_IMG_SRC_EXTRA
# (space-separated origins). style-src keeps 'unsafe-inline' — React inline
# styles and the sanitized email preview rely on it; removing it needs a nonce
# architecture (tracked as future work).
_IMG_SRC_EXTRA = os.environ.get("LTP_IMG_SRC_EXTRA", "").strip()
_IMG_SRC = (
    "img-src 'self' data: "
    "https://*.googleusercontent.com https://googleusercontent.com "
    "https://storage.googleapis.com "
    "https://www.luminarytechnology.productions https://luminarytechnology.productions"
    + ((" " + _IMG_SRC_EXTRA) if _IMG_SRC_EXTRA else "")
    + "; "
)
_CSP = (
    "default-src 'self'; "
    "script-src 'self' https://cdnjs.cloudflare.com; "
    # Service worker (/sw.js) and the web-app manifest are same-origin. Both
    # otherwise fall back to default-src 'self' (so the PWA already works), but
    # we make the allowance explicit so a future default-src tightening can't
    # silently break installability.
    "worker-src 'self'; "
    "manifest-src 'self'; "
    # Fonts are self-hosted (assets/fonts.css + assets/fonts/*.woff2), so style
    # and font sources are 'self' only — no fonts.googleapis.com / gstatic.com
    # (SECURITY_REVIEW.md L8). style-src keeps 'unsafe-inline' (React inline
    # styles + sanitized email preview).
    "style-src 'self' 'unsafe-inline'; "
    "font-src 'self'; "
    + _IMG_SRC +
    # connect-src governs fetch/XHR AND source-map fetches DevTools makes for
    # external scripts. Allowing cdnjs here prevents the console-error noise
    # when DevTools tries to grab .map files for the React/DOMPurify scripts.
    # Production behavior is identical either way (browsers don't fetch maps
    # unless DevTools is open).
    "connect-src 'self' https://cdnjs.cloudflare.com; "
    "object-src 'none'; "
    "base-uri 'self'; "
    # appcenter.intuit.com is where /api/qbo/connect redirects the browser to
    # start the QuickBooks OAuth consent flow (mirrors accounts.google.com).
    "form-action 'self' https://accounts.google.com https://appcenter.intuit.com; "
    "frame-ancestors 'none'"
)
_SECURITY_HEADERS = [
    (b"content-security-policy", _CSP.encode("ascii")),
    (b"x-content-type-options", b"nosniff"),
    # X-Frame-Options is legacy but adds defense-in-depth for older browsers
    # that don't honor frame-ancestors. The two directives agree.
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"strict-origin-when-cross-origin"),
    (b"cross-origin-opener-policy", b"same-origin"),
    # Isolate our resources from cross-origin embedding (SECURITY_REVIEW.md L6).
    # COEP is deliberately NOT set — require-corp would break the CDN-loaded
    # React/DOMPurify scripts.
    (b"cross-origin-resource-policy", b"same-origin"),
    # Drop access to browser features the app never uses, so an injected script
    # can't reach them either. EXCEPTION: camera=(self) — the rentals barcode
    # scan-import flow (modules/rentals-scan.js) reads the phone camera via
    # getUserMedia to decode unit barcodes. `(self)` allows it ONLY for our own
    # origin (never cross-origin/iframe embeds); microphone stays fully off.
    (b"permissions-policy",
     b"geolocation=(), microphone=(), camera=(self), payment=(), usb=(), "
     b"magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()"),
]
if _IS_HTTPS:
    # 1 year, include subdomains. No `preload` — that submits the domain to
    # browsers' preload list, which is hard to undo. Add it once the app has
    # run stably on HTTPS for 12+ months if you want.
    _SECURITY_HEADERS.append(
        (b"strict-transport-security", b"max-age=31536000; includeSubDomains")
    )


class SecurityHeadersMiddleware:
    """Pure ASGI middleware that appends standard security headers to every
    HTTP response (except the 101 WebSocket upgrade and lifespan messages).
    Inserting via raw ASGI rather than Starlette's BaseHTTPMiddleware avoids
    re-buffering the response body."""

    def __init__(self, app, headers):
        self.app = app
        self.headers = list(headers)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def add_headers(msg):
            if msg["type"] == "http.response.start":
                # Avoid duplicates: if any of our headers are already set
                # (rare — e.g. a route hand-set CSP), respect the route's.
                existing = {name for (name, _) in msg.get("headers", [])}
                injected = [(n, v) for (n, v) in self.headers if n not in existing]
                msg = {
                    **msg,
                    "headers": list(msg.get("headers", [])) + injected,
                }
            await send(msg)

        await self.app(scope, receive, add_headers)


# Add middlewares. ORDER MATTERS: Starlette processes them outer-first on
# the way IN and inner-first on the way OUT. Last-added = outermost. We want
# this execution order on incoming requests:
#   1. SecurityHeaders   — wraps EVERY response (including rejections below)
#   2. CsrfOrigin        — reject cross-origin state-changing requests (H8)
#   3. RateLimit         — reject /auth/* floods before they hit OAuth
#   4. PayloadSizeLimit  — reject oversize bodies before SessionMiddleware
#                          tries to read cookies (cookies are small; body isn't)
#   5. SessionMiddleware — Authlib's signed state cookie
#   6. (routes)
# Therefore add in reverse order (innermost first):
app.add_middleware(PayloadSizeLimitMiddleware, max_bytes=MAX_PAYLOAD_BYTES)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(CsrfOriginMiddleware)
app.add_middleware(SecurityHeadersMiddleware, headers=_SECURITY_HEADERS)


# ── Starlette SessionMiddleware ─────────────────────────────────────────────
# This is NOT our app session — it's a separate signed cookie that Authlib
# uses to round-trip the OAuth state/nonce while the user is at Google. Our
# real app session lives in the `ltp_session` cookie + `sessions` DB table.
# `LTP_SESSION_SECRET` should be a long random hex string — generate with
# `python -c "import secrets; print(secrets.token_hex(32))"`.
# The secret signs the Starlette session cookie that round-trips the OAuth
# state/nonce — the primary OAuth-CSRF defense. Requirements:
#   - Production (HTTPS deploy): MUST be set and strong, or we refuse to boot.
#     The old behaviour generated an ephemeral per-process key and continued,
#     which silently broke OAuth across restarts/workers and masked the
#     misconfiguration until logins started failing (SECURITY_REVIEW.md H6).
#   - When a value IS provided (any environment): enforce a minimum length so
#     a weak/guessable secret can't slip through.
#   - Local dev only (non-HTTPS, unset): fall back to an ephemeral key with a
#     loud warning, so running locally Just Works without ceremony.
_MIN_SESSION_SECRET_LEN = 32  # chars; token_hex(32) → 64, token_urlsafe(32) → 43
_session_secret = os.environ.get("LTP_SESSION_SECRET", "")
if _session_secret:
    if len(_session_secret) < _MIN_SESSION_SECRET_LEN:
        raise RuntimeError(
            f"LTP_SESSION_SECRET is too short ({len(_session_secret)} chars); "
            f"need >= {_MIN_SESSION_SECRET_LEN}. Generate one with "
            f'`python -c "import secrets; print(secrets.token_hex(32))"`.'
        )
elif _IS_HTTPS:
    # Fail fast at boot rather than booting with an ephemeral key that breaks
    # OAuth later in a way that looks like an app bug, not a config error.
    raise RuntimeError(
        "LTP_SESSION_SECRET is not set. It is required in production "
        "(an HTTPS LTP_OAUTH_REDIRECT_URI was detected). Generate one with "
        '`python -c "import secrets; print(secrets.token_hex(32))"` and set it '
        "in the environment."
    )
else:
    print("[LTP] WARNING: LTP_SESSION_SECRET not set — using ephemeral dev key. "
          "Sessions will break across restarts. Set it for any shared/HTTPS "
          "deployment.", flush=True)
    import secrets as _secrets
    _session_secret = _secrets.token_hex(32)

app.add_middleware(
    SessionMiddleware,
    secret_key=_session_secret,
    same_site="lax",
    https_only=_IS_HTTPS,
)

print(f"[LTP] payload size limit: {MAX_PAYLOAD_BYTES} bytes "
      f"({MAX_PAYLOAD_BYTES // 1024 // 1024} MB)", flush=True)

# Access-control posture warning. If neither allowlist is configured, ANY Google
# account can sign in (and on a brand-new deployment the first sign-in becomes
# admin). We warn loudly rather than fail closed, because hard-requiring an
# allowlist could lock out an owner on a shared domain like gmail.com
# (SECURITY_REVIEW.md M4). Set LTP_ALLOWED_DOMAIN and/or LTP_ALLOWED_EMAILS.
if not (os.environ.get("LTP_ALLOWED_DOMAIN", "").strip()
        or os.environ.get("LTP_ALLOWED_EMAILS", "").strip()):
    print("[LTP] WARNING: neither LTP_ALLOWED_DOMAIN nor LTP_ALLOWED_EMAILS is "
          "set — any Google account can sign in. Set one to restrict access.",
          flush=True)


# ── Authlib OAuth client ────────────────────────────────────────────────────
# Stashed on app.state so routes/auth.py can pull it via the Request.
#
# Scope list:
#   openid email profile     — identity (sub claim, email, name, picture)
#   gmail.send               — send email as the signed-in user (no read access
#                              to their inbox, no full Gmail). Required for the
#                              per-user Gmail send feature; users grant on first
#                              sign-in after this scope shipped.
#
# access_type=offline + prompt=consent at the /auth/login redirect (see
# routes/auth.py) force Google to issue a refresh_token in the token response
# every time. Without prompt=consent, Google issues a refresh_token only on
# the very first consent — and we cannot tell at callback time whether this
# was that first time, so the refresh_token would silently go missing for
# every returning user.
GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"
oauth = OAuth()
oauth.register(
    name="google",
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_id=os.environ.get("GOOGLE_CLIENT_ID", ""),
    client_secret=os.environ.get("GOOGLE_CLIENT_SECRET", ""),
    client_kwargs={"scope": f"openid email profile {GMAIL_SEND_SCOPE}"},
)
# ── QuickBooks Online (Intuit) OAuth client ─────────────────────────────────
# Company-wide accounting connection (one realm) — see backend/routes/qbo.py
# and backend/quickbooks.py. Single least-privilege scope; no payroll/payments.
# Tokens are exchanged + refreshed server-side and stored encrypted in the
# qbo_connection table. Credentials come from QBO_CLIENT_ID / QBO_CLIENT_SECRET;
# QBO_REDIRECT_URI must match the Intuit Developer app's redirect URI, and
# QBO_ENVIRONMENT selects sandbox vs production.
oauth.register(
    name="intuit",
    server_metadata_url="https://developer.api.intuit.com/.well-known/openid_configuration",
    client_id=os.environ.get("QBO_CLIENT_ID", ""),
    client_secret=os.environ.get("QBO_CLIENT_SECRET", ""),
    client_kwargs={"scope": "com.intuit.quickbooks.accounting"},
)
app.state.oauth = oauth


# ── Routers ─────────────────────────────────────────────────────────────────
# IMPORTANT: register API + auth routers BEFORE the static catch-all below.
# FastAPI dispatches in registration order; if the `/{full_path}` route is
# registered first it would swallow `/auth/login` etc.
app.include_router(auth_router)
app.include_router(api_router)
# PDF: api_pdf_router holds the session-gated POST endpoints (under /api/);
# public_pdf_router holds the tokenized GET endpoint (under /pdf/) which
# intentionally bypasses session auth — the token is the credential.
app.include_router(api_pdf_router)
app.include_router(public_pdf_router)
# Public client-view: token-only, no session. Lives under /api/view/* so the
# existing catch-all early-return (api/ prefix) covers it; we don't need a
# separate prefix exclusion.
app.include_router(view_router)
# Crew requests: crew_public_router is token-only (no session) under
# /api/crew/* — the crew member's accept/decline landing page; crew_admin_router
# is session-gated under /api/crew-requests/* — the producer's send/withdraw/
# list. Both sit under /api/ so the static catch-all's api/ early-return covers
# unmatched sub-paths. See backend/routes/crew.py.
app.include_router(crew_public_router)
app.include_router(crew_admin_router)
# Email send: session-gated. Per-user Gmail via OAuth scope gmail.send;
# see backend/routes/email.py for the full lifecycle.
app.include_router(email_router)
# QuickBooks Online: admin-managed company connection + invoice push.
# Session/admin-gated; see backend/routes/qbo.py.
app.include_router(qbo_router)
# Web Push: session-gated subscription management under /api/push/*. Sending
# lives in backend/webpush.py, fired inline from event sites. See backend/routes/push.py.
app.include_router(push_router)


# ── Static frontend serving ─────────────────────────────────────────────────
# Files live at the project root (one level up from backend/).
frontend_dir = os.path.realpath(os.path.dirname(os.path.dirname(__file__)))

# Strict allowlist — deny by default. The project root contains things we do
# NOT want exposed (requirements.txt, railway.json, .env files, the entire
# backend/ tree, etc.). Only the explicit set below is reachable; everything
# else falls through to index.html so the SPA can still handle unknown client routes.
_ALLOWED_TOP_LEVEL_FILES = {
    "index.html", "app.js", "mount.js", "router.js", "theme.js", "favicon.ico",
}
_ALLOWED_TREES = {
    "components/": (".js",),
    "data/":       (".js",),
    "modules/":    (".js",),
    "assets/":     (".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp", ".ico",
                    ".woff", ".woff2", ".ttf", ".eot", ".otf", ".css"),
}


def _resolve_static(full_path):
    """Resolve a request path to an absolute file inside frontend_dir.
    Returns None unless the request matches the explicit allowlist. Defends
    against ../ traversal, percent-encoded escapes, symlinks, cross-drive
    paths, AND access to in-repo files that aren't part of the frontend."""
    if not full_path:
        return None
    candidate = os.path.realpath(os.path.join(frontend_dir, full_path))
    try:
        common = os.path.commonpath([frontend_dir, candidate])
    except ValueError:
        return None
    if common != frontend_dir:
        return None
    if not os.path.isfile(candidate):
        return None
    rel = os.path.relpath(candidate, frontend_dir).replace(os.sep, "/")
    if rel in _ALLOWED_TOP_LEVEL_FILES:
        return candidate
    for prefix, exts in _ALLOWED_TREES.items():
        if rel.startswith(prefix) and rel.endswith(exts):
            return candidate
    return None


# ── App variant (dev vs prod home-screen identity) ───────────────────────────
# When a deployment sets LTP_APP_VARIANT=dev, the PWA gets a distinct icon set
# and name ("LTP Dev") so an installed dev app is unmistakable next to
# production on the home screen. The switch is env-driven, NOT branch-driven:
# the code + dev icons live on every branch, but only activate where the var is
# set (e.g. the dev Railway deployment). Production, with the var unset, is
# byte-for-byte unaffected — nothing can leak the dev identity into prod.
_APP_VARIANT = os.environ.get("LTP_APP_VARIANT", "").strip().lower()
_IS_DEV_VARIANT = _APP_VARIANT == "dev"
_DEV_ICON_DIR = os.path.realpath(os.path.join(frontend_dir, "assets", "icons", "dev"))


def _dev_icon_path(icon_name: str):
    """Absolute path to the dev-variant icon of this basename, or None when not
    running the dev variant / no such dev file. basename-only (rejects any
    separators or dotfiles) and confined to the dev icon dir — no traversal."""
    if not _IS_DEV_VARIANT or not icon_name:
        return None
    if "/" in icon_name or "\\" in icon_name or icon_name.startswith("."):
        return None
    cand = os.path.realpath(os.path.join(_DEV_ICON_DIR, icon_name))
    try:
        if os.path.commonpath([_DEV_ICON_DIR, cand]) != _DEV_ICON_DIR:
            return None
    except ValueError:
        return None
    return cand if os.path.isfile(cand) else None


# ── PWA endpoints ────────────────────────────────────────────────────────────
# The service worker and web-app manifest are root-scoped files. They are
# intentionally NOT in the static allowlist above (and need response headers the
# generic FileResponse path doesn't set), so they get dedicated routes here —
# registered BEFORE the catch-all so it can't swallow them and return index.html.
@app.get("/sw.js")
async def service_worker():
    # media_type is explicit because a stale mimetypes map could otherwise serve
    # the worker as text/plain (browsers refuse to register a non-JS worker).
    # no-cache: always revalidate so an updated worker is picked up promptly.
    # Service-Worker-Allowed: / lets a /sw.js worker claim the whole origin.
    resp = FileResponse(os.path.join(frontend_dir, "sw.js"), media_type="text/javascript")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["Service-Worker-Allowed"] = "/"
    return resp


@app.get("/manifest.webmanifest")
async def web_manifest():
    # mimetypes doesn't reliably know .webmanifest, so set it explicitly.
    path = os.path.join(frontend_dir, "manifest.webmanifest")
    if _IS_DEV_VARIANT:
        # Dev deployment: rename to "LTP Dev". The icon `src`s stay the same
        # paths — the /assets/icons route below serves the dev bytes (the "DEV"
        # variant) for them. Theme/background stay the base slate so the splash
        # matches the dev icon's field. Built from the base file so every other
        # field stays a single source of truth.
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            data["name"] = "LTP Dev"
            data["short_name"] = "LTP Dev"
            resp = JSONResponse(data, media_type="application/manifest+json")
            resp.headers["Cache-Control"] = "no-cache"
            return resp
        except Exception as e:
            print(f"[LTP] dev manifest build failed, serving base: {e}", flush=True)
    resp = FileResponse(path, media_type="application/manifest+json")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/assets/icons/{icon_name}")
async def app_icon(icon_name: str):
    """PWA / home-screen icons. On the dev deployment (LTP_APP_VARIANT=dev) the
    dev-variant file of the same basename is served in place of the prod icon,
    so an installed dev PWA is visibly distinct (violet field + "DEV" tag).
    Registered before the catch-all so it wins for these paths; falls back to
    the normal allowlisted static file when there's no dev override."""
    dev = _dev_icon_path(icon_name)
    if dev:
        return FileResponse(dev)
    static = _resolve_static(f"assets/icons/{icon_name}")
    if static:
        return FileResponse(static)
    return Response(status_code=404)


@app.get("/favicon.ico")
async def favicon():
    """Browser-tab icon — dev variant swapped in on the dev deployment."""
    dev = _dev_icon_path("favicon.ico")
    return FileResponse(dev or os.path.join(frontend_dir, "favicon.ico"))


_INDEX_PATH = os.path.realpath(os.path.join(frontend_dir, "index.html"))
# Exact strings rewritten for the dev deployment so the installed app reads
# "LTP Dev" instead of "LTP". Kept as full-tag literals so a replace can't
# accidentally match anything else in the document.
_APPLE_TITLE_PROD = '<meta name="apple-mobile-web-app-title" content="LTP" />'
_APPLE_TITLE_DEV = '<meta name="apple-mobile-web-app-title" content="LTP Dev" />'
_DOC_TITLE_PROD = "<title>LTP Business Suite</title>"
_DOC_TITLE_DEV = "<title>LTP Dev — Business Suite</title>"


def _index_response():
    """Serve index.html. On the dev deployment (LTP_APP_VARIANT=dev) rewrite the
    iOS home-screen app name (apple-mobile-web-app-title) and the document title
    to the 'LTP Dev' identity — iOS reads the home-screen label from that meta
    tag, not the manifest. Production is served verbatim from disk (unchanged)."""
    if _IS_DEV_VARIANT:
        try:
            with open(_INDEX_PATH, "r", encoding="utf-8") as f:
                html = f.read()
            html = html.replace(_APPLE_TITLE_PROD, _APPLE_TITLE_DEV)
            html = html.replace(_DOC_TITLE_PROD, _DOC_TITLE_DEV)
            resp = HTMLResponse(html)
            resp.headers["Cache-Control"] = "no-cache"
            return resp
        except Exception as e:
            print(f"[LTP] dev index rewrite failed, serving base: {e}", flush=True)
    resp = FileResponse(_INDEX_PATH)
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/{full_path:path}")
async def serve_frontend(full_path: str):
    # Anything under api/, auth/, or pdf/ that didn't match the routers
    # above is a genuinely unknown endpoint — 404 instead of returning
    # index.html, which would otherwise mask typos.
    if full_path.startswith("api/") or full_path.startswith("auth/") or full_path.startswith("pdf/"):
        return Response(status_code=404)

    static = _resolve_static(full_path)
    if static:
        # index.html gets the dev-name rewrite (below); all other statics served
        # straight from disk.
        if os.path.realpath(static) == _INDEX_PATH:
            return _index_response()
        resp = FileResponse(static)
        # App code (HTML/JS/CSS) is served from un-versioned filenames
        # (e.g. /theme.js), so without this a browser's heuristic cache could
        # keep serving a stale copy AFTER a deploy — masking frontend fixes
        # until a manual hard-refresh. `no-cache` forces revalidation on every
        # load; FileResponse's ETag makes that a cheap 304 when unchanged and a
        # fresh 200 when the deploy changed the file. Fonts/images keep the
        # default (revalidated) caching.
        if static.endswith((".js", ".css", ".html")):
            resp.headers["Cache-Control"] = "no-cache"
        return resp

    # SPA fallback for any unknown path (also the dev-name rewrite applies).
    return _index_response()
