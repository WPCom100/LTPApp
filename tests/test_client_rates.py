"""Client service rates — the per-(client, service) rate override entity.

A client can negotiate a different rate for SPECIFIC roles, plus a minimum
number of billable/payable hours per day ("A1 for FUMC is a reduced day rate,
but carries a full 10-hour day minimum"). Those overrides are rows in
`client_rates` (backend/models.py::ClientRate), served by the generic CRUD
factory at /api/client-rates.

The PRICING lives entirely in the frontend engine (theme.js::
LTP_servicesForClient + LTP_calcDayLabor, covered by tests/test_labor_rates.js).
What the backend owes the feature — and what this suite proves — is:

  - the row round-trips through POST/GET/PUT/DELETE with camelCase mapping,
    including the hyphenated route path the frontend state key derives
  - a NULL rate column round-trips as null ("inherit the base card") and is
    distinguishable from a stored 0 (a genuinely free tier) — the whole
    resolution rule depends on that distinction surviving the database
  - validation rejects negative money / hours and a bogus clientType
  - foreign keys are validated on write (a rate for a service that doesn't
    exist is a 400, not a 500) and CASCADE on parent delete, so an override
    can never outlive the client or the service it qualifies

Mirrors tests/test_manual_shift.py's harness (shared session DB under pytest,
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
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_client_rates.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

_db_path = os.path.join(_root, "_test_client_rates.db")
if os.path.exists(_db_path):
    os.remove(_db_path)

from backend import models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402


# ── Dedicated fixture ids ────────────────────────────────────────────────────
CR_COMPANY = 6900       # the client (FUMC stand-in)
CR_COMPANY_DOOMED = 6901  # deleted to prove the FK cascade
CR_CONTACT = 6902       # a directly-billed individual
CR_SVC_A1 = 6910        # A1 — Lead Audio
CR_SVC_L1 = 6911        # L1 — Lead Lighting
CR_SVC_DOOMED = 6912    # deleted to prove the FK cascade

R_ROUNDTRIP = 6920
R_NULLS = 6921
R_CONTACT = 6922
R_COMPANY_CASCADE = 6923
R_SERVICE_CASCADE = 6924
R_UPDATE = 6925

_ADMIN_TOK = "client-rates-session"
_client = None
_seeded = False


def _setup():
    """Boot the TestClient once and seed the clients + rate-card services."""
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
                admin = models.User(google_sub="cr-admin-sub", email="cr-admin@biz.com",
                                    name="Client Rates Admin", role="admin")
                db.add(admin)
                await db.flush()
                db.add(models.Session(id=hash_session_token(_ADMIN_TOK), user_id=admin.id,
                                      expires_at=datetime.now(timezone.utc) + timedelta(days=7)))
                db.add(models.Company(id=CR_COMPANY, name="First United Methodist", is_client=True))
                db.add(models.Company(id=CR_COMPANY_DOOMED, name="Soon Gone Co", is_client=True))
                db.add(models.Contact(id=CR_CONTACT, first_name="Dana", last_name="Direct",
                                      email="dana@example.com"))
                db.add(models.Service(id=CR_SVC_A1, role="A1", description="Lead Audio",
                                      department="Audio", day_rate=1000, day_cost=600))
                db.add(models.Service(id=CR_SVC_L1, role="L1", description="Lead Lighting",
                                      department="Lighting", day_rate=900, day_cost=500))
                db.add(models.Service(id=CR_SVC_DOOMED, role="XX", description="Doomed Role",
                                      department="Production", day_rate=100, day_cost=50))
                await db.commit()

        asyncio.run(seed())
        _seeded = True
    return _client, _ADMIN_TOK


def _teardown():
    global _client
    if _client is not None:
        _client.__exit__(None, None, None)
        _client = None


def _rate_payload(rid, service_id=CR_SVC_A1, **over):
    """The row the editor (components/client-rates.js) POSTs. Blank fields are
    sent as null = "inherit the base card"."""
    body = {
        "id": rid, "clientType": "company", "companyId": CR_COMPANY, "clientContactId": None,
        "serviceId": service_id, "label": "FUMC A1 agreement",
        "dayRate": 800, "halfDay": None, "hourlyRate": None, "otRate": None,
        "dayCost": None, "halfDayCost": None, "hourlyCost": None, "otCost": None,
        "minHours": 10, "minCostHours": 0, "active": True, "notes": "2026 contract",
    }
    body.update(over)
    return body


def _post(client, tok, body):
    return client.post("/api/client-rates", json=body, cookies={"ltp_session": tok})


def _get_all(client, tok):
    return client.get("/api/client-rates", cookies={"ltp_session": tok}).json()


# ── Tests ────────────────────────────────────────────────────────────────────

def test_rate_round_trips_through_crud():
    """POST a negotiated rate and read it back: every field survives, mapped to
    camelCase, on the hyphenated /api/client-rates path the frontend uses."""
    client, tok = _setup()
    r = _post(client, tok, _rate_payload(R_ROUNDTRIP))
    assert r.status_code == 200, r.text
    created = r.json()
    assert created["clientType"] == "company"
    assert created["companyId"] == CR_COMPANY
    assert created["serviceId"] == CR_SVC_A1
    assert created["dayRate"] == 800
    assert created["minHours"] == 10
    assert created["label"] == "FUMC A1 agreement"
    assert created["active"] is True

    one = client.get(f"/api/client-rates/{R_ROUNDTRIP}", cookies={"ltp_session": tok}).json()
    assert one["dayRate"] == 800 and one["minHours"] == 10
    assert any(x["id"] == R_ROUNDTRIP for x in _get_all(client, tok))


def test_null_means_inherit_and_zero_is_a_real_rate():
    """The resolution rule (theme.js::LTP_applyClientRate) reads null as
    "inherit the base card" and 0 as a real, free tier. That distinction has to
    survive the database — a null must not come back as 0, or every blank field
    would silently price at zero."""
    client, tok = _setup()
    r = _post(client, tok, _rate_payload(R_NULLS, service_id=CR_SVC_L1,
                                         dayRate=None, halfDay=0, minHours=0))
    assert r.status_code == 200, r.text
    row = client.get(f"/api/client-rates/{R_NULLS}", cookies={"ltp_session": tok}).json()
    assert row["dayRate"] is None, "blank day rate must stay null (inherit)"
    assert row["halfDay"] == 0, "an explicit 0 must stay 0 (free tier)"
    assert row["otRate"] is None and row["dayCost"] is None


def test_contact_client_rate():
    """A directly-billed individual (clientType 'contact') carries rates on the
    contact FK instead of the company one."""
    client, tok = _setup()
    r = _post(client, tok, _rate_payload(R_CONTACT, clientType="contact",
                                         companyId=None, clientContactId=CR_CONTACT))
    assert r.status_code == 200, r.text
    row = r.json()
    assert row["clientType"] == "contact"
    assert row["clientContactId"] == CR_CONTACT and row["companyId"] is None


def test_update_and_delete():
    """PUT edits in place; DELETE removes the override so the role goes back to
    the base card."""
    client, tok = _setup()
    assert _post(client, tok, _rate_payload(R_UPDATE, service_id=CR_SVC_L1)).status_code == 200

    body = _rate_payload(R_UPDATE, service_id=CR_SVC_L1, dayRate=750, minHours=8,
                         minCostHours=8, active=False)
    r = client.put(f"/api/client-rates/{R_UPDATE}", json=body, cookies={"ltp_session": tok})
    assert r.status_code == 200, r.text
    assert r.json()["dayRate"] == 750
    assert r.json()["minCostHours"] == 8
    assert r.json()["active"] is False

    assert client.delete(f"/api/client-rates/{R_UPDATE}",
                         cookies={"ltp_session": tok}).status_code == 200
    assert client.get(f"/api/client-rates/{R_UPDATE}",
                      cookies={"ltp_session": tok}).status_code == 404


def test_validation_rejects_bad_values():
    """Negative money / hours and an unknown clientType are 400s with a field
    name, not 500s or silently-stored garbage."""
    client, tok = _setup()
    for field, value in (("dayRate", -1), ("dayCost", -50), ("minHours", -1),
                         ("minCostHours", -2), ("otRate", "lots")):
        body = _rate_payload(6990, **{field: value})
        r = _post(client, tok, body)
        assert r.status_code == 400, f"{field}={value!r} should be rejected: {r.text}"
        assert r.json()["detail"]["field"] == field

    r = _post(client, tok, _rate_payload(6991, clientType="vendor"))
    assert r.status_code == 400
    assert r.json()["detail"]["field"] == "clientType"


def test_unknown_foreign_keys_are_rejected():
    """A rate pointing at a service (or client) that doesn't exist is a clean
    400 — SQLite doesn't enforce FKs, so the API validates them itself."""
    client, tok = _setup()
    r = _post(client, tok, _rate_payload(6992, service_id=987654))
    assert r.status_code == 400, r.text
    assert r.json()["detail"]["field"] == "serviceId"

    r = _post(client, tok, _rate_payload(6993, companyId=987654))
    assert r.status_code == 400, r.text
    assert r.json()["detail"]["field"] == "companyId"


def test_deleting_the_client_or_service_removes_the_override():
    """Both parents CASCADE: an override with no client, or no service, would
    match nobody forever. Proven directly against the DB so the constraint (not
    just an app-level cleanup) is what's doing the work."""
    client, tok = _setup()
    from sqlalchemy import select, text
    from backend.database import async_session

    assert _post(client, tok, _rate_payload(R_COMPANY_CASCADE,
                                            companyId=CR_COMPANY_DOOMED)).status_code == 200
    assert _post(client, tok, _rate_payload(R_SERVICE_CASCADE,
                                            service_id=CR_SVC_DOOMED)).status_code == 200

    async def drop_parents_and_count():
        async with async_session() as db:
            # SQLite only enforces FK actions with the pragma on; the app engine
            # sets it, but be explicit here so the assertion tests the schema.
            await db.execute(text("PRAGMA foreign_keys=ON"))
            comp = (await db.execute(select(models.Company)
                                     .where(models.Company.id == CR_COMPANY_DOOMED))).scalar_one()
            svc = (await db.execute(select(models.Service)
                                    .where(models.Service.id == CR_SVC_DOOMED))).scalar_one()
            await db.delete(comp)
            await db.delete(svc)
            await db.commit()
        async with async_session() as db:
            rows = (await db.execute(select(models.ClientRate.id).where(
                models.ClientRate.id.in_([R_COMPANY_CASCADE, R_SERVICE_CASCADE])))).scalars().all()
            return list(rows)

    assert asyncio.run(drop_parents_and_count()) == [], \
        "overrides must not outlive their client or their service"


def test_requires_a_session():
    """Every /api/* route is session-gated; the new one is no exception."""
    client, _ = _setup()
    assert client.get("/api/client-rates").status_code == 401


if __name__ == "__main__":
    try:
        for name, fn in list(globals().items()):
            if name.startswith("test_") and callable(fn):
                fn()
                print(f"  ok  {name}")
        print("client-rates suite passed")
    finally:
        _teardown()
