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
  - direct book ({silent: true}): no email, positions straight to confirmed,
    allowed for crew with no email on file, and closed to resend/withdraw
  - guards: non-crew contact, crew without email, no-sendable-positions, and
    short/garbage tokens

Each test owns a dedicated project so the tests are order-independent. Uses
real asserts (pytest-native) so a regression actually fails the run. Under
pytest the module shares the session-wide DB from tests/conftest.py; run as a
plain script it uses its own DATABASE_URL (the setdefault below).
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
P_EMAIL    = 7009   # email composition (mocked Gmail)
P_RECONN   = 7010   # email best-effort: needsReconnect, request still created
P_LIST     = 7011   # GET /api/crew-requests list shape + project filter
P_RESEND   = 7012   # resend re-emails a pending request
P_RESEND2  = 7013   # resend on a non-pending request → 409
P_NOTIFY   = 7014   # /notify informational template emails
P_STALE    = 7015   # full position removal → auto-withdraw + withdrawn screen
P_STALE2   = 7016   # partial removal → trim, request still answerable
P_DEL      = 7017   # project delete → auto-withdraw
P_WD_NOTIFY = 7018  # withdraw + notify emails the crew member (crewWithdrawn)
P_WD_QUIET  = 7019  # withdraw without notify sends no email
P_UNSCHED   = 7020  # unscheduled day (no date) — never sendable
P_MIXED     = 7021  # one dated + one undated position — send covers only the dated one
P_ADDR      = 7022  # typed site_address flows to the public payload
P_ADDR_CO   = 7023  # site_use_company_address derives the client company's address
CO_ADDR     = 6001  # company with a billing address (for P_ADDR_CO)
P_DRIFT     = 7024  # positions drifted open before the answer → accept still lands
P_ZOMBIE    = 7025  # accepted request whose positions drifted open → list heals
P_FLOOR     = 7026  # stale PUT downgrade blocked; deliberate release passes
P_SILENT    = 7027  # direct book (silent) → confirmed, no email
P_SILENT2   = 7028  # direct book for a crew member with NO email on file
P_SILENT3   = 7029  # a direct book can't be resent or withdrawn

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
                db.add(models.Project(id=P_EMAIL, name="Gala Email", schedule=[
                    _shift("s9", "Load In", "2026-07-20", [_pos("p9a", C1, service=S1)]),
                ]))
                db.add(models.Project(id=P_RECONN, name="Gala Reconnect", schedule=[
                    _shift("s10", "Show", "2026-07-22", [_pos("p10a", C1, service=S1)]),
                ]))
                db.add(models.Project(id=P_LIST, name="Gala List", schedule=[
                    _shift("s11", "Show", "2026-07-24", [_pos("p11a", C1, service=S1)]),
                ]))
                db.add(models.Project(id=P_RESEND, name="Gala Resend", schedule=[
                    _shift("s12", "Show", "2026-07-26", [_pos("p12a", C1, service=S1)]),
                ]))
                db.add(models.Project(id=P_RESEND2, name="Gala Resend2", schedule=[
                    _shift("s13", "Show", "2026-07-28", [_pos("p13a", C1, service=S1)]),
                ]))
                db.add(models.Project(id=P_NOTIFY, name="Gala Notify", schedule=[
                    _shift("s14", "Show", "2026-07-30", [_pos("p14a", C1, service=S1)]),
                ]))
                db.add(models.Project(id=P_STALE, name="Gala Stale", schedule=[
                    _shift("sst", "Show", "2026-08-01",
                           [_pos("pst_a", C1, service=S1), _pos("pst_b", C1, service=S1)]),
                ]))
                db.add(models.Project(id=P_STALE2, name="Gala Stale Partial", schedule=[
                    _shift("st_keep", "Keep", "2026-08-02", [_pos("pk", C1, service=S1)]),
                    _shift("st_drop", "Drop", "2026-08-03", [_pos("pd", C1, service=S1)]),
                ]))
                db.add(models.Project(id=P_DEL, name="Gala Delete", schedule=[
                    _shift("sdl", "Show", "2026-08-05", [_pos("pdl_a", C1, service=S1)]),
                ]))
                db.add(models.Project(id=P_WD_NOTIFY, name="Gala WD Notify", schedule=[
                    _shift("swn", "Show", "2026-08-07", [_pos("pwn_a", C1, service=S1)]),
                ]))
                db.add(models.Project(id=P_WD_QUIET, name="Gala WD Quiet", schedule=[
                    _shift("swq", "Show", "2026-08-09", [_pos("pwq_a", C1, service=S1)]),
                ]))
                # An unscheduled day: a shift with NO date but a crew member
                # already assigned. It must never be sendable for an availability
                # request — the day has to be scheduled first.
                db.add(models.Project(id=P_UNSCHED, name="Gala Unscheduled", schedule=[
                    _shift("sun", "TBD", "", [_pos("pun_a", C1, service=S1)]),
                ]))
                # Mixed: one scheduled day + one unscheduled day, both with a C1
                # position. A whole-project send must cover only the dated one.
                db.add(models.Project(id=P_MIXED, name="Gala Mixed", schedule=[
                    _shift("smx_d", "Show", "2026-08-11", [_pos("pmx_dated", C1, service=S1)]),
                    _shift("smx_u", "TBD", "", [_pos("pmx_undated", C1, service=S1)]),
                ]))
                # Site address: typed directly on the project…
                db.add(models.Project(id=P_ADDR, name="Gala Address", venue="Moody Center",
                                      site_address="2001 Robert Dedman Dr, Austin, TX 78712", schedule=[
                    _shift("sad", "Show", "2026-08-13", [_pos("pad_a", C1, service=S1)]),
                ]))
                # …or derived live from the client company's billing address
                # (multi-line street must flatten to one line).
                db.add(models.Company(id=CO_ADDR, name="Venue Client",
                                      address="500 E Cesar Chavez St\nSuite 2",
                                      city="Austin", state="TX", zip="78701"))
                db.add(models.Project(id=P_ADDR_CO, name="Gala CompanyAddr", company_id=CO_ADDR,
                                      site_use_company_address=True, schedule=[
                    _shift("sac", "Show", "2026-08-15", [_pos("pac_a", C1, service=S1)]),
                ]))
                # Status-drift scenarios (stale full-row saves vs the request
                # pipeline) — see the "status drift" test section below.
                db.add(models.Project(id=P_DRIFT, name="Gala Drift", schedule=[
                    _shift("sdr", "Show", "2026-08-17",
                           [_pos("pdr_a", C1, service=S1), _pos("pdr_b", C1, service=S1)]),
                ]))
                db.add(models.Project(id=P_ZOMBIE, name="Gala Zombie", schedule=[
                    _shift("szo", "Show", "2026-08-19", [_pos("pzo_a", C1, service=S1)]),
                ]))
                db.add(models.Project(id=P_FLOOR, name="Gala Floor", schedule=[
                    _shift("sfl", "Show", "2026-08-21", [_pos("pfl_a", C1, service=S1)]),
                ]))
                # Direct book (silent) — two shifts for C1 plus another crew
                # member's slot, which must stay untouched.
                db.add(models.Project(id=P_SILENT, name="Gala Silent", schedule=[
                    _shift("ssi", "Show", "2026-08-23",
                           [_pos("psi_a", C1, service=S1), _pos("psi_b", C1, service=S1),
                            _pos("psi_x", C2, service=S1)]),
                ]))
                # …and one for the crew member with NO email on file: bookable
                # directly, never sendable.
                db.add(models.Project(id=P_SILENT2, name="Gala Silent NoEmail", schedule=[
                    _shift("ssn", "Show", "2026-08-25", [_pos("psn_a", C2, service=S1)]),
                ]))
                db.add(models.Project(id=P_SILENT3, name="Gala Silent Locked", schedule=[
                    _shift("ssl", "Show", "2026-08-27", [_pos("psl_a", C1, service=S1)]),
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


def _pos_crew(project_json, pos_id):
    for sh in project_json.get("schedule", []):
        for p in sh.get("positions", []):
            if p.get("id") == pos_id:
                return p.get("crewId")
    return None


def _send(client, tok, pid, cid, position_ids=None, silent=None):
    body = {"projectId": pid, "contactId": cid}
    if position_ids is not None:
        body["positionIds"] = position_ids
    if silent is not None:
        body["silent"] = silent
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
    # The response carries the moved project row, token included, so the
    # sending window installs it instead of PUTting its own mirror of the move
    # back under the pre-send If-Match token (which drew a 409 + "Changed in
    # another window" toast for the sender's own change).
    assert req["project"]["id"] == P_SEND
    assert req["project"]["_rev"] == proj["_rev"]
    assert _pos_status(req["project"], "p1a") == "requested"


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


def test_send_for_unscheduled_day_is_rejected():
    # A crew member assigned only to a dateless ("unscheduled") day has no
    # sendable positions — the day must be scheduled before a request can go out.
    client, tok = _setup()
    r = _send(client, tok, P_UNSCHED, C1)
    assert r.status_code == 400 and "sendable" in r.text, r.text
    # The dateless position must NOT have been flipped to requested.
    proj = _project(client, tok, P_UNSCHED)
    assert _pos_status(proj, "pun_a") == "open"


def test_send_skips_unscheduled_positions_in_mixed_project():
    # Whole-project send must cover only the position on the dated day; the
    # position on the unscheduled (dateless) day is left untouched.
    client, tok = _setup()
    r = _send(client, tok, P_MIXED, C1)
    assert r.status_code == 200, r.text
    assert set(r.json()["positionIds"]) == {"pmx_dated"}, r.json()["positionIds"]
    proj = _project(client, tok, P_MIXED)
    assert _pos_status(proj, "pmx_dated") == "requested"
    assert _pos_status(proj, "pmx_undated") == "open"


# ── direct book (silent — no email, no ask) ─────────────────────────────────

def test_silent_send_books_positions_confirmed_without_emailing():
    """{silent: true} books the crew member outright: no email composed or
    sent, positions straight to confirmed, request stored as an already
    answered `accepted` row flagged silent."""
    import backend.gmail as gmailmod
    client, tok = _setup()
    called = {"n": 0}

    async def fake_send(**kwargs):
        called["n"] += 1
        return {"id": "x"}

    orig = gmailmod.send
    gmailmod.send = fake_send
    try:
        r = _send(client, tok, P_SILENT, C1, silent=True)
    finally:
        gmailmod.send = orig

    assert r.status_code == 200, r.text
    body = r.json()
    assert called["n"] == 0                                  # nothing was sent
    assert body["emailStatus"] == {"emailed": False, "silent": True}
    assert body["status"] == "accepted" and body["silent"] is True
    assert body["respondedAt"]                               # already answered
    assert set(body["positionIds"]) == {"psi_a", "psi_b"}

    proj = _project(client, tok, P_SILENT)
    assert _pos_status(proj, "psi_a") == "confirmed"
    assert _pos_status(proj, "psi_b") == "confirmed"
    assert _pos_crew(proj, "psi_a") == C1                    # crew stays attached
    # The direct book's pay stamp is written client-side right after this
    # response; it needs the moved row's token to land, so that row rides along.
    assert body["project"]["_rev"] == proj["_rev"]
    assert _pos_status(body["project"], "psi_a") == "confirmed"
    # Another crew member's slot on the same shift is untouched.
    assert _pos_status(proj, "psi_x") == "open"


def test_silent_send_works_for_crew_without_an_email():
    """The no-email guard is a delivery-address check, so it applies only to a
    real send. A crew member who only takes texts can still be booked."""
    client, tok = _setup()
    r = _send(client, tok, P_SILENT2, C2)                     # normal send → blocked
    assert r.status_code == 400 and "email" in r.text, r.text
    assert _pos_status(_project(client, tok, P_SILENT2), "psn_a") == "open"

    r = _send(client, tok, P_SILENT2, C2, silent=True)        # direct book → allowed
    assert r.status_code == 200, r.text
    assert r.json()["silent"] is True
    assert _pos_status(_project(client, tok, P_SILENT2), "psn_a") == "confirmed"


def test_silent_book_cannot_be_resent_or_withdrawn():
    """A direct book has no outstanding ask, so the chase actions are closed:
    unbooking goes through the Labor status controls like any confirmed
    position."""
    client, tok = _setup()
    req = _send(client, tok, P_SILENT3, C1, silent=True).json()
    r = client.post("/api/crew-requests/" + str(req["id"]) + "/resend", cookies={"ltp_session": tok})
    assert r.status_code == 409, r.text
    r = client.post("/api/crew-requests/" + str(req["id"]) + "/withdraw", cookies={"ltp_session": tok})
    assert r.status_code == 409, r.text
    # Still booked after both refusals.
    assert _pos_status(_project(client, tok, P_SILENT3), "psl_a") == "confirmed"


def test_notify_flags_a_crew_member_with_no_email_as_undeliverable():
    """A notice aimed at someone with no email can never be delivered — flagged
    `noEmail` so the notify tray drops it instead of parking it forever to
    retry (crew booked directly need never have an address on file)."""
    client, tok = _setup()
    r = client.post("/api/crew-requests/notify",
                    json={"contactId": C2, "projectId": P_SILENT2, "template": "crewCancelled",
                          "positionIds": ["psn_a"]},
                    cookies={"ltp_session": tok})
    assert r.status_code == 200, r.text
    es = r.json()["emailStatus"]
    assert es["emailed"] is False and es["noEmail"] is True, es


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


def test_public_payload_carries_typed_site_address():
    client, tok = _setup()
    token = _send(client, tok, P_ADDR, C1).json()["token"]
    r = client.get(f"/api/crew/{token}")
    assert r.status_code == 200, r.text
    assert r.json()["project"]["siteAddress"] == "2001 Robert Dedman Dr, Austin, TX 78712"
    assert r.json()["project"]["venue"] == "Moody Center"


def test_company_address_checkbox_derives_site_address():
    client, tok = _setup()
    token = _send(client, tok, P_ADDR_CO, C1).json()["token"]
    r = client.get(f"/api/crew/{token}")
    assert r.status_code == 200, r.text
    # Multi-line street flattens to one line; city + state/zip appended.
    assert r.json()["project"]["siteAddress"] == "500 E Cesar Chavez St, Suite 2, Austin, TX 78701"


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
    proj = _project(client, tok, P_WITHDRAW)
    assert _pos_status(proj, "p5a") == "requested"
    assert _pos_crew(proj, "p5a") == C1  # assigned before withdraw

    r = client.post(f"/api/crew-requests/{req['id']}/withdraw", cookies={"ltp_session": tok})
    assert r.status_code == 200 and r.json()["status"] == "withdrawn", r.text
    proj = _project(client, tok, P_WITHDRAW)
    assert _pos_status(proj, "p5a") == "open"
    assert _pos_crew(proj, "p5a") is None  # withdraw unassigns the crew member too
    # Like send, withdraw hands back the reopened row for the window to adopt.
    assert r.json()["project"]["_rev"] == proj["_rev"]
    assert _pos_status(r.json()["project"], "p5a") == "open"
    assert _pos_crew(r.json()["project"], "p5a") is None


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


# ── email (best-effort, composed server-side) ──────────────────────────────

def test_send_emails_crew_member_when_gmail_connected():
    import backend.gmail as gmailmod
    client, tok = _setup()
    captured = {}

    async def fake_send(**kwargs):
        captured.update(kwargs)
        return {"id": "msg-123"}

    orig = gmailmod.send
    gmailmod.send = fake_send   # crew.py calls gmail.send(...) at runtime
    try:
        r = _send(client, tok, P_EMAIL, C1)
    finally:
        gmailmod.send = orig

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["emailStatus"]["emailed"] is True
    # Sent to the crew member; subject carries the project name.
    assert captured["to"] == ["casey@crew.com"]
    assert "Gala Email" in captured["subject"]
    html = captured["html_body"]
    # The crew landing link, an Accept/Decline section, and the resolved shift
    # role label are all present in the rendered email.
    assert ("/#/crew/" + body["token"]) in html
    assert "Respond" in html          # single CTA button → the crew landing page
    assert "Lead Lighting Tech" in html
    # Themed, branded shell: default accent (accentColor) + rounded card.
    assert "#EF5822" in html
    assert "border-radius" in html


def test_send_without_gmail_still_creates_request_and_reports_reconnect():
    client, tok = _setup()
    r = _send(client, tok, P_RECONN, C1)   # admin has no Gmail token
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "pending"               # request created
    assert body["emailStatus"]["emailed"] is False
    assert body["emailStatus"].get("needsReconnect") is True
    # Positions still moved to requested despite the email not going out.
    assert _pos_status(_project(client, tok, P_RECONN), "p10a") == "requested"


def test_list_crew_requests_shape_and_filter():
    client, tok = _setup()
    created = _send(client, tok, P_LIST, C1).json()
    # Full list includes the new request with the producer-facing shape.
    allreqs = client.get("/api/crew-requests", cookies={"ltp_session": tok}).json()
    assert isinstance(allreqs, list)
    mine = [r for r in allreqs if r["id"] == created["id"]]
    assert len(mine) == 1
    for k in ("id", "token", "projectId", "contactId", "positionIds", "status", "silent", "sentAt"):
        assert k in mine[0], k
    assert mine[0]["silent"] is False        # a real send is never a direct book
    # ?projectId= narrows to that project only.
    filtered = client.get("/api/crew-requests?projectId=" + str(P_LIST), cookies={"ltp_session": tok}).json()
    assert filtered and all(r["projectId"] == P_LIST for r in filtered)


# ── resend + notify (best-effort, mocked Gmail) ─────────────────────────────

def test_resend_pending_reemails_same_token():
    import backend.gmail as gmailmod
    client, tok = _setup()
    created = _send(client, tok, P_RESEND, C1).json()   # admin has no Gmail → pending, not emailed
    assert created["status"] == "pending"
    captured = {}

    async def fake_send(**kw):
        captured.update(kw)
        return {"id": "rm-1"}

    orig = gmailmod.send
    gmailmod.send = fake_send
    try:
        r = client.post("/api/crew-requests/" + str(created["id"]) + "/resend", cookies={"ltp_session": tok})
    finally:
        gmailmod.send = orig
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "pending"            # unchanged — no new request
    assert body["token"] == created["token"]      # same token re-used
    assert body["emailStatus"]["emailed"] is True
    assert captured["to"] == ["casey@crew.com"]
    assert ("/#/crew/" + created["token"]) in captured["html_body"]


def test_resend_non_pending_is_409():
    client, tok = _setup()
    created = _send(client, tok, P_RESEND2, C1).json()
    client.post("/api/crew/" + created["token"] + "/accept", json={})   # now accepted
    r = client.post("/api/crew-requests/" + str(created["id"]) + "/resend", cookies={"ltp_session": tok})
    assert r.status_code == 409


def test_notify_sends_named_template_email():
    import backend.gmail as gmailmod
    client, tok = _setup()
    captured = {}

    async def fake_send(**kw):
        captured.update(kw)
        return {"id": "nm-1"}

    orig = gmailmod.send
    gmailmod.send = fake_send
    try:
        r = client.post("/api/crew-requests/notify",
                        json={"contactId": C1, "projectId": P_NOTIFY, "template": "crewConfirmed", "positionIds": ["p14a"]},
                        cookies={"ltp_session": tok})
    finally:
        gmailmod.send = orig
    assert r.status_code == 200, r.text
    assert r.json()["emailStatus"]["emailed"] is True
    assert captured["to"] == ["casey@crew.com"]
    assert "Gala Notify" in captured["subject"]
    # Informational — carries NO Accept/Decline crew link.
    assert "/#/crew/" not in captured["html_body"]


def test_notify_confirmed_add_to_calendar_links_to_call_sheet():
    """A crewConfirmed notify with a token carries a single 'Click here to add to
    calendar' button that routes the crew back to their call sheet (where the
    per-shift calendar buttons live) — NOT per-shift Google Calendar links in the
    email itself."""
    import backend.gmail as gmailmod
    client, tok = _setup()
    captured = {}

    async def fake_send(**kw):
        captured.update(kw)
        return {"id": "cal-1"}

    crew_token = "verifyconfirmtoken0000000000000000"
    orig = gmailmod.send
    gmailmod.send = fake_send
    try:
        r = client.post("/api/crew-requests/notify",
                        json={"contactId": C1, "projectId": P_NOTIFY, "template": "crewConfirmed",
                              "positionIds": ["p14a"], "token": crew_token},
                        cookies={"ltp_session": tok})
    finally:
        gmailmod.send = orig
    assert r.status_code == 200, r.text
    assert r.json()["emailStatus"]["emailed"] is True
    html = captured["html_body"]
    assert "Click here to add to calendar" in html
    # The button links back to the crew call sheet for this token.
    assert "/#/crew/" + crew_token in html
    # The per-shift Google Calendar links now live only on the web page.
    assert "calendar.google.com" not in html


def test_notify_confirmed_without_token_has_no_broken_calendar_link():
    """No token → no calendar button (rather than a broken link); the email still
    sends fine."""
    import backend.gmail as gmailmod
    client, tok = _setup()
    captured = {}

    async def fake_send(**kw):
        captured.update(kw)
        return {"id": "cal-2"}

    orig = gmailmod.send
    gmailmod.send = fake_send
    try:
        r = client.post("/api/crew-requests/notify",
                        json={"contactId": C1, "projectId": P_NOTIFY, "template": "crewConfirmed", "positionIds": ["p14a"]},
                        cookies={"ltp_session": tok})
    finally:
        gmailmod.send = orig
    assert r.status_code == 200, r.text
    assert r.json()["emailStatus"]["emailed"] is True
    html = captured["html_body"]
    assert "Click here to add to calendar" not in html
    assert "/#/crew/" not in html


def test_crew_shifts_payload_carries_role_and_note():
    """The crew payload/shift builder exposes the bare role acronym (for the
    calendar event title) and the producer's per-shift note, and the email shift
    card renders the note."""
    from backend.routes import crew as crewmod

    class _P:
        pass
    proj = _P()
    proj.schedule = [{
        "id": "s", "title": "Main Show", "date": "2026-08-01", "time": "08:00", "endTime": "17:00",
        "positions": [{"id": "p1", "serviceId": None, "role": "A1", "crewId": 1,
                       "status": "confirmed", "note": "Parking is on 4th St. Gate code 4821."}],
    }]
    shifts = crewmod._crew_shifts(proj, ["p1"], {})
    assert shifts and shifts[0]["role"] == "A1"
    assert shifts[0]["note"] == "Parking is on 4th St. Gate code 4821."
    html = crewmod._crew_shifts_html(shifts, "#EF5822")
    assert "Parking is on 4th St. Gate code 4821." in html


def test_notify_shift_note_email_renders_note_from_snapshot():
    """The crewShiftNote notify (sent when a producer adds a note to a confirmed
    shift) renders the note from the shift snapshot — no dependence on the
    debounced projects PUT having landed — and carries no calendar/accept link."""
    import backend.gmail as gmailmod
    client, tok = _setup()
    captured = {}

    async def fake_send(**kw):
        captured.update(kw)
        return {"id": "note-1"}

    orig = gmailmod.send
    gmailmod.send = fake_send
    try:
        r = client.post("/api/crew-requests/notify",
                        json={"contactId": C1, "projectId": P_NOTIFY, "template": "crewShiftNote",
                              "projectName": "Gala Notify",
                              "shifts": [{"roleLabel": "L1 — Lead Lighting Tech", "date": "2026-07-30",
                                          "startTime": "10:00", "endTime": "14:00",
                                          "note": "Load-in via the north gate. Badge required."}]},
                        cookies={"ltp_session": tok})
    finally:
        gmailmod.send = orig
    assert r.status_code == 200, r.text
    assert r.json()["emailStatus"]["emailed"] is True
    html = captured["html_body"]
    assert "Load-in via the north gate. Badge required." in html
    assert "Note added" in captured["subject"] or "Gala Notify" in captured["subject"]
    # Informational — no accept/decline link, no calendar CTA.
    assert "/#/crew/" not in html


def test_notify_rejects_unknown_template():
    client, tok = _setup()
    r = client.post("/api/crew-requests/notify",
                    json={"contactId": C1, "projectId": P_NOTIFY, "template": "bogus"},
                    cookies={"ltp_session": tok})
    assert r.status_code == 400


def test_notify_with_snapshot_shifts_works_without_live_project():
    """The notify tray flushing a removal after its project was deleted: an
    explicit shift snapshot + projectName render the email even though the
    project (and its positions) no longer exist."""
    import backend.gmail as gmailmod
    client, tok = _setup()
    captured = {}

    async def fake_send(**kw):
        captured.update(kw)
        return {"id": "snap-1"}

    orig = gmailmod.send
    gmailmod.send = fake_send
    try:
        r = client.post("/api/crew-requests/notify",
                        json={"contactId": C1, "projectId": 999999,  # no such project
                              "template": "crewCancelled", "projectName": "Deleted Gala",
                              "shifts": [{"roleLabel": "A1 — Audio", "date": "2026-07-01",
                                          "shiftTitle": "Load-in", "startTime": "08:00", "endTime": "17:00"}]},
                        cookies={"ltp_session": tok})
    finally:
        gmailmod.send = orig
    assert r.status_code == 200, r.text
    assert r.json()["emailStatus"]["emailed"] is True
    assert captured["to"] == ["casey@crew.com"]
    assert "Deleted Gala" in captured["subject"]
    assert "Load-in" in captured["html_body"]  # the snapshot shift rendered


def test_notify_missing_project_without_snapshot_is_404():
    """The live path (positionIds, no snapshot) still needs the project to resolve
    its shifts, so a gone project is a 404."""
    client, tok = _setup()
    r = client.post("/api/crew-requests/notify",
                    json={"contactId": C1, "projectId": 999999, "template": "crewWithdrawn", "positionIds": ["x"]},
                    cookies={"ltp_session": tok})
    assert r.status_code == 404


def test_notify_schedule_change_renders_old_and_new():
    """A crewScheduleChanged notice carries prev* on each shift, and the email
    spells out old → new (the current time plus an "Updated from …" line) so the
    crew see exactly what moved."""
    import backend.gmail as gmailmod
    client, tok = _setup()
    captured = {}

    async def fake_send(**kw):
        captured.update(kw)
        return {"id": "sc-1"}

    orig = gmailmod.send
    gmailmod.send = fake_send
    try:
        r = client.post("/api/crew-requests/notify",
                        json={"contactId": C1, "projectId": 999999, "template": "crewScheduleChanged",
                              "projectName": "Moved Gala",
                              "shifts": [{"roleLabel": "A1 — Audio", "date": "2026-07-02",
                                          "shiftTitle": "Load-in", "startTime": "11:00", "endTime": "16:00",
                                          "prevDate": "2026-07-01", "prevStartTime": "08:00", "prevEndTime": "14:00"}]},
                        cookies={"ltp_session": tok})
    finally:
        gmailmod.send = orig
    assert r.status_code == 200, r.text
    assert r.json()["emailStatus"]["emailed"] is True
    body = captured["html_body"]
    assert "shift times changed" in captured["subject"]
    assert "11:00 AM" in body and "4:00 PM" in body       # the new time (current card)
    assert "Updated from" in body                          # the change line renders
    assert "8:00 AM" in body and "2:00 PM" in body         # the previous time


def test_removing_all_positions_auto_withdraws_and_shows_withdrawn_screen():
    """Producer removes the shifts a pending request covers → the save hook
    auto-withdraws it; the crew link reports withdrawn and accept is refused."""
    client, tok = _setup()
    token = _send(client, tok, P_STALE, C1).json()["token"]
    assert client.get(f"/api/crew/{token}").json()["status"] == "pending"

    # Remove every position (empty the schedule) and PUT the project back.
    proj = _project(client, tok, P_STALE)
    proj["schedule"] = []
    put = client.put(f"/api/projects/{P_STALE}", json=proj, cookies={"ltp_session": tok})
    assert put.status_code == 200, put.text

    body = client.get(f"/api/crew/{token}").json()
    assert body["status"] == "withdrawn", body          # crew sees the withdrawn screen
    assert body["shifts"] == []
    acc = client.post(f"/api/crew/{token}/accept", json={})
    assert acc.status_code == 409, acc.text             # can't accept a withdrawn request


def test_partial_removal_trims_request_but_stays_answerable():
    """Removing ONE of a request's shifts trims it to the survivors; the request
    stays pending and the crew can still accept the shift that remains."""
    client, tok = _setup()
    token = _send(client, tok, P_STALE2, C1).json()["token"]
    assert sorted(client.get("/api/crew-requests?projectId=" + str(P_STALE2),
                             cookies={"ltp_session": tok}).json()[0]["positionIds"]) == ["pd", "pk"]

    # Drop the "st_drop" shift; keep "st_keep".
    proj = _project(client, tok, P_STALE2)
    proj["schedule"] = [s for s in proj["schedule"] if s["id"] == "st_keep"]
    assert client.put(f"/api/projects/{P_STALE2}", json=proj,
                      cookies={"ltp_session": tok}).status_code == 200

    body = client.get(f"/api/crew/{token}").json()
    assert body["status"] == "pending", body            # still answerable
    assert [s["positionId"] for s in body["shifts"]] == ["pk"]
    acc = client.post(f"/api/crew/{token}/accept", json={})
    assert acc.status_code == 200, acc.text
    assert _pos_status(_project(client, tok, P_STALE2), "pk") == "accepted"


def test_project_delete_auto_withdraws_request():
    """Deleting the project auto-withdraws its requests (before the FK nulls)."""
    client, tok = _setup()
    token = _send(client, tok, P_DEL, C1).json()["token"]
    assert client.delete(f"/api/projects/{P_DEL}", cookies={"ltp_session": tok}).status_code == 200
    body = client.get(f"/api/crew/{token}").json()
    assert body["status"] == "withdrawn", body


def test_withdraw_with_notify_emails_crew():
    """Withdraw with {notify:true} emails the crew member the crewWithdrawn
    template (best-effort) and still reopens the positions."""
    import backend.gmail as gmailmod
    client, tok = _setup()
    req = _send(client, tok, P_WD_NOTIFY, C1).json()   # request created (admin Gmail not connected — fine)
    captured = {}

    async def fake_send(**kwargs):
        captured.update(kwargs)
        return {"id": "msg-wd"}

    orig = gmailmod.send
    gmailmod.send = fake_send
    try:
        r = client.post("/api/crew-requests/" + str(req["id"]) + "/withdraw",
                        json={"notify": True}, cookies={"ltp_session": tok})
    finally:
        gmailmod.send = orig

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "withdrawn"
    assert body["emailStatus"]["emailed"] is True
    assert captured["to"] == ["casey@crew.com"]
    assert "Gala WD Notify" in captured["subject"]
    assert "withdrawn" in captured["html_body"].lower()   # uses the crewWithdrawn fallback body
    assert "Lead Lighting Tech" in captured["html_body"]  # {{shifts}} renders the withdrawn shift
    assert "<strong>Gala WD Notify</strong>" in captured["html_body"]  # project name bolded
    assert _pos_status(_project(client, tok, P_WD_NOTIFY), "pwn_a") == "open"


def test_withdraw_without_notify_sends_no_email():
    """Plain withdraw (no notify flag) reopens positions but emails nobody."""
    import backend.gmail as gmailmod
    client, tok = _setup()
    req = _send(client, tok, P_WD_QUIET, C1).json()
    called = {"n": 0}

    async def fake_send(**kwargs):
        called["n"] += 1
        return {"id": "x"}

    orig = gmailmod.send
    gmailmod.send = fake_send
    try:
        r = client.post("/api/crew-requests/" + str(req["id"]) + "/withdraw",
                        cookies={"ltp_session": tok})   # no body → notify defaults false
    finally:
        gmailmod.send = orig

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "withdrawn"
    assert "emailStatus" not in body
    assert called["n"] == 0


# ── status drift (stale saves vs the request pipeline) ─────────────────────
#
# The frontend PUTs whole project rows from in-memory copies it never refetches,
# so a stale copy can revert requested/accepted positions to "open" while the
# crew member stays assigned. Three defenses, each covered below: the accept
# path advances drifted-open positions anyway; the producer list heals an
# already-zombied request; and the project PUT restores same-crew downgrades.


def _force_position_status(pid, status):
    """Rewrite every position status on a project DIRECTLY in the DB — the
    drift a stale save used to inflict (and pre-fix rows still carry), planted
    behind the API on purpose so the PUT guard can't intercept it. Crew
    assignments are left untouched."""
    from sqlalchemy import select
    from sqlalchemy.orm.attributes import flag_modified
    from backend.database import async_session

    async def run():
        async with async_session() as db:
            proj = (await db.execute(
                select(models.Project).where(models.Project.id == pid))).scalar_one()
            for sh in proj.schedule or []:
                for p in sh.get("positions", []):
                    p["status"] = status
            flag_modified(proj, "schedule")
            await db.commit()

    asyncio.run(run())


def test_accept_lands_even_after_positions_drifted_open():
    """Send → a stale save reverts the positions to open (crew kept) → the crew
    member accepts. The answer must still reach the schedule instead of leaving
    an accepted request over 'Ready to send' positions."""
    client, tok = _setup()
    token = _send(client, tok, P_DRIFT, C1).json()["token"]
    assert _pos_status(_project(client, tok, P_DRIFT), "pdr_a") == "requested"

    _force_position_status(P_DRIFT, "open")   # the drift

    r = client.post(f"/api/crew/{token}/accept", json={})
    assert r.status_code == 200 and r.json()["status"] == "accepted", r.text
    proj = _project(client, tok, P_DRIFT)
    assert _pos_status(proj, "pdr_a") == "accepted"
    assert _pos_status(proj, "pdr_b") == "accepted"
    assert _pos_crew(proj, "pdr_a") == C1


def test_list_heals_zombie_accepted_request():
    """An ACCEPTED request whose positions drifted back to open (the reported
    bug, e.g. rows written before the PUT guard existed) is healed by the
    producer-list sweep: opening the tab advances the schedule to accepted."""
    client, tok = _setup()
    req = _send(client, tok, P_ZOMBIE, C1).json()
    assert client.post(f"/api/crew/{req['token']}/accept", json={}).status_code == 200
    assert _pos_status(_project(client, tok, P_ZOMBIE), "pzo_a") == "accepted"

    _force_position_status(P_ZOMBIE, "open")  # post-answer drift → zombie

    listed = client.get("/api/crew-requests", cookies={"ltp_session": tok}).json()
    assert any(r["id"] == req["id"] and r["status"] == "accepted" for r in listed)
    proj = _project(client, tok, P_ZOMBIE)
    assert _pos_status(proj, "pzo_a") == "accepted"   # healed, not "Ready to send"
    assert _pos_crew(proj, "pzo_a") == C1


def test_project_put_blocks_stale_status_downgrade():
    """A project PUT that keeps the same crew member but writes a lower status
    is a stale echo — the stored status must win. A deliberate release (crew
    cleared) still passes through and withdraws the pending request."""
    client, tok = _setup()
    req = _send(client, tok, P_FLOOR, C1).json()
    proj = _project(client, tok, P_FLOOR)
    assert _pos_status(proj, "pfl_a") == "requested"

    # Stale echo: same crew, status reverted to open → floored back.
    for sh in proj["schedule"]:
        for p in sh["positions"]:
            p["status"] = "open"
    r = client.put(f"/api/projects/{P_FLOOR}", json=proj, cookies={"ltp_session": tok})
    assert r.status_code == 200, r.text
    proj = _project(client, tok, P_FLOOR)
    assert _pos_status(proj, "pfl_a") == "requested"   # regression blocked
    assert _pos_crew(proj, "pfl_a") == C1

    # Deliberate release: crew cleared → the downgrade applies, and the
    # pending request auto-withdraws (position no longer this member's).
    for sh in proj["schedule"]:
        for p in sh["positions"]:
            p["status"] = "open"
            p["crewId"] = None
    r = client.put(f"/api/projects/{P_FLOOR}", json=proj, cookies={"ltp_session": tok})
    assert r.status_code == 200, r.text
    proj = _project(client, tok, P_FLOOR)
    assert _pos_status(proj, "pfl_a") == "open"
    assert _pos_crew(proj, "pfl_a") is None
    listed = client.get(f"/api/crew-requests?projectId={P_FLOOR}", cookies={"ltp_session": tok}).json()
    assert [r["status"] for r in listed if r["id"] == req["id"]] == ["withdrawn"]


def main() -> int:
    tests = [
        test_send_whole_project_requests_only_this_crews_positions,
        test_send_guards_non_crew_no_email_and_no_sendable,
        test_send_for_unscheduled_day_is_rejected,
        test_send_skips_unscheduled_positions_in_mixed_project,
        test_silent_send_books_positions_confirmed_without_emailing,
        test_silent_send_works_for_crew_without_an_email,
        test_silent_book_cannot_be_resent_or_withdrawn,
        test_notify_flags_a_crew_member_with_no_email_as_undeliverable,
        test_send_unauthenticated_is_rejected,
        test_public_payload_is_allow_listed,
        test_short_or_unknown_token_is_404,
        test_accept_sets_positions_accepted_and_is_idempotent,
        test_decline_sets_positions_declined,
        test_withdraw_pending_reopens_positions,
        test_withdraw_after_answer_is_blocked,
        test_split_sends_only_selected_positions,
        test_send_emails_crew_member_when_gmail_connected,
        test_send_without_gmail_still_creates_request_and_reports_reconnect,
        test_list_crew_requests_shape_and_filter,
        test_resend_pending_reemails_same_token,
        test_resend_non_pending_is_409,
        test_notify_sends_named_template_email,
        test_notify_confirmed_add_to_calendar_links_to_call_sheet,
        test_notify_confirmed_without_token_has_no_broken_calendar_link,
        test_crew_shifts_payload_carries_role_and_note,
        test_notify_shift_note_email_renders_note_from_snapshot,
        test_notify_rejects_unknown_template,
        test_notify_with_snapshot_shifts_works_without_live_project,
        test_notify_missing_project_without_snapshot_is_404,
        test_notify_schedule_change_renders_old_and_new,
        test_removing_all_positions_auto_withdraws_and_shows_withdrawn_screen,
        test_partial_removal_trims_request_but_stays_answerable,
        test_project_delete_auto_withdraws_request,
        test_withdraw_with_notify_emails_crew,
        test_withdraw_without_notify_sends_no_email,
        test_accept_lands_even_after_positions_drifted_open,
        test_list_heals_zombie_accepted_request,
        test_project_put_blocks_stale_status_downgrade,
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
