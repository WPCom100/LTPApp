"""Referential integrity for crew requests.

A CrewRequest (backend/models.py) references shift positions ONLY by string id
(``position_ids``) plus a ``project_id``. The positions themselves live inside
``Project.schedule[].positions[]`` (a JSON column). So removing a position,
removing a whole schedule day, or deleting a project leaves a request's
``position_ids`` pointing at things that no longer exist — and because the rest
of the system silently skips ids it can't find, an ``accepted`` request keeps
reading as a live hire forever.

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


def _assigned_position_ids(project, contact_id) -> set:
    """Position ids that still exist in the schedule AND are still assigned to
    ``contact_id``.

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
        for pos in (shift.get("positions") or []):
            pid = pos.get("id")
            if pid is not None and pos.get("crewId") == contact_id:
                present.add(pid)
    return present


def reconcile_one(req: models.CrewRequest, project) -> dict | None:
    """Heal one request against its project (``project=None`` means the project
    is gone). Mutates ``req`` in place; the caller is responsible for the flush.

    Returns a change summary dict, or ``None`` when nothing changed:
      - ``project`` gone OR none of its positions are still the member's →
        ``status='withdrawn'``
      - some positions removed/reassigned away → ``position_ids`` trimmed to the
        ones the member still holds

    Only acts on active (pending/accepted) requests."""
    if req.status not in _ACTIVE:
        return None
    original = list(req.position_ids or [])
    present = _assigned_position_ids(project, req.contact_id)
    live = [pid for pid in original if pid in present]
    removed = [pid for pid in original if pid not in present]
    if not removed:
        return None  # every referenced position still exists — nothing to do

    if not live:
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

    # Partially stale → trim to the surviving shifts; the request stays active
    # (a producer removed some shifts, not the whole booking).
    req.position_ids = live
    flag_modified(req, "position_ids")
    return {"requestId": req.id, "action": "trimmed", "removed": removed, "remaining": live}


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
              f"{sum(c['action'] == 'trimmed' for c in changes)} trimmed", flush=True)
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
