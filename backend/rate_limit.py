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
import os

from backend.env import env_int
import time
from fastapi import Response


# Per-(ip, route-bucket) limits, requests per WINDOW_SECONDS. Tuned for: one
# human acts a handful of times per minute; bots loop hundreds of times per
# minute. The limits below give humans ample headroom while making floods
# useless.
#
# Rules are matched by longest PATH-SEGMENT PREFIX (see _match_rule), so a
# single rule covers a whole route family — e.g. "/api/view" buckets every
# "/api/view/<token>/..." sub-path together. This closes the prior gap where
# only the two exact /auth paths were limited and every public token route,
# the PDF generator, the email relay, and the bulk-sync wipe were unthrottled
# (SECURITY_REVIEW.md H2).
WINDOW_SECONDS = 60
_RULES = [
    # OAuth: cheap to initiate, costs a provider call to exchange the code.
    ("/auth/login",       10),
    ("/auth/callback",    10),
    ("/api/qbo/callback", 10),   # QuickBooks OAuth callback — same class
    # Public, UNAUTHENTICATED token surfaces. No login cost to an attacker, so
    # tight buckets: blunt share-token enumeration and, for /pdf,
    # unauthenticated PDF-generation DoS (every hit runs ReportLab).
    ("/api/view",         60),
    # Crew accept/decline landing page — same class as /api/view (token is the
    # credential, no session). Note: this rule covers /api/crew/<token>/... but
    # NOT the session-gated producer routes at /api/crew-requests/... — the
    # longest-prefix matcher treats "/api/crew-requests" as a separate path
    # ("/api/crew" only matches "/api/crew" or "/api/crew/...").
    ("/api/crew",         60),
    # Public, UNAUTHENTICATED avatar bytes (embedded in email signatures). The
    # token is unguessable and each hit serves small cached bytes, so a generous
    # bucket — one email render can load several avatars, and pages fan out too.
    ("/api/users/photo",  120),
    ("/pdf",              30),
    # Authenticated but sensitive. Per-IP backstop on top of the recipient cap
    # (H4) for the Gmail relay, and on the destructive bulk wipe/repopulate.
    ("/api/email/send",   20),
    # Label OCR — each hit is a paid Anthropic API call, so bound per-IP spend.
    # 30/min is far above real scanning cadence (it only fires on barcode
    # misses) while capping a hostile/runaway client at pennies per minute.
    ("/api/scan",         30),
]


def _match_rule(path: str):
    """Return (route_key, limit) for the longest matching path-segment prefix,
    or None if no rule applies. A rule prefix P matches `path` when the path
    equals P or starts with P + "/", so "/auth/login" won't match
    "/auth/loginX" and "/api/view" covers "/api/view/<token>" but not an
    unrelated "/api/viewer". The matched prefix becomes the counter bucket
    key, so all sub-paths of a family share one limit."""
    best = None
    best_len = -1
    for prefix, limit in _RULES:
        if (path == prefix or path.startswith(prefix + "/")) and len(prefix) > best_len:
            best = (prefix, limit)
            best_len = len(prefix)
    return best


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


# How many trusted proxy hops sit between the client and the app.
#
# Railway adds exactly one X-Forwarded-For hop (their edge proxy), so
# default = 1. If a CDN (Cloudflare, Fastly, etc.) is layered in front
# later, bump this to 2, and so on. Setting to 0 disables XFF parsing
# entirely — direct socket IP only, correct for purely-local dev with no
# proxy in the loop.
#
# The math: with N trusted hops, the (-N)th entry from the right end of
# XFF is the IP that the FIRST trusted hop observed connecting to it —
# i.e. the real client (assuming the trusted chain doesn't lie). Entries
# to the LEFT of that are client-supplied and CAN be spoofed; entries to
# the RIGHT are inner proxies and irrelevant for attribution.
#
# Previous bug: this code took XFF[0] (leftmost), which on Railway is
# trustworthy only when the client sends no XFF of their own. If the
# client sends `X-Forwarded-For: 1.2.3.4`, Railway appends its observed
# IP and the app sees `1.2.3.4, <real>` — XFF[0] is then the attacker's
# choice. The new code takes XFF[-1] for the default 1-hop config, which
# is always Railway's view of the connecting client.
# env_int, not a bare int(): a typo here used to raise at import time, which
# crash-loops the container before the app object exists — no traceback
# route, no health surface, just restarts. Negative hops are meaningless,
# so the floor rejects them too.
_TRUST_PROXY_HOPS = env_int("LTP_TRUST_PROXY_HOPS", 1, minimum=0)


def _client_ip(scope) -> str:
    """Extract the originating IP, accounting for the configured trusted
    proxy chain. Falls back to the direct socket IP when no XFF header is
    present (local dev), or when the header doesn't contain at least
    LTP_TRUST_PROXY_HOPS entries (misconfigured chain — safer to fall back
    than guess wrong).

    Why `len(parts) >= N` and not `> N`:
    in standard XFF semantics, EVERY entry was appended by a proxy from its
    view of the immediate predecessor — there is no "client-supplied untrusted
    entry that must precede the trusted N." When Railway adds exactly one
    entry, that single entry IS the trusted view of the client; the `>=`
    bound is what makes the common Railway-default case work. Matches
    Werkzeug's ProxyFix and similar libraries.

    The misconfiguration risk (operator sets HOPS higher than actual chain
    depth) is handled by documentation, not arithmetic — bumping HOPS without
    a corresponding proxy in front of the app would also be wrong with a `>`
    check, just in a different way (silently falls back to socket)."""
    if _TRUST_PROXY_HOPS > 0:
        for name, value in scope.get("headers", []):
            if name == b"x-forwarded-for":
                try:
                    parts = [
                        p.strip()
                        for p in value.decode("ascii", errors="replace").split(",")
                        if p.strip()
                    ]
                    if len(parts) >= _TRUST_PROXY_HOPS:
                        return parts[-_TRUST_PROXY_HOPS]
                except Exception:
                    pass
                break  # XFF present but unusable; fall through to socket
    client = scope.get("client")
    return client[0] if client else "unknown"


class RateLimitMiddleware:
    """Pure ASGI middleware. Applies the longest-matching rule from `_RULES`
    to each request; paths matching no rule pass through untouched. Returns
    429 with a Retry-After header when the limit is exceeded."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        path = scope.get("path", "")
        rule = _match_rule(path)
        if rule is None:
            return await self.app(scope, receive, send)
        route_key, limit = rule

        ip = _client_ip(scope)
        # Bucket on the matched prefix (not the full path) so every sub-path of
        # a route family shares one counter.
        allowed, retry_after = _state.hit(ip, route_key, limit)
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
