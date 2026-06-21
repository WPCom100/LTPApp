"""Security-hardening regression tests (docs/SECURITY_REVIEW.md).

C1 — the public accept endpoint must only store signatures that are real
base64 raster images, so the staff-facing "View signature" popup can't be
turned into a stored-XSS sink (prefix/length checks alone let SVG payloads
and img-src attribute-breakout strings through).
"""
import base64
import os

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "http://localhost:8000/auth/callback")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import pytest
from fastapi import HTTPException

from backend.routes.view import _validate_signature_data_url

# A real 1x1 transparent PNG (decodes to bytes starting with the PNG magic).
_PNG_1x1 = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _data_url(mime: str, raw: bytes) -> str:
    return f"data:{mime};base64," + base64.b64encode(raw).decode()


def test_valid_png_signature_accepted():
    # A genuine PNG must pass (no exception).
    _validate_signature_data_url(_PNG_1x1)


def test_valid_jpeg_signature_accepted():
    _validate_signature_data_url(_data_url("image/jpeg", b"\xff\xd8\xff\xe0" + b"\x00" * 16))


def test_svg_signature_rejected():
    # image/svg+xml is the one image/* type that can carry script.
    svg = _data_url("image/svg+xml", b"<svg onload=alert(1)></svg>")
    with pytest.raises(HTTPException) as ei:
        _validate_signature_data_url(svg)
    assert ei.value.status_code == 400


def test_attribute_breakout_rejected():
    # Starts with data:image/ (passes the old prefix check) but is not a real
    # base64 image — this is the string that would break out of the popup's
    # <img src="..."> attribute.
    payload = 'data:image/png"><script>alert(document.cookie)</script>'
    with pytest.raises(HTTPException):
        _validate_signature_data_url(payload)


def test_non_base64_rejected():
    with pytest.raises(HTTPException):
        _validate_signature_data_url("data:image/png;base64,@@@not base64@@@")


def test_non_image_base64_rejected():
    # Valid base64, but the bytes are not any known image (no magic number).
    with pytest.raises(HTTPException):
        _validate_signature_data_url(_data_url("image/png", b"this is not an image"))


def test_missing_base64_marker_rejected():
    # data:image/png,<raw> (no ;base64) — reject; we require base64 encoding.
    with pytest.raises(HTTPException):
        _validate_signature_data_url("data:image/png,iVBORw0KGgo")


# ── H2: rate-limit rule matching ───────────────────────────────────────────
# The previously-unthrottled families (public view, PDF, email relay, bulk
# sync, QBO callback) must now resolve to a limit, while ordinary /api routes
# stay unmatched, and prefixes must match on path segments (no /auth/loginX).

from backend.rate_limit import _match_rule


@pytest.mark.parametrize("path,expected_key", [
    ("/auth/login", "/auth/login"),
    ("/auth/callback", "/auth/callback"),
    ("/api/qbo/callback", "/api/qbo/callback"),
    ("/api/view/sometoken", "/api/view"),
    ("/api/view/sometoken/accept", "/api/view"),
    ("/api/view/sometoken/pdf", "/api/view"),
    ("/pdf/sometoken", "/pdf"),
    ("/api/email/send", "/api/email/send"),
    ("/api/sync", "/api/sync"),
])
def test_rate_limited_routes_match(path, expected_key):
    rule = _match_rule(path)
    assert rule is not None, f"{path} should be rate-limited"
    assert rule[0] == expected_key
    assert rule[1] > 0


@pytest.mark.parametrize("path", [
    "/api/companies",
    "/api/invoices/5",
    "/auth/loginX",        # not a path-segment prefix of /auth/login
    "/api/viewer",         # not a path-segment prefix of /api/view
    "/static/app.js",
    "/",
])
def test_unlimited_routes_pass_through(path):
    assert _match_rule(path) is None


# ── H3: share_token is server-authoritative ────────────────────────────────
# A client-supplied share_token (the public client-view credential) must be
# stripped by the write layer so a member can't pin it to a guessable value or
# rotate it. The token is minted server-side on create instead.

from backend.routes.api import _dict_to_row, _READONLY_COLS
from backend import models


def test_share_token_in_readonly_cols():
    assert "share_token" in _READONLY_COLS


def test_share_token_stripped_from_quote_writes():
    mapped = _dict_to_row({"shareToken": "attacker-chosen", "status": "draft"}, models.Quote)
    assert "share_token" not in mapped       # stripped
    assert mapped.get("status") == "draft"   # ordinary fields still write


def test_share_token_snake_case_also_stripped():
    # Defense against a client that sends the snake_case name directly.
    mapped = _dict_to_row({"share_token": "attacker-chosen"}, models.Invoice)
    assert "share_token" not in mapped
