"""Tests for the QuickBooks Online integration.

Covers the security/correctness-critical pieces that don't need a live QB
company: Fault parsing, query escaping, the OAuth token-refresh lifecycle
(Basic auth + rotated-refresh persistence + invalid_grant drop), the _request
401-refresh-retry, the read-only column guard, and the invoice → QB payload
mapping (lines, per-line tax codes, discount conversion, the RECALLED memo).

Runs both as pytest and as a plain script:
    python tests/test_quickbooks_sync.py
Self-contained — sets env before importing backend.
"""
import asyncio
import os
import sys
import types
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "http://localhost:8000/auth/callback")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

from backend import crypto, models, qbo_sync, quickbooks  # noqa: E402
from backend.quickbooks import (  # noqa: E402
    QboApiError,
    QboReconnectRequired,
    escape_query_value,
)
from backend.routes.api import _dict_to_row  # noqa: E402


_results: list[tuple[str, bool]] = []


def _check(label: str, cond: bool, detail: str = "") -> None:
    _results.append((label, bool(cond)))
    status = "PASS" if cond else "FAIL"
    suffix = f"  ({detail})" if detail else ""
    print(f"  [{status}] {label}{suffix}")


def _make_conn(*, fresh=True):
    conn = models.QboConnection(id=1)
    conn.realm_id = "9999999999"
    conn.environment = "sandbox"
    conn.access_token_enc = crypto.encrypt_token("access-tok")
    conn.refresh_token_enc = crypto.encrypt_token("refresh-tok")
    conn.access_token_expires_at = datetime.now(timezone.utc) + (
        timedelta(hours=1) if fresh else timedelta(minutes=-5)
    )
    return conn


# ── Fault parsing + escaping ────────────────────────────────────────────────

def test_fault_parsing():
    print("test_fault_parsing")
    body = ('{"Fault":{"Error":[{"Message":"Duplicate Document Number",'
            '"Detail":"Doc number already exists","code":"6140"}],"type":"ValidationFault"}}')
    _check("summarizes message + detail",
           quickbooks._summarize_fault(400, body) == "Duplicate Document Number: Doc number already exists")
    _check("extracts fault code", quickbooks.fault_code(body) == "6140")
    _check("non-json body falls back", quickbooks._summarize_fault(500, "boom")[:4] == "boom")
    _check("fault_code None on junk", quickbooks.fault_code("not json") is None)


def test_query_escaping():
    print("test_query_escaping")
    _check("single quote escaped", escape_query_value("O'Brien Lighting") == "O\\'Brien Lighting")
    _check("backslash escaped", escape_query_value("a\\b").count("\\") == 2)
    _check("plain string unchanged", escape_query_value("Acme Corp") == "Acme Corp")


def test_readonly_columns_stripped():
    print("test_readonly_columns_stripped")
    data = {"status": "draft", "qbInvoiceId": "123", "qbSyncToken": "5",
            "qbTaxTotal": 9.0, "qbCustomerId": "7", "taxable": True}
    mapped = _dict_to_row(data, models.Invoice)
    _check("status passes through", mapped.get("status") == "draft")
    _check("qb_invoice_id stripped", "qb_invoice_id" not in mapped)
    _check("qb_sync_token stripped", "qb_sync_token" not in mapped)
    _check("qb_tax_total stripped", "qb_tax_total" not in mapped)
    # taxable is user-editable on companies/contacts — confirm it survives there.
    cmapped = _dict_to_row({"taxable": True, "qbCustomerId": "9"}, models.Company)
    _check("taxable kept (user-editable)", cmapped.get("taxable") is True)
    _check("qb_customer_id stripped", "qb_customer_id" not in cmapped)


# ── Token refresh lifecycle ─────────────────────────────────────────────────

async def test_refresh_cached_when_fresh():
    print("test_refresh_cached_when_fresh")
    conn = _make_conn(fresh=True)
    db = MagicMock(); db.flush = AsyncMock()
    client = MagicMock(); client.post = AsyncMock()
    out = await quickbooks.refresh_if_needed(conn, db, client_id="cid", client_secret="csec", httpx_client=client)
    _check("returns cached access token", out == "access-tok")
    _check("did not hit Intuit", client.post.await_count == 0)


async def test_refresh_basic_auth_and_rotation():
    print("test_refresh_basic_auth_and_rotation")
    conn = _make_conn(fresh=False)
    resp = MagicMock(); resp.status_code = 200
    resp.json = MagicMock(return_value={
        "access_token": "new-access", "refresh_token": "ROTATED",
        "expires_in": 3600, "x_refresh_token_expires_in": 8726400,
    })
    client = MagicMock(); client.post = AsyncMock(return_value=resp)
    db = MagicMock(); db.flush = AsyncMock()

    out = await quickbooks.refresh_if_needed(conn, db, client_id="cid", client_secret="csec", httpx_client=client)
    _check("returns new access token", out == "new-access")
    _check("hit Intuit once", client.post.await_count == 1)
    # Intuit authenticates the client via HTTP Basic auth, not body params.
    _, kwargs = client.post.call_args
    _check("used HTTP Basic auth", kwargs.get("auth") == ("cid", "csec"))
    _check("client creds NOT in body",
           "client_id" not in (kwargs.get("data") or {}))
    _check("persisted rotated refresh token",
           crypto.decrypt_token(conn.refresh_token_enc) == "ROTATED")
    _check("stored new access token",
           crypto.decrypt_token(conn.access_token_enc) == "new-access")


async def test_refresh_invalid_grant_drops_connection():
    print("test_refresh_invalid_grant_drops_connection")
    conn = _make_conn(fresh=False)
    resp = MagicMock(); resp.status_code = 400; resp.text = '{"error":"invalid_grant"}'
    client = MagicMock(); client.post = AsyncMock(return_value=resp)
    db = MagicMock(); db.flush = AsyncMock(); db.delete = AsyncMock()

    raised = False
    try:
        await quickbooks.refresh_if_needed(conn, db, client_id="c", client_secret="s", httpx_client=client)
    except QboReconnectRequired:
        raised = True
    _check("raises QboReconnectRequired", raised)
    _check("dropped the connection row", db.delete.await_count == 1)


async def test_request_retries_on_401():
    print("test_request_retries_on_401")
    conn = _make_conn(fresh=True)
    db = MagicMock(); db.flush = AsyncMock()

    resp401 = MagicMock(); resp401.status_code = 401; resp401.headers = {}
    resp200 = MagicMock(); resp200.status_code = 200
    resp200.json = MagicMock(return_value={"QueryResponse": {"Item": [{"Id": "1"}]}})
    token_resp = MagicMock(); token_resp.status_code = 200
    token_resp.json = MagicMock(return_value={"access_token": "forced", "expires_in": 3600})

    client = MagicMock()
    client.request = AsyncMock(side_effect=[resp401, resp200])
    client.post = AsyncMock(return_value=token_resp)  # the forced refresh

    out = await quickbooks._request(conn, db, "GET", "query", client_id="c", client_secret="s",
                                    httpx_client=client)
    _check("retried after 401 (2 requests)", client.request.await_count == 2)
    _check("forced a token refresh", client.post.await_count == 1)
    _check("returned final JSON", out["QueryResponse"]["Item"][0]["Id"] == "1")


async def test_api_error_on_fault():
    print("test_api_error_on_fault")
    conn = _make_conn(fresh=True)
    db = MagicMock(); db.flush = AsyncMock()
    resp = MagicMock(); resp.status_code = 400
    resp.text = '{"Fault":{"Error":[{"Message":"Bad","code":"2500"}]}}'
    resp.json = MagicMock(return_value={})
    client = MagicMock(); client.request = AsyncMock(return_value=resp)
    raised = None
    try:
        await quickbooks._request(conn, db, "POST", "invoice", client_id="c", client_secret="s",
                                  json={}, httpx_client=client)
    except QboApiError as e:
        raised = e
    _check("raised QboApiError", raised is not None)
    _check("captured fault code", raised is not None and raised.fault_code == "2500")
    _check("safe_message set", raised is not None and "Bad" in raised.safe_message)


# ── Customer address + fields ────────────────────────────────────────────────

def test_customer_billaddr_and_fields():
    print("test_customer_billaddr_and_fields")
    company = types.SimpleNamespace(name="Acme Corp", address="123 Main St\nSuite 4",
                                    city="Dallas", state="TX", zip="75001", taxable=True)
    addr = qbo_sync._bill_addr(company)
    _check("Line1 from first address line", addr["Line1"] == "123 Main St")
    _check("Line2 from remaining lines", addr["Line2"] == "Suite 4")
    _check("City mapped", addr["City"] == "Dallas")
    _check("state → CountrySubDivisionCode", addr["CountrySubDivisionCode"] == "TX")
    _check("zip → PostalCode", addr["PostalCode"] == "75001")

    name, fields = qbo_sync._customer_fields(company, "company")
    _check("display name from company name", name == "Acme Corp")
    _check("Taxable carried into fields", fields["Taxable"] is True)
    _check("BillAddr included", "BillAddr" in fields)
    # DisplayName must NOT be in fields — it's added only on create so a sparse
    # update can never trip a duplicate-name conflict by renaming.
    _check("DisplayName excluded from sync fields", "DisplayName" not in fields)

    bare = types.SimpleNamespace(name="X", address="", city="", state="", zip="", taxable=False)
    _check("no address → None BillAddr", qbo_sync._bill_addr(bare) is None)
    _, f2 = qbo_sync._customer_fields(bare, "company")
    _check("no BillAddr when address empty", "BillAddr" not in f2)

    # Directly-billed contacts are ALWAYS taxable (companies carry the flag).
    contact = types.SimpleNamespace(first_name="Jo", last_name="Lee", email="j@x.com",
                                    phone="", id=5, address="", city="", state="", zip="")
    _, cf = qbo_sync._customer_fields(contact, "contact")
    _check("directly-billed contact → Taxable True", cf["Taxable"] is True)
    _check("company taxable=False → Taxable False", qbo_sync._party_taxable(bare, "company") is False)
    _check("contact → _party_taxable True", qbo_sync._party_taxable(contact, "contact") is True)


# ── Payload mapping ─────────────────────────────────────────────────────────

def _fake_invoice(**over):
    base = dict(
        id=7, invoice_date="2026-06-21", due_date="2026-07-21", notes="Thank you",
        status="sent", sent_date="2026-06-21",
        global_discount={"type": "none"},
        sections=[{"id": "s1", "items": [
            {"type": "equipment", "name": "Solaframe 3000", "qty": 4, "unitPrice": 100, "adjustedPrice": None},
            {"type": "service", "name": "L1 — Lead Tech", "qty": 1, "unitPrice": 500,
             "adjustedPrice": 450, "serviceId": 3, "taxable": False},
            {"type": "note", "name": "Delivered on site"},
        ]}],
    )
    base.update(over)
    return types.SimpleNamespace(**base)


async def _build(invoice, customer_taxable=True, project_name=""):
    # Patch the two collaborators that would hit QB / settings.
    qbo_sync._settings_get = AsyncMock(return_value=None)
    qbo_sync._resolve_line_item_id = AsyncMock(side_effect=lambda c, d, item, **k: "ITEM-" + item["type"])
    return await qbo_sync.build_invoice_payload(
        None, MagicMock(), invoice, "CUST-1", customer_taxable,
        project_name=project_name, client_id="c", client_secret="s"
    )


async def test_payload_lines_and_tax():
    print("test_payload_lines_and_tax")
    payload = await _build(_fake_invoice())
    lines = payload["Line"]
    sales = [l for l in lines if l["DetailType"] == "SalesItemLineDetail"]
    notes = [l for l in lines if l["DetailType"] == "DescriptionOnly"]
    _check("two sales lines", len(sales) == 2)
    _check("one description-only (note) line", len(notes) == 1)
    _check("equipment amount = price*qty", sales[0]["Amount"] == 400)
    _check("service uses adjustedPrice", sales[1]["Amount"] == 450)
    _check("customer-taxable equipment line → TAX",
           sales[0]["SalesItemLineDetail"]["TaxCodeRef"]["value"] == "TAX")
    _check("per-line override exempt → NON",
           sales[1]["SalesItemLineDetail"]["TaxCodeRef"]["value"] == "NON")
    _check("DocNumber is INV-YYYY-NNN", payload["DocNumber"] == "INV-2026-007")
    _check("customer ref set", payload["CustomerRef"]["value"] == "CUST-1")
    _check("not recalled (status sent) → empty PrivateNote", payload["PrivateNote"] == "")


async def test_payload_recall_note():
    print("test_payload_recall_note")
    payload = await _build(_fake_invoice(status="draft", sent_date="2026-06-21"))
    _check("recalled draft gets RECALLED memo", payload["PrivateNote"] == qbo_sync._RECALL_NOTE)
    # Recall banner is the FIRST line on the invoice (not just the memo).
    line0 = payload["Line"][0]
    _check("recall banner is the first line",
           line0["DetailType"] == "DescriptionOnly" and "RECALLED" in line0["Description"])
    fresh = await _build(_fake_invoice(status="draft", sent_date=""))
    _check("never-sent draft has no memo", fresh["PrivateNote"] == "")
    _check("no recall banner when not recalled",
           not any(l.get("DetailType") == "DescriptionOnly" and "RECALLED" in (l.get("Description") or "")
                   for l in fresh["Line"]))


async def test_payload_discounts():
    print("test_payload_discounts")
    pct = await _build(_fake_invoice(global_discount={"type": "percent", "value": 10}))
    disc = [l for l in pct["Line"] if l["DetailType"] == "DiscountLineDetail"]
    _check("percent discount line present", len(disc) == 1 and disc[0]["DiscountLineDetail"]["PercentBased"] is True)
    _check("percent value carried", disc[0]["DiscountLineDetail"]["DiscountPercent"] == 10)

    # subtotal = 400 + 450 = 850; target 600 → flat discount of 250.
    tgt = await _build(_fake_invoice(global_discount={"type": "target", "value": 600}))
    tdisc = [l for l in tgt["Line"] if l["DetailType"] == "DiscountLineDetail"]
    _check("target converted to flat discount", len(tdisc) == 1 and tdisc[0]["Amount"] == 250)
    _check("flat discount not percent-based", tdisc[0]["DiscountLineDetail"]["PercentBased"] is False)


async def test_payload_project_memo():
    print("test_payload_project_memo")
    payload = await _build(_fake_invoice(), project_name="Spring Gala")
    memo = (payload.get("CustomerMemo") or {}).get("value", "")
    _check("CustomerMemo includes project name", "Spring Gala" in memo)
    _check("CustomerMemo includes notes", "Thank you" in memo)


async def test_payload_requires_billable_line():
    print("test_payload_requires_billable_line")
    only_notes = _fake_invoice(sections=[{"id": "s1", "items": [{"type": "note", "name": "hi"}]}])
    raised = False
    try:
        await _build(only_notes)
    except qbo_sync.InvoiceNotSyncable:
        raised = True
    _check("note-only invoice rejected", raised)


# ── Delete ──────────────────────────────────────────────────────────────────

async def test_delete_not_synced():
    print("test_delete_not_synced")
    inv = types.SimpleNamespace(qb_invoice_id=None, qb_sync_token=None)
    result = await qbo_sync.delete_from_quickbooks(MagicMock(), inv, client_id="c", client_secret="s")
    _check("unsynced invoice → deleted False (no QB call)", result["deleted"] is False)


async def test_delete_synced_calls_qb():
    print("test_delete_synced_calls_qb")
    inv = types.SimpleNamespace(qb_invoice_id="42", qb_sync_token="3")
    qbo_sync.quickbooks.load_connection = AsyncMock(return_value=object())
    qbo_sync.quickbooks.delete_invoice = AsyncMock(return_value={})
    result = await qbo_sync.delete_from_quickbooks(MagicMock(), inv, client_id="c", client_secret="s")
    _check("synced invoice → deleted True", result["deleted"] is True)
    _check("QB delete called once", qbo_sync.quickbooks.delete_invoice.await_count == 1)


# ── Runner ──────────────────────────────────────────────────────────────────

def main():
    sync_tests = [test_fault_parsing, test_query_escaping, test_readonly_columns_stripped,
                  test_customer_billaddr_and_fields]
    async_tests = [
        test_refresh_cached_when_fresh, test_refresh_basic_auth_and_rotation,
        test_refresh_invalid_grant_drops_connection, test_request_retries_on_401,
        test_api_error_on_fault, test_payload_lines_and_tax, test_payload_recall_note,
        test_payload_discounts, test_payload_project_memo, test_payload_requires_billable_line,
        test_delete_not_synced, test_delete_synced_calls_qb,
    ]
    for t in sync_tests:
        t()
    for t in async_tests:
        asyncio.run(t())
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
