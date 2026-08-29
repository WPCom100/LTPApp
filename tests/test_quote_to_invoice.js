#!/usr/bin/env node
// window.LTP_quoteToInvoiceDraft — turning a quote's delivered-but-uninvoiced
// lines into invoice sections.
//
// WHY THIS SUITE EXISTS
//   This is the hand-off where work that has been DONE becomes work that gets
//   BILLED. It decides how much of each line is still owed, how the new invoice
//   line is linked back to the quote it draws against, and how a quote's
//   discount converts to the percentage an invoice carries. Every one of those
//   is money.
//
//   Until it was lifted into components/domain-docs.js it lived inside the
//   quote builder's closure — 69 lines with a single setState at the end — so
//   none of it could be reached by a test.
//
// Pure Node, zero deps.
//   Run:  node tests/test_quote_to_invoice.js
"use strict";
const { loadDomain } = require("./_load_domain.js");
loadDomain();

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(n, g === w, g === w ? "" : "got " + g + " want " + w);
}

const CONV = window.LTP_quoteToInvoiceDraft;
ok("A0 LTP_quoteToInvoiceDraft is exported", typeof CONV === "function");

// Deterministic ids so assertions can name them.
function gidFactory() { let n = 0; return (p) => (p || "x") + "-" + (++n); }

function quote(items, over) {
  return Object.assign({
    id: 5,
    globalDiscount: { type: "none", value: 0 },
    sections: [{ id: "s1", label: "Audio", projectId: "pr1", customDates: false,
                 startDate: "", endDate: "", items: items }],
  }, over || {});
}
const line = (o) => Object.assign({ id: "i1", type: "product", name: "Console", qty: 5,
                                    unitPrice: 100, deliveredQty: 0, invoicedQty: 0 }, o);
const run = (q) => CONV(q, gidFactory());

// ── Nothing to bill ─────────────────────────────────────────────────────────
ok("A1 nothing delivered -> null", run(quote([line({})])) === null);
ok("A2 everything already invoiced -> null",
   run(quote([line({ deliveredQty: 5, invoicedQty: 5 })])) === null);
ok("A3 invoiced MORE than delivered (a correction) -> null",
   run(quote([line({ deliveredQty: 2, invoicedQty: 5 })])) === null);
ok("A4 only note rows -> null", run(quote([{ id: "n1", type: "note", text: "hi" }])) === null);
// A note row carrying quantity data is the case that proves the type check is
// doing the work. Without it, the qty guard masks the note guard entirely and
// deleting `if (it.type === "note")` passes every other assertion here.
ok("A4b a note row carrying deliveredQty is still never billed",
   run(quote([{ id: "n1", type: "note", text: "hi", qty: 3, unitPrice: 99,
               deliveredQty: 3, invoicedQty: 0 }])) === null);
eq("A4c ...and a note alongside a real line does not become an invoice line",
   run(quote([line({ deliveredQty: 2 }),
              { id: "n1", type: "note", text: "hi", deliveredQty: 9, invoicedQty: 0 }]))
     .invSections[0].items.map((x) => x.sourceItemId), ["i1"]);
ok("A5 no sections -> null", run(quote([], { sections: [] })) === null);

// ── The core arithmetic: delivered minus already-invoiced ───────────────────
let r = run(quote([line({ deliveredQty: 5, invoicedQty: 0 })]));
eq("A6 a fully delivered, uninvoiced line bills in full", r.invSections[0].items[0].qty, 5);
r = run(quote([line({ deliveredQty: 5, invoicedQty: 2 })]));
eq("A7 a partly invoiced line bills only the remainder", r.invSections[0].items[0].qty, 3);

// THE float guard. A bare 5.1 - 2.2 is 2.8999999999999995 in IEEE 754; that
// number would flow onto the invoice line, its display, and the QuickBooks Qty.
r = run(quote([line({ deliveredQty: 5.1, invoicedQty: 2.2 })]));
eq("A8 decimal quantities are rounded to 5dp, not left as float noise",
   r.invSections[0].items[0].qty, 2.9);
ok("A9 the raw subtraction really would have been wrong (guard is load-bearing)",
   5.1 - 2.2 !== 2.9, "float arithmetic changed; re-check the 5dp rounding");
r = run(quote([line({ deliveredQty: 0.3, invoicedQty: 0.1 })]));
eq("A10 another float case: 0.3 - 0.1", r.invSections[0].items[0].qty, 0.2);
// 5dp is deliberate: it matches QuickBooks' quantity precision.
r = run(quote([line({ deliveredQty: 1.000001, invoicedQty: 0 })]));
eq("A11 six decimal places round to five", r.invSections[0].items[0].qty, 1);

// ── The link back to the quote ──────────────────────────────────────────────
// modules/invoices.js keys every invoicedQty rollback on these fields.
r = run(quote([line({ id: "orig", deliveredQty: 4, invoicedQty: 1 })]));
const it = r.invSections[0].items[0];
eq("A12 sourceItemId names the quote line", it.sourceItemId, "orig");
eq("A13 sourceQuoteId names the quote", it.sourceQuoteId, 5);
eq("A14 linkedQty starts equal to the billed qty", it.linkedQty, 3);
eq("A15 the new line starts uninvoiced", it.invoicedQty, 0);
eq("A16 deliveredQty on the invoice line equals what is being billed", it.deliveredQty, 3);
ok("A17 the invoice line gets a NEW id, not the quote line's", it.id !== "orig");
eq("A18 price and name carry over", [it.unitPrice, it.name], [100, "Console"]);

// ── The quote is stamped as invoiced ────────────────────────────────────────
eq("A19 the quote line's invoicedQty advances to delivered",
   r.updatedQuoteSections[0].items[0].invoicedQty, 4);
ok("A20 the original quote object is not mutated",
   (function () {
     const q = quote([line({ deliveredQty: 4, invoicedQty: 1 })]);
     const before = JSON.stringify(q);
     run(q);
     return JSON.stringify(q) === before;
   })());
eq("A21 a note row survives the round-trip untouched",
   run(quote([line({ deliveredQty: 1 }), { id: "n1", type: "note", text: "careful" }]))
     .updatedQuoteSections[0].items[1], { id: "n1", type: "note", text: "careful" });

// ── Section attribution ─────────────────────────────────────────────────────
eq("A22 the section's projectId rides along to the invoice",
   r.invSections[0].projectId, "pr1");
eq("A23 the section label rides along", r.invSections[0].label, "Audio");
ok("A24 the invoice section gets a new id", r.invSections[0].id !== "s1");
// A section with nothing billable must not produce an empty invoice section.
const twoSecs = quote([line({ deliveredQty: 3 })]);
twoSecs.sections.push({ id: "s2", label: "Grip", items: [line({ id: "g1", deliveredQty: 0 })] });
eq("A25 a section with nothing to bill is omitted entirely",
   run(twoSecs).invSections.map((s) => s.label), ["Audio"]);
eq("A26 ...but it still comes back in the updated quote sections",
   run(twoSecs).updatedQuoteSections.map((s) => s.label), ["Audio", "Grip"]);

// ── Discount conversion ─────────────────────────────────────────────────────
// An invoice carries a percentage, so amount/target discounts convert.
const billable = [line({ deliveredQty: 5, invoicedQty: 0 })];   // adjusted = 500
eq("A27 no discount converts to no discount",
   run(quote(billable)).invoiceDiscount, { type: "none", value: 0 });
eq("A28 a percentage discount passes through unchanged",
   run(quote(billable, { globalDiscount: { type: "percent", value: 12.5 } })).invoiceDiscount,
   { type: "percent", value: 12.5 });
r = run(quote(billable, { globalDiscount: { type: "amount", value: 50 } }));
eq("A29 a $ amount converts to the equivalent percentage of the adjusted total",
   r.invoiceDiscount, { type: "percent", value: 10 });
ok("A30 the conversion is recorded so nobody has to reverse-engineer it",
   /50/.test(r.discountNote) && /10/.test(r.discountNote), r.discountNote);
r = run(quote(billable, { globalDiscount: { type: "target", value: 400 } }));
eq("A31 a target total converts to the discount percentage that reaches it",
   r.invoiceDiscount, { type: "percent", value: 20 });
ok("A32 the target conversion is recorded too", /target/.test(r.discountNote), r.discountNote);
eq("A33 a target ABOVE the total yields no discount rather than a negative one",
   run(quote(billable, { globalDiscount: { type: "target", value: 900 } })).invoiceDiscount,
   { type: "none", value: 0 });
eq("A34 a zero-amount discount yields no discount",
   run(quote(billable, { globalDiscount: { type: "amount", value: 0 } })).invoiceDiscount,
   { type: "none", value: 0 });
eq("A35 a missing globalDiscount is treated as none",
   run(quote(billable, { globalDiscount: null })).invoiceDiscount, { type: "none", value: 0 });
// The percentage is rounded to 2dp — an invoice discount is displayed.
r = run(quote(billable, { globalDiscount: { type: "amount", value: 33 } }));
eq("A36 the converted percentage is rounded to 2dp", r.invoiceDiscount.value, 6.6);

console.log("quote-to-invoice suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
