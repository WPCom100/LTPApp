"""QuickBooks-driven automatic payment receipts.

Background poller + server-side composer that emails a client their payment
receipt as soon as the linked QuickBooks invoice is marked paid (its QB
``Balance`` reaches 0). Mirrors what an admin does manually today — the
"Send Receipt" modal that pops after an in-app payment settles the balance —
but driven by QuickBooks instead of an in-app click, on a poll cadence.

Why poll instead of a webhook
=============================
A webhook would need a public, authenticated endpoint and Intuit subscription
plumbing. The owner asked to "sync every couple of hours," and the candidate
set (linked invoices not yet receipted) is tiny for this business, so a simple
periodic poll — started from the FastAPI lifespan exactly like the session
sweeper in backend/main.py — is the right amount of machinery.

Sender identity (owner's decision)
==================================
Every auto-receipt is sent from the Gmail of the admin who connected
QuickBooks (``QboConnection.connected_by_user_id``). If that admin's Gmail is
unavailable (never granted / token revoked / refresh fails mid-cycle), the
receipt is CACHED — ``receipt_email_status='pending'`` — and retried on each
later cycle, so it goes out once "the admin's Gmail connection is
reestablished." Reconciling the invoice to paid still happens regardless (that
is QuickBooks truth); only the email waits.

Idempotency
===========
``Invoice.receipt_email_status`` is the state machine (null → pending/failed →
sent). The poller only looks at invoices whose status is null/pending/failed,
and the manual "Send Receipt" path stamps 'sent' too (routes/email.py), so a
client is never double-receipted from the two paths.

Server-side composition
=======================
Customer emails are normally composed in the browser and relayed through
POST /api/email/send. The poller has no browser, so this module reproduces that
pipeline server-side: resolve the ``paymentReceipt`` template, render the
themed {{header}} action box (the Python twin of theme.js::LTP_renderHeader for
kind="receipt"), substitute {{signature}} + per-recipient {{viewUrl}}, wrap in
the shared ``email_shell``, and hand the result to ``gmail.send`` — reusing the
helpers in routes/email.py and routes/crew.py so an auto-receipt is
byte-for-byte the same shape as a manually sent one.
"""
import secrets
from datetime import datetime, timezone
from html import escape

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from backend import gmail, models, qbo_sync, quickbooks
from backend.database import async_session
from backend.email_validate import RecipientError, parse_recipients
from backend.routes._shared import load_settings
from backend.sanitize import email_html


# Safety cap on QB fetches per cycle so a misconfiguration can't turn the loop
# into an unbounded API storm. Logged when hit. Far above any realistic count
# of open-and-unreceipted invoices for this business.
_MAX_INVOICES_PER_CYCLE = 200

# Treated as "paid in full." QB balances are currency, but compare with a small
# epsilon so floating dust never reads as an outstanding balance.
_PAID_EPSILON = 0.01


# ── Money / date / line-item formatting (mirror modules/invoices.js) ─────────

def _num(x) -> float:
    try:
        return float(x or 0)
    except (TypeError, ValueError):
        return 0.0


def _money(amount) -> str:
    """'$1,234.50'. Receipts always show two decimals."""
    return "${:,.2f}".format(_num(amount))


_METHOD_LABELS = {
    "check": "Check", "ach": "ACH", "credit_card": "Credit Card",
    "cash": "Cash", "wire": "Wire", "other": "Other", "quickbooks": "QuickBooks",
}


def _payment_lines(payments: list) -> str:
    """One indented line per payment — the same shape openReceiptModal builds:
    '  Fri, Jun 12, 2026 — $1,234.50 via QuickBooks (ref)'."""
    from backend.routes.crew import _fmt_iso_date
    out = []
    for p in (payments or []):
        when = _fmt_iso_date(p.get("date"))
        method = _METHOD_LABELS.get(p.get("method"), p.get("method") or "")
        ref = (p.get("reference") or "").strip()
        out.append("  " + when + " — " + _money(p.get("amount")) + " via " + method
                   + ((" (" + ref + ")") if ref else ""))
    return "\n".join(out)


# ── Receipt {{header}} action box (Python twin of theme.js LTP_renderHeader) ──

def render_receipt_header(ref_number: str, project_name: str, total: str) -> str:
    """The themed receipt action box: reference + project + total summary and a
    single "View Receipt" button linking to {{viewUrl}} (left literal here — the
    send path swaps in the per-recipient tracked URL, exactly like the browser).

    Structurally identical to theme.js::LTP_renderHeader(kind="receipt", …) so an
    auto-receipt's header matches a manually-composed one. The summary values are
    HTML-escaped (defense in depth; the whole body is bleach-sanitized downstream
    too)."""
    ref = escape(ref_number or "")
    proj = escape(project_name or "")
    tot = escape(total or "")
    return (
        '<div style="padding:0px">'
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" '
        'style="width:100%;margin-top:5px;background-color:#f7f9fa;border:1px solid #eceef0;border-radius:10px">'
        '<tbody><tr><td style="padding:22px;text-align:center">'
        '<div style="font-size:12px;color:#8a949e;text-transform:uppercase;letter-spacing:0.06em">' + ref + '</div>'
        '<div style="font-size:19px;font-weight:bold;color:#233038;margin:4px 0 2px">' + proj + '</div>'
        '<div style="font-size:14px;color:#233038;margin-bottom:18px">' + tot + '</div>'
        '<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto">'
        '<tbody><tr><td style="background-color:#f15927;border-radius:7px">'
        '<a href="{{viewUrl}}" style="display:inline-block;padding:14px 38px;font-size:15px;'
        'font-weight:bold;color:#ffffff;text-decoration:none">View Receipt</a>'
        '</td></tr></tbody></table>'
        '</td></tr></tbody></table></div>'
    )


# Fallbacks if the workspace never customized the paymentReceipt template (the
# rich default lives in data/settings.js, not the DB, until an admin saves
# Settings). Kept in sync with modules/invoices.js openReceiptModal.
# Fallback used ONLY when the DB has no saved paymentReceipt template — a fresh
# deploy where Settings were never saved (load_settings reads the DB, which
# doesn't carry the data/settings.js defaults until an admin clicks Save). It is
# pinned BYTE-FOR-BYTE to data/settings.js::emailTemplates.paymentReceipt so the
# auto-receipt sends exactly the template an admin sees in Settings — the same
# pattern as backend/routes/email.py::_FALLBACK_SIGNATURE. Any edit to the
# data/settings.js default MUST be mirrored here (test_qbo_receipts pins it).
_FALLBACK_SUBJECT = "{{refNumber}} — Payment Received — Thank You"
_FALLBACK_BODY = (
    "{{header}}\n\nHi {{clientName}},\n\nThank you! We have received your payment for "
    "{{refNumber}} ({{projectName}}).\n\n{{lineItems}}\n\nBalance: $0.00 — Paid in Full\n\n"
    "This email serves as your receipt. Please keep it for your records.\n\n{{signature}}"
)


def _resolve(template: str, vars: dict) -> str:
    """Substitute {{key}} from vars; leave unknown tokens literal (so {{header}},
    {{signature}}, {{viewUrl}} survive for the block/recipient passes). Mirror of
    theme.js::LTP_resolveTemplate."""
    out = template or ""
    for k, v in vars.items():
        out = out.replace("{{" + k + "}}", "" if v is None else str(v))
    return out


def build_receipt_email(settings_data: dict, sender: models.User, text_vars: dict,
                        header_html: str) -> tuple[str, str]:
    """Pure composition: resolve the paymentReceipt template against ``text_vars``,
    drop in the receipt header + the sender's signature at block level, and return
    ``(subject, inner_html)``. ``inner_html`` still carries a literal {{viewUrl}}
    for the send path to swap per recipient; it is NOT yet shell-wrapped."""
    # Lazy import: routes.crew imports routes.email which lazy-imports crew back;
    # importing here (not at module top) keeps the import graph acyclic.
    from backend.routes.crew import _paragraphs_to_html
    from backend.routes.email import _render_signature

    templates = (settings_data.get("emailTemplates") or {})
    tmpl = templates.get("paymentReceipt") or {}
    subject = _resolve(tmpl.get("subject") or _FALLBACK_SUBJECT, text_vars)
    body = _resolve(tmpl.get("body") or _FALLBACK_BODY, text_vars)

    signature_html = _render_signature(sender, settings_data)
    inner = _paragraphs_to_html(body, {
        "{{header}}": header_html,
        "{{signature}}": signature_html,
    })
    return subject, inner


def _finalize_html(inner_html: str, view_url: str, settings_data: dict) -> str:
    """Substitute {{viewUrl}}, sanitize, and wrap in the shared branded shell —
    the same final stages routes/email.py runs before the wire."""
    from backend.routes.crew import email_shell, _email_brand
    rendered = inner_html.replace("{{viewUrl}}", view_url).replace("{{masthead}}", "")
    sanitized = email_html(rendered)
    return email_html(email_shell(sanitized, _email_brand(settings_data)))


# ── Recipient resolution (mirror modules/invoices.js openReceiptModal) ───────

async def _resolve_recipient(db: AsyncSession, invoice: models.Invoice) -> tuple[str, str]:
    """Return (email, client_name) for the invoice's billing party. Contact-billed
    → that contact; company-billed → the company's first linked contact (preferring
    one that actually has an email). Returns ('', '') if none is resolvable."""
    if invoice.client_contact_id:
        r = await db.execute(select(models.Contact).where(models.Contact.id == invoice.client_contact_id))
        ct = r.scalar_one_or_none()
        if ct:
            name = (f"{ct.first_name or ''} {ct.last_name or ''}").strip()
            return (ct.email or "").strip(), name
        return "", ""
    if invoice.company_id:
        r = await db.execute(select(models.Contact))
        linked = [c for c in r.scalars().all() if invoice.company_id in (c.company_ids or [])]
        if not linked:
            return "", ""
        # Prefer a contact with an email on file.
        chosen = next((c for c in linked if (c.email or "").strip()), linked[0])
        return (chosen.email or "").strip(), (chosen.first_name or "").strip()
    return "", ""


# ── Local reconciliation: bring the app invoice in line with "paid in QB" ────

def _reconcile_paid(invoice: models.Invoice, total_amt: float, now: datetime) -> bool:
    """Idempotently mark the invoice paid and, if the app doesn't already know
    about the payment, record ONE synthetic 'Paid via QuickBooks' payment so the
    app shows paid-in-full and the receipt's line items render. Returns True if
    anything changed (caller stamps an activity entry once)."""
    changed = False
    today = now.strftime("%Y-%m-%d")
    if invoice.status != "paid":
        invoice.status = "paid"
        changed = True
    if not (invoice.paid_date or "").strip():
        invoice.paid_date = today
        changed = True
    payments = list(invoice.payments or [])
    app_paid = sum(_num(p.get("amount")) for p in payments)
    total = _num(total_amt)
    remainder = round(total - app_paid, 2)
    if total > 0 and remainder > _PAID_EPSILON:
        payments.append({
            "id": "pay-qb-" + secrets.token_urlsafe(6),
            "date": today,
            "amount": remainder,
            "method": "quickbooks",
            "reference": "Paid via QuickBooks",
            "notes": "Recorded automatically when the QuickBooks invoice was marked paid.",
        })
        invoice.payments = payments
        flag_modified(invoice, "payments")
        changed = True
    return changed


# ── Per-invoice processing ───────────────────────────────────────────────────

async def _send_receipt(db, invoice, sender, settings_data, to_list, cc_list,
                        subject, inner_html, now, *, client_id, client_secret) -> str:
    """Mint per-recipient tracking tokens, persist EmailRecipient rows, finalize
    the HTML with the primary recipient's {{viewUrl}}, send via the sender's
    Gmail, and stamp activity — the server-side twin of routes/email.py's send
    block. Returns the new receipt_email_status ('sent' | 'pending' | 'failed').
    """
    from backend.routes.email import (
        _build_view_url, _stamp_email_failed, _stamp_email_sent,
    )

    primary_tracking = secrets.token_urlsafe(24)
    rows = [models.EmailRecipient(
        entity_type="invoice", entity_id=invoice.id, share_token=invoice.share_token,
        recipient_email=to_list[0], recipient_role="to",
        tracking_token=primary_tracking, sent_at=now, sent_by_user_id=sender.id,
    )]
    for addr in to_list[1:]:
        rows.append(models.EmailRecipient(
            entity_type="invoice", entity_id=invoice.id, share_token=invoice.share_token,
            recipient_email=addr, recipient_role="to",
            tracking_token=secrets.token_urlsafe(24), sent_at=now, sent_by_user_id=sender.id))
    for addr in cc_list:
        rows.append(models.EmailRecipient(
            entity_type="invoice", entity_id=invoice.id, share_token=invoice.share_token,
            recipient_email=addr, recipient_role="cc",
            tracking_token=secrets.token_urlsafe(24), sent_at=now, sent_by_user_id=sender.id))
    db.add_all(rows)
    await db.flush()

    view_url = _build_view_url("invoice", invoice.share_token, primary_tracking)
    final_html = _finalize_html(inner_html, view_url, settings_data)

    try:
        resp = await gmail.send(
            user=sender, db=db, client_id=client_id, client_secret=client_secret,
            to=to_list, cc=cc_list, subject=subject, html_body=final_html,
            reply_to=(settings_data.get("emailReplyTo") or "").strip() or None,
        )
    except gmail.GmailReconnectRequired:
        # Cache: the admin's Gmail is unavailable. Drop the recipient rows and
        # retry next cycle once the connection is reestablished.
        for r in rows:
            await db.delete(r)
        await db.flush()
        return "pending"
    except gmail.GmailSendError as e:
        for r in rows:
            await db.delete(r)
        _stamp_email_failed(invoice, sender, to_list, cc_list, subject, str(e), now)
        await db.flush()
        return "failed"

    gmail_message_id = resp.get("id") if isinstance(resp, dict) else None
    for r in rows:
        r.gmail_message_id = gmail_message_id
    _stamp_email_sent(invoice, sender, to_list, cc_list, subject, gmail_message_id, now)
    invoice.receipt_email_sent_at = now
    await db.flush()
    return "sent"


async def _process_invoice(db, conn, invoice, sender, settings_data, *,
                           client_id, client_secret, can_email) -> str:
    """Fetch this invoice's QB balance; if paid, reconcile locally and (if able)
    email the receipt. Returns a short outcome string for the cycle summary."""
    qb_inv = await quickbooks.get_invoice(
        conn, db, invoice.qb_invoice_id, client_id=client_id, client_secret=client_secret,
    )
    balance = qb_inv.get("Balance")
    total_amt = qb_inv.get("TotalAmt")
    invoice.qb_balance = _num(balance) if balance is not None else invoice.qb_balance

    # Not paid yet (or QB has no real total) — nothing to do this cycle.
    if balance is None or _num(balance) > _PAID_EPSILON or _num(total_amt) <= 0:
        await db.flush()
        return "open"

    now = datetime.now(timezone.utc)
    ref = qbo_sync._invoice_ref(invoice)
    if _reconcile_paid(invoice, total_amt, now):
        qbo_sync._stamp(invoice, None, "paid",
                        f"Marked paid in QuickBooks ({ref})",
                        [{"cat": "Balance", "detail": "$0.00 — Paid in full"},
                         {"cat": "Source", "detail": "QuickBooks"}])

    # Defensive: a manual receipt may have claimed the slot between query + now.
    if invoice.receipt_email_status == "sent":
        await db.flush()
        return "already_sent"

    if not can_email:
        invoice.receipt_email_status = "pending"
        await db.flush()
        return "pending"

    # Resolve + validate the recipient.
    to_email, client_name = await _resolve_recipient(db, invoice)
    try:
        to_list = parse_recipients(to_email, allow_empty=False)
    except RecipientError:
        to_list = []
    if not to_list:
        invoice.receipt_email_status = "failed"
        qbo_sync._stamp(invoice, sender, "email_failed",
                        "Payment receipt could not be sent — no valid client email on file",
                        [{"cat": "Reference", "detail": ref}])
        await db.flush()
        return "failed"

    # Compose.
    project_name = ""
    if invoice.project_id:
        pr = await db.execute(select(models.Project).where(models.Project.id == invoice.project_id))
        proj = pr.scalar_one_or_none()
        if proj:
            project_name = proj.name or ""
    total_str = _money(total_amt)
    text_vars = {
        "companyName": (settings_data.get("companyName") or "LTP"),
        "refNumber": ref,
        "projectName": project_name,
        "clientName": client_name or "there",
        "total": total_str,
        "lineItems": "Payments Received:\n" + _payment_lines(invoice.payments),
    }
    header_html = render_receipt_header(ref, project_name, total_str)
    subject, inner_html = build_receipt_email(settings_data, sender, text_vars, header_html)

    try:
        cc_list = parse_recipients((tmpl_cc(settings_data, text_vars)), allow_empty=True)
    except RecipientError:
        cc_list = []

    status = await _send_receipt(
        db, invoice, sender, settings_data, to_list, cc_list, subject, inner_html, now,
        client_id=client_id, client_secret=client_secret,
    )
    invoice.receipt_email_status = status
    await db.flush()
    return status


def tmpl_cc(settings_data: dict, text_vars: dict) -> str:
    """Resolved cc line from the paymentReceipt template (usually empty)."""
    tmpl = (settings_data.get("emailTemplates") or {}).get("paymentReceipt") or {}
    return _resolve(tmpl.get("cc") or "", text_vars)


# ── Poll cycle ───────────────────────────────────────────────────────────────

async def _candidate_invoices(db: AsyncSession) -> list[models.Invoice]:
    """Invoices the poller should check this cycle: linked to QuickBooks, not a
    draft, and not yet receipted (status null/pending/failed). Bounded by the
    safety cap."""
    result = await db.execute(
        select(models.Invoice).where(
            models.Invoice.qb_invoice_id.isnot(None),
            models.Invoice.status != "draft",
            or_(
                models.Invoice.receipt_email_status.is_(None),
                models.Invoice.receipt_email_status.in_(["pending", "failed"]),
            ),
        ).order_by(models.Invoice.id).limit(_MAX_INVOICES_PER_CYCLE + 1)
    )
    return list(result.scalars().all())


async def run_receipt_poll() -> dict:
    """One full poll cycle. Opens its own session and commits per invoice so a
    mid-batch failure never loses progress (same self-contained pattern as the
    session sweeper). Returns a small summary dict for logging/tests. Never
    raises for an individual invoice — those are isolated and logged."""
    summary = {"checked": 0, "sent": 0, "pending": 0, "failed": 0, "paid": 0, "skipped": False}
    client_id, client_secret = qbo_sync.creds()

    async with async_session() as db:
        try:
            conn = await quickbooks.load_connection(db)
        except quickbooks.QboNotConnected:
            summary["skipped"] = True
            return summary

        settings_data = await load_settings(db)

        # Sender = the admin who connected QuickBooks. No usable Gmail → cache
        # everything this cycle and retry once reconnected.
        sender = None
        if conn.connected_by_user_id:
            r = await db.execute(select(models.User).where(models.User.id == conn.connected_by_user_id))
            sender = r.scalar_one_or_none()
        can_email = sender is not None and bool(sender.gmail_refresh_token)

        invoices = await _candidate_invoices(db)
        if len(invoices) > _MAX_INVOICES_PER_CYCLE:
            invoices = invoices[:_MAX_INVOICES_PER_CYCLE]
            print(f"[LTP] qbo-receipts: candidate set capped at {_MAX_INVOICES_PER_CYCLE}; "
                  "remaining invoices handled next cycle", flush=True)

        for invoice in invoices:
            summary["checked"] += 1
            try:
                outcome = await _process_invoice(
                    db, conn, invoice, sender, settings_data,
                    client_id=client_id, client_secret=client_secret, can_email=can_email,
                )
                # outcome ∈ open | sent | pending | failed | already_sent
                if outcome != "open":
                    summary["paid"] += 1
                if outcome in ("sent", "pending", "failed"):
                    summary[outcome] += 1
                await db.commit()
            except (quickbooks.QboReconnectRequired, quickbooks.QboApiError) as e:
                # A QB-side error (auth/transport) aborts the whole cycle — the
                # connection or API is unhealthy, so the rest will fail too.
                await db.rollback()
                print(f"[LTP] qbo-receipts: aborting cycle on QuickBooks error: {e}", flush=True)
                break
            except Exception as e:  # pragma: no cover - isolate one bad invoice
                await db.rollback()
                print(f"[LTP] qbo-receipts: invoice {invoice.id} failed (continuing): {e}", flush=True)

    return summary
