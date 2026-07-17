"""Manual / one-off shift — the "internal" project path (warehouse labor etc.).

A manual shift is created client-side by window.LTP_manualShiftProject as a
lightweight Project row marked ``internal: true`` with no company and a single
dated schedule day of positions. There is no bespoke backend endpoint: the row
rides the normal project CRUD, and because the crew-request pipeline only ever
reads ``Project.schedule[].positions[]`` (never the company/category), a manual
shift links into crew requests and payouts with no special-casing.

This suite proves that end to end against the real API:

  - the ``internal`` flag round-trips through POST/GET (camelCase mapping,
    not stripped as read-only) alongside the manual-shift schedule shape
  - a crew request SENDS against the internal project's assigned position and
    flips it open → requested, exactly like a client project
  - the tokenized public payload resolves the role label server-side and the
    crew member can ACCEPT, landing the position at accepted
  - the internal project is returned by the normal list endpoint (the backend
    does NOT hide it — client-facing hiding is a frontend concern), so Labor
    surfaces that read every project's schedule pick it up automatically

Mirrors tests/test_crew_requests.py's harness (shared session DB under pytest,
own DATABASE_URL standalone). Fixture ids are in a dedicated range so the module
is order-independent within the combined suite.
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_manual_shift.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

# Fresh DB (standalone runs) so the full migration stack — incl. the new
# projects.internal column — runs from scratch.
_db_path = os.path.join(_root, "_test_manual_shift.db")
if os.path.exists(_db_path):
    os.remove(_db_path)

from backend import models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402


# ── Dedicated fixture ids (distinct range → no collision in the shared DB) ────
# One project per test (each mutates its position's status), so the module is
# order-independent — mirrors tests/test_crew_requests.py.
WH_CREW = 9950   # crew member, has email
WH_SVC = 8950    # service: WH — Warehouse Hand
P_ROUNDTRIP = 7950  # internal flag round-trips through CRUD
P_LIST = 7951       # internal project appears in the normal list
P_SEND = 7952       # crew request sends against the manual shift
P_ACCEPT = 7953     # public payload + accept

_ADMIN_TOK = "manual-shift-session"
_client = None
_seeded = False


def _setup():
    """Boot the TestClient once and seed the crew member + service + admin."""
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
                admin = models.User(google_sub="ms-admin-sub", email="ms-admin@biz.com",
                                    name="Manual Shift Admin", role="admin")
                db.add(admin)
                await db.flush()
                db.add(models.Session(id=hash_session_token(_ADMIN_TOK), user_id=admin.id,
                                      expires_at=datetime.now(timezone.utc) + timedelta(days=7)))
                db.add(models.Contact(id=WH_CREW, first_name="Wendy", last_name="Warehouse",
                                      email="wendy@warehouse.com", is_crew=True,
                                      crew_status="active", crew_roles=["WH"]))
                db.add(models.Service(id=WH_SVC, role="WH", description="Warehouse Hand",
                                      department="Production", day_rate=400, day_cost=240))
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

def _manual_shift_payload(pid, title, date, positions):
    """The Project row window.LTP_manualShiftProject builds for a manual shift —
    kept in sync with theme.js (internal flag, no company, one dated day)."""
    return {
        "id": pid, "name": title, "companyId": None, "internal": True,
        "category": "Labor", "status": "in-progress",
        "startDate": date, "endDate": date, "venue": "",
        "siteAddress": "500 Dock Rd", "siteUseCompanyAddress": False,
        "contactIds": [], "budget": {"lighting": 0, "labor": 0, "rentals": 0, "misc": 0},
        "notes": [], "meetings": [], "scheduleNotes": "bring steel toes",
        "schedule": [{
            "id": "wsh1", "title": title, "date": date, "time": "08:00",
            "endDate": date, "endTime": "16:00", "showOnCalendar": True,
            "breaks": [], "positions": positions,
        }],
    }


def _pos(pid, crew, status="open", service=WH_SVC, role="WH"):
    return {"id": pid, "role": role, "serviceId": service, "crewId": crew,
            "status": status, "fullMargin": False}


def _create_manual_shift(client, tok, pid, positions):
    body = _manual_shift_payload(pid, "Warehouse Load-out", "2026-09-01", positions)
    return client.post("/api/projects", json=body, cookies={"ltp_session": tok})


def _project(client, tok, pid):
    return client.get(f"/api/projects/{pid}", cookies={"ltp_session": tok}).json()


def _pos_status(project_json, pos_id):
    for sh in project_json.get("schedule", []):
        for p in sh.get("positions", []):
            if p.get("id") == pos_id:
                return p.get("status")
    return None


# ── Tests ─────────────────────────────────────────────────────────────────

def test_internal_flag_round_trips_through_crud():
    """POST a manual-shift project and read it back: the `internal` flag persists
    and surfaces camelCase (not stripped as read-only), and the single dated
    schedule day + positions are stored intact."""
    client, tok = _setup()
    r = _create_manual_shift(client, tok, P_ROUNDTRIP, [_pos("wp1", WH_CREW)])
    assert r.status_code == 200, r.text
    created = r.json()
    assert created["internal"] is True, created
    assert created["companyId"] is None

    proj = _project(client, tok, P_ROUNDTRIP)
    assert proj["internal"] is True
    assert proj["category"] == "Labor"           # a real category → badge/colors resolve
    assert len(proj["schedule"]) == 1
    day = proj["schedule"][0]
    assert day["date"] == "2026-09-01" and day["endDate"] == "2026-09-01"
    assert day["time"] == "08:00" and day["endTime"] == "16:00"
    assert _pos_status(proj, "wp1") == "open"


def test_manual_shift_is_returned_by_the_normal_project_list():
    """The backend does NOT hide internal projects — the Labor surfaces that read
    every project's schedule depend on them being in the list. (Client-facing
    hiding is done on the frontend.)"""
    client, tok = _setup()
    _create_manual_shift(client, tok, P_LIST, [_pos("wl1", WH_CREW)])
    rows = client.get("/api/projects", cookies={"ltp_session": tok}).json()
    mine = [p for p in rows if p["id"] == P_LIST]
    assert mine and mine[0]["internal"] is True, "internal project must appear in the list"


def test_crew_request_sends_against_a_manual_shift():
    """A crew request created for the internal project flips its assigned position
    open → requested — the manual shift links into the crew-request pipeline with
    no special-casing."""
    client, tok = _setup()
    _create_manual_shift(client, tok, P_SEND, [_pos("ws1", WH_CREW)])

    r = client.post("/api/crew-requests/send",
                    json={"projectId": P_SEND, "contactId": WH_CREW},
                    cookies={"ltp_session": tok})
    assert r.status_code == 200, r.text
    req = r.json()
    assert req["status"] == "pending"
    assert req["positionIds"] == ["ws1"], req["positionIds"]
    assert req["token"] and len(req["token"]) >= 32
    assert _pos_status(_project(client, tok, P_SEND), "ws1") == "requested"


def test_public_payload_and_accept_for_a_manual_shift():
    """The tokenized crew payload resolves the WH role label server-side (the
    public page has no services catalog), carries the manual shift's name +
    site address, and the crew member can accept — landing the position at
    accepted, exactly like a client-project shift."""
    client, tok = _setup()
    _create_manual_shift(client, tok, P_ACCEPT, [_pos("wa1", WH_CREW)])
    token = client.post("/api/crew-requests/send",
                        json={"projectId": P_ACCEPT, "contactId": WH_CREW},
                        cookies={"ltp_session": tok}).json()["token"]

    payload = client.get(f"/api/crew/{token}").json()
    assert payload["status"] == "pending"
    assert payload["project"]["name"] == "Warehouse Load-out"
    assert payload["project"]["siteAddress"] == "500 Dock Rd"
    assert len(payload["shifts"]) == 1
    assert payload["shifts"][0]["roleLabel"] == "WH — Warehouse Hand"
    # No client-internal leakage on the public payload.
    assert "crewId" not in payload["shifts"][0]
    assert "token" not in payload

    acc = client.post(f"/api/crew/{token}/accept", json={})
    assert acc.status_code == 200 and acc.json()["status"] == "accepted", acc.text
    assert _pos_status(_project(client, tok, P_ACCEPT), "wa1") == "accepted"


def main() -> int:
    tests = [
        test_internal_flag_round_trips_through_crud,
        test_manual_shift_is_returned_by_the_normal_project_list,
        test_crew_request_sends_against_a_manual_shift,
        test_public_payload_and_accept_for_a_manual_shift,
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
    total = len(tests)
    print(f"\nmanual-shift suite — PASS: {total - failed}   FAIL: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
