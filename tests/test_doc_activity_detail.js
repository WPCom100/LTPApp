#!/usr/bin/env node
// components/doc-activity-detail.js — the "what changed" popup behind an entry
// in a document's revision log.
//
// WHY THIS SUITE EXISTS
//   It was inline in both builders, copy-pasted and then drifted, and NEITHER
//   copy was covered: the builder render snapshot opens modals by flipping
//   boolean state slots, and this one is gated on `viewActivity` — a useState
//   holding an object or null, not a boolean. So it stayed shut in every
//   scenario and the two versions could diverge indefinitely without anything
//   noticing. They did.
//
//   Extracting it made it directly renderable, which is what this suite uses.
//
// Pure Node, zero deps.
//   Run:  node tests/test_doc_activity_detail.js
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(n, g === w, g === w ? "" : "got " + g + " want " + w);
}

// ── Shim: record the element tree rather than mounting it ──────────────────
global.React = {
  createElement: function (type, props) {
    return { type: type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) };
  },
};
global.window = {
  LTP_THEME: { textMut: "#8A99A0", textSec: "#B6C2C7", accent: "#FF8A50", border: "#243038" },
  LTPModal: function LTPModal(props) { return props; },
  LTP_formatDate: function (d) { return "FMT(" + d + ")"; },
  LTP_formatTime: function (t) { return "TIME(" + t + ")"; },
};
(0, eval)(fs.readFileSync(path.join(ROOT, "components", "doc-activity-detail.js"), "utf8"));

const RENDER = window.LTPActivityDetail;
ok("A0 LTPActivityDetail is exported", typeof RENDER === "function");

// Flatten a tree to the strings it renders, so assertions read as "does the
// user see this".
function textOf(node) {
  if (node == null || node === false || node === true) return [];
  if (Array.isArray(node)) return node.flatMap(textOf);
  if (typeof node !== "object") return [String(node)];
  const kids = (node.children || []).flatMap(textOf);
  const propKids = node.props && node.props.children !== undefined ? textOf(node.props.children) : [];
  return kids.concat(propKids);
}
function widths(node, acc) {
  acc = acc || [];
  if (node == null || typeof node !== "object") return acc;
  if (Array.isArray(node)) { node.forEach((n) => widths(n, acc)); return acc; }
  if (node.props && node.props.style && node.props.style.width != null) acc.push(node.props.style.width);
  (node.children || []).forEach((n) => widths(n, acc));
  if (node.props && node.props.children !== undefined) widths(node.props.children, acc);
  return acc;
}

const ENTRY = {
  message: "Quote sent", user: "Dana", date: "2026-08-29", time: "14:05",
  changes: [{ cat: "Status", detail: "draft → sent" }, { cat: "Total", detail: "$1,000 → $1,200" }],
};

// ── The entry header ────────────────────────────────────────────────────────
let out = RENDER({ entry: ENTRY, onClose: function () {} });
let text = textOf(out).join(" | ");
ok("A1 the author is shown", /Dana/.test(text), text.slice(0, 200));
ok("A2 the date is formatted, not raw", /FMT\(2026-08-29\)/.test(text), text.slice(0, 200));
// THE fix on the invoice side: invoices stored a time on every activity entry
// and never rendered it. Several edits a day is normal, so a date alone cannot
// tell you which came first.
ok("A3 the TIME is shown", /TIME\(14:05\)/.test(text), text.slice(0, 200));
eq("A4 the modal is titled with the entry's message", out.props.title, "Quote sent");

// ── The change rows ─────────────────────────────────────────────────────────
ok("A5 each change category is shown", /Status/.test(text) && /Total/.test(text), text);
ok("A6 each change detail is shown",
   /draft → sent/.test(text) && /\$1,000 → \$1,200/.test(text), text);
eq("A7 the label column settles at 140px", widths(out).filter((w) => w === 140).length, 2);
ok("A8 no 120px column survives from the invoice copy",
   widths(out).indexOf(120) === -1, JSON.stringify(widths(out)));

// ── The empty state ─────────────────────────────────────────────────────────
// The other fix: the invoice copy rendered an empty modal body. Older entries
// predate the change log, so landing on one is normal.
[[], undefined, null].forEach(function (changes, i) {
  const t = textOf(RENDER({ entry: Object.assign({}, ENTRY, { changes: changes }), onClose: function () {} })).join(" ");
  ok("A9." + i + " an entry with no changes says so rather than showing a blank box",
     /No detailed changes recorded/.test(t), t.slice(0, 160));
});
ok("A10 an entry WITH changes does not show the empty-state message",
   !/No detailed changes recorded/.test(text), text.slice(0, 200));

// ── Partial and missing data ────────────────────────────────────────────────
let t2 = textOf(RENDER({ entry: { message: "m", user: "Dana", date: "2026-08-29", changes: [] }, onClose: function () {} })).join(" ");
ok("A11 an entry with no time still renders", /FMT\(2026-08-29\)/.test(t2), t2.slice(0, 160));
ok("A12 ...and does not render a stray time", !/TIME\(/.test(t2), t2.slice(0, 160));
let t3 = textOf(RENDER({ entry: { message: "m", changes: [] }, onClose: function () {} })).join(" ");
ok("A13 an entry with no user or date does not throw and shows the empty state",
   /No detailed changes recorded/.test(t3), t3.slice(0, 160));
ok("A14 ...and renders no 'FMT(undefined)'", !/FMT\(/.test(t3), t3.slice(0, 160));
ok("A15 a null entry renders nothing rather than throwing",
   RENDER({ entry: null, onClose: function () {} }) === null);

// ── The close handler reaches the modal ─────────────────────────────────────
let closed = 0;
out = RENDER({ entry: ENTRY, onClose: function () { closed++; } });
ok("A16 onClose is wired to the modal", typeof out.props.onClose === "function");
out.props.onClose();
eq("A17 ...and calling it reaches the caller", closed, 1);

// ── Both builders use it ────────────────────────────────────────────────────
["modules/quotes-builder.js", "modules/invoices.js"].forEach(function (rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  ok(rel + " renders the shared popup", src.indexOf("window.LTPActivityDetail") !== -1);
  ok(rel + " no longer inlines its own",
     src.indexOf('viewActivity && h(window.LTPModal') === -1);
});

console.log("doc-activity-detail suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
