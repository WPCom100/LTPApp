"""QuickBooks-driven payout-bill payment tracking.

Background poller that marks a crew payout Vendor Bill PAID once its QuickBooks
``Balance`` reaches 0, and web-pushes admins on the transition. It mirrors the
invoice receipt poller (backend/qbo_receipts.py) — same lifespan-started poll
cadence and the same QuickBooks-error handling — but for the accounts-PAYABLE
side, and without any email.

Once a bill is paid, its `qb_paid_at` is set: the Payouts tab / Schedule Builder
guard protects its days from silent re-pricing, and the bill drops out of the
candidate set so polling stops for it (Balance == 0 is terminal). No webhook —
same rationale as the receipt poller: a small candidate set on a couple-hour
cadence, started from the FastAPI lifespan.
"""
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend import models, qbo_sync, quickbooks, webpush
from backend.database import async_session
from backend.qbo_payouts import _stamp

# Safety cap on QB fetches per cycle (far above any realistic count of unpaid
# payout bills). Logged when hit.
_MAX_BILLS_PER_CYCLE = 500

# "Paid in full" — QB balances are currency, so compare with a small epsilon so
# floating dust never reads as an outstanding balance (matches qbo_receipts).
_PAID_EPSILON = 0.01


def _num(x) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


async def _contact_name(db, contact_id) -> str:
    if not contact_id:
        return ""
    r = await db.execute(select(models.Contact).where(models.Contact.id == contact_id))
    c = r.scalar_one_or_none()
    return ((c.first_name or "") + " " + (c.last_name or "")).strip() if c else ""


async def _candidate_bills(db: AsyncSession) -> list[models.PayoutBill]:
    """Bills to check this cycle: linked to QuickBooks, synced, not yet paid.
    A paid bill (qb_paid_at set) drops out — polling stops for it.

    Ordered least-recently-checked first (never-checked NULLs win), so a large
    persistent unpaid backlog can't starve a newer bill's payment detection
    behind the same oldest N every cycle."""
    result = await db.execute(
        select(models.PayoutBill).where(
            models.PayoutBill.qb_bill_id.isnot(None),
            models.PayoutBill.qb_sync_status == "synced",
            models.PayoutBill.qb_paid_at.is_(None),
        ).order_by(models.PayoutBill.qb_last_checked_at.asc().nullsfirst(),
                   models.PayoutBill.id).limit(_MAX_BILLS_PER_CYCLE + 1)
    )
    return list(result.scalars().all())


async def _process_bill(db, conn, pb, *, client_id, client_secret) -> str:
    """GET the bill's QB Balance; mark paid when it reaches 0. Returns
    'open' | 'paid'. Writes qb_balance/qb_total_amt every cycle as a snapshot."""
    qb_bill = await quickbooks.get_bill(conn, db, pb.qb_bill_id, client_id=client_id, client_secret=client_secret)
    pb.qb_last_checked_at = datetime.now(timezone.utc)   # fairness ordering (see _candidate_bills)
    balance = qb_bill.get("Balance")
    total_amt = qb_bill.get("TotalAmt")
    if balance is not None:
        pb.qb_balance = _num(balance)
    if total_amt is not None:
        pb.qb_total_amt = _num(total_amt)

    # Not paid yet (or QB has no real total) — nothing more to do this cycle.
    if balance is None or _num(balance) > _PAID_EPSILON or _num(total_amt) <= 0:
        await db.flush()
        return "open"

    pb.qb_paid_at = datetime.now(timezone.utc)
    _stamp(pb, None, "qbo_payout_paid",
           f"Vendor bill paid in QuickBooks ({pb.doc_number or pb.qb_bill_id})",
           [{"cat": "Balance", "detail": "$0.00 — Paid in full"},
            {"cat": "Amount", "detail": f"${_num(total_amt):,.2f}"}])
    await db.flush()

    # Best-effort push to admins on the open->paid transition (no-ops when push
    # isn't configured; "payout" has no per-sender rows so it falls back to admins).
    try:
        name = await _contact_name(db, pb.contact_id)
        title = f"Payout bill paid ({pb.doc_number or pb.qb_bill_id})"
        body = ((name + " · ") if name else "") + f"Paid in full · ${_num(total_amt):,.2f}"
        await webpush.notify_entity(db, "payout", pb.id, title, body, "/#/labor/payouts")
    except Exception as e:  # pragma: no cover - notify is best-effort
        print(f"[LTP] webpush: payout paid notify failed for bill {pb.id}: {e}", flush=True)
    return "paid"


async def run_bill_poll() -> dict:
    """One full poll cycle. Own session, per-bill commit (so a mid-batch abort
    never loses progress); a QuickBooks auth/API error aborts the cycle and is
    snapshotted on the connection row (Settings → Error Log); any other per-bill
    error is isolated and logged. Never raises. Returns a small summary dict."""
    summary = {"checked": 0, "paid": 0, "skipped": False}
    client_id, client_secret = qbo_sync.creds()

    async with async_session() as db:
        try:
            conn = await quickbooks.load_connection(db)
        except quickbooks.QboNotConnected:
            summary["skipped"] = True
            return summary

        bills = await _candidate_bills(db)
        if len(bills) > _MAX_BILLS_PER_CYCLE:
            bills = bills[:_MAX_BILLS_PER_CYCLE]
            print(f"[LTP] qbo-bill-poll: candidate set capped at {_MAX_BILLS_PER_CYCLE}; "
                  "remaining bills handled next cycle", flush=True)
        # Capture ids up front: a per-bill rollback expires every ORM object in
        # the session, so we re-load each bill freshly (an awaited db.get, which
        # is greenlet-safe) rather than touching an expired instance from the list.
        bill_ids = [pb.id for pb in bills]

        aborted = False
        qb_ok = False  # at least one QB round-trip succeeded this cycle (health proof)
        for bill_id in bill_ids:
            # Re-load conn each iteration too: a per-item rollback (the object-fault
            # skip below, or the generic handler) expires EVERY ORM object in the
            # session including conn, and _process_bill -> refresh_if_needed reads
            # conn's token fields on the next QB call — an expired attribute there
            # raises MissingGreenlet and would silently drop the rest of the cycle.
            # load_connection re-populates it (and is what the tests patch).
            try:
                conn = await quickbooks.load_connection(db)
            except quickbooks.QboNotConnected:
                break  # connection dropped mid-cycle — nothing more to poll
            pb = await db.get(models.PayoutBill, bill_id)
            if pb is None or pb.qb_paid_at is not None or not pb.qb_bill_id:
                continue  # paid/removed since we listed candidates — skip
            summary["checked"] += 1
            try:
                if await _process_bill(db, conn, pb, client_id=client_id, client_secret=client_secret) == "paid":
                    summary["paid"] += 1
                await db.commit()
                qb_ok = True
            except quickbooks.QboReconnectRequired as e:
                # Connection/auth-level — nothing works until an admin reconnects.
                await db.rollback()
                print(f"[LTP] qbo-bill-poll: aborting cycle on reconnect-required: {e}", flush=True)
                summary["qbo_error"] = getattr(e, "safe_message", str(e))
                await quickbooks.record_connection_error(db, summary["qbo_error"])
                aborted = True
                break
            except quickbooks.QboApiError as e:
                await db.rollback()
                if e.status in (400, 404):
                    # Object-level fault (the bill was deleted/voided in QBO, or a
                    # transient per-object error): the CONNECTION is fine (we got a
                    # real response, not an auth failure), so skip THIS bill and
                    # keep polling the rest instead of wedging every higher-id bill.
                    print(f"[LTP] qbo-bill-poll: bill {bill_id} object-level QB error "
                          f"({e.status}), skipping: {e.safe_message}", flush=True)
                    summary["skippedBills"] = summary.get("skippedBills", 0) + 1
                    qb_ok = True
                    # Stamp last-checked so a permanently-dead bill AGES to the back
                    # of the LRU order instead of monopolizing the nullsfirst front
                    # slot every cycle (which, en masse, would re-starve live bills).
                    # The rollback above expired pb, so re-load it to write the stamp.
                    stale = await db.get(models.PayoutBill, bill_id)
                    if stale is not None:
                        stale.qb_last_checked_at = datetime.now(timezone.utc)
                        await db.commit()
                    continue
                # Auth (401/403) or a post-retry 5xx/429 — treat as connection-level.
                print(f"[LTP] qbo-bill-poll: aborting cycle on QuickBooks error: {e}", flush=True)
                summary["qbo_error"] = e.safe_message
                await quickbooks.record_connection_error(db, summary["qbo_error"])
                aborted = True
                break
            except Exception as e:  # pragma: no cover - isolate one bad bill
                await db.rollback()
                print(f"[LTP] qbo-bill-poll: bill {bill_id} failed (continuing): {e}", flush=True)

        # Only declare the connection healthy (clearing the shared last_error the
        # receipt poller may have just set) when THIS cycle actually completed a
        # QuickBooks round-trip. An empty candidate set makes no QB call and is no
        # evidence of health, so it must not wipe a real error (M1).
        if not aborted and qb_ok:
            await quickbooks.clear_connection_error(db)

    return summary
