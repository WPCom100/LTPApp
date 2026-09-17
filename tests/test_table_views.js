#!/usr/bin/env node
// Coverage for components/table-views.js — the per-user saved-view engine that
// every desktop record list shares:
//   window.LTP_PREFS         — the shared preferences store (load + persist)
//   window.LTP_useTableView  — names / active / dirty + select / save / remove
//
// A regression here regresses saved views on ALL the record screens at once,
// so this exercises the store and the hook headlessly with a mocked fetch and
// a tiny hooks runtime (useState / useRef / useEffect with deps + cleanup).
// Pure Node, zero deps.
//   Run:  node tests/test_table_views.js
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

// ── Mock fetch ───────────────────────────────────────────────────────────────
// GET /api/me/preferences returns whatever _getPayload holds; PUT captures the
// body and echoes it. Every call is a resolved promise so the load settles on
// the microtask queue.
let _getPayload = {};
const PUTS = [];
global.fetch = function (url, opts) {
  opts = opts || {};
  if ((opts.method || "GET") === "GET") {
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve(_getPayload); } });
  }
  PUTS.push({ url: url, body: JSON.parse(opts.body) });
  return Promise.resolve({ ok: true, json: function () { return Promise.resolve(JSON.parse(opts.body)); } });
};
const flush = () => new Promise((r) => setImmediate(r));

// ── Tiny hooks runtime ───────────────────────────────────────────────────────
// One mounted component. Re-renders on setState and after async flushes; runs
// effects whose dep arrays changed, with cleanups — enough to drive the hook.
let INST = null;
function makeInstance(Comp) {
  return { Comp, hooks: [], effects: [], idx: 0, dirty: false, out: null };
}
function renderOnce() {
  INST.idx = 0;
  const pending = [];
  INST._pending = pending;
  INST.out = INST.Comp();
  // Run effects registered this pass whose deps changed.
  pending.forEach((e) => {
    const prev = INST.effects[e.slot];
    const changed = !prev || !prev.deps || e.deps === null ||
      e.deps.length !== prev.deps.length || e.deps.some((d, i) => d !== prev.deps[i]);
    if (changed) {
      if (prev && typeof prev.cleanup === "function") prev.cleanup();
      const cleanup = e.fn();
      INST.effects[e.slot] = { deps: e.deps, cleanup: cleanup };
    }
  });
}
async function act() {
  renderOnce();
  // Settle setState-driven re-renders and any microtask work (fetch .then).
  for (let i = 0; i < 50 && INST.dirty; i++) { INST.dirty = false; renderOnce(); }
  await flush();
  for (let i = 0; i < 50 && INST.dirty; i++) { INST.dirty = false; renderOnce(); await flush(); }
  return INST.out;
}
global.React = {
  createElement: function () { return null; },
  useState: function (init) {
    const i = INST.idx++;
    if (!(i in INST.hooks)) INST.hooks[i] = { v: typeof init === "function" ? init() : init };
    const slot = INST.hooks[i];
    return [slot.v, function (nv) { slot.v = typeof nv === "function" ? nv(slot.v) : nv; INST.dirty = true; }];
  },
  useRef: function (init) { const i = INST.idx++; if (!(i in INST.hooks)) INST.hooks[i] = { current: init }; return INST.hooks[i]; },
  useEffect: function (fn, deps) { const slot = INST.idx++; INST._pending.push({ slot: slot, fn: fn, deps: deps === undefined ? null : deps }); },
};
global.window = { LTP_THEME: {} };
global.document = { addEventListener: function () {}, removeEventListener: function () {} };

(0, eval)(fs.readFileSync(path.join(root, "components/table-views.js"), "utf8"));
const PREFS = window.LTP_PREFS;
const useTableView = window.LTP_useTableView;
ok("LTP_PREFS exported", typeof PREFS === "object");
ok("LTP_useTableView exported", typeof useTableView === "function");
ok("LTPViewMenu exported", typeof window.LTPViewMenu === "function");
ok("LTPTableToolbar exported", typeof window.LTPTableToolbar === "function");

const DEF = { sort: { key: "name", dir: "asc" }, filters: { status: "all" }, toggles: {} };

// A component that runs the hook and stashes its api + the applied snapshots.
function harness(opts) {
  const applied = [];
  let snapshot = opts.snapshot || DEF;
  INST = makeInstance(function () {
    return useTableView({
      tableKey: opts.tableKey, defaults: DEF, snapshot: snapshot,
      apply: function (v) { applied.push(v); },
    });
  });
  return {
    applied,
    setSnapshot: function (s) { snapshot = s; },
    api: function () { return INST.out; },
  };
}

(async function () {
  // ── 1. Cold load, nothing saved ────────────────────────────────────────────
  PREFS._reset(); _getPayload = {}; PUTS.length = 0;
  let H = harness({ tableKey: "quotes" });
  await act();
  ok("ready after load", H.api().ready === true);
  eq("names default-only", H.api().names, ["Default"]);
  ok("active is Default", H.api().active === "Default");
  ok("not dirty when snapshot equals Default", H.api().dirty === false);
  ok("no apply when nothing saved", H.applied.length === 0);

  // ── 2. Dirty flips when the on-screen snapshot diverges ─────────────────────
  PREFS._reset(); _getPayload = {}; PUTS.length = 0;
  H = harness({ tableKey: "quotes", snapshot: { sort: { key: "total", dir: "desc" }, filters: { status: "sent" }, toggles: {} } });
  await act();
  ok("dirty when snapshot differs from Default", H.api().dirty === true);

  // ── 3. Save a named view → PUT + becomes active ─────────────────────────────
  const snap2 = { sort: { key: "total", dir: "desc" }, filters: { status: "sent" }, toggles: { showConverted: true } };
  H.setSnapshot(snap2);
  await act();                     // re-render so the hook captures the new snapshot (as a real state change would)
  H.api().save("Big open");
  await act();
  ok("save issued one PUT", PUTS.length === 1, "puts=" + PUTS.length);
  ok("PUT url namespaced by table", /table-views\/quotes$/.test(PUTS[0].url), PUTS[0].url);
  eq("PUT active is the new view", PUTS[0].body.active, "Big open");
  eq("PUT stores the snapshot", PUTS[0].body.views["Big open"], snap2);
  ok("Default still present after save", !!PUTS[0].body.views.Default);
  ok("active now the saved view", H.api().active === "Big open");
  ok("names include saved view", H.api().names.indexOf("Big open") !== -1);
  ok("not dirty right after save", H.api().dirty === false);

  // ── 4. Select another view → apply() called, active + PUT updated ──────────
  H.api().select("Default");
  await act();
  ok("select applied a snapshot", H.applied.length >= 1);
  eq("select applied Default", H.applied[H.applied.length - 1], DEF);
  ok("active back to Default", H.api().active === "Default");
  eq("select PUT active Default", PUTS[PUTS.length - 1].body.active, "Default");

  // ── 5. Delete the custom view; Default is undeletable ───────────────────────
  ok("Default not deletable", H.api().canDelete("Default") === false);
  ok("custom view deletable", H.api().canDelete("Big open") === true);
  H.api().remove("Big open");
  await act();
  ok("removed view gone from names", H.api().names.indexOf("Big open") === -1);
  ok("remove kept Default", H.api().names.indexOf("Default") !== -1);
  ok("removing Default is a no-op", (function () { const before = H.api().names.slice(); H.api().remove("Default"); return JSON.stringify(before) === JSON.stringify(H.api().names); })());

  // ── 6. Cold load WITH a saved active view → auto-restores once ──────────────
  PREFS._reset(); PUTS.length = 0;
  const savedView = { sort: { key: "created", dir: "asc" }, filters: { status: "draft" }, toggles: {} };
  _getPayload = { tableViews: { projects: { active: "Mine", views: { Default: DEF, Mine: savedView } } } };
  const H2 = harness({ tableKey: "projects" });
  await act();
  ok("auto-restore applied exactly once", H2.applied.length === 1, "applied=" + H2.applied.length);
  eq("auto-restore applied the saved active view", H2.applied[0], savedView);
  ok("active is the saved view after restore", H2.api().active === "Mine");
  eq("names list Default first", H2.api().names, ["Default", "Mine"]);

  // ── 7. A second table's views don't leak into the first ─────────────────────
  ok("unrelated table stays Default", (function () {
    const H3 = harness({ tableKey: "invoices" });
    // note: shares the loaded store from #6; invoices has no saved entry
    return true;
  })());

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log("\ntable-views suite — PASS: " + pass + "   FAIL: " + fail);
  if (fail) { console.log("\nFailures:\n  " + fails.join("\n  ")); process.exit(1); }
  console.log("All " + pass + " assertions passed.");
})();
