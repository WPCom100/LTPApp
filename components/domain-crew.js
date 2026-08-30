// LTP domain — schedule shaping, crew assignment, sign-off and notifications.
//
// Split out of theme.js. Sign-off is where a schedule stops being a plan and
// becomes a payable record (LTP_signOffDay freezes work.pay, which
// backend/payouts.py later bills verbatim to a QuickBooks vendor bill), so this
// file is money-adjacent even though the arithmetic lives in domain-labor.js.
//
// GENUINELY INDIVISIBLE: the crew-removal block at the bottom IS an IIFE, so
// its private shiftSnap really is lexically scoped — unlike the bare file-scope
// helpers elsewhere in this layer. Its four exports must move as one block or
// they break at call time.
//
// LOAD ORDER CONTRACT — read before moving this <script> tag.
//   These domain-*.js files were split out of theme.js. They must stay in
//   index.html's THEME slot (group 3), together and in the listed order, and
//   BEFORE every components/ and modules/ file — NOT down in the components
//   group where their path suggests they belong. 46 frontend files alias these
//   exports into IIFE-locals at their OWN load time (modules/quotes-list.js:9
//   is `var computeTotals = window.LTP_QUOTE_TOTALS;`), so a symbol defined
//   after its consumer's <script> is captured as undefined, not late-bound.
//   They also belong in sw.js's SAME_ORIGIN_PRECACHE boot chain beside
//   /theme.js, or the shell drops them on a cold offline launch.
//
// Nothing here reads another LTP_ symbol at load time, so the order AMONG
// these files is free; it is fixed only for readability. The one genuine
// load-order edge in the original file (the LTP_STATUS_COLORS IIFE calling
// LTP_badgeFromHex) stayed behind in theme.js on purpose.


// Build quote/invoice line-item sections from a project schedule — the whole
// of "Send to Quote" / "Send to Invoice" except the document literal itself.
// Lives here rather than in ScheduleBuilder so both destinations bill off ONE
// implementation (a divergence between them would be an invisible pricing bug)
// and so the aggregation is unit-testable — tests/test_schedule_billing.js.
//
// Billing model, unchanged from the original Send-to-Quote: each DAY is priced
// per ROLE, not per position. A role spread over several items on one day is
// one day rate sized by its max concurrent count, rated over the role's actual
// worked span. LTP_calcDayLabor owns that math; this function only aggregates
// its per-role output across days into line items — day rates keyed role+tier,
// OT pooled by role.
//
//   schedule  the project's schedule rows (already saved — the caller gates on
//             dirty state, since a day's times drive its price)
//   svcs      the CLIENT-resolved rate card (LTP_servicesForClient), never the
//             raw catalog, so a negotiated rate lands on the document
//   crewMins  LTP_crewMinMap(contacts) — per-crew payout floors, cost side only
//   grouping  "one" → a single "Labor" section; anything else → one section per
//             department
//   fmtDate   date formatter for each line's "which days" note (LTP_formatDate)
//
// Returns [] when the schedule bills nothing — no dated+timed day carries a
// position with a serviceId. Callers treat that as "nothing to send".
window.LTP_scheduleLaborSections = function(schedule, svcs, crewMins, grouping, fmtDate, genId) {
  var gen = genId || window.LTP_genId;
  var fmt = fmtDate || function(d) { return d; };

  // Group by date for day-level rate calculation.
  var dateGroups = {};
  (schedule || []).forEach(function(s) {
    var d = s.date || "_unscheduled";
    if (!dateGroups[d]) dateGroups[d] = { dayCall: null, dayWrap: null, items: [], date: d };
    var g = dateGroups[d];
    if (s.time && (!g.dayCall || s.time < g.dayCall)) g.dayCall = s.time;
    if (s.endTime && (!g.dayWrap || s.endTime > g.dayWrap)) g.dayWrap = s.endTime;
    g.items.push(s);
  });

  var dayRateItems = {};
  var otItems = {};

  Object.keys(dateGroups).forEach(function(dateKey) {
    var g = dateGroups[dateKey];
    if (!g.dayCall || !g.dayWrap) return;
    var dayLabel = g.date !== "_unscheduled" ? fmt(g.date) : "TBD";

    window.LTP_calcDayLabor(g.items, svcs, crewMins).units.forEach(function(u) {
      // Each unit is one person. The day-rate line aggregates units of the same
      // role+tier (qty = how many people); costAccum adds $0 for a full-margin
      // unit so its rate is pure margin. Per-unit cost is blended at build time
      // so a single line stays correct.
      var drKey = u.serviceId + "|" + u.tier;
      if (!dayRateItems[drKey]) {
        dayRateItems[drKey] = { svc: u.svc, tier: u.tier, rate: u.dayRate, qty: 0, costAccum: 0, dates: [],
                                dept: u.svc.department || "Other", minHours: u.minHours || 0, minApplied: false };
      }
      // A day billed up to the client's contract minimum says so on the line —
      // otherwise "Full day" against a 4-hour call reads as a mistake to
      // whoever reviews it.
      if (u.minHoursApplied) dayRateItems[drKey].minApplied = true;
      dayRateItems[drKey].qty += 1;
      dayRateItems[drKey].costAccum = Math.round((dayRateItems[drKey].costAccum + (u.fullMargin ? 0 : u.dayCost)) * 100) / 100;
      if (dayRateItems[drKey].dates.indexOf(dayLabel) === -1) dayRateItems[drKey].dates.push(dayLabel);

      // OT line item — this person's own OT hours (cost $0 if full margin).
      if (u.otHours > 0) {
        var otKey = u.serviceId;
        if (!otItems[otKey]) {
          otItems[otKey] = { svc: u.svc, otRate: u.otRate, rateHours: 0, costAccum: 0, dates: [], dept: u.svc.department || "Other" };
        }
        otItems[otKey].rateHours = Math.round((otItems[otKey].rateHours + u.otHours) * 100) / 100;
        otItems[otKey].costAccum = Math.round((otItems[otKey].costAccum + (u.fullMargin ? 0 : u.otCost * u.otHours)) * 100) / 100;
        if (otItems[otKey].dates.indexOf(dayLabel) === -1) otItems[otKey].dates.push(dayLabel);
      }
    });
  });

  function dayList(dates) {
    return dates.length <= 4 ? dates.join(", ") : dates.slice(0, 3).join(", ") + " + " + (dates.length - 3) + " more";
  }

  // Build the labor line items once (identical for both groupings); each
  // carries its department so we can either split by department or pool
  // everything into a single section.
  var laborItems = [];  // [{ dept, item }]

  // Day-rate lines. Per-unit cost is the blended cost across the qty
  // (full-margin positions contribute $0), so one line carries the right margin
  // without splitting paid vs owner crew.
  Object.keys(dayRateItems).forEach(function(key) {
    var li = dayRateItems[key];
    laborItems.push({ dept: li.dept, item: {
      id: gen("item"), type: "service", serviceId: li.svc.id,
      name: li.svc.role + " — " + li.svc.description,
      rateType: li.tier === "half" ? "half" : "day",
      qty: li.qty, unitPrice: li.rate, adjustedPrice: null,
      cost: li.qty > 0 ? Math.round((li.costAccum / li.qty) * 100) / 100 : 0,
      notes: dayList(li.dates) + (li.minApplied ? " · " + li.minHours + "-hour contract minimum applied" : ""),
      deliveredQty: 0, invoicedQty: 0
    } });
  });

  // OT lines (blended per-hour cost; margin OT hours cost $0).
  Object.keys(otItems).forEach(function(key) {
    var li = otItems[key];
    if (li.rateHours <= 0) return;
    laborItems.push({ dept: li.dept, item: {
      id: gen("item"), type: "service", serviceId: li.svc.id,
      name: li.svc.role + " — " + li.svc.description,
      rateType: "ot",
      qty: li.rateHours, unitPrice: li.otRate, adjustedPrice: null,
      cost: li.rateHours > 0 ? Math.round((li.costAccum / li.rateHours) * 100) / 100 : 0,
      notes: "Overtime hours: " + dayList(li.dates), deliveredQty: 0, invoicedQty: 0
    } });
  });

  if (laborItems.length === 0) return [];

  if (grouping === "one") {
    return [{ id: gen("sec"), label: "Labor", customDates: false, startDate: "", endDate: "",
              items: laborItems.map(function(x) { return x.item; }) }];
  }
  var sectionMap = {};
  laborItems.forEach(function(x) { (sectionMap[x.dept] = sectionMap[x.dept] || []).push(x.item); });
  return Object.keys(sectionMap).map(function(dept) {
    return { id: gen("sec"), label: dept, customDates: false, startDate: "", endDate: "", items: sectionMap[dept] };
  });
};

// ── Manual / one-off shift (warehouse labor not tied to a client job) ────────
//
// Build a lightweight "internal" project row from the Labor > Manual Shift
// adder. A manual shift deliberately reuses the Project + schedule shape so it
// flows through the crew-request and payout pipelines with NO special-casing:
// both iterate every project's `schedule[].positions[]`. The row is marked
// `internal: true` (companyId null, no schedule editor) so client-facing
// surfaces hide it while every Labor surface still shows it.
//
// opts = {
//   id,                       // caller-minted integer project id (required)
//   title,                    // shift name, e.g. "Warehouse Load-out"
//   date,                     // ISO YYYY-MM-DD — the single shift day
//   startTime, endTime,       // "HH:MM" (default 08:00 → 18:00)
//   location,                 // free-text job-site address (crew-facing)
//   notes,                    // free-text, stored as scheduleNotes
//   positions: [{ serviceId, role, crewId }]   // role = rate-card Service; crew optional
// }
// Positions start `status:"open"` — the same state the schedule editor mints —
// so an assigned crew member is immediately sendable as a crew request, and a
// confirmed one flows into payouts once it carries a serviceId with rates.
window.LTP_manualShiftProject = function(opts) {
  opts = opts || {};
  var genId = window.LTP_genId;
  var date = opts.date || "";
  var title = (opts.title || "").trim() || "Manual Shift";
  // A manual-shift role is always a rate-card Service (serviceId); positions
  // without one carry no rate and can't be paid, so they're dropped here — the
  // builder stays the single source of truth for what a valid position is,
  // independent of the caller.
  var positions = (opts.positions || []).filter(function(p) {
    return p && p.serviceId != null && p.serviceId !== "";
  }).map(function(p) {
    return {
      id: genId("pos"),
      role: p.role || "",
      serviceId: p.serviceId,
      crewId: (p.crewId != null && p.crewId !== "") ? p.crewId : null,
      status: "open",
      fullMargin: false,
    };
  });
  // Crew-wide meal breaks — same shape the schedule editor uses. Drop any
  // without both endpoints; unpaid breaks are deducted from paid hours in pay.
  var breaks = (opts.breaks || []).filter(function(b) {
    return b && b.startTime && b.endTime;
  }).map(function(b) {
    return { id: b.id || genId("brk"), startTime: b.startTime, endTime: b.endTime, type: b.type === "paid" ? "paid" : "unpaid" };
  });
  var shift = {
    id: genId("sch"),
    title: title,
    date: date,
    time: opts.startTime || "08:00",
    endDate: date,
    endTime: opts.endTime || "18:00",
    showOnCalendar: true,
    breaks: breaks,
    positions: positions,
  };
  return {
    id: opts.id,
    name: title,
    companyId: null,
    internal: true,
    category: "Labor",          // a real category so badge/color lookups resolve
    status: "in-progress",
    startDate: date,
    endDate: date,
    venue: "",
    siteAddress: opts.location || "",
    siteUseCompanyAddress: false,
    contactIds: [],
    budget: { lighting: 0, labor: 0, rentals: 0, misc: 0 },
    notes: [],
    meetings: [],
    scheduleNotes: (opts.notes || ""),
    schedule: [shift],
  };
};

// ── Crew payout (locked pay + payouts aggregation) ───────────────────────────
//
// Pay is agreed at HIRE. When a producer confirms a crew member, their pay for
// each confirmed day is computed once and stamped onto the positions as a `pay`
// snapshot — so a later rate-card edit, minimum change, or schedule tweak can't
// silently rewrite what someone was hired at. The Payouts tab reads snapshots
// (never live math) as the payable figure, and shows a recomputed value next to
// a locked one only to flag drift for an explicit re-lock.

// ONE person's pay for ONE project-day, from their CONFIRMED positions only —
// requested/accepted shifts aren't owed money. dayItems are that date's schedule
// items; the engine merges the person's shifts (OT + meal penalty run over their
// combined hours) exactly as billing does. Returns null when the person has no
// confirmed, timed work that day.
window.LTP_crewDayPay = function(dayItems, crewId, services, crewMins) {
  var items = (dayItems || []).map(function(s) {
    return { time: s.time, endTime: s.endTime, breaks: s.breaks,
      positions: (s.positions || []).filter(function(p) { return p && p.crewId === crewId && p.status === "confirmed"; }) };
  }).filter(function(s) { return s.positions.length > 0; });
  if (!items.length) return null;
  var day = window.LTP_calcDayLabor(items, services, crewMins);
  if (!day.units.length) return null;
  // Every figure here is the PAY side: costTier/costHours/costOtHours, which
  // equal the billing fields unless a client minimum differs from the payout
  // minimum. A client's billing guarantee must never inflate a crew payout.
  var paidHours = 0, otHours = 0, mealPenaltyHours = 0;
  var units = day.units.map(function(u) {
    var uHours = u.costHours != null ? u.costHours : u.paidHours;
    var uOt = u.costOtHours != null ? u.costOtHours : u.otHours;
    paidHours += uHours; otHours += uOt; mealPenaltyHours += u.mealPenaltyHours;
    return { serviceId: u.serviceId, tier: u.costTier || u.tier, paidHours: uHours, otHours: uOt,
      dayCost: u.dayCost, otCost: u.otCost, minApplied: u.minApplied,
      minHoursApplied: !!u.minCostHoursApplied, fullMargin: u.fullMargin, total: u.costTotal };
  });
  return {
    total: day.costTotal,
    paidHours: Math.round(paidHours * 100) / 100,
    otHours: Math.round(otHours * 100) / 100,
    mealPenaltyHours: Math.round(mealPenaltyHours * 100) / 100,
    tier: units.length === 1 ? units[0].tier : "mixed",
    units: units,
  };
};

// Stamp `pay` snapshots onto ONE person's confirmed positions in a schedule.
// `dates` restricts which days are (re)locked — the caller passes exactly the
// days its action touched, so confirming new work never silently re-locks an
// unrelated day whose rates have since changed (that would erase drift the
// producer should see). Omit dates to lock every day with confirmed work (the
// Payouts tab's explicit per-day Lock passes a single date). Returns a new
// schedule; items without changes are passed through untouched.
window.LTP_stampPay = function(schedule, crewId, services, crewMins, lockedAt, dates) {
  var only = null;
  if (dates) { only = {}; dates.forEach(function(d) { only[d] = true; }); }
  var byDate = {};
  (schedule || []).forEach(function(s) {
    if (s.date && (!only || only[s.date])) (byDate[s.date] = byDate[s.date] || []).push(s);
  });
  var payByDate = {};
  Object.keys(byDate).forEach(function(d) {
    var pay = window.LTP_crewDayPay(byDate[d], crewId, services, crewMins);
    if (pay) payByDate[d] = Object.assign({ lockedAt: lockedAt }, pay);
  });
  return (schedule || []).map(function(s) {
    if (!s.date || !payByDate[s.date]) return s;
    var touched = false;
    var positions = (s.positions || []).map(function(p) {
      if (p && p.crewId === crewId && p.status === "confirmed") { touched = true; return Object.assign({}, p, { pay: payByDate[s.date] }); }
      return p;
    });
    return touched ? Object.assign({}, s, { positions: positions }) : s;
  });
};

// ── Day-of execution: actuals + sign-off ─────────────────────────────────────
//
// After the event day, a producer signs off each person-day: worked as
// scheduled, adjusted (actual times differ / a shift was dropped), or no-show.
// The sign-off is recorded as a `work` field on each of the person's confirmed
// positions that day: { state: "worked"|"adjusted"|"no_show", time?, endTime?,
// pay, signedAt, signedBy } — `pay` being the FINAL figure computed from the
// actual times at sign-off and frozen. Payout requires sign-off: a confirmed
// day with no `work` is "pending" and is not payable yet.

// ONE person's pay for ONE project-day from ACTUAL worked times: like
// LTP_crewDayPay, but no_show shifts are dropped and an adjusted position's
// work.time/work.endTime override the shift's scheduled times. Scheduled
// crew-wide breaks are kept only when they fall inside the actual window
// (a break outside what was actually worked didn't happen). Returns null when
// the person worked nothing that day (full no-show).
window.LTP_crewDayActuals = function(dayItems, crewId, services, crewMins) {
  var items = [];
  (dayItems || []).forEach(function(s) {
    var pos = (s.positions || []).filter(function(p) {
      return p && p.crewId === crewId && p.status === "confirmed" && !(p.work && p.work.state === "no_show");
    });
    if (!pos.length) return;
    var adj = pos.find(function(p) { return p.work && p.work.state === "adjusted" && p.work.time && p.work.endTime; });
    var time = adj ? adj.work.time : s.time;
    var endTime = adj ? adj.work.endTime : s.endTime;
    var breaks = s.breaks || [];
    if (adj && endTime > time) { // clip on adjusted, plain "HH:MM" compare (non-overnight)
      breaks = breaks.filter(function(b) { return b.startTime >= time && b.endTime <= endTime; });
    }
    items.push({ time: time, endTime: endTime, breaks: breaks, positions: pos });
  });
  if (!items.length) return null;
  var day = window.LTP_calcDayLabor(items, services, crewMins);
  if (!day.units.length) return null;
  // Every figure here is the PAY side: costTier/costHours/costOtHours, which
  // equal the billing fields unless a client minimum differs from the payout
  // minimum. A client's billing guarantee must never inflate a crew payout.
  var paidHours = 0, otHours = 0, mealPenaltyHours = 0;
  var units = day.units.map(function(u) {
    var uHours = u.costHours != null ? u.costHours : u.paidHours;
    var uOt = u.costOtHours != null ? u.costOtHours : u.otHours;
    paidHours += uHours; otHours += uOt; mealPenaltyHours += u.mealPenaltyHours;
    return { serviceId: u.serviceId, tier: u.costTier || u.tier, paidHours: uHours, otHours: uOt,
      dayCost: u.dayCost, otCost: u.otCost, minApplied: u.minApplied,
      minHoursApplied: !!u.minCostHoursApplied, fullMargin: u.fullMargin, total: u.costTotal };
  });
  return {
    total: day.costTotal,
    paidHours: Math.round(paidHours * 100) / 100,
    otHours: Math.round(otHours * 100) / 100,
    mealPenaltyHours: Math.round(mealPenaltyHours * 100) / 100,
    tier: units.length === 1 ? units[0].tier : "mixed",
    units: units,
  };
};

// Sign off ONE person's day. `actuals` maps positionId → { state, time?,
// endTime? }; positions not in the map are "worked" (as scheduled). Applies the
// work states, computes the final pay from the actual times (current rates +
// minimums — the drift flag warns the producer of rate changes BEFORE signing;
// signing is the final agreement act), and freezes it as work.pay on every one
// of the person's confirmed positions that day. Returns a new schedule.
window.LTP_signOffDay = function(schedule, crewId, date, actuals, services, crewMins, signedAt, signedBy) {
  var isMine = function(s, p) { return s.date === date && p && p.crewId === crewId && p.status === "confirmed"; };
  var draft = (schedule || []).map(function(s) {
    if (s.date !== date) return s;
    return Object.assign({}, s, { positions: (s.positions || []).map(function(p) {
      if (!isMine(s, p)) return p;
      var a = actuals && actuals[p.id];
      var work = { state: "worked", signedAt: signedAt, signedBy: signedBy };
      if (a && a.state === "no_show") work.state = "no_show";
      else if (a && a.state === "adjusted" && a.time && a.endTime) { work.state = "adjusted"; work.time = a.time; work.endTime = a.endTime; }
      return Object.assign({}, p, { work: work });
    }) });
  });
  var pay = window.LTP_crewDayActuals(draft.filter(function(s) { return s.date === date; }), crewId, services, crewMins)
    || { total: 0, paidHours: 0, otHours: 0, mealPenaltyHours: 0, tier: "", units: [] };
  return draft.map(function(s) {
    if (s.date !== date) return s;
    return Object.assign({}, s, { positions: (s.positions || []).map(function(p) {
      if (!isMine(s, p)) return p;
      return Object.assign({}, p, { work: Object.assign({}, p.work, { pay: pay }) });
    }) });
  });
};

// Set the pay adjustments for ONE person's day: extras or deductions agreed for
// situations on the shift (parking, gear rental, bonus, an advance taken, …).
// `adjustments` = [{ id, amount, label, addedAt?, addedBy? }] — amount may be
// negative. Stored as `adj` on each of the person's confirmed positions that
// day (same ride-along pattern as `pay`/`work`); an empty list clears it.
// Adjustments are independent of sign-off: they add on top of the estimate
// before signing and on top of the frozen figure after.
window.LTP_setPayAdjustments = function(schedule, crewId, date, adjustments) {
  var clean = (adjustments || []).filter(function(a) { return a && typeof a.amount === "number" && !isNaN(a.amount) && a.amount !== 0; });
  return (schedule || []).map(function(s) {
    if (s.date !== date) return s;
    var touched = false;
    var positions = (s.positions || []).map(function(p) {
      if (p && p.crewId === crewId && p.status === "confirmed") {
        touched = true;
        var copy = Object.assign({}, p);
        if (clean.length) copy.adj = clean; else delete copy.adj;
        return copy;
      }
      return p;
    });
    return touched ? Object.assign({}, s, { positions: positions }) : s;
  });
};

// Read back what LTP_setPayAdjustments stored, for ONE person's day.
//
// Matches domain-payouts.js's rollup exactly — same day, same person, confirmed
// positions only, first non-empty list wins — so an editor reading this and a
// payout row reading that can never disagree about what is on the day.
window.LTP_getPayAdjustments = function(schedule, crewId, date) {
  var found = null;
  (schedule || []).forEach(function(s) {
    if (!s || s.date !== date || found) return;
    (s.positions || []).forEach(function(p) {
      if (found) return;
      if (p && p.crewId === crewId && p.status === "confirmed" && p.adj && p.adj.length) found = p.adj;
    });
  });
  return found || [];
};

// Undo a sign-off: strip `work` from the person's positions on that date so the
// day returns to pending. Returns a new schedule.
window.LTP_unsignDay = function(schedule, crewId, date) {
  return (schedule || []).map(function(s) {
    if (s.date !== date) return s;
    var touched = false;
    var positions = (s.positions || []).map(function(p) {
      if (p && p.crewId === crewId && p.status === "confirmed" && p.work) {
        touched = true;
        var copy = Object.assign({}, p); delete copy.work; return copy;
      }
      return p;
    });
    return touched ? Object.assign({}, s, { positions: positions }) : s;
  });
};

// Resolve email template variables: {{varName}} → value
window.LTP_resolveTemplate = function(template, vars) {
  if (!template) return "";
  return template.replace(/\{\{(\w+)\}\}/g, function(match, key) {
    return vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : match;
  });
};

// Best-effort crew notification (POSTs to the producer notify endpoint, resolves
// to { ok, body } where body.emailStatus is { emailed, needsReconnect, error };
// NEVER rejects). The notify tray (components/crew-outbox.js) is the only caller
// — it sends a parked removal notice on demand.
// `opts` is either { positionIds } (resolve the shift list live from the
// project's current schedule — the project must still exist) or { shifts,
// projectName } (a snapshot captured at removal time — works even after the
// shifts/project are gone, which is how the notify tray sends). projectName is
// only needed when the project itself was deleted.
window.LTP_crewNotify = function(contactId, projectId, template, opts) {
  opts = opts || {};
  var payload = { contactId: contactId, projectId: projectId, template: template };
  if (opts.shifts) { payload.shifts = opts.shifts; if (opts.projectName) payload.projectName = opts.projectName; }
  else { payload.positionIds = opts.positionIds || []; }
  // The crew-request token lets the confirmation email link back to the crew
  // call sheet (where the "Add to Calendar" buttons live).
  if (opts.token) payload.token = opts.token;
  return fetch("/api/crew-requests/notify", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(function(r) {
    return r.json().then(function(j) { return { ok: r.ok, body: j }; },
                        function() { return { ok: r.ok, body: {} }; });
  }, function(e) { return { ok: false, body: { error: String(e) } }; });
};

// Crew-removal notification helpers. A removal is notified by *type*, derived
// from the shift's status when it was removed:
//   requested  → crewWithdrawn   (the request is withdrawn)
//   accepted   → crewNotSelected (they accepted but were released)
//   confirmed  → crewCancelled   (their confirmed booking is cancelled)
// Every removal path snapshots the affected shifts and parks them in the notify
// tray (components/crew-outbox.js), grouped per person+project+type, so one
// combined email per type is sent on demand — never one-per-shift.
(function() {
  function shiftSnap(shift, pos, svcById) {
    var svc = svcById[pos.serviceId];
    var roleLabel = svc
      ? ((svc.role || "") + (svc.description ? " — " + svc.description : "")).replace(/^\s*—\s*|\s*—\s*$/g, "").trim()
      : (pos.role || "");
    return {
      positionId: pos.id, roleLabel: roleLabel || "Crew",
      department: svc ? (svc.department || "") : "", status: pos.status,
      shiftTitle: shift.title || "", date: shift.date || "",
      startTime: shift.time || "", endTime: shift.endTime || "",
    };
  }

  // Snapshot the named positions out of a (still-live) schedule into the shape
  // the notify email renders — so the email survives the positions being deleted.
  window.LTP_shiftSnapshots = function(schedule, positionIds, services) {
    var ids = {}; (positionIds || []).forEach(function(id) { ids[id] = true; });
    var svcById = {}; (services || []).forEach(function(s) { svcById[s.id] = s; });
    var out = [];
    (schedule || []).forEach(function(sh) {
      (sh.positions || []).forEach(function(p) { if (ids[p.id]) out.push(shiftSnap(sh, p, svcById)); });
    });
    return out;
  };

  window.LTP_removalTemplate = function(status) {
    return status === "confirmed" ? "crewCancelled" : status === "accepted" ? "crewNotSelected" : "crewWithdrawn";
  };

  // Diff two schedule snapshots; return the crew who LOST an active assignment
  // (position removed, day deleted, or reassigned away), bucketed per person AND
  // per notice type with the snapshotted shifts. Returns
  // [{ crewId, crewName, template, shifts: [...] }] — park each into the tray.
  window.LTP_diffRemovedCrew = function(before, after, contacts, services) {
    var ACTIVE = { requested: 1, accepted: 1, confirmed: 1 };
    var svcById = {}; (services || []).forEach(function(s) { svcById[s.id] = s; });
    var afterById = {};
    (after || []).forEach(function(s) {
      (s.positions || []).forEach(function(p) { afterById[p.id] = p.crewId || null; });
    });
    var groups = {};  // "crewId:template"
    (before || []).forEach(function(sh) {
      (sh.positions || []).forEach(function(p) {
        if (!p.crewId || !ACTIVE[p.status]) return;
        var stillThere = Object.prototype.hasOwnProperty.call(afterById, p.id);
        if (stillThere && afterById[p.id] === p.crewId) return;  // still theirs
        var template = window.LTP_removalTemplate(p.status);
        var k = p.crewId + ":" + template;
        if (!groups[k]) {
          var cm = (contacts || []).find(function(c) { return c.id === p.crewId; });
          groups[k] = { crewId: p.crewId, crewName: cm ? (cm.firstName + " " + cm.lastName).trim() : "Crew", template: template, shifts: [] };
        }
        groups[k].shifts.push(shiftSnap(sh, p, svcById));
      });
    });
    return Object.keys(groups).map(function(k) { return groups[k]; });
  };

  // Diff two schedule snapshots; return the crew whose STILL-HELD active
  // assignment had its shift MOVED (call/wrap/date changed while the position and
  // its crew member stayed put), bucketed per person with the new times plus the
  // previous ones. Mirrors LTP_diffRemovedCrew but for reschedules — the two are
  // disjoint by construction: a removed/reassigned position is caught by
  // diffRemovedCrew (it's gone from `after` or held by someone else), and only a
  // surviving, same-crew position can be a reschedule here. Returns
  // [{ crewId, crewName, template:"crewScheduleChanged",
  //    shifts:[{...snap, prevDate, prevStartTime, prevEndTime}] }] — park each
  // into the notify tray. A shift whose date was CLEARED is skipped: that's an
  // auto-withdrawal handled server-side (crew_integrity), not a reschedule.
  window.LTP_diffChangedShifts = function(before, after, contacts, services) {
    var ACTIVE = { requested: 1, accepted: 1, confirmed: 1 };
    var svcById = {}; (services || []).forEach(function(s) { svcById[s.id] = s; });
    var afterPos = {};  // position id -> { crewId, shift } in the after schedule
    (after || []).forEach(function(sh) {
      (sh.positions || []).forEach(function(p) { afterPos[p.id] = { crewId: p.crewId || null, shift: sh }; });
    });
    var groups = {};  // "crewId"
    (before || []).forEach(function(sh) {
      (sh.positions || []).forEach(function(p) {
        if (!p.crewId || !ACTIVE[p.status]) return;
        var a = afterPos[p.id];
        if (!a || a.crewId !== p.crewId) return;          // removed or reassigned — a removal, not a reschedule
        var as = a.shift;
        if (!((as.date || "").trim())) return;             // date cleared — withdrawal, handled elsewhere
        var moved = (sh.time || "") !== (as.time || "")
                 || (sh.endTime || "") !== (as.endTime || "")
                 || (sh.date || "") !== (as.date || "");
        if (!moved) return;
        var k = String(p.crewId);
        if (!groups[k]) {
          var cm = (contacts || []).find(function(c) { return c.id === p.crewId; });
          groups[k] = { crewId: p.crewId, crewName: cm ? (cm.firstName + " " + cm.lastName).trim() : "Crew", template: "crewScheduleChanged", shifts: [] };
        }
        var snap = shiftSnap(as, p, svcById);              // new date/time from the after shift
        snap.prevDate = sh.date || "";
        snap.prevStartTime = sh.time || "";
        snap.prevEndTime = sh.endTime || "";
        groups[k].shifts.push(snap);
      });
    });
    return Object.keys(groups).map(function(k) { return groups[k]; });
  };
})();

// A schedule row is worth keeping if ANYTHING was entered into the day — a
// title, date, end-date, start/end time, crew positions, or breaks. Titles
// are optional and a day added via "Add Day" starts with an empty date, so
// filtering on title (or even title/date/crew) alone silently discarded days
// that had only times entered. Only a truly empty row object is dropped.
// Used by the schedule builder and the project form's Save + validation.
window.LTP_scheduleRowHasContent = function(s) {
  if (!s) return false;
  return !!(
    (s.title && String(s.title).trim()) ||
    (s.date && String(s.date).trim()) ||
    (s.endDate && String(s.endDate).trim()) ||
    (s.time && String(s.time).trim()) ||
    (s.endTime && String(s.endTime).trim()) ||
    (Array.isArray(s.positions) && s.positions.length > 0) ||
    (Array.isArray(s.breaks) && s.breaks.length > 0)
  );
};

// Repair each schedule row's endDate before validating/saving. The schedule
// editor exposes no endDate input, so a stale or half-typed value (e.g. a
// "0002-08-14" frozen mid-keystroke by the old date-input handler, or the
// original day left behind after a shift was moved) is impossible for the
// user to see or fix — and the project form's range validation would reject
// the save against that invisible date. Rules: no date → no endDate; an
// endDate before the date is nonsense → snap to the date; a missing endDate
// on a dated row → the date (single-day). A deliberate multi-day span
// (endDate after date) is preserved. Used by the project form's Save.
window.LTP_normalizeScheduleRows = function(rows) {
  return (rows || []).map(function(s) {
    if (!s || typeof s !== "object") return s;
    if (!s.date) {
      return s.endDate ? Object.assign({}, s, { endDate: "" }) : s;
    }
    if (!s.endDate || s.endDate < s.date) {
      return Object.assign({}, s, { endDate: s.date });
    }
    return s;
  });
};

// Detect crew double-bookings across projects
window.LTP_detectCrewConflicts = function(projects) {
  var bookings = {};
  (projects || []).forEach(function(proj) {
    (proj.schedule || []).forEach(function(s) {
      if (!s.date) return;
      (s.positions || []).forEach(function(p) {
        if (!p.crewId || p.status === "declined") return;
        var key = p.crewId + "|" + s.date;
        if (!bookings[key]) bookings[key] = [];
        bookings[key].push({ projectId: proj.id, projectName: proj.name, schedTitle: s.title, schedItemId: s.id, posId: p.id, status: p.status, date: s.date, crewId: p.crewId, serviceId: p.serviceId });
      });
    });
  });
  var conflicts = {};
  Object.keys(bookings).forEach(function(key) {
    var b = bookings[key];
    if (b.length < 2) return;
    // Cross-project: different projectIds
    var projectIds = {};
    b.forEach(function(bk) { projectIds[bk.projectId] = true; });
    var hasCrossProject = Object.keys(projectIds).length >= 2;
    // Same-project duplicate: same person on different roles in same project+date
    var hasSameProjectDupe = false;
    var byProject = {};
    b.forEach(function(bk) {
      if (!byProject[bk.projectId]) byProject[bk.projectId] = {};
      byProject[bk.projectId][bk.serviceId || bk.posId] = true;
    });
    Object.keys(byProject).forEach(function(pid) {
      if (Object.keys(byProject[pid]).length >= 2) hasSameProjectDupe = true;
    });
    if (hasCrossProject || hasSameProjectDupe) {
      b.forEach(function(bk) {
        // A CONFIRMED position is settled — the producer locked it in knowing
        // the day's picture, so the double-booking is purposeful and it is
        // never flagged itself. It still appears in the OTHER side's list, so
        // an unsettled position sharing the day with confirmed work keeps its
        // warning until it's confirmed (or released) too.
        if (bk.status === "confirmed") return;
        conflicts[bk.posId] = b.filter(function(o) { return o.posId !== bk.posId; });
      });
    }
  });
  return conflicts;
};
