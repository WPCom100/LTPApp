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
import io
import re
import secrets as _secrets
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from backend import models
from backend.database import get_db
from backend.pdf_generator import doc_ref, generate_pdf
from backend.routes._shared import (
    quote_dict, invoice_dict,
    load_related, load_settings,
    public_section_items, public_activity, public_settings,
)


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


def _safe_filename(stem: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", stem)
    return f"{safe}.pdf" if not safe.lower().endswith(".pdf") else safe


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
    return {
        "kind": kind,
        "entity": entity_d,
        "company": company,    # name + address only (load_related shape)
        "contact": contact,    # name + email + role
        "project": project,    # name + dates
        "settings": public_settings(settings),
        "ref": doc_ref(kind, entity_d),
    }


# ── GET /api/view/{token} ─────────────────────────────────────────────────

@view_router.get("/{token}")
async def get_view(token: str, db: AsyncSession = Depends(get_db)):
    kind, row = await _find_entity_by_token(db, token)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    company, contact, project = await load_related(
        db, row.company_id, row.client_contact_id, row.project_id
    )
    settings = await load_settings(db)
    return _sanitized_payload(kind, row, company, contact, project, settings)


# ── POST /api/view/{token}/accept ─────────────────────────────────────────

@view_router.post("/{token}/accept")
async def post_accept(token: str, body: dict, db: AsyncSession = Depends(get_db)):
    """Client-driven accept. Only valid on Quotes; invoices 400. Idempotent-
    ish: if the quote is already accepted/declined/converted, 409 with the
    current status so the client UI can update without flipping anything."""
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
    entry = {
        "id": "ca-" + _secrets.token_urlsafe(6),
        "date": now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H:%M"),
        "type": "client_accepted",
        "user": client_name,
        "userId": None,   # no LTP user; client is external
        "message": "Quote accepted by client",
        "comment": comment or None,
        "signatureDataUrl": signature,
    }
    row.activity = list(row.activity or []) + [entry]
    flag_modified(row, "activity")
    row.status = "accepted"
    await db.flush()
    return {"status": "accepted", "activityId": entry["id"]}


# ── POST /api/view/{token}/decline ────────────────────────────────────────

@view_router.post("/{token}/decline")
async def post_decline(token: str, body: dict, db: AsyncSession = Depends(get_db)):
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
    entry = {
        "id": "cd-" + _secrets.token_urlsafe(6),
        "date": now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H:%M"),
        "type": "client_declined",
        "user": client_name,
        "userId": None,
        "message": "Quote declined by client",
        "comment": comment or None,
    }
    row.activity = list(row.activity or []) + [entry]
    flag_modified(row, "activity")
    row.status = "declined"
    await db.flush()
    return {"status": "declined", "activityId": entry["id"]}


# ── GET /api/view/{token}/pdf ─────────────────────────────────────────────

@view_router.get("/{token}/pdf")
async def get_view_pdf(token: str, db: AsyncSession = Depends(get_db)):
    """Fresh-generate a PDF on the fly for the public client view. Not
    archived (the archive flow is for LTP-user-initiated downloads — this
    is the client just clicking 'Download PDF' on the view page; the
    bytes always reflect the latest live state, not a frozen snapshot)."""
    kind, row = await _find_entity_by_token(db, token)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
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
