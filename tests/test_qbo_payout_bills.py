"""QuickBooks payout vendor-bill push tests (backend/qbo_payouts.py).

Real in-memory SQLite session (so the PayoutBill idempotency + payout_bill_lines
double-pay ledger are exercised for real) with the QuickBooks HTTP layer stubbed
by patching quickbooks.* to AsyncMocks. Mirrors tests/test_quickbooks_sync.py.

Runs under pytest and standalone (python tests/test_qbo_payout_bills.py).
"""
import asyncio
import contextlib
import inspect
import os
import sys
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "http://localhost:8000/auth/callback")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _root not in sys.path:
    sys.path.insert(0, _root)

from sqlalchemy import select                                    # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402
from sqlalchemy.pool import StaticPool                           # noqa: E402

from backend import models, qbo_payouts, quickbooks             # noqa: E402
from backend.database import Base                                # noqa: E402
from backend.quickbooks import QboApiError                       # noqa: E402


# ── Harness ──────────────────────────────────────────────────────────────────

@contextlib.asynccontextmanager
async def _db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", poolclass=StaticPool,
                                  connect_args={"check_same_thread": False})
    async with engine.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            yield s
    finally:
        await engine.dispose()


@contextlib.contextmanager
def _patch(**overrides):
    """Patch quickbooks.* to AsyncMocks (restoring originals after). Unspecified
    calls default to a no-op mock so a stray real HTTP call can't slip through."""
    defaults = {
        "load_connection": AsyncMock(return_value=SimpleNamespace(realm_id="1", environment="sandbox")),
        "query": AsyncMock(return_value=[]),
        "create_vendor": AsyncMock(return_value={"Vendor": {"Id": "V1"}}),
        "get_vendor": AsyncMock(return_value={"Id": "V1", "SyncToken": "0"}),
        "update_vendor": AsyncMock(return_value={"Vendor": {"Id": "V1"}}),
        "create_bill": AsyncMock(return_value={"Bill": {"Id": "B1", "SyncToken": "0", "TotalAmt": 0}}),
        "update_bill": AsyncMock(return_value={"Bill": {"Id": "B1", "SyncToken": "1"}}),
        "get_bill": AsyncMock(return_value={"Id": "B1", "SyncToken": "1"}),
    }
    defaults.update(overrides)
    saved = {name: getattr(quickbooks, name) for name in defaults}
    for name, fn in defaults.items():
        setattr(quickbooks, name, fn)
    try:
        yield defaults
    finally:
        for name, fn in saved.items():
            setattr(quickbooks, name, fn)


def _fault(code, message="boom", status=400):
    body = '{"Fault":{"Error":[{"Message":"%s","code":"%s"}]}}' % (message, code)
    return QboApiError(status, body, code)


async def _seed_contact(db, cid=5, first="Alex", last="Crew"):
    c = models.Contact(id=cid, first_name=first, last_name=last, is_crew=True)
    db.add(c)
    await db.flush()
    return c


def _period(index=0):
    # Anchor 2026-07-06 → index 0 is the 14th period of 2026 (PAY-26-14).
    return {"start": "2026-07-06", "end": "2026-07-19", "index": index,
            "pay_day": "2026-07-24", "label": "July 6th, 2026 – July 19th, 2026",
            "year": 2026, "year2": 26, "number": 14}


def _day(project_id=10, name="Fest", date="2026-07-08", payable=600.0, units=None, tier="full"):
    return {"project_id": project_id, "project_name": name, "date": date, "tier": tier,
            "payable": payable, "adj_total": 0.0,
            "units": units if units is not None else [{"service_id": 1, "amount": payable}]}


def _draft(cid, days):
    return {"contact_id": cid, "name": "Alex Crew", "days": days, "pending": [], "total_signed": 0}


_ACCTS = {"default_expense": "80", "ap": None, "by_service": {2: "81"}}


# ── Tests ────────────────────────────────────────────────────────────────────

async def test_push_creates_bill():
    async with _db() as db:
        c = await _seed_contact(db)
        with _patch() as m:
            res = await qbo_payouts.push_payout_bill(
                db, c, _draft(5, [_day()]), _period(), _ACCTS, client_id="x", client_secret="y")
        assert res["action"] == "created" and res["qbBillId"] == "B1", res
        pb = (await db.execute(select(models.PayoutBill))).scalar_one()
        assert pb.qb_bill_id == "B1" and pb.amount == 600.0 and pb.qb_sync_status == "synced"
        assert pb.doc_number == "PAY-26-14" and pb.line_signature
        lines = (await db.execute(select(models.PayoutBillLine))).scalars().all()
        assert len(lines) == 1 and lines[0].date == "2026-07-08" and lines[0].amount == 600.0
        payload = m["create_bill"].await_args.args[2]
        assert payload["VendorRef"]["value"] == "V1"
        assert payload["Line"][0]["AccountBasedExpenseLineDetail"]["AccountRef"]["value"] == "80"
        assert payload["DocNumber"] == "PAY-26-14"
        assert payload["TxnDate"] == "2026-07-19" and payload["DueDate"] == "2026-07-24"
        assert "APAccountRef" not in payload           # no AP configured -> omitted
        assert c.qb_vendor_id == "V1"                  # cached back on the contact


async def test_push_idempotent_noop():
    async with _db() as db:
        c = await _seed_contact(db)
        draft, period = _draft(5, [_day()]), _period()
        with _patch() as m:
            await qbo_payouts.push_payout_bill(db, c, draft, period, _ACCTS, client_id="x", client_secret="y")
            res2 = await qbo_payouts.push_payout_bill(db, c, draft, period, _ACCTS, client_id="x", client_secret="y")
        assert res2["action"] == "unchanged", res2
        assert m["create_bill"].await_count == 1       # NOT called the second time
        assert m["update_bill"].await_count == 0
        assert len((await db.execute(select(models.PayoutBill))).scalars().all()) == 1


async def test_push_update_on_added_day():
    async with _db() as db:
        c = await _seed_contact(db)
        with _patch() as m:
            await qbo_payouts.push_payout_bill(db, c, _draft(5, [_day()]), _period(), _ACCTS, client_id="x", client_secret="y")
            # A second signed day appears in the period -> signature changes -> update.
            draft2 = _draft(5, [_day(), _day(project_id=11, name="Wh", date="2026-07-10", payable=480.0)])
            res = await qbo_payouts.push_payout_bill(db, c, draft2, _period(), _ACCTS, client_id="x", client_secret="y")
        assert res["action"] == "updated", res
        assert m["update_bill"].await_count == 1
        pb = (await db.execute(select(models.PayoutBill))).scalar_one()
        assert pb.amount == 1080.0
        lines = (await db.execute(select(models.PayoutBillLine))).scalars().all()
        assert len(lines) == 2                          # ledger replaced with both days


async def test_push_prequery_adopts_orphan():
    # qb_bill_id is null locally but a Bill with our DocNumber already exists in QB
    # (a prior create succeeded, persist didn't). Pre-query adopts + updates it.
    async with _db() as db:
        c = await _seed_contact(db)
        with _patch(query=AsyncMock(return_value=[{"Id": "B9", "SyncToken": "4"}]),
                    update_bill=AsyncMock(return_value={"Bill": {"Id": "B9", "SyncToken": "5"}})) as m:
            res = await qbo_payouts.push_payout_bill(db, c, _draft(5, [_day()]), _period(), _ACCTS, client_id="x", client_secret="y")
        assert res["action"] == "updated" and res["qbBillId"] == "B9", res
        assert m["create_bill"].await_count == 0        # adopted, never created
        payload = m["update_bill"].await_args.args[2]
        assert payload["Id"] == "B9" and payload["SyncToken"] == "4"


async def test_push_5010_refetch_and_retry():
    async with _db() as db:
        c = await _seed_contact(db)
        # Seed an already-synced bill so the update path runs.
        db.add(models.PayoutBill(contact_id=5, period_start="2026-07-06", period_end="2026-07-19",
                                 period_index=0, doc_number="PAY-26-14", qb_bill_id="B1",
                                 qb_sync_token="1", qb_sync_status="synced", line_signature="OLD", amount=1.0))
        await db.flush()
        with _patch(update_bill=AsyncMock(side_effect=[_fault("5010"), {"Bill": {"Id": "B1", "SyncToken": "9"}}]),
                    get_bill=AsyncMock(return_value={"Id": "B1", "SyncToken": "8"})) as m:
            res = await qbo_payouts.push_payout_bill(db, c, _draft(5, [_day()]), _period(), _ACCTS, client_id="x", client_secret="y")
        assert res["action"] == "updated", res
        assert m["update_bill"].await_count == 2 and m["get_bill"].await_count == 1
        assert m["update_bill"].await_args.args[2]["SyncToken"] == "8"   # refetched token used


async def test_create_recovery_6140_adopts_by_docnumber():
    # Pre-query misses, create races into a 6140; recovery re-queries + updates.
    async with _db() as db:
        c = await _seed_contact(db)
        query = AsyncMock(side_effect=[[], [{"Id": "B7", "SyncToken": "2"}]])  # pre-query empty, recovery finds it
        with _patch(query=query,
                    create_bill=AsyncMock(side_effect=_fault("6140", "Duplicate Document Number")),
                    update_bill=AsyncMock(return_value={"Bill": {"Id": "B7", "SyncToken": "3"}})) as m:
            res = await qbo_payouts.push_payout_bill(db, c, _draft(5, [_day()]), _period(), _ACCTS, client_id="x", client_secret="y")
        assert res["qbBillId"] == "B7", res
        assert m["update_bill"].await_count == 1


async def test_vendor_6240_disambiguates():
    async with _db() as db:
        c = await _seed_contact(db)
        # First create (name collides with a Customer/Employee) -> 6240; Vendor
        # re-query still empty -> retry with a disambiguated DisplayName.
        create_vendor = AsyncMock(side_effect=[_fault("6240", "Duplicate Name Exists"),
                                               {"Vendor": {"Id": "V2"}}])
        with _patch(query=AsyncMock(return_value=[]), create_vendor=create_vendor):
            vid = await qbo_payouts.find_or_create_vendor(
                SimpleNamespace(), db, c, client_id="x", client_secret="y")
        assert vid == "V2"
        assert create_vendor.await_count == 2
        assert "(Crew 5)" in create_vendor.await_args.args[2]["DisplayName"]


async def test_double_pay_guard_blocks_second_period():
    async with _db() as db:
        c = await _seed_contact(db)
        with _patch():
            await qbo_payouts.push_payout_bill(db, c, _draft(5, [_day()]), _period(0), _ACCTS, client_id="x", client_secret="y")
            # A DIFFERENT period tries to bill the SAME (contact, project, date).
            period_b = {"start": "2026-07-20", "end": "2026-08-02", "index": 1,
                        "pay_day": "2026-08-07", "label": "next"}
            raised = False
            try:
                await qbo_payouts.push_payout_bill(db, c, _draft(5, [_day()]), period_b, _ACCTS, client_id="x", client_secret="y")
            except qbo_payouts.PayoutNotBillable as e:
                raised = True
                assert "already billed" in str(e)
            assert raised, "expected double-pay guard to fire"


async def test_negative_total_blocked():
    async with _db() as db:
        c = await _seed_contact(db)
        day = _day(payable=-50.0, units=[])   # a deduction-only day nets negative
        with _patch():
            raised = False
            try:
                await qbo_payouts.push_payout_bill(db, c, _draft(5, [day]), _period(), _ACCTS, client_id="x", client_secret="y")
            except qbo_payouts.PayoutNotBillable as e:
                raised = True
                assert "deductions exceed pay" in str(e)
            assert raised


async def test_no_billable_days_skipped():
    async with _db() as db:
        c = await _seed_contact(db)
        day = _day(payable=0.0, units=[])     # signed but $0 -> nothing to bill
        with _patch():
            raised = False
            try:
                await qbo_payouts.push_payout_bill(db, c, _draft(5, [day]), _period(), _ACCTS, client_id="x", client_secret="y")
            except qbo_payouts.PayoutNotBillable:
                raised = True
            assert raised


async def test_qbo_error_returns_failure_and_no_ledger():
    async with _db() as db:
        c = await _seed_contact(db)
        with _patch(create_bill=AsyncMock(side_effect=_fault("5000", "server error", status=502))):
            res = await qbo_payouts.push_payout_bill(db, c, _draft(5, [_day()]), _period(), _ACCTS, client_id="x", client_secret="y")
        assert res["ok"] is False and res["action"] == "error", res
        pb = (await db.execute(select(models.PayoutBill))).scalar_one()
        assert pb.qb_sync_status == "error" and pb.qb_last_error
        # QBO write failed BEFORE the ledger write -> no ledger rows reserved.
        assert (await db.execute(select(models.PayoutBillLine))).scalars().all() == []


async def test_multi_account_lines_reconcile_in_payload():
    async with _db() as db:
        c = await _seed_contact(db)
        # A day worked as two roles: svc 1 -> default acct 80, svc 2 -> acct 81,
        # plus a +30 "Parking" adjustment as its OWN line on the primary role account.
        day = _day(payable=570.0, tier="mixed",
                   units=[{"service_id": 1, "amount": 300.0, "paid_hours": 10},
                          {"service_id": 2, "amount": 240.0, "paid_hours": 5}])
        day["adj_total"] = 30.0
        day["adjustments"] = [{"label": "Parking", "amount": 30.0}]
        with _patch() as m:
            await qbo_payouts.push_payout_bill(db, c, _draft(5, [day]), _period(), _ACCTS, client_id="x", client_secret="y")
        lines = m["create_bill"].await_args.args[2]["Line"]
        assert round(sum(ln["Amount"] for ln in lines), 2) == 570.0
        per_acct = {}
        for ln in lines:
            a = ln["AccountBasedExpenseLineDetail"]["AccountRef"]["value"]
            per_acct[a] = round(per_acct.get(a, 0) + ln["Amount"], 2)
        assert per_acct == {"80": 330.0, "81": 240.0}      # 300 work + 30 adj on 80; 240 work on 81
        adj_lines = [ln for ln in lines if "Parking" in ln["Description"]]
        assert len(adj_lines) == 1 and adj_lines[0]["Amount"] == 30.0
        assert adj_lines[0]["AccountBasedExpenseLineDetail"]["AccountRef"]["value"] == "80"
        assert any("10h" in ln["Description"] for ln in lines)   # hours shown on the work line


def test_build_bill_lines_hours_and_adjustment_only():
    # Pure line-building: a no-show + kill-fee day (no worked units) -> a single
    # adjustment line on the default account; a worked day shows hours + OT.
    accts = {"default_expense": "80", "ap": None, "by_service": {2: "81"}}
    noshow = {"project_name": "Wh", "date": "2026-07-11", "tier": "", "payable": 100.0,
              "adj_total": 100.0, "units": [], "adjustments": [{"label": "Kill fee", "amount": 100.0}]}
    lines = qbo_payouts.build_bill_lines([noshow], accts)
    assert lines == [{"account_id": "80", "amount": 100.0, "description": "Wh · 2026-07-11 · Kill fee"}]
    worked = {"project_name": "Fest", "date": "2026-07-08", "tier": "full", "payable": 1050.0,
              "adj_total": 0.0, "adjustments": [],
              "units": [{"service_id": 1, "amount": 1050.0, "paid_hours": 10, "ot_hours": 5}]}
    wl = qbo_payouts.build_bill_lines([worked], accts)
    assert wl[0]["amount"] == 1050.0 and "10h +5h OT" in wl[0]["description"]


async def test_amount_reconciliation_mismatch_stamped():
    async with _db() as db:
        c = await _seed_contact(db)
        # QuickBooks returns a TotalAmt different from our computed 600 -> flagged.
        with _patch(create_bill=AsyncMock(return_value={"Bill": {"Id": "B1", "SyncToken": "0", "TotalAmt": 599.5}})):
            res = await qbo_payouts.push_payout_bill(db, c, _draft(5, [_day()]), _period(), _ACCTS, client_id="x", client_secret="y")
        assert res["action"] == "created"
        pb = (await db.execute(select(models.PayoutBill))).scalar_one()
        assert pb.qb_total_amt == 599.5
        assert pb.qb_last_error and "599.50" in pb.qb_last_error
        assert any(a.get("type") == "qbo_payout_mismatch" for a in (pb.activity or []))


async def test_paid_bill_not_overwritten():
    async with _db() as db:
        c = await _seed_contact(db)
        # A PAID bill whose payout has since changed (stale signature) must NOT be
        # overwritten — push refuses and hits QuickBooks zero times.
        db.add(models.PayoutBill(contact_id=5, period_start="2026-07-06", period_end="2026-07-19",
                                 period_index=0, doc_number="PAY-26-14", qb_bill_id="B1", qb_sync_token="1",
                                 qb_sync_status="synced", line_signature="OLD", amount=600.0,
                                 qb_paid_at=datetime.now(timezone.utc)))
        await db.flush()
        with _patch() as m:
            raised = False
            try:
                await qbo_payouts.push_payout_bill(db, c, _draft(5, [_day()]), _period(), _ACCTS, client_id="x", client_secret="y")
            except qbo_payouts.PayoutNotBillable as e:
                raised = True
                assert "already paid" in str(e)
            assert raised
            assert m["create_bill"].await_count == 0 and m["update_bill"].await_count == 0


async def test_paid_bill_unchanged_is_noop_not_blocked():
    async with _db() as db:
        c = await _seed_contact(db)
        # First push creates + captures the signature; then mark it paid and re-push
        # the SAME data -> the no-op short-circuit wins (no error), no QB overwrite.
        with _patch() as m:
            await qbo_payouts.push_payout_bill(db, c, _draft(5, [_day()]), _period(), _ACCTS, client_id="x", client_secret="y")
            pb = (await db.execute(select(models.PayoutBill))).scalar_one()
            pb.qb_paid_at = datetime.now(timezone.utc)
            await db.flush()
            res = await qbo_payouts.push_payout_bill(db, c, _draft(5, [_day()]), _period(), _ACCTS, client_id="x", client_secret="y")
        assert res["action"] == "unchanged"
        assert m["create_bill"].await_count == 1 and m["update_bill"].await_count == 0


async def test_ap_account_included_when_configured():
    async with _db() as db:
        c = await _seed_contact(db)
        accts = {"default_expense": "80", "ap": "33", "by_service": {}}
        with _patch() as m:
            await qbo_payouts.push_payout_bill(db, c, _draft(5, [_day()]), _period(), accts, client_id="x", client_secret="y")
        payload = m["create_bill"].await_args.args[2]
        assert payload["APAccountRef"] == {"value": "33"}


async def test_readonly_guard_strips_qb_vendor_id():
    from backend.routes.api import _dict_to_row
    mapped = _dict_to_row({"firstName": "Al", "qbVendorId": "V9", "qbCustomerId": "C9"}, models.Contact)
    assert mapped.get("first_name") == "Al"
    assert "qb_vendor_id" not in mapped and "qb_customer_id" not in mapped


if __name__ == "__main__":
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = failed = 0
    for fn in fns:
        try:
            r = fn()
            if inspect.iscoroutine(r):
                asyncio.run(r)
            passed += 1
            print("  [PASS] " + fn.__name__)
        except Exception:
            failed += 1
            print("  [FAIL] " + fn.__name__)
            traceback.print_exc()
    print("qbo-payout-bills suite — PASS: %d   FAIL: %d" % (passed, failed))
    raise SystemExit(1 if failed else 0)
