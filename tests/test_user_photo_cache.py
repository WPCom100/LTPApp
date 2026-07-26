"""Cached Google profile photo feature.

Covers:
  - User.cached_photo_path() (model helper: token+timestamp → serve URL)
  - auth._should_fetch_photo (when to (re)download)
  - auth._fetch_and_cache_photo (best-effort download; mocked httpx)
  - email_compose._signature_photo_url (cache > google url > self-hosted fallback)
  - GET /api/users/photo/{token}   (PUBLIC serve endpoint — no session)
  - POST /api/users/{id}/refresh-photo (admin-only re-pull flag)
  - _user_dict pictureUrl prefers the cached path

Written pytest-native (real asserts) so the combined `pytest` run actually
verifies it; also runnable as a script via main().
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_user_photo.db")
# Required when LTP_OAUTH_REDIRECT_URI is https (prod cookie/HSTS path). Under
# pytest conftest.py provides this; set a strong default for standalone runs.
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

# Clean the standalone DB (no-op under pytest, which pins a shared suite DB).
if "_test_user_photo.db" in os.environ["DATABASE_URL"]:
    for _suffix in ("", "-wal", "-shm"):
        try:
            os.remove(os.path.join(_root, "_test_user_photo.db") + _suffix)
        except FileNotFoundError:
            pass

from contextlib import contextmanager  # noqa: E402

from backend import models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402
from backend.routes import auth as auth_mod  # noqa: E402
from backend.routes import api as api_mod  # noqa: E402
from backend.email_compose import (  # noqa: E402
    _signature_photo_url, _photo_fallback_url, _app_origin,
)


@contextmanager
def _patch_fetch(*, returns, cache=False):
    """Replace api._fetch_and_cache_photo so the refresh endpoint doesn't make a
    real network call. `returns` is the boolean it yields; when cache=True the
    fake also populates the user row like a real successful download would."""
    orig = api_mod._fetch_and_cache_photo

    async def fake(user, picture, now, **kwargs):
        if cache:
            user.photo_token = user.photo_token or f"immediate-tok-{user.id}"
            user.photo_data = _PNG_BYTES
            user.photo_content_type = "image/png"
            user.photo_updated_at = now
            user.photo_refresh_requested = False
        return returns

    api_mod._fetch_and_cache_photo = fake
    try:
        yield
    finally:
        api_mod._fetch_and_cache_photo = orig


# 1×1 PNG — a real, tiny image payload for the serve-endpoint tests.
_PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


# ── Model helper: cached_photo_path ────────────────────────────────────────

def test_cached_photo_path():
    u = models.User(google_sub="g", email="x@y.com", name="X")
    assert u.cached_photo_path() is None, "no token/timestamp → None"
    u.photo_token = "abc123"
    assert u.cached_photo_path() is None, "token but no timestamp → None"
    ts = datetime(2026, 7, 27, 12, 0, tzinfo=timezone.utc)
    u.photo_updated_at = ts
    path = u.cached_photo_path()
    assert path == f"/api/users/photo/abc123?v={int(ts.timestamp())}", path
    assert "?v=" in path, "carries a cache-buster"


# ── auth._should_fetch_photo ───────────────────────────────────────────────

def test_should_fetch_photo():
    u = models.User(google_sub="g", email="x@y.com", name="X")
    # New/legacy user: no cached photo yet → fetch (when a source URL exists).
    assert auth_mod._should_fetch_photo(u, "https://lh3/pic") is True
    # No source URL → never fetch.
    assert auth_mod._should_fetch_photo(u, "") is False
    # Already cached, no re-pull requested → skip.
    u.photo_updated_at = datetime.now(timezone.utc)
    u.photo_refresh_requested = False
    assert auth_mod._should_fetch_photo(u, "https://lh3/pic") is False
    # Cached but admin queued a re-pull → fetch.
    u.photo_refresh_requested = True
    assert auth_mod._should_fetch_photo(u, "https://lh3/pic") is True


# ── auth._fetch_and_cache_photo (mocked httpx) ─────────────────────────────

def _fake_client(status=200, ctype="image/jpeg", content=_PNG_BYTES):
    resp = MagicMock()
    resp.status_code = status
    resp.headers = {"content-type": ctype}
    resp.content = content
    cli = MagicMock()
    cli.get = AsyncMock(return_value=resp)
    return cli, resp


def test_fetch_and_cache_photo_success():
    u = models.User(google_sub="g", email="x@y.com", name="X")
    u.photo_refresh_requested = True
    now = datetime.now(timezone.utc)
    cli, _ = _fake_client(ctype="image/jpeg")
    ok = asyncio.run(auth_mod._fetch_and_cache_photo(u, "https://lh3/pic=s96-c", now, httpx_client=cli))
    assert ok is True
    assert u.photo_data == _PNG_BYTES
    assert u.photo_content_type == "image/jpeg"
    assert u.photo_updated_at == now
    assert u.photo_token, "token minted on first cache"
    assert u.photo_refresh_requested is False, "re-pull flag cleared on success"


def test_fetch_and_cache_photo_bumps_size_hint():
    """We request a crisper size than Google's default =s96-c."""
    u = models.User(google_sub="g", email="x@y.com", name="X")
    cli, _ = _fake_client()
    asyncio.run(auth_mod._fetch_and_cache_photo(u, "https://lh3/AAA=s96-c", datetime.now(timezone.utc), httpx_client=cli))
    requested_url = cli.get.await_args.args[0]
    assert requested_url == "https://lh3/AAA=s256-c", requested_url


def test_fetch_and_cache_photo_non_image_kept_old():
    u = models.User(google_sub="g", email="x@y.com", name="X")
    u.photo_data = b"OLD"
    u.photo_content_type = "image/png"
    old_ts = datetime(2020, 1, 1, tzinfo=timezone.utc)
    u.photo_updated_at = old_ts
    cli, _ = _fake_client(status=200, ctype="text/html", content=b"<html>404</html>")
    ok = asyncio.run(auth_mod._fetch_and_cache_photo(u, "https://lh3/pic", datetime.now(timezone.utc), httpx_client=cli))
    assert ok is False
    assert u.photo_data == b"OLD", "non-image response must not clobber the cache"
    assert u.photo_updated_at == old_ts


def test_fetch_and_cache_photo_network_error_nonfatal():
    u = models.User(google_sub="g", email="x@y.com", name="X")
    u.photo_data = b"OLD"
    cli = MagicMock()
    cli.get = AsyncMock(side_effect=RuntimeError("connection reset"))
    ok = asyncio.run(auth_mod._fetch_and_cache_photo(u, "https://lh3/pic", datetime.now(timezone.utc), httpx_client=cli))
    assert ok is False, "network error is non-fatal (never raises)"
    assert u.photo_data == b"OLD"


def test_fetch_and_cache_photo_too_big_skipped():
    u = models.User(google_sub="g", email="x@y.com", name="X")
    huge = b"x" * (auth_mod._PHOTO_MAX_BYTES + 1)
    cli, _ = _fake_client(ctype="image/jpeg", content=huge)
    ok = asyncio.run(auth_mod._fetch_and_cache_photo(u, "https://lh3/pic", datetime.now(timezone.utc), httpx_client=cli))
    assert ok is False
    assert u.photo_data is None


# ── email_compose._signature_photo_url ─────────────────────────────────────

def test_signature_photo_url_priority():
    # 1. Cached copy wins — absolute, app-served.
    u = models.User(google_sub="g", email="x@y.com", name="X",
                    picture_url="https://lh3/google-pic")
    u.photo_token = "tok9"
    u.photo_updated_at = datetime(2026, 7, 27, tzinfo=timezone.utc)
    url = _signature_photo_url(u)
    # Absolute (built from the app origin, which differs across test configs) and
    # points at our cached-photo route, not the Google URL.
    assert url == _app_origin() + "/api/users/photo/tok9?v=" + str(int(u.photo_updated_at.timestamp())), url
    assert "lh3" not in url

    # 2. No cache → raw Google URL.
    u2 = models.User(google_sub="g2", email="y@y.com", name="Y",
                     picture_url="https://lh3/google-pic")
    assert _signature_photo_url(u2) == "https://lh3/google-pic"

    # 3. Nothing → self-hosted fallback avatar.
    u3 = models.User(google_sub="g3", email="z@y.com", name="Z", picture_url="")
    assert _signature_photo_url(u3) == _photo_fallback_url()


# ── HTTP endpoints (TestClient) ────────────────────────────────────────────

_client = None
_counter = 0


def _client_and_seed(with_photo=True):
    """Return (client, admin_tok, member_tok, admin_id, member_id, photo_token).
    The member row optionally carries cached photo bytes."""
    global _client, _counter
    _counter += 1
    tag = f"p{_counter}"
    if _client is None:
        from fastapi.testclient import TestClient
        from backend.main import app
        _client = TestClient(app)
        _client.__enter__()

    from backend.database import async_session
    photo_token = f"phototok-{tag}"

    async def seed():
        async with async_session() as db:
            admin = models.User(google_sub=f"padmin-{tag}", email=f"padmin-{tag}@biz.com",
                                name="PAdmin", role="admin")
            member = models.User(google_sub=f"pmember-{tag}", email=f"pmember-{tag}@biz.com",
                                 name="PMember", role="member",
                                 picture_url="https://lh3/original")
            if with_photo:
                member.photo_token = photo_token
                member.photo_data = _PNG_BYTES
                member.photo_content_type = "image/png"
                member.photo_updated_at = datetime.now(timezone.utc)
            db.add_all([admin, member])
            await db.flush()
            db.add_all([
                models.Session(id=hash_session_token(f"padmin-sess-{tag}"), user_id=admin.id,
                               expires_at=datetime.now(timezone.utc) + timedelta(days=7)),
                models.Session(id=hash_session_token(f"pmember-sess-{tag}"), user_id=member.id,
                               expires_at=datetime.now(timezone.utc) + timedelta(days=7)),
            ])
            await db.flush()
            await db.commit()
            return admin.id, member.id

    admin_id, member_id = asyncio.run(seed())
    return (_client, f"padmin-sess-{tag}", f"pmember-sess-{tag}",
            admin_id, member_id, photo_token)


def test_get_user_photo_serves_bytes_publicly():
    client, _, _, _, _, token = _client_and_seed(with_photo=True)
    # No session cookie at all — must still serve (email clients have no session).
    r = client.get(f"/api/users/photo/{token}")
    assert r.status_code == 200, r.status_code
    assert r.headers["content-type"].startswith("image/png"), r.headers.get("content-type")
    assert r.content == _PNG_BYTES
    assert "max-age" in r.headers.get("cache-control", ""), r.headers.get("cache-control")


def test_get_user_photo_404_unknown_and_empty():
    client, _, _, _, member_id, _ = _client_and_seed(with_photo=False)
    # Unknown token → 404.
    r = client.get("/api/users/photo/does-not-exist")
    assert r.status_code == 404, r.status_code


def test_refresh_photo_requires_admin():
    # Auth is checked before any fetch, so no patching needed here.
    client, admin_tok, member_tok, _, member_id, _ = _client_and_seed(with_photo=False)
    r = client.post(f"/api/users/{member_id}/refresh-photo", cookies={"ltp_session": member_tok})
    assert r.status_code == 403, r.status_code
    r = client.post(f"/api/users/{member_id}/refresh-photo")
    assert r.status_code == 401, r.status_code


def test_refresh_photo_falls_back_to_flag_when_fetch_fails():
    """Stored Google URL is stale → immediate fetch fails → queue for next login."""
    client, admin_tok, _, _, member_id, _ = _client_and_seed(with_photo=False)
    with _patch_fetch(returns=False):
        r = client.post(f"/api/users/{member_id}/refresh-photo", cookies={"ltp_session": admin_tok})
    assert r.status_code == 200, r.status_code
    body = r.json()
    assert body["photoCachedNow"] is False
    assert body["photoRefreshRequested"] is True
    # Confirm it persisted via the roster.
    users = client.get("/api/users", cookies={"ltp_session": admin_tok}).json()
    member = next(u for u in users if u["id"] == member_id)
    assert member["photoRefreshRequested"] is True


def test_refresh_photo_caches_immediately_when_fetch_succeeds():
    """Stored Google URL still works server-side → photo updates right now, no
    re-login needed, and pictureUrl becomes the app-cached absolute URL."""
    client, admin_tok, _, _, member_id, _ = _client_and_seed(with_photo=False)
    with _patch_fetch(returns=True, cache=True):
        r = client.post(f"/api/users/{member_id}/refresh-photo", cookies={"ltp_session": admin_tok})
    assert r.status_code == 200, r.status_code
    body = r.json()
    assert body["photoCachedNow"] is True
    assert body["photoRefreshRequested"] is False
    assert "/api/users/photo/" in body["pictureUrl"], body["pictureUrl"]
    assert "lh3" not in body["pictureUrl"]


def test_refresh_photo_404_unknown_user():
    # 404 (user not found) is returned before any fetch, so no patching needed.
    client, admin_tok, _, _, _, _ = _client_and_seed(with_photo=False)
    r = client.post("/api/users/99999999/refresh-photo", cookies={"ltp_session": admin_tok})
    assert r.status_code == 404, r.status_code


def test_user_dict_picture_url_prefers_cache():
    client, admin_tok, _, _, member_id, token = _client_and_seed(with_photo=True)
    users = client.get("/api/users", cookies={"ltp_session": admin_tok}).json()
    member = next(u for u in users if u["id"] == member_id)
    # Absolute URL (origin + path) so it passes the frontend http(s) <img> guard.
    assert member["pictureUrl"].startswith(_app_origin() + f"/api/users/photo/{token}?v="), member["pictureUrl"]
    assert "lh3" not in member["pictureUrl"], "cached path replaces the Google URL"


def main() -> int:
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  [PASS] {t.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  [FAIL] {t.__name__}: {e}")
    if _client is not None:
        _client.__exit__(None, None, None)
    print(f"\n== {len(tests) - failed}/{len(tests)} tests passed ==")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
