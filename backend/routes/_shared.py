"""Shared helpers for entity-loading and dict conversion used by multiple
route modules (pdf.py, view.py).

These were originally in pdf.py; moved here when view.py needed the same
data shape for its public client-view payload. Both modules call
`load_related`, `load_settings`, and the per-entity dict converters; one
home keeps them in sync.

Naming: public functions (no underscore prefix) since they're imported
across modules. Internally still treated as routing-layer plumbing — not
exposed in any API surface.
"""
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend import models


async def doc_display_name(db: AsyncSession, row) -> str:
    """Human name for a quote/invoice — its `custom_name` if set, otherwise the
    linked project's name, otherwise ''. Mirrors how custom_name overrides
    project.name on the printed doc. `row` is a Quote or Invoice; used to label
    push notifications. Best-effort — returns '' rather than raising."""
    try:
        cn = (getattr(row, "custom_name", "") or "").strip()
        if cn:
            return cn
        pid = getattr(row, "project_id", None)
        if pid:
            name = (
                await db.execute(
                    select(models.Project.name).where(models.Project.id == pid)
                )
            ).scalar_one_or_none()
            if name:
                return name.strip()
    except Exception:
        pass
    return ""


def safe_pdf_filename(stem: str) -> str:
    """Sanitize a doc ref ('INV-2026-014') into a safe Content-Disposition /
    attachment filename, ensuring a .pdf suffix. Defensive against odd ref
    formats and empty input."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", stem or "invoice")
    return safe if safe.lower().endswith(".pdf") else f"{safe}.pdf"


def quote_dict(q: models.Quote) -> dict:
    """Convert a Quote row into the camelCase dict shape the generator
    and the frontend expect. None-tolerant: passing None returns {}."""
    if q is None:
        return {}
    return {
        "id": q.id,
        "clientType": q.client_type,
        "companyId": q.company_id,
        "clientContactId": q.client_contact_id,
        "projectId": q.project_id,
        "status": q.status,
        "sentDate": q.sent_date,
        "customStartDate": q.custom_start_date,
        "customEndDate": q.custom_end_date,
        "customName": q.custom_name,
        "globalDiscount": q.global_discount or {},
        "sections": q.sections or [],
        "notes": q.notes,
        "activity": q.activity or [],
        "shareToken": q.share_token,
        # `createdDate` not in our model — the generator falls back to created_at
        "createdDate": q.created_at.isoformat()[:10] if q.created_at else "",
    }


def invoice_dict(inv: models.Invoice) -> dict:
    if inv is None:
        return {}
    return {
        "id": inv.id,
        "clientType": inv.client_type,
        "companyId": inv.company_id,
        "clientContactId": inv.client_contact_id,
        "projectId": inv.project_id,
        "quoteId": inv.quote_id,
        "status": inv.status,
        "invoiceDate": inv.invoice_date,
        "dueDate": inv.due_date,
        "sentDate": inv.sent_date,
        "paidDate": inv.paid_date,
        # Names a project-less invoice; the PDF generator + public view fall back
        # to this when there's no linked project (mirrors Quote.customName).
        "customName": inv.custom_name,
        "globalDiscount": inv.global_discount or {},
        "sections": inv.sections or [],
        "notes": inv.notes,
        "payments": inv.payments or [],
        "activity": inv.activity or [],
        "shareToken": inv.share_token,
        # QuickBooks-computed sales tax (read-only). Drives the tax line + the
        # tax-inclusive total on the client view and PDF, matching the app.
        "qbTaxTotal": inv.qb_tax_total,
        "createdDate": inv.created_at.isoformat()[:10] if inv.created_at else "",
    }


def company_dict(c: models.Company) -> dict:
    if c is None:
        return {}
    return {
        "id": c.id,
        "name": c.name,
        "address": c.address,
        "city": c.city,
        "state": c.state,
        "zip": c.zip,
        "website": c.website,
        "logo": c.logo,
    }


def contact_dict(c: models.Contact) -> dict:
    if c is None:
        return {}
    return {
        "id": c.id,
        "firstName": c.first_name,
        "lastName": c.last_name,
        "email": c.email,
        "phone": c.phone,
        "role": c.role,
        "address": c.address,
        "city": c.city,
        "state": c.state,
        "zip": c.zip,
    }


def project_dict(p: models.Project) -> dict:
    if p is None:
        return {}
    return {
        "id": p.id,
        "name": p.name,
        "category": p.category,
        "status": p.status,
        "startDate": p.start_date,
        "endDate": p.end_date,
        "venue": p.venue,
    }


async def load_related(db: AsyncSession, company_id, contact_id, project_id):
    """Fetch related Company/Contact/Project rows. Returns dicts (already
    converted). Any of the three IDs may be None — corresponding dict is {}."""
    company = contact = project = None
    if company_id is not None:
        r = await db.execute(select(models.Company).where(models.Company.id == company_id))
        company = r.scalar_one_or_none()
    if contact_id is not None:
        r = await db.execute(select(models.Contact).where(models.Contact.id == contact_id))
        contact = r.scalar_one_or_none()
    if project_id is not None:
        r = await db.execute(select(models.Project).where(models.Project.id == project_id))
        project = r.scalar_one_or_none()
    return company_dict(company), contact_dict(contact), project_dict(project)


async def load_settings(db: AsyncSession) -> dict:
    """Singleton Settings row (id=1). Returns the JSON `data` blob or {}."""
    r = await db.execute(select(models.Settings).where(models.Settings.id == 1))
    row = r.scalar_one_or_none()
    if not row:
        return {}
    return row.data or {}


# ── Public-view sanitization ───────────────────────────────────────────────
# Keys removed from the public payload because they're either internal-only
# or expose information the client should never see (our cost basis,
# internal notes, FK IDs that hint at table layout, etc.).
_PUBLIC_ITEM_DROP_KEYS = {"cost", "deliveredQty", "invoicedQty"}


def public_section_items(sections: list) -> list:
    """Strip internal/cost fields from every line item across every section.
    Returns a NEW list — does not mutate input. Used by the public client
    view payload so we don't leak cost or internal workflow state."""
    if not isinstance(sections, list):
        return []
    out = []
    for sec in sections:
        if not isinstance(sec, dict):
            continue
        items = sec.get("items") or []
        scrubbed_items = []
        for it in items:
            if not isinstance(it, dict):
                continue
            scrubbed = {k: v for k, v in it.items() if k not in _PUBLIC_ITEM_DROP_KEYS}
            scrubbed_items.append(scrubbed)
        out.append({
            "id": sec.get("id"),
            "label": sec.get("label", ""),
            "items": scrubbed_items,
            # carry through any non-sensitive section-level fields the
            # generator/UI uses (e.g. customDates flag, startDate/endDate)
            "customDates": sec.get("customDates", False),
            "startDate": sec.get("startDate", ""),
            "endDate": sec.get("endDate", ""),
        })
    return out


def public_activity(activity: list) -> list:
    """Filter the activity log down to entries the client should see:
    the milestones (created / sent / accepted / declined / client_accepted /
    client_declined). Hide internal saves, adjustments, PDF generation logs,
    and userId fields (we don't expose LTP user IDs publicly).

    Names ARE shown (so the client sees "Accepted by Sarah Chen") but the
    `userId` is stripped — internal user IDs aren't the client's business."""
    if not isinstance(activity, list):
        return []
    PUBLIC_TYPES = {"created", "sent", "accepted", "declined",
                    "client_accepted", "client_declined", "converted",
                    # email_sent shows the client "yes, your quote was emailed
                    # to me, here's when." We deliberately do NOT include
                    # email_failed (internal ops detail) or recipient_opened /
                    # client_viewed / client_downloaded_pdf (those are about
                    # the client's own activity — confusing to show back at them).
                    "email_sent"}
    out = []
    for entry in activity:
        if not isinstance(entry, dict):
            continue
        if entry.get("type") not in PUBLIC_TYPES:
            continue
        out.append({
            "id": entry.get("id"),
            "date": entry.get("date"),
            "time": entry.get("time"),
            "type": entry.get("type"),
            "user": entry.get("user"),
            "message": entry.get("message"),
            # signatureDataUrl is included so the client can re-view their
            # own signature on a return visit to the accepted quote.
            "signatureDataUrl": entry.get("signatureDataUrl"),
            "comment": entry.get("comment"),
        })
    return out


def public_settings(settings: dict) -> dict:
    """Subset of the Settings blob safe to expose on the public client
    view: branding + contact info shown in the PDF header/footer. NO
    email templates, NO crew options, NO tagColors (none of those should
    matter to the client)."""
    if not isinstance(settings, dict):
        return {}
    keys = ["companyName", "companyShort", "tagline", "phone", "website",
            "street", "suite", "city", "state", "zip",
            "accentColor", "logoUrl"]
    return {k: settings.get(k, "") for k in keys}
