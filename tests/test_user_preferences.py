"""Per-user preferences API — private saved table views.

Covers:
  - GET  /api/me/preferences            (empty → {}, then reflects saves)
  - PUT  /api/me/preferences/table-views/{table_key}
       · stores a per-table view envelope under preferences.tableViews
       · a second table does NOT clobber the first
       · invalid table key / bad body / too many views → 4xx
       · one user's views are invisible to another (private per row)
       · no session → 401

Runnable both under pytest (shared suite DB via conftest) and standalone
(python tests/test_user_preferences.py) with its own throwaway DB.
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_user_prefs.db")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

# Clean the standalone DB (no-op under pytest, which pins a shared suite DB).
if "_test_user_prefs.db" in os.environ["DATABASE_URL"]:
    for _suffix in ("", "-wal", "-shm"):
        try:
            os.remove(os.path.join(_root, "_test_user_prefs.db") + _suffix)
        except FileNotFoundError:
            pass

from backend import models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402

# Unique tokens/identities so rows are disjoint from other modules sharing the
# pytest suite DB.
_TOK = "prefs-user-token-" + "a" * 24
_TOK2 = "prefs-user2-token-" + "b" * 24

_client = None
_seeded = False


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
            now = datetime.now(timezone.utc)
            async with async_session() as db:
                u1 = models.User(google_sub="prefs-sub-1", email="prefs1@biz.com",
                                 name="Prefs One", role="member", last_login=now)
                u2 = models.User(google_sub="prefs-sub-2", email="prefs2@biz.com",
                                 name="Prefs Two", role="member", last_login=now)
                db.add_all([u1, u2])
                await db.flush()
                db.add(models.Session(id=hash_session_token(_TOK), user_id=u1.id, expires_at=now + timedelta(days=7)))
                db.add(models.Session(id=hash_session_token(_TOK2), user_id=u2.id, expires_at=now + timedelta(days=7)))
                await db.commit()

        asyncio.run(seed())
        _seeded = True
    return _client


def _cookie(tok=_TOK):
    return {"ltp_session": tok}


# ── Tests ────────────────────────────────────────────────────────────────────

def test_empty_preferences_start_as_object():
    c = _setup()
    r = c.get("/api/me/preferences", cookies=_cookie())
    assert r.status_code == 200, r.text
    assert r.json() == {}


def test_requires_session():
    c = _setup()
    assert c.get("/api/me/preferences").status_code == 401
    assert c.put("/api/me/preferences/table-views/quotes", json={"views": {}}).status_code == 401


def test_save_and_read_back_a_view():
    c = _setup()
    view = {"sort": {"key": "created", "dir": "desc"}, "filters": {"status": "sent"}, "toggles": {"showConverted": True}}
    body = {"active": "My View", "views": {"Default": {}, "My View": view}}
    r = c.put("/api/me/preferences/table-views/quotes", json=body, cookies=_cookie())
    assert r.status_code == 200, r.text
    assert r.json()["active"] == "My View"
    assert r.json()["views"]["My View"] == view

    got = c.get("/api/me/preferences", cookies=_cookie()).json()
    assert got["tableViews"]["quotes"]["active"] == "My View"
    assert got["tableViews"]["quotes"]["views"]["My View"] == view


def test_second_table_does_not_clobber_first():
    c = _setup()
    c.put("/api/me/preferences/table-views/quotes", json={"active": "A", "views": {"A": {}}}, cookies=_cookie())
    c.put("/api/me/preferences/table-views/projects", json={"active": "B", "views": {"B": {}}}, cookies=_cookie())
    tv = c.get("/api/me/preferences", cookies=_cookie()).json()["tableViews"]
    assert set(tv.keys()) >= {"quotes", "projects"}
    assert tv["projects"]["active"] == "B"


def test_preferences_are_private_per_user():
    c = _setup()
    c.put("/api/me/preferences/table-views/invoices", json={"active": "Mine", "views": {"Mine": {}}}, cookies=_cookie())
    # User two has never saved invoices views — must not see user one's.
    other = c.get("/api/me/preferences", cookies=_cookie(_TOK2)).json()
    assert "invoices" not in (other.get("tableViews") or {})


def test_invalid_table_key_rejected():
    c = _setup()
    r = c.put("/api/me/preferences/table-views/Bad_Key!", json={"views": {}}, cookies=_cookie())
    assert r.status_code == 400


def test_bad_body_rejected():
    c = _setup()
    # views must be an object
    assert c.put("/api/me/preferences/table-views/quotes", json={"views": []}, cookies=_cookie()).status_code == 400
    assert c.put("/api/me/preferences/table-views/quotes", json=[1, 2, 3], cookies=_cookie()).status_code == 422


def test_too_many_views_rejected():
    c = _setup()
    many = {("v%d" % i): {} for i in range(51)}
    r = c.put("/api/me/preferences/table-views/quotes", json={"views": many}, cookies=_cookie())
    assert r.status_code == 400


def main():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = 0
    for fn in fns:
        fn()
        passed += 1
        print("PASS", fn.__name__)
    print(f"\nAll {passed} preference-API checks passed.")


if __name__ == "__main__":
    main()
