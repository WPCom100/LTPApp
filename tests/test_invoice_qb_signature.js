#!/usr/bin/env node
// The invoice's QuickBooks fingerprint (modules/invoices.js::qbSignature) — what
// decides "✓ In QuickBooks" vs "QB update needed".
//
// WHY THIS SUITE EXISTS
//   The push sends each line's "name — notes" as its QuickBooks description,
//   but the fingerprint used to leave notes out. The labor sync rewrites a
//   line's day-list note when a schedule day moves without the count changing,
//   so an invoice would read "in QuickBooks" while QuickBooks still showed the
//   old day (docs/LABOR_SYNC_PLAN.md, decision 16). Notes are in now — but every
//   invoice pushed before stored the OLD fingerprint, and all of them would
//   have flipped to "update needed" on deploy with nothing changed. So the old
//   form is still computed, byte for byte, and a stored value matching either
//   reads as in sync. This suite pins both halves.
//
// Pure Node, zero deps. The functions are extracted from the module's source,
// never re-typed, so the test and the builder cannot drift apart.
//   Run:  node tests/test_invoice_qb_signature.js
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, got, want) { ok(n, JSON.stringify(got) === JSON.stringify(want), "got " + JSON.stringify(got) + " exp " + JSON.stringify(want)); }

const src = fs.readFileSync(path.join(__dirname, "..", "modules", "invoices.js"), "utf8");
function extract(name) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1) return null;
  let depth = 0;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return null;
}
const hashSrc = extract("qbHash"), sigSrc = extract("qbSignature");
ok("qbHash located", !!hashSrc);
ok("qbSignature located", !!sigSrc);
global.qbHash = (0, eval)("(" + hashSrc + ")");
const SIG = (0, eval)("(" + sigSrc + ")");

const INV = { invoiceDate: "2026-09-01", dueDate: "2026-10-01", notes: "Thanks", status: "sent", sentDate: "2026-09-02",
  globalDiscount: { type: "percent", value: 10 }, customName: "",
  sections: [{ items: [
    { type: "service", name: "A1 — Audio Lead", qty: 3, unitPrice: 600, adjustedPrice: null, taxable: true, notes: "Aug 10, Aug 11, Aug 12" },
    { type: "note", text: "Load in via the west dock" },
    { type: "equipment", name: "Speaker", qty: 2, unitPrice: 100, adjustedPrice: 90, notes: "" } ] }] };
const CUST = { name: "Acme Co", address: "1 A St", city: "LA", state: "CA", zip: "90001", email: "a@b.c", phone: "555" };
const PROJ = { name: "Spring Shoot" };
function withNote(note) {
  return Object.assign({}, INV, { sections: [{ items: INV.sections[0].items.map((it, i) => i === 0 ? Object.assign({}, it, { notes: note }) : it) }] });
}

// ── The pre-notes fingerprint is exactly what it always was ─────────────────
// This value was computed by the function BEFORE notes were added. If it moves,
// every invoice pushed before this change reads "QB update needed".
const PINNED = "88989b36e26e254-182";
eq("L0 the legacy fingerprint is byte-for-byte the old one", SIG(INV, CUST, PROJ, true, false), PINNED);
eq("L1 …and is the default when the flag is left out", SIG(INV, CUST, PROJ, true), PINNED);
eq("L2 the legacy form never sees a note", SIG(withNote("Aug 10, Aug 12, Aug 13"), CUST, PROJ, true, false), PINNED);

// ── The new fingerprint follows the notes ────────────────────────────────────
const NEW = SIG(INV, CUST, PROJ, true, true);
ok("N0 the new form differs from the legacy one", NEW !== PINNED, NEW);
eq("N1 stable for an unchanged invoice", SIG(INV, CUST, PROJ, true, true), NEW);
ok("N2 a note-only change moves it (a schedule day moved)", SIG(withNote("Aug 10, Aug 12, Aug 13"), CUST, PROJ, true, true) !== NEW);
ok("N3 a price change still moves it", SIG(Object.assign({}, INV, { sections: [{ items: [Object.assign({}, INV.sections[0].items[0], { unitPrice: 650 })] }] }), CUST, PROJ, true, true) !== NEW);
ok("N4 an empty note and a missing one agree",
   SIG(withNote(""), CUST, PROJ, true, true) === SIG(Object.assign({}, INV, { sections: [{ items: [Object.assign({}, INV.sections[0].items[0], { notes: undefined })].concat(INV.sections[0].items.slice(1)) }] }), CUST, PROJ, true, true));
eq("N5 no invoice → empty", SIG(null, CUST, PROJ, true, true), "");

// ── The builder reads "in sync" when the stored value matches either form ───
// A source guard, like tests/test_quote_availability.py's: the rule is inline in
// the render, so pin its shape rather than restate it.
ok("S0 the builder computes both forms",
   /qbSignature\([^)]*,\s*true\)/.test(src) && /qbSignature\([^)]*,\s*false\)/.test(src));
ok("S1 out of sync only when the stored value matches neither",
   /qbSig !== storedSig && qbSigLegacy !== storedSig/.test(src));
ok("S2 every push sends the new form", !/qbSignature\(invoiceObj, party, proj, taxable\)/.test(src)
   && /qbSignature\(invoiceObj, party, proj, taxable, true\)/.test(src));

console.log("invoice-qb-signature suite — PASS: " + pass + "   FAIL: " + fail);
if (fail) { fails.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
