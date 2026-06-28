"""QuickBooks Online sync engine.

Pure business logic that maps an LTP Invoice onto the QuickBooks Online data
model and pushes it through backend/quickbooks.py. The route layer
(backend/routes/qbo.py) stays thin: it loads the invoice, calls push_invoice,
and maps exceptions to HTTP. This module owns:

  - find-or-create of QB Customers (from Company / Contact) and QB Items
    (from Product / Service; Equipment maps to one generic "Equipment Rental"
    item), caching the returned ids back on the local rows.
  - building the QB Invoice payload (lines, discount, per-line tax codes,
    DocNumber, dates, and the RECALLED private-note memo).
  - the idempotent create-or-update push keyed on the stored qb_invoice_id +
    SyncToken, with stale-token (5010) and duplicate-DocNumber (6140) recovery.
  - pulling QB-computed tax + grand total back onto the invoice (read-only).
  - a throttled background auto-resync used after an invoice is edited.

Decisions baked in (confirmed with the owner):
  - Equipment → ONE generic "Equipment Rental" QB item; each equipment type is
    its own line referencing that item, detail carried in the description.
  - Recall → no delete; stamp PrivateNote "RECALLED — MAY NOT BE UP TO DATE",
    cleared on the next push once the invoice is no longer a recalled draft.
  - Tax → customer-level `taxable` flag with per-line override; QB computes the
    tax and we store TotalTax / TotalAmt read-only so totals always match.
"""
import os
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from backend import crypto, models, quickbooks
from backend.activity import append_activity
from backend.quickbooks import (
    QboApiError,
    QboError,
    escape_query_value,
)

# US Automated Sales Tax sentinel codes. LTP is a US company, so taxable lines
# carry "TAX" and exempt lines "NON"; QB's AST engine computes the rate from the
# customer + addresses. Overridable via settings if a non-US/manual setup needs
# explicit tax code ids.
_DEFAULT_TAX_CODE = "TAX"
_DEFAULT_NON_TAX_CODE = "NON"

_RECALL_NOTE = "RECALLED — MAY NOT BE UP TO DATE"
# Shown as a prominent first line ON the QB invoice (the memo alone is easy to
# miss). Cleared automatically once the invoice is no longer a recalled draft.
_RECALL_LINE = "*** RECALLED — MAY NOT BE UP TO DATE — A CORRECTED INVOICE WILL FOLLOW ***"


class InvoiceNotSyncable(QboError):
    """The invoice can't be pushed as-is (no client, or no billable lines).
    Route maps this to 400 so the user gets an actionable message."""


def creds() -> tuple[str, str]:
    """QuickBooks app credentials from the environment. Read here (not imported)
    so this module stays decoupled — same pattern as gmail creds in email.py."""
    return os.environ.get("QBO_CLIENT_ID", ""), os.environ.get("QBO_CLIENT_SECRET", "")


# ── Settings cache helpers ───────────────────────────────────────────────────

async def _settings_row(db: AsyncSession) -> models.Settings:
    r = await db.execute(select(models.Settings).where(models.Settings.id == 1))
    row = r.scalar_one_or_none()
    if row is None:
        row = models.Settings(id=1, data={})
        db.add(row)
        await db.flush()
    return row


async def _settings_get(db: AsyncSession, key: str):
    row = await _settings_row(db)
    return (row.data or {}).get(key)


async def _settings_set(db: AsyncSession, key: str, value) -> None:
    row = await _settings_row(db)
    data = dict(row.data or {})
    data[key] = value
    row.data = data
    flag_modified(row, "data")
    await db.flush()


# ── Income account resolution ────────────────────────────────────────────────

async def _resolve_income_account_id(conn, db, *, client_id, client_secret) -> str:
    """Return an Income account id for backing new Items' IncomeAccountRef.
    Prefers the admin-configured settings.qboIncomeAccountId; otherwise picks
    the first active Income account in QB and caches it. Raises QboApiError with
    an actionable message if the QB company has none."""
    configured = await _settings_get(db, "qboIncomeAccountId")
    if configured:
        return str(configured)
    accounts = await quickbooks.list_income_accounts(
        conn, db, client_id=client_id, client_secret=client_secret
    )
    if not accounts:
        raise QboApiError(
            400,
            '{"Fault":{"Error":[{"Message":"No income account found",'
            '"Detail":"Create an income account in QuickBooks, or set one in '
            'Settings, before syncing invoices."}]}}',
        )
    account_id = str(accounts[0].get("Id"))
    await _settings_set(db, "qboIncomeAccountId", account_id)
    return account_id


# ── Customer find-or-create ──────────────────────────────────────────────────

def _safe_name(name: str, limit: int) -> str:
    """QB names can't contain a colon (sub-item separator) and have length
    caps. Clean + truncate, never return empty."""
    cleaned = (name or "").replace(":", " -").strip()
    cleaned = cleaned[:limit].strip()
    return cleaned or "Item"


async def _billing_party(db: AsyncSession, invoice: models.Invoice):
    """Return the (row, kind) that bills this invoice — a Company or a Contact —
    or (None, None) if neither is set."""
    if invoice.client_type == "contact" and invoice.client_contact_id:
        r = await db.execute(select(models.Contact).where(models.Contact.id == invoice.client_contact_id))
        return r.scalar_one_or_none(), "contact"
    if invoice.company_id:
        r = await db.execute(select(models.Company).where(models.Company.id == invoice.company_id))
        return r.scalar_one_or_none(), "company"
    # Fall back to whichever id is present.
    if invoice.client_contact_id:
        r = await db.execute(select(models.Contact).where(models.Contact.id == invoice.client_contact_id))
        return r.scalar_one_or_none(), "contact"
    return None, None


def _bill_addr(party) -> dict | None:
    """Structured QuickBooks BillAddr from the party's address fields, or None
    if nothing is set. Automated Sales Tax geocodes the jurisdiction from City /
    CountrySubDivisionCode (state) / PostalCode (+ Line1), which is why the
    free-form `address` alone couldn't drive tax."""
    line = (getattr(party, "address", "") or "").strip()
    city = (getattr(party, "city", "") or "").strip()
    state = (getattr(party, "state", "") or "").strip()
    postal = (getattr(party, "zip", "") or "").strip()
    if not (line or city or state or postal):
        return None
    addr: dict = {}
    if line:
        parts = [p.strip() for p in line.splitlines() if p.strip()]
        if parts:
            addr["Line1"] = parts[0][:500]
            if len(parts) > 1:
                addr["Line2"] = " ".join(parts[1:])[:500]
    if city:
        addr["City"] = city[:255]
    if state:
        addr["CountrySubDivisionCode"] = state[:255]
    if postal:
        addr["PostalCode"] = postal[:30]
    addr["Country"] = "US"
    return addr


def _party_taxable(party, kind) -> bool:
    """Default taxability for a billing party's invoice lines. Directly-billed
    contacts (individuals) are ALWAYS taxable; companies carry an explicit
    `taxable` flag (many are exempt — resellers, non-profits). Per-line
    overrides still apply on top of this in build_invoice_payload."""
    if kind == "contact":
        return True
    return bool(getattr(party, "taxable", False))


def _customer_fields(party, kind) -> tuple[str, dict]:
    """Return (display_name, fields) for a QB Customer built from the party.
    `fields` holds the syncable attributes (name parts, contact info, BillAddr,
    Taxable) WITHOUT DisplayName — DisplayName is added only on create, so a
    sparse update of an existing customer can never trip a duplicate-name (6240)
    conflict by trying to rename it."""
    if kind == "company":
        display_name = _safe_name(party.name, 100)
        fields: dict = {"CompanyName": (party.name or "")[:100]}
    else:
        full = f"{party.first_name or ''} {party.last_name or ''}".strip()
        display_name = _safe_name(full or party.email or f"Contact {party.id}", 100)
        fields = {
            "GivenName": (party.first_name or "")[:100],
            "FamilyName": (party.last_name or "")[:100],
        }
        if (party.email or "").strip():
            fields["PrimaryEmailAddr"] = {"Address": party.email}
        if (party.phone or "").strip():
            fields["PrimaryPhone"] = {"FreeFormNumber": party.phone}
    addr = _bill_addr(party)
    if addr:
        fields["BillAddr"] = addr
    fields["Taxable"] = _party_taxable(party, kind)
    return display_name, fields


async def find_or_create_customer(conn, db, party, kind, *, client_id, client_secret) -> str:
    """Resolve `party` (Company or Contact row) to a QB Customer id, caching it
    on the row. When the customer already exists, keep its billing address +
    Taxable flag in sync with the app on each push (so a client moved into a
    taxable area, or toggled taxable, reflects in QuickBooks and tax computes).
    The customer sync is best-effort — a hiccup there must not block the push."""
    display_name, fields = _customer_fields(party, kind)

    if party.qb_customer_id:
        try:
            current = await quickbooks.get_customer(
                conn, db, party.qb_customer_id, client_id=client_id, client_secret=client_secret
            )
            if current.get("Id"):
                update = dict(fields)
                update["Id"] = str(current["Id"])
                update["SyncToken"] = str(current.get("SyncToken", "0"))
                update["sparse"] = True
                await quickbooks.update_customer(
                    conn, db, update, client_id=client_id, client_secret=client_secret
                )
        except QboApiError as e:
            print(f"[LTP] qbo: customer sync skipped for {party.qb_customer_id} ({e.safe_message})", flush=True)
        return party.qb_customer_id

    # No cached id — match an existing customer by DisplayName, else create.
    payload = dict(fields)
    payload["DisplayName"] = display_name
    found = await quickbooks.query(
        conn, db,
        f"SELECT Id, DisplayName FROM Customer WHERE DisplayName = '{escape_query_value(display_name)}'",
        client_id=client_id, client_secret=client_secret,
    )
    if found:
        qb_id = str(found[0].get("Id"))
    else:
        try:
            resp = await quickbooks.create_customer(
                conn, db, payload, client_id=client_id, client_secret=client_secret
            )
            qb_id = str((resp.get("Customer") or {}).get("Id"))
        except QboApiError as e:
            # Duplicate name (6240) — another path created it; re-query + adopt.
            if e.fault_code == "6240":
                again = await quickbooks.query(
                    conn, db,
                    f"SELECT Id FROM Customer WHERE DisplayName = '{escape_query_value(display_name)}'",
                    client_id=client_id, client_secret=client_secret,
                )
                if not again:
                    raise
                qb_id = str(again[0].get("Id"))
            else:
                raise

    party.qb_customer_id = qb_id
    await db.flush()
    return qb_id


# ── Item find-or-create ──────────────────────────────────────────────────────

async def _find_or_create_named_item(conn, db, name, unit_price, *, client_id, client_secret) -> str:
    """Find a QB Service item by Name, creating it (backed by the resolved
    income account) if absent. Returns the item id."""
    safe = _safe_name(name, 100)
    found = await quickbooks.query(
        conn, db,
        f"SELECT Id, Name FROM Item WHERE Name = '{escape_query_value(safe)}'",
        client_id=client_id, client_secret=client_secret,
    )
    if found:
        return str(found[0].get("Id"))
    income_account_id = await _resolve_income_account_id(
        conn, db, client_id=client_id, client_secret=client_secret
    )
    payload = {
        "Name": safe,
        "Type": "Service",
        "IncomeAccountRef": {"value": income_account_id},
    }
    if unit_price is not None:
        try:
            payload["UnitPrice"] = round(float(unit_price), 2)
        except (TypeError, ValueError):
            pass
    try:
        resp = await quickbooks.create_item(
            conn, db, payload, client_id=client_id, client_secret=client_secret
        )
        return str((resp.get("Item") or {}).get("Id"))
    except QboApiError as e:
        if e.fault_code == "6240":  # duplicate name race
            again = await quickbooks.query(
                conn, db,
                f"SELECT Id FROM Item WHERE Name = '{escape_query_value(safe)}'",
                client_id=client_id, client_secret=client_secret,
            )
            if again:
                return str(again[0].get("Id"))
        raise


async def _generic_equipment_item_id(conn, db, *, client_id, client_secret) -> str:
    """The single 'Equipment Rental' QB item all equipment lines reference.
    Resolved/created once and cached in settings.qboEquipmentItemId."""
    cached = await _settings_get(db, "qboEquipmentItemId")
    if cached:
        return str(cached)
    item_id = await _find_or_create_named_item(
        conn, db, "Equipment Rental", None, client_id=client_id, client_secret=client_secret
    )
    await _settings_set(db, "qboEquipmentItemId", item_id)
    return item_id


async def _resolve_line_item_id(conn, db, line, *, client_id, client_secret) -> str:
    """QB Item id for a sales line. Equipment → the generic rental item.
    Product/Service → their own item (matched on the catalog row's qb_item_id
    cache, else by name). Free-typed lines fall back to the line name."""
    ltype = line.get("type")
    eff_price = line.get("adjustedPrice")
    if eff_price is None:
        eff_price = line.get("unitPrice")

    if ltype == "equipment":
        return await _generic_equipment_item_id(conn, db, client_id=client_id, client_secret=client_secret)

    catalog_row = None
    name = line.get("name") or ""
    if ltype == "product" and line.get("productId"):
        r = await db.execute(select(models.Product).where(models.Product.id == line["productId"]))
        catalog_row = r.scalar_one_or_none()
        if catalog_row and not name:
            name = catalog_row.name
    elif ltype == "service" and line.get("serviceId"):
        r = await db.execute(select(models.Service).where(models.Service.id == line["serviceId"]))
        catalog_row = r.scalar_one_or_none()
        if catalog_row and not name:
            name = f"{catalog_row.role} — {catalog_row.description}".strip()

    if catalog_row and catalog_row.qb_item_id:
        return catalog_row.qb_item_id

    item_id = await _find_or_create_named_item(
        conn, db, name or "Line item", eff_price, client_id=client_id, client_secret=client_secret
    )
    if catalog_row is not None:
        catalog_row.qb_item_id = item_id
        await db.flush()
    return item_id


# ── Payload building ─────────────────────────────────────────────────────────

def _invoice_ref(invoice: models.Invoice) -> str:
    """Mirror theme.js LTP_INVOICE_REF: INV-YYYY-NNN (year from invoice_date)."""
    year = (invoice.invoice_date or "")[:4] or str(datetime.now(timezone.utc).year)
    return f"INV-{year}-{str(invoice.id or 0).zfill(3)}"


def _line_taxable(line: dict, customer_taxable: bool) -> bool:
    """Per-line override wins; otherwise inherit the customer's taxable flag."""
    override = line.get("taxable")
    if isinstance(override, bool):
        return override
    return bool(customer_taxable)


async def _build_sales_lines(conn, db, entity, customer_taxable, tax_code, non_tax_code, *, client_id, client_secret) -> tuple[list[dict], float]:
    """Build the QB sales lines (item lines with per-line TaxCodeRef + a trailing
    global-discount line) from any entity carrying `.sections` and
    `.global_discount` — invoices AND quotes (for the temporary tax estimate).
    Returns (lines, subtotal). Raises InvoiceNotSyncable if there are no billable
    item lines. Shared so quote tax codes match the eventual invoice exactly."""
    lines: list[dict] = []
    subtotal = 0.0
    for section in (entity.sections or []):
        for item in (section.get("items") or []):
            itype = item.get("type")
            if itype == "note":
                # Note line items store their text in `.text` (see modules/invoices.js).
                text = (item.get("text") or item.get("name") or item.get("notes") or "").strip()
                if text:
                    lines.append({"DetailType": "DescriptionOnly", "Description": text[:4000]})
                continue
            qty = float(item.get("qty") or 0)
            eff_price = item.get("adjustedPrice")
            if eff_price is None:
                eff_price = item.get("unitPrice") or 0
            eff_price = float(eff_price or 0)
            amount = round(eff_price * qty, 2)
            subtotal += amount

            item_id = await _resolve_line_item_id(
                conn, db, item, client_id=client_id, client_secret=client_secret
            )
            description = (item.get("name") or "").strip()
            if (item.get("notes") or "").strip():
                description = (description + " — " + item["notes"].strip())[:4000]
            taxable = _line_taxable(item, customer_taxable)
            lines.append({
                "DetailType": "SalesItemLineDetail",
                "Amount": amount,
                "Description": description[:4000] or "Line item",
                "SalesItemLineDetail": {
                    "ItemRef": {"value": item_id},
                    "Qty": qty,
                    "UnitPrice": round(eff_price, 2),
                    "TaxCodeRef": {"value": tax_code if taxable else non_tax_code},
                },
            })

    if not any(l.get("DetailType") == "SalesItemLineDetail" for l in lines):
        raise InvoiceNotSyncable("no billable line items to push to QuickBooks")

    # Global discount → a single discount line after the item lines.
    gd = entity.global_discount or {}
    gtype = gd.get("type")
    if gtype == "percent" and gd.get("value"):
        lines.append({
            "DetailType": "DiscountLineDetail",
            "DiscountLineDetail": {"PercentBased": True, "DiscountPercent": float(gd["value"])},
        })
    elif gtype in ("flat", "target"):
        if gtype == "flat":
            amount = float(gd.get("value") or 0)
        else:  # target total → equivalent flat discount (matches theme.js)
            amount = max(0.0, subtotal - float(gd.get("value") or 0))
        if amount > 0:
            lines.append({
                "DetailType": "DiscountLineDetail",
                "Amount": round(amount, 2),
                "DiscountLineDetail": {"PercentBased": False},
            })
    return lines, subtotal


async def build_invoice_payload(conn, db, invoice, customer_id, customer_taxable, *, project_name="", client_id, client_secret) -> dict:
    """Construct the QuickBooks Invoice JSON from an LTP invoice. Resolves QB
    item ids for each billable line (find-or-create). Raises InvoiceNotSyncable
    if there are no billable lines. `project_name` is surfaced on the QB invoice
    (CustomerMemo) so a project/event rename is a real, pushable change."""
    tax_code = str(await _settings_get(db, "qboTaxableCodeId") or _DEFAULT_TAX_CODE)
    non_tax_code = str(await _settings_get(db, "qboNonTaxableCodeId") or _DEFAULT_NON_TAX_CODE)
    lines, subtotal = await _build_sales_lines(
        conn, db, invoice, customer_taxable, tax_code, non_tax_code,
        client_id=client_id, client_secret=client_secret,
    )

    # Recall: a draft that was previously sent. Surface it prominently as the
    # FIRST line on the QB invoice (a memo is easy to miss) and keep the memo
    # too. Cleared automatically once it's no longer a recalled draft.
    recalled = invoice.status == "draft" and bool((invoice.sent_date or "").strip())
    if recalled:
        lines.insert(0, {"DetailType": "DescriptionOnly", "Description": _RECALL_LINE})

    payload: dict = {
        "CustomerRef": {"value": str(customer_id)},
        "Line": lines,
        "DocNumber": _invoice_ref(invoice)[:21],
    }
    if (invoice.invoice_date or "").strip():
        payload["TxnDate"] = invoice.invoice_date
    if (invoice.due_date or "").strip():
        payload["DueDate"] = invoice.due_date
    # CustomerMemo carries the project/event name (so renames push through) plus
    # the invoice notes.
    memo_parts = []
    if (project_name or "").strip():
        memo_parts.append(project_name.strip())
    if (invoice.notes or "").strip():
        memo_parts.append(invoice.notes.strip())
    if memo_parts:
        payload["CustomerMemo"] = {"value": "\n".join(memo_parts)[:1000]}
    payload["PrivateNote"] = _RECALL_NOTE if recalled else ""
    return payload


# ── Activity stamping ────────────────────────────────────────────────────────

def _actor(user):
    if user is None:
        return "QuickBooks", None
    return (user.name or user.email), user.id


def _stamp(invoice, user, etype, message, changes):
    actor_name, actor_id = _actor(user)
    return append_activity(
        invoice, id_prefix="qb-", type_=etype, user=actor_name,
        user_id=actor_id, message=message, now=datetime.now(timezone.utc),
        changes=changes,
    )


# ── Push ─────────────────────────────────────────────────────────────────────

async def push_invoice(db, invoice, user=None, *, client_id=None, client_secret=None) -> dict:
    """Create or update this invoice in QuickBooks (idempotent on qb_invoice_id).
    Persists qb_invoice_id / qb_sync_token / status / QB-computed totals back on
    the row and stamps a qbo_synced activity entry. Raises QboNotConnected,
    QboReconnectRequired, QboApiError, or InvoiceNotSyncable for the route to
    map to HTTP."""
    if client_id is None or client_secret is None:
        client_id, client_secret = creds()
    conn = await quickbooks.load_connection(db)

    party, kind = await _billing_party(db, invoice)
    if party is None:
        raise InvoiceNotSyncable("invoice has no client (company or contact) to bill")

    customer_id = await find_or_create_customer(
        conn, db, party, kind, client_id=client_id, client_secret=client_secret
    )
    project_name = ""
    if invoice.project_id:
        pr = await db.execute(select(models.Project).where(models.Project.id == invoice.project_id))
        proj = pr.scalar_one_or_none()
        if proj:
            project_name = proj.name or ""
    payload = await build_invoice_payload(
        conn, db, invoice, customer_id, _party_taxable(party, kind),
        project_name=project_name,
        client_id=client_id, client_secret=client_secret,
    )

    created = invoice.qb_invoice_id is None
    if created:
        resp_inv = await _create_with_recovery(
            conn, db, invoice, payload, client_id=client_id, client_secret=client_secret
        )
        action = "created"
    else:
        payload["Id"] = invoice.qb_invoice_id
        payload["SyncToken"] = invoice.qb_sync_token or "0"
        payload["sparse"] = False
        try:
            resp = await quickbooks.update_invoice(
                conn, db, payload, client_id=client_id, client_secret=client_secret
            )
        except QboApiError as e:
            if e.fault_code == "5010":  # stale SyncToken — refetch + retry once
                current = await quickbooks.get_invoice(
                    conn, db, invoice.qb_invoice_id, client_id=client_id, client_secret=client_secret
                )
                payload["SyncToken"] = str(current.get("SyncToken", "0"))
                resp = await quickbooks.update_invoice(
                    conn, db, payload, client_id=client_id, client_secret=client_secret
                )
            else:
                raise
        resp_inv = resp.get("Invoice") or {}
        action = "updated"

    _apply_qb_result(invoice, resp_inv)
    _stamp(invoice, user, "qbo_synced",
           f"Synced to QuickBooks ({_invoice_ref(invoice)})",
           [{"cat": "QB Invoice Id", "detail": invoice.qb_invoice_id or "?"},
            {"cat": "Action", "detail": action}])
    await db.flush()
    return {
        "ok": True,
        "action": action,
        "qbInvoiceId": invoice.qb_invoice_id,
        "qbSyncToken": invoice.qb_sync_token,
        "qbTaxTotal": invoice.qb_tax_total,
        "qbTotalAmt": invoice.qb_total_amt,
        "qbSyncStatus": invoice.qb_sync_status,
        "qbSyncedAt": invoice.qb_synced_at.isoformat() if invoice.qb_synced_at else None,
    }


async def _create_with_recovery(conn, db, invoice, payload, *, client_id, client_secret) -> dict:
    """Create the invoice, recovering from the two foreseeable faults:
      - 6140 duplicate DocNumber → a prior create succeeded but our persist
        didn't; find that invoice and switch to an update (idempotency net).
      - a DocNumber-not-allowed fault (custom numbers disabled) → retry without
        the DocNumber so QB auto-assigns."""
    try:
        resp = await quickbooks.create_invoice(
            conn, db, payload, client_id=client_id, client_secret=client_secret
        )
        return resp.get("Invoice") or {}
    except QboApiError as e:
        body = (e.body or "").lower()
        if e.fault_code == "6140" or "duplicate document number" in body:
            existing = await quickbooks.query(
                conn, db,
                f"SELECT Id, SyncToken FROM Invoice WHERE DocNumber = '{escape_query_value(payload.get('DocNumber', ''))}'",
                client_id=client_id, client_secret=client_secret,
            )
            if existing:
                payload["Id"] = str(existing[0].get("Id"))
                payload["SyncToken"] = str(existing[0].get("SyncToken", "0"))
                payload["sparse"] = False
                resp = await quickbooks.update_invoice(
                    conn, db, payload, client_id=client_id, client_secret=client_secret
                )
                return resp.get("Invoice") or {}
        if "docnumber" in body and payload.get("DocNumber"):
            payload.pop("DocNumber", None)
            resp = await quickbooks.create_invoice(
                conn, db, payload, client_id=client_id, client_secret=client_secret
            )
            return resp.get("Invoice") or {}
        raise


def _apply_qb_result(invoice, resp_inv: dict) -> None:
    """Copy the QB response's id / SyncToken / computed totals onto the row."""
    if resp_inv.get("Id"):
        invoice.qb_invoice_id = str(resp_inv["Id"])
    if resp_inv.get("SyncToken") is not None:
        invoice.qb_sync_token = str(resp_inv["SyncToken"])
    tax = (resp_inv.get("TxnTaxDetail") or {}).get("TotalTax")
    if tax is not None:
        try:
            invoice.qb_tax_total = float(tax)
        except (TypeError, ValueError):
            pass
    if resp_inv.get("TotalAmt") is not None:
        try:
            invoice.qb_total_amt = float(resp_inv["TotalAmt"])
        except (TypeError, ValueError):
            pass
    invoice.qb_sync_status = "synced"
    invoice.qb_synced_at = datetime.now(timezone.utc)
    invoice.qb_last_error = None


# ── Delete ───────────────────────────────────────────────────────────────────

async def delete_from_quickbooks(db, invoice, *, client_id=None, client_secret=None) -> dict:
    """Delete this invoice's QuickBooks counterpart. Idempotent:
      - a not-yet-synced invoice (no qb_invoice_id) → {"deleted": False}
      - a QB invoice that's already gone → treated as deleted
      - a stale SyncToken (5010) → refetch the current token and retry
    Raises QboNotConnected / QboReconnectRequired / QboApiError for the route to
    map to HTTP. Does NOT delete the local row — that's the caller's job."""
    if not invoice.qb_invoice_id:
        return {"ok": True, "deleted": False, "reason": "not_synced"}
    if client_id is None or client_secret is None:
        client_id, client_secret = creds()
    conn = await quickbooks.load_connection(db)
    sync_token = invoice.qb_sync_token or "0"
    try:
        await quickbooks.delete_invoice(
            conn, db, invoice.qb_invoice_id, sync_token,
            client_id=client_id, client_secret=client_secret,
        )
    except QboApiError as e:
        body = (e.body or "").lower()
        if e.fault_code == "5010":  # stale SyncToken — refetch + retry once
            current = await quickbooks.get_invoice(
                conn, db, invoice.qb_invoice_id, client_id=client_id, client_secret=client_secret
            )
            sync_token = str(current.get("SyncToken", sync_token))
            await quickbooks.delete_invoice(
                conn, db, invoice.qb_invoice_id, sync_token,
                client_id=client_id, client_secret=client_secret,
            )
        elif e.fault_code == "610" or "not found" in body:
            pass  # already gone in QB — idempotent success
        else:
            raise
    return {"ok": True, "deleted": True, "qbInvoiceId": invoice.qb_invoice_id}


# ── Quote sales tax via a temporary estimate ──────────────────────────────────

async def _delete_estimate_quietly(conn, db, estimate_id, sync_token, *, client_id, client_secret) -> bool:
    """Delete a temporary estimate; idempotent (5010 stale-token → refetch +
    retry; 610/already-gone → success). NEVER raises — we've already read the
    tax, so a failed delete is logged (the orphan can be swept later) rather than
    losing the result."""
    try:
        await quickbooks.delete_estimate(
            conn, db, estimate_id, str(sync_token), client_id=client_id, client_secret=client_secret
        )
        return True
    except QboApiError as e:
        body = (e.body or "").lower()
        if e.fault_code == "5010":
            try:
                current = await quickbooks.get_estimate(
                    conn, db, estimate_id, client_id=client_id, client_secret=client_secret
                )
                await quickbooks.delete_estimate(
                    conn, db, estimate_id, str(current.get("SyncToken", sync_token)),
                    client_id=client_id, client_secret=client_secret,
                )
                return True
            except QboApiError as e2:
                print(f"[LTP] qbo: estimate {estimate_id} delete retry failed: {e2.safe_message}", flush=True)
                return False
        if e.fault_code == "610" or "not found" in body:
            return True  # already gone
        print(f"[LTP] qbo: estimate {estimate_id} delete failed: {e.safe_message}", flush=True)
        return False


async def get_quote_estimate_tax(db, quote, user=None, *, client_id=None, client_secret=None) -> dict:
    """Compute a quote's sales tax the QuickBooks-authoritative way WITHOUT
    leaving a QB document behind: create a temporary Estimate from the quote's
    lines, read its QB-computed TxnTaxDetail.TotalTax, then delete the estimate
    (the business doesn't use QB estimates). Stores the result on
    quote.qb_tax_total and stamps an activity entry.

    Exempt customers short-circuit to $0 with no QB round-trip. Raises
    QboNotConnected / QboReconnectRequired / QboApiError / InvoiceNotSyncable for
    the route to map to HTTP."""
    if client_id is None or client_secret is None:
        client_id, client_secret = creds()

    party, kind = await _billing_party(db, quote)
    if party is None:
        raise InvoiceNotSyncable("quote has no client (company or contact) to compute tax for")

    customer_taxable = _party_taxable(party, kind)
    if not customer_taxable:
        # Tax-exempt client → tax is $0 by definition; don't touch QuickBooks.
        quote.qb_tax_total = 0.0
        _stamp(quote, user, "qbo_estimate_tax", "Sales tax: client is tax-exempt ($0.00)",
               [{"cat": "Sales Tax", "detail": "$0.00 (exempt)"}])
        await db.flush()
        return {"ok": True, "qbTaxTotal": 0.0, "taxable": False, "estimateDeleted": False}

    conn = await quickbooks.load_connection(db)
    customer_id = await find_or_create_customer(
        conn, db, party, kind, client_id=client_id, client_secret=client_secret
    )
    tax_code = str(await _settings_get(db, "qboTaxableCodeId") or _DEFAULT_TAX_CODE)
    non_tax_code = str(await _settings_get(db, "qboNonTaxableCodeId") or _DEFAULT_NON_TAX_CODE)
    lines, _subtotal = await _build_sales_lines(
        conn, db, quote, customer_taxable, tax_code, non_tax_code,
        client_id=client_id, client_secret=client_secret,
    )
    # DocNumber omitted on purpose: QB auto-assigns an estimate number, avoiding
    # duplicate-DocNumber faults across repeated calcs (the estimate is deleted
    # each time anyway). Only CustomerRef + Line are needed for QB to compute tax.
    payload = {"CustomerRef": {"value": str(customer_id)}, "Line": lines}

    resp = await quickbooks.create_estimate(
        conn, db, payload, client_id=client_id, client_secret=client_secret
    )
    est = resp.get("Estimate") or {}
    estimate_id = est.get("Id")
    sync_token = est.get("SyncToken")

    tax_total = 0.0
    raw_tax = (est.get("TxnTaxDetail") or {}).get("TotalTax")
    if raw_tax is not None:
        try:
            tax_total = float(raw_tax)
        except (TypeError, ValueError):
            tax_total = 0.0

    deleted = False
    if estimate_id:
        deleted = await _delete_estimate_quietly(
            conn, db, estimate_id, sync_token or "0",
            client_id=client_id, client_secret=client_secret,
        )

    quote.qb_tax_total = tax_total
    _stamp(quote, user, "qbo_estimate_tax", "Sales tax calculated via QuickBooks",
           [{"cat": "Sales Tax", "detail": f"${tax_total:,.2f}"}])
    await db.flush()
    return {"ok": True, "qbTaxTotal": tax_total, "taxable": True, "estimateDeleted": deleted}
