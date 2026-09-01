"""Tests covering commit 3 of the email feature: client-view tracking.

  - view_tracking.should_log_view 7-step gate (each gate path)
  - bot UA regex coverage on real-world strings
  - email_sent recency window
  - in-memory debounce key
  - recipient lookup with entity-mismatch protection
  - auth_deps.get_optional_user (non-raising session probe)
  - view.py activity-stamping helpers + open_count bumping
  - full HTTP roundtrip via TestClient: anonymous view, recipient view,
    preview=1 suppression, bot UA suppression

Runs as a plain script:
    python tests/test_commit3_view_tracking.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, AsyncMock

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_commit3.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

# Clean test DB before importing backend (init_db needs an empty file)
_db_path = os.path.join(_root, "_test_commit3.db")
if os.path.exists(_db_path):
    os.remove(_db_path)

from backend import models, view_tracking  # noqa: E402
from backend.routes.view import (  # noqa: E402
    _stamp_tracked_open, _bump_recipient_open, _bump_recipient_pdf,
)


_results: list[tuple[str, bool]] = []


def _check(label: str, cond: bool, detail: str = "") -> None:
    _results.append((label, cond))
    status = "PASS" if cond else "FAIL"
    suffix = f"  ({detail})" if detail else ""
    print(f"  [{status}] {label}{suffix}")
    assert cond, f"{label} {detail}"


# Fake request scaffolding for the gate tests — we mock just enough of
# FastAPI Request that view_tracking helpers see what they expect.

def _fake_request(
    *, method="GET", accept="text/html", ua="Mozilla/5.0 (Windows)",
    query: dict | None = None,
):
    """Build a MagicMock that quacks like a FastAPI Request for the gate."""
    req = MagicMock()
    req.method = method
    req.headers = {"accept": accept, "user-agent": ua}
    qp = {}
    if query:
        qp.update(query)
    req.query_params = qp
    # scope is used by extract_client_meta → _client_ip
    req.scope = {
        "headers": [(b"x-forwarded-for", b"203.0.113.5")],
        "client": ("127.0.0.1", 12345),
    }
    return req


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── view_tracking gate ─────────────────────────────────────────────────────


def test_accepts_html_logic():
    print("test_accepts_html_logic")
    _check("text/html in Accept → True",
           view_tracking._accepts_html(_fake_request(accept="text/html,application/xml")))
    _check("*/* in Accept → True",
           view_tracking._accepts_html(_fake_request(accept="*/*")))
    _check("empty Accept → True (default)",
           view_tracking._accepts_html(_fake_request(accept="")))
    _check("application/json only → False",
           not view_tracking._accepts_html(_fake_request(accept="application/json")))
    _check("image/png only → False",
           not view_tracking._accepts_html(_fake_request(accept="image/png")))


def test_bot_ua_regex_real_strings():
    print("test_bot_ua_regex_real_strings")
    real_bots = [
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        "Mozilla/5.0 GoogleImageProxy",
        "Mimecast Link Scanner",
        "Mozilla/5.0 (compatible; Outlook-iOS/1.0)",
        "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 SafeLinks-Outlook",
        "curl/7.88.1",
        "python-requests/2.31.0",
        "Mozilla/5.0 (compatible; Slackbot-LinkExpanding 1.0; ...)",
        "facebookexternalhit/1.1",
        "Mozilla/5.0 (Mobile; rv:106.0) ProofpointLink",
        "HeadlessChrome/120.0.0.0",
    ]
    for ua in real_bots:
        _check(f"detects: {ua[:50]!r}", view_tracking._is_scanner_ua(ua))

    humans = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
    ]
    for ua in humans:
        _check(f"passes: {ua[:50]!r}", not view_tracking._is_scanner_ua(ua))

    _check("empty UA treated as suspicious", view_tracking._is_scanner_ua(""))
    _check("None UA treated as suspicious", view_tracking._is_scanner_ua(None))


def test_recent_email_sent():
    print("test_recent_email_sent")
    now = datetime(2026, 6, 19, 14, 30, 0, tzinfo=timezone.utc)
    # email_sent 30s ago — within 60s window → True
    activity = [{
        "type": "email_sent",
        "date": "2026-06-19",
        "time": "14:30",  # current minute
    }]
    _check("entry in current minute → True",
           view_tracking._recent_email_sent(activity, now))

    activity = [{
        "type": "email_sent",
        "date": "2026-06-19",
        "time": "14:25",  # 5 minutes ago
    }]
    _check("entry 5min ago → False",
           not view_tracking._recent_email_sent(activity, now))

    _check("empty activity → False",
           not view_tracking._recent_email_sent([], now))
    _check("None activity → False",
           not view_tracking._recent_email_sent(None, now))

    # Other entry types shouldn't trigger
    activity = [{
        "type": "client_accepted",
        "date": "2026-06-19",
        "time": "14:30",
    }]
    _check("client_accepted in current minute → False",
           not view_tracking._recent_email_sent(activity, now))

    # Malformed entries skipped
    activity = [
        {"type": "email_sent"},  # no date
        "not a dict",
        {"type": "email_sent", "date": "BAD-DATE", "time": "14:30"},
    ]
    _check("malformed entries don't crash",
           not view_tracking._recent_email_sent(activity, now))


def test_debounce_logic():
    print("test_debounce_logic")
    seen = {}
    now = _now()
    key = ("quote", 1, "view", "anon")
    _check("first call → not debounced",
           not view_tracking._debounce_check_and_mark(seen, key, now))
    _check("second call immediately → debounced",
           view_tracking._debounce_check_and_mark(seen, key, now + timedelta(seconds=10)))
    _check("after 25h → not debounced",
           not view_tracking._debounce_check_and_mark(seen, key, now + timedelta(hours=25)))


def test_debounce_pruning():
    """Confirm the dict doesn't grow unbounded. We add >256 entries with
    very old timestamps then a fresh one; the prune should kick in."""
    print("test_debounce_pruning")
    seen = {}
    very_old = _now() - timedelta(hours=72)  # 3 days ago
    for i in range(300):
        view_tracking._debounce_check_and_mark(seen, ("k", i, "x"), very_old)
    fresh = _now()
    view_tracking._debounce_check_and_mark(seen, ("FRESH",), fresh)
    _check("size pruned after threshold", len(seen) < 300)
    _check("fresh entry survived", ("FRESH",) in seen)


def test_should_log_view_all_gates():
    print("test_should_log_view_all_gates")
    now = _now()
    seen = {}

    # Baseline: clean human visit, no recent email, fresh debounce key
    base_args = dict(
        request=_fake_request(),
        optional_user=None,
        entity_activity=[],
        debounce_seen=seen,
        debounce_key=("quote", 1, "view", "anon"),
        now=now,
    )
    _check("baseline clean human → True",
           view_tracking.should_log_view(**base_args))

    # Re-run after a successful log → debounce kicks in
    _check("immediate re-log → False (debounce)",
           not view_tracking.should_log_view(**base_args))

    # Reset debounce dict for next checks
    base_args["debounce_seen"] = {}

    # Step 1: HEAD
    args = dict(base_args, request=_fake_request(method="HEAD"))
    _check("HEAD → False", not view_tracking.should_log_view(**args))

    # Step 2: non-HTML Accept
    args = dict(base_args, debounce_seen={},
                request=_fake_request(accept="application/json"))
    _check("non-HTML accept → False", not view_tracking.should_log_view(**args))

    # Step 3: ?preview=1
    args = dict(base_args, debounce_seen={},
                request=_fake_request(query={"preview": "1"}))
    _check("preview=1 → False", not view_tracking.should_log_view(**args))

    # Step 4: internal user
    args = dict(base_args, debounce_seen={},
                optional_user=MagicMock(spec=models.User))
    _check("internal user → False", not view_tracking.should_log_view(**args))

    # Step 5: bot UA
    args = dict(base_args, debounce_seen={},
                request=_fake_request(ua="Googlebot/2.1"))
    _check("bot UA → False", not view_tracking.should_log_view(**args))

    # Step 6: recent email_sent
    args = dict(base_args, debounce_seen={},
                entity_activity=[{"type": "email_sent",
                                  "date": now.strftime("%Y-%m-%d"),
                                  "time": now.strftime("%H:%M")}])
    _check("recent email_sent → False", not view_tracking.should_log_view(**args))


# ── lookup_recipient ──────────────────────────────────────────────────────


async def test_lookup_recipient_resolution():
    print("test_lookup_recipient_resolution")
    # Use an in-memory async engine for this test
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from backend.database import Base

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    Session = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with Session() as db:
        # Seed a recipient row
        rec = models.EmailRecipient(
            entity_type="quote", entity_id=42,
            share_token="qtok",
            recipient_email="alice@biz.com", recipient_role="to",
            tracking_token="track-abc-123",
            sent_at=_now(), sent_by_user_id=None,
        )
        db.add(rec)
        await db.flush()

        # Correct (token, entity_type, entity_id) → resolves
        out = await view_tracking.lookup_recipient(db, "track-abc-123", "quote", 42)
        _check("correct token + entity → row", out is not None and out.recipient_email == "alice@biz.com")

        # Unknown token → None
        out = await view_tracking.lookup_recipient(db, "no-such-token", "quote", 42)
        _check("unknown token → None", out is None)

        # Known token but wrong entity_type → None (entity-mismatch defense)
        out = await view_tracking.lookup_recipient(db, "track-abc-123", "invoice", 42)
        _check("wrong entity_type → None", out is None)

        # Known token but wrong entity_id → None
        out = await view_tracking.lookup_recipient(db, "track-abc-123", "quote", 999)
        _check("wrong entity_id → None", out is None)

        # Empty token → None
        out = await view_tracking.lookup_recipient(db, "", "quote", 42)
        _check("empty token → None", out is None)

    await engine.dispose()


# ── Activity stamping helpers ─────────────────────────────────────────────


def test_stamp_tracked_open_recipient_opened():
    print("test_stamp_tracked_open_recipient_opened")
    class FakeEntity:
        activity = []

    e = FakeEntity()
    e.activity = []
    rec = MagicMock()
    rec.recipient_email = "alice@biz.com"

    # flag_modified runs inside backend.activity.append_activity; patch it there
    # so the test doesn't need a real ORM row.
    import backend.activity as activity_mod
    real_flag = activity_mod.flag_modified
    activity_mod.flag_modified = lambda *a, **k: None
    try:
        entry = _stamp_tracked_open(
            entity=e, kind="quote", recipient=rec,
            ip="203.0.113.5", ua="Mozilla",
            action="view", now=datetime(2026, 6, 19, 14, 30, tzinfo=timezone.utc),
        )
    finally:
        activity_mod.flag_modified = real_flag

    _check("type recipient_opened", entry["type"] == "recipient_opened")
    _check("id prefix ro-", entry["id"].startswith("ro-"))
    _check("user is recipient email", entry["user"] == "alice@biz.com")
    _check("userId is None", entry["userId"] is None)
    _check("message contains email", "alice@biz.com" in entry["message"])
    cats = {c["cat"]: c["detail"] for c in entry["changes"]}
    _check("Recipient in changes", cats.get("Recipient") == "alice@biz.com")
    _check("IP in changes", cats.get("IP") == "203.0.113.5")
    _check("UA in changes", cats.get("User-Agent") == "Mozilla")
    _check("appended to entity.activity", len(e.activity) == 1)


def test_stamp_tracked_open_anonymous_view():
    print("test_stamp_tracked_open_anonymous_view")
    class FakeEntity:
        activity = []
    e = FakeEntity(); e.activity = []
    import backend.activity as activity_mod
    real_flag = activity_mod.flag_modified
    activity_mod.flag_modified = lambda *a, **k: None
    try:
        entry = _stamp_tracked_open(
            entity=e, kind="quote", recipient=None,
            ip="203.0.113.5", ua="Mozilla",
            action="view", now=_now(),
        )
    finally:
        activity_mod.flag_modified = real_flag
    _check("anonymous type client_viewed", entry["type"] == "client_viewed")
    _check("id prefix cv-", entry["id"].startswith("cv-"))
    _check("user is Anonymous viewer", entry["user"] == "Anonymous viewer")
    cats = {c["cat"]: c["detail"] for c in entry["changes"]}
    _check("no Recipient cat for anonymous", "Recipient" not in cats)
    _check("IP still in changes", cats.get("IP") == "203.0.113.5")


def test_stamp_tracked_open_pdf_variants():
    print("test_stamp_tracked_open_pdf_variants")
    class FakeEntity:
        activity = []
    import backend.activity as activity_mod
    real_flag = activity_mod.flag_modified
    activity_mod.flag_modified = lambda *a, **k: None
    try:
        # Recipient PDF
        e = FakeEntity(); e.activity = []
        rec = MagicMock(); rec.recipient_email = "alice@biz.com"
        entry = _stamp_tracked_open(
            entity=e, kind="invoice", recipient=rec,
            ip="1.1.1.1", ua="x", action="pdf", now=_now(),
        )
        _check("recipient PDF type", entry["type"] == "recipient_downloaded_pdf")
        _check("recipient PDF id prefix rp-", entry["id"].startswith("rp-"))
        _check("PDF message mentions download", "downloaded PDF" in entry["message"])

        # Anonymous PDF
        e = FakeEntity(); e.activity = []
        entry = _stamp_tracked_open(
            entity=e, kind="invoice", recipient=None,
            ip="1.1.1.1", ua="x", action="pdf", now=_now(),
        )
        _check("anonymous PDF type", entry["type"] == "client_downloaded_pdf")
        _check("anonymous PDF id prefix cp-", entry["id"].startswith("cp-"))
    finally:
        activity_mod.flag_modified = real_flag


def test_bump_recipient_open_counts():
    print("test_bump_recipient_open_counts")
    rec = MagicMock()
    rec.open_count = 0
    rec.first_opened_at = None
    rec.last_opened_at = None
    t1 = _now()
    _bump_recipient_open(rec, t1)
    _check("first open_count = 1", rec.open_count == 1)
    _check("first_opened_at set", rec.first_opened_at == t1)
    _check("last_opened_at set", rec.last_opened_at == t1)

    t2 = t1 + timedelta(minutes=5)
    _bump_recipient_open(rec, t2)
    _check("second open_count = 2", rec.open_count == 2)
    _check("first_opened_at unchanged", rec.first_opened_at == t1)
    _check("last_opened_at updated", rec.last_opened_at == t2)


def test_bump_recipient_pdf_first_only():
    print("test_bump_recipient_pdf_first_only")
    rec = MagicMock()
    rec.pdf_downloaded_at = None
    t1 = _now()
    _bump_recipient_pdf(rec, t1)
    _check("first download sets pdf_downloaded_at", rec.pdf_downloaded_at == t1)

    t2 = t1 + timedelta(minutes=5)
    _bump_recipient_pdf(rec, t2)
    _check("second download does NOT overwrite", rec.pdf_downloaded_at == t1)


# ── get_optional_user ─────────────────────────────────────────────────────


async def test_get_optional_user_no_cookie():
    print("test_get_optional_user_no_cookie")
    from backend.auth_deps import get_optional_user
    req = MagicMock()
    req.cookies = {}
    out = await get_optional_user(request=req, db=MagicMock())
    _check("no cookie → None", out is None)


async def test_get_optional_user_valid_session():
    print("test_get_optional_user_valid_session")
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from backend.database import Base
    # sessions.id stores the SHA-256 of the raw cookie token, never the token
    # itself (SECURITY_REVIEW.md L1), so a fixture row must be keyed by
    # hash_session_token(...) or the lookup in _load_session_user can never
    # match it. Seeding the raw token here made "valid session" fail and made
    # "expired session → None" pass for the wrong reason — the row was simply
    # never found, so the expiry branch was never exercised.
    from backend.auth_deps import (
        get_optional_user,
        hash_session_token,
        SESSION_COOKIE_NAME,
    )

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with Session() as db:
        u = models.User(google_sub="g", email="x@y.com", name="X", role="member")
        db.add(u)
        await db.flush()
        sess = models.Session(
            id=hash_session_token("sesstok-123"),
            user_id=u.id,
            expires_at=_now() + timedelta(days=7),
        )
        db.add(sess)
        await db.flush()

        req = MagicMock()
        req.cookies = {SESSION_COOKIE_NAME: "sesstok-123"}
        out = await get_optional_user(request=req, db=db)
        _check("valid session → User row", out is not None and out.email == "x@y.com")

        # Expired session
        sess2 = models.Session(
            id=hash_session_token("expired-123"),
            user_id=u.id,
            expires_at=_now() - timedelta(days=1),
        )
        db.add(sess2)
        await db.flush()
        req.cookies = {SESSION_COOKIE_NAME: "expired-123"}
        out = await get_optional_user(request=req, db=db)
        _check("expired session → None", out is None)

        # Unknown token
        req.cookies = {SESSION_COOKIE_NAME: "no-such-session"}
        out = await get_optional_user(request=req, db=db)
        _check("unknown token → None", out is None)

    await engine.dispose()


# ── Integration test: full HTTP roundtrip ─────────────────────────────────


def test_full_view_roundtrip():
    """Use FastAPI's TestClient against the real app. Seeds a quote +
    recipient, hits /api/view/{token} via each gate path, checks the
    activity feed. Skip if TestClient unavailable."""
    print("test_full_view_roundtrip")
    try:
        from fastapi.testclient import TestClient
    except ImportError:
        _check("TestClient unavailable — skipping integration", True)
        return

    from backend.main import app

    # Spin up + seed
    with TestClient(app) as client:
        # Manually insert a quote + recipient row using the app's engine
        from backend.database import async_session

        async def seed():
            async with async_session() as db:
                q = models.Quote(
                    id=42, share_token="testqtok123456",
                    status="sent", activity=[],
                )
                db.add(q)
                await db.flush()
                rec = models.EmailRecipient(
                    entity_type="quote", entity_id=42,
                    share_token="testqtok123456",
                    recipient_email="alice@biz.com", recipient_role="to",
                    tracking_token="track-zzz-1",
                    sent_at=_now(),
                )
                db.add(rec)
                await db.flush()
                await db.commit()

        asyncio.run(seed())

        # 1. Anonymous human view → should stamp client_viewed
        r = client.get("/api/view/testqtok123456", headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
            "Accept": "text/html",
        })
        _check("anonymous view: 200", r.status_code == 200)
        body = r.json()
        # Activity is sanitized for public view — tracking entries are
        # NOT in PUBLIC_TYPES so they won't appear here, BUT we can
        # query the entity directly to verify the stamp happened.

        async def fetch_quote_activity():
            async with async_session() as db:
                from sqlalchemy import select
                q = await db.execute(select(models.Quote).where(models.Quote.id == 42))
                row = q.scalar_one_or_none()
                return list(row.activity or [])

        acts = asyncio.run(fetch_quote_activity())
        client_viewed_count = sum(1 for a in acts if a.get("type") == "client_viewed")
        _check("client_viewed entry stamped",
               client_viewed_count == 1, f"got {client_viewed_count}")

        # 2. Bot UA → should NOT stamp
        before = len(asyncio.run(fetch_quote_activity()))
        r = client.get("/api/view/testqtok123456", headers={
            "User-Agent": "Googlebot/2.1",
            "Accept": "text/html",
        })
        _check("bot UA: 200 (still serves view)", r.status_code == 200)
        after = len(asyncio.run(fetch_quote_activity()))
        _check("bot UA: no new activity entry", before == after)

        # 3. ?preview=1 → should NOT stamp
        r = client.get("/api/view/testqtok123456?preview=1", headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36",
            "Accept": "text/html",
        })
        before2 = after
        after2 = len(asyncio.run(fetch_quote_activity()))
        _check("preview=1: no new activity entry", before2 == after2)

        # 4. ?r=<tracking_token> → should stamp recipient_opened
        #    But we just stamped a client_viewed entry, which acts as a debounce.
        #    Use a different debounce key — wait, debounce is by (kind, id, action,
        #    "r", tracking_token), so the anonymous one doesn't block this.
        r = client.get(
            "/api/view/testqtok123456?r=track-zzz-1",
            headers={
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2) AppleWebKit/605.1.15 Safari",
                "Accept": "text/html",
            },
        )
        _check("recipient view: 200", r.status_code == 200)
        acts3 = asyncio.run(fetch_quote_activity())
        recipient_opened_count = sum(1 for a in acts3 if a.get("type") == "recipient_opened")
        _check("recipient_opened entry stamped",
               recipient_opened_count == 1, f"got {recipient_opened_count}")

        # 5. Verify open_count was bumped on the EmailRecipient row
        async def fetch_recipient():
            async with async_session() as db:
                from sqlalchemy import select
                r = await db.execute(select(models.EmailRecipient).where(
                    models.EmailRecipient.tracking_token == "track-zzz-1"
                ))
                return r.scalar_one_or_none()
        rec = asyncio.run(fetch_recipient())
        _check("EmailRecipient.open_count bumped", rec.open_count == 1, f"got {rec.open_count}")
        _check("EmailRecipient.first_opened_at set", rec.first_opened_at is not None)
        _check("EmailRecipient.last_opened_at set", rec.last_opened_at is not None)


# ── Main ───────────────────────────────────────────────────────────────────


def main() -> int:
    # Sync tests
    test_accepts_html_logic()
    test_bot_ua_regex_real_strings()
    test_recent_email_sent()
    test_debounce_logic()
    test_debounce_pruning()
    test_should_log_view_all_gates()
    test_stamp_tracked_open_recipient_opened()
    test_stamp_tracked_open_anonymous_view()
    test_stamp_tracked_open_pdf_variants()
    test_bump_recipient_open_counts()
    test_bump_recipient_pdf_first_only()
    # Async tests
    asyncio.run(test_lookup_recipient_resolution())
    asyncio.run(test_get_optional_user_no_cookie())
    asyncio.run(test_get_optional_user_valid_session())
    # Integration
    test_full_view_roundtrip()

    fail_count = sum(1 for _, ok in _results if not ok)
    print()
    print(f"== {len(_results) - fail_count}/{len(_results)} checks passed ==")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
