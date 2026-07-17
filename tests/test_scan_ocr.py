"""Label-OCR endpoint (/api/scan/ocr) — gating, validation, and extraction.

The endpoint forwards a label photo to Claude to read the serial PRINTED on
it when the barcode won't decode (see backend/routes/scan.py). These tests
cover everything EXCEPT the real Anthropic call, which is monkeypatched —
network correctness is exercised by the Playwright E2E against a stub server.

Key behaviors locked in:
  - Feature-flagged on ANTHROPIC_API_KEY: status reflects it; POST 503s without it.
  - Input validation: base64 required, size-capped.
  - Reply validation: only plausible printed codes come back — prose,
    "NONE", bare words, and oversized strings all normalize to null.
"""
import base64
import os

import pytest
from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_scan_ocr.db")

import asyncio
import sys
from datetime import datetime, timedelta, timezone

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

from backend import models                      # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402
from backend.routes import scan as scan_module    # noqa: E402

_client = None
_seeded = False
_session_token = "scan-ocr-session-abcdefghijklmnopqrstuvwxyz"


def _setup():
    global _client, _seeded
    if _client is None:
        from fastapi.testclient import TestClient
        from backend.main import app
        _client = TestClient(app)
        _client.__enter__()
    if not _seeded:
        from backend.database import async_session

        async def seed():
            async with async_session() as db:
                user = models.User(
                    google_sub="scan-ocr-sub", email="scan-ocr@biz.com",
                    name="OCR Tester", role="member",
                )
                db.add(user)
                await db.flush()
                db.add(models.Session(
                    id=hash_session_token(_session_token), user_id=user.id,
                    expires_at=datetime.now(timezone.utc) + timedelta(days=7),
                ))
                await db.commit()

        asyncio.run(seed())
        _seeded = True
    return _client


_TINY_PNG_B64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 64).decode()


# ── _extract_code: only plausible printed codes survive ─────────────────────

@pytest.mark.parametrize("reply,expected", [
    ("LTP0106", "LTP0106"),
    ("  `LTP0106`  ", "LTP0106"),
    ('"LTP-01/A.2#"', "LTP-01/A.2#"),
    ("NONE", None),
    ("none", None),
    ("I cannot see a code in this image.", None),   # prose (has spaces)
    ("Sorry", None),                                 # bare word, no digit
    ("LTP 0106", None),                              # codes are contiguous
    ("x" * 200, None),                               # too long
    ("", None),
    (None, None),
])
def test_extract_code(reply, expected):
    assert scan_module._extract_code(reply) == expected


# ── Feature gating on ANTHROPIC_API_KEY ─────────────────────────────────────

def test_status_reflects_key(monkeypatch):
    client = _setup()
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    r = client.get("/api/scan/ocr/status", cookies={"ltp_session": _session_token})
    assert r.status_code == 200 and r.json() == {"available": False}

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-real")
    r = client.get("/api/scan/ocr/status", cookies={"ltp_session": _session_token})
    assert r.status_code == 200 and r.json() == {"available": True}


def test_post_without_key_is_503(monkeypatch):
    client = _setup()
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    r = client.post("/api/scan/ocr", json={"image": _TINY_PNG_B64},
                    cookies={"ltp_session": _session_token})
    assert r.status_code == 503


def test_requires_session():
    client = _setup()
    assert client.get("/api/scan/ocr/status").status_code == 401
    assert client.post("/api/scan/ocr", json={"image": _TINY_PNG_B64}).status_code == 401


# ── Input validation ────────────────────────────────────────────────────────

def test_rejects_bad_base64(monkeypatch):
    client = _setup()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-real")
    r = client.post("/api/scan/ocr", json={"image": "not@@base64!!"},
                    cookies={"ltp_session": _session_token})
    assert r.status_code == 400


def test_rejects_oversized_image(monkeypatch):
    client = _setup()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-real")
    big = base64.b64encode(b"0" * (scan_module._MAX_IMAGE_BYTES + 1)).decode()
    r = client.post("/api/scan/ocr", json={"image": big},
                    cookies={"ltp_session": _session_token})
    assert r.status_code == 400


# ── Happy path with the Anthropic call monkeypatched ────────────────────────

def test_ocr_read_returns_validated_code(monkeypatch):
    client = _setup()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-real")

    async def fake_call(image_b64, media_type):
        assert image_b64 == _TINY_PNG_B64
        assert media_type == "image/jpeg"
        return "  LTP0777  "

    monkeypatch.setattr(scan_module, "_call_claude", fake_call)
    r = client.post("/api/scan/ocr", json={"image": _TINY_PNG_B64},
                    cookies={"ltp_session": _session_token})
    assert r.status_code == 200 and r.json() == {"code": "LTP0777"}


def test_ocr_read_none_and_prose_normalize_to_null(monkeypatch):
    client = _setup()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-real")
    for reply in ("NONE", "I see a black road case but no legible code."):
        async def fake_call(image_b64, media_type, _r=reply):
            return _r
        monkeypatch.setattr(scan_module, "_call_claude", fake_call)
        r = client.post("/api/scan/ocr", json={"image": _TINY_PNG_B64},
                        cookies={"ltp_session": _session_token})
        assert r.status_code == 200 and r.json() == {"code": None}
