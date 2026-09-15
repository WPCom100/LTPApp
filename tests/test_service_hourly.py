"""Hourly roles — the per-hour pricing switch on a rate-card Service.

`services.hourly` (backend/models.py::Service) flips ONE role from the
half/full-day card to per-hour pricing (shop and warehouse work). The MATH
lives in the frontend engine (components/domain-labor.js::LTP_calcDayLabor,
pinned by tests/test_labor_rates.js section N and tests/test_doc_projects.js).
What the backend owes the feature — and what this suite proves — is:

  - the flag round-trips through POST/GET/PUT as camelCase `hourly`, and a
    role created without it reads as a day-rate role (false), so every row
    that predates the column keeps pricing exactly as before
  - validation rejects a non-boolean: a truthy string like "false" (or a 1)
    must never switch a role to hourly pricing — 400, not a stored surprise
  - the QuickBooks vendor-bill description labels an hourly day "Hourly"
    (backend/qbo_payouts.py), the way it labels a half or full day

Mirrors tests/test_client_rates.py's harness (shared session DB under pytest,
own DATABASE_URL standalone). Fixture ids sit in a dedicated range so the
module is order-independent inside the combined suite.
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_service_hourly.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

_db_path = os.path.join(_root, "_test_service_hourly.db")
if os.path.exists(_db_path):
    os.remove(_db_path)

from backend import models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402


# ── Dedicated fixture ids ────────────────────────────────────────────────────
SH_DAY = 8960       # a role created without the flag — must read as day-rate
SH_HOURLY = 8961    # created hourly, then flipped back
SH_REJECT = 8962    # never created: the payload is rejected

_ADMIN_TOK = "service-hourly-session"
_client = None
_seeded = False


def _setup():
    """Boot the TestClient once and seed the admin session."""
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
                admin = models.User(google_sub="sh-admin-sub", email="sh-admin@biz.com",
                                    name="Service Hourly Admin", role="admin")
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


def _service_payload(sid, **over):
    """The row the Services form (modules/quotes-services.js) POSTs for a
    day-rate role; the hourly form adds `hourly` + the hourly figures."""
    body = {
        "id": sid, "role": "SH", "description": "Shop Hand", "department": "Production",
        "dayRate": 400, "dayCost": 240, "notes": "",
        "qbIncomeAccountId": None, "qbExpenseAccountId": None,
    }
    body.update(over)
    return body


def _post(client, tok, body):
    return client.post("/api/services", json=body, cookies={"ltp_session": tok})


def _get(client, tok, sid):
    return client.get(f"/api/services/{sid}", cookies={"ltp_session": tok}).json()


# ── Tests ────────────────────────────────────────────────────────────────────

def test_role_without_the_flag_is_a_day_rate_role():
    """A service created the way every role has always been created carries
    hourly=false: the column default, so nothing that predates the flag moves."""
    client, tok = _setup()
    r = _post(client, tok, _service_payload(SH_DAY, role="L1", description="Lead Lighting"))
    assert r.status_code == 200, r.text
    assert r.json()["hourly"] is False
    assert _get(client, tok, SH_DAY)["hourly"] is False
    assert _get(client, tok, SH_DAY)["dayRate"] == 400


def test_hourly_round_trips_and_flips_back():
    """POST an hourly role with its hourly figures, read it back, then PUT it
    back to day-rate — the flag survives both directions as a real boolean."""
    client, tok = _setup()
    r = _post(client, tok, _service_payload(SH_HOURLY, hourly=True, hourlyRate=40, hourlyCost=25))
    assert r.status_code == 200, r.text
    created = r.json()
    assert created["hourly"] is True
    assert created["hourlyRate"] == 40 and created["hourlyCost"] == 25

    row = _get(client, tok, SH_HOURLY)
    assert row["hourly"] is True
    assert any(x["id"] == SH_HOURLY and x["hourly"] is True
               for x in client.get("/api/services", cookies={"ltp_session": tok}).json())

    body = _service_payload(SH_HOURLY, hourly=False, hourlyRate=40, hourlyCost=25)
    r = client.put(f"/api/services/{SH_HOURLY}", json=body, cookies={"ltp_session": tok})
    assert r.status_code == 200, r.text
    assert r.json()["hourly"] is False
    assert _get(client, tok, SH_HOURLY)["hourly"] is False


def test_hourly_rejects_anything_but_a_boolean():
    """The flag changes how money is computed, so only true/false may set it.
    A truthy string or a 1 is a 400 naming the field — never stored."""
    client, tok = _setup()
    for bad in ("false", "true", 1, 0, "yes"):
        r = _post(client, tok, _service_payload(SH_REJECT, hourly=bad))
        assert r.status_code == 400, (bad, r.text)
        assert r.json()["detail"]["field"] == "hourly"
    assert client.get(f"/api/services/{SH_REJECT}", cookies={"ltp_session": tok}).status_code == 404
    # null means "unset" and takes the column default, like every other field.
    r = _post(client, tok, _service_payload(SH_REJECT, hourly=None))
    assert r.status_code == 200, r.text
    assert r.json()["hourly"] in (False, None)


def test_bill_line_labels_an_hourly_day():
    """backend/qbo_payouts.py describes each work line by its tier; an hourly
    day reads "Hourly" beside its hours, the way a day-rate day reads "Full day"."""
    from backend import qbo_payouts
    hourly = {"project_name": "Shop Prep", "date": "2026-09-14", "tier": "hourly"}
    assert qbo_payouts._work_line_desc(hourly, qbo_payouts._hours_label(7, 1)) == \
        "Shop Prep · 2026-09-14 · Hourly · 7h +1h OT"
    full = {"project_name": "Gala", "date": "2026-09-14", "tier": "full"}
    assert qbo_payouts._work_line_desc(full, qbo_payouts._hours_label(10, 0)) == \
        "Gala · 2026-09-14 · Full day · 10h"


if __name__ == "__main__":
    try:
        for name, fn in list(globals().items()):
            if name.startswith("test_") and callable(fn):
                fn()
                print(f"  ok  {name}")
        print("service-hourly suite passed")
    finally:
        _teardown()
