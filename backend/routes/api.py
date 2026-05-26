import os
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from backend.database import get_db
from backend import models


async def require_api_key(authorization: Optional[str] = Header(None)):
    """Stopgap shared-secret auth. Compares Authorization: Bearer <key>
    against the LTP_API_KEY env var. If no env var is set, auth is disabled
    (intended for local dev) — a startup-time warning would go in main.py.
    Replace with proper session/OAuth once Google login lands."""
    expected = os.environ.get("LTP_API_KEY", "")
    if not expected:
        return  # auth disabled
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing API key")
    token = authorization[len("Bearer "):].strip()
    # Constant-time compare to avoid leaking length/contents via timing
    import hmac
    if not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=403, detail="Invalid API key")


# Router-level dependency: applies to every /api/* route, including ones
# registered later via add_api_route() in the CRUD factory below.
router = APIRouter(prefix="/api", dependencies=[Depends(require_api_key)])


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


# ── CRUD factory ──────────────────────────────────────────────────────────

def _crud_routes(path, model_cls):
    """Generate GET all, GET by id, POST, PUT, DELETE for a model."""

    async def get_all(db: AsyncSession = Depends(get_db)):
        result = await db.execute(select(model_cls).order_by(model_cls.id))
        return [_row_to_dict(r) for r in result.scalars().all()]

    async def get_one(item_id: int, db: AsyncSession = Depends(get_db)):
        result = await db.execute(select(model_cls).where(model_cls.id == item_id))
        row = result.scalar_one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail=f"{path} {item_id} not found")
        return _row_to_dict(row)

    async def create(data: dict, db: AsyncSession = Depends(get_db)):
        mapped = _dict_to_row(data, model_cls)
        row = model_cls(**mapped)
        db.add(row)
        await db.flush()
        await db.refresh(row)
        return _row_to_dict(row)

    async def update(item_id: int, data: dict, db: AsyncSession = Depends(get_db)):
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

    router.add_api_route(f"/{path}",                  get_all, methods=["GET"])
    router.add_api_route(f"/{path}/{{item_id}}",      get_one, methods=["GET"])
    router.add_api_route(f"/{path}",                  create,  methods=["POST"])
    router.add_api_route(f"/{path}/{{item_id}}",      update,  methods=["PUT"])
    router.add_api_route(f"/{path}/{{item_id}}",      remove,  methods=["DELETE"])


# Register routes for every entity
_crud_routes("companies",   models.Company)
_crud_routes("contacts",    models.Contact)
_crud_routes("projects",    models.Project)
_crud_routes("quotes",      models.Quote)
_crud_routes("invoices",    models.Invoice)
_crud_routes("equipment",   models.Equipment)
_crud_routes("products",    models.Product)
_crud_routes("services",    models.Service)
_crud_routes("allocations", models.Allocation)
_crud_routes("containers",  models.Container)
_crud_routes("kits",        models.Kit)


# ── Settings (singleton JSON blob) ────────────────────────────────────────

@router.get("/settings")
async def get_settings(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(models.Settings).where(models.Settings.id == 1))
    row = result.scalar_one_or_none()
    if not row:
        return {}
    return row.data


@router.put("/settings")
async def update_settings(data: dict, db: AsyncSession = Depends(get_db)):
    """Shallow-merge update. Incoming top-level keys overwrite; existing keys
    not present in the payload are preserved. This protects against a buggy
    frontend update path that sends a partial settings object — without merge,
    such a write would silently wipe tagColors / email templates / etc.
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


# ── Counters (monotonic ID generators) ────────────────────────────────────

@router.get("/counters/{key}")
async def get_counter(key: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(models.Counter).where(models.Counter.key == key))
    row = result.scalar_one_or_none()
    return {"key": key, "value": row.value if row else None}


@router.put("/counters/{key}")
async def update_counter(key: str, payload: dict, db: AsyncSession = Depends(get_db)):
    value = int(payload.get("value", 1))
    result = await db.execute(select(models.Counter).where(models.Counter.key == key))
    row = result.scalar_one_or_none()
    if not row:
        row = models.Counter(key=key, value=value)
        db.add(row)
    else:
        # Counter is monotonic — never go backwards
        row.value = max(row.value, value)
    await db.flush()
    return {"key": key, "value": row.value}


# ── Bulk sync (one-shot localStorage → server migration) ─────────────────

@router.post("/sync")
async def bulk_sync(payload: dict, db: AsyncSession = Depends(get_db)):
    """Wipe + repopulate all entities from a full localStorage dump.
    Used once per client to seed the server from their browser state."""
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

    if "counters" in payload and isinstance(payload["counters"], dict):
        for key, value in payload["counters"].items():
            result = await db.execute(select(models.Counter).where(models.Counter.key == key))
            row = result.scalar_one_or_none()
            v = int(value)
            if not row:
                db.add(models.Counter(key=key, value=v))
            else:
                row.value = max(row.value, v)
        counts["counters"] = len(payload["counters"])

    return {"synced": counts}
