import hashlib
import json
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from sqlalchemy.orm import undefer
from backend.database import async_session, get_db
from backend import crew_integrity, livesync, models, payouts
from backend.auth_deps import load_session_user, require_session, require_admin
from backend.sanitize import email_html
from backend.validators import validate
from backend.email_validate import parse_recipients, RecipientError
from backend.email_compose import _app_origin
from backend.routes.auth import _fetch_and_cache_photo


def _picture_url(u: models.User) -> str:
    """Public pictureUrl for API responses. Prefers the app-cached avatar as an
    ABSOLUTE URL (origin + path) so it (a) passes the frontend's http(s)-only
    <img> guard and (b) is the same URL used in emails. Falls back to the raw
    Google URL until the first cache lands on that user's next sign-in, then to
    "" (frontend shows an initials placeholder). Origin comes from
    LTP_OAUTH_REDIRECT_URI; empty only in local dev without it set."""
    cached = u.cached_photo_path()
    if cached:
        return (_app_origin() or "") + cached
    return u.picture_url or ""


# ── Generic helpers ───────────────────────────────────────────────────────

def _snake_to_camel(s):
    parts = s.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def _camel_to_snake(s):
    import re
    return re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", s).lower()


# Auto-managed columns the client should never send/receive.
_HIDDEN_COLS = {"created_at", "updated_at"}

# Server-authoritative columns the client may READ (they're returned on GET)
# but must never WRITE. Most are populated only by the QuickBooks sync engine
# (backend/qbo_sync.py). Stripping them on the way IN protects against the
# frontend's debounced diff-sync echoing a stale value (e.g. nulling a cached
# qb_customer_id captured before the row was synced). The names are globally
# unique across tables, so a single flat set is sufficient. NOTE: `taxable` is
# deliberately NOT here — that one is user-editable.
#
# `share_token` is here for a different reason: it is the PUBLIC, unauthenticated
# client-view credential. Letting a member set or rotate it via the normal write
# path is a mass-assignment hole (SECURITY_REVIEW.md H3) — it could be pinned to
# a guessable value or silently changed. It is minted server-side on create
# (see `create` below) and never written from client input thereafter.
_READONLY_COLS = {
    "qb_invoice_id", "qb_sync_token", "qb_sync_status", "qb_synced_at",
    "qb_last_error", "qb_tax_total", "qb_total_amt", "qb_synced_signature",
    "qb_tax_signature", "qb_customer_id", "qb_vendor_id", "qb_item_id",
    # Last-confirmed income account of the backing QB item (same column name +
    # semantics on services AND products) — written only by the sync engine's
    # re-point path. Its sibling `qb_income_account_id` is deliberately NOT
    # here: that's the user-set override, editable like `taxable`.
    "qb_income_account_synced",
    # Auto-receipt state — written only by the receipt poller + the manual
    # receipt send path; the client must never set these via a CRUD PUT.
    "qb_balance", "receipt_email_status", "receipt_email_sent_at",
    "share_token",
}


# QuickBooks computes sales tax against a SPECIFIC set of lines, a specific
# discount and a specific customer. Change any of those and the stored figure
# becomes a claim about a document that no longer exists — yet it is handed
# verbatim to the PDF generator and the public share link, neither of which can
# tell a fresh number from a stale one. (The builders can: they compare a
# client-side signature. The customer-facing surfaces have no such check.)
_TAX_INPUT_COLS = ("sections", "global_discount", "client_type",
                   "company_id", "client_contact_id")


def _merge_activity(stored: list | None, incoming: list | None) -> list:
    """Union stored and incoming activity entries, keyed by entry id.

    The frontend PUTs its whole in-memory row, and its `activity` array is a
    snapshot taken before any SERVER-side stamp landed — `email_sent`
    (routes/email.py), `qbo_synced` (qbo_sync.py), `qbo_estimate_tax`. Writing
    that array back verbatim erased them, so a document's own history never
    recorded that it had been emailed, and view_tracking._recent_email_sent lost
    the signal it uses to tell an email scanner's prefetch from a real client
    open (logging phantom "client viewed" entries).

    Nothing in the app deletes an activity entry, so a union can never resurrect
    an intentional removal. Recovered entries append at the end — they are the
    most recent events at the time of the write, and the feed renders the array
    in order (modules/invoices.js: `activity.slice().reverse()`).
    """
    incoming_list = [e for e in (incoming or []) if isinstance(e, dict)]
    stored_list = [e for e in (stored or []) if isinstance(e, dict)]
    seen = {e.get("id") for e in incoming_list if e.get("id")}
    recovered = [e for e in stored_list if e.get("id") and e.get("id") not in seen]
    return incoming_list + recovered if recovered else incoming_list


def _tax_inputs_fingerprint(row) -> str:
    """Stable serialization of everything a stored sales tax depends on."""
    return json.dumps([getattr(row, c, None) for c in _TAX_INPUT_COLS],
                      sort_keys=True, default=str)


def _row_rev(d: dict) -> str:
    """Content revision for a serialized row — the If-Match token.

    A CONTENT hash rather than a timestamp or a version column, for three
    reasons. It needs no migration across thirteen tables. It cannot be defeated
    by clock resolution (SQLite's CURRENT_TIMESTAMP only ticks once a second, so
    two writes to one row inside the same second share an updated_at). And it
    means exactly what the guard wants it to mean: "the row is still what I last
    saw", which also makes a genuinely idempotent rewrite a non-conflict.

    Truncated to 16 hex chars — 64 bits, which is far past collision relevance
    for a guard whose failure mode is one skipped conflict warning."""
    payload = json.dumps(d, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def _row_to_dict(row):
    """Convert SQLAlchemy row to camelCase dict for frontend compatibility.
    Only top-level column names are converted — JSON column contents are
    passed through as-is so nested camelCase (e.g. rates.threeDay) is preserved.

    Every row carries `_rev`, the optimistic-concurrency token. The client
    stores it per row and echoes it back as `If-Match` on the next PUT; see
    _require_fresh() for what happens when it no longer matches. It is computed
    over the row WITHOUT `_rev` (self-reference would be circular) and dropped
    on the way back in by _dict_to_row, since `_rev` maps to no column."""
    d = {}
    for col in row.__table__.columns:
        if col.name in _HIDDEN_COLS:
            continue
        val = getattr(row, col.name)
        d[_snake_to_camel(col.name)] = val
    d["_rev"] = _row_rev(d)
    return d


def _paid_day_override(request: Request) -> bool:
    """Did the caller explicitly confirm editing a day already paid in QuickBooks?

    A header rather than a body field: the body is the row, and anything in it
    would be persisted. Same reasoning as If-Match.

    Any signed-in user may override — the Schedule Builder is member-accessible
    and its existing warn+confirm has always been open to members, so requiring
    admin here would silently change who can edit a schedule. The override is
    logged server-side either way.
    """
    raw = (request.headers.get("x-ltp-paid-day-override") or "").strip().lower()
    return raw in ("1", "true", "yes")


def _require_fresh(request: Request, row, path: str, item_id) -> None:
    """Reject a PUT whose If-Match no longer matches the stored row.

    This is the guard that stops a window which loaded before a crew member
    accepted from PUTting its stale project row back and silently reverting the
    acceptance. backend/crew_integrity.py::enforce_status_floor patches that one
    symptom for one column family; this closes the general case for every table.

    The header is OPTIONAL. Callers that do not send it keep the previous
    last-write-wins behaviour, which keeps the two hand-rolled PUT call sites
    (modules/settings.js, modules/invoices.js) working untouched and lets the
    guard roll out without a flag day.

    On conflict the CURRENT server row rides along in the 409 body, so the
    client can adopt it without a second round trip."""
    want = (request.headers.get("if-match") or "").strip()
    if not want:
        return
    current = _row_to_dict(row)
    if want.strip('"') == current["_rev"]:
        return
    raise HTTPException(
        status_code=409,
        detail=jsonable_encoder({
            "code": "stale_write",
            "field": "_rev",
            # Don't try to singularize `path` — rstrip('s') turns "companies"
            # into "companie". The client renders its own message anyway.
            "message": f"This {path} row changed in another window since you loaded it.",
            "rev": current["_rev"],
            "row": current,
        }),
    )


def _dict_to_row(data, model_cls):
    """Convert camelCase dict from frontend to snake_case kwargs for the model."""
    mapped = {}
    valid_cols = {c.name for c in model_cls.__table__.columns}
    for key, val in data.items():
        snake = _camel_to_snake(key)
        if snake in valid_cols and snake not in _HIDDEN_COLS and snake not in _READONLY_COLS:
            mapped[snake] = val
    return mapped


async def _validate_fks(mapped: dict, model_cls, db: AsyncSession) -> None:
    """Reject writes whose foreign-key columns point at non-existent rows.
    SQLite doesn't enforce FKs (silent corruption) and Postgres surfaces an
    ugly 500 IntegrityError — validate here for a clean 400 either way
    (SECURITY_REVIEW.md M5). Only non-null FK values are checked; nullable FKs
    left unset are fine."""
    for col in model_cls.__table__.columns:
        if not col.foreign_keys:
            continue
        val = mapped.get(col.name)
        if val is None:
            continue
        target_col = next(iter(col.foreign_keys)).column  # e.g. companies.id
        found = await db.execute(select(target_col).where(target_col == val).limit(1))
        if found.scalar_one_or_none() is None:
            raise HTTPException(
                status_code=400,
                detail={"field": _snake_to_camel(col.name),
                        "reason": f"references a {target_col.table.name} row that does not exist"},
            )


def _stamp_activity(data: dict, user: models.User) -> dict:
    """Overwrite client-supplied attribution fields with the authenticated
    user's identity. Prevents a (compromised or malicious) frontend from
    forging "who did what" records.

    Walks three keys, all of which are dated event lists with an attribution
    field that the client formerly trusted but the server now enforces:
      - `activity`           Quote.activity, Invoice.activity (and any future
                             entity with the same shape). Entries:
                             {id, date, time, type, message, user, userId, changes}
                             We stamp user + userId.
      - `scheduleActivity`   Project.scheduleActivity. Same shape, same stamping.
      - `notes`              Project.notes (list of {id, date, author, text,
                             linkedMeetingId}). We stamp author + authorId.
                             Skipped harmlessly when the entity's `notes` is
                             a plain string (Quote.notes, Invoice.notes,
                             Equipment.notes, etc. — those are Text columns).

    Always stamps (doesn't try to detect legacy entries) — the net effect is
    that the most recent save attributes its OWN actor, which is correct.
    Returns the dict for chaining."""
    for key in ("activity", "scheduleActivity"):
        entries = data.get(key)
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if isinstance(entry, dict):
                entry["userId"] = user.id
                entry["user"] = user.name
    notes = data.get("notes")
    if isinstance(notes, list):
        for entry in notes:
            # Only stamp entries that look like attribution-bearing notes
            # (have an `author` key). Defensive: prevents accidentally adding
            # author fields to some other entity's "notes" array if one is
            # introduced later with a different shape.
            if isinstance(entry, dict) and "author" in entry:
                entry["author"] = user.name
                entry["authorId"] = user.id   # future-proof; frontend ignores extras
    return data


# ── CRUD factory ──────────────────────────────────────────────────────────

def _crud_routes(router, path, model_cls, has_activity: bool):
    """Generate GET all, GET by id, POST, PUT, DELETE for a model.

    `has_activity` tells the factory whether to apply _stamp_activity to
    incoming payloads. Set True for Quote, Invoice, Project (which has
    scheduleActivity); False for everything else."""

    async def get_all(db: AsyncSession = Depends(get_db)):
        result = await db.execute(select(model_cls).order_by(model_cls.id))
        return [_row_to_dict(r) for r in result.scalars().all()]

    async def get_one(item_id: int, db: AsyncSession = Depends(get_db)):
        result = await db.execute(select(model_cls).where(model_cls.id == item_id))
        row = result.scalar_one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail=f"{path} {item_id} not found")
        return _row_to_dict(row)

    async def create(
        data: dict,
        db: AsyncSession = Depends(get_db),
        user: models.User = Depends(require_session),
    ):
        # 1. Validate client-supplied id (always first; cheap; fails before
        # any DB work or activity stamping).
        client_id = data.get("id")
        if client_id is not None:
            if isinstance(client_id, bool) or not isinstance(client_id, int) or client_id < 1:
                raise HTTPException(
                    status_code=400,
                    detail={"field": "id", "reason": "must be a positive integer"},
                )
            # 2. Reject duplicate id with 409 — the frontend's recovery is to
            # fall back to PUT (treat as an update). Without this check we'd
            # surface a generic IntegrityError as a 500.
            existing = await db.execute(
                select(model_cls.id).where(model_cls.id == client_id)
            )
            if existing.scalar_one_or_none() is not None:
                raise HTTPException(
                    status_code=409,
                    detail=f"{path} {client_id} already exists",
                )
        # 3. Field-level validation BEFORE _stamp_activity so we don't mutate
        # the payload if we're about to reject it.
        validate(model_cls, data)
        if has_activity:
            data = _stamp_activity(data, user)
        mapped = _dict_to_row(data, model_cls)
        await _validate_fks(mapped, model_cls, db)
        # Payroll integrity: a non-admin can't introduce a frozen pay snapshot on a
        # brand-new project either — strip any `work`/`adj` off incoming positions
        # (stored side is empty on create). See the update path for the rationale.
        if model_cls is models.Project and user.role != "admin" and isinstance(mapped.get("schedule"), list):
            stripped = crew_integrity.enforce_pay_snapshot([], mapped["schedule"])
            if stripped:
                print(f"[LTP] payout-integrity: project create by non-admin user "
                      f"id={user.id} ({user.email}) carried {stripped} pay-snapshot "
                      f"value(s) — stripped", flush=True)
        row = model_cls(**mapped)
        # share_token is the PUBLIC client-view credential and is server-
        # authoritative: any client-supplied value was already stripped by
        # _dict_to_row (it's in _READONLY_COLS), so mint a strong one here for
        # token-bearing entities (Quote, Invoice). SECURITY_REVIEW.md H3.
        if hasattr(row, "share_token") and not getattr(row, "share_token"):
            row.share_token = secrets.token_urlsafe(32)
        db.add(row)
        await db.flush()
        await db.refresh(row)
        livesync.mark_dirty(db, path)
        return _row_to_dict(row)

    async def update(
        item_id: int,
        data: dict,
        request: Request,
        db: AsyncSession = Depends(get_db),
        user: models.User = Depends(require_session),
    ):
        # If the body supplies an id, it must match the URL id. Prevents
        # subtle bugs where the frontend updates state for one row but PUTs
        # to another — the server would silently apply the body's fields to
        # the URL's row.
        body_id = data.get("id")
        if body_id is not None and body_id != item_id:
            raise HTTPException(
                status_code=400,
                detail={"field": "id", "reason": "body id must match URL id"},
            )
        validate(model_cls, data)
        if has_activity:
            data = _stamp_activity(data, user)
        result = await db.execute(select(model_cls).where(model_cls.id == item_id))
        row = result.scalar_one_or_none()
        if not row:
            # Proper REST: PUT to nonexistent id is 404. New rows go through
            # POST. The frontend's syncEntity routes accordingly.
            raise HTTPException(status_code=404, detail=f"{path} {item_id} not found")
        # Optimistic concurrency — BEFORE any mutation, so a rejected write
        # leaves the row untouched.
        _require_fresh(request, row, path, item_id)
        mapped = _dict_to_row(data, model_cls)
        await _validate_fks(mapped, model_cls, db)
        # Stale-write guard (Project only): the frontend PUTs its whole
        # in-memory row and never refetches projects after page load, so a
        # copy captured before a crew-request send/answer would silently
        # revert those positions' statuses (requested/accepted → open) while
        # the crew member stays assigned. Restore any same-crew status
        # regression from the stored row before applying the write; deliberate
        # downgrades always clear/change the assignee and pass through
        # (backend/crew_integrity.py::enforce_status_floor).
        if model_cls is models.Project and isinstance(mapped.get("schedule"), list):
            floored = crew_integrity.enforce_status_floor(row.schedule, mapped["schedule"])
            if floored:
                print(f"[LTP] crew-integrity: project {item_id} save carried "
                      f"{floored} stale position-status downgrade(s) — restored", flush=True)
            # Payroll integrity: the payout export bills `work.pay` verbatim, so a
            # non-admin must not create or alter a day's frozen pay snapshot/adjust-
            # ments (they'd be billed on an admin's later push). Restore them from
            # the stored row before applying the write (backend/crew_integrity.py
            # ::enforce_pay_snapshot). Admins pass through untouched.
            if user.role != "admin":
                reverted = crew_integrity.enforce_pay_snapshot(row.schedule, mapped["schedule"])
                if reverted:
                    print(f"[LTP] payout-integrity: project {item_id} save by non-admin "
                          f"user id={user.id} ({user.email}) carried {reverted} pay-snapshot "
                          f"change(s) — reverted", flush=True)
        # Paid-day integrity. Runs LAST among the schedule guards, on the FINAL
        # incoming schedule, so a change the floor/pay-snapshot guards already
        # reverted is not reported as a conflict that no longer exists.
        #
        # Once a day is billed AND that bill is paid, the money is gone; editing
        # the schedule underneath it only makes the app disagree with the
        # accounts. The Schedule Builder warns first, but it warns from a
        # `paidDays` map fetched when the editor opened — stale the moment a bill
        # is paid, or a second window saves. That check is a courtesy; this is
        # the enforcement, and it is what makes the client's staleness harmless.
        if model_cls is models.Project and isinstance(mapped.get("schedule"), list):
            paid_hits = await payouts.paid_day_conflicts(db, item_id, row.schedule, mapped["schedule"])
            if paid_hits:
                if not _paid_day_override(request):
                    raise HTTPException(
                        status_code=409,
                        detail=jsonable_encoder({
                            "code": "paid_day_conflict",
                            "message": (
                                f"This save changes {len(paid_hits)} day"
                                f"{'' if len(paid_hits) == 1 else 's'} already paid in QuickBooks."
                            ),
                            "days": paid_hits,
                        }),
                    )
                # Overridden deliberately. The client also POSTs
                # /api/qbo/payouts/notify-edit, which stamps the bill and pushes
                # admins — but that is best-effort and client-driven, so leave a
                # server-side trace that cannot be skipped.
                print(f"[LTP] payout-integrity: user id={user.id} ({user.email}) overrode "
                      f"{len(paid_hits)} paid-day change(s) on project {item_id}: "
                      + ", ".join(f"{h['name']}@{h['date']}" for h in paid_hits), flush=True)

        # Keep server-stamped history the client's snapshot doesn't know about.
        if has_activity and "activity" in mapped:
            mapped["activity"] = _merge_activity(row.activity, mapped["activity"])
        tracks_tax = model_cls in (models.Quote, models.Invoice)
        tax_inputs_before = _tax_inputs_fingerprint(row) if tracks_tax else None
        for key, val in mapped.items():
            if key != "id":
                setattr(row, key, val)
        # Re-pricing a line, changing the discount or switching the client
        # invalidates any tax QuickBooks previously computed. Drop it rather than
        # let the PDF and the share link keep quoting a confidently wrong number;
        # they render no tax row until it is recalculated, and the send flow
        # recalculates before anything reaches the customer.
        if tracks_tax and _tax_inputs_fingerprint(row) != tax_inputs_before:
            row.qb_tax_total = None
            if hasattr(row, "qb_tax_signature"):
                row.qb_tax_signature = None
        await db.flush()
        # Crew-request integrity (Project only): a schedule edit may have removed
        # positions/days that crew requests still reference. Trim each affected
        # request to its surviving shifts; auto-withdraw any left with none, so a
        # removal is traced the moment it's saved instead of leaving a stale hire.
        if model_cls is models.Project:
            await crew_integrity.reconcile_project(db, row)
            # reconcile_project can trim or auto-withdraw crew requests, so the
            # crew-requests collection moved too even though this was a project
            # write. Same on the delete path below.
            livesync.mark_dirty(db, "crew-requests")
        await db.refresh(row)
        livesync.mark_dirty(db, path)
        return _row_to_dict(row)

    async def remove(item_id: int, db: AsyncSession = Depends(get_db),
                     user: models.User = Depends(require_session)):
        result = await db.execute(select(model_cls).where(model_cls.id == item_id))
        row = result.scalar_one_or_none()
        if not row:
            return {"ok": True, "id": item_id}  # idempotent delete
        # Auto-withdraw this project's active crew requests BEFORE the delete nulls
        # their project_id FK — otherwise they'd be orphaned with no link back to
        # trace. (Project only; a no-op for every other entity.)
        if model_cls is models.Project:
            await crew_integrity.reconcile_project(db, row, deleted=True)
            livesync.mark_dirty(db, "crew-requests")
        await db.delete(row)
        # Audit destructive ops (SECURITY_REVIEW.md L3). Deletes stay member-
        # level by design (trusted staff delete their own drafts) but are now
        # attributable in the server log: who deleted what, when.
        print(f"[LTP] audit: user id={user.id} ({user.email}) deleted "
              f"{path} id={item_id}", flush=True)
        livesync.mark_dirty(db, path)
        return {"ok": True, "id": item_id}

    router.add_api_route(f"/{path}",             get_all, methods=["GET"])
    router.add_api_route(f"/{path}/{{item_id}}", get_one, methods=["GET"])
    router.add_api_route(f"/{path}",             create,  methods=["POST"])
    router.add_api_route(f"/{path}/{{item_id}}", update,  methods=["PUT"])
    router.add_api_route(f"/{path}/{{item_id}}", remove,  methods=["DELETE"])


# ── Router (session-gated) ────────────────────────────────────────────────
# Router-level dependency: every /api/* route requires a valid session.
# Specific routes (PUT /api/settings) layer on require_admin below.
router = APIRouter(prefix="/api", dependencies=[Depends(require_session)])


# Register routes. Entities with activity columns (Quote, Invoice) AND
# Project (scheduleActivity) get backend-enforced attribution stamping.
_crud_routes(router, "companies",   models.Company,   has_activity=False)
_crud_routes(router, "contacts",    models.Contact,   has_activity=False)
_crud_routes(router, "projects",    models.Project,   has_activity=True)   # scheduleActivity
_crud_routes(router, "quotes",      models.Quote,     has_activity=True)
_crud_routes(router, "invoices",    models.Invoice,   has_activity=True)
_crud_routes(router, "equipment",   models.Equipment, has_activity=False)
_crud_routes(router, "products",    models.Product,   has_activity=False)
_crud_routes(router, "services",    models.Service,   has_activity=False)
_crud_routes(router, "fees",        models.Fee,       has_activity=False)
# Per-client service rate overrides (negotiated contract rates + day minimums).
# Path is hyphenated to match the frontend state key (components/data-state.js
# derives the URL from the key verbatim).
_crud_routes(router, "client-rates", models.ClientRate, has_activity=False)
_crud_routes(router, "allocations", models.Allocation, has_activity=False)
_crud_routes(router, "containers",  models.Container, has_activity=False)
_crud_routes(router, "kits",        models.Kit,       has_activity=False)


# ── Settings (singleton JSON blob; admin-only write) ──────────────────────

@router.get("/settings")
async def get_settings(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(models.Settings).where(models.Settings.id == 1))
    row = result.scalar_one_or_none()
    if not row:
        return {}
    return row.data


@router.put("/settings", dependencies=[Depends(require_admin)])
async def update_settings(data: dict, db: AsyncSession = Depends(get_db)):
    """Shallow-merge update. Incoming top-level keys overwrite; existing keys
    not present in the payload are preserved. Admin-only — non-admins get 403.
    To delete a key, send it explicitly as null.

    Sanitizes `emailSignatureTemplate` server-side if present. Defense in
    depth: the frontend editor already renders a sanitized preview, and the
    send pipeline sanitizes at send time, but storing pre-sanitized HTML
    means a future surface that reads the template without sanitizing can't
    accidentally render an XSS payload. Idempotent — re-sanitizing a clean
    string is a no-op. (The {{header}} action box is not stored here — it's
    generated per email type by theme.js::LTP_renderHeader.)"""
    # Sanitize the email signature template BEFORE merging into storage.
    # Admin authoring gets the original-vs-sanitized diff in their preview.
    if "emailSignatureTemplate" in data and data["emailSignatureTemplate"]:
        data["emailSignatureTemplate"] = email_html(data["emailSignatureTemplate"])
    # Validate emailReplyTo at write time. An invalid value would otherwise sit
    # in settings and blow up every send with an uncaught ValueError, orphaning
    # recipient rows (SECURITY_REVIEW.md M6). Must be a single address (or empty
    # to clear it).
    if data.get("emailReplyTo"):
        try:
            reply_addrs = parse_recipients(data["emailReplyTo"], allow_empty=True)
        except RecipientError as e:
            raise HTTPException(status_code=400, detail={"field": "emailReplyTo", "reason": str(e)})
        if len(reply_addrs) > 1:
            raise HTTPException(
                status_code=400,
                detail={"field": "emailReplyTo", "reason": "must be a single email address"},
            )
    result = await db.execute(select(models.Settings).where(models.Settings.id == 1))
    row = result.scalar_one_or_none()
    if not row:
        row = models.Settings(id=1, data=data)
        db.add(row)
    else:
        merged = dict(row.data or {})
        merged.update(data)
        row.data = merged
    await db.flush()
    livesync.mark_dirty(db, "settings")
    return row.data


# ── Live sync: what changed, and a push channel that says so ──────────────
#
# See backend/livesync.py for the design. Both routes deal only in per-collection
# STAMPS — never row data — so their cost is flat no matter how large the
# workspace grows.

@router.get("/versions")
async def get_versions(db: AsyncSession = Depends(get_db)):
    """Current stamp for every synced collection.

    The polling half of live sync, and the reconciliation point after a tab
    wakes from background. A client compares this against its own stamps and
    refetches only what moved.

    Clients MUST read this BEFORE fetching the collections it names. Reading it
    after would let a write that lands between the two be lost forever: the
    client would hold pre-write rows alongside the post-write stamp and never
    refetch. Fetching in the other order costs at worst one redundant refetch."""
    return {"stamps": await livesync.ensure_seeded(db), "at": livesync.now_ms()}


# NOT mounted on `router`: that router carries a Depends(require_session) whose
# database session FastAPI holds open until the response finishes — which for a
# stream is "until the tab closes". See auth_deps.load_session_user.
stream_router = APIRouter(prefix="/api", tags=["livesync"])


@stream_router.get("/stream")
async def stream_changes(request: Request):
    """Server-sent stamp feed: an immediate snapshot, then a frame per change.

    SSE rather than WebSocket because nothing needs to travel client→server here
    (writes already go over REST), EventSource reconnects on its own, and the
    connection is an ordinary GET that passes through the existing cookie auth
    and middleware stack unchanged.

    Idle cost is one `: keepalive` comment every livesync.KEEPALIVE_SECONDS.
    Starlette's GZipMiddleware excludes text/event-stream from compression by
    default (DEFAULT_EXCLUDED_CONTENT_TYPES), so frames are not buffered."""
    # Short-lived session: authenticate, seed the stamp map, release the pooled
    # connection — all BEFORE the long-lived response body begins.
    async with async_session() as db:
        user = await load_session_user(db, request)
        if user is None:
            raise HTTPException(
                status_code=401, detail="Not signed in",
                headers={"WWW-Authenticate": "Cookie"},
            )
        initial = await livesync.ensure_seeded(db)
        await db.commit()          # persist the throttled last_used_at touch

    return StreamingResponse(
        livesync.event_stream(initial),
        media_type="text/event-stream",
        headers={
            # no-transform additionally tells intermediaries not to buffer or
            # re-encode; X-Accel-Buffering is the nginx-specific form of the
            # same instruction.
            "Cache-Control": "no-cache, no-store, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ── Users (admin-only management of team-member title/phone) ──────────────
#
# The User row is created automatically on first sign-in via Google OAuth;
# identity (name/email/picture) is sourced from Google and refreshed on every
# login. The only fields the admin edits in-app are:
#   - title  (job title — feeds {{userTitle}} in the email signature template)
#   - phone  (direct line — feeds {{userPhone}})
#   - role   (member ↔ admin promotion)
# Everything else (gmail_*, google_sub, last_login, created_at) is internal
# state we deliberately do NOT expose for editing.

_USER_EDITABLE_FIELDS = {"title", "phone", "role"}
_VALID_ROLES = {"member", "admin"}


def _user_dict(u: models.User) -> dict:
    """Public-safe User dict for the admin user-list. Drops the OAuth token
    columns (refresh_token / access_token) so a 'list users' response never
    leaks credentials over the wire even to other admins. gmailConnected is
    a derived boolean — the underlying ciphertext stays server-side."""
    if u is None:
        return {}
    granted_scopes = (u.gmail_granted_scopes or "").split()
    return {
        "id": u.id,
        "email": u.email,
        "name": u.name,
        # App-cached avatar when available (stable, self-hosted, absolute), else
        # the Google URL until the first cache lands on that user's next sign-in.
        "pictureUrl": _picture_url(u),
        # Whether a re-pull has already been queued (so the UI can show
        # "queued" instead of letting an admin click twice).
        "photoRefreshRequested": bool(u.photo_refresh_requested),
        "role": u.role,
        "title": u.title or "",
        "phone": u.phone or "",
        "gmailConnected": bool(u.gmail_refresh_token),
        "gmailScope": "send" if "https://www.googleapis.com/auth/gmail.send" in granted_scopes else "none",
        "lastLogin": u.last_login.isoformat() if u.last_login else None,
    }


@router.get("/users", dependencies=[Depends(require_admin)])
async def list_users(db: AsyncSession = Depends(get_db)):
    """Admin-only. Returns every user in the workspace. Used by the Settings
    page's Team Members section to drive the title/phone editor + role
    management UI."""
    result = await db.execute(select(models.User).order_by(models.User.id))
    return [_user_dict(u) for u in result.scalars().all()]


@router.put("/users/{user_id}", dependencies=[Depends(require_admin)])
async def update_user(
    user_id: int,
    data: dict,
    db: AsyncSession = Depends(get_db),
    actor: models.User = Depends(require_admin),
):
    """Admin-only patch. Updates ONLY the fields in _USER_EDITABLE_FIELDS;
    silently ignores anything else (so a frontend that accidentally PUTs
    the whole user dict doesn't try to overwrite email/name/picture/etc.).

    Two safety rails on top of the whitelist:
      - `role` must be one of {member, admin}.
      - The acting admin cannot demote THEMSELVES from admin → member; doing
        so would lock the workspace out if they're the only admin. Demoting
        OTHER admins is fine."""
    result = await db.execute(select(models.User).where(models.User.id == user_id))
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail=f"user {user_id} not found")

    # Track whether anything actually changed so we can skip the flush/refresh
    # roundtrip when the client sends an empty body or only non-editable keys.
    changed = False
    for key, val in data.items():
        if key not in _USER_EDITABLE_FIELDS:
            continue
        if key == "role":
            if val not in _VALID_ROLES:
                raise HTTPException(
                    status_code=400,
                    detail={"field": "role", "reason": f"must be one of {sorted(_VALID_ROLES)}"},
                )
            if target.id == actor.id and val != "admin":
                raise HTTPException(
                    status_code=400,
                    detail={"field": "role", "reason": "cannot demote yourself; ask another admin"},
                )
            target.role = val
            changed = True
        elif key == "title":
            target.title = (val or "").strip() or None
            changed = True
        elif key == "phone":
            target.phone = (val or "").strip() or None
            changed = True

    if changed:
        await db.flush()
        await db.refresh(target)
    return _user_dict(target)


@router.post("/users/{user_id}/refresh-photo", dependencies=[Depends(require_admin)])
async def refresh_user_photo(user_id: int, db: AsyncSession = Depends(get_db)):
    """Admin-only. Re-pull a user's Google profile photo.

    Two-tier: first try an IMMEDIATE server-side download from the stored Google
    `picture` URL. That often succeeds even when the same URL fails in a browser
    or email client — Google throttles hotlinked/no-referrer avatar loads far
    more than a plain server fetch — so the admin usually gets an instant fix
    (and can fix OTHER users' photos without them re-logging in). If the stored
    URL is itself stale/rotted (the common cause of a broken avatar), the fetch
    fails and we fall back to flagging a re-pull on that user's NEXT sign-in,
    where a fresh OAuth login hands us a working URL.

    Returns the updated user dict plus `photoCachedNow` (True if the immediate
    fetch succeeded)."""
    result = await db.execute(select(models.User).where(models.User.id == user_id))
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail=f"user {user_id} not found")

    now = datetime.now(timezone.utc)
    cached_now = False
    if (target.picture_url or "").strip():
        cached_now = await _fetch_and_cache_photo(target, target.picture_url, now)
    if not cached_now:
        # Couldn't fetch right now — queue it for the next sign-in (a fresh
        # login refreshes picture_url to a working URL, then downloads it).
        target.photo_refresh_requested = True

    await db.flush()
    await db.refresh(target)
    out = _user_dict(target)
    out["photoCachedNow"] = cached_now
    return out


# ── Public avatar serving (no session) ────────────────────────────────────
# Separate router WITHOUT the session dependency: the same URL is embedded in
# outbound email signatures, so external recipients' mail clients must be able
# to load it. Mounted in main.py alongside the other public token routes.
public_router = APIRouter(prefix="/api", tags=["users-public"])


@public_router.get("/users/photo/{photo_token}")
async def get_user_photo(photo_token: str, db: AsyncSession = Depends(get_db)):
    """Serve a user's app-cached avatar bytes by opaque token. Public by design
    (see the router comment). The token is unguessable and the payload is a
    non-sensitive profile picture. 404 when the token is unknown or nothing is
    cached yet. photo_data is deferred on the model, so we undefer it here — the
    ONLY place the blob is loaded."""
    result = await db.execute(
        select(models.User)
        .options(undefer(models.User.photo_data))
        .where(models.User.photo_token == photo_token)
    )
    user = result.scalar_one_or_none()
    if user is None or not user.photo_data:
        raise HTTPException(status_code=404, detail="photo not found")
    return Response(
        content=user.photo_data,
        media_type=user.photo_content_type or "image/jpeg",
        # The URL carries a ?v=<photo_updated_at> cache-buster, so a re-pull
        # changes the URL — safe to cache the bytes hard.
        headers={"Cache-Control": "public, max-age=86400, immutable"},
    )


# ── Bulk sync (one-shot localStorage → server migration) ─────────────────

@router.post("/sync", dependencies=[Depends(require_admin)])
async def bulk_sync(payload: dict, db: AsyncSession = Depends(get_db)):
    """Wipe + repopulate all entities from a full localStorage dump.
    Used once per client to seed the server from their browser state.
    Admin-only because it's destructive."""
    model_map = {
        "companies":   models.Company,
        "contacts":    models.Contact,
        "projects":    models.Project,
        "quotes":      models.Quote,
        "invoices":    models.Invoice,
        "equipment":   models.Equipment,
        "products":    models.Product,
        "services":    models.Service,
        "fees":        models.Fee,
        "allocations": models.Allocation,
        "containers":  models.Container,
        "kits":        models.Kit,
    }
    counts = {}
    for key, model_cls in model_map.items():
        items = payload.get(key)
        if items is None:
            continue
        await db.execute(delete(model_cls))
        for item in items:
            # Run the same field validation as the per-entity create path so a
            # bulk import can't seed forged enum/date/length values
            # (SECURITY_REVIEW.md H5). Activity attribution is intentionally NOT
            # re-stamped here — this is a one-time migration of the admin's own
            # data and rewriting every historical actor to the importer would
            # lose the original attribution.
            validate(model_cls, item)
            mapped = _dict_to_row(item, model_cls)
            row = model_cls(**mapped)
            # share_token is server-authoritative (stripped by _dict_to_row).
            # Mint one for token-bearing rows so the NOT NULL invariant holds; a
            # full re-import regenerates share links, which is acceptable for
            # this one-time wipe-and-reseed migration. SECURITY_REVIEW.md H3.
            if hasattr(row, "share_token") and not getattr(row, "share_token"):
                row.share_token = secrets.token_urlsafe(32)
            db.add(row)
        counts[key] = len(items)

    if "settings" in payload:
        result = await db.execute(select(models.Settings).where(models.Settings.id == 1))
        row = result.scalar_one_or_none()
        if not row:
            db.add(models.Settings(id=1, data=payload["settings"]))
        else:
            row.data = payload["settings"]
        counts["settings"] = 1

    return {"synced": counts}
