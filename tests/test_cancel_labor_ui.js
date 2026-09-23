#!/usr/bin/env node
// The cancel dialog and the Labor tab's flow — components/cancel-labor.js:
//   * LTPCancelDialog — the pay share held to its reference, the totals line,
//     what Confirm hands back
//   * LTPCancelFlow   — what the Assignments and Payouts tabs write: the
//     cancellation on the live row, its schedule-activity line, the notice
//     parked in the tray (the pay template when a share is paid), the edit
//     dialog with Restore, the paid-day guard wrapping the write
//   * LTP_refillBooking — a new open slot, logged
// The engine underneath (components/domain-crew.js) has its own suite
// (tests/test_cancelled_labor.js).
//
// Pure Node, zero deps, under a small hook runner (state persists across
// renders the way React's does; effects are not run).
//   Run:  node tests/test_cancel_labor_ui.js
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
};
function mount(fn) {
  const ctx = { hooks: {}, idx: 0 };
  return function (props) { CTX = ctx; ctx.idx = 0; try { return fn(props); } finally { CTX = null; } };
}
// Every element in a tree, depth first.
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
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.children);
}
function button(tree, label) { return walk(tree).find((n) => n.props && typeof n.props.onClick === "function" && textOf(n) === label); }

require("./_load_domain.js").loadDomain(global.window || {});
window.LTP_THEME = window.LTP_THEME || {};
window.LTP_CURRENT_USER = "Jamie";
window.LTP_CURRENT_USER_ID = 4;
window.LTP_useIsMobile = function () { return false; };
window.LTPModal = function () { return null; };
window.Btn = function () { return null; };
let toasts = [], parked = [];
window.LTP_toast = function (t, o) { toasts.push([t, o && o.message]); };
window.LTP_outbox = { add: function (e) { parked.push(e); } };
(0, eval)(fs.readFileSync(path.join(__dirname, "..", "components", "cancel-labor.js"), "utf8"));
["LTPCancelDialog", "LTPCancelFlow", "LTP_refillBooking", "LTP_usePaidDayConflict"].forEach((k) => ok(k + " is exported", typeof window[k] === "function"));

// ── Fixtures ─────────────────────────────────────────────────────────────────
const SVCS = [
  { id: 1, role: "A1", description: "Audio Lead", department: "Audio", dayRate: 600, dayCost: 300 },
  { id: 2, role: "LX", description: "Lighting Tech", department: "Lighting", dayRate: 500, dayCost: 250 },
];
const CONTACTS = [{ id: 5, firstName: "Jane", lastName: "Doe", email: "jane@example.com" }];
const P = (id, sid, extra) => Object.assign({ id: id, serviceId: sid, role: sid === 1 ? "A1" : "LX", status: "confirmed", crewId: 5 }, extra || {});
const PROJ = { id: 9, name: "Gala", companyId: 7, scheduleActivity: [],
  schedule: [
    { id: "l", title: "Load-In", date: "2026-08-10", time: "08:00", endTime: "12:00", breaks: [], positions: [P("l1", 1), P("l2", 2, { crewId: 6 })] },
    { id: "s", title: "Show", date: "2026-08-10", time: "13:00", endTime: "17:00", breaks: [], positions: [P("s1", 1)] },
  ],
  fixedPositions: [] };
function store(projects) {
  const st = { projects: projects, writes: 0 };
  st.setProjects = function (fn) { st.writes++; st.projects = typeof fn === "function" ? fn(st.projects) : fn; };
  return st;
}
const posOf = (proj, id) => { let hit = null; proj.schedule.forEach((s) => s.positions.forEach((p) => { if (p.id === id) hit = p; })); return hit; };

// ── The dialog: shares, totals, what Confirm hands back ──────────────────────
{
  let got = null;
  const render = mount(window.LTPCancelDialog);
  const props = { title: "Cancel shift", refBill: 600, refPay: 300, hasCrew: true, fullMargin: false,
    initial: { bill: { mode: "percent", value: 50 }, pay: { mode: "percent", value: 50 } }, notify: true,
    onConfirm: function (sh, reason, notify) { got = [sh, reason, notify]; }, onClose: function () {} };
  let tree = render(props);
  ok("D0 totals line", textOf(tree).indexOf("Charged $300.00") >= 0 && textOf(tree).indexOf("Paid $150.00") >= 0 && textOf(tree).indexOf("Margin $150.00") >= 0, textOf(tree));
  // Type a pay amount above the reference: it is held to the reference.
  const payRow = walk(tree).filter((n) => n.props && n.props.label === "Pay crew")[0];
  payRow.props.onChange({ mode: "amount", value: "999" });
  tree = render(props);
  ok("D1 pay can't exceed its reference", textOf(tree).indexOf("Paid $300.00") >= 0, textOf(tree));
  button(tree.props.footer, "Cancel shift").props.onClick();
  eq("D2 confirm hands back the clamped shares, reason, notify", got, [{ bill: { mode: "percent", value: 50 }, pay: { mode: "amount", value: 300 } }, "", true]);

  const none = mount(window.LTPCancelDialog)(Object.assign({}, props, { hasCrew: false }));
  ok("D3 nobody to pay → no pay side", walk(none).some((n) => n.props && n.props.label === "Pay crew" && n.props.locked === "none"));
  ok("D4 no notify choice without crew", textOf(none).indexOf("Add to notify tray") < 0);
  const edit = mount(window.LTPCancelDialog)(Object.assign({}, props, { edit: true, onRestore: function () {} }));
  ok("D5 editing: Save and Restore", !!button(edit.props.footer, "Save") && !!button(edit.props.footer, "Restore"));
}

// ── The flow: cancel a booking from the Labor tab ────────────────────────────
{
  const st = store([PROJ]);
  let closed = 0, guarded = 0;
  const flow = mount(window.LTPCancelFlow);
  const tree = flow({ project: PROJ, positionIds: ["l1", "s1"], services: SVCS, clientRates: [], contacts: CONTACTS,
    settings: { cancellationDefaultBillPct: 100, cancellationDefaultPayPct: 25 }, setProjects: st.setProjects,
    onClose: function () { closed++; }, guard: function (run) { guarded++; run(); } });
  eq("F0 the dialog gets the booking priced as one person-day", [tree.props.title, tree.props.refBill, tree.props.refPay, tree.props.hasCrew, tree.props.subtitle],
     ["Cancel shift", 600, 300, true, "Jane Doe · A1 · August 10th, 2026"]);
  eq("F1 pre-filled from Settings", tree.props.initial, { bill: { mode: "percent", value: 100 }, pay: { mode: "percent", value: 25 } });
  tree.props.onConfirm({ bill: { mode: "percent", value: 50 }, pay: { mode: "percent", value: 50 } }, "Client moved the load-in", true);
  const pr = st.projects[0];
  eq("F2 written through the guard, once", [guarded, st.writes, closed], [1, 1, 1]);
  eq("F3 both shifts cancelled, the other person untouched", [posOf(pr, "l1").status, posOf(pr, "s1").status, posOf(pr, "l2").status], ["cancelled", "cancelled", "confirmed"]);
  eq("F4 who and when on the record", [posOf(pr, "l1").cancel.by, posOf(pr, "l1").cancel.byId, posOf(pr, "l1").cancel.reason], ["Jamie", 4, "Client moved the load-in"]);
  const act = pr.scheduleActivity[pr.scheduleActivity.length - 1];
  eq("F5 the activity line", [act.message, act.changes], ["Shift cancelled: Jane Doe as A1 · August 10th, 2026",
     [{ cat: "August 10th, 2026 — A1 Cancelled", detail: "Jane Doe · bill 50% $300.00 · pay 50% $150.00" }]]);
  eq("F6 the pay notice, each shift carrying its share", [parked.length, parked[0].template, parked[0].shifts.map((s) => s.cancellationPay)],
     [1, "crewCancelledWithPay", [75, 75]]);
  eq("F7 toast", toasts[toasts.length - 1], ["Shift cancelled", "Charged $300.00 · paid $150.00 · notice in the tray"]);

  // Edit it: the same reference, the current shares, Restore on offer.
  const edit = mount(window.LTPCancelFlow)({ project: pr, positionIds: ["l1", "s1"], services: SVCS, clientRates: [], contacts: CONTACTS,
    settings: {}, setProjects: st.setProjects, onClose: function () {} });
  eq("F8 edit dialog", [edit.props.title, edit.props.edit, edit.props.refBill, edit.props.refPay, edit.props.initial, edit.props.notify, typeof edit.props.onRestore],
     ["Cancellation", true, 600, 300, { bill: { mode: "percent", value: 50 }, pay: { mode: "percent", value: 50 } }, null, "function"]);
  edit.props.onConfirm({ bill: { mode: "amount", value: 450 }, pay: { mode: "none", value: 0 } }, "", false);
  const pr2 = st.projects[0];
  eq("F9 re-shared, no second notice", [posOf(pr2, "l1").cancel.bill.total + posOf(pr2, "s1").cancel.bill.total, posOf(pr2, "s1").cancel.pay.total, parked.length], [450, 0, 1]);
  eq("F10 logged as an edit", pr2.scheduleActivity[pr2.scheduleActivity.length - 1].changes[0].cat, "August 10th, 2026 — A1 Cancellation Edited");
  mount(window.LTPCancelFlow)({ project: pr2, positionIds: ["l1", "s1"], services: SVCS, clientRates: [], contacts: CONTACTS,
    settings: {}, setProjects: st.setProjects, onClose: function () {} }).props.onRestore();
  const pr3 = st.projects[0];
  eq("F11 restored, pay re-locked", [posOf(pr3, "l1").status, "cancel" in posOf(pr3, "l1"), !!(posOf(pr3, "l1").pay && posOf(pr3, "l1").pay.lockedAt)], ["confirmed", false, true]);
  eq("F12 logged as a restore", pr3.scheduleActivity[pr3.scheduleActivity.length - 1].changes[0], { cat: "August 10th, 2026 — A1 Restored", detail: "Jane Doe · back to confirmed" });
}

// ── An unpaid cancellation parks the plain notice; Reopen passes through ─────
{
  parked = [];
  const st = store([PROJ]);
  let reopened = 0;
  const tree = mount(window.LTPCancelFlow)({ project: PROJ, positionIds: ["l2"], services: SVCS, clientRates: [], contacts: CONTACTS,
    settings: {}, setProjects: st.setProjects, onClose: function () {}, onReopen: function () { reopened++; } });
  tree.props.onReopen();
  eq("R0 Reopen slot instead runs the caller's path", [reopened, st.writes], [1, 0]);
  tree.props.onConfirm({ bill: { mode: "percent", value: 50 }, pay: { mode: "none", value: 0 } }, "", true);
  eq("R1 no pay → the confirmed-removal notice", parked.map((p) => [p.template, p.crewId]), [["crewCancelled", 6]]);
  const quiet = store([PROJ]);
  parked = [];
  mount(window.LTPCancelFlow)({ project: PROJ, positionIds: ["l2"], services: SVCS, clientRates: [], contacts: CONTACTS,
    settings: {}, setProjects: quiet.setProjects, onClose: function () {} }).props.onConfirm({ bill: { mode: "percent", value: 50 }, pay: { mode: "percent", value: 50 } }, "", false);
  eq("R2 notify unticked → nothing parked", parked.length, 0);
}

// ── Refill ──────────────────────────────────────────────────────────────────
{
  const st = store([PROJ]);
  const cancelled = window.LTP_projectBookingWrite(PROJ, window.LTP_projectBooking(PROJ, ["l1"], SVCS, {}), "cancel",
    { bill: { mode: "percent", value: 50 }, pay: { mode: "percent", value: 50 } }, SVCS, {}, { at: "t" }, window.LTP_genId).project;
  st.projects = [cancelled];
  window.LTP_refillBooking(cancelled, ["l1"], st.setProjects, SVCS, CONTACTS);
  const pr = st.projects[0];
  const fresh = pr.schedule[0].positions[pr.schedule[0].positions.length - 1];
  eq("RF0 a new open A1 slot on the same shift", [pr.schedule[0].positions.length, fresh.serviceId, fresh.status, fresh.crewId], [3, 1, "open", null]);
  eq("RF1 logged", pr.scheduleActivity[pr.scheduleActivity.length - 1].changes[0], { cat: "August 10th, 2026 — A1 Refilled", detail: "1 open position added" });
}

// ── A signed-off day blocks cancel and restore ──────────────────────────────
{
  const signed = Object.assign({}, PROJ, { schedule: window.LTP_signOffDay(PROJ.schedule, 5, "2026-08-10", {}, SVCS, {}, "t1", "Jamie") });
  const st = store([signed]);
  const tree = mount(window.LTPCancelFlow)({ project: signed, positionIds: ["s1"], services: SVCS, clientRates: [], contacts: CONTACTS, settings: {}, setProjects: st.setProjects, onClose: function () {} });
  eq("G0 one shift of a signed day gets the block, not the dialog", [tree.type === window.LTPModal, tree.props.title, st.writes], [true, "Day signed off", 0]);
  const whole = mount(window.LTPCancelFlow)({ project: signed, positionIds: ["l1", "s1"], services: SVCS, clientRates: [], contacts: CONTACTS, settings: {}, setProjects: st.setProjects, onClose: function () {} });
  eq("G1 the whole booking still cancels", whole.type === window.LTPCancelDialog, true);
  whole.props.onConfirm({ bill: { mode: "percent", value: 50 }, pay: { mode: "percent", value: 50 } }, "", false);
  const pr = st.projects[0];
  eq("G2 both frozen figures replaced by the shares", [posOf(pr, "l1").work.state, posOf(pr, "s1").work.state], ["cancelled", "cancelled"]);
  // A cancellation riding on a signed day can be re-shared, not restored.
  const one = store([PROJ]);
  mount(window.LTPCancelFlow)({ project: PROJ, positionIds: ["s1"], services: SVCS, clientRates: [], contacts: CONTACTS, settings: {}, setProjects: one.setProjects, onClose: function () {} })
    .props.onConfirm({ bill: { mode: "percent", value: 50 }, pay: { mode: "percent", value: 50 } }, "", false);
  const later = Object.assign({}, one.projects[0], { schedule: window.LTP_signOffDay(one.projects[0].schedule, 5, "2026-08-10", {}, SVCS, {}, "t1", "Jamie") });
  const edit = mount(window.LTPCancelFlow)({ project: later, positionIds: ["s1"], services: SVCS, clientRates: [], contacts: CONTACTS, settings: {}, setProjects: one.setProjects, onClose: function () {} });
  eq("G3 edit stays, Restore goes", [edit.type === window.LTPCancelDialog, edit.props.edit, edit.props.onRestore], [true, true, null]);
}

console.log("cancel-labor UI suite — PASS: " + pass + "   FAIL: " + fail);
if (fail) { fails.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
