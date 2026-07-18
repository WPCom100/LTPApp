"""Route-level tests for the payout vendor-bill export endpoints.

  POST /api/qbo/payouts/preview   (admin; no side effects; validation report)
  POST /api/qbo/payouts/push      (admin; per-contact isolation)
  POST /api/qbo/accounts/refresh  (now also caches Expense/AP accounts)
  GET  /api/qbo/status            (now returns expenseAccounts / apAccounts)

Uses the shared TestClient (real app + shared file DB via lifespan) with seeded
admin/member sessions, mirroring tests/test_commit4_admin_signature.py. The deep
push logic is covered at the engine level (tests/test_qbo_payout_bills.py); here
we exercise the HTTP surface: auth gating, period validation, the not-connected
report + batch-abort paths, and account caching.
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_suite.db")

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _root not in sys.path:
    sys.path.insert(0, _root)

from backend import crypto, models, qbo_sync, quickbooks  # noqa: E402
from backend.auth_deps import hash_session_token          # noqa: E402

_client = None
_ctr = 0


def _signed_schedule(crew_id):
    """A schedule with one confirmed + signed-off day (2026-07-08) carrying an
    authentic-shaped work.pay snapshot — total 600, one L1 unit."""
    pay = {"total": 600.0, "paidHours": 10, "otHours": 0, "mealPenaltyHours": 0, "tier": "full",
           "units": [{"serviceId": 1, "tier": "full", "paidHours": 10, "otHours": 0,
                      "dayCost": 600, "otCost": 90, "minApplied": False, "fullMargin": False, "total": 600.0}]}
    return [{
        "id": "s1", "date": "2026-07-08", "time": "08:00", "endTime": "18:00", "breaks": [],
        "positions": [{"id": "p1", "crewId": crew_id, "serviceId": 1, "role": "L1",
                       "status": "confirmed", "fullMargin": False,
                       "work": {"state": "worked", "signedAt": "2026-07-08T20:00:00Z",
                                "signedBy": "tester", "pay": pay}}],
    }]


def _setup(**settings):
    """Seed admin+member sessions, a crew member with a signed payout day, a
    Service, and the given payout settings. Returns (client, admin_tok, member_tok, crew_id)."""
    global _client, _ctr
    _ctr += 1
    tag = f"p{_ctr}"
    base = 930000 + _ctr * 10
    crew_id = base + 1

    if _client is None:
        from fastapi.testclient import TestClient
        from backend.main import app
        _client = TestClient(app)
        _client.__enter__()

    from backend.database import async_session

    async def seed():
        async with async_session() as db:
            admin = models.User(google_sub=f"pa-admin-{tag}", email=f"pa-admin-{tag}@biz.com",
                                name="Admin", role="admin")
            member = models.User(google_sub=f"pa-mem-{tag}", email=f"pa-mem-{tag}@biz.com",
                                 name="Member", role="member")
            db.add_all([admin, member])
            await db.flush()
            db.add_all([
                models.Session(id=hash_session_token(f"pa-admin-{tag}"), user_id=admin.id,
                               expires_at=datetime.now(timezone.utc) + timedelta(days=7)),
                models.Session(id=hash_session_token(f"pa-mem-{tag}"), user_id=member.id,
                               expires_at=datetime.now(timezone.utc) + timedelta(days=7)),
                models.Contact(id=crew_id, first_name="Alex", last_name=f"Crew{_ctr}", is_crew=True),
                models.Service(id=base + 3, role="L1", day_rate=1000, day_cost=600),
                models.Project(id=base + 2, name=f"Fest{_ctr}", schedule=_signed_schedule(crew_id)),
            ])
            await db.flush()
            # Payout settings (merge — never clobber other keys).
            for k, v in settings.items():
                await qbo_sync._settings_set(db, k, v)
            await db.commit()

    asyncio.run(seed())
    return _client, f"pa-admin-{tag}", f"pa-mem-{tag}", crew_id


_PERIOD = {"periodStart": "2026-07-06", "periodEnd": "2026-07-19"}


# ── Auth gating ──────────────────────────────────────────────────────────────

def test_preview_requires_admin():
    client, admin, member, _ = _setup(payPeriodAnchor="2026-07-06")
    assert client.post("/api/qbo/payouts/preview", json=_PERIOD).status_code == 401
    assert client.post("/api/qbo/payouts/preview", json=_PERIOD,
                       cookies={"ltp_session": member}).status_code == 403


def test_push_requires_admin():
    client, admin, member, _ = _setup(payPeriodAnchor="2026-07-06")
    assert client.post("/api/qbo/payouts/push", json=_PERIOD).status_code == 401
    assert client.post("/api/qbo/payouts/push", json=_PERIOD,
                       cookies={"ltp_session": member}).status_code == 403


# ── Period validation ────────────────────────────────────────────────────────

def test_preview_bad_period_range():
    client, admin, _, _ = _setup(payPeriodAnchor="2026-07-06")
    # A range that isn't a real pay-period boundary is rejected.
    r = client.post("/api/qbo/payouts/preview",
                    json={"periodStart": "2026-07-07", "periodEnd": "2026-07-20"},
                    cookies={"ltp_session": admin})
    assert r.status_code == 400 and r.json()["reason"] == "bad_period"


# ── Preview report ───────────────────────────────────────────────────────────

def test_preview_reports_draft_and_not_connected():
    client, admin, _, crew_id = _setup(payPeriodAnchor="2026-07-06", payPeriodPayDayOffsetDays=5,
                                       qboPayoutExpenseAccountId="80")
    r = client.post("/api/qbo/payouts/preview", json=_PERIOD, cookies={"ltp_session": admin})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["period"]["payDay"] == "2026-07-24"
    assert body["connected"] is False
    assert any("not connected" in b.lower() for b in body["blocks"])
    card = next((c for c in body["contacts"] if c["contactId"] == crew_id), None)
    assert card is not None, "seeded crew payout should appear"
    assert card["total"] == 600.0 and card["blocked"] is False
    assert card["billStatus"] == "new" and card["lineCount"] == 1
    assert card["days"][0]["amount"] == 600.0


# ── Push abort/validation paths (no HTTP needed) ─────────────────────────────

def test_push_no_expense_account_blocks():
    # Explicitly clear the default expense account for this test's run.
    client, admin, _, _ = _setup(payPeriodAnchor="2026-07-06", qboPayoutExpenseAccountId=None)
    r = client.post("/api/qbo/payouts/push", json=_PERIOD, cookies={"ltp_session": admin})
    assert r.status_code == 400 and r.json()["reason"] == "no_expense_account"


def test_push_not_connected_aborts_batch():
    client, admin, _, _ = _setup(payPeriodAnchor="2026-07-06", qboPayoutExpenseAccountId="80")
    # No QboConnection row seeded -> load_connection raises QboNotConnected -> 409.
    r = client.post("/api/qbo/payouts/push", json=_PERIOD, cookies={"ltp_session": admin})
    assert r.status_code == 409 and r.json()["reason"] == "not_connected"


# ── Account refresh now caches Expense + AP; status returns them ─────────────

def test_accounts_refresh_caches_expense_and_ap():
    client, admin, _, _ = _setup(payPeriodAnchor="2026-07-06")
    from backend.database import async_session

    async def seed_conn():
        async with async_session() as db:
            existing = await db.get(models.QboConnection, 1)
            if existing is None:
                db.add(models.QboConnection(
                    id=1, realm_id="9999999999", environment="sandbox",
                    access_token_enc=crypto.encrypt_token("a"), refresh_token_enc=crypto.encrypt_token("r"),
                    access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1)))
                await db.commit()

    asyncio.run(seed_conn())

    saved = {n: getattr(quickbooks, n) for n in ("list_income_accounts", "list_expense_accounts", "list_ap_accounts")}
    quickbooks.list_income_accounts = AsyncMock(return_value=[{"Id": "1", "Name": "Sales"}])
    quickbooks.list_expense_accounts = AsyncMock(return_value=[{"Id": "80", "Name": "Contract Labor", "AccountType": "Expense"}])
    quickbooks.list_ap_accounts = AsyncMock(return_value=[{"Id": "33", "Name": "Accounts Payable", "AccountType": "Accounts Payable"}])
    try:
        r = client.post("/api/qbo/accounts/refresh", cookies={"ltp_session": admin})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["expenseAccounts"] == [{"id": "80", "name": "Contract Labor", "type": "Expense"}]
        assert body["apAccounts"] == [{"id": "33", "name": "Accounts Payable", "type": "Accounts Payable"}]
        # And /status now surfaces them.
        s = client.get("/api/qbo/status", cookies={"ltp_session": admin}).json()
        assert s["expenseAccounts"] and s["expenseAccounts"][0]["id"] == "80"
        assert s["apAccounts"] and s["apAccounts"][0]["id"] == "33"
    finally:
        for n, fn in saved.items():
            setattr(quickbooks, n, fn)


if __name__ == "__main__":
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = failed = 0
    for fn in fns:
        try:
            fn()
            passed += 1
            print("  [PASS] " + fn.__name__)
        except Exception:
            failed += 1
            print("  [FAIL] " + fn.__name__)
            traceback.print_exc()
    if _client is not None:
        _client.__exit__(None, None, None)
    print("qbo-payout-routes suite — PASS: %d   FAIL: %d" % (passed, failed))
    raise SystemExit(1 if failed else 0)
