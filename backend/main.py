import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.responses import FileResponse, Response
from starlette.middleware.sessions import SessionMiddleware
from authlib.integrations.starlette_client import OAuth

from backend.database import init_db
from backend.routes.api import router as api_router
from backend.routes.auth import router as auth_router
from backend.rate_limit import RateLimitMiddleware


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


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
_IS_HTTPS = os.environ.get("LTP_OAUTH_REDIRECT_URI", "").startswith("https://")
_CSP = (
    "default-src 'self'; "
    "script-src 'self' https://cdnjs.cloudflare.com; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com; "
    # img-src: allow any HTTPS image, not just Google avatars. Reasoning:
    #   1. Google's profile-picture URLs come from multiple hosts
    #      (lh3.googleusercontent.com mostly, but also lh4/lh5/lh6/bare-host
    #      depending on account type). A wildcard over googleusercontent.com
    #      misses the bare host; explicitly listing every variant is brittle.
    #   2. Settings.logoUrl is user-configurable — could be any HTTPS URL.
    #   3. <img> elements don't execute code; loading from an arbitrary HTTPS
    #      origin only reveals the user's IP and a "this app is in use" signal
    #      to whoever owns the image. The XSS path that would let an attacker
    #      inject <img> is already blocked by DOMPurify in sanitize.js.
    # data: is also allowed for inline/embedded images (logo pasted as base64).
    "img-src 'self' data: https:; "
    # connect-src governs fetch/XHR AND source-map fetches DevTools makes for
    # external scripts. Allowing cdnjs here prevents the console-error noise
    # when DevTools tries to grab .map files for the React/DOMPurify scripts.
    # Production behavior is identical either way (browsers don't fetch maps
    # unless DevTools is open).
    "connect-src 'self' https://cdnjs.cloudflare.com; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'self' https://accounts.google.com; "
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
#   2. RateLimit         — reject /auth/* floods before they hit OAuth
#   3. PayloadSizeLimit  — reject oversize bodies before SessionMiddleware
#                          tries to read cookies (cookies are small; body isn't)
#   4. SessionMiddleware — Authlib's signed state cookie
#   5. (routes)
# Therefore add in reverse order (innermost first):
app.add_middleware(PayloadSizeLimitMiddleware, max_bytes=MAX_PAYLOAD_BYTES)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(SecurityHeadersMiddleware, headers=_SECURITY_HEADERS)


# ── Starlette SessionMiddleware ─────────────────────────────────────────────
# This is NOT our app session — it's a separate signed cookie that Authlib
# uses to round-trip the OAuth state/nonce while the user is at Google. Our
# real app session lives in the `ltp_session` cookie + `sessions` DB table.
# `LTP_SESSION_SECRET` should be a long random hex string — generate with
# `python -c "import secrets; print(secrets.token_hex(32))"`.
_session_secret = os.environ.get("LTP_SESSION_SECRET", "")
if not _session_secret:
    # Last-resort fallback for local dev; production MUST set this. We loudly
    # warn in production-looking deployments (HTTPS redirect URI) and fail
    # fast on the next OAuth attempt since the state cookie won't validate.
    if _IS_HTTPS:
        print("[LTP] ERROR: LTP_SESSION_SECRET not set in HTTPS environment — "
              "OAuth flow WILL fail until you set this env var.", flush=True)
    else:
        print("[LTP] WARNING: LTP_SESSION_SECRET not set — using ephemeral dev key. "
              "Sessions will break across restarts.", flush=True)
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


# ── Authlib OAuth client ────────────────────────────────────────────────────
# Stashed on app.state so routes/auth.py can pull it via the Request.
oauth = OAuth()
oauth.register(
    name="google",
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_id=os.environ.get("GOOGLE_CLIENT_ID", ""),
    client_secret=os.environ.get("GOOGLE_CLIENT_SECRET", ""),
    client_kwargs={"scope": "openid email profile"},
)
app.state.oauth = oauth


# ── Routers ─────────────────────────────────────────────────────────────────
# IMPORTANT: register API + auth routers BEFORE the static catch-all below.
# FastAPI dispatches in registration order; if the `/{full_path}` route is
# registered first it would swallow `/auth/login` etc.
app.include_router(auth_router)
app.include_router(api_router)


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


@app.get("/{full_path:path}")
async def serve_frontend(full_path: str):
    # Anything under api/ or auth/ that didn't match the routers above is a
    # genuinely unknown endpoint — 404 instead of returning index.html, which
    # would otherwise mask typos.
    if full_path.startswith("api/") or full_path.startswith("auth/"):
        return Response(status_code=404)

    static = _resolve_static(full_path)
    if static:
        return FileResponse(static)

    # SPA fallback for any unknown path
    return FileResponse(os.path.join(frontend_dir, "index.html"))
