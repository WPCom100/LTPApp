#!/usr/bin/env node
// Coverage for window.LTPDateField / window.LTPTimeField (components/ui.js) —
// the deferred-commit <input type="date"> and <input type="time"> the schedule
// editor uses for a shift's date, its start/end times and its break times.
//
// The bug this guards: a native date/time input fires a change on EVERY segment
// keystroke, and the in-between values are garbage — an incomplete value reads
// as "", a half-typed year reads as "0002-08-14", and a half-typed hour reads
// as "01:00" on the way to "11:00". The schedule editor groups its rows by day
// AND sorts the rows within a day by start time, so publishing those
// intermediates re-shuffled the list mid-edit: the row jumped to "Unscheduled"
// or past its neighbours, the input moved (or was torn down) under the caret,
// and the field deselected after a single digit. Typing a date or a time
// through was impossible and arrow-key nudges moved the row on every press.
//
// The rules held here:
//   * a keyboard-driven change (digits, arrows, backspace) is BUFFERED — the
//     field shows it, the parent never sees it
//   * blur / Enter publish the buffered value, exactly once
//   * a calendar-popup pick (a change with no keystroke behind it) publishes
//     immediately, so the picker still feels instant
//   * Escape drops the buffer and restores the committed value
//   * a commit that doesn't change the value doesn't call onChange at all
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
// dispatchers below read a module-level "currently rendering" context that the
// host installs. Enough to drive one component through a render loop.
let CTX = null;
global.React = {
  createElement: function (type, props) { return { type: type, props: props || {} }; },
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

// Host: renders the component, keeps its hook state across re-renders, and
// exposes the rendered <input> props so a test can fire its handlers.
function mount(initialValue, Component) {
  const Field = Component || DateField;
  const published = [];
  let props = { value: initialValue, onChange: function (v) { published.push(v); } };
  const ctx = { hooks: [], idx: 0, render: null };
  let el = null;
  ctx.render = function () {
    const prev = CTX; CTX = ctx; ctx.idx = 0;
    try { el = Field(props); } finally { CTX = prev; }
  };
  ctx.render();
  return {
    published: published,
    shown: function () { return el.props.value; },
    setValue: function (v) { props = Object.assign({}, props, { value: v }); ctx.render(); },
    key: function (k) { el.props.onKeyDown({ key: k, target: { value: el.props.value } }); },
    change: function (v) { el.props.onChange({ target: { value: v } }); },
    blur: function () { el.props.onBlur({ target: { value: el.props.value } }); },
    el: function () { return el; },
  };
}

// ── It renders a real date input ───────────────────────────────────────────
{
  const f = mount("2026-08-14");
  eq("renders an <input type=date>", [f.el().type, f.el().props.type], ["input", "date"]);
  eq("shows the committed value", f.shown(), "2026-08-14");
}

// A null/undefined value renders as "" — a controlled input must never go
// uncontrolled mid-edit.
{
  const f = mount(undefined);
  eq("undefined value renders empty", f.shown(), "");
}

// ── Typing a year digit-by-digit publishes nothing until blur ──────────────
// The exact sequence a browser produces while the year segment is retyped:
// each keystroke leaves the date incomplete ("") until the 4th digit lands.
{
  const f = mount("2026-08-14");
  ["1", "9", "9"].forEach(function (d) { f.key(d); f.change(""); });
  eq("incomplete dates are not published", f.published, []);
  ok("the empty intermediate is still shown", f.shown() === "");
  f.key("9"); f.change("1999-08-14");
  eq("the complete typed date is still buffered", f.published, []);
  eq("the buffered date is what the field shows", f.shown(), "1999-08-14");
  f.blur();
  eq("blur publishes once, with the final value", f.published, ["1999-08-14"]);
}

// A half-typed YEAR (the "0002-08-14" case) is a *valid* date string, so only
// the buffering keeps it out of the parent — worth its own assertion.
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

// ── Arrow-key nudges buffer too ────────────────────────────────────────────
// "any adjustment moves the row after a single key input" — stepping a segment
// must not re-sort the day list under the user mid-adjustment.
{
  const f = mount("2026-08-14");
  f.key("ArrowUp"); f.change("2026-08-15");
  f.key("ArrowUp"); f.change("2026-08-16");
  eq("arrow steps are buffered", f.published, []);
  eq("the field tracks each step", f.shown(), "2026-08-16");
  f.blur();
  eq("blur publishes the settled value once", f.published, ["2026-08-16"]);
}

// ── Enter commits without waiting for blur ─────────────────────────────────
{
  const f = mount("2026-08-14");
  f.key("ArrowDown"); f.change("2026-08-13");
  f.key("Enter");
  eq("Enter publishes", f.published, ["2026-08-13"]);
  f.blur();
  eq("the following blur is a no-op", f.published, ["2026-08-13"]);
}

// ── Escape abandons the edit ───────────────────────────────────────────────
{
  const f = mount("2026-08-14");
  f.key("ArrowUp"); f.change("2026-08-15");
  f.key("Escape");
  eq("Escape publishes nothing", f.published, []);
  eq("Escape restores the committed value", f.shown(), "2026-08-14");
  f.blur();
  eq("blur after Escape publishes nothing", f.published, []);
}

// ── A calendar-popup pick publishes immediately ────────────────────────────
// No keystroke precedes it, so there is nothing to buffer — the row is free to
// move because the user is done.
{
  const f = mount("2026-08-14");
  f.change("2026-09-01");
  eq("picker pick publishes right away", f.published, ["2026-09-01"]);
  // ...and does not re-publish on the blur that follows the popup closing.
  f.setValue("2026-09-01");
  f.blur();
  eq("no duplicate publish on blur", f.published, ["2026-09-01"]);
}

// ── Clearing the field ─────────────────────────────────────────────────────
// Backspacing a date away is a real edit (the schedule editor reads "" as
// unscheduled), so it publishes — on blur, like any other typed change.
{
  const f = mount("2026-08-14");
  f.key("Backspace"); f.change("");
  eq("clearing is buffered while typing", f.published, []);
  f.blur();
  eq("clearing publishes on blur", f.published, [""]);
}

// ── A no-op edit never reaches the parent ──────────────────────────────────
// Focus/blur with nothing typed, and a round trip back to the original value,
// both stay silent — the schedule editor re-renders (and re-sorts) on every
// onChange, so a spurious publish is a visible jump.
{
  const f = mount("2026-08-14");
  f.blur();
  eq("bare blur publishes nothing", f.published, []);
  f.key("ArrowUp"); f.change("2026-08-15");
  f.key("ArrowDown"); f.change("2026-08-14");
  f.blur();
  eq("a value nudged back to where it started publishes nothing", f.published, []);
}

// ── Tab does not arm the buffer ────────────────────────────────────────────
// Tab only moves between segments; a change that arrives without an editing
// keystroke behind it is still treated as a pick.
{
  const f = mount("2026-08-14");
  f.key("Tab");
  f.change("2026-10-02");
  eq("Tab then a pick still publishes immediately", f.published, ["2026-10-02"]);
}

// ── The prop stays the source of truth once the edit is over ───────────────
// After a commit the parent may normalize/reject the value; the field must
// follow it rather than keep showing the local buffer.
{
  const f = mount("2026-08-14");
  f.key("ArrowUp"); f.change("2026-08-15");
  f.blur();
  f.setValue("2026-08-15");
  eq("field mirrors the accepted value", f.shown(), "2026-08-15");
  f.setValue("2026-12-25");   // parent-driven change (e.g. an undo)
  eq("field follows a parent-driven change", f.shown(), "2026-12-25");
}

// ── The time field follows the same rules ──────────────────────────────────
// Same component, so the commit machinery is already covered above; what
// matters here is that a TIME behaves the same way, since the schedule editor
// sorts the rows inside a day by start time and so re-shuffles on every
// intermediate value it is handed.
{
  const f = mount("08:00", TimeField);
  eq("renders an <input type=time>", [f.el().type, f.el().props.type], ["input", "time"]);
  // Typing "11:45" into an hh:mm field: the hour passes through "01" before it
  // reads "11", and "01:00" would sort this row ahead of an 05:00 neighbour.
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

// An emptied segment reads as "" — the value that sorts a row to the very top
// of its day. It must not escape mid-edit either.
{
  const f = mount("09:00", TimeField);
  f.key("Backspace"); f.change("");
  f.key("1"); f.change("01:00");
  f.key("0"); f.change("10:00");
  eq("the empty intermediate never reaches the parent", f.published, []);
  f.blur();
  eq("only the retyped time is published", f.published, ["10:00"]);
}

// The AM/PM segment is keyboard-driven too ("P" flips 08:00 → 20:00, which
// re-sorts the row past a 13:00 neighbour).
{
  const f = mount("08:00", TimeField);
  f.key("p"); f.change("20:00");
  eq("an AM/PM keystroke is buffered", f.published, []);
  f.key("Enter");
  eq("Enter publishes it", f.published, ["20:00"]);
}

// A clock-popup pick (a change with no keystroke behind it) still lands at once.
{
  const f = mount("08:00", TimeField);
  f.change("07:30");
  eq("popup pick publishes immediately", f.published, ["07:30"]);
}

// ── The schedule editor actually uses them ─────────────────────────────────
// A regression here would silently restore the raw date/time inputs and the
// focus-loss bug with them.
{
  const src = fs.readFileSync(path.join(root, "components/schedule-editor.js"), "utf8");
  ok("schedule editor renders LTPDateField for the shift date",
     /h\(window\.LTPDateField,\s*\{\s*value:\s*s\.date/.test(src));
  ok("shift start time uses LTPTimeField", /h\(window\.LTPTimeField,\s*\{\s*value:\s*s\.time/.test(src));
  ok("shift end time uses LTPTimeField", /h\(window\.LTPTimeField,\s*\{\s*value:\s*s\.endTime/.test(src));
  ok("break start time uses LTPTimeField", /h\(window\.LTPTimeField,\s*\{\s*value:\s*brk\.startTime/.test(src));
  ok("break end time uses LTPTimeField", /h\(window\.LTPTimeField,\s*\{\s*value:\s*brk\.endTime/.test(src));
  ok("no raw date input left", src.indexOf('type: "date"') === -1);
  ok("no raw time input left", src.indexOf('type: "time"') === -1);
}

console.log("\ndate/time-field suite — PASS: " + pass + "   FAIL: " + fail);
if (fail) { console.log("\nFailures:"); fails.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
