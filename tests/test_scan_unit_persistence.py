"""Round-trip persistence for barcode-scanned serialized units.

The scan-import flow (modules/rentals-scan.js) appends units to
Equipment.units shaped like:

    {id, serial:"", barcode:<scanned>, purchaseDate, purchaseVendorId,
     purchaseCost, status, location, maintenanceLogs:[]}

`location` is a NEW per-unit key (the equipment-level column is unrelated).
The backend stores `units` as an opaque JSON column and
backend/validators.py validates only top-level Equipment fields, so the
new key needs no migration and no validator change. These tests prove it
survives POST → GET and an incremental PUT (the append-per-scan path),
using real asserts so pytest fails loudly on regression.

Runs under pytest (conftest pins the shared DB) or standalone:
    python tests/test_scan_unit_persistence.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
# Required once an HTTPS redirect URI is present (matches conftest.py); harmless
# under pytest where conftest already set it (setdefault leaves it untouched).
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_scan_units.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

# Standalone-only clean slate (pytest uses conftest's shared DB, set first).
if os.environ["DATABASE_URL"].endswith("_test_scan_units.db"):
    _db_path = os.path.join(_root, "_test_scan_units.db")
    if os.path.exists(_db_path):
        os.remove(_db_path)

from backend import models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402


_client = None
_seeded = False
# Unique session id so this file is order-independent within the shared test DB.
_admin_session_id = "scan-units-admin-session"


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
                admin = models.User(
                    google_sub="scan-units-admin-sub",
                    email="scan-units-admin@biz.com",
                    name="Scan Admin", role="admin",
                )
                db.add(admin)
                await db.flush()
                db.add(models.Session(
                    id=hash_session_token(_admin_session_id), user_id=admin.id,
                    expires_at=datetime.now(timezone.utc) + timedelta(days=7),
                ))
                await db.commit()

        asyncio.run(seed())
        _seeded = True
    return _client, _admin_session_id


def _teardown():
    global _client
    if _client is not None:
        _client.__exit__(None, None, None)
        _client = None


def _scanned_unit(uid, barcode, **over):
    unit = {
        "id": uid, "serial": "", "barcode": barcode,
        "purchaseDate": "2026-05-01", "purchaseVendorId": 7,
        "purchaseCost": 42.5, "status": "available",
        "location": "Warehouse A", "maintenanceLogs": [],
    }
    unit.update(over)
    return unit


def test_scanned_units_round_trip_on_create():
    """POST a serialized item with two scanned units; GET it back and
    assert every per-unit field — including the new `location` key —
    survives verbatim."""
    print("test_scanned_units_round_trip_on_create")
    client, tok = _setup()
    payload = {
        "name": "XLR Cable 25ft",
        "category": "Audio",
        "serialized": True,
        "qty": 2,
        "units": [
            _scanned_unit(1, "LTP-XLR-001"),
            _scanned_unit(2, "LTP-XLR-002", location="Warehouse B",
                          purchaseVendorId=8, status="under-maintenance"),
        ],
    }
    r = client.post("/api/equipment", json=payload, cookies={"ltp_session": tok})
    assert r.status_code == 200, f"POST failed {r.status_code}: {r.text[:200]}"
    eq_id = r.json()["id"]

    fresh = client.get(f"/api/equipment/{eq_id}", cookies={"ltp_session": tok}).json()
    units = fresh.get("units") or []
    assert len(units) == 2, f"expected 2 units, got {len(units)}"

    by_barcode = {u["barcode"]: u for u in units}
    u1 = by_barcode["LTP-XLR-001"]
    assert u1["serial"] == "", "serial should stay blank (scan → barcode only)"
    assert u1["location"] == "Warehouse A", "per-unit location must round-trip"
    assert u1["purchaseVendorId"] == 7
    assert u1["purchaseCost"] == 42.5
    assert u1["purchaseDate"] == "2026-05-01"
    assert u1["status"] == "available"

    u2 = by_barcode["LTP-XLR-002"]
    assert u2["location"] == "Warehouse B", "second batch's location preserved"
    assert u2["purchaseVendorId"] == 8
    assert u2["status"] == "under-maintenance"


def test_scanned_units_append_on_update():
    """The detail-route path persists each scan as an incremental PUT that
    grows units[]. Simulate: create with 1 unit, PUT with 2, GET and assert
    both survive with location intact and qty tracks the count."""
    print("test_scanned_units_append_on_update")
    client, tok = _setup()
    create = client.post("/api/equipment", json={
        "name": "DMX Cable 10ft", "category": "Lighting",
        "serialized": True, "qty": 1,
        "units": [_scanned_unit(1, "LTP-DMX-001")],
    }, cookies={"ltp_session": tok})
    assert create.status_code == 200, create.text[:200]
    eq_id = create.json()["id"]

    put = client.put(f"/api/equipment/{eq_id}", json={
        "id": eq_id, "name": "DMX Cable 10ft", "category": "Lighting",
        "serialized": True, "qty": 2,
        "units": [
            _scanned_unit(1, "LTP-DMX-001"),
            _scanned_unit(2, "LTP-DMX-002", location="Shelf 3"),
        ],
    }, cookies={"ltp_session": tok})
    assert put.status_code == 200, f"PUT failed {put.status_code}: {put.text[:200]}"

    fresh = client.get(f"/api/equipment/{eq_id}", cookies={"ltp_session": tok}).json()
    units = fresh.get("units") or []
    assert len(units) == 2, f"expected 2 units after append, got {len(units)}"
    assert fresh.get("qty") == 2, "qty should track unit count for serialized items"
    locations = sorted(u.get("location", "") for u in units)
    assert locations == ["Shelf 3", "Warehouse A"], f"locations lost: {locations}"


def main() -> int:
    failures = 0
    try:
        for fn in (test_scanned_units_round_trip_on_create,
                   test_scanned_units_append_on_update):
            try:
                fn()
                print(f"  [PASS] {fn.__name__}")
            except AssertionError as e:
                failures += 1
                print(f"  [FAIL] {fn.__name__}: {e}")
    finally:
        _teardown()
    print()
    print(f"== {2 - failures}/2 checks passed ==")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
