"""Crew request backend — tokenized accept/decline + producer send/withdraw.

Covers the full state machine and security posture of backend/routes/crew.py:

  - send (whole project) flips this crew member's OPEN positions → requested
    and leaves other crew's positions untouched
  - public GET /api/crew/{token} returns an allow-listed payload: this crew
    member's shifts only, role labels resolved server-side, NO token echoed,
    NO crewId/serviceId internals, NO other crew's slots
  - accept → positions accepted + request accepted; idempotent (409 on replay)
  - decline → positions declined
  - withdraw (pending) → positions back to open; 409 once answered
  - split: positionIds subset requests only those positions
  - guards: non-crew contact, crew without email, no-sendable-positions, and
    short/garbage tokens

Each test owns a dedicated project so the tests are order-independent. Uses
real asserts (pytest-native) so a regression actually fails the run. Runs
file-by-file (own DATABASE_URL); also runnable as a script.
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_crew.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

# Fresh DB so the full migration stack (incl. crew_requests) runs from scratch.
_db_path = os.path.join(_root, "_test_crew.db")
if os.path.exists(_db_path):
    os.remove(_db_path)

from backend import models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402


# ── Seeded fixture IDs (one project per test → order-independent) ────────────
C1 = 9001   # crew, has email
C2 = 9002   # crew, NO email
C3 = 9003   # NOT crew (a company contact)
S1 = 8001   # service: L1 — Lead Lighting Tech

P_SEND     = 7001   # send-whole + cross-crew isolation
P_PAYLOAD  = 7002   # public payload allow-list
P_ACCEPT   = 7003   # accept + idempotency
P_DECLINE  = 7004   # decline
P_WITHDRAW = 7005   # withdraw pending
P_ANSWERED = 7006   # withdraw-after-answer (409)
P_SPLIT    = 7007   # subset send
P_CONFIRM  = 7008   # no-sendable (already confirmed)

_ADMIN_TOK = "crew-admin-session"
_client = None
_seeded = False


def _setup():
    """Boot the TestClient once and seed fixtures once. Returns (client, tok)."""
    global _client, _seeded
    if _client is None:
        from fastapi.testclient import TestClient
        from backend.main import app
        _client = TestClient(app)
        _client.__enter__()

    if not _seeded:
        from backend.database import async_session

        def _pos(pid, crew, status="open", service=None, role=""):
            return {"id": pid, "role": role, "serviceId": service, "crewId": crew, "status": status}

        def _shift(sid, title, date, positions):
            return {"id": sid, "title": title, "date": date, "time": "10:00",
                    "endTime": "14:00", "positions": positions}

        async def seed():
            async with async_session() as db:
                admin = models.User(google_sub="crew-admin-sub", email="crew-admin@biz.com",
                                    name="Crew Admin", role="admin")
                db.add(admin)
                await db.flush()
                db.add(models.Session(id=hash_session_token(_ADMIN_TOK), user_id=admin.id,
                                      expires_at=datetime.now(timezone.utc) + timedelta(days=7)))

                db.add(models.Contact(id=C1, first_name="Casey", last_name="Crew",
                                      email="casey@crew.com", is_crew=True, crew_status="active"))
                db.add(models.Contact(id=C2, first_name="Noemail", last_name="Crew",
                                      email="", is_crew=True, crew_status="active"))
                db.add(models.Contact(id=C3, first_name="Client", last_name="Person",
                                      email="client@co.com", is_crew=False))
                db.add(models.Service(id=S1, role="L1", description="Lead Lighting Tech",
                                      department="Lighting"))

                # P_SEND: two C1 positions + a third on a 2nd shift, plus one
                # position belonging to a DIFFERENT crew member (C2).
                db.add(models.Project(id=P_SEND, name="Gala Send", venue="Grand Hall",
                                      start_date="2026-07-01", end_date="2026-07-02", schedule=[
                    _shift("sh1", "Load In", "2026-07-01",
                           [_pos("p1a", C1, service=S1), _pos("p1b", C1, role="Grip")]),
                    _shift("sh2", "Show", "2026-07-02",
                           [_pos("p1c", C1, service=S1), _pos("p1x", C2, service=S1)]),
                ]))
                db.add(models.Project(id=P_PAYLOAD, name="Gala Payload", venue="Ballroom", schedule=[
                    _shift("s2", "Show", "2026-07-05",
                           [_pos("p2a", C1, service=S1), _pos("p2b", C1, service=S1)]),
                ]))
                db.add(models.Project(id=P_ACCEPT, name="Gala Accept", schedule=[
                    _shift("s3", "Show", "2026-07-08",
                           [_pos("p3a", C1, service=S1), _pos("p3b", C1, service=S1)]),
                ]))
                db.add(models.Project(id=P_DECLINE, name="Gala Decline", schedule=[
                    _shift("s4", "Show", "2026-07-10",
                           [_pos("p4a", C1, service=S1), _pos("p4b", C1)]),
                ]))
                db.add(models.Project(id=P_WITHDRAW, name="Gala Withdraw", schedule=[
                    _shift("s5", "Show", "2026-07-12", [_pos("p5a", C1, service=S1)]),
                ]))
                db.add(models.Project(id=P_ANSWERED, name="Gala Answered", schedule=[
                    _shift("s6", "Show", "2026-07-14", [_pos("p6a", C1, service=S1)]),
                ]))
                db.add(models.Project(id=P_SPLIT, name="Gala Split", schedule=[
                    _shift("s7", "Show", "2026-07-16",
                           [_pos("p7a", C1, service=S1), _pos("p7b", C1, service=S1)]),
                ]))
                db.add(models.Project(id=P_CONFIRM, name="Gala Confirm", schedule=[
                    _shift("s8", "Show", "2026-07-18",
                           [_pos("p8a", C1, service=S1, status="confirmed")]),
                ]))
                await db.commit()

        asyncio.run(seed())
        _seeded = True
    return _client, _ADMIN_TOK


def _teardown():
    global _client
    if _client is not None:
        _client.__exit__(None, None, None)
        _client = None


# ── Helpers ─────────────────────────────────────────────────────────────────

def _project(client, tok, pid):
    return client.get(f"/api/projects/{pid}", cookies={"ltp_session": tok}).json()


def _pos_status(project_json, pos_id):
    for sh in project_json.get("schedule", []):
        for p in sh.get("positions", []):
            if p.get("id") == pos_id:
                return p.get("status")
    return None


def _send(client, tok, pid, cid, position_ids=None):
    body = {"projectId": pid, "contactId": cid}
    if position_ids is not None:
        body["positionIds"] = position_ids
    return client.post("/api/crew-requests/send", json=body, cookies={"ltp_session": tok})


# ── send (whole project) ────────────────────────────────────────────────────

def test_send_whole_project_requests_only_this_crews_positions():
    client, tok = _setup()
    r = _send(client, tok, P_SEND, C1)
    assert r.status_code == 200, r.text
    req = r.json()
    assert req["status"] == "pending"
    assert set(req["positionIds"]) == {"p1a", "p1b", "p1c"}, req["positionIds"]
    assert req["token"] and len(req["token"]) >= 32

    proj = _project(client, tok, P_SEND)
    assert _pos_status(proj, "p1a") == "requested"
    assert _pos_status(proj, "p1b") == "requested"
    assert _pos_status(proj, "p1c") == "requested"
    # The OTHER crew member's position must be left untouched.
    assert _pos_status(proj, "p1x") == "open"


def test_send_guards_non_crew_no_email_and_no_sendable():
    client, tok = _setup()
    # Not a crew member.
    r = _send(client, tok, P_SEND, C3)
    assert r.status_code == 400 and "crew member" in r.text, r.text
    # Crew member with no email on file.
    r = _send(client, tok, P_SEND, C2)
    assert r.status_code == 400 and "email" in r.text, r.text
    # Crew member whose only position is already confirmed (non-sendable).
    r = _send(client, tok, P_CONFIRM, C1)
    assert r.status_code == 400 and "sendable" in r.text, r.text


def test_send_unauthenticated_is_rejected():
    client, _ = _setup()
    r = client.post("/api/crew-requests/send", json={"projectId": P_SEND, "contactId": C1})
    assert r.status_code in (401, 403), r.status_code


# ── public GET payload (allow-list) ─────────────────────────────────────────

def test_public_payload_is_allow_listed():
    client, tok = _setup()
    token = _send(client, tok, P_PAYLOAD, C1).json()["token"]
    # PUBLIC fetch — no session cookie.
    r = client.get(f"/api/crew/{token}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["crewName"] == "Casey Crew"
    assert body["status"] == "pending"
    assert body["project"]["name"] == "Gala Payload"
    assert len(body["shifts"]) == 2
    # Role label resolved server-side from the service catalog.
    assert body["shifts"][0]["roleLabel"] == "L1 — Lead Lighting Tech"
    assert body["settings"] is not None and "companyName" in body["settings"]

    raw = r.text
    # The token is the credential — it must NEVER be echoed back.
    assert token not in raw, "token leaked in public payload"
    # No internal/foreign keys in the payload.
    for banned in ("crewId", "serviceId", "contactId", "companyId", "respondentIp", "cost"):
        assert banned not in raw, f"{banned} leaked in public payload"


def test_short_or_unknown_token_is_404():
    client, _ = _setup()
    assert client.get("/api/crew/short").status_code == 404
    assert client.get("/api/crew/" + "z" * 40).status_code == 404


# ── accept ──────────────────────────────────────────────────────────────────

def test_accept_sets_positions_accepted_and_is_idempotent():
    client, tok = _setup()
    token = _send(client, tok, P_ACCEPT, C1).json()["token"]

    r = client.post(f"/api/crew/{token}/accept", json={"comment": "See you there"})
    assert r.status_code == 200 and r.json()["status"] == "accepted", r.text

    proj = _project(client, tok, P_ACCEPT)
    assert _pos_status(proj, "p3a") == "accepted"
    assert _pos_status(proj, "p3b") == "accepted"

    # Idempotency: a second accept (or a decline) is locked with 409 + status.
    again = client.post(f"/api/crew/{token}/accept", json={})
    assert again.status_code == 409 and again.json()["detail"]["status"] == "accepted"
    assert client.post(f"/api/crew/{token}/decline", json={}).status_code == 409

    # The accepted decision + comment are reflected on the public payload.
    body = client.get(f"/api/crew/{token}").json()
    assert body["status"] == "accepted"
    assert body["comment"] == "See you there"


# ── decline ─────────────────────────────────────────────────────────────────

def test_decline_sets_positions_declined():
    client, tok = _setup()
    token = _send(client, tok, P_DECLINE, C1).json()["token"]
    r = client.post(f"/api/crew/{token}/decline", json={"comment": "Booked elsewhere"})
    assert r.status_code == 200 and r.json()["status"] == "declined", r.text
    proj = _project(client, tok, P_DECLINE)
    assert _pos_status(proj, "p4a") == "declined"
    assert _pos_status(proj, "p4b") == "declined"


# ── withdraw ────────────────────────────────────────────────────────────────

def test_withdraw_pending_reopens_positions():
    client, tok = _setup()
    req = _send(client, tok, P_WITHDRAW, C1).json()
    assert _pos_status(_project(client, tok, P_WITHDRAW), "p5a") == "requested"

    r = client.post(f"/api/crew-requests/{req['id']}/withdraw", cookies={"ltp_session": tok})
    assert r.status_code == 200 and r.json()["status"] == "withdrawn", r.text
    assert _pos_status(_project(client, tok, P_WITHDRAW), "p5a") == "open"


def test_withdraw_after_answer_is_blocked():
    client, tok = _setup()
    req = _send(client, tok, P_ANSWERED, C1).json()
    assert client.post(f"/api/crew/{req['token']}/accept", json={}).status_code == 200
    r = client.post(f"/api/crew-requests/{req['id']}/withdraw", cookies={"ltp_session": tok})
    assert r.status_code == 409, r.text


# ── split (subset send) ─────────────────────────────────────────────────────

def test_split_sends_only_selected_positions():
    client, tok = _setup()
    req = _send(client, tok, P_SPLIT, C1, position_ids=["p7a"]).json()
    assert set(req["positionIds"]) == {"p7a"}
    proj = _project(client, tok, P_SPLIT)
    assert _pos_status(proj, "p7a") == "requested"
    assert _pos_status(proj, "p7b") == "open"   # unsent → stays open


def main() -> int:
    tests = [
        test_send_whole_project_requests_only_this_crews_positions,
        test_send_guards_non_crew_no_email_and_no_sendable,
        test_send_unauthenticated_is_rejected,
        test_public_payload_is_allow_listed,
        test_short_or_unknown_token_is_404,
        test_accept_sets_positions_accepted_and_is_idempotent,
        test_decline_sets_positions_declined,
        test_withdraw_pending_reopens_positions,
        test_withdraw_after_answer_is_blocked,
        test_split_sends_only_selected_positions,
    ]
    failed = 0
    try:
        for t in tests:
            try:
                t()
                print(f"  [PASS] {t.__name__}")
            except Exception as e:
                failed += 1
                print(f"  [FAIL] {t.__name__}: {e!r}")
    finally:
        _teardown()
    print(f"\n== {len(tests) - failed}/{len(tests)} tests passed ==")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
