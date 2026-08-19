"""Server-stamped activity must survive the client's next save.

The frontend holds a whole entity in memory and PUTs it back verbatim — on a
debounce after any state change (components/data-state.js), and explicitly from
modules/invoices.js::persistAndPushQbo. Its `activity` array is a snapshot taken
before any SERVER-side stamp landed:

  - `email_sent`        routes/email.py, on a successful send
  - `qbo_synced`        qbo_sync.py::push_invoice
  - `qbo_estimate_tax`  qbo_sync.py::get_quote_estimate_tax

Writing that snapshot back erased them. A document's own history therefore never
recorded that it had been emailed — the frontend stamps no send entry of its
own, so the send left no trace anywhere — and backend/view_tracking.py
::_recent_email_sent lost the signal it uses to tell an email scanner's prefetch
from a real client open, so a scanner hit inside the 60s window was logged as a
phantom "client viewed".

The update path now unions stored and incoming entries by id. Nothing in the app
deletes an activity entry, so a union cannot resurrect an intentional removal.

Covers:
  - a real /api/email/send stamps email_sent, and a stale client PUT (the exact
    payload the frontend re-sends) no longer erases it.
  - entries the CLIENT authors still persist — the merge is a union, not a
    server-wins overwrite.
  - an edit that legitimately changes other fields still applies.
  - the merge helper's own semantics, including malformed entries.

Runs both as pytest and as a plain script:
    python tests/test_activity_preservation.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_activity_pres.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

_db_path = os.path.join(_root, "_test_activity_pres.db")
for _suffix in ("", "-wal", "-shm"):
    try:
        os.remove(_db_path + _suffix)
    except FileNotFoundError:
        pass

from backend import models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402
from backend.routes.api import _merge_activity  # noqa: E402

_ADMIN_TOK = "activity-pres-admin"
_client = None
_seeded = False
_results: list = []


def _check(label, cond, detail=""):
    _results.append((label, bool(cond)))
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  ({detail})" if detail else ""))
    assert cond, f"{label} {detail}"


def _cookies():
    return {"ltp_session": _ADMIN_TOK}


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
                admin = models.User(google_sub="actpres-admin-sub", email="actpres@biz.com",
                                    name="Activity Admin", role="admin")
                db.add(admin)
                await db.flush()
                db.add(models.Session(id=hash_session_token(_ADMIN_TOK), user_id=admin.id,
                                      expires_at=datetime.now(timezone.utc) + timedelta(days=7)))
                await db.commit()

        asyncio.run(seed())
        _seeded = True
    return _client, _ADMIN_TOK


def _teardown():
    global _client
    if _client is not None:
        _client.__exit__(None, None, None)
        _client = None


def _types(entity):
    return [a.get("type") for a in (entity.get("activity") or [])]


# ── The round trip that used to lose the send ────────────────────────────────

def test_a_stale_client_put_no_longer_erases_the_send_record():
    client, _ = _setup()
    from backend import gmail
    from backend.routes import email as email_route

    created = client.post("/api/invoices", json={
        "clientType": "company", "status": "draft",
        "sections": [{"id": "s1", "label": "Labor",
                      "items": [{"id": "i1", "type": "service", "unitPrice": 100, "qty": 1}]}],
    }, cookies=_cookies()).json()

    real_pdf, real_send = email_route.generate_pdf, gmail.send

    def _fake_pdf(buf, *a, **k):
        buf.write(b"%PDF-1.4 test\n")

    async def _fake_send(*a, **k):
        return {"id": "fake-msg-id"}

    email_route.generate_pdf, gmail.send = _fake_pdf, _fake_send
    try:
        r = client.post("/api/email/send", json={
            "entityType": "invoice", "entityId": created["id"],
            "to": "client@example.com", "subject": "Your invoice",
            "bodyHtml": "<p>Attached.</p>", "attachPdf": True,
        }, cookies=_cookies())
    finally:
        email_route.generate_pdf, gmail.send = real_pdf, real_send
    _check("send succeeded", r.status_code == 200, r.text[:200])

    after_send = client.get(f"/api/invoices/{created['id']}", cookies=_cookies()).json()
    _check("server stamped email_sent", "email_sent" in _types(after_send), str(_types(after_send)))

    # `created` is the copy the frontend has been holding since before the send —
    # exactly what persistAndPushQbo and the debounced save re-send.
    stale = dict(created, status="sent", sentDate="2026-08-19")
    p = client.put(f"/api/invoices/{created['id']}", json=stale, cookies=_cookies())
    _check("stale PUT accepted", p.status_code == 200, p.text[:200])

    final = client.get(f"/api/invoices/{created['id']}", cookies=_cookies()).json()
    _check("email_sent survived the stale PUT", "email_sent" in _types(final), str(_types(final)))
    _check("the edit still applied", final.get("status") == "sent", str(final.get("status")))


def test_client_authored_entries_still_persist():
    # The merge is a union, not server-wins: entries the client writes (saves,
    # status changes, the recall notice) must still reach the row.
    client, _ = _setup()
    created = client.post("/api/invoices", json={"clientType": "company", "status": "draft"},
                          cookies=_cookies()).json()
    mine = {"id": "act-client-1", "date": "2026-08-19", "time": "09:00",
            "type": "saved", "user": "Activity Admin", "message": "Invoice saved"}
    upd = dict(created, activity=list(created.get("activity") or []) + [mine])
    r = client.put(f"/api/invoices/{created['id']}", json=upd, cookies=_cookies())
    _check("PUT accepted", r.status_code == 200, r.text[:200])
    got = client.get(f"/api/invoices/{created['id']}", cookies=_cookies()).json()
    ids = [a.get("id") for a in (got.get("activity") or [])]
    _check("client-authored entry persisted", "act-client-1" in ids, str(ids))


# ── The merge helper itself ──────────────────────────────────────────────────

def test_merge_semantics():
    server = {"id": "es-abc", "type": "email_sent"}
    client_entry = {"id": "act-1", "type": "saved"}

    merged = _merge_activity([client_entry, server], [client_entry])
    _check("a stamp the client never saw is recovered", merged == [client_entry, server], str(merged))

    both = _merge_activity([client_entry, server], [client_entry, server])
    _check("no duplication when the client already has it", both == [client_entry, server], str(both))

    added = {"id": "act-2", "type": "status"}
    grew = _merge_activity([client_entry, server], [client_entry, added])
    _check("client additions kept, stamp appended", grew == [client_entry, added, server], str(grew))

    _check("empty stored is a no-op", _merge_activity([], [client_entry]) == [client_entry])
    _check("empty incoming still recovers stored", _merge_activity([server], []) == [server])
    _check("None-safe", _merge_activity(None, None) == [])
    # Malformed entries (no id, not a dict) must not crash or dedupe wrongly.
    _check("non-dict entries dropped", _merge_activity(["junk", server], [None]) == [server],
           str(_merge_activity(["junk", server], [None])))
    idless = {"type": "legacy", "message": "no id"}
    _check("id-less stored entry is not resurrected (cannot dedupe it)",
           _merge_activity([idless], [client_entry]) == [client_entry])


def main() -> int:
    tests = [
        test_a_stale_client_put_no_longer_erases_the_send_record,
        test_client_authored_entries_still_persist,
        test_merge_semantics,
    ]
    failed = 0
    try:
        for t in tests:
            print(f"\n{t.__name__}:")
            try:
                t()
            except AssertionError as e:
                failed += 1
                print(f"  !! {e}")
    finally:
        _teardown()
    total = len(_results)
    bad = sum(1 for _, ok in _results if not ok)
    print(f"\nactivity-preservation suite — PASS: {total - bad}   FAIL: {bad}")
    return 1 if (bad or failed) else 0


if __name__ == "__main__":
    raise SystemExit(main())
