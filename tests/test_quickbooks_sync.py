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
from unittest.mock import AsyncMock, MagicMock, patch

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
# The estimate-tax tests replace this with an AsyncMock module-wide, so the
# inactive-reference tests below have to reach for the real one.
_real_find_or_create_customer = qbo_sync.find_or_create_customer


_results: list[tuple[str, bool]] = []


def _check(label: str, cond: bool, detail: str = "") -> None:
    _results.append((label, bool(cond)))
    status = "PASS" if cond else "FAIL"
    suffix = f"  ({detail})" if detail else ""
    print(f"  [{status}] {label}{suffix}")
    assert cond, f"{label} {detail}"


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
    # db.refresh (re-read) leaves the transient conn expired -> not adopted; db.commit
    # persists the rotation durably on the caller's own session.
    db = MagicMock(); db.flush = AsyncMock(); db.refresh = AsyncMock(); db.commit = AsyncMock()

    out = await quickbooks.refresh_if_needed(conn, db, client_id="cid", client_secret="csec", httpx_client=client)
    _check("returns new access token", out == "new-access")
    _check("committed the rotation", db.commit.await_count == 1)
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
    # db.refresh re-reads the same (unchanged) refresh token -> genuine invalid_grant -> drop.
    db = MagicMock(); db.flush = AsyncMock(); db.delete = AsyncMock(); db.refresh = AsyncMock()

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
    # Another caller already refreshed: the committed row holds a fresh access
    # token, and _adopt_if_fresh re-reads it (db.refresh) instead of the stale
    # identity-map copy.
    Session, eng = await _mem_session_with_conn(refresh_plain="RT1", access_fresh=True)
    try:
        async with Session() as db:
            conn = await quickbooks.load_connection(db)
            _check("adopts the freshly-persisted token",
                   await quickbooks._adopt_if_fresh(conn, db, force=False) is True)
            _check("force=True skips adoption",
                   await quickbooks._adopt_if_fresh(conn, db, force=True) is False)
    finally:
        await eng.dispose()


async def test_recover_after_rotation_detects_race():
    print("test_recover_after_rotation_detects_race")
    # The row's refresh token was rotated to RT1 (+ fresh access) by another
    # caller; we spent RT0 and got a 400 -> recover instead of dropping.
    Session, eng = await _mem_session_with_conn(refresh_plain="RT1", access_fresh=True)
    try:
        async with Session() as db:
            conn = await quickbooks.load_connection(db)
            rec = await quickbooks._recover_after_rotation(conn, db, "RT0")
            _check("recovers on a concurrent rotation", rec == "access-new")
            # Same token we spent -> genuine invalid_grant, no recovery.
            same = await quickbooks._recover_after_rotation(conn, db, "RT1")
            _check("no recovery when token unchanged", same is None)
    finally:
        await eng.dispose()


async def test_request_retries_on_401():
    print("test_request_retries_on_401")
    conn = _make_conn(fresh=True)
    db = MagicMock(); db.flush = AsyncMock(); db.commit = AsyncMock()  # forced refresh commits

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


async def test_transport_error_becomes_typed_error():
    """A connect failure / timeout used to escape _request as httpx's own
    exception, which the routes did not map — FastAPI answered a plain-text
    500 and the sending window reported "Unexpected token 'I' ... is not valid
    JSON". It is retried once (like a 5xx) and then raised as QboApiError."""
    print("test_transport_error_becomes_typed_error")
    import httpx
    conn = _make_conn(fresh=True)
    db = MagicMock(); db.flush = AsyncMock()
    client = MagicMock()
    client.request = AsyncMock(side_effect=httpx.ConnectTimeout("timed out"))
    raised = None
    # Skip the real 2s backoff — scoped, so the rest of the run keeps a real
    # asyncio.sleep (a process-wide stub turns every sleep loop into a hot one).
    with patch("backend.quickbooks.asyncio.sleep", new=AsyncMock()):
        try:
            await quickbooks._request(conn, db, "POST", "invoice", client_id="c", client_secret="s",
                                      json={}, httpx_client=client)
        except QboApiError as e:
            raised = e
    _check("raised QboApiError (routes map it to 502)", isinstance(raised, quickbooks.QboUnreachable))
    _check("retried once before giving up", client.request.await_count == 2)
    _check("message says QuickBooks could not be reached",
           raised is not None and "could not be reached" in raised.safe_message
           and "ConnectTimeout" in raised.safe_message, getattr(raised, "safe_message", None))


async def test_transport_error_recovers_on_retry():
    print("test_transport_error_recovers_on_retry")
    import httpx
    conn = _make_conn(fresh=True)
    db = MagicMock(); db.flush = AsyncMock()
    resp200 = MagicMock(); resp200.status_code = 200
    resp200.json = MagicMock(return_value={"Invoice": {"Id": "7"}})
    client = MagicMock()
    client.request = AsyncMock(side_effect=[httpx.ReadError("reset"), resp200])
    with patch("backend.quickbooks.asyncio.sleep", new=AsyncMock()):
        out = await quickbooks._request(conn, db, "POST", "invoice", client_id="c", client_secret="s",
                                        json={}, httpx_client=client)
    _check("second attempt's answer is returned", out["Invoice"]["Id"] == "7")


async def test_non_json_success_becomes_typed_error():
    print("test_non_json_success_becomes_typed_error")
    conn = _make_conn(fresh=True)
    db = MagicMock(); db.flush = AsyncMock()
    resp = MagicMock(); resp.status_code = 200; resp.text = "<html>gateway</html>"
    resp.json = MagicMock(side_effect=ValueError("not json"))
    client = MagicMock(); client.request = AsyncMock(return_value=resp)
    raised = None
    try:
        await quickbooks._request(conn, db, "GET", "query", client_id="c", client_secret="s",
                                  httpx_client=client)
    except QboApiError as e:
        raised = e
    _check("raised QboApiError", isinstance(raised, quickbooks.QboBadResponse))
    _check("message is human", raised is not None and "could not be read" in raised.safe_message)


async def test_refresh_transport_error_keeps_connection():
    """The token endpoint being unreachable is not a revocation: the refresh
    token was never spent, so the connection row must survive and the caller
    gets the typed error rather than httpx's."""
    print("test_refresh_transport_error_keeps_connection")
    import httpx
    conn = _make_conn(fresh=False)
    db = MagicMock(); db.flush = AsyncMock(); db.commit = AsyncMock(); db.delete = AsyncMock()
    db.refresh = AsyncMock()
    client = MagicMock(); client.post = AsyncMock(side_effect=httpx.ConnectError("no route"))
    raised = None
    try:
        await quickbooks.refresh_if_needed(conn, db, client_id="c", client_secret="s", httpx_client=client)
    except QboApiError as e:
        raised = e
    _check("raised the typed unreachable error", isinstance(raised, quickbooks.QboUnreachable))
    _check("connection row was not dropped", db.delete.await_count == 0)


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


async def test_payload_fee_line():
    print("test_payload_fee_line")
    # A custom fee (feeId None) and a catalog fee both bill as ordinary sales
    # lines. Fees edit unitPrice directly (adjustedPrice stays null), so the
    # billed amount is unitPrice * qty with no adjustment applied.
    inv = _fake_invoice(sections=[{"id": "s1", "items": [
        {"type": "fee", "feeId": None, "name": "Lodging — 2 nights", "qty": 2, "unitPrice": 180, "adjustedPrice": None, "taxable": False},
        {"type": "fee", "feeId": 5, "name": "Consultation", "qty": 3, "unitPrice": 150, "adjustedPrice": None, "taxable": True},
    ]}])
    payload = await _build(inv)
    sales = [l for l in payload["Line"] if l["DetailType"] == "SalesItemLineDetail"]
    _check("both fee lines billed", len(sales) == 2)
    _check("custom fee amount = price*qty (no adjustment)", sales[0]["Amount"] == 360)
    _check("catalog fee amount = price*qty", sales[1]["Amount"] == 450)
    _check("fee resolves an item ref", sales[0]["SalesItemLineDetail"]["ItemRef"]["value"] == "ITEM-fee")
    _check("exempt fee → NON tax code", sales[0]["SalesItemLineDetail"]["TaxCodeRef"]["value"] == "NON")
    _check("taxable fee → TAX code", sales[1]["SalesItemLineDetail"]["TaxCodeRef"]["value"] == "TAX")


def _db_returning_project(start, end):
    proj = types.SimpleNamespace(id=4, name="Auditorium Maintenance", start_date=start, end_date=end)
    result = MagicMock(); result.scalar_one_or_none = MagicMock(return_value=proj)
    db = MagicMock(); db.execute = AsyncMock(return_value=result); db.flush = AsyncMock()
    return db


async def test_rentals_never_become_qb_products():
    print("test_rentals_never_become_qb_products")
    # Rentals all post against the one shared "Equipment Rental" item, so the
    # line description is what identifies the fixture and its rental window.
    qbo_sync._resolve_line_item_id = AsyncMock(return_value="EQ-GENERIC")
    entity = types.SimpleNamespace(
        project_id=4, global_discount={"type": "none"},
        sections=[{"id": "s1", "label": "Equipment", "customDates": False,
                   "items": [{"type": "equipment", "equipmentId": 12,
                              "name": "V-Show - Aura (Wash)", "rentalLabel": "3-Day rate",
                              "qty": 4, "unitPrice": 150, "adjustedPrice": None}]}])
    lines, _sub = await qbo_sync._build_sales_lines(
        None, _db_returning_project("2026-07-09", "2026-07-11"), entity,
        True, "TAX", "NON", client_id="c", client_secret="s")
    desc = lines[0]["Description"]
    _check("rental line posts against the shared equipment item",
           lines[0]["SalesItemLineDetail"]["ItemRef"]["value"] == "EQ-GENERIC")
    _check("description names the fixture", "V-Show - Aura (Wash)" in desc)
    _check("description carries the rental period", "Jul 9 – Jul 11, 2026" in desc)
    _check("description carries the rate basis", "3-Day rate" in desc)

    # A section billing its own window overrides the project's dates.
    entity.sections[0].update({"customDates": True, "startDate": "2026-08-01",
                               "endDate": "2026-08-01"})
    lines, _sub = await qbo_sync._build_sales_lines(
        None, _db_returning_project("2026-07-09", "2026-07-11"), entity,
        True, "TAX", "NON", client_id="c", client_secret="s")
    _check("section dates win over the project window",
           "Aug 1, 2026" in lines[0]["Description"])

    # Item notes still ride along after the period.
    entity.sections[0]["items"][0]["notes"] = "Ships Wed"
    lines, _sub = await qbo_sync._build_sales_lines(
        None, _db_returning_project("", ""), entity,
        True, "TAX", "NON", client_id="c", client_secret="s")
    _check("notes preserved on rental lines", lines[0]["Description"].endswith("Ships Wed"))

    # No dates anywhere → the fixture name alone, never a stray dash.
    entity.sections[0].update({"customDates": False})
    entity.sections[0]["items"][0].pop("notes")
    entity.sections[0]["items"][0].pop("rentalLabel")
    lines, _sub = await qbo_sync._build_sales_lines(
        None, _db_returning_project("", ""), entity,
        True, "TAX", "NON", client_id="c", client_secret="s")
    _check("dateless rental → bare name", lines[0]["Description"] == "V-Show - Aura (Wash)")

    # A rental added as some other line type still routes to the shared item —
    # it must never mint a QB product from the rental catalog.
    qbo_sync._resolve_line_item_id = _real_resolve_line_item_id
    qbo_sync._generic_equipment_item_id = AsyncMock(return_value="EQ-GENERIC")
    qbo_sync.quickbooks.query = AsyncMock(return_value=[])
    qbo_sync.quickbooks.create_item = AsyncMock(return_value={"Item": {"Id": "NEW"}})
    out = await _real_resolve_line_item_id(
        None, MagicMock(), {"type": "product", "productId": 5, "equipmentId": 12,
                            "name": "V-Show - Aura (Wash)", "unitPrice": 150},
        client_id="c", client_secret="s")
    _check("equipmentId routes to the shared item whatever the line type",
           out == "EQ-GENERIC")
    _check("no QB product created for a rental",
           qbo_sync.quickbooks.create_item.await_count == 0)
    qbo_sync._generic_equipment_item_id = _real_generic_equipment_item_id


def test_period_label():
    print("test_period_label")
    _check("multi-day same year", qbo_sync._period_label("2026-07-09", "2026-07-11") == "Jul 9 – Jul 11, 2026")
    _check("single day collapses", qbo_sync._period_label("2026-07-09", "2026-07-09") == "Jul 9, 2026")
    _check("open end collapses to start", qbo_sync._period_label("2026-07-09", "") == "Jul 9, 2026")
    _check("year boundary spelled out",
           qbo_sync._period_label("2026-12-30", "2027-01-02") == "Dec 30, 2026 – Jan 2, 2027")
    _check("missing start → empty", qbo_sync._period_label("", "2026-07-11") == "")
    _check("malformed date → empty", qbo_sync._period_label("not-a-date", "2026-07-11") == "")
    _check("out-of-range month → empty", qbo_sync._period_label("2026-13-09", "2026-07-11") == "")


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

    # subtotal = 400 + 450 = 850; target 600 → fixed discount of 250.
    tgt = await _build(_fake_invoice(global_discount={"type": "target", "value": 600}))
    tdisc = [l for l in tgt["Line"] if l["DetailType"] == "DiscountLineDetail"]
    _check("target converted to fixed discount", len(tdisc) == 1 and tdisc[0]["Amount"] == 250)
    _check("fixed discount not percent-based", tdisc[0]["DiscountLineDetail"]["PercentBased"] is False)

    # "amount" is what the invoice builder's "$" option writes. This branch used
    # to match only "flat", so a $ discount pushed NO discount line — QuickBooks
    # billed the full amount while the client's PDF showed the discounted total,
    # leaving a phantom balance the receipt poller could never close.
    amt = await _build(_fake_invoice(global_discount={"type": "amount", "value": 100}))
    adisc = [l for l in amt["Line"] if l["DetailType"] == "DiscountLineDetail"]
    _check("amount discount reaches QuickBooks", len(adisc) == 1 and adisc[0]["Amount"] == 100)
    _check("amount discount not percent-based", adisc[0]["DiscountLineDetail"]["PercentBased"] is False)

    # "flat" is the legacy alias and must keep pushing the same line.
    flat = await _build(_fake_invoice(global_discount={"type": "flat", "value": 100}))
    fdisc = [l for l in flat["Line"] if l["DetailType"] == "DiscountLineDetail"]
    _check("legacy flat alias still pushes", len(fdisc) == 1 and fdisc[0]["Amount"] == 100)

    # QuickBooks rejects a discount larger than the invoice; clamp like theme.js.
    over = await _build(_fake_invoice(global_discount={"type": "amount", "value": 99999}))
    odisc = [l for l in over["Line"] if l["DetailType"] == "DiscountLineDetail"]
    _check("over-large discount clamped to subtotal", len(odisc) == 1 and odisc[0]["Amount"] == 850)

    # An unrecognized type must be a no-op, not a partial discount.
    bogus = await _build(_fake_invoice(global_discount={"type": "bogus", "value": 100}))
    _check("unknown discount type pushes nothing",
           not [l for l in bogus["Line"] if l["DetailType"] == "DiscountLineDetail"])


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
    settings["qboFeeIncomeAccountId"] = "88"
    _check("fee mapping honored",
           await qbo_sync._desired_income_account_id(None, "fee", None) == "88")
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
    ok, changed, stale = await _real_repoint_item_income_account(
        object(), db, "I1", "42", client_id="c", client_secret="s")
    _check("already-correct item confirmed", ok is True and changed is False)
    _check("no update when already correct", qbo_sync.quickbooks.update_item.await_count == 0)

    # Different account → sparse update rewrites IncomeAccountRef.
    qbo_sync.quickbooks.get_item = AsyncMock(return_value={
        "Id": "I1", "SyncToken": "3", "IncomeAccountRef": {"value": "11"}})
    ok, changed, stale = await _real_repoint_item_income_account(
        object(), db, "I1", "42", client_id="c", client_secret="s")
    _check("mismatched item re-pointed", ok is True and changed is True)
    payload = qbo_sync.quickbooks.update_item.await_args.args[2]
    _check("re-point is a sparse update", payload.get("sparse") is True)
    _check("re-point carries Id + SyncToken",
           payload.get("Id") == "I1" and payload.get("SyncToken") == "3")
    _check("re-point sets the new account", payload["IncomeAccountRef"]["value"] == "42")

    # QB hiccup → best-effort (False, False, False), never raises. NOT stale:
    # a transient error must not throw away a good cached id.
    qbo_sync.quickbooks.get_item = AsyncMock(
        side_effect=QboApiError(500, "boom"))
    ok, changed, stale = await _real_repoint_item_income_account(
        object(), db, "I1", "42", client_id="c", client_secret="s")
    _check("QB error swallowed (best-effort)",
           ok is False and changed is False and stale is False)


async def test_repoint_refuses_foreign_item():
    print("test_repoint_refuses_foreign_item")
    db = MagicMock(); db.flush = AsyncMock()

    # The cached id now names something else in this QB company (swapped realm,
    # merged item, reused id). Nothing may be written to it.
    qbo_sync.quickbooks.get_item = AsyncMock(return_value={
        "Id": "20", "Name": "Scissor Lift Rental (deleted)", "SyncToken": "3",
        "Active": False, "IncomeAccountRef": {"value": "11"}})
    qbo_sync.quickbooks.update_item = AsyncMock()
    ok, changed, stale = await _real_repoint_item_income_account(
        object(), db, "20", "42", expected_name="L1 — Lead Lighting Tech",
        client_id="c", client_secret="s")
    _check("foreign item reported stale", stale is True and ok is False)
    _check("foreign item NOT written to", qbo_sync.quickbooks.update_item.await_count == 0)
    _check("foreign item NOT revived", qbo_sync.quickbooks.update_item.await_count == 0)

    # Our own item, deleted in the QB UI (which appends "(deleted)") → still ours,
    # and the revive puts the real name back so find-or-create matches it again.
    qbo_sync.quickbooks.get_item = AsyncMock(return_value={
        "Id": "20", "Name": "Equipment Rental (deleted)", "SyncToken": "3",
        "Active": False, "IncomeAccountRef": {"value": "11"}})
    qbo_sync.quickbooks.update_item = AsyncMock()
    ok, changed, stale = await _real_repoint_item_income_account(
        object(), db, "20", "42", expected_name="Equipment Rental",
        client_id="c", client_secret="s")
    _check("our own deleted item still matches", stale is False and ok is True)
    payload = qbo_sync.quickbooks.update_item.await_args.args[2]
    _check("revive restores the name QB mangled",
           payload.get("Name") == "Equipment Rental" and payload.get("Active") is True)

    # An ACTIVE item already holds the name → the revive is abandoned, not
    # forced, and the caller re-resolves onto the active one.
    qbo_sync.quickbooks.update_item = AsyncMock(
        side_effect=QboApiError(400, "duplicate", "6240"))
    ok, changed, stale = await _real_repoint_item_income_account(
        object(), db, "20", "42", expected_name="Equipment Rental",
        client_id="c", client_secret="s")
    _check("name already taken → stale, no retry",
           stale is True and ok is False and
           qbo_sync.quickbooks.update_item.await_count == 1)

    # No such item in this company at all → stale, so the caller re-resolves.
    qbo_sync.quickbooks.get_item = AsyncMock(side_effect=QboApiError(
        404, '{"Fault":{"Error":[{"Message":"Object Not Found","code":"610"}]}}', "610"))
    ok, changed, stale = await _real_repoint_item_income_account(
        object(), db, "20", "42", expected_name="L1 — Lead Lighting Tech",
        client_id="c", client_secret="s")
    _check("missing item reported stale", stale is True and ok is False)

    # No expected_name (legacy callers) → name check skipped, behaviour intact.
    qbo_sync.quickbooks.get_item = AsyncMock(return_value={
        "Id": "20", "Name": "Anything", "SyncToken": "3",
        "IncomeAccountRef": {"value": "11"}})
    qbo_sync.quickbooks.update_item = AsyncMock()
    ok, changed, stale = await _real_repoint_item_income_account(
        object(), db, "20", "42", client_id="c", client_secret="s")
    _check("unnamed call still re-points", ok is True and changed is True and stale is False)


async def test_resolve_line_reresolves_stale_item_id():
    print("test_resolve_line_reresolves_stale_item_id")
    settings = {"qboServiceIncomeAccountId": "42"}
    qbo_sync._settings_get = AsyncMock(side_effect=lambda db, key: settings.get(key))
    row = types.SimpleNamespace(id=3, role="L1", description="Lead Lighting Tech",
                                qb_item_id="20", qb_income_account_id=None,
                                qb_income_account_synced="11")
    conn = types.SimpleNamespace(income_accounts=[{"id": "42", "name": "Labor Income"}])
    # Item 20 is a stranger's deleted rental item — the cached id is bad.
    qbo_sync.quickbooks.get_item = AsyncMock(side_effect=[
        {"Id": "20", "Name": "Scissor Lift Rental (deleted)", "SyncToken": "1",
         "Active": False, "IncomeAccountRef": {"value": "11"}},
        {"Id": "77", "Name": "L1 — Lead Lighting Tech", "SyncToken": "0",
         "IncomeAccountRef": {"value": "42"}},
    ])
    qbo_sync.quickbooks.update_item = AsyncMock()
    qbo_sync.quickbooks.query = AsyncMock(return_value=[])          # no item by that name
    qbo_sync.quickbooks.create_item = AsyncMock(return_value={"Item": {"Id": "77"}})

    line = {"type": "service", "serviceId": 3, "name": "L1 — Lead Lighting Tech",
            "unitPrice": 432}
    repoints = []
    item_id = await _real_resolve_line_item_id(
        conn, _db_returning_row(row), line, client_id="c", client_secret="s",
        repoints=repoints)
    _check("line posts against the re-resolved item, not the stranger", item_id == "77")
    _check("bad cached id replaced on the row", row.qb_item_id == "77")
    _check("stranger's item never written to", qbo_sync.quickbooks.update_item.await_count == 0)
    _check("replacement created against the mapped account",
           qbo_sync.quickbooks.create_item.await_args.args[2]["IncomeAccountRef"]["value"] == "42")
    _check("synced cache confirmed on the verified item",
           row.qb_income_account_synced == "42")


def _deleted_element_fault(status=400):
    """The Fault QB returns for a write against a deleted list element."""
    return QboApiError(status, (
        '{"Fault": {"Error": [{"Message": "A business validation error has '
        'occurred while processing your request", "Detail": "Business '
        'Validation Error: You cannot modify a list element that has been '
        'deleted.", "code": "6000"}], "type": "ValidationFault"}}'
    ), "6000")


async def test_repoint_revives_deleted_item():
    print("test_repoint_revives_deleted_item")
    db = MagicMock(); db.flush = AsyncMock()

    # Item deleted (Active=false) in QB → the sparse update revives it too,
    # because QB refuses every other edit to a deleted list element.
    qbo_sync.quickbooks.get_item = AsyncMock(return_value={
        "Id": "20", "SyncToken": "3", "Active": False,
        "IncomeAccountRef": {"value": "11"}})
    qbo_sync.quickbooks.update_item = AsyncMock()
    ok, changed, stale = await _real_repoint_item_income_account(
        object(), db, "20", "42", client_id="c", client_secret="s")
    _check("deleted item re-pointed instead of skipped", ok is True and changed is True)
    payload = qbo_sync.quickbooks.update_item.await_args.args[2]
    _check("revive rides along with the re-point", payload.get("Active") is True)
    _check("revive keeps the new account", payload["IncomeAccountRef"]["value"] == "42")

    # Deleted, but already on the right account → revived, and NOT reported as
    # an account change (nothing to stamp into the invoice activity).
    qbo_sync.quickbooks.get_item = AsyncMock(return_value={
        "Id": "20", "SyncToken": "3", "Active": False,
        "IncomeAccountRef": {"value": "42"}})
    qbo_sync.quickbooks.update_item = AsyncMock()
    ok, changed, stale = await _real_repoint_item_income_account(
        object(), db, "20", "42", client_id="c", client_secret="s")
    _check("deleted item revived even when the account matches",
           ok is True and changed is False and
           qbo_sync.quickbooks.update_item.await_count == 1)

    # Read said active, write said deleted (raced / stale read) → retried once
    # with Active=true rather than logged and left stale forever.
    qbo_sync.quickbooks.get_item = AsyncMock(return_value={
        "Id": "20", "SyncToken": "3", "Active": True,
        "IncomeAccountRef": {"value": "11"}})
    qbo_sync.quickbooks.update_item = AsyncMock(
        side_effect=[_deleted_element_fault(), {"Item": {"Id": "20"}}])
    ok, changed, stale = await _real_repoint_item_income_account(
        object(), db, "20", "42", client_id="c", client_secret="s")
    _check("deleted-element fault retried with Active=true", ok is True and changed is True)
    _check("retry sent exactly one extra update",
           qbo_sync.quickbooks.update_item.await_count == 2)
    _check("retry payload carries the revive",
           qbo_sync.quickbooks.update_item.await_args.args[2].get("Active") is True)

    # A different validation fault is NOT retried — still best-effort.
    qbo_sync.quickbooks.update_item = AsyncMock(
        side_effect=QboApiError(400, "boom", "6000"))
    ok, changed, stale = await _real_repoint_item_income_account(
        object(), db, "20", "42", client_id="c", client_secret="s")
    _check("unrelated fault not retried",
           ok is False and changed is False and
           qbo_sync.quickbooks.update_item.await_count == 1)


async def test_find_or_create_revives_deleted_name():
    print("test_find_or_create_revives_deleted_name")
    db = MagicMock(); db.flush = AsyncMock()
    queries: list[str] = []

    async def _query(conn, _db, sql, **kw):
        queries.append(sql)
        # Only the explicit Active = false lookup finds the deleted item still
        # holding the name — the active-scoped lookup must not surface it.
        if "Active = false" in sql:
            return [{"Id": "20", "SyncToken": "7"}]
        return []

    qbo_sync.quickbooks.query = _query
    qbo_sync.quickbooks.create_item = AsyncMock(
        side_effect=QboApiError(400, "duplicate", "6240"))
    qbo_sync.quickbooks.update_item = AsyncMock()

    out = await _real_find_or_create_named_item(
        object(), db, "Equipment Rental", None,
        income_account_id="42", client_id="c", client_secret="s")
    _check("duplicate name owned by a deleted item → revived id returned", out == "20")
    payload = qbo_sync.quickbooks.update_item.await_args.args[2]
    _check("revive is a sparse Active=true update",
           payload.get("sparse") is True and payload.get("Active") is True and
           payload.get("SyncToken") == "7")
    _check("revived item re-pointed at the mapped account",
           payload["IncomeAccountRef"]["value"] == "42")
    _check("deleted lookup scoped to the item name",
           any("Active = false" in q and "Equipment Rental" in q for q in queries))
    _check("name lookup is scoped to ACTIVE items",
           all("Active = true" in q for q in queries if "Active = false" not in q))


async def test_deleted_item_never_lands_on_a_line():
    print("test_deleted_item_never_lands_on_a_line")
    # QB's Item query returns deleted items too. Handing one to an invoice line
    # gets the push rejected ("You need to activate this item before updating
    # the quantity"), so the lookup must never return it — the deleted item is
    # revived first and the line references an ACTIVE id.
    db = MagicMock(); db.flush = AsyncMock()
    seen: list[str] = []

    async def _query(conn, _db, sql, **kw):
        seen.append(sql)
        if "Active = false" in sql:
            return [{"Id": "20", "SyncToken": "7"}]      # the deleted namesake
        return []                                        # nothing active

    qbo_sync.quickbooks.query = _query
    qbo_sync.quickbooks.create_item = AsyncMock(
        side_effect=QboApiError(400, "duplicate", "6240"))
    qbo_sync.quickbooks.update_item = AsyncMock()

    out = await _real_find_or_create_named_item(
        object(), db, "L1 — Lead Lighting Tech", 432,
        income_account_id="42", client_id="c", client_secret="s")
    _check("deleted namesake reused only after being revived", out == "20")
    _check("the revive ran before the id was handed back",
           qbo_sync.quickbooks.update_item.await_args.args[2].get("Active") is True)
    _check("no unscoped item lookup anywhere",
           not any("Active" not in q for q in seen))

    # A deleted INVENTORY namesake belongs to the bookkeeper: never reactivated,
    # never re-pointed — the user gets an actionable message instead.
    qbo_sync.quickbooks.update_item.reset_mock()

    async def _inventory_query(conn, _db, sql, **kw):
        if "Active = false" in sql:
            return [{"Id": "20", "SyncToken": "7", "Type": "Inventory"}]
        return []

    qbo_sync.quickbooks.query = _inventory_query
    err = None
    try:
        await _real_find_or_create_named_item(
            object(), db, "V-Show - Aura (Wash)", 0,
            income_account_id="42", client_id="c", client_secret="s")
    except qbo_sync.InvoiceNotSyncable as e:
        err = str(e)
    _check("deleted Inventory namesake → actionable error, not a 6240",
           err is not None and "Inventory" in err and "V-Show - Aura (Wash)" in err)
    _check("the bookkeeper's item is left untouched",
           qbo_sync.quickbooks.update_item.await_count == 0)

    # Same guard on the re-point path: a deleted Inventory item is reported
    # stale (→ re-resolve → the message above), never revived in place.
    qbo_sync.quickbooks.get_item = AsyncMock(return_value={
        "Id": "20", "Name": "V-Show - Aura (Wash)", "SyncToken": "7",
        "Type": "Inventory", "Active": False, "IncomeAccountRef": {"value": "11"}})
    qbo_sync.quickbooks.update_item = AsyncMock()
    ok, changed, stale = await _real_repoint_item_income_account(
        object(), db, "20", "42", expected_name="V-Show - Aura (Wash)",
        client_id="c", client_secret="s")
    _check("deleted Inventory item not revived by the re-point",
           stale is True and ok is False and
           qbo_sync.quickbooks.update_item.await_count == 0)

    # An ACTIVE namesake is used as-is — no create, no revive.
    qbo_sync.quickbooks.create_item.reset_mock()
    qbo_sync.quickbooks.update_item.reset_mock()

    async def _active_query(conn, _db, sql, **kw):
        return [{"Id": "31", "Name": "L1 — Lead Lighting Tech"}] if "Active = true" in sql else []

    qbo_sync.quickbooks.query = _active_query
    out = await _real_find_or_create_named_item(
        object(), db, "L1 — Lead Lighting Tech", 432,
        income_account_id="42", client_id="c", client_secret="s")
    _check("active namesake reused untouched",
           out == "31" and qbo_sync.quickbooks.create_item.await_count == 0 and
           qbo_sync.quickbooks.update_item.await_count == 0)

    # Name is unique per PARENT, so a top-level item and a sub-item filed under
    # a category answer to the same Name. Pick the top-level one — the kind this
    # app creates — rather than whichever row QB happened to return first.
    async def _subitem_first_query(conn, _db, sql, **kw):
        if "Active = true" not in sql:
            return []
        return [
            {"Id": "25", "Name": "V-Show - Aura (Wash)",
             "FullyQualifiedName": "Lighting Equipment:V-Show - Aura (Wash)"},
            {"Id": "88", "Name": "V-Show - Aura (Wash)",
             "FullyQualifiedName": "V-Show - Aura (Wash)"},
        ]

    qbo_sync.quickbooks.query = _subitem_first_query
    out = await _real_find_or_create_named_item(
        object(), db, "V-Show - Aura (Wash)", 150,
        income_account_id="42", client_id="c", client_secret="s")
    _check("top-level item wins over a same-named sub-item", out == "88")

    # Only a sub-item carries the name → still deterministic, still used.
    async def _only_subitem_query(conn, _db, sql, **kw):
        if "Active = true" not in sql:
            return []
        return [{"Id": "25", "Name": "V-Show - Aura (Wash)",
                 "FullyQualifiedName": "Lighting Equipment:V-Show - Aura (Wash)"}]

    qbo_sync.quickbooks.query = _only_subitem_query
    out = await _real_find_or_create_named_item(
        object(), db, "V-Show - Aura (Wash)", 150,
        income_account_id="42", client_id="c", client_secret="s")
    _check("lone sub-item still resolves", out == "25")

    # Duplicate name with no deleted item behind it → the fault still surfaces.
    async def _empty_query(conn, _db, sql, **kw):
        return []

    qbo_sync.quickbooks.query = _empty_query
    raised = False
    try:
        await _real_find_or_create_named_item(
            object(), db, "Gaff Tape", None,
            income_account_id="42", client_id="c", client_secret="s")
    except QboApiError:
        raised = True
    _check("unexplained duplicate name still raises", raised)


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
        "Id": "I9", "Name": "L1 — Lead Tech", "SyncToken": "0",
        "IncomeAccountRef": {"value": "11"}})
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
    qbo_sync._repoint_item_income_account = AsyncMock(return_value=(True, True, False))
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


# ── Inactive QuickBooks references ───────────────────────────────────────────
# A customer or item DEACTIVATED in QuickBooks is still readable by id — QB only
# refuses it when a transaction references it, answering "Object Not Found ...
# has been made inactive" and naming nothing. The old code read the customer,
# saw an Id, swallowed any sync error and returned the stale id anyway, so every
# send failed with that message forever with no way out from the app.

def _inactive_customer_party():
    return types.SimpleNamespace(
        name="Landry Strickland", taxable=True, address="", city="", state="", zip="",
        qb_customer_id="CUST-DEAD",
    )


async def test_inactive_customer_is_reactivated():
    print("test_inactive_customer_is_reactivated")
    party = _inactive_customer_party()
    qbo_sync.quickbooks.get_customer = AsyncMock(
        return_value={"Id": "CUST-DEAD", "SyncToken": "7", "Active": False,
                      "DisplayName": "Landry Strickland"})
    qbo_sync.quickbooks.update_customer = AsyncMock(return_value={})
    db = MagicMock()
    db.flush = AsyncMock()

    got = await _real_find_or_create_customer(
        object(), db, party, "company", client_id="c", client_secret="s")

    _check("cached id is kept", got == "CUST-DEAD")
    sent = qbo_sync.quickbooks.update_customer.await_args.args[2]
    _check("reactivated via sparse update", sent.get("Active") is True)
    _check("update is sparse", sent.get("sparse") is True)
    _check("SyncToken carried", sent.get("SyncToken") == "7")
    # Recreating under the same DisplayName is not an option — QB enforces name
    # uniqueness across active AND inactive customers.
    _check("no duplicate customer created",
           not isinstance(getattr(qbo_sync.quickbooks, "create_customer", None), AsyncMock)
           or qbo_sync.quickbooks.create_customer.await_count == 0)


async def test_failed_reactivation_says_which_customer():
    print("test_failed_reactivation_says_which_customer")
    party = _inactive_customer_party()
    qbo_sync.quickbooks.get_customer = AsyncMock(
        return_value={"Id": "CUST-DEAD", "SyncToken": "1", "Active": False,
                      "DisplayName": "Landry Strickland"})
    qbo_sync.quickbooks.update_customer = AsyncMock(
        side_effect=QboApiError(400, '{"Fault":{"Error":[{"Message":"nope"}]}}', "6240"))
    db = MagicMock()
    db.flush = AsyncMock()

    raised = None
    try:
        await _real_find_or_create_customer(
            object(), db, party, "company", client_id="c", client_secret="s")
    except qbo_sync.InvoiceNotSyncable as e:
        raised = e
    # Silence here is what produced the unexplainable failure: the estimate that
    # follows is certain to be rejected, so it must say so while it still knows.
    _check("raises instead of returning a doomed id", raised is not None)
    _check("names the customer", raised is not None and "Landry Strickland" in str(raised))
    _check("says how to unblock it", raised is not None and "QuickBooks" in str(raised))


async def test_unreadable_cached_customer_is_re_resolved():
    print("test_unreadable_cached_customer_is_re_resolved")
    # The id names nothing in this QB company (deleted outright, or carried over
    # from another realm — ids are reused across companies).
    party = _inactive_customer_party()
    qbo_sync.quickbooks.get_customer = AsyncMock(
        side_effect=QboApiError(404, '{"Fault":{"Error":[{"Message":"gone"}]}}', "610"))
    qbo_sync.quickbooks.query = AsyncMock(return_value=[{"Id": "CUST-NEW"}])
    qbo_sync.quickbooks.update_customer = AsyncMock(return_value={})
    db = MagicMock()
    db.flush = AsyncMock()

    got = await _real_find_or_create_customer(
        object(), db, party, "company", client_id="c", client_secret="s")

    _check("re-resolved by name", got == "CUST-NEW")
    _check("cache repointed at the live customer", party.qb_customer_id == "CUST-NEW")


async def test_names_the_unusable_reference():
    print("test_names_the_unusable_reference")
    lines = [{"DetailType": "SalesItemLineDetail",
              "SalesItemLineDetail": {"ItemRef": {"value": "ITEM-9"}}}]

    # An inactive ITEM: a query filters inactive rows out, so a referenced id
    # simply missing from the result is the signal.
    qbo_sync.quickbooks.get_customer = AsyncMock(
        return_value={"Id": "C1", "Active": True, "DisplayName": "Acme"})
    qbo_sync.quickbooks.query = AsyncMock(return_value=[])
    detail = await qbo_sync._name_unusable_refs(
        object(), MagicMock(), "C1", lines, client_id="c", client_secret="s")
    _check("names the unusable item", "ITEM-9" in detail, detail)

    # An inactive CUSTOMER.
    qbo_sync.quickbooks.get_customer = AsyncMock(
        return_value={"Id": "C1", "Active": False, "DisplayName": "Landry Strickland"})
    qbo_sync.quickbooks.query = AsyncMock(return_value=[{"Id": "ITEM-9", "Name": "L1", "Active": True}])
    detail = await qbo_sync._name_unusable_refs(
        object(), MagicMock(), "C1", lines, client_id="c", client_secret="s")
    _check("names the inactive customer", "Landry Strickland" in detail, detail)

    # Healthy payload → nothing to report, so the real error is not replaced.
    qbo_sync.quickbooks.get_customer = AsyncMock(
        return_value={"Id": "C1", "Active": True, "DisplayName": "Acme"})
    detail = await qbo_sync._name_unusable_refs(
        object(), MagicMock(), "C1", lines, client_id="c", client_secret="s")
    _check("healthy payload reports nothing", detail == "", detail)

    # A diagnostic that itself fails must not mask the original fault.
    qbo_sync.quickbooks.get_customer = AsyncMock(side_effect=RuntimeError("boom"))
    detail = await qbo_sync._name_unusable_refs(
        object(), MagicMock(), "C1", lines, client_id="c", client_secret="s")
    _check("diagnostic failure is swallowed", detail == "", detail)


def main():
    sync_tests = [test_fault_parsing, test_query_escaping, test_readonly_columns_stripped,
                  test_period_label,
                  test_customer_billaddr_and_fields, test_income_account_readonly_columns]
    async_tests = [
        test_refresh_cached_when_fresh, test_refresh_basic_auth_and_rotation,
        test_refresh_invalid_grant_drops_connection, test_request_retries_on_401,
        test_api_error_on_fault, test_payload_lines_and_tax, test_payload_recall_note,
        test_payload_discounts, test_payload_project_memo, test_payload_requires_billable_line,
        test_rentals_never_become_qb_products,
        test_delete_not_synced, test_delete_synced_calls_qb,
        test_estimate_tax_creates_reads_deletes, test_estimate_tax_exempt_skips_qb,
        test_estimate_tax_stale_token_delete_retry,
        test_income_account_resolution, test_item_created_with_mapped_account,
        test_repoint_item_income_account, test_repoint_revives_deleted_item,
        test_repoint_refuses_foreign_item, test_resolve_line_reresolves_stale_item_id,
        test_find_or_create_revives_deleted_name, test_deleted_item_never_lands_on_a_line,
        test_resolve_line_repoints_on_mapping_change,
        test_equipment_item_uses_rentals_mapping, test_accounts_refresh_route,
        test_inactive_customer_is_reactivated, test_failed_reactivation_says_which_customer,
        test_unreadable_cached_customer_is_re_resolved, test_names_the_unusable_reference,
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
