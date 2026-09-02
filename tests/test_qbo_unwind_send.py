"""Undoing a QuickBooks push whose send then failed.

Sending a taxable invoice pushes to QuickBooks FIRST — QuickBooks computes the
sales tax, and the emailed PDF is rendered server-side from the saved row, so the
tax has to be on that row before the email is built
(modules/invoices.js::executeSend). If the email then fails, that push has
already created a live invoice in QuickBooks for a document nobody received.
POST /api/qbo/invoices/{id}/unwind-send deletes it and returns the row to
never-pushed, so the failure leaves nothing to clean up by hand.

This is a destructive operation against the customer's books, so the guards
matter more than the happy path:

  - It only ever runs for a push that CREATED the invoice. An update means the
    QuickBooks record pre-existed this send — on a resend, one the customer may
    already hold — so it is not ours to delete. The caller enforces that by
    passing the id only when the push reported action "created"; the route
    enforces the rest.
  - The caller must pass the id it believes it created. If the row has since
    moved to a different QuickBooks invoice, the unwind is refused rather than
    deleting whatever is there now.
  - A network error on the send is NOT proof the send failed (the server may
    have sent and lost the response), so the frontend does not unwind there —
    it reports what exists. Covered by the caller, not this route.
  - If QuickBooks refuses the delete, the local link is left INTACT so the
    frontend can tell the user exactly which invoice is still out there.

Covers all of the above plus: the local row itself survives, the QuickBooks link
fields are fully cleared (a half-cleared link would make the next push try to
UPDATE a deleted id instead of creating a fresh invoice), and the unwind is
stamped into the activity log.

Runs both as pytest and as a plain script:
    python tests/test_qbo_unwind_send.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_qbo_unwind.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

_db_path = os.path.join(_root, "_test_qbo_unwind.db")
for _suffix in ("", "-wal", "-shm"):
    try:
        os.remove(_db_path + _suffix)
    except FileNotFoundError:
        pass

from backend import models, quickbooks  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402
from backend.routes import qbo as qbo_route  # noqa: E402

_ADMIN_TOK = "unwind-admin-session"
_MEMBER_TOK = "unwind-member-session"
_client = None
_seeded = False
_results: list = []


def _check(label, cond, detail=""):
    _results.append((label, bool(cond)))
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  ({detail})" if detail else ""))
    assert cond, f"{label} {detail}"


def _setup():
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
                exp = datetime.now(timezone.utc) + timedelta(days=7)
                admin = models.User(google_sub="unwind-admin", email="unwind-admin@biz.com",
                                    name="Unwind Admin", role="admin")
                member = models.User(google_sub="unwind-member", email="unwind-member@biz.com",
                                     name="Unwind Member", role="member")
                db.add_all([admin, member])
                await db.flush()
                db.add(models.Session(id=hash_session_token(_ADMIN_TOK), user_id=admin.id, expires_at=exp))
                db.add(models.Session(id=hash_session_token(_MEMBER_TOK), user_id=member.id, expires_at=exp))
                await db.commit()

        asyncio.run(seed())
        _seeded = True
    return _client


def _teardown():
    global _client
    if _client is not None:
        _client.__exit__(None, None, None)
        _client = None


def _cookies(tok=_ADMIN_TOK):
    return {"ltp_session": tok}


def _new_pushed_invoice(client, qb_id="QB-777"):
    """An invoice in the state a successful push leaves behind."""
    inv = client.post("/api/invoices", json={
        "clientType": "company", "status": "draft", "customName": "Unwind Me",
        "sections": [{"id": "s1", "label": "L",
                      "items": [{"id": "i1", "type": "service", "unitPrice": 1000, "qty": 1}]}],
    }, cookies=_cookies()).json()
    # qb_* columns are server-authoritative (stripped from CRUD writes), so set
    # them the way push_invoice would.
    from backend.database import async_session

    async def stamp():
        async with async_session() as db:
            row = await db.get(models.Invoice, inv["id"])
            row.qb_invoice_id = qb_id
            row.qb_sync_token = "0"
            row.qb_sync_status = "synced"
            row.qb_synced_at = datetime.now(timezone.utc)
            row.qb_synced_signature = "sig"
            row.qb_tax_total = 82.50
            row.qb_total_amt = 1082.50
            await db.commit()

    asyncio.run(stamp())
    return inv["id"]


def _read(client, inv_id):
    return client.get(f"/api/invoices/{inv_id}", cookies=_cookies()).json()


def _qb_link_fields(client, inv_id):
    from backend.database import async_session

    async def read():
        async with async_session() as db:
            r = await db.get(models.Invoice, inv_id)
            return {
                "qb_invoice_id": r.qb_invoice_id, "qb_sync_token": r.qb_sync_token,
                "qb_sync_status": r.qb_sync_status, "qb_synced_at": r.qb_synced_at,
                "qb_synced_signature": r.qb_synced_signature, "qb_last_error": r.qb_last_error,
                "qb_tax_total": r.qb_tax_total, "qb_total_amt": r.qb_total_amt,
            }

    return asyncio.run(read())


class _Stub:
    """Swaps qbo_sync.delete_from_quickbooks for the duration of a test."""

    def __init__(self, behaviour):
        self.behaviour = behaviour
        self.calls = []

    def __enter__(self):
        self._orig = qbo_route.qbo_sync.delete_from_quickbooks

        async def fake(db, invoice, **kw):
            self.calls.append(invoice.qb_invoice_id)
            if isinstance(self.behaviour, Exception):
                raise self.behaviour
            return {"ok": True, "deleted": True, "qbInvoiceId": invoice.qb_invoice_id}

        qbo_route.qbo_sync.delete_from_quickbooks = fake
        return self

    def __exit__(self, *a):
        qbo_route.qbo_sync.delete_from_quickbooks = self._orig


# ── Happy path ───────────────────────────────────────────────────────────────

def test_unwind_deletes_in_quickbooks_and_unlinks_the_row():
    client = _setup()
    inv_id = _new_pushed_invoice(client, "QB-777")
    with _Stub(None) as stub:
        r = client.post(f"/api/qbo/invoices/{inv_id}/unwind-send",
                        json={"qbInvoiceId": "QB-777"}, cookies=_cookies())
    _check("unwind returns 200", r.status_code == 200, r.text[:200])
    _check("reports it unwound", r.json().get("unwound") is True, r.text[:200])
    _check("QuickBooks delete was called once for that id", stub.calls == ["QB-777"], str(stub.calls))

    link = _qb_link_fields(client, inv_id)
    # A HALF-cleared link is the dangerous outcome: the next push would try to
    # UPDATE an id QuickBooks no longer has instead of creating a fresh invoice.
    for field, value in link.items():
        _check(f"{field} cleared", value is None, repr(value))

    row = _read(client, inv_id)
    _check("the invoice itself survives", row.get("id") == inv_id, str(row.get("id")))
    _check("it is still a draft", row.get("status") == "draft", str(row.get("status")))
    _check("the unwind is stamped in activity",
           any(a.get("type") == "qbo_unwound" for a in (row.get("activity") or [])),
           str([a.get("type") for a in (row.get("activity") or [])]))


# ── Guards ───────────────────────────────────────────────────────────────────

def test_refuses_when_the_row_points_somewhere_else():
    # Someone re-pushed between the failed send and the unwind. Whatever is in
    # QuickBooks now is not the invoice this send created.
    client = _setup()
    inv_id = _new_pushed_invoice(client, "QB-NEWER")
    with _Stub(None) as stub:
        r = client.post(f"/api/qbo/invoices/{inv_id}/unwind-send",
                        json={"qbInvoiceId": "QB-STALE"}, cookies=_cookies())
    _check("refused with 409", r.status_code == 409, r.text[:200])
    _check("reason is 'moved'", r.json().get("reason") == "moved", r.text[:200])
    _check("QuickBooks was never called", stub.calls == [], str(stub.calls))
    _check("link left intact", _qb_link_fields(client, inv_id)["qb_invoice_id"] == "QB-NEWER")


def test_never_pushed_invoice_is_a_no_op():
    client = _setup()
    inv = client.post("/api/invoices", json={"clientType": "company", "status": "draft"},
                      cookies=_cookies()).json()
    with _Stub(None) as stub:
        r = client.post(f"/api/qbo/invoices/{inv['id']}/unwind-send",
                        json={"qbInvoiceId": "anything"}, cookies=_cookies())
    _check("200 with unwound False", r.status_code == 200 and r.json().get("unwound") is False, r.text[:200])
    _check("QuickBooks was never called", stub.calls == [], str(stub.calls))


def test_a_quickbooks_failure_leaves_the_link_intact():
    # The frontend turns this into "this invoice IS in QuickBooks and could not
    # be removed" — which is only true if we did NOT clear the link.
    client = _setup()
    for label, exc, expect_status in (
        ("API error", quickbooks.QboApiError(502, '{"Fault":{"Error":[{"Message":"boom"}]}}'), 502),
        ("not connected", quickbooks.QboNotConnected("nope"), 409),
        ("reconnect required", quickbooks.QboReconnectRequired("expired"), 409),
    ):
        inv_id = _new_pushed_invoice(client, "QB-KEEP")
        with _Stub(exc):
            r = client.post(f"/api/qbo/invoices/{inv_id}/unwind-send",
                            json={"qbInvoiceId": "QB-KEEP"}, cookies=_cookies())
        _check(f"{label} → {expect_status}", r.status_code == expect_status, r.text[:160])
        _check(f"{label} → names the stranded invoice",
               r.json().get("qbInvoiceId") == "QB-KEEP", r.text[:160])
        link = _qb_link_fields(client, inv_id)
        _check(f"{label} → link NOT cleared", link["qb_invoice_id"] == "QB-KEEP", repr(link["qb_invoice_id"]))
        _check(f"{label} → tax NOT cleared", link["qb_tax_total"] == 82.50, repr(link["qb_tax_total"]))


def test_an_unmapped_failure_on_push_is_json_and_recorded():
    """The report: "Sales Tax Unavailable … Network or server error: Unexpected
    token 'I', \"Internal S\"... is not valid JSON" on sending an invoice, with
    nothing in the app's error list.

    An exception the push route did not map (here a plain RuntimeError, in
    production an httpx transport error) escaped as FastAPI's plain-text 500.
    The route must answer JSON the client can read, and record the failure on
    the invoice like any other failed sync."""
    client = _setup()
    inv = client.post("/api/invoices", json={
        "clientType": "company", "status": "draft", "customName": "Boom",
        "sections": [{"id": "s1", "label": "L",
                      "items": [{"id": "i1", "type": "service", "unitPrice": 100, "qty": 1}]}],
    }, cookies=_cookies()).json()

    async def _explode(db, invoice, user=None, **kw):
        raise RuntimeError("something nobody mapped")

    original = qbo_route.qbo_sync.push_invoice
    qbo_route.qbo_sync.push_invoice = _explode
    try:
        r = client.post(f"/api/qbo/invoices/{inv['id']}/push", json={"signature": "sig"}, cookies=_cookies())
    finally:
        qbo_route.qbo_sync.push_invoice = original
    _check("answers 500", r.status_code == 500, r.text[:160])
    body = r.json()   # would raise on the old plain-text body
    _check("as JSON with reason=server_error", body.get("reason") == "server_error", r.text[:160])
    _check("naming the exception", "RuntimeError" in (body.get("error") or ""), body.get("error"))

    from backend.database import async_session

    async def read():
        async with async_session() as db:
            row = await db.get(models.Invoice, inv["id"])
            return row.qb_sync_status, row.qb_last_error, list(row.activity or [])

    status, last_error, activity = asyncio.run(read())
    _check("invoice marked as a failed sync", status == "error", repr(status))
    _check("with the reason on the row", "RuntimeError" in (last_error or ""), repr(last_error))
    _check("and a qbo_sync_failed activity entry",
           any(a.get("type") == "qbo_sync_failed" for a in activity), repr(activity)[:200])


def test_unwind_is_admin_only():
    # It deletes from the customer's books; same bar as push and delete.
    client = _setup()
    inv_id = _new_pushed_invoice(client, "QB-ADMINONLY")
    with _Stub(None) as stub:
        r = client.post(f"/api/qbo/invoices/{inv_id}/unwind-send",
                        json={"qbInvoiceId": "QB-ADMINONLY"}, cookies=_cookies(_MEMBER_TOK))
    _check("non-admin refused", r.status_code in (401, 403), f"{r.status_code} {r.text[:120]}")
    _check("QuickBooks was never called", stub.calls == [], str(stub.calls))
    _check("link left intact", _qb_link_fields(client, inv_id)["qb_invoice_id"] == "QB-ADMINONLY")


def main() -> int:
    tests = [
        test_unwind_deletes_in_quickbooks_and_unlinks_the_row,
        test_refuses_when_the_row_points_somewhere_else,
        test_never_pushed_invoice_is_a_no_op,
        test_a_quickbooks_failure_leaves_the_link_intact,
        test_unwind_is_admin_only,
    ]
    failed = 0
    try:
        for t in tests:
            print(f"\n{t.__name__}:")
            try:
                t()
            except AssertionError as e:
                failed += 1
                print(f"  !! {e}")
    finally:
        _teardown()
    total = len(_results)
    bad = sum(1 for _, ok in _results if not ok)
    print(f"\nqbo-unwind-send suite — PASS: {total - bad}   FAIL: {bad}")
    return 1 if (bad or failed) else 0


if __name__ == "__main__":
    raise SystemExit(main())
