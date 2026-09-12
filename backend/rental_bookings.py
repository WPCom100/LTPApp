"""Bookings derived from confirmed documents.

An ``Allocation`` (backend/models.py) is the record that some units of a
catalog item are booked to a project for a date range — it is what makes the
Availability Checker read "3 of 10 available" and the equipment popup say
"On Rental". Until this module existed nothing wrote one: the rentals screens
only read them, so every "out" figure in the app was zero unless a booking was
POSTed by hand.

This is the single seam that turns a document into bookings, and it is wired
into every path that can change what a document commits us to:

    quote/invoice create   (POST /api/quotes|invoices)          → reconcile_doc()
    quote/invoice save     (PUT  /api/quotes|invoices/{id})     → reconcile_doc()
    quote/invoice delete   (DELETE …)                           → reconcile_doc(deleted=True)
    client accepts a quote (POST /api/view/{token}/accept)      → reconcile_doc()
    app boot               (backend/main.py lifespan)           → reconcile_all()
                                                                   (one-time backfill for
                                                                   documents that pre-date
                                                                   this engine; idempotent)

Policy (confirmed with the owner: "similar to quotes, it's not marked as
unavailable until it's confirmed")
=======================================================================
- A QUOTE books its equipment lines only while ``status == "accepted"``. A
  draft or sent quote reserves nothing; a declined one reserves nothing; a
  converted one hands its bookings to the invoice.
- An INVOICE books its equipment lines in every status — an invoice only
  exists for confirmed work, and the draft created by converting a quote must
  keep the quote's booking alive without a gap.
- A partially invoiced accepted quote books the UN-invoiced remainder
  (``qty - invoicedQty``) while the invoice books what it drew, so the total
  never double-counts across the two documents.
- Line dates: the section's own rental period when ``customDates`` is set,
  otherwise the document's — a quote's linked project dates, or its custom
  dates when it has no project; an invoice's linked project dates. A line with
  no resolvable dates cannot be booked and is skipped.
- Bookings are keyed by ``(doc_type, doc_id, line_id)``. An existing row is
  UPDATED in place (qty, dates, item, project) so the state a person set on it
  (reserved → allocated → checked-out) survives a document edit. A row whose
  line no longer books is DELETED only while still ``reserved`` / ``allocated``:
  gear that is physically out (``checked-out``) keeps counting against
  availability until someone returns it, and ``returned`` rows are history.
  ``under-maintenance`` rows are never touched.
- ``doc_type == "manual"`` rows (entered on the Allocations tab) are never
  touched by anything here.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend import models

# Rows in these states are ours to remove when their line stops booking.
_REMOVABLE = ("reserved", "allocated")
# Rows in these states are updated in place from the document; the rest
# (returned / under-maintenance) are left exactly as they are.
_UPDATABLE = ("reserved", "allocated", "checked-out")


def _num(v) -> float:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return 0.0
    return n if n == n else 0.0  # NaN guard


def _iso(v) -> str:
    return v if isinstance(v, str) and len(v) == 10 else ""


def doc_books(doc_type: str, row) -> bool:
    """Does this document commit gear right now? See the policy above."""
    if doc_type == "quote":
        return row.status == "accepted"
    if doc_type == "invoice":
        return True
    return False


def booking_lines(doc_type: str, row, projects: dict) -> list[dict]:
    """The bookings this document implies: one per equipment line with a
    positive quantity and resolvable dates.

    ``projects`` maps project id → Project row (only the ids the document
    references need to be present; a missing project simply yields no dates).
    Pure over the row's JSON so it is unit-testable without a session."""
    out: list[dict] = []
    if not doc_books(doc_type, row):
        return out
    sections = row.sections if isinstance(row.sections, list) else []

    def project_dates(pid):
        p = projects.get(pid) if pid is not None else None
        if p is None:
            return "", ""
        return _iso(getattr(p, "start_date", "")), _iso(getattr(p, "end_date", ""))

    # Document-level default dates.
    if doc_type == "quote":
        if row.project_id is not None:
            d_start, d_end = project_dates(row.project_id)
        else:
            d_start, d_end = _iso(row.custom_start_date), _iso(row.custom_end_date)
    else:
        d_start, d_end = project_dates(row.project_id)

    for sec in sections:
        if not isinstance(sec, dict):
            continue
        sec_project = sec.get("projectId")
        if sec_project is None:
            sec_project = row.project_id
        if sec.get("customDates") and _iso(sec.get("startDate")) and _iso(sec.get("endDate")):
            start, end = sec["startDate"], sec["endDate"]
        elif sec_project is not None and sec_project != row.project_id:
            # A section appended from another job books on THAT job's dates.
            start, end = project_dates(sec_project)
        else:
            start, end = d_start, d_end
        if not start or not end or start > end:
            continue
        items = sec.get("items") if isinstance(sec.get("items"), list) else []
        for it in items:
            if not isinstance(it, dict) or it.get("type") != "equipment":
                continue
            eq_id = it.get("equipmentId")
            if not isinstance(eq_id, int) or isinstance(eq_id, bool):
                continue
            qty = _num(it.get("qty"))
            if doc_type == "quote":
                qty -= _num(it.get("invoicedQty"))
            qty = int(qty) if float(qty).is_integer() else qty
            if qty <= 0:
                continue
            line_id = str(it.get("id") or "")
            if not line_id:
                continue
            out.append({
                "line_id": line_id[:64],
                "equipment_id": eq_id,
                "qty": qty,
                "start_date": start,
                "end_date": end,
                "project_id": sec_project,
            })
    return out


async def _load_projects(db: AsyncSession, ids: set) -> dict:
    ids = {i for i in ids if isinstance(i, int) and not isinstance(i, bool)}
    if not ids:
        return {}
    rows = (await db.execute(
        select(models.Project).where(models.Project.id.in_(ids))
    )).scalars().all()
    return {p.id: p for p in rows}


async def _existing_equipment(db: AsyncSession, ids: set) -> set:
    ids = {i for i in ids if isinstance(i, int) and not isinstance(i, bool)}
    if not ids:
        return set()
    rows = (await db.execute(
        select(models.Equipment.id).where(models.Equipment.id.in_(ids))
    )).scalars().all()
    return set(rows)


def _referenced_project_ids(row) -> set:
    ids = {row.project_id}
    for sec in (row.sections if isinstance(row.sections, list) else []):
        if isinstance(sec, dict) and sec.get("projectId") is not None:
            ids.add(sec.get("projectId"))
    return ids


async def reconcile_doc(db: AsyncSession, doc_type: str, row, *, deleted: bool = False) -> dict:
    """Bring the allocations owned by this document in line with what it books.
    Flushes when anything changed. Returns {"created", "updated", "removed"}
    counts. With ``deleted=True`` the document is about to go: every removable
    booking it owns is dropped (call BEFORE ``db.delete``).

    ``doc_type`` is "quote" or "invoice"; ``row`` the ORM row."""
    wanted: dict = {}
    if not deleted:
        projects = await _load_projects(db, _referenced_project_ids(row))
        lines = booking_lines(doc_type, row, projects)
        # A line naming an item that no longer exists cannot be booked (the FK
        # would reject it; SQLite would silently take it). Skip, don't fail the
        # document save.
        known = await _existing_equipment(db, {ln["equipment_id"] for ln in lines})
        for ln in lines:
            if ln["equipment_id"] in known:
                wanted[ln["line_id"]] = ln
        # A booking must point at a project row that exists (FK); a quote with
        # custom dates and no project books with project_id None.
        for ln in wanted.values():
            if ln["project_id"] is not None and ln["project_id"] not in projects:
                ln["project_id"] = None

    existing = (await db.execute(
        select(models.Allocation).where(
            models.Allocation.doc_type == doc_type,
            models.Allocation.doc_id == row.id,
        )
    )).scalars().all()

    created = updated = removed = 0
    seen: set = set()
    for a in existing:
        ln = wanted.get(a.line_id)
        if ln is None or a.line_id in seen:
            # Line gone (or a duplicate row for the same line): drop it only
            # while it is still just a reservation.
            if a.state in _REMOVABLE:
                await db.delete(a)
                removed += 1
            continue
        seen.add(a.line_id)
        if a.state not in _UPDATABLE:
            continue
        changed = False
        for col in ("equipment_id", "qty", "start_date", "end_date", "project_id"):
            if getattr(a, col) != ln[col]:
                setattr(a, col, ln[col])
                changed = True
        if changed:
            updated += 1
    for line_id, ln in wanted.items():
        if line_id in seen:
            continue
        db.add(models.Allocation(
            equipment_id=ln["equipment_id"], project_id=ln["project_id"], qty=ln["qty"],
            start_date=ln["start_date"], end_date=ln["end_date"], state="reserved",
            notes="", doc_type=doc_type, doc_id=row.id, line_id=line_id,
        ))
        created += 1

    if created or updated or removed:
        await db.flush()
        print(f"[LTP] bookings: {doc_type} {row.id} {'deleted' if deleted else 'saved'} → "
              f"{created} booked, {updated} updated, {removed} released", flush=True)
    return {"created": created, "updated": updated, "removed": removed}


async def reconcile_all(db: AsyncSession) -> dict:
    """Walk every quote and invoice once. Idempotent — safe on every boot, and
    the one-time backfill for documents that pre-date this engine."""
    totals = {"created": 0, "updated": 0, "removed": 0}
    for doc_type, model_cls in (("quote", models.Quote), ("invoice", models.Invoice)):
        rows = (await db.execute(select(model_cls))).scalars().all()
        for row in rows:
            r = await reconcile_doc(db, doc_type, row)
            for k in totals:
                totals[k] += r[k]
    return totals
