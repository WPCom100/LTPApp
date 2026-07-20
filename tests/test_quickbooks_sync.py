"""Tests for the QuickBooks Online integration.

Covers the security/correctness-critical pieces that don't need a live QB
company: Fault parsing, query escaping, the OAuth token-refresh lifecycle
(Basic auth + rotated-refresh persistence + invalid_grant drop), the _request
401-refresh-retry, the read-only column guard, the invoice → QB payload
mapping (lines, per-line tax codes, discount conversion, the RECALLED memo),
and the income-account mapping (override → type default → global default
resolution, item creation against the mapped account, and the lazy re-point
of an existing QB item when the mapping changes).

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
from backend.routes import qbo as qbo_routes  # noqa: E402


# Real function objects, captured BEFORE any test monkeypatches the module
# attributes (several tests overwrite e.g. qbo_sync._resolve_line_item_id
# globally; the income-account tests below need the real implementations).
_real_resolve_line_item_id = qbo_sync._resolve_line_item_id
_real_find_or_create_named_item = qbo_sync._find_or_create_named_item
_real_generic_equipment_item_id = qbo_sync._generic_equipment_item_id
_real_repoint_item_income_account = qbo_sync._repoint_item_income_account


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


async def _mem_session_with_conn(*, refresh_plain, access_fresh):
    """Fresh in-memory DB with a single seeded QboConnection (id=1). Returns
    (Session, engine) — caller disposes the engine."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import StaticPool
    from backend.database import Base
    eng = create_async_engine("sqlite+aiosqlite:///:memory:", poolclass=StaticPool,
                              connect_args={"check_same_thread": False})
    async with eng.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    async with Session() as db:
        db.add(models.QboConnection(
            id=1, realm_id="9999999999", environment="sandbox",
            access_token_enc=crypto.encrypt_token("access-new"),
            refresh_token_enc=crypto.encrypt_token(refresh_plain),
            access_token_expires_at=datetime.now(timezone.utc) + (
                timedelta(hours=1) if access_fresh else timedelta(minutes=-5))))
        await db.commit()
    return Session, eng


async def test_refresh_adopts_freshly_rotated_token():
    print("test_refresh_adopts_freshly_rotated_token")
    # Another caller already refreshed: the row holds a fresh access token.
    Session, eng = await _mem_session_with_conn(refresh_plain="RT1", access_fresh=True)
    try:
        async with Session() as db:
            adopted = await quickbooks._adopt_if_fresh(db, force=False)
            _check("adopts the freshly-persisted token", adopted is not None)
            _check("force=True skips adoption",
                   await quickbooks._adopt_if_fresh(db, force=True) is None)
    finally:
        await eng.dispose()


async def test_recover_after_rotation_detects_race():
    print("test_recover_after_rotation_detects_race")
    # The row's refresh token was rotated to RT1 (+ fresh access) by another
    # caller; we spent RT0 and got a 400 -> recover instead of dropping.
    Session, eng = await _mem_session_with_conn(refresh_plain="RT1", access_fresh=True)
    try:
        async with Session() as db:
            rec = await quickbooks._recover_after_rotation(db, "RT0")
            _check("recovers on a concurrent rotation", rec is not None and rec[0] == "access-new")
            # Same token we spent -> genuine invalid_grant, no recovery.
            same = await quickbooks._recover_after_rotation(db, "RT1")
            _check("no recovery when token unchanged", same is None)
    finally:
        await eng.dispose()


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


# ── Quote sales tax via temporary estimate ───────────────────────────────────

def _fake_quote(**over):
    base = dict(
        id=5, client_type="company", company_id=1, client_contact_id=None,
        status="sent", sent_date="2026-06-21", global_discount={"type": "none"},
        sections=[{"id": "s1", "items": [
            {"type": "equipment", "name": "Solaframe 3000", "qty": 4, "unitPrice": 100, "adjustedPrice": None, "taxable": True},
            {"type": "service", "name": "L1 — Lead Tech", "qty": 1, "unitPrice": 500, "adjustedPrice": 450, "taxable": True},
        ]}],
        qb_tax_total=None, qb_tax_signature=None, activity=[],
    )
    base.update(over)
    return types.SimpleNamespace(**base)


def _taxable_company():
    return types.SimpleNamespace(name="Acme", taxable=True, address="1 Main", city="Dallas",
                                 state="TX", zip="75001", qb_customer_id="CUST-1")


def _mock_estimate_calls(*, tax=8.25, delete_side_effect=None):
    qbo_sync.find_or_create_customer = AsyncMock(return_value="CUST-1")
    qbo_sync._settings_get = AsyncMock(return_value=None)
    qbo_sync._resolve_line_item_id = AsyncMock(side_effect=lambda c, d, item, **k: "ITEM-" + item["type"])
    qbo_sync.quickbooks.load_connection = AsyncMock(return_value=object())
    qbo_sync.quickbooks.create_estimate = AsyncMock(
        return_value={"Estimate": {"Id": "E1", "SyncToken": "0", "TxnTaxDetail": {"TotalTax": tax}}})
    qbo_sync.quickbooks.delete_estimate = AsyncMock(
        side_effect=delete_side_effect) if delete_side_effect else AsyncMock(return_value={})
    qbo_sync._stamp = MagicMock()  # avoid SQLAlchemy flag_modified on a fake row


async def test_estimate_tax_creates_reads_deletes():
    print("test_estimate_tax_creates_reads_deletes")
    qbo_sync._billing_party = AsyncMock(return_value=(_taxable_company(), "company"))
    _mock_estimate_calls(tax=8.25)
    q = _fake_quote()
    db = MagicMock(); db.flush = AsyncMock()
    result = await qbo_sync.get_quote_estimate_tax(db, q, user=None, client_id="c", client_secret="s")
    _check("tax read from TxnTaxDetail.TotalTax", result["qbTaxTotal"] == 8.25)
    _check("tax stored on the quote row", q.qb_tax_total == 8.25)
    _check("estimate created once", qbo_sync.quickbooks.create_estimate.await_count == 1)
    _check("estimate DELETED (not left behind)", qbo_sync.quickbooks.delete_estimate.await_count == 1)
    _check("estimateDeleted reported true", result["estimateDeleted"] is True)
    payload = qbo_sync.quickbooks.create_estimate.await_args.args[2]
    sales = [l for l in payload["Line"] if l["DetailType"] == "SalesItemLineDetail"]
    _check("estimate payload has the sales lines", len(sales) == 2)
    _check("taxable line → TAX code", sales[0]["SalesItemLineDetail"]["TaxCodeRef"]["value"] == "TAX")
    _check("no DocNumber (QB auto-numbers the estimate)", "DocNumber" not in payload)


async def test_estimate_tax_exempt_skips_qb():
    print("test_estimate_tax_exempt_skips_qb")
    exempt = types.SimpleNamespace(name="NonProfit", taxable=False, address="", city="",
                                   state="", zip="", qb_customer_id=None)
    qbo_sync._billing_party = AsyncMock(return_value=(exempt, "company"))
    qbo_sync.quickbooks.create_estimate = AsyncMock()
    qbo_sync._stamp = MagicMock()
    q = _fake_quote()
    db = MagicMock(); db.flush = AsyncMock()
    result = await qbo_sync.get_quote_estimate_tax(db, q, user=None, client_id="c", client_secret="s")
    _check("exempt client → $0 tax", result["qbTaxTotal"] == 0.0)
    _check("exempt client → taxable False", result["taxable"] is False)
    _check("exempt client → NO QB estimate created", qbo_sync.quickbooks.create_estimate.await_count == 0)
    _check("exempt client → tax stored 0 on quote", q.qb_tax_total == 0.0)


async def test_estimate_tax_stale_token_delete_retry():
    print("test_estimate_tax_stale_token_delete_retry")
    qbo_sync._billing_party = AsyncMock(return_value=(_taxable_company(), "company"))
    stale = QboApiError(400, '{"Fault":{"Error":[{"code":"5010"}]}}', fault_code="5010")
    _mock_estimate_calls(tax=5.0, delete_side_effect=[stale, {}])
    qbo_sync.quickbooks.get_estimate = AsyncMock(return_value={"SyncToken": "9"})
    q = _fake_quote()
    db = MagicMock(); db.flush = AsyncMock()
    result = await qbo_sync.get_quote_estimate_tax(db, q, user=None, client_id="c", client_secret="s")
    _check("tax still read despite stale-token delete", result["qbTaxTotal"] == 5.0)
    _check("delete retried after token refetch", qbo_sync.quickbooks.delete_estimate.await_count == 2)
    _check("get_estimate used to refetch token", qbo_sync.quickbooks.get_estimate.await_count == 1)
    _check("estimate ultimately deleted", result["estimateDeleted"] is True)


# ── Income account mapping ──────────────────────────────────────────────────

async def test_income_account_resolution():
    print("test_income_account_resolution")
    settings = {"qboServiceIncomeAccountId": "55", "qboIncomeAccountId": "11"}
    qbo_sync._settings_get = AsyncMock(side_effect=lambda db, key: settings.get(key))
    override_row = types.SimpleNamespace(qb_income_account_id="99")
    plain_row = types.SimpleNamespace(qb_income_account_id=None)
    _check("per-row override wins",
           await qbo_sync._desired_income_account_id(None, "service", override_row) == "99")
    _check("type-level mapping when no override",
           await qbo_sync._desired_income_account_id(None, "service", plain_row) == "55")
    _check("global default when type unmapped",
           await qbo_sync._desired_income_account_id(None, "product", plain_row) == "11")
    settings["qboEquipmentIncomeAccountId"] = "77"
    _check("equipment (rentals) mapping honored",
           await qbo_sync._desired_income_account_id(None, "equipment", None) == "77")
    settings.clear()
    _check("None when nothing configured",
           await qbo_sync._desired_income_account_id(None, "product", None) is None)


async def test_item_created_with_mapped_account():
    print("test_item_created_with_mapped_account")
    db = MagicMock(); db.flush = AsyncMock()
    qbo_sync.quickbooks.query = AsyncMock(return_value=[])  # no existing item
    qbo_sync.quickbooks.create_item = AsyncMock(return_value={"Item": {"Id": "I1"}})
    qbo_sync._resolve_income_account_id = AsyncMock(return_value="LEGACY")

    out = await _real_find_or_create_named_item(
        object(), db, "L1 — Lead Tech", 500,
        income_account_id="42", client_id="c", client_secret="s")
    _check("returns created item id", out == "I1")
    payload = qbo_sync.quickbooks.create_item.await_args.args[2]
    _check("new item backed by the mapped account",
           payload["IncomeAccountRef"]["value"] == "42")
    _check("legacy default resolution NOT consulted",
           qbo_sync._resolve_income_account_id.await_count == 0)

    # No mapping resolved → legacy default resolution backs the item.
    qbo_sync.quickbooks.create_item.reset_mock()
    await _real_find_or_create_named_item(
        object(), db, "Gaff Tape", 20, client_id="c", client_secret="s")
    payload = qbo_sync.quickbooks.create_item.await_args.args[2]
    _check("falls back to legacy default account",
           payload["IncomeAccountRef"]["value"] == "LEGACY")


async def test_repoint_item_income_account():
    print("test_repoint_item_income_account")
    db = MagicMock(); db.flush = AsyncMock()
    # Already on the desired account → confirmed, nothing written.
    qbo_sync.quickbooks.get_item = AsyncMock(return_value={
        "Id": "I1", "SyncToken": "3", "IncomeAccountRef": {"value": "42"}})
    qbo_sync.quickbooks.update_item = AsyncMock()
    ok, changed = await _real_repoint_item_income_account(
        object(), db, "I1", "42", client_id="c", client_secret="s")
    _check("already-correct item confirmed", ok is True and changed is False)
    _check("no update when already correct", qbo_sync.quickbooks.update_item.await_count == 0)

    # Different account → sparse update rewrites IncomeAccountRef.
    qbo_sync.quickbooks.get_item = AsyncMock(return_value={
        "Id": "I1", "SyncToken": "3", "IncomeAccountRef": {"value": "11"}})
    ok, changed = await _real_repoint_item_income_account(
        object(), db, "I1", "42", client_id="c", client_secret="s")
    _check("mismatched item re-pointed", ok is True and changed is True)
    payload = qbo_sync.quickbooks.update_item.await_args.args[2]
    _check("re-point is a sparse update", payload.get("sparse") is True)
    _check("re-point carries Id + SyncToken",
           payload.get("Id") == "I1" and payload.get("SyncToken") == "3")
    _check("re-point sets the new account", payload["IncomeAccountRef"]["value"] == "42")

    # QB hiccup → best-effort (False, False), never raises.
    qbo_sync.quickbooks.get_item = AsyncMock(
        side_effect=QboApiError(500, "boom"))
    ok, changed = await _real_repoint_item_income_account(
        object(), db, "I1", "42", client_id="c", client_secret="s")
    _check("QB error swallowed (best-effort)", ok is False and changed is False)


def _db_returning_row(row):
    db = MagicMock()
    result = MagicMock(); result.scalar_one_or_none = MagicMock(return_value=row)
    db.execute = AsyncMock(return_value=result)
    db.flush = AsyncMock()
    return db


async def test_resolve_line_repoints_on_mapping_change():
    print("test_resolve_line_repoints_on_mapping_change")
    settings = {"qboServiceIncomeAccountId": "42"}
    qbo_sync._settings_get = AsyncMock(side_effect=lambda db, key: settings.get(key))
    row = types.SimpleNamespace(id=3, role="L1", description="Lead Tech",
                                qb_item_id="I9", qb_income_account_id=None,
                                qb_income_account_synced="11")
    db = _db_returning_row(row)
    conn = types.SimpleNamespace(income_accounts=[{"id": "42", "name": "Labor Income"}])
    qbo_sync.quickbooks.get_item = AsyncMock(return_value={
        "Id": "I9", "SyncToken": "0", "IncomeAccountRef": {"value": "11"}})
    qbo_sync.quickbooks.update_item = AsyncMock()

    repoints = []
    line = {"type": "service", "serviceId": 3, "name": "L1 — Lead Tech", "unitPrice": 500}
    item_id = await _real_resolve_line_item_id(
        conn, db, line, client_id="c", client_secret="s", repoints=repoints)
    _check("cached qb_item_id reused", item_id == "I9")
    _check("QB item re-pointed once", qbo_sync.quickbooks.update_item.await_count == 1)
    _check("synced cache updated on the row", row.qb_income_account_synced == "42")
    _check("re-point recorded for the activity stamp",
           len(repoints) == 1 and repoints[0]["account"] == "Labor Income")

    # Steady state: synced cache now matches → no QB round-trip at all.
    qbo_sync.quickbooks.get_item.reset_mock(); qbo_sync.quickbooks.update_item.reset_mock()
    repoints = []
    await _real_resolve_line_item_id(
        conn, _db_returning_row(row), line, client_id="c", client_secret="s", repoints=repoints)
    _check("steady state → no item read", qbo_sync.quickbooks.get_item.await_count == 0)
    _check("steady state → no re-point", len(repoints) == 0)

    # No mapping configured → item left alone entirely.
    settings.clear()
    bare = types.SimpleNamespace(id=3, role="L1", description="Lead Tech",
                                 qb_item_id="I9", qb_income_account_id=None,
                                 qb_income_account_synced=None)
    await _real_resolve_line_item_id(
        conn, _db_returning_row(bare), line, client_id="c", client_secret="s", repoints=repoints)
    _check("unconfigured mapping → never touches the item",
           qbo_sync.quickbooks.get_item.await_count == 0 and len(repoints) == 0)


async def test_equipment_item_uses_rentals_mapping():
    print("test_equipment_item_uses_rentals_mapping")
    settings = {"qboEquipmentIncomeAccountId": "77"}
    qbo_sync._settings_get = AsyncMock(side_effect=lambda db, key: settings.get(key))
    stored = {}
    qbo_sync._settings_set = AsyncMock(side_effect=lambda db, key, value: stored.__setitem__(key, value))
    qbo_sync._find_or_create_named_item = AsyncMock(return_value="EQ1")
    qbo_sync._repoint_item_income_account = AsyncMock(return_value=(True, True))
    conn = types.SimpleNamespace(income_accounts=[{"id": "77", "name": "Rental Income"}])
    db = MagicMock(); db.flush = AsyncMock()

    repoints = []
    item_id = await _real_generic_equipment_item_id(
        conn, db, client_id="c", client_secret="s", repoints=repoints)
    _check("equipment item id returned", item_id == "EQ1")
    _check("created against the rentals account",
           qbo_sync._find_or_create_named_item.await_args.kwargs.get("income_account_id") == "77")
    _check("item id cached in settings", stored.get("qboEquipmentItemId") == "EQ1")
    _check("synced account cached in settings", stored.get("qboEquipmentItemAccountSynced") == "77")
    _check("re-point recorded with the account name",
           len(repoints) == 1 and repoints[0] == {"name": "Equipment Rental", "account": "Rental Income"})

    # Steady state: cached id + synced account match → no create, no re-point.
    settings.update(stored)
    qbo_sync._find_or_create_named_item.reset_mock()
    qbo_sync._repoint_item_income_account.reset_mock()
    repoints = []
    item_id = await _real_generic_equipment_item_id(
        conn, db, client_id="c", client_secret="s", repoints=repoints)
    _check("steady state → cached id reused", item_id == "EQ1")
    _check("steady state → no create / no re-point",
           qbo_sync._find_or_create_named_item.await_count == 0
           and qbo_sync._repoint_item_income_account.await_count == 0)


def test_income_account_readonly_columns():
    print("test_income_account_readonly_columns")
    for model_cls in (models.Service, models.Product):
        mapped = _dict_to_row({"qbIncomeAccountId": "42", "qbIncomeAccountSynced": "11"}, model_cls)
        _check(f"{model_cls.__name__}: override is user-editable",
               mapped.get("qb_income_account_id") == "42")
        _check(f"{model_cls.__name__}: synced cache stripped",
               "qb_income_account_synced" not in mapped)


async def test_accounts_refresh_route():
    print("test_accounts_refresh_route")
    conn = types.SimpleNamespace(income_accounts=None, income_accounts_updated_at=None)
    qbo_routes.quickbooks.load_connection = AsyncMock(return_value=conn)
    qbo_routes.quickbooks.list_income_accounts = AsyncMock(return_value=[
        {"Id": 79, "Name": "Rental Income"},
        {"Id": "80", "Name": "Labor Income"},
        {"Name": "no id — skipped"},
    ])
    db = MagicMock(); db.flush = AsyncMock()
    out = await qbo_routes.refresh_income_accounts(db=db, _admin=None)
    _check("normalized {id, name} list returned",
           out["incomeAccounts"] == [{"id": "79", "name": "Rental Income"},
                                     {"id": "80", "name": "Labor Income"}])
    _check("list cached on the connection row", conn.income_accounts == out["incomeAccounts"])
    _check("refresh timestamp stamped", conn.income_accounts_updated_at is not None)

    # Not connected → structured 409, not an exception.
    qbo_routes.quickbooks.load_connection = AsyncMock(
        side_effect=quickbooks.QboNotConnected("nope"))
    resp = await qbo_routes.refresh_income_accounts(db=db, _admin=None)
    _check("not connected → 409 response", getattr(resp, "status_code", None) == 409)


# ── Runner ──────────────────────────────────────────────────────────────────

def main():
    sync_tests = [test_fault_parsing, test_query_escaping, test_readonly_columns_stripped,
                  test_customer_billaddr_and_fields, test_income_account_readonly_columns]
    async_tests = [
        test_refresh_cached_when_fresh, test_refresh_basic_auth_and_rotation,
        test_refresh_invalid_grant_drops_connection, test_request_retries_on_401,
        test_api_error_on_fault, test_payload_lines_and_tax, test_payload_recall_note,
        test_payload_discounts, test_payload_project_memo, test_payload_requires_billable_line,
        test_delete_not_synced, test_delete_synced_calls_qb,
        test_estimate_tax_creates_reads_deletes, test_estimate_tax_exempt_skips_qb,
        test_estimate_tax_stale_token_delete_retry,
        test_income_account_resolution, test_item_created_with_mapped_account,
        test_repoint_item_income_account, test_resolve_line_repoints_on_mapping_change,
        test_equipment_item_uses_rentals_mapping, test_accounts_refresh_route,
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
