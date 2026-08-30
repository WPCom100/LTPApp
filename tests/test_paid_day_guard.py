"""Server-side paid-day guard — a schedule write can't silently reprice money
that has already left the building.

Once a crew day is billed to QuickBooks AND that bill is paid, editing the
schedule underneath it claws nothing back; it just makes the app disagree with
the accounts. The Schedule Builder and Payouts tab both warn first, but they warn
from a `paidDays`/`dayStatus` map fetched when the editor opened — stale the
moment a bill is paid, or a second window saves. That check is a courtesy.

This covers the enforcement: backend/payouts.py::paid_day_signature +
paid_day_conflicts, and the 409 the project PUT raises without
X-LTP-Paid-Day-Override.

Under pytest this module shares the session-wide DB from tests/conftest.py; run
as a plain script it uses its own DATABASE_URL (the setdefault below).
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_paidday.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

_db_path = os.path.join(_root, "_test_paidday.db")
if os.environ["DATABASE_URL"].endswith("_test_paidday.db") and os.path.exists(_db_path):
    os.remove(_db_path)

from backend import models, payouts  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402


ADMIN_TOK = "paidday-admin-session"
MEMBER_TOK = "paidday-member-session"

C_PAID = 9601        # crew member with a PAID bill
S_ROLE = 8601

P_PAID = 7601        # a paid day — edits must be refused
P_UNPAID = 7602      # billed but NOT paid — edits pass straight through
P_OTHER = 7603       # paid day plus an untouched second day
P_SNAP = 7604        # non-admin work change (reverted by enforce_pay_snapshot)

_client = None
_seeded = False

_WORK = {"pay": {"total": 400.0, "tier": "day", "units": [{"serviceId": S_ROLE, "total": 400.0}]},
         "state": "signed"}


def _pos(pid, crew, status="confirmed", service=S_ROLE, work=None, breaks=None):
    p = {"id": pid, "role": "", "serviceId": service, "crewId": crew, "status": status}
    if work is not None:
        p["work"] = work
    if breaks is not None:
        p["breaks"] = breaks
    return p


def _shift(sid, date, positions, time="08:00", end="17:00", breaks=None):
    return {"id": sid, "title": "Day", "date": date, "time": time, "endTime": end,
            "positions": positions, "breaks": breaks or []}


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
                admin = models.User(google_sub="paidday-admin-sub", email="paidday-admin@biz.com",
                                    name="Paid Admin", role="admin")
                member = models.User(google_sub="paidday-member-sub", email="paidday-member@biz.com",
                                     name="Paid Member", role="member")
                db.add_all([admin, member])
                await db.flush()
                exp = datetime.now(timezone.utc) + timedelta(days=7)
                db.add(models.Session(id=hash_session_token(ADMIN_TOK), user_id=admin.id, expires_at=exp))
                db.add(models.Session(id=hash_session_token(MEMBER_TOK), user_id=member.id, expires_at=exp))

                db.add(models.Contact(id=C_PAID, first_name="Pat", last_name="Paid",
                                      email="pat@crew.com", is_crew=True, crew_status="active"))
                db.add(models.Service(id=S_ROLE, role="A1", description="Audio Lead", department="Audio"))

                for pid, date in ((P_PAID, "2026-11-02"), (P_UNPAID, "2026-11-03"), (P_SNAP, "2026-11-05")):
                    db.add(models.Project(id=pid, name=f"Project {pid}", schedule=[
                        _shift(f"s{pid}", date, [_pos(f"p{pid}", C_PAID, work=dict(_WORK))]),
                    ]))
                db.add(models.Project(id=P_OTHER, name="Two Days", schedule=[
                    _shift("so1", "2026-11-04", [_pos("po1", C_PAID, work=dict(_WORK))]),
                    _shift("so2", "2026-11-06", [_pos("po2", C_PAID, work=dict(_WORK))]),
                ]))
                await db.flush()

                # PAID bills for P_PAID, P_OTHER (day 1 only) and P_SNAP.
                paid = models.PayoutBill(contact_id=C_PAID, period_start="2026-11-01",
                                         period_end="2026-11-14", doc_number="PAY-26-9",
                                         qb_paid_at=datetime.now(timezone.utc))
                # An UNPAID bill for P_UNPAID — billed, but the money has not moved.
                unpaid = models.PayoutBill(contact_id=C_PAID, period_start="2026-12-01",
                                           period_end="2026-12-14", doc_number="PAY-26-11")
                db.add_all([paid, unpaid])
                await db.flush()
                db.add_all([
                    models.PayoutBillLine(payout_bill_id=paid.id, contact_id=C_PAID,
                                          project_id=P_PAID, date="2026-11-02", amount=400.0),
                    models.PayoutBillLine(payout_bill_id=paid.id, contact_id=C_PAID,
                                          project_id=P_OTHER, date="2026-11-04", amount=400.0),
                    models.PayoutBillLine(payout_bill_id=paid.id, contact_id=C_PAID,
                                          project_id=P_SNAP, date="2026-11-05", amount=400.0),
                    models.PayoutBillLine(payout_bill_id=unpaid.id, contact_id=C_PAID,
                                          project_id=P_UNPAID, date="2026-11-03", amount=400.0),
                ])
                await db.commit()

        _run(seed())
        _seeded = True
    return _client, ADMIN_TOK


def _teardown():
    global _client
    if _client is not None:
        _client.__exit__(None, None, None)
        _client = None


def _get(client, tok, pid):
    return client.get(f"/api/projects/{pid}", cookies={"ltp_session": tok}).json()


def _put(client, tok, pid, body, override=False):
    headers = {"X-LTP-Paid-Day-Override": "1"} if override else {}
    return client.put(f"/api/projects/{pid}", json=body, headers=headers,
                      cookies={"ltp_session": tok})


# ── paid_day_signature (pure) ───────────────────────────────────────────────

def test_signature_is_stable_for_an_unchanged_day():
    sched = [_shift("s1", "2026-11-02", [_pos("p1", C_PAID, work=dict(_WORK))])]
    assert payouts.paid_day_signature(sched) == payouts.paid_day_signature(sched)


def test_signature_ignores_position_order():
    a = [_shift("s1", "2026-11-02", [_pos("p1", C_PAID), _pos("p2", C_PAID, service=99)])]
    b = [_shift("s1", "2026-11-02", [_pos("p2", C_PAID, service=99), _pos("p1", C_PAID)])]
    assert payouts.paid_day_signature(a) == payouts.paid_day_signature(b), \
        "reordering a day's positions changes nothing about what is owed"


def test_signature_moves_on_every_repricing_input():
    base = [_shift("s1", "2026-11-02", [_pos("p1", C_PAID, work=dict(_WORK))])]
    key = f"{C_PAID}|2026-11-02"
    original = payouts.paid_day_signature(base)[key]

    variants = {
        "shift times": [_shift("s1", "2026-11-02", [_pos("p1", C_PAID, work=dict(_WORK))], time="06:00")],
        "crew-wide breaks": [_shift("s1", "2026-11-02", [_pos("p1", C_PAID, work=dict(_WORK))],
                                    breaks=[{"startTime": "12:00", "endTime": "12:30", "type": "meal"}])],
        "position breaks": [_shift("s1", "2026-11-02", [_pos("p1", C_PAID, work=dict(_WORK),
                                                             breaks=[{"startTime": "13:00", "endTime": "13:30", "type": "meal"}])])],
        "service": [_shift("s1", "2026-11-02", [_pos("p1", C_PAID, service=4242, work=dict(_WORK))])],
        "status": [_shift("s1", "2026-11-02", [_pos("p1", C_PAID, status="open", work=dict(_WORK))])],
        "the billed pay itself": [_shift("s1", "2026-11-02",
                                         [_pos("p1", C_PAID, work={"pay": {"total": 999.0}, "state": "signed"})])],
    }
    for label, sched in variants.items():
        assert payouts.paid_day_signature(sched).get(key) != original, \
            f"a change to {label} must move the signature"


def test_signature_keys_are_per_crew_member():
    sched = [_shift("s1", "2026-11-02", [_pos("p1", C_PAID), _pos("p2", 9999)])]
    sig = payouts.paid_day_signature(sched)
    assert f"{C_PAID}|2026-11-02" in sig and "9999|2026-11-02" in sig
    # Changing one crew member's position must not disturb the other's key.
    other = [_shift("s1", "2026-11-02", [_pos("p1", C_PAID), _pos("p2", 9999, status="open")])]
    assert payouts.paid_day_signature(other)[f"{C_PAID}|2026-11-02"] == sig[f"{C_PAID}|2026-11-02"]


def test_signature_skips_undated_shifts_and_unassigned_positions():
    sched = [
        {"id": "nodate", "title": "Unscheduled", "positions": [_pos("p1", C_PAID)]},
        _shift("s1", "2026-11-02", [_pos("p2", None)]),
    ]
    assert payouts.paid_day_signature(sched) == {}, \
        "a day with no date, or a slot with no crew, is owed to nobody"


# ── The PUT guard ───────────────────────────────────────────────────────────

def test_editing_a_paid_day_is_refused():
    client, tok = _setup()
    row = _get(client, tok, P_PAID)
    body = {k: v for k, v in row.items() if k != "_rev"}
    body["schedule"] = [_shift("s7601", "2026-11-02", [_pos("p7601", C_PAID, work=dict(_WORK))], time="05:00")]

    r = _put(client, tok, P_PAID, body)
    assert r.status_code == 409, f"expected 409, got {r.status_code}: {r.text[:300]}"
    detail = r.json()["detail"]
    assert detail["code"] == "paid_day_conflict"
    assert len(detail["days"]) == 1
    day = detail["days"][0]
    assert day["date"] == "2026-11-02"
    assert day["contactId"] == C_PAID
    assert day["docNumber"] == "PAY-26-9"
    assert day["name"] == "Pat Paid", "the refusal must name who, not just an id"

    # And nothing was written.
    assert _get(client, tok, P_PAID)["schedule"][0]["time"] == "08:00", \
        "a refused write must leave the schedule untouched"


def test_the_override_header_lets_it_through():
    client, tok = _setup()
    row = _get(client, tok, P_PAID)
    body = {k: v for k, v in row.items() if k != "_rev"}
    body["schedule"] = [_shift("s7601", "2026-11-02", [_pos("p7601", C_PAID, work=dict(_WORK))], time="05:00")]

    r = _put(client, tok, P_PAID, body, override=True)
    assert r.status_code == 200, r.text
    assert _get(client, tok, P_PAID)["schedule"][0]["time"] == "05:00"


def test_a_billed_but_unpaid_day_is_not_guarded():
    """Money that has not moved can still be corrected freely — that is the
    whole point of the paid/unpaid distinction."""
    client, tok = _setup()
    row = _get(client, tok, P_UNPAID)
    body = {k: v for k, v in row.items() if k != "_rev"}
    body["schedule"] = [_shift("s7602", "2026-11-03", [_pos("p7602", C_PAID, work=dict(_WORK))], time="04:00")]
    r = _put(client, tok, P_UNPAID, body)
    assert r.status_code == 200, f"an unpaid bill must not gate edits: {r.text[:300]}"


def test_editing_an_unrelated_day_on_a_project_with_paid_days_passes():
    client, tok = _setup()
    row = _get(client, tok, P_OTHER)
    body = {k: v for k, v in row.items() if k != "_rev"}
    # Touch ONLY the second (unbilled) day.
    body["schedule"] = [
        _shift("so1", "2026-11-04", [_pos("po1", C_PAID, work=dict(_WORK))]),
        _shift("so2", "2026-11-06", [_pos("po2", C_PAID, work=dict(_WORK))], time="03:00"),
    ]
    r = _put(client, tok, P_OTHER, body)
    assert r.status_code == 200, f"an untouched paid day must not block a sibling day: {r.text[:300]}"
    assert _get(client, tok, P_OTHER)["schedule"][1]["time"] == "03:00"


def test_a_change_the_pay_snapshot_guard_reverts_is_not_reported_as_a_conflict():
    """Ordering test. enforce_pay_snapshot restores a non-admin's `work` change
    before the write lands, so by the time the paid-day check runs there is
    nothing different about that day. Running the check on the RAW incoming
    schedule instead would refuse a write that changes nothing."""
    client, _ = _setup()
    row = _get(client, MEMBER_TOK, P_SNAP)
    body = {k: v for k, v in row.items() if k != "_rev"}
    body["schedule"] = [_shift("s7604", "2026-11-05",
                               [_pos("p7604", C_PAID, work={"pay": {"total": 99999.0}, "state": "signed"})])]
    r = _put(client, MEMBER_TOK, P_SNAP, body)
    assert r.status_code == 200, \
        f"a reverted non-admin snapshot change is a no-op, not a conflict: {r.text[:300]}"
    after = _get(client, MEMBER_TOK, P_SNAP)
    assert after["schedule"][0]["positions"][0]["work"]["pay"]["total"] == 400.0, \
        "and the tampered amount must still have been reverted"


def test_an_identical_resave_of_a_paid_day_is_not_a_conflict():
    client, tok = _setup()
    row = _get(client, tok, P_OTHER)
    body = {k: v for k, v in row.items() if k != "_rev"}
    r = _put(client, tok, P_OTHER, body)
    assert r.status_code == 200, \
        f"saving a project without touching its paid day must not prompt: {r.text[:300]}"


def test_a_junk_override_header_does_not_count_as_consent():
    client, tok = _setup()
    row = _get(client, tok, P_OTHER)
    body = {k: v for k, v in row.items() if k != "_rev"}
    body["schedule"] = [
        _shift("so1", "2026-11-04", [_pos("po1", C_PAID, work=dict(_WORK))], time="02:00"),
        _shift("so2", "2026-11-06", [_pos("po2", C_PAID, work=dict(_WORK))]),
    ]
    r = client.put(f"/api/projects/{P_OTHER}", json=body,
                   headers={"X-LTP-Paid-Day-Override": "maybe"},
                   cookies={"ltp_session": tok})
    assert r.status_code == 409, "only an explicit affirmative counts as an override"


def main():
    tests = [
        test_signature_is_stable_for_an_unchanged_day,
        test_signature_ignores_position_order,
        test_signature_moves_on_every_repricing_input,
        test_signature_keys_are_per_crew_member,
        test_signature_skips_undated_shifts_and_unassigned_positions,
        test_editing_a_paid_day_is_refused,
        test_the_override_header_lets_it_through,
        test_a_billed_but_unpaid_day_is_not_guarded,
        test_editing_an_unrelated_day_on_a_project_with_paid_days_passes,
        test_a_change_the_pay_snapshot_guard_reverts_is_not_reported_as_a_conflict,
        test_an_identical_resave_of_a_paid_day_is_not_a_conflict,
        test_a_junk_override_header_does_not_count_as_consent,
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
