"""Crew request — tokenized accept/decline + producer send/withdraw.

Two routers, mirroring the split that already exists for quotes/invoices
(public token surface in view.py, session-gated CRUD in api.py):

  PUBLIC (no session — the token IS the credential, like /api/view):
    GET  /api/crew/{token}          → sanitized crew-facing payload
    POST /api/crew/{token}/accept   → body {comment?}; pending → accepted
    POST /api/crew/{token}/decline  → body {comment?}; pending → declined

  PRODUCER (session-gated, under /api/crew-requests):
    GET  /api/crew-requests              → list (optionally ?projectId=)
    POST /api/crew-requests/send         → body {projectId, contactId, positionIds?}
    POST /api/crew-requests/{id}/withdraw → pending → withdrawn

The accept/decline flow drives the POSITION status machine that the Labor
module already understands (components/status-enums.js). Positions live in
Project.schedule[].positions[] (JSON); we mutate their `status` in place and
flag_modified the column. See backend/models.py CrewRequest for the full
state machine.

Security model (reuses the hardened patterns from SECURITY_REVIEW.md):
  - token minted server-side via secrets.token_urlsafe(32) (~256 bits), never
    client-set, never echoed on the public payload (the holder already has it).
  - the public GET payload is an ALLOW-LIST: only this crew member's own shifts
    + branding; no cost, no internal notes, no other crew, no FK ids.
  - accept/decline are idempotent (409 once terminal) and capture IP/UA for
    non-repudiation (internal-only — never surfaced on the payload).
  - /api/crew is rate-limited (backend/rate_limit.py) like /api/view.
"""
from datetime import datetime, timezone
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from backend import models, view_tracking
from backend.auth_deps import require_session
from backend.database import get_db
from backend.routes._shared import load_settings, public_settings


# Public — no session dependency. Token is the credential.
crew_public_router = APIRouter(prefix="/api/crew", tags=["crew"])
# Producer — every route requires a valid session.
crew_admin_router = APIRouter(
    prefix="/api/crew-requests", tags=["crew"],
    dependencies=[Depends(require_session)],
)

# Position statuses a request may be SENT against (assigned-but-not-yet-sent,
# or previously declined and being re-asked). Accepted/confirmed positions are
# deliberately excluded so a re-send can't clobber a settled hire.
_SENDABLE_FROM = {"open", "declined"}
# Terminal request statuses — once here, accept/decline are locked.
_TERMINAL = {"accepted", "declined", "withdrawn"}


# ── Shared helpers ─────────────────────────────────────────────────────────

async def _find_request_by_token(db: AsyncSession, token: str):
    """Return the CrewRequest for `token`, or None. The length floor blunts
    garbage/enumeration lookups before they hit the index (mirrors view.py)."""
    if not token or len(token) < 8:
        return None
    r = await db.execute(select(models.CrewRequest).where(models.CrewRequest.token == token))
    return r.scalar_one_or_none()


async def _load_project(db: AsyncSession, project_id):
    if project_id is None:
        return None
    r = await db.execute(select(models.Project).where(models.Project.id == project_id))
    return r.scalar_one_or_none()


def _update_positions(project, position_ids, *, to_status, require_from=None) -> int:
    """Set status=to_status on every position in project.schedule whose id is
    in position_ids — optionally only when its current status is in
    `require_from`. Mutates the JSON in place and flag_modifies the column so
    SQLAlchemy persists it. Returns the number of positions changed."""
    ids = set(position_ids or [])
    if not ids:
        return 0
    changed = 0
    schedule = project.schedule or []
    for shift in schedule:
        for pos in (shift.get("positions") or []):
            if pos.get("id") not in ids:
                continue
            if require_from is not None and pos.get("status") not in require_from:
                continue
            pos["status"] = to_status
            changed += 1
    if changed:
        flag_modified(project, "schedule")
    return changed


def _crew_shifts(project, position_ids, services_by_id) -> list:
    """Build the crew-facing shift list for `position_ids`, resolving role
    labels server-side (the public page has no services catalog). Allow-list
    only — never carries crewId, serviceId internals, or other crew's slots."""
    ids = set(position_ids or [])
    out = []
    for shift in (project.schedule or []):
        for pos in (shift.get("positions") or []):
            if pos.get("id") not in ids:
                continue
            svc = services_by_id.get(pos.get("serviceId"))
            if svc is not None:
                role_label = (svc.role or "")
                if svc.description:
                    role_label = (role_label + " — " + svc.description).strip(" —")
                dept = svc.department or ""
            else:
                role_label = pos.get("role") or ""
                dept = ""
            out.append({
                "positionId": pos.get("id"),
                "roleLabel": role_label or "Crew",
                "department": dept,
                "status": pos.get("status"),
                "shiftTitle": shift.get("title") or "",
                "date": shift.get("date") or "",
                "startTime": shift.get("time") or "",
                "endTime": shift.get("endTime") or "",
            })
    out.sort(key=lambda s: (s["date"] or "", s["startTime"] or ""))
    return out


def _request_dict(r: models.CrewRequest) -> dict:
    """Producer-facing serialization. Includes the token so the Labor UI can
    surface/copy the crew link; this is the authenticated producer's own data.
    The PUBLIC payload (below) deliberately never includes the token."""
    return {
        "id": r.id,
        "token": r.token,
        "projectId": r.project_id,
        "contactId": r.contact_id,
        "positionIds": r.position_ids or [],
        "status": r.status,
        "comment": r.comment or "",
        "sentAt": r.sent_at.isoformat() if r.sent_at else None,
        "respondedAt": r.responded_at.isoformat() if r.responded_at else None,
        "sentByUserId": r.sent_by_user_id,
    }


# ── PUBLIC: GET /api/crew/{token} ───────────────────────────────────────────

@crew_public_router.get("/{token}")
async def get_crew_request(token: str, db: AsyncSession = Depends(get_db)):
    """Sanitized crew-facing payload. Exposes only this crew member's shifts on
    this request + branding — no cost, no internal notes, no other crew, and
    never the token itself (the holder already has it in their URL)."""
    req = await _find_request_by_token(db, token)
    if req is None:
        raise HTTPException(status_code=404, detail="not found")

    project = await _load_project(db, req.project_id)
    contact = None
    if req.contact_id is not None:
        r = await db.execute(select(models.Contact).where(models.Contact.id == req.contact_id))
        contact = r.scalar_one_or_none()
    services = (await db.execute(select(models.Service))).scalars().all()
    services_by_id = {s.id: s for s in services}
    settings = await load_settings(db)

    shifts = _crew_shifts(project, req.position_ids, services_by_id) if project else []
    crew_name = ((contact.first_name or "") + " " + (contact.last_name or "")).strip() if contact else ""

    return {
        "status": req.status,
        "crewName": crew_name,
        "comment": req.comment or "",
        "respondedAt": req.responded_at.isoformat() if req.responded_at else None,
        "project": {
            "name": project.name if project else "",
            "venue": project.venue if project else "",
            "startDate": project.start_date if project else "",
            "endDate": project.end_date if project else "",
        },
        "shifts": shifts,
        "settings": public_settings(settings),
    }


# ── PUBLIC: POST /api/crew/{token}/accept | /decline ────────────────────────

async def _respond(token: str, body: dict, request: Request, db: AsyncSession, *, decision: str):
    """Shared accept/decline. `decision` ∈ {"accepted", "declined"} and is also
    the target position status. Idempotent: 409 once the request is terminal."""
    req = await _find_request_by_token(db, token)
    if req is None:
        raise HTTPException(status_code=404, detail="not found")
    if not isinstance(body, dict):
        body = {}
    comment = (body.get("comment") or "").strip()
    if len(comment) > 1000:
        raise HTTPException(status_code=400, detail={"field": "comment", "reason": "max 1000 chars"})

    if req.status != "pending":
        raise HTTPException(
            status_code=409,
            detail={"status": req.status, "message": f"request is already {req.status}"},
        )

    project = await _load_project(db, req.project_id)
    if project is not None:
        # Only move positions still sitting at `requested` — never override a
        # slot the producer already settled out-of-band.
        _update_positions(project, req.position_ids, to_status=decision, require_from={"requested"})

    now = datetime.now(timezone.utc)
    ip, ua = view_tracking.extract_client_meta(request)
    req.status = decision
    req.responded_at = now
    req.comment = comment
    req.respondent_ip = ip or None
    req.respondent_ua = (ua or "")[:300] or None
    await db.flush()
    return {"status": decision}


@crew_public_router.post("/{token}/accept")
async def accept_crew_request(token: str, body: dict, request: Request, db: AsyncSession = Depends(get_db)):
    return await _respond(token, body, request, db, decision="accepted")


@crew_public_router.post("/{token}/decline")
async def decline_crew_request(token: str, body: dict, request: Request, db: AsyncSession = Depends(get_db)):
    return await _respond(token, body, request, db, decision="declined")


# ── PRODUCER: GET /api/crew-requests ────────────────────────────────────────

@crew_admin_router.get("")
async def list_crew_requests(projectId: int | None = None, db: AsyncSession = Depends(get_db)):
    q = select(models.CrewRequest).order_by(models.CrewRequest.id)
    if projectId is not None:
        q = q.where(models.CrewRequest.project_id == projectId)
    rows = (await db.execute(q)).scalars().all()
    return [_request_dict(r) for r in rows]


# ── PRODUCER: POST /api/crew-requests/send ──────────────────────────────────

@crew_admin_router.post("/send")
async def send_crew_request(
    body: dict,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(require_session),
):
    """Create a crew request covering a crew member's sendable positions on a
    project, flip those positions open/declined → requested, and return the
    request (with token + crew link). Defaults to the WHOLE project; pass
    `positionIds` to send only a subset (split a project into multiple
    requests). The crew-request EMAIL is wired in a later phase — for now the
    request + token exist and the producer can copy the crew link.

    Validates the crew member exists, is crew, and has an email on file."""
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    project_id = body.get("projectId")
    contact_id = body.get("contactId")
    if not isinstance(project_id, int) or isinstance(project_id, bool):
        raise HTTPException(status_code=400, detail={"field": "projectId", "reason": "required integer"})
    if not isinstance(contact_id, int) or isinstance(contact_id, bool):
        raise HTTPException(status_code=400, detail={"field": "contactId", "reason": "required integer"})

    project = await _load_project(db, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail={"field": "projectId", "reason": "project not found"})
    r = await db.execute(select(models.Contact).where(models.Contact.id == contact_id))
    contact = r.scalar_one_or_none()
    if contact is None:
        raise HTTPException(status_code=404, detail={"field": "contactId", "reason": "contact not found"})
    if not contact.is_crew:
        raise HTTPException(status_code=400, detail={"field": "contactId", "reason": "contact is not a crew member"})
    if not (contact.email or "").strip():
        raise HTTPException(status_code=400, detail={"field": "contactId", "reason": "crew member has no email on file"})

    # Optional subset selection. When omitted/empty → whole project (every
    # sendable position assigned to this crew member).
    requested_ids = body.get("positionIds")
    explicit = isinstance(requested_ids, list) and len(requested_ids) > 0
    explicit_set = {str(x) for x in requested_ids} if explicit else None

    sendable = []
    for shift in (project.schedule or []):
        for pos in (shift.get("positions") or []):
            if pos.get("crewId") != contact_id:
                continue
            if explicit and str(pos.get("id")) not in explicit_set:
                continue
            if pos.get("status") in _SENDABLE_FROM:
                sendable.append(pos.get("id"))

    if not sendable:
        raise HTTPException(
            status_code=400,
            detail={"reason": "no sendable positions — assign this crew member to open positions on the project first"},
        )

    req = models.CrewRequest(
        token=secrets.token_urlsafe(32),
        project_id=project_id,
        contact_id=contact_id,
        position_ids=sendable,
        status="pending",
        sent_by_user_id=user.id,
    )
    db.add(req)
    _update_positions(project, sendable, to_status="requested", require_from=_SENDABLE_FROM)
    await db.flush()
    await db.refresh(req)
    return _request_dict(req)


# ── PRODUCER: POST /api/crew-requests/{id}/withdraw ─────────────────────────

@crew_admin_router.post("/{req_id}/withdraw")
async def withdraw_crew_request(
    req_id: int,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(require_session),
):
    """Withdraw a still-PENDING request: its positions go requested → open and
    the request → withdrawn. A request the crew already answered
    (accepted/declined) is NOT silently reopened — that returns 409 so the
    producer uses the Labor status controls instead. Idempotent on an
    already-withdrawn request."""
    r = await db.execute(select(models.CrewRequest).where(models.CrewRequest.id == req_id))
    req = r.scalar_one_or_none()
    if req is None:
        raise HTTPException(status_code=404, detail="not found")
    if req.status == "withdrawn":
        return _request_dict(req)
    if req.status != "pending":
        raise HTTPException(
            status_code=409,
            detail={"status": req.status, "message": f"cannot withdraw a {req.status} request; use the Labor controls"},
        )
    project = await _load_project(db, req.project_id)
    if project is not None:
        _update_positions(project, req.position_ids, to_status="open", require_from={"requested"})
    req.status = "withdrawn"
    await db.flush()
    await db.refresh(req)
    return _request_dict(req)
