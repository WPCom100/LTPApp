"""Web Push subscription management — session-gated /api/push/*.

  GET  /api/push/vapid-public-key   → { publicKey, configured }
  POST /api/push/subscribe          → store this browser's PushSubscription
  POST /api/push/unsubscribe        → drop it

The endpoint + keys come straight from the browser's PushManager.subscribe();
we key on the (unique) endpoint so re-subscribing the same device updates in
place instead of piling up rows. Every route is session-gated — a subscription
always belongs to the signed-in user. Sending lives in backend/webpush.py; the
table in backend/models.py (PushSubscription). All paths sit under /api/ so the
static catch-all's api/ early-return already covers them.
"""
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend import models, webpush
from backend.auth_deps import require_session
from backend.database import get_db

push_router = APIRouter(prefix="/api/push", tags=["push"])


class SubscribeBody(BaseModel):
    endpoint: str
    keys: dict = {}   # {"p256dh": "...", "auth": "..."} — from PushSubscription.toJSON()


@push_router.get("/vapid-public-key")
async def vapid_public_key(user: models.User = Depends(require_session)):
    """The applicationServerKey the browser needs, plus whether push is
    configured server-side (so the UI can show 'not set up' instead of failing)."""
    return {"publicKey": webpush.public_key(), "configured": webpush.is_configured()}


@push_router.post("/subscribe")
async def subscribe(
    body: SubscribeBody,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(require_session),
):
    p256dh = (body.keys or {}).get("p256dh")
    auth = (body.keys or {}).get("auth")
    if not body.endpoint or not p256dh or not auth:
        return {"ok": False, "error": "incomplete subscription"}

    ua = (request.headers.get("user-agent") or "")[:300] or None
    existing = (
        await db.execute(
            select(models.PushSubscription).where(
                models.PushSubscription.endpoint == body.endpoint
            )
        )
    ).scalar_one_or_none()

    if existing is not None:
        # Same device re-subscribing (keys rotate, or it moved to another user).
        existing.user_id = user.id
        existing.p256dh = p256dh
        existing.auth = auth
        existing.ua = ua
    else:
        db.add(
            models.PushSubscription(
                user_id=user.id,
                endpoint=body.endpoint,
                p256dh=p256dh,
                auth=auth,
                ua=ua,
            )
        )
    # get_db commits on a clean return.
    return {"ok": True}


@push_router.post("/unsubscribe")
async def unsubscribe(
    body: SubscribeBody,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(require_session),
):
    await db.execute(
        delete(models.PushSubscription).where(
            models.PushSubscription.endpoint == body.endpoint,
            models.PushSubscription.user_id == user.id,
        )
    )
    return {"ok": True}
