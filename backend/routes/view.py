"""Public client-facing view of a quote or invoice.

Four endpoints, all TOKEN-AUTHENTICATED (no session required — the
share_token IS the credential, mirroring the PDF download model):

    GET  /api/view/{token}              → sanitized JSON payload for ClientView
    POST /api/view/{token}/accept       → body {clientName, comment?, signatureDataUrl}
    POST /api/view/{token}/decline      → body {clientName, comment?}
    GET  /api/view/{token}/pdf          → fresh-generated PDF, attachment

Sanitization is done in backend/routes/_shared.py (public_section_items,
public_activity, public_settings). The principle: the client sees what
they'd see on the printed quote, never anything internal (no `cost`,
no `internal_notes`, no full activity log with LTP userIDs, no full
settings blob with email templates / crew options / tagColors).

The accept/decline endpoints bypass the existing `_stamp_activity` helper
in api.py — those force the authenticated user as the activity actor, but
here the actor IS the client (anonymous, supplies their own name). We
build the activity entry directly from the client-submitted form, then
append + flush.
"""
import asyncio
import base64
import binascii
import io
from datetime import datetime, timezone
from typing import Literal, Union

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend import models, view_tracking, webpush
from backend.activity import append_activity
from backend.auth_deps import get_optional_user
from backend.database import get_db
from backend.pdf_generator import doc_ref, generate_pdf
from backend.routes._shared import (
    quote_dict, invoice_dict,
    load_related, load_settings,
    public_section_items, public_activity, public_settings,
    safe_pdf_filename as _safe_filename,
)


# Activity entry ID prefixes — surfaced as constants so a quick grep tells
# you where each shape comes from. RO/CV/RP/CP are paired by action ×
# attribution: (recipient|client) × (open|pdf-download). The trailing
# token_urlsafe(6) keeps entries globally unique within an entity's feed.
_ID_PREFIX_RECIPIENT_OPENED = "ro-"
_ID_PREFIX_CLIENT_VIEWED = "cv-"
_ID_PREFIX_RECIPIENT_PDF = "rp-"
_ID_PREFIX_CLIENT_PDF = "cp-"

# action argument vocabulary for _record_open / _stamp_tracked_open
_TrackAction = Literal["view", "pdf"]
_TrackedEntity = Union[models.Quote, models.Invoice]


# Public — no session dependency. Token is the credential.
view_router = APIRouter(prefix="/api/view", tags=["view"])


# ── Lookup helpers ────────────────────────────────────────────────────────

async def _find_entity_by_token(db: AsyncSession, token: str):
    """Return (kind, row) for the matching entity, or (None, None) if no row
    has that token. Quote checked first, then Invoice (one query each)."""
    if not token or len(token) < 8:
        return None, None
    r = await db.execute(select(models.Quote).where(models.Quote.share_token == token))
    row = r.scalar_one_or_none()
    if row is not None:
        return "quote", row
    r = await db.execute(select(models.Invoice).where(models.Invoice.share_token == token))
    row = r.scalar_one_or_none()
    if row is not None:
        return "invoice", row
    return None, None


# Magic-number prefixes for the raster formats a signature pad can emit. SVG
# is deliberately absent — image/svg+xml is the one image/* type that can carry
# script, and the signature canvas only ever produces PNG anyway.
_IMAGE_MAGIC = (
    b"\x89PNG\r\n\x1a\n",   # PNG
    b"\xff\xd8\xff",         # JPEG
    b"GIF87a", b"GIF89a",   # GIF
    b"RIFF",                 # WEBP container (RIFF....WEBP)
)


def _validate_signature_data_url(signature: str) -> None:
    """Confirm `signature` is a real base64-encoded raster image data URL.

    The signature is stored on the quote's activity log and later rendered in a
    staff-facing popup. A prefix+length check alone ('starts with data:image/')
    lets an attacker break out of the popup's img `src` attribute or smuggle an
    image/svg+xml payload — both XSS vectors. We decode the base64 and require a
    known raster magic number, and reject SVG outright (SECURITY_REVIEW.md C1).

    Raises HTTPException(400) on any failure; returns None on success.
    """
    field = "signatureDataUrl"
    try:
        header, payload = signature.split(",", 1)
    except ValueError:
        raise HTTPException(status_code=400, detail={"field": field, "reason": "malformed data URL"})
    if not header.startswith("data:image/") or ";base64" not in header:
        raise HTTPException(status_code=400, detail={"field": field, "reason": "must be a base64-encoded data:image/ URL"})
    if "image/svg" in header:
        raise HTTPException(status_code=400, detail={"field": field, "reason": "SVG signatures are not allowed"})
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail={"field": field, "reason": "invalid base64 image data"})
    if not raw.startswith(_IMAGE_MAGIC):
        raise HTTPException(status_code=400, detail={"field": field, "reason": "not a recognized image"})


def _sanitized_payload(kind: str, entity, company, contact, project, settings) -> dict:
    """Build the public response body for GET /api/view/{token}. Strips
    cost columns from line items, filters activity to public milestones,
    and trims the settings blob to branding-only."""
    entity_d = quote_dict(entity) if kind == "quote" else invoice_dict(entity)
    # Sanitize sections (strip cost / deliveredQty / invoicedQty)
    entity_d["sections"] = public_section_items(entity_d.get("sections", []))
    # Sanitize activity (whitelist of public types, strip userId)
    entity_d["activity"] = public_activity(entity_d.get("activity", []))
    # Strip internal-only fields the client should never see
    for k in ("internalNotes", "internal_notes"):
        entity_d.pop(k, None)
    # No FK ids in the public response
    for k in ("companyId", "clientContactId", "projectId", "quoteId"):
        entity_d.pop(k, None)
    # The share_token IS the credential (the client already holds it in the
    # URL) — never echo it back. The payments ledger is internal financial
    # detail the client view doesn't consume. SECURITY_REVIEW.md M1.
    for k in ("shareToken", "share_token", "payments"):
        entity_d.pop(k, None)
    return {
        "kind": kind,
        "entity": entity_d,
        "company": company,    # name + address only (load_related shape)
        "contact": contact,    # name + email + role
        "project": project,    # name + dates
        "settings": public_settings(settings),
        "ref": doc_ref(kind, entity_d),
    }


# ── Activity stamping for view / PDF tracking ─────────────────────────────


def _stamp_tracked_open(
    *, entity: _TrackedEntity, kind: str, recipient: models.EmailRecipient | None,
    ip: str, ua: str, action: _TrackAction, now: datetime,
) -> dict:
    """Append a tracking activity entry to the entity's activity log.

    `action` is one of {"view", "pdf"} — drives which type values get used:
      - view + recipient → recipient_opened
      - view + no recipient → client_viewed
      - pdf + recipient → recipient_downloaded_pdf
      - pdf + no recipient → client_downloaded_pdf

    None of the tracking types are in PUBLIC_TYPES — they're internal
    audit only, never echoed back at the client through the sanitized
    view payload."""
    if action == "view":
        type_ = "recipient_opened" if recipient else "client_viewed"
        verb = "opened"
    else:  # pdf
        type_ = "recipient_downloaded_pdf" if recipient else "client_downloaded_pdf"
        verb = "downloaded PDF"

    if recipient:
        actor_label = recipient.recipient_email
        message = f"{kind.title()} {verb} by {recipient.recipient_email}"
    else:
        actor_label = "Anonymous viewer"
        message = f"{kind.title()} {verb} (anonymous link)"

    changes = []
    if recipient:
        changes.append({"cat": "Recipient", "detail": recipient.recipient_email})
    if ip and ip != "unknown":
        changes.append({"cat": "IP", "detail": ip})
    if ua:
        changes.append({"cat": "User-Agent", "detail": ua})

    if action == "view":
        prefix = _ID_PREFIX_RECIPIENT_OPENED if recipient else _ID_PREFIX_CLIENT_VIEWED
    else:  # pdf
        prefix = _ID_PREFIX_RECIPIENT_PDF if recipient else _ID_PREFIX_CLIENT_PDF
    return append_activity(
        entity, id_prefix=prefix, type_=type_, user=actor_label,
        user_id=None, message=message, now=now, changes=changes,
    )


def _bump_recipient_open(recipient: models.EmailRecipient, now: datetime) -> None:
    """Update open_count + last_opened_at on an EmailRecipient row.
    Sets first_opened_at if it was null."""
    recipient.open_count = (recipient.open_count or 0) + 1
    recipient.last_opened_at = now
    if recipient.first_opened_at is None:
        recipient.first_opened_at = now


def _bump_recipient_pdf(recipient: models.EmailRecipient, now: datetime) -> None:
    """Record pdf_downloaded_at if null (first download wins). Subsequent
    PDF downloads by the same recipient don't overwrite the first
    download timestamp — first download is the meaningful signal."""
    if recipient.pdf_downloaded_at is None:
        recipient.pdf_downloaded_at = now


async def _record_open(
    *, db: AsyncSession, entity: _TrackedEntity, kind: str, request: Request,
    optional_user: models.User | None, action: _TrackAction,
) -> None:
    """Run the 7-step gate; if it passes, look up the optional ?r=
    recipient and stamp the appropriate activity entry.

    Wrapped in try/except: tracking failures must NEVER break the view
    render or the PDF download. We log and move on."""
    try:
        now = datetime.now(timezone.utc)
        tracking_token = request.query_params.get("r")

        recipient = None
        if tracking_token:
            recipient = await view_tracking.lookup_recipient(
                db, tracking_token, kind, entity.id,
            )

        # Debounce key: separates per-recipient tracking from anonymous
        # views so each recipient gets ~one entry per 24h, AND the
        # anonymous slot also gets ~one entry per 24h. Without this
        # split, a recipient open within 24h of an anonymous open (or
        # vice versa) would suppress the second entry incorrectly.
        if recipient is not None:
            debounce_key = (kind, entity.id, action, "r", tracking_token)
        else:
            debounce_key = (kind, entity.id, action, "anon")

        should_log = view_tracking.should_log_view(
            request=request,
            optional_user=optional_user,
            entity_activity=entity.activity,
            debounce_seen=request.app.state.client_view_seen,
            debounce_key=debounce_key,
            now=now,
        )
        if not should_log:
            return

        ip, ua = view_tracking.extract_client_meta(request)
        _stamp_tracked_open(
            entity=entity, kind=kind, recipient=recipient,
            ip=ip, ua=ua, action=action, now=now,
        )
        if recipient is not None:
            if action == "view":
                _bump_recipient_open(recipient, now)
            else:
                _bump_recipient_pdf(recipient, now)
        await db.flush()
    except Exception as e:
        # Never let tracking break the render. Log loudly so ops can
        # diagnose if the activity feed goes mysteriously quiet.
        print(f"[LTP] view_tracking: open-record failed for "
              f"{kind} {getattr(entity, 'id', '?')}: {e!r}", flush=True)


# ── GET /api/view/{token} ─────────────────────────────────────────────────

@view_router.get("/{token}")
async def get_view(
    token: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    optional_user: models.User | None = Depends(get_optional_user),
):
    kind, row = await _find_entity_by_token(db, token)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    # Track the open BEFORE building the response so the new activity
    # entry (if we stamp one) is visible in this same payload — the
    # client view's "Status" / "Activity" badges reflect immediately.
    await _record_open(
        db=db, entity=row, kind=kind, request=request,
        optional_user=optional_user, action="view",
    )
    company, contact, project = await load_related(
        db, row.company_id, row.client_contact_id, row.project_id
    )
    settings = await load_settings(db)
    return _sanitized_payload(kind, row, company, contact, project, settings)


async def _notify_quote_response(db, row, decision: str, client_name: str, comment: str) -> None:
    """Push-notify the quote's sender(s) — or all admins when it went out as an
    anonymous share link — that the client accepted/declined. Fully best-effort:
    a notification failure must never turn a valid client response into a 500."""
    try:
        ref = doc_ref("quote", {
            "id": row.id,
            "createdDate": row.created_at.isoformat() if getattr(row, "created_at", None) else "",
            "sentDate": row.sent_date or "",
        })
        who = client_name or "The client"
        title = f"Quote {ref} {decision}"
        body = f"{who} {decision} the quote"
        if comment:
            body += " · “" + comment + "”"
        await webpush.notify_entity(db, "quote", row.id, title, body, f"/#/quotes/{row.id}")
    except Exception as e:
        print(f"[LTP] webpush: quote {decision} notify failed for "
              f"quote {getattr(row, 'id', '?')}: {e}", flush=True)


# ── POST /api/view/{token}/accept ─────────────────────────────────────────

@view_router.post("/{token}/accept")
async def post_accept(token: str, body: dict, request: Request, db: AsyncSession = Depends(get_db)):
    """Client-driven accept. Only valid on Quotes; invoices 400. Idempotent-
    ish: if the quote is already accepted/declined/converted, 409 with the
    current status so the client UI can update without flipping anything.

    Replay/forgery hardening (SECURITY_REVIEW.md H12): the signature is
    validated as a real image (C1), the terminal-status check below blocks
    re-decision, the endpoint is rate-limited (H2), and we capture the client
    IP/User-Agent on the activity entry for non-repudiation (internal-only —
    public_activity does not echo these fields back)."""
    kind, row = await _find_entity_by_token(db, token)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    if kind != "quote":
        raise HTTPException(
            status_code=400,
            detail="accept is only valid for quotes; this token refers to an invoice",
        )
    # Validate body
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    client_name = (body.get("clientName") or "").strip()
    if not client_name:
        raise HTTPException(status_code=400, detail={"field": "clientName", "reason": "required"})
    if len(client_name) > 100:
        raise HTTPException(status_code=400, detail={"field": "clientName", "reason": "max 100 chars"})
    signature = body.get("signatureDataUrl") or ""
    # Signature required for accept (per plan). Sanity-check it looks like a
    # data URL — we don't validate the image contents, just that someone
    # actually drew something. A blank canvas produces a ~134-byte data URL
    # for an empty 400x150 PNG; we set a small floor above that.
    if not signature.startswith("data:image/"):
        raise HTTPException(status_code=400, detail={"field": "signatureDataUrl", "reason": "required (must be data: URL)"})
    if len(signature) < 200:
        raise HTTPException(status_code=400, detail={"field": "signatureDataUrl", "reason": "looks blank — please sign"})
    if len(signature) > 200_000:  # ~200KB of base64 = ~150KB image. Generous.
        raise HTTPException(status_code=400, detail={"field": "signatureDataUrl", "reason": "too large (>200 KB)"})
    # Beyond the shape/size checks above, confirm the payload decodes to a real
    # raster image (not SVG, not an attribute-breakout string) before we store
    # something the staff signature popup will render. SECURITY_REVIEW.md C1.
    _validate_signature_data_url(signature)
    comment = (body.get("comment") or "").strip()
    if len(comment) > 1000:
        raise HTTPException(status_code=400, detail={"field": "comment", "reason": "max 1000 chars"})

    # Idempotency: 409 if already terminal
    if row.status in ("accepted", "declined", "converted"):
        raise HTTPException(
            status_code=409,
            detail={"status": row.status, "message": f"quote is already {row.status}"},
        )

    # Append activity + flip status
    now = datetime.now()
    ip, ua = view_tracking.extract_client_meta(request)
    entry = append_activity(
        row, id_prefix="ca-", type_="client_accepted", user=client_name,
        user_id=None,   # no LTP user; client is external
        message="Quote accepted by client", now=now,
        comment=comment or None, signatureDataUrl=signature,
        # Internal audit metadata (not echoed by public_activity).
        ip=ip or None, userAgent=(ua or "")[:300] or None,
    )
    row.status = "accepted"
    await db.flush()
    await _notify_quote_response(db, row, "accepted", client_name, comment)
    return {"status": "accepted", "activityId": entry["id"]}


# ── POST /api/view/{token}/decline ────────────────────────────────────────

@view_router.post("/{token}/decline")
async def post_decline(token: str, body: dict, request: Request, db: AsyncSession = Depends(get_db)):
    kind, row = await _find_entity_by_token(db, token)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    if kind != "quote":
        raise HTTPException(status_code=400, detail="decline is only valid for quotes")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    client_name = (body.get("clientName") or "").strip()
    if not client_name:
        raise HTTPException(status_code=400, detail={"field": "clientName", "reason": "required"})
    if len(client_name) > 100:
        raise HTTPException(status_code=400, detail={"field": "clientName", "reason": "max 100 chars"})
    comment = (body.get("comment") or "").strip()
    if len(comment) > 1000:
        raise HTTPException(status_code=400, detail={"field": "comment", "reason": "max 1000 chars"})

    if row.status in ("accepted", "declined", "converted"):
        raise HTTPException(
            status_code=409,
            detail={"status": row.status, "message": f"quote is already {row.status}"},
        )

    now = datetime.now()
    ip, ua = view_tracking.extract_client_meta(request)
    entry = append_activity(
        row, id_prefix="cd-", type_="client_declined", user=client_name,
        user_id=None, message="Quote declined by client", now=now,
        comment=comment or None,
        # Internal audit metadata (not echoed by public_activity).
        ip=ip or None, userAgent=(ua or "")[:300] or None,
    )
    row.status = "declined"
    await db.flush()
    await _notify_quote_response(db, row, "declined", client_name, comment)
    return {"status": "declined", "activityId": entry["id"]}


# ── GET /api/view/{token}/pdf ─────────────────────────────────────────────

@view_router.get("/{token}/pdf")
async def get_view_pdf(
    token: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    optional_user: models.User | None = Depends(get_optional_user),
):
    """Fresh-generate a PDF on the fly for the public client view. Not
    archived (the archive flow is for LTP-user-initiated downloads — this
    is the client just clicking 'Download PDF' on the view page; the
    bytes always reflect the latest live state, not a frozen snapshot).

    Same 7-step view-tracking gate as the JSON GET — a real PDF download
    by a recipient stamps `recipient_downloaded_pdf` + bumps
    `pdf_downloaded_at` on the EmailRecipient row. Anonymous downloads
    stamp `client_downloaded_pdf`."""
    kind, row = await _find_entity_by_token(db, token)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    await _record_open(
        db=db, entity=row, kind=kind, request=request,
        optional_user=optional_user, action="pdf",
    )
    entity_dict = quote_dict(row) if kind == "quote" else invoice_dict(row)
    company, contact, project = await load_related(
        db, row.company_id, row.client_contact_id, row.project_id
    )
    settings = await load_settings(db)
    # "Generated by" is the company name on the public download (the client
    # has no LTP user to attribute to). Generator falls back gracefully.
    user_name = (settings or {}).get("companyName") or "LTP"

    buf = io.BytesIO()
    await asyncio.to_thread(
        generate_pdf, buf, kind, entity_dict,
        company, contact, project, settings, user_name,
    )
    pdf_bytes = buf.getvalue()
    if not pdf_bytes:
        raise HTTPException(status_code=500, detail="PDF generator produced empty output")
    filename = _safe_filename(doc_ref(kind, entity_dict))
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, max-age=300",
        },
    )
