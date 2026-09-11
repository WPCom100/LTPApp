"""Cross rentals — vendor price memory + orders of gear rented in.

Covers the backend half of docs/CROSS_RENTAL_PLAN.md:
  - The migration lands both tables, the equipment flag and the allocation
    source columns on a fresh database (the TestClient lifespan runs
    `alembic upgrade head`).
  - vendor-rates and cross-rentals round-trip through the generic CRUD API,
    including an order's JSON `lines` list.
  - The validator rejects a bad order status, a malformed date, a non-list
    `lines`, a bad vendor quotedDate, and a bad allocation docType.
  - A vendor/equipment id that does not exist is a clean 400, not a 500.
  - /api/versions carries both new collections so live sync can publish them.
  - equipment.crossRentalOnly round-trips.

FK cascades (vendor delete → prices, equipment delete → prices) are declared
on the columns and enforced by Postgres; SQLite does not enforce them in this
suite, so they are not asserted here.

Runs both as pytest and as a plain script:
    python tests/test_cross_rentals.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_cross_rentals.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

_db_path = os.path.join(_root, "_test_cross_rentals.db")
if os.path.exists(_db_path):
    os.remove(_db_path)

from backend import models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402

_ADMIN_TOK = "crossrental-admin-session-token"
_client = None
_seeded = False


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
                admin = models.User(google_sub="crossrental-admin-sub", email="crossrental@biz.com",
                                    name="Cross Admin", role="admin")
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


# ── Fixtures created through the API ─────────────────────────────────────────

_ids: dict = {}


def _fixtures(client):
    if _ids:
        return _ids
    _ids["vendor"] = _post(client, "/api/companies", {"id": 9101, "name": "PRG", "isVendor": True, "isClient": False})["id"]
    _ids["vendor2"] = _post(client, "/api/companies", {"id": 9102, "name": "4Wall", "isVendor": True, "isClient": False})["id"]
    _ids["eq"] = _post(client, "/api/equipment", {"id": 9101, "name": "Mac Aura XB", "category": "Lighting",
                                                  "qty": 4, "rates": {"threeDay": 120, "week": 240, "month": 600}})["id"]
    return _ids


# ── Schema ───────────────────────────────────────────────────────────────────

def test_migration_lands_the_schema():
    _setup()
    import sqlite3
    # Under pytest, conftest pins one shared file DB for the whole session;
    # standalone, the header's setdefault above wins. Inspect whichever is live.
    live = os.environ["DATABASE_URL"].split("///", 1)[1]
    db = sqlite3.connect(os.path.join(_root, live) if not os.path.isabs(live) else live)
    tables = {r[0] for r in db.execute("select name from sqlite_master where type='table'")}
    _check("vendor_rates table exists", "vendor_rates" in tables)
    _check("cross_rentals table exists", "cross_rentals" in tables)
    alloc_cols = {c[1] for c in db.execute("pragma table_info(allocations)")}
    _check("allocations carries doc_type/doc_id/line_id", {"doc_type", "doc_id", "line_id"} <= alloc_cols)
    eq_cols = {c[1] for c in db.execute("pragma table_info(equipment)")}
    _check("equipment carries cross_rental_only", "cross_rental_only" in eq_cols)
    db.close()


# ── Vendor rates ─────────────────────────────────────────────────────────────

def test_vendor_rate_round_trip():
    client, _ = _setup()
    ids = _fixtures(client)
    row = _post(client, "/api/vendor-rates", {
        "id": 9101, "vendorCompanyId": ids["vendor"], "equipmentId": ids["eq"],
        "rates": {"threeDay": 60, "week": 120, "month": 300}, "vendorItem": "AURA-XB",
        "quotedDate": "2026-09-01", "preferred": True, "notes": "delivers",
    })
    _check("rates JSON stored verbatim (camelCase inner keys)", row["rates"] == {"threeDay": 60, "week": 120, "month": 300})
    _check("active defaults True", row["active"] is True)
    _check("preferred stored", row["preferred"] is True)
    r = client.put("/api/vendor-rates/9101", json={"rates": {"threeDay": 65, "week": 130, "month": 320},
                                                   "quotedDate": "2026-09-10"}, cookies=_cookies())
    _check("PUT vendor rate ok", r.status_code == 200, r.text[:200])
    _check("PUT updated the rates", r.json()["rates"]["threeDay"] == 65)
    got = client.get("/api/vendor-rates", cookies=_cookies()).json()
    _check("GET list carries the row", any(v["id"] == 9101 for v in got))


def test_vendor_rate_validation():
    client, _ = _setup()
    ids = _fixtures(client)
    r = client.post("/api/vendor-rates", json={"vendorCompanyId": ids["vendor"], "equipmentId": ids["eq"],
                                               "quotedDate": "last spring"}, cookies=_cookies())
    _check("non-ISO quotedDate rejected", r.status_code == 400, r.text[:200])
    r = client.post("/api/vendor-rates", json={"vendorCompanyId": 424242, "equipmentId": ids["eq"]}, cookies=_cookies())
    _check("unknown vendor id is a clean 400", r.status_code == 400, r.text[:200])
    _check("…naming the field", "vendorCompanyId" in r.text)
    r = client.post("/api/vendor-rates", json={"vendorCompanyId": ids["vendor"], "equipmentId": 424242}, cookies=_cookies())
    _check("unknown equipment id is a clean 400", r.status_code == 400, r.text[:200])
    r = client.post("/api/vendor-rates", json={"vendorCompanyId": ids["vendor"], "equipmentId": ids["eq"],
                                               "rates": [1, 2, 3]}, cookies=_cookies())
    _check("rates must be an object", r.status_code == 400, r.text[:200])


# ── Cross-rental orders ──────────────────────────────────────────────────────

def test_cross_rental_order_round_trip():
    client, _ = _setup()
    ids = _fixtures(client)
    lines = [
        {"id": "crl-1", "equipmentId": ids["eq"], "name": "Mac Aura XB", "qty": 6,
         "startDate": "", "endDate": "", "rates": {"threeDay": 60, "week": 120, "month": 300},
         "costOverride": None, "notes": ""},
        {"id": "crl-2", "equipmentId": None, "name": "Safety cables", "qty": 6,
         "startDate": "", "endDate": "", "rates": {"threeDay": 2, "week": 4, "month": 10},
         "costOverride": 10, "notes": "parts"},
    ]
    row = _post(client, "/api/cross-rentals", {
        "id": 9101, "vendorCompanyId": ids["vendor"], "reference": "PO-4471",
        "startDate": "2026-10-01", "endDate": "2026-10-07", "lines": lines, "notes": "",
    })
    _check("status defaults to quoted", row["status"] == "quoted")
    _check("lines list stored verbatim", row["lines"] == lines)
    _check("rememberRates defaults True", row["rememberRates"] is True)
    _check("projectId optional (null)", row["projectId"] is None)
    r = client.put("/api/cross-rentals/9101", json={"status": "confirmed"}, cookies=_cookies())
    _check("PUT status confirmed ok", r.status_code == 200, r.text[:200])
    _check("status moved", r.json()["status"] == "confirmed")
    got = client.get("/api/cross-rentals/9101", cookies=_cookies()).json()
    _check("GET one carries the lines", len(got["lines"]) == 2 and got["lines"][1]["name"] == "Safety cables")


def test_cross_rental_validation():
    client, _ = _setup()
    ids = _fixtures(client)
    base = {"vendorCompanyId": ids["vendor"], "startDate": "2026-10-01", "endDate": "2026-10-07", "lines": []}
    r = client.post("/api/cross-rentals", json=dict(base, status="maybe"), cookies=_cookies())
    _check("unknown status rejected", r.status_code == 400, r.text[:200])
    r = client.post("/api/cross-rentals", json=dict(base, startDate="Oct 1"), cookies=_cookies())
    _check("non-ISO startDate rejected", r.status_code == 400, r.text[:200])
    r = client.post("/api/cross-rentals", json=dict(base, lines={"a": 1}), cookies=_cookies())
    _check("lines must be a list", r.status_code == 400, r.text[:200])
    r = client.post("/api/cross-rentals", json=dict(base, reference="x" * 101), cookies=_cookies())
    _check("reference length capped", r.status_code == 400, r.text[:200])
    r = client.post("/api/cross-rentals", json=dict(base, projectId=424242), cookies=_cookies())
    _check("unknown projectId is a clean 400", r.status_code == 400, r.text[:200])


def test_allocation_doc_type_validation_and_default():
    client, _ = _setup()
    ids = _fixtures(client)
    r = client.post("/api/allocations", json={"equipmentId": ids["eq"], "qty": 1, "startDate": "2026-10-01",
                                              "endDate": "2026-10-02", "docType": "email"}, cookies=_cookies())
    _check("unknown allocation docType rejected", r.status_code == 400, r.text[:200])
    row = _post(client, "/api/allocations", {"id": 9101, "equipmentId": ids["eq"], "qty": 1,
                                             "startDate": "2026-10-01", "endDate": "2026-10-02"})
    _check("a hand-entered booking defaults to docType manual", row["docType"] == "manual")
    _check("…with no document id", row["docId"] is None)


def test_equipment_cross_rental_only_round_trip():
    client, _ = _setup()
    row = _post(client, "/api/equipment", {"id": 9102, "name": "Hazer we never bought", "category": "SFX",
                                           "qty": 0, "crossRentalOnly": True,
                                           "rates": {"threeDay": 90, "week": 180, "month": 450}})
    _check("crossRentalOnly stored", row["crossRentalOnly"] is True)
    plain = client.get("/api/equipment/9101", cookies=_cookies()).json()
    _check("existing rows read as not cross-rental-only", plain["crossRentalOnly"] in (False, None))


def test_versions_carry_the_new_collections():
    client, _ = _setup()
    v = client.get("/api/versions", cookies=_cookies()).json().get("stamps", {})
    _check("versions has vendor-rates", "vendor-rates" in v, str(list(v)))
    _check("versions has cross-rentals", "cross-rentals" in v, str(list(v)))


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
            print("   FAILED:", e)
    _teardown()
    passed = sum(1 for _, ok in _results if ok)
    print(f"\ncross-rentals suite — PASS: {passed}   FAIL: {len(_results) - passed}")
    sys.exit(1 if failed or passed != len(_results) else 0)
