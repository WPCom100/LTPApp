#!/usr/bin/env node
// Regression suite for multi-project quotes/invoices and the schedule → quote /
// → invoice line builder in theme.js. Pure Node, zero deps.
//
// Covers:
//   * LTP_docProjectIds     — legacy rows, de-duplication, primary-first order
//   * LTP_linkDocProject    — adopting a project without renaming the primary
//   * LTP_docProjectNames   — deleted projects degrade instead of vanishing
//   * LTP_projectSectionLabel — project stamping, no double-stamping
//   * LTP_appendDocSections — append-only semantics + id-collision regeneration
//   * LTP_scheduleLaborSections — day-rate/OT aggregation, grouping, margin
//   * LTP_docHasProject     — contributor links count, not just the primary
//   * LTP_sharedDocNote     — the overlap warning on project money figures
//   * LTP_sectionDateStamp  — per-section rental window for another job's work
//
//   Run:  node tests/test_doc_projects.js
"use strict";
const fs = require("fs");
const path = require("path");
global.window = {};
let _seq = 0;
window.LTP_genId = (p) => (p || "x") + "-" + (++_seq);
(0, eval)(fs.readFileSync(path.join(__dirname, "..", "theme.js"), "utf8"));

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, g, e) { ok(n, JSON.stringify(g) === JSON.stringify(e), "got " + JSON.stringify(g) + " exp " + JSON.stringify(e)); }
function near(n, g, e) { ok(n, Math.abs(g - e) < 0.005, "got " + g + " exp " + e); }

const IDS = window.LTP_docProjectIds;
const LINK = window.LTP_linkDocProject;
const NAMES = window.LTP_docProjectNames;
const LABEL = window.LTP_projectSectionLabel;
const APPEND = window.LTP_appendDocSections;
const SECTIONS = window.LTP_scheduleLaborSections;

// ── LTP_docProjectIds ────────────────────────────────────────────────────────
eq("P0 null entity", IDS(null), []);
eq("P1 no project at all", IDS({ projectId: null }), []);
eq("P2 legacy row (projectId only)", IDS({ projectId: 7 }), [7]);
eq("P3 legacy row, projectIds absent", IDS({ projectId: 7, projectIds: undefined }), [7]);
eq("P4 primary first, then the rest", IDS({ projectId: 7, projectIds: [9, 7] }), [7, 9]);
eq("P5 primary missing from list is still folded in", IDS({ projectId: 7, projectIds: [9] }), [7, 9]);
eq("P6 duplicates collapse", IDS({ projectId: 7, projectIds: [9, 9, 7, 9] }), [7, 9]);
eq("P7 project-less doc keeps its list", IDS({ projectId: null, projectIds: [4, 5] }), [4, 5]);
eq("P8 nulls in the list are dropped", IDS({ projectId: 3, projectIds: [null, 4] }), [3, 4]);
// String/number id mix must not double-count — ids arrive as numbers from the
// API but a hand-built object could carry a string.
eq("P9 string/number id de-dup", IDS({ projectId: 7, projectIds: ["7", 9] }), [7, 9]);

// ── LTP_linkDocProject ───────────────────────────────────────────────────────
eq("L0 add a second project", LINK({ projectId: 7 }, 9), { projectId: 7, projectIds: [7, 9] });
eq("L1 idempotent re-link", LINK({ projectId: 7, projectIds: [7, 9] }, 9), { projectId: 7, projectIds: [7, 9] });
eq("L2 normalizes a legacy row", LINK({ projectId: 7 }, 7), { projectId: 7, projectIds: [7] });
eq("L3 project-less doc adopts a primary", LINK({ projectId: null }, 9), { projectId: 9, projectIds: [9] });
eq("L4 null projectId is a no-op patch", LINK({ projectId: 7, projectIds: [7] }, null), { projectId: 7, projectIds: [7] });
// The primary must never be rewritten — the client already received a document
// titled with it.
eq("L5 primary survives a third project", LINK({ projectId: 7, projectIds: [7, 9] }, 11),
   { projectId: 7, projectIds: [7, 9, 11] });
// String/number mix must not append a duplicate.
eq("L6 re-link with a string id", LINK({ projectId: 7, projectIds: [7] }, "7"), { projectId: 7, projectIds: [7] });

// ── LTP_docProjectNames ──────────────────────────────────────────────────────
const PROJECTS = [{ id: 7, name: "Riverfront Gala" }, { id: 9, name: "Summit Keynote" }];
eq("N0 resolves in primary-first order", NAMES({ projectId: 9, projectIds: [7] }, PROJECTS),
   ["Summit Keynote", "Riverfront Gala"]);
eq("N1 deleted project degrades, doesn't vanish", NAMES({ projectId: 7, projectIds: [99] }, PROJECTS),
   ["Riverfront Gala", "Project 99"]);
eq("N2 empty when nothing linked", NAMES({ projectId: null }, PROJECTS), []);
eq("N3 tolerates a missing projects list", NAMES({ projectId: 7 }, null), ["Project 7"]);

// ── LTP_projectSectionLabel ──────────────────────────────────────────────────
eq("S0 stamps the project", LABEL("Labor", "Summit Keynote"), "Labor — Summit Keynote");
eq("S1 no project → unchanged", LABEL("Labor", ""), "Labor");
eq("S2 no project (null) → unchanged", LABEL("Labor", null), "Labor");
eq("S3 never double-stamps", LABEL("Labor — Summit Keynote", "Summit Keynote"), "Labor — Summit Keynote");
eq("S4 case-insensitive double-stamp guard", LABEL("Labor — summit keynote", "Summit Keynote"), "Labor — summit keynote");
eq("S5 blank base falls back", LABEL("", "Summit Keynote"), "Items — Summit Keynote");
eq("S6 whitespace-only base falls back", LABEL("   ", "Summit Keynote"), "Items — Summit Keynote");

// ── LTP_appendDocSections ────────────────────────────────────────────────────
// The core promise: what's already on the document is returned untouched, and
// the new sections are ADDED — never merged into a same-labelled section.
{
  const existing = [{ id: "sec-a", label: "Labor", items: [{ id: "it-1", name: "A1 Audio", qty: 1 }] }];
  const incoming = [{ id: "sec-b", label: "Labor", items: [{ id: "it-2", name: "Lighting Tech", qty: 2 }] }];
  const out = APPEND(existing, incoming, window.LTP_genId);
  eq("A0 section count grows", out.length, 2);
  eq("A1 existing section object is untouched", out[0], existing[0]);
  eq("A2 same label does NOT merge", out[0].items.length, 1);
  eq("A3 incoming lands as its own section", out[1].items.map((i) => i.name), ["Lighting Tech"]);
}
{
  // Id collision: a section/item copied out of another document can carry an id
  // the target already uses. Both must be regenerated, and the ORIGINALS kept.
  const existing = [{ id: "sec-a", label: "Labor", items: [{ id: "it-1", name: "Keep me", qty: 1 }] }];
  const incoming = [{ id: "sec-a", label: "Labor — Summit", items: [{ id: "it-1", name: "New line", qty: 3 }] }];
  const out = APPEND(existing, incoming, window.LTP_genId);
  ok("A4 colliding section id regenerated", out[1].id !== "sec-a", out[1].id);
  ok("A5 colliding item id regenerated", out[1].items[0].id !== "it-1", out[1].items[0].id);
  eq("A6 original section id preserved", out[0].id, "sec-a");
  eq("A7 original item survives intact", out[0].items[0].name, "Keep me");
  eq("A8 appended item keeps its data", out[1].items[0].name, "New line");
  eq("A9 appended label preserved", out[1].label, "Labor — Summit");
}
{
  const out = APPEND(null, [{ id: "s1", label: "Labor", items: [] }], window.LTP_genId);
  eq("A10 tolerates a null target", out.length, 1);
  eq("A11 nothing to append is a no-op", APPEND([{ id: "s1", label: "L", items: [] }], [], window.LTP_genId).length, 1);
  eq("A12 null incoming is a no-op", APPEND([{ id: "s1", label: "L", items: [] }], null, window.LTP_genId).length, 1);
}

// ── LTP_scheduleLaborSections ────────────────────────────────────────────────
// A minimal rate card. dayRate/dayCost drive price vs cost; otRate/otCost are
// derived by LTP_calcDayLabor when absent.
const SVCS = [
  { id: 1, role: "A1", description: "Audio Lead", department: "Audio", dayRate: 600, dayCost: 300 },
  { id: 2, role: "LX", description: "Lighting Tech", department: "Lighting", dayRate: 500, dayCost: 250 },
];
const fmtDate = (d) => d;              // identity formatter keeps assertions readable
const pos = (id, serviceId, extra) => Object.assign({ id: id, serviceId: serviceId, role: "R", status: "confirmed" }, extra || {});
// Meal breaks matter to the math, not just to realism: LTP_calcLaborDay charges
// meal-penalty OT on any work SEGMENT over 5 hours, so an unbroken 8-hour call
// is already an overtime day. Standard fixtures below carry a break so they
// exercise the ordinary full-day path; the penalty itself is asserted in J*.
const MEAL  = [{ startTime: "12:00", endTime: "12:30", type: "unpaid" }];
const MEAL2 = MEAL.concat([{ startTime: "17:00", endTime: "17:30", type: "unpaid" }]);
const day = (id, date, time, endTime, positions, breaks) =>
  ({ id: id, date: date, time: time, endTime: endTime, positions: positions, breaks: breaks || [] });

{
  // One 8-hour day (7.5h worked after the meal), two roles, one person each →
  // two day-rate lines, no OT.
  const schedule = [day("d1", "2026-08-10", "08:00", "16:00", [pos("p1", 1), pos("p2", 2)], MEAL)];
  const one = SECTIONS(schedule, SVCS, {}, "one", fmtDate, window.LTP_genId);
  eq("B0 single section when grouping=one", one.length, 1);
  eq("B1 section label", one[0].label, "Labor");
  eq("B2 two day-rate lines", one[0].items.length, 2);
  eq("B3 line names include role — description", one[0].items.map((i) => i.name).sort(),
     ["A1 — Audio Lead", "LX — Lighting Tech"]);
  eq("B4 rateType is a full day", one[0].items.map((i) => i.rateType), ["day", "day"]);
  eq("B5 qty is people-per-role", one[0].items.map((i) => i.qty), [1, 1]);
  eq("B6 notes carry the day", one[0].items[0].notes, "2026-08-10");
  eq("B7 ledger fields start at zero", one[0].items.map((i) => i.deliveredQty + i.invoicedQty), [0, 0]);

  const split = SECTIONS(schedule, SVCS, {}, "split", fmtDate, window.LTP_genId);
  eq("B8 one section per department", split.length, 2);
  eq("B9 department labels", split.map((s) => s.label).sort(), ["Audio", "Lighting"]);
  eq("B10 each department has its own line", split.map((s) => s.items.length), [1, 1]);
}
{
  // Same role on two days → ONE line, qty 2 (one person-day each), both dates.
  const schedule = [
    day("d1", "2026-08-10", "08:00", "16:00", [pos("p1", 1)], MEAL),
    day("d2", "2026-08-11", "08:00", "16:00", [pos("p2", 1)], MEAL),
  ];
  const out = SECTIONS(schedule, SVCS, {}, "one", fmtDate, window.LTP_genId);
  eq("C0 one aggregated line", out[0].items.length, 1);
  eq("C1 qty is total person-days", out[0].items[0].qty, 2);
  eq("C2 both dates listed", out[0].items[0].notes, "2026-08-10, 2026-08-11");
  near("C3 unit price is the day rate", out[0].items[0].unitPrice, 600);
  near("C4 unit cost is the day cost", out[0].items[0].cost, 300);
}
{
  // A day past 10 worked hours produces an OT line alongside the day rate.
  // 08:00–22:00 with two meals = 13 paid hours → 3 OT.
  const schedule = [day("d1", "2026-08-10", "08:00", "22:00", [pos("p1", 1)], MEAL2)];
  const out = SECTIONS(schedule, SVCS, {}, "one", fmtDate, window.LTP_genId);
  eq("D0 day-rate line plus OT line", out[0].items.length, 2);
  const dayLine = out[0].items.find((i) => i.rateType === "day");
  const ot = out[0].items.find((i) => i.rateType === "ot");
  ok("D1 OT line exists", !!ot);
  near("D2 OT hours = worked - 10", ot.qty, 3);
  near("D3 OT rate defaults to dayRate/10 × 1.5", ot.unitPrice, 90);
  near("D4 OT cost defaults to dayCost/10 × 1.5", ot.cost, 45);
  eq("D5 OT note names the day", ot.notes, "Overtime hours: 2026-08-10");
  // The day rate is still billed in full alongside the OT — OT is additive.
  near("D6 day rate unaffected by OT", dayLine.unitPrice, 600);
  eq("D7 day line qty is still one person", dayLine.qty, 1);
}
{
  // A full-margin position (owner working their own gig) bills normally but
  // costs nothing — the line's blended cost must reflect that.
  const schedule = [day("d1", "2026-08-10", "08:00", "16:00",
                        [pos("p1", 1, { fullMargin: true }), pos("p2", 1)], MEAL)];
  const out = SECTIONS(schedule, SVCS, {}, "one", fmtDate, window.LTP_genId);
  eq("E0 two people on one line", out[0].items[0].qty, 2);
  near("E1 price is per-person day rate", out[0].items[0].unitPrice, 600);
  near("E2 cost is blended across paid + margin", out[0].items[0].cost, 150);  // (300 + 0) / 2
}
{
  // A per-crew negotiated minimum floors COST only — the client is still billed
  // the role rate.
  const schedule = [day("d1", "2026-08-10", "08:00", "16:00", [pos("p1", 1, { crewId: 42 })], MEAL)];
  const out = SECTIONS(schedule, SVCS, { 42: 450 }, "one", fmtDate, window.LTP_genId);
  near("F0 price unaffected by the crew minimum", out[0].items[0].unitPrice, 600);
  near("F1 cost floored at the crew minimum", out[0].items[0].cost, 450);
  // Below the role's own cost the minimum must not lower anything.
  const low = SECTIONS(schedule, SVCS, { 42: 100 }, "one", fmtDate, window.LTP_genId);
  near("F2 a lower minimum never reduces cost", low[0].items[0].cost, 300);
}
{
  // Days that can't be priced are skipped, and a schedule of only those bills
  // nothing at all (the caller turns [] into a "nothing to bill" message).
  eq("G0 no schedule → nothing", SECTIONS([], SVCS, {}, "one", fmtDate, window.LTP_genId), []);
  eq("G1 null schedule → nothing", SECTIONS(null, SVCS, {}, "one", fmtDate, window.LTP_genId), []);
  const untimed = [day("d1", "2026-08-10", "", "", [pos("p1", 1)])];
  eq("G2 day with no times bills nothing", SECTIONS(untimed, SVCS, {}, "one", fmtDate, window.LTP_genId), []);
  const noService = [day("d1", "2026-08-10", "08:00", "16:00", [{ id: "p1", role: "R", status: "confirmed" }], MEAL)];
  eq("G3 position without a service bills nothing", SECTIONS(noService, SVCS, {}, "one", fmtDate, window.LTP_genId), []);
  // A role that isn't on the client's rate card can't be priced either.
  const unknownSvc = [day("d1", "2026-08-10", "08:00", "16:00", [pos("p1", 99)], MEAL)];
  eq("G3b unknown service bills nothing", SECTIONS(unknownSvc, SVCS, {}, "one", fmtDate, window.LTP_genId), []);
  // A timed day and an untimed day together: only the timed one bills.
  const mixed = [
    day("d1", "2026-08-10", "08:00", "16:00", [pos("p1", 1)], MEAL),
    day("d2", "2026-08-11", "", "", [pos("p2", 1)]),
  ];
  const out = SECTIONS(mixed, SVCS, {}, "one", fmtDate, window.LTP_genId);
  eq("G4 only the priceable day is billed", out[0].items[0].qty, 1);
  eq("G5 only its date is noted", out[0].items[0].notes, "2026-08-10");
}
{
  // Undated rows still bill, labelled TBD — matching the original Send to Quote.
  const undated = [day("d1", "", "08:00", "16:00", [pos("p1", 1)], MEAL)];
  const out = SECTIONS(undated, SVCS, {}, "one", fmtDate, window.LTP_genId);
  eq("H0 undated day bills", out[0].items.length, 1);
  eq("H1 labelled TBD", out[0].items[0].notes, "TBD");
}
{
  // More than four dates collapses to "first three + N more" so a long run
  // doesn't blow out the note column.
  const days = ["01", "02", "03", "04", "05"].map((d, i) =>
    day("d" + i, "2026-08-" + d, "08:00", "16:00", [pos("p" + i, 1)], MEAL));
  const out = SECTIONS(days, SVCS, {}, "one", fmtDate, window.LTP_genId);
  eq("H2 long date runs are summarized", out[0].items[0].notes,
     "2026-08-01, 2026-08-02, 2026-08-03 + 2 more");
  eq("H3 exactly four dates still list in full",
     SECTIONS(days.slice(0, 4), SVCS, {}, "one", fmtDate, window.LTP_genId)[0].items[0].notes,
     "2026-08-01, 2026-08-02, 2026-08-03, 2026-08-04");
}
{
  // Every generated section/item id must be unique — they land straight into a
  // document's sections and a collision would break React keys and edits.
  const days = [
    day("d1", "2026-08-10", "08:00", "22:00", [pos("p1", 1), pos("p2", 2)], MEAL2),
    day("d2", "2026-08-11", "08:00", "22:00", [pos("p3", 1), pos("p4", 2)], MEAL2),
  ];
  const out = SECTIONS(days, SVCS, {}, "split", fmtDate, window.LTP_genId);
  const ids = [];
  out.forEach((s) => { ids.push(s.id); s.items.forEach((i) => ids.push(i.id)); });
  eq("H4 all generated ids are unique", ids.length, new Set(ids).size);
  eq("H5 day + OT line per department", ids.length, 6);   // 2 sections + 4 items
}
{
  // Meal-penalty rule, asserted directly: an unbroken 8-hour call bills a full
  // day PLUS 3 hours of penalty OT (every segment hour past 5).
  const unbroken = [day("d1", "2026-08-10", "08:00", "16:00", [pos("p1", 1)])];
  const out = SECTIONS(unbroken, SVCS, {}, "one", fmtDate, window.LTP_genId);
  eq("J0 unbroken long call adds an OT line", out[0].items.length, 2);
  near("J1 penalty hours = segment hours past 5", out[0].items.find((i) => i.rateType === "ot").qty, 3);
  // A short call with no break stays a half day and never accrues penalty.
  const short = [day("d2", "2026-08-10", "09:00", "13:00", [pos("p1", 1)])];
  const shortOut = SECTIONS(short, SVCS, {}, "one", fmtDate, window.LTP_genId);
  eq("J2 short call is a single half-day line", shortOut[0].items.length, 1);
  eq("J3 rateType is half", shortOut[0].items[0].rateType, "half");
  near("J4 half day is priced at half the day rate", shortOut[0].items[0].unitPrice, 300);
}
{
  // End-to-end: schedule → sections → labelled → appended into a doc that
  // already has content. This is exactly what Send to Quote / Send to Invoice
  // does on the append path.
  const schedule = [day("d1", "2026-08-10", "08:00", "16:00", [pos("p1", 1)], MEAL)];
  const built = SECTIONS(schedule, SVCS, {}, "one", fmtDate, window.LTP_genId);
  const labelled = built.map((s) => Object.assign({}, s, { label: LABEL(s.label, "Summit Keynote"), projectId: 9 }));
  const target = { id: 3, projectId: 7, projectIds: [7],
                   sections: [{ id: "sec-x", label: "Labor", items: [{ id: "it-x", name: "Existing", qty: 1 }] }] };
  const merged = APPEND(target.sections, labelled, window.LTP_genId);
  const link = LINK(target, 9);
  eq("Z0 target section untouched", merged[0], target.sections[0]);
  eq("Z1 appended section names the job", merged[1].label, "Labor — Summit Keynote");
  eq("Z2 appended section records the project", merged[1].projectId, 9);
  eq("Z3 primary project unchanged", link.projectId, 7);
  eq("Z4 both projects now linked", link.projectIds, [7, 9]);
  eq("Z5 both jobs named on the doc", NAMES({ projectId: link.projectId, projectIds: link.projectIds }, PROJECTS),
     ["Riverfront Gala", "Summit Keynote"]);
  // A second send of the SAME schedule appends again rather than merging — the
  // duplicate is visible as its own section, not silently folded into the first.
  const twice = APPEND(merged, labelled, window.LTP_genId);
  eq("Z6 re-sending appends a further section", twice.length, 3);
  eq("Z7 earlier sections still untouched", twice.slice(0, 2), merged);
}

// ── LTP_docHasProject ────────────────────────────────────────────────────────
// The whole point: a project's Quotes/Invoices tabs must find documents where
// it's a CONTRIBUTOR, not only ones it's primary on.
const HAS = window.LTP_docHasProject;
eq("D0 primary matches", HAS({ projectId: 7, projectIds: [7, 9] }, 7), true);
eq("D1 contributor matches", HAS({ projectId: 7, projectIds: [7, 9] }, 9), true);
eq("D2 unrelated project doesn't", HAS({ projectId: 7, projectIds: [7, 9] }, 11), false);
eq("D3 legacy row still matches its one project", HAS({ projectId: 7 }, 7), true);
eq("D4 null project id never matches", HAS({ projectId: 7 }, null), false);
eq("D5 null entity never matches", HAS(null, 7), false);
eq("D6 string/number id still matches", HAS({ projectId: 7, projectIds: [7] }, "7"), true);

// ── LTP_sharedDocNote ────────────────────────────────────────────────────────
// Each project counts a shared document's FULL total, so its pages read right in
// isolation but can't be summed. This note is what says so.
const NOTE = window.LTP_sharedDocNote;
const P7 = { id: 7, name: "Riverfront Gala" };
{
  const solo = [{ projectId: 7, projectIds: [7] }, { projectId: 7 }];
  eq("W0 nothing shared -> no note", NOTE(P7, solo, PROJECTS), null);
  eq("W1 no documents -> no note", NOTE(P7, [], PROJECTS), null);
  eq("W2 null project -> no note", NOTE(null, solo, PROJECTS), null);
}
{
  const mixed = [{ projectId: 7, projectIds: [7] }, { projectId: 7, projectIds: [7, 9] }];
  const note = NOTE(P7, mixed, PROJECTS);
  ok("W3 names the other job", /Summit Keynote/.test(note), note);
  ok("W4 counts only the shared one", /Includes 1 /.test(note), note);
  ok("W5 says the total is counted twice", /counted in full/.test(note), note);
  ok("W6 never names the project itself", !/Riverfront/.test(note), note);
}
{
  // Several other jobs collapse into a readable phrase rather than a long list.
  const many = [{ projectId: 7, projectIds: [7, 9, 11, 12, 13] }];
  const all = PROJECTS.concat([{ id: 11, name: "Autumn Mixer" }, { id: 12, name: "Trade Show" }, { id: 13, name: "Winter Ball" }]);
  const note = NOTE(P7, many, all);
  ok("W7 first two named", /Summit Keynote, Autumn Mixer/.test(note), note);
  ok("W8 remainder counted", /and 2 more/.test(note), note);
}
{
  // A deleted contributing project degrades rather than dropping out.
  const note = NOTE(P7, [{ projectId: 7, projectIds: [7, 404] }], PROJECTS);
  ok("W9 deleted project still named", /Project 404/.test(note), note);
}

// ── LTP_projectHeadlineTotal counts contributor quotes ───────────────────────
{
  const HEAD = window.LTP_projectHeadlineTotal;
  const money = (n) => ({ sections: [{ items: [{ type: "service", qty: 1, unitPrice: n }] }] });
  const primary = Object.assign({ id: 1, projectId: 7, projectIds: [7], status: "sent" }, money(1000));
  const shared = Object.assign({ id: 2, projectId: 9, projectIds: [9, 7], status: "sent" }, money(2100));
  const other = Object.assign({ id: 3, projectId: 11, projectIds: [11], status: "sent" }, money(500));
  const declined = Object.assign({ id: 4, projectId: 7, projectIds: [7], status: "declined" }, money(9999));
  const r = HEAD({ id: 7, budget: {} }, [primary, shared, other, declined]);
  eq("V0 counts primary + contributor quotes", r.count, 2);
  near("V1 shared quote counts its FULL total", r.total, 3100);
  eq("V2 flagged as quoted", r.quoted, true);
  // The other project sees the same shared quote at full value — deliberate,
  // and exactly what LTP_sharedDocNote exists to disclose.
  near("V3 the other job counts it in full too", HEAD({ id: 9, budget: {} }, [primary, shared, other]).total, 2100);
  // A project with only declined quotes falls back to its preliminary budget.
  eq("V4 declined-only falls back to budget",
     HEAD({ id: 7, budget: { gear: 400, labor: 100 } }, [declined]).quoted, false);
  near("V5 budget total", HEAD({ id: 7, budget: { gear: 400, labor: 100 } }, [declined]).total, 500);
}

// ── LTP_sectionDateStamp ─────────────────────────────────────────────────────
// Work appended from another job carries that job's rental window on its own
// sections, so equipment lines price on the right dates.
const STAMP = window.LTP_sectionDateStamp;
const GALA = { id: 7, name: "Riverfront Gala", startDate: "2026-08-10", endDate: "2026-08-11" };
const SUMMIT = { id: 9, name: "Summit Keynote", startDate: "2026-09-01", endDate: "2026-09-02" };
const ALLP = [GALA, SUMMIT];
{
  const doc = { projectId: 7, projectIds: [7] };
  eq("T0 the doc's own primary job needs no override", STAMP(doc, GALA, ALLP), null);
  eq("T1 a different job gets its own window", STAMP(doc, SUMMIT, ALLP),
     { customDates: true, startDate: "2026-09-01", endDate: "2026-09-02" });
}
{
  // Same dates → nothing to override, even for a different job.
  const twin = { id: 11, name: "Twin Job", startDate: "2026-08-10", endDate: "2026-08-11" };
  eq("T2 matching windows need no override", STAMP({ projectId: 7, projectIds: [7] }, twin, ALLP.concat([twin])), null);
}
{
  eq("T3 undated project can't stamp anything", STAMP({ projectId: 7 }, { id: 9, name: "No Dates" }, ALLP), null);
  eq("T4 null project is a no-op", STAMP({ projectId: 7 }, null, ALLP), null);
  // A project-less document falls back to its custom dates for the comparison.
  eq("T5 custom-dated doc, different job", STAMP({ projectId: null, customStartDate: "2026-01-01", customEndDate: "2026-01-02" }, SUMMIT, ALLP),
     { customDates: true, startDate: "2026-09-01", endDate: "2026-09-02" });
  eq("T6 custom dates already match", STAMP({ projectId: null, customStartDate: "2026-09-01", customEndDate: "2026-09-02" }, SUMMIT, ALLP), null);
}
{
  // The stamp is applied on top of a built section — the section keeps its
  // items and label, and gains only the window.
  const built = { id: "s1", label: "Labor — Summit Keynote", customDates: false, startDate: "", endDate: "",
                  items: [{ id: "i1", name: "A1", qty: 1 }] };
  const stamped = Object.assign({}, built, STAMP({ projectId: 7, projectIds: [7] }, SUMMIT, ALLP) || {});
  eq("T7 section keeps its label", stamped.label, "Labor — Summit Keynote");
  eq("T8 section keeps its items", stamped.items.length, 1);
  eq("T9 section gains the job's window", [stamped.customDates, stamped.startDate, stamped.endDate],
     [true, "2026-09-01", "2026-09-02"]);
}

// ── Quote draft clone: server-managed fields must survive the whitelist ──────
// modules/quotes-builder.js::cloneDraft rebuilds every draft from an explicit
// whitelist, so a field it does not name is silently dropped when a quote is
// opened. That is what hid the QuickBooks sales tax: the builder's Totals panel
// gated its tax row on a field the clone had already thrown away, so the app
// showed a tax-EXCLUSIVE total while the client's PDF and share link (which
// read the row directly) showed the tax. Extract the real function and run it.
{
  const src = fs.readFileSync(path.join(__dirname, "..", "modules", "quotes-builder.js"), "utf8");
  const start = src.indexOf("function cloneDraft(");
  let i = src.indexOf("{", start), depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  ok("C0 cloneDraft located in the module", start !== -1 && end !== -1);
  // cloneDraft closes over two module-scope helpers; supply them.
  globalThis.todayISO = () => "2026-08-19";
  const cloneDraft = (0, eval)("(" + src.slice(start, end) + ")");

  const q = { id: 4, clientType: "company", companyId: 2, status: "sent",
              sections: [{ id: "s1", label: "Crew", items: [{ id: "i1", unitPrice: 5000, qty: 2 }] }],
              globalDiscount: { type: "none", value: 0 },
              qbTaxTotal: 825, qbTaxSignature: "sig-abc" };
  const d = cloneDraft(q);
  eq("C1 clone keeps qbTaxTotal", d.qbTaxTotal, 825);
  eq("C2 clone keeps qbTaxSignature", d.qbTaxSignature, "sig-abc");
  // The panel gates on `!= null`, so an uncalculated quote must clone to null,
  // not undefined-by-omission — and a real $0 (exempt client) must stay 0.
  eq("C3 uncalculated tax clones as null", cloneDraft({ id: 5, sections: [] }).qbTaxTotal, null);
  eq("C4 an exempt client's $0 survives", cloneDraft({ id: 6, sections: [], qbTaxTotal: 0 }).qbTaxTotal, 0);
  // And the totals helper agrees with what the PDF would compute.
  eq("C5 cloned draft totals are tax-inclusive", window.LTP_QUOTE_TOTALS(d).total, 10825);
}

console.log("doc-projects suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { fails.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
