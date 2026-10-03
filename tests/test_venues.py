"""Saved venues — the venue memory behind the project form's Venue Name box.

Covers the backend half of README.md "Saved venues":
  - The migration lands the venues table and projects.site_instructions on a
    fresh database (the TestClient lifespan runs `alembic upgrade head`).
  - Creating a project that names a venue remembers it, with the typed
    address and the parking / access instructions.
  - A project save that CHANGES the venue fields refreshes the saved venue;
    one that writes the whole unchanged row (a schedule save) leaves it alone,
    so a stale window cannot rewrite what a newer project taught.
  - Names match without regard to case; a rename remembers a new venue and
    keeps the old row.
  - A company-derived site address is never copied; an emptied typed address
    never blanks the saved one; instructions mirror once edited (clearing
    included); a project newly pointed at a venue only adds what it knows.
  - /api/venues is read-only: GET lists, POST/PUT/DELETE answer 405.
  - /api/versions carries the collection so live sync can publish it, and a
    project save that taught the memory moves its stamp.
  - The crew call sheet payload carries siteInstructions.
  - Deleting a project leaves the venue in place.

Runs both as pytest and as a plain script:
    python tests/test_venues.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_venues.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

_db_path = os.path.join(_root, "_test_venues.db")
if os.path.exists(_db_path):
    os.remove(_db_path)

from backend import models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402

_ADMIN_TOK = "venues-admin-session-token"
_client = None
_seeded = False

# Ids disjoint from every other module (the combined pytest run shares one DB).
_P = 9301          # first project id in this module; each test takes its own
_CO = 9301         # client company
_CO_ADDR = 9302    # client company with a billing address
_CONTACT = 9301    # crew contact


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
                admin = models.User(google_sub="venues-admin-sub", email="venues@biz.com",
                                    name="Venue Admin", role="admin")
                db.add(admin)
                await db.flush()
                db.add(models.Session(id=hash_session_token(_ADMIN_TOK), user_id=admin.id,
                                      expires_at=datetime.now(timezone.utc) + timedelta(days=7)))
                await db.commit()

        asyncio.run(seed())
        _seeded = True
    return _client, _ADMIN_TOK


_results: list = []


def _check(label, cond, detail=""):
    _results.append((label, bool(cond)))
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  ({detail})" if detail else ""))
    assert cond, f"{label} {detail}"


def _cookies():
    return {"ltp_session": _ADMIN_TOK}


def _post(client, path, body):
    r = client.post(path, json=body, cookies=_cookies())
    _check(f"POST {path} ok", r.status_code == 200, r.text[:200])
    return r.json()


def _put(client, path, body):
    r = client.put(path, json=body, cookies=_cookies())
    _check(f"PUT {path} ok", r.status_code == 200, r.text[:200])
    return r.json()


def _venues(client):
    r = client.get("/api/venues", cookies=_cookies())
    _check("GET /api/venues ok", r.status_code == 200, r.text[:200])
    return r.json()


def _venue(client, name):
    rows = [v for v in _venues(client) if v["name"].lower() == name.lower()]
    return rows[0] if rows else None


def _project(pid, **over):
    base = {
        "id": pid, "name": f"Venue Test {pid}", "companyId": _CO, "category": "Rental",
        "status": "upcoming", "startDate": "2026-11-01", "endDate": "2026-11-02",
        "venue": "", "siteAddress": "", "siteUseCompanyAddress": False, "siteInstructions": "",
        "contactIds": [], "budget": {"lighting": 0, "labor": 0, "rentals": 0, "misc": 0},
        "notes": [], "meetings": [], "schedule": [],
    }
    base.update(over)
    return base


_fixtures_done = False


def _fixtures(client):
    global _fixtures_done
    if _fixtures_done:
        return
    _post(client, "/api/companies", {"id": _CO, "name": "Venue Test Client", "isClient": True})
    _post(client, "/api/companies", {"id": _CO_ADDR, "name": "Addressed Client", "isClient": True,
                                     "address": "500 E Cesar Chavez St\nSuite 2", "city": "Austin",
                                     "state": "TX", "zip": "78701"})
    _post(client, "/api/contacts", {"id": _CONTACT, "firstName": "Venue", "lastName": "Crew",
                                    "email": "venue.crew@example.com", "isCrew": True, "crewStatus": "active",
                                    "crewRoles": ["L1"], "companyIds": []})
    _fixtures_done = True


# ── Schema ───────────────────────────────────────────────────────────────────

def test_migration_lands_the_schema():
    _setup()
    import sqlite3
    live = os.environ["DATABASE_URL"].split("///", 1)[1]
    db = sqlite3.connect(os.path.join(_root, live) if not os.path.isabs(live) else live)
    tables = {r[0] for r in db.execute("select name from sqlite_master where type='table'")}
    _check("venues table exists", "venues" in tables)
    venue_cols = {c[1] for c in db.execute("pragma table_info(venues)")}
    _check("venues carries name/address/instructions", {"name", "address", "instructions"} <= venue_cols)
    proj_cols = {c[1] for c in db.execute("pragma table_info(projects)")}
    _check("projects carries site_instructions", "site_instructions" in proj_cols)
    db.close()


# ── Remembering ──────────────────────────────────────────────────────────────

def test_creating_a_project_remembers_its_venue():
    client, _ = _setup()
    _fixtures(client)
    row = _post(client, "/api/projects", _project(
        _P, venue="Moody Center", siteAddress="2001 Robert Dedman Dr, Austin, TX 78712",
        siteInstructions="Crew lot off Red River. Load in at dock 3."))
    _check("siteInstructions round-trips on the project", row["siteInstructions"] == "Crew lot off Red River. Load in at dock 3.")
    v = _venue(client, "Moody Center")
    _check("venue remembered", v is not None)
    _check("…with the typed address", v["address"] == "2001 Robert Dedman Dr, Austin, TX 78712")
    _check("…and the instructions", v["instructions"] == "Crew lot off Red River. Load in at dock 3.")
    _check("…and a _rev like every other row", "_rev" in v)


def test_a_project_without_a_venue_remembers_nothing():
    client, _ = _setup()
    _fixtures(client)
    before = len(_venues(client))
    _post(client, "/api/projects", _project(_P + 1, venue="   ", siteAddress="1 Nowhere Ln"))
    _check("blank venue name adds no row", len(_venues(client)) == before)


def test_editing_the_venue_fields_refreshes_the_memory():
    client, _ = _setup()
    _fixtures(client)
    pid = _P + 2
    row = _post(client, "/api/projects", _project(
        pid, venue="Dallas Market Hall", siteAddress="2200 N Stemmons Fwy, Dallas, TX",
        siteInstructions="Gate code 4411"))
    row["siteInstructions"] = "Gate code 4411. Park in Lot C after 6pm."
    row["siteAddress"] = "2200 N Stemmons Fwy, Dallas, TX 75207"
    _put(client, f"/api/projects/{pid}", row)
    v = _venue(client, "Dallas Market Hall")
    _check("edited instructions reach the venue", v["instructions"] == "Gate code 4411. Park in Lot C after 6pm.")
    _check("edited address reaches the venue", v["address"] == "2200 N Stemmons Fwy, Dallas, TX 75207")


def test_an_unchanged_row_write_leaves_the_memory_alone():
    """The stale-window case. Project A (older) and project B (newer) share a
    venue; B taught the venue newer instructions. A's schedule save PUTs A's
    whole row — venue fields unchanged on A — and must not drag the venue
    back to A's older note."""
    client, _ = _setup()
    _fixtures(client)
    a, b = _P + 3, _P + 4
    row_a = _post(client, "/api/projects", _project(a, venue="The Rustic", siteAddress="3656 Howell St, Dallas, TX",
                                                    siteInstructions="Park behind the stage."))
    _post(client, "/api/projects", _project(b, venue="The Rustic", siteAddress="3656 Howell St, Dallas, TX",
                                            siteInstructions="Park behind the stage. Gate opens 7am."))
    _check("newer project taught the venue", _venue(client, "The Rustic")["instructions"] == "Park behind the stage. Gate opens 7am.")
    # A's schedule save: everything but the schedule as stored.
    fresh_a = client.get(f"/api/projects/{a}", cookies=_cookies()).json()
    fresh_a["schedule"] = [{"id": "d1", "title": "Load In", "date": "2026-11-01", "time": "08:00", "endTime": "17:00", "positions": []}]
    _put(client, f"/api/projects/{a}", fresh_a)
    _check("older project's unchanged venue fields did not rewrite the memory",
           _venue(client, "The Rustic")["instructions"] == "Park behind the stage. Gate opens 7am.")
    _check("…and the venue row count did not grow", len([v for v in _venues(client) if v["name"] == "The Rustic"]) == 1)


def test_names_match_without_regard_to_case_and_a_rename_is_a_new_venue():
    client, _ = _setup()
    _fixtures(client)
    pid = _P + 5
    before = len(_venues(client))
    row = _post(client, "/api/projects", _project(pid, venue="moody center", siteAddress="",
                                                  siteInstructions="Use the Red River entrance."))
    _check("case-insensitive match adds no second Moody Center", len(_venues(client)) == before)
    v = _venue(client, "Moody Center")
    _check("the saved name keeps its original casing", v["name"] == "Moody Center")
    _check("a newly-pointed project only ADDS: its instructions are taken", v["instructions"] == "Use the Red River entrance.")
    _check("…and its empty typed address did not blank the saved one", v["address"] == "2001 Robert Dedman Dr, Austin, TX 78712")
    # Rename: a new venue, the old one stays.
    row["venue"] = "Moody Center — Arena Floor"
    _put(client, f"/api/projects/{pid}", row)
    _check("renamed venue is remembered", _venue(client, "Moody Center — Arena Floor") is not None)
    _check("the old venue row stays", _venue(client, "Moody Center") is not None)
    _check("the new row is seeded from the project's current instructions",
           _venue(client, "Moody Center — Arena Floor")["instructions"] == "Use the Red River entrance.")


def test_company_derived_address_is_never_copied_and_clearing_instructions_mirrors():
    client, _ = _setup()
    _fixtures(client)
    pid = _P + 6
    row = _post(client, "/api/projects", _project(pid, companyId=_CO_ADDR, venue="Client HQ Ballroom",
                                                  siteAddress="", siteUseCompanyAddress=True,
                                                  siteInstructions="Valet only."))
    v = _venue(client, "Client HQ Ballroom")
    _check("company-derived address is not the venue's", v["address"] == "")
    _check("instructions still remembered", v["instructions"] == "Valet only.")
    # Switch to a typed address: now it IS the venue's.
    row["siteUseCompanyAddress"] = False
    row["siteAddress"] = "99 Ballroom Way, Austin, TX"
    row = _put(client, f"/api/projects/{pid}", row)
    _check("typed address taken once the switch is off", _venue(client, "Client HQ Ballroom")["address"] == "99 Ballroom Way, Austin, TX")
    # Clear the typed address: the saved one survives.
    row["siteAddress"] = ""
    row = _put(client, f"/api/projects/{pid}", row)
    _check("an emptied address never blanks the saved one", _venue(client, "Client HQ Ballroom")["address"] == "99 Ballroom Way, Austin, TX")
    # Clear the instructions on a project already AT the venue: that is an edit.
    row["siteInstructions"] = ""
    _put(client, f"/api/projects/{pid}", row)
    _check("clearing instructions on a project at the venue clears the memory", _venue(client, "Client HQ Ballroom")["instructions"] == "")


def test_validation_caps_instructions():
    client, _ = _setup()
    _fixtures(client)
    r = client.post("/api/projects", json=_project(_P + 7, venue="Too Long", siteInstructions="x" * 4001), cookies=_cookies())
    _check("over-long siteInstructions is a clean 400", r.status_code == 400, r.text[:200])
    _check("…naming the field", "siteInstructions" in r.text)


# ── Read-only API ────────────────────────────────────────────────────────────

def test_venues_api_is_read_only():
    client, _ = _setup()
    _fixtures(client)
    r = client.get("/api/venues")
    _check("GET /api/venues needs a session", r.status_code == 401, str(r.status_code))
    r = client.post("/api/venues", json={"name": "Sneaky"}, cookies=_cookies())
    _check("POST /api/venues is refused", r.status_code == 405, str(r.status_code))
    v = _venue(client, "Moody Center")
    r = client.put(f"/api/venues/{v['id']}", json={"name": "Sneaky"}, cookies=_cookies())
    _check("PUT /api/venues/{id} is refused", r.status_code in (404, 405), str(r.status_code))
    r = client.delete(f"/api/venues/{v['id']}", cookies=_cookies())
    _check("DELETE /api/venues/{id} is refused", r.status_code in (404, 405), str(r.status_code))
    _check("…and nothing changed", _venue(client, "Moody Center") is not None and _venue(client, "Sneaky") is None)


def test_versions_carry_venues_and_a_save_moves_the_stamp():
    client, _ = _setup()
    _fixtures(client)
    stamps = client.get("/api/versions", cookies=_cookies()).json().get("stamps", {})
    _check("versions has venues", "venues" in stamps, str(list(stamps)))
    before = stamps["venues"]
    _post(client, "/api/projects", _project(_P + 8, venue="Stamp Hall", siteAddress="1 Stamp St"))
    after = client.get("/api/versions", cookies=_cookies()).json()["stamps"]["venues"]
    _check("a project save that taught the memory moves the venues stamp", after != before, f"{before} -> {after}")


# ── Crew-facing ──────────────────────────────────────────────────────────────

def test_crew_call_sheet_carries_the_instructions():
    client, _ = _setup()
    _fixtures(client)
    pid = _P + 9
    _post(client, "/api/services", {"id": 9301, "role": "L1", "description": "Lead Lighting Tech",
                                    "department": "Lighting", "dayRate": 400, "cost": 300})
    _post(client, "/api/projects", _project(
        pid, venue="Moody Center", siteAddress="2001 Robert Dedman Dr, Austin, TX 78712",
        siteInstructions="Crew lot off Red River. Load in at dock 3.",
        schedule=[{"id": "d1", "title": "Load In", "date": "2026-11-01", "time": "08:00", "endTime": "17:00",
                   "positions": [{"id": "pos-9301", "role": "L1", "serviceId": 9301, "crewId": _CONTACT, "status": "open"}]}]))
    r = client.post("/api/crew-requests/send", json={"projectId": pid, "contactId": _CONTACT, "positionIds": ["pos-9301"]},
                    cookies=_cookies())
    _check("crew send ok", r.status_code == 200, r.text[:300])
    token = r.json()["token"]
    page = client.get(f"/api/crew/{token}")
    _check("public call sheet ok", page.status_code == 200, page.text[:200])
    _check("call sheet carries siteInstructions", page.json()["project"]["siteInstructions"] == "Crew lot off Red River. Load in at dock 3.")


# ── Everywhere the address goes ──────────────────────────────────────────────

def _brand():
    return {"accent": "#EF5822", "company": "Luminary"}


def test_request_email_header_carries_the_instructions():
    from backend.routes.crew import _render_crew_request_body
    html = _render_crew_request_body(None, crew_name="Casey", project_name="Gala", company="Luminary",
                                     brand=_brand(), shifts=[], view_url="https://x.test/#/crew/t",
                                     signature_html="", site_address="1 Main St, Austin, TX",
                                     site_instructions="Crew lot off Red River. Dock 3.")
    _check("header card shows the address", "1 Main St, Austin, TX" in html)
    _check("header card shows the instructions under it", "Parking &amp; access:</strong> Crew lot off Red River. Dock 3." in html)
    html2 = _render_crew_request_body(None, crew_name="Casey", project_name="Gala", company="Luminary",
                                      brand=_brand(), shifts=[], view_url="https://x.test/#/crew/t",
                                      signature_html="", site_address="1 Main St, Austin, TX", site_instructions="")
    _check("no instructions → no label", "Parking" not in html2)


def test_location_token_folds_the_instructions_when_the_template_has_no_token():
    from backend.routes.crew import _render_crew_request_body, _with_instructions
    legacy = "Hi {{crewName}},\n\nLocation: {{location}}\n\n{{header}}\n\n{{signature}}"
    html = _render_crew_request_body(legacy, crew_name="Casey", project_name="Gala", company="Luminary",
                                     brand=_brand(), shifts=[], view_url="https://x.test/#/crew/t",
                                     signature_html="", site_address="1 Main St", site_instructions="Gate code 4411")
    _check("a saved body without the token still carries the note under the address",
           "Location: 1 Main St<br>Parking &amp; access: Gate code 4411" in html)
    modern = "Location: {{location}}\nParking & access: {{siteInstructions}}\n\n{{header}}"
    html = _render_crew_request_body(modern, crew_name="Casey", project_name="Gala", company="Luminary",
                                     brand=_brand(), shifts=[], view_url="https://x.test/#/crew/t",
                                     signature_html="", site_address="1 Main St", site_instructions="Gate code 4411")
    _check("a body that places the token gets the bare address on its own line",
           "Location: 1 Main St<br>Parking &amp; access: Gate code 4411" in html and html.count("Gate code 4411") == 2)
    html = _render_crew_request_body(modern, crew_name="Casey", project_name="Gala", company="Luminary",
                                     brand=_brand(), shifts=[], view_url="https://x.test/#/crew/t",
                                     signature_html="", site_address="1 Main St", site_instructions="")
    _check("an empty note drops its label line instead of mailing a bare label",
           "Parking" not in html and "Location: 1 Main St" in html)
    _check("_with_instructions with no address is just the note line",
           _with_instructions("", "Dock 3", "") == "Parking & access: Dock 3")
    _check("_with_instructions leaves the address alone when the template has the token",
           _with_instructions("1 Main", "Dock 3", "x {{siteInstructions}} y") == "1 Main")


def test_unresolved_label_lines_are_narrow():
    from backend.routes.crew import _drop_unresolved_label_lines, _NOTIFY_FALLBACKS
    t = ("Hi,\n\nThe following shifts are affected:\n\n{{shifts}}\n\n"
         "Location: {{location}}\nParking & access: {{siteInstructions}}\n\nBye")
    out = _drop_unresolved_label_lines(t, {"{{location}}": "1 Main", "{{siteInstructions}}": ""})
    _check("an intro ending in a colon survives", "The following shifts are affected:" in out)
    _check("a label whose token is empty goes", "Parking & access" not in out)
    _check("a label whose token has a value stays", "Location: {{location}}" in out)
    _check("the confirmation fallback places the token",
           "Parking & access: {{siteInstructions}}" in _NOTIFY_FALLBACKS["crewConfirmed"]["body"])


def test_deleting_a_project_keeps_the_venue():
    client, _ = _setup()
    _fixtures(client)
    pid = _P + 10
    _post(client, "/api/projects", _project(pid, venue="Ephemeral Hall", siteAddress="2 Gone St"))
    _check("remembered", _venue(client, "Ephemeral Hall") is not None)
    r = client.delete(f"/api/projects/{pid}", cookies=_cookies())
    _check("project deleted", r.status_code == 200, r.text[:200])
    _check("venue survives the project", _venue(client, "Ephemeral Hall") is not None)


def _teardown():
    global _client
    if _client is not None:
        _client.__exit__(None, None, None)
        _client = None


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        print(t.__name__)
        try:
            t()
        except AssertionError as e:
            failed += 1
            print(f"  FAILED: {e}")
    _teardown()
    passed = sum(1 for _, ok in _results if ok)
    print(f"\nvenues suite — PASS: {passed}   FAIL: {len(_results) - passed}   ({len(tests)} tests, {failed} failed)")
    sys.exit(1 if failed else 0)
