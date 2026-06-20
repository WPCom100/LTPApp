"""Heuristics for deciding whether a public-view hit deserves an activity
log entry, and helpers for shape-checking inbound request metadata.

Context
=======
The public view route (/api/view/{token}) and PDF route (/api/view/{token}/pdf)
log every "real" client open into the parent entity's activity feed so the
LTP user can see "Sarah's quote was opened by alice@biz.com at 14:32." But
"real" is doing a lot of work here — between the moment we send an email
and the moment a human reads it, the URL is hit by:

  - The sender's own outbox preview (Gmail web showing the sent message)
  - The recipient's mail server scanning the URL for malware/phishing
    (Mimecast, Proofpoint, Barracuda, Microsoft SafeLinks, GoogleImageProxy)
  - Link-preview generators (Slack, Discord, iMessage, Outlook preview)
  - The recipient's mail client prefetching the link
  - Web crawlers indexing the URL if it ever leaks

If we log every hit, the activity feed becomes useless within seconds —
half a dozen "viewed" entries appear in the first minute, none of them
the actual human. So we filter aggressively.

The 7-step gate
===============
Applied in order; first match short-circuits to "don't log":

  1. HEAD request                  → skip (scanners HEAD-probe URLs)
  2. Accept lacks text/html        → skip (API/scanner; humans say */* or text/html)
  3. ?preview=1 query param        → skip (LTP user opened via the Preview button)
  4. Valid LTP session cookie      → skip (LTP user opened the share URL directly)
  5. UA regex matches scanner/bot  → skip (Mimecast/SafeLinks/Googlebot/curl/...)
  6. email_sent ≤ 60s ago          → skip (mail-server scan window — fires within
                                       seconds of the inbound email reaching the recipient)
  7. Same (kind, id, debounce-key) → skip (already logged in the last 24h)
                                       in last 24h, in-memory

Anything that survives all seven gates is "a real client opening the link"
for our purposes. The token=credential design (anyone with the URL can hit
it) means we cannot achieve 100% precision — a real human SECOND open
within 24h won't re-log, an extremely fast scanner that doesn't match the
regex will sneak through — but the signal-to-noise ratio is what the
sender actually cares about.

Debounce state lives in process memory (app.state.client_view_seen). On
pod restart the debounce window resets. That's acceptable: an audit log
that's wrong about "this was their 3rd view today" is much less bad than
one that's silently wrong about "Alice opened your quote." If we ever
need durable cross-pod debounce we can move to Redis — out of scope for v1.
"""
import re
from datetime import datetime, timedelta, timezone

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend import models
from backend.rate_limit import _client_ip


# UA-based bot suppression. Case-insensitive. Patterns chosen for the
# scanner/preview generators that actually hit business-email URLs in
# practice — see the gate-step #5 comment above for context.
#
# Note: this list is INTENTIONALLY broad. False positives here mean we
# fail to log a real human view; false negatives mean we log a scanner
# hit and pollute the activity feed. The latter is worse for the LTP
# user's mental model, so we err toward over-suppression. Real humans
# whose first open we miss will still see their NEXT open logged after
# the 24h debounce window (gate 7) expires — i.e. once.
_BOT_UA_RE = re.compile(
    r"(?i)"
    r"bot|crawler|spider|preview|fetch|scanner|"
    r"safelinks|googleimageproxy|mimecast|proofpoint|barracuda|"
    r"headlesschrome|phantomjs|puppeteer|playwright|selenium|"
    r"curl|wget|python|java|"
    r"go-http-client|httpx|aiohttp|axios|node-fetch|guzzlehttp|"
    r"facebookexternalhit|whatsapp|slackbot|discordbot|telegrambot|"
    r"twitterbot|linkedinbot|outlook|skype"
)

# Debounce window: a token that's already been logged within this window
# won't be logged again. 24h gives a normal user-day's worth of re-opens
# without spamming the feed.
DEBOUNCE_WINDOW = timedelta(hours=24)

# How recently an email_sent activity entry must have occurred for the
# "post-send scan window" gate to fire. Mail-server URL scanners
# (Mimecast etc.) typically hit within 5–30 seconds of delivery.
RECENT_SEND_WINDOW = timedelta(seconds=60)


def _accepts_html(request: Request) -> bool:
    """Return True if the request's Accept header indicates a browser-ish
    client that wants HTML. Empty or missing Accept counts as yes (older
    browsers, default fetch behavior). Explicit non-HTML accept (e.g.
    `application/json`, `image/png`) counts as no — that's an API or
    preview-thumbnailer, not a human reading the page."""
    accept = request.headers.get("accept", "").lower()
    if not accept:
        return True
    return "text/html" in accept or "*/*" in accept


def _is_scanner_ua(user_agent: str | None) -> bool:
    """Return True if the User-Agent matches our scanner/bot/preview
    regex. None or empty UA is treated as suspicious — every real browser
    sends one."""
    if not user_agent:
        return True
    return _BOT_UA_RE.search(user_agent) is not None


def _recent_email_sent(activity: list | None, now: datetime) -> bool:
    """Return True if an `email_sent` activity entry exists within
    RECENT_SEND_WINDOW of now. Activity entries store date (YYYY-MM-DD)
    and time (HH:MM) so resolution is one minute — close enough for the
    60s scanner window. Tolerant of malformed entries (skips them)."""
    if not activity:
        return False
    cutoff = now - RECENT_SEND_WINDOW
    for entry in activity:
        if not isinstance(entry, dict):
            continue
        if entry.get("type") != "email_sent":
            continue
        date_str = entry.get("date")
        time_str = entry.get("time", "00:00")
        if not date_str:
            continue
        try:
            ts = datetime.strptime(f"{date_str} {time_str}", "%Y-%m-%d %H:%M")
            ts = ts.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue
        if ts >= cutoff:
            return True
    return False


def _debounce_check_and_mark(
    seen: dict, debounce_key: tuple, now: datetime,
) -> bool:
    """Return True if `debounce_key` has been logged within DEBOUNCE_WINDOW.
    Mutates `seen` to record the current timestamp regardless of outcome —
    callers that decide to skip logging still want the timestamp updated
    so the window slides forward against repeated polling.

    Also opportunistically prunes entries older than DEBOUNCE_WINDOW * 2
    so the dict doesn't grow without bound. The prune is O(n) but only
    runs when an entry is added; for realistic workloads (hundreds of
    quotes max) this is meaningless. If the table ever grows orders of
    magnitude bigger, swap for an LRU or move to Redis."""
    cutoff = now - DEBOUNCE_WINDOW
    prior = seen.get(debounce_key)
    seen[debounce_key] = now
    # Opportunistic prune. The constant 2x of DEBOUNCE_WINDOW gives a
    # generous grace period before eviction so memory pressure stays
    # bounded while still catching genuine re-opens at exactly 24h.
    if len(seen) > 256:
        stale_cutoff = now - DEBOUNCE_WINDOW * 2
        for k in list(seen.keys()):
            if seen[k] < stale_cutoff:
                del seen[k]
    return prior is not None and prior > cutoff


async def lookup_recipient(
    db: AsyncSession,
    tracking_token: str,
    entity_type: str,
    entity_id: int,
) -> models.EmailRecipient | None:
    """Resolve a `?r=` token to its EmailRecipient row, verifying the row
    actually belongs to the entity being viewed. Returns None if the token
    is unknown OR if it's known but points at a different entity (defense
    against someone copying a tracking_token from one entity's email
    into the URL of another entity)."""
    if not tracking_token:
        return None
    r = await db.execute(
        select(models.EmailRecipient).where(
            models.EmailRecipient.tracking_token == tracking_token
        )
    )
    rec = r.scalar_one_or_none()
    if rec is None:
        return None
    if rec.entity_type != entity_type or rec.entity_id != entity_id:
        return None
    return rec


def extract_client_meta(request: Request) -> tuple[str, str]:
    """Pull (ip, user_agent) from an inbound Request. IP delegates to
    rate_limit._client_ip which already handles the XFF trust chain;
    UA is truncated at 200 chars so a malicious 100MB UA can't bloat
    the activity log."""
    ip = _client_ip(request.scope)
    ua = (request.headers.get("user-agent") or "")[:200]
    return ip, ua


def should_log_view(
    *,
    request: Request,
    optional_user: models.User | None,
    entity_activity: list | None,
    debounce_seen: dict,
    debounce_key: tuple,
    now: datetime,
) -> bool:
    """Run the 7-step gate. Returns True iff this hit should be logged
    as a client_viewed / recipient_opened / client_downloaded_pdf /
    recipient_downloaded_pdf activity entry.

    Caller is responsible for:
      - Loading the entity (we read its activity list, that's all)
      - Looking up the EmailRecipient row separately if `?r=` is present
      - Writing the actual activity entry on a True return

    The function NEVER raises — any unexpected condition is treated as
    "don't log." The view route must still render the entity even if
    tracking is misbehaving.

    Gate decisions are logged via _gate_log for ops visibility — without
    it, "why didn't Alice's open show up?" requires running a debugger
    against prod. The log includes the debounce_key so ops can correlate
    against entity / recipient."""
    # Step 1: HEAD probe
    if request.method == "HEAD":
        return _gate_log(False, "head", debounce_key)
    # Step 2: Accept lacks text/html
    if not _accepts_html(request):
        return _gate_log(False, "non_html_accept", debounce_key)
    # Step 3: in-app Preview mode
    if request.query_params.get("preview") == "1":
        return _gate_log(False, "preview_flag", debounce_key)
    # Step 4: viewer is an internal LTP user
    if optional_user is not None:
        return _gate_log(False, "internal_session", debounce_key)
    # Step 5: UA matches scanner / bot / preview generator
    ua = request.headers.get("user-agent")
    if _is_scanner_ua(ua):
        return _gate_log(False, "bot_ua", debounce_key)
    # Step 6: recently-sent email — scanners fire within ~60s
    if _recent_email_sent(entity_activity, now):
        return _gate_log(False, "recent_email_sent", debounce_key)
    # Step 7: in-memory debounce per (entity, debounce-key)
    if _debounce_check_and_mark(debounce_seen, debounce_key, now):
        return _gate_log(False, "debounce", debounce_key)
    return _gate_log(True, "log", debounce_key)


def _gate_log(decision: bool, reason: str, debounce_key: tuple) -> bool:
    """Single stdout-bound logger for gate decisions. Cheap — string
    format + one print. Switch to a structured logger if/when the
    codebase adopts one. Returns `decision` unchanged so call sites
    stay one-liners."""
    print(f"[view_tracking] decision={'log' if decision else 'skip'} "
          f"reason={reason} key={debounce_key}", flush=True)
    return decision
