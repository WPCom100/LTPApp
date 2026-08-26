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

// ── projectHeadlineTotal (quotes supersede the preliminary budget) ──────────
const PH = window.LTP_projectHeadlineTotal;
const _proj = { id: 7, budget: { lighting: 1000, labor: 2000, rentals: 0, misc: 500 } };
const _q = (id, projectId, status, price) => ({
  id, projectId, status, createdDate: "2026-01-01",
  sections: [{ items: [{ type: "labor", qty: 1, unitPrice: price }] }],
});
eq("PH1 no quotes -> budget total", PH(_proj, []).total, 3500);
ok("PH2 no quotes -> quoted=false", PH(_proj, []).quoted === false);
eq("PH3 quotes supersede budget", PH(_proj, [_q(1, 7, "sent", 8000)]).total, 8000);
ok("PH4 quotes -> quoted=true, count", (function() {
  var r = PH(_proj, [_q(1, 7, "sent", 8000), _q(2, 7, "draft", 1500)]);
  return r.quoted === true && r.count === 2 && r.total === 9500;
})());
eq("PH5 declined quotes don't count", PH(_proj, [_q(1, 7, "declined", 8000)]).total, 3500);
eq("PH6 other projects' quotes don't count", PH(_proj, [_q(1, 8, "sent", 8000)]).total, 3500);
eq("PH7 mixed: declined excluded from sum", PH(_proj, [_q(1, 7, "sent", 8000), _q(2, 7, "declined", 999)]).total, 8000);
eq("PH8 missing budget -> 0", PH({ id: 9 }, []).total, 0);

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

// ── diffChangedShifts ────────────────────────────────────────────────────────
const DIFFC = window.LTP_diffChangedShifts;
const cBefore = [{ id: "s1", title: "Day", date: "2026-07-01", time: "09:00", endTime: "14:00", positions: [{ id: "p1", crewId: 5, status: "accepted", serviceId: 1 }] }];
const cAfter  = [{ id: "s1", title: "Day", date: "2026-07-01", time: "11:00", endTime: "16:00", positions: [{ id: "p1", crewId: 5, status: "accepted", serviceId: 1 }] }];
let cg = DIFFC(cBefore, cAfter, contacts, svcs);
eq("DC1 time change -> 1 group", cg.length, 1);
eq("DC2 template scheduleChanged", cg[0] && cg[0].template, "crewScheduleChanged");
eq("DC3 new startTime", cg[0] && cg[0].shifts[0].startTime, "11:00");
eq("DC4 prev startTime carried", cg[0] && cg[0].shifts[0].prevStartTime, "09:00");
eq("DC5 prev endTime carried", cg[0] && cg[0].shifts[0].prevEndTime, "14:00");
cg = DIFFC(cBefore, [{ id: "s1", date: "2026-07-02", time: "09:00", endTime: "14:00", positions: [{ id: "p1", crewId: 5, status: "confirmed", serviceId: 1 }] }], contacts, svcs);
eq("DC6 date change -> 1 group", cg.length, 1);
eq("DC7 prev date carried", cg[0] && cg[0].shifts[0].prevDate, "2026-07-01");
cg = DIFFC(cBefore, cBefore, contacts, svcs);
eq("DC8 no change -> 0", cg.length, 0);
cg = DIFFC([{ id: "s1", date: "2026-07-01", time: "09:00", endTime: "14:00", positions: [{ id: "p1", crewId: 5, status: "open", serviceId: 1 }] }],
           [{ id: "s1", date: "2026-07-01", time: "11:00", endTime: "16:00", positions: [{ id: "p1", crewId: 5, status: "open", serviceId: 1 }] }], contacts, svcs);
eq("DC9 non-committed status ignored", cg.length, 0);
cg = DIFFC(cBefore, [{ id: "s1", date: "2026-07-01", time: "11:00", endTime: "16:00", positions: [] }], contacts, svcs);
eq("DC10 removed position not a change (left to diffRemovedCrew)", cg.length, 0);
cg = DIFFC(cBefore, [{ id: "s1", date: "2026-07-01", time: "11:00", endTime: "16:00", positions: [{ id: "p1", crewId: 6, status: "accepted", serviceId: 1 }] }], contacts, svcs);
eq("DC11 reassigned away not a change", cg.length, 0);
cg = DIFFC(cBefore, [{ id: "s1", date: "", time: "09:00", endTime: "14:00", positions: [{ id: "p1", crewId: 5, status: "accepted", serviceId: 1 }] }], contacts, svcs);
eq("DC12 cleared date not a reschedule (withdrawn server-side)", cg.length, 0);

// ── detectCrewConflicts ──────────────────────────────────────────────────────
const DCC = window.LTP_detectCrewConflicts;
let conf = DCC([
  { id: 1, name: "P1", schedule: [{ id: "s1", date: "2026-07-01", title: "t", positions: [{ id: "pa", crewId: 5, status: "accepted", serviceId: 1 }] }] },
  { id: 2, name: "P2", schedule: [{ id: "s2", date: "2026-07-01", title: "t", positions: [{ id: "pb", crewId: 5, status: "requested", serviceId: 1 }] }] },
]);
ok("CC1 cross-project conflict both posIds", conf.pa && conf.pb && conf.pa.length === 1 && conf.pb.length === 1);
conf = DCC([{ id: 1, name: "P1", schedule: [{ id: "s1", date: "2026-07-01", positions: [{ id: "pa", crewId: 5, status: "accepted", serviceId: 1 }, { id: "pb", crewId: 5, status: "requested", serviceId: 2 }] }] }]);
ok("CC2 same-project two roles -> conflict, each lists the other", conf.pa && conf.pb && conf.pa.length === 1 && conf.pa[0].posId === "pb" && conf.pb.length === 1 && conf.pb[0].posId === "pa");
conf = DCC([{ id: 1, name: "P1", schedule: [{ id: "s1", date: "2026-07-01", positions: [{ id: "pa", crewId: 5, status: "requested", serviceId: 1 }, { id: "pb", crewId: 5, status: "requested", serviceId: 1 }] }] }]);
eq("CC3 same role twice -> no conflict", Object.keys(conf).length, 0);
conf = DCC([
  { id: 1, name: "P1", schedule: [{ id: "s1", date: "2026-07-01", positions: [{ id: "pa", crewId: 5, status: "declined", serviceId: 1 }] }] },
  { id: 2, name: "P2", schedule: [{ id: "s2", date: "2026-07-01", positions: [{ id: "pb", crewId: 5, status: "accepted", serviceId: 1 }] }] },
]);
eq("CC4 declined ignored -> no conflict", Object.keys(conf).length, 0);
// Confirmed = settled: the double-booking was accepted on purpose, so the
// confirmed side never flags. An unsettled side sharing the day still does —
// with the confirmed booking listed as its counterpart — until it settles too.
conf = DCC([
  { id: 1, name: "P1", schedule: [{ id: "s1", date: "2026-07-01", positions: [{ id: "pa", crewId: 5, status: "confirmed", serviceId: 1 }] }] },
  { id: 2, name: "P2", schedule: [{ id: "s2", date: "2026-07-01", positions: [{ id: "pb", crewId: 5, status: "confirmed", serviceId: 1 }] }] },
]);
eq("CC5 both confirmed -> purposeful, no conflict", Object.keys(conf).length, 0);
conf = DCC([
  { id: 1, name: "P1", schedule: [{ id: "s1", date: "2026-07-01", positions: [{ id: "pa", crewId: 5, status: "confirmed", serviceId: 1 }] }] },
  { id: 2, name: "P2", schedule: [{ id: "s2", date: "2026-07-01", positions: [{ id: "pb", crewId: 5, status: "accepted", serviceId: 1 }] }] },
]);
ok("CC6 half-confirmed -> only the unsettled side flags", !conf.pa && conf.pb && conf.pb.length === 1 && conf.pb[0].posId === "pa");
conf = DCC([{ id: 1, name: "P1", schedule: [{ id: "s1", date: "2026-07-01", positions: [{ id: "pa", crewId: 5, status: "confirmed", serviceId: 1 }, { id: "pb", crewId: 5, status: "requested", serviceId: 2 }] }] }]);
// The confirmed side isn't flagged, but it must STILL be listed as the
// counterpart on the unsettled side (empty array is truthy — assert the id).
ok("CC7 same-project vs confirmed -> unsettled side flags, keeps confirmed counterpart", !conf.pa && conf.pb && conf.pb.length === 1 && conf.pb[0].posId === "pa");

// ── product pricing variants ─────────────────────────────────────────────────
const PV = window.LTP_productVariants, FV = window.LTP_findProductVariant, VN = window.LTP_productVariantName;
const transport = { name: "Transportation", unitPrice: 0, cost: 0, variants: [
  { id: "v1", label: "Local Delivery", unitPrice: 150, cost: 60 },
  { id: "v2", label: "Per Mile", unitPrice: 2.5, cost: 1.1 },
  { id: 3, label: "  Client Goods  ", unitPrice: "200", cost: null },   // messy row: numeric id, padded label, string/absent numbers
  { id: "v4", label: "   ", unitPrice: 99 },                            // unlabeled → dropped
  null,                                                                 // junk → dropped
] };
eq("PV1 usable variants kept, junk dropped", PV(transport).length, 3);
eq("PV2 label trimmed", PV(transport)[2].label, "Client Goods");
eq("PV3 numeric id normalized to string", PV(transport)[2].id, "3");
eq("PV4 string price coerced", PV(transport)[2].unitPrice, 200);
eq("PV5 missing cost -> 0", PV(transport)[2].cost, 0);
eq("PV6 no variants field -> []", PV({ name: "Gaff Tape" }).length, 0);
eq("PV7 null product -> []", PV(null).length, 0);
eq("PV8 non-array variants tolerated", PV({ variants: "junk" }).length, 0);
eq("FV1 lookup by id", FV(transport, "v2").unitPrice, 2.5);
eq("FV2 numeric id arg matches", FV(transport, 3).label, "Client Goods");
eq("FV3 unknown id -> null", FV(transport, "nope"), null);
eq("FV4 empty id -> null (base price)", FV(transport, ""), null);
eq("FV5 null id -> null", FV(transport, null), null);
eq("FV6 unlabeled variant not findable", FV(transport, "v4"), null);
eq("VN1 name with variant", VN(transport, FV(transport, "v1")), "Transportation — Local Delivery");
eq("VN2 name without variant is base name", VN(transport, null), "Transportation");
eq("VN3 null product tolerated", VN(null, null), "");

// ── collectEmailFaults (Settings Error Log — email delivery faults) ──────────
const CEF = window.LTP_collectEmailFaults;
const _inv = [
  { id: 1, activity: [
    { id: "a1", type: "email_sent", date: "2026-07-15", time: "09:00", message: "Email sent to x" },
    { id: "a2", type: "email_failed", date: "2026-07-16", time: "10:00",
      message: "Email to richard@dcsymphony.org failed",
      changes: [{ cat: "Error", detail: "Gmail send failed (401): invalid_client" }, { cat: "To", detail: "richard@dcsymphony.org" }] },
  ] },
  { id: 2, activity: [
    { id: "a3", type: "email_failed", date: "2026-07-14", time: "08:00",
      message: "Payment receipt could not be sent — no valid client email on file",
      changes: [{ cat: "Reference", detail: "INV-2026-002" }] },
  ] },
];
const _qts = [
  { id: 5, createdDate: "2026-07-16", activity: [
    { id: "a4", type: "email_failed", date: "2026-07-16", time: "12:30", message: "Email to bob@acme.com failed",
      changes: [{ cat: "Error", detail: "Gmail send failed (502): rejected" }] },
  ] },
  { id: 6, activity: [{ id: "a5", type: "viewed", date: "2026-07-16", time: "13:00", message: "viewed" }] },
];
const _faults = CEF(_inv, _qts);
eq("CEF1 gathers only email_failed entries", _faults.length, 3);
eq("CEF2 newest first (quote 07/16 12:30)", _faults[0].message, "Email to bob@acme.com failed");
eq("CEF3 oldest last (invoice 07/14)", _faults[2].date, "2026-07-14");
eq("CEF4 invoice context uses INV ref", _faults[1].context, window.LTP_INVOICE_REF(_inv[0]));
eq("CEF5 quote context uses Q ref", _faults[0].context, window.LTP_QUOTE_REF(_qts[0]));
eq("CEF6 error detail extracted from changes", _faults[0].errorDetail, "Gmail send failed (502): rejected");
eq("CEF7 no Error change -> empty detail", _faults[2].errorDetail, "");
ok("CEF8 null inputs tolerated", Array.isArray(CEF(null, null)) && CEF(null, null).length === 0);
ok("CEF9 entities without activity tolerated", CEF([{ id: 9 }], [{ id: 8 }]).length === 0);
eq("CEF10 message falls back when absent",
   CEF([{ id: 1, activity: [{ type: "email_failed", date: "2026-01-01", time: "00:00" }] }], []).length === 1
     ? CEF([{ id: 1, activity: [{ type: "email_failed", date: "2026-01-01", time: "00:00" }] }], [])[0].message
     : "MISSING", "Email failed");

// ── collectQboFaults + generic collectActivityFaults ────────────────────────
const CQF = window.LTP_collectQboFaults;
const _qinv = [
  { id: 3, activity: [
    { id: "q1", type: "qbo_synced", date: "2026-07-16", time: "09:00", message: "Synced to QuickBooks" },
    { id: "q2", type: "qbo_sync_failed", date: "2026-07-16", time: "11:00", message: "QuickBooks sync failed",
      changes: [{ cat: "Error", detail: "Request has invalid or unsupported property" }] },
  ] },
];
const _qf = CQF(_qinv, []);
eq("CQF1 gathers only qbo_sync_failed", _qf.length, 1);
eq("CQF2 message present", _qf[0].message, "QuickBooks sync failed");
eq("CQF3 error detail extracted", _qf[0].errorDetail, "Request has invalid or unsupported property");
eq("CQF4 context is invoice ref", _qf[0].context, window.LTP_INVOICE_REF(_qinv[0]));
ok("CQF5 null inputs tolerated", Array.isArray(CQF(null, null)) && CQF(null, null).length === 0);
eq("CQF6 message fallback when absent",
   CQF([{ id: 1, activity: [{ type: "qbo_sync_failed", date: "2026-01-01", time: "00:00" }] }], [])[0].message,
   "QuickBooks sync failed");
eq("CQF7 email faults not mixed into qbo", CQF(_inv, _qts).length, 0);
// Generic collector filters strictly by activity type.
const GEN = window.LTP_collectActivityFaults;
eq("GEN1 filters email type", GEN(_inv, _qts, "email_failed").length, 3);
eq("GEN2 filters qbo type", GEN(_qinv, [], "qbo_sync_failed").length, 1);
eq("GEN3 unknown type -> none", GEN(_inv, _qts, "nope").length, 0);

// ── manual shift builder (one-off warehouse labor → internal project) ────────
const MS = window.LTP_manualShiftProject;
const _ms = MS({ id: 42, title: "  Warehouse Load-out  ", date: "2026-08-01", startTime: "07:00", endTime: "15:00",
  location: "500 Dock Rd", notes: "bring forklift cert",
  positions: [{ serviceId: 1, role: "L1", crewId: 5 }, { serviceId: 2, role: "GRIP", crewId: "" }, { serviceId: "", role: "" }] });
eq("MS1 id passthrough", _ms.id, 42);
eq("MS2 marked internal", _ms.internal, true);
eq("MS3 no company", _ms.companyId, null);
eq("MS4 category Labor (valid badge key)", _ms.category, "Labor");
eq("MS5 title trimmed -> name", _ms.name, "Warehouse Load-out");
eq("MS6 single dated schedule day", _ms.schedule.length, 1);
eq("MS7 day date == start/end date", _ms.schedule[0].date + "|" + _ms.schedule[0].endDate, "2026-08-01|2026-08-01");
eq("MS8 times carried", _ms.schedule[0].time + "-" + _ms.schedule[0].endTime, "07:00-15:00");
eq("MS9 shift title mirrors name", _ms.schedule[0].title, "Warehouse Load-out");
eq("MS10 location -> siteAddress", _ms.siteAddress, "500 Dock Rd");
eq("MS11 notes -> scheduleNotes", _ms.scheduleNotes, "bring forklift cert");
eq("MS12 roleless rows dropped (no serviceId)", _ms.schedule[0].positions.length, 2);
ok("MS13 positions start open + not-full-margin", _ms.schedule[0].positions.every((p) => p.status === "open" && p.fullMargin === false));
eq("MS14 assigned crew carried", _ms.schedule[0].positions[0].crewId, 5);
eq("MS15 unassigned crew -> null", _ms.schedule[0].positions[1].crewId, null);
ok("MS16 unique position ids", _ms.schedule[0].positions[0].id !== _ms.schedule[0].positions[1].id);
ok("MS17 showOnCalendar + no breaks", _ms.schedule[0].showOnCalendar === true && Array.isArray(_ms.schedule[0].breaks) && _ms.schedule[0].breaks.length === 0);
eq("MS18 empty title fallback", MS({ id: 1 }).name, "Manual Shift");
eq("MS19 no positions -> empty array", MS({ id: 1, positions: [] }).schedule[0].positions.length, 0);
ok("MS20 default times when omitted", (function () { var m = MS({ id: 2, date: "2026-08-01", positions: [{ serviceId: 1 }] }); return m.schedule[0].time === "08:00" && m.schedule[0].endTime === "18:00"; })());

// End-to-end: a confirmed position on a manual shift is payable — it flows into
// the pay pipeline exactly like a client-project shift (LTP_payoutRows sees it).
const _msPay = MS({ id: 99, title: "Prep Day", date: "2026-08-02", startTime: "08:00", endTime: "18:00",
  positions: [{ serviceId: 1, role: "L1", crewId: 5 }] });
_msPay.schedule[0].positions[0].status = "confirmed";   // producer confirmed the hire
const _payServices = [{ id: 1, role: "L1", dayRate: 1000, dayCost: 600, halfDay: 500, halfDayCost: 300 }];
const _payContacts = [{ id: 5, isCrew: true, firstName: "Alex", lastName: "Crew" }];
const _pr = window.LTP_payoutRows([_msPay], _payContacts, _payServices, "2026-08-01", "2026-08-31");
eq("MSP1 one payout group for the manual shift", _pr.groups.length, 1);
eq("MSP2 group is the assigned crew member", _pr.groups[0].crewId, 5);
eq("MSP3 one payable row", _pr.groups[0].rows.length, 1);
eq("MSP4 row names the manual shift", _pr.groups[0].rows[0].projectName, "Prep Day");
ok("MSP5 confirmed-but-unsigned day is a positive pending estimate", _pr.pendingCount === 1 && _pr.pendingTotal > 0);
ok("MSP6 open (unassigned/unconfirmed) shift yields no payout", window.LTP_payoutRows([_ms], _payContacts, _payServices, "2026-08-01", "2026-08-31").groups.length === 0);

// ── Pay periods (bi-weekly payroll cycles) ───────────────────────────────────
// Anchor matches the app default: Mon 2026-07-06 → Sun 2026-07-19, length 14.
const _ppA = "2026-07-06";
const PPI = window.LTP_payPeriodIndex, PPF = window.LTP_payPeriodForIndex, PPB = window.LTP_payPeriodBounds;
eq("PP1 anchor day is index 0", PPI(_ppA, 14, "2026-07-06"), 0);
eq("PP2 last day of period 0 (end inclusive)", PPI(_ppA, 14, "2026-07-19"), 0);
eq("PP3 first day of period 1", PPI(_ppA, 14, "2026-07-20"), 1);
eq("PP4 day before anchor is index -1", PPI(_ppA, 14, "2026-07-05"), -1);
eq("PP5 far-past date floors negative", PPI(_ppA, 14, "2026-01-01"), -14);
const _pp0 = PPF(_ppA, 14, 0);
ok("PP6 period 0 bounds", _pp0.start === "2026-07-06" && _pp0.end === "2026-07-19", JSON.stringify(_pp0));
const _pp1 = PPF(_ppA, 14, 1);
ok("PP7 period 1 bounds", _pp1.start === "2026-07-20" && _pp1.end === "2026-08-02", JSON.stringify(_pp1));
const _ppN1 = PPF(_ppA, 14, -1);
ok("PP8 period -1 bounds", _ppN1.start === "2026-06-22" && _ppN1.end === "2026-07-05", JSON.stringify(_ppN1));
const _ppMid = PPB(_ppA, 14, "2026-07-15");
ok("PP9 bounds contains its date", _ppMid.index === 0 && _ppMid.start === "2026-07-06" && _ppMid.end === "2026-07-19");
eq("PP10 pay day = end + 5 (the following Friday)", window.LTP_payPeriodPayDay("2026-07-19", 5), "2026-07-24");
eq("PP11 pay day offset 0 = end", window.LTP_payPeriodPayDay("2026-07-19", 0), "2026-07-19");
// Non-14 length still tiles cleanly.
eq("PP12 weekly length index", PPI(_ppA, 7, "2026-07-13"), 1);
const _ppW = PPF(_ppA, 7, 1);
ok("PP13 weekly period 1 bounds", _ppW.start === "2026-07-13" && _ppW.end === "2026-07-19", JSON.stringify(_ppW));
// Invalid/absent anchor → null (callers fall back to week/month presets).
eq("PP14 empty anchor -> null", PPI("", 14, "2026-07-19"), null);
eq("PP15 malformed date -> null", PPI(_ppA, 14, "not-a-date"), null);
eq("PP16 overflow-normalized anchor rejected", PPB("2026-02-31", 14, "2026-07-19"), null);
eq("PP17 invalid length falls back to 14", PPI(_ppA, 0, "2026-07-20"), 1);
// Month-boundary crossing stays exact (no DST/tz drift).
eq("PP18 crosses month end exactly", PPI(_ppA, 14, "2026-08-02"), 1);
eq("PP19 next period starts day after", PPI(_ppA, 14, "2026-08-03"), 2);
const _ppLabel = window.LTP_payPeriodLabel("2026-07-06", "2026-07-19");
ok("PP20 label reads both endpoints", /July 6th, 2026/.test(_ppLabel) && /July 19th, 2026/.test(_ppLabel), _ppLabel);

// ── gcalUrl (calendar links: back-compat + crew endTime/location/overnight) ──
const GC = window.LTP_gcalUrl;
// Back-compat: no endTime → one-hour block, hour clamped, always trailing &add=.
eq("GC1 legacy one-hour block",
  GC({ title: "Sync — LTP", date: "2026-07-03", time: "09:30", details: "d" }),
  "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Sync%20%E2%80%94%20LTP&dates=20260703T093000/20260703T103000&details=d&add=");
eq("GC2 legacy hour clamps at 23",
  GC({ title: "T", date: "2026-07-03", time: "23:15" }),
  "https://calendar.google.com/calendar/render?action=TEMPLATE&text=T&dates=20260703T231500/20260703T231500&add=");
eq("GC3 legacy attendees joined",
  GC({ title: "T", date: "2026-07-03", time: "10:00", attendees: ["a@b.com", "c@d.com"] }),
  "https://calendar.google.com/calendar/render?action=TEMPLATE&text=T&dates=20260703T100000/20260703T110000&add=a@b.com,c@d.com");
// Crew: explicit endTime is honored; location is appended.
const _g4 = GC({ title: "Gala — A1", date: "2026-07-03", time: "08:00", endTime: "17:00", location: "500 Main St" });
ok("GC4 endTime honored", /dates=20260703T080000\/20260703T170000/.test(_g4), _g4);
ok("GC5 location appended", /&location=500%20Main%20St/.test(_g4), _g4);
// Overnight (wrap earlier than call) rolls the end date one day.
ok("GC6 overnight rolls a day",
  /dates=20260703T180000\/20260704T020000/.test(GC({ title: "T", date: "2026-07-03", time: "18:00", endTime: "02:00" })), "overnight");
// Same-day wrap does NOT roll.
ok("GC7 equal times stay same day",
  /dates=20260703T080000\/20260703T080000/.test(GC({ title: "T", date: "2026-07-03", time: "08:00", endTime: "08:00" })), "no-roll");

// ── Note line items (spacing/newlines are content) ──────────────────────────
// Notes are typed into a textarea on quotes/invoices; the author's blank lines
// and indentation carry meaning (call times, indented sub-points). The old
// builders stored noteText.trim(), which ate a leading indent on line one.
const NT = window.LTP_noteText;
eq("NT1 interior newlines kept", NT("a\nb"), "a\nb");
eq("NT2 blank line kept", NT("a\n\nb"), "a\n\nb");
eq("NT3 leading indent kept", NT("    - load in"), "    - load in");
eq("NT4 interior space runs kept", NT("a  b   c"), "a  b   c");
eq("NT5 trailing whitespace dropped", NT("a\n\n  \n"), "a");
eq("NT6 trailing spaces on last line dropped", NT("a   "), "a");
eq("NT7 CRLF normalized", NT("a\r\nb"), "a\nb");
eq("NT8 lone CR normalized", NT("a\rb"), "a\nb");
eq("NT9 null is empty", NT(null), "");
eq("NT10 undefined is empty", NT(undefined), "");
eq("NT11 whitespace-only collapses to empty", NT("  \n\t \n"), "");

const NH = window.LTP_noteHasText;
ok("NH1 text has content", NH("hi") === true);
ok("NH2 whitespace-only has none", NH("  \n \t ") === false);
ok("NH3 empty has none", NH("") === false);
ok("NH4 null has none", NH(null) === false);
ok("NH5 indented text has content", NH("    x") === true);

// One-line digest for the change log: first line with content, collapsed.
const NS = window.LTP_noteSummary;
eq("NS1 first line wins", NS("first line\nsecond line"), "first line");
eq("NS2 leading blank lines skipped", NS("\n\n  real text"), "real text");
eq("NS3 interior runs collapsed for the digest", NS("a   b"), "a b");
eq("NS4 ellipsized past the limit", NS("abcdefghij", 5), "abcd…");
eq("NS5 exactly at the limit is untouched", NS("abcde", 5), "abcde");
eq("NS6 empty note digests to empty", NS(""), "");

// The display style is what carries the formatting into the DOM.
eq("NSTY1 pre-wrap", window.LTP_NOTE_TEXT_STYLE.whiteSpace, "pre-wrap");
ok("NSTY2 long tokens can break", !!window.LTP_NOTE_TEXT_STYLE.overflowWrap);

// ── Quote expiration (LTP_quoteExpiry / LTP_isQuoteExpired) ─────────────────
// The rule is duplicated in Python (backend/pdf_generator._quote_expiry) because
// the app, the PDF and the client's browser all render this deadline. If these
// two ever disagree, a client's copy says a different day than the producer's —
// so tests/test_quote_expiry.py holds the same table on the other side.
const QE = window.LTP_quoteExpiry, QX = window.LTP_isQuoteExpired;
window.LTP_DEFAULT_QUOTE_VALIDITY = 30;

eq("QE1 the quote's own date wins",
   QE({ expiryDate: "2026-11-05", sentDate: "2026-10-01" }), "2026-11-05");
eq("QE2 unset falls back to sentDate + validity",
   QE({ sentDate: "2026-10-01" }), "2026-10-31");
eq("QE3 an unsent draft previews off the asOf date",
   QE({ sentDate: null }, "2026-10-01"), "2026-10-31");
eq("QE4 sentDate beats asOf — the clock started when it went out",
   QE({ sentDate: "2026-09-01" }, "2026-10-01"), "2026-10-01");
eq("QE5 nothing to count from yields no date", QE({}), "");
eq("QE6 null quote tolerated", QE(null), "");
eq("QE7 a garbage date yields no date, not NaN", QE({ sentDate: "whenever" }), "");
eq("QE8 an explicit validity override wins over the global",
   QE({ sentDate: "2026-10-01" }, "", 45), "2026-11-15");

// The override is what the public client view passes (it loads without a
// session, so app.js never mirrored the workspace default onto window).
const VD = window.LTP_QUOTE_VALIDITY_DAYS;
eq("QV1 override used when given", VD(45), 45);
eq("QV2 numeric string accepted", VD("60"), 60);
eq("QV3 junk falls back to 30", VD("soon"), 30);
eq("QV4 zero falls back to 30", VD(0), 30);
eq("QV5 empty string falls through to the global", VD(""), 30);

// Only a SENT quote can be expired: a draft was never promised to anyone, and
// accepted / declined / converted are settled — an accepted quote does not
// un-accept itself because a date passed.
const past = "2000-01-01", future = "2999-01-01";
eq("QX1 a sent quote past its date is expired", QX({ status: "sent", expiryDate: past }), true);
eq("QX2 a sent quote inside its window is not", QX({ status: "sent", expiryDate: future }), false);
eq("QX3 a draft is never expired", QX({ status: "draft", expiryDate: past }), false);
eq("QX4 an accepted quote is never expired", QX({ status: "accepted", expiryDate: past }), false);
eq("QX5 a converted quote is never expired", QX({ status: "converted", expiryDate: past }), false);
eq("QX6 a declined quote is never expired", QX({ status: "declined", expiryDate: past }), false);
eq("QX7 a sent quote with nothing to count from is not expired", QX({ status: "sent" }), false);
eq("QX8 null tolerated", QX(null), false);
// The fallback path expires too — a legacy quote sent long ago with no date of
// its own is just as stale as one carrying an explicit date.
eq("QX9 the sentDate fallback can expire", QX({ status: "sent", sentDate: "2000-01-01" }), true);

console.log("utils suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
