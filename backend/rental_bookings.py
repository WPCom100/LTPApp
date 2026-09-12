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
    check out / return     (POST /api/quotes/{id}/gear)          → set_gear_state()

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
- Converting a quote HANDS ITS BOOKINGS TO THE INVOICE. An invoice line that
  draws from a quote line (``sourceQuoteId`` / ``sourceItemId``) adopts the
  quote's booking: when it draws everything the quote still books, the row is
  re-keyed to the invoice with its state intact (gear checked out against the
  quote stays checked out); when it draws part, the invoice row is created in
  the quote row's state and the quote row shrinks to the remainder. Either
  save order (invoice first or quote first) lands on the same rows.
- ``doc_type == "manual"`` rows (entered by hand through the API) are never
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


def _source_map(invoice) -> dict:
    """invoice line id → (sourceQuoteId, sourceItemId) for lines drawn from a quote."""
    out = {}
    for sec in (invoice.sections if isinstance(invoice.sections, list) else []):
        if not isinstance(sec, dict):
            continue
        for it in (sec.get("items") if isinstance(sec.get("items"), list) else []):
            if not isinstance(it, dict) or it.get("type") != "equipment":
                continue
            qid, lid = it.get("sourceQuoteId"), it.get("sourceItemId")
            if isinstance(qid, int) and not isinstance(qid, bool) and lid:
                out[str(it.get("id") or "")] = (qid, str(lid))
    return out


async def _adopt_from_quotes(db: AsyncSession, invoice, wanted: dict, existing_line_ids: set):
    """For each invoice line drawn from a quote line that has no booking on
    this invoice yet, take over the quote's booking (see the module docstring).
    Returns (adopted, inherited): rows re-keyed onto this invoice, keyed by
    invoice line id, and the state a still-to-be-created row should start in."""
    adopted: dict = {}
    inherited: dict = {}
    sources = _source_map(invoice)
    quote_cache: dict = {}
    for line_id, ln in wanted.items():
        if line_id in existing_line_ids or line_id not in sources:
            continue
        qid, src_line = sources[line_id]
        q_row = (await db.execute(
            select(models.Allocation).where(
                models.Allocation.doc_type == "quote",
                models.Allocation.doc_id == qid,
                models.Allocation.line_id == src_line,
            )
        )).scalars().first()
        if q_row is None:
            continue
        if qid not in quote_cache:
            quote = (await db.execute(select(models.Quote).where(models.Quote.id == qid))).scalar_one_or_none()
            q_wanted = {}
            if quote is not None:
                projects = await _load_projects(db, _referenced_project_ids(quote))
                q_wanted = {x["line_id"]: x for x in booking_lines("quote", quote, projects)}
            quote_cache[qid] = q_wanted
        remainder = quote_cache[qid].get(src_line, {}).get("qty", 0)
        if remainder <= 0 or ln["qty"] >= remainder:
            # The invoice takes the whole booking: same row, new owner.
            q_row.doc_type, q_row.doc_id, q_row.line_id = "invoice", invoice.id, line_id
            for col in ("equipment_id", "qty", "start_date", "end_date", "project_id"):
                setattr(q_row, col, ln[col])
            adopted[line_id] = q_row
        else:
            inherited[line_id] = q_row.state
    return adopted, inherited


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
    inherited: dict = {}
    if doc_type == "invoice" and not deleted:
        adopted, inherited = await _adopt_from_quotes(db, row, wanted, {a.line_id for a in existing})
        for line_id in adopted:
            seen.add(line_id)
            updated += 1
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
            start_date=ln["start_date"], end_date=ln["end_date"],
            state=inherited.get(line_id, "reserved"),
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



# What "check out" and "return" move, and from where. Return frees anything
# still out or merely held (a job that wrapped early); under-maintenance rows
# are a repair record, never gear on a job.
_GEAR_MOVES = {
    "checked-out": ("reserved", "allocated"),
    "returned": ("reserved", "allocated", "checked-out"),
}


async def gear_rows_for_quote(db: AsyncSession, quote_id: int) -> list:
    """Every booking that belongs to this quote's gear: the rows keyed to the
    quote itself, plus rows on invoices for lines drawn from it (the handover
    above moves bookings there on conversion)."""
    rows = list((await db.execute(
        select(models.Allocation).where(
            models.Allocation.doc_type == "quote",
            models.Allocation.doc_id == quote_id,
        )
    )).scalars().all())
    invoices = (await db.execute(select(models.Invoice))).scalars().all()
    pairs = set()
    for inv in invoices:
        for line_id, (qid, _src) in _source_map(inv).items():
            if qid == quote_id:
                pairs.add((inv.id, line_id))
    if pairs:
        inv_rows = (await db.execute(
            select(models.Allocation).where(
                models.Allocation.doc_type == "invoice",
                models.Allocation.doc_id.in_({p[0] for p in pairs}),
            )
        )).scalars().all()
        rows.extend(a for a in inv_rows if (a.doc_id, a.line_id) in pairs)
    return rows


async def set_gear_state(db: AsyncSession, quote_id: int, state: str) -> int:
    """Check out (or return) every booking behind a quote's gear. Returns how
    many rows moved. Flushes when any did."""
    from_states = _GEAR_MOVES[state]
    moved = 0
    for a in await gear_rows_for_quote(db, quote_id):
        if a.state in from_states:
            a.state = state
            moved += 1
    if moved:
        await db.flush()
        print(f"[LTP] bookings: quote {quote_id} gear → {state} ({moved} row(s))", flush=True)
    return moved
