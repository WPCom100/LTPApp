#!/usr/bin/env node
// components/data-state.js — adoptRow, driven through usePersistentState itself.
//
// WHY THIS SUITE EXISTS
//   Sending a crew request drew "PUT projects/23 HTTP 409" and a "Changed in
//   another window" toast from the sender's OWN window, with no other window
//   open. The Labor tab flipped open → requested locally as a user edit, which
//   queued a project PUT under the pre-send If-Match token behind the send that
//   was moving the same row; whenever the send committed first the server
//   refused the PUT, and the window adopted a row identical to its own, with a
//   warning. A direct book was worse: its pay stamp went out under the pre-book
//   token and was thrown away when the server's unstamped row was adopted.
//
//   adoptRow is the client half of the fix: a row the server handed us (or a
//   move we know it is making) lands as SERVER state — nothing queued for the
//   PUT, its _rev the token for the next real edit. That lives inside the hook,
//   so this suite runs the hook for real on a minimal React stand-in.
//
// Pure Node, zero deps.
//   Run:  node tests/test_data_state_adopt.js
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const realError = console.error;   // boot() silences console.error for the module under test

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(n, g === w, g === w ? "" : "got " + g + " want " + w);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Past the hook's 400ms write debounce, with margin.
const SETTLE = 650;

// ── React stand-in ─────────────────────────────────────────────────────────
// Just enough of the hooks contract for usePersistentState: slots by call
// order, functional setState, effects run after render when their deps
// change, and re-renders coalesced onto a microtask the way React batches.
function mountHook(hookFn, args) {
  const slots = [];
  let cursor = 0, pending = [], result, scheduled = false;
  global.React = {
    useState(init) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { v: typeof init === "function" ? init() : init };
      const s = slots[i];
      return [s.v, function(nv) { s.v = typeof nv === "function" ? nv(s.v) : nv; schedule(); }];
    },
    useRef(init) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: init };
      return slots[i];
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const prev = slots[i];
      const changed = !prev || !deps || !prev.deps
        || deps.length !== prev.deps.length || deps.some((d, k) => d !== prev.deps[k]);
      if (!prev) slots[i] = { deps: deps, cleanup: null }; else prev.deps = deps;
      const slot = slots[i];
      if (changed) pending.push(function() { if (slot.cleanup) slot.cleanup(); slot.cleanup = fn() || null; });
    },
  };
  function render() {
    cursor = 0;
    result = hookFn.apply(null, args);
    const fx = pending; pending = [];
    fx.forEach((f) => f());
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    Promise.resolve().then(function() { scheduled = false; render(); });
  }
  render();
  return { value: () => result[0], set: (v) => result[1](v), ready: () => result[2] };
}

// ── Host stubs ─────────────────────────────────────────────────────────────
let calls, serverRows, live, S;

// Re-evaluating the module per scenario resets its private state. `live` is
// the LTP_LIVE surface the hook uses, with a `bump` to play the SSE feed.
function boot(rows) {
  calls = []; serverRows = rows;
  live = {
    stamps: { projects: 1 }, subs: {},
    ready: () => Promise.resolve(),
    subscribe(c, fn) { (live.subs[c] = live.subs[c] || []).push(fn); return () => {}; },
    stampFor: (c) => live.stamps[c],
    announceWrite() {},
    bump(c) { live.stamps[c] += 1; (live.subs[c] || []).forEach((fn) => fn(c)); },
  };
  global.console = Object.assign({}, console, { error() {} });
  global.window = { location: { href: "" }, dispatchEvent() {}, LTP_LIVE: live, LTP_toast() {} };
  global.CustomEvent = function(type, init) { this.type = type; this.detail = (init || {}).detail; };
  global.fetch = function(url, opts) {
    opts = opts || {};
    const rec = { method: opts.method || "GET", url: url, headers: opts.headers || {},
                  body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(rec);
    const body = rec.method === "GET" ? serverRows
               : Object.assign({}, rec.body, { _rev: "r-after-" + rec.method });
    return Promise.resolve({ ok: true, status: 200,
                             json: () => Promise.resolve(body), text: () => Promise.resolve("") });
  };
  (0, eval)(fs.readFileSync(path.join(ROOT, "components", "data-state.js"), "utf8"));
  S = window.LTP_STATE;
  return S;
}
const puts = () => calls.filter((c) => c.method === "PUT");

// ── Fixture: one project, one shift, one position ──────────────────────────
const P = 23;
function row(status, extra) {
  return Object.assign({
    id: P, name: "Load In", venue: "",
    schedule: [{ id: "s1", date: "2026-09-21", positions: [{ id: "p1", crewId: 9, status: status }] }],
  }, extra || {});
}
function statusOf(rows) { return rows.find((r) => r.id === P).schedule[0].positions[0].status; }
function flipped(r, status) {
  return Object.assign({}, r, {
    schedule: r.schedule.map((s) => Object.assign({}, s, {
      positions: s.positions.map((p) => Object.assign({}, p, { status: status })),
    })),
  });
}
function withStatus(rows, status) { return rows.map((r) => r.id !== P ? r : flipped(r, status)); }

(async function() {
  ok("data-state exposes adoptRow", typeof boot([]).adoptRow === "function");

  // ── A. The report: mirror the send, then take the send's response ────────
  {
    boot([row("open", { _rev: "r1" })]);
    const h = mountHook(S.usePersistentState, ["projects", []]);
    await wait(20);
    ok("A1 hydrated from the server", h.ready() === true && statusOf(h.value()) === "open");

    // The Labor tab mirrors the move it knows the send is making — no _rev yet.
    eq("A2 a mirror without _rev is accepted", S.adoptRow("projects", row("requested")), true);
    await wait(0);
    eq("A3 and the view shows it at once", statusOf(h.value()), "requested");
    await wait(SETTLE);
    eq("A4 but NOTHING is queued for the debounced PUT", puts().length, 0);

    // The send comes back with the row it moved.
    eq("A5 the response row is accepted", S.adoptRow("projects", row("requested", { _rev: "r2" })), true);
    await wait(SETTLE);
    eq("A6 still no PUT — the server already holds it", puts().length, 0);

    // A real edit afterwards.
    h.set(h.value().map((r) => Object.assign({}, r, { venue: "Dock B" })));
    await wait(SETTLE);
    eq("A7 the next real edit writes once", puts().length, 1);
    eq("A8 under the token the send handed back, not the pre-send one", puts()[0].headers["If-Match"], "r2");
    eq("A9 carrying the mirrored status and the edit",
       [statusOf([puts()[0].body]), puts()[0].body.venue], ["requested", "Dock B"]);
  }

  // ── B. Direct book: adopt the booked row, THEN stamp pay on it ───────────
  {
    boot([row("open", { _rev: "r1" })]);
    const h = mountHook(S.usePersistentState, ["projects", []]);
    await wait(20);
    S.adoptRow("projects", row("confirmed", { _rev: "r2" }));
    // confirmPositionsLocal's shape: pay stamp + activity entry, as a
    // functional update on top of whatever the state holds now.
    h.set((prev) => prev.map((r) => r.id !== P ? r : Object.assign({}, r, {
      schedule: r.schedule.map((s) => Object.assign({}, s, {
        positions: s.positions.map((p) => Object.assign({}, p, { pay: 350 })),
      })),
      scheduleActivity: [{ id: "act1", message: "Crew booked directly" }],
    })));
    await wait(SETTLE);
    eq("B1 the pay stamp writes once", puts().length, 1);
    eq("B2 under the post-book token, so it lands instead of being refused", puts()[0].headers["If-Match"], "r2");
    eq("B3 with the stamp on the confirmed position",
       [puts()[0].body.schedule[0].positions[0].pay, statusOf([puts()[0].body])], [350, "confirmed"]);
  }

  // ── C. A genuine unsynced edit is neither eaten nor re-tokened ───────────
  {
    boot([row("open", { _rev: "r1" })]);
    const h = mountHook(S.usePersistentState, ["projects", []]);
    await wait(20);
    h.set(h.value().map((r) => Object.assign({}, r, { venue: "Dock B" })));   // debounce pending
    S.adoptRow("projects", row("requested", { _rev: "r2" }));
    await wait(0);
    eq("C1 the local edit is kept, as a refresh would keep it", h.value()[0].venue, "Dock B");
    await wait(SETTLE);
    eq("C2 and still goes out", puts().length, 1);
    eq("C3 under the token it was based on — both sides changed, the server judges",
       puts()[0].headers["If-Match"], "r1");
  }

  // ── D. Two projects installed in one tick both stick ─────────────────────
  {
    const other = Object.assign(row("open"), { id: 24, name: "Strike" });
    boot([row("open", { _rev: "r1" }), Object.assign({}, other, { _rev: "o1" })]);
    const h = mountHook(S.usePersistentState, ["projects", []]);
    await wait(20);
    S.adoptRow("projects", row("requested"));
    S.adoptRow("projects", flipped(other, "requested"));
    await wait(SETTLE);
    eq("D1 both mirrors are visible", h.value().map((r) => r.schedule[0].positions[0].status), ["requested", "requested"]);
    eq("D2 and neither queued a PUT", puts().length, 0);
  }

  // ── E. The old flip, converging on a refresh ─────────────────────────────
  // A plain user edit that turns out to be exactly what the server then sends
  // (the crew-request reconcile does this too) must not be pushed back, and
  // must take the server's token.
  {
    boot([row("open", { _rev: "r1" })]);
    const h = mountHook(S.usePersistentState, ["projects", []]);
    await wait(20);
    h.set(withStatus(h.value(), "requested"));            // a user-style edit
    serverRows = [row("requested", { _rev: "r2" })];       // the server made the same move
    live.bump("projects");                                 // and the feed says so, inside the debounce
    await wait(SETTLE);
    eq("E1 nothing to push — the refresh found the server already there", puts().length, 0);
    h.set(h.value().map((r) => Object.assign({}, r, { venue: "Dock B" })));
    await wait(SETTLE);
    eq("E2 the next edit carries the server's token", puts().map((p) => p.headers["If-Match"]), ["r2"]);
  }

  // ── F. Guards ────────────────────────────────────────────────────────────
  {
    boot([row("open", { _rev: "r1" })]);
    eq("F1 no hook owns the collection yet", S.adoptRow("projects", row("open")), false);
    const h = mountHook(S.usePersistentState, ["projects", []]);
    eq("F2 not before hydration", S.adoptRow("projects", row("open")), false);
    await wait(20);
    eq("F3 unknown collection", S.adoptRow("nope", row("open")), false);
    eq("F4 a row without an id", S.adoptRow("projects", { name: "x" }), false);
    eq("F5 a row the collection has never seen is added, not dropped",
       [S.adoptRow("projects", Object.assign(row("open"), { id: 99, _rev: "n1" })), (await wait(0), h.value().map((r) => r.id))],
       [true, [23, 99]]);
    await wait(SETTLE);
    eq("F6 and, being server state, is not POSTed", calls.filter((c) => c.method === "POST").length, 0);
  }

  console.log("\nadopt-row suite — PASS: " + pass + "   FAIL: " + fail);
  if (fail) { fails.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
  console.log("All " + pass + " assertions passed.");
})().catch((e) => { realError(e); process.exit(1); });
