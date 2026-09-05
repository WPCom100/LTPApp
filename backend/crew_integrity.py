"""Referential integrity for crew requests.

A CrewRequest (backend/models.py) references shift positions ONLY by string id
(``position_ids``) plus a ``project_id``. The positions themselves live inside
``Project.schedule[].positions[]`` (a JSON column). So removing a position,
removing a whole schedule day, clearing a day's date (it becomes an
"unscheduled" day, no longer a valid shift), or deleting a project leaves a
request's ``position_ids`` pointing at things that are no longer live — and
because the rest of the system silently skips ids it can't find, an
``accepted`` request keeps reading as a live hire forever.

This module is the single source of truth for detecting + healing that drift. It
is wired into every stage of the pipeline that can remove an upstream entity, so
a removal is *traced* the moment it happens instead of leaving a zombie:

    project save    (PUT  /api/projects/{id})      → reconcile_project()
    project delete  (DELETE /api/projects/{id})    → reconcile_project(deleted=True)
    crew opens link (GET  /api/crew/{token})       → reconcile_one()
    crew accept/decline                            → reconcile_one() guard
    producer lists  (GET  /api/crew-requests)      → reconcile_all()  (also a
                                                      one-time backfill for
                                                      requests orphaned before
                                                      this engine existed)

Policy (confirmed with the owner)
=================================
A request is TRIMMED to its surviving positions; once NONE survive (or its
project is gone) it is AUTO-WITHDRAWN (``status='withdrawn'``). A withdrawn
request drops out of the producer's active list (the Crew Requests tab hides
withdrawn) and the crew landing page shows the standard "this request has been
withdrawn" screen. Crew are NEVER auto-emailed. Only non-terminal requests
(``pending`` / ``accepted``) are ever touched — ``declined`` / ``withdrawn`` are
already settled, so we leave them.

Status drift (the second failure mode)
======================================
Besides *removed* positions, a request's surviving positions can drift BELOW
the request's own state: the frontend PUTs its entire in-memory project row
(schedule included) and never refetches projects after page load, so a
tab/device whose copy predates a send (or an answer) reverts those positions'
``status`` back to ``open`` on its next save — while the crew member stays
assigned and the request still reads pending/accepted. The producer then sees
"Ready to send" on a shift the crew member already accepted. Two defenses:

  - ``reconcile_one`` also HEALS: positions a live request still covers are
    advanced back up to the request's status floor (pending → ``requested``,
    accepted → ``accepted``). It never downgrades — ``confirmed`` and
    ``declined`` positions, and anything already at/above the floor, are left
    alone. Runs everywhere reconciliation already runs, so the first
    producer-list load after a drift (or after this deploy) self-heals it.
  - ``enforce_status_floor`` blocks the stale write itself at the project PUT
    (routes/api.py): an incoming position keeping the SAME crew member but a
    lower-ranked status than the stored row is a stale echo, never a
    deliberate change — every deliberate downgrade in the UI (Release /
    Withdraw / Cancel / Reassign) clears or changes the assignee.

Flat-rate positions (``Project.fixed_positions`` — no date, no times, a flat
fee for the whole job) share the position id namespace and status ladder, so
every walk in this module covers them as well; a request may reference any mix
of shift positions and flat-rate positions.

Position ids are stable (``theme.js`` ``genId`` = ``pos-<ts>-<counter>``; saves,
edits, and reordering all preserve them), so trimming only ever fires on a
genuine change — a removed shift OR a position reassigned to a different crew
member (the request belongs to the person who was asked; reassigning the shift
away releases it). Normal editing can't false-positive.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from backend import models


# Statuses a request can be healed FROM. Terminal-and-settled states
# (declined, withdrawn) are left untouched.
_ACTIVE = ("pending", "accepted")

# Position-status floor a live request implies: request status → (statuses to
# heal FROM, status to advance TO). A position a request still covers can't
# legitimately sit below the floor while the same crew member holds it —
# every deliberate producer-side downgrade also unassigns (which trims the
# request instead). Healing only ever advances; confirmed/declined positions
# and anything already at the floor are never touched.
_STATUS_FLOOR = {
    "pending":  ({"open"}, "requested"),
    "accepted": ({"open", "requested"}, "accepted"),
}

# Rank for the stale-write guard (enforce_status_floor). ``declined`` ranks
# with ``accepted``: both are settled crew answers that a stale open/requested
# echo must not erase. Unknown statuses never trigger the guard (incoming
# unknown ranks high, stored unknown ranks low).
_STATUS_RANK = {"open": 0, "requested": 1, "accepted": 2, "declined": 2, "confirmed": 3}


def _fixed_positions(project) -> list:
    """The project's flat-rate positions (Project.fixed_positions), as a list
    of position dicts. They live outside the schedule — no date, no times — but
    share the position id namespace and status ladder, so every walk over
    ``schedule[].positions[]`` in this module walks these too."""
    if project is None:
        return []
    raw = getattr(project, "fixed_positions", None) or []
    return [p for p in raw if isinstance(p, dict)]


def _assigned_position_ids(project, contact_id) -> set:
    """Position ids that still exist in the schedule (or the flat-rate list)
    AND are still assigned to ``contact_id``.

    A request owns only the shifts its crew member currently holds. A position
    that was reassigned to someone else (or unassigned) is no longer live for the
    request even though the position itself still exists — so it must be trimmed
    just like a deleted one. This is safe to key on crew because the send
    endpoint only ever requests positions already assigned to the member
    (routes/crew.py), so a freshly-created request matches exactly; this only
    ever trims on a *later* reassignment."""
    present = set()
    if project is None:
        return present
    for shift in (project.schedule or []):
        # A shift whose date was cleared is "unscheduled" — no longer a real,
        # assignable day. Treat its positions as gone so a request sent while the
        # day was dated is trimmed (or auto-withdrawn, if it was the only day)
        # when the date is later removed. This mirrors the send-side rule that a
        # request can't be created for a dateless day in the first place
        # (routes/crew.py send_crew_request), so the "must have a date" invariant
        # holds in both directions.
        if not (shift.get("date") or "").strip():
            continue
        for pos in (shift.get("positions") or []):
            pid = pos.get("id")
            if pid is not None and pos.get("crewId") == contact_id:
                present.add(pid)
    # A flat-rate position has no date by design — it is live for as long as
    # it exists and is still this crew member's.
    for pos in _fixed_positions(project):
        pid = pos.get("id")
        if pid is not None and pos.get("crewId") == contact_id:
            present.add(pid)
    return present


def _heal_position_statuses(req: models.CrewRequest, project) -> list:
    """Advance positions the request still covers that sit BELOW its status
    floor (see ``_STATUS_FLOOR``) — the schedule-side repair for drift where a
    stale full-row project save reverted a requested/accepted position back to
    ``open`` while the crew member stayed assigned. Only positions on a dated
    shift, still held by the request's contact, are touched. Mutates the
    schedule in place and flag_modifies it when anything changed. Returns the
    list of position ids advanced."""
    floor = _STATUS_FLOOR.get(req.status)
    if floor is None or project is None:
        return []
    heal_from, target = floor
    ids = set(req.position_ids or [])
    if not ids:
        return []
    healed = []
    for shift in (project.schedule or []):
        if not (shift.get("date") or "").strip():
            continue
        for pos in (shift.get("positions") or []):
            if (pos.get("id") in ids
                    and pos.get("crewId") == req.contact_id
                    and pos.get("status") in heal_from):
                pos["status"] = target
                healed.append(pos.get("id"))
    if healed:
        flag_modified(project, "schedule")
    healed_fixed = []
    for pos in _fixed_positions(project):
        if (pos.get("id") in ids
                and pos.get("crewId") == req.contact_id
                and pos.get("status") in heal_from):
            pos["status"] = target
            healed_fixed.append(pos.get("id"))
    if healed_fixed:
        flag_modified(project, "fixed_positions")
    return healed + healed_fixed


def reconcile_one(req: models.CrewRequest, project) -> dict | None:
    """Heal one request against its project (``project=None`` means the project
    is gone). Mutates ``req`` (and possibly the project's schedule) in place;
    the caller is responsible for the flush.

    Returns a change summary dict, or ``None`` when nothing changed:
      - ``project`` gone OR none of its positions are still the member's →
        ``status='withdrawn'``
      - some positions removed/reassigned away → ``position_ids`` trimmed to the
        ones the member still holds
      - surviving positions sitting BELOW the request's status floor (a stale
        project save reverted requested/accepted back to open) → advanced back
        to the floor; ``healed`` lists the position ids touched

    Only acts on active (pending/accepted) requests."""
    if req.status not in _ACTIVE:
        return None
    original = list(req.position_ids or [])
    present = _assigned_position_ids(project, req.contact_id)
    live = [pid for pid in original if pid in present]
    removed = [pid for pid in original if pid not in present]

    if original and not live:
        # Fully stale → auto-withdraw. Keep position_ids as the audit record of
        # what it used to cover; they're harmless once the status is terminal
        # (reconcileFromRequests + _update_positions both ignore withdrawn).
        req.status = "withdrawn"
        return {
            "requestId": req.id,
            "action": "withdrawn",
            "reason": "project_deleted" if project is None else "positions_removed",
            "removed": removed,
        }

    if removed:
        # Partially stale → trim to the surviving shifts; the request stays
        # active (a producer removed some shifts, not the whole booking).
        req.position_ids = live
        flag_modified(req, "position_ids")

    # Status drift: re-assert the floor on the (possibly just-trimmed) live
    # positions, so an accepted request whose schedule was clobbered back to
    # "open"/"requested" by a stale save reads as accepted again everywhere.
    healed = _heal_position_statuses(req, project)

    if not removed and not healed:
        return None  # every position present, none below the floor — nothing to do
    if removed:
        out = {"requestId": req.id, "action": "trimmed", "removed": removed, "remaining": live}
        if healed:
            out["healed"] = healed
        return out
    return {"requestId": req.id, "action": "healed", "healed": healed}


async def reconcile_project(db: AsyncSession, project: models.Project, *, deleted: bool = False) -> list[dict]:
    """Reconcile every active request for ``project`` after its schedule changed
    (or it is about to be deleted — pass ``deleted=True`` and call this BEFORE
    ``db.delete`` while the FK linkage is still intact). Flushes when anything
    changed. Returns the list of change summaries."""
    rows = (await db.execute(
        select(models.CrewRequest).where(
            models.CrewRequest.project_id == project.id,
            models.CrewRequest.status.in_(_ACTIVE),
        )
    )).scalars().all()
    changes = []
    for req in rows:
        ch = reconcile_one(req, None if deleted else project)
        if ch:
            changes.append(ch)
    if changes:
        await db.flush()
        print(f"[LTP] crew-integrity: project {project.id} "
              f"{'deleted' if deleted else 'saved'} → "
              f"{sum(c['action'] == 'withdrawn' for c in changes)} withdrawn, "
              f"{sum(c['action'] == 'trimmed' for c in changes)} trimmed, "
              f"{sum(1 for c in changes if c.get('healed'))} status-healed", flush=True)
    return changes


async def reconcile_request(db: AsyncSession, req: models.CrewRequest) -> dict | None:
    """Load ``req``'s project and reconcile that single request (used by the crew
    GET + the accept/decline guard). Flushes when it changed."""
    project = None
    if req.project_id is not None:
        project = (await db.execute(
            select(models.Project).where(models.Project.id == req.project_id)
        )).scalar_one_or_none()
    ch = reconcile_one(req, project)
    if ch:
        await db.flush()
    return ch


def enforce_status_floor(stored_schedule, incoming_schedule) -> int:
    """Repair position-status regressions in an incoming project write.

    The frontend PUTs its entire in-memory project row (schedule included) and
    never refetches projects after page load — so a tab/device whose copy
    predates a crew-request send (or the crew member's answer) silently reverts
    those positions' statuses on its next save, while the request record still
    reads pending/accepted. For every incoming position that (a) already exists
    on the stored row, (b) keeps the SAME assigned crew member, and (c) writes a
    strictly lower-ranked status (``_STATUS_RANK``), restore the stored status —
    that combination is always a stale echo. Deliberate downgrades (Release /
    Withdraw / Cancel / Reassign in the Labor UI) all clear or change the
    assignee, so they pass through untouched, as do new positions and upgrades.

    Mutates ``incoming_schedule`` in place; returns the number of positions
    restored. Pure function of the two JSON blobs — no DB access."""
    stored = {}
    for shift in (stored_schedule or []):
        if not isinstance(shift, dict):
            continue
        for pos in (shift.get("positions") or []):
            if isinstance(pos, dict) and pos.get("id") is not None:
                stored[pos["id"]] = (pos.get("crewId"), pos.get("status"))
    if not stored:
        return 0
    fixed = 0
    for shift in (incoming_schedule or []):
        if not isinstance(shift, dict):
            continue
        for pos in (shift.get("positions") or []):
            if not isinstance(pos, dict):
                continue
            prev = stored.get(pos.get("id"))
            if prev is None:
                continue
            prev_crew, prev_status = prev
            if prev_crew is None or pos.get("crewId") != prev_crew:
                continue
            if _STATUS_RANK.get(pos.get("status"), 99) < _STATUS_RANK.get(prev_status, -1):
                pos["status"] = prev_status
                fixed += 1
    return fixed


def enforce_pay_snapshot(stored_schedule, incoming_schedule) -> int:
    """Payroll-integrity guard for NON-ADMIN project writes.

    A position's frozen payout snapshot — ``work`` (the signed-off pay object the
    QuickBooks payout export bills *verbatim*, `work.pay.total`) and ``adj`` (the
    itemized pay adjustments) — is money that flows straight onto a Vendor Bill.
    Only admins may create or change it. But the frontend PUTs its whole in-memory
    project row, so a non-admin's ordinary schedule save carries these sub-objects
    too, and nothing else re-derives them server-side (the export trusts the stored
    snapshot). Without this guard any signed-in member could raise ``work.pay.total``
    on a confirmed day and have an admin's later export bill the inflated amount —
    the amount-reconciliation check can't catch it because QuickBooks derives its
    total from the same tampered lines.

    So for a non-admin write we restore each incoming position's ``work``/``adj`` to
    the stored value (matched by position id), and strip them from positions that
    don't exist in the stored row (a non-admin can't *introduce* a snapshot either).
    Legitimate member edits — times, roles, assignments, statuses, breaks — are
    untouched, and because a member's save echoes the snapshot it loaded, an
    unchanged snapshot restores to itself (a no-op). Admin writes never call this.

    Mutates ``incoming_schedule`` in place; returns the number of positions whose
    ``work`` or ``adj`` was restored/stripped (for audit logging). Pure function of
    the two JSON blobs — no DB access."""
    stored = {}
    for shift in (stored_schedule or []):
        if not isinstance(shift, dict):
            continue
        for pos in (shift.get("positions") or []):
            if isinstance(pos, dict) and pos.get("id") is not None:
                stored[pos["id"]] = (pos.get("work"), pos.get("adj"))
    fixed = 0
    for shift in (incoming_schedule or []):
        if not isinstance(shift, dict):
            continue
        for pos in (shift.get("positions") or []):
            if not isinstance(pos, dict):
                continue
            prev_work, prev_adj = stored.get(pos.get("id"), (None, None))
            if pos.get("work") != prev_work:
                if prev_work is None:
                    pos.pop("work", None)
                else:
                    pos["work"] = prev_work
                fixed += 1
            if pos.get("adj") != prev_adj:
                if prev_adj is None:
                    pos.pop("adj", None)
                else:
                    pos["adj"] = prev_adj
                fixed += 1
    return fixed


def enforce_status_floor_fixed(stored_fixed, incoming_fixed) -> int:
    """``enforce_status_floor`` for the flat-rate list (Project.fixed_positions).
    Same rule, same reason; the list is a bare position list rather than shift
    rows, so it is wrapped as one pseudo-shift. Mutates ``incoming_fixed`` in
    place; returns the number of positions restored."""
    return enforce_status_floor([{"positions": stored_fixed or []}],
                                [{"positions": incoming_fixed or []}])


def enforce_pay_snapshot_fixed(stored_fixed, incoming_fixed) -> int:
    """``enforce_pay_snapshot`` for the flat-rate list: a non-admin write may not
    create or change a flat-rate position's frozen ``work``/``adj`` (its fee is
    billed to a vendor bill exactly like a signed day). Mutates
    ``incoming_fixed`` in place; returns the number restored/stripped."""
    return enforce_pay_snapshot([{"positions": stored_fixed or []}],
                                [{"positions": incoming_fixed or []}])


async def reconcile_all(db: AsyncSession) -> int:
    """Sweep every active request, batching project loads. Heals ongoing drift
    and backfills requests orphaned before this engine existed (the first
    producer list after deploy auto-withdraws the stale ones). Returns the count
    of requests changed; flushes when non-zero. Caller commits."""
    rows = (await db.execute(
        select(models.CrewRequest).where(models.CrewRequest.status.in_(_ACTIVE))
    )).scalars().all()
    if not rows:
        return 0
    pids = {r.project_id for r in rows if r.project_id is not None}
    projects: dict = {}
    if pids:
        prs = (await db.execute(
            select(models.Project).where(models.Project.id.in_(pids))
        )).scalars().all()
        projects = {p.id: p for p in prs}
    changed = 0
    for req in rows:
        project = projects.get(req.project_id) if req.project_id is not None else None
        if reconcile_one(req, project):
            changed += 1
    if changed:
        await db.flush()
        print(f"[LTP] crew-integrity: sweep healed {changed} stale request(s)", flush=True)
    return changed
