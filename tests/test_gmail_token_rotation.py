"""Durability of a Google-rotated Gmail refresh token
(backend/gmail.py::refresh_if_needed).

Google occasionally hands back a NEW refresh_token on a refresh and invalidates
the old one at that moment. The code has always said it persists that
"immediately or we'll lose access on the next refresh attempt" — but it only
flushed, so the write lived and died with the caller's transaction. Any caller
rollback after a rotation threw away the only working credential and the user's
Gmail was silently dead until they reconnected by hand.

That rollback is a routine path, not a rare one:
backend/qbo_receipts.py::_send_receipt deletes its EmailRecipient rows and the
poller rolls the whole iteration back whenever a send fails.

Committing the CALLER's session instead is not an option — those recipient rows
are deliberately deleted on failure, and committing would make them permanent
along with their tracking tokens. So the rotated token is written in its own
session, before the caller's transaction has touched the users row.

Runs both as pytest and as a plain script:
    python tests/test_gmail_token_rotation.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "http://localhost:8000/auth/callback")
# Global engine stays harmlessly in-memory; this file drives a private engine.
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from backend import crypto, database, gmail, models  # noqa: E402

_DB_PATH = os.path.join(_here, "scratch_gmail_rotation_test.db")
engine = create_async_engine("sqlite+aiosqlite:///" + _DB_PATH)
async_session = async_sessionmaker(engine, expire_on_commit=False)
# refresh_if_needed opens its OWN session for the rotated-token write, resolved
# from backend.database at call time — point that at this file's engine.
database.async_session = async_session

_results: list[tuple[str, bool]] = []


def _check(label: str, cond: bool, detail: str = "") -> None:
    _results.append((label, bool(cond)))
    status = "PASS" if cond else "FAIL"
    suffix = f"  ({detail})" if detail else ""
    print(f"  [{status}] {label}{suffix}")
    assert cond, f"{label} {detail}"


async def _reset_schema():
    async with engine.begin() as conn:
        await conn.run_sync(models.Base.metadata.drop_all)
        await conn.run_sync(models.Base.metadata.create_all)


class _RotatingResponse:
    """Google's token endpoint handing back a rotated refresh token."""
    status_code = 200
    text = ""

    def json(self):
        return {
            "access_token": "ya29.brand-new-access",
            "refresh_token": "1//ROTATED-BY-GOOGLE",
            "expires_in": 3600,
            "scope": "https://www.googleapis.com/auth/gmail.send",
        }


class _FakeHttpx:
    async def post(self, *a, **kw):
        return _RotatingResponse()


async def _seed_user() -> int:
    async with async_session() as db:
        u = models.User(google_sub="rot-sub", email="rot@example.com", name="Rot",
                        role="admin")
        u.gmail_refresh_token = crypto.encrypt_token("1//ORIGINAL")
        u.gmail_access_token = crypto.encrypt_token("stale-access")
        # Already expired, so refresh_if_needed actually calls Google.
        u.gmail_token_expires_at = datetime.now(timezone.utc) - timedelta(hours=1)
        db.add(u)
        await db.flush()
        uid = u.id
        await db.commit()
        return uid


async def test_rotated_refresh_token_survives_a_caller_rollback():
    print("test_rotated_refresh_token_survives_a_caller_rollback")
    await _reset_schema()
    uid = await _seed_user()

    async with async_session() as db:
        user = await db.get(models.User, uid)
        access = await gmail.refresh_if_needed(
            user, db, client_id="cid", client_secret="csec",
            httpx_client=_FakeHttpx(),
        )
        _check("refresh returned the new access token", access == "ya29.brand-new-access")
        # Exactly what the receipt poller does when a send fails.
        await db.rollback()

    async with async_session() as db:
        user = await db.get(models.User, uid)
        stored = crypto.decrypt_token(user.gmail_refresh_token)
        _check("rotated refresh token is still in the DB after the rollback",
               stored == "1//ROTATED-BY-GOOGLE", stored)


async def test_refresh_without_rotation_leaves_the_stored_token_alone():
    """Google usually returns NO refresh_token. The stored one must survive
    untouched — the independent write must not fire on this path."""
    print("test_refresh_without_rotation_leaves_the_stored_token_alone")
    await _reset_schema()
    uid = await _seed_user()

    class _NoRotation(_RotatingResponse):
        def json(self):
            d = super().json()
            d.pop("refresh_token")
            return d

    class _Client:
        async def post(self, *a, **kw):
            return _NoRotation()

    async with async_session() as db:
        user = await db.get(models.User, uid)
        await gmail.refresh_if_needed(user, db, client_id="cid", client_secret="csec",
                                      httpx_client=_Client())
        await db.commit()

    async with async_session() as db:
        user = await db.get(models.User, uid)
        _check("original refresh token preserved when Google rotates nothing",
               crypto.decrypt_token(user.gmail_refresh_token) == "1//ORIGINAL")


def main() -> int:
    asyncio.run(test_rotated_refresh_token_survives_a_caller_rollback())
    asyncio.run(test_refresh_without_rotation_leaves_the_stored_token_alone())
    fail_count = sum(1 for _, ok in _results if not ok)
    print()
    print(f"== {len(_results) - fail_count}/{len(_results)} checks passed ==")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
