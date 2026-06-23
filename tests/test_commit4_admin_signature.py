"""Tests covering commit 4 of the email feature: admin user-list endpoints
+ signature template sanitization at save time.

  - GET /api/users requires admin
  - GET /api/users returns the user roster without leaking tokens
  - PUT /api/users/{id} requires admin
  - PUT /api/users/{id} updates title/phone/role only (whitelist)
  - PUT /api/users/{id} rejects invalid role
  - PUT /api/users/{id} blocks self-demotion
  - PUT /api/settings sanitizes emailSignatureTemplate
  - Sanitized signature is idempotent

Runs as a plain script:
    python tests/test_commit4_admin_signature.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_commit4.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

# Clean test DB before importing
_db_path = os.path.join(_root, "_test_commit4.db")
if os.path.exists(_db_path):
    os.remove(_db_path)

from backend import models, crypto  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402


_results: list[tuple[str, bool]] = []


def _check(label: str, cond: bool, detail: str = "") -> None:
    _results.append((label, cond))
    status = "PASS" if cond else "FAIL"
    suffix = f"  ({detail})" if detail else ""
    print(f"  [{status}] {label}{suffix}")


# ── Setup: seed admin + member sessions, return the test client ──────────


# Module-level TestClient — created once. Sqlite file locking on Windows
# prevents recreating it per test, and disposing the app engine between
# tests doesn't reliably release the lock. We share one client and use
# per-test unique google_sub values so seeds don't collide.
_client = None
_test_counter = 0


def _setup_test_client():
    """Seed a fresh admin + member pair with unique google_sub keys so the
    test can run alongside others without colliding on the unique index.
    Returns (client, admin_token, member_token, admin_id, member_id)."""
    global _client, _test_counter
    _test_counter += 1
    tag = f"t{_test_counter}"

    if _client is None:
        from fastapi.testclient import TestClient
        from backend.main import app
        _client = TestClient(app)
        _client.__enter__()

    from backend.database import async_session

    async def seed():
        async with async_session() as db:
            admin = models.User(
                google_sub=f"admin-sub-{tag}", email=f"admin-{tag}@biz.com", name="Admin",
                role="admin", title="Owner", phone="555-0001",
            )
            member = models.User(
                google_sub=f"member-sub-{tag}", email=f"member-{tag}@biz.com", name="Member",
                role="member", title="", phone="",
            )
            admin.gmail_refresh_token = crypto.encrypt_token("fake-refresh-token")
            admin.gmail_granted_scopes = "openid email profile https://www.googleapis.com/auth/gmail.send"
            db.add_all([admin, member])
            await db.flush()
            admin_session = models.Session(
                id=hash_session_token(f"admin-session-{tag}"), user_id=admin.id,
                expires_at=datetime.now(timezone.utc) + timedelta(days=7),
            )
            member_session = models.Session(
                id=hash_session_token(f"member-session-{tag}"), user_id=member.id,
                expires_at=datetime.now(timezone.utc) + timedelta(days=7),
            )
            db.add_all([admin_session, member_session])
            await db.flush()
            await db.commit()
            return admin.id, member.id

    admin_id, member_id = asyncio.run(seed())
    return _client, f"admin-session-{tag}", f"member-session-{tag}", admin_id, member_id


def _teardown_client():
    global _client
    if _client is not None:
        _client.__exit__(None, None, None)
        _client = None


# ── GET /api/users tests ──────────────────────────────────────────────────


def test_list_users_requires_admin():
    print("test_list_users_requires_admin")
    client, admin_tok, member_tok, _, _ = _setup_test_client()
    try:  # noqa: SIM105 — keep the explicit try/finally; we used to teardown per-test
        # Member: 403
        r = client.get("/api/users", cookies={"ltp_session": member_tok})
        _check("member gets 403", r.status_code == 403, f"got {r.status_code}")

        # No session: 401
        r = client.get("/api/users")
        _check("no session gets 401", r.status_code == 401, f"got {r.status_code}")

        # Admin: 200
        r = client.get("/api/users", cookies={"ltp_session": admin_tok})
        _check("admin gets 200", r.status_code == 200, f"got {r.status_code}")
    finally:
        pass  # client lifecycle is module-level; see _teardown_client


def test_list_users_shape_and_no_token_leak():
    print("test_list_users_shape_and_no_token_leak")
    client, admin_tok, _, admin_id, member_id = _setup_test_client()
    try:  # noqa: SIM105 — keep the explicit try/finally; we used to teardown per-test
        r = client.get("/api/users", cookies={"ltp_session": admin_tok})
        users = r.json()
        _check("returns a list", isinstance(users, list))
        _check("contains at least this test's pair", len(users) >= 2)

        # Pluck this test's specific admin + member by ID — other tests may
        # have left rows behind (per-test unique google_sub to dodge sqlite
        # file locking — see _setup_test_client).
        admin = next(u for u in users if u["id"] == admin_id)
        member = next(u for u in users if u["id"] == member_id)

        _check("admin has gmailConnected=True", admin["gmailConnected"] is True)
        _check("admin gmailScope=send", admin["gmailScope"] == "send")
        _check("member has gmailConnected=False", member["gmailConnected"] is False)
        _check("title surfaced", admin["title"] == "Owner")
        _check("phone surfaced", admin["phone"] == "555-0001")

        # Critical: refresh token ciphertext MUST NOT appear in the response
        body = r.text
        _check("no gmail_refresh_token in body", "gmail_refresh_token" not in body)
        _check("no gmailRefreshToken in body", "gmailRefreshToken" not in body)
        _check("encrypted token bytes not in body", "fake-refresh-token" not in body)
    finally:
        pass  # client lifecycle is module-level; see _teardown_client


# ── PUT /api/users/{id} tests ─────────────────────────────────────────────


def test_update_user_requires_admin():
    print("test_update_user_requires_admin")
    client, admin_tok, member_tok, _, member_id = _setup_test_client()
    try:  # noqa: SIM105 — keep the explicit try/finally; we used to teardown per-test
        r = client.put(f"/api/users/{member_id}", json={"title": "x"},
                       cookies={"ltp_session": member_tok})
        _check("member gets 403", r.status_code == 403, f"got {r.status_code}")

        r = client.put(f"/api/users/{member_id}", json={"title": "x"})
        _check("no session gets 401", r.status_code == 401, f"got {r.status_code}")
    finally:
        pass  # client lifecycle is module-level; see _teardown_client


def test_update_user_whitelists_fields():
    print("test_update_user_whitelists_fields")
    client, admin_tok, _, _, member_id = _setup_test_client()
    try:  # noqa: SIM105 — keep the explicit try/finally; we used to teardown per-test
        # Capture the original Google-sourced fields so we can confirm the
        # PUT doesn't change them, regardless of which test seeded this user.
        before = client.get("/api/users", cookies={"ltp_session": admin_tok}).json()
        seeded = next(u for u in before if u["id"] == member_id)
        # Try to update title + phone (allowed) AND email + name (silently
        # ignored — Google-sourced).
        r = client.put(
            f"/api/users/{member_id}",
            json={"title": "Tech", "phone": "555-9999",
                  "email": "hacker@evil.com", "name": "Hacker",
                  "pictureUrl": "http://evil/x.png"},
            cookies={"ltp_session": admin_tok},
        )
        _check("returns 200", r.status_code == 200, f"got {r.status_code}")
        updated = r.json()
        _check("title updated", updated["title"] == "Tech")
        _check("phone updated", updated["phone"] == "555-9999")
        _check("email NOT changed", updated["email"] == seeded["email"])
        _check("name NOT changed", updated["name"] == seeded["name"])
    finally:
        pass  # client lifecycle is module-level; see _teardown_client


def test_update_user_role_validation():
    print("test_update_user_role_validation")
    client, admin_tok, _, _, member_id = _setup_test_client()
    try:  # noqa: SIM105 — keep the explicit try/finally; we used to teardown per-test
        # Invalid role: 400
        r = client.put(f"/api/users/{member_id}", json={"role": "super"},
                       cookies={"ltp_session": admin_tok})
        _check("invalid role rejected", r.status_code == 400, f"got {r.status_code}")

        # Promote to admin: 200
        r = client.put(f"/api/users/{member_id}", json={"role": "admin"},
                       cookies={"ltp_session": admin_tok})
        _check("promote member→admin: 200", r.status_code == 200, f"got {r.status_code}")
        _check("role updated", r.json()["role"] == "admin")
    finally:
        pass  # client lifecycle is module-level; see _teardown_client


def test_update_user_blocks_self_demotion():
    print("test_update_user_blocks_self_demotion")
    client, admin_tok, _, admin_id, _ = _setup_test_client()
    try:  # noqa: SIM105 — keep the explicit try/finally; we used to teardown per-test
        r = client.put(f"/api/users/{admin_id}", json={"role": "member"},
                       cookies={"ltp_session": admin_tok})
        _check("self-demote rejected", r.status_code == 400, f"got {r.status_code}")
        body = r.json()
        # detail.reason should mention "cannot demote yourself"
        detail = body.get("detail", {})
        reason = detail.get("reason", "") if isinstance(detail, dict) else str(detail)
        _check("error explains self-demote", "demote" in reason.lower(), f"reason={reason!r}")
    finally:
        pass  # client lifecycle is module-level; see _teardown_client


def test_update_user_admin_can_demote_other_admin():
    print("test_update_user_admin_can_demote_other_admin")
    client, admin_tok, _, _, member_id = _setup_test_client()
    try:  # noqa: SIM105 — keep the explicit try/finally; we used to teardown per-test
        # Promote member to admin first
        client.put(f"/api/users/{member_id}", json={"role": "admin"},
                   cookies={"ltp_session": admin_tok})
        # Now first admin demotes the new admin — should succeed
        r = client.put(f"/api/users/{member_id}", json={"role": "member"},
                       cookies={"ltp_session": admin_tok})
        _check("demote other admin: 200", r.status_code == 200, f"got {r.status_code}")
    finally:
        pass  # client lifecycle is module-level; see _teardown_client


def test_update_user_404_for_unknown_id():
    print("test_update_user_404_for_unknown_id")
    client, admin_tok, _, _, _ = _setup_test_client()
    try:  # noqa: SIM105 — keep the explicit try/finally; we used to teardown per-test
        r = client.put("/api/users/99999", json={"title": "x"},
                       cookies={"ltp_session": admin_tok})
        _check("unknown user 404", r.status_code == 404, f"got {r.status_code}")
    finally:
        pass  # client lifecycle is module-level; see _teardown_client


# ── PUT /api/settings emailSignatureTemplate sanitization ────────────────


def test_settings_sanitizes_signature_template():
    print("test_settings_sanitizes_signature_template")
    client, admin_tok, _, _, _ = _setup_test_client()
    try:  # noqa: SIM105 — keep the explicit try/finally; we used to teardown per-test
        # Send a signature with an XSS attempt + a legitimate <p> + an
        # <a href="javascript:..."> attack.
        evil = ('<p>Best, {{userName}}<script>alert(1)</script></p>'
                '<a href="javascript:steal()">click</a>')
        r = client.put(
            "/api/settings",
            json={"emailSignatureTemplate": evil},
            cookies={"ltp_session": admin_tok},
        )
        _check("settings PUT 200", r.status_code == 200, f"got {r.status_code}")
        stored = r.json().get("emailSignatureTemplate", "")
        _check("<script> tag stripped", "<script" not in stored)
        _check("javascript: URL stripped", "javascript:" not in stored)
        _check("legitimate <p> preserved", "<p>" in stored)
        _check("user placeholder preserved", "{{userName}}" in stored)

        # Idempotency: round-trip should be stable
        r2 = client.put(
            "/api/settings",
            json={"emailSignatureTemplate": stored},
            cookies={"ltp_session": admin_tok},
        )
        stored2 = r2.json().get("emailSignatureTemplate", "")
        _check("sanitization idempotent", stored == stored2)
    finally:
        pass  # client lifecycle is module-level; see _teardown_client


# ── Main ─────────────────────────────────────────────────────────────────


def main() -> int:
    try:
        test_list_users_requires_admin()
        test_list_users_shape_and_no_token_leak()
        test_update_user_requires_admin()
        test_update_user_whitelists_fields()
        test_update_user_role_validation()
        test_update_user_blocks_self_demotion()
        test_update_user_admin_can_demote_other_admin()
        test_update_user_404_for_unknown_id()
        test_settings_sanitizes_signature_template()
    finally:
        _teardown_client()

    fail_count = sum(1 for _, ok in _results if not ok)
    print()
    print(f"== {len(_results) - fail_count}/{len(_results)} checks passed ==")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
