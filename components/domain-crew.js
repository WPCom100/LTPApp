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
// and so the aggregation is unit-testable — tests/test_doc_projects.js and
// tests/test_fixed_positions.js.
//
// Every line and section it returns carries a `laborSync` marker — the memory
// that lets a document be brought back in step with the schedule later
// (components/domain-labor-sync.js). On a line:
//   { projectId, key, at, snap: { qty, unitPrice, cost, notes, dates } }
//   key    the line's identity across regenerations — "svc:<serviceId>|<rateType>"
//          for a pooled day/half/hourly/ot line, "flat:<positionId>" for a
//          flat-rate position, "cancel:<positionId>" for a cancelled position
//          (shift or flat-rate) that still charges the client its share.
//          Re-running this function on the changed
//          schedule yields the same keys, which is what makes a line-level
//          diff possible without changing what the client sees.
//   snap   what the schedule produced when the line was last written or
//          acknowledged; `dates` are the ISO days behind the `notes` text.
// On a section: { projectId, grouping: "one"|"dept", dept?, ignored: {} } —
// where a NEW line for the project lands, and the keys the producer chose not
// to add. A line with no marker is a hand-added line and is never touched.
//
// Billing model, unchanged from the original Send-to-Quote: each DAY is priced
// per ROLE, not per position. A role spread over several items on one day is
// one day rate sized by its max concurrent count, rated over the role's actual
// worked span. LTP_calcDayLabor owns that math; this function only aggregates
// its per-role output across days into line items — day rates keyed role+tier,
// OT pooled by role, and an HOURLY role's straight hours pooled by role the
// same way (one "hourly" line, qty = hours; it never produces a day-rate line).
//
//   schedule  the project's schedule rows (already saved — the caller gates on
//             dirty state, since a day's times drive its price)
//   svcs      the CLIENT-resolved rate card (LTP_servicesForClient), never the
//             raw catalog, so a negotiated rate lands on the document
//   crewMins  LTP_crewMinMap(contacts) — per-crew payout floors, cost side only
//   grouping  "one" → a single "Labor" section; anything else → one section per
//             department
//   fmtDate   date formatter for each line's "which days" note (LTP_formatDate)
//   fixedPositions  the project's flat-rate positions (optional) — each with
//             a rate-card role and a bill amount > 0 becomes ONE "flat" line:
//             qty 1 at the bill amount, cost = the fee ($0 full-margin)
//
// A CANCELLED position never bills through the day pools (LTP_withoutCancelled);
// when its cancellation charges the client a share it is billed on a line of
// its own — rateType "cancel", qty 1 at that share (see cancelLine below).
//
// Returns [] when the schedule bills nothing — no dated+timed day carries a
// position with a serviceId, no flat-rate position bills the client, and no
// cancellation charges anything. Callers treat that as "nothing to send".
// The order the lines are read in, on a quote or an invoice: letters-only
// positions first (PM, SPOT, LD, SM), then numbered ones (L1, L2, L3), each
// group alphabetical (LTP_compareRoleGroups); every position's lines sit
// together, largest unit first — flat (the whole project), day, half day, then
// hours (hourly, then overtime), and a cancelled call's charge last.
// a/b: { role, description, rateType }.
var _RATE_TYPE_ORDER = { flat: 0, day: 1, half: 2, hourly: 3, ot: 4, cancel: 5 };
window.LTP_compareLaborLines = function(a, b) {
  var ra = _RATE_TYPE_ORDER[a && a.rateType], rb = _RATE_TYPE_ORDER[b && b.rateType];
  return window.LTP_compareRoleGroups(a && a.role, b && b.role)
    || String((a && a.description) || "").localeCompare(String((b && b.description) || ""), "en", { sensitivity: "base" })
    || ((ra == null ? 9 : ra) - (rb == null ? 9 : rb));
};

//   projectId  stamped into every marker so a document holding several jobs'
//             labor can be checked one project at a time (null = unknown; the
//             marker is still written, it just never matches a project)
//   nowIso     the marker's `at` timestamp (defaults to now; tests pass a
//             fixed value so output is deterministic)
window.LTP_scheduleLaborSections = function(schedule, svcs, crewMins, grouping, fmtDate, genId, fixedPositions, projectId, nowIso) {
  var gen = genId || window.LTP_genId;
  var fmt = fmtDate || function(d) { return d; };
  var pid = projectId != null ? projectId : null;
  var now = nowIso || new Date().toISOString();

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
  var hourlyItems = {};

  Object.keys(dateGroups).forEach(function(dateKey) {
    var g = dateGroups[dateKey];
    if (!g.dayCall || !g.dayWrap) return;
    var dayLabel = g.date !== "_unscheduled" ? fmt(g.date) : "TBD";
    var isoDate = g.date !== "_unscheduled" ? g.date : "";
    // Each pooled line remembers the days behind it twice: the formatted
    // labels that become its `notes`, and the ISO dates for the sync marker.
    function noteDay(li) {
      if (li.dates.indexOf(dayLabel) === -1) li.dates.push(dayLabel);
      if (isoDate && li.iso.indexOf(isoDate) === -1) li.iso.push(isoDate);
    }

    // Cancelled positions are billed below, one line each, from their own
    // cancellation record — never through the day pools.
    window.LTP_calcDayLabor(window.LTP_withoutCancelled(g.items), svcs, crewMins).units.forEach(function(u) {
      if (u.tier === "hourly") {
        // An hourly role: this person's straight hours join ONE line for the
        // role (qty = hours across every person and day, like the OT pool
        // below). u.dayRate / u.dayCost are the PER-HOUR figures on an hourly
        // unit; the cost is blended per hour so a full-margin person's hours
        // cost $0. OT still lands on the shared OT line further down.
        var hKey = u.serviceId;
        if (!hourlyItems[hKey]) {
          hourlyItems[hKey] = { svc: u.svc, rate: u.dayRate, rateHours: 0, costAccum: 0, dates: [], iso: [],
                               dept: u.svc.department || "Other", minHours: u.minHours || 0, minApplied: false };
        }
        if (u.minHoursApplied) hourlyItems[hKey].minApplied = true;
        hourlyItems[hKey].rateHours = Math.round((hourlyItems[hKey].rateHours + u.straightHours) * 100) / 100;
        hourlyItems[hKey].costAccum = Math.round((hourlyItems[hKey].costAccum + (u.fullMargin ? 0 : u.dayCost * u.straightHours)) * 100) / 100;
        noteDay(hourlyItems[hKey]);
      } else {
        // Each unit is one person. The day-rate line aggregates units of the same
        // role+tier (qty = how many people); costAccum adds $0 for a full-margin
        // unit so its rate is pure margin. Per-unit cost is blended at build time
        // so a single line stays correct.
        var drKey = u.serviceId + "|" + u.tier;
        if (!dayRateItems[drKey]) {
          dayRateItems[drKey] = { svc: u.svc, tier: u.tier, rate: u.dayRate, qty: 0, costAccum: 0, dates: [], iso: [],
                                  dept: u.svc.department || "Other", minHours: u.minHours || 0, minApplied: false };
        }
        // A day billed up to the client's contract minimum says so on the line —
        // otherwise "Full day" against a 4-hour call reads as a mistake to
        // whoever reviews it.
        if (u.minHoursApplied) dayRateItems[drKey].minApplied = true;
        dayRateItems[drKey].qty += 1;
        dayRateItems[drKey].costAccum = Math.round((dayRateItems[drKey].costAccum + (u.fullMargin ? 0 : u.dayCost)) * 100) / 100;
        noteDay(dayRateItems[drKey]);
      }

      // OT line item — this person's own OT hours (cost $0 if full margin).
      if (u.otHours > 0) {
        var otKey = u.serviceId;
        if (!otItems[otKey]) {
          otItems[otKey] = { svc: u.svc, otRate: u.otRate, rateHours: 0, costAccum: 0, dates: [], iso: [], dept: u.svc.department || "Other" };
        }
        otItems[otKey].rateHours = Math.round((otItems[otKey].rateHours + u.otHours) * 100) / 100;
        otItems[otKey].costAccum = Math.round((otItems[otKey].costAccum + (u.fullMargin ? 0 : u.otCost * u.otHours)) * 100) / 100;
        noteDay(otItems[otKey]);
      }
    });
  });

  function dayList(dates) {
    return dates.length <= 4 ? dates.join(", ") : dates.slice(0, 3).join(", ") + " + " + (dates.length - 3) + " more";
  }

  // Build the labor line items once (identical for both groupings); each
  // carries its department so we can either split by department or pool
  // everything into a single section.
  var laborItems = [];  // [{ dept, role, description, rateType, item }] — the sort keys ride beside the line

  // Day-rate lines. Per-unit cost is the blended cost across the qty
  // (full-margin positions contribute $0), so one line carries the right margin
  // without splitting paid vs owner crew.
  Object.keys(dayRateItems).forEach(function(key) {
    var li = dayRateItems[key];
    laborItems.push({ dept: li.dept, role: li.svc.role, description: li.svc.description, rateType: li.tier === "half" ? "half" : "day",
                      key: "svc:" + li.svc.id + "|" + (li.tier === "half" ? "half" : "day"), iso: li.iso, item: {
      id: gen("item"), type: "service", serviceId: li.svc.id,
      name: li.svc.role + " — " + li.svc.description,
      rateType: li.tier === "half" ? "half" : "day",
      qty: li.qty, unitPrice: li.rate, adjustedPrice: null,
      cost: li.qty > 0 ? Math.round((li.costAccum / li.qty) * 100) / 100 : 0,
      notes: dayList(li.dates) + (li.minApplied ? " · " + li.minHours + "-hour contract minimum applied" : ""),
      deliveredQty: 0, invoicedQty: 0
    } });
  });

  // Hourly lines — one per hourly role: its straight hours across every
  // person and day at the hourly rate, blended per-hour cost. A short call
  // billed up to a client's hour minimum says so, like a day line does.
  Object.keys(hourlyItems).forEach(function(key) {
    var li = hourlyItems[key];
    if (li.rateHours <= 0) return;
    laborItems.push({ dept: li.dept, role: li.svc.role, description: li.svc.description, rateType: "hourly",
                      key: "svc:" + li.svc.id + "|hourly", iso: li.iso, item: {
      id: gen("item"), type: "service", serviceId: li.svc.id,
      name: li.svc.role + " — " + li.svc.description,
      rateType: "hourly",
      qty: li.rateHours, unitPrice: li.rate, adjustedPrice: null,
      cost: Math.round((li.costAccum / li.rateHours) * 100) / 100,
      notes: dayList(li.dates) + (li.minApplied ? " · " + li.minHours + "-hour contract minimum applied" : ""),
      deliveredQty: 0, invoicedQty: 0
    } });
  });

  // OT lines (blended per-hour cost; margin OT hours cost $0).
  Object.keys(otItems).forEach(function(key) {
    var li = otItems[key];
    if (li.rateHours <= 0) return;
    laborItems.push({ dept: li.dept, role: li.svc.role, description: li.svc.description, rateType: "ot",
                      key: "svc:" + li.svc.id + "|ot", iso: li.iso, item: {
      id: gen("item"), type: "service", serviceId: li.svc.id,
      name: li.svc.role + " — " + li.svc.description,
      rateType: "ot",
      qty: li.rateHours, unitPrice: li.otRate, adjustedPrice: null,
      cost: li.rateHours > 0 ? Math.round((li.costAccum / li.rateHours) * 100) / 100 : 0,
      notes: "Overtime hours: " + dayList(li.dates), deliveredQty: 0, invoicedQty: 0
    } });
  });

  // Flat-rate positions: one line each, after the hourly lines. The note
  // spans the project's scheduled dates (no times — the hire sets their own).
  var svcById = {}; (svcs || []).forEach(function(sv) { svcById[sv.id] = sv; });
  var dated = (schedule || []).map(function(s) { return s && s.date; }).filter(Boolean).sort();
  var datedUnique = dated.filter(function(d, i) { return dated.indexOf(d) === i; });
  // A multi-day row (endDate after date) extends the span to its last day.
  var lastDay = (schedule || []).reduce(function(m, s) { var e = s && s.endDate; return (e && e > m) ? e : m; }, dated.length ? dated[dated.length - 1] : "");
  var span = dated.length ? (dated[0] === lastDay ? fmt(dated[0]) : fmt(dated[0]) + " – " + fmt(lastDay)) : "";
  (fixedPositions || []).forEach(function(p) {
    if (!p || !p.serviceId) return;
    if (p.status === "cancelled") return;   // billed below as a cancellation, at its share
    var svc = svcById[p.serviceId];
    if (!svc) return;
    var bill = Math.round((Number(p.bill) || 0) * 100) / 100;
    if (bill <= 0) return;   // absorbed in a package price — nothing to bill separately
    laborItems.push({ dept: svc.department || "Other", role: svc.role, description: svc.description, rateType: "flat",
                      key: "flat:" + (p.id != null ? p.id : ""), iso: datedUnique, item: {
      id: gen("item"), type: "service", serviceId: svc.id,
      name: svc.role + " — " + svc.description,
      rateType: "flat",
      qty: 1, unitPrice: bill, adjustedPrice: null,
      cost: p.fullMargin ? 0 : Math.round((Number(p.fee) || 0) * 100) / 100,
      notes: "Flat-rate position" + (span ? " · " + span : ""),
      deliveredQty: 0, invoicedQty: 0
    } });
  });

  // Cancelled positions (see "Cancellation" below): each one that still
  // charges the client is its own line — qty 1 at the bill share chosen when
  // it was cancelled — keyed on the POSITION, so the sync review shows the
  // day it came out of and the cancellation it became side by side, and the
  // producer can take either, both or neither. A flat-rate position is
  // handled the same way: its flat line drops out (skipped above) and a
  // cancellation line takes its place. The note is also what the client reads
  // beside the line (backend/doc_units.py::line_detail): the day and the
  // percentage charged — decision 9 in docs/LABOR_SYNC_PLAN.md.
  function cancelLine(p, svc, isoDate) {
    var c = p.cancel;
    var bill = Math.round((Number(c && c.bill && c.bill.total) || 0) * 100) / 100;
    if (bill <= 0) return;   // cancelled at no charge — nothing to bill
    var pay = Math.round((Number(c.pay && c.pay.total) || 0) * 100) / 100;
    laborItems.push({ dept: svc.department || "Other", role: svc.role, description: svc.description, rateType: "cancel",
                      key: "cancel:" + (p.id != null ? p.id : ""), iso: isoDate ? [isoDate] : [], item: {
      id: gen("item"), type: "service", serviceId: svc.id,
      name: svc.role + " — " + svc.description,
      rateType: "cancel",
      qty: 1, unitPrice: bill, adjustedPrice: null,
      cost: p.fullMargin ? 0 : pay,
      notes: window.LTP_cancellationNote(c, isoDate),
      deliveredQty: 0, invoicedQty: 0
    } });
  }
  (schedule || []).forEach(function(s) {
    ((s && s.positions) || []).forEach(function(p) {
      if (!p || p.status !== "cancelled" || !p.cancel || !p.serviceId) return;
      var svc = svcById[p.serviceId];
      if (svc) cancelLine(p, svc, s.date || "");
    });
  });
  (fixedPositions || []).forEach(function(p) {
    if (!p || p.status !== "cancelled" || !p.cancel || !p.serviceId) return;
    var svc = svcById[p.serviceId];
    if (svc) cancelLine(p, svc, "");
  });

  if (laborItems.length === 0) return [];

  // Read order (see LTP_compareLaborLines): letters-only positions, then
  // numbered ones, each position's lines together from the largest unit down.
  // Sorted once here so the single section and the per-department sections
  // agree, and so the split keeps each section in the same order.
  laborItems.sort(window.LTP_compareLaborLines);

  // The sync marker (see the header comment): the line's identity plus a
  // snapshot of what the schedule just said, so a later diff can tell a
  // schedule change from a hand edit. Stamped after the sort so every line,
  // pooled or flat, gets it in one place.
  laborItems.forEach(function(x) {
    x.item.laborSync = {
      projectId: pid, key: x.key, at: now,
      snap: { qty: x.item.qty, unitPrice: x.item.unitPrice, cost: x.item.cost, notes: x.item.notes,
              dates: (x.iso || []).slice().sort() },
    };
  });

  if (grouping === "one") {
    return [{ id: gen("sec"), label: "Labor", customDates: false, startDate: "", endDate: "",
              laborSync: { projectId: pid, grouping: "one", ignored: {} },
              items: laborItems.map(function(x) { return x.item; }) }];
  }
  var sectionMap = {};
  laborItems.forEach(function(x) { (sectionMap[x.dept] = sectionMap[x.dept] || []).push(x.item); });
  return Object.keys(sectionMap).map(function(dept) {
    return { id: gen("sec"), label: dept, customDates: false, startDate: "", endDate: "",
             laborSync: { projectId: pid, grouping: "dept", dept: dept, ignored: {} },
             items: sectionMap[dept] };
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
//   days: [{ date, startTime, endTime }],  // one entry per day (see below)
//   date, startTime, endTime, // single-day shorthand, read when `days` is absent
//   breaks,                   // crew-wide meal breaks, laid onto every day
//   location,                 // free-text job-site address (crew-facing)
//   notes,                    // free-text, stored as scheduleNotes
//   positions: [{ serviceId, role, crewId }]   // role = rate-card Service; crew optional
// }
// A manual shift can span several days (two days of shop cleanup, say). Each
// day becomes its own dated schedule item with its OWN copy of the positions —
// fresh ids, same role and crew — because everywhere else in the app a
// position is one person on one dated shift (requests, pay, sign-off). The
// crew-request send then bundles every day a person is on into ONE request
// and one email, since requests are per person per project. Days sort by
// date and the project runs from the first to the last.
// Positions start `status:"open"` — the same state the schedule editor mints —
// so an assigned crew member is immediately sendable as a crew request, and a
// confirmed one flows into payouts once it carries a serviceId with rates.
window.LTP_manualShiftProject = function(opts) {
  opts = opts || {};
  var genId = window.LTP_genId;
  var title = (opts.title || "").trim() || "Manual Shift";
  // A manual-shift role is always a rate-card Service (serviceId); positions
  // without one carry no rate and can't be paid, so they're dropped here — the
  // builder stays the single source of truth for what a valid position is,
  // independent of the caller.
  var roles = (opts.positions || []).filter(function(p) {
    return p && p.serviceId != null && p.serviceId !== "";
  }).map(function(p) {
    return { role: p.role || "", serviceId: p.serviceId, crewId: (p.crewId != null && p.crewId !== "") ? p.crewId : null };
  });
  // Crew-wide meal breaks — same shape the schedule editor uses. Drop any
  // without both endpoints; unpaid breaks are deducted from paid hours in pay.
  var breaksIn = (opts.breaks || []).filter(function(b) { return b && b.startTime && b.endTime; });
  var days = (Array.isArray(opts.days) && opts.days.length ? opts.days : [{ date: opts.date, startTime: opts.startTime, endTime: opts.endTime }])
    .filter(Boolean)
    .map(function(d) { return { date: d.date || "", startTime: d.startTime || "08:00", endTime: d.endTime || "18:00" }; })
    .sort(function(a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  var schedule = days.map(function(d, di) {
    return {
      id: genId("sch"),
      title: title,
      date: d.date,
      time: d.startTime,
      endDate: d.date,
      endTime: d.endTime,
      showOnCalendar: true,
      // The first day keeps the ids the caller passed (an edit round-trips
      // them); every further day gets its own, as breaks are per shift.
      breaks: breaksIn.map(function(b) {
        return { id: (di === 0 && b.id) ? b.id : genId("brk"), startTime: b.startTime, endTime: b.endTime, type: b.type === "paid" ? "paid" : "unpaid" };
      }),
      positions: roles.map(function(p) {
        return { id: genId("pos"), role: p.role, serviceId: p.serviceId, crewId: p.crewId, status: "open", fullMargin: false };
      }),
    };
  });
  var dated = days.map(function(d) { return d.date; }).filter(Boolean);
  return {
    id: opts.id,
    name: title,
    companyId: null,
    internal: true,
    category: "Labor",          // a real category so badge/color lookups resolve
    status: "in-progress",
    startDate: dated[0] || "",
    endDate: dated.length ? dated[dated.length - 1] : "",
    venue: "",
    siteAddress: opts.location || "",
    siteUseCompanyAddress: false,
    contactIds: [],
    budget: { lighting: 0, labor: 0, rentals: 0, misc: 0 },
    notes: [],
    meetings: [],
    scheduleNotes: (opts.notes || ""),
    schedule: schedule,
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
// A day the person has only CANCELLED shifts on (each with a frozen pay share,
// LTP_cancelPosition) still pays, so its adjustments ride on those positions;
// a day with any confirmed shift keeps them on the confirmed ones, as always.
// Same rule as the payout rollup (domain-payouts.js, backend/payouts.py).
function _adjTargets(schedule, crewId, date) {
  var confirmed = false, cancelled = false;
  (schedule || []).forEach(function(s) {
    if (!s || s.date !== date) return;
    (s.positions || []).forEach(function(p) {
      if (!p || p.crewId !== crewId) return;
      if (p.status === "confirmed") confirmed = true;
      else if (p.status === "cancelled" && p.work && p.work.state === "cancelled") cancelled = true;
    });
  });
  return confirmed ? "confirmed" : (cancelled ? "cancelled" : "confirmed");
}
function _isFrozenCancel(p) { return !!(p && p.status === "cancelled" && p.work && p.work.state === "cancelled"); }
function _isAdjTarget(p, crewId, target) {
  if (!p || p.crewId !== crewId) return false;
  if (target === "cancelled") return _isFrozenCancel(p);
  return p.status === "confirmed";
}
window.LTP_setPayAdjustments = function(schedule, crewId, date, adjustments) {
  var clean = (adjustments || []).filter(function(a) { return a && typeof a.amount === "number" && !isNaN(a.amount) && a.amount !== 0; });
  var target = _adjTargets(schedule, crewId, date);
  return (schedule || []).map(function(s) {
    if (s.date !== date) return s;
    var touched = false;
    var positions = (s.positions || []).map(function(p) {
      if (_isAdjTarget(p, crewId, target)) {
        touched = true;
        var copy = Object.assign({}, p);
        if (clean.length) copy.adj = clean; else delete copy.adj;
        return copy;
      }
      // The other kind of the person's positions that day never keeps a list
      // of its own: the rollup reads confirmed first, then cancelled, so a
      // stale list left there would come back the moment this one is cleared.
      if (p && p.crewId === crewId && p.adj && (p.status === "confirmed" || _isFrozenCancel(p))) {
        touched = true;
        var bare = Object.assign({}, p); delete bare.adj; return bare;
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
  // Exactly the rollup's order: the first confirmed position's list, else the
  // first frozen cancellation's.
  var confirmed = null, cancelled = null;
  (schedule || []).forEach(function(s) {
    if (!s || s.date !== date) return;
    (s.positions || []).forEach(function(p) {
      if (!p || p.crewId !== crewId || !p.adj || !p.adj.length) return;
      if (p.status === "confirmed" && !confirmed) confirmed = p.adj;
      else if (_isFrozenCancel(p) && !cancelled) cancelled = p.adj;
    });
  });
  return confirmed || cancelled || [];
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

// ── Cancellation ─────────────────────────────────────────────────────────────
//
// A shift that will not happen after someone was booked for it. The position
// stays on the schedule as `cancelled` — with its crew member, its locked
// `pay`, and a `cancel` record of what was decided — instead of being reset to
// open, which erased the booking and left the old snapshots behind for the
// next person. Two shares are chosen independently, each a percentage of a
// REFERENCE or a typed amount: what the client is charged, and what the crew
// member is paid. The reference is the shift's own full rate and cost from
// LTP_calcDayLabor at the moment of cancelling (docs/LABOR_SYNC_PLAN.md,
// decision 7) — client rate card, contract minimums, crew floors and
// full-margin all already honoured — and it is fixed once written, so a later
// edit of the shares only moves within it (the server holds a non-admin to
// that ceiling: backend/crew_integrity.py::enforce_pay_snapshot).
//
//   cancel  { at, by, byId, reason, ref: { bill, pay },
//             bill: { mode: "percent"|"amount"|"none", value, total },
//             pay:  { mode, value, total },
//             updatedAt?, updatedBy? }            (set when the shares are edited)
//
// The pay side is frozen the way a sign-off is — `work` = { state:
// "cancelled", pay: { total, tier: "cancel", units: [one unit for the role] },
// signedAt, signedBy } — so payouts, vendor bills, the paid-day guard and the
// crew portal read it through the paths they already have (domain-payouts.js,
// backend/payouts.py). The bill side is read by the schedule → document
// generator, which bills a cancelled position as its own "cancellation" line
// and leaves it out of the day pools. A position with no crew member has no
// pay side at all; a full-margin one is paid $0, as it would be for work.

// Whether a cancellation pays the person on the position: only someone
// committed to the call — confirmed, or accepted (they said yes and held the
// date). A request still unanswered, a slot never sent, or a decline pays
// nothing, though the client can still be charged for the role. A position
// already cancelled was committed exactly when its pay was frozen.
function _cancelPaysCrew(p) {
  return !!p && p.crewId != null
    && (p.status === "confirmed" || p.status === "accepted" || (p.status === "cancelled" && !!p.work));
}

// This shift's own full bill rate and pay cost — the reference the shares are
// taken from. { bill: 0, pay: 0 } when the shift can't be priced (no times,
// no role on the card); pay 0 when nobody committed is on it or it is full
// margin.
window.LTP_cancelReference = function(shift, position, services, crewMins) {
  if (!shift || !position || !position.serviceId) return { bill: 0, pay: 0 };
  var day = window.LTP_calcDayLabor(
    [{ time: shift.time, endTime: shift.endTime, breaks: shift.breaks || [], positions: [position] }], services, crewMins);
  var u = day && day.units && day.units[0];
  if (!u) return { bill: 0, pay: 0 };
  return { bill: Math.round((u.rateTotal || 0) * 100) / 100,
           pay: (position.fullMargin || !_cancelPaysCrew(position)) ? 0 : Math.round((u.costTotal || 0) * 100) / 100 };
};

// One share: a percentage of the reference, a typed amount, or nothing.
window.LTP_cancelShare = function(ref, mode, value) {
  var r = Math.max(0, Number(ref) || 0), v = Number(value) || 0;
  if (mode === "none") return 0;
  if (mode === "amount") return Math.max(0, Math.round(v * 100) / 100);
  return Math.max(0, Math.round(r * v) / 100);
};

// What one side's share comes to as a percentage of its reference, as display
// text ("50", "41.7") — the chosen percent, or what a typed amount works out
// to. "" when there is nothing to measure against (no reference, no share).
window.LTP_cancelSharePct = function(side, ref) {
  if (!side || side.mode === "none") return "";
  var pct;
  if (side.mode === "amount") {
    var r = Number(ref) || 0;
    if (r <= 0) return "";
    pct = (Number(side.total) || 0) / r * 100;
  } else {
    pct = Number(side.value) || 0;
  }
  var rounded = Math.round(pct * 10) / 10;
  return String(rounded === 0 ? 0 : rounded);
};

// The note a cancellation line carries on a quote or invoice — and the aside
// the client reads beside it on the PDF and the online view
// (backend/doc_units.py::line_detail): "Cancelled Jun 5 · 50% charged". The
// owner chose to show the percentage (docs/LABOR_SYNC_PLAN.md, decision 9).
// isoDate is the cancelled shift's date ("" for a flat-rate position or an
// undated shift). The day is written short and without the year on purpose:
// the note prints after the line's name in the PDF's item column, and a long
// date ("August 11th, 2026") pushed the percentage off the end. Built from the
// ISO parts, not the locale, so it reads the same everywhere.
var _CANCEL_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function _cancelDay(isoDate) {
  var p = String(isoDate || "").split("-");
  if (p.length !== 3) return isoDate || "";
  var m = parseInt(p[1], 10), d = parseInt(p[2], 10);
  return (m >= 1 && m <= 12 && d > 0) ? _CANCEL_MONTHS[m - 1] + " " + d : isoDate;
}
window.LTP_cancellationNote = function(cancel, isoDate) {
  var pct = window.LTP_cancelSharePct(cancel && cancel.bill, cancel && cancel.ref && cancel.ref.bill);
  var day = _cancelDay(isoDate);
  return "Cancelled" + (day ? " " + day : "") + (pct !== "" ? " · " + pct + "% charged" : "");
};

// The schedule-activity detail for a cancellation: "Jane Doe · bill 50%
// $300.00 · pay 50% $175.00" (docs/LABOR_SYNC_PLAN.md, B4). A typed amount
// reads as the amount alone; with nobody booked there is no pay side.
window.LTP_cancelActivityDetail = function(crewName, cancel) {
  cancel = cancel || {};
  function side(label, sd) {
    if (!sd || sd.mode === "none") return label + " none";
    return label + " " + (sd.mode === "amount" ? "" : (Number(sd.value) || 0) + "% ") + "$" + window.LTP_money(Number(sd.total) || 0);
  }
  var parts = [crewName || "Unassigned", side("bill", cancel.bill)];
  if (crewName) parts.push(side("pay", cancel.pay));
  return parts.join(" \u00b7 ");
};

// What a save did to one position's cancellation, for the schedule builder's
// activity log: { what: "Cancelled" | "Cancellation Edited" | "Restored",
// detail } — or null when its cancellation didn't change.
window.LTP_cancelChange = function(before, after, crewName) {
  var was = !!before && before.status === "cancelled", is = !!after && after.status === "cancelled";
  if (!was && is) return { what: "Cancelled", detail: window.LTP_cancelActivityDetail(crewName, after.cancel) };
  if (was && after && !is) return { what: "Restored", detail: (crewName || "Unassigned") + " \u00b7 back to " + after.status };
  if (was && is) {
    var a = before.cancel || {}, b = after.cancel || {};
    if (JSON.stringify([a.bill, a.pay]) !== JSON.stringify([b.bill, b.pay])) {
      return { what: "Cancellation Edited", detail: window.LTP_cancelActivityDetail(crewName, b) };
    }
  }
  return null;
};

// The frozen pay for a cancelled position, in the shape a sign-off writes.
window.LTP_cancelWork = function(position, payTotal, signedAt, signedBy) {
  var total = Math.round((Number(payTotal) || 0) * 100) / 100;
  return { state: "cancelled", signedAt: signedAt || "", signedBy: signedBy || "",
    pay: { total: total, paidHours: 0, otHours: 0, mealPenaltyHours: 0, tier: "cancel",
           units: [{ serviceId: position ? position.serviceId : null, tier: "cancel", paidHours: 0, otHours: 0,
                     dayCost: total, otCost: 0, minApplied: false, minHoursApplied: false,
                     fullMargin: !!(position && position.fullMargin), total: total }] } };
};

// The dialog's pre-fill (decision 8): Settings → cancellationDefaultBillPct /
// cancellationDefaultPayPct, 50 / 50 when unset.
window.LTP_cancelDefaults = function(settings) {
  var s = settings || {};
  function pct(v, d) { var n = Number(v); return (v == null || v === "" || isNaN(n)) ? d : Math.max(0, n); }
  return { bill: { mode: "percent", value: pct(s.cancellationDefaultBillPct, 50) },
           pay:  { mode: "percent", value: pct(s.cancellationDefaultPayPct, 50) } };
};

// Build the cancelled position from the shares chosen. `ref` is the fixed
// reference; a position already cancelled keeps its original at/by/byId and
// records the edit alongside.
function _cancelledPosition(position, ref, shares, meta) {
  shares = shares || {}; meta = meta || {};
  var hasCrew = _cancelPaysCrew(position);
  var bill = shares.bill || { mode: "percent", value: 0 };
  var pay = (hasCrew && !position.fullMargin) ? (shares.pay || { mode: "percent", value: 0 }) : { mode: "none", value: 0 };
  var billTotal = window.LTP_cancelShare(ref.bill, bill.mode, bill.value);
  var payTotal = hasCrew ? window.LTP_cancelShare(ref.pay, pay.mode, pay.value) : 0;
  var prior = position.cancel;
  var cancel = prior
    ? Object.assign({}, prior, { updatedAt: meta.at || "", updatedBy: meta.by || "",
                                 reason: meta.reason != null ? meta.reason : (prior.reason || "") })
    : { at: meta.at || "", by: meta.by || "", byId: meta.byId != null ? meta.byId : null, reason: meta.reason || "" };
  cancel.ref = { bill: ref.bill, pay: ref.pay };
  cancel.bill = { mode: bill.mode || "percent", value: Number(bill.value) || 0, total: billTotal };
  cancel.pay = { mode: pay.mode || "percent", value: Number(pay.value) || 0, total: payTotal };
  var out = Object.assign({}, position, { status: "cancelled", cancel: cancel });
  if (hasCrew) out.work = window.LTP_cancelWork(position, payTotal, meta.at || "", meta.by || "");
  else delete out.work;
  return out;
}

// Cancel ONE shift position. shares = { bill: {mode, value}, pay: {mode,
// value} }; meta = { at, by, byId, reason }. Works from any status; a position
// already cancelled is re-shared against its fixed reference. Returns a new
// schedule (the input when the position is not found).
window.LTP_cancelPosition = function(schedule, shiftId, posId, shares, services, crewMins, meta) {
  var hit = false;
  var out = (schedule || []).map(function(s) {
    if (!s || s.id !== shiftId) return s;
    var positions = (s.positions || []).map(function(p) {
      if (!p || p.id !== posId) return p;
      hit = true;
      var ref = (p.cancel && p.cancel.ref) ? p.cancel.ref : window.LTP_cancelReference(s, p, services, crewMins);
      return _cancelledPosition(p, ref, shares, meta);
    });
    return Object.assign({}, s, { positions: positions });
  });
  return hit ? out : schedule;
};

// Edit the shares of a position already cancelled. Its reference never moves.
window.LTP_setCancellationShares = function(schedule, shiftId, posId, shares, meta) {
  var hit = false;
  var out = (schedule || []).map(function(s) {
    if (!s || s.id !== shiftId) return s;
    var positions = (s.positions || []).map(function(p) {
      if (!p || p.id !== posId || p.status !== "cancelled" || !p.cancel || !p.cancel.ref) return p;
      hit = true;
      return _cancelledPosition(p, p.cancel.ref, shares, meta);
    });
    return Object.assign({}, s, { positions: positions });
  });
  return hit ? out : schedule;
};

// Undo a cancellation: back to confirmed (or open when nobody holds it), the
// record and the frozen pay gone, and the person's pay for that day re-locked
// at today's rates. Returns a new schedule (the input when nothing changed).
window.LTP_restorePosition = function(schedule, shiftId, posId, services, crewMins, lockedAt) {
  var crewId = null, date = "", hit = false;
  var out = (schedule || []).map(function(s) {
    if (!s || s.id !== shiftId) return s;
    var positions = (s.positions || []).map(function(p) {
      if (!p || p.id !== posId || p.status !== "cancelled") return p;
      hit = true; crewId = p.crewId != null ? p.crewId : null; date = s.date || "";
      var copy = Object.assign({}, p, { status: crewId != null ? "confirmed" : "open" });
      delete copy.cancel; delete copy.work;
      return copy;
    });
    return Object.assign({}, s, { positions: positions });
  });
  if (!hit) return schedule;
  return (crewId != null && date) ? window.LTP_stampPay(out, crewId, services, crewMins, lockedAt, [date]) : out;
};

// The flat-rate mirrors. The reference is the typed amounts: `bill` and `fee`
// ($0 pay for a full-margin position).
window.LTP_cancelFixedPosition = function(fixedPositions, posId, shares, meta) {
  var hit = false;
  var out = (fixedPositions || []).map(function(p) {
    if (!p || p.id !== posId) return p;
    hit = true;
    var ref = (p.cancel && p.cancel.ref) ? p.cancel.ref
      : { bill: Math.round((Number(p.bill) || 0) * 100) / 100,
          pay: (p.fullMargin || !_cancelPaysCrew(p)) ? 0 : Math.round((Number(p.fee) || 0) * 100) / 100 };
    return _cancelledPosition(p, ref, shares, meta);
  });
  return hit ? out : fixedPositions;
};
window.LTP_setFixedCancellationShares = function(fixedPositions, posId, shares, meta) {
  var hit = false;
  var out = (fixedPositions || []).map(function(p) {
    if (!p || p.id !== posId || p.status !== "cancelled" || !p.cancel || !p.cancel.ref) return p;
    hit = true;
    return _cancelledPosition(p, p.cancel.ref, shares, meta);
  });
  return hit ? out : fixedPositions;
};
window.LTP_restoreFixedPosition = function(fixedPositions, posId, lockedAt) {
  var crewId = null, hit = false;
  var out = (fixedPositions || []).map(function(p) {
    if (!p || p.id !== posId || p.status !== "cancelled") return p;
    hit = true; crewId = p.crewId != null ? p.crewId : null;
    var copy = Object.assign({}, p, { status: crewId != null ? "confirmed" : "open" });
    delete copy.cancel; delete copy.work;
    return copy;
  });
  if (!hit) return fixedPositions;
  return crewId != null ? window.LTP_stampFixedPay(out, crewId, lockedAt, [posId]) : out;
};

// ── Bookings: several positions cancelled as one ─────────────────────────────
// What the Labor tab and the schedule editor cancel is usually a BOOKING — one
// person's positions on one day (a load-in and a show), or every position on a
// day — not a lone position. A person's shifts that day bill as ONE
// person-day (LTP_calcDayLabor pools them by role and slot, with the day's
// OT), so pricing each shift alone would state the reference as two day rates.
// Here the reference is the positions priced TOGETHER — each shift carrying
// only the booking's positions, so nobody else on it moves the figure — and
// then split across the positions in proportion to what each would bill
// alone. A typed amount is split the same way, to the cent, remainder on the
// last, so every position's record still reads "N% of its own reference" and
// its line on the document names the same percentage. A single position comes
// out exactly as LTP_cancelPosition would have it.

// Split `total` across `weights` to the cent (equally when they sum to 0),
// the rounding remainder on the last so the parts add up exactly.
function _splitCents(total, weights) {
  var cents = Math.round((Number(total) || 0) * 100);
  var sumW = weights.reduce(function(t, w) { return t + (Number(w) || 0); }, 0);
  var used = 0;
  return weights.map(function(w, i) {
    if (i === weights.length - 1) return (cents - used) / 100;
    var c = sumW > 0 ? Math.round(cents * (Number(w) || 0) / sumW) : Math.round(cents / weights.length);
    used += c;
    return c / 100;
  });
}
function _pickPositions(schedule, positionIds) {
  var want = {}; (positionIds || []).forEach(function(id) { want[id] = true; });
  var picks = [];
  (schedule || []).forEach(function(s) {
    ((s && s.positions) || []).forEach(function(p) { if (p && want[p.id]) picks.push({ shift: s, pos: p }); });
  });
  return picks;
}

// The booking's reference: { bill, pay, parts: [{ id, bill, pay }] }. Only
// positions that are not already cancelled are priced (a cancelled one keeps
// the reference it was cancelled against).
window.LTP_bookingCancelReference = function(schedule, positionIds, services, crewMins) {
  var picks = _pickPositions(schedule, positionIds).filter(function(pk) { return pk.pos.status !== "cancelled"; });
  if (!picks.length) return { bill: 0, pay: 0, parts: [] };
  var byShift = {}, order = [];
  picks.forEach(function(pk) {
    var k = String(pk.shift.id);
    if (!byShift[k]) { byShift[k] = { time: pk.shift.time, endTime: pk.shift.endTime, breaks: pk.shift.breaks || [], positions: [] }; order.push(k); }
    byShift[k].positions.push(pk.pos);
  });
  function priced(keep) {
    var shifts = order.map(function(k) {
      return Object.assign({}, byShift[k], { positions: byShift[k].positions.filter(keep) });
    });
    return window.LTP_calcDayLabor(shifts, services, crewMins);
  }
  var bill = 0, pay = 0;
  (priced(function() { return true; }).units || []).forEach(function(u) { bill += u.rateTotal || 0; });
  // The pay side: only the people committed to the call, not full margin
  // (_cancelPaysCrew) — priced on their own, so an unanswered request on the
  // same shift adds nothing to it.
  var paid = function(p) { return _cancelPaysCrew(p) && !p.fullMargin; };
  if (picks.some(function(pk) { return paid(pk.pos); })) {
    (priced(paid).units || []).forEach(function(u) { pay += u.fullMargin ? 0 : (u.costTotal || 0); });
  }
  bill = Math.round(bill * 100) / 100; pay = Math.round(pay * 100) / 100;
  var alone = picks.map(function(pk) { return window.LTP_cancelReference(pk.shift, pk.pos, services, crewMins); });
  var bills = _splitCents(bill, alone.map(function(a) { return a.bill; }));
  // Pay splits by each position's own cost (0 for anyone it doesn't pay).
  var payWeights = alone.map(function(a) { return a.pay; });
  var lastPaid = -1; picks.forEach(function(pk, i) { if (paid(pk.pos)) lastPaid = i; });
  var pays = payWeights.some(function(w) { return w > 0; }) ? _splitCents(pay, payWeights)
    : picks.map(function(pk, i) { return i === lastPaid ? pay : 0; });
  return { bill: bill, pay: pay, parts: picks.map(function(pk, i) { return { id: pk.pos.id, bill: bills[i], pay: pays[i] }; }) };
};

// One side's share for each part: a percentage applies as it is; an amount is
// split in proportion to the parts' references.
function _sideShares(side, total, partRefs) {
  var sd = side || { mode: "percent", value: 0 };
  if (sd.mode !== "amount") return partRefs.map(function() { return { mode: sd.mode || "percent", value: Number(sd.value) || 0 }; });
  return _splitCents(Number(sd.value) || 0, partRefs).map(function(v) { return { mode: "amount", value: v }; });
}
function _applyParts(schedule, parts, shares, meta, write) {
  var byId = {};
  var billShares = _sideShares(shares && shares.bill, 0, parts.map(function(pt) { return pt.bill; }));
  var payShares = _sideShares(shares && shares.pay, 0, parts.map(function(pt) { return pt.pay; }));
  parts.forEach(function(pt, i) { byId[pt.id] = { ref: { bill: pt.bill, pay: pt.pay }, shares: { bill: billShares[i], pay: payShares[i] } }; });
  var hit = false;
  var out = (schedule || []).map(function(s) {
    if (!s || !(s.positions || []).some(function(p) { return p && byId[p.id]; })) return s;
    return Object.assign({}, s, { positions: s.positions.map(function(p) {
      var part = p && byId[p.id];
      if (!part) return p;
      var next = write(p, part);
      if (next !== p) hit = true;
      return next;
    }) });
  });
  return hit ? out : schedule;
}

// Cancel the positions as one booking. shares = { bill: {mode, value}, pay:
// {mode, value} } for the booking as a whole; meta = { at, by, byId, reason }.
// Positions already cancelled are left as they are. Returns a new schedule
// (the input when nothing was cancelled).
window.LTP_cancelBooking = function(schedule, positionIds, shares, services, crewMins, meta) {
  var ref = window.LTP_bookingCancelReference(schedule, positionIds, services, crewMins);
  if (!ref.parts.length) return schedule;
  return _applyParts(schedule, ref.parts, shares, meta, function(p, part) {
    return p.status === "cancelled" ? p : _cancelledPosition(p, part.ref, part.shares, meta);
  });
};

// The reference a cancelled booking was cancelled against — the sum of its
// positions' fixed references — and the shares it currently carries, for the
// edit dialog. { bill, pay, shares: { bill, pay } } or null.
window.LTP_bookingCancellation = function(schedule, positionIds) {
  var picks = _pickPositions(schedule, positionIds).filter(function(pk) { return pk.pos.status === "cancelled" && pk.pos.cancel && pk.pos.cancel.ref; });
  if (!picks.length) return null;
  var bill = 0, pay = 0, billTotal = 0, payTotal = 0;
  picks.forEach(function(pk) {
    var c = pk.pos.cancel;
    bill += Number(c.ref.bill) || 0; pay += Number(c.ref.pay) || 0;
    billTotal += Number(c.bill && c.bill.total) || 0; payTotal += Number(c.pay && c.pay.total) || 0;
  });
  function side(key, total) {
    var first = picks[0].pos.cancel[key] || { mode: "percent", value: 0 };
    if (first.mode === "amount") return { mode: "amount", value: Math.round(total * 100) / 100 };
    return { mode: first.mode || "percent", value: Number(first.value) || 0 };
  }
  return { bill: Math.round(bill * 100) / 100, pay: Math.round(pay * 100) / 100,
           billTotal: Math.round(billTotal * 100) / 100, payTotal: Math.round(payTotal * 100) / 100,
           reason: picks[0].pos.cancel.reason || "",
           shares: { bill: side("bill", billTotal), pay: side("pay", payTotal) } };
};

// Re-share a cancelled booking. Each position keeps the reference it was
// cancelled against; an amount is split across those references.
window.LTP_setBookingCancellationShares = function(schedule, positionIds, shares, meta) {
  var picks = _pickPositions(schedule, positionIds).filter(function(pk) { return pk.pos.status === "cancelled" && pk.pos.cancel && pk.pos.cancel.ref; });
  if (!picks.length) return schedule;
  var parts = picks.map(function(pk) { return { id: pk.pos.id, bill: Number(pk.pos.cancel.ref.bill) || 0, pay: Number(pk.pos.cancel.ref.pay) || 0 }; });
  return _applyParts(schedule, parts, shares, meta, function(p, part) {
    return _cancelledPosition(p, part.ref, part.shares, meta);
  });
};

// Restore every cancelled position of a booking (LTP_restorePosition each).
window.LTP_restoreBooking = function(schedule, positionIds, services, crewMins, lockedAt) {
  var out = schedule;
  _pickPositions(schedule, positionIds).forEach(function(pk) {
    if (pk.pos.status === "cancelled") out = window.LTP_restorePosition(out, pk.shift.id, pk.pos.id, services, crewMins, lockedAt);
  });
  return out;
};

// "Refill role": the call still needs someone. A new OPEN position for the same
// role on the same shift, with the next free person-slot so it is a different
// person, not the cancelled one's day. Returns { schedule, positionId }.
window.LTP_refillPosition = function(schedule, shiftId, posId, genId) {
  var gen = genId || window.LTP_genId, newId = null;
  var out = (schedule || []).map(function(s) {
    if (!s || s.id !== shiftId) return s;
    var src = (s.positions || []).filter(function(p) { return p && p.id === posId; })[0];
    if (!src) return s;
    var used = {};
    var slots = window.LTP_effectiveSlots(s.positions);
    (s.positions || []).forEach(function(p) { if (p && p.serviceId === src.serviceId) used[slots[p.id] || 1] = true; });
    var slot = 1; while (used[slot]) slot++;
    newId = gen("pos");
    var fresh = { id: newId, role: src.role || "", serviceId: src.serviceId || null, crewId: null, status: "open", fullMargin: false };
    if (src.serviceId) fresh.slot = slot;
    return Object.assign({}, s, { positions: (s.positions || []).concat([fresh]) });
  });
  return { schedule: newId ? out : schedule, positionId: newId };
};
// The flat-rate mirror: the same role, fee and bill, open, nobody on it.
window.LTP_refillFixedPosition = function(fixedPositions, posId, genId) {
  var gen = genId || window.LTP_genId;
  var src = (fixedPositions || []).filter(function(p) { return p && p.id === posId; })[0];
  if (!src) return { fixedPositions: fixedPositions, positionId: null };
  var newId = gen("pos");
  var fresh = { id: newId, serviceId: src.serviceId || null, role: src.role || "", crewId: null, status: "open",
                fee: src.fee, bill: src.bill, fullMargin: false, note: src.note || "" };
  return { fixedPositions: (fixedPositions || []).concat([fresh]), positionId: newId };
};

// ── A booking on a project row ───────────────────────────────────────────────
// The Labor tab writes whole project rows, so these wrap the booking helpers
// above for one project: its schedule when the ids are shift positions, its
// flat-rate list when the id is a flat-rate position (a booking is one or the
// other — the tab never mixes them).
function _cancelR2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function _shareOf(side) {
  return side ? { mode: side.mode || "percent", value: Number(side.value) || 0 } : { mode: "percent", value: 0 };
}

// What the cancel dialog shows for `positionIds` on `project`:
//   { flat, ids, crewId, status, fullMargin, cancelled, ref: { bill, pay },
//     shares, billTotal, payTotal, reason, date }
// `cancelled` is true when every position named is already cancelled: `ref`
// is then what they were cancelled against and `shares` what they carry (the
// edit dialog). Otherwise `ids` narrows to the positions not yet cancelled
// and `ref` is priced now. null when none of the ids is on the project.
window.LTP_projectBooking = function(project, positionIds, services, crewMins) {
  if (!project) return null;
  var want = {}; (positionIds || []).forEach(function(id) { want[id] = true; });
  var fp = (project.fixedPositions || []).filter(function(p) { return p && want[p.id]; })[0];
  if (fp) {
    var fc = fp.status === "cancelled" && fp.cancel && fp.cancel.ref ? fp.cancel : null;
    var fref = fc ? fc.ref : { bill: fp.bill, pay: fp.fullMargin ? 0 : fp.fee };
    var fpaid = _cancelPaysCrew(fp);
    if (!fc && !fpaid) fref = { bill: fref.bill, pay: 0 };
    return { flat: true, ids: [fp.id], crewId: fp.crewId != null ? fp.crewId : null, status: fp.status, paysCrew: fpaid,
             fullMargin: !!fp.fullMargin, cancelled: !!fc, ref: { bill: _cancelR2(fref.bill), pay: _cancelR2(fref.pay) },
             shares: fc ? { bill: _shareOf(fc.bill), pay: _shareOf(fc.pay) } : null,
             billTotal: fc ? _cancelR2(fc.bill && fc.bill.total) : 0, payTotal: fc ? _cancelR2(fc.pay && fc.pay.total) : 0,
             reason: fc ? (fc.reason || "") : "", date: "" };
  }
  var picks = _pickPositions(project.schedule, positionIds);
  if (!picks.length) return null;
  var live = picks.filter(function(pk) { return pk.pos.status !== "cancelled"; });
  var lead = (live[0] || picks[0]).pos;
  var out = { flat: false, crewId: lead.crewId != null ? lead.crewId : null, status: lead.status,
              date: (live[0] || picks[0]).shift.date || "",
              paysCrew: (live.length ? live : picks).some(function(pk) { return _cancelPaysCrew(pk.pos); }) };
  function margin(pks) { return pks.every(function(pk) { return !!pk.pos.fullMargin; }); }
  if (!live.length) {
    var bc = window.LTP_bookingCancellation(project.schedule, positionIds);
    if (!bc) return null;
    return Object.assign(out, { ids: picks.map(function(pk) { return pk.pos.id; }), fullMargin: margin(picks), cancelled: true,
      ref: { bill: bc.bill, pay: bc.pay }, shares: bc.shares, billTotal: bc.billTotal, payTotal: bc.payTotal, reason: bc.reason });
  }
  var ids = live.map(function(pk) { return pk.pos.id; });
  var ref = window.LTP_bookingCancelReference(project.schedule, ids, services, crewMins);
  return Object.assign(out, { ids: ids, fullMargin: margin(live), cancelled: false,
    ref: { bill: ref.bill, pay: ref.pay }, shares: null, billTotal: 0, payTotal: 0, reason: "" });
};

// Write one of the dialog's decisions onto the project row. action: "cancel" |
// "edit" | "restore" | "refill"; meta = { at, by, byId, reason } (restore
// re-locks pay at meta.at). Returns { project, positionIds }: the new row (the
// input when nothing changed) and, for "refill", the new open positions' ids.
window.LTP_projectBookingWrite = function(project, booking, action, shares, services, crewMins, meta, genId) {
  meta = meta || {};
  if (!project || !booking) return { project: project, positionIds: [] };
  var ids = booking.ids || [], added = [];
  if (booking.flat) {
    var fixed = project.fixedPositions || [], nextFixed = fixed;
    if (action === "cancel") nextFixed = window.LTP_cancelFixedPosition(fixed, ids[0], shares, meta);
    else if (action === "edit") nextFixed = window.LTP_setFixedCancellationShares(fixed, ids[0], shares, meta);
    else if (action === "restore") nextFixed = window.LTP_restoreFixedPosition(fixed, ids[0], meta.at);
    else if (action === "refill") {
      var rf = window.LTP_refillFixedPosition(fixed, ids[0], genId);
      nextFixed = rf.fixedPositions;
      if (rf.positionId) added.push(rf.positionId);
    }
    return { project: nextFixed === fixed ? project : Object.assign({}, project, { fixedPositions: nextFixed }), positionIds: added };
  }
  var sched = project.schedule || [], next = sched;
  if (action === "cancel") next = window.LTP_cancelBooking(sched, ids, shares, services, crewMins, meta);
  else if (action === "edit") next = window.LTP_setBookingCancellationShares(sched, ids, shares, meta);
  else if (action === "restore") next = window.LTP_restoreBooking(sched, ids, services, crewMins, meta.at);
  else if (action === "refill") {
    _pickPositions(sched, ids).forEach(function(pk) {
      var rs = window.LTP_refillPosition(next, pk.shift.id, pk.pos.id, genId);
      next = rs.schedule;
      if (rs.positionId) added.push(rs.positionId);
    });
  }
  return { project: next === sched ? project : Object.assign({}, project, { schedule: next }), positionIds: added };
};

// The notify-tray shift list for a cancelled booking: the usual snapshots,
// each paid one carrying its own share as `cancellationPay`, which the
// crewCancelledWithPay email sums (see LTP_diffRemovedCrew).
window.LTP_cancelSnapshots = function(project, positionIds, services) {
  if (!project) return [];
  var payById = {};
  function note(p) { if (p && p.status === "cancelled" && p.cancel && p.cancel.pay) payById[p.id] = _cancelR2(p.cancel.pay.total); }
  (project.schedule || []).forEach(function(s) { ((s && s.positions) || []).forEach(note); });
  (project.fixedPositions || []).forEach(note);
  var snaps = window.LTP_shiftSnapshots(project.schedule, positionIds, services)
    .concat(window.LTP_fixedSnapshots(project.fixedPositions, positionIds, services));
  snaps.forEach(function(sn) { if (payById[sn.positionId] > 0) sn.cancellationPay = payById[sn.positionId]; });
  return snaps;
};

// What a reassignment or a reopen must take with it: the previous holder's
// locked pay, sign-off, adjustments and cancellation. The Labor tab and the
// schedule editor merge this into the position patch (Object.assign copies the
// undefined values; JSON drops them on save; the server lets a non-admin drop
// them exactly here — backend/crew_integrity.py::enforce_pay_snapshot). Before
// this, the next person confirmed into a slot inherited the last one's
// sign-off and adjustments.
window.LTP_SNAPSHOT_CLEAR = { pay: undefined, work: undefined, adj: undefined, cancel: undefined };
window.LTP_reassignPatch = function(pos, crewId) {
  var same = crewId != null && pos && crewId === pos.crewId;
  var patch = { crewId: crewId, status: same ? pos.status : "open" };
  return same ? patch : Object.assign(patch, window.LTP_SNAPSHOT_CLEAR);
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
    // A position the person still holds but that was CANCELLED in between is
    // a removal too: the call is off. It is noticed like a cancelled booking,
    // except that one carrying a pay share gets its own notice
    // (crewCancelledWithPay) naming what they will be paid: each shift carries
    // its own share as `cancellationPay` (LTP_cancelSnapshots), which the
    // notify route sums — the tray merges shifts from several parks into one
    // notice, so the figure has to travel with the shift. A cancellation that
    // pays nothing reads like any other removal from that status (a confirmed
    // call → crewCancelled).
    var afterPosById = {};
    (after || []).forEach(function(s) {
      (s.positions || []).forEach(function(p) { afterPosById[p.id] = p; });
    });
    var groups = {};  // "crewId:template"
    (before || []).forEach(function(sh) {
      (sh.positions || []).forEach(function(p) {
        if (!p.crewId || !ACTIVE[p.status]) return;
        var stillThere = Object.prototype.hasOwnProperty.call(afterById, p.id);
        var nowPos = afterPosById[p.id];
        var cancelledNow = !!(stillThere && afterById[p.id] === p.crewId && nowPos && nowPos.status === "cancelled");
        if (stillThere && afterById[p.id] === p.crewId && !cancelledNow) return;  // still theirs
        var pay = cancelledNow ? Math.round((Number(nowPos.cancel && nowPos.cancel.pay && nowPos.cancel.pay.total) || 0) * 100) / 100 : 0;
        var template = pay > 0 ? "crewCancelledWithPay" : window.LTP_removalTemplate(p.status);
        var k = p.crewId + ":" + template;
        if (!groups[k]) {
          var cm = (contacts || []).find(function(c) { return c.id === p.crewId; });
          groups[k] = { crewId: p.crewId, crewName: cm ? (cm.firstName + " " + cm.lastName).trim() : "Crew", template: template, shifts: [] };
        }
        var snap = shiftSnap(sh, p, svcById);
        if (pay > 0) snap.cancellationPay = pay;
        groups[k].shifts.push(snap);
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

// ── Crew double-bookings ─────────────────────────────────────────────────────
//
// One person on two shifts the same day is one of two things:
//   • a SAME-DAY booking — the shifts sit at different times (a morning load-in
//     here, an evening show on another project), so the day can work;
//   • a TIME CONFLICT — the spans overlap, so they can't be in both places.
// LTP_detectCrewConflicts tells them apart by stamping `overlap` on every
// counterpart it lists, and LTP_conflictLevel folds a position's list into
// the badge it earns: "overlap" (red) or "day" (yellow). Before this split
// every same-day pair was red, which buried the real clashes among days that
// merely had two calls on them.

// "HH:MM" → minutes from midnight, or null when it isn't a real clock time.
// "24:00" (end-of-day midnight) is the one accepted out-of-range value, as in
// the labor engine (LTP_calcLaborDay).
function _hhmmToMinutes(t) {
  var m = /^(\d{1,2}):([0-5]\d)$/.exec(String(t == null ? "" : t).trim());
  if (!m) return null;
  var h = +m[1], mm = +m[2];
  if (h > 24 || (h === 24 && mm > 0)) return null;
  return h * 60 + mm;
}
// "YYYY-MM-DD" → whole days since the epoch, or null. Built from the parts so
// the day never shifts with the browser's timezone.
function _isoDayIndex(d) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d == null ? "" : d).trim());
  if (!m) return null;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}

// A shift's span as absolute minutes, {start, end}, so rows on different dates
// compare directly. A wrap earlier than (or equal to) the call means the shift
// runs past midnight (the labor engine's rule); a multi-day row (endDate after
// date) ends on its last day. Null when the row lacks a date or either time,
// or one of them is not a real value — the caller decides what "unknown"
// means (see LTP_shiftTimesOverlap).
window.LTP_shiftSpan = function(row) {
  if (!row || !row.date || !row.time || !row.endTime) return null;
  var day = _isoDayIndex(row.date);
  var start = _hhmmToMinutes(row.time), end = _hhmmToMinutes(row.endTime);
  if (day == null || start == null || end == null) return null;
  var lastDay = (row.endDate && row.endDate > row.date) ? _isoDayIndex(row.endDate) : day;
  if (lastDay == null) return null;
  start += day * 1440;
  end += lastDay * 1440;
  if (end <= start) end += 1440; // overnight
  return { start: start, end: end };
};

// Do two shifts' times overlap? True unless BOTH carry complete times and the
// spans are disjoint (back-to-back — a 12:00 wrap against a 12:00 call — is
// not an overlap). The conservative side is deliberate: a shift with no times
// set can't be shown clear of the other, so it keeps the red badge it always
// had; the split only ever downgrades a pair the times prove apart.
window.LTP_shiftTimesOverlap = function(a, b) {
  var sa = window.LTP_shiftSpan(a), sb = window.LTP_shiftSpan(b);
  if (!sa || !sb) return true;
  return sa.start < sb.end && sb.start < sa.end;
};

// The badge a position's counterpart list earns: "overlap" when at least one
// counterpart's times overlap this shift (or can't be ruled out), "day" when
// every counterpart is on the same day at other times, null for no conflict.
// A counterpart without the flag (an older caller's shape) counts as an
// overlap, so nothing that used to be red turns yellow by accident.
window.LTP_conflictLevel = function(list) {
  if (!list || !list.length) return null;
  return list.some(function(c) { return !c || c.overlap !== false; }) ? "overlap" : "day";
};

// Tooltip for a conflict badge: which kind it is, and where else the person is
// booked with that shift's times, so a glance says whether the day works.
// When a red list also holds same-day counterparts, each is marked.
window.LTP_conflictTitle = function(list) {
  var level = window.LTP_conflictLevel(list);
  if (!level) return "";
  var mixed = level === "overlap" && list.some(function(c) { return c && c.overlap === false; });
  var where = list.map(function(c) {
    if (!c) return "";
    var s = (c.projectName || "another project") + (c.schedTitle ? " (" + c.schedTitle + ")" : "");
    s += c.time ? ", " + window.LTP_formatTime(c.time) + (c.endTime ? " – " + window.LTP_formatTime(c.endTime) : "") : ", no times set";
    if (mixed) s += c.overlap === false ? " — other times" : " — overlaps";
    return s;
  }).filter(Boolean).join("; ");
  return (level === "overlap" ? "Time conflict — also on " : "Same day, no overlap — also on ") + where;
};

// Detect crew double-bookings across projects: posId → the other bookings the
// person holds that day (each with `overlap` against this position's shift).
window.LTP_detectCrewConflicts = function(projects) {
  var bookings = {};
  (projects || []).forEach(function(proj) {
    (proj.schedule || []).forEach(function(s) {
      if (!s.date) return;
      (s.positions || []).forEach(function(p) {
        // A declined position was never theirs; a cancelled one no longer is —
        // the day is free (its pay share, if any, is not a booking).
        if (!p.crewId || p.status === "declined" || p.status === "cancelled") return;
        var key = p.crewId + "|" + s.date;
        if (!bookings[key]) bookings[key] = [];
        bookings[key].push({ projectId: proj.id, projectName: proj.name, schedTitle: s.title, schedItemId: s.id, posId: p.id, status: p.status, date: s.date, crewId: p.crewId, serviceId: p.serviceId,
                             // The shift's times ride along so a counterpart can be judged
                             // (and shown) against the position it is listed on.
                             endDate: s.endDate, time: s.time, endTime: s.endTime });
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
        conflicts[bk.posId] = b.filter(function(o) { return o.posId !== bk.posId; }).map(function(o) {
          return Object.assign({}, o, { overlap: window.LTP_shiftTimesOverlap(bk, o) });
        });
      });
    }
  });
  return conflicts;
};

// Who has already said no to a shift — so the crew pickers can list them under
// their own heading instead of leaving the producer to remember, and ask them
// again by accident.
//
// The record is the crew_requests table (backend/models.py::CrewRequest): a
// declined request stays `declined` for good, its `positionIds` naming the
// shifts it covered, even after the producer reassigns the slot. This index
// reads those rows back per SHIFT — the schedule row (day) a position sits on,
// or the flat-rate position itself — so a decline for "L2 #1 on the show day"
// also marks "L2 #2 on the show day": the person turned down the day, not the
// slot number.
//
// The LATEST ask wins per (person, shift). Someone who declined, was asked
// again and accepted (or hasn't answered yet) is not "previously declined";
// someone who declined and whose later re-ask the producer withdrew still is.
// A direct book counts as an accepted ask. Requests are ordered by sentAt, id
// breaking ties.
//
//   var idx = LTP_declinedCrewIndex(crewRequests, projects);
//   idx.declinedFor(projectId, [{ schedItemId: "sch-1" }, { flat: true, posId: "fpos-2" }])
//     → [{ contactId, respondedAt, comment }], newest decline first, one per person
//
// `projects` are the SAVED rows (a request only ever names saved positions);
// a position id no project holds any more is simply ignored.
window.LTP_declinedCrewIndex = function(crewRequests, projects) {
  // (projectId, positionId) → the shift key that position belongs to.
  var shiftOf = {};
  (projects || []).forEach(function(proj) {
    if (!proj) return;
    var m = shiftOf[proj.id] = {};
    (proj.schedule || []).forEach(function(s) {
      (s && s.positions || []).forEach(function(p) { if (p && p.id != null) m[p.id] = "s:" + s.id; });
    });
    (proj.fixedPositions || []).forEach(function(p) { if (p && p.id != null) m[p.id] = "f:" + p.id; });
  });
  function later(a, b) {      // is request a more recent than b?
    var x = a.sentAt || "", y = b.sentAt || "";
    if (x !== y) return x > y;
    return (a.id || 0) > (b.id || 0);
  }
  // projectId → shift key → contactId → the latest request touching that shift.
  var latest = {};
  (crewRequests || []).forEach(function(r) {
    if (!r || r.status === "withdrawn" || r.contactId == null || r.projectId == null) return;
    var m = shiftOf[r.projectId];
    if (!m) return;
    (r.positionIds || []).forEach(function(pid) {
      var key = m[pid];
      if (!key) return;
      var byShift = latest[r.projectId] || (latest[r.projectId] = {});
      var byCrew = byShift[key] || (byShift[key] = {});
      var cur = byCrew[r.contactId];
      if (!cur || later(r, cur)) byCrew[r.contactId] = r;
    });
  });
  function keyFor(e) {
    if (!e) return null;
    if (e.flat) return e.posId != null ? "f:" + e.posId : null;
    return e.schedItemId != null ? "s:" + e.schedItemId : null;
  }
  return {
    declinedFor: function(projectId, entries) {
      var byShift = latest[projectId];
      if (!byShift) return [];
      var seen = {}, out = [];
      (entries || []).forEach(function(e) {
        var byCrew = byShift[keyFor(e)];
        if (!byCrew) return;
        Object.keys(byCrew).forEach(function(cid) {
          var r = byCrew[cid];
          if (r.status !== "declined") return;
          var prev = seen[cid];
          // Several shifts in one lookup (a multi-row day booking): keep the
          // most recent answer for the person.
          if (prev && !later(r, prev)) return;
          seen[cid] = r;
        });
      });
      Object.keys(seen).forEach(function(cid) {
        var r = seen[cid];
        out.push({ contactId: r.contactId, respondedAt: r.respondedAt || null, comment: r.comment || "" });
      });
      out.sort(function(a, b) {
        var x = a.respondedAt || "", y = b.respondedAt || "";
        return x < y ? 1 : (x > y ? -1 : 0);
      });
      return out;
    },
  };
};

// ── Flat-rate ("fixed cost") positions ───────────────────────────────────────
//
// A lighting designer or stage manager hired for the WHOLE project at a flat
// fee, with no contracted shift times — they get the schedule and make their
// own hours. These live in project.fixedPositions, not on a schedule row (see
// backend/models.py::Project.fixed_positions for the item shape). They share
// the position id namespace, the open → requested → accepted/declined →
// confirmed ladder, and the frozen pay / work / adj snapshot shape with shift
// positions, so the crew-request and payout pipelines carry both. What differs:
//   • no rate engine — `fee` (what we pay) and `bill` (what the client pays)
//     are typed, margin = bill − fee, `fullMargin` zeroes the cost;
//   • no date — the project's END date (LTP_fixedPayDate) picks the pay
//     period, and the fee is paid on that period's pay day;
//   • "Mark complete" (LTP_completeFixedPosition) replaces the day sign-off.

// The pay-side figure for a flat-rate position as it stands NOW — the typed fee,
// or $0 for a full-margin one — in the same shape LTP_crewDayPay returns, so
// the Payouts tab, the confirm-time lock and the completion freeze all read one
// object. The single unit carries the service so the QuickBooks export can
// route the fee to that role's expense account (backend/qbo_payouts.py).
window.LTP_fixedPositionPay = function(pos, amount) {
  var base = (amount != null && !isNaN(Number(amount))) ? Number(amount) : (pos ? Number(pos.fee) : 0);
  var total = (pos && pos.fullMargin) ? 0 : Math.round((base || 0) * 100) / 100;
  return {
    total: total, paidHours: 0, otHours: 0, mealPenaltyHours: 0, tier: "flat",
    units: [{ serviceId: pos ? pos.serviceId : null, tier: "flat", paidHours: 0, otHours: 0,
              dayCost: total, otCost: 0, minApplied: false, minHoursApplied: false,
              fullMargin: !!(pos && pos.fullMargin), total: total }],
  };
};

// Stamp the fee agreed at hire as `pay` onto ONE person's confirmed flat
// flat-rate positions — the flat-rate mirror of LTP_stampPay. `ids` restricts which
// positions are (re)locked; omit it to lock every confirmed one. Returns a new
// list; untouched entries are passed through.
window.LTP_stampFixedPay = function(fixedPositions, crewId, lockedAt, ids) {
  var only = null;
  if (ids) { only = {}; ids.forEach(function(i) { only[i] = true; }); }
  return (fixedPositions || []).map(function(p) {
    if (!p || p.crewId !== crewId || p.status !== "confirmed" || (only && !only[p.id])) return p;
    return Object.assign({}, p, { pay: Object.assign({ lockedAt: lockedAt }, window.LTP_fixedPositionPay(p)) });
  });
};

// "Mark complete": the position is done, freeze the FINAL figure as work.pay
// — the flat-rate mirror of LTP_signOffDay. Pass `amount` when the final fee
// differs from the one agreed (scope grew, a day was dropped); omit it to
// complete at the fee as it stands. Only a confirmed flat-rate position can complete.
window.LTP_completeFixedPosition = function(fixedPositions, posId, amount, signedAt, signedBy) {
  return (fixedPositions || []).map(function(p) {
    if (!p || p.id !== posId || p.status !== "confirmed") return p;
    return Object.assign({}, p, { work: { state: "completed", pay: window.LTP_fixedPositionPay(p, amount),
                                          signedAt: signedAt, signedBy: signedBy } });
  });
};

// Undo "Mark complete": strip `work` so the position returns to pending.
window.LTP_uncompleteFixedPosition = function(fixedPositions, posId) {
  return (fixedPositions || []).map(function(p) {
    if (!p || p.id !== posId || !p.work) return p;
    var copy = Object.assign({}, p); delete copy.work; return copy;
  });
};

// Pay adjustments on a flat-rate position — same list shape and rules as
// LTP_setPayAdjustments (zero/invalid amounts dropped, empty list clears).
window.LTP_setFixedAdjustments = function(fixedPositions, posId, adjustments) {
  var clean = (adjustments || []).filter(function(a) { return a && typeof a.amount === "number" && !isNaN(a.amount) && a.amount !== 0; });
  return (fixedPositions || []).map(function(p) {
    if (!p || p.id !== posId) return p;
    var copy = Object.assign({}, p);
    if (clean.length) copy.adj = clean; else delete copy.adj;
    return copy;
  });
};

window.LTP_getFixedAdjustments = function(fixedPositions, posId) {
  var hit = (fixedPositions || []).find(function(p) { return p && p.id === posId; });
  return (hit && hit.adj && hit.adj.length) ? hit.adj : [];
};

// Notify-tray snapshot of a flat-rate position — the shape _crew_shifts_html
// renders (flagged `flat`, no date/time, no fee: a removal notice doesn't
// restate the offer). Mirrors shiftSnap for shift positions.
window.LTP_fixedSnapshots = function(fixedPositions, positionIds, services) {
  var ids = {}; (positionIds || []).forEach(function(id) { ids[id] = true; });
  var svcById = {}; (services || []).forEach(function(sv) { svcById[sv.id] = sv; });
  var out = [];
  (fixedPositions || []).forEach(function(p) {
    if (!p || !ids[p.id]) return;
    var svc = svcById[p.serviceId];
    var roleLabel = svc
      ? ((svc.role || "") + (svc.description ? " — " + svc.description : "")).replace(/^\s*—\s*|\s*—\s*$/g, "").trim()
      : (p.role || "");
    out.push({ positionId: p.id, roleLabel: roleLabel || "Crew", department: svc ? (svc.department || "") : "",
               status: p.status, shiftTitle: "", date: "", startTime: "", endTime: "", flat: true });
  });
  return out;
};

// Flat-rate mirror of LTP_diffRemovedCrew: flat-rate positions that LOST their crew
// member between two fixedPositions lists (deleted, unassigned, reassigned),
// bucketed per person + notice type for the notify tray.
window.LTP_diffRemovedFixed = function(before, after, contacts, services) {
  var ACTIVE = { requested: 1, accepted: 1, confirmed: 1 };
  var afterById = {};
  (after || []).forEach(function(p) { if (p) afterById[p.id] = p; });
  var groups = {};
  (before || []).forEach(function(p) {
    if (!p || !p.crewId || !ACTIVE[p.status]) return;
    var now = afterById[p.id];
    // Still theirs and not cancelled in between (a cancellation is noticed
    // exactly as LTP_diffRemovedCrew notices one).
    var cancelledNow = !!(now && now.crewId === p.crewId && now.status === "cancelled");
    if (now && now.crewId === p.crewId && !cancelledNow) return;
    var pay = cancelledNow ? Math.round((Number(now.cancel && now.cancel.pay && now.cancel.pay.total) || 0) * 100) / 100 : 0;
    var template = pay > 0 ? "crewCancelledWithPay" : window.LTP_removalTemplate(p.status);
    var k = p.crewId + ":" + template;
    if (!groups[k]) {
      var cm = (contacts || []).find(function(c) { return c.id === p.crewId; });
      groups[k] = { crewId: p.crewId, crewName: cm ? (cm.firstName + " " + cm.lastName).trim() : "Crew", template: template, shifts: [] };
    }
    var snaps = window.LTP_fixedSnapshots([p], [p.id], services);
    if (pay > 0) snaps.forEach(function(sn) { sn.cancellationPay = pay; });
    groups[k].shifts = groups[k].shifts.concat(snaps);
  });
  return Object.keys(groups).map(function(k) { return groups[k]; });
};

// Bill / cost / margin across a project's flat-rate positions — what the Schedule
// Builder adds to its day-labor totals. A full-margin flat-rate position bills but
// costs nothing; a flat-rate position without a rate-card role still counts (it just
// can't be sent to a quote until it has one).
window.LTP_fixedPositionsTotals = function(fixedPositions) {
  var rate = 0, cost = 0, n = 0, filled = 0;
  (fixedPositions || []).forEach(function(p) {
    // A cancelled one bills and pays its share instead (LTP_cancellationTotals).
    if (!p || p.status === "cancelled") return;
    n++;
    if (p.status === "confirmed") filled++;
    rate += Number(p.bill) || 0;
    cost += p.fullMargin ? 0 : (Number(p.fee) || 0);
  });
  return { rateTotal: Math.round(rate * 100) / 100, costTotal: Math.round(cost * 100) / 100,
           margin: Math.round((rate - cost) * 100) / 100, count: n, filled: filled };
};

// Bill / cost across a project's CANCELLED positions, shift and flat-rate —
// the shares chosen when each was cancelled (LTP_cancelPosition), which the
// Schedule Builder adds to its totals in place of the day labor those
// positions no longer bill. A full-margin position's pay share is $0.
window.LTP_cancellationTotals = function(schedule, fixedPositions) {
  var rate = 0, cost = 0, n = 0;
  function add(p) {
    if (!p || p.status !== "cancelled") return;
    n++;
    var c = p.cancel || {};
    rate += Number(c.bill && c.bill.total) || 0;
    cost += p.fullMargin ? 0 : (Number(c.pay && c.pay.total) || 0);
  }
  (schedule || []).forEach(function(s) { ((s && s.positions) || []).forEach(add); });
  (fixedPositions || []).forEach(add);
  return { rateTotal: Math.round(rate * 100) / 100, costTotal: Math.round(cost * 100) / 100,
           margin: Math.round((rate - cost) * 100) / 100, count: n };
};
