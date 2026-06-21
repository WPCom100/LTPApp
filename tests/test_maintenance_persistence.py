"""Round-trip persistence for maintenance logs on Equipment + Container.

Closes the silent-data-loss gap where the frontend wrote maintenance
data to two fields that had no backend column:

  - Equipment.maintenanceLogs (parent-level, for NON-serialized items)
  - Container.units (per-unit records for SERIALIZED containers; each
    unit holds its own maintenanceLogs)

`_dict_to_row` in backend/routes/api.py filters incoming keys to the
model's actual columns and silently drops the rest, so a PUT carrying
either field would return 200 + the original input in the response —
making the bug invisible in DevTools — while losing the data on next
GET. These tests POST, GET, PUT, and GET again, asserting the
maintenance data survives every transition.

Runs as a plain script:
    python tests/test_maintenance_persistence.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_maintenance.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

# Clean test DB before importing — guarantees the alembic migration
# stack runs from scratch so the new column shows up.
_db_path = os.path.join(_root, "_test_maintenance.db")
if os.path.exists(_db_path):
    os.remove(_db_path)

from backend import models  # noqa: E402


_results: list[tuple[str, bool]] = []


def _check(label: str, cond: bool, detail: str = "") -> None:
    _results.append((label, cond))
    status = "PASS" if cond else "FAIL"
    suffix = f"  ({detail})" if detail else ""
    print(f"  [{status}] {label}{suffix}")


# ── Setup ─────────────────────────────────────────────────────────────────


_client = None
_seeded = False
_admin_session_id = "maint-admin-session"


def _setup_test_client():
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
                    google_sub="maint-admin-sub", email="maint-admin@biz.com",
                    name="Maint Admin", role="admin",
                )
                db.add(admin)
                await db.flush()
                session = models.Session(
                    id=_admin_session_id, user_id=admin.id,
                    expires_at=datetime.now(timezone.utc) + timedelta(days=7),
                )
                db.add(session)
                await db.commit()

        asyncio.run(seed())
        _seeded = True

    return _client, _admin_session_id


def _teardown_client():
    global _client
    if _client is not None:
        _client.__exit__(None, None, None)
        _client = None


# ── Schema sanity: the migration ran and the new columns exist ───────────


def test_models_declare_new_columns():
    """The Equipment + Container ORM classes must expose the new
    JSON columns. Catches a half-applied fix where the migration ran
    but someone forgot to update models.py (so the column exists in
    the DB but _dict_to_row still strips the field because it isn't
    in model_cls.__table__.columns)."""
    print("test_models_declare_new_columns")
    eq_cols = {c.name for c in models.Equipment.__table__.columns}
    cn_cols = {c.name for c in models.Container.__table__.columns}
    _check("Equipment.maintenance_logs column declared",
           "maintenance_logs" in eq_cols)
    _check("Container.units column declared",
           "units" in cn_cols)
    _check("Container.maintenance_logs column still present (was already there)",
           "maintenance_logs" in cn_cols)


# ── Equipment, non-serialized: parent-level maintenanceLogs round-trip ───


def test_equipment_nonserialized_maintenance_logs_persist_on_create():
    """POST a non-serialized equipment with one open maintenance log;
    immediately GET it back and assert the log survived. Before this
    fix, the log was silently dropped on PUT and on POST."""
    print("test_equipment_nonserialized_maintenance_logs_persist_on_create")
    client, admin_tok = _setup_test_client()
    payload = {
        "name": "Source Four LED Series 3",
        "serialized": False,
        "qty": 10,
        "maintenanceLogs": [
            {"id": 1717000000001, "date": "2026-06-20",
             "issue": "Lamp module needs replacement",
             "status": "open", "resolvedDate": None},
        ],
    }
    r = client.post("/api/equipment", json=payload,
                    cookies={"ltp_session": admin_tok})
    _check("POST 200", r.status_code == 200, f"got {r.status_code}: {r.text[:200]}")
    body = r.json()
    eq_id = body.get("id")
    _check("response includes id", isinstance(eq_id, int))
    _check("response carries maintenanceLogs",
           isinstance(body.get("maintenanceLogs"), list)
           and len(body["maintenanceLogs"]) == 1,
           f"got {body.get('maintenanceLogs')!r}")

    # Refresh from disk — this is where the silent-drop bug used to bite.
    r2 = client.get(f"/api/equipment/{eq_id}",
                    cookies={"ltp_session": admin_tok})
    _check("GET 200", r2.status_code == 200)
    fresh = r2.json()
    logs = fresh.get("maintenanceLogs") or []
    _check("GET back carries 1 maintenance log", len(logs) == 1,
           f"got {len(logs)} logs")
    if logs:
        log = logs[0]
        _check("log issue text preserved",
               log.get("issue") == "Lamp module needs replacement")
        _check("log status preserved", log.get("status") == "open")
        _check("log date preserved", log.get("date") == "2026-06-20")


def test_equipment_nonserialized_maintenance_logs_persist_on_update():
    """Open issue, then resolve it via PUT, then GET — the resolved log
    should be there with resolvedDate set."""
    print("test_equipment_nonserialized_maintenance_logs_persist_on_update")
    client, admin_tok = _setup_test_client()
    # Create with one log
    create_resp = client.post("/api/equipment", json={
        "name": "Smoke Machine",
        "serialized": False,
        "qty": 4,
        "maintenanceLogs": [
            {"id": 1717000000002, "date": "2026-06-15",
             "issue": "Pump making grinding noise",
             "status": "open", "resolvedDate": None},
        ],
    }, cookies={"ltp_session": admin_tok})
    _check("POST 200", create_resp.status_code == 200)
    eq_id = create_resp.json()["id"]

    # PUT a resolution
    put_resp = client.put(f"/api/equipment/{eq_id}", json={
        "id": eq_id,
        "name": "Smoke Machine",
        "serialized": False,
        "qty": 4,
        "maintenanceLogs": [
            {"id": 1717000000002, "date": "2026-06-15",
             "issue": "Pump making grinding noise",
             "status": "resolved", "resolvedDate": "2026-06-20"},
        ],
    }, cookies={"ltp_session": admin_tok})
    _check("PUT 200", put_resp.status_code == 200,
           f"got {put_resp.status_code}: {put_resp.text[:200]}")

    # Refresh
    fresh = client.get(f"/api/equipment/{eq_id}",
                       cookies={"ltp_session": admin_tok}).json()
    logs = fresh.get("maintenanceLogs") or []
    _check("still one log after PUT", len(logs) == 1)
    if logs:
        _check("status now 'resolved'", logs[0].get("status") == "resolved")
        _check("resolvedDate now set",
               logs[0].get("resolvedDate") == "2026-06-20")


def test_equipment_serialized_per_unit_logs_still_persist():
    """Regression guard for the path that was ALREADY working — make
    sure adding the parent-level column didn't break serialized
    equipment's per-unit logs nested inside units[]."""
    print("test_equipment_serialized_per_unit_logs_still_persist")
    client, admin_tok = _setup_test_client()
    payload = {
        "name": "Mac Quantum",
        "serialized": True,
        "qty": 2,
        "units": [
            {"id": 1, "serial": "MQ-001", "barcode": "MQ001",
             "status": "available", "maintenanceLogs": []},
            {"id": 2, "serial": "MQ-002", "barcode": "MQ002",
             "status": "under-maintenance",
             "maintenanceLogs": [
                 {"id": 100, "date": "2026-06-18",
                  "issue": "Pan motor stalling",
                  "status": "open", "resolvedDate": None},
             ]},
        ],
    }
    r = client.post("/api/equipment", json=payload,
                    cookies={"ltp_session": admin_tok})
    _check("POST 200", r.status_code == 200,
           f"got {r.status_code}: {r.text[:200]}")
    eq_id = r.json()["id"]

    fresh = client.get(f"/api/equipment/{eq_id}",
                       cookies={"ltp_session": admin_tok}).json()
    units = fresh.get("units") or []
    _check("two units survived", len(units) == 2)
    if len(units) >= 2:
        unit2 = next((u for u in units if u.get("serial") == "MQ-002"), None)
        _check("second unit has one open log",
               unit2 is not None
               and len(unit2.get("maintenanceLogs", [])) == 1)
        if unit2 and unit2.get("maintenanceLogs"):
            _check("nested log issue preserved",
                   unit2["maintenanceLogs"][0].get("issue") == "Pan motor stalling")


# ── Container, serialized: units[] round-trip ─────────────────────────────


def test_container_serialized_units_persist_on_create():
    """A serialized container creates with N units; each unit may
    carry its own maintenanceLogs. Before this fix the `units` field
    was silently dropped because Container had no `units` column."""
    print("test_container_serialized_units_persist_on_create")
    client, admin_tok = _setup_test_client()
    payload = {
        "name": "Lift Case",
        "type": "Road Case",
        "serialized": True,
        "qty": 2,
        "units": [
            {"id": 1, "serial": "LC-A", "barcode": "LCA",
             "status": "available", "maintenanceLogs": []},
            {"id": 2, "serial": "LC-B", "barcode": "LCB",
             "status": "under-maintenance",
             "maintenanceLogs": [
                 {"id": 200, "date": "2026-06-19",
                  "issue": "Caster wheel broken",
                  "status": "open", "resolvedDate": None},
             ]},
        ],
    }
    r = client.post("/api/containers", json=payload,
                    cookies={"ltp_session": admin_tok})
    _check("POST 200", r.status_code == 200,
           f"got {r.status_code}: {r.text[:200]}")
    body = r.json()
    cn_id = body.get("id")
    _check("response includes units",
           isinstance(body.get("units"), list) and len(body["units"]) == 2,
           f"got units={body.get('units')!r}")

    fresh = client.get(f"/api/containers/{cn_id}",
                       cookies={"ltp_session": admin_tok}).json()
    units = fresh.get("units") or []
    _check("GET back has 2 units", len(units) == 2)
    if len(units) >= 2:
        u_b = next((u for u in units if u.get("serial") == "LC-B"), None)
        _check("LC-B unit present", u_b is not None)
        if u_b:
            logs = u_b.get("maintenanceLogs") or []
            _check("LC-B has one open log", len(logs) == 1)
            if logs:
                _check("log issue preserved",
                       logs[0].get("issue") == "Caster wheel broken")


def test_container_nonserialized_maintenance_logs_still_persist():
    """Regression guard for the Container path that was ALREADY working
    (line-level maintenance_logs column existed). Adding the units
    column shouldn't change behavior here."""
    print("test_container_nonserialized_maintenance_logs_still_persist")
    client, admin_tok = _setup_test_client()
    payload = {
        "name": "Shelf",
        "type": "Soft Bag",
        "serialized": False,
        "qty": 8,
        "maintenanceLogs": [
            {"id": 300, "date": "2026-06-20",
             "issue": "Strap fraying", "status": "open", "resolvedDate": None},
        ],
    }
    r = client.post("/api/containers", json=payload,
                    cookies={"ltp_session": admin_tok})
    _check("POST 200", r.status_code == 200)
    cn_id = r.json()["id"]
    fresh = client.get(f"/api/containers/{cn_id}",
                       cookies={"ltp_session": admin_tok}).json()
    logs = fresh.get("maintenanceLogs") or []
    _check("parent-level log survived", len(logs) == 1)


# ── Main ──────────────────────────────────────────────────────────────────


def main() -> int:
    try:
        test_models_declare_new_columns()
        test_equipment_nonserialized_maintenance_logs_persist_on_create()
        test_equipment_nonserialized_maintenance_logs_persist_on_update()
        test_equipment_serialized_per_unit_logs_still_persist()
        test_container_serialized_units_persist_on_create()
        test_container_nonserialized_maintenance_logs_still_persist()
    finally:
        _teardown_client()

    fail_count = sum(1 for _, ok in _results if not ok)
    print()
    print(f"== {len(_results) - fail_count}/{len(_results)} checks passed ==")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
