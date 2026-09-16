#!/usr/bin/env node
// "Previously declined this shift" — the index behind the crew pickers'
// declined section (components/domain-crew.js::LTP_declinedCrewIndex).
//
// The record is the crew_requests table: a declined request keeps its
// positionIds for good. The index reads those rows back per SHIFT — the day
// row a position sits on, or the flat-rate position itself — and the latest
// ask per (person, shift) decides. These tests hold that line:
//   * a decline marks the whole day row, not just the slot that was asked
//   * a later accept / pending re-ask clears it; a withdrawn re-ask does not
//   * a flat-rate position is its own shift
//   * one lookup can span several shifts (a multi-row day booking)
//   Run:  node tests/test_declined_crew.js
"use strict";
require("./_load_domain.js").loadDomain();

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, g, e) { ok(n, JSON.stringify(g) === JSON.stringify(e), "got " + JSON.stringify(g) + " exp " + JSON.stringify(e)); }

const projects = [{
  id: 7, name: "Gala",
  schedule: [
    { id: "sch-1", date: "2026-09-20", title: "Load-in", positions: [{ id: "p1", crewId: null, status: "open" }, { id: "p2", crewId: 11, status: "open" }] },
    { id: "sch-2", date: "2026-09-21", title: "Show", positions: [{ id: "p3", crewId: null, status: "open" }] },
  ],
  fixedPositions: [{ id: "f1", crewId: null, status: "open" }, { id: "f2", crewId: null, status: "open" }],
}, { id: 8, name: "Other", schedule: [{ id: "sch-9", date: "2026-09-20", positions: [{ id: "p9" }] }], fixedPositions: [] }];

// Request rows as GET /api/crew-requests returns them. id doubles as the send
// order: id N was sent on Sep N and answered on Sep 1N.
function req(id, contactId, positionIds, status, extra) {
  return Object.assign({ id: id, projectId: 7, contactId: contactId, positionIds: positionIds, status: status,
    sentAt: "2026-09-0" + id + "T10:00:00Z", respondedAt: status === "pending" ? null : "2026-09-1" + id + "T10:00:00Z", comment: "" }, extra || {});
}
const IDX = window.LTP_declinedCrewIndex;
const day1 = [{ schedItemId: "sch-1" }], day2 = [{ schedItemId: "sch-2" }];
const who = (list) => list.map((d) => d.contactId);

// ── A decline marks the day row ───────────────────────────────────────────
let idx = IDX([req(1, 10, ["p1"], "declined", { comment: "Out of town" })], projects);
eq("D1 the decliner is listed for the day row", who(idx.declinedFor(7, day1)), [10]);
eq("D2 not for another day", idx.declinedFor(7, day2), []);
eq("D3 not for another project", idx.declinedFor(8, [{ schedItemId: "sch-9" }]), []);
eq("D4 the answer's date and note ride along",
   idx.declinedFor(7, day1)[0], { contactId: 10, respondedAt: "2026-09-11T10:00:00Z", comment: "Out of town" });
// The slot asked was p1; p2 is another slot on the same row. The person turned
// down the DAY, so the row's other slots list them too — the picker for p2
// reads the same lookup.
idx = IDX([req(1, 10, ["p2"], "declined")], projects);
eq("D5 a decline for one slot marks every slot on that row", who(idx.declinedFor(7, day1)), [10]);

// ── Only a decline counts ─────────────────────────────────────────────────
idx = IDX([req(1, 10, ["p1"], "accepted"), req(2, 11, ["p1"], "pending"), req(3, 12, ["p1"], "withdrawn")], projects);
eq("S1 accepted / pending / withdrawn are not 'previously declined'", idx.declinedFor(7, day1), []);

// ── The latest ask wins ───────────────────────────────────────────────────
idx = IDX([req(1, 10, ["p1"], "declined"), req(2, 10, ["p1"], "accepted")], projects);
eq("L1 declined, re-asked and accepted → not listed", idx.declinedFor(7, day1), []);
idx = IDX([req(1, 10, ["p1"], "declined"), req(2, 10, ["p1"], "pending")], projects);
eq("L2 declined, re-asked, no answer yet → not listed", idx.declinedFor(7, day1), []);
idx = IDX([req(1, 10, ["p1"], "declined"), req(2, 10, ["p1"], "withdrawn")], projects);
eq("L3 declined, re-asked, re-ask withdrawn → still listed", who(idx.declinedFor(7, day1)), [10]);
idx = IDX([req(1, 10, ["p1"], "accepted"), req(2, 10, ["p1"], "declined")], projects);
eq("L4 accepted once, declined the re-ask → listed", who(idx.declinedFor(7, day1)), [10]);
idx = IDX([req(2, 10, ["p1"], "accepted"), req(1, 10, ["p1"], "declined")], projects);
eq("L5 the list's order doesn't matter — sentAt does", idx.declinedFor(7, day1), []);
idx = IDX([req(1, 10, ["p1"], "declined", { sentAt: "2026-09-01T10:00:00Z" }), req(2, 10, ["p1"], "accepted", { sentAt: "2026-09-01T10:00:00Z" })], projects);
eq("L6 a sentAt tie is broken by id", idx.declinedFor(7, day1), []);
idx = IDX([req(1, 10, ["p1"], "declined"), req(2, 10, ["p1"], "accepted", { silent: true })], projects);
eq("L7 a later direct book counts as an accepted ask", idx.declinedFor(7, day1), []);
// Per shift: a re-ask covering only one of the declined days clears only that day.
idx = IDX([req(1, 10, ["p1", "p3"], "declined"), req(2, 10, ["p3"], "accepted")], projects);
eq("L8 the re-ask clears the day it covered", idx.declinedFor(7, day2), []);
eq("L9 ...and leaves the other day declined", who(idx.declinedFor(7, day1)), [10]);

// ── A flat-rate position is its own shift ─────────────────────────────────
idx = IDX([req(1, 10, ["f1"], "declined")], projects);
eq("F1 listed for the flat-rate position", who(idx.declinedFor(7, [{ flat: true, posId: "f1" }])), [10]);
eq("F2 not for the project's other flat-rate position", idx.declinedFor(7, [{ flat: true, posId: "f2" }]), []);
eq("F3 not for a day row", idx.declinedFor(7, day1), []);

// ── One lookup, several shifts ────────────────────────────────────────────
idx = IDX([req(1, 10, ["p1"], "declined"), req(2, 11, ["p3"], "declined"), req(3, 10, ["p3"], "declined")], projects);
const both = idx.declinedFor(7, [{ schedItemId: "sch-1" }, { schedItemId: "sch-2" }]);
eq("M1 spanning two rows lists everyone who declined either, once each", who(both), [10, 11]);
eq("M2 ...newest decline first, carrying the person's newest answer",
   both[0], { contactId: 10, respondedAt: "2026-09-13T10:00:00Z", comment: "" });

// ── Guards ────────────────────────────────────────────────────────────────
idx = IDX([req(1, 10, ["gone"], "declined")], projects);
eq("G1 a position no project holds any more is ignored", idx.declinedFor(7, day1), []);
eq("G2 null inputs → empty", IDX(null, null).declinedFor(7, day1), []);
eq("G3 an unknown project → empty", IDX([req(1, 10, ["p1"], "declined")], projects).declinedFor(99, day1), []);
eq("G4 entries naming no shift → empty", IDX([req(1, 10, ["p1"], "declined")], projects).declinedFor(7, [{}, null, { flat: true }]), []);
idx = IDX([{ id: 1, projectId: 7, contactId: null, positionIds: ["p1"], status: "declined" }], projects);
eq("G5 a request with no crew member is skipped", idx.declinedFor(7, day1), []);
idx = IDX([req(1, 10, ["p1"], "declined")], [{ id: 7, schedule: null, fixedPositions: null }, null]);
eq("G6 a project with no rows is tolerated", idx.declinedFor(7, day1), []);

console.log("declined-crew suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
