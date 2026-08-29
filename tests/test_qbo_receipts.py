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
    assert cond, f"{label} {detail}"


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


def test_empty_project_name_no_orphan_parens():
    print("test_empty_project_name_no_orphan_parens")
    # The default template reads "...payment for {{refNumber}} ({{projectName}})."
    # A project-less invoice with no custom name leaves projectName empty; the
    # composed body must NOT show a bare "()" (the bug from the reported receipt).
    _check("strip helper collapses ' ()'", qr._strip_empty_parens("for INV-2026-002 ().") == "for INV-2026-002.")
    _check("strip helper leaves filled parens", qr._strip_empty_parens("for INV (Gala).") == "for INV (Gala).")

    sender = models.User(name="Jane Boss", email="jane@ltp.com")
    sender.picture_url = ""
    tv = {"companyName": "LTP", "refNumber": "INV-2026-002", "projectName": "",
          "clientName": "Zach", "total": "$5,938.43", "lineItems": "Payments Received:"}
    header = qr.render_receipt_header("INV-2026-002", "", "$5,938.43")
    _, inner = qr.build_receipt_email({"emailTemplates": {}, "companyName": "LTP"},
                                      sender, tv, header)
    _check("no orphan '()' in composed body", "()" not in inner)
    _check("clean sentence for nameless invoice", "payment for INV-2026-002." in inner)

    # With a name present, the parenthetical is preserved.
    tv2 = dict(tv, projectName="Downtown Gala")
    _, inner2 = qr.build_receipt_email({"emailTemplates": {}, "companyName": "LTP"},
                                       sender, tv2, header)
    _check("named invoice keeps '(project)'", "INV-2026-002 (Downtown Gala)" in inner2)


def test_fallback_matches_settings_default():
    print("test_fallback_matches_settings_default")
    import re
    with open(os.path.join(_root, "data", "settings.js"), encoding="utf-8") as f:
        src = f.read()
    # Scope to the paymentReceipt object. Split on the close line ("\n    },")
    # — NOT a bare "}," which also occurs inside "{{clientName}},".
    block = src.split("paymentReceipt:", 1)[1].split("\n    },", 1)[0]

    def grab(field):
        m = re.search(field + r'\s*:\s*"((?:[^"\\]|\\.)*)"', block)
        return m.group(1).replace('\\"', '"').replace("\\n", "\n")

    js_subject, js_body = grab("subject"), grab("body")
    # The no-DB-saved fallback must be the SAME template an admin sees in
    # Settings, so the auto-receipt never sends a different stub than the manual
    # flow. Pinned byte-for-byte to data/settings.js::paymentReceipt.
    _check("fallback subject matches data/settings.js", qr._FALLBACK_SUBJECT == js_subject,
           f"py={qr._FALLBACK_SUBJECT!r} js={js_subject!r}")
    _check("fallback body matches data/settings.js", qr._FALLBACK_BODY == js_body)


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


async def test_poll_caches_on_gmail_auth_error():
    """A 401 from Google's token endpoint (bad/missing GOOGLE_CLIENT_ID/SECRET)
    is an app-config problem, not this invoice's fault: cache as pending and
    retry silently — do NOT stamp an email_failed every cycle."""
    print("test_poll_caches_on_gmail_auth_error")
    await _reset_schema()
    inv_id = await _seed(sender_has_gmail=True)
    quickbooks.get_invoice = AsyncMock(return_value={
        "Id": "QB-42", "SyncToken": "4", "Balance": 0, "TotalAmt": 1000.0})
    gmail.send = AsyncMock(side_effect=gmail.GmailSendError(401, "Google token refresh failed: invalid_client"))

    summary = await qr.run_receipt_poll()
    _check("auth error cached as pending", summary["pending"] == 1, str(summary))
    _check("auth error NOT counted as failed", summary["failed"] == 0, str(summary))
    inv = await _get_invoice(inv_id)
    _check("receipt cached pending", inv.receipt_email_status == "pending")
    _check("no email_failed stamped for auth error",
           not any(a.get("type") == "email_failed" for a in (inv.activity or [])))
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


async def _set_invoice_fields(inv_id, **fields):
    from sqlalchemy import select
    async with async_session() as db:
        r = await db.execute(select(models.Invoice).where(models.Invoice.id == inv_id))
        inv = r.scalar_one()
        for k, v in fields.items():
            setattr(inv, k, v)
        await db.commit()


async def test_poll_receipt_name_and_no_orphan_parens():
    """A QuickBooks-driven receipt is usually for a project-LESS invoice. Its
    name must resolve the SAME way the manual Send Receipt flow does — custom_name
    first (matching modules/invoices.js openReceiptModal / doc_display_name) — and
    when there is no name at all the body must not show a bare '()'."""
    print("test_poll_receipt_name_and_no_orphan_parens")

    async def _run_and_capture():
        captured = {}

        async def _fake_send(**kwargs):
            captured["html"] = kwargs.get("html_body")
            return {"id": "gmail-msg"}
        quickbooks.get_invoice = AsyncMock(return_value={
            "Id": "QB-42", "SyncToken": "4", "Balance": 0, "TotalAmt": 1000.0})
        gmail.send = AsyncMock(side_effect=_fake_send)
        await qr.run_receipt_poll()
        return captured.get("html", "")

    # (1) Project-less invoice WITH a custom name → the name shows in the receipt.
    await _reset_schema()
    inv_id = await _seed(sender_has_gmail=True)
    await _set_invoice_fields(inv_id, project_id=None, custom_name="Downtown Gala")
    html = await _run_and_capture()
    _check("receipt shows custom name", "Downtown Gala" in html, html[:200])
    _check("named receipt has no orphan '()'", "()" not in html)

    # (2) Project-less invoice with NO name → clean sentence, no bare '()'.
    await _reset_schema()
    inv_id = await _seed(sender_has_gmail=True)
    await _set_invoice_fields(inv_id, project_id=None, custom_name="")
    html2 = await _run_and_capture()
    _check("nameless receipt has no orphan '()'", "()" not in html2, html2[:200])
    _check("nameless receipt keeps the invoice number", "INV" in html2 or "Invoice" in html2)


async def test_poll_uses_google_creds_for_gmail():
    """Regression: the QB API fetch must get the QuickBooks OAuth client while
    the Gmail send must get the GOOGLE OAuth client. Handing QB creds to Gmail's
    token endpoint (the old bug) returns invalid_client and every receipt fails
    even though manual quote sends — which use the Google creds — work."""
    print("test_poll_uses_google_creds_for_gmail")
    await _reset_schema()
    await _seed(sender_has_gmail=True)

    os.environ["QBO_CLIENT_ID"] = "qbo-cid"
    os.environ["QBO_CLIENT_SECRET"] = "qbo-secret"
    os.environ["GOOGLE_CLIENT_ID"] = "google-cid"
    os.environ["GOOGLE_CLIENT_SECRET"] = "google-secret"

    captured = {}

    async def _fake_get_invoice(*args, **kwargs):
        captured["qb_id"] = kwargs.get("client_id")
        captured["qb_secret"] = kwargs.get("client_secret")
        return {"Id": "QB-42", "SyncToken": "4", "Balance": 0, "TotalAmt": 1000.0}

    async def _fake_send(**kwargs):
        captured["gmail_id"] = kwargs.get("client_id")
        captured["gmail_secret"] = kwargs.get("client_secret")
        return {"id": "gmail-msg"}

    quickbooks.get_invoice = AsyncMock(side_effect=_fake_get_invoice)
    gmail.send = AsyncMock(side_effect=_fake_send)

    summary = await qr.run_receipt_poll()
    _check("receipt sent with correct creds", summary["sent"] == 1, str(summary))
    _check("QB fetch got QuickBooks client id", captured.get("qb_id") == "qbo-cid",
           f"qb_id={captured.get('qb_id')!r}")
    _check("QB fetch got QuickBooks client secret", captured.get("qb_secret") == "qbo-secret")
    _check("Gmail send got Google client id", captured.get("gmail_id") == "google-cid",
           f"gmail_id={captured.get('gmail_id')!r}")
    _check("Gmail send got Google client secret", captured.get("gmail_secret") == "google-secret")
    _check("Gmail did NOT receive the QuickBooks client", captured.get("gmail_id") != "qbo-cid")


async def test_poll_failed_receipt_not_restamped():
    """A receipt Gmail keeps rejecting (GmailSendError) is retried each cycle but
    must log a single email_failed entry — on the transition into 'failed' — not
    a fresh one every cycle. The old behavior flooded the activity feed."""
    print("test_poll_failed_receipt_not_restamped")
    await _reset_schema()
    inv_id = await _seed(sender_has_gmail=True)
    quickbooks.get_invoice = AsyncMock(return_value={
        "Id": "QB-42", "SyncToken": "4", "Balance": 0, "TotalAmt": 1000.0})
    gmail.send = AsyncMock(side_effect=gmail.GmailSendError(400, "Gmail rejected the message"))

    summary1 = await qr.run_receipt_poll()
    _check("first cycle records one failure", summary1["failed"] == 1, str(summary1))
    inv = await _get_invoice(inv_id)
    _check("status is failed after first cycle", inv.receipt_email_status == "failed")
    n1 = len([a for a in (inv.activity or []) if a.get("type") == "email_failed"])
    _check("exactly one email_failed after first cycle", n1 == 1, f"n={n1}")

    # Second cycle: still failing, but must NOT append another email_failed.
    gmail.send = AsyncMock(side_effect=gmail.GmailSendError(400, "Gmail rejected the message"))
    await qr.run_receipt_poll()
    inv = await _get_invoice(inv_id)
    n2 = len([a for a in (inv.activity or []) if a.get("type") == "email_failed"])
    _check("still exactly one email_failed after retry", n2 == 1, f"n={n2}")
    _check("no recipient rows left after failed retries", await _count_recipients(inv_id) == 0)


async def _get_conn():
    from sqlalchemy import select
    async with async_session() as db:
        r = await db.execute(select(models.QboConnection).where(models.QboConnection.id == 1))
        return r.scalar_one_or_none()


async def _set_conn_last_error(msg):
    from sqlalchemy import select
    async with async_session() as db:
        r = await db.execute(select(models.QboConnection).where(models.QboConnection.id == 1))
        conn = r.scalar_one()
        conn.last_error = msg
        conn.last_error_at = datetime.now(timezone.utc)
        await db.commit()


async def test_poll_records_qbo_connection_error():
    """A QuickBooks API error aborts the cycle AND snapshots the error on the
    connection row so Settings → Error Log can show it (not just the server log)."""
    print("test_poll_records_qbo_connection_error")
    await _reset_schema()
    await _seed(sender_has_gmail=True)
    quickbooks.get_invoice = AsyncMock(
        side_effect=quickbooks.QboApiError(500, "QuickBooks is temporarily unavailable"))
    gmail.send = AsyncMock(return_value={"id": "x"})

    summary = await qr.run_receipt_poll()
    _check("cycle recorded a qbo_error", bool(summary.get("qbo_error")), str(summary))
    conn = await _get_conn()
    _check("connection last_error persisted", bool(conn and conn.last_error), str(conn and conn.last_error))
    _check("last_error_at set", conn is not None and conn.last_error_at is not None)
    _check("gmail never attempted after abort", gmail.send.await_count == 0)


async def test_poll_clears_qbo_connection_error_on_clean_cycle():
    """Once QuickBooks is reachable again, a clean poll cycle retires the stale
    connection error so the Error Log clears itself."""
    print("test_poll_clears_qbo_connection_error_on_clean_cycle")
    await _reset_schema()
    await _seed(sender_has_gmail=True)
    await _set_conn_last_error("earlier failure")
    # Unpaid invoice → nothing to send, no abort → clean cycle.
    quickbooks.get_invoice = AsyncMock(return_value={
        "Id": "QB-42", "SyncToken": "4", "Balance": 1000.0, "TotalAmt": 1000.0})
    gmail.send = AsyncMock(return_value={"id": "x"})

    conn_before = await _get_conn()
    _check("precondition: last_error set", conn_before.last_error == "earlier failure")
    await qr.run_receipt_poll()
    conn = await _get_conn()
    _check("clean cycle cleared last_error", conn.last_error is None)
    _check("clean cycle cleared last_error_at", conn.last_error_at is None)


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
                  test_empty_project_name_no_orphan_parens,
                  test_fallback_matches_settings_default, test_reconcile_paid_idempotent,
                  test_send_request_receipt_flag]
    async_tests = [
        test_poll_sends_receipt_when_paid, test_poll_skips_unpaid,
        test_poll_caches_when_no_gmail, test_poll_caches_on_gmail_reconnect_error,
        test_poll_caches_on_gmail_auth_error,
        test_poll_company_contact_resolution,
        test_poll_receipt_name_and_no_orphan_parens,
        test_poll_uses_google_creds_for_gmail,
        test_poll_failed_receipt_not_restamped, test_poll_records_qbo_connection_error,
        test_poll_clears_qbo_connection_error_on_clean_cycle,
        test_poll_skipped_when_not_connected,
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
