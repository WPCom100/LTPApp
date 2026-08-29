#!/usr/bin/env node
// window.LTP_quoteChanges / window.LTP_invoiceChanges — the save-confirmation
// change summaries.
//
// WHY THIS SUITE EXISTS
//   These decide what a user is shown before they commit an edit to a document
//   that has already gone to a client. Getting them wrong means someone
//   approves a change they were never told about — a price moved, a due date
//   moved, a payment vanished — so they are worth testing, and until now they
//   could not be: the quote version sat at file scope inside an IIFE (readable,
//   not reachable) and the invoice version was buried inside the 1,908-line
//   InvoiceBuilder closure.
//
//   Both moved verbatim into components/domain-docs.js, which is what makes
//   this file possible.
//
// Pure Node, zero deps.
//   Run:  node tests/test_doc_changes.js
"use strict";
const { loadDomain } = require("./_load_domain.js");
loadDomain();

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function has(n, rows, cat, detailPart) {
  const row = (rows || []).find((r) => r.cat === cat);
  if (!row) return ok(n, false, "no row for category " + JSON.stringify(cat)
    + "; got " + JSON.stringify((rows || []).map((r) => r.cat)));
  ok(n, detailPart == null || String(row.detail).indexOf(detailPart) !== -1,
     "detail was " + JSON.stringify(row.detail));
}
function noRow(n, rows, cat) {
  ok(n, !(rows || []).some((r) => r.cat === cat),
     "unexpected row: " + JSON.stringify((rows || []).find((r) => r.cat === cat)));
}

const QC = window.LTP_quoteChanges, IC = window.LTP_invoiceChanges;
ok("LTP_quoteChanges is exported", typeof QC === "function");
ok("LTP_invoiceChanges is exported", typeof IC === "function");

const PROJECTS = [{ id: "pr1", name: "Spring Shoot" }, { id: "pr2", name: "Autumn Shoot" }];
const COMPANIES = [{ id: "co1", name: "Acme Co" }, { id: "co2", name: "Globex" }];

function quote(over) {
  return Object.assign({
    id: 1, createdDate: "2026-08-01", status: "draft", clientType: "company",
    companyId: "co1", projectId: "pr1", expiryDate: "2026-09-01",
    globalDiscount: { type: "none", value: 0 }, terms: "", notes: "",
    sections: [{ id: "s1", label: "Audio", items: [
      { id: "i1", type: "product", name: "Console", qty: 1, unitPrice: 1000, cost: 400 },
    ] }],
  }, over || {});
}
function invoice(over) {
  return Object.assign(quote(), {
    id: 7, invoiceDate: "2026-08-05", dueDate: "2026-09-04", payments: [],
  }, over || {});
}
// Deep-clone so a mutation in a test cannot leak into the "before" side.
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── Null handling (the builders call these with a possibly-absent baseline) ──
ok("Q1 null before returns null", QC(null, quote(), PROJECTS, COMPANIES) === null);
ok("Q2 null after returns null", QC(quote(), null, PROJECTS, COMPANIES) === null);
ok("I1 null before returns null", IC(null, invoice(), PROJECTS, COMPANIES) === null);
ok("I2 null after returns null", IC(invoice(), null, PROJECTS, COMPANIES) === null);

// ── No change means no rows ─────────────────────────────────────────────────
ok("Q3 identical documents report nothing",
   (QC(quote(), clone(quote()), PROJECTS, COMPANIES) || []).length === 0,
   JSON.stringify(QC(quote(), clone(quote()), PROJECTS, COMPANIES)));
ok("I3 identical invoices report nothing",
   (IC(invoice(), clone(invoice()), PROJECTS, COMPANIES) || []).length === 0,
   JSON.stringify(IC(invoice(), clone(invoice()), PROJECTS, COMPANIES)));

// ── Money is the row that matters most ──────────────────────────────────────
const qPriceUp = clone(quote());
qPriceUp.sections[0].items[0].unitPrice = 1500;
has("Q4 a unit-price change is reported as a total change",
    QC(quote(), qPriceUp, PROJECTS, COMPANIES), "Quote Total", "1,000.00");
const qQty = clone(quote());
qQty.sections[0].items[0].qty = 3;
has("Q5 a quantity change moves the total", QC(quote(), qQty, PROJECTS, COMPANIES), "Quote Total");
const qDisc = clone(quote());
qDisc.globalDiscount = { type: "percent", value: 10 };
has("Q6 a discount change moves the total", QC(quote(), qDisc, PROJECTS, COMPANIES), "Quote Total");

const iPrice = clone(invoice());
iPrice.sections[0].items[0].unitPrice = 1500;
has("I4 a unit-price change is reported as a total change",
    IC(invoice(), iPrice, PROJECTS, COMPANIES), "Invoice Total", "1,000.00");

// A sub-cent difference must NOT be reported — the code rounds to cents, and a
// float artefact showing up as a "change" would train users to ignore the list.
// 0.004 survives into the total but rounds to the same cent. (1e-9 does not
// work here: LTP_QUOTE_TOTALS rounds it away before the comparison is even
// reached, so the assertion would pass with the rounding removed.)
const qTiny = clone(quote());
qTiny.sections[0].items[0].unitPrice = 1000.004;
noRow("Q7 a sub-cent difference is not reported as a total change",
      QC(quote(), qTiny, PROJECTS, COMPANIES), "Quote Total");
const iTiny = clone(invoice());
iTiny.sections[0].items[0].unitPrice = 1000.004;
noRow("I10 a sub-cent difference is not reported on invoices either",
      IC(invoice(), iTiny, PROJECTS, COMPANIES), "Invoice Total");
// ...and one cent MORE must be reported, so the guard above is not just
// asserting that the row never appears.
const qCent = clone(quote());
qCent.sections[0].items[0].unitPrice = 1000.01;
has("Q7b a one-cent difference IS reported",
    QC(quote(), qCent, PROJECTS, COMPANIES), "Quote Total");

// ── Status and dates ────────────────────────────────────────────────────────
has("Q8 status change", QC(quote(), clone(quote({ status: "sent" })), PROJECTS, COMPANIES),
    "Status", "draft");
has("I5 status change", IC(invoice(), clone(invoice({ status: "sent" })), PROJECTS, COMPANIES),
    "Status", "draft");
has("I6 due-date change", IC(invoice(), clone(invoice({ dueDate: "2026-10-01" })), PROJECTS, COMPANIES),
    "Due Date");
has("I7 an unset due date reads as 'Not set', not as blank",
    IC(invoice({ dueDate: "" }), clone(invoice()), PROJECTS, COMPANIES), "Due Date", "Not set");

// ── Entity names are resolved, not shown as raw ids ─────────────────────────
// This is the reason projects/companies are parameters at all.
// Assert BOTH sides resolve. Checking only the "after" name lets a mutation
// that leaves the "before" side as a raw id slip through.
const qProj = JSON.stringify(QC(quote(), clone(quote({ projectId: "pr2" })), PROJECTS, COMPANIES));
ok("Q9 a project change shows the OLD name", qProj.indexOf("Spring Shoot") !== -1, qProj);
ok("Q9b a project change shows the NEW name", qProj.indexOf("Autumn Shoot") !== -1, qProj);
ok("Q9c a project change leaks no raw id",
   qProj.indexOf("pr1") === -1 && qProj.indexOf("pr2") === -1, qProj);
const qComp = JSON.stringify(QC(quote(), clone(quote({ companyId: "co2" })), PROJECTS, COMPANIES));
ok("Q10 a company change shows the OLD name", qComp.indexOf("Acme Co") !== -1, qComp);
ok("Q10b a company change shows the NEW name", qComp.indexOf("Globex") !== -1, qComp);
ok("Q10c a company change leaks no raw id",
   qComp.indexOf("co1") === -1 && qComp.indexOf("co2") === -1, qComp);
const iComp = JSON.stringify(IC(invoice(), clone(invoice({ companyId: "co2" })), PROJECTS, COMPANIES));
ok("I11 invoices resolve both entity names too",
   iComp.indexOf("Acme Co") !== -1 && iComp.indexOf("Globex") !== -1
   && iComp.indexOf("co1") === -1 && iComp.indexOf("co2") === -1, iComp);

// Missing lookup lists must not throw — the builders can call these early.
ok("Q11 undefined projects/companies do not throw", (function () {
  try { QC(quote(), clone(quote({ projectId: "pr2" }))); return true; }
  catch (e) { return "threw: " + e.message; }
})() === true);
ok("I8 undefined projects/companies do not throw", (function () {
  try { IC(invoice(), clone(invoice({ projectId: "pr2" }))); return true; }
  catch (e) { return "threw: " + e.message; }
})() === true);

// Quotes and invoices resolve a project through DIFFERENT code — quotes with a
// direct projects.find(), invoices via window.LTP_diffEntityName — so covering
// one proves nothing about the other.
const iProj = JSON.stringify(IC(invoice(), clone(invoice({ projectId: "pr2" })), PROJECTS, COMPANIES));
ok("I12 an invoice project change shows the OLD name", iProj.indexOf("Spring Shoot") !== -1, iProj);
ok("I13 an invoice project change shows the NEW name", iProj.indexOf("Autumn Shoot") !== -1, iProj);
ok("I14 an invoice project change leaks no raw id",
   iProj.indexOf("pr1") === -1 && iProj.indexOf("pr2") === -1, iProj);

// ── Per-section rental periods (quotes only) ────────────────────────────────
// A section can override the quote's dates. Changing that window changes what
// the client is billed for, so it has to appear in the summary.
const qSecOn = clone(quote());
qSecOn.sections[0].customDates = true;
qSecOn.sections[0].startDate = "2026-09-10";
qSecOn.sections[0].endDate = "2026-09-12";
has("Q13 turning on custom section dates is reported",
    QC(quote(), qSecOn, PROJECTS, COMPANIES), "Audio Rental Period", "Quote dates");
const qSecHalf = clone(quote());
qSecHalf.sections[0].customDates = true;
qSecHalf.sections[0].startDate = "2026-09-10";   // end left blank
has("Q14 a half-set custom range reads as 'Not set', not as a blank arrow",
    QC(quote(), qSecHalf, PROJECTS, COMPANIES), "Audio Rental Period", "Not set");
has("Q15 turning custom section dates back off is reported",
    QC(qSecOn, clone(quote()), PROJECTS, COMPANIES), "Audio Rental Period", "Reset to quote dates");
has("Q16 a section rename is reported",
    QC(quote(), clone(quote({ sections: [Object.assign({}, quote().sections[0], { label: "Lighting" })] })),
       PROJECTS, COMPANIES), "Section Renamed", "Audio");

// ── Every row is renderable ─────────────────────────────────────────────────
// The save dialog maps over these; a row missing `cat` or `detail` renders as
// an empty line and the user is told nothing.
[["quote", QC(quote(), clone(quote({ status: "sent", projectId: "pr2", companyId: "co2" })), PROJECTS, COMPANIES)],
 ["invoice", IC(invoice(), clone(invoice({ status: "sent", dueDate: "2026-10-01" })), PROJECTS, COMPANIES)]
].forEach(function (pair) {
  const rows = pair[1] || [];
  ok(pair[0] + " summary produced rows", rows.length > 0, "n=" + rows.length);
  ok("every " + pair[0] + " row has a non-empty cat and detail",
     rows.every((r) => r && typeof r.cat === "string" && r.cat
                    && typeof r.detail === "string" && r.detail),
     JSON.stringify(rows));
});

// ── The two are deliberately NOT the same function ──────────────────────────
ok("the quote and invoice summaries are distinct implementations", QC !== IC);
has("Q12 quotes report their own total category",
    QC(quote(), qPriceUp, PROJECTS, COMPANIES), "Quote Total");
has("I9 invoices report their own total category",
    IC(invoice(), iPrice, PROJECTS, COMPANIES), "Invoice Total");

console.log("doc-changes suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
