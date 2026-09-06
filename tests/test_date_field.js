#!/usr/bin/env node
// Coverage for window.LTPDateField / window.LTPTimeField (components/ui.js).
//
// DATE — two controls behind one name:
//   * desktop: the app's own calendar — a text field (mm/dd/yyyy) plus a
//     popover month grid. The value is published on exactly three things: a
//     clicked day, Today, or Clear. Paging months never touches it. Typed text
//     is buffered and published on Enter/blur only when it parses; otherwise
//     the field reverts. Escape reverts. This replaced the browser's calendar,
//     whose popup rewrote the input's value as you paged months (an empty
//     field became the 1st of the month on show) — the deferred field read
//     that as a pick, the schedule editor re-sorted the row, and the popup
//     died before a day was chosen.
//   * phone (≤600px): the native <input type="date"> with the deferred-commit
//     rules below, because iOS's wheel is the right control there and the
//     picker-chip pattern stretches that input over a formatted chip.
//
// TIME (and the phone date): a native input fires a change on EVERY segment
// keystroke and the in-between values are garbage ("" for an incomplete date,
// "01:00" on the way to "11:00"). The schedule editor groups rows by day and
// sorts them by start time, so publishing those re-shuffled the list under the
// caret. The rules: keyboard-driven changes are BUFFERED; blur / Enter publish
// once; a popup pick (a change with no keystroke behind it) publishes at once;
// Escape restores the committed value; a no-op commit never calls onChange.
//
//   Run:  node tests/test_date_field.js
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

// ── Minimal React shim with real hook state ────────────────────────────────
// ui.js grabs React.createElement/useState/useRef at load time, so the
// dispatchers read a module-level "currently rendering" context the host
// installs. Elements keep their children so a test can walk the tree.
let CTX = null;
global.React = {
  createElement: function (type, props) { return { type: type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) }; },
  Fragment: "Fragment",
  useState: function (init) {
    const c = CTX, i = c.idx++;
    if (!(i in c.hooks)) c.hooks[i] = { v: typeof init === "function" ? init() : init };
    const slot = c.hooks[i];
    return [slot.v, function (nv) { slot.v = typeof nv === "function" ? nv(slot.v) : nv; c.render(); }];
  },
  useRef: function (init) {
    const c = CTX, i = c.idx++;
    if (!(i in c.hooks)) c.hooks[i] = { current: init };
    return c.hooks[i];
  },
  useMemo: function (f) { return f(); },
  useEffect: function () {},
};
global.window = { LTP_THEME: {}, LTP_STATUS_COLORS: {} };
global.document = undefined;

(0, eval)(fs.readFileSync(path.join(root, "components/ui.js"), "utf8"));

const DateField = window.LTPDateField;
const TimeField = window.LTPTimeField;
ok("LTPDateField is exported", typeof DateField === "function");
ok("LTPTimeField is exported", typeof TimeField === "function");
ok("they are distinct components", DateField !== TimeField);

// Expand nested function components inside one hook context (order is stable
// per render, which is all the shim needs).
function expand(el) {
  if (Array.isArray(el)) return el.map(expand);        // a .map() of children
  while (el && typeof el.type === "function") el = el.type(el.props);
  if (el && el.children) el.children = el.children.map(expand);
  return el;
}
function findAll(el, pred, out) {
  out = out || [];
  if (Array.isArray(el)) { el.forEach(function (c) { findAll(c, pred, out); }); return out; }
  if (!el || typeof el !== "object") return out;
  if (pred(el)) out.push(el);
  (el.children || []).forEach(function (c) { findAll(c, pred, out); });
  return out;
}
function find(el, pred) { return findAll(el, pred)[0] || null; }

// Host: renders the component, keeps hook state across re-renders, and hands
// back the live tree so a test can fire handlers on what is rendered NOW.
function mount(initialValue, Component, extra) {
  const Field = Component || DateField;
  const published = [];
  let props = Object.assign({ value: initialValue, onChange: function (v) { published.push(v); } }, extra || {});
  const ctx = { hooks: [], idx: 0, render: null };
  let el = null;
  ctx.render = function () {
    const prev = CTX; CTX = ctx; ctx.idx = 0;
    try { el = expand(Field(props)); } finally { CTX = prev; }
  };
  ctx.render();
  const input = function () { return find(el, function (n) { return n.type === "input"; }); };
  return {
    published: published,
    tree: function () { return el; },
    input: input,
    shown: function () { return input().props.value; },
    setValue: function (v) { props = Object.assign({}, props, { value: v }); ctx.render(); },
    key: function (k) { input().props.onKeyDown({ key: k, target: { value: input().props.value }, preventDefault: function () {} }); },
    change: function (v) { input().props.onChange({ target: { value: v } }); },
    blur: function () { input().props.onBlur({ target: { value: input().props.value } }); },
    click: function () { input().props.onClick(); },
    panel: function () { return find(el, function (n) { return n.props && n.props["data-ltp-cal"]; }); },
    month: function () { const m = find(el, function (n) { return n.props && n.props["data-cal-month"]; }); return m ? m.children[0] : null; },
    nav: function (label) { find(el, function (n) { return n.props && n.props["aria-label"] === label; }).props.onClick(); },
    days: function () { return findAll(el, function (n) { return n.props && n.props["data-day"]; }); },
    day: function (iso) { return find(el, function (n) { return n.props && n.props["data-day"] === iso; }); },
    pressDay: function (iso) { const d = find(el, function (n) { return n.props && n.props["data-day"] === iso; }); d.props.onClick(); },
    foot: function (label) { find(el, function (n) { return n.type === "button" && n.children && n.children[0] === label; }).props.onClick(); },
  };
}
function localToday() { const n = new Date(); return window.LTP_isoFromParts(n.getFullYear(), n.getMonth(), n.getDate()); }

// ── Calendar arithmetic ────────────────────────────────────────────────────
eq("US format", window.LTP_formatDateUS("2026-09-05"), "09/05/2026");
eq("US format of nothing", window.LTP_formatDateUS(""), "");
eq("US format rejects an impossible day", window.LTP_formatDateUS("2026-02-30"), "");
eq("add days across a month end", window.LTP_isoAddDays("2026-08-30", 3), "2026-09-02");
eq("add days back across a year", window.LTP_isoAddDays("2026-01-01", -1), "2025-12-31");
eq("leap day holds", window.LTP_isoAddDays("2028-02-28", 1), "2028-02-29");
eq("parse m/d/yyyy", window.LTP_parseTypedDate("9/12/2026"), "2026-09-12");
eq("parse mm/dd/yyyy", window.LTP_parseTypedDate("09/12/2026"), "2026-09-12");
eq("parse two-digit year", window.LTP_parseTypedDate("9/12/26"), "2026-09-12");
eq("parse month/day alone uses the reference year", window.LTP_parseTypedDate("9/12", 2027), "2027-09-12");
eq("parse ISO", window.LTP_parseTypedDate("2026-09-12"), "2026-09-12");
eq("parse dashes and dots", [window.LTP_parseTypedDate("9-12-2026"), window.LTP_parseTypedDate("9.12.2026")], ["2026-09-12", "2026-09-12"]);
eq("parse tolerates whitespace", window.LTP_parseTypedDate("  9/12/2026 "), "2026-09-12");
eq("an emptied field is a clear", window.LTP_parseTypedDate(""), "");
eq("garbage is not a date", window.LTP_parseTypedDate("next tuesday"), null);
eq("month 13 is not a date", window.LTP_parseTypedDate("13/1/2026"), null);
eq("Feb 30 is not a date (not rolled)", window.LTP_parseTypedDate("2/30/2026"), null);
eq("a lone number is not a date", window.LTP_parseTypedDate("12"), null);
{
  const g = window.LTP_calendarGrid(2026, 8);   // September 2026 starts on a Tuesday
  eq("grid is 6 weeks", g.length, 42);
  eq("grid starts on the Sunday before the 1st", g[0].iso, "2026-08-30");
  eq("the 1st sits in the Tuesday column", g[2].iso + "|" + g[2].inMonth, "2026-09-01|true");
  eq("30 cells belong to the month", g.filter(function (c) { return c.inMonth; }).length, 30);
  eq("the tail is October", g[41].iso, "2026-10-10");
  eq("day numbers are the calendar day", g[2].day, 1);
}

// ── Desktop: the app's own calendar ────────────────────────────────────────
{
  const f = mount("2026-08-14");
  eq("desktop renders a text field, not a native date input", f.input().props.type, "text");
  eq("it shows the value as mm/dd/yyyy", f.shown(), "08/14/2026");
  ok("the calendar is closed until asked for", f.panel() === null);
  eq("undefined value shows empty", mount(undefined).shown(), "");
}

// Paging months moves nothing but the month on show. This is THE bug.
{
  const f = mount("");
  f.click();
  ok("a click opens the calendar", f.panel() !== null);
  const before = f.month();
  f.nav("Next month");
  ok("the month label advanced", f.month() !== before, f.month());
  f.nav("Next month"); f.nav("Previous month");
  eq("paging months publishes nothing", f.published, []);
  eq("the field still shows nothing", f.shown(), "");
  ok("the calendar stays open while paging", f.panel() !== null);
}

// A clicked day is the pick: published once, calendar closed.
{
  const f = mount("2026-08-14");
  f.click();
  eq("opens on the value's month", f.month(), "August 2026");
  eq("the value's day is marked selected", f.day("2026-08-14").props["aria-pressed"], "true");
  eq("42 day cells", f.days().length, 42);
  f.nav("Next month");
  eq("September on show", f.month(), "September 2026");
  f.pressDay("2026-09-03");
  eq("the clicked day is published", f.published, ["2026-09-03"]);
  ok("the calendar closed on the pick", f.panel() === null);
  f.setValue("2026-09-03");
  eq("the field shows the new value", f.shown(), "09/03/2026");
  f.blur();
  eq("the blur after a pick publishes nothing more", f.published, ["2026-09-03"]);
}

// A day from the neighbouring month is clickable too (the dimmed cells).
{
  const f = mount("2026-08-14");
  f.click();
  f.pressDay("2026-09-01");
  eq("a dimmed next-month day publishes", f.published, ["2026-09-01"]);
}

// Clicking the already-selected day is a no-op for the parent.
{
  const f = mount("2026-08-14");
  f.click(); f.pressDay("2026-08-14");
  eq("re-picking the value publishes nothing", f.published, []);
  ok("but still closes", f.panel() === null);
}

// Today / Clear.
{
  const f = mount("2026-08-14");
  f.click(); f.foot("Today");
  eq("Today publishes today's date", f.published, [localToday()]);
  const g = mount("2026-08-14");
  g.click(); g.foot("Clear");
  eq("Clear publishes an empty date", g.published, [""]);
  ok("Clear closes the calendar", g.panel() === null);
  const e = mount("");
  e.click(); e.foot("Clear");
  eq("Clear on an empty field publishes nothing", e.published, []);
}

// Typing: buffered until Enter or blur, then parsed.
{
  const f = mount("2026-08-14");
  f.change("9"); f.change("9/"); f.change("9/1"); f.change("9/1/"); f.change("9/1/2026");
  eq("typing publishes nothing", f.published, []);
  eq("the field shows the keystrokes", f.shown(), "9/1/2026");
  f.key("Enter");
  eq("Enter publishes the parsed date", f.published, ["2026-09-01"]);
  ok("Enter closes the calendar", f.panel() === null);
}
{
  const f = mount("2026-08-14");
  f.change("12/25/26");
  f.blur();
  eq("blur publishes a parseable draft", f.published, ["2026-12-25"]);
}
{
  const f = mount("2026-08-14");
  f.change("not a date");
  f.blur();
  eq("gibberish publishes nothing", f.published, []);
  eq("and the field reverts", f.shown(), "08/14/2026");
}
{
  const f = mount("2026-08-14");
  f.change("9/1/2026");
  f.key("Escape");
  eq("Escape publishes nothing", f.published, []);
  eq("Escape restores the committed value", f.shown(), "08/14/2026");
}
{
  const f = mount("2026-08-14");
  f.change("");
  f.blur();
  eq("emptying the text is a clear", f.published, [""]);
}
{
  const f = mount("2026-08-14");
  f.change("08/14/2026");
  f.blur();
  eq("retyping the same date publishes nothing", f.published, []);
}
{
  const f = mount("2026-08-14");
  f.click();
  f.change("2/30/2026");
  f.key("Enter");
  eq("an impossible day is rejected, not rolled", f.published, []);
  eq("the field reverts", f.shown(), "08/14/2026");
}

// Keyboard on the open calendar: the highlighted day moves, nothing publishes
// until Enter.
{
  const f = mount("2026-08-14");
  f.key("ArrowDown");
  ok("ArrowDown opens the calendar", f.panel() !== null);
  f.key("ArrowDown");   // +7
  f.key("ArrowRight");  // +1
  eq("moving the highlight publishes nothing", f.published, []);
  f.key("PageDown");
  eq("PageDown pages the month", f.month(), "September 2026");
  eq("still nothing published", f.published, []);
  f.key("Enter");
  eq("Enter picks the highlighted day", f.published, ["2026-08-22"]);
}
{
  const f = mount("2026-08-30");
  f.key("ArrowDown"); f.key("ArrowDown");   // +7 crosses into September
  eq("the highlight crossing a month end flips the month on show", f.month(), "September 2026");
  eq("no publish on the crossing", f.published, []);
}

// The prop stays the source of truth once the edit is over.
{
  const f = mount("2026-08-14");
  f.change("9/1/2026"); f.blur();
  f.setValue("2026-09-01");
  eq("field mirrors the accepted value", f.shown(), "09/01/2026");
  f.setValue("2026-12-25");
  eq("field follows a parent-driven change", f.shown(), "12/25/2026");
}

// A disabled field never opens.
{
  const f = mount("2026-08-14", null, { disabled: true });
  f.click();
  ok("disabled: no calendar", f.panel() === null);
}

// ── Phone: the native field, deferred commit ───────────────────────────────
window.matchMedia = function () { return { matches: true, addEventListener: function () {}, removeEventListener: function () {} }; };
{
  const f = mount("2026-08-14");
  eq("phone renders an <input type=date>", [f.input().type, f.input().props.type], ["input", "date"]);
  eq("shows the committed value", f.shown(), "2026-08-14");
  eq("undefined value renders empty", mount(undefined).shown(), "");
}
{
  const f = mount("2026-08-14");
  ["1", "9", "9"].forEach(function (d) { f.key(d); f.change(""); });
  eq("incomplete dates are not published", f.published, []);
  ok("the empty intermediate is still shown", f.shown() === "");
  f.key("9"); f.change("1999-08-14");
  eq("the complete typed date is still buffered", f.published, []);
  f.blur();
  eq("blur publishes once, with the final value", f.published, ["1999-08-14"]);
}
{
  const f = mount("2026-08-14");
  f.key("2"); f.change("0002-08-14");
  f.key("0"); f.change("0020-08-14");
  f.key("2"); f.change("0202-08-14");
  f.key("7"); f.change("2027-08-14");
  eq("no partial year escapes", f.published, []);
  f.blur();
  eq("only the finished year is published", f.published, ["2027-08-14"]);
}
{
  const f = mount("2026-08-14");
  f.key("ArrowUp"); f.change("2026-08-15");
  f.key("ArrowUp"); f.change("2026-08-16");
  eq("arrow steps are buffered", f.published, []);
  f.blur();
  eq("blur publishes the settled value once", f.published, ["2026-08-16"]);
}
{
  const f = mount("2026-08-14");
  f.key("ArrowDown"); f.change("2026-08-13");
  f.key("Enter");
  eq("Enter publishes", f.published, ["2026-08-13"]);
  f.blur();
  eq("the following blur is a no-op", f.published, ["2026-08-13"]);
}
{
  const f = mount("2026-08-14");
  f.key("ArrowUp"); f.change("2026-08-15");
  f.key("Escape");
  eq("Escape publishes nothing", f.published, []);
  eq("Escape restores the committed value", f.shown(), "2026-08-14");
}
{
  const f = mount("2026-08-14");
  f.change("2026-09-01");
  eq("wheel pick publishes right away", f.published, ["2026-09-01"]);
  f.setValue("2026-09-01");
  f.blur();
  eq("no duplicate publish on blur", f.published, ["2026-09-01"]);
}
{
  const f = mount("2026-08-14");
  f.key("Backspace"); f.change("");
  eq("clearing is buffered while typing", f.published, []);
  f.blur();
  eq("clearing publishes on blur", f.published, [""]);
}
{
  const f = mount("2026-08-14");
  f.blur();
  eq("bare blur publishes nothing", f.published, []);
  f.key("ArrowUp"); f.change("2026-08-15");
  f.key("ArrowDown"); f.change("2026-08-14");
  f.blur();
  eq("a value nudged back to where it started publishes nothing", f.published, []);
}
{
  const f = mount("2026-08-14");
  f.key("Tab");
  f.change("2026-10-02");
  eq("Tab then a pick still publishes immediately", f.published, ["2026-10-02"]);
}
{
  const f = mount("2026-08-14");
  f.key("ArrowUp"); f.change("2026-08-15");
  f.blur();
  f.setValue("2026-08-15");
  eq("field mirrors the accepted value", f.shown(), "2026-08-15");
  f.setValue("2026-12-25");
  eq("field follows a parent-driven change", f.shown(), "2026-12-25");
}
delete window.matchMedia;

// ── The time field: native, deferred commit, on every screen ───────────────
{
  const f = mount("08:00", TimeField);
  eq("renders an <input type=time>", [f.input().type, f.input().props.type], ["input", "time"]);
  f.key("1"); f.change("01:00");
  eq("the half-typed hour is not published", f.published, []);
  eq("but the field shows it", f.shown(), "01:00");
  f.key("1"); f.change("11:00");
  f.key("4"); f.change("11:04");
  f.key("5"); f.change("11:45");
  eq("nothing published while typing through", f.published, []);
  f.blur();
  eq("blur publishes the finished time once", f.published, ["11:45"]);
}
{
  const f = mount("09:00", TimeField);
  f.key("Backspace"); f.change("");
  f.key("1"); f.change("01:00");
  f.key("0"); f.change("10:00");
  eq("the empty intermediate never reaches the parent", f.published, []);
  f.blur();
  eq("only the retyped time is published", f.published, ["10:00"]);
}
{
  const f = mount("08:00", TimeField);
  f.key("p"); f.change("20:00");
  eq("an AM/PM keystroke is buffered", f.published, []);
  f.key("Enter");
  eq("Enter publishes it", f.published, ["20:00"]);
}
{
  const f = mount("08:00", TimeField);
  f.change("07:30");
  eq("popup pick publishes immediately", f.published, ["07:30"]);
}

// ── Every date in the app goes through the shared field ────────────────────
// A regression here would quietly bring back the browser calendar somewhere.
{
  const src = fs.readFileSync(path.join(root, "components/schedule-editor.js"), "utf8");
  ok("schedule editor renders LTPDateField for the shift date",
     /h\(window\.LTPDateField,\s*\{\s*value:\s*s\.date/.test(src));
  ok("shift start time uses LTPTimeField", /h\(window\.LTPTimeField,\s*\{\s*value:\s*s\.time/.test(src));
  ok("shift end time uses LTPTimeField", /h\(window\.LTPTimeField,\s*\{\s*value:\s*s\.endTime/.test(src));
  ok("break start time uses LTPTimeField", /h\(window\.LTPTimeField,\s*\{\s*value:\s*brk\.startTime/.test(src));
  ok("break end time uses LTPTimeField", /h\(window\.LTPTimeField,\s*\{\s*value:\s*brk\.endTime/.test(src));
  ok("no raw date input left in the schedule editor", src.indexOf('type: "date"') === -1);
  ok("no raw time input left in the schedule editor", src.indexOf('type: "time"') === -1);
  const ui = fs.readFileSync(path.join(root, "components/ui.js"), "utf8");
  ok("LTPInput routes type:\"date\" to LTPDateField", /type === "date" \? h\(window\.LTPDateField/.test(ui));
  const raw = [];
  ["modules", "components"].forEach(function (d) {
    fs.readdirSync(path.join(root, d)).filter(function (f) { return f.endsWith(".js") && !(d === "components" && f === "ui.js"); }).forEach(function (f) {
      const text = fs.readFileSync(path.join(root, d, f), "utf8");
      if (/h\("input",\s*\{[^}]*type:\s*"date"/.test(text)) raw.push(d + "/" + f);
    });
  });
  eq("no module renders its own <input type=date>", raw, []);
}

console.log("\ndate/time-field suite — PASS: " + pass + "   FAIL: " + fail);
if (fail) { console.log("\nFailures:"); fails.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
