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

console.log("crew-portal routes suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
