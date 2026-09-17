#!/usr/bin/env node
// Runtime acceptance matrix for the navigation rewrite — docs/NAVIGATION_DESIGN.md.
//
// NOT part of the automatic suites: it needs a running server, a forged
// session and the `playwright` npm package, so it lives outside tests/test_*.js
// (which the session-start hook runs unattended). The unit suite
// tests/test_nav_history.js covers the history mechanics against a fake
// history; this drives a real browser, which is the only way to catch things
// like a boot file the backend refuses to serve.
//
// Setup and run — see .claude/skills/verify/SKILL.md for the full recipe:
//   DATABASE_URL="sqlite+aiosqlite:///$S/ltp.db" .venv/bin/uvicorn backend.main:app --port 8000 &
//   # forge a session row, seed a company/project/equipment via /api/*
//   npm install playwright && curl the four cdnjs libs into ./vendor
//   node tests/manual/verify-navigation.js
const { chromium } = require("playwright");
const path = require("path");
const BASE = "http://127.0.0.1:8000";
const TOKEN = "verifytoken-navigation-backbutton-0001";
const VENDOR = path.join(__dirname, "vendor");
const MAP = { "react/": "react.js", "react-dom/": "react-dom.js", "dompurify/": "purify.js", "signature_pad/": "signature_pad.js" };

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) { pass++; console.log("  ok   " + n); } else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); console.log("  FAIL " + n + (d ? "  [" + d + "]" : "")); } }
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const hash = (p) => p.evaluate(() => location.hash);
const hlen = (p) => p.evaluate(() => history.length);
const idx  = (p) => p.evaluate(() => (history.state && history.state.ltp) ? history.state.ltp.idx : null);
const settle = async (p, ms = 450) => p.waitForTimeout(ms);
async function back(p) { await p.goBack(); await settle(p); }

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: false, args: ["--headless=new"] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies([{ name: "ltp_session", value: TOKEN, url: BASE }]);
  await ctx.route("**cdnjs.cloudflare.com/**", (route) => {
    const u = route.request().url();
    const k = Object.keys(MAP).find((x) => u.includes(x));
    return k ? route.fulfill({ path: path.join(VENDOR, MAP[k]), contentType: "application/javascript" }) : route.abort();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  async function cold(h) {                      // a genuinely cold entry: fresh tab
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(BASE + "/" + h, { waitUntil: "networkidle" });
    await p.waitForTimeout(1200);
    return p;
  }

  console.log("\n#1 cold load of a deep route seeds its ancestors");
  {
    const p = await cold("#/crm/companies/1/edit");
    eq("lands on the requested screen", await hash(p), "#/crm/companies/1/edit");
    eq("stamped at chain depth 3", await idx(p), 3);
    await back(p); eq("Back → detail", await hash(p), "#/crm/companies/1");
    await back(p); eq("Back → list", await hash(p), "#/crm/companies");
    await back(p); eq("Back → home", await hash(p), "#/dashboard");
    await p.close();
  }
  {
    const p = await cold("#/rentals/equipment/1");
    eq("rentals deep link lands", await hash(p), "#/rentals/equipment/1");
    await back(p); eq("Back → equipment list", await hash(p), "#/rentals/equipment");
    await back(p); eq("Back → home (tabs are peers)", await hash(p), "#/dashboard");
    await p.close();
  }
  {
    const p = await cold("#/projects/1/schedule");
    eq("schedule editor deep link lands", await hash(p), "#/projects/1/schedule");
    await back(p); eq("full-screen editor Back → its LIST, per decision 1", await hash(p), "#/projects");
    await p.close();
  }

  console.log("\n#2 in-app drill-down A → B → C returns exactly");
  {
    const p = await cold("#/projects");
    await p.click("text=Northside Gala"); await settle(p);
    eq("drilled into the project", await hash(p), "#/projects/1");
    await p.evaluate(() => window.LTPRouter.navigate("projects/1/edit")); await settle(p);
    eq("drilled into edit", await hash(p), "#/projects/1/edit");
    await back(p); eq("C → B", await hash(p), "#/projects/1");
    await back(p); eq("B → A", await hash(p), "#/projects");
    await p.close();
  }

  console.log("\n#3 cross-area link returns to the originating screen");
  {
    const p = await cold("#/rentals/equipment");
    await p.evaluate(() => window.LTPRouter.navigate("crm/companies/1")); await settle(p);
    eq("crossed into CRM", await hash(p), "#/crm/companies/1");
    await back(p);
    eq("Back returns to the ORIGIN, not the CRM list", await hash(p), "#/rentals/equipment");
    await p.close();
  }

  console.log("\n#5 tab changes leave the screen, they do not step through filters");
  {
    const p = await cold("#/crm/companies");
    const before = await hlen(p);
    await p.click("text=Contacts"); await settle(p);
    eq("tab switched", await hash(p), "#/crm/contacts");
    eq("no history entry added", await hlen(p), before);
    await back(p);
    eq("Back leaves the area in one step", await hash(p), "#/dashboard");
    await p.close();
  }

  console.log("\n#6 a URL-bound modal: Back closes it only");
  {
    const p = await cold("#/crm/companies");
    await p.click("text=Acme Studios"); await settle(p);
    eq("modal opened via the URL", await hash(p), "#/crm/companies/1");
    ok("modal is on screen", await p.locator(".ltp-modal-backdrop").count() > 0);
    await back(p);
    eq("Back returns to the list", await hash(p), "#/crm/companies");
    eq("modal is gone", await p.locator(".ltp-modal-backdrop").count(), 0);
    await p.close();
  }

  console.log("\n#4 create: Back never returns to a blank form");
  {
    const p = await cold("#/crm/companies");
    const n0 = await hlen(p);
    await p.evaluate(() => window.LTPRouter.navigate("crm/companies/new")); await settle(p);
    eq("on the create form", await hash(p), "#/crm/companies/new");
    await p.fill('input[placeholder="e.g. Dallas Theater Center"]', "Back Test Co");
    await p.click('button:text-is("Save Company")'); await settle(p, 900);
    const after = await hash(p);
    ok("saved to the new record", /^#\/crm\/companies\/\d+$/.test(after), after);
    eq("the form entry was REPLACED, not stacked", await hlen(p), n0 + 1);
    await back(p);
    eq("Back goes to the list, never the blank form", await hash(p), "#/crm/companies");
    ok("and no form is on screen", await p.locator('button:text-is("Save Company")').count() === 0);
    await p.close();
  }

  console.log("\ndead record ids never strand the user");
  for (const [dead, land] of [["#/quotes/99999", "#/quotes"], ["#/crm/companies/99999", "#/crm/companies"],
                              ["#/rentals/equipment/99999", "#/rentals/equipment"], ["#/invoices/99999", "#/invoices"]]) {
    const p = await cold(dead);
    eq(dead + " → " + land, await hash(p), land);
    await p.close();
  }
  { const p = await cold("#/bogus/route"); eq("an unknown route canonicalises home", await hash(p), "#/dashboard"); await p.close(); }

  console.log("\n#8 reload mid-session preserves Back");
  {
    const p = await cold("#/projects");
    await p.evaluate(() => window.LTPRouter.navigate("projects/2")); await settle(p);
    await p.reload({ waitUntil: "networkidle" }); await p.waitForTimeout(1200);
    eq("same screen after reload", await hash(p), "#/projects/2");
    await back(p);
    eq("Back is still one real step", await hash(p), "#/projects");
    await p.close();
  }

  console.log("\n#4b list state and scroll come back with Back");
  {
    const p = await cold("#/projects");
    await p.fill('input[placeholder*="Search"]', "Harbor"); await settle(p);
    await p.evaluate(() => window.LTPRouter.navigate("projects/2")); await settle(p);
    await back(p);
    const v = await p.inputValue('input[placeholder*="Search"]');
    eq("the search box is as it was left", v, "Harbor");
    await p.close();
  }

  console.log("\n#10 seeding causes no double fetch and no ancestor render");
  {
    // One hashchange means React was handed the final route once: the seeded
    // ancestors were written into history without ever being rendered. A flash
    // would need one hashchange per ancestor.
    const p = await ctx.newPage();
    const reqs = [];
    p.on("request", (r) => { if (r.url().includes("/api/")) reqs.push(r.method() + " " + r.url()); });
    await p.addInitScript(() => {
      window.__hashEvents = 0;
      window.addEventListener("hashchange", () => { window.__hashEvents++; });
    });
    await p.goto(BASE + "/#/crm/companies/1/edit", { waitUntil: "networkidle" });
    await p.waitForTimeout(1800);
    const dupes = Object.entries(reqs.reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {})).filter(([, n]) => n > 1);
    ok("no API request is made twice while seeding a 3-deep route", dupes.length === 0, JSON.stringify(dupes.slice(0, 3)));
    eq("seeding hands React the route exactly once (no ancestor render)", await p.evaluate(() => window.__hashEvents), 1);
    eq("and it really is 3 deep", await idx(p), 3);
    await p.close();
  }

  ok("no uncaught page errors anywhere", errors.length === 0, errors.slice(0, 3).join(" | "));
  console.log("\nverify-nav — PASS: " + pass + "   FAIL: " + fail);
  if (fail) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); }
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
