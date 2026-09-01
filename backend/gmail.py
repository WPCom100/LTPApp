"""Gmail send helper.

End-to-end responsibility for taking a parsed/sanitized send request and
turning it into a successful Gmail API call, INCLUDING the OAuth token
lifecycle (refresh on expiry, persist any rotated refresh_token, clear
+ signal reconnect on irrecoverable failure).

Why httpx instead of google-api-python-client
=============================================
The official Google client is a ~50MB dependency tree (apiclient,
google-auth, oauth2client, six, httplib2, ...) for what we use as
literally two HTTP calls: POST oauth2/v4/token to refresh, POST
gmail.googleapis.com/.../messages/send to send. httpx is already a
FastAPI transitive dep. Keeping this thin makes the security boundary
much smaller to audit.

Gmail send: API + protocol
==========================
The Gmail API accepts a single POST to:
    https://gmail.googleapis.com/gmail/v1/users/me/messages/send

Body:  {"raw": "<base64url-encoded RFC 2822 message>"}
Auth:  Bearer <access_token>

The "raw" field is a base64url-encoded byte string of a complete RFC
2822 message — From, To, Cc, Subject headers + body. Gmail sets the
From header for us if we don't supply one; we supply it anyway so the
display name comes through clean.

For multipart/alternative HTML emails, we construct text/plain and
text/html parts with Python's stdlib email module. Use email.policy.SMTP
so line endings are CRLF (RFC 2822 requirement) — the default policy
uses LF and Gmail rejects malformed messages.
"""
import asyncio
import base64
from datetime import datetime, timedelta, timezone
from email.header import Header
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.policy import SMTP
from email.utils import formataddr

import html2text
import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from backend import crypto, models
from backend.crypto import InvalidToken


GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"

# When an access token is within this many seconds of expiry, refresh it
# proactively rather than waiting for Google to return 401. Tradeoff: a
# bit of unnecessary refresh traffic for users near the boundary, against
# avoiding a round-trip-and-retry on every send near token expiry.
_EXPIRY_BUFFER_SECONDS = 60


class GmailError(Exception):
    """Base class for gmail-helper errors. Routes catch this hierarchy."""


class GmailReconnectRequired(GmailError):
    """The user's stored refresh token is missing, malformed, or rejected
    by Google. The route layer translates this to a 409 with reason=
    "reconnect" so the frontend can surface the banner.

    Set by:
      - Missing gmail_refresh_token entirely (user never granted scope)
      - Fernet decrypt failure (rotated key, tampered ciphertext)
      - Google returns invalid_grant on refresh (user revoked at
        myaccount.google.com, refresh token expired after 6 months
        of inactivity, app credentials changed)
    """


class GmailSendError(GmailError):
    """Gmail accepted the request but rejected the message, OR Gmail
    returned a 5xx after our one retry. The route logs the entity-level
    activity entry as `email_failed` and returns 502 to the frontend."""
    def __init__(self, status: int, body: str):
        super().__init__(f"Gmail send failed ({status}): {body[:300]}")
        self.status = status
        self.body = body


# ── Token refresh ──────────────────────────────────────────────────────────

async def refresh_if_needed(
    user: models.User,
    db: AsyncSession,
    *,
    client_id: str,
    client_secret: str,
    httpx_client: httpx.AsyncClient | None = None,
    force: bool = False,
) -> str:
    """Ensure user.gmail_access_token is fresh; return the plaintext access
    token. Refreshes via Google's token endpoint if expired (or within
    _EXPIRY_BUFFER_SECONDS of expiry). Persists any rotated refresh_token
    Google returns in the response.

    Caller supplies client_id and client_secret — they live in
    backend/main.py's OAuth config; passing them in keeps this module free
    of FastAPI/app-state coupling.

    Caller may supply an httpx.AsyncClient for testability; if omitted we
    create a one-shot one per call.

    `force=True` skips the local expiry check and always hits Google.
    Used by send() when Gmail returns 401 — the cached token is fresh by
    our clock but Gmail rejected it (revoked / rotated by Google /
    short-lived scope downgrade), so we MUST refresh before retrying or
    the retry will hit the same 401.

    Raises GmailReconnectRequired on any condition that means we can't
    speak to Google as this user without re-consent."""
    if not user.gmail_refresh_token:
        raise GmailReconnectRequired("no refresh token on file")

    try:
        refresh_token = crypto.decrypt_token(user.gmail_refresh_token)
    except InvalidToken as e:
        # Key was rotated and the row's ciphertext is from the old key, or
        # the row was tampered. Either way we can't recover; force re-consent.
        raise GmailReconnectRequired(f"stored refresh token unreadable: {e}")

    now = datetime.now(timezone.utc)
    expires_at = user.gmail_token_expires_at
    # SQLite drops tzinfo on DateTime(timezone=True) reads; Postgres keeps it.
    # Normalize to UTC-aware before comparing, the same way
    # backend/auth_deps.py:55-59 does for session expiry — without this the
    # comparison below raises "can't compare offset-naive and offset-aware
    # datetimes" on every refresh under SQLite, i.e. on every local dev run.
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    fresh_enough = (
        not force
        and expires_at is not None
        and expires_at > now + timedelta(seconds=_EXPIRY_BUFFER_SECONDS)
        and user.gmail_access_token
    )
    if fresh_enough:
        try:
            return crypto.decrypt_token(user.gmail_access_token)
        except InvalidToken as e:
            # Access token is unreadable — drop through to refresh, which
            # will replace it with a fresh one we can decrypt.
            print(f"[LTP] gmail: stored access token unreadable ({e}); refreshing", flush=True)

    # Refresh via Google. We use a context-managed client when one wasn't
    # supplied so connection pools don't leak.
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
        "client_secret": client_secret,
    }
    if httpx_client is None:
        async with httpx.AsyncClient(timeout=10.0) as cli:
            resp = await cli.post(GOOGLE_TOKEN_URL, data=payload)
    else:
        resp = await httpx_client.post(GOOGLE_TOKEN_URL, data=payload, timeout=10.0)

    if resp.status_code == 400:
        # Google's standard "invalid_grant" response — user revoked, token
        # rotated by us but lost, or app credentials changed. Clear stored
        # tokens so future probes return gmailConnected=False and the
        # frontend prompts reconnect. Log a truncated snippet server-side
        # only; the exception message is reflected to the client by the email
        # route, so it must not carry the raw provider body
        # (SECURITY_REVIEW.md H10).
        print(f"[LTP] gmail: refresh rejected by Google: {resp.text[:200]}", flush=True)
        user.gmail_refresh_token = None
        user.gmail_access_token = None
        user.gmail_token_expires_at = None
        await db.flush()
        raise GmailReconnectRequired("Google refused the token refresh; reconnect required.")
    if resp.status_code != 200:
        # Non-400 failure: 401 invalid_client (the app's GOOGLE_CLIENT_ID /
        # GOOGLE_CLIENT_SECRET are wrong or missing), 403, or a 5xx/network blip.
        # Surface Google's OAuth error code — a standard enum like "invalid_client",
        # not a secret — so the Settings Error Log names the real cause instead of
        # a generic message; the raw body stays server-side only (H10). Don't
        # clear tokens; the refresh may succeed once the config/outage is fixed.
        oauth_error = ""
        try:
            oauth_error = str((resp.json() or {}).get("error", "")).strip()
        except Exception:
            oauth_error = ""
        print(f"[LTP] gmail: refresh endpoint returned {resp.status_code}: "
              f"{resp.text[:200]}", flush=True)
        detail = "Google token refresh failed"
        if oauth_error:
            detail += f": {oauth_error}"
        raise GmailSendError(resp.status_code, detail)

    data = resp.json()
    new_access = data.get("access_token")
    if not new_access:
        raise GmailSendError(200, "Google token refresh returned no access token.")

    user.gmail_access_token = crypto.encrypt_token(new_access)
    expires_in = int(data.get("expires_in", 3600))
    user.gmail_token_expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
    rotated_refresh = data.get("refresh_token")
    if rotated_refresh:
        # Google occasionally rotates the refresh token; persist immediately
        # or we'll lose access on the next refresh attempt.
        encrypted_refresh = crypto.encrypt_token(rotated_refresh)
        user.gmail_refresh_token = encrypted_refresh
        # "Immediately" has to mean COMMITTED, not flushed. Google has already
        # invalidated the old refresh token by this point, so if the caller's
        # transaction later rolls back we lose the only working credential and
        # the user's Gmail is dead until they reconnect by hand. That rollback
        # is a normal path, not a rare one: qbo_receipts._send_receipt deletes
        # its EmailRecipient rows and the poller rolls the whole iteration back
        # whenever a send fails.
        #
        # Committing the CALLER's session here is not an option — it would make
        # those recipient rows permanent, and the failure path is written to
        # delete them. So write just this one column in its own session.
        #
        # Ordering matters: this runs BEFORE the flush below, while the caller's
        # transaction has not yet written the users row, so the two cannot
        # contend for the same row lock. No current caller of gmail.send touches
        # the users row before sending (checked: routes/email.py,
        # routes/crew.py, qbo_receipts.py) — keep it that way, or move this.
        #
        # Best-effort: a failure here must not break a send that is otherwise
        # fine. The in-memory user object and the caller's transaction still
        # carry the new value, so the old flush-only behaviour remains as the
        # fallback.
        try:
            from sqlalchemy import update as _update
            from backend.database import async_session as _async_session

            async with _async_session() as _s:
                await _s.execute(
                    _update(models.User)
                    .where(models.User.id == user.id)
                    .values(gmail_refresh_token=encrypted_refresh)
                )
                await _s.commit()
        except Exception as e:  # pragma: no cover - durability is best-effort
            print(f"[LTP] gmail: rotated refresh token for user {user.id} could not be "
                  f"committed independently ({e}); relying on the caller's transaction",
                  flush=True)
    new_scope = data.get("scope")
    if new_scope:
        user.gmail_granted_scopes = new_scope
    await db.flush()
    return new_access


# ── Message construction ──────────────────────────────────────────────────

_h2t = html2text.HTML2Text()
_h2t.body_width = 0     # don't wrap; we want the plaintext to look like an email
_h2t.ignore_images = True
_h2t.protect_links = True
_h2t.unicode_snob = True
# Our HTML is table-based for layout (email_shell's card, the masthead, and the
# signature are all <table>s). Rendering those tables into the plaintext part
# produces garbage: `| | |` / `---|---` grid artifacts AND — worse — it swallows
# the paragraph breaks so body sentences run together ("...for the Gala.Due
# Date: ...Payment can be made..."). A text/plain alternative that doesn't
# cleanly mirror the HTML is a real deliverability penalty — spam scorers
# (SpamAssassin's MIME_HTML_* checks and similar) treat a broken/empty plaintext
# part as a spam signal. ignore_tables renders just the cell *content* (no grid),
# so paragraphs separate correctly and the plaintext reads like a real email.
_h2t.ignore_tables = True


def html_to_text(html: str) -> str:
    """Convert HTML to a plaintext alternative for multipart/alternative.
    Mail clients that block HTML (still common in some corporate setups)
    will render this part instead. Preserves links as `(http://...)`
    after their anchor text via html2text's protect_links flag.

    Layout tables are flattened to their cell content (ignore_tables) so the
    plaintext keeps proper paragraph spacing instead of the `| | |` grid
    artifacts html2text emits by default — a garbled text/plain part that
    doesn't match the HTML raises the message's spam score."""
    if not html:
        return ""
    return _h2t.handle(html).strip()


def build_message(
    *,
    from_name: str,
    from_email: str,
    to: list[str],
    cc: list[str],
    subject: str,
    html_body: str,
    text_body: str | None = None,
    reply_to: str | None = None,
    attachments: list[dict] | None = None,
) -> bytes:
    """Construct an RFC 2822 message ready for Gmail's API. Returns the
    base64url-safe encoded bytes (what the Gmail API `raw` field expects).

    Without attachments the message is a multipart/alternative (text + html).
    With attachments it becomes a multipart/mixed wrapping that alternative
    plus one part per file, so the body still renders inline and the files
    attach. Each attachment is a dict:
        {"filename": str, "content": bytes, "subtype": str (optional, "pdf")}
    """
    # Inner alternative: the human-readable body in plain + html.
    alt = MIMEMultipart("alternative", policy=SMTP)
    if not text_body:
        text_body = html_to_text(html_body)
    alt.attach(MIMEText(text_body, "plain", "utf-8", policy=SMTP))
    alt.attach(MIMEText(html_body, "html", "utf-8", policy=SMTP))

    if attachments:
        msg = MIMEMultipart("mixed", policy=SMTP)
        msg.attach(alt)
        for att in attachments:
            # MIMEApplication base64-encodes the bytes for transport.
            part = MIMEApplication(
                att["content"], _subtype=att.get("subtype", "pdf"), policy=SMTP,
            )
            part.add_header(
                "Content-Disposition", "attachment",
                filename=att.get("filename", "attachment.pdf"),
            )
            msg.attach(part)
    else:
        msg = alt

    # Headers belong on the OUTER message (mixed when attaching, else the
    # alternative itself).
    msg["From"] = formataddr((str(Header(from_name, "utf-8")), from_email))
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    if reply_to:
        msg["Reply-To"] = reply_to
    msg["Subject"] = str(Header(subject, "utf-8"))

    # base64url with no padding — what Gmail's `raw` field expects.
    return base64.urlsafe_b64encode(msg.as_bytes(policy=SMTP)).rstrip(b"=")


# ── Send ──────────────────────────────────────────────────────────────────

async def send(
    *,
    user: models.User,
    db: AsyncSession,
    client_id: str,
    client_secret: str,
    to: list[str],
    cc: list[str],
    subject: str,
    html_body: str,
    text_body: str | None = None,
    reply_to: str | None = None,
    attachments: list[dict] | None = None,
    httpx_client: httpx.AsyncClient | None = None,
) -> dict:
    """Send an email through Gmail as `user`. Returns Gmail's response
    dict (contains the message id, thread id, label ids).

    `attachments` (optional) is a list of {filename, content (bytes), subtype}
    dicts attached to the message (see build_message).

    Token-lifecycle handling:
      - 401 from Gmail: refresh + retry once. If the refresh itself fails
        with invalid_grant, raises GmailReconnectRequired.
      - 5xx from Gmail: wait 2 seconds, retry once.
      - other non-2xx: raises GmailSendError immediately (the caller
        writes an `email_failed` activity entry and returns 502).
    """
    access_token = await refresh_if_needed(
        user, db,
        client_id=client_id, client_secret=client_secret,
        httpx_client=httpx_client,
    )

    raw_b64 = build_message(
        from_name=user.name or user.email,
        from_email=user.email,
        to=to, cc=cc, subject=subject,
        html_body=html_body, text_body=text_body,
        reply_to=reply_to, attachments=attachments,
    )

    async def _do_send(token: str) -> httpx.Response:
        body = {"raw": raw_b64.decode("ascii")}
        headers = {"Authorization": f"Bearer {token}"}
        if httpx_client is None:
            async with httpx.AsyncClient(timeout=30.0) as cli:
                return await cli.post(GMAIL_SEND_URL, json=body, headers=headers)
        return await httpx_client.post(GMAIL_SEND_URL, json=body, headers=headers, timeout=30.0)

    resp = await _do_send(access_token)

    if resp.status_code == 401:
        # Token rejected by Gmail despite our local expiry saying it was
        # fresh — Google rotated, the user partially revoked, or our buffer
        # was too tight. force=True bypasses the local expiry check so we
        # actually hit Google's token endpoint instead of handing back the
        # same bad cached token.
        access_token = await refresh_if_needed(
            user, db,
            client_id=client_id, client_secret=client_secret,
            httpx_client=httpx_client,
            force=True,
        )
        resp = await _do_send(access_token)
    elif 500 <= resp.status_code < 600:
        # Transient Gmail error — single backoff retry, then fail.
        await asyncio.sleep(2.0)
        resp = await _do_send(access_token)

    if 200 <= resp.status_code < 300:
        return resp.json()
    raise GmailSendError(resp.status_code, resp.text)
