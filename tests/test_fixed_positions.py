"""Flat-rate ("fixed cost") positions — backend coverage.

A production hires a lighting designer or stage manager for the WHOLE job at a
flat fee, with no contracted shift times. Those positions live in
Project.fixed_positions (backend/models.py) rather than on a schedule row, and
this module covers every seam they pass through:

  - CRUD round-trip + JSON shape validation of the new column
  - crew request send: a flat position is sendable with no date; the email
    states the fee + the project's date outline; a mixed request says
    "N shifts + 1 flat-rate position"
  - the public crew payload: the flat entry carries flat/fee/projectDates and
    still no crewId/serviceId internals
  - accept / withdraw drive the flat position's status like a shift's
  - integrity: a request over a flat position survives project saves (no date
    needed) and auto-withdraws when the position is removed; a stale PUT can't
    downgrade its status; a non-admin can't plant a frozen pay snapshot
  - payouts: derive_payout_drafts turns a completed flat-rate position into a "day" on
    the project's END date (so it lands in that date's payroll period), keeps
    an incomplete one pending, merges with a signed shift day on the same
    date, and plan_bill posts it to the role's expense account
  - the paid-day guard refuses a fee change on a PAID flat-rate position (409)
    unless overridden, and passes unrelated edits
  - a crewConfirmed notice for a flat hire uses the project date range and
    drops the empty Call:/Wrap: lines

Under pytest this module shares the session-wide DB from tests/conftest.py; run
as a plain script it uses its own DATABASE_URL (the setdefault below).
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_fixed.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

_db_path = os.path.join(_root, "_test_fixed.db")
if os.environ["DATABASE_URL"].endswith("_test_fixed.db") and os.path.exists(_db_path):
    os.remove(_db_path)

from backend import crew_integrity, models, payouts, qbo_payouts  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402


ADMIN_TOK = "fixed-admin-session"
MEMBER_TOK = "fixed-member-session"

C_LD = 9801      # crew: the lighting designer (has email)
C_SM = 9802      # crew: stage manager (has email)
S_LD = 8801      # service: LD — Lighting Designer (expense account 77)
S_L1 = 8802      # service: L1 — Lighting Tech

P_CRUD = 7801
P_SEND = 7802
P_PAYLOAD = 7803
P_ACCEPT = 7804
P_WITHDRAW = 7805
P_INTEGRITY = 7806
P_FLOOR = 7807
P_SNAP = 7808
P_PAID = 7809
P_NOTIFY = 7810
P_MIXED = 7811

_client = None
_seeded = False


def _fp(pid, crew, status="open", service=S_LD, fee=1500.0, bill=2000.0, note="", work=None, adj=None):
    p = {"id": pid, "serviceId": service, "role": "LD", "crewId": crew, "status": status,
         "fee": fee, "bill": bill, "fullMargin": False, "note": note}
    if work is not None:
        p["work"] = work
    if adj is not None:
        p["adj"] = adj
    return p


def _pos(pid, crew, status="open", service=S_L1, work=None):
    p = {"id": pid, "role": "L1", "serviceId": service, "crewId": crew, "status": status}
    if work is not None:
        p["work"] = work
    return p


def _shift(sid, title, date, positions, time="08:00", end="18:00", end_date=None):
    s = {"id": sid, "title": title, "date": date, "time": time, "endTime": end,
         "positions": positions, "breaks": []}
    if end_date:
        s["endDate"] = end_date
    return s


def _flat_work(total, service=S_LD):
    return {"state": "completed", "signedAt": "2026-09-21T10:00:00Z", "signedBy": "tester",
            "pay": {"total": total, "tier": "flat", "paidHours": 0, "otHours": 0, "mealPenaltyHours": 0,
                    "units": [{"serviceId": service, "tier": "flat", "total": total, "paidHours": 0, "otHours": 0}]}}


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
                admin = models.User(google_sub="fixed-admin-sub", email="fixed-admin@biz.com",
                                    name="Fixed Admin", role="admin")
                member = models.User(google_sub="fixed-member-sub", email="fixed-member@biz.com",
                                     name="Fixed Member", role="member")
                db.add_all([admin, member])
                await db.flush()
                exp = datetime.now(timezone.utc) + timedelta(days=7)
                db.add(models.Session(id=hash_session_token(ADMIN_TOK), user_id=admin.id, expires_at=exp))
                db.add(models.Session(id=hash_session_token(MEMBER_TOK), user_id=member.id, expires_at=exp))

                db.add(models.Contact(id=C_LD, first_name="Dana", last_name="Designer",
                                      email="dana@crew.com", is_crew=True, crew_status="active"))
                db.add(models.Contact(id=C_SM, first_name="Sam", last_name="Manager",
                                      email="sam@crew.com", is_crew=True, crew_status="active"))
                db.add(models.Service(id=S_LD, role="LD", description="Lighting Designer",
                                      department="Lighting", qb_expense_account_id="77"))
                db.add(models.Service(id=S_L1, role="L1", description="Lighting Tech", department="Lighting"))

                outline = [
                    _shift("sh-in", "Load-in", "2026-09-10", []),
                    _shift("sh-reh", "Rehearsal", "2026-09-11", [_pos("px", C_SM)]),
                    _shift("sh-show", "Show", "2026-09-12", [], end_date="2026-09-13"),
                ]
                db.add(models.Project(id=P_SEND, name="Autumn Gala", venue="Grand Hall",
                                      start_date="2026-09-10", end_date="2026-09-13",
                                      schedule=[dict(s) for s in outline],
                                      fixed_positions=[_fp("fp-send", C_LD, note="Design + programming, attend rehearsal")]))
                db.add(models.Project(id=P_PAYLOAD, name="Payload Gala", start_date="2026-09-10", end_date="2026-09-13",
                                      schedule=[dict(s) for s in outline],
                                      fixed_positions=[_fp("fp-pay", C_LD)]))
                db.add(models.Project(id=P_ACCEPT, name="Accept Gala", start_date="2026-09-10", end_date="2026-09-13",
                                      schedule=[], fixed_positions=[_fp("fp-acc", C_LD)]))
                db.add(models.Project(id=P_WITHDRAW, name="Withdraw Gala", start_date="2026-09-10", end_date="2026-09-13",
                                      schedule=[], fixed_positions=[_fp("fp-wd", C_LD)]))
                db.add(models.Project(id=P_INTEGRITY, name="Integrity Gala", start_date="2026-09-10", end_date="2026-09-13",
                                      schedule=[], fixed_positions=[_fp("fp-int", C_LD)]))
                db.add(models.Project(id=P_FLOOR, name="Floor Gala", start_date="2026-09-10", end_date="2026-09-13",
                                      schedule=[], fixed_positions=[_fp("fp-floor", C_LD, status="requested")]))
                db.add(models.Project(id=P_SNAP, name="Snapshot Gala", start_date="2026-09-10", end_date="2026-09-13",
                                      schedule=[], fixed_positions=[_fp("fp-snap", C_LD, status="confirmed")]))
                db.add(models.Project(id=P_PAID, name="Paid Gala", start_date="2026-09-10", end_date="2026-09-13",
                                      schedule=[], fixed_positions=[
                                          _fp("fp-paid", C_LD, status="confirmed", work=_flat_work(1500.0))]))
                db.add(models.Project(id=P_NOTIFY, name="Notify Gala", venue="The Barn",
                                      start_date="2026-09-10", end_date="2026-09-13",
                                      schedule=[], fixed_positions=[_fp("fp-not", C_LD, status="confirmed")]))
                db.add(models.Project(id=P_MIXED, name="Mixed Gala", start_date="2026-09-10", end_date="2026-09-13",
                                      schedule=[_shift("sh-mx", "Show", "2026-09-12", [_pos("pmx", C_LD)])],
                                      fixed_positions=[_fp("fp-mx", C_LD)]))
                await db.flush()

                # A PAID vendor bill covering the flat fee on P_PAID — billed on the
                # project's end date (09-13), the payroll period it falls into.
                paid = models.PayoutBill(contact_id=C_LD, period_start="2026-09-07",
                                         period_end="2026-09-20", doc_number="PAY-26-18",
                                         qb_paid_at=datetime.now(timezone.utc))
                db.add(paid)
                await db.flush()
                db.add(models.PayoutBillLine(payout_bill_id=paid.id, contact_id=C_LD,
                                             project_id=P_PAID, date="2026-09-13", amount=1500.0))
                await db.commit()

        _run(seed())
        _seeded = True
    return _client, ADMIN_TOK


def _teardown():
    global _client
    if _client is not None:
        _client.__exit__(None, None, None)
        _client = None


# ── Helpers ─────────────────────────────────────────────────────────────────

def _project(client, tok, pid):
    return client.get(f"/api/projects/{pid}", cookies={"ltp_session": tok}).json()


def _fixed(project_json, pos_id):
    for p in project_json.get("fixedPositions") or []:
        if p.get("id") == pos_id:
            return p
    return None


def _send(client, tok, pid, cid, position_ids=None, silent=None):
    body = {"projectId": pid, "contactId": cid}
    if position_ids is not None:
        body["positionIds"] = position_ids
    if silent is not None:
        body["silent"] = silent
    return client.post("/api/crew-requests/send", json=body, cookies={"ltp_session": tok})


def _with_fake_gmail(fn):
    """Run fn() with gmail.send stubbed; returns (result, captured kwargs)."""
    import backend.gmail as gmailmod
    captured = {}

    async def fake_send(**kwargs):
        captured.update(kwargs)
        return {"id": "msg-1"}

    orig = gmailmod.send
    gmailmod.send = fake_send
    try:
        return fn(), captured
    finally:
        gmailmod.send = orig


# ── CRUD round-trip + shape validation ───────────────────────────────────────

def test_fixed_positions_round_trip_and_shape():
    client, tok = _setup()
    body = {"id": P_CRUD, "name": "CRUD Gala", "status": "upcoming", "category": "Labor",
            "startDate": "2026-10-01", "endDate": "2026-10-03", "schedule": [],
            "fixedPositions": [_fp("fp-crud", None, fee=900, bill=1200, note="Plot + focus")]}
    r = client.post("/api/projects", json=body, cookies={"ltp_session": tok})
    assert r.status_code == 200, r.text
    got = _project(client, tok, P_CRUD)
    assert got["fixedPositions"][0]["fee"] == 900 and got["fixedPositions"][0]["bill"] == 1200
    assert got["fixedPositions"][0]["note"] == "Plot + focus"
    # Container shape is enforced like every other JSON column.
    r = client.put(f"/api/projects/{P_CRUD}", json={"fixedPositions": True}, cookies={"ltp_session": tok})
    assert r.status_code == 400, r.text
    # A member's ordinary save round-trips the list unchanged.
    r = client.put(f"/api/projects/{P_CRUD}", json={"fixedPositions": got["fixedPositions"]},
                   cookies={"ltp_session": MEMBER_TOK})
    assert r.status_code == 200, r.text
    assert _project(client, tok, P_CRUD)["fixedPositions"][0]["fee"] == 900


# ── Send: no date needed, email states fee + outline ─────────────────────────

def test_send_flat_position_creates_request_and_email_states_fee_and_outline():
    client, tok = _setup()
    r, captured = _with_fake_gmail(lambda: _send(client, tok, P_SEND, C_LD))
    assert r.status_code == 200, r.text
    req = r.json()
    assert req["status"] == "pending" and req["positionIds"] == ["fp-send"]
    assert req["emailStatus"]["emailed"] is True
    proj = _project(client, tok, P_SEND)
    assert _fixed(proj, "fp-send")["status"] == "requested"
    # The response carries the moved row so the sender adopts it.
    assert _fixed(req["project"], "fp-send")["status"] == "requested"

    html = captured["html_body"]
    assert "Flat-rate position" in html
    assert "$1,500.00" in html                       # the fee IS the offer
    assert "Project dates" in html and "Sep 10, 2026" in html and "Sep 13, 2026" in html
    # Outline: each scheduled day + its title, no times.
    assert "Load-in" in html and "Rehearsal" in html and "Show" in html
    assert "8:00 AM" not in html and "6:00 PM" not in html
    assert "Sep 12, 2026 – " in html                  # the multi-day Show row spans to its endDate
    assert "Design + programming" in html            # the scope note
    assert "1 flat-rate position" in html          # header count line
    assert "/#/crew/" + req["token"] in html


def test_mixed_request_counts_shifts_and_flat_positions():
    client, tok = _setup()
    r, captured = _with_fake_gmail(lambda: _send(client, tok, P_MIXED, C_LD))
    assert r.status_code == 200, r.text
    assert set(r.json()["positionIds"]) == {"pmx", "fp-mx"}
    assert "1 shift + 1 flat-rate position" in captured["html_body"]
    proj = _project(client, tok, P_MIXED)
    assert _fixed(proj, "fp-mx")["status"] == "requested"
    sh_pos = proj["schedule"][0]["positions"][0]
    assert sh_pos["status"] == "requested"


# ── Public payload allow-list ────────────────────────────────────────────────

def test_public_payload_flat_entry_allow_list():
    client, tok = _setup()
    r, _ = _with_fake_gmail(lambda: _send(client, tok, P_PAYLOAD, C_LD))
    token = r.json()["token"]
    pub = client.get(f"/api/crew/{token}").json()
    assert pub["status"] == "pending"
    assert len(pub["shifts"]) == 1
    e = pub["shifts"][0]
    assert e["flat"] is True and e["fee"] == 1500.0
    assert e["roleLabel"] == "LD — Lighting Designer" and e["role"] == "LD"
    assert e["projectStart"] == "2026-09-10" and e["projectEnd"] == "2026-09-13"
    dates = e["projectDates"]
    assert [d["date"] for d in dates] == ["2026-09-10", "2026-09-11", "2026-09-12"]
    assert dates[0]["title"] == "Load-in" and dates[2].get("endDate") == "2026-09-13"
    # Still no internals.
    for k in ("crewId", "serviceId", "bill", "pay", "work"):
        assert k not in e
    assert "token" not in pub
    for d in dates:
        assert "time" not in d and "positions" not in d and "crewId" not in d


# ── Accept / withdraw drive the flat position status ────────────────────────

def test_accept_flat_position():
    client, tok = _setup()
    r, _ = _with_fake_gmail(lambda: _send(client, tok, P_ACCEPT, C_LD))
    token = r.json()["token"]
    a = client.post(f"/api/crew/{token}/accept", json={"comment": "Happy to."})
    assert a.status_code == 200, a.text
    proj = _project(client, tok, P_ACCEPT)
    assert _fixed(proj, "fp-acc")["status"] == "accepted"
    assert _fixed(proj, "fp-acc")["crewId"] == C_LD
    # A replay is locked.
    assert client.post(f"/api/crew/{token}/accept", json={}).status_code == 409


def test_withdraw_flat_position_reopens_and_unassigns():
    client, tok = _setup()
    r, _ = _with_fake_gmail(lambda: _send(client, tok, P_WITHDRAW, C_LD))
    rid = r.json()["id"]
    w = client.post(f"/api/crew-requests/{rid}/withdraw", json={"notify": False}, cookies={"ltp_session": tok})
    assert w.status_code == 200, w.text
    assert w.json()["status"] == "withdrawn"
    fp = _fixed(w.json()["project"], "fp-wd")
    assert fp["status"] == "open" and fp["crewId"] is None
    assert _fixed(_project(client, tok, P_WITHDRAW), "fp-wd")["status"] == "open"


# ── Integrity ───────────────────────────────────────────────────────────────

def test_flat_request_survives_saves_and_withdraws_when_removed():
    client, tok = _setup()
    r, _ = _with_fake_gmail(lambda: _send(client, tok, P_INTEGRITY, C_LD))
    rid = r.json()["id"]
    proj = _project(client, tok, P_INTEGRITY)
    # An ordinary save (a new schedule day added) must NOT withdraw the request:
    # a flat-rate position needs no date to stay live.
    proj["schedule"] = [_shift("new-day", "Load-in", "2026-09-10", [])]
    r2 = client.put(f"/api/projects/{P_INTEGRITY}", json=proj, cookies={"ltp_session": tok})
    assert r2.status_code == 200, r2.text
    lst = client.get(f"/api/crew-requests?projectId={P_INTEGRITY}", cookies={"ltp_session": tok}).json()
    mine = [x for x in lst if x["id"] == rid][0]
    assert mine["status"] == "pending" and mine["positionIds"] == ["fp-int"]
    # Removing the flat position auto-withdraws the request.
    proj = _project(client, tok, P_INTEGRITY)
    proj["fixedPositions"] = []
    r3 = client.put(f"/api/projects/{P_INTEGRITY}", json=proj, cookies={"ltp_session": tok})
    assert r3.status_code == 200, r3.text
    lst = client.get(f"/api/crew-requests?projectId={P_INTEGRITY}", cookies={"ltp_session": tok}).json()
    mine = [x for x in lst if x["id"] == rid][0]
    assert mine["status"] == "withdrawn"


def test_stale_put_cannot_downgrade_flat_status():
    client, tok = _setup()
    proj = _project(client, tok, P_FLOOR)
    assert _fixed(proj, "fp-floor")["status"] == "requested"
    stale = dict(proj)
    stale["fixedPositions"] = [dict(_fixed(proj, "fp-floor"), status="open")]   # same crew, lower status
    r = client.put(f"/api/projects/{P_FLOOR}", json=stale, cookies={"ltp_session": tok})
    assert r.status_code == 200, r.text
    assert _fixed(_project(client, tok, P_FLOOR), "fp-floor")["status"] == "requested"
    # A deliberate release (crew cleared) passes through.
    proj = _project(client, tok, P_FLOOR)
    proj["fixedPositions"] = [dict(_fixed(proj, "fp-floor"), status="open", crewId=None)]
    r = client.put(f"/api/projects/{P_FLOOR}", json=proj, cookies={"ltp_session": tok})
    assert r.status_code == 200, r.text
    assert _fixed(_project(client, tok, P_FLOOR), "fp-floor")["status"] == "open"


def test_non_admin_cannot_plant_flat_pay_snapshot_admin_can():
    client, tok = _setup()
    proj = _project(client, tok, P_SNAP)
    proj["fixedPositions"] = [dict(_fixed(proj, "fp-snap"), work=_flat_work(9999.0))]
    r = client.put(f"/api/projects/{P_SNAP}", json=proj, cookies={"ltp_session": MEMBER_TOK})
    assert r.status_code == 200, r.text
    assert "work" not in _fixed(_project(client, tok, P_SNAP), "fp-snap")
    proj = _project(client, tok, P_SNAP)
    proj["fixedPositions"] = [dict(_fixed(proj, "fp-snap"), work=_flat_work(1500.0))]
    r = client.put(f"/api/projects/{P_SNAP}", json=proj, cookies={"ltp_session": tok})
    assert r.status_code == 200, r.text
    assert _fixed(_project(client, tok, P_SNAP), "fp-snap")["work"]["pay"]["total"] == 1500.0


# ── Payout derivation (pure) ─────────────────────────────────────────────────

_CREW = {C_LD: {"first_name": "Dana", "last_name": "Designer"}}


def test_derive_flat_pending_until_complete_and_dated_on_project_end():
    projects = [
        {"id": 1, "name": "Gala", "schedule": [], "end_date": "2026-09-13",
         "fixed_positions": [
             _fp("a", C_LD, status="confirmed"),                          # incomplete → pending on the end date
             _fp("c", C_LD, status="requested", work=_flat_work(1.0)),     # not confirmed → ignored
         ]},
        {"id": 2, "name": "Recital", "schedule": [], "end_date": "2026-09-20",
         "fixed_positions": [_fp("b", C_LD, status="confirmed", work=_flat_work(1500.0))]},  # complete → billed on 09-20
    ]
    drafts = payouts.derive_payout_drafts(projects, _CREW, "2026-09-01", "2026-09-30")
    assert len(drafts) == 1
    d = drafts[0]
    assert d["pending"] == [{"project_id": 1, "project_name": "Gala", "date": "2026-09-13", "flat": True}]
    assert len(d["days"]) == 1
    day = d["days"][0]
    assert day["date"] == "2026-09-20" and day["tier"] == "flat" and day["flat"] is True
    assert day["payable"] == 1500.0 and day["units"] == [
        {"service_id": S_LD, "amount": 1500.0, "paid_hours": 0.0, "ot_hours": 0.0}]
    assert d["total_signed"] == 1500.0
    # The end date alone picks the period: a range that excludes it sees nothing.
    assert payouts.derive_payout_drafts(projects, _CREW, "2026-10-01", "2026-10-31") == []
    # No project end date → not payable anywhere (the builder flags it).
    nodate = [{"id": 3, "name": "Undated", "schedule": [], "end_date": "",
               "fixed_positions": [_fp("z", C_LD, status="confirmed", work=_flat_work(5.0))]}]
    assert payouts.derive_payout_drafts(nodate, _CREW, "", "") == []
    # Two flat-rate positions on one project stay one "flat" entry (same ledger key).
    two = [{"id": 4, "name": "Fair", "schedule": [], "end_date": "2026-09-20",
            "fixed_positions": [_fp("x", C_LD, status="confirmed", work=_flat_work(1000.0)),
                                _fp("y", C_LD, status="confirmed", work=_flat_work(250.0, service=S_L1), service=S_L1)]}]
    d2 = payouts.derive_payout_drafts(two, _CREW, "2026-09-01", "2026-09-30")[0]
    assert len(d2["days"]) == 1 and d2["days"][0]["payable"] == 1250.0 and d2["days"][0]["tier"] == "flat"
    assert [u["service_id"] for u in d2["days"][0]["units"]] == [S_LD, S_L1]


def test_derive_flat_merges_into_same_date_shift_day_and_keeps_adjustments():
    day_work = {"state": "worked", "pay": {"total": 400.0, "tier": "full", "paidHours": 10, "otHours": 0,
                                           "units": [{"serviceId": S_L1, "total": 400.0, "paidHours": 10, "otHours": 0}]}}
    projects = [{"id": 3, "name": "Gala", "end_date": "2026-09-13",
                 "schedule": [_shift("s", "Show", "2026-09-13", [_pos("p", C_LD, status="confirmed", work=day_work)])],
                 "fixed_positions": [_fp("f", C_LD, status="confirmed", work=_flat_work(1500.0),
                                         adj=[{"id": "x", "amount": 50, "label": "Parking"}])]}]
    d = payouts.derive_payout_drafts(projects, _CREW, "2026-09-01", "2026-09-30")[0]
    assert len(d["days"]) == 1, d["days"]
    day = d["days"][0]
    assert day["date"] == "2026-09-13" and day["tier"] == "mixed" and day["flat"] is True
    assert day["payable"] == 1950.0 and day["adj_total"] == 50.0
    assert [u["service_id"] for u in day["units"]] == [S_L1, S_LD]
    assert day["adjustments"] == [{"label": "Parking", "amount": 50.0}]
    assert d["total_signed"] == 1950.0


def test_plan_bill_posts_flat_fee_to_the_role_expense_account():
    projects = [{"id": 4, "name": "Gala", "schedule": [], "end_date": "2026-09-20",
                 "fixed_positions": [_fp("f", C_LD, status="confirmed", work=_flat_work(1500.0))]}]
    d = payouts.derive_payout_drafts(projects, _CREW, "2026-09-14", "2026-09-27")[0]
    period = {"start": "2026-09-14", "end": "2026-09-27", "index": 5, "year2": 26, "number": 19, "pay_day": "2026-10-02"}
    accounts = {"default_expense": "10", "ap": None, "by_service": {S_LD: "77"}}
    plan = qbo_payouts.plan_bill(C_LD, d, period, accounts)
    assert plan["total"] == 1500.0 and len(plan["lines"]) == 1
    ln = plan["lines"][0]
    assert ln["account_id"] == "77" and ln["amount"] == 1500.0
    assert ln["description"] == "Gala · 2026-09-20 · Flat rate"


# ── Paid-day guard ──────────────────────────────────────────────────────────

def test_paid_day_signature_covers_flat_fee_status_and_project_end():
    base = [_fp("f", C_LD, status="confirmed", work=_flat_work(1500.0))]
    key = f"{C_LD}|2026-09-13"
    sig = payouts.paid_day_signature([], base, "2026-09-13")
    assert set(sig) == {key}                       # keyed on the project's end date
    # Fee, status and full-margin all change the fingerprint; bill does not.
    assert payouts.paid_day_signature([], [dict(base[0], fee=1600)], "2026-09-13")[key] != sig[key]
    assert payouts.paid_day_signature([], [dict(base[0], bill=9999)], "2026-09-13") == sig
    assert payouts.paid_day_signature([], [dict(base[0], fullMargin=True)], "2026-09-13") != sig
    assert payouts.paid_day_signature([], [dict(base[0], status="accepted")], "2026-09-13") != sig
    # Moving the project end date moves the key; no end date → absent.
    assert set(payouts.paid_day_signature([], base, "2026-09-20")) == {f"{C_LD}|2026-09-20"}
    assert payouts.paid_day_signature([], base, "") == {}


def test_put_refuses_fee_change_on_paid_flat_position_unless_overridden():
    client, tok = _setup()
    proj = _project(client, tok, P_PAID)
    # Unrelated edit passes: a note on the position doesn't change the money.
    proj["fixedPositions"] = [dict(_fixed(proj, "fp-paid"), note="Bring the plot")]
    r = client.put(f"/api/projects/{P_PAID}", json=proj, cookies={"ltp_session": tok})
    assert r.status_code == 200, r.text
    # Re-pricing the fee on the PAID flat-rate position → 409 paid_day_conflict.
    proj = _project(client, tok, P_PAID)
    proj["fixedPositions"] = [dict(_fixed(proj, "fp-paid"), fee=1750)]
    r = client.put(f"/api/projects/{P_PAID}", json=proj, cookies={"ltp_session": tok})
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "paid_day_conflict"
    assert detail["days"][0]["date"] == "2026-09-13" and detail["days"][0]["name"] == "Dana Designer"
    assert _fixed(_project(client, tok, P_PAID), "fp-paid")["fee"] == 1500.0
    # With the override header the write lands.
    r = client.put(f"/api/projects/{P_PAID}", json=proj,
                   cookies={"ltp_session": tok}, headers={"X-LTP-Paid-Day-Override": "1"})
    assert r.status_code == 200, r.text
    assert _fixed(_project(client, tok, P_PAID), "fp-paid")["fee"] == 1750


# ── Notify: crewConfirmed for a flat hire ───────────────────────────────────

def test_confirm_notify_for_flat_uses_project_dates_and_drops_call_wrap_lines():
    client, tok = _setup()
    r, captured = _with_fake_gmail(lambda: client.post(
        "/api/crew-requests/notify",
        json={"contactId": C_LD, "projectId": P_NOTIFY, "template": "crewConfirmed", "positionIds": ["fp-not"]},
        cookies={"ltp_session": tok}))
    assert r.status_code == 200, r.text
    assert r.json()["emailStatus"]["emailed"] is True
    html = captured["html_body"]
    assert "Sep 10, 2026 – " in html and "Sep 13, 2026" in html      # {{date}} → project range
    assert "LD — Lighting Designer" in html
    assert "Call:" not in html and "Wrap:" not in html               # empty label lines dropped
    assert "The Barn" in html                                        # {{location}} still resolves
    assert "Confirmed: Notify Gala" in captured["subject"]


def test_drop_empty_label_lines_is_surgical():
    from backend.routes.crew import _drop_empty_label_lines
    txt = "Project: Gala\nRole: LD\nCall: \nWrap:\nNote: bring 3:00 plot\n\nSee you at 7:00."
    out = _drop_empty_label_lines(txt)
    assert "Call:" not in out and "Wrap:" not in out
    assert "Project: Gala" in out and "Role: LD" in out and "Note: bring 3:00 plot" in out and "See you at 7:00." in out


# ── crew_integrity pure helpers ─────────────────────────────────────────────

def test_fixed_helpers_wrap_the_shift_guards():
    stored = [_fp("a", C_LD, status="accepted"), _fp("b", C_LD, status="confirmed", work=_flat_work(10.0))]
    incoming = [_fp("a", C_LD, status="open"), _fp("b", C_LD, status="confirmed", work=_flat_work(99.0)), _fp("c", None)]
    assert crew_integrity.enforce_status_floor_fixed(stored, incoming) == 1
    assert incoming[0]["status"] == "accepted"
    assert crew_integrity.enforce_pay_snapshot_fixed(stored, incoming) == 1
    assert incoming[1]["work"]["pay"]["total"] == 10.0 and "work" not in incoming[2]


if __name__ == "__main__":
    import pytest
    sys.exit(pytest.main([__file__, "-q"]))
