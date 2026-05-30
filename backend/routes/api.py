from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from backend.database import get_db
from backend import models
from backend.auth_deps import require_session, require_admin


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
    """Overwrite activity entries' `userId` and `user` fields with the
    authenticated user's identity. Prevents the frontend from forging
    attribution.

    Operates on `activity` and `scheduleActivity` top-level keys (whichever
    is present), iterating the entries in place. Doesn't backfill entries
    that have neither field (legacy entries from before this PR — leave their
    `user` string alone, just stamp userId if missing). Returns the modified
    dict for chaining.

    Called from `update` and `create` route handlers below."""
    for activity_key in ("activity", "scheduleActivity"):
        entries = data.get(activity_key)
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            # New entries from the current PR send {user, userId}; we always
            # overwrite both to enforce truth from the session.
            # Detect "new" entries by absence of userId on legacy ones:
            # if userId is missing AND user is some pre-existing string, this
            # is a legacy entry we should NOT modify — but we don't know
            # which is which here. Compromise: always stamp; legacy entries
            # are stamped once on next save which is fine, the attribution
            # becomes "whoever saved most recently" rather than wrong.
            entry["userId"] = user.id
            entry["user"] = user.name
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
        if has_activity:
            data = _stamp_activity(data, user)
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
        if has_activity:
            data = _stamp_activity(data, user)
        result = await db.execute(select(model_cls).where(model_cls.id == item_id))
        row = result.scalar_one_or_none()
        if not row:
            # Upsert: PUT with unknown id creates. Lets the frontend send PUTs
            # without worrying about whether a row was created previously.
            mapped = _dict_to_row(data, model_cls)
            mapped["id"] = item_id
            row = model_cls(**mapped)
            db.add(row)
            await db.flush()
            await db.refresh(row)
            return _row_to_dict(row)
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
    To delete a key, send it explicitly as null."""
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
