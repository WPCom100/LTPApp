#!/usr/bin/env node
// Regression suite for the money math in theme.js: quote & invoice totals,
// discounts, tax, payments, and reference strings. Pure Node, zero deps.
//   Run:  node tests/test_money_totals.js
"use strict";
const fs = require("fs");
const path = require("path");
// theme.js is now theme.js + components/domain-*.js; the loader reads the
// order straight out of index.html so it cannot drift from production.
require("./_load_domain.js").loadDomain();

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, g, e) { ok(n, g === e, "got " + JSON.stringify(g) + " exp " + JSON.stringify(e)); }
function near(n, g, e) { ok(n, Math.abs(g - e) < 0.005, "got " + g + " exp " + e); }

const QT = window.LTP_QUOTE_TOTALS, IT = window.LTP_INVOICE_TOTALS;
const QREF = window.LTP_QUOTE_REF, IREF = window.LTP_INVOICE_REF;

function items(arr) { return [{ items: arr }]; }
const line = (o) => Object.assign({ type: "service", qty: 1, unitPrice: 0 }, o);

// ── Invoice totals ───────────────────────────────────────────────────────────
eq("I0 null invoice -> zeros", IT(null).total, 0);
let inv = { sections: items([line({ unitPrice: 100, qty: 2 }), line({ unitPrice: 50, qty: 1 })]) };
near("I1 subtotal", IT(inv).subtotal, 250);
near("I1 total (no tax)", IT(inv).total, 250);
// `subtotal` is the ORIGINAL list price and `adjusted` the re-priced sum — the
// same split quotes, the client view and the PDF use. This function used to
// report only the adjusted figure, under the name `subtotal`, with no `adjusted`
// key at all; the invoice editor's "Adjustments" row compared subtotal against
// that missing key (always unequal) and so rendered "-$0.00" on every invoice.
inv = { sections: items([line({ unitPrice: 100, qty: 2, adjustedPrice: 80 }), line({ type: "note", unitPrice: 999 })]) };
near("I2 subtotal is the original list price", IT(inv).subtotal, 200);
near("I2 adjusted reflects the re-priced line", IT(inv).adjusted, 160);
near("I2 note rows carry no amount", IT(inv).total, 160);
// With no per-line override the two agree, so the adjustments row stays hidden.
inv = { sections: items([line({ unitPrice: 100, qty: 2 })]) };
eq("I2b no adjustment -> subtotal === adjusted", IT(inv).subtotal === IT(inv).adjusted, true);
inv = { sections: items([line({ unitPrice: 200 })]), globalDiscount: { type: "percent", value: 10 } };
near("I3 percent discount", IT(inv).discount, 20); near("I3 total after %", IT(inv).total, 180);
// "amount" is what the invoice builder's "$" option actually writes. This
// function used to match only "flat", so a $ discount computed as $0 here while
// the client's PDF and share link showed it applied — three parties, three
// totals. The "flat" case below is the legacy alias, which must keep working.
inv = { sections: items([line({ unitPrice: 200 })]), globalDiscount: { type: "amount", value: 30 } };
near("I4 amount discount (what the $ option writes)", IT(inv).discount, 30);
near("I4 total after amount", IT(inv).total, 170);
inv = { sections: items([line({ unitPrice: 200 })]), globalDiscount: { type: "flat", value: 30 } };
near("I4b flat is a legacy alias for amount", IT(inv).discount, 30);
near("I4b total after flat", IT(inv).total, 170);
inv = { sections: items([line({ unitPrice: 200 })]), globalDiscount: { type: "target", value: 150 } };
near("I5 target discount = subtotal-target", IT(inv).discount, 50); near("I5 total = target", IT(inv).total, 150);
// Clamped the same way quotes are (Q5) and the same way the PDF + client view
// clamp — otherwise an over-discount shows a NEGATIVE total in the app while
// the customer-facing documents show 0.
inv = { sections: items([line({ unitPrice: 50 })]), globalDiscount: { type: "amount", value: 999 } };
near("I5b over-large amount can't go negative", IT(inv).total, 0);
near("I5b discount capped at subtotal", IT(inv).discount, 50);
inv = { sections: items([line({ unitPrice: 50 })]), globalDiscount: { type: "percent", value: 150 } };
near("I5c over-100% can't go negative", IT(inv).total, 0);
// An unrecognized type is a no-op, never a silent partial discount.
inv = { sections: items([line({ unitPrice: 200 })]), globalDiscount: { type: "bogus", value: 30 } };
near("I5d unknown discount type is ignored", IT(inv).total, 200);
// Invoices are QuickBooks-tax-authoritative, exactly like quotes (Q6 below).
// A flat percentage used to apply here as a pre-push estimate, which made this
// function alone claim a tax that pdf_generator.py::_calc_totals and
// client-view.js::calcTotals both reported as zero — and the invoice editor
// folded it into the TOTAL without ever drawing a tax row to explain it. The
// setting is gone; a stray global must not bring the behaviour back.
window.LTP_TAX_RATE = 10;   // deliberately hostile: nothing may read this
inv = { sections: items([line({ unitPrice: 100 })]) };
near("I6 flat rate ignored — tax is QuickBooks-only", IT(inv).tax, 0);
near("I6 total carries no estimated tax", IT(inv).total, 100);
inv = { sections: items([line({ unitPrice: 100 })]), qbTaxTotal: 7.25 };
near("I7 qbTaxTotal is the tax", IT(inv).tax, 7.25); near("I7 total", IT(inv).total, 107.25);
inv = { sections: items([line({ unitPrice: 100 })]), qbTaxTotal: 0 };
near("I7b an explicit $0 tax (exempt client) stays $0", IT(inv).tax, 0);
inv = { sections: items([line({ unitPrice: 100 })]), payments: [{ amount: 40 }, { amount: 25 }] };
near("I8 paid sums payments", IT(inv).paid, 65); near("I8 balance", IT(inv).balance, 35);
inv = { sections: items([line({ unitPrice: 100 })]), payments: [{ amount: 150 }] };
near("I9 balance never negative", IT(inv).balance, 0);
eq("I10 invoice ref", IREF({ id: 7, invoiceDate: "2026-05-01" }), "INV-2026-007");
eq("I11 invoice ref null", IREF(null), "INV-?");

// ── Quote totals ─────────────────────────────────────────────────────────────
let q = { sections: items([line({ unitPrice: 100, qty: 2, cost: 60 }), line({ unitPrice: 50, adjustedPrice: 40 })]) };
near("Q1 subtotal (orig)", QT(q).subtotal, 250);
near("Q1 adjusted (uses adjustedPrice)", QT(q).adjusted, 240);
near("Q1 cost", QT(q).cost, 120);
near("Q1 total == adjusted (no tax)", QT(q).total, 240);
q = { sections: items([line({ unitPrice: 200 })]), globalDiscount: { type: "percent", value: 25 } };
near("Q2 percent discount", QT(q).preTax, 150);
q = { sections: items([line({ unitPrice: 200 })]), globalDiscount: { type: "amount", value: 30 } };
near("Q3 amount discount", QT(q).preTax, 170);
q = { sections: items([line({ unitPrice: 200 })]), globalDiscount: { type: "target", value: 120 } };
near("Q4 target discount", QT(q).preTax, 120);
q = { sections: items([line({ unitPrice: 50 })]), globalDiscount: { type: "amount", value: 999 } };
near("Q5 discount can't go negative", QT(q).preTax, 0);
// The two totals functions must stay interchangeable on discount vocabulary —
// that's the property whose absence produced the invoice "$" bug.
q = { sections: items([line({ unitPrice: 200 })]), globalDiscount: { type: "flat", value: 30 } };
near("Q5b quotes also read the legacy flat alias", QT(q).preTax, 170);
// Quotes are QuickBooks-tax-authoritative: tax comes from qbTaxTotal (set by
// the temporary-estimate flow). Null → $0. Same hostile global as above.
window.LTP_TAX_RATE = 8;
q = { sections: items([line({ unitPrice: 100 })]) };
near("Q6 flat rate ignored on quotes", QT(q).tax, 0); near("Q6 total no QB tax", QT(q).total, 100);
q = { sections: items([line({ unitPrice: 100 })]), qbTaxTotal: 8.25 };
near("Q6b qbTaxTotal applied", QT(q).tax, 8.25); near("Q6b total with QB tax", QT(q).total, 108.25);
// `preTax` is the money the business actually keeps, and it is what the builder
// derives its discount row and its margin from. Reading those off `total`
// instead made an undiscounted quote show a NEGATIVE discount (−tax) the moment
// tax was calculated, and counted sales tax as profit.
near("Q6c preTax excludes tax", QT(q).preTax, 100);
eq("Q6c discount row base is tax-free", QT(q).adjusted - QT(q).preTax, 0);
q = { sections: items([line({ unitPrice: 200, cost: 50 })]), globalDiscount: { type: "amount", value: 40 }, qbTaxTotal: 13.2 };
near("Q6d preTax is discounted but untaxed", QT(q).preTax, 160);
near("Q6d margin ignores sales tax", QT(q).preTax - QT(q).cost, 110);
near("Q6d discount amount is tax-free", QT(q).adjusted - QT(q).preTax, 40);
near("Q6d customer still pays tax-inclusive", QT(q).total, 173.2);
eq("Q7 quote ref Q-YYYY-NNN", QREF({ id: 3, createdDate: "2026-02-09" }), "Q-2026-003");
eq("Q8 note rows skipped", (function () { return QT({ sections: items([line({ type: "note", unitPrice: 500 }), line({ unitPrice: 25 })]) }).subtotal; })(), 25);
// Fees are ordinary priced lines that edit unitPrice directly and never set
// adjustedPrice — so a fee's subtotal == its adjusted (no line-adjustment delta),
// and it sums alongside other line types.
let qf = { sections: items([line({ type: "fee", unitPrice: 250, qty: 2 }), line({ type: "service", unitPrice: 100, qty: 1 })]) };
near("Q9 fee sums into subtotal", QT(qf).subtotal, 600);
near("Q9 fee never creates adjustment delta (adjusted == subtotal)", QT(qf).adjusted, 600);
near("Q9 fee cost defaults 0", QT(qf).cost, 0);
let invf = { sections: items([line({ type: "fee", unitPrice: 250, qty: 2 }), line({ type: "note", unitPrice: 999 })]) };
near("Q10 invoice totals count fee, skip note", IT(invf).subtotal, 500);

// ── isOverdue / displayStatus ────────────────────────────────────────────────
const today = window.LTP_todayISO();
const past = "2000-01-01", future = "2999-01-01";
eq("S1 overdue when past + unpaid sent", window.LTP_isOverdue({ dueDate: past, status: "sent" }), true);
eq("S2 not overdue when draft", window.LTP_isOverdue({ dueDate: past, status: "draft" }), false);
eq("S3 not overdue when paid", window.LTP_isOverdue({ dueDate: past, status: "paid" }), false);
eq("S4 not overdue when future", window.LTP_isOverdue({ dueDate: future, status: "sent" }), false);
eq("S5 displayStatus paid", window.LTP_displayStatus({ status: "paid" }), "paid");
eq("S6 displayStatus partial", window.LTP_displayStatus({ status: "sent", sections: items([line({ unitPrice: 100 })]), payments: [{ amount: 40 }] }), "partial");
eq("S7 displayStatus overdue", window.LTP_displayStatus({ status: "sent", dueDate: past, sections: items([line({ unitPrice: 100 })]) }), "overdue");

// ── Fee quick-pick names helper (editable in Quotes → Fees) ──────────────────
const FQN = window.LTP_feeQuickNames;
eq("F1 default list when unset", JSON.stringify(FQN({})), JSON.stringify(window.LTP_FEE_QUICKNAMES_DEFAULT));
eq("F2 default list when null settings", JSON.stringify(FQN(null)), JSON.stringify(window.LTP_FEE_QUICKNAMES_DEFAULT));
eq("F3 custom list passes through", JSON.stringify(FQN({ feeQuickNames: ["A", "B"] })), JSON.stringify(["A", "B"]));
eq("F4 trims + drops blanks", JSON.stringify(FQN({ feeQuickNames: ["  Lodging  ", "", "   ", "Travel"] })), JSON.stringify(["Lodging", "Travel"]));
eq("F5 de-dupes case-insensitively, keeps first form/order", JSON.stringify(FQN({ feeQuickNames: ["Travel", "travel", "Lodging"] })), JSON.stringify(["Travel", "Lodging"]));
eq("F6 explicit empty list stays empty (no fallback)", JSON.stringify(FQN({ feeQuickNames: [] })), JSON.stringify([]));
eq("F7 non-array falls back to default", JSON.stringify(FQN({ feeQuickNames: "Lodging" })), JSON.stringify(window.LTP_FEE_QUICKNAMES_DEFAULT));

// ── Shared section totals (was duplicated in both builders) ─────────────────
// modules/quotes-builder.js and modules/invoices.js each carried their own
// sectionTotals(). The loops matched, but the RETURNS did not:
//   quotes   -> { subtotal, margin: sub - cost }
//   invoices -> { subtotal, cost }
// `margin` and `cost` are different numbers, so a naive merge would have been a
// money bug. They now share window.LTP_sectionTotals, which returns all three.
//
// These assertions re-implement BOTH originals verbatim and diff them against
// the shared helper over a matrix — the only way to show the merge was lossless
// rather than merely plausible.
const ST = window.LTP_sectionTotals;

function oldQuoteSectionTotals(sec) {          // verbatim, pre-merge
  var sub = 0, cst = 0;
  sec.items.forEach(function(it) {
    if (it.type === "note") return;
    var qty = Number(it.qty) || 0;
    var eff = it.adjustedPrice != null ? (Number(it.adjustedPrice) || 0) : (Number(it.unitPrice) || 0);
    sub += eff * qty;
    cst += (Number(it.cost) || 0) * qty;
  });
  return { subtotal: sub, margin: sub - cst };
}
function oldInvoiceSectionTotals(sec) {        // verbatim, pre-merge
  var sub = 0, cost = 0;
  sec.items.forEach(function(it) {
    if (it.type === "note") return;
    var qty = Number(it.qty) || 0;
    var eff = it.adjustedPrice != null ? (Number(it.adjustedPrice) || 0) : (Number(it.unitPrice) || 0);
    sub += eff * qty;
    cost += (Number(it.cost) || 0) * qty;
  });
  return { subtotal: sub, cost: cost };
}

const QTY = [0, 1, 2, 3.5, -1, null, undefined, "2", "", "abc", NaN];
const PRICE = [0, 100, 1234.56, -50, null, undefined, "250", "", "x"];
const COST = [0, 60, 999.99, null, undefined, "40", "", "y"];
const ADJ = [undefined, null, 0, 75, "80", ""];
let cases = 0, mismatchQ = 0, mismatchI = 0, firstBad = "";
QTY.forEach((qty) => PRICE.forEach((unitPrice) => COST.forEach((cost) => ADJ.forEach((adjustedPrice) => {
  const item = { id: "i", type: "product", qty, unitPrice, cost };
  if (adjustedPrice !== undefined) item.adjustedPrice = adjustedPrice;
  const sec = { id: "s", items: [item, { id: "n", type: "note", text: "ignored" }] };
  cases++;
  const now = ST(sec), oq = oldQuoteSectionTotals(sec), oi = oldInvoiceSectionTotals(sec);
  const okQ = Object.is(now.subtotal, oq.subtotal) && Object.is(now.margin, oq.margin);
  const okI = Object.is(now.subtotal, oi.subtotal) && Object.is(now.cost, oi.cost);
  if (!okQ) { mismatchQ++; if (!firstBad) firstBad = JSON.stringify({ item, now, oq }); }
  if (!okI) { mismatchI++; if (!firstBad) firstBad = JSON.stringify({ item, now, oi }); }
})))); 
eq("ST1 matrix ran the full cross-product", cases, QTY.length * PRICE.length * COST.length * ADJ.length);
eq("ST2 shared helper matches the old QUOTE version on every case", mismatchQ + "|" + firstBad, "0|" + (mismatchQ ? firstBad : ""));
eq("ST3 shared helper matches the old INVOICE version on every case", mismatchI + "|" + firstBad, "0|" + (mismatchI ? firstBad : ""));

// margin and cost are distinct — the assertion that stops a future "simplify"
// from collapsing them back into one field.
const marginCase = ST({ items: [{ type: "product", qty: 2, unitPrice: 100, cost: 30 }] });
eq("ST4 subtotal is price x qty", marginCase.subtotal, 200);
eq("ST5 cost is cost x qty", marginCase.cost, 60);
eq("ST6 margin is subtotal - cost, NOT cost", marginCase.margin, 140);
eq("ST7 margin and cost really differ", marginCase.margin === marginCase.cost, false);
eq("ST8 adjustedPrice wins over unitPrice", ST({ items: [{ type: "product", qty: 1, unitPrice: 100, adjustedPrice: 70 }] }).subtotal, 70);
eq("ST9 adjustedPrice of 0 is honoured, not treated as absent", ST({ items: [{ type: "product", qty: 1, unitPrice: 100, adjustedPrice: 0 }] }).subtotal, 0);
eq("ST10 note rows never contribute", ST({ items: [{ type: "note", text: "x", qty: 9, unitPrice: 9 }] }).subtotal, 0);
eq("ST11 missing items array is safe", ST({}).subtotal, 0);
eq("ST12 null section is safe", ST(null).subtotal, 0);

console.log("money-totals suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
