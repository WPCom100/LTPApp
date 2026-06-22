"""Origin/Referer CSRF defense for state-changing requests.

The app authenticates with a cookie (`ltp_session`); `SameSite=Lax` was the
only other CSRF barrier. This pure-ASGI middleware adds an Origin/Referer check
on every UNSAFE method (POST/PUT/DELETE/PATCH): the request's `Origin` (or,
when absent, `Referer`) host must match an allowed origin — the app's own host.
A cross-site forgery from evil.com carries `Origin: https://evil.com`, which
fails the check and is rejected with 403.

Design choices (SECURITY_REVIEW.md H8):
  - Requests with NEITHER Origin nor Referer are ALLOWED. Browsers always send
    Origin on cross-origin unsafe requests, so absence means it isn't a browser
    CSRF — this keeps server-to-server callers, curl, and the test client
    working without weakening the CSRF property.
  - Safe methods (GET/HEAD/OPTIONS/TRACE) are never checked; they must be
    side-effect-free anyway, and the OAuth callbacks are GETs.
  - The allowed set includes the request's own Host header, so same-origin SPA
    calls always pass. An attacker cannot make a browser send a matching Origin
    cross-origin, so including Host does not weaken the check.
"""
import os
from urllib.parse import urlparse

_SAFE_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}


def _allowed_hosts(request_host: str) -> set:
    """Hosts that may originate a state-changing request: the configured app
    origin (from the OAuth redirect URI), any LTP_EXTRA_ORIGINS, and the
    request's own Host."""
    hosts = set()
    redirect = os.environ.get("LTP_OAUTH_REDIRECT_URI", "")
    if redirect:
        hosts.add(urlparse(redirect).netloc)
    for extra in os.environ.get("LTP_EXTRA_ORIGINS", "").split(","):
        extra = extra.strip()
        if extra:
            hosts.add(urlparse(extra).netloc if "//" in extra else extra)
    if request_host:
        hosts.add(request_host)
    return {h for h in hosts if h}


class CsrfOriginMiddleware:
    """Reject cross-origin state-changing requests by Origin/Referer."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        method = scope.get("method", "GET").upper()
        if method in _SAFE_METHODS:
            return await self.app(scope, receive, send)

        # Single-valued headers we care about; latin-1 is the HTTP header charset.
        origin = referer = host = ""
        for k, v in scope.get("headers", []):
            name = k.decode("latin-1").lower()
            if name == "origin":
                origin = v.decode("latin-1")
            elif name == "referer":
                referer = v.decode("latin-1")
            elif name == "host":
                host = v.decode("latin-1")

        source = origin or referer
        if source:
            source_host = urlparse(source).netloc
            if source_host not in _allowed_hosts(host):
                return await self._reject(send)
        # No Origin/Referer present → not a browser CSRF → allow through.
        return await self.app(scope, receive, send)

    async def _reject(self, send):
        body = b'{"error":"cross-origin request blocked"}'
        await send({
            "type": "http.response.start",
            "status": 403,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
        })
        await send({"type": "http.response.body", "body": body})
