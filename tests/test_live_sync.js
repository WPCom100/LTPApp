#!/usr/bin/env node
// Cross-window live sync — the client half.
//
// Covers the two pieces of logic that decide whether a background refresh is
// safe: components/live-sync.js's stamp diffing (WHAT to refetch) and
// components/data-state.js's three-way merge (how to fold the result in
// without eating the user's unsynced edits).
//
// Pure Node, zero deps. Both files are IIFEs that only touch window/document/
// fetch inside functions, so a thin shim is enough to load them for real
// rather than reimplementing their logic here.
//   Run:  node tests/test_live_sync.js
"use strict";
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, g, e) {
  ok(n, JSON.stringify(g) === JSON.stringify(e),
     "got " + JSON.stringify(g) + " exp " + JSON.stringify(e));
}

// ── Browser shim ────────────────────────────────────────────────────────────
// Enough for both modules to load and run their pure logic. fetch resolves to a
// benign empty stamp map so start()/revalidate() are harmless no-ops here — the
// network paths are covered server-side in tests/test_livesync.py.
const listeners = {};
global.window = {
  addEventListener() {},
  location: { href: "" },
};
global.document = {
  hidden: false,
  addEventListener(name, fn) { (listeners[name] || (listeners[name] = [])).push(fn); },
};
global.fetch = () => Promise.resolve({
  ok: true, status: 200,
  json: () => Promise.resolve({ stamps: {}, at: 0 }),
  text: () => Promise.resolve("{}"),
});
global.setTimeout = setTimeout;
global.clearTimeout = clearTimeout;
global.React = { useState() {}, useEffect() {}, useRef() {} };
global.CustomEvent = function () {};

(0, eval)(fs.readFileSync(path.join(root, "components", "live-sync.js"), "utf8"));
(0, eval)(fs.readFileSync(path.join(root, "components", "data-state.js"), "utf8"));

const LIVE = window.LTP_LIVE;
const S = window.LTP_STATE;

ok("live-sync exposes LTP_LIVE", !!LIVE);
ok("data-state exposes LTP_STATE", !!S);

// ── Stamp diffing ───────────────────────────────────────────────────────────
// The contract: the FIRST map only seeds (nothing has been fetched against an
// older stamp yet), and after that only genuinely-moved collections fire.

function freshLive() {
  LIVE._reset();
  const seen = [];
  return { seen, note: (c) => seen.push(c) };
}

// Seed FIRST, then subscribe: this isolates the steady-state diffing contract
// from the seeding wake tested further down.
function seeded(map) {
  const { seen } = freshLive();
  LIVE._applyStamps(map);
  return { seen };
}

{
  const { seen } = seeded({ projects: "a:1:0", contacts: "b:2:0" });
  LIVE.subscribe("projects", (c) => seen.push(c));
  eq("L1 seeding records the stamp", LIVE.stampFor("projects"), "a:1:0");
  eq("L2 and a subscriber joining afterwards hears nothing", seen, []);
}

{
  const { seen } = seeded({ projects: "a:1:0", contacts: "b:2:0" });
  LIVE.subscribe("projects", (c) => seen.push(c));
  const changed = LIVE._applyStamps({ projects: "a:1:1", contacts: "b:2:0" });
  eq("L4 only the moved collection is reported", changed, ["projects"]);
  eq("L5 its subscriber fires", seen, ["projects"]);
  eq("L6 the new stamp is stored", LIVE.stampFor("projects"), "a:1:1");
}

{
  const { seen } = seeded({ projects: "a:1:0", contacts: "b:2:0" });
  LIVE.subscribe("contacts", (c) => seen.push(c));
  LIVE._applyStamps({ projects: "a:1:9", contacts: "b:2:0" });
  eq("L7 an unrelated write does not wake this subscriber", seen, []);
}

{
  const { seen } = seeded({ projects: "a:1:0" });
  LIVE.subscribe("projects", (c) => seen.push(c));
  LIVE._applyStamps({ projects: "a:1:0" });
  LIVE._applyStamps({ projects: "a:1:0" });
  eq("L8 a repeated identical stamp is not a change", seen, []);
}

{
  // A subscriber that throws must not stop the rest of the page refreshing.
  const { seen } = seeded({ projects: "a:1:0" });
  LIVE.subscribe("projects", () => { throw new Error("boom"); });
  LIVE.subscribe("projects", (c) => seen.push(c));
  const realError = console.error; console.error = () => {};
  LIVE._applyStamps({ projects: "a:1:1" });
  console.error = realError;
  eq("L9 one broken subscriber does not block the others", seen, ["projects"]);
}

{
  const { seen } = seeded({ projects: "a:1:0" });
  const off = LIVE.subscribe("projects", (c) => seen.push(c));
  off();
  LIVE._applyStamps({ projects: "a:1:1" });
  eq("L10 unsubscribe stops delivery", seen, []);
  eq("L11 status() reports no live subscribers", LIVE.status().subscribers.projects, undefined);
}

{
  // The late-seed case. ready() is bounded and revalidate() swallows failures, so
  // on a slow or failed /api/versions the hooks fetch BLIND and the seed lands
  // afterwards. Anything written in between is baked into a stamp the client
  // trusts while it holds pre-write rows — and nothing used to re-check.
  // Subscribers already existing at seed time IS that situation, so wake them.
  const { seen } = freshLive();
  LIVE.subscribe("projects", (c) => seen.push(c));
  LIVE.subscribe("contacts", (c) => seen.push(c));
  LIVE._applyStamps({ projects: "a:1:0", contacts: "b:2:0" });
  eq("L12 a seed arriving after the hooks subscribed wakes them to re-check",
     seen.sort(), ["contacts", "projects"]);
}

{
  // ...but only collections that actually have a subscriber.
  const { seen } = freshLive();
  LIVE.subscribe("projects", (c) => seen.push(c));
  LIVE._applyStamps({ projects: "a:1:0", contacts: "b:2:0", quotes: "c:3:0" });
  eq("L13 and wakes nobody for the collections nothing is watching", seen, ["projects"]);
}

LIVE._reset();

// ── Revision handling ───────────────────────────────────────────────────────
// _rev is transport metadata. It must not reach state, where ~30 modules
// spread, stringify and diff these rows.

{
  const split = S._splitRevs([
    { id: 1, name: "A", _rev: "r1" },
    { id: 2, name: "B", _rev: "r2" },
  ]);
  eq("V1 _rev is stripped from the rows", split.rows, [{ id: 1, name: "A" }, { id: 2, name: "B" }]);
  eq("V2 _rev is collected by id", split.revs, { 1: "r1", 2: "r2" });
}

{
  const split = S._splitRevs([{ id: 3, name: "C" }]);
  eq("V3 a row with no _rev passes through untouched", split.rows, [{ id: 3, name: "C" }]);
  eq("V4 and contributes no revision", split.revs, {});
}

eq("V5 null list is tolerated", S._splitRevs(null).rows, []);

// ── Three-way merge ─────────────────────────────────────────────────────────
// base   = what the server had at our last successful sync
// local  = current in-memory value, possibly with unsynced edits
// server = the collection as just refetched
const M = S._mergeRemote;

{
  const base   = [{ id: 1, name: "A" }];
  const local  = [{ id: 1, name: "A" }];
  const server = [{ id: 1, name: "A renamed elsewhere" }];
  eq("M1 with no local edits the server wins outright", M(base, local, server), server);
}

{
  // The case that matters: a refetch triggered by someone else's write must not
  // throw away what this user is halfway through typing.
  const base   = [{ id: 1, name: "A" }, { id: 2, name: "B" }];
  const local  = [{ id: 1, name: "A" }, { id: 2, name: "B edited here" }];
  const server = [{ id: 1, name: "A renamed elsewhere" }, { id: 2, name: "B" }];
  eq("M2 remote change lands, local edit survives",
     M(base, local, server),
     [{ id: 1, name: "A renamed elsewhere" }, { id: 2, name: "B edited here" }]);
}

{
  const base   = [{ id: 1, name: "A" }];
  const local  = [{ id: 1, name: "A" }, { id: 9, name: "Created here, not synced yet" }];
  const server = [{ id: 1, name: "A" }, { id: 5, name: "Created elsewhere" }];
  eq("M3 both sides' new rows are kept",
     M(base, local, server),
     [{ id: 1, name: "A" }, { id: 5, name: "Created elsewhere" },
      { id: 9, name: "Created here, not synced yet" }]);
}

{
  const base   = [{ id: 1, name: "A" }, { id: 2, name: "B" }];
  const local  = [{ id: 1, name: "A" }];                       // deleted 2 locally
  const server = [{ id: 1, name: "A" }, { id: 2, name: "B" }]; // server still has it
  eq("M4 an unsynced local delete is not resurrected by the refetch",
     M(base, local, server), [{ id: 1, name: "A" }]);
}

{
  const base   = [{ id: 1, name: "A" }, { id: 2, name: "B" }];
  const local  = [{ id: 1, name: "A" }, { id: 2, name: "B" }];
  const server = [{ id: 1, name: "A" }];                       // deleted elsewhere
  eq("M5 a remote delete removes a row we had not touched",
     M(base, local, server), [{ id: 1, name: "A" }]);
}

{
  // Edited on both sides. The local edit is kept HERE so the user keeps typing;
  // the conflict then surfaces on write, where If-Match turns it into a visible
  // 409 rather than a silent overwrite (tests/test_livesync.py covers that half).
  const base   = [{ id: 1, name: "A" }];
  const local  = [{ id: 1, name: "A mine" }];
  const server = [{ id: 1, name: "A theirs" }];
  eq("M6 a doubly-edited row keeps the local edit for the write to resolve",
     M(base, local, server), [{ id: 1, name: "A mine" }]);
}

{
  const server = [{ id: 3, name: "C" }, { id: 1, name: "A" }, { id: 2, name: "B" }];
  eq("M7 server ordering is preserved", M([], [], server), server);
}

{
  // Edited here, DELETED there. Keeping the local copy would not just show a
  // stale row — the next diff would treat it as new and POST it back, undoing
  // someone else's delete behind their back.
  const base   = [{ id: 1, name: "A" }, { id: 2, name: "B" }];
  const local  = [{ id: 1, name: "A" }, { id: 2, name: "B edited here" }];
  const server = [{ id: 1, name: "A" }];
  const removed = [];
  eq("M8 a remote delete beats a local edit rather than resurrecting the row",
     M(base, local, server, removed), [{ id: 1, name: "A" }]);
  eq("M9 and the dropped row is reported so the user can be told", removed, ["2"]);
}

{
  // A locally-CREATED row must still survive — it was never on the server, so
  // its absence there is not a delete.
  const removed = [];
  eq("M10 a locally-created row is not mistaken for a remote delete",
     M([], [{ id: 9, name: "New here" }], [], removed), [{ id: 9, name: "New here" }]);
  eq("M11 and nothing is reported dropped", removed, []);
}

eq("M12 empty everything is empty", M([], [], []), []);
eq("M13 null inputs are tolerated", M(null, null, null), []);

{
  // Rows without ids (defensive — nothing in the app stores them, but a merge
  // must not crash if one appears).
  const server = [{ id: 1, name: "A" }, { name: "no id" }];
  eq("M14 id-less server rows pass through", M([], [], server), server);
}

// ── revsRef must not advance for rows the merge kept locally ────────────────
//
// This is the bug that made If-Match unable to fire for exactly the rows it was
// built for: adopting the server's newer rev for a locally-kept row handed the
// next PUT a token the server already agreed with, so the guard passed and the
// other window's change was overwritten with no 409 and no toast.

{
  const base   = [{ id: 1, name: "A" }, { id: 2, name: "B" }];
  const local  = [{ id: 1, name: "A" }, { id: 2, name: "B edited here" }];
  const server = [{ id: 1, name: "A elsewhere" }, { id: 2, name: "B elsewhere" }];
  const removed = [], kept = [];
  M(base, local, server, removed, kept);
  eq("K1 a row resolved in favour of the local edit is reported", kept, ["2"]);
  eq("K2 a row taken from the server is not", removed, []);
}

{
  const base   = [{ id: 1, name: "A" }];
  const local  = [{ id: 1, name: "A" }, { id: 9, name: "New here" }];
  const server = [{ id: 1, name: "A elsewhere" }];
  const kept = [];
  M(base, local, server, [], kept);
  eq("K3 a locally-CREATED row is not reported as kept — it has no server rev to hold back",
     kept, []);
}

{
  const base   = [{ id: 1, name: "A" }];
  const local  = [{ id: 1, name: "A" }];
  const server = [{ id: 1, name: "A elsewhere" }];
  const kept = [];
  M(base, local, server, [], kept);
  eq("K4 an untouched row is not reported, so its rev may safely advance", kept, []);
}

// ── Settings merge ──────────────────────────────────────────────────────────
// A refetch must fold in ship-defaults exactly the way hydration does, or a
// background refresh would silently drop newly-shipped email templates.
const AS = S._adoptSettings;

{
  const fallback = { theme: "dark", emailTemplates: { crewRequest: "D1", crewWithdrawn: "D2" } };
  const server   = { theme: "light", emailTemplates: { crewRequest: "EDITED" } };
  const got = AS(fallback, server);
  eq("S1 server wins on overlapping top-level keys", got.theme, "light");
  eq("S2 an edited template is kept", got.emailTemplates.crewRequest, "EDITED");
  eq("S3 a newly-shipped template is not hidden by a saved blob",
     got.emailTemplates.crewWithdrawn, "D2");
}

{
  const fallback = { a: 1, emailTemplates: { x: "X" } };
  eq("S4 an empty server blob falls back cleanly", AS(fallback, null),
     { a: 1, emailTemplates: { x: "X" } });
}

// ── announceWrite ───────────────────────────────────────────────────────────
{
  LIVE._reset();
  let threw = false;
  try { LIVE.announceWrite(["projects"]); } catch (e) { threw = true; }
  ok("B1 announceWrite is a no-op without BroadcastChannel", !threw);
  try { LIVE.announceWrite([]); LIVE.announceWrite(null); } catch (e) { threw = true; }
  ok("B2 announceWrite tolerates empty input", !threw);
}

// ── Remote edits to an open draft (theme.js::LTP_useRemoteEdits) ────────────
//
// The three big editors clone their record into a local draft and reseed only
// on an id change, so a record that moved underneath them is invisible until
// they save over it. This hook is the shared response. Exercised through a
// minimal React model — refs that persist across renders and effects that fire
// when their deps change, in declaration order — which is all the hook uses.

function mountHook(fn) {
  const refs = [];
  const deps = [];
  let ri = 0, ei = 0;
  const queued = [];
  global.React = {
    useRef(init) {
      if (refs.length <= ri) refs.push({ current: init });
      return refs[ri++];
    },
    useEffect(cb, d) {
      const i = ei++;
      const prev = deps[i];
      const changed = !prev || d.length !== prev.length || d.some((x, k) => x !== prev[k]);
      deps[i] = d.slice();
      if (changed) queued.push(cb);
    },
  };
  return function render() {
    ri = 0; ei = 0; queued.length = 0;
    fn.apply(null, arguments);
    queued.forEach((cb) => cb());     // effects run after the body, in order
  };
}

// The editor hooks live in components/domain-util.js, not theme.js: the audit
// branch split theme.js's 2,600-line domain layer into components/domain-*.js
// and theme.js is now tokens + colours + the module registry. Both only touch
// React inside function bodies, so they load fine here.
window.LTP_genId = (p) => (p || "x") + "-1";
(0, eval)(fs.readFileSync(path.join(root, "theme.js"), "utf8"));
(0, eval)(fs.readFileSync(path.join(root, "components", "domain-util.js"), "utf8"));
ok("domain-util exports LTP_useRemoteEdits", typeof window.LTP_useRemoteEdits === "function");
ok("domain-util exports LTP_useRecordWatch", typeof window.LTP_useRecordWatch === "function");
ok("domain-util exports LTP_useUnsavedGuard", typeof window.LTP_useUnsavedGuard === "function");

function scenario() {
  const state = { adopted: [], toasts: [], dirty: false };
  window.LTP_toast = (title, o) => state.toasts.push(title + " :: " + (o && o.message));
  const snap = (r) => ({ id: r.id, body: r.body });
  const render = mountHook((record, resetKey) => {
    window.LTP_useRemoteEdits(record, snap, state.dirty,
      (fresh) => state.adopted.push(fresh),
      { title: "Changed elsewhere", message: "unsaved changes are kept" },
      resetKey);
  });
  return { state, render };
}

{
  const { state, render } = scenario();
  render({ id: 1, body: "a" }, 1);
  eq("H1 the first render only seeds", [state.adopted.length, state.toasts.length], [0, 0]);
  render({ id: 1, body: "a" }, 1);          // new identity, same content
  eq("H2 a refetch that changed nothing does nothing", [state.adopted.length, state.toasts.length], [0, 0]);
}

{
  const { state, render } = scenario();
  render({ id: 1, body: "a" }, 1);
  render({ id: 1, body: "b" }, 1);
  eq("H3 a clean editor adopts the newer version", state.adopted, [{ id: 1, body: "b" }]);
  eq("H4 and is not nagged about it", state.toasts, []);
}

{
  const { state, render } = scenario();
  render({ id: 1, body: "a" }, 1);
  state.dirty = true;
  render({ id: 1, body: "b" }, 1);
  eq("H5 a dirty editor keeps its edits (no adopt)", state.adopted, []);
  eq("H6 and is told once", state.toasts.length, 1);
  ok("H7 the notice says what happens on save", /unsaved changes are kept/.test(state.toasts[0]), state.toasts[0]);

  render({ id: 1, body: "c" }, 1);
  eq("H8 a second remote change does not nag again", state.toasts.length, 1);
  eq("H9 and still does not clobber the draft", state.adopted, []);
}

{
  // Saving clears the dirty flag; a later remote change should adopt again, and
  // the one-notice budget should be back for the next editing session.
  const { state, render } = scenario();
  render({ id: 1, body: "a" }, 1);
  state.dirty = true;
  render({ id: 1, body: "b" }, 1);
  eq("H10 warned while dirty", state.toasts.length, 1);
  state.dirty = false;
  render({ id: 1, body: "c" }, 1);
  eq("H11 adopts again once the draft is clean", state.adopted, [{ id: 1, body: "c" }]);
  state.dirty = true;
  render({ id: 1, body: "d" }, 1);
  eq("H12 the notice budget resets per editing session", state.toasts.length, 2);
}

{
  // Switching records is not a remote change.
  const { state, render } = scenario();
  render({ id: 1, body: "a" }, 1);
  state.dirty = true;
  render({ id: 2, body: "z" }, 2);          // different record entirely
  eq("H13 switching records adopts nothing", state.adopted, []);
  eq("H14 and warns about nothing", state.toasts, []);
}

{
  const { state, render } = scenario();
  render(null, 1);                          // a brand-new, unsaved record
  render(null, 1);
  eq("H15 no stored record means no-op", [state.adopted.length, state.toasts.length], [0, 0]);
}

{
  // A record the snapshot cannot serialize must not throw out of the effect.
  const { state } = scenario();
  const cyclic = { id: 1 }; cyclic.self = cyclic;
  const render = mountHook((record, resetKey) => {
    window.LTP_useRemoteEdits(record, (r) => r, false,
      (f) => state.adopted.push(f), null, resetKey);
  });
  let threw = false;
  try { render({ id: 1 }, 1); render(cyclic, 1); } catch (e) { threw = true; }
  ok("H16 an unserializable record is survived, not thrown", !threw);
}

// ── Watching a row from a field-per-useState form (LTP_useRecordWatch) ──────
//
// The ~dozen modal editors seed one useState per field from a row. They cannot
// adopt a newer version mid-edit, so they warn — and If-Match will not catch
// them, because live sync refreshes the row's revision underneath a form that
// is still holding values from before it.

function watchScenario(collection, id, pick) {
  const state = { toasts: [] };
  window.LTP_toast = (title) => state.toasts.push(title);
  const render = mountHook(() => {
    window.LTP_useRecordWatch(collection, id, { title: "Changed elsewhere", message: "m" }, pick);
  });
  return { state, render };
}

{
  window.LTP_DATA_LIVE = { companies: [{ id: 1, name: "Acme" }, { id: 2, name: "Other" }] };
  const { state, render } = watchScenario("companies", 1);
  render();
  eq("W1 finding the row is not itself a change", state.toasts, []);

  window.LTP_DATA_LIVE.companies = [{ id: 1, name: "Acme Renamed" }, { id: 2, name: "Other" }];
  render();
  eq("W2 a change to the watched row warns", state.toasts.length, 1);

  window.LTP_DATA_LIVE.companies = [{ id: 1, name: "Acme Renamed" }, { id: 2, name: "Other Renamed" }];
  render();
  eq("W3 a change to a DIFFERENT row does not", state.toasts.length, 1);

  window.LTP_DATA_LIVE.companies = [{ id: 1, name: "Acme Third Time" }, { id: 2, name: "Other Renamed" }];
  render();
  eq("W4 it warns once per open, not once per change", state.toasts.length, 1);
}

{
  // Creating a new record: there is no row to watch and nothing to warn about.
  window.LTP_DATA_LIVE = { companies: [{ id: 1, name: "Acme" }] };
  const { state, render } = watchScenario("companies", undefined);
  render();
  window.LTP_DATA_LIVE.companies = [{ id: 1, name: "Acme Renamed" }];
  render();
  eq("W5 a create form watches nothing", state.toasts, []);
}

{
  window.LTP_DATA_LIVE = { companies: [{ id: 1, name: "Acme" }] };
  const { state, render } = watchScenario("companies", 1);
  render();
  window.LTP_DATA_LIVE.companies = [];              // deleted in another window
  render();
  eq("W6 the row being deleted elsewhere warns too", state.toasts.length, 1);
}

{
  // A note lives inside a project row. Editing one note must not be woken by an
  // unrelated change to the same project.
  const pick = (p) => (p.notes || []).find((n) => n.id === "n1") || null;
  window.LTP_DATA_LIVE = { projects: [{ id: 7, name: "Gala", notes: [{ id: "n1", text: "a" }] }] };
  const { state, render } = watchScenario("projects", 7, pick);
  render();

  window.LTP_DATA_LIVE.projects = [{ id: 7, name: "Gala RENAMED", notes: [{ id: "n1", text: "a" }] }];
  render();
  eq("W7 pick ignores changes outside the watched slice", state.toasts, []);

  window.LTP_DATA_LIVE.projects = [{ id: 7, name: "Gala RENAMED", notes: [{ id: "n1", text: "edited elsewhere" }] }];
  render();
  eq("W8 but still catches a change inside it", state.toasts.length, 1);
}

{
  // A singleton blob (settings) has no id — the whole object is the record.
  window.LTP_DATA_LIVE = { settings: { theme: "dark" } };
  const { state, render } = watchScenario("settings", null);
  render();
  window.LTP_DATA_LIVE.settings = { theme: "light" };
  render();
  eq("W9 a singleton collection is watched whole", state.toasts.length, 1);
}

{
  // A collection that has not loaded yet must not crash the form.
  window.LTP_DATA_LIVE = {};
  const { state, render } = watchScenario("companies", 1);
  let threw = false;
  try { render(); render(); } catch (e) { threw = true; }
  ok("W10 an unloaded collection is survived", !threw);
  eq("W11 and warns about nothing", state.toasts, []);
}

// ── The unsaved-changes guard (theme.js::LTP_useUnsavedGuard) ───────────────
//
// router.navigate() decides whether to prompt "You have unsaved changes" purely
// from window.__LTP_UNSAVED, so that mirror going out of step with the real
// dirty flag means an editor full of unsaved work navigates away in silence.
// This models React closely enough to catch that: state that re-renders, and
// effects whose cleanup runs before the next effect body when deps change.

function mountStateful(fn) {
  const states = [], refs = [], deps = [], cleanups = [];
  let si = 0, ri = 0, ei = 0, lastArgs = [];
  function render() {
    if (arguments.length) lastArgs = Array.prototype.slice.call(arguments);
    si = 0; ri = 0; ei = 0;
    const queued = [];
    global.React = {
      useState(init) {
        const i = si++;
        if (states.length <= i) states.push(typeof init === "function" ? init() : init);
        return [states[i], (v) => {
          states[i] = typeof v === "function" ? v(states[i]) : v;
          render();
        }];
      },
      useRef(init) { if (refs.length <= ri) refs.push({ current: init }); return refs[ri++]; },
      useEffect(cb, d) {
        const i = ei++;
        const prev = deps[i];
        const changed = !prev || !d || d.length !== prev.length || d.some((x, k) => x !== prev[k]);
        deps[i] = d ? d.slice() : null;
        if (changed) queued.push([i, cb]);
      },
    };
    const out = fn.apply(null, lastArgs);
    queued.forEach(([i, cb]) => {
      if (cleanups[i]) cleanups[i]();          // React: cleanup, then the new body
      cleanups[i] = cb() || null;
    });
    return out;
  }
  render.unmount = () => cleanups.forEach((c) => c && c());
  return render;
}

{
  window.addEventListener = function () {};
  window.removeEventListener = function () {};
  let api = null;
  const render = mountStateful(() => { api = window.LTP_useUnsavedGuard(); });
  render();
  eq("U1 a clean editor reports no unsaved work", window.__LTP_UNSAVED, false);

  api[1](true);
  eq("U2 the mirror survives the dirty transition", window.__LTP_UNSAVED, true);
  eq("U3 and the hook agrees", api[0], true);

  api[1](true);
  eq("U4 staying dirty stays dirty", window.__LTP_UNSAVED, true);

  api[1](false);
  eq("U5 saving clears it", window.__LTP_UNSAVED, false);

  api[1](true);
  eq("U6 dirty again after a save", window.__LTP_UNSAVED, true);
  render.unmount();
  eq("U7 leaving the tree gives up ownership", window.__LTP_UNSAVED, false);
}

console.log("live-sync suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");

// live-sync keeps timers armed on purpose — a page never stops watching for
// changes. Under Node that would hold the process open forever, and the
// deferred connect() scheduled off ready() can re-arm the poll after any
// synchronous _reset(). So exit explicitly rather than waiting for an event
// loop that is designed never to drain.
process.exit(0);
