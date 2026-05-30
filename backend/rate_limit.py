"""Lightweight rate limiter for the auth endpoints.

Why hand-rolled instead of slowapi? slowapi adds a dependency, optional Redis,
and decorator machinery we don't need. Our scale is one-pod single-tenant; an
in-process fixed-window counter is plenty.

What it protects against:
  - Bots looping /auth/login to burn Google OAuth quota
  - Bots replaying /auth/callback with junk codes (each one hits Google's
    token endpoint, costing bandwidth + quota)
  - General request-flood DOS against the auth surface

What it doesn't protect against:
  - Distributed attacks (many IPs). For that, run a real WAF/CDN in front.
  - Authenticated abuse — /api/* uses session auth, which has its own
    expensive-to-create cookies; spam attempts get 401 cheaply.

The counter resets every WINDOW_SECONDS; not a token bucket. Edge cases at
window boundaries are acceptable for this scale (a perfectly-timed attacker
could double the rate for one second per window — meaningless).
"""
import time
from typing import Optional
from fastapi import Response


# Per-(ip, route) limits. Tuned for: one human signs in ~once per day; bots
# loop hundreds of times per minute. 10/min per IP gives humans 60x headroom
# while making bot floods useless.
WINDOW_SECONDS = 60
LIMITS = {
    "/auth/login":    10,   # initiating OAuth — cheap for us
    "/auth/callback": 10,   # exchanging code — costs us a Google API call
}


class _RateLimitState:
    """Fixed-window counters keyed by (ip, route, window_start).

    Memory bound: every (ip, route) pair seen in the last WINDOW_SECONDS lives
    in `_counts`. A periodic compaction (every N inserts) drops stale entries.
    """
    def __init__(self):
        self._counts: dict = {}
        self._inserts_since_compact = 0
        self._compact_interval = 500

    def _compact(self, now: int):
        cutoff = now - WINDOW_SECONDS
        self._counts = {k: v for k, v in self._counts.items() if k[2] > cutoff}
        self._inserts_since_compact = 0

    def hit(self, ip: str, route: str, limit: int) -> tuple[bool, int]:
        """Record a hit; return (allowed, retry_after_seconds).
        retry_after is non-zero only on rejection (when the window closes)."""
        now = int(time.time())
        window_start = now - (now % WINDOW_SECONDS)
        key = (ip, route, window_start)
        count = self._counts.get(key, 0) + 1
        self._counts[key] = count
        self._inserts_since_compact += 1
        if self._inserts_since_compact >= self._compact_interval:
            self._compact(now)
        if count > limit:
            retry_after = WINDOW_SECONDS - (now - window_start)
            return False, max(1, retry_after)
        return True, 0


_state = _RateLimitState()


def _client_ip(scope) -> str:
    """Extract the originating IP. Behind Railway's proxy the real client
    address is in X-Forwarded-For; the first entry is the original client.
    Falls back to the direct connection IP if no proxy header (local dev)."""
    for name, value in scope.get("headers", []):
        if name == b"x-forwarded-for":
            try:
                return value.decode("ascii", errors="replace").split(",")[0].strip()
            except Exception:
                pass
    client = scope.get("client")
    return client[0] if client else "unknown"


class RateLimitMiddleware:
    """Pure ASGI middleware. Applies LIMITS only to the routes named there;
    every other path passes through untouched. Returns 429 with a
    Retry-After header when the limit is exceeded."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        path = scope.get("path", "")
        limit = LIMITS.get(path)
        if limit is None:
            return await self.app(scope, receive, send)

        ip = _client_ip(scope)
        allowed, retry_after = _state.hit(ip, path, limit)
        if allowed:
            return await self.app(scope, receive, send)

        body = (
            b'{"error":"Rate limit exceeded",'
            b'"retry_after_seconds":'
            + str(retry_after).encode("ascii")
            + b"}"
        )
        await send(
            {
                "type": "http.response.start",
                "status": 429,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                    (b"retry-after", str(retry_after).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
