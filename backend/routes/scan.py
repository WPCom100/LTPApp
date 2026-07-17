"""Barcode-label OCR via Claude — session-gated /api/scan/*.

  GET  /api/scan/ocr/status  → { available }   (is ANTHROPIC_API_KEY configured?)
  POST /api/scan/ocr         → { code | null } (read the asset code printed on a label photo)

The scan-import UI (modules/rentals-scan.js) decodes barcodes locally
(BarcodeDetector / ZXing-WASM). When the bars won't read — glare, angle, blur —
the printed serial UNDER the bars usually still will, so the frontend falls
back to posting a downscaled JPEG of the frame here. We forward it to the
Anthropic Messages API (Claude Haiku by default: fast, cheap, and excellent at
reading small/angled/glare-y printed text) with a tight extract-only prompt,
then validate the reply's shape before returning it. The frontend applies its
own cleanScanCode + duplicate guard on top.

Ops notes:
  - Feature-flagged on ANTHROPIC_API_KEY (checked per request, so setting the
    Railway variable lights it up on the next call — no restart needed beyond
    the platform's own). Without a key: status says unavailable and POST 503s;
    the UI hides all OCR affordances.
  - LTP_OCR_MODEL overrides the model id; ANTHROPIC_BASE_URL overrides the API
    origin (tests point it at a local stub — never set it in production).
  - The key stays server-side; the browser never sees it. Rate-limited via the
    "/api/scan" rule in backend/rate_limit.py to bound spend from a hostile or
    runaway client. Image bytes are size-capped and never logged.
"""
import base64
import binascii
import os
import re

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend import models
from backend.auth_deps import require_session

scan_router = APIRouter(prefix="/api/scan", tags=["scan"])

# ~4 MB of raw image is far above the frontend's ~1280px JPEG (~100-300 KB) —
# generous headroom without letting a client shovel full 24 MP originals through.
_MAX_IMAGE_BYTES = 4 * 1024 * 1024
_ALLOWED_MEDIA = {"image/jpeg", "image/png", "image/webp"}
_DEFAULT_MODEL = "claude-haiku-4-5-20251001"
_PROMPT = (
    "This photo shows an equipment asset label. Printed on it is a short "
    "alphanumeric asset/serial code (often starting with LTP), usually beneath "
    "a barcode. Reply with ONLY that code, exactly as printed, nothing else. "
    "If no code is legible, reply with exactly NONE."
)
# What a plausible asset code looks like: contiguous (no spaces — that's what
# rejects "I cannot see a code…"-style prose), starts alphanumeric, contains at
# least one digit (every real tag does; rejects bare words like "Sorry"), and
# short. Anything else is treated as "no read" rather than stored.
_CODE_RE = re.compile(r"^(?=.*\d)[A-Za-z0-9][A-Za-z0-9._/#-]{0,31}$")


def _enabled() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())


def _extract_code(reply: str):
    """Normalize Claude's reply to a plausible code, or None. Strips wrapping
    quotes/backticks/whitespace, rejects the NONE sentinel and anything that
    doesn't look like a printed asset code."""
    if not isinstance(reply, str):
        return None
    code = reply.strip().strip("`'\"").strip()
    if not code or code.upper() == "NONE":
        return None
    if not _CODE_RE.match(code):
        return None
    return code


async def _call_claude(image_b64: str, media_type: str) -> str:
    """One Messages-API call: image + extract prompt → reply text. Split out so
    tests can monkeypatch it without real network."""
    base = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")
    model = os.environ.get("LTP_OCR_MODEL", _DEFAULT_MODEL)
    payload = {
        "model": model,
        "max_tokens": 64,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_b64}},
                {"type": "text", "text": _PROMPT},
            ],
        }],
    }
    headers = {
        "x-api-key": os.environ["ANTHROPIC_API_KEY"].strip(),
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    async with httpx.AsyncClient(timeout=25.0) as cli:
        resp = await cli.post(base + "/v1/messages", json=payload, headers=headers)
    if resp.status_code != 200:
        # Auth/model/rate errors are server config problems — surface a generic
        # upstream failure (no key material, no image data) and log the status.
        print(f"[LTP] scan-ocr: anthropic returned {resp.status_code}", flush=True)
        raise HTTPException(status_code=502, detail="label-reading service unavailable")
    data = resp.json()
    blocks = data.get("content") or []
    for block in blocks:
        if block.get("type") == "text":
            return block.get("text") or ""
    return ""


class OcrBody(BaseModel):
    image: str                       # base64 (no data: prefix), JPEG/PNG/WebP
    mediaType: str = "image/jpeg"


@scan_router.get("/ocr/status")
async def ocr_status(user: models.User = Depends(require_session)):
    """Lets the scan UI decide whether to show OCR affordances at all."""
    return {"available": _enabled()}


@scan_router.post("/ocr")
async def ocr_read(body: OcrBody, user: models.User = Depends(require_session)):
    if not _enabled():
        raise HTTPException(status_code=503, detail="label reading is not configured")
    media_type = body.mediaType if body.mediaType in _ALLOWED_MEDIA else "image/jpeg"
    b64 = (body.image or "").strip()
    if not b64:
        raise HTTPException(status_code=400, detail={"field": "image", "reason": "required"})
    try:
        raw = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail={"field": "image", "reason": "must be base64"})
    if len(raw) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail={"field": "image", "reason": "image too large"})
    try:
        reply = await _call_claude(b64, media_type)
    except HTTPException:
        raise
    except Exception as e:
        print(f"[LTP] scan-ocr: call failed: {type(e).__name__}", flush=True)
        raise HTTPException(status_code=502, detail="label-reading service unavailable")
    return {"code": _extract_code(reply)}
