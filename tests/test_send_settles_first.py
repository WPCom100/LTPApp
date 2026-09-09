"""The send is the LAST step, and the document becomes `sent` inside it.

The report: invoices and quotes "being sent but getting held up at QBO sync" —
the customer had the email while the app still called the document a draft, and
the QuickBooks error never reached Settings → Error Log.

Three things were true of the old pipeline. Marking the document sent was a
separate PUT the browser made AFTER the send answered, so anything that stopped
that write (a tab closed on a phone, a lost connection, a refused stale write)
left the email out and the status at draft. The QuickBooks export of a
tax-exempt invoice ran after the email, so a slow or failing QuickBooks left a
customer holding an invoice the books did not have. And several failure paths
returned (or raised) without recording anything on the document: a raised
HTTPException rolled the `email_failed` stamp back with the transaction, and the
quote tax route stamped nothing at all.

Pins the new contract:

  - POST /api/email/send moves a draft to `sent` in the same transaction as the
    email_sent stamp: status, sentDate (UTC today), a quote's frozen expiryDate,
    and the remembered recipients — all on the row it hands back.
  - A resend leaves status and sentDate alone; a receipt send leaves a paid
    invoice paid.
  - A Gmail failure answers JSON with the {"detail": {...}} shape the frontend
    reads, the document stays a draft, its recipient rows are gone, and the
    `email_failed` stamp is on the row afterwards (it committed).
  - Every kind of QuickBooks push failure is recorded on the invoice, and every
    kind of tax-calculation failure on the quote — the entries Settings → Error
    Log lists.

Runs both as pytest and as a plain script:
    python tests/test_send_settles_first.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_send_settles.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

_db_path = os.path.join(_root, "_test_send_settles.db")
for _suffix in ("", "-wal", "-shm"):
    try:
        os.remove(_db_path + _suffix)
    except FileNotFoundError:
        pass

from sqlalchemy import select  # noqa: E402

from backend import gmail, models, quickbooks  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402
from backend.routes import email as email_route  # noqa: E402
from backend.routes import qbo as qbo_route  # noqa: E402

_ADMIN_TOK = "settles-admin-session"
_ADMIN_ID = None   # this module's sender — recipient rows are counted per sender, so another module's rows never bleed in
_client = None
_seeded = False
_results: list = []


def _check(label, cond, detail=""):
    _results.append((label, bool(cond)))
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  ({detail})" if detail else ""))
    assert cond, f"{label} {detail}"


def _setup():
    global _client, _seeded, _ADMIN_ID
    if _client is None:
        from fastapi.testclient import TestClient
        from backend.main import app
        _client = TestClient(app)
        _client.__enter__()
    if not _seeded:
        from backend.database import async_session

        async def seed():
            async with async_session() as db:
                exp = datetime.now(timezone.utc) + timedelta(days=7)
                admin = models.User(google_sub="settles-admin", email="settles-admin@biz.com",
                                    name="Settles Admin", role="admin")
                db.add(admin)
                await db.flush()
                db.add(models.Session(id=hash_session_token(_ADMIN_TOK), user_id=admin.id, expires_at=exp))
                await db.commit()
                return admin.id

        _ADMIN_ID = asyncio.run(seed())
        _seeded = True
    return _client


def _teardown():
    global _client
    if _client is not None:
        _client.__exit__(None, None, None)
        _client = None


def _cookies():
    return {"ltp_session": _ADMIN_TOK}


def _types(entity):
    return [a.get("type") for a in (entity.get("activity") or [])]


def _today():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


class _Gmail:
    """Swaps backend.gmail.send for the duration of a test."""

    def __init__(self, behaviour=None):
        self.behaviour = behaviour
        self.calls = 0

    def __enter__(self):
        self._orig = gmail.send

        async def fake(**kw):
            self.calls += 1
            if isinstance(self.behaviour, Exception):
                raise self.behaviour
            return {"id": "fake-gmail-id"}

        gmail.send = fake
        return self

    def __exit__(self, *a):
        gmail.send = self._orig


def _new(client, kind, **fields):
    body = {"clientType": "company", "status": "draft",
            "sections": [{"id": "s1", "label": "Labor",
                          "items": [{"id": "i1", "type": "service", "unitPrice": 100, "qty": 1}]}]}
    body.update(fields)
    r = client.post(f"/api/{kind}s", json=body, cookies=_cookies())
    assert r.status_code in (200, 201), r.text[:200]
    return r.json()


def _send(client, kind, row_id, **extra):
    # /api/email/send is rate-limited per IP (backend/rate_limit.py: 20 per
    # minute). Under one pytest process every module's sends share the test
    # client's IP and land in the same window — this module alone added enough
    # to trip it, so the counters are reset before each send here.
    from backend import rate_limit
    rate_limit._state._counts.clear()
    payload = {"entityType": kind, "entityId": row_id, "to": "client@example.com, second@example.com",
               "cc": "cc@example.com", "subject": "Your document", "bodyHtml": "<p>Please review.</p>"}
    payload.update(extra)
    return client.post("/api/email/send", json=payload, cookies=_cookies())


def _recipient_rows(kind, row_id):
    from backend.database import async_session

    async def read():
        async with async_session() as db:
            r = await db.execute(select(models.EmailRecipient).where(
                models.EmailRecipient.entity_type == kind, models.EmailRecipient.entity_id == row_id,
                models.EmailRecipient.sent_by_user_id == _ADMIN_ID))
            return len(r.scalars().all())

    return asyncio.run(read())


# ── The send marks the document sent, atomically ─────────────────────────────

def test_a_sent_draft_quote_is_marked_sent_by_the_send_itself():
    client = _setup()
    q = _new(client, "quote", customName="Gala")
    with _Gmail() as g:
        r = _send(client, "quote", q["id"])
    _check("send succeeded", r.status_code == 200, r.text[:200])
    _check("gmail was called once", g.calls == 1)
    body = r.json()
    row = body.get("row") or {}
    live = client.get(f"/api/quotes/{q['id']}", cookies=_cookies()).json()
    _check("the row handed back is sent", row.get("status") == "sent", str(row.get("status")))
    _check("a GET agrees", live.get("status") == "sent", str(live.get("status")))
    _check("dated today (UTC)", live.get("sentDate") == _today(), str(live.get("sentDate")))
    expected_expiry = (datetime.strptime(_today(), "%Y-%m-%d") + timedelta(days=30)).strftime("%Y-%m-%d")
    _check("the quote's expiry is frozen at sentDate + the default 30 days",
           live.get("expiryDate") == expected_expiry, f"{live.get('expiryDate')} vs {expected_expiry}")
    _check("the recipients are remembered on the row",
           live.get("sendRecipients") == {"to": ["client@example.com", "second@example.com"], "cc": ["cc@example.com"]},
           str(live.get("sendRecipients")))
    _check("the response names what it changed",
           body.get("marked", {}).get("status") == "sent" and body["marked"].get("expiryDate") == expected_expiry,
           str(body.get("marked")))
    _check("and still stamps email_sent", "email_sent" in _types(live), str(_types(live)))
    _check("the row's _rev is the live one", row.get("_rev") == live.get("_rev"))


def test_a_sent_draft_invoice_is_marked_sent_by_the_send_itself():
    client = _setup()
    inv = _new(client, "invoice", customName="Gala invoice", invoiceDate="2026-09-01", dueDate="2026-10-01")
    with _Gmail():
        r = _send(client, "invoice", inv["id"])
    _check("send succeeded", r.status_code == 200, r.text[:200])
    live = client.get(f"/api/invoices/{inv['id']}", cookies=_cookies()).json()
    _check("the invoice is sent", live.get("status") == "sent", str(live.get("status")))
    _check("dated today", live.get("sentDate") == _today(), str(live.get("sentDate")))
    _check("recipients remembered", (live.get("sendRecipients") or {}).get("to") == ["client@example.com", "second@example.com"])
    # Nothing the browser does afterwards is needed for the status — but its
    # habitual PUT (the copy it held before the send, marked sent) still lands
    # without disturbing anything.
    stale = dict(inv, status="sent", sentDate=live["sentDate"])
    p = client.put(f"/api/invoices/{inv['id']}", json=stale, cookies=_cookies())
    _check("the browser's follow-up PUT is still accepted", p.status_code == 200, p.text[:160])
    _check("and keeps email_sent", "email_sent" in _types(p.json()))


def test_a_recalled_draft_is_redated_when_it_goes_out_again():
    client = _setup()
    q = _new(client, "quote", customName="Recalled", sentDate="2026-01-05", expiryDate="2026-02-04")
    with _Gmail():
        r = _send(client, "quote", q["id"])
    _check("send succeeded", r.status_code == 200, r.text[:200])
    live = client.get(f"/api/quotes/{q['id']}", cookies=_cookies()).json()
    _check("sent again", live.get("status") == "sent")
    _check("re-dated to today — it went out again today", live.get("sentDate") == _today(), str(live.get("sentDate")))
    _check("the expiry it already carried is kept", live.get("expiryDate") == "2026-02-04", str(live.get("expiryDate")))


def test_a_resend_leaves_status_and_dates_alone():
    client = _setup()
    q = _new(client, "quote", customName="Resend", status="accepted", sentDate="2026-03-01", expiryDate="2026-03-31")
    with _Gmail():
        r = _send(client, "quote", q["id"])
    _check("resend succeeded", r.status_code == 200, r.text[:200])
    live = client.get(f"/api/quotes/{q['id']}", cookies=_cookies()).json()
    _check("status untouched", live.get("status") == "accepted", str(live.get("status")))
    _check("sentDate untouched — the original offer, going out again", live.get("sentDate") == "2026-03-01")
    _check("expiry untouched", live.get("expiryDate") == "2026-03-31")
    _check("recipients still remembered", (live.get("sendRecipients") or {}).get("cc") == ["cc@example.com"])


def test_a_receipt_send_leaves_a_paid_invoice_paid():
    client = _setup()
    inv = _new(client, "invoice", customName="Paid", status="paid", sentDate="2026-04-01", paidDate="2026-04-20",
               payments=[{"id": "p1", "date": "2026-04-20", "method": "ach", "amount": 100}])
    with _Gmail():
        r = _send(client, "invoice", inv["id"], receipt=True)
    _check("receipt sent", r.status_code == 200, r.text[:200])
    live = client.get(f"/api/invoices/{inv['id']}", cookies=_cookies()).json()
    _check("still paid", live.get("status") == "paid", str(live.get("status")))
    _check("sentDate untouched", live.get("sentDate") == "2026-04-01")
    _check("nothing marked", r.json().get("marked") == {}, str(r.json().get("marked")))
    _check("the receipt slot is claimed", live.get("receiptEmailStatus") == "sent", str(live.get("receiptEmailStatus")))


# ── Failures stay drafts and are on record ───────────────────────────────────

def test_a_gmail_failure_is_recorded_and_leaves_the_draft():
    client = _setup()
    q = _new(client, "quote", customName="Boom")
    with _Gmail(gmail.GmailSendError(500, "Gmail upstream blew up")):
        r = _send(client, "quote", q["id"])
    _check("answers 502", r.status_code == 502, r.text[:160])
    body = r.json()
    _check("with the shape the frontend reads", (body.get("detail") or {}).get("reason") == "gmail_error", r.text[:160])
    _check("naming the error", "blew up" in ((body.get("detail") or {}).get("error") or ""))
    live = client.get(f"/api/quotes/{q['id']}", cookies=_cookies()).json()
    _check("the quote is still a draft", live.get("status") == "draft", str(live.get("status")))
    _check("no sentDate", not (live.get("sentDate") or ""), str(live.get("sentDate")))
    _check("the email_failed stamp COMMITTED (it used to roll back with the raised exception)",
           "email_failed" in _types(live), str(_types(live)))
    _check("and no email_sent", "email_sent" not in _types(live))
    _check("its recipient rows were rolled back", _recipient_rows("quote", q["id"]) == 0)


def test_a_gmail_reconnect_answers_409_json_and_leaves_the_draft():
    client = _setup()
    inv = _new(client, "invoice", customName="Reconnect")
    with _Gmail(gmail.GmailReconnectRequired("refresh token rejected by Google")):
        r = _send(client, "invoice", inv["id"])
    _check("answers 409", r.status_code == 409, r.text[:160])
    _check("reason=reconnect under detail", (r.json().get("detail") or {}).get("reason") == "reconnect", r.text[:160])
    live = client.get(f"/api/invoices/{inv['id']}", cookies=_cookies()).json()
    _check("still a draft", live.get("status") == "draft")
    _check("no stamp of any kind — the send simply did not happen",
           not any(t in ("email_sent", "email_failed") for t in _types(live)), str(_types(live)))
    _check("recipient rows rolled back", _recipient_rows("invoice", inv["id"]) == 0)


def _push_with(client, inv_id, exc):
    original = qbo_route.qbo_sync.push_invoice

    async def _fail(db, invoice, user=None, **kw):
        raise exc

    qbo_route.qbo_sync.push_invoice = _fail
    try:
        return client.post(f"/api/qbo/invoices/{inv_id}/push", json={"signature": "sig"}, cookies=_cookies())
    finally:
        qbo_route.qbo_sync.push_invoice = original


def test_every_kind_of_push_failure_is_recorded_on_the_invoice():
    client = _setup()
    cases = [
        ("reconnect", quickbooks.QboReconnectRequired("expired"), 409, "reconnect", "Reconnect"),
        ("not connected", quickbooks.QboNotConnected(), 409, "not_connected", "not connected"),
        ("not syncable", qbo_route.qbo_sync.InvoiceNotSyncable("invoice has no client (company or contact) to bill"), 400, "not_syncable", "no client"),
        ("QuickBooks fault", quickbooks.QboApiError(400, '{"Fault":{"Error":[{"Message":"Business Validation Error","Detail":"Duplicate Document Number"}]}}'), 502, "qbo_error", "Duplicate"),
    ]
    for label, exc, status, reason, needle in cases:
        inv = _new(client, "invoice", customName=f"Push {label}")
        r = _push_with(client, inv["id"], exc)
        _check(f"{label}: answers {status}", r.status_code == status, f"{r.status_code}: {r.text[:120]}")
        _check(f"{label}: reason={reason}", r.json().get("reason") == reason, r.text[:120])
        live = client.get(f"/api/invoices/{inv['id']}", cookies=_cookies()).json()
        _check(f"{label}: a qbo_sync_failed entry is on the invoice", "qbo_sync_failed" in _types(live), str(_types(live)))
        err = next((c.get("detail") for a in live.get("activity") or [] if a.get("type") == "qbo_sync_failed"
                    for c in (a.get("changes") or []) if c.get("cat") == "Error"), "")
        _check(f"{label}: naming the reason", needle.lower() in (err or "").lower(), repr(err))
        _check(f"{label}: the invoice card shows the error", live.get("qbSyncStatus") == "error" and needle.lower() in (live.get("qbLastError") or "").lower(),
               f"{live.get('qbSyncStatus')} / {live.get('qbLastError')}")
        _check(f"{label}: and it is still a draft", live.get("status") == "draft")


def test_every_kind_of_tax_failure_is_recorded_on_the_quote():
    client = _setup()
    cases = [
        ("reconnect", quickbooks.QboReconnectRequired("expired"), 409, "Reconnect"),
        ("not connected", quickbooks.QboNotConnected(), 409, "not connected"),
        ("QuickBooks fault", quickbooks.QboApiError(500, "Intuit fell over"), 502, "fell over"),
        ("unmapped", RuntimeError("something nobody mapped"), 500, "RuntimeError"),
    ]
    original = qbo_route.qbo_sync.get_quote_estimate_tax
    for label, exc, status, needle in cases:
        q = _new(client, "quote", customName=f"Tax {label}")

        async def _fail(db, quote, user=None, **kw):
            raise exc

        qbo_route.qbo_sync.get_quote_estimate_tax = _fail
        try:
            r = client.post(f"/api/qbo/quotes/{q['id']}/estimate-tax", json={"signature": "sig"}, cookies=_cookies())
        finally:
            qbo_route.qbo_sync.get_quote_estimate_tax = original
        _check(f"{label}: answers {status} as JSON", r.status_code == status and isinstance(r.json(), dict), f"{r.status_code}: {r.text[:120]}")
        live = client.get(f"/api/quotes/{q['id']}", cookies=_cookies()).json()
        _check(f"{label}: a qbo_sync_failed entry is on the quote (it used to record nothing)",
               "qbo_sync_failed" in _types(live), str(_types(live)))
        err = next((c.get("detail") for a in live.get("activity") or [] if a.get("type") == "qbo_sync_failed"
                    for c in (a.get("changes") or []) if c.get("cat") == "Error"), "")
        _check(f"{label}: naming the reason", needle.lower() in (err or "").lower(), repr(err))
        _check(f"{label}: the quote is still a draft", live.get("status") == "draft")


def main() -> int:
    try:
        test_a_sent_draft_quote_is_marked_sent_by_the_send_itself()
        test_a_sent_draft_invoice_is_marked_sent_by_the_send_itself()
        test_a_recalled_draft_is_redated_when_it_goes_out_again()
        test_a_resend_leaves_status_and_dates_alone()
        test_a_receipt_send_leaves_a_paid_invoice_paid()
        test_a_gmail_failure_is_recorded_and_leaves_the_draft()
        test_a_gmail_reconnect_answers_409_json_and_leaves_the_draft()
        test_every_kind_of_push_failure_is_recorded_on_the_invoice()
        test_every_kind_of_tax_failure_is_recorded_on_the_quote()
    finally:
        _teardown()
    failed = sum(1 for _, ok in _results if not ok)
    print(f"\n== {len(_results) - failed}/{len(_results)} checks passed ==")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
