#!/usr/bin/env node
// Render-tree snapshot for QuotesBuilder and InvoiceBuilder.
//
// WHY THIS EXISTS
//   These two components are 1,670 and 1,998 lines and were, until this suite,
//   completely untested — nothing inside a closure that large can be reached by
//   a unit test. That is fine right up until someone refactors them, at which
//   point a dropped prop or a stale closure reference is silent in a language
//   with no compiler, and surfaces as a blank panel on whichever screen the
//   user opens next.
//
//   So this renders both builders across 14 data scenarios under a hook-capable
//   React shim, serializes the resulting element trees, and diffs against a
//   committed golden file. For a refactor that is supposed to be a pure move,
//   the trees must be byte-identical. It is the same idea as the theme.js split
//   snapshot, adapted to components.
//
// WHAT IT DOES AND DOES NOT COVER
//   Covered: the initial render of every scenario below — which sub-components
//   appear, in what nesting, with which props (functions collapsed to `fn`,
//   style objects to a property count, everything else serialized).
//   Composite components are INVOKED, so InvoiceBuilder — reachable only
//   through InvoicesView — is rendered in place rather than left opaque.
//
//   NOT covered: anything gated on isDirty. That flag is owned by
//   LTP_useUnsavedGuard and only flips on a user edit, so branches like
//   `isDirty && !isLocked && Save` are dark in every static render. Verified:
//   forcing `isLocked = false` does not move the snapshot. The scenarios below
//   compensate where they can by varying INPUT DATA (paid / partial / overdue /
//   pushed-to-QuickBooks invoices; accepted / expired / declined quotes) to
//   light up the status and money branches instead.
//
//   Also not covered: effects (useEffect is a no-op here) and anything behind a
//   click. This is a structural guard, not a behavioural one.
//
// USAGE
//   node tests/test_builder_render.js            # compare against the golden
//   node tests/test_builder_render.js --update   # regenerate after an
//                                                # INTENTIONAL render change
"use strict";

const fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.join(__dirname, "..");

// ── React shim with real hook state ────────────────────────────────────────
let CTX = null;
function mkCtx(render) { return { idx: 0, hooks: {}, render: render, effects: [] }; }
global.React = {
  Fragment: "Fragment",
  createElement: function (type, props) {
    const children = Array.prototype.slice.call(arguments, 2);
    return { $$: true, type: type, props: props || {}, children: children };
  },
  useState: function (init) {
    const c = CTX, i = c.idx++;
    if (!(i in c.hooks)) c.hooks[i] = { v: typeof init === "function" ? init() : init };
    const slot = c.hooks[i];
    return [slot.v, function (nv) { slot.v = typeof nv === "function" ? nv(slot.v) : nv; }];
  },
  useRef: function (init) {
    const c = CTX, i = c.idx++;
    if (!(i in c.hooks)) c.hooks[i] = { current: init };
    return c.hooks[i];
  },
  useMemo: function (f) { const c = CTX, i = c.idx++;
    if (!(i in c.hooks)) c.hooks[i] = { v: f() };
    return c.hooks[i].v; },
  useCallback: function (f) { return f; },
  useEffect: function () {},          // effects are side-effectful; skip
  useLayoutEffect: function () {},
};

// ── Host environment ───────────────────────────────────────────────────────
global.window = {};
global.document = {
  createElement: function () { return { style: {}, setAttribute: function () {}, appendChild: function () {},
    querySelector: function () { return null; }, focus: function () {}, select: function () {},
    classList: { add: function () {}, remove: function () {} }, innerHTML: "", textContent: "" }; },
  addEventListener: function () {}, removeEventListener: function () {},
  getElementById: function () { return null; }, querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  body: { appendChild: function () {}, removeChild: function () {}, style: {} },
};
// Node 22 defines navigator as a getter-only global; define instead of assign.
Object.defineProperty(global, "navigator", { value: { userAgent: "node", clipboard: { writeText: function () { return Promise.resolve(); } } }, configurable: true, writable: true });
global.location = { origin: "https://ltp.example.com", href: "https://ltp.example.com/" };
global.fetch = function () { return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } }); };
global.matchMedia = function () { return { matches: false, addEventListener: function () {}, removeEventListener: function () {} }; };
global.requestAnimationFrame = function () { return 0; };
Object.assign(global.window, {
  location: global.location, document: global.document, navigator: global.navigator,
  matchMedia: global.matchMedia, addEventListener: function () {}, removeEventListener: function () {},
  dispatchEvent: function () {}, open: function () { return null; }, confirm: function () { return true; },
  innerWidth: 1440, innerHeight: 900, getComputedStyle: function () { return {}; },
});

// ── Real code: the domain layer, then the real components the builders use ──
const { domainScripts } = require(path.join(ROOT, "tests", "_load_domain.js"));
for (const rel of domainScripts()) (0, eval)(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const REAL_COMPONENTS = [
  "components/helpers.js", "components/status-enums.js", "components/sortable.js",
];
for (const rel of REAL_COMPONENTS) {
  const p = path.join(ROOT, rel);
  if (fs.existsSync(p)) { try { (0, eval)(fs.readFileSync(p, "utf8")); } catch (e) { /* optional */ } }
}

// ── Stubs for everything a real DOM would provide ──────────────────────────
// Each UI component becomes a marker element, so the tree still records WHERE
// it appears and WHAT props it is handed — which is the part a refactor can
// break — without needing the component's own internals.
function stub(name) { return function (props) { return { $$: true, type: "<" + name + ">", props: props || {}, children: [] }; }; }
[
  "Badge", "Btn", "ClientRateChip", "CompanySearchField", "ContactSearchField", "EmailBodyEditor",
  "LTPConfirmDialog", "LTPDocTerms", "LTPInput", "LTPList", "LTPModal", "LTPMoveArrows",
  "LTPNoteLineRow", "LTPOverflowMenu", "LTPRow", "LTPScrollStrip", "LTPSelect", "LTPTabs",
  "ProjectSearchField", "RecipientEditor", "StatCard",
].forEach((n) => { if (!window[n]) window[n] = stub(n); });

if (!window.LTP_useIsMobile) window.LTP_useIsMobile = function () { return false; };
if (!window.LTP_useSortable) window.LTP_useSortable = function () {
  return { zoneProps: function () { return {}; }, itemProps: function () { return {}; },
           handleProps: function () { return {}; }, animate: function (f) { f(); },
           dragging: null, isDragging: false };
};
if (!window.LTP_deriveRecipients) window.LTP_deriveRecipients = function () { return []; };
if (!window.LTP_toast) window.LTP_toast = function () {};
if (!window.LTPRouter) window.LTPRouter = { navigate: function () {}, current: function () { return {}; } };
if (!window.LTP_HELPERS) window.LTP_HELPERS = {};
window.LTP_CURRENT_USER = "Test User";
window.LTP_CURRENT_USER_ID = "u1";
window.LTP_SENDER_NAME = "Sender"; window.LTP_SENDER_EMAIL = "s@example.com";
window.LTP_GMAIL_CONNECTED = true;
window.LTP_DATA_SETTINGS = window.LTP_DATA_SETTINGS || {};
window.LTP_DEFAULT_TERMS = window.LTP_DEFAULT_TERMS || "";
window.LTP_DEFAULT_QUOTE_NOTES = ""; window.LTP_DEFAULT_INVOICE_NOTES = "";
window.LTP_API_ERRORS = [];
window.LTP_RENTALS = window.LTP_RENTALS || {};

// ── Deterministic ids (BEFORE the modules load) ──────────────────────────────────────────────────────
let _n = 0;
window.LTP_genId = function (p) { return (p || "x") + "-" + (++_n); };
window.LTP_genShareToken = function () { return "tok-" + (++_n); };
window.LTP_todayISO = function () { return "2026-08-29"; };

// ── The builders ───────────────────────────────────────────────────────────
(0, eval)(fs.readFileSync(path.join(ROOT, "modules", "quotes-list.js"), "utf8"));
(0, eval)(fs.readFileSync(path.join(ROOT, "modules", "quotes-builder.js"), "utf8"));
(0, eval)(fs.readFileSync(path.join(ROOT, "modules", "invoices.js"), "utf8"));

// ── Fixtures ───────────────────────────────────────────────────────────────
const COMPANIES = [{ id: "co1", name: "Acme Co", taxable: true, address: "1 A St", city: "LA", state: "CA", zip: "90001" }];
const CONTACTS = [{ id: "ct1", name: "Dana Reyes", email: "dana@acme.test", companyIds: ["co1"] },
                  { id: "c9", name: "Crew Person", isCrew: true }];
const PROJECTS = [{ id: "pr1", name: "Spring Shoot", companyId: "co1", startDate: "2026-09-01", endDate: "2026-09-03", schedule: [] }];
const SERVICES = [{ id: "s1", role: "A1", department: "Audio", dayRate: 1000, halfRate: 600, hourlyRate: 150, otRate: 225, cost: 500 }];
const PRODUCTS = [{ id: "p1", name: "Console", price: 500, cost: 300, variants: [] }];
const EQUIPMENT = [{ id: "e1", name: "Speaker", dayRate: 100, weekRate: 300, cost: 40 }];
const FEES = [{ id: "f1", name: "Lodging", amount: 200 }];
const SETTINGS = { defaultPaymentTerms: "Net 30", quoteValidityDays: 30, emailTemplates: {}, tagColors: {} };

const QUOTE = {
  id: 1, createdDate: "2026-08-01", status: "draft", clientType: "company", companyId: "co1",
  projectId: "pr1", contactId: "ct1", globalDiscount: { type: "percent", value: 10 },
  terms: "", notes: "", activity: [], sections: [
    { id: "sec1", label: "Audio", customDates: false, startDate: "", endDate: "", items: [
      { id: "i1", type: "product", productId: "p1", name: "Console", qty: 2, unitPrice: 500, cost: 300, taxable: true },
      { id: "i2", type: "service", serviceId: "s1", name: "A1", qty: 1, unitPrice: 1000, adjustedPrice: 900, cost: 600, taxable: false },
      { id: "i3", type: "note", text: "Handle with care" },
    ] },
    { id: "sec2", label: "Grip", customDates: false, startDate: "", endDate: "", items: [] },
  ],
};
const INVOICE = Object.assign({}, JSON.parse(JSON.stringify(QUOTE)), {
  id: 7, invoiceDate: "2026-08-05", dueDate: "2026-09-04", status: "draft", payments: [],
});

const COMMON = {
  products: PRODUCTS, services: SERVICES, clientRates: [], fees: FEES, equipment: EQUIPMENT,
  allocations: [], companies: COMPANIES, contacts: CONTACTS, projects: PROJECTS,
  setProjects: function () {}, settings: SETTINGS, isAdmin: true, qbo: { connected: false },
};

function render(Component, props, label) {
  const ctx = mkCtx(function () {});
  CTX = ctx; ctx.idx = 0;
  let tree;
  try { tree = Component(props); }
  catch (e) { return label + " THREW: " + e.constructor.name + ": " + e.message + "\n" + (e.stack || "").split("\n").slice(1, 4).join("\n"); }
  finally { CTX = null; }
  return label + "\n" + serialize(tree, 0);
}

function serialize(node, depth) {
  const pad = "  ".repeat(Math.min(depth, 40));
  if (node == null || node === false || node === true) return "";
  if (Array.isArray(node)) return node.map((n) => serialize(n, depth)).filter(Boolean).join("\n");
  if (typeof node !== "object") return pad + String(node);
  if (!node.$$) return pad + "{" + Object.keys(node).sort().join(",") + "}";

  // A composite (function) type is INVOKED so the tree below it is captured
  // too — otherwise InvoiceBuilder, reached only through InvoicesView, would
  // serialize as a single opaque line and the snapshot would prove nothing
  // about it. Each composite gets its own hook context, and the render is
  // depth-first, exactly as React does it.
  if (typeof node.type === "function") {
    const name = node.type.name || "anon";
    const saved = CTX;
    CTX = mkCtx(function () {});
    let sub;
    try { sub = node.type(node.props || {}); }
    catch (e) { CTX = saved; return pad + "<" + name + " RENDER-THREW=" + e.constructor.name + ":" + JSON.stringify(e.message) + ">"; }
    CTX = saved;
    const inner = serialize(sub, depth + 1);
    return pad + "<" + name + ">" + (inner ? "\n" + inner : "");
  }
  const t = String(node.type);
  const props = node.props || {};
  const keys = Object.keys(props).filter((k) => k !== "children").sort();
  const desc = keys.map((k) => {
    const v = props[k];
    if (typeof v === "function") return k + "=fn";
    if (k === "style" && v && typeof v === "object") return "style=" + Object.keys(v).sort().length + "props";
    if (v && typeof v === "object") { try { return k + "=" + JSON.stringify(v); } catch (_) { return k + "=obj"; } }
    return k + "=" + JSON.stringify(v);
  }).join(" ");
  const kids = (node.children || []).concat(props.children === undefined ? [] : [props.children])
    .map((c) => serialize(c, depth + 1)).filter(Boolean).join("\n");
  return pad + "<" + t + (desc ? " " + desc : "") + ">" + (kids ? "\n" + kids : "");
}

const out = [];
out.push(render(window.QuotesBuilder, Object.assign({
  quoteId: 1, isNew: false, quotes: [QUOTE], setQuotes: function () {},
  getNextQuoteId: function () { return 2; }, invoices: [], setInvoices: function () {},
  getNextInvoiceId: function () { return 1; },
}, COMMON), "== QuotesBuilder (existing draft) =="));

out.push(render(window.QuotesBuilder, Object.assign({
  quoteId: null, isNew: true, quotes: [], setQuotes: function () {},
  getNextQuoteId: function () { return 1; }, invoices: [], setInvoices: function () {},
  getNextInvoiceId: function () { return 1; },
}, COMMON), "\n== QuotesBuilder (new) =="));

out.push(render(window.QuotesBuilder, Object.assign({
  quoteId: 1, isNew: false, quotes: [Object.assign({}, QUOTE, { status: "sent", sentDate: "2026-08-10" })],
  setQuotes: function () {}, getNextQuoteId: function () { return 2; },
  invoices: [], setInvoices: function () {}, getNextInvoiceId: function () { return 1; },
}, COMMON), "\n== QuotesBuilder (sent) =="));

// InvoiceBuilder is not exported; it is reached through InvoicesView's route
// prop. The recursive serializer above renders it in place.
const INV_PROPS = Object.assign({
  invoices: [INVOICE], setInvoices: function () {}, getNextInvoiceId: function () { return 8; },
  quotes: [QUOTE], setQuotes: function () {}, setCompanies: function () {}, setContacts: function () {},
}, COMMON);
out.push(render(window.InvoicesView, Object.assign({ route: { id: 7, action: null } }, INV_PROPS),
  "\n== InvoiceBuilder (existing draft) =="));
out.push(render(window.InvoicesView, Object.assign({ route: { id: null, action: "new" } }, INV_PROPS),
  "\n== InvoiceBuilder (new) =="));
out.push(render(window.InvoicesView, Object.assign({ route: { id: 7, action: null } },
  INV_PROPS, { invoices: [Object.assign({}, INVOICE, { status: "sent", sentDate: "2026-08-10" })] }),
  "\n== InvoiceBuilder (sent) =="));
out.push(render(window.InvoicesView, Object.assign({ route: { id: null, action: null } }, INV_PROPS),
  "\n== InvoiceList =="));

// ── Branch-widening scenarios ──────────────────────────────────────────────
// The seven above all render a PRISTINE draft, so any branch gated on isDirty
// (e.g. `isDirty && !isLocked && Save`) is dark. isDirty is owned by
// LTP_useUnsavedGuard and only flips on an edit, which a static render never
// performs — so these vary the INPUT DATA instead, to light up the status,
// payment and QuickBooks branches that a refactor is most likely to disturb.
const PAID = Object.assign({}, INVOICE, { status: "paid", sentDate: "2026-08-10",
  payments: [{ id: "pay1", amount: 2000, date: "2026-08-20", method: "check", reference: "CHK-1" }] });
const PARTIAL = Object.assign({}, INVOICE, { status: "sent", sentDate: "2026-08-10",
  payments: [{ id: "pay1", amount: 100, date: "2026-08-20", method: "ach", reference: "" }] });
const OVERDUE = Object.assign({}, INVOICE, { status: "sent", sentDate: "2026-07-01", dueDate: "2026-07-15" });
const QBO_PUSHED = Object.assign({}, INVOICE, { status: "sent", sentDate: "2026-08-10",
  qbInvoiceId: "QB-99", qbSyncedSignature: "stale" });
[["paid", PAID], ["partially paid", PARTIAL], ["overdue", OVERDUE], ["pushed to QuickBooks", QBO_PUSHED]]
  .forEach(function (pair) {
    out.push(render(window.InvoicesView,
      Object.assign({ route: { id: 7, action: null } }, INV_PROPS, { invoices: [pair[1]],
        qbo: pair[0] === "pushed to QuickBooks" ? { connected: true, realmId: "r1" } : { connected: false } }),
      "\n== InvoiceBuilder (" + pair[0] + ") =="));
  });

const ACCEPTED = Object.assign({}, QUOTE, { status: "accepted", sentDate: "2026-08-10", acceptedDate: "2026-08-12" });
const EXPIRED = Object.assign({}, QUOTE, { status: "sent", sentDate: "2026-06-01", expiryDate: "2026-06-30" });
const DECLINED = Object.assign({}, QUOTE, { status: "declined", sentDate: "2026-08-10" });
[["accepted", ACCEPTED], ["expired", EXPIRED], ["declined", DECLINED]].forEach(function (pair) {
  out.push(render(window.QuotesBuilder, Object.assign({
    quoteId: 1, isNew: false, quotes: [pair[1]], setQuotes: function () {},
    getNextQuoteId: function () { return 2; }, invoices: [], setInvoices: function () {},
    getNextInvoiceId: function () { return 1; },
  }, COMMON), "\n== QuotesBuilder (" + pair[0] + ") =="));
});

// Three clock reads reach the tree and differ between two runs of the SAME
// code, so they are normalized rather than compared: an id minted from
// Date.now() inside a nested module, the "HH:MM" stamped onto activity
// entries, and the "8:35 PM" rendered into activity lines. Verified by
// diffing two unmutated runs a minute apart — nothing else moved.
const text = out.join("\n")
  .replace(/-1[0-9]{12}-/g, "-<EPOCH>-")
  .replace(/"time":"\d{1,2}:\d{2}"/g, '"time":"<CLOCK>"')
  .replace(/\b\d{1,2}:\d{2}\s?(AM|PM)\b/g, "<CLOCK>");

// ── Compare against the golden ─────────────────────────────────────────────
const GOLDEN = path.join(ROOT, "tests", "fixtures", "builder-render.snap.txt");
const threw = (text.match(/THREW/g) || []).length;

if (process.argv.includes("--update")) {
  if (threw) {
    console.log("REFUSING to update: " + threw + " render(s) threw. Fix them first.");
    process.exit(1);
  }
  fs.writeFileSync(GOLDEN, text + "\n");
  console.log("builder-render golden updated (" + text.split("\n").length + " lines, "
    + out.length + " scenarios)");
  process.exit(0);
}

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }

ok("every scenario rendered without throwing", threw === 0,
   (text.match(/^.*THREW.*$/gm) || []).slice(0, 3).join(" | "));
ok("all " + out.length + " scenarios produced output", out.length === 14, "got " + out.length);

if (!fs.existsSync(GOLDEN)) {
  ok("golden snapshot exists", false, "run with --update to create it");
} else {
  const golden = fs.readFileSync(GOLDEN, "utf8").replace(/\n$/, "");
  if (golden === text) {
    ok("render trees match the golden snapshot", true);
  } else {
    const g = golden.split("\n"), t = text.split("\n");
    const diffs = [];
    for (let i = 0; i < Math.max(g.length, t.length) && diffs.length < 6; i++) {
      if (g[i] !== t[i]) {
        diffs.push("line " + (i + 1) + ":\n    golden: " + String(g[i]).slice(0, 150)
                 + "\n    now   : " + String(t[i]).slice(0, 150));
      }
    }
    ok("render trees match the golden snapshot", false,
       (g.length !== t.length ? "(" + g.length + " -> " + t.length + " lines) " : "")
       + "first differences:\n  " + diffs.join("\n  ")
       + "\n  If this change is INTENDED, re-run with --update.");
  }
}

console.log("builder-render suite — PASS: " + pass + "   FAIL: " + fail
  + "   (" + out.length + " scenarios, " + text.split("\n").length + " tree lines)");
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " checks passed.");
