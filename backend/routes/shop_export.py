"""Read-only signed-quote requirements for Shop, with a separate credential.

Never reuse the inventory export token: this feed has a different data scope.
No prices, customer records, share tokens, or signature images leave this route.
Previously signed quotes remain in the feed when recalled so Shop can flag changes.
"""
from __future__ import annotations

import hashlib
import hmac
import os
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.models import Project, Quote

router = APIRouter(prefix="/api/shop-export", tags=["shop export"])


def require_shop_token(
    presented: str | None = Header(default=None, alias="X-LTP-Shop-Token"),
) -> None:
    expected = os.environ.get("LTP_SHOP_QUOTE_EXPORT_TOKEN", "")
    if len(expected) < 32:
        raise HTTPException(503, "Shop quote export is not configured")
    if not presented or not hmac.compare_digest(
        hashlib.sha256(presented.encode()).digest(),
        hashlib.sha256(expected.encode()).digest(),
    ):
        raise HTTPException(401, "Invalid shop export credential")


def signed_evidence(activity: Any) -> dict[str, str] | None:
    """Only the client-accept path records this event with a signature image."""
    for event in reversed(activity if isinstance(activity, list) else []):
        if not isinstance(event, dict) or event.get("type") != "client_accepted":
            continue
        signature = event.get("signatureDataUrl")
        if not isinstance(signature, str) or not signature.startswith("data:image/"):
            continue
        if not 200 <= len(signature) <= 200_000:
            continue
        return {
            "activityId": str(event.get("id") or ""),
            "signedAt": str(event.get("date") or "") + " " + str(event.get("time") or ""),
            "signatureSha256": hashlib.sha256(signature.encode()).hexdigest(),
        }
    return None


def serialize_quote(quote: Quote, project: Project | None) -> dict[str, Any] | None:
    evidence = signed_evidence(quote.activity)
    if evidence is None:
        return None
    sections = []
    for section in quote.sections or []:
        if not isinstance(section, dict):
            continue
        items = []
        for item in section.get("items") or []:
            if not isinstance(item, dict) or item.get("type") not in {"equipment", "note"}:
                continue
            items.append({key: item.get(key) for key in (
                "id", "type", "name", "qty", "equipmentId", "note",
            )})
        sections.append({"id": section.get("id"), "label": section.get("label"), "items": items})
    updated = quote.updated_at
    if updated is not None and updated.tzinfo is None:
        updated = updated.replace(tzinfo=timezone.utc)
    return {
        "id": quote.id,
        "status": quote.status,
        "updatedAt": updated.isoformat() if updated else None,
        "projectId": quote.project_id,
        "projectName": project.name if project else None,
        "customName": quote.custom_name,
        "startDate": quote.custom_start_date or (project.start_date if project else None),
        "endDate": quote.custom_end_date or (project.end_date if project else None),
        "notes": quote.notes,
        "signedEvidence": evidence,
        "sections": sections,
    }


@router.get("/quotes", dependencies=[Depends(require_shop_token)])
async def export_quotes(response: Response, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    rows = (await db.execute(
        select(Quote, Project).outerjoin(Project, Project.id == Quote.project_id).order_by(Quote.id)
    )).all()
    quotes = [payload for quote, project in rows if (payload := serialize_quote(quote, project))]
    return {
        "schemaVersion": "ltpapp.shop-quotes/1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "quotes": quotes,
    }
