"""POST /api/email/send — outbound email via per-user Gmail.

Wiring summary
==============
Request body (camelCase, matches frontend):
    {
      entityType: "quote" | "invoice",
      entityId:   int,
      to:         str   (comma- or semicolon-separated email addresses),
      cc:         str | null,
      subject:    str,
      bodyHtml:   str   (may contain {{viewUrl}} + {{signature}} placeholders;
                         all OTHER variables — companyName, clientName,
                         refNumber, etc. — must already be interpolated by
                         the frontend before send),
      bodyText:   str | null  (optional plaintext alternative; auto-derived
                               from bodyHtml if omitted),
    }

Why the frontend pre-interpolates most variables but leaves {{viewUrl}}
and {{signature}} alone:

  - {{viewUrl}}  is per-recipient: it embeds a tracking_token unique
    to the primary recipient of THIS send. The frontend doesn't know
    the tracking_token (we mint it server-side), so the frontend leaves
    the placeholder and we substitute it just before constructing the
    MIME message.

  - {{signature}} resolves against the SENDER's profile (title + phone)
    plus the workspace signature template. We pull both server-side
    because the frontend's notion of "the current user" could be stale
    (admin edited title in another tab) and we'd rather render the
    canonical version.

All OTHER variables (companyName, clientName, refNumber, total, dueDate,
quoteValidity, etc.) are interpolated client-side; bodyHtml arrives
already-substituted for those.

Lifecycle
=========
1. Authenticate via session (Depends(require_session)).
2. Validate inputs (`backend.email_validate`).
3. Sanitize bodyHtml (`backend.sanitize.email_html`).
4. Load the entity (Quote or Invoice) by entityId, confirm share_token exists.
5. Mint a per-recipient `tracking_token` for each recipient (To + CC).
6. Substitute {{viewUrl}} server-side using share_token + the PRIMARY
   recipient's tracking_token (CC recipients see the same URL — opens
   attribute to the primary). Substitute {{signature}}.
7. Persist `email_recipients` rows BEFORE the send so that even if Gmail
   fails partway, we have a record of intent + the tracking_token (so
   the user could retry without rotating tokens).
8. Build MIME, call `backend.gmail.send`.
9. On success: stamp `email_sent` activity entry on the entity, mark each
   email_recipients row with the returned gmail_message_id, return 200.
10. On `GmailReconnectRequired`: roll back recipient rows, stamp no
    activity, return 409 {reason: "reconnect"}.
11. On `GmailSendError`: roll back recipient rows, stamp `email_failed`
    activity, return 502 with the error summary.
"""
import os
import secrets
from datetime import datetime, timezone
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from backend import gmail, models
from backend.auth_deps import require_session
from backend.database import get_db
from backend.email_validate import RecipientError, parse_recipients, validate_subject
from backend.routes._shared import load_settings
from backend.sanitize import email_html


email_router = APIRouter(prefix="/api/email", tags=["email"])


# ── Request model ──────────────────────────────────────────────────────────


class SendRequest(BaseModel):
    entityType: str
    entityId: int
    to: str
    cc: str | None = None
    subject: str
    bodyHtml: str
    bodyText: str | None = None


# ── Helpers ────────────────────────────────────────────────────────────────


def _app_origin() -> str:
    """Public-facing origin (scheme + host) for view URLs in outbound mail.
    Pulled from LTP_OAUTH_REDIRECT_URI so we use the same canonical host
    Google was given for the OAuth callback. Falls back to empty string in
    local dev where the redirect URI isn't set — the frontend will handle
    a relative URL fine, but the email body shouldn't have one (clients
    can't follow `#/view/...` without a host)."""
    redirect = os.environ.get("LTP_OAUTH_REDIRECT_URI", "")
    if not redirect:
        return ""
    parsed = urlparse(redirect)
    return f"{parsed.scheme}://{parsed.netloc}"


def _build_view_url(entity_type: str, share_token: str, tracking_token: str) -> str:
    """Per-recipient client view URL. The `?r=` query param is what the
    backend's view route uses to attribute opens to a specific recipient."""
    origin = _app_origin()
    return f"{origin}/#/view/{entity_type}/{share_token}?r={tracking_token}"


def _render_signature(
    user: models.User,
    settings_data: dict,
) -> str:
    """Apply the workspace signature template against the sender's profile.
    Returns the rendered HTML (or empty string if no template configured).
    Substitutes {{userName}}, {{userEmail}}, {{userTitle}}, {{userPhone}}.
    Missing user fields become empty strings; the template is responsible
    for handling those gracefully (e.g. skipping a phone line via styling
    rather than via conditional logic in the template)."""
    template = (settings_data.get("emailSignatureTemplate") or "").strip()
    if not template:
        return ""
    return (
        template
        .replace("{{userName}}", user.name or "")
        .replace("{{userEmail}}", user.email or "")
        .replace("{{userTitle}}", user.title or "")
        .replace("{{userPhone}}", user.phone or "")
    )


async def _load_entity(
    db: AsyncSession, entity_type: str, entity_id: int,
):
    """Fetch a Quote or Invoice by id. Returns the row. 404 if not found
    or if entity_type is unknown. Raises 400 if share_token is missing
    (shouldn't happen given the schema constraint, but defensive)."""
    if entity_type == "quote":
        model = models.Quote
    elif entity_type == "invoice":
        model = models.Invoice
    else:
        raise HTTPException(status_code=400, detail=f"unknown entityType: {entity_type!r}")

    r = await db.execute(select(model).where(model.id == entity_id))
    row = r.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail=f"{entity_type} {entity_id} not found")
    if not row.share_token:
        # Schema makes share_token NOT NULL but defense in depth — we
        # can't construct a viewUrl without it.
        raise HTTPException(status_code=400, detail=f"{entity_type} {entity_id} has no share_token")
    return row


def _stamp_email_sent(
    entity, user: models.User, to: list[str], cc: list[str],
    subject: str, gmail_message_id: str | None, now: datetime,
) -> dict:
    """Append an `email_sent` activity entry to the entity's activity log.
    Mutates the entity's activity list and calls flag_modified — caller
    must commit/flush. Returns the entry dict for logging/test inspection."""
    changes = [
        {"cat": "From", "detail": f"{user.name} <{user.email}>"},
        {"cat": "To", "detail": ", ".join(to)},
    ]
    if cc:
        changes.append({"cat": "CC", "detail": ", ".join(cc)})
    changes.append({"cat": "Subject", "detail": subject})
    if gmail_message_id:
        changes.append({"cat": "Gmail Message ID", "detail": gmail_message_id})

    entry = {
        "id": "es-" + secrets.token_urlsafe(6),
        "date": now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H:%M"),
        "type": "email_sent",
        "user": user.name or user.email,
        "userId": user.id,
        "message": f"Email sent to {to[0]}" + (f" + {len(to) - 1} more" if len(to) > 1 else ""),
        "recipients": {"to": to, "cc": cc},
        "changes": changes,
    }
    activity = list(entity.activity or [])
    activity.append(entry)
    entity.activity = activity
    flag_modified(entity, "activity")
    return entry


def _stamp_email_failed(
    entity, user: models.User, to: list[str], cc: list[str],
    subject: str, error: str, now: datetime,
) -> dict:
    """Mirror of _stamp_email_sent for failed sends. Internal-only
    (email_failed is NOT in PUBLIC_TYPES) — surfaces in the LTP activity
    panel so the sender knows why their click didn't go anywhere."""
    entry = {
        "id": "ef-" + secrets.token_urlsafe(6),
        "date": now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H:%M"),
        "type": "email_failed",
        "user": user.name or user.email,
        "userId": user.id,
        "message": f"Email to {to[0]} failed",
        "recipients": {"to": to, "cc": cc},
        "changes": [
            {"cat": "Error", "detail": error[:300]},
            {"cat": "To", "detail": ", ".join(to)},
            {"cat": "Subject", "detail": subject},
        ],
    }
    activity = list(entity.activity or [])
    activity.append(entry)
    entity.activity = activity
    flag_modified(entity, "activity")
    return entry


# ── Endpoint ───────────────────────────────────────────────────────────────


@email_router.post("/send")
async def send_email(
    body: SendRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(require_session),
):
    """Send an email through the signed-in user's Gmail. See the module
    docstring for the full lifecycle."""

    # 1. Validate
    try:
        to_list = parse_recipients(body.to, allow_empty=False)
        cc_list = parse_recipients(body.cc, allow_empty=True)
        subject = validate_subject(body.subject)
    except RecipientError as e:
        raise HTTPException(status_code=400, detail={"reason": "validation", "field": "recipients", "error": str(e)})
    if not to_list:
        raise HTTPException(status_code=400, detail={"reason": "validation", "field": "to", "error": "at least one To: recipient required"})
    if not subject:
        raise HTTPException(status_code=400, detail={"reason": "validation", "field": "subject", "error": "subject required"})

    # 2. Load entity (defensive — raises 404 / 400 if bad)
    entity = await _load_entity(db, body.entityType, body.entityId)

    # 3. Mint a tracking_token per recipient. Primary recipient's token
    # goes into the URL embedded in the email body; CC tokens exist for
    # the audit trail but aren't surfaced in any URL.
    now = datetime.now(timezone.utc)
    primary_email = to_list[0]
    primary_tracking = secrets.token_urlsafe(24)
    cc_tokens = [secrets.token_urlsafe(24) for _ in cc_list]
    secondary_to_tokens = [secrets.token_urlsafe(24) for _ in to_list[1:]]

    # 4. Sanitize HTML, then substitute server-controlled placeholders
    sanitized_html = email_html(body.bodyHtml)
    settings_data = await load_settings(db)
    signature_html = _render_signature(user, settings_data)
    view_url = _build_view_url(body.entityType, entity.share_token, primary_tracking)
    rendered_html = (
        sanitized_html
        .replace("{{viewUrl}}", view_url)
        .replace("{{signature}}", signature_html)
    )
    # Re-sanitize after signature substitution — the signature template
    # came out of admin-edited settings; it's already sanitized at save
    # time (commit 4 wires that), but defense in depth: a missed save-time
    # sanitization gets caught here before going to the wire.
    final_html = email_html(rendered_html)

    # 5. Persist email_recipients rows BEFORE attempting send. If we crash
    # mid-send, the row + tracking_token are recoverable evidence.
    recipient_rows = []
    recipient_rows.append(models.EmailRecipient(
        entity_type=body.entityType, entity_id=entity.id,
        share_token=entity.share_token,
        recipient_email=primary_email, recipient_role="to",
        tracking_token=primary_tracking,
        sent_at=now, sent_by_user_id=user.id,
    ))
    for email_addr, tok in zip(to_list[1:], secondary_to_tokens):
        recipient_rows.append(models.EmailRecipient(
            entity_type=body.entityType, entity_id=entity.id,
            share_token=entity.share_token,
            recipient_email=email_addr, recipient_role="to",
            tracking_token=tok,
            sent_at=now, sent_by_user_id=user.id,
        ))
    for email_addr, tok in zip(cc_list, cc_tokens):
        recipient_rows.append(models.EmailRecipient(
            entity_type=body.entityType, entity_id=entity.id,
            share_token=entity.share_token,
            recipient_email=email_addr, recipient_role="cc",
            tracking_token=tok,
            sent_at=now, sent_by_user_id=user.id,
        ))
    db.add_all(recipient_rows)
    await db.flush()

    # 6. Send via Gmail. Pull OAuth client creds from the app config so the
    # gmail helper can refresh the access token without coupling to FastAPI.
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")
    reply_to = (settings_data.get("emailReplyTo") or "").strip() or None
    try:
        gmail_resp = await gmail.send(
            user=user, db=db,
            client_id=client_id, client_secret=client_secret,
            to=to_list, cc=cc_list, subject=subject,
            html_body=final_html, text_body=body.bodyText,
            reply_to=reply_to,
        )
    except gmail.GmailReconnectRequired as e:
        # Roll back the recipient rows — they exist but were never delivered,
        # and leaving them lets a stale tracking_token leak to the next send.
        for r in recipient_rows:
            await db.delete(r)
        await db.flush()
        # Don't stamp any activity entry — the send simply didn't happen.
        # The frontend's reconnect banner surfaces the actionable signal.
        raise HTTPException(status_code=409, detail={"reason": "reconnect", "error": str(e)})
    except gmail.GmailSendError as e:
        # Stamp an `email_failed` activity entry so the LTP user sees why.
        # Roll back recipient rows for the same reason as reconnect.
        for r in recipient_rows:
            await db.delete(r)
        _stamp_email_failed(entity, user, to_list, cc_list, subject, str(e), now)
        await db.flush()
        raise HTTPException(status_code=502, detail={"reason": "gmail_error", "error": str(e)})

    # 7. Success — record gmail_message_id on each recipient row + stamp activity
    gmail_message_id = gmail_resp.get("id") if isinstance(gmail_resp, dict) else None
    for r in recipient_rows:
        r.gmail_message_id = gmail_message_id
    entry = _stamp_email_sent(entity, user, to_list, cc_list, subject, gmail_message_id, now)
    await db.flush()

    return {
        "ok": True,
        "gmailMessageId": gmail_message_id,
        "activityId": entry["id"],
        "recipients": [
            {"email": r.recipient_email, "role": r.recipient_role}
            for r in recipient_rows
        ],
    }
