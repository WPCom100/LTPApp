#!/usr/bin/env node
// The builders' side of the labor sync — components/labor-sync.js::
// LTP_useLaborSync, the hook both document builders call. The engine it drives
// (components/domain-labor-sync.js) has its own suite; this one pins what the
// hook does with it:
//   * which projects get a banner, in which mode, and when none do
//   * Apply / Keep / Keep all as ordinary draft edits (edit mode)
//   * the activity rows a save records, and that the log empties after
//   * a removed invoice line from a quote queued for the quote rollback
//   * a legacy document linked by its first Apply or Keep
//   * Keep as is on a locked invoice: a marker-only write, never setDraft
//   * the open-on-arrival handoff from the schedule's Send
//
// Pure Node, zero deps, under a small hook runner (state persists across calls
// the way React's does; effects are not run).
//   Run:  node tests/test_labor_sync_ui.js
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, got, want) { ok(n, JSON.stringify(got) === JSON.stringify(want), "got " + JSON.stringify(got) + " exp " + JSON.stringify(want)); }

// ── A minimal hook runtime ────────────────────────────────────────────────────
let CTX = null;
function depsChanged(a, b) { return !a || !b || a.length !== b.length || a.some((x, i) => x !== b[i]); }
global.React = {
  createElement: function (type, props) { return { type: type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) }; },
  useState: function (init) {
    const c = CTX, i = c.idx++;
    if (!(i in c.hooks)) c.hooks[i] = { v: typeof init === "function" ? init() : init };
    const slot = c.hooks[i];
    return [slot.v, function (nv) { slot.v = typeof nv === "function" ? nv(slot.v) : nv; }];
  },
  useRef: function (init) { const c = CTX, i = c.idx++; if (!(i in c.hooks)) c.hooks[i] = { current: init }; return c.hooks[i]; },
  useMemo: function (f, deps) {
    const c = CTX, i = c.idx++;
    if (!(i in c.hooks) || depsChanged(c.hooks[i].deps, deps)) c.hooks[i] = { v: f(), deps: deps };
    return c.hooks[i].v;
  },
  useEffect: function () {},
};
function mount(hookFn) {
  const ctx = { hooks: {}, idx: 0 };
  return function (opts) { CTX = ctx; ctx.idx = 0; try { return hookFn(opts); } finally { CTX = null; } };
}

require("./_load_domain.js").loadDomain(global.window || {});
window.LTP_THEME = window.LTP_THEME || {};
window.LTP_CURRENT_USER = "Test User";
let toasts = [];
window.LTP_toast = function (t, o) { toasts.push(t); };
(0, eval)(fs.readFileSync(path.join(__dirname, "..", "components", "labor-sync.js"), "utf8"));
ok("hook is exported", typeof window.LTP_useLaborSync === "function");
ok("banner is exported", typeof window.LTPLaborSyncBanner === "function");
ok("review is exported", typeof window.LTPLaborSyncReview === "function");

// ── Fixtures ─────────────────────────────────────────────────────────────────
const SVCS = [
  { id: 1, role: "A1", description: "Audio Lead", department: "Audio", dayRate: 600, dayCost: 300 },
  { id: 2, role: "LX", description: "Lighting Tech", department: "Lighting", dayRate: 500, dayCost: 250 },
];
const MEAL = [{ startTime: "12:00", endTime: "12:30", type: "unpaid" }];
const pos = (id, sid) => ({ id: id, serviceId: sid, role: "R", status: "confirmed", crewId: 5 });
const day = (id, date, positions) => ({ id: id, date: date, time: "08:00", endTime: "16:00", breaks: MEAL, positions: positions });
const S0 = [day("d1", "2026-08-10", [pos("p1", 1), pos("p2", 2)]), day("d2", "2026-08-11", [pos("p3", 1)])];
const S1 = S0.concat([day("d3", "2026-08-12", [pos("p4", 1)])]);   // A1 gains a day
let n = 0; const gen = (p) => p + "-" + (++n);
function docFrom(schedule, extra) {
  const secs = window.LTP_scheduleLaborSections(schedule, SVCS, {}, "one", window.LTP_formatDate, gen, [], 42, "t0")
    .map((s) => Object.assign({}, s, { projectId: 42 }));
  return Object.assign({ id: 3, status: "draft", projectId: 42, projectIds: [42], clientType: "company", companyId: 7, sections: secs, activity: [] }, extra || {});
}
const P = (schedule) => [{ id: 42, name: "Summit Keynote", companyId: 7, schedule: schedule, fixedPositions: [] }];
function base(extra) {
  const calls = { setDraft: [], writeLocked: [], removed: [] };
  return {
    calls: calls,
    opts: Object.assign({ kind: "quote", projects: P(S1), svcs: SVCS, contacts: [], mode: "edit", genId: gen,
      setDraft: (d) => calls.setDraft.push(d), writeLocked: (p) => calls.writeLocked.push(p),
      onRemovedLinked: (l) => calls.removed.push(l) }, extra || {}),
  };
}
const line = (doc, key) => { for (const s of doc.sections) for (const it of s.items) if (it.laborSync && it.laborSync.key === key) return it; return null; };

// ── Banners ──────────────────────────────────────────────────────────────────
{
  const run = mount(window.LTP_useLaborSync);
  const b = base({ draft: docFrom(S0) });
  const ls = run(b.opts);
  eq("B0 one banner for the moved project", ls.banners.map((x) => [x.projectId, x.drift.count, x.linking]), [[42, 1, null]]);
  eq("B1 its name", ls.nameOf(42), "Summit Keynote");
  eq("B2 no review yet", ls.review, null);
  const off = mount(window.LTP_useLaborSync)(Object.assign({}, b.opts, { mode: "off" }));
  eq("B3 an accepted quote (mode off) shows nothing", off.banners, []);
  const inStep = mount(window.LTP_useLaborSync)(Object.assign({}, b.opts, { projects: P(S0) }));
  eq("B4 a document in step shows nothing", inStep.banners, []);
  ls.openReview(42);
  const again = run(b.opts);
  eq("B5 the review opens on the project's drift", [again.review && again.review.projectId, again.review && again.review.drift.count], [42, 1]);
  again.openReview(99);
  eq("B6 a project with nothing to review does not open", run(b.opts).review.projectId, 42);
}

// ── Apply, then save ─────────────────────────────────────────────────────────
{
  const run = mount(window.LTP_useLaborSync);
  const b = base({ draft: docFrom(S0) });
  const ls = run(b.opts);
  ls.apply(42, ["svc:1|day"]);
  eq("A0 Apply is one draft edit", b.calls.setDraft.length, 1);
  const d = b.calls.setDraft[0];
  eq("A1 the applied line", [line(d, "svc:1|day").qty, line(d, "svc:1|day").laborSync.snap.qty], [3, 3]);
  ok("A2 the rest of the draft is the same object", d.activity === b.opts.draft.activity && d.projectId === 42);
  const acts = run(Object.assign({}, b.opts, { draft: d })).takeActivity({ date: "2026-09-23", time: "10:00", user: "Test User" });
  eq("A3 one activity entry, typed and worded", acts.map((a) => [a.type, a.message, a.user, a.date, a.time]),
     [["updated", "Labor synced from Summit Keynote schedule (1 applied)", "Test User", "2026-09-23", "10:00"]]);
  eq("A4 its rows say what moved", acts[0].changes.map((c) => c.cat), ["A1 — Audio Lead · Day"]);
  eq("A5 the log empties once taken", run(b.opts).takeActivity({ date: "x", time: "y", user: "z" }), []);
  run(b.opts).apply(42, []);
  eq("A6 nothing ticked is no edit", b.calls.setDraft.length, 1);
  run(b.opts).apply(42, ["svc:9|day"]);
  eq("A7 a key that is not a change is no edit", b.calls.setDraft.length, 1);
}

// ── Keep, Keep all, and the log's reset ──────────────────────────────────────
{
  const run = mount(window.LTP_useLaborSync);
  const b = base({ draft: docFrom(S0) });
  run(b.opts).keepAll(42);
  const d = b.calls.setDraft[0];
  eq("K0 Keep all moves the snapshot, not the billed line", [line(d, "svc:1|day").qty, line(d, "svc:1|day").laborSync.snap.qty], [2, 3]);
  const acts = run(b.opts).takeActivity({ date: "d", time: "t", user: "u" });
  eq("K1 the entry says it was kept", [acts[0].message, acts[0].changes[0].detail], ["Labor synced from Summit Keynote schedule (1 kept)", "Kept ×2 (schedule ×3)"]);
  run(b.opts).keep(42, ["svc:1|day"]);
  run(b.opts).resetLog();
  eq("K2 resetLog forgets a discarded session", run(b.opts).takeActivity({ date: "d", time: "t", user: "u" }), []);
}

// ── An invoice line from a quote: removal queued for the rollback ────────────
{
  const run = mount(window.LTP_useLaborSync);
  const inv = docFrom(S0, { quoteId: 11 });
  inv.sections = inv.sections.map((s) => Object.assign({}, s, { items: s.items.map((it) => Object.assign({}, it, { sourceItemId: "q-" + it.id, linkedQty: it.qty })) }));
  const NO_LX = [day("d1", "2026-08-10", [pos("p1", 1)]), day("d2", "2026-08-11", [pos("p3", 1)])];
  const b = base({ kind: "invoice", draft: inv, projects: P(NO_LX), fallbackQuoteId: 11 });
  run(b.opts).apply(42, ["svc:2|day"]);
  eq("R0 the removed linked line is queued, with the invoice's quote as fallback", b.calls.removed,
     [[{ quoteId: 11, sourceItemId: "q-" + line(inv, "svc:2|day").id, qty: 1, name: "LX — Lighting Tech" }]]);
  eq("R1 and gone from the draft", line(b.calls.setDraft[0], "svc:2|day"), null);
}

// ── A legacy document is linked by its first action ──────────────────────────
{
  const run = mount(window.LTP_useLaborSync);
  const legacy = { id: 4, status: "draft", projectId: 42, projectIds: [42], activity: [], sections: [
    { id: "L", label: "Labor", projectId: 42, items: [
      { id: "a", type: "service", serviceId: 2, name: "LX — Lighting Tech", rateType: "day", qty: 1, unitPrice: 500, cost: 250 },
      { id: "b", type: "service", serviceId: 1, name: "A1 — Audio Lead", rateType: "day", qty: 2, unitPrice: 600, cost: 300 } ] }] };
  const b = base({ draft: legacy });
  const ls = run(b.opts);
  eq("L0 a legacy document gets a banner only because linking shows a difference",
     ls.banners.map((x) => [x.projectId, x.drift.count, x.linking && x.linking.linked]), [[42, 1, ["svc:2|day", "svc:1|day"]]]);
  eq("L1 in step, no banner", mount(window.LTP_useLaborSync)(Object.assign({}, b.opts, { projects: P(S0) })).banners, []);
  ls.apply(42, ["svc:1|day"]);
  const d = b.calls.setDraft[0];
  eq("L2 the first Apply links the lines and applies", [line(d, "svc:2|day").laborSync.key, line(d, "svc:1|day").qty, d.sections[0].laborSync.projectId],
     ["svc:2|day", 3, 42]);
  const acts = run(Object.assign({}, b.opts, { draft: d })).takeActivity({ date: "d", time: "t", user: "u" });
  eq("L3 the entry records the link first", acts[0].changes[0], { cat: "Labor", detail: "Linked 2 lines to the schedule" });
  eq("L4 a new-style document never offers the link", run(Object.assign({}, b.opts, { draft: docFrom(S0) })).links, []);
  const link2 = mount(window.LTP_useLaborSync);
  const b2 = base({ draft: legacy, mode: "difference" });
  eq("L5 a locked legacy invoice is not linked (drafts only)", link2(b2.opts).links, []);
}

// ── Keep as is on a locked invoice ───────────────────────────────────────────
{
  const run = mount(window.LTP_useLaborSync);
  const sent = docFrom(S0, { status: "sent", activity: [{ id: "a0" }] });
  const b = base({ kind: "invoice", draft: sent, mode: "difference" });
  const ls = run(b.opts);
  eq("D0 the banner is there in difference mode", ls.banners.length, 1);
  ls.keepAll(42);
  eq("D1 no draft edit on a locked invoice", b.calls.setDraft.length, 0);
  eq("D2 one marker-only write", b.calls.writeLocked.length, 1);
  const p = b.calls.writeLocked[0];
  eq("D3 it carries sections and activity only", Object.keys(p).sort(), ["activity", "sections"]);
  eq("D4 the billed line is untouched", [line({ sections: p.sections }, "svc:1|day").qty, line({ sections: p.sections }, "svc:1|day").unitPrice], [2, 600]);
  eq("D5 its activity entry", [p.activity.length, p.activity[1].type, p.activity[1].message], [2, "updated", "Schedule changes kept as is (Summit Keynote)"]);
  eq("D6 nothing left in the log for a save", run(b.opts).takeActivity({ date: "d", time: "t", user: "u" }), []);
}

// ── Open on arrival from the schedule's Send ─────────────────────────────────
{
  window.__LTP_OPEN_LABOR_REVIEW = { kind: "quote", id: 3, projectId: 42 };
  const run = mount(window.LTP_useLaborSync);
  const b = base({ draft: docFrom(S0) });
  eq("H0 the matching document mounts with its review open", run(b.opts).review.projectId, 42);
  window.__LTP_OPEN_LABOR_REVIEW = { kind: "invoice", id: 3, projectId: 42 };
  eq("H1 a different kind of document ignores it", mount(window.LTP_useLaborSync)(b.opts).review, null);
  window.__LTP_OPEN_LABOR_REVIEW = { kind: "quote", id: 99, projectId: 42 };
  eq("H2 a different document ignores it", mount(window.LTP_useLaborSync)(b.opts).review, null);
  window.__LTP_OPEN_LABOR_REVIEW = null;
}

console.log("labor-sync-ui suite — PASS: " + pass + "   FAIL: " + fail);
if (fail) { fails.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
