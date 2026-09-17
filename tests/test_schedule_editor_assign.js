#!/usr/bin/env node
// Schedule editor — picking a crew member fills ONE position.
//
// The crew picker on a shift row used to "assign to the day": besides the
// clicked slot it pencilled the same person into every open, unfilled slot of
// the same role on every other row that date. In the full schedule editor a
// project is usually a load-in row and a show row (or several) on one date,
// so one pick quietly staffed all of them — the producer saw people on shifts
// they never picked them for. This suite renders the real ScheduleEditor under
// the hook-capable React shim (the one tests/test_builder_render.js uses),
// drives the crew picker's onChange, and checks exactly which positions the
// published schedule changed:
//   * the clicked position gets the person; every other slot is untouched —
//     same role, same date, other rows included
//   * a second pick on another row is its own decision (no spread there either)
//   * the same-day conflict dialog still fires when the person is already on
//     another row that date, and "Assign Anyway" still fills only that slot
//   * re-picking the same person keeps the status; a different person reopens it
//   Run:  node tests/test_schedule_editor_assign.js
"use strict";

const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, g, e) { ok(n, JSON.stringify(g) === JSON.stringify(e), "got " + JSON.stringify(g) + " exp " + JSON.stringify(e)); }

// ── React shim with real hook state ────────────────────────────────────────
let CTX = null;
global.React = {
  Fragment: "Fragment",
  createElement: function (type, props) {
    const children = Array.prototype.slice.call(arguments, 2);
    return { $$: true, type: type, props: props || {}, children: children };
  },
  useState: function (init) {
    const c = CTX, i = c.idx++;
    if (!(i in c.hooks)) c.hooks[i] = { v: typeof init === "function" ? init() : init };
    const slot = c.hooks[i];
    return [slot.v, function (nv) { slot.v = typeof nv === "function" ? nv(slot.v) : nv; }];
  },
  useRef: function (init) {
    const c = CTX, i = c.idx++;
    if (!(i in c.hooks)) c.hooks[i] = { current: init };
    return c.hooks[i];
  },
  useMemo: function (f) { const c = CTX, i = c.idx++;
    if (!(i in c.hooks)) c.hooks[i] = { v: f() };
    return c.hooks[i].v; },
  useCallback: function (f) { return f; },
  useEffect: function () {},
  useLayoutEffect: function () {},
};

// ── Host environment ───────────────────────────────────────────────────────
global.window = {};
global.document = {
  createElement: function () { return { style: {}, setAttribute: function () {}, appendChild: function () {},
    querySelector: function () { return null; }, focus: function () {}, select: function () {},
    classList: { add: function () {}, remove: function () {} }, innerHTML: "", textContent: "" }; },
  addEventListener: function () {}, removeEventListener: function () {},
  getElementById: function () { return null; }, querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  body: { appendChild: function () {}, removeChild: function () {}, style: {} },
};
Object.defineProperty(global, "navigator", { value: { userAgent: "node" }, configurable: true, writable: true });
global.location = { origin: "https://ltp.example.com", href: "https://ltp.example.com/" };
global.fetch = function () { return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } }); };
global.matchMedia = function () { return { matches: false, addEventListener: function () {}, removeEventListener: function () {} }; };
global.requestAnimationFrame = function () { return 0; };
Object.assign(global.window, {
  location: global.location, document: global.document, navigator: global.navigator,
  matchMedia: global.matchMedia, addEventListener: function () {}, removeEventListener: function () {},
  dispatchEvent: function () {}, innerWidth: 1440, innerHeight: 900, getComputedStyle: function () { return {}; },
});

// ── Real code: the domain layer, then the components (best-effort) ─────────
const { domainScripts } = require(path.join(ROOT, "tests", "_load_domain.js"));
for (const rel of domainScripts()) (0, eval)(fs.readFileSync(path.join(ROOT, rel), "utf8"));
const indexHtml = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const COMPONENT_SRCS = [...indexHtml.matchAll(/<script\s+src="(components\/[^"]+)"/g)].map((m) => m[1]);
for (const rel of COMPONENT_SRCS) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  try { (0, eval)(fs.readFileSync(abs, "utf8")); } catch (e) { /* needs a real DOM */ }
}
if (typeof window.ScheduleEditor !== "function") { console.log("components/schedule-editor.js did not load"); process.exit(1); }

function stub(name) {
  return function (props) { return { $$: true, type: "<" + name + ">", props: props || {}, children: [] }; };
}
["Btn", "LTPModal", "LTPDateField", "LTPTimeField", "LTPSelect", "LTPInput"].forEach((n) => { if (!window[n]) window[n] = stub(n); });
if (!window.LTPSearchSelect) window.LTPSearchSelect = stub("LTPSearchSelect");
if (!window.LTP_crewSelectOptions) window.LTP_crewSelectOptions = function () { return { options: [], sections: [], moreOptions: [] }; };
window.LTP_useIsMobile = function () { return false; };   // desktop layout
let _n = 0;
window.LTP_genId = function (p) { return (p || "x") + "-" + (++_n); };
window.LTP_todayISO = function () { return "2026-09-16"; };
window.LTP_toast = function () {};

// ── Fixtures ───────────────────────────────────────────────────────────────
const services = [
  { id: 1, role: "L1", description: "Lighting Tech", department: "Lighting", dayRate: 1000, dayCost: 600 },
  { id: 2, role: "A1", description: "Audio Tech", department: "Audio", dayRate: 1000, dayCost: 600 },
];
const contacts = [
  { id: 11, isCrew: true, crewStatus: "active", firstName: "Alex", lastName: "Crew", crewRoles: ["L1"], crewDepartments: ["Lighting"] },
  { id: 12, isCrew: true, crewStatus: "active", firstName: "Dana", lastName: "Deck", crewRoles: ["L1"], crewDepartments: ["Lighting"] },
];
// One date, two rows, the same role open on both — the shape that used to
// spread a single pick across the day.
function schedule(overrides) {
  const base = [
    { id: "sch-1", title: "Load-in", date: "2026-09-20", time: "08:00", endDate: "2026-09-20", endTime: "12:00", showOnCalendar: true, breaks: [],
      positions: [
        { id: "p1", role: "L1", serviceId: 1, crewId: null, status: "open", fullMargin: false },
        { id: "p2", role: "L1", serviceId: 1, crewId: null, status: "open", fullMargin: false },
      ] },
    { id: "sch-2", title: "Show", date: "2026-09-20", time: "14:00", endDate: "2026-09-20", endTime: "22:00", showOnCalendar: true, breaks: [],
      positions: [
        { id: "p3", role: "L1", serviceId: 1, crewId: null, status: "open", fullMargin: false },
        { id: "p4", role: "A1", serviceId: 2, crewId: null, status: "open", fullMargin: false },
      ] },
    { id: "sch-3", title: "Strike", date: "2026-09-21", time: "08:00", endDate: "2026-09-21", endTime: "12:00", showOnCalendar: true, breaks: [],
      positions: [
        { id: "p5", role: "L1", serviceId: 1, crewId: null, status: "open", fullMargin: false },
      ] },
  ];
  return JSON.parse(JSON.stringify(base)).map(function (s) {
    s.positions = s.positions.map(function (p) { return Object.assign(p, (overrides || {})[p.id] || {}); });
    return s;
  });
}

// ── Render + tree helpers ──────────────────────────────────────────────────
function mount(sched) {
  const ctx = { idx: 0, hooks: {} };
  const published = [];
  const props = { schedule: sched, onChange: function (next) { published.push(next); }, contacts: contacts, services: services };
  function render() { CTX = ctx; ctx.idx = 0; const tree = window.ScheduleEditor(props); CTX = null; return tree; }
  return { render: render, published: published };
}
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach(function (n) { walk(n, visit); }); return; }
  if (!node.$$) return;
  visit(node);
  walk(node.children, visit);
  if (node.props && node.props.children !== undefined) walk(node.props.children, visit);
}
// The crew pickers, in row/position order (rows group by date, then by time).
function crewPickers(tree) {
  const out = [];
  walk(tree, function (n) { if (n.type === window.LTPSearchSelect && n.props.searchPlaceholder === "Search crew…") out.push(n); });
  return out;
}
function confirmButton(tree) {
  let found = null;
  walk(tree, function (n) {
    if (n.type === window.Btn && n.props.variant === "danger" && n.children[0] === "Assign Anyway") found = n;
  });
  return found;
}
function crewOf(sched) {
  const m = {};
  sched.forEach(function (s) { s.positions.forEach(function (p) { m[p.id] = [p.crewId, p.status]; }); });
  return m;
}

// ── A pick fills the clicked slot and nothing else ─────────────────────────
{
  const m = mount(schedule());
  const pickers = crewPickers(m.render());
  eq("A0 five crew pickers rendered, one per position", pickers.length, 5);
  pickers[0].props.onChange("11");                 // p1 on Load-in
  eq("A1 one schedule published", m.published.length, 1);
  eq("A2 only p1 changed — p2 (same row, same role), p3 (Show, same role), p4, p5 untouched",
     crewOf(m.published[0]),
     { p1: [11, "open"], p2: [null, "open"], p3: [null, "open"], p4: [null, "open"], p5: [null, "open"] });
}

// ── The other row is its own pick ──────────────────────────────────────────
{
  const m = mount(schedule({ p1: { crewId: 11, status: "requested" } }));
  const pickers = crewPickers(m.render());
  pickers[2].props.onChange("12");                 // p3 on Show, a different person
  eq("B1 published once", m.published.length, 1);
  eq("B2 p3 gets Dana; Alex's p1 keeps its request; the open L1 slots stay open",
     crewOf(m.published[0]),
     { p1: [11, "requested"], p2: [null, "open"], p3: [12, "open"], p4: [null, "open"], p5: [null, "open"] });
}

// ── Same-day conflict: Alex already on the Show row, picked for Load-in ────
{
  const m = mount(schedule({ p3: { crewId: 11, status: "confirmed" } }));
  const pickers = crewPickers(m.render());
  pickers[0].props.onChange("11");                 // p1 — Alex is on p3 that date
  eq("C1 nothing published yet — the conflict dialog comes first", m.published.length, 0);
  const tree = m.render();
  const btn = confirmButton(tree);
  ok("C2 'Assign Anyway' offered", !!btn);
  let msg = "";
  walk(tree, function (n) { if (n.type === "p" && typeof n.children[0] === "string" && n.children[0].indexOf("Already assigned as") !== -1) msg = n.children[0]; });
  ok("C3 dialog names the other shift", /Already assigned as L1 .* on Show/.test(msg), msg);
  btn.props.onClick();
  eq("C4 confirming publishes once", m.published.length, 1);
  eq("C5 only p1 filled; p2 (open L1 on the same row) is NOT auto-filled",
     crewOf(m.published[0]),
     { p1: [11, "open"], p2: [null, "open"], p3: [11, "confirmed"], p4: [null, "open"], p5: [null, "open"] });
}

// ── Status on re-pick ──────────────────────────────────────────────────────
{
  const m = mount(schedule({ p1: { crewId: 11, status: "confirmed" } }));
  const pickers = crewPickers(m.render());
  pickers[0].props.onChange("11");                 // same person again
  eq("D1 re-picking the same person keeps the status", crewOf(m.published[0]).p1, [11, "confirmed"]);
}
{
  const m = mount(schedule({ p1: { crewId: 11, status: "confirmed" } }));
  const pickers = crewPickers(m.render());
  pickers[0].props.onChange("12");                 // swap to Dana
  eq("D2 a different person reopens the slot", crewOf(m.published[0]).p1, [12, "open"]);
  eq("D3 …and still touches nothing else", crewOf(m.published[0]).p2, [null, "open"]);
}
{
  const m = mount(schedule({ p1: { crewId: 11, status: "requested" } }));
  const pickers = crewPickers(m.render());
  pickers[0].props.onChange("");                   // clear
  eq("D4 clearing reopens the slot", crewOf(m.published[0]).p1, [null, "open"]);
}

// ── Source guard: no "assign to the day" spread left in the editor ─────────
{
  const src = fs.readFileSync(path.join(ROOT, "components", "schedule-editor.js"), "utf8");
  ok("E1 the same-day auto-fill is gone", src.indexOf("sameDayItems") === -1 && src.indexOf("AssignCrewToDay") === -1);
}

console.log("schedule-editor assign suite — PASS: " + pass + "   FAIL: " + fail);
if (fail) { console.log("\nFailures:"); fails.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
