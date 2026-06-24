"""Tests for the QuickBooks-driven automatic payment receipts
(backend/qbo_receipts.py).

Two layers:
  - Pure composition / reconciliation logic (no DB, no network): money + line
    formatting, the receipt {{header}} box, template resolution, the full
    server-side compose pipeline, {{viewUrl}} finalization, and the idempotent
    mark-paid + synthetic-payment reconciliation.
  - End-to-end poll cycles against a real temp SQLite DB with QuickBooks
    (quickbooks.get_invoice) and Gmail (gmail.send) mocked: a paid invoice is
    reconciled + receipted once; an unpaid one is left alone; a sender whose
    Gmail is unavailable caches the receipt (pending) without losing the paid
    reconciliation; an already-receipted invoice is never touched again; and a
    disconnected QuickBooks short-circuits the whole cycle.

Runs both as pytest and as a plain script:
    python tests/test_qbo_receipts.py
"""
import asyncio
import os
import sys
from datetime import datetime, timezone
from unittest.mock import AsyncMock

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "http://localhost:8000/auth/callback")
# Keep the GLOBAL engine harmlessly in-memory; this test drives its own private
# engine (below) and never touches backend.database.engine, so it can't
# contaminate sibling test files when the whole suite runs in one process.
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from backend import crypto, gmail, models, quickbooks  # noqa: E402
from backend import qbo_receipts as qr  # noqa: E402

# Private temp-file engine for this test's data. We point qbo_receipts'
# async_session at it so run_receipt_poll() (which opens its own session) reads
# our seed. Mirrors the real sessionmaker config (expire_on_commit=False).
_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scratch_receipts_test.db")
engine = create_async_engine("sqlite+aiosqlite:///" + _DB_PATH)
async_session = async_sessionmaker(engine, expire_on_commit=False)
qr.async_session = async_session  # redirect the poller's session factory


_results: list[tuple[str, bool]] = []


def _check(label: str, cond: bool, detail: str = "") -> None:
    _results.append((label, bool(cond)))
    status = "PASS" if cond else "FAIL"
    suffix = f"  ({detail})" if detail else ""
    print(f"  [{status}] {label}{suffix}")


# ── Pure helpers ─────────────────────────────────────────────────────────────

def test_money_and_lines():
    print("test_money_and_lines")
    _check("money 2dp + commas", qr._money(1234.5) == "$1,234.50")
    _check("money handles junk", qr._money(None) == "$0.00")
    line = qr._payment_lines([{"date": "2026-06-12", "amount": 1234.5,
                               "method": "quickbooks", "reference": "QB"}])
    _check("payment line label maps quickbooks", "via QuickBooks" in line)
    _check("payment line has amount", "$1,234.50" in line)
    _check("payment line has reference", "(QB)" in line)


def test_receipt_header():
    print("test_receipt_header")
    h = qr.render_receipt_header("INV-2026-014", "Acme Gala", "$1,234.50")
    _check("header has View Receipt CTA", "View Receipt" in h)
    _check("header leaves viewUrl literal", "{{viewUrl}}" in h)
    _check("header shows reference", "INV-2026-014" in h)
    _check("header shows project", "Acme Gala" in h)
    _check("header shows total", "$1,234.50" in h)
    # Receipt sizing (NOT the larger invoice variant): ref 12px, total 14px.
    _check("receipt ref is 12px", "font-size:12px" in h)
    _check("no due-date line on receipts", "Due " not in h)
    # XSS defense in depth: a hostile project name is escaped.
    hx = qr.render_receipt_header("INV-1", "<script>x</script>", "$1")
    _check("project name escaped", "<script>" not in hx and "&lt;script&gt;" in hx)


def test_resolve_and_compose():
    print("test_resolve_and_compose")
    _check("resolve substitutes known", qr._resolve("{{a}} {{b}}", {"a": "1", "b": "2"}) == "1 2")
    _check("resolve leaves unknown literal", "{{header}}" in qr._resolve("{{header}} {{a}}", {"a": "1"}))

    sender = models.User(name="Jane Boss", email="jane@ltp.com")
    sender.title = "Owner"
    sender.phone = "555-1212"
    sender.picture_url = ""
    text_vars = {
        "companyName": "LTP", "refNumber": "INV-2026-014", "projectName": "Acme Gala",
        "clientName": "Bob", "total": "$1,234.50",
        "lineItems": "Payments Received:\n  Fri, Jun 12, 2026 — $1,234.50 via QuickBooks",
    }
    header = qr.render_receipt_header("INV-2026-014", "Acme Gala", "$1,234.50")
    subject, inner = qr.build_receipt_email({"emailTemplates": {}, "companyName": "LTP"},
                                            sender, text_vars, header)
    _check("subject resolved", "INV-2026-014" in subject)
    _check("body keeps viewUrl literal", "{{viewUrl}}" in inner)
    _check("header token consumed", "{{header}}" not in inner)
    _check("signature token consumed", "{{signature}}" not in inner)
    _check("client name interpolated", "Bob" in inner)
    _check("line items rendered", "Payments Received" in inner)
    _check("signature rendered (sender name present)", "Jane Boss" in inner)

    final = qr._finalize_html(inner, "https://app/#/view/invoice/tok?r=abc",
                              {"companyName": "LTP", "accentColor": "#E8731A"})
    _check("finalize swaps viewUrl", "https://app/#/view/invoice/tok?r=abc" in final)
    _check("finalize leaves no literal viewUrl", "{{viewUrl}}" not in final)
    _check("finalize wraps in email shell", "f1f3f5" in final or "max-width:580px" in final)


def test_reconcile_paid_idempotent():
    print("test_reconcile_paid_idempotent")
    now = datetime(2026, 6, 24, tzinfo=timezone.utc)
    inv = models.Invoice(status="sent", paid_date="", payments=[])
    changed = qr._reconcile_paid(inv, 1000.0, now)
    _check("first reconcile changes", changed is True)
    _check("status → paid", inv.status == "paid")
    _check("paid_date set", inv.paid_date == "2026-06-24")
    _check("one synthetic payment added", len(inv.payments) == 1)
    _check("synthetic payment is full total", abs(inv.payments[0]["amount"] - 1000.0) < 0.001)
    _check("synthetic method is quickbooks", inv.payments[0]["method"] == "quickbooks")

    # Re-run: already paid, payment already covers it → no change, no dup payment.
    changed2 = qr._reconcile_paid(inv, 1000.0, now)
    _check("second reconcile is no-op", changed2 is False)
    _check("no duplicate synthetic payment", len(inv.payments) == 1)

    # Existing partial app payment → synth only the remainder.
    inv2 = models.Invoice(status="partial", paid_date="",
                          payments=[{"id": "p1", "amount": 400.0, "method": "check"}])
    qr._reconcile_paid(inv2, 1000.0, now)
    total_paid = sum(p["amount"] for p in inv2.payments)
    _check("remainder synthesized to reach total", abs(total_paid - 1000.0) < 0.001)
    _check("partial kept original payment", len(inv2.payments) == 2)


# ── Real-DB integration ──────────────────────────────────────────────────────

async def _reset_schema():
    async with engine.begin() as conn:
        await conn.run_sync(models.Base.metadata.drop_all)
        await conn.run_sync(models.Base.metadata.create_all)


async def _seed(*, sender_has_gmail=True, with_company_contact=False):
    """Seed a connection, a sender admin, a client, and one synced+sent invoice.
    Returns the invoice id."""
    async with async_session() as db:
        sender = models.User(
            name="Jane Boss", email="jane@ltp.com", google_sub="g-jane",
            title="Owner", phone="555-1212",
            gmail_refresh_token=(crypto.encrypt_token("rt") if sender_has_gmail else None),
        )
        db.add(sender)
        await db.flush()

        conn = models.QboConnection(
            id=1, realm_id="9999999999", environment="sandbox",
            access_token_enc=crypto.encrypt_token("at"),
            refresh_token_enc=crypto.encrypt_token("rt"),
            access_token_expires_at=datetime.now(timezone.utc),
            connected_by_user_id=sender.id,
        )
        db.add(conn)

        company = models.Company(name="Acme Corp")
        db.add(company)
        await db.flush()
        if with_company_contact:
            ct = models.Contact(first_name="Bob", last_name="Buyer",
                                email="bob@acme.com", company_ids=[company.id])
            db.add(ct)
            await db.flush()
            client_contact_id = None
            company_id = company.id
        else:
            ct = models.Contact(first_name="Bob", last_name="Buyer", email="bob@acme.com")
            db.add(ct)
            await db.flush()
            client_contact_id = ct.id
            company_id = None

        inv = models.Invoice(
            client_type="contact" if client_contact_id else "company",
            company_id=company_id, client_contact_id=client_contact_id,
            status="sent", invoice_date="2026-06-01", due_date="2026-06-30",
            sections=[{"id": "s1", "label": "Services",
                       "items": [{"id": "i1", "type": "service", "name": "Audio",
                                  "qty": 1, "unitPrice": 1000.0}]}],
            payments=[], activity=[], share_token="share-" + os.urandom(8).hex(),
            qb_invoice_id="QB-42", qb_sync_token="3", qb_sync_status="synced",
        )
        db.add(inv)
        await db.flush()
        inv_id = inv.id
        await db.commit()
        return inv_id


async def _get_invoice(inv_id):
    from sqlalchemy import select
    async with async_session() as db:
        r = await db.execute(select(models.Invoice).where(models.Invoice.id == inv_id))
        return r.scalar_one()


async def _count_recipients(inv_id):
    from sqlalchemy import select
    async with async_session() as db:
        r = await db.execute(select(models.EmailRecipient).where(
            models.EmailRecipient.entity_id == inv_id))
        return len(list(r.scalars().all()))


async def test_poll_sends_receipt_when_paid():
    print("test_poll_sends_receipt_when_paid")
    await _reset_schema()
    inv_id = await _seed(sender_has_gmail=True)

    quickbooks.get_invoice = AsyncMock(return_value={
        "Id": "QB-42", "SyncToken": "4", "Balance": 0, "TotalAmt": 1000.0})
    gmail.send = AsyncMock(return_value={"id": "gmail-msg-1"})

    summary = await qr.run_receipt_poll()
    _check("summary one sent", summary["sent"] == 1, str(summary))
    _check("gmail.send called once", gmail.send.await_count == 1)

    inv = await _get_invoice(inv_id)
    _check("receipt_email_status sent", inv.receipt_email_status == "sent")
    _check("receipt_email_sent_at set", inv.receipt_email_sent_at is not None)
    _check("status paid", inv.status == "paid")
    _check("qb_balance recorded 0", (inv.qb_balance or 0) == 0)
    _check("synthetic payment recorded", len(inv.payments) == 1 and inv.payments[0]["method"] == "quickbooks")
    types = [a.get("type") for a in (inv.activity or [])]
    _check("paid activity stamped", "paid" in types)
    _check("email_sent activity stamped", "email_sent" in types)
    _check("one EmailRecipient row", await _count_recipients(inv_id) == 1)

    # Second poll: invoice is now 'sent' → excluded from candidates, no re-send.
    gmail.send = AsyncMock(return_value={"id": "gmail-msg-2"})
    summary2 = await qr.run_receipt_poll()
    _check("second poll sends nothing", summary2["sent"] == 0)
    _check("gmail.send not called again", gmail.send.await_count == 0)


async def test_poll_skips_unpaid():
    print("test_poll_skips_unpaid")
    await _reset_schema()
    inv_id = await _seed(sender_has_gmail=True)
    quickbooks.get_invoice = AsyncMock(return_value={
        "Id": "QB-42", "SyncToken": "4", "Balance": 1000.0, "TotalAmt": 1000.0})
    gmail.send = AsyncMock(return_value={"id": "x"})

    summary = await qr.run_receipt_poll()
    _check("nothing sent for unpaid", summary["sent"] == 0)
    _check("gmail not called", gmail.send.await_count == 0)
    inv = await _get_invoice(inv_id)
    _check("status unchanged (still sent)", inv.status == "sent")
    _check("receipt status still null", inv.receipt_email_status is None)
    _check("qb_balance recorded", abs((inv.qb_balance or 0) - 1000.0) < 0.001)


async def test_poll_caches_when_no_gmail():
    print("test_poll_caches_when_no_gmail")
    await _reset_schema()
    inv_id = await _seed(sender_has_gmail=False)  # connector admin has no Gmail
    quickbooks.get_invoice = AsyncMock(return_value={
        "Id": "QB-42", "SyncToken": "4", "Balance": 0, "TotalAmt": 1000.0})
    gmail.send = AsyncMock(return_value={"id": "x"})

    summary = await qr.run_receipt_poll()
    _check("cached as pending", summary["pending"] == 1, str(summary))
    _check("gmail never attempted", gmail.send.await_count == 0)
    inv = await _get_invoice(inv_id)
    _check("status reconciled to paid anyway", inv.status == "paid")
    _check("receipt cached pending", inv.receipt_email_status == "pending")
    _check("no recipient rows for cached", await _count_recipients(inv_id) == 0)


async def test_poll_caches_on_gmail_reconnect_error():
    print("test_poll_caches_on_gmail_reconnect_error")
    await _reset_schema()
    inv_id = await _seed(sender_has_gmail=True)
    quickbooks.get_invoice = AsyncMock(return_value={
        "Id": "QB-42", "SyncToken": "4", "Balance": 0, "TotalAmt": 1000.0})
    gmail.send = AsyncMock(side_effect=gmail.GmailReconnectRequired("revoked mid-cycle"))

    summary = await qr.run_receipt_poll()
    _check("cached on reconnect error", summary["pending"] == 1, str(summary))
    inv = await _get_invoice(inv_id)
    _check("receipt cached pending", inv.receipt_email_status == "pending")
    _check("recipient rows rolled back", await _count_recipients(inv_id) == 0)
    _check("still reconciled to paid", inv.status == "paid")


async def test_poll_company_contact_resolution():
    print("test_poll_company_contact_resolution")
    await _reset_schema()
    inv_id = await _seed(sender_has_gmail=True, with_company_contact=True)
    quickbooks.get_invoice = AsyncMock(return_value={
        "Id": "QB-42", "SyncToken": "4", "Balance": 0, "TotalAmt": 1000.0})
    captured = {}

    async def _fake_send(**kwargs):
        captured["to"] = kwargs.get("to")
        return {"id": "gmail-msg"}
    gmail.send = AsyncMock(side_effect=_fake_send)

    summary = await qr.run_receipt_poll()
    _check("company-billed receipt sent", summary["sent"] == 1, str(summary))
    _check("resolved company's contact email", captured.get("to") == ["bob@acme.com"])


async def test_poll_skipped_when_not_connected():
    print("test_poll_skipped_when_not_connected")
    await _reset_schema()  # no QboConnection row
    gmail.send = AsyncMock(return_value={"id": "x"})
    summary = await qr.run_receipt_poll()
    _check("poll skipped when disconnected", summary["skipped"] is True)
    _check("gmail not called", gmail.send.await_count == 0)


def test_send_request_receipt_flag():
    print("test_send_request_receipt_flag")
    from backend.routes.email import SendRequest
    base = dict(entityType="invoice", entityId=1, to="a@b.com", subject="s", bodyHtml="<p>x</p>")
    _check("receipt defaults False", SendRequest(**base).receipt is False)
    _check("receipt accepts True", SendRequest(**dict(base, receipt=True)).receipt is True)


def main():
    sync_tests = [test_money_and_lines, test_receipt_header, test_resolve_and_compose,
                  test_reconcile_paid_idempotent, test_send_request_receipt_flag]
    async_tests = [
        test_poll_sends_receipt_when_paid, test_poll_skips_unpaid,
        test_poll_caches_when_no_gmail, test_poll_caches_on_gmail_reconnect_error,
        test_poll_company_contact_resolution, test_poll_skipped_when_not_connected,
    ]
    try:
        for t in sync_tests:
            t()
        for t in async_tests:
            asyncio.run(t())
    finally:
        # Clean up the temp DB file (+ wal/shm if any).
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(_DB_PATH + suffix)
            except OSError:
                pass
    passed = sum(1 for _, ok in _results if ok)
    total = len(_results)
    print(f"\n{passed}/{total} checks passed")
    if passed != total:
        print("FAILURES:")
        for label, ok in _results:
            if not ok:
                print("  -", label)
        sys.exit(1)


if __name__ == "__main__":
    main()
