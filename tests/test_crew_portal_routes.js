#!/usr/bin/env node
// Crew portal — routing + wiring guard.
//
// The portal is a separate surface with its own cookie, so the pieces that
// route a browser to it have to agree: the hash router must parse
// #/crew-portal/<screen>/<token> without mangling the token, app.js must render
// it outside the staff auth gate, components/auth.js must not fire the staff
// /auth/me probe on it (a 401 there used to bounce public pages to Google),
// index.html must load the module, and the email templates it sends must be
// declared with their variables. Pure Node, zero deps.
//   Run:  node tests/test_crew_portal_routes.js
"use strict";
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, a, b) { ok(n, JSON.stringify(a) === JSON.stringify(b), "got " + JSON.stringify(a) + " want " + JSON.stringify(b)); }
function read(rel) { return fs.readFileSync(path.join(root, rel), "utf8"); }

// ── router.js under a minimal shim ───────────────────────────────────────────
global.window = { location: { hash: "#/crew-portal" }, addEventListener() {}, removeEventListener() {}, history: { replaceState() {} } };
global.React = { useState() { throw new Error("not used here"); }, useEffect() {} };
(0, eval)(read("router.js"));
const R = global.window.LTPRouter;
function parse(hash) { global.window.location.hash = hash; return R.getRoute(); }

const tok = "Wf3k_9ZQ-abcDEF0123456789_-XYZabc0987654321qrs";
eq("bare #/crew-portal", parse("#/crew-portal"), { module: "crew-portal", sub: null, id: null, action: null, query: {} });
eq("screen only", parse("#/crew-portal/schedule"), { module: "crew-portal", sub: "schedule", id: null, action: null, query: {} });
eq("signup token lands in id, untouched", parse("#/crew-portal/signup/" + tok),
   { module: "crew-portal", sub: "signup", id: tok, action: null, query: {} });
eq("reset token lands in id, untouched", parse("#/crew-portal/reset/" + tok),
   { module: "crew-portal", sub: "reset", id: tok, action: null, query: {} });
eq("query survives", parse("#/crew-portal/login?next=payouts").query, { next: "payouts" });
// The neighbours keep parsing as before.
eq("#/crew/<token> is still the call sheet", parse("#/crew/" + tok), { module: "crew", sub: null, id: tok, action: null, query: {} });
eq("crm/companies/5/edit unchanged", parse("#/crm/companies/5/edit"), { module: "crm", sub: "companies", id: 5, action: "edit", query: {} });

// ── The default route comes from the page (the crew portal's own domain) ────
// backend/main.py serves index.html on the crew host with
// <meta name="ltp-default-route" content="crew-portal">; router.js reads it
// once at load so a bare visit lands on the portal. Everywhere else the tag is
// absent and the staff dashboard stays the default.
function loadRouter(metaContent, startHash) {
  global.window = { location: { hash: startHash || "" }, addEventListener() {}, removeEventListener() {}, history: { replaceState() {} } };
  global.document = {
    querySelector(sel) {
      if (metaContent === null || sel.indexOf("ltp-default-route") === -1) return null;
      return { getAttribute() { return metaContent; } };
    },
  };
  (0, eval)(read("router.js"));
  const w = global.window;
  delete global.document;
  return w;
}
eq("no tag → a bare visit lands on the dashboard", loadRouter(null).location.hash, "/dashboard");
eq("crew-portal tag → a bare visit lands on the portal", loadRouter("crew-portal").location.hash, "/crew-portal");
eq("a bare '#' counts as bare", loadRouter("crew-portal", "#").location.hash, "/crew-portal");
eq("an existing hash is never overridden by the tag", loadRouter("crew-portal", "#/labor/roster").location.hash, "#/labor/roster");
eq("an unexpected tag value is ignored", loadRouter("evil<script>").location.hash, "/dashboard");
eq("the tag also sets the module a bare hash parses to", loadRouter("crew-portal").LTPRouter.getRoute().module, "crew-portal");
// Restore the plain shim for the remaining assertions.
global.window = { location: { hash: "#/crew-portal" }, addEventListener() {}, removeEventListener() {}, history: { replaceState() {} } };
(0, eval)(read("router.js"));

// ── Wiring ───────────────────────────────────────────────────────────────────
const app = read("app.js");
ok("app.js renders the portal outside the staff gate",
   /route\.module === "crew-portal"[\s\S]{0,200}LTPCrewPortal/.test(app));
ok("app.js checks the portal route BEFORE the auth gate",
   app.indexOf('route.module === "crew-portal"') < app.indexOf("if (authUser === undefined)"));

const auth = read("components/auth.js");
ok("auth.js skips the staff /auth/me probe on #/crew-portal",
   /crew-portal/.test(auth.split("function fireAuthCheck")[0]));
ok("auth.js also skips the probe on a bare visit to the crew host (the default-route tag)",
   /ltp-default-route/.test(auth.split("function fireAuthCheck")[0]));

const html = read("index.html");
const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
ok("index.html loads modules/crew-portal.js", srcs.includes("modules/crew-portal.js"));
ok("…after ui.js and domain-util.js (it reads LTP_useIsMobile, LTP_gcalUrl, LTP_useDocFreshness)",
   srcs.indexOf("modules/crew-portal.js") > srcs.indexOf("components/ui.js")
   && srcs.indexOf("modules/crew-portal.js") > srcs.indexOf("components/domain-util.js"));
ok("…before app.js (app.js references window.LTPCrewPortal)",
   srcs.indexOf("modules/crew-portal.js") < srcs.indexOf("app.js"));

const portal = read("modules/crew-portal.js");
ok("the module publishes window.LTPCrewPortal", /window\.LTPCrewPortal\s*=\s*function/.test(portal));
ok("the module talks only to /api/crew-portal", /var API = "\/api\/crew-portal"/.test(portal) && !/\/api\/contacts|\/api\/projects|LTP_STATE/.test(portal));
ok("every fetch sends the crew cookie", /credentials: "include"/.test(portal));
ok("no render-time router writes (replace/navigate only inside handlers or effects)",
   !/return h\([^;]*LTPRouter\.replace/.test(portal));
["login", "forgot", "request-access", "signup", "reset", "overview", "schedule", "payouts", "account"].forEach((screen) => {
  ok("the module handles the " + screen + " screen", portal.indexOf('"' + screen + '"') !== -1);
});

// ── Templates ────────────────────────────────────────────────────────────────
const data = read("data/settings.js");
["crewInvite", "crewPasswordReset"].forEach((key) => {
  ok("data/settings.js ships the " + key + " template", new RegExp(key + ":\\s*\\{").test(data));
  const tv = data.split("window.LTP_TEMPLATE_VARIABLES")[1];
  const m = new RegExp(key + ":\\s*\\[([^\\]]*)\\]").exec(tv);
  ok(key + " declares its variables", !!m);
  if (m) {
    const vars = new Set([...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]));
    const body = new RegExp(key + ":\\s*\\{[\\s\\S]*?body: \"((?:[^\"\\\\]|\\\\.)*)\"").exec(data)[1];
    const used = new Set([...body.matchAll(/\{\{(\w+)\}\}/g)].map((x) => x[1]));
    const leaks = [...used].filter((v) => !vars.has(v));
    ok(key + " body uses only declared variables", leaks.length === 0, leaks.join(", "));
  }
});
const settingsUi = read("modules/settings.js");
ok("Settings lists the portal templates for editing", /"crewInvite", "crewPasswordReset"/.test(settingsUi));

// ── Roster ───────────────────────────────────────────────────────────────────
const labor = read("modules/labor.js");
ok("the roster loads portal status", labor.indexOf('"/api/crew-portal/accounts"') !== -1);
ok("a new crew member with an email is invited after save", /inviteWhenSynced\(newId/.test(labor));
ok("invitations retry until the new row has synced", /status === 404 && attempt < 8/.test(labor));
["invite", "reset", "disable", "enable"].forEach((a) => {
  ok("the roster offers the " + a + " action", labor.indexOf('"' + a + '"') !== -1);
});

// ── Wording and typography ───────────────────────────────────────────────────
// Crew read "production manager", never "producer", and the portal carries no
// em dashes: sentences are split, or joined with a comma or colon, instead.
ok("the portal never says 'producer'", !/producer/i.test(portal));
ok("the portal has no em dashes", portal.indexOf("\u2014") === -1);
["list", "week", "month"].forEach((m) => ok("the schedule offers the " + m + " view", portal.indexOf('"' + m + '"') !== -1));

// ── Calendar math (the Schedule tab's week and month views) ──────────────────
// The module is loaded under a shim: at load it only aliases React and
// publishes window.LTPCrewPortal, whose ._cal carries the pure helpers.
{
  const savedWindow = global.window, savedReact = global.React;
  global.window = {};
  global.React = { createElement() { return null; }, useState() {}, useEffect() {}, useRef() {} };
  (0, eval)(portal);
  const cal = global.window.LTPCrewPortal._cal;
  global.window = savedWindow; global.React = savedReact;

  eq("addDaysISO crosses a month end", cal.addDaysISO("2026-09-30", 1), "2026-10-01");
  eq("addDaysISO steps back across a year", cal.addDaysISO("2026-01-01", -1), "2025-12-31");
  eq("addDaysISO leaves garbage alone", cal.addDaysISO("nope", 3), "nope");
  eq("weekStartISO is the Sunday on or before (a Wednesday)", cal.weekStartISO("2026-09-16"), "2026-09-13");
  eq("a Sunday is its own week start", cal.weekStartISO("2026-09-13"), "2026-09-13");
  eq("weekDays runs Sunday to Saturday", cal.weekDays("2026-09-16"),
     ["2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19"]);
  eq("addMonthsISO wraps the year forward", cal.addMonthsISO("2026-12-16", 1), "2027-01-01");
  eq("addMonthsISO wraps the year backward", cal.addMonthsISO("2026-01-16", -1), "2025-12-01");

  const grid = cal.monthGrid("2026-09-16");
  eq("September 2026 starts on Sunday Aug 30", grid[0].iso, "2026-08-30");
  eq("...and ends on Saturday Oct 3", grid[grid.length - 1].iso, "2026-10-03");
  ok("...in whole weeks", grid.length % 7 === 0, String(grid.length));
  eq("...with 30 in-month cells", grid.filter((c) => c.inMonth).length, 30);
  eq("...the padding cells flagged out of month", grid[0].inMonth, false);
  eq("February 2026 (a Sunday 1st, 28 days) is exactly four rows", cal.monthGrid("2026-02-10").length, 28);
  eq("a bad date yields an empty grid", cal.monthGrid("nope"), []);

  const flat = { flat: true, projectStart: "2026-10-05", projectEnd: "2026-10-08", roleLabel: "LD", status: "confirmed" };
  const by = cal.entriesByDate([
    { date: "2026-09-16", startTime: "14:00", roleLabel: "L2", status: "confirmed" },
    { date: "2026-09-16", startTime: "08:00", roleLabel: "A1", status: "accepted" },
    flat,
  ]);
  eq("timed calls sort by call time", by["2026-09-16"].map((e) => e.roleLabel), ["A1", "L2"]);
  eq("a flat-rate job lands on every day of its range",
     ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"].map((k) => (by[k] || []).length), [1, 1, 1, 1]);
  ok("...and not beyond it", !by["2026-10-09"] && !by["2026-10-04"]);
  eq("a flat-rate spread is capped at 62 days",
     Object.keys(cal.entriesByDate([{ flat: true, projectStart: "2026-01-01", projectEnd: "2026-12-31" }])).length, 62);
  eq("a flat-rate job with no dates is skipped", cal.entriesByDate([{ flat: true }]), {});
  eq("a reversed range collapses to its start day",
     Object.keys(cal.entriesByDate([{ flat: true, projectStart: "2026-10-08", projectEnd: "2026-10-05" }])), ["2026-10-08"]);
  eq("a timed call beside a flat job puts the flat job last",
     cal.entriesByDate([flat, { date: "2026-10-06", startTime: "09:00", roleLabel: "L2" }])["2026-10-06"].map((e) => e.roleLabel), ["L2", "LD"]);
  eq("null input yields an empty map", cal.entriesByDate(null), {});
  eq("a dateless timed call is dropped, not keyed under ''", cal.entriesByDate([{ date: "", roleLabel: "L2" }]), {});
}

console.log("crew-portal routes suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
