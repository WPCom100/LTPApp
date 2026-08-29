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

console.log("doc-sections suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
