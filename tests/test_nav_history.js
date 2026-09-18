#!/usr/bin/env node
// Navigation history — registry, stamping, seeding, goBack, peers, return-to,
// per-entry state. Pure Node, zero deps, against a fake window/history that
// behaves like a browser's (push truncates forward entries, back fires
// popstate then hashchange, state travels with the entry).
//   Run:  node tests/test_nav_history.js
"use strict";
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, a, b) { ok(n, JSON.stringify(a) === JSON.stringify(b), "got " + JSON.stringify(a) + " want " + JSON.stringify(b)); }
const ROUTER = fs.readFileSync(path.join(root, "router.js"), "utf8");
const REGISTRY = fs.readFileSync(path.join(root, "nav-registry.js"), "utf8");

function storage() { const m = {}; return { getItem(k) { return k in m ? m[k] : null; }, setItem(k, v) { m[k] = String(v); }, removeItem(k) { delete m[k]; } }; }
function makeWindow(startHash, store) {
  let entries = [{ url: "http://x/" + (startHash || ""), state: null }], i = 0;
  const listeners = {};
  const w = {
    location: {
      get hash() { const u = entries[i].url, k = u.indexOf("#"); return k < 0 ? "" : u.slice(k); },
      set hash(v) { const u = entries[i].url.split("#")[0] + (v.charAt(0) === "#" ? v : "#" + v); entries = entries.slice(0, i + 1).concat([{ url: u, state: null }]); i++; w.dispatchEvent({ type: "hashchange" }); },
      get href() { return entries[i].url; },
    },
    history: {
      get state() { return entries[i].state; }, get length() { return entries.length; },
      pushState(s, t, u) { entries = entries.slice(0, i + 1).concat([{ url: u, state: s }]); i++; },
      replaceState(s, t, u) { entries[i] = { url: u, state: s }; },
      back() { if (i > 0) { i--; w.dispatchEvent({ type: "popstate" }); w.dispatchEvent({ type: "hashchange" }); } },
    },
    sessionStorage: store || storage(),
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener(t, f) { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
    dispatchEvent(e) { (listeners[e.type] || []).forEach((f) => f(e)); return true; },
    confirm() { return w._confirm; }, _confirm: true,
    hashes() { return entries.map((e) => e.url.slice(e.url.indexOf("#") < 0 ? e.url.length : e.url.indexOf("#"))); },
    index() { return i; },
  };
  return w;
}
function boot(startHash, store) {
  const w = makeWindow(startHash, store);
  global.window = w; delete global.document;
  global.React = { useState() { throw new Error("no React here"); }, useEffect() {}, useRef() {}, useCallback(f) { return f; } };
  (0, eval)(ROUTER); (0, eval)(REGISTRY);
  return w;
}
function reload(w) { global.window = w; (0, eval)(ROUTER); (0, eval)(REGISTRY); return w; }
const R = () => window.LTPRouter, G = () => window.LTP_NAV_REGISTRY;
const parse = (p) => R().parsePath("#/" + p);

// ── Parents are declared ─────────────────────────────────────────────────────
boot("#/dashboard");
const P = (p) => G().parentOf(parse(p));
eq("home has no parent", P("dashboard"), null);
[["crm/companies", "dashboard"], ["crm/contacts", "dashboard"], ["projects", "dashboard"], ["calendar", "dashboard"],
 ["rentals", "dashboard"], ["rentals/equipment", "dashboard"], ["rentals/kits", "dashboard"], ["rentals/cross-rentals", "dashboard"],
 ["quotes", "dashboard"], ["quotes/products", "dashboard"], ["quotes/client-rates", "dashboard"], ["invoices", "dashboard"],
 ["labor/assignments", "dashboard"], ["labor/payouts", "dashboard"], ["settings", "dashboard"],
].forEach(([p, want]) => eq("root/tab " + p + " → " + want, P(p), want));
[["crm/companies/new", "crm/companies"], ["crm/companies/42", "crm/companies"], ["crm/companies/42/edit", "crm/companies/42"],
 ["crm/contacts/7", "crm/contacts"], ["crm/contacts/7/edit", "crm/contacts/7"],
 ["projects/new", "projects"], ["projects/7", "projects"], ["projects/7/meetings", "projects"], ["projects/7/edit", "projects/7"],
 ["projects/7/schedule", "projects"],                                   // full-screen editor → the list (decision 1)
 ["quotes/new", "quotes"], ["quotes/9", "quotes"], ["invoices/new", "invoices"], ["invoices/901", "invoices"],
 ["rentals/equipment/new", "rentals/equipment"], ["rentals/equipment/3", "rentals/equipment"],
 ["rentals/equipment/3/edit", "rentals/equipment/3"], ["rentals/equipment/3/scan", "rentals/equipment/3"],
 ["rentals/kits/3/edit", "rentals/kits/3"], ["rentals/cross-rentals/new", "rentals/cross-rentals"],
 // #/rentals/<id> — an equipment item opened from the Availability Checker,
 // which is the bare `rentals` tab. Distinct from #/rentals/equipment/<id>,
 // the same item opened from the Equipment List tab; each goes back to the
 // tab it was opened from rather than swapping the list behind the popup.
 ["rentals/2", "rentals"], ["rentals/equipment/2", "rentals/equipment"],
 ["crew-portal/overview", null], ["crew-portal/payouts", "crew-portal/overview"], ["crew-portal/account", "crew-portal/overview"],
 ["crew-portal/login", null], ["crew-portal/forgot", "crew-portal/login"], ["crew-portal/signup/tok", "crew-portal/login"],
 ["crew-portal/reset/tok", "crew-portal/login"], ["crew-portal/confirm-email/tok", "crew-portal/overview"],
 ["view/quote/tok", null], ["crew/tok", null], ["bogus", null],
].forEach(([p, want]) => eq("parent " + p + " → " + want, P(p), want));

// ── Canonical URLs ───────────────────────────────────────────────────────────
const C = (p) => G().canonical(parse(p));
eq("bare crm → companies", C("crm"), "crm/companies");
eq("bare labor → assignments", C("labor"), "labor/assignments");
eq("bad crm tab", C("crm/bogus"), "crm/companies");
eq("bad rentals tab", C("rentals/bogus"), "rentals");
eq("unknown module → home", C("foo"), "dashboard");
["dashboard", "projects", "quotes/products", "rentals", "rentals/2", "labor/roster", "invoices/9", "view/quote/t", "crew-portal/login", "crm/companies/5"].forEach((p) => eq("already canonical " + p, C(p), null));

// ── Chains ───────────────────────────────────────────────────────────────────
const CH = (p) => G().chainFor(parse(p));
eq("chain edit company", CH("crm/companies/42/edit"), ["dashboard", "crm/companies", "crm/companies/42"]);
eq("chain schedule editor", CH("projects/7/schedule"), ["dashboard", "projects"]);
eq("chain quote", CH("quotes/9"), ["dashboard", "quotes"]);
eq("chain kit edit", CH("rentals/kits/3/edit"), ["dashboard", "rentals/kits", "rentals/kits/3"]);
eq("chain checker item", CH("rentals/2"), ["dashboard", "rentals"]);
eq("chain equipment-list item", CH("rentals/equipment/2"), ["dashboard", "rentals/equipment"]);
eq("chain portal tab", CH("crew-portal/payouts"), ["crew-portal/overview"]);
eq("chain portal signup", CH("crew-portal/signup/tok"), ["crew-portal/login"]);
eq("chain home", CH("dashboard"), []);

// ── Peers / goTab ────────────────────────────────────────────────────────────
const peer = (a, b) => G().isPeer(parse(a), parse(b));
ok("companies ~ contacts", peer("crm/companies", "crm/contacts"));
ok("quotes ~ products", peer("quotes", "quotes/products"));
ok("rentals ~ kits", peer("rentals", "rentals/kits"));
ok("labor roster ~ payouts", peer("labor/roster", "labor/payouts"));
ok("portal overview ~ schedule", peer("crew-portal/overview", "crew-portal/schedule"));
ok("detail is not a peer of a tab", !peer("crm/companies/5", "crm/contacts"));
ok("a checker item is not a peer of the checker", !peer("rentals/2", "rentals"));
ok("cross-module never peers", !peer("quotes", "invoices"));
ok("home is nobody's peer", !peer("dashboard", "projects"));
{
  const w = boot("#/dashboard");
  G().seedIfCold();
  G().goTab("crm/companies");                                  // entering the area: push
  eq("enter area pushes", w.hashes(), ["#/dashboard", "#/crm/companies"]);
  G().goTab("crm/contacts");                                   // sibling: replace
  eq("sibling tab replaces", w.hashes(), ["#/dashboard", "#/crm/contacts"]);
  eq("index unchanged by replace", R().currentIndex(), 1);
  R().goBack();
  eq("Back leaves the area in one step", w.location.hash, "#/dashboard");
}

// ── Bare load ────────────────────────────────────────────────────────────────
{
  const w = boot("");
  eq("bare load lands on home", w.location.hash, "#/dashboard");
  eq("…by replace, not push", w.history.length, 1);
  ok("bare load is still cold (no stamp)", R().entryKey() === null);
}

// ── Stamping, in-app detection, goBack ───────────────────────────────────────
{
  const w = boot("#/quotes");
  ok("foreign entry has no in-app prev", !R().hasInAppPrev());
  R().navigate("quotes/5");
  eq("push stamps idx 1", w.history.state.ltp.idx, 1);
  ok("now has in-app prev", R().hasInAppPrev());
  R().navigate("quotes/5");
  eq("same-path navigate is a no-op", w.history.length, 2);
  R().goBack();
  eq("goBack steps back one entry", w.location.hash, "#/quotes");
  ok("…and the foreign entry still counts as no-prev", !R().hasInAppPrev());
  R().goBack();
  eq("goBack on a foreign root replaces to the parent (home)", w.location.hash, "#/dashboard");
  eq("…without adding entries", w.hashes(), ["#/dashboard", "#/quotes/5"]);
}
{
  const w = boot("#/rentals/2");
  ok("a checker item seeds", G().seedIfCold());
  eq("...under the checker, not the Equipment List", w.hashes(), ["#/dashboard", "#/rentals", "#/rentals/2"]);
  R().goBack(); eq("Back returns to the checker", w.location.hash, "#/rentals");
}
{
  const w = boot("#/rentals/kits/3");
  R().goBack();
  eq("cold deep entry, no seed: goBack replaces to the logical parent", w.hashes(), ["#/rentals/kits"]);
}

// ── Seeding ──────────────────────────────────────────────────────────────────
{
  const w = boot("#/crm/companies/42/edit");
  ok("seeds a cold deep entry", G().seedIfCold());
  eq("stack is [root … parent, current]", w.hashes(), ["#/dashboard", "#/crm/companies", "#/crm/companies/42", "#/crm/companies/42/edit"]);
  eq("user is on the current entry", w.index(), 3);
  eq("current entry stamped at its depth", w.history.state.ltp.idx, 3);
  ok("seeding is idempotent", !G().seedIfCold());
  R().goBack(); eq("Back → detail", w.location.hash, "#/crm/companies/42");
  R().goBack(); eq("Back → list", w.location.hash, "#/crm/companies");
  R().goBack(); eq("Back → home", w.location.hash, "#/dashboard");
  ok("home has no in-app prev", !R().hasInAppPrev());
  R().goBack(); eq("Back at home stays home", w.location.hash, "#/dashboard");
  eq("…and never grew the stack", w.history.length, 4);
}
{
  const w = boot("#/crm");
  G().seedIfCold();
  eq("canonicalises while seeding", w.hashes(), ["#/dashboard", "#/crm/companies"]);
}
{
  const w = boot("#/foo");
  G().seedIfCold();
  eq("unknown route seeds as home alone", w.hashes(), ["#/dashboard"]);
}
{
  const w = boot("#/view/quote/abc?preview=1");
  ok("public share view is never seeded", !G().seedIfCold());
  eq("…and untouched", w.hashes(), ["#/view/quote/abc?preview=1"]);
}
{
  const w = boot("#/crew-portal/payouts");
  G().seedIfCold();
  eq("portal tab seeds under overview", w.hashes(), ["#/crew-portal/overview", "#/crew-portal/payouts"]);
}
{
  const w = boot("#/rentals/cross-rentals/new?equipmentId=4&start=2026-09-01");
  G().seedIfCold();
  eq("query survives seeding", w.hashes(), ["#/dashboard", "#/rentals/cross-rentals", "#/rentals/cross-rentals/new?equipmentId=4&start=2026-09-01"]);
}

// ── Reload keeps the session ─────────────────────────────────────────────────
{
  const w = boot("#/projects");
  G().seedIfCold(); R().navigate("projects/7");
  reload(w);
  ok("after reload the entry is still ours", R().entryKey() !== null);
  ok("seed does not run again", !G().seedIfCold());
  ok("in-app prev survives reload", R().hasInAppPrev());
  R().goBack(); eq("Back after reload is one real step", w.location.hash, "#/projects");
}
{
  const w = boot("#/projects");
  G().seedIfCold(); R().navigate("projects/7");
  const fresh = makeWindow("#/projects/7");            // a new launch: same URL, no history, new storage
  fresh.history.replaceState(w.history.state, "", fresh.location.href);
  global.window = fresh; (0, eval)(ROUTER); (0, eval)(REGISTRY);
  ok("a fresh launch (new sessionStorage) treats the old stamp as foreign", !R().hasInAppPrev());
}

// ── Return-to after login ────────────────────────────────────────────────────
{
  const store = storage();
  boot("#/invoices/901", store);
  G().stashReturnTo();
  const w = boot("", store);                               // /auth/callback → "/" → bare load
  eq("callback lands on home first", w.location.hash, "#/dashboard");
  G().seedIfCold();
  eq("…then restores the requested screen, seeded, with no sign-in entry", w.hashes(), ["#/dashboard", "#/invoices", "#/invoices/901"]);
  eq("stash is consumed", G().consumeReturnTo(), null);
  boot("#/view/quote/abc", store); G().stashReturnTo();
  eq("public routes are never stashed", G().consumeReturnTo(), null);
}

// ── Per-entry state ──────────────────────────────────────────────────────────
{
  const w = boot("#/quotes");
  G().seedIfCold();
  G().setEntryField("filter", "sent");
  R().navigate("quotes/5");
  ok("new entry starts empty", G().entryState() === null);
  R().goBack();
  eq("Back restores the entry's remembered state", G().entryState().filter, "sent");
  R().replace("quotes/products");
  ok("replace drops the entry's state", G().entryState() === null);
}

// ── Unsaved-changes guard ────────────────────────────────────────────────────
{
  const w = boot("#/quotes");
  G().seedIfCold(); R().navigate("quotes/5");
  window.__LTP_UNSAVED = true; w._confirm = false;
  R().goBack(); eq("declined confirm blocks goBack", w.location.hash, "#/quotes/5");
  R().navigate("quotes"); eq("declined confirm blocks navigate", w.location.hash, "#/quotes/5");
  w._confirm = true;
  R().goBack(); eq("accepted confirm proceeds", w.location.hash, "#/quotes");
  ok("…and clears the flag", window.__LTP_UNSAVED === false);
}

console.log("nav-history suite — PASS: " + pass + "   FAIL: " + fail);
if (fail) { fails.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
