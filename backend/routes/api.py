from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from backend.database import get_db
from backend import models
from backend.auth_deps import require_session, require_admin
from backend.sanitize import email_html
from backend.validators import validate


# ── Generic helpers ───────────────────────────────────────────────────────

def _snake_to_camel(s):
    parts = s.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def _camel_to_snake(s):
    import re
    return re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", s).lower()


# Auto-managed columns the client should never send/receive.
_HIDDEN_COLS = {"created_at", "updated_at"}


def _row_to_dict(row):
    """Convert SQLAlchemy row to camelCase dict for frontend compatibility.
    Only top-level column names are converted — JSON column contents are
    passed through as-is so nested camelCase (e.g. rates.threeDay) is preserved."""
    d = {}
    for col in row.__table__.columns:
        if col.name in _HIDDEN_COLS:
            continue
        val = getattr(row, col.name)
        d[_snake_to_camel(col.name)] = val
    return d


def _dict_to_row(data, model_cls):
    """Convert camelCase dict from frontend to snake_case kwargs for the model."""
    mapped = {}
    valid_cols = {c.name for c in model_cls.__table__.columns}
    for key, val in data.items():
        snake = _camel_to_snake(key)
        if snake in valid_cols and snake not in _HIDDEN_COLS:
            mapped[snake] = val
    return mapped


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
        # Mint share_token for entities that have one (Quote, Invoice) if the
        # client didn't supply one. This is the credential the public client
        # view uses — generated lazily on creation so it's available the
        # moment the entity exists, but never overwritten if already set
        # (i.e. on a /sync re-import we preserve the existing token).
        if "share_token" in {c.name for c in model_cls.__table__.columns}:
            if not data.get("shareToken") and not data.get("share_token"):
                import secrets as _secrets
                data["shareToken"] = _secrets.token_urlsafe(32)
        mapped = _dict_to_row(data, model_cls)
        row = model_cls(**mapped)
        db.add(row)
        await db.flush()
        await db.refresh(row)
        return _row_to_dict(row)

    async def update(
        item_id: int,
        data: dict,
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
        mapped = _dict_to_row(data, model_cls)
        for key, val in mapped.items():
            if key != "id":
                setattr(row, key, val)
        await db.flush()
        await db.refresh(row)
        return _row_to_dict(row)

    async def remove(item_id: int, db: AsyncSession = Depends(get_db)):
        result = await db.execute(select(model_cls).where(model_cls.id == item_id))
        row = result.scalar_one_or_none()
        if not row:
            return {"ok": True, "id": item_id}  # idempotent delete
        await db.delete(row)
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
    string is a no-op."""
    # Sanitize the email signature template BEFORE merging into storage. The
    # admin authoring it gets the original-vs-sanitized diff visible in their
    # preview pane (commit 4 wires that on the frontend).
    if "emailSignatureTemplate" in data and data["emailSignatureTemplate"]:
        data["emailSignatureTemplate"] = email_html(data["emailSignatureTemplate"])
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
    return row.data


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
        "pictureUrl": u.picture_url,
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
            mapped = _dict_to_row(item, model_cls)
            db.add(model_cls(**mapped))
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
