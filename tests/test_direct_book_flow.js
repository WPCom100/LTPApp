#!/usr/bin/env node
// Labor → Assignments: booking crew directly ("Book Without Emailing") and
// sending requests — modules/labor.js AssignmentsTab.sendSelected, plus the
// reconcile that bridges request answers into the schedule.
//
// WHY THIS SUITE EXISTS
//   Crew booked directly came back NOT confirmed and stayed on the Assignments
//   tab. Two things, both in this one path:
//     * Several groups on one project were POSTed at once. Each send rewrites
//       that project's schedule JSON server-side, so the later write put the
//       earlier booking back to `open`; the request row still said accepted,
//       and the next list healed the slot to "Accepted" — which a direct book
//       has no Confirm button to leave. On the client, the per-group response
//       rows were installed in list order, so an older row could land over a
//       newer one and revert a confirm on screen too.
//     * The pay stamp was written AFTER the server's row (already `confirmed`)
//       had been installed, against from-statuses of open/declined only — so it
//       found nothing to stamp. Confirmed, but "not locked" in Payouts, and no
//       activity line.
//   Now: groups go out one project at a time (projects in parallel), every
//   returned row is installed before any local write, the stamp lands on the
//   confirmed row, and a silent request's floor is `confirmed`.
//
// Pure Node, zero deps, under a small hook runner (state persists across
// renders the way React's does; effects are not run; child components are
// recorded, not called). fetch is a fake server whose replies the test releases
// by hand, so the ORDER sends go out in is observable.
//   Run:  node tests/test_direct_book_flow.js
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, got, want) { ok(n, JSON.stringify(got) === JSON.stringify(want), "got " + JSON.stringify(got) + " exp " + JSON.stringify(want)); }
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

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
function buttons(tree, label) { return walk(tree).filter((n) => n.props && typeof n.props.onClick === "function" && textOf(n) === label); }
function buttonStarting(tree, prefix) { return walk(tree).find((n) => n.props && typeof n.props.onClick === "function" && textOf(n).indexOf(prefix) === 0); }

// ── The page around the tab ───────────────────────────────────────────────────
require("./_load_domain.js").loadDomain(global.window || {});
global.localStorage = { getItem() { return null; }, setItem() {} };
window.LTP_useIsMobile = function () { return false; };
window.LTPRouter = { navigate: function () {} };
window.LTP_CURRENT_USER = "Jamie";
["EmptyState", "LTPStatStrip", "LTPSearchSelect", "LTPScrollStrip", "LTPModal", "Btn", "StatCard", "LTPCancelFlow"]
  .forEach((k) => { window[k] = function () { return null; }; Object.defineProperty(window[k], "name", { value: k }); });
window.LTP_usePaidDayConflict = function () { return null; };
// The crew picker's option builder lives in components/search-dropdown.js; the
// picker itself is recorded, never opened, so an empty menu is enough.
window.LTP_crewSelectOptions = function () { return { options: [], sections: [], moreOptions: [], moreLabel: "" }; };
window.LTP_pickerChip = function () { return null; };
let toasts = [];
window.LTP_toast = function (t, o) { toasts.push([t, o && o.message, o && o.variant]); };
window.LTP_outbox = { add: function () {} };
(0, eval)(fs.readFileSync(path.join(__dirname, "..", "modules", "labor.js"), "utf8"));
ok("LaborView is exported", typeof window.LaborView === "function");

// ── Fixtures ─────────────────────────────────────────────────────────────────
const CONTACTS = [
  { id: 5, firstName: "Jane", lastName: "Doe", email: "jane@example.com", isCrew: true, crewStatus: "active" },
  { id: 6, firstName: "Sam", lastName: "Lee", email: "", isCrew: true, crewStatus: "active" },   // texts only
  { id: 7, firstName: "Alex", lastName: "Kim", email: "alex@example.com", isCrew: true, crewStatus: "active" },
];
const SERVICES = [{ id: 1, role: "A1", description: "Audio Lead", department: "Audio", dayRate: 600, dayCost: 300 }];
const COMPANIES = [{ id: 3, name: "Acme Events" }];
const P = (id, crewId, status) => ({ id: id, serviceId: 1, role: "A1", crewId: crewId, status: status || "open" });
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function fixtures() {
  return [
    { id: 1, name: "Spring Gala", companyId: 3, status: "confirmed", startDate: "2026-09-10", endDate: "2026-09-11", scheduleActivity: [], schedule: [
      { id: "g1", title: "Show", date: "2026-09-10", time: "08:00", endTime: "16:00", breaks: [], positions: [P("a", 5), P("b", 6)] },
      { id: "g2", title: "Show", date: "2026-09-11", time: "08:00", endTime: "16:00", breaks: [], positions: [P("c", 5)] },
    ], fixedPositions: [] },
    { id: 2, name: "Tech Expo", companyId: 3, status: "confirmed", startDate: "2026-09-20", endDate: "2026-09-20", scheduleActivity: [], schedule: [
      { id: "e1", title: "Load In", date: "2026-09-20", time: "07:00", endTime: "15:00", breaks: [], positions: [P("e", 7)] },
    ], fixedPositions: [] },
  ];
}
const posOf = (projects, pid, id) => { let hit = null; projects.find((p) => p.id === pid).schedule.forEach((s) => s.positions.forEach((p) => { if (p.id === id) hit = p; })); return hit; };

// ── The state layer, as the tab sees it ──────────────────────────────────────
// `store` plays usePersistentState's eager setter + LTP_DATA_LIVE mirror;
// `adopted` records what the tab installed as server state (data-state.js
// adoptRow): the row replaces the local one and its _rev becomes the token.
let store, adopted, revs;
function makeStore(projects) {
  store = { projects: projects };
  store.setProjects = function (fn) {
    store.projects = typeof fn === "function" ? fn(store.projects) : fn;
    window.LTP_DATA_LIVE.projects = store.projects;
  };
  window.LTP_DATA_LIVE = { projects: store.projects };
  adopted = []; revs = {};
  window.LTP_STATE = {
    adoptRow: function (key, row) {
      if (key !== "projects" || !row || row.id == null) return false;
      const stripped = Object.assign({}, row); delete stripped._rev;
      adopted.push({ id: row.id, rev: row._rev, statuses: row.schedule.map((s) => s.positions.map((p) => p.status)) });
      if (row._rev != null) revs[row.id] = row._rev;
      store.setProjects(store.projects.map((p) => p.id === row.id ? stripped : p));
      return true;
    },
  };
}

// ── A fake server for POST /api/crew-requests/send ───────────────────────────
// Processes each send the moment it ARRIVES (read the schedule, flip this
// crew member's positions, write it back, bump the rev) and holds the reply
// until the test releases it — so what goes out when is observable, and the
// row each reply carries is the server's state at arrival, as in life.
let server, calls, pendingReplies, requestsList;
function makeServer(projects) {
  server = { projects: clone(projects), rev: {}, fail: {} };
  calls = []; pendingReplies = []; requestsList = [];
  global.fetch = function (url, opts) {
    opts = opts || {};
    const method = opts.method || "GET";
    if (method === "GET") {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(requestsList) });
    }
    const body = JSON.parse(opts.body);
    calls.push({ url: url, body: body, at: calls.length });
    const proj = server.projects.find((p) => p.id === body.projectId);
    const key = body.contactId + "|" + body.projectId;
    let reply;
    if (server.fail[key]) {
      reply = { ok: false, status: 400, body: { detail: { reason: "no sendable positions" } } };
    } else {
      const to = body.silent ? "confirmed" : "requested";
      const moved = [];
      proj.schedule.forEach((s) => s.positions.forEach((p) => {
        if (p.crewId === body.contactId && body.positionIds.indexOf(p.id) >= 0 && (p.status === "open" || p.status === "declined")) { p.status = to; moved.push(p.id); }
      }));
      server.rev[proj.id] = (server.rev[proj.id] || 0) + 1;
      const row = Object.assign(clone(proj), { _rev: "r" + proj.id + "-" + server.rev[proj.id] });
      reply = { ok: true, status: 200, body: { id: calls.length, status: body.silent ? "accepted" : "pending", silent: !!body.silent,
        positionIds: moved, project: row, emailStatus: body.silent ? { emailed: false, silent: true } : { emailed: true } } };
    }
    return new Promise((resolve) => {
      pendingReplies.push({ key: key, release: () => resolve({ ok: reply.ok, status: reply.status, json: () => Promise.resolve(reply.body) }) });
    });
  };
}
async function release(n) {
  for (let i = 0; i < (n || 1); i++) { const r = pendingReplies.shift(); if (r) r.release(); }
  await settle();
}

// ── Render LaborView on the Assignments route, then drive its tab ────────────
function page() {
  const View = mount(window.LaborView);
  let Tab = null, tabProps = null;
  function render() {
    const view = View({ contacts: CONTACTS, setContacts: function () {}, projects: store.projects, setProjects: store.setProjects,
      services: SERVICES, clientRates: [], quotes: [], companies: COMPANIES, settings: {}, route: { sub: "assignments" }, isAdmin: true, qbo: {} });
    const el = named(view, "AssignmentsTab")[0];
    if (!Tab) Tab = mount(el.type);
    tabProps = el.props;
    return Tab(el.props);
  }
  return { render: render, props: () => tabProps };
}
// Open the send panel (every pending group pre-selected), then the action asked for.
function openPanel(pg) {
  let tree = pg.render();
  const trigger = buttonStarting(tree, "Send ");
  ok("  the Send … Requests ▸ trigger is on the tab", !!trigger, textOf(tree).slice(0, 200));
  trigger.props.onClick();
  return pg.render();
}
function clickBookDirect(pg, tree) {
  buttons(tree, "Book Without Emailing")[0].props.onClick();      // the panel's quiet secondary action
  tree = pg.render();
  const dlg = walk(tree).find((n) => n.type === window.LTPModal && n.props.zIndex === 1100);
  ok("  the direct-book confirmation sits above the panel", !!dlg);
  buttons(dlg, "Book Without Emailing")[0].props.onClick();       // confirm → sendSelected(true)
  return pg.render();
}

(async function () {
  // ── A. Two crew members booked directly on one project ────────────────────
  {
    makeStore([fixtures()[0]]); makeServer(store.projects); toasts = [];
    const pg = page();
    let tree = openPanel(pg);
    ok("A0 both groups are in the panel", textOf(tree).indexOf("Recipients (2)") >= 0, textOf(tree).slice(0, 300));
    clickBookDirect(pg, tree);
    await settle();
    eq("A1 only ONE send has gone out — same project, so one at a time", calls.length, 1);
    const shiftsOf = { 5: ["a", "c"], 6: ["b"] };
    const first = calls[0].body;
    eq("A2 it is one of the two, direct, with all of that person's shifts", [first.silent, first.positionIds.slice().sort()], [true, shiftsOf[first.contactId]]);
    await release(1);
    eq("A3 the second goes out only once the first has answered", calls.length, 2);
    const second = calls[1].body;
    eq("A4 and it is the other one", [[first.contactId, second.contactId].sort(), second.positionIds.slice().sort()], [[5, 6], shiftsOf[second.contactId]]);
    eq("A5 nothing is installed or written until every reply is in", [adopted.length, posOf(store.projects, 1, "a").status], [0, "open"]);
    await release(1);
    // The server ended with every booking in place — no lost write.
    eq("A6 the server holds all three confirmed", server.projects[0].schedule.map((s) => s.positions.map((p) => p.status)), [["confirmed", "confirmed"], ["confirmed"]]);
    // The window installed both rows in send order and kept the newest token.
    eq("A7 both response rows installed, oldest first", adopted.map((a) => a.rev), ["r1-1", "r1-2"]);
    eq("A8 the row the second send returned already carried Jane's confirm", adopted[1].statuses, [["confirmed", "confirmed"], ["confirmed"]]);
    eq("A9 the If-Match token is the newest", revs[1], "r1-2");
    const a = posOf(store.projects, 1, "a"), b = posOf(store.projects, 1, "b"), c = posOf(store.projects, 1, "c");
    eq("A10 every booked position reads confirmed on screen", [a.status, b.status, c.status], ["confirmed", "confirmed", "confirmed"]);
    ok("A11 the pay stamp landed on the confirmed rows — Jane both days", !!(a.pay && a.pay.lockedAt && c.pay && c.pay.lockedAt), JSON.stringify([a.pay, c.pay]));
    ok("A12 and on Sam's", !!(b.pay && b.pay.lockedAt && b.pay.total > 0), JSON.stringify(b.pay));
    const acts = store.projects[0].scheduleActivity.map((e) => e.message);
    eq("A13 one activity line per crew member", acts.slice().sort(), ["Crew booked directly (no email): Jane Doe (2 positions)", "Crew booked directly (no email): Sam Lee (1 position)"]);
    eq("A14 the toast counts both", toasts.filter((t) => t[0] === "2 crew members booked").length, 1);
    // Nothing is left for the send queue.
    tree = pg.render();
    ok("A15 the Assignments tab offers no Send trigger any more", !buttonStarting(tree, "Send "));
    ok("A16 and no row says Ready to send", textOf(tree).indexOf("Ready to send") < 0);
  }

  // ── B. Emailed requests on one project are sequenced the same way ─────────
  {
    makeStore([fixtures()[0]]); makeServer(store.projects); toasts = [];
    const pg = page();
    let tree = openPanel(pg);
    // (Sam has no email on file; the fake server does not check addresses —
    // the ordering is what this scenario is about.)
    buttons(tree, "Send 2 Requests")[0].props.onClick();          // sendSelected(false)
    await settle();
    eq("B1 the mirror shows both requested at once", [posOf(store.projects, 1, "a").status, posOf(store.projects, 1, "b").status], ["requested", "requested"]);
    eq("B2 but only one send is in flight", calls.length, 1);
    await release(1);
    eq("B3 the second follows the first's reply", calls.length, 2);
    await release(1);
    eq("B4 server: every slot requested, none lost", server.projects[0].schedule.map((s) => s.positions.map((p) => p.status)), [["requested", "requested"], ["requested"]]);
    // The mirror goes in first as server state without a token (the move the
    // server is known to be making), then the two response rows in send order.
    eq("B5 mirror, then rows oldest first; token newest", [adopted.map((x) => x.rev), revs[1]], [[undefined, "r1-1", "r1-2"], "r1-2"]);
    eq("B6 nothing reverted to open on screen", [posOf(store.projects, 1, "a").status, posOf(store.projects, 1, "b").status, posOf(store.projects, 1, "c").status], ["requested", "requested", "requested"]);
    eq("B7 the toast", toasts.filter((t) => t[0] === "2 crew requests sent").length, 1);
  }

  // ── C. Different projects still go out together ───────────────────────────
  {
    const fx = fixtures();
    fx[0].schedule[0].positions = [P("a", 5)]; fx[0].schedule[1].positions = [];   // one group per project
    makeStore(fx); makeServer(store.projects); toasts = [];
    const pg = page();
    let tree = openPanel(pg);
    clickBookDirect(pg, tree);
    await settle();
    eq("C1 two projects → two sends in flight at once", calls.map((c) => c.body.projectId).sort(), [1, 2]);
    await release(2);
    eq("C2 both confirmed on screen", [posOf(store.projects, 1, "a").status, posOf(store.projects, 2, "e").status], ["confirmed", "confirmed"]);
    eq("C3 each project took its own row and token", [revs[1], revs[2]], ["r1-1", "r2-1"]);
    ok("C4 both stamped", !!(posOf(store.projects, 1, "a").pay && posOf(store.projects, 2, "e").pay));
  }

  // ── D. One booking refused: the other still lands whole ───────────────────
  {
    makeStore([fixtures()[0]]); makeServer(store.projects); toasts = [];
    server.fail["6|1"] = true;                                       // Sam's send is refused
    const pg = page();
    let tree = openPanel(pg);
    clickBookDirect(pg, tree);
    await settle(); await release(1); await release(1);
    const a = posOf(store.projects, 1, "a"), b = posOf(store.projects, 1, "b");
    eq("D1 Jane confirmed and stamped, Sam still open", [a.status, !!a.pay, b.status, !!b.pay], ["confirmed", true, "open", false]);
    eq("D2 the row installed is the one send that stuck", adopted.map((x) => x.rev), ["r1-1"]);
    ok("D3 the producer is told which one failed", toasts.some((t) => t[0] === "Some bookings didn't save" && /Sam Lee/.test(t[1])), JSON.stringify(toasts));
    tree = pg.render();
    ok("D4 Sam is still Ready to send", textOf(tree).indexOf("Ready to send") >= 0);
  }

  // ── E. A direct book's positions heal to confirmed, never accepted ────────
  // The reconcile that bridges request answers into the schedule: a silent
  // request found over positions at open/requested/accepted (drift) lifts them
  // to confirmed — an emailed accept still stops at accepted.
  {
    const fx = fixtures();
    fx[0].schedule[0].positions = [P("a", 5, "accepted"), P("b", 6, "open")];
    fx[0].schedule[1].positions = [P("c", 5, "requested"), P("d", 7, "requested")];
    makeStore(fx); makeServer(store.projects); toasts = [];
    requestsList = [
      { id: 1, projectId: 1, contactId: 5, positionIds: ["a", "c"], status: "accepted", silent: true },    // direct book, drifted
      { id: 2, projectId: 1, contactId: 6, positionIds: ["b"], status: "accepted", silent: true },         // direct book knocked to open
      { id: 3, projectId: 1, contactId: 7, positionIds: ["d"], status: "accepted", silent: false },        // emailed, crew said yes
    ];
    const pg = page();
    pg.render();
    pg.props().reloadCrewRequests();
    await settle();
    eq("E1 the direct books read confirmed again", [posOf(store.projects, 1, "a").status, posOf(store.projects, 1, "c").status, posOf(store.projects, 1, "b").status], ["confirmed", "confirmed", "confirmed"]);
    eq("E2 the emailed accept stays accepted for the producer to confirm", posOf(store.projects, 1, "d").status, "accepted");
    // Reassigned away: the request's crew member no longer holds the slot.
    fx[0].schedule[0].positions[0].crewId = 7;
    makeStore(clone(fx)); requestsList = [{ id: 1, projectId: 1, contactId: 5, positionIds: ["a"], status: "accepted", silent: true }];
    const pg2 = page(); pg2.render(); pg2.props().reloadCrewRequests();
    await settle();
    eq("E3 a slot handed to someone else never inherits the direct book", posOf(store.projects, 1, "a").status, "accepted");
  }

  console.log("direct-book flow suite — PASS: " + pass + "   FAIL: " + fail);
  if (fail) { fails.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
  console.log("All " + pass + " assertions passed.");
})().catch((e) => { console.error(e); fails.forEach((f) => console.log("  ✗ " + f)); console.log("passed so far: " + pass); process.exit(1); });
