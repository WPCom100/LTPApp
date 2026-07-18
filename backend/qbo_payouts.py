"""QuickBooks Online payout vendor-bill engine.

The accounts-PAYABLE mirror of qbo_sync.py. It maps a crew member's payout for
one pay period onto a QuickBooks Vendor Bill and pushes it idempotently:

  - find-or-create of a QB Vendor from the crew Contact, caching qb_vendor_id
    (mirrors find_or_create_customer, with a DisplayName-collision fallback).
  - building the Bill payload: one AccountBasedExpenseLineDetail line per payout
    day, expensed to the per-role account (Service.qb_expense_account_id) or the
    configured default; day-level adjustments + rounding residual absorbed by the
    day's primary account line so the lines sum EXACTLY to the payable.
  - the idempotent create-or-update push keyed on the PayoutBill row's cached
    qb_bill_id + a deterministic DocNumber, with pre-query-by-DocNumber orphan
    adoption, 6140/6240/5010 recovery, a line-signature no-op short-circuit, and
    the payout_bill_lines double-pay ledger written in the same transaction.

The money never comes from the client — the route re-derives it from the frozen
schedule snapshots (backend/payouts.py) before calling push_payout_bill.
"""
import hashlib
from datetime import datetime, timezone

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from backend import models, quickbooks
from backend.activity import append_activity
from backend.payouts import js_round2
from backend.qbo_sync import _bill_addr, _safe_name, _settings_get, creds
from backend.quickbooks import QboApiError, QboError, escape_query_value


class PayoutNotBillable(QboError):
    """This crew member's period has nothing billable (no signed non-zero days,
    a net total <= 0, a day already billed on another period, or no expense
    account). The route reports it as a per-contact skip, not an error."""


# ── Account resolution ───────────────────────────────────────────────────────

async def resolve_payout_accounts(db, services) -> dict:
    """Resolve the expense/AP account mapping for the bill lines:
      - per-role override: Service.qb_expense_account_id
      - default: settings.qboPayoutExpenseAccountId
      - AP: settings.qboPayoutApAccountId (else omit -> QB default AP account)
    Account-type validation is the preview's job (it has the cached account
    lists); the biller only needs the ids."""
    default_expense = await _settings_get(db, "qboPayoutExpenseAccountId")
    ap = await _settings_get(db, "qboPayoutApAccountId")
    by_service = {}
    for s in (services or []):
        acct = getattr(s, "qb_expense_account_id", None)
        if acct:
            by_service[s.id] = str(acct)
    return {
        "default_expense": str(default_expense) if default_expense else None,
        "ap": str(ap) if ap else None,
        "by_service": by_service,
    }


# ── Vendor find-or-create ────────────────────────────────────────────────────

def _vendor_fields(contact) -> tuple[str, dict]:
    """(display_name, fields) for a QB Vendor from a crew Contact. DisplayName is
    added only on create (kept out of `fields`) so a sparse update can't trip a
    6240 rename conflict — same discipline as _customer_fields."""
    full = f"{contact.first_name or ''} {contact.last_name or ''}".strip()
    display = _safe_name(full or (contact.email or "") or f"Crew {contact.id}", 100)
    fields = {
        "GivenName": (contact.first_name or "")[:100],
        "FamilyName": (contact.last_name or "")[:100],
    }
    if (getattr(contact, "email", "") or "").strip():
        fields["PrimaryEmailAddr"] = {"Address": contact.email}
    if (getattr(contact, "phone", "") or "").strip():
        fields["PrimaryPhone"] = {"FreeFormNumber": contact.phone}
    addr = _bill_addr(contact)
    if addr:
        fields["BillAddr"] = addr
    return display, fields


async def _query_vendor_id(conn, db, display_name, *, client_id, client_secret) -> str | None:
    found = await quickbooks.query(
        conn, db,
        f"SELECT Id FROM Vendor WHERE DisplayName = '{escape_query_value(display_name)}'",
        client_id=client_id, client_secret=client_secret,
    )
    return str(found[0].get("Id")) if found else None


async def find_or_create_vendor(conn, db, contact, *, client_id, client_secret) -> str:
    """Resolve a crew Contact to a QB Vendor id, caching it on contact.qb_vendor_id.
    On a 6240 duplicate-name fault the name may be owned by a Customer/Employee
    (QB enforces DisplayName uniqueness across all name-list entities), so we
    re-query Vendor and, if the name is not a vendor, retry with a disambiguated
    '{name} (Crew {id})'."""
    display, fields = _vendor_fields(contact)

    if contact.qb_vendor_id:
        # Best-effort: keep email/address in sync. A hiccup must not block the bill.
        try:
            current = await quickbooks.get_vendor(
                conn, db, contact.qb_vendor_id, client_id=client_id, client_secret=client_secret
            )
            if current.get("Id"):
                upd = dict(fields)
                upd["Id"] = str(current["Id"])
                upd["SyncToken"] = str(current.get("SyncToken", "0"))
                upd["sparse"] = True
                await quickbooks.update_vendor(
                    conn, db, upd, client_id=client_id, client_secret=client_secret
                )
        except QboApiError as e:
            print(f"[LTP] qbo: vendor sync skipped for {contact.qb_vendor_id} ({e.safe_message})", flush=True)
        return contact.qb_vendor_id

    qb_id = await _query_vendor_id(conn, db, display, client_id=client_id, client_secret=client_secret)
    if qb_id is None:
        payload = dict(fields)
        payload["DisplayName"] = display
        try:
            resp = await quickbooks.create_vendor(conn, db, payload, client_id=client_id, client_secret=client_secret)
            qb_id = str((resp.get("Vendor") or {}).get("Id"))
        except QboApiError as e:
            if e.fault_code != "6240":
                raise
            # Name taken — adopt if it's already a Vendor, else disambiguate.
            qb_id = await _query_vendor_id(conn, db, display, client_id=client_id, client_secret=client_secret)
            if qb_id is None:
                payload["DisplayName"] = _safe_name(f"{display} (Crew {contact.id})", 100)
                resp = await quickbooks.create_vendor(conn, db, payload, client_id=client_id, client_secret=client_secret)
                qb_id = str((resp.get("Vendor") or {}).get("Id"))

    contact.qb_vendor_id = qb_id
    await db.flush()
    return qb_id


# ── Bill payload ─────────────────────────────────────────────────────────────

def doc_number(period) -> str:
    """Human-readable, idempotent DocNumber PAY-{year2}-{number} (e.g. PAY-26-14) —
    the year + the payroll period's ordinal within it. Unique PER VENDOR per pay
    period (so the orphan-adoption queries scope by VendorRef). <=21 chars; falls
    back to the raw period index if the number-in-year wasn't resolved."""
    y, n = period.get("year2"), period.get("number")
    if y is None or n is None:
        return f"PAY-P{period.get('index')}"[:21]
    return f"PAY-{int(y):02d}-{int(n)}"[:21]


def _line_desc(day) -> str:
    tier = day.get("tier") or ""
    base = f"{day.get('project_name') or 'Payout'} · {day.get('date') or ''}"
    return (base + (f" · {tier}" if tier else ""))[:1000]


def build_bill_lines(billable, accounts) -> list[dict]:
    """One line per payout day, split by expense account only when a day's roles
    map to different accounts. Each day's lines sum EXACTLY to that day's payable:
    the primary (largest-base) account line absorbs day-level adjustments and any
    rounding residual. Raises PayoutNotBillable if no account can be resolved."""
    lines = []
    for day in billable:
        groups = {}   # account_id -> cents (base, from unit costs)
        order = []    # first-seen account order -> deterministic primary
        for u in day.get("units") or []:
            acct = accounts["by_service"].get(u.get("service_id")) or accounts["default_expense"]
            if not acct:
                raise PayoutNotBillable("no expense account configured for this payout")
            if acct not in groups:
                groups[acct] = 0
                order.append(acct)
            groups[acct] += int(round(u["amount"] * 100))
        payable_cents = int(round(day["payable"] * 100))
        if not order:
            # No unit costs (e.g. a no-show day with only an adjustment).
            acct = accounts["default_expense"]
            if not acct:
                raise PayoutNotBillable("no default expense account for an adjustment-only day")
            order = [acct]
            groups[acct] = 0
        # Primary absorbs adjustments + rounding residual so lines reconcile.
        primary = max(order, key=lambda a: (groups[a], -order.index(a)))
        non_primary = sum(groups[a] for a in order if a != primary)
        desc = _line_desc(day)
        for a in order:
            cents = (payable_cents - non_primary) if a == primary else groups[a]
            if cents == 0:
                continue
            lines.append({"account_id": a, "amount": round(cents / 100.0, 2), "description": desc})
    return lines


def build_bill_payload(vendor_id, lines, accounts, period, doc_no) -> dict:
    payload = {
        "VendorRef": {"value": str(vendor_id)},
        "Line": [{
            "DetailType": "AccountBasedExpenseLineDetail",
            "Amount": ln["amount"],
            "Description": ln["description"],
            "AccountBasedExpenseLineDetail": {"AccountRef": {"value": str(ln["account_id"])}},
        } for ln in lines],
        "TxnDate": period["end"],
        "DueDate": period.get("pay_day") or period["end"],
        "DocNumber": doc_no,
        "PrivateNote": (f"Crew payout — {period.get('label') or (period['start'] + ' – ' + period['end'])}")[:1000],
    }
    if accounts.get("ap"):
        payload["APAccountRef"] = {"value": str(accounts["ap"])}
    return payload


def _line_signature(doc_no, period, lines) -> str:
    parts = [doc_no or "", period["start"], period["end"], period.get("pay_day") or ""]
    for ln in sorted(lines, key=lambda x: (x["account_id"], x["description"], x["amount"])):
        parts.append("%s|%s|%.2f" % (ln["account_id"], ln["description"], ln["amount"]))
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def plan_bill(contact_id, draft, period, accounts) -> dict:
    """Pure: turn a payout draft into the bill's billable days, total, lines,
    DocNumber, and line-signature — or raise PayoutNotBillable. Shared by the
    preview (report what would post) and push (what actually posts) so the two
    can never disagree."""
    billable = [d for d in draft["days"] if int(round(d["payable"] * 100)) != 0]
    if not billable:
        raise PayoutNotBillable("no signed, non-zero payout days in this period")
    total = js_round2(sum(d["payable"] for d in billable))
    if total <= 0:
        raise PayoutNotBillable(
            f"period nets ${total:.2f} (deductions exceed pay) — settle manually or issue a Vendor Credit"
        )
    lines = build_bill_lines(billable, accounts)
    if not lines:
        raise PayoutNotBillable("no billable bill lines after account resolution")
    doc_no = doc_number(period)
    return {"billable": billable, "total": total, "lines": lines,
            "doc_number": doc_no, "signature": _line_signature(doc_no, period, lines)}


# ── Persistence helpers ──────────────────────────────────────────────────────

async def _find_or_create_payout_bill(db, contact_id, period):
    q = select(models.PayoutBill).where(
        models.PayoutBill.contact_id == contact_id,
        models.PayoutBill.period_start == period["start"],
        models.PayoutBill.period_end == period["end"],
    )
    row = (await db.execute(q)).scalar_one_or_none()
    if row is not None:
        return row
    row = models.PayoutBill(contact_id=contact_id, period_start=period["start"],
                            period_end=period["end"], period_index=period.get("index"))
    db.add(row)
    try:
        async with db.begin_nested():   # SAVEPOINT — survive a concurrent insert
            await db.flush()
    except IntegrityError:
        row = (await db.execute(q)).scalar_one_or_none()   # lost the race — adopt the winner
    return row


async def _assert_not_double_billed(db, contact_id, pb_id, billable):
    """Refuse to bill a (contact, project, date) already billed on a DIFFERENT
    pay period. The payout_bill_lines unique constraint is the physical backstop;
    this pre-check yields a clean, actionable message before any QB write."""
    wanted = {(d["project_id"], d["date"]) for d in billable}
    existing = (await db.execute(
        select(models.PayoutBillLine).where(models.PayoutBillLine.contact_id == contact_id)
    )).scalars().all()
    for ln in existing:
        if ln.payout_bill_id != pb_id and (ln.project_id, ln.date) in wanted:
            raise PayoutNotBillable(
                f"{ln.date} (project {ln.project_id}) is already billed on another pay period"
            )


async def _replace_ledger(db, pb, contact_id, billable):
    await db.execute(delete(models.PayoutBillLine).where(models.PayoutBillLine.payout_bill_id == pb.id))
    for d in billable:
        db.add(models.PayoutBillLine(
            payout_bill_id=pb.id, contact_id=contact_id, project_id=d["project_id"],
            date=d["date"], amount=d["payable"], tier=d.get("tier"),
        ))
    await db.flush()


def _stamp(pb, user, etype, message, changes):
    actor = (user.name or user.email) if user is not None else "QuickBooks"
    actor_id = user.id if user is not None else None
    return append_activity(pb, id_prefix="qbp-", type_=etype, user=actor, user_id=actor_id,
                           message=message, now=datetime.now(timezone.utc), changes=changes)


async def _create_bill_with_recovery(conn, db, payload, vendor_id, *, client_id, client_secret) -> dict:
    """Create the bill, recovering from 6140 duplicate-DocNumber (adopt by
    DocNumber -> update) and DocNumber-not-allowed (retry without it). The
    DocNumber (PAY-{yy}-{n}) is shared across vendors, so the adopt-query scopes
    by VendorRef to find THIS vendor's bill."""
    try:
        resp = await quickbooks.create_bill(conn, db, payload, client_id=client_id, client_secret=client_secret)
        return resp.get("Bill") or {}
    except QboApiError as e:
        body = (e.body or "").lower()
        if e.fault_code == "6140" or "duplicate document number" in body:
            existing = await quickbooks.query(
                conn, db,
                f"SELECT Id, SyncToken FROM Bill WHERE DocNumber = '{escape_query_value(payload.get('DocNumber', ''))}'"
                f" AND VendorRef = '{escape_query_value(str(vendor_id))}'",
                client_id=client_id, client_secret=client_secret,
            )
            if existing:
                payload["Id"] = str(existing[0].get("Id"))
                payload["SyncToken"] = str(existing[0].get("SyncToken", "0"))
                payload["sparse"] = False
                resp = await quickbooks.update_bill(conn, db, payload, client_id=client_id, client_secret=client_secret)
                return resp.get("Bill") or {}
        if "docnumber" in body and payload.get("DocNumber"):
            payload.pop("DocNumber", None)
            resp = await quickbooks.create_bill(conn, db, payload, client_id=client_id, client_secret=client_secret)
            return resp.get("Bill") or {}
        raise


def _apply_bill_result(pb, resp_bill, total, sig, doc_no, period):
    if resp_bill.get("Id"):
        pb.qb_bill_id = str(resp_bill["Id"])
    if resp_bill.get("SyncToken") is not None:
        pb.qb_sync_token = str(resp_bill["SyncToken"])
    pb.amount = total
    pb.line_signature = sig
    pb.doc_number = doc_no
    pb.period_index = period.get("index")
    pb.qb_sync_status = "synced"
    pb.qb_synced_at = datetime.now(timezone.utc)
    pb.qb_last_error = None


# ── Push ─────────────────────────────────────────────────────────────────────

async def push_payout_bill(db, contact, draft, period, accounts, user=None, *,
                           client_id=None, client_secret=None) -> dict:
    """Create or update this crew member's vendor bill for the pay period,
    idempotently. `draft` is a backend.payouts.derive_payout_drafts entry (money
    from server-side snapshot re-derivation). Raises PayoutNotBillable for a
    per-contact skip; QboNotConnected/QboReconnectRequired propagate (batch
    abort). A per-contact QboApiError is caught, stamped, and returned as a
    failure so the batch continues."""
    if client_id is None or client_secret is None:
        client_id, client_secret = creds()
    conn = await quickbooks.load_connection(db)

    plan = plan_bill(contact.id, draft, period, accounts)   # raises PayoutNotBillable
    billable, total, lines = plan["billable"], plan["total"], plan["lines"]
    doc_no, sig = plan["doc_number"], plan["signature"]

    pb = await _find_or_create_payout_bill(db, contact.id, period)

    # Unchanged + already synced -> skip the QuickBooks round-trip entirely.
    if pb.qb_bill_id and pb.qb_sync_status == "synced" and pb.line_signature == sig:
        return {"ok": True, "action": "unchanged", "contactId": contact.id,
                "qbBillId": pb.qb_bill_id, "amount": pb.amount}

    await _assert_not_double_billed(db, contact.id, pb.id, billable)

    vendor_id = await find_or_create_vendor(conn, db, contact, client_id=client_id, client_secret=client_secret)
    payload = build_bill_payload(vendor_id, lines, accounts, period, doc_no)

    try:
        if pb.qb_bill_id is None:
            # Adopt an orphaned bill by DocNumber (don't depend on a 6140 firing —
            # QB's duplicate-bill-number check is a preference that may be off).
            existing = await quickbooks.query(
                conn, db,
                f"SELECT Id, SyncToken FROM Bill WHERE DocNumber = '{escape_query_value(doc_no)}'"
                f" AND VendorRef = '{escape_query_value(str(vendor_id))}'",
                client_id=client_id, client_secret=client_secret,
            )
            if existing:
                payload["Id"] = str(existing[0].get("Id"))
                payload["SyncToken"] = str(existing[0].get("SyncToken", "0"))
                payload["sparse"] = False
                resp_bill = (await quickbooks.update_bill(
                    conn, db, payload, client_id=client_id, client_secret=client_secret)).get("Bill") or {}
                action = "updated"
            else:
                resp_bill = await _create_bill_with_recovery(
                    conn, db, payload, vendor_id, client_id=client_id, client_secret=client_secret)
                action = "created"
        else:
            payload["Id"] = pb.qb_bill_id
            payload["SyncToken"] = pb.qb_sync_token or "0"
            payload["sparse"] = False
            try:
                resp = await quickbooks.update_bill(conn, db, payload, client_id=client_id, client_secret=client_secret)
            except QboApiError as e:
                if e.fault_code != "5010":  # stale SyncToken — refetch + retry once
                    raise
                current = await quickbooks.get_bill(conn, db, pb.qb_bill_id, client_id=client_id, client_secret=client_secret)
                payload["SyncToken"] = str(current.get("SyncToken", "0"))
                resp = await quickbooks.update_bill(conn, db, payload, client_id=client_id, client_secret=client_secret)
            resp_bill = resp.get("Bill") or {}
            action = "updated"
    except QboApiError as e:
        pb.qb_sync_status = "error"
        pb.qb_last_error = e.safe_message[:300]
        _stamp(pb, user, "qbo_payout_failed", f"QuickBooks payout bill failed for {period.get('label') or period['end']}",
               [{"cat": "Error", "detail": e.safe_message}])
        await db.flush()
        return {"ok": False, "action": "error", "contactId": contact.id, "error": e.safe_message}

    _apply_bill_result(pb, resp_bill, total, sig, doc_no, period)
    await _replace_ledger(db, pb, contact.id, billable)
    _stamp(pb, user, "qbo_payout_synced",
           f"Payout bill {action} for {period.get('label') or period['end']} — ${total:.2f}",
           [{"cat": "QB Bill Id", "detail": pb.qb_bill_id or "?"},
            {"cat": "Action", "detail": action},
            {"cat": "DocNumber", "detail": doc_no}])
    await db.flush()
    return {"ok": True, "action": action, "contactId": contact.id,
            "qbBillId": pb.qb_bill_id, "amount": pb.amount}
