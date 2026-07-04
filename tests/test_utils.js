#!/usr/bin/env node
// Regression suite for theme.js utility/business helpers: URL safety, date/time
// formatting, templates, addresses, badge colors, legacy labor helpers, and the
// crew conflict/removal logic. Pure Node, zero deps.
//   Run:  node tests/test_utils.js
"use strict";
const fs = require("fs");
const path = require("path");
global.window = {};
let _seq = 0;
window.LTP_genId = (p) => (p || "x") + "-" + (++_seq);
(0, eval)(fs.readFileSync(path.join(__dirname, "..", "theme.js"), "utf8"));

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, g, e) { ok(n, g === e, "got " + JSON.stringify(g) + " exp " + JSON.stringify(e)); }

// ── safeUrl (security: block script-y schemes) ───────────────────────────────
const U = window.LTP_safeUrl;
eq("U1 https allowed", U("https://luminary.example/x"), "https://luminary.example/x");
eq("U2 http allowed", U("http://a.b"), "http://a.b");
eq("U3 mailto allowed", U("mailto:a@b.com"), "mailto:a@b.com");
eq("U4 tel allowed", U("tel:+15550000"), "tel:+15550000");
eq("U5 javascript blocked", U("javascript:alert(1)"), "");
eq("U6 JavaScript case-insensitive blocked", U("JavaScript:alert(1)"), "");
eq("U7 data blocked", U("data:text/html,<script>"), "");
eq("U8 vbscript blocked", U("vbscript:msgbox"), "");
eq("U9 relative path allowed", U("/quotes/3"), "/quotes/3");
eq("U10 hash allowed", U("#/view/abc"), "#/view/abc");
eq("U11 empty -> empty", U(""), "");
eq("U12 embedded control char in scheme stripped then blocked", U("java\tscript:alert(1)"), "");
eq("U13 leading whitespace trimmed then blocked", U("   javascript:alert(1)"), "");

// ── scheduleRowHasContent ────────────────────────────────────────────────────
const HC = window.LTP_scheduleRowHasContent;
eq("R1 empty row -> false", HC({}), false);
eq("R2 null -> false", HC(null), false);
eq("R3 only time -> true", HC({ time: "09:00" }), true);
eq("R4 only title -> true", HC({ title: "Load-In" }), true);
eq("R5 positions -> true", HC({ positions: [{ id: "p" }] }), true);
eq("R6 empty arrays -> false", HC({ positions: [], breaks: [] }), false);

// ── normalizeScheduleRows (repair hidden endDate before validate/save) ──────
const NR = window.LTP_normalizeScheduleRows;
eq("N1 stale endDate before date snaps to date",
   NR([{ date: "2026-08-14", endDate: "2026-08-10" }])[0].endDate, "2026-08-14");
eq("N2 half-typed garbage endDate snaps to date",
   NR([{ date: "2026-08-14", endDate: "0002-08-14" }])[0].endDate, "2026-08-14");
eq("N3 missing endDate filled with date",
   NR([{ date: "2026-08-14", endDate: "" }])[0].endDate, "2026-08-14");
eq("N4 multi-day span preserved",
   NR([{ date: "2026-08-14", endDate: "2026-08-16" }])[0].endDate, "2026-08-16");
eq("N5 same-day endDate untouched",
   NR([{ date: "2026-08-14", endDate: "2026-08-14" }])[0].endDate, "2026-08-14");
eq("N6 dateless row clears endDate",
   NR([{ date: "", endDate: "0002-08-14" }])[0].endDate, "");
eq("N7 dateless row without endDate returned as-is",
   NR([{ date: "", endDate: "" }])[0].endDate, "");
ok("N8 null/empty input tolerated", Array.isArray(NR(null)) && NR([]).length === 0);
ok("N9 does not mutate the input row", (function() {
  var row = { date: "2026-08-14", endDate: "2026-08-10" };
  NR([row]);
  return row.endDate === "2026-08-10";
})());

// ── formatAddress ────────────────────────────────────────────────────────────
const A = window.LTP_formatAddress;
eq("AD1 full address", A({ address: "123 Main", city: "Austin", state: "TX", zip: "78701" }), "123 Main, Austin, TX 78701");
eq("AD2 city + state only", A({ city: "Austin", state: "TX" }), "Austin, TX");
eq("AD3 empty", A(null), "");
eq("AD4 multiline street collapsed", A({ address: "Line1\nLine2", city: "X" }), "Line1, Line2, X");

// ── formatDate (ordinals) ────────────────────────────────────────────────────
const FD = window.LTP_formatDate;
eq("D1 1st", FD("2026-04-01"), "April 1st, 2026");
eq("D2 2nd", FD("2026-04-02"), "April 2nd, 2026");
eq("D3 3rd", FD("2026-04-03"), "April 3rd, 2026");
eq("D4 4th", FD("2026-04-04"), "April 4th, 2026");
eq("D5 11th", FD("2026-04-11"), "April 11th, 2026");
eq("D6 21st", FD("2026-04-21"), "April 21st, 2026");
eq("D7 22nd", FD("2026-04-22"), "April 22nd, 2026");
eq("D8 23rd", FD("2026-04-23"), "April 23rd, 2026");
eq("D9 31st", FD("2026-12-31"), "December 31st, 2026");
eq("D10 empty -> empty", FD(""), "");
eq("D11 no-dash passthrough", FD("20260422"), "20260422");

// ── calcDuration / formatTime / calcHours ────────────────────────────────────
const DUR = window.LTP_calcDuration, FT = window.LTP_formatTime, CH = window.LTP_calcHours;
eq("T1 8h30m", DUR("2026-01-01", "09:00", "2026-01-01", "17:30"), "8h 30m");
eq("T2 exact hours", DUR("2026-01-01", "09:00", "2026-01-01", "12:00"), "3h");
eq("T3 zero/negative -> empty", DUR("2026-01-01", "12:00", "2026-01-01", "12:00"), "");
eq("T4 formatTime PM", FT("14:00"), "2:00 PM");
eq("T5 formatTime AM", FT("08:30"), "8:30 AM");
eq("T6 formatTime midnight", FT("00:15"), "12:15 AM");
eq("T7 formatTime noon", FT("12:00"), "12:00 PM");
eq("T8 calcHours 8", CH("09:00", "17:00"), 8);
eq("T9 calcHours overnight", CH("20:00", "04:00"), 8);
eq("T10 calcHours missing -> 0", CH("", "17:00"), 0);

// ── resolveTemplate ──────────────────────────────────────────────────────────
const TPL = window.LTP_resolveTemplate;
eq("TP1 substitution", TPL("Hi {{name}}, ref {{ref}}", { name: "Sam", ref: "Q-1" }), "Hi Sam, ref Q-1");
eq("TP2 missing var kept literal", TPL("Hi {{name}}", {}), "Hi {{name}}");
eq("TP3 empty template", TPL("", { a: 1 }), "");

// ── badgeFromHex ─────────────────────────────────────────────────────────────
const BH = window.LTP_badgeFromHex;
let b = BH("#E8731A");
eq("B1 text is hex", b.text, "#E8731A");
eq("B2 bg rgba", b.bg, "rgba(232,115,26,0.12)");
eq("B3 bd rgba", b.bd, "rgba(232,115,26,0.35)");
eq("B4 default when empty", BH("").text, "#666666");

// ── legacy labor helpers ─────────────────────────────────────────────────────
const LR = window.LTP_calcLaborRate, LTier = window.LTP_calcLaborTier;
eq("L1 half day", LR(1000, 4), 500);
eq("L2 full day", LR(1000, 8), 1000);
eq("L3 full + OT", LR(1000, 12), 1300);
eq("L4 zero hours", LR(1000, 0), 0);
eq("L5 tier half", LTier(4), "Half day (4h)");
eq("L6 tier full", LTier(8), "Full day (8h)");
eq("L7 tier OT", LTier(12), "Full + 2h OT (12h)");
eq("L8 tier zero", LTier(0), "");

// ── removalTemplate ──────────────────────────────────────────────────────────
const RT = window.LTP_removalTemplate;
eq("RT1 confirmed -> cancelled", RT("confirmed"), "crewCancelled");
eq("RT2 accepted -> notSelected", RT("accepted"), "crewNotSelected");
eq("RT3 requested -> withdrawn", RT("requested"), "crewWithdrawn");
eq("RT4 other -> withdrawn", RT("open"), "crewWithdrawn");

// ── shiftSnapshots ───────────────────────────────────────────────────────────
const SNAP = window.LTP_shiftSnapshots;
const sched = [{ title: "Load-In", date: "2026-07-01", time: "09:00", endTime: "14:00", positions: [{ id: "p1", serviceId: 1, status: "confirmed" }, { id: "p2", serviceId: 1, status: "open" }] }];
const svcs = [{ id: 1, role: "L1", description: "Lead Lighting", department: "Lighting" }];
let snaps = SNAP(sched, ["p1"], svcs);
eq("SN1 one snapshot", snaps.length, 1);
eq("SN2 roleLabel", snaps[0].roleLabel, "L1 — Lead Lighting");
eq("SN3 department", snaps[0].department, "Lighting");
eq("SN4 times", snaps[0].startTime + "-" + snaps[0].endTime, "09:00-14:00");

// ── diffRemovedCrew ──────────────────────────────────────────────────────────
const DIFF = window.LTP_diffRemovedCrew;
const contacts = [{ id: 5, firstName: "Alex", lastName: "Crew" }];
const beforeS = [{ title: "Day", date: "2026-07-01", positions: [{ id: "p1", crewId: 5, status: "confirmed", serviceId: 1 }] }];
let g = DIFF(beforeS, [{ positions: [] }], contacts, svcs);
eq("DF1 removed -> 1 group", g.length, 1);
eq("DF2 template cancelled", g[0] && g[0].template, "crewCancelled");
eq("DF3 crewName", g[0] && g[0].crewName, "Alex Crew");
g = DIFF(beforeS, [{ positions: [{ id: "p1", crewId: 6, status: "confirmed" }] }], contacts, svcs);
eq("DF4 reassigned away -> removal for 5", g.length === 1 && g[0].crewId, 5);
g = DIFF(beforeS, [{ positions: [{ id: "p1", crewId: 5, status: "confirmed" }] }], contacts, svcs);
eq("DF5 still theirs -> no removal", g.length, 0);
g = DIFF([{ positions: [{ id: "p1", crewId: 5, status: "open" }] }], [{ positions: [] }], contacts, svcs);
eq("DF6 non-active status ignored", g.length, 0);

// ── detectCrewConflicts ──────────────────────────────────────────────────────
const DCC = window.LTP_detectCrewConflicts;
let conf = DCC([
  { id: 1, name: "P1", schedule: [{ id: "s1", date: "2026-07-01", title: "t", positions: [{ id: "pa", crewId: 5, status: "confirmed", serviceId: 1 }] }] },
  { id: 2, name: "P2", schedule: [{ id: "s2", date: "2026-07-01", title: "t", positions: [{ id: "pb", crewId: 5, status: "confirmed", serviceId: 1 }] }] },
]);
ok("CC1 cross-project conflict both posIds", conf.pa && conf.pb && conf.pa.length === 1 && conf.pb.length === 1);
conf = DCC([{ id: 1, name: "P1", schedule: [{ id: "s1", date: "2026-07-01", positions: [{ id: "pa", crewId: 5, status: "confirmed", serviceId: 1 }, { id: "pb", crewId: 5, status: "confirmed", serviceId: 2 }] }] }]);
ok("CC2 same-project two roles -> conflict", !!conf.pa && !!conf.pb);
conf = DCC([{ id: 1, name: "P1", schedule: [{ id: "s1", date: "2026-07-01", positions: [{ id: "pa", crewId: 5, status: "confirmed", serviceId: 1 }, { id: "pb", crewId: 5, status: "confirmed", serviceId: 1 }] }] }]);
eq("CC3 same role twice -> no conflict", Object.keys(conf).length, 0);
conf = DCC([
  { id: 1, name: "P1", schedule: [{ id: "s1", date: "2026-07-01", positions: [{ id: "pa", crewId: 5, status: "declined", serviceId: 1 }] }] },
  { id: 2, name: "P2", schedule: [{ id: "s2", date: "2026-07-01", positions: [{ id: "pb", crewId: 5, status: "confirmed", serviceId: 1 }] }] },
]);
eq("CC4 declined ignored -> no conflict", Object.keys(conf).length, 0);

console.log("utils suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
