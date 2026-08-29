"""Sales tax plumbing — does the QuickBooks-computed tax reach the customer?

Sales tax is QuickBooks-authoritative: an invoice gets `qb_tax_total` from the
push response (qbo_sync.push_invoice), a quote from the temporary-estimate flow
(qbo_sync.get_quote_estimate_tax). Everything downstream — the PDF, the public
share link, the app — is supposed to read that one number so all three agree.

Two ways that broke:

  1. `quote_dict` did not emit `qbTaxTotal` at all, while `invoice_dict` did.
     Every consumer of a quote's serialized shape (the PDF route, the public
     view, the client-view JS) therefore saw `None` and rendered $0 tax with a
     tax-EXCLUSIVE grand total — permanently, no matter how often the tax was
     recalculated. The quote's send flow had already been careful to compute the
     tax before mailing, so the email body quoted a tax-inclusive total while the
     linked quote and its PDF quoted a smaller one.

  2. The PDF's "Line Adjustments" row is epsilon-guarded (`> 0.01`), so it hides
     when nothing was re-priced. Pinned here because the app-side rows were NOT
     guarded that way and drifted (see tests/test_money_totals.js).

Covers:
  - quote_dict and invoice_dict both carry qbTaxTotal (the core bug).
  - quote_dict carries qbTaxSignature, so the app can tell fresh tax from stale.
  - _calc_totals folds the tax into the grand total for a quote AND an invoice.
  - a null tax means $0 and a tax-exclusive total (nothing invented).
  - an explicit $0 (tax-exempt client) is preserved, not treated as "unknown".
  - the adjustments/tax rows' visibility thresholds.
  - a RENDERED PDF really draws "Sales Tax:" and a tax-inclusive TOTAL for both
    document kinds, and really omits both rows when there is nothing to show.
    These drive generate_pdf and record the draw calls, so they exercise the
    guards rather than restating them.
  - a customer's tax exemption outranks the `taxable: true` both builders stamp
    on every line.
  - a push whose response carries no TotalTax clears the previous tax instead of
    leaving it beside a refreshed grand total it contradicts.
  - editing the lines, the discount or the client invalidates a stored tax.

Runs both as pytest and as a plain script:
    python tests/test_sales_tax_plumbing.py
"""
import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

from backend import models  # noqa: E402
from backend.pdf_generator import _calc_totals  # noqa: E402
from backend.routes._shared import invoice_dict, quote_dict  # noqa: E402

_failures = []


def _check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        _failures.append(name + (f"  [{detail}]" if detail else ""))
        print(f"  FAIL {name}" + (f"  [{detail}]" if detail else ""))
    assert cond, f"{name} {detail}"


def _sections(unit_price=1000, qty=10, adjusted=None):
    item = {"type": "service", "unitPrice": unit_price, "qty": qty}
    if adjusted is not None:
        item["adjustedPrice"] = adjusted
    return [{"items": [item]}]


def _quote(**kw):
    base = dict(id=1, client_type="company", share_token="tok-" + "q" * 20,
                sections=_sections(), global_discount={}, qb_tax_total=None,
                qb_tax_signature=None)
    base.update(kw)
    return models.Quote(**base)


def _invoice(**kw):
    base = dict(id=1, client_type="company", share_token="tok-" + "i" * 20,
                sections=_sections(), global_discount={}, qb_tax_total=None)
    base.update(kw)
    return models.Invoice(**base)


# ── Serialization: the shape the PDF route + public view consume ─────────────

def test_both_serializers_carry_the_tax():
    q = quote_dict(_quote(qb_tax_total=812.50, qb_tax_signature="sig-abc"))
    i = invoice_dict(_invoice(qb_tax_total=812.50))
    _check("quote_dict includes qbTaxTotal", q.get("qbTaxTotal") == 812.50, str(q.get("qbTaxTotal")))
    _check("invoice_dict includes qbTaxTotal", i.get("qbTaxTotal") == 812.50, str(i.get("qbTaxTotal")))
    # Without the signature the app cannot tell a fresh tax from one computed
    # before the line items changed.
    _check("quote_dict includes qbTaxSignature", q.get("qbTaxSignature") == "sig-abc",
           str(q.get("qbTaxSignature")))


def test_tax_reaches_the_grand_total_for_quotes_and_invoices():
    # $10,000 of work + $812.50 of tax = $10,812.50 on BOTH document kinds.
    for kind, d in (("quote", quote_dict(_quote(qb_tax_total=812.50))),
                    ("invoice", invoice_dict(_invoice(qb_tax_total=812.50)))):
        t = _calc_totals(d)
        _check(f"{kind}: subtotal excludes tax", abs(t["subtotal"] - 10000) < 0.005, str(t["subtotal"]))
        _check(f"{kind}: tax read from qbTaxTotal", abs(t["tax"] - 812.50) < 0.005, str(t["tax"]))
        _check(f"{kind}: grand total is tax-inclusive", abs(t["total"] - 10812.50) < 0.005, str(t["total"]))


def test_uncalculated_tax_is_zero_not_invented():
    # Null means "QuickBooks hasn't said yet" → $0 and a tax-exclusive total.
    # Nothing estimates a rate here; the app-side helpers match (test_money_totals.js).
    for kind, d in (("quote", quote_dict(_quote())), ("invoice", invoice_dict(_invoice()))):
        t = _calc_totals(d)
        _check(f"{kind}: null tax → $0", t["tax"] == 0.0, str(t["tax"]))
        _check(f"{kind}: null tax → tax-exclusive total", abs(t["total"] - 10000) < 0.005, str(t["total"]))


def test_explicit_zero_tax_is_preserved():
    # A tax-exempt client stores 0.0, which must survive as 0.0 — the exempt
    # path in qbo_sync.get_quote_estimate_tax writes exactly this.
    d = quote_dict(_quote(qb_tax_total=0.0))
    _check("exempt quote serializes 0.0", d.get("qbTaxTotal") == 0.0, str(d.get("qbTaxTotal")))
    _check("exempt quote totals to the pre-tax amount", abs(_calc_totals(d)["total"] - 10000) < 0.005)


def test_a_discount_is_applied_before_the_tax_is_added():
    # The tax QuickBooks returns is computed on the discounted lines, so the PDF
    # must add it to the DISCOUNTED figure, never to the list price.
    d = invoice_dict(_invoice(global_discount={"type": "percent", "value": 10}, qb_tax_total=731.25))
    t = _calc_totals(d)
    _check("discount applied to the pre-tax figure", abs(t["preTax"] - 9000) < 0.005, str(t["preTax"]))
    _check("total = discounted + tax", abs(t["total"] - 9731.25) < 0.005, str(t["total"]))


# ── Row visibility thresholds ────────────────────────────────────────────────

def test_row_visibility_thresholds():
    # These mirror the guards in pdf_generator._draw_totals. The adjustments row
    # appears only once a line has actually been re-priced; the app-side rows use
    # the same 1c threshold (modules/invoices.js, modules/quotes-builder.js).
    plain = _calc_totals(invoice_dict(_invoice()))
    _check("no re-pricing → adjustments row hidden",
           abs(plain["subtotal"] - plain["adjusted"]) <= 0.01,
           f'{plain["subtotal"]} vs {plain["adjusted"]}')

    repriced = _calc_totals(invoice_dict(_invoice(sections=_sections(adjusted=900))))
    _check("a re-priced line → adjustments row shows",
           abs(repriced["subtotal"] - repriced["adjusted"]) > 0.01,
           f'{repriced["subtotal"]} vs {repriced["adjusted"]}')
    _check("adjustment is the difference", abs((repriced["subtotal"] - repriced["adjusted"]) - 1000) < 0.005)

    # Sub-cent float residue must NOT surface a "-$0.00" row.
    residue = _calc_totals(invoice_dict(_invoice(sections=_sections(unit_price=0.1, qty=3, adjusted=0.1))))
    _check("float residue stays below the threshold",
           abs(residue["subtotal"] - residue["adjusted"]) <= 0.01,
           f'{residue["subtotal"]} vs {residue["adjusted"]}')

    _check("a $0 tax draws no tax row", not (_calc_totals(invoice_dict(_invoice()))["tax"] > 0.005))
    _check("a real tax draws a tax row", _calc_totals(invoice_dict(_invoice(qb_tax_total=812.50)))["tax"] > 0.005)


# ── Durability: the stored figure must not outlive what it was computed on ───

def test_a_customer_exemption_outranks_a_per_line_flag():
    from backend.qbo_sync import _line_taxable
    # Both builders stamp `taxable: true` on every line they create and only
    # offer the per-line checkbox when the CUSTOMER is taxable — so for an exempt
    # party that flag is a default, never a considered override. Reading it as an
    # override billed sales tax to non-profits and resellers.
    _check("exempt customer: a defaulted true does not tax the line",
           _line_taxable({"taxable": True}, False) is False)
    _check("exempt customer: an unflagged line stays exempt",
           _line_taxable({}, False) is False)
    # For a taxable customer the override still works in the direction the UI
    # actually offers it: exempting one line.
    _check("taxable customer: a line can be exempted",
           _line_taxable({"taxable": False}, True) is False)
    _check("taxable customer: an unflagged line is taxed",
           _line_taxable({}, True) is True)


def test_a_push_without_tax_clears_the_previous_tax():
    from backend.qbo_sync import _apply_qb_result

    class _Row:
        qb_invoice_id = qb_sync_token = None
        qb_tax_total = 87.50
        qb_total_amt = 1087.50
        qb_sync_status = qb_synced_at = qb_last_error = None

    row = _Row()
    # The customer went tax-exempt: QuickBooks now returns no TxnTaxDetail and a
    # smaller TotalAmt. Both must move together — leaving the old tax behind
    # produced a row whose grand total its own tax figure contradicts.
    _apply_qb_result(row, {"Id": "42", "SyncToken": "3", "TotalAmt": 1000.00})
    _check("tax cleared when QuickBooks returns none", row.qb_tax_total == 0.0, str(row.qb_tax_total))
    _check("grand total refreshed alongside it", row.qb_total_amt == 1000.00, str(row.qb_total_amt))
    _check("row is internally consistent", abs((row.qb_total_amt - row.qb_tax_total) - 1000.00) < 0.005)

    row2 = _Row()
    _apply_qb_result(row2, {"Id": "42", "TxnTaxDetail": {"TotalTax": 12.25}, "TotalAmt": 1012.25})
    _check("a real tax is still stored", row2.qb_tax_total == 12.25, str(row2.qb_tax_total))


def test_editing_the_document_invalidates_the_stored_tax():
    from backend.routes.api import _tax_inputs_fingerprint

    q = _quote(qb_tax_total=825.0)
    before = _tax_inputs_fingerprint(q)
    _check("an unrelated edit leaves the fingerprint alone",
           _tax_inputs_fingerprint(_quote(qb_tax_total=825.0)) == before)

    # Each of these changes what QuickBooks would compute, so each must be
    # detected — otherwise the share link keeps quoting tax for lines that are
    # no longer on the document.
    for label, changed in (
        ("re-pricing the lines", _quote(sections=_sections(unit_price=200))),
        ("dropping a line", _quote(sections=[{"items": []}])),
        ("adding a discount", _quote(global_discount={"type": "percent", "value": 10})),
        ("switching the client", _quote(company_id=999)),
        ("switching client type", _quote(client_type="contact", client_contact_id=7)),
    ):
        _check(f"{label} invalidates the tax", _tax_inputs_fingerprint(changed) != before)


# ── End to end: what the rendered PDF actually draws ─────────────────────────

def _render_and_capture(kind, entity):
    """Render a real PDF and return every string the generator drew.

    Exercises pdf_generator's actual drawing path — the row guards included —
    rather than restating their predicates in the test. reportlab compresses its
    page streams, so we record the draw calls instead of parsing the output.
    """
    import io

    from reportlab.pdfgen.canvas import Canvas

    from backend import pdf_generator

    drawn = []
    orig_str, orig_right = Canvas.drawString, Canvas.drawRightString

    def spy_str(self, x, y, text, *a, **k):
        drawn.append(str(text))
        return orig_str(self, x, y, text, *a, **k)

    def spy_right(self, x, y, text, *a, **k):
        drawn.append(str(text))
        return orig_right(self, x, y, text, *a, **k)

    Canvas.drawString, Canvas.drawRightString = spy_str, spy_right
    try:
        buf = io.BytesIO()
        pdf_generator.generate_pdf(buf, kind, entity, None, None, None, {}, "Tester")
        assert buf.getvalue().startswith(b"%PDF"), "generator produced no PDF"
    finally:
        Canvas.drawString, Canvas.drawRightString = orig_str, orig_right
    return drawn


def test_the_rendered_pdf_draws_the_tax_row_for_both_kinds():
    for kind, d in (("quote", quote_dict(_quote(qb_tax_total=812.50))),
                    ("invoice", invoice_dict(_invoice(qb_tax_total=812.50)))):
        drawn = _render_and_capture(kind, d)
        _check(f"{kind} PDF draws a Sales Tax label", "Sales Tax:" in drawn, str(drawn[-14:]))
        _check(f"{kind} PDF prints the tax amount", "$812.50" in drawn, str(drawn[-14:]))
        _check(f"{kind} PDF prints the tax-inclusive total", "$10,812.50" in drawn, str(drawn[-14:]))


def test_the_rendered_pdf_omits_the_tax_row_when_there_is_no_tax():
    for kind, d in (("quote", quote_dict(_quote())), ("invoice", invoice_dict(_invoice()))):
        drawn = _render_and_capture(kind, d)
        _check(f"{kind} PDF draws no Sales Tax row", "Sales Tax:" not in drawn)
        _check(f"{kind} PDF total excludes tax", "$10,000.00" in drawn, str(drawn[-10:]))


def test_the_rendered_pdf_shows_adjustments_only_once_one_exists():
    plain = _render_and_capture("invoice", invoice_dict(_invoice()))
    _check("no adjustment → no Line Adjustments row", "Line Adjustments:" not in plain)

    repriced = _render_and_capture("invoice", invoice_dict(_invoice(sections=_sections(adjusted=900))))
    _check("a re-priced line → Line Adjustments row", "Line Adjustments:" in repriced)
    _check("and it prints the difference", "-$1,000.00" in repriced, str(repriced[-14:]))


def main() -> int:
    tests = [
        test_both_serializers_carry_the_tax,
        test_tax_reaches_the_grand_total_for_quotes_and_invoices,
        test_uncalculated_tax_is_zero_not_invented,
        test_explicit_zero_tax_is_preserved,
        test_a_discount_is_applied_before_the_tax_is_added,
        test_row_visibility_thresholds,
        test_a_customer_exemption_outranks_a_per_line_flag,
        test_a_push_without_tax_clears_the_previous_tax,
        test_editing_the_document_invalidates_the_stored_tax,
        test_the_rendered_pdf_draws_the_tax_row_for_both_kinds,
        test_the_rendered_pdf_omits_the_tax_row_when_there_is_no_tax,
        test_the_rendered_pdf_shows_adjustments_only_once_one_exists,
    ]
    for t in tests:
        print(f"\n{t.__name__}:")
        t()
    print()
    if _failures:
        print(f"sales-tax-plumbing suite — FAIL: {len(_failures)}")
        for f in _failures:
            print(f"  x {f}")
        return 1
    print("sales-tax-plumbing suite — all assertions passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
