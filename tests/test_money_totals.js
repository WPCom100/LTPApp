#!/usr/bin/env node
// Regression suite for the money math in theme.js: quote & invoice totals,
// discounts, tax, payments, and reference strings. Pure Node, zero deps.
//   Run:  node tests/test_money_totals.js
"use strict";
const fs = require("fs");
const path = require("path");
global.window = {};
let _seq = 0;
window.LTP_genId = (p) => (p || "x") + "-" + (++_seq);
(0, eval)(fs.readFileSync(path.join(__dirname, "..", "theme.js"), "utf8"));

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, g, e) { ok(n, g === e, "got " + JSON.stringify(g) + " exp " + JSON.stringify(e)); }
function near(n, g, e) { ok(n, Math.abs(g - e) < 0.005, "got " + g + " exp " + e); }

const QT = window.LTP_QUOTE_TOTALS, IT = window.LTP_INVOICE_TOTALS;
const QREF = window.LTP_QUOTE_REF, IREF = window.LTP_INVOICE_REF;

function items(arr) { return [{ items: arr }]; }
const line = (o) => Object.assign({ type: "service", qty: 1, unitPrice: 0 }, o);

// ── Invoice totals ───────────────────────────────────────────────────────────
window.LTP_TAX_RATE = 0;
eq("I0 null invoice -> zeros", IT(null).total, 0);
let inv = { sections: items([line({ unitPrice: 100, qty: 2 }), line({ unitPrice: 50, qty: 1 })]) };
near("I1 subtotal", IT(inv).subtotal, 250);
near("I1 total (no tax)", IT(inv).total, 250);
inv = { sections: items([line({ unitPrice: 100, qty: 2, adjustedPrice: 80 }), line({ type: "note", unitPrice: 999 })]) };
near("I2 adjustedPrice used + note skipped", IT(inv).subtotal, 160);
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
window.LTP_TAX_RATE = 10;
inv = { sections: items([line({ unitPrice: 100 })]) };
near("I6 tax via rate", IT(inv).tax, 10); near("I6 total with tax", IT(inv).total, 110);
inv = { sections: items([line({ unitPrice: 100 })]), qbTaxTotal: 7.25 };
near("I7 qbTaxTotal overrides rate", IT(inv).tax, 7.25); near("I7 total", IT(inv).total, 107.25);
window.LTP_TAX_RATE = 0;
inv = { sections: items([line({ unitPrice: 100 })]), payments: [{ amount: 40 }, { amount: 25 }] };
near("I8 paid sums payments", IT(inv).paid, 65); near("I8 balance", IT(inv).balance, 35);
inv = { sections: items([line({ unitPrice: 100 })]), payments: [{ amount: 150 }] };
near("I9 balance never negative", IT(inv).balance, 0);
eq("I10 invoice ref", IREF({ id: 7, invoiceDate: "2026-05-01" }), "INV-2026-007");
eq("I11 invoice ref null", IREF(null), "INV-?");

// ── Quote totals ─────────────────────────────────────────────────────────────
window.LTP_TAX_RATE = 0;
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
// Quotes are QuickBooks-tax-authoritative: the flat LTP_TAX_RATE is IGNORED;
// tax comes from qbTaxTotal (set by the temporary-estimate flow). Null → $0.
window.LTP_TAX_RATE = 8;
q = { sections: items([line({ unitPrice: 100 })]) };
near("Q6 flat rate ignored on quotes", QT(q).tax, 0); near("Q6 total no QB tax", QT(q).total, 100);
q = { sections: items([line({ unitPrice: 100 })]), qbTaxTotal: 8.25 };
near("Q6b qbTaxTotal applied", QT(q).tax, 8.25); near("Q6b total with QB tax", QT(q).total, 108.25);
eq("Q7 quote ref Q-YYYY-NNN", QREF({ id: 3, createdDate: "2026-02-09" }), "Q-2026-003");
eq("Q8 note rows skipped", (function () { window.LTP_TAX_RATE = 0; return QT({ sections: items([line({ type: "note", unitPrice: 500 }), line({ unitPrice: 25 })]) }).subtotal; })(), 25);
// Fees are ordinary priced lines that edit unitPrice directly and never set
// adjustedPrice — so a fee's subtotal == its adjusted (no line-adjustment delta),
// and it sums alongside other line types.
window.LTP_TAX_RATE = 0;
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
window.LTP_TAX_RATE = 0;
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

console.log("money-totals suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
