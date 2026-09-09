#!/usr/bin/env node
// Coverage for the desktop record table (components/ui.js):
//   window.LTPTable      — header + grid rows, one track list shared by both
//   window.LTP_sortRows  — the ordering the column accessors drive
//   window.LTP_nextSort  — what one click on a header does to the sort state
//
// These back every converted list screen (invoices, quotes, projects, CRM,
// rentals, crew roster), so an ordering rule that regresses here regresses on
// all of them at once. Pure Node, zero deps.
//   Run:  node tests/test_list_table.js
"use strict";
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(n, g === w, g === w ? "" : "got " + g + " want " + w);
}

// ── Minimal React shim ─────────────────────────────────────────────────────
// Same shape as tests/test_date_field.js: ui.js grabs React.createElement and
// the hook dispatchers at load time. Elements keep their children so a test can
// walk the rendered tree.
let CTX = null;
global.React = {
  // Children go into props.children AS WELL AS .children, the way real React
  // does it. LTPList and LTPRow both destructure `{ children }` off props, so a
  // shim that only kept .children would render them empty and quietly drop the
  // whole table body.
  createElement: function (type, props) {
    const kids = Array.prototype.slice.call(arguments, 2);
    const p = Object.assign({}, props || {});
    if (kids.length) p.children = kids.length === 1 ? kids[0] : kids;
    return { type: type, props: p, children: kids };
  },
  Fragment: "Fragment",
  useState: function (init) {
    const c = CTX, i = c.idx++;
    if (!(i in c.hooks)) c.hooks[i] = { v: typeof init === "function" ? init() : init };
    const slot = c.hooks[i];
    return [slot.v, function (nv) { slot.v = typeof nv === "function" ? nv(slot.v) : nv; }];
  },
  useRef: function (init) { const c = CTX, i = c.idx++; if (!(i in c.hooks)) c.hooks[i] = { current: init }; return c.hooks[i]; },
  useMemo: function (f) { return f(); },
  useEffect: function () {},
};
global.window = { LTP_THEME: {}, LTP_STATUS_COLORS: {} };
global.document = undefined;

(0, eval)(fs.readFileSync(path.join(root, "components/ui.js"), "utf8"));

const T = window.LTPTable, sortRows = window.LTP_sortRows, nextSort = window.LTP_nextSort;
ok("LTPTable is exported", typeof T === "function");
ok("LTP_sortRows is exported", typeof sortRows === "function");
ok("LTP_nextSort is exported", typeof nextSort === "function");

// Expand nested function components so the test can read the real tree.
function expand(el) {
  if (Array.isArray(el)) return el.map(expand);
  while (el && typeof el.type === "function") el = el.type(el.props);
  if (el && el.children) el.children = el.children.map(expand);
  return el;
}
function render(props) {
  CTX = { hooks: {}, idx: 0 };
  const out = expand(T(props));
  CTX = null;
  return out;
}
// Every node in the tree, depth-first.
function walk(el, out) {
  out = out || [];
  if (Array.isArray(el)) { el.forEach((c) => walk(c, out)); return out; }
  if (!el || typeof el !== "object") return out;
  out.push(el);
  (el.children || []).forEach((c) => walk(c, out));
  return out;
}
const headers = (tree) => walk(tree).filter((e) => e.props && e.props.className === "ltp-th");
const rows = (tree) => walk(tree).filter((e) => e.props && String(e.props.className || "").indexOf("ltp-row") === 0);

// ═══════════════════════════════════════════════════════════════════════════
//   LTP_sortRows — the ordering behind every converted list
// ═══════════════════════════════════════════════════════════════════════════
const COLS = [
  { key: "name",  label: "Name",  sort: (r) => r.name },
  { key: "ref",   label: "Ref",   sort: (r) => r.ref },
  { key: "total", label: "Total", dir: "desc", sort: (r) => r.total },
  { key: "badge", label: "Badge" },   // no accessor — an inert column
];
const names = (list) => list.map((r) => r.name);

const people = [
  { name: "delta", ref: "INV-9",  total: 30 },
  { name: "Alpha", ref: "INV-10", total: 5 },
  { name: "charlie", ref: "INV-2", total: 100 },
  { name: "Bravo", ref: "INV-100", total: 20 },
];

eq("sorts strings ascending, case-insensitively",
   names(sortRows(people, COLS, { key: "name", dir: "asc" })),
   ["Alpha", "Bravo", "charlie", "delta"]);
eq("sorts strings descending",
   names(sortRows(people, COLS, { key: "name", dir: "desc" })),
   ["delta", "charlie", "Bravo", "Alpha"]);

// A plain string compare puts INV-10 before INV-2 (character by character).
// Refs are numbered, so the comparison has to be numeric-aware.
eq("orders numbered refs by their number, not character by character",
   sortRows(people, COLS, { key: "ref", dir: "asc" }).map((r) => r.ref),
   ["INV-2", "INV-9", "INV-10", "INV-100"]);

eq("sorts numbers numerically, not as text",
   sortRows(people, COLS, { key: "total", dir: "asc" }).map((r) => r.total),
   [5, 20, 30, 100]);
eq("sorts numbers descending",
   sortRows(people, COLS, { key: "total", dir: "desc" }).map((r) => r.total),
   [100, 30, 20, 5]);

// Blanks sink in BOTH directions. Flipping a column should reorder the records
// you can see, not float a wall of empty cells to the top of the list.
const withBlanks = [
  { name: "real one" }, { name: "" }, { name: "another" }, { name: null }, { name: undefined },
];
eq("blank values sink to the bottom ascending",
   names(sortRows(withBlanks, COLS, { key: "name", dir: "asc" })).slice(0, 2),
   ["another", "real one"]);
eq("blank values sink to the bottom descending too",
   names(sortRows(withBlanks, COLS, { key: "name", dir: "desc" })).slice(0, 2),
   ["real one", "another"]);
ok("every blank is still present after sorting",
   sortRows(withBlanks, COLS, { key: "name", dir: "asc" }).length === 5);

// Zero is a value, not a blank — "no minimum day rate" really is the cheapest.
eq("zero sorts as a number rather than sinking like a blank",
   sortRows([{ total: 5 }, { total: 0 }, { total: 9 }], COLS, { key: "total", dir: "asc" }).map((r) => r.total),
   [0, 5, 9]);

// Robustness: a sort naming a column that has no accessor (a badge column), or
// no column at all, must return the list untouched rather than throw.
eq("an inert column leaves the order alone", names(sortRows(people, COLS, { key: "badge", dir: "asc" })), names(people));
eq("an unknown sort key leaves the order alone", names(sortRows(people, COLS, { key: "nope", dir: "asc" })), names(people));
eq("no sort state at all leaves the order alone", names(sortRows(people, COLS, null)), names(people));
eq("an empty list is fine", sortRows([], COLS, { key: "name", dir: "asc" }), []);

// The callers keep their own filtered array and re-render from it, so sorting
// must never reorder the array it was handed.
const original = people.slice();
sortRows(people, COLS, { key: "total", dir: "desc" });
eq("sorting does not mutate the caller's array", names(people), names(original));

// ═══════════════════════════════════════════════════════════════════════════
//   LTP_nextSort — one click on a header
// ═══════════════════════════════════════════════════════════════════════════
eq("clicking the active column flips it to descending",
   nextSort(COLS, { key: "name", dir: "asc" }, "name"), { key: "name", dir: "desc" });
eq("clicking it again flips back to ascending",
   nextSort(COLS, { key: "name", dir: "desc" }, "name"), { key: "name", dir: "asc" });
eq("a new text column opens ascending",
   nextSort(COLS, { key: "total", dir: "desc" }, "name"), { key: "name", dir: "asc" });
// Money and dates declare dir:"desc" — the big/recent end is the one you want.
eq("a new column opens in its own declared direction",
   nextSort(COLS, { key: "name", dir: "asc" }, "total"), { key: "total", dir: "desc" });
eq("with no sort state yet, a column still opens in its declared direction",
   nextSort(COLS, null, "total"), { key: "total", dir: "desc" });

// ═══════════════════════════════════════════════════════════════════════════
//   LTPTable — rendering
// ═══════════════════════════════════════════════════════════════════════════
const mkRows = (list) => list.map((r) => ({ key: r.name, onClick: function () {}, cells: [r.name, r.ref, r.total, "b"] }));
let clicked = null;
const tree = render({
  columns: COLS, sort: { key: "total", dir: "desc" },
  onSort: function (s) { clicked = s; },
  rows: mkRows(people), empty: "Nothing here.",
});

eq("one header per column", headers(tree).length, 3);   // the inert one is not a button
eq("one row per record", rows(tree).length, 4);

// A column without an accessor renders as plain text, not a clickable button —
// nobody should be invited to sort by a badge.
const allHeaderText = walk(tree).filter((e) => e.type === "div" || e.type === "button")
  .map((e) => (e.children || []).filter((c) => typeof c === "string").join("")).join("|");
ok("the inert column still shows its label", allHeaderText.indexOf("Badge") !== -1);

// The header marks the sorted column for a screen reader, and index.html keys
// its hover rule off the same attribute.
const active = headers(tree).filter((e) => e.props["aria-sort"] !== "none");
eq("exactly one header is marked as the sorted one", active.length, 1);
eq("and it is the one the sort names", active[0].props.key, "total");
eq("descending is reported as such", active[0].props["aria-sort"], "descending");
eq("ascending is reported as such",
   headers(render({ columns: COLS, sort: { key: "name", dir: "asc" }, rows: mkRows(people) }))
     .filter((e) => e.props["aria-sort"] !== "none")[0].props["aria-sort"], "ascending");

// Clicking a header hands the caller the NEXT sort state, ready to store.
headers(tree).filter((e) => e.props.key === "name")[0].props.onClick();
eq("clicking an unsorted header requests that column", clicked, { key: "name", dir: "asc" });
headers(tree).filter((e) => e.props.key === "total")[0].props.onClick();
eq("clicking the sorted header requests the flip", clicked, { key: "total", dir: "asc" });

// The header and the rows must lay out on the SAME grid or the columns drift
// apart — this is the one invariant the whole look depends on.
const headerRow = walk(tree).find((e) => e.props && e.props.style && e.props.style.borderBottom && e.props.style.display === "grid");
const firstRow = rows(tree)[0];
ok("the header row is a grid", !!headerRow);
ok("the data rows are grids too", firstRow.props.style.display === "grid");
eq("header and rows share one column track list",
   headerRow.props.style.gridTemplateColumns, firstRow.props.style.gridTemplateColumns);
eq("and the same column gap",
   headerRow.props.style.columnGap, firstRow.props.style.columnGap);
ok("a column with no declared width falls back to a flexible track",
   headerRow.props.style.gridTemplateColumns.indexOf("minmax(0,1fr)") !== -1,
   headerRow.props.style.gridTemplateColumns);

// Row extras the list screens depend on: the click target, and the per-row
// style that carries the Projects category rule / the archived-kit dimming.
ok("rows carry their onClick", typeof firstRow.props.onClick === "function");
const styled = render({
  columns: COLS, sort: { key: "name", dir: "asc" }, rows: [
    { key: "a", cells: ["a", "b", 1, "c"], style: { borderLeft: "3px solid #EF5822", opacity: 0.6 } },
  ],
});
eq("a row's own style survives onto the row", rows(styled)[0].props.style.borderLeft, "3px solid #EF5822");
eq("alongside the grid the table sets", rows(styled)[0].props.style.display, "grid");
eq("and dimming rides through too", rows(styled)[0].props.style.opacity, 0.6);

// Empty state: the header stays (so the columns still read) and the message shows.
const emptyTree = render({ columns: COLS, sort: { key: "name", dir: "asc" }, rows: [], empty: "No invoices found." });
eq("no rows render when there are none", rows(emptyTree).length, 0);
eq("the headers stay so the columns still read", headers(emptyTree).length, 3);
ok("the empty message shows",
   walk(emptyTree).some((e) => (e.children || []).indexOf("No invoices found.") !== -1));

console.log("list-table suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
