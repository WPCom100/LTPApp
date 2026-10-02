"""A recalled quote's share link stops showing the quote.

Once a quote is sent the client holds a link. Recalling it to draft (to edit)
must not leave that link rendering the document — the client would watch the
edits land — nor let them accept/decline a draft, which would knock it out of
the draft → sent → accepted/declined pipeline.

A recalled quote is status "draft" with the sentDate the send stamped (the
recall leaves it alone). A never-sent draft has no sentDate. Signed-in staff
are exempt from the stub because the builder's Preview opens this same link.
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_recalled.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

_db_path = os.path.join(_root, "_test_recalled.db")
if os.environ["DATABASE_URL"].endswith("_test_recalled.db") and os.path.exists(_db_path):
    os.remove(_db_path)

from backend import models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402

U_SUB = "recalled-admin-sub"
_TOK = "recalled-admin-session"
CO = 6901
Q_RECALLED = 6902
Q_SENT = 6903
Q_DRAFT = 6904
T_RECALLED = "recalled-quote-share-token"
T_SENT = "recalled-sent-share-token"
T_DRAFT = "recalled-draft-share-token"
ACCEPT = {"clientName": "Pat", "signatureDataUrl": "data:image/png;base64,iVBORw0KGgo" + "A" * 300}

_client = None
_seeded = False


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


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
                admin = models.User(google_sub=U_SUB, email="recalled-admin@biz.com",
                                    name="Recalled Admin", role="admin")
                db.add(admin)
                await db.flush()
                db.add(models.Session(id=hash_session_token(_TOK), user_id=admin.id,
                                      expires_at=datetime.now(timezone.utc) + timedelta(days=7)))
                if await db.get(models.Company, CO) is None:
                    db.add(models.Company(id=CO, name="Secret Co", status="active", is_client=True))
                for qid, status, tok, sent in (
                    (Q_RECALLED, "draft", T_RECALLED, "2026-09-01"),
                    (Q_SENT, "sent", T_SENT, "2026-09-01"),
                    (Q_DRAFT, "draft", T_DRAFT, ""),
                ):
                    if await db.get(models.Quote, qid) is None:
                        db.add(models.Quote(id=qid, company_id=CO, status=status, share_token=tok,
                                            sent_date=sent, sections=[], activity=[],
                                            custom_name="Half-edited price"))
                await db.commit()

        _run(seed())
        _seeded = True
    return _client


def _status(qid):
    from backend.database import async_session

    async def go():
        async with async_session() as db:
            return (await db.get(models.Quote, qid)).status
    return _run(go())


def test_recalled_link_serves_only_the_recalled_stub():
    c = _setup()
    r = c.get(f"/api/view/{T_RECALLED}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["recalled"] is True and body["kind"] == "quote"
    assert set(body) == {"kind", "recalled", "_v"}, f"stub leaked fields: {sorted(body)}"
    assert "Secret Co" not in r.text and "Half-edited" not in r.text


def test_sent_quote_is_unaffected():
    c = _setup()
    body = c.get(f"/api/view/{T_SENT}").json()
    assert not body.get("recalled") and body["entity"]["status"] == "sent"


def test_unsent_draft_is_not_called_recalled():
    c = _setup()
    assert not c.get(f"/api/view/{T_DRAFT}", cookies={"ltp_session": _TOK}).json().get("recalled")


def test_signed_in_staff_still_see_the_document_for_preview():
    c = _setup()
    body = c.get(f"/api/view/{T_RECALLED}?preview=1", cookies={"ltp_session": _TOK}).json()
    assert not body.get("recalled") and body["entity"]["id"] == Q_RECALLED


def test_recalled_view_is_not_tracked():
    c = _setup()
    c.get(f"/api/view/{T_RECALLED}")
    from backend.database import async_session

    async def go():
        async with async_session() as db:
            return (await db.get(models.Quote, Q_RECALLED)).activity
    assert not _run(go()), "a stub render is not a view"


def test_recalled_version_matches_the_stub_and_differs_from_a_live_quote():
    c = _setup()
    stub = c.get(f"/api/view/{T_RECALLED}").json()
    ver = c.get(f"/api/view/{T_RECALLED}/version").json()
    assert ver["doc"] == stub["_v"], "page and poll must agree or the stub banners 'changed'"
    assert ver["doc"] != c.get(f"/api/view/{T_SENT}/version").json()["doc"]


def test_accept_and_decline_are_refused_and_leave_the_draft_alone():
    c = _setup()
    r = c.post(f"/api/view/{T_RECALLED}/accept", json=ACCEPT)
    assert r.status_code == 409 and r.json()["detail"]["status"] == "recalled", r.text
    r = c.post(f"/api/view/{T_RECALLED}/decline", json={"clientName": "Pat"})
    assert r.status_code == 409 and r.json()["detail"]["status"] == "recalled", r.text
    assert _status(Q_RECALLED) == "draft", "the pipeline state must not move"


def test_recalled_pdf_is_refused_to_clients_but_not_staff():
    c = _setup()
    assert c.get(f"/api/view/{T_RECALLED}/pdf").status_code == 410
    assert c.get(f"/api/view/{T_RECALLED}/pdf?preview=1",
                 cookies={"ltp_session": _TOK}).status_code == 200


def test_sent_quote_can_still_be_declined():
    c = _setup()
    r = c.post(f"/api/view/{T_SENT}/decline", json={"clientName": "Pat"})
    assert r.status_code == 200, r.text
    assert _status(Q_SENT) == "declined"
