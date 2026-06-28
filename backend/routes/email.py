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
import asyncio
import io
import os
import secrets
from datetime import datetime, timezone
from html import escape
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend import gmail, models
from backend.activity import append_activity
from backend.auth_deps import require_session
from backend.database import get_db
from backend.email_validate import RecipientError, parse_recipients, validate_subject
from backend.pdf_generator import doc_ref, generate_pdf
from backend.routes._shared import (
    invoice_dict, load_related, load_settings,
    safe_pdf_filename as _pdf_filename,
)
from backend.sanitize import email_html


email_router = APIRouter(prefix="/api/email", tags=["email"])

# Hard cap on total recipients (To + CC) per send. A quote/invoice email goes
# to a handful of people; an unbounded list turns this endpoint -- which sends
# as the authenticated company Gmail account (passes SPF/DKIM/DMARC) -- into a
# spam/phishing relay (SECURITY_REVIEW.md H4). Per-IP throttling of the
# endpoint is handled separately by the rate limiter (H2).
_MAX_RECIPIENTS_PER_SEND = 25


# ── Request model ──────────────────────────────────────────────────────────


class SendRequest(BaseModel):
    entityType: str
    entityId: int
    to: str
    cc: str | None = None
    subject: str
    bodyHtml: str
    bodyText: str | None = None
    # When true (invoice sends only), the backend generates the invoice PDF
    # and attaches it to the email. Ignored for non-invoice entity types.
    attachPdf: bool = False
    # When true (invoice receipt sends only), mark the invoice as receipted so
    # the QuickBooks-driven auto-receipt poller (backend/qbo_receipts.py) never
    # sends a second receipt for the same invoice. Set by the manual "Send
    # Receipt" flow (modules/invoices.js::sendReceipt).
    receipt: bool = False


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
    Substitutes {{userName}}, {{userEmail}}, {{userTitle}}, {{userPhone}},
    {{userPhoto}}.
    User fields are HTML-escaped BEFORE substitution as defense in depth
    — the email body goes through bleach sanitization downstream too,
    but escaping here ensures a future refactor that drops one of those
    layers doesn't open an XSS hole.

    Falls back to _FALLBACK_SIGNATURE when the workspace hasn't
    customized a template. Reason: data/settings.js ships a rich default
    that lives only in the frontend's merged config — it's not in the DB
    until an admin clicks Save in Settings. Without this fallback, the
    first send from a fresh deploy would substitute {{signature}} with
    "" and the recipient would see the body abruptly end.

    The fallback string MUST match data/settings.js::emailSignatureTemplate
    byte-for-byte so the Send-modal preview (which reads the frontend
    config) shows the same signature the recipient gets. Any change to
    one MUST be mirrored in the other; tests/test_polish_pass_signature_html.py
    pins both via substring checks."""
    template = (settings_data.get("emailSignatureTemplate") or "").strip()
    if not template:
        template = _FALLBACK_SIGNATURE
    # {{userPhoto}} resolves to the user's Google profile picture, with
    # the LTP logo as a fallback when picture_url is empty (rare —
    # Google OAuth users almost always have one, but a User row that
    # pre-dates the OAuth scope grant could be photo-less). We escape
    # picture_url too even though it's controlled by Google; an attacker
    # who managed to inject HTML there would still be neutered.
    photo_url = (user.picture_url or "").strip() or _PHOTO_FALLBACK_URL
    return (
        template
        .replace("{{userPhoto}}", escape(photo_url))
        .replace("{{userName}}", escape(user.name or ""))
        .replace("{{userEmail}}", escape(user.email or ""))
        .replace("{{userTitle}}", escape(user.title or ""))
        .replace("{{userPhone}}", escape(user.phone or ""))
    )


# Used by both _render_signature (for users with no Google profile pic)
# AND embedded in _FALLBACK_SIGNATURE; pinned here so changing the URL
# updates both call sites in one edit. MUST stay in sync with the same
# constant in theme.js (window.LTP_SIGNATURE_PHOTO_FALLBACK) so the
# Send-modal preview renders the same image the recipient gets.
_PHOTO_FALLBACK_URL = (
    "https://www.luminarytechnology.productions/wp-content/uploads/2024/07/LTP-Logo-Stacked.png"
)


# Server-side fallback signature — must stay byte-identical to the
# data/settings.js default. When the DB has no emailSignatureTemplate
# value (fresh deploy, settings never saved, admin set it to ""), the
# Send pipeline renders this. Storing it here too means the recipient
# always sees a rich signature, never the truncated "...if you have any
# questions or would like to proceed." that motivated this fallback.
_FALLBACK_SIGNATURE = (
    '<table style="padding:0;margin:18px 0 0 0;border:none;border-collapse:collapse;max-width:100%">'
    '<tr><td style="padding:0 10px 0 0;vertical-align:top">'
    '<img alt="{{userName}}" height="120" '
    'src="{{userPhoto}}" width="120" '
    'style="display:block;border-radius:50%;object-fit:cover">'
    '</td><td style="border-left:3px solid #dddddd;padding:6px 0 0 14px;word-break:break-word;'
    "font-family:'verdana','geneva',sans-serif;font-size:12px;line-height:14px;color:#233038\">"
    '<div style="margin-bottom:10px"><strong>'
    '<span style="font-size:16px;color:#ef5822">{{userName}}</span>'
    '</strong><br>{{userTitle}}</div>'
    '<div style="margin-bottom:10px">'
    '<a href="mailto:{{userEmail}}" style="color:#233038;text-decoration:none" target="_blank">{{userEmail}}</a>'
    '<br>M:&nbsp;<a href="tel:{{userPhone}}" style="color:#233038;text-decoration:none" target="_blank">{{userPhone}}</a>'
    '</div>'
    '<div style="margin-bottom:10px">'
    '<span style="font-size:15px;color:#ef5822"><strong>Luminary Technology &amp; Productions</strong></span>'
    '<br>3786 Arapaho Rd.<br>Addison, TX 75001<br>'
    '<a href="https://LuminaryTechnology.Productions" style="color:#233038;text-decoration:none" target="_blank">LuminaryTechnology.Productions</a>'
    '</div>'
    '<div>'
    '<a href="https://www.facebook.com/profile.php?id=61563798680454" style="color:rgb(255,146,30);text-decoration:none;margin-right:6px" target="_blank">'
    '<img alt="facebook" height="18" src="https://storage.googleapis.com/signaturesatori/icons/cf/16/ff6633/facebook.png" width="18" style="vertical-align:middle">'
    '</a>'
    '<a href="https://www.instagram.com/luminarytechnologyproductions/" style="color:rgb(255,146,30);text-decoration:none" target="_blank">'
    '<img alt="instagram" height="18" src="https://storage.googleapis.com/signaturesatori/icons/cf/16/ff6633/instagram.png" width="18" style="vertical-align:middle">'
    '</a></div></td></tr></table>'
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

    return append_activity(
        entity, id_prefix="es-", type_="email_sent",
        user=user.name or user.email, user_id=user.id,
        message=f"Email sent to {to[0]}" + (f" + {len(to) - 1} more" if len(to) > 1 else ""),
        now=now, recipients={"to": to, "cc": cc}, changes=changes,
    )


def _stamp_email_failed(
    entity, user: models.User, to: list[str], cc: list[str],
    subject: str, error: str, now: datetime,
) -> dict:
    """Mirror of _stamp_email_sent for failed sends. Internal-only
    (email_failed is NOT in PUBLIC_TYPES) — surfaces in the LTP activity
    panel so the sender knows why their click didn't go anywhere."""
    return append_activity(
        entity, id_prefix="ef-", type_="email_failed",
        user=user.name or user.email, user_id=user.id,
        message=f"Email to {to[0]} failed", now=now,
        recipients={"to": to, "cc": cc},
        changes=[
            {"cat": "Error", "detail": error[:300]},
            {"cat": "To", "detail": ", ".join(to)},
            {"cat": "Subject", "detail": subject},
        ],
    )


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
    total_recipients = len(to_list) + len(cc_list)
    if total_recipients > _MAX_RECIPIENTS_PER_SEND:
        raise HTTPException(
            status_code=400,
            detail={"reason": "validation", "field": "recipients",
                    "error": f"too many recipients ({total_recipients}); "
                             f"max {_MAX_RECIPIENTS_PER_SEND} per send"},
        )

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

    # 4. Sanitize HTML, then substitute server-controlled placeholders.
    # {{header}} is NOT substituted here. The header HTML contains
    # per-entity tokens ({{refNumber}}, {{projectName}}, {{total}}) that
    # only the frontend has values for — the frontend expands {{header}}
    # at compose time using its already-computed entity vars, then sends
    # the expanded HTML in bodyHtml with {{viewUrl}} still literal for
    # us to swap per-recipient. If {{header}} ever leaks here as a
    # literal, the recipient sees the placeholder text — a visible bug
    # that surfaces fast instead of a header with literal {{refNumber}}
    # tokens silently going out.
    sanitized_html = email_html(body.bodyHtml)
    settings_data = await load_settings(db)
    signature_html = _render_signature(user, settings_data)
    view_url = _build_view_url(body.entityType, entity.share_token, primary_tracking)
    rendered_html = (
        sanitized_html
        .replace("{{viewUrl}}", view_url)
        .replace("{{signature}}", signature_html)
        # The masthead is provided by the shared container below, not a body
        # token — strip any stray {{masthead}} so it never renders literally.
        .replace("{{masthead}}", "")
    )
    # Re-sanitize after signature substitution — the signature template
    # came out of admin-edited settings; it's already sanitized at save
    # time (commit 4 wires that), but defense in depth: a missed save-time
    # sanitization gets caught here before going to the wire.
    inner_html = email_html(rendered_html)
    # Wrap every email in the shared branded container (light canvas → white
    # card with the masthead on top + footer) so the layout and masthead are
    # identical across crew and customer emails. Lazy import avoids a
    # module-load cycle (crew.py imports helpers from this module).
    from backend.routes.crew import email_shell, _email_brand
    final_html = email_html(email_shell(inner_html, _email_brand(settings_data)))

    # 4b. Optionally generate + attach the invoice PDF. Fresh render (the same
    # generator POST /api/invoices/{id}/pdf and the "View & Download" link use)
    # so the attachment matches the invoice's current state. Done BEFORE the
    # recipient rows so a generation failure leaves no partial state. Only
    # invoices have a PDF; the flag is ignored for other entity types.
    attachments = None
    if body.attachPdf and body.entityType == "invoice":
        company, contact, project = await load_related(
            db, entity.company_id, entity.client_contact_id, entity.project_id,
        )
        inv_dict = invoice_dict(entity)
        buf = io.BytesIO()
        # reportlab is synchronous + slow enough to block the event loop.
        await asyncio.to_thread(
            generate_pdf, buf, "invoice", inv_dict,
            company, contact, project, settings_data, user.name,
        )
        pdf_bytes = buf.getvalue()
        if not pdf_bytes:
            raise HTTPException(
                status_code=500,
                detail={"reason": "pdf", "error": "could not generate the invoice PDF to attach"},
            )
        attachments = [{"filename": _pdf_filename(doc_ref("invoice", inv_dict)), "content": pdf_bytes}]

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
            reply_to=reply_to, attachments=attachments,
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
    # A manual "Send Receipt" claims the receipt slot so the QuickBooks poller
    # won't email a second receipt. Server-authoritative (the column is in
    # _READONLY_COLS) — set here, on the real send, not from client state.
    if body.receipt and body.entityType == "invoice":
        entity.receipt_email_status = "sent"
        entity.receipt_email_sent_at = now
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
