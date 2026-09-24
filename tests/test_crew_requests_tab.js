#!/usr/bin/env node
// Labor → Crew Requests (modules/labor.js CrewRequestsTab): what the queue
// shows once work has been paid out, and the filter bar it shares with the
// Assignments tab.
//   * a request drops out of the queue once every shift in it is paid out;
//     a project drops out whole — its declines too — once every ask on it
//     is paid out or declined (the rules: tests/test_crew_request_pay.js)
//   * the status tiles count the rows on the screen and filter them
//   * the project picker lists the queue's projects, then the paid-out ones
//     under their own heading; picking one shows everything on it, paid
//     requests badged "Paid"; All Projects goes back to the open queue
//   * on a phone: the stat strip and chip strip, and "paid" on each paid shift
//
// Pure Node, zero deps, under a small hook runner (state persists across
// renders the way React's does; effects are not run, and child components are
// recorded, not called — so a tile row is read off FilterTiles' props).
//   Run:  node tests/test_crew_requests_tab.js
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, got, want) { ok(n, JSON.stringify(got) === JSON.stringify(want), "got " + JSON.stringify(got) + " exp " + JSON.stringify(want)); }

// ── A minimal hook runtime ────────────────────────────────────────────────────
let CTX = null;
global.React = {
  createElement: function (type, props) { return { type: type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) }; },
  useState: function (init) {
    const c = CTX, i = c.idx++;
    if (!(i in c.hooks)) c.hooks[i] = { v: typeof init === "function" ? init() : init };
    const slot = c.hooks[i];
    return [slot.v, function (nv) { slot.v = typeof nv === "function" ? nv(slot.v) : nv; }];
  },
  useEffect: function () {},
  useMemo: function (fn) { return fn(); },
  useRef: function (v) { return { current: v }; },
};
function mount(fn) {
  const ctx = { hooks: {}, idx: 0 };
  return function (props) { CTX = ctx; ctx.idx = 0; try { return fn(props); } finally { CTX = null; } };
}
function walk(node, out) {
  out = out || [];
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if (!node || typeof node !== "object") return out;
  out.push(node);
  walk(node.children, out);
  Object.keys(node.props || {}).forEach((k) => { const v = node.props[k]; if (v && typeof v === "object" && (v.type || Array.isArray(v))) walk(v, out); });
  return out;
}
function textOf(node) {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.children);
}
function named(tree, name) { return walk(tree).filter((n) => typeof n.type === "function" && n.type.name === name); }

// ── The page around the tab ───────────────────────────────────────────────────
require("./_load_domain.js").loadDomain(global.window || {});
let MOBILE = false;
window.LTP_useIsMobile = function () { return MOBILE; };
window.LTPRouter = { navigate: function () {} };
// Recorded as element types only — never called.
window.EmptyState = function EmptyState() { return null; };
window.LTPStatStrip = function LTPStatStrip() { return null; };
window.LTPSearchSelect = function LTPSearchSelect() { return null; };
window.LTPScrollStrip = function LTPScrollStrip() { return null; };
window.LTPModal = function LTPModal() { return null; };
window.Btn = function Btn() { return null; };
(0, eval)(fs.readFileSync(path.join(__dirname, "..", "modules", "labor.js"), "utf8"));
ok("LaborView is exported", typeof window.LaborView === "function");

// ── Fixtures ─────────────────────────────────────────────────────────────────
const CONTACTS = [
  { id: 5, firstName: "Jane", lastName: "Doe", email: "jane@example.com", isCrew: true, crewStatus: "active" },
  { id: 6, firstName: "Sam", lastName: "Lee", email: "sam@example.com", isCrew: true, crewStatus: "active" },
  { id: 7, firstName: "Alex", lastName: "Kim", email: "alex@example.com", isCrew: true, crewStatus: "active" },
  { id: 8, firstName: "Kim", lastName: "Park", email: "kim@example.com", isCrew: true, crewStatus: "active" },
];
const SERVICES = [{ id: 1, role: "A1", description: "Audio Lead", department: "Audio" }];
const COMPANIES = [{ id: 3, name: "Acme Events" }];
const P = (id, crewId, status) => ({ id: id, serviceId: 1, role: "A1", crewId: crewId, status: status });
const PROJECTS = [
  // Paid out: Jane worked both days and has been paid; Sam declined.
  { id: 1, name: "Spring Gala", companyId: 3, startDate: "2026-09-10", endDate: "2026-09-11", schedule: [
    { id: "g1", title: "Show", date: "2026-09-10", time: "08:00", endTime: "16:00", positions: [P("a", 5, "confirmed")] },
    { id: "g2", title: "Show", date: "2026-09-11", time: "08:00", endTime: "16:00", positions: [P("b", 5, "confirmed"), P("c", 6, "declined")] },
  ], fixedPositions: [] },
  // Jane paid; Alex paid for day 1 only; Kim hasn't answered.
  { id: 2, name: "Tech Expo", companyId: 3, startDate: "2026-09-20", endDate: "2026-09-21", schedule: [
    { id: "e1", title: "Load In", date: "2026-09-20", time: "07:00", endTime: "15:00", positions: [P("e1a", 5, "confirmed"), P("e1b", 7, "confirmed")] },
    { id: "e2", title: "Show", date: "2026-09-21", time: "09:00", endTime: "17:00", positions: [P("e2a", 7, "confirmed"), P("e2b", 8, "requested")] },
  ], fixedPositions: [] },
  // Sam accepted, still to confirm.
  { id: 3, name: "County Fair", companyId: 3, startDate: "2026-10-01", endDate: "2026-10-01", schedule: [
    { id: "f1", title: "Fair", date: "2026-10-01", time: "10:00", endTime: "18:00", positions: [P("fa", 6, "accepted")] },
  ], fixedPositions: [] },
];
const R = (id, projectId, contactId, positionIds, status, paidDates) => ({ id: id, token: "t" + id, projectId: projectId, contactId: contactId,
  positionIds: positionIds, status: status, silent: false, comment: "", sentAt: "2026-09-01T10:00:00Z",
  respondedAt: status === "pending" ? null : "2026-09-02T10:00:00Z", paidDates: paidDates || [] });
const REQUESTS = [
  R(1, 1, 5, ["a", "b"], "accepted", ["2026-09-10", "2026-09-11"]),
  R(2, 1, 6, ["c"], "declined"),
  R(3, 2, 5, ["e1a"], "accepted", ["2026-09-20"]),
  R(4, 2, 7, ["e1b", "e2a"], "accepted", ["2026-09-20"]),
  R(5, 2, 8, ["e2b"], "pending"),
  R(6, 3, 6, ["fa"], "accepted"),
  R(7, 3, 8, [], "withdrawn"),
];

// Render LaborView on the Crew Requests route, then the tab it hands its props
// to — with the request list the tab would have fetched.
function openTab(requests) {
  const view = mount(window.LaborView)({ contacts: CONTACTS, setContacts: function () {}, projects: PROJECTS, setProjects: function () {},
    services: SERVICES, clientRates: [], quotes: [], companies: COMPANIES, settings: {}, route: { sub: "requests" }, isAdmin: true, qbo: {} });
  const el = named(view, "CrewRequestsTab")[0];
  ok("the requests route renders the Crew Requests tab", !!el);
  const Tab = mount(el.type);
  const props = Object.assign({}, el.props, { crewRequests: requests });
  return function () { return Tab(props); };
}
function tiles(tree) {
  const t = named(tree, "FilterTiles")[0];
  const out = {};
  (t ? t.props.items : []).forEach((it) => { out[it.key] = it.value + (it.active ? "*" : ""); });
  return out;
}
function sections(tree) {
  return named(tree, "ProjectSection").map((s) => ({ title: s.props.title, text: textOf(s.children) }));
}
function who(tree) {
  return sections(tree).map((s) => s.title + ": " + CONTACTS.filter((c) => s.text.indexOf(c.firstName + " " + c.lastName) !== -1).map((c) => c.firstName).join(","));
}
function picker(tree) { return named(tree, "LTPSearchSelect")[0]; }
function clickTile(tree, key) { named(tree, "FilterTiles")[0].props.items.find((it) => it.key === key).onClick(); }

// ── The queue (desktop) ───────────────────────────────────────────────────────
let render = openTab(REQUESTS);
let tree = render();
eq("Q1 the tiles count the queue: paid-out requests and projects are not in it",
   tiles(tree), { all: "3", open: "2*", requested: "1", accepted: "1", confirmed: "1", declined: "0" });
eq("Q2 it opens on what still needs action", who(tree), ["Tech Expo: Kim", "County Fair: Sam"]);
ok("Q3 no stat strip or chips on a desktop", !named(tree, "LTPStatStrip").length && !named(tree, "LTPScrollStrip").length);
clickTile(tree, "all");
tree = render();
eq("Q4 All: Jane's paid-out request is gone from the Expo, Alex's half-paid one stays",
   who(tree), ["Tech Expo: Alex,Kim", "County Fair: Sam"]);
ok("Q5 …and the paid-out Gala is gone whole, Sam's decline with it", !sections(tree).some((s) => s.title === "Spring Gala"));
clickTile(tree, "confirmed");
tree = render();
eq("Q6 a tile narrows within the screen", who(tree), ["Tech Expo: Alex"]);
eq("Q7 …and says so on the tile", tiles(tree).confirmed, "1*");

// ── The project picker ───────────────────────────────────────────────────────
let sel = picker(tree);
ok("P1 the project picker sits in the toolbar", !!sel);
eq("P2 it lists the queue's projects after All Projects", sel.props.options.map((o) => o.label), ["All Projects", "Tech Expo", "County Fair"]);
eq("P3 …and the paid-out ones under their own heading",
   sel.props.sections.map((s) => [s.label, s.options.map((o) => o.label)]), [["Paid out", ["Spring Gala"]]]);
eq("P4 each option says whose and when", sel.props.options[1].sublabel, "Acme Events · Sep 20 – Sep 21");
eq("P5 the closed picker reads All Projects", sel.props.value, "all");

sel.props.onChange("1");
tree = render();
eq("P6 picking a paid-out project shows everything on it", who(tree), ["Spring Gala: Jane,Sam"]);
eq("P7 …the tiles count that project, on All", tiles(tree), { all: "2*", open: "0", requested: "0", accepted: "0", confirmed: "1", declined: "1" });
const gala = sections(tree)[0].text;
ok("P8 the paid-out request is badged Paid", /Jane Doe[\s\S]*Paid/.test(gala), gala);
ok("P9 the decline still reads Declined", gala.indexOf("Declined") !== -1, gala);
eq("P10 the picker holds the pick", picker(tree).props.value, "1");

picker(tree).props.onChange("2");
tree = render();
eq("P11 picking a live project shows its paid-out request too", who(tree), ["Tech Expo: Jane,Alex,Kim"]);

picker(tree).props.onChange("all");
tree = render();
eq("P12 All Projects goes back to the open queue", tiles(tree).open, "2*");
eq("P13 …and its rows", who(tree), ["Tech Expo: Kim", "County Fair: Sam"]);

// ── Nothing left ─────────────────────────────────────────────────────────────
render = openTab([REQUESTS[0], REQUESTS[1]]);
tree = render();
const empty = named(tree, "EmptyState")[0];
ok("E1 everything paid out: the queue is empty and says why",
   !!empty && /every request has been paid out/.test(empty.props.text) && /Pick a project above/.test(empty.props.text), empty && empty.props.text);
eq("E2 …with the paid-out project still in the picker", picker(tree).props.sections[0].options.map((o) => o.label), ["Spring Gala"]);
render = openTab([]);
ok("E3 no requests at all keeps its own message", /No crew requests yet/.test(named(render(), "EmptyState")[0].props.text));

// ── On a phone ───────────────────────────────────────────────────────────────
MOBILE = true;
render = openTab(REQUESTS);
tree = render();
const strip = named(tree, "LTPStatStrip")[0];
ok("M1 a phone gets the stat strip, not the tiles", !!strip && !named(tree, "FilterTiles").length);
eq("M2 …counting the queue", strip.props.items.filter(Boolean).map((i) => i.label + " " + i.value),
   ["Total 3", "Open 2", "Requested 1", "Accepted 1", "Confirmed 1"]);
const chips = named(tree, "LTPScrollStrip")[0];
eq("M3 the status chips scroll in a strip", walk(chips.children).filter((n) => n.type === "button").map(textOf),
   ["all", "open", "requested", "accepted", "confirmed", "declined"]);
walk(chips.children).find((n) => n.type === "button" && textOf(n) === "all").props.onClick();
tree = render();
const lines = walk(sections(tree).length ? named(tree, "ProjectSection")[0].children : [])
  .map(textOf).filter((t) => /^[✓•] /.test(t));
ok("M4 a paid shift says so", lines.some((t) => /Sep 20/.test(t) && /paid$/.test(t)), lines.join(" | "));
ok("M5 …an unpaid one doesn't", lines.some((t) => /Sep 21/.test(t)) && !lines.some((t) => /Sep 21/.test(t) && /paid$/.test(t)), lines.join(" | "));

console.log("crew-requests tab suite — PASS: " + pass + "   FAIL: " + fail);
if (fail) { fails.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
