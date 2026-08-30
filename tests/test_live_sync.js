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

{
  const { seen } = freshLive();
  LIVE.subscribe("projects", (c) => seen.push(c));
  const first = LIVE._applyStamps({ projects: "a:1:0", contacts: "b:2:0" });
  eq("L1 first map seeds silently", first, []);
  eq("L2 seeding notifies nobody", seen, []);
  eq("L3 stamp is recorded", LIVE.stampFor("projects"), "a:1:0");
}

{
  const { seen } = freshLive();
  LIVE.subscribe("projects", (c) => seen.push(c));
  LIVE._applyStamps({ projects: "a:1:0", contacts: "b:2:0" });
  const changed = LIVE._applyStamps({ projects: "a:1:1", contacts: "b:2:0" });
  eq("L4 only the moved collection is reported", changed, ["projects"]);
  eq("L5 its subscriber fires", seen, ["projects"]);
  eq("L6 the new stamp is stored", LIVE.stampFor("projects"), "a:1:1");
}

{
  const { seen } = freshLive();
  LIVE.subscribe("contacts", (c) => seen.push(c));
  LIVE._applyStamps({ projects: "a:1:0", contacts: "b:2:0" });
  LIVE._applyStamps({ projects: "a:1:9", contacts: "b:2:0" });
  eq("L7 an unrelated write does not wake this subscriber", seen, []);
}

{
  const { seen } = freshLive();
  LIVE.subscribe("projects", (c) => seen.push(c));
  LIVE._applyStamps({ projects: "a:1:0" });
  LIVE._applyStamps({ projects: "a:1:0" });
  LIVE._applyStamps({ projects: "a:1:0" });
  eq("L8 a repeated identical stamp is not a change", seen, []);
}

{
  // A subscriber that throws must not stop the rest of the page refreshing.
  const { seen } = freshLive();
  LIVE.subscribe("projects", () => { throw new Error("boom"); });
  LIVE.subscribe("projects", (c) => seen.push(c));
  const realError = console.error; console.error = () => {};
  LIVE._applyStamps({ projects: "a:1:0" });
  LIVE._applyStamps({ projects: "a:1:1" });
  console.error = realError;
  eq("L9 one broken subscriber does not block the others", seen, ["projects"]);
}

{
  const { seen } = freshLive();
  const off = LIVE.subscribe("projects", (c) => seen.push(c));
  LIVE._applyStamps({ projects: "a:1:0" });
  off();
  LIVE._applyStamps({ projects: "a:1:1" });
  eq("L10 unsubscribe stops delivery", seen, []);
  eq("L11 status() reports no live subscribers", LIVE.status().subscribers.projects, undefined);
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

eq("M8 empty everything is empty", M([], [], []), []);
eq("M9 null inputs are tolerated", M(null, null, null), []);

{
  // Rows without ids (defensive — nothing in the app stores them, but a merge
  // must not crash if one appears).
  const server = [{ id: 1, name: "A" }, { name: "no id" }];
  eq("M10 id-less server rows pass through", M([], [], server), server);
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

console.log("live-sync suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");

// live-sync keeps timers armed on purpose — a page never stops watching for
// changes. Under Node that would hold the process open forever, and the
// deferred connect() scheduled off ready() can re-arm the poll after any
// synchronous _reset(). So exit explicitly rather than waiting for an event
// loop that is designed never to drain.
process.exit(0);
