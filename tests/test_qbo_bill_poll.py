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
from datetime import datetime, timedelta, timezone
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

from backend import crypto, models, qbo_bill_poll, quickbooks   # noqa: E402
from backend.database import Base                                # noqa: E402

_REAL_LOAD_CONNECTION = quickbooks.load_connection              # captured before any patch


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


async def test_poll_isolates_deleted_bill_and_continues():
    # A bill deleted in QuickBooks (get_bill -> 404 object fault) must NOT abort
    # the cycle: the poller skips it and still detects the next bill's payment.
    async with _engine() as eng:
        Session = async_sessionmaker(eng, expire_on_commit=False)
        async with Session() as db:
            db.add(models.Contact(id=5, first_name="Alex", last_name="Crew", is_crew=True))
            db.add(models.PayoutBill(
                id=1, contact_id=5, period_start="2026-07-06", period_end="2026-07-19",
                doc_number="PAY-26-14", qb_bill_id="GONE", qb_sync_status="synced", amount=600.0))
            db.add(models.PayoutBill(
                id=2, contact_id=5, period_start="2026-06-22", period_end="2026-07-05",
                doc_number="PAY-26-13", qb_bill_id="B2", qb_sync_status="synced", amount=800.0))
            await db.commit()

        async def get_bill(conn, db, bill_id, **kw):
            if bill_id == "GONE":
                raise quickbooks.QboApiError(404, '{"Fault":{"Error":[{"Message":"Object Not Found","code":"610"}]}}', "610")
            return {"Id": bill_id, "Balance": 0, "TotalAmt": 800.0}

        with _patch_qb(AsyncMock(side_effect=get_bill), Session) as names:
            summary = await qbo_bill_poll.run_bill_poll()
        # The deleted bill (id 1, lower) was skipped; the newer bill (id 2) was
        # still checked and marked paid — no cycle abort.
        assert summary.get("skippedBills") == 1
        assert summary["paid"] == 1
        assert "qbo_error" not in summary
        assert names["record_connection_error"].await_count == 0
        assert names["clear_connection_error"].await_count == 1   # healthy round-trip happened
        async with Session() as db:
            paid = (await db.execute(select(models.PayoutBill).where(models.PayoutBill.id == 2))).scalar_one()
            assert paid.qb_paid_at is not None
            # The deleted bill must be AGED (last-checked stamped) so it rotates to
            # the back of the LRU order instead of monopolizing the front forever.
            dead = (await db.execute(select(models.PayoutBill).where(models.PayoutBill.id == 1))).scalar_one()
            assert dead.qb_last_checked_at is not None


async def test_candidates_least_recently_checked_first():
    # Fairness: a never-checked (NULL) bill and an old-checked bill sort ahead of
    # a recently-checked one, so a persistent backlog can't starve newer bills.
    async with _engine() as eng:
        Session = async_sessionmaker(eng, expire_on_commit=False)
        async with Session() as db:
            db.add(models.Contact(id=5, first_name="Alex", last_name="Crew", is_crew=True))
            now = datetime.now(timezone.utc)
            db.add(models.PayoutBill(id=1, contact_id=5, period_start="2026-07-06", period_end="2026-07-19",
                                     doc_number="PAY-26-14", qb_bill_id="B1", qb_sync_status="synced", amount=1.0,
                                     qb_last_checked_at=now))                      # checked just now
            db.add(models.PayoutBill(id=2, contact_id=5, period_start="2026-06-22", period_end="2026-07-05",
                                     doc_number="PAY-26-13", qb_bill_id="B2", qb_sync_status="synced", amount=1.0,
                                     qb_last_checked_at=None))                     # never checked
            db.add(models.PayoutBill(id=3, contact_id=5, period_start="2026-06-08", period_end="2026-06-21",
                                     doc_number="PAY-26-12", qb_bill_id="B3", qb_sync_status="synced", amount=1.0,
                                     qb_last_checked_at=now.replace(year=2020)))   # checked long ago
            await db.commit()
        async with Session() as db:
            order = [pb.id for pb in await qbo_bill_poll._candidate_bills(db)]
        assert order == [2, 3, 1], order   # NULL first, then oldest-checked, then recent


async def test_poll_stamps_last_checked():
    async with _engine() as eng:
        Session = async_sessionmaker(eng, expire_on_commit=False)
        await _seed_bill(Session)
        with _patch_qb(AsyncMock(return_value={"Id": "B1", "Balance": 600.0, "TotalAmt": 600.0}), Session):
            await qbo_bill_poll.run_bill_poll()
        async with Session() as db:
            pb = (await db.execute(select(models.PayoutBill))).scalar_one()
            assert pb.qb_last_checked_at is not None   # stamped even though still unpaid


async def test_poll_survives_conn_expiry_after_object_fault():
    # Regression: a 404 on bill #1 rolls back and EXPIRES the shared ORM conn; the
    # per-iteration reload must repopulate it so bill #2's refresh (which reads
    # conn's token fields) doesn't hit MissingGreenlet and drop the rest of the
    # cycle. Uses the REAL load_connection + a real ORM conn (a rollback only
    # expires a session-managed object), and a get_bill that touches conn exactly
    # as refresh_if_needed does.
    async with _engine() as eng:
        Session = async_sessionmaker(eng, expire_on_commit=False)
        async with Session() as db:
            db.add(models.Contact(id=5, first_name="Alex", last_name="Crew", is_crew=True))
            db.add(models.QboConnection(
                id=1, realm_id="1", environment="sandbox",
                access_token_enc=crypto.encrypt_token("acc"),
                refresh_token_enc=crypto.encrypt_token("ref"),
                access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1)))
            db.add(models.PayoutBill(id=1, contact_id=5, period_start="2026-07-06", period_end="2026-07-19",
                                     doc_number="PAY-26-14", qb_bill_id="GONE", qb_sync_status="synced", amount=1.0))
            db.add(models.PayoutBill(id=2, contact_id=5, period_start="2026-06-22", period_end="2026-07-05",
                                     doc_number="PAY-26-13", qb_bill_id="B2", qb_sync_status="synced", amount=1.0))
            await db.commit()

        async def get_bill(conn, db_, bill_id, **kw):
            _ = conn.refresh_token_enc   # same access refresh_if_needed makes; expired conn -> MissingGreenlet
            if bill_id == "GONE":
                raise quickbooks.QboApiError(404, '{"Fault":{"Error":[{"code":"610"}]}}', "610")
            return {"Id": bill_id, "Balance": 0, "TotalAmt": 1.0}

        with _patch_qb(AsyncMock(side_effect=get_bill), Session):
            quickbooks.load_connection = _REAL_LOAD_CONNECTION   # real conn, not the SimpleNamespace stub
            summary = await qbo_bill_poll.run_bill_poll()
        assert summary.get("skippedBills") == 1 and summary["paid"] == 1, summary
        async with Session() as db:
            b2 = (await db.execute(select(models.PayoutBill).where(models.PayoutBill.id == 2))).scalar_one()
            assert b2.qb_paid_at is not None   # processed despite bill #1's rollback expiring conn


async def test_poll_no_candidates_does_not_clear_error():
    # An empty candidate set makes no QB call, so it must NOT clear a shared
    # connection error the receipt poller may have just recorded (M1).
    async with _engine() as eng:
        Session = async_sessionmaker(eng, expire_on_commit=False)
        await _seed_bill(Session, paid=True)   # already paid -> not a candidate
        with _patch_qb(AsyncMock(), Session) as names:
            summary = await qbo_bill_poll.run_bill_poll()
        assert summary["checked"] == 0
        assert names["clear_connection_error"].await_count == 0


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
