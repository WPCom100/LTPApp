#!/usr/bin/env node
// window.LTP_applySortMove — the drag-reorder transform for document sections.
//
// WHY THIS SUITE EXISTS
//   This logic lived twice, byte-identical after comments and indentation,
//   inside the 1,704-line QuotesBuilder and the 2,008-line InvoiceBuilder
//   closures. Nothing inside those closures can be unit-tested, so every
//   drag-reorder path in the app — the one that decides what order a client
//   sees line items in on their quote — had zero coverage.
//
//   Extracting it as a pure function fixed that. These assertions compare the
//   shared helper against a verbatim copy of the pre-extraction inline code
//   over an exhaustive move matrix, so the extraction is shown to be lossless
//   rather than assumed to be.
//
// Pure Node, zero deps.
//   Run:  node tests/test_doc_sections.js
"use strict";
const { loadDomain } = require("./_load_domain.js");
loadDomain();

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, got, want) { ok(n, JSON.stringify(got) === JSON.stringify(want), "got " + JSON.stringify(got)); }

const APPLY = window.LTP_applySortMove;
ok("LTP_applySortMove is exported", typeof APPLY === "function");

// ── Verbatim pre-extraction implementation, as a reference ──────────────────
// This is the body both builders carried, lifted out of the setDraft callbacks
// with `d` replaced by `{ sections }`. It returns the new sections or null for
// the cases where the original returned `d` unchanged.
function referenceApply(sections, m) {
  if (m.kind === "section") {
    var secs = sections.slice();
    var from = secs.findIndex(function(s) { return s.id === m.id; });
    if (from === -1) return null;
    var moved = secs.splice(from, 1)[0];
    var to = m.targetId == null ? secs.length : secs.findIndex(function(s) { return s.id === m.targetId; });
    if (to === -1) to = secs.length;
    else if (m.after) to += 1;
    secs.splice(to, 0, moved);
    return secs;
  }
  var copy = sections.map(function(s) { return Object.assign({}, s, { items: s.items.slice() }); });
  var from2 = copy.find(function(s) { return s.id === m.fromZone; });
  var dest = copy.find(function(s) { return s.id === m.toZone; });
  if (!from2 || !dest) return null;
  var idx = from2.items.findIndex(function(i) { return i.id === m.id; });
  if (idx === -1) return null;
  var moved2 = from2.items.splice(idx, 1)[0];
  var to2 = m.targetId == null ? dest.items.length : dest.items.findIndex(function(i) { return i.id === m.targetId; });
  if (to2 === -1) to2 = dest.items.length;
  else if (m.after) to2 += 1;
  dest.items.splice(to2, 0, moved2);
  return copy;
}

function fixture() {
  return [
    { id: "A", label: "Audio", items: [{ id: "a1" }, { id: "a2" }, { id: "a3" }] },
    { id: "B", label: "Grip",  items: [{ id: "b1" }, { id: "b2" }] },
    { id: "C", label: "Empty", items: [] },
  ];
}

// ── Exhaustive differential matrix ──────────────────────────────────────────
const SECTION_IDS = ["A", "B", "C", "nope"];
const ITEM_IDS = ["a1", "a2", "a3", "b1", "b2", "nope"];
let cases = 0, diffs = 0, firstDiff = "";

// Section moves: every section x every target x before/after x append.
SECTION_IDS.forEach((id) => {
  [...SECTION_IDS, null].forEach((targetId) => {
    [false, true].forEach((after) => {
      const m = { kind: "section", id, targetId, after };
      const got = APPLY(fixture(), m);
      const want = referenceApply(fixture(), m);
      const wantOut = want === null ? fixture() : want;   // null meant "unchanged"
      cases++;
      if (JSON.stringify(got) !== JSON.stringify(wantOut)) {
        diffs++;
        if (!firstDiff) firstDiff = JSON.stringify({ m, got, wantOut });
      }
    });
  });
});

// Item moves: every item x every source/dest zone x every target x before/after.
ITEM_IDS.forEach((id) => {
  SECTION_IDS.forEach((fromZone) => {
    SECTION_IDS.forEach((toZone) => {
      [...ITEM_IDS, null].forEach((targetId) => {
        [false, true].forEach((after) => {
          const m = { kind: "item", id, fromZone, toZone, targetId, after };
          const got = APPLY(fixture(), m);
          const want = referenceApply(fixture(), m);
          const wantOut = want === null ? fixture() : want;
          cases++;
          if (JSON.stringify(got) !== JSON.stringify(wantOut)) {
            diffs++;
            if (!firstDiff) firstDiff = JSON.stringify({ m, got, wantOut });
          }
        });
      });
    });
  });
});

ok("D1 matrix covered every move shape", cases === 4 * 5 * 2 + 6 * 4 * 4 * 7 * 2, "cases=" + cases);
ok("D2 shared helper matches the pre-extraction code on every move", diffs === 0,
   diffs + " differences, first: " + firstDiff);

// ── Purity: the caller relies on reference equality to skip a re-render ─────
const original = fixture();
const frozenJson = JSON.stringify(original);
const moved = APPLY(original, { kind: "section", id: "A", targetId: "B", after: true });
ok("D3 input array is not mutated", JSON.stringify(original) === frozenJson);
ok("D4 a real move returns a NEW array", moved !== original);
ok("D5 an unknown section returns the SAME reference (caller skips setDraft)",
   APPLY(original, { kind: "section", id: "zzz", targetId: "A" }) === original);
ok("D6 an unknown item returns the SAME reference",
   APPLY(original, { kind: "item", id: "zzz", fromZone: "A", toZone: "B" }) === original);
ok("D7 an unknown zone returns the SAME reference",
   APPLY(original, { kind: "item", id: "a1", fromZone: "A", toZone: "zzz" }) === original);
const itemMoved = APPLY(original, { kind: "item", id: "a1", fromZone: "A", toZone: "B", targetId: "b1" });
ok("D8 an item move deep-copies the items arrays it touches",
   itemMoved[0].items !== original[0].items && itemMoved[1].items !== original[1].items);
ok("D9 the moved item is the same object, not a clone",
   itemMoved[1].items.find((i) => i.id === "a1") === original[0].items[0]);

// ── Behaviour the builders depend on ────────────────────────────────────────
eq("D10 section move to a later target with after=true lands past it",
   APPLY(fixture(), { kind: "section", id: "A", targetId: "B", after: true }).map((s) => s.id),
   ["B", "A", "C"]);
eq("D11 section move with after=false lands before the target",
   APPLY(fixture(), { kind: "section", id: "C", targetId: "A", after: false }).map((s) => s.id),
   ["C", "A", "B"]);
eq("D12 null targetId appends the section to the end",
   APPLY(fixture(), { kind: "section", id: "A", targetId: null }).map((s) => s.id),
   ["B", "C", "A"]);
eq("D13 item moves across sections",
   APPLY(fixture(), { kind: "item", id: "a1", fromZone: "A", toZone: "B", targetId: "b1" })
     .map((s) => s.items.map((i) => i.id)),
   [["a2", "a3"], ["a1", "b1", "b2"], []]);
eq("D14 null targetId appends the item to the destination",
   APPLY(fixture(), { kind: "item", id: "a1", fromZone: "A", toZone: "C", targetId: null })
     .map((s) => s.items.map((i) => i.id)),
   [["a2", "a3"], ["b1", "b2"], ["a1"]]);
// The comment in the extracted helper claims the target index is resolved AFTER
// the removal so a same-section move is already correct. Pin that claim.
eq("D15 same-section move down resolves the index after removal",
   APPLY(fixture(), { kind: "item", id: "a1", fromZone: "A", toZone: "A", targetId: "a3", after: true })
     .map((s) => s.items.map((i) => i.id)),
   [["a2", "a3", "a1"], ["b1", "b2"], []]);
eq("D16 same-section move up",
   APPLY(fixture(), { kind: "item", id: "a3", fromZone: "A", toZone: "A", targetId: "a1", after: false })
     .map((s) => s.items.map((i) => i.id)),
   [["a3", "a1", "a2"], ["b1", "b2"], []]);
eq("D17 moving into an empty section works",
   APPLY(fixture(), { kind: "item", id: "b2", fromZone: "B", toZone: "C", targetId: null })
     .map((s) => s.items.map((i) => i.id)),
   [["a1", "a2", "a3"], ["b1"], ["b2"]]);

// ── Defensive inputs (the builders can call this mid-drag) ──────────────────
ok("D18 null sections is safe", APPLY(null, { kind: "section", id: "A" }) === null);
ok("D19 null move is safe", APPLY(original, null) === original);
eq("D20 a section with no items array does not throw",
   APPLY([{ id: "A" }], { kind: "item", id: "x", fromZone: "A", toZone: "A" }).length, 1);

// ── window.LTP_SECTIONS — the builders' pure draft transforms ──────────────
// Six array surgeries that lived twice, once in each 1,700/1,900-line builder
// closure, wrapped in six different sets of policy. The policy stayed in the
// builders; only these moved, which is what makes them testable at all.
//
// The contract every one of them keeps: return a NEW sections array when
// something changed, the SAME reference when nothing did, and never mutate the
// input. The builders rely on the same-reference case in moveSection to leave
// the draft object untouched.
const S = window.LTP_SECTIONS;
ok("E0 LTP_SECTIONS is exported", S && typeof S === "object");
["patchSection", "removeSection", "addItem", "patchItem", "removeItem", "nudgeItem", "nudgeSection"]
  .forEach(function (k) { ok("E0." + k + " exists", typeof S[k] === "function"); });

function secs() {
  return [
    { id: "A", label: "Audio", customDates: false, items: [{ id: "a1", qty: 1 }, { id: "a2", qty: 2 }, { id: "a3", qty: 3 }] },
    { id: "B", label: "Grip", customDates: false, items: [{ id: "b1", qty: 1 }] },
  ];
}
const snapshot = JSON.stringify(secs());
function unchangedInput(fn) {
  const input = secs();
  fn(input);
  return JSON.stringify(input) === snapshot;
}

// patchSection
eq("E1 patchSection merges into the named section",
   S.patchSection(secs(), "A", { label: "Sound" }).map((x) => x.label), ["Sound", "Grip"]);
eq("E2 patchSection leaves other sections alone",
   S.patchSection(secs(), "A", { label: "Sound" })[1], secs()[1]);
ok("E3 patchSection returns the SAME array for an unknown id",
   S.patchSection(secs(), "zzz", { label: "x" }) !== null
   && (function () { const i = secs(); return S.patchSection(i, "zzz", { label: "x" }) === i; })());
ok("E4 patchSection does not mutate its input", unchangedInput((i) => S.patchSection(i, "A", { label: "X" })));

// removeSection
eq("E5 removeSection drops the named section",
   S.removeSection(secs(), "A").map((x) => x.id), ["B"]);
ok("E6 removeSection returns the SAME array for an unknown id",
   (function () { const i = secs(); return S.removeSection(i, "zzz") === i; })());
ok("E7 removeSection does not mutate its input", unchangedInput((i) => S.removeSection(i, "A")));

// addItem
eq("E8 addItem appends to the named section",
   S.addItem(secs(), "B", { id: "b2", qty: 9 })[1].items.map((i) => i.id), ["b1", "b2"]);
ok("E9 addItem returns the SAME array for an unknown section",
   (function () { const i = secs(); return S.addItem(i, "zzz", { id: "x" }) === i; })());
ok("E10 addItem does not mutate its input", unchangedInput((i) => S.addItem(i, "A", { id: "new" })));
eq("E11 addItem into an empty section works",
   S.addItem([{ id: "C", items: [] }], "C", { id: "c1" })[0].items.map((i) => i.id), ["c1"]);

// patchItem — object form and function form
eq("E12 patchItem merges an object patch",
   S.patchItem(secs(), "A", "a2", { qty: 99 })[0].items[1].qty, 99);
eq("E13 patchItem accepts a function patch and sees the existing item",
   S.patchItem(secs(), "A", "a2", (it) => ({ qty: it.qty * 10 }))[0].items[1].qty, 20);
ok("E14 patchItem returns the SAME array for an unknown item",
   (function () { const i = secs(); return S.patchItem(i, "A", "zzz", { qty: 1 }) === i; })());
ok("E15 patchItem returns the SAME array for an unknown section",
   (function () { const i = secs(); return S.patchItem(i, "zzz", "a1", { qty: 1 }) === i; })());
ok("E16 patchItem does not mutate its input", unchangedInput((i) => S.patchItem(i, "A", "a1", { qty: 5 })));
eq("E17 patchItem leaves sibling items untouched",
   S.patchItem(secs(), "A", "a2", { qty: 99 })[0].items.map((i) => i.qty), [1, 99, 3]);

// removeItem
eq("E18 removeItem drops the named item",
   S.removeItem(secs(), "A", "a2")[0].items.map((i) => i.id), ["a1", "a3"]);
ok("E19 removeItem returns the SAME array for an unknown item",
   (function () { const i = secs(); return S.removeItem(i, "A", "zzz") === i; })());
ok("E20 removeItem does not mutate its input", unchangedInput((i) => S.removeItem(i, "A", "a1")));

// nudgeItem
eq("E21 nudgeItem moves an item down", S.nudgeItem(secs(), "A", "a1", 1)[0].items.map((i) => i.id), ["a2", "a1", "a3"]);
eq("E22 nudgeItem moves an item up", S.nudgeItem(secs(), "A", "a3", -1)[0].items.map((i) => i.id), ["a1", "a3", "a2"]);
ok("E23 nudgeItem past the top is a no-op (SAME array)",
   (function () { const i = secs(); return S.nudgeItem(i, "A", "a1", -1) === i; })());
ok("E24 nudgeItem past the bottom is a no-op (SAME array)",
   (function () { const i = secs(); return S.nudgeItem(i, "A", "a3", 1) === i; })());
ok("E25 nudgeItem on an unknown item is a no-op",
   (function () { const i = secs(); return S.nudgeItem(i, "A", "zzz", 1) === i; })());
ok("E26 nudgeItem does not mutate its input", unchangedInput((i) => S.nudgeItem(i, "A", "a1", 1)));

// nudgeSection — moves a section one place. Implemented as a swap with the
// neighbour; note that for a SINGLE step a swap and a remove-then-insert are
// indistinguishable (verified by mutation — replacing the swap with a splice
// changes nothing), so no assertion here can or should distinguish them. They
// would diverge only for |dir| > 1, which this function never takes.
eq("E27 nudgeSection swaps with the next section",
   S.nudgeSection(secs(), "A", 1).map((x) => x.id), ["B", "A"]);
eq("E28 nudgeSection swaps with the previous section",
   S.nudgeSection(secs(), "B", -1).map((x) => x.id), ["B", "A"]);
ok("E29 nudgeSection past either end is a no-op (SAME array)",
   (function () { const i = secs(); return S.nudgeSection(i, "A", -1) === i && S.nudgeSection(i, "B", 1) === i; })());
ok("E30 nudgeSection on an unknown id is a no-op",
   (function () { const i = secs(); return S.nudgeSection(i, "zzz", 1) === i; })());
ok("E31 nudgeSection does not mutate its input", unchangedInput((i) => S.nudgeSection(i, "A", 1)));
eq("E32 nudgeSection moves the middle of three down one place",
   S.nudgeSection([{ id: "A" }, { id: "B" }, { id: "C" }], "B", 1).map((x) => x.id), ["A", "C", "B"]);
eq("E32b nudgeSection moves the middle of three up one place",
   S.nudgeSection([{ id: "A" }, { id: "B" }, { id: "C" }], "B", -1).map((x) => x.id), ["B", "A", "C"]);
eq("E32c nudgeSection leaves the untouched sections in order",
   S.nudgeSection([{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }], "C", 1).map((x) => x.id),
   ["A", "B", "D", "C"]);

// Defensive: the builders can call these while a draft is still settling.
["patchSection", "removeSection", "addItem", "patchItem", "removeItem", "nudgeItem", "nudgeSection"]
  .forEach(function (k) {
    ok("E33." + k + " tolerates null sections", S[k](null, "A", "x", 1) === null);
  });
eq("E34 a section with no items array does not throw",
   S.addItem([{ id: "A" }], "A", { id: "x" })[0].items.map((i) => i.id), ["x"]);
eq("E35 patchItem on a section with no items array does not throw",
   S.patchItem([{ id: "A" }], "A", "x", { qty: 1 }).length, 1);

// ── window.LTP_eligibleInvoiceTargets ──────────────────────────────────────
// Which existing invoices a quote's items may be added to. This decides whose
// bill a job's lines land on, and it lived inside an IIFE in the middle of the
// quote builder's render tree where nothing could reach it.
const ELIG = window.LTP_eligibleInvoiceTargets;
ok("F0 LTP_eligibleInvoiceTargets is exported", typeof ELIG === "function");

const COMPANY_QUOTE = { clientType: "company", companyId: "co1", clientContactId: null };
const CONTACT_QUOTE = { clientType: "contact", companyId: null, clientContactId: "ct1" };
function inv(over) {
  return Object.assign({ id: 1, status: "draft", clientType: "company",
                         companyId: "co1", clientContactId: null }, over || {});
}
const ids = (list) => list.map((x) => x.id);

// Draft-only. An invoice locks the moment it is sent, so a sent one cannot
// take new lines — offering it would produce an edit the builder then refuses.
["sent", "paid", "overdue", "partial", "void"].forEach(function (st) {
  eq("F1 a " + st + " invoice is never a target",
     ids(ELIG([inv({ id: 9, status: st })], COMPANY_QUOTE)), []);
});
eq("F2 a draft invoice for the same company IS a target",
   ids(ELIG([inv({ id: 9 })], COMPANY_QUOTE)), [9]);

// Billing party must match — this is the assertion that stops a job's lines
// landing on another client's bill.
eq("F3 a different company is not a target",
   ids(ELIG([inv({ id: 9, companyId: "co2" })], COMPANY_QUOTE)), []);
eq("F4 a contact-billed invoice is not a target for a company-billed quote",
   ids(ELIG([inv({ id: 9, clientType: "contact", clientContactId: "ct1", companyId: null })], COMPANY_QUOTE)), []);
eq("F5 a company-billed invoice is not a target for a contact-billed quote",
   ids(ELIG([inv({ id: 9 })], CONTACT_QUOTE)), []);
eq("F6 a contact-billed invoice for the same contact IS a target",
   ids(ELIG([inv({ id: 9, clientType: "contact", clientContactId: "ct1", companyId: null })], CONTACT_QUOTE)), [9]);
eq("F7 a different contact is not a target",
   ids(ELIG([inv({ id: 9, clientType: "contact", clientContactId: "ct2", companyId: null })], CONTACT_QUOTE)), []);

// An invoice that carries BOTH ids — which happens when one is switched from
// company- to contact-billing and the old field is left behind — is the case
// that actually proves clientType is checked. With both ids populated, the id
// comparison alone would match; only the type check excludes it. (Verified by
// mutation: deleting the clientType check passes every test above but fails
// these two.)
const BOTH = { id: 9, status: "draft", companyId: "co1", clientContactId: "ct1" };
eq("F7b a contact-billed invoice carrying a matching companyId is still not a company target",
   ids(ELIG([Object.assign({}, BOTH, { clientType: "contact" })], COMPANY_QUOTE)), []);
eq("F7c a company-billed invoice carrying a matching contactId is still not a contact target",
   ids(ELIG([Object.assign({}, BOTH, { clientType: "company" })], CONTACT_QUOTE)), []);

// A null id must never match a null id — otherwise every unassigned invoice
// becomes a target for every unassigned quote.
eq("F8 a null companyId does not match a null companyId",
   ids(ELIG([inv({ id: 9, companyId: null })], { clientType: "company", companyId: null })), []);
eq("F9 a null contactId does not match a null contactId",
   ids(ELIG([inv({ id: 9, clientType: "contact", clientContactId: null, companyId: null })],
            { clientType: "contact", clientContactId: null })), []);

// The project is deliberately NOT a condition: an invoice that started on
// another job is a legitimate target, which is what lets one invoice cover
// several jobs.
eq("F10 an invoice from a different project is still a target",
   ids(ELIG([inv({ id: 9, projectId: "pr-other" })], Object.assign({ projectId: "pr1" }, COMPANY_QUOTE))), [9]);

// Missing clientType defaults to company on both sides.
eq("F11 a missing clientType defaults to company",
   ids(ELIG([{ id: 9, status: "draft", companyId: "co1" }], { companyId: "co1" })), [9]);

// Newest first — the invoice someone is most likely still working on.
eq("F12 targets come back newest first",
   ids(ELIG([inv({ id: 3 }), inv({ id: 11 }), inv({ id: 7 })], COMPANY_QUOTE)), [11, 7, 3]);

// Purity + defensiveness: the builder calls this during render.
const src = [inv({ id: 3 }), inv({ id: 11 })];
const before = JSON.stringify(src);
ELIG(src, COMPANY_QUOTE);
ok("F13 does not mutate or reorder the input array", JSON.stringify(src) === before);
eq("F14 null invoices is safe", ids(ELIG(null, COMPANY_QUOTE)), []);
eq("F15 null quote is safe", ids(ELIG([inv({ id: 9 })], null)), []);
eq("F16 a null entry in the list is skipped",
   ids(ELIG([null, inv({ id: 9 })], COMPANY_QUOTE)), [9]);

console.log("doc-sections suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
