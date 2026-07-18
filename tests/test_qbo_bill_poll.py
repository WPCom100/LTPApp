"""Bill-payment poller tests (backend/qbo_bill_poll.py).

Real in-memory SQLite (its own sessionmaker patched into the poller) with the
QuickBooks layer stubbed. Mirrors the invoice-poller / vendor-bill test style.
Runs under pytest and standalone.
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
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _root not in sys.path:
    sys.path.insert(0, _root)

from sqlalchemy import select                                    # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402
from sqlalchemy.pool import StaticPool                           # noqa: E402

from backend import models, qbo_bill_poll, quickbooks           # noqa: E402
from backend.database import Base                                # noqa: E402


@contextlib.asynccontextmanager
async def _engine():
    eng = create_async_engine("sqlite+aiosqlite:///:memory:", poolclass=StaticPool,
                              connect_args={"check_same_thread": False})
    async with eng.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    try:
        yield eng
    finally:
        await eng.dispose()


@contextlib.contextmanager
def _patch_qb(get_bill, Session):
    """Patch the QuickBooks surface the poller touches AND route its own
    async_session at the in-memory engine — restoring everything after."""
    names = {
        "load_connection": AsyncMock(return_value=SimpleNamespace(realm_id="1", environment="sandbox",
                                                                  connected_by_user_id=None)),
        "get_bill": get_bill,
        "record_connection_error": AsyncMock(),
        "clear_connection_error": AsyncMock(),
    }
    saved = {n: getattr(quickbooks, n) for n in names}
    saved_session = qbo_bill_poll.async_session
    for n, fn in names.items():
        setattr(quickbooks, n, fn)
    qbo_bill_poll.async_session = Session
    try:
        yield names
    finally:
        for n, fn in saved.items():
            setattr(quickbooks, n, fn)
        qbo_bill_poll.async_session = saved_session


async def _seed_bill(Session, *, paid=False, bill_id="B1"):
    async with Session() as db:
        db.add(models.Contact(id=5, first_name="Alex", last_name="Crew", is_crew=True))
        db.add(models.PayoutBill(
            id=1, contact_id=5, period_start="2026-07-06", period_end="2026-07-19",
            doc_number="PAY-26-14", qb_bill_id=bill_id, qb_sync_status="synced", amount=600.0,
            qb_paid_at=(datetime.now(timezone.utc) if paid else None)))
        await db.commit()


async def test_poll_marks_paid_on_zero_balance():
    async with _engine() as eng:
        Session = async_sessionmaker(eng, expire_on_commit=False)
        await _seed_bill(Session)
        with _patch_qb(AsyncMock(return_value={"Id": "B1", "Balance": 0, "TotalAmt": 600.0}), Session):
            summary = await qbo_bill_poll.run_bill_poll()
        assert summary["paid"] == 1 and summary["checked"] == 1
        async with Session() as db:
            pb = (await db.execute(select(models.PayoutBill))).scalar_one()
            assert pb.qb_paid_at is not None and pb.qb_balance == 0.0
            assert any(a.get("type") == "qbo_payout_paid" for a in (pb.activity or []))


async def test_poll_ignores_unpaid():
    async with _engine() as eng:
        Session = async_sessionmaker(eng, expire_on_commit=False)
        await _seed_bill(Session)
        with _patch_qb(AsyncMock(return_value={"Id": "B1", "Balance": 600.0, "TotalAmt": 600.0}), Session):
            summary = await qbo_bill_poll.run_bill_poll()
        assert summary["paid"] == 0
        async with Session() as db:
            pb = (await db.execute(select(models.PayoutBill))).scalar_one()
            assert pb.qb_paid_at is None and pb.qb_balance == 600.0


async def test_poll_skips_already_paid():
    async with _engine() as eng:
        Session = async_sessionmaker(eng, expire_on_commit=False)
        await _seed_bill(Session, paid=True)
        get_bill = AsyncMock(return_value={"Id": "B1", "Balance": 0, "TotalAmt": 600.0})
        with _patch_qb(get_bill, Session):
            summary = await qbo_bill_poll.run_bill_poll()
        assert summary["checked"] == 0          # a paid bill isn't a candidate
        assert get_bill.await_count == 0


async def test_poll_skips_when_not_connected():
    async with _engine() as eng:
        Session = async_sessionmaker(eng, expire_on_commit=False)
        await _seed_bill(Session)
        # load_connection raising QboNotConnected -> clean skip.
        with _patch_qb(AsyncMock(), Session) as names:
            names["load_connection"].side_effect = quickbooks.QboNotConnected()
            summary = await qbo_bill_poll.run_bill_poll()
        assert summary["skipped"] is True


async def test_poll_aborts_and_records_on_api_error():
    async with _engine() as eng:
        Session = async_sessionmaker(eng, expire_on_commit=False)
        await _seed_bill(Session)
        boom = quickbooks.QboApiError(502, '{"Fault":{"Error":[{"Message":"boom"}]}}', None)
        with _patch_qb(AsyncMock(side_effect=boom), Session) as names:
            summary = await qbo_bill_poll.run_bill_poll()
        assert "qbo_error" in summary
        assert names["record_connection_error"].await_count == 1
        assert names["clear_connection_error"].await_count == 0   # aborted -> not cleared


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
    print("qbo-bill-poll suite — PASS: %d   FAIL: %d" % (passed, failed))
    raise SystemExit(1 if failed else 0)
