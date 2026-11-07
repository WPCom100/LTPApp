#!/usr/bin/env node
// window.LTP_markQuoteConverted — the manual "mark converted" override.
//
// WHY THIS SUITE EXISTS
//   "Converted" is normally earned: Send to Invoice flips the quote once every
//   line is invoiced. The override closes a quote that was billed OUTSIDE the
//   app, and it must leave the document looking exactly the way a real
//   conversion does (nothing outstanding), refuse every state it does not
//   apply to, and write a log entry a reader can tell apart from a conversion
//   that produced an invoice. Each of those is a paper-trail promise.
//
// Pure Node, zero deps.
//   Run:  node tests/test_quote_mark_converted.js
"use strict";
const { loadDomain } = require("./_load_domain.js");
loadDomain();

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(n, g === w, g === w ? "" : "got " + g + " want " + w);
}

const MARK = window.LTP_markQuoteConverted;
ok("A0 LTP_markQuoteConverted is exported", typeof MARK === "function");

function gidFactory() { let n = 0; return (p) => (p || "x") + "-" + (++n); }
const OPTS = () => ({ genId: gidFactory(), user: "Tess", date: "2026-11-07", time: "09:15" });

const line = (o) => Object.assign({ id: "i1", type: "equipment", name: "Console", qty: 5,
                                    unitPrice: 100, deliveredQty: 0, invoicedQty: 0 }, o);
function quote(items, over) {
  return Object.assign({
    id: 7, status: "accepted", activity: [{ id: "act-old", type: "created" }],
    sections: [{ id: "s1", label: "Audio", items: items }],
  }, over || {});
}

// ── Refusals ────────────────────────────────────────────────────────────────
ok("B1 null quote -> null", MARK(null, OPTS()) === null);
for (const st of ["draft", "sent", "declined", "converted"]) {
  ok("B2 " + st + " quote -> null", MARK(quote([line()], { status: st }), OPTS()) === null);
}
ok("B3 unsaved (no id) accepted quote -> null", MARK(quote([line()], { id: null }), OPTS()) === null);
ok("B3b undefined id -> null", MARK(quote([line()], { id: undefined }), OPTS()) === null);

// ── The happy path ──────────────────────────────────────────────────────────
{
  const q = quote([line(), line({ id: "i2", name: "Cable", qty: 12, deliveredQty: 12, invoicedQty: 4 }),
                   { id: "n1", type: "note", text: "load-in 8am" }]);
  const before = JSON.stringify(q);
  const r = MARK(q, OPTS());
  ok("C1 returns a quote", !!r && r !== q);
  ok("C2 input not mutated", JSON.stringify(q) === before);
  eq("C3 status -> converted", r.status, "converted");
  eq("C4 untouched line stamped delivered+invoiced in full",
     [r.sections[0].items[0].deliveredQty, r.sections[0].items[0].invoicedQty], [5, 5]);
  eq("C5 partly invoiced line topped up to qty, not reset",
     [r.sections[0].items[1].deliveredQty, r.sections[0].items[1].invoicedQty], [12, 12]);
  eq("C6 note row left alone", r.sections[0].items[2], { id: "n1", type: "note", text: "load-in 8am" });
  ok("C7 other line fields survive", r.sections[0].items[0].unitPrice === 100 && r.sections[0].items[0].name === "Console");
  eq("C8 section label survives", r.sections[0].label, "Audio");
  eq("C9 existing activity kept, one entry appended", r.activity.length, 2);
  const e = r.activity[1];
  eq("C10 entry id from genId", e.id, "act-1");
  eq("C11 entry type is a status change", e.type, "status");
  eq("C12 entry user/date/time from opts", [e.user, e.date, e.time], ["Tess", "2026-11-07", "09:15"]);
  ok("C13 message says it was manual", /manually/.test(e.message), e.message);
  eq("C14 status change recorded, labelled manual", e.changes[0], { cat: "Status", detail: "accepted \u2192 converted (manual)" });
  ok("C15 write-off names the remainder per line, not the whole qty",
     e.changes[1].cat === "Written off" && e.changes[1].detail === "Console \u00d75, Cable \u00d78", JSON.stringify(e.changes[1]));
}

// ── Nothing left to write off ───────────────────────────────────────────────
{
  const full = line({ deliveredQty: 5, invoicedQty: 5 });
  const r = MARK(quote([full]), OPTS());
  eq("D1 fully invoiced quote still converts", r.status, "converted");
  ok("D2 fully invoiced line is the SAME reference (no needless copy)", r.sections[0].items[0] === full);
  eq("D3 only the status change is logged", r.changes, undefined);
  eq("D3b one change entry, no write-off", r.activity[1].changes.length, 1);
  ok("D4 message has no write-off clause", !/outside LTP/.test(r.activity[1].message), r.activity[1].message);
}

// ── Over-delivered / over-invoiced corrections are not clawed back ──────────
{
  const r = MARK(quote([line({ deliveredQty: 7, invoicedQty: 6 })]), OPTS());
  eq("E1 counters above qty are kept, not lowered", [r.sections[0].items[0].deliveredQty, r.sections[0].items[0].invoicedQty], [7, 6]);
  eq("E2 no write-off logged for it", r.activity[1].changes.length, 1);
}

// ── Defensive shapes ────────────────────────────────────────────────────────
{
  const r = MARK({ id: 3, status: "accepted" }, OPTS());
  eq("F1 missing sections/activity -> converted with empty sections and one entry",
     [r.status, r.sections, r.activity.length], ["converted", [], 1]);
  const r2 = MARK({ id: 3, status: "accepted", sections: [{ id: "s", items: null }] }, OPTS());
  eq("F2 section with null items -> empty items", r2.sections[0].items, []);
  const r3 = MARK(quote([line({ qty: "4", deliveredQty: "", invoicedQty: undefined })]), OPTS());
  eq("F3 string qty / blank counters coerce", [r3.sections[0].items[0].deliveredQty, r3.sections[0].items[0].invoicedQty], [4, 4]);
}

// ── Defaults when no opts are passed ────────────────────────────────────────
{
  window.LTP_CURRENT_USER = "Default User";
  const r = MARK(quote([line()]));
  const e = r.activity[1];
  ok("G1 id generated", typeof e.id === "string" && e.id.length > 0);
  ok("G2 date is today (ISO)", e.date === window.LTP_todayISO(), e.date);
  ok("G3 time is HH:MM", /^\d\d:\d\d$/.test(e.time), e.time);
  eq("G4 user falls back to LTP_CURRENT_USER", e.user, "Default User");
}

console.log("quote mark-converted suite \u2014 PASS: " + pass + "   FAIL: " + fail);
if (fail) { fails.forEach((f) => console.log("  \u2717 " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
