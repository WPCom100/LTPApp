"""PDF generation + tokenized download routes.

Two-step flow (per the approved plan):

    POST /api/quotes/{id}/pdf     ← session-gated
    POST /api/invoices/{id}/pdf   ← session-gated
        → renders fresh PDF in a worker thread,
          inserts a pdf_archives row with a fresh opaque token,
          appends a {type: "pdf_generated", pdfToken, pdfFilename, ...}
          entry to the entity's `activity` JSON column,
          returns {token, downloadUrl, filename}.

    GET /pdf/{token}              ← UNGATED, token is the credential
        → returns the archived bytes with Content-Disposition: attachment.

The GET endpoint lives outside /api on purpose so it can bypass the
session-required dependency. The token is the only auth — treat it as a
non-guessable URL.
"""
import asyncio
import io
import re
import secrets
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from backend import models
from backend.auth_deps import require_session
from backend.database import get_db
from backend.pdf_generator import doc_ref, generate_pdf
from backend.routes._shared import (
    quote_dict as _quote_dict,
    invoice_dict as _invoice_dict,
    load_related as _load_related,
    load_settings as _load_settings,
)


# Two routers — one for the session-gated POST endpoints (attaches to /api/*
# style auth), and one for the public token GET endpoint (no auth).
api_pdf_router = APIRouter(prefix="/api", tags=["pdf"], dependencies=[Depends(require_session)])
public_pdf_router = APIRouter(prefix="/pdf", tags=["pdf"])


def _safe_filename(stem: str) -> str:
    """Strip anything not safe for Content-Disposition: filename. Quote refs
    are already safe, but be defensive in case a future ref format includes
    something odd."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", stem)
    return f"{safe}.pdf" if not safe.lower().endswith(".pdf") else safe


def _append_pdf_activity_entry(entity_row, user, token, filename):
    """Append a `pdf_generated` entry to the entity's `activity` JSON array.
    Mutates the row in place; caller must commit. flag_modified is required
    because we're mutating a JSON column's inner list (SQLAlchemy can't
    auto-detect that)."""
    activity = list(entity_row.activity or [])
    # The frontend's existing activity entries use string IDs like "qa1" or
    # ISO-time-suffixed strings. Match that pattern so the existing renderer
    # treats it identically.
    eid = "pdf-" + secrets.token_urlsafe(6)
    now = datetime.now()
    entry = {
        "id": eid,
        "date": now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H:%M"),
        "type": "pdf_generated",
        "user": user.name,
        "userId": user.id,
        "message": "PDF generated",
        "pdfToken": token,
        "pdfFilename": filename,
    }
    activity.append(entry)
    entity_row.activity = activity
    flag_modified(entity_row, "activity")
    return entry


async def _generate_and_archive(
    db: AsyncSession,
    user: models.User,
    kind: str,
    entity_row,
    entity_dict: dict,
    related_lookups,  # (company_id, contact_id, project_id)
) -> dict:
    """Shared implementation for both POST endpoints. Returns the response
    body that the route handler will return verbatim."""
    company, contact, project = await _load_related(db, *related_lookups)
    settings = await _load_settings(db)

    # Render PDF in a worker thread — reportlab is synchronous and slow
    # enough (0.5–2 s) to block the event loop noticeably under any load.
    buf = io.BytesIO()
    await asyncio.to_thread(
        generate_pdf,
        buf, kind, entity_dict,
        company, contact, project, settings, user.name,
    )
    pdf_bytes = buf.getvalue()
    if not pdf_bytes:
        # Reportlab silently produces empty output on some font-load errors;
        # don't archive an empty PDF or the user gets a 0-byte download.
        raise HTTPException(status_code=500, detail="PDF generator produced empty output")

    token = secrets.token_urlsafe(32)
    filename = _safe_filename(doc_ref(kind, entity_dict))

    archive = models.PdfArchive(
        token=token,
        entity_type=kind,
        entity_id=entity_dict.get("id"),
        filename=filename,
        pdf_bytes=pdf_bytes,
        bytes_size=len(pdf_bytes),
        created_by_user_id=user.id,
    )
    db.add(archive)
    _append_pdf_activity_entry(entity_row, user, token, filename)
    await db.flush()
    return {"token": token, "downloadUrl": f"/pdf/{token}", "filename": filename}


# ── POST /api/quotes/{id}/pdf ──────────────────────────────────────────────

@api_pdf_router.post("/quotes/{quote_id}/pdf")
async def generate_quote_pdf(
    quote_id: int,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(require_session),
):
    r = await db.execute(select(models.Quote).where(models.Quote.id == quote_id))
    row = r.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail=f"quote {quote_id} not found")
    return await _generate_and_archive(
        db, user, "quote", row, _quote_dict(row),
        (row.company_id, row.client_contact_id, row.project_id),
    )


# ── POST /api/invoices/{id}/pdf ────────────────────────────────────────────

@api_pdf_router.post("/invoices/{invoice_id}/pdf")
async def generate_invoice_pdf(
    invoice_id: int,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(require_session),
):
    r = await db.execute(select(models.Invoice).where(models.Invoice.id == invoice_id))
    row = r.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail=f"invoice {invoice_id} not found")
    return await _generate_and_archive(
        db, user, "invoice", row, _invoice_dict(row),
        (row.company_id, row.client_contact_id, row.project_id),
    )


# ── GET /pdf/{token} ───────────────────────────────────────────────────────

@public_pdf_router.get("/{token}")
async def download_pdf(token: str, db: AsyncSession = Depends(get_db)):
    """Token-authenticated download. No session required — the token IS the
    credential. Tokens are 256-bit random; brute-forcing is infeasible."""
    r = await db.execute(select(models.PdfArchive).where(models.PdfArchive.token == token))
    row = r.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="PDF not found")
    # Content-Disposition: attachment so the browser saves the file rather
    # than rendering it in-page. Filename uses double-quote-wrapped form for
    # broad client compatibility.
    return Response(
        content=row.pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{row.filename}"',
            # Don't cache aggressively; the same token always returns the
            # same bytes, but Cache-Control: private prevents intermediaries
            # from holding the file.
            "Cache-Control": "private, max-age=3600",
        },
    )
