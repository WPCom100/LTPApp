from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from backend.database import get_db
from backend import models

router = APIRouter(prefix="/api")


# ── Generic helpers ───────────────────────────────────────────────────────

def _snake_to_camel(s):
    parts = s.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def _camel_to_snake(s):
    import re
    return re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", s).lower()


def _row_to_dict(row):
    """Convert SQLAlchemy row to camelCase dict for frontend compatibility."""
    d = {}
    for col in row.__table__.columns:
        val = getattr(row, col.name)
        key = _snake_to_camel(col.name)
        d[key] = val
    # Keep id as "id"
    return d


def _dict_to_row(data, model_cls):
    """Convert camelCase dict from frontend to snake_case for the model."""
    mapped = {}
    valid_cols = {c.name for c in model_cls.__table__.columns}
    for key, val in data.items():
        snake = _camel_to_snake(key)
        if snake in valid_cols and snake not in ("created_at", "updated_at"):
            mapped[snake] = val
    return mapped


# ── CRUD factory ──────────────────────────────────────────────────────────

def _crud_routes(path, model_cls):
    """Generate GET all, GET by id, POST, PUT, DELETE for a model."""

    @router.get(f"/{path}")
    async def get_all(db: AsyncSession = Depends(get_db)):
        result = await db.execute(select(model_cls).order_by(model_cls.id))
        return [_row_to_dict(r) for r in result.scalars().all()]

    @router.get(f"/{path}/{{item_id}}")
    async def get_one(item_id: int, db: AsyncSession = Depends(get_db)):
        result = await db.execute(select(model_cls).where(model_cls.id == item_id))
        row = result.scalar_one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail=f"{path} {item_id} not found")
        return _row_to_dict(row)

    @router.post(f"/{path}")
    async def create(data: dict, db: AsyncSession = Depends(get_db)):
        mapped = _dict_to_row(data, model_cls)
        row = model_cls(**mapped)
        db.add(row)
        await db.flush()
        await db.refresh(row)
        return _row_to_dict(row)

    @router.put(f"/{path}/{{item_id}}")
    async def update(item_id: int, data: dict, db: AsyncSession = Depends(get_db)):
        result = await db.execute(select(model_cls).where(model_cls.id == item_id))
        row = result.scalar_one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail=f"{path} {item_id} not found")
        mapped = _dict_to_row(data, model_cls)
        for key, val in mapped.items():
            if key != "id":
                setattr(row, key, val)
        await db.flush()
        await db.refresh(row)
        return _row_to_dict(row)

    @router.delete(f"/{path}/{{item_id}}")
    async def remove(item_id: int, db: AsyncSession = Depends(get_db)):
        result = await db.execute(select(model_cls).where(model_cls.id == item_id))
        row = result.scalar_one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail=f"{path} {item_id} not found")
        await db.delete(row)
        return {"ok": True, "id": item_id}


# Register routes for every entity
_crud_routes("companies", models.Company)
_crud_routes("contacts", models.Contact)
_crud_routes("projects", models.Project)
_crud_routes("quotes", models.Quote)
_crud_routes("invoices", models.Invoice)
_crud_routes("equipment", models.Equipment)
_crud_routes("products", models.Product)
_crud_routes("services", models.Service)


# ── Settings (singleton) ─────────────────────────────────────────────────

@router.get("/settings")
async def get_settings(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(models.Settings).where(models.Settings.id == 1))
    row = result.scalar_one_or_none()
    if not row:
        return {}
    return row.data


@router.put("/settings")
async def update_settings(data: dict, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(models.Settings).where(models.Settings.id == 1))
    row = result.scalar_one_or_none()
    if not row:
        row = models.Settings(id=1, data=data)
        db.add(row)
    else:
        row.data = data
    await db.flush()
    return row.data


# ── Bulk sync (for initial migration from localStorage) ──────────────────

@router.post("/sync")
async def bulk_sync(payload: dict, db: AsyncSession = Depends(get_db)):
    """Accept full localStorage dump and populate the database."""
    model_map = {
        "companies": models.Company,
        "contacts": models.Contact,
        "projects": models.Project,
        "quotes": models.Quote,
        "invoices": models.Invoice,
        "equipment": models.Equipment,
        "products": models.Product,
        "services": models.Service,
    }
    counts = {}
    for key, model_cls in model_map.items():
        items = payload.get(key, [])
        if not items:
            continue
        # Clear existing
        await db.execute(delete(model_cls))
        for item in items:
            mapped = _dict_to_row(item, model_cls)
            db.add(model_cls(**mapped))
        counts[key] = len(items)

    # Settings
    if "settings" in payload:
        result = await db.execute(select(models.Settings).where(models.Settings.id == 1))
        row = result.scalar_one_or_none()
        if not row:
            db.add(models.Settings(id=1, data=payload["settings"]))
        else:
            row.data = payload["settings"]
        counts["settings"] = 1

    return {"synced": counts}
