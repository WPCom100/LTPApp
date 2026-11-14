#!/usr/bin/env node
// Crew call sheet (modules/crew-view.js): where the Accept / Decline pair lives.
//
// WHY THIS SUITE EXISTS
//   On a phone the sheet showed the pair twice — once in the action card under
//   the shifts and once in a bar fixed to the bottom of the screen. The card's
//   pair opened the note panel BELOW the fold (the bar vanished and the page
//   shifted at the same moment), so to a crew member it read as a dead button
//   beside one that worked. Now the phone has the bar only; the card keeps the
//   question and the note panel, and the bar scrolls the card into view.
//   Desktop keeps the in-card pair and has no bar.
//
// Pure Node, zero deps, under a small hook runner: state persists across
// renders, effects run once on mount (and again when their deps change), fetch
// is a stub that answers with the scenario's payload.
//   Run:  node tests/test_crew_view_mobile.js
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, got, want) { ok(n, JSON.stringify(got) === JSON.stringify(want), "got " + JSON.stringify(got) + " exp " + JSON.stringify(want)); }
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

// ── A minimal hook runtime ───────────────────────────────────────────────────
let CTX = null;
function depsChanged(a, b) {
  if (!a || !b) return true;
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
  return false;
}
global.React = {
  createElement: function (type, props) { return { type: type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) }; },
  useState: function (init) {
    const c = CTX, i = c.idx++;
    if (!(i in c.hooks)) c.hooks[i] = { v: typeof init === "function" ? init() : init };
    const slot = c.hooks[i];
    return [slot.v, function (nv) { slot.v = typeof nv === "function" ? nv(slot.v) : nv; }];
  },
  useEffect: function (fn, deps) {
    const c = CTX, i = c.idx++;
    if (!(i in c.hooks)) c.hooks[i] = { deps: undefined, ran: false };
    const slot = c.hooks[i];
    if (!slot.ran || depsChanged(slot.deps, deps)) { slot.deps = deps; slot.ran = true; c.pending.push(fn); }
  },
  useMemo: function (fn) { return fn(); },
  useRef: function (v) {
    const c = CTX, i = c.idx++;
    if (!(i in c.hooks)) c.hooks[i] = { current: v };
    return c.hooks[i];
  },
};
function mount(fn) {
  const ctx = { hooks: {}, idx: 0, pending: [], count: null };
  return function (props) {
    CTX = ctx; ctx.idx = 0; ctx.pending = [];
    let tree;
    try { tree = fn(props); } finally { CTX = null; }
    // React's rule: the same hooks, in the same order, on every render. A hook
    // placed after an early return runs on some passes and not others, which
    // the real React rejects (error #310) — so this runner does too.
    if (ctx.count !== null && ctx.count !== ctx.idx) throw new Error("hook count changed between renders: " + ctx.count + " -> " + ctx.idx);
    ctx.count = ctx.idx;
    ctx.pending.forEach((e) => { try { e(); } catch (err) { /* effects are best-effort here */ } });
    return tree;
  };
}
function walk(node, out) {
  out = out || [];
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if (!node || typeof node !== "object") return out;
  out.push(node);
  walk(node.children, out);
  return out;
}
function textOf(node) {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.children);
}
function buttons(tree, label) { return walk(tree).filter((n) => n.type === "button" && textOf(n) === label); }
function hasText(tree, text) { return textOf(tree).indexOf(text) !== -1; }
function fixedBars(tree) { return walk(tree).filter((n) => n.props && n.props.style && n.props.style.position === "fixed"); }
function textareas(tree) { return walk(tree).filter((n) => n.type === "textarea"); }
function actionCard(tree) { return walk(tree).find((n) => n.props && n.props.ref && typeof n.props.ref === "object"); }

// ── The browser around the page ──────────────────────────────────────────────
let MOBILE = false;
global.window = {
  matchMedia: function (q) { return { media: q, matches: MOBILE, addEventListener() {}, removeEventListener() {} }; },
  LTP_useDocFreshness: function () { return "fresh"; },
  addEventListener() {}, removeEventListener() {},
};
global.document = {
  getElementById() { return null; },
  createElement() { return { style: {}, setAttribute() {} }; },
  head: { appendChild() {} },
  body: { style: {} },
};
let PAYLOAD = null;
global.fetch = function () { return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(PAYLOAD), text: () => Promise.resolve("") }); };

(0, eval)(fs.readFileSync(path.join(ROOT, "modules", "crew-view.js"), "utf8"));
const CrewView = global.window.LTPCrewView;
ok("crew-view.js exposes window.LTPCrewView", typeof CrewView === "function");

function payload(overrides) {
  return Object.assign({
    status: "pending", crewName: "Jordan", comment: "", respondedAt: null, _v: "v1",
    project: { name: "Harbor Lights Gala", venue: "Pier 9", siteAddress: "", siteInstructions: "", startDate: "2026-11-20", endDate: "2026-11-22" },
    shifts: [
      { positionId: "p1", role: "A1", roleLabel: "A1", status: "requested", note: "", shiftTitle: "Load-in", date: "2026-11-20", startTime: "08:00", endTime: "18:00" },
      { positionId: "p2", role: "A1", roleLabel: "A1", status: "requested", note: "", shiftTitle: "Show", date: "2026-11-21", startTime: "10:00", endTime: "23:00" },
    ],
    settings: { companyName: "LTP", website: "" },
  }, overrides || {});
}

// Mount, let the fetch land, and render again with the data in hand. The
// action card's ref gets a stand-in element whose scrollIntoView calls are
// logged on this scenario's own list (a settle timer from one scenario must
// not leak into the next).
async function open(mobile, data) {
  MOBILE = mobile; PAYLOAD = data;
  const log = [];
  const render = mount(CrewView);
  const props = { route: { module: "crew", id: "tok-1" } };
  render(props);                       // loading pass: kicks off the fetch
  await settle();
  const tree = render(props);          // data in hand
  const card = actionCard(tree);
  if (card) card.props.ref.current = { scrollIntoView: function (o) { log.push(o || true); } };
  return { render: () => render(props), tree: tree, scrolled: log };
}

(async () => {
  // ── Phone, pending: the bar is the only pair ─────────────────────────────
  {
    const s = await open(true, payload());
    let t = s.tree;
    ok("M1 the page rendered the shifts", hasText(t, "HARBOR LIGHTS GALA") && hasText(t, "Load-in"));
    eq("M2 no in-card Accept on a phone", buttons(t, "Accept These Calls").length, 0);
    eq("M3 exactly one 'I Can't Make It' on a phone (the bar's)", buttons(t, "I Can't Make It").length, 1);
    eq("M4 exactly one 'Accept' on a phone (the bar's)", buttons(t, "Accept").length, 1);
    const bars = fixedBars(t);
    eq("M5 one fixed bar", bars.length, 1);
    ok("M6 the fixed bar holds both answers", buttons(bars[0], "Accept").length === 1 && buttons(bars[0], "I Can't Make It").length === 1);
    ok("M7 the card still asks the question", hasText(t, "Can you take these calls?"));
    ok("M8 …and points at the bar", hasText(t, "Answer with the buttons at the bottom of your screen."));
    eq("M9 no note panel before a choice (closed, not absent)", textareas(t).length, 1);
    const card = actionCard(t);
    ok("M10 the action card carries the scroll target ref", !!card);
    const reveal = walk(card).find((n) => n.props && n.props.style && "maxHeight" in n.props.style);
    eq("M11 the panel is collapsed", reveal.props.style.maxHeight, 0);

    // Tap Accept on the bar.
    buttons(bars[0], "Accept")[0].props.onClick();
    t = s.render();
    eq("M12 tapping the bar scrolls the card into view at once", s.scrolled.length, 1);
    eq("M13 …aligned to the card's top", s.scrolled[0] && s.scrolled[0].block, "start");
    await new Promise((r) => setTimeout(r, 400));
    eq("M13b …and again, minimally, once the panel has opened", s.scrolled.length, 2);
    eq("M13c the second pass is 'nearest' (no-op when already in view)", s.scrolled[1] && s.scrolled[1].block, "nearest");
    eq("M14 the bar is gone once a choice is made", fixedBars(t).length, 0);
    ok("M15 the note panel is open", walk(actionCard(t)).find((n) => n.props && n.props.style && "maxHeight" in n.props.style).props.style.maxHeight > 0);
    ok("M16 with the accept eyebrow", hasText(t, "Confirming — leave a note (optional)"));
    eq("M17 and a Confirm Accept button", buttons(t, "Confirm Accept").length, 1);
    eq("M18 still no in-card pair while the panel is open", buttons(t, "Accept These Calls").length + buttons(t, "I Can't Make It").length, 0);
    ok("M19 the hint steps aside while the panel is open", !hasText(t, "Answer with the buttons at the bottom of your screen."));

    // Back brings the bar straight back.
    buttons(t, "Back")[0].props.onClick();
    t = s.render();
    eq("M20 Back restores the bar", fixedBars(t).length, 1);
    ok("M21 …and the hint", hasText(t, "Answer with the buttons at the bottom of your screen."));
    eq("M22 the panel is collapsed again", walk(actionCard(t)).find((n) => n.props && n.props.style && "maxHeight" in n.props.style).props.style.maxHeight, 0);

    // Decline from the bar.
    buttons(fixedBars(t)[0], "I Can't Make It")[0].props.onClick();
    t = s.render();
    ok("M23 declining from the bar opens the decline panel", hasText(t, "Letting us know — what's the conflict? (optional)"));
    eq("M24 with a Confirm Decline button", buttons(t, "Confirm Decline").length, 1);
    eq("M25 the bar hides for the decline panel too", fixedBars(t).length, 0);
    await new Promise((r) => setTimeout(r, 400));
    eq("M26 the decline tap scrolls and settles the same way", s.scrolled.length, 4);
    eq("M27 …start, then nearest", s.scrolled.slice(2).map((o) => o.block), ["start", "nearest"]);
  }

  // ── Phone, flat-rate only: same bar, same labels ─────────────────────────
  {
    const flat = payload({ shifts: [{ positionId: "f1", role: "SM", roleLabel: "SM — Stage manager", status: "requested", note: "", shiftTitle: "", date: "", startTime: "", endTime: "", flat: true, fee: 1200, projectStart: "2026-11-20", projectEnd: "2026-11-22", projectDates: [{ date: "2026-11-20", title: "Load-in" }, { date: "2026-11-22", title: "Strike" }] }] });
    const s = await open(true, flat);
    const t = s.tree;
    eq("F1 no in-card 'Accept This Position' on a phone", buttons(t, "Accept This Position").length, 0);
    eq("F2 the bar still offers Accept", buttons(fixedBars(t)[0], "Accept").length, 1);
    ok("F3 the question names the position", hasText(t, "Can you take this position?"));
  }

  // ── Phone, already answered: nothing to answer, no bar ───────────────────
  {
    const s = await open(true, payload({ status: "accepted", respondedAt: "2026-11-14T10:00:00" }));
    const t = s.tree;
    eq("T1 no bar once answered", fixedBars(t).length, 0);
    eq("T2 no answer buttons at all", buttons(t, "Accept").length + buttons(t, "I Can't Make It").length + buttons(t, "Accept These Calls").length, 0);
    ok("T3 the accepted banner shows instead", hasText(t, "You've accepted these calls"));
  }

  // ── Desktop, pending: the in-card pair, no bar ───────────────────────────
  {
    const s = await open(false, payload());
    let t = s.tree;
    eq("D1 the in-card Accept is there", buttons(t, "Accept These Calls").length, 1);
    eq("D2 the in-card decline is there", buttons(t, "I Can't Make It").length, 1);
    eq("D3 no fixed bar on desktop", fixedBars(t).length, 0);
    eq("D4 no bare 'Accept' (that label is the bar's)", buttons(t, "Accept").length, 0);
    ok("D5 no phone hint on desktop", !hasText(t, "Answer with the buttons at the bottom of your screen."));
    const row = walk(actionCard(t)).find((n) => n.props && n.props.style && n.props.style.flexDirection === "row" && buttons(n, "Accept These Calls").length === 1);
    ok("D6 the pair sits in one row", !!row);

    buttons(t, "Accept These Calls")[0].props.onClick();
    t = s.render();
    await new Promise((r) => setTimeout(r, 400));
    eq("D7 the in-card Accept never scrolls the page, then or later", s.scrolled.length, 0);
    ok("D8 the note panel opens in place", hasText(t, "Confirming — leave a note (optional)"));
    eq("D9 the pair stays live to switch sides", buttons(t, "Accept These Calls").length + buttons(t, "I Can't Make It").length, 2);
    buttons(t, "I Can't Make It")[0].props.onClick();
    t = s.render();
    ok("D10 switching to decline in place", hasText(t, "Letting us know — what's the conflict? (optional)"));
  }

  // ── Breakpoint is one constant, used by state seed and listener alike ────
  {
    const src = fs.readFileSync(path.join(ROOT, "modules", "crew-view.js"), "utf8");
    eq("B1 the phone media query is written once", (src.match(/\(max-width:600px\)/g) || []).length, 1);
    ok("B2 isMobile is seeded from matchMedia, not assumed false", /useState\(function\(\) \{ return !!\(window\.matchMedia && window\.matchMedia\(MOBILE_MQ\)\.matches\); \}\)/.test(src));
  }

  console.log("crew-view mobile suite — PASS: " + pass + "   FAIL: " + fail);
  if (fail) { fails.forEach((f) => console.log("  FAIL " + f)); process.exit(1); }
  console.log("All " + pass + " assertions passed.");
})().catch((e) => { console.error(e); process.exit(1); });
