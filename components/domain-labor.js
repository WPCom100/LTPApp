// LTP domain — the labor pricing engine. THIS IS MONEY MATH.
//
// Split out of theme.js so the rules that decide what a crew day costs live in
// one small, individually-testable file rather than buried at line 288 of a
// 2,739-line "theme". Covered by tests/test_labor_rates.js (320 assertions).
//
// KEEP TOGETHER: _timeToDecimal, _decimalToTime and _breakInSpan are the
// parsing/normalization helpers behind LTP_calcLaborDay and LTP_mealFixBreaks,
// which sat ~1,000 lines apart in the original file.
//
// To be precise about WHY, because it is easy to get backwards: theme.js was
// never IIFE-wrapped, so a `function _timeToDecimal()` at its top level is a
// GLOBAL, and separate <script> tags share one global scope. Splitting these
// apart would therefore still work — verified in Chromium, a function declared
// in one tag is callable from the next. So this is a maintainability rule, not
// a correctness one. It matters anyway for two reasons: these helpers are the
// only thing standing between a "HH:MM" string and a billed hour, so they
// belong beside the code that bills; and the moment anyone wraps a domain file
// in an IIFE to stop leaking `_timeToDecimal` onto window — which is the right
// cleanup — the separation becomes a real ReferenceError at call time.
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


// ═══════════════════════════════════════════════════════════════════════════
//   LABOR RATE CALCULATION
// ═══════════════════════════════════════════════════════════════════════════
//
// Rate tiers: 0-5h = half day, 5-10h = full day, 10+h = full + OT at 1.5x
// Meal breaks: must be provided every 5h of work.
//   Any work beyond 5h in a segment without a meal break = meal penalty OT (1.5x)
//
// Break types:
//   "unpaid" (default, 1hr) — crew leaves, time deducted from paid hours
//   "paid" (30min) — company provides food, crew stays on clock, time NOT deducted
//   Both types reset the 5-hour meal penalty clock.
//
// Calculation:
//   1. Build work segments from call → breaks → wrap (both types create boundaries)
//   2. Only unpaid break time is subtracted from paid hours
//   3. For each segment > 5h: excess is meal penalty OT
//   4. Remaining paid hours apply to standard tiers
//   5. Regular OT (10h+ of non-penalty time) stacks with meal penalty

// Parse "HH:MM" to decimal hours from midnight. Returns NaN for anything that
// is not a real 24-hour clock time; every caller below skips the row it came
// from rather than guessing.
//
// This used to be `parseInt(p[0]) + parseInt(p[1]) / 60`, which invented money
// out of bad data instead of rejecting it: "12" (no colon) made parseInt(p[1])
// NaN and produced a zero-hour day that still billed a half-day rate; "-1:00"
// parsed as -1 and turned a 17:00 finish into an 18-hour day at $2450; "09:90"
// silently became 10:30. That matters beyond typos — project.schedule is a
// free-form JSON column with no server-side validation of its nested times
// (backend/validators.py checks only top-level fields), so these values can
// arrive straight from an API write, not just the UI's time picker.
// "24:00" is accepted and means end-of-day midnight — the schedule uses it for
// a shift that finishes exactly at 00:00 (an 18:00-24:00 evening call), and
// treating it as invalid would silently drop those blocks. "24:30" is not a
// time and is rejected like any other out-of-range value.
function _timeToDecimal(t) {
  var m = /^(\d{1,2}):([0-5]\d)$/.exec(String(t == null ? "" : t).trim());
  if (!m) return NaN;
  var h = +m[1], mm = +m[2];
  if (h > 24 || (h === 24 && mm > 0)) return NaN;
  return h + mm / 60;
}
function _decimalToTime(d) {
  if (d < 0) d += 24;
  var h = Math.floor(d) % 24;
  var m = Math.round((d - Math.floor(d)) * 60);
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

// Lift a break's wall-clock "HH:MM" pair into the decimal frame of the SPAN
// that contains it. Returns { start, end }, or null when the break falls
// outside the span entirely.
//
// Work blocks are normalized into a >24h frame for overnight work: an
// 18:00–02:00 shift becomes 18..26. Breaks, though, are stored as wall-clock
// strings and parse back into 0..24 — so a break taken after midnight lands at
// 00:30 -> 0.5 while its own span runs 18..26, i.e. apparently BEFORE the shift
// started. Normalizing a break only against itself (`if (be <= bs) be += 24`)
// catches a break that straddles midnight but not one wholly past it, which
// rewound the segment cursor and emitted one enormous paid segment: an
// 18:00–02:00 call with a 00:30–01:00 break returned 25 paid hours and 20 hours
// of meal penalty instead of 7.5 and 0. Both callers below share this so the
// engine and the auto meal-break generator can never disagree about which day
// a break belongs to.
function _breakInSpan(brk, spanStart, spanEnd) {
  if (!brk) return null;                        // a null entry in breaks[] threw
  var bs = _timeToDecimal(brk.startTime);
  var be = _timeToDecimal(brk.endTime);
  if (isNaN(bs) || isNaN(be)) return null;      // unparseable — ignore the break
  if (be <= bs) be += 24;                       // the break straddles midnight
  if (bs < spanStart) { bs += 24; be += 24; }   // ...or sits wholly after it
  // A break that starts at or after the span ends belongs to some other span
  // (or is bad data). Dropping it is what keeps the lift above from turning a
  // nonsense break into a giant segment the way the un-lifted value used to.
  if (bs >= spanEnd) return null;
  return { start: bs, end: be };
}

// Full day labor rate across one or more schedule items for a single rate.
//
// This is the canonical engine. A "day" is a set of work blocks (schedule
// items), each { time, endTime, breaks }. Blocks that are contiguous or
// overlapping are merged into one continuous SPAN, so the 5-hour meal-penalty
// clock runs across back-to-back items (an 8a–1p item immediately followed by
// a 1p–3p item is 7 continuous hours → meal penalty). A real GAP between items
// (crew released and called back) splits spans: the gap is unpaid and resets
// the meal clock. Meal penalty is computed per continuous segment; OT (>10h)
// and the half/full tier are computed on the day total.
//
// items = [{ time, endTime, breaks: [{ startTime, endTime, type }] }, ...]
//
// DEFINED RANGE. Shifts run up to 24 hours and routinely cross midnight; both
// are fully supported and pinned by tests (a 22:00-04:00 call with a 01:00
// break, a 14-hour 18:00-08:00 call, a maximal 06:00-06:00 day, and a date
// carrying both a day call and a night call). Property fuzzing over 36,000
// random days found no invariant violation anywhere in that range.
//
// The one shape this function cannot resolve is a date whose blocks span MORE
// than 24 hours end-to-end. There, a wall-clock break like "02:00" maps to two
// different points in the day's frame and nothing in the data says which. That
// requires a single continuous run longer than a day, which the 24-hour shift
// ceiling rules out — so it is out of scope by operating constraint, not merely
// untested. Do not "fix" it by resolving breaks against their owning block
// instead of the span: that was tried and measured, and it changes billing on
// ~5% of ordinary sub-24h days by dropping breaks entered slightly outside
// their own block (a 21:15 break on a 21:45 shift), every difference biased
// toward billing MORE. Span-relative is correct for every reachable input.
window.LTP_calcLaborDay = function(dayRate, items) {
  var EMPTY = { rate: 0, paidHours: 0, unpaidBreakHours: 0, paidBreakHours: 0, mealPenaltyHours: 0, regularOTHours: 0, tier: "", segments: [] };
  if (!dayRate || !items || !items.length) return EMPTY;

  // Normalize items to decimal-hour blocks, dropping any without both times.
  var blocks = [];
  items.forEach(function(it) {
    if (!it || !it.time || !it.endTime) return;
    var start = _timeToDecimal(it.time);
    var end = _timeToDecimal(it.endTime);
    if (isNaN(start) || isNaN(end)) return; // unparseable — skip, don't guess
    if (end <= start) end += 24; // overnight
    blocks.push({ start: start, end: end, breaks: (it.breaks || []).slice() });
  });
  if (!blocks.length) return EMPTY;

  // Sort by start, then merge contiguous/overlapping blocks into spans.
  blocks.sort(function(a, b) { return a.start - b.start; });
  var spans = [];
  var cur = { start: blocks[0].start, end: blocks[0].end, breaks: blocks[0].breaks.slice() };
  for (var bi = 1; bi < blocks.length; bi++) {
    var blk = blocks[bi];
    if (blk.start <= cur.end) { // touching or overlapping → same continuous span
      if (blk.end > cur.end) cur.end = blk.end;
      cur.breaks = cur.breaks.concat(blk.breaks);
    } else {
      spans.push(cur);
      cur = { start: blk.start, end: blk.end, breaks: blk.breaks.slice() };
    }
  }
  spans.push(cur);

  // Within each span, breaks split work segments. Only unpaid break time is
  // deducted; paid breaks keep the crew on the clock. Any segment > 5h accrues
  // meal-penalty OT on the excess.
  var segments = [];
  var mealPenaltyHours = 0;
  var regularHours = 0;
  var unpaidBreakHours = 0;
  var paidBreakHours = 0;

  spans.forEach(function(span) {
    // Normalize into the span's frame FIRST, then sort. Sorting on the raw
    // parse put a 00:30 break (0.5) ahead of a 21:00 one (21) on an overnight
    // span, so even the ordering was wrong before the cursor ever ran.
    var sortedBreaks = [];
    span.breaks.forEach(function(brk) {
      var nb = _breakInSpan(brk, span.start, span.end);
      if (nb) { nb.type = brk.type; sortedBreaks.push(nb); }
    });
    sortedBreaks.sort(function(a, b) { return a.start - b.start; });
    var cursor = span.start;
    sortedBreaks.forEach(function(brk) {
      var bs = brk.start;
      var be = brk.end;
      if (bs > cursor) {
        segments.push({ start: cursor, end: bs, hours: Math.round((bs - cursor) * 100) / 100 });
      }
      // Count only the slice of this break the cursor has not already consumed.
      // Two breaks covering the same window — a crew-wide meal plus an
      // individual one, which LTP_calcDayLabor concatenates for every person
      // (see its shifts.push) — otherwise each contribute their FULL length.
      // Unpaid double-counting inflates the reported break total; PAID
      // double-counting flows into regularHours below and bills time nobody
      // worked: a 4.5h day with one paid break duplicated reported 5.5 paid
      // hours, crossing the 5h boundary and billing a full day for a half.
      // Clipped at BOTH ends: to the cursor (overlap, above) and to the span
      // end, so a break running past the shift — 17:00-18:00 entered on a day
      // that ends 17:30 — cannot contribute time nobody was on site for.
      var effStart = Math.max(bs, cursor);
      var effEnd = Math.min(be, span.end);
      var brkHours = Math.max(0, Math.round((effEnd - effStart) * 100) / 100);
      if (brk.type === "paid") {
        paidBreakHours += brkHours;
      } else {
        unpaidBreakHours += brkHours;
      }
      // Never let the cursor move backwards: two overlapping breaks would
      // otherwise rewind it and inflate the trailing segment — the same
      // failure mode the frame fix above closes. Matches LTP_mealFixBreaks.
      cursor = Math.max(cursor, be);
    });
    if (cursor < span.end) {
      segments.push({ start: cursor, end: span.end, hours: Math.round((span.end - cursor) * 100) / 100 });
    }
  });

  segments.forEach(function(seg) {
    if (seg.hours > 5) {
      mealPenaltyHours += Math.round((seg.hours - 5) * 100) / 100;
      regularHours += 5;
    } else {
      regularHours += seg.hours;
    }
  });

  // Paid breaks count toward paid hours (crew is on clock)
  regularHours += paidBreakHours;
  regularHours = Math.round(regularHours * 100) / 100;

  var regularOTHours = Math.max(0, Math.round((regularHours - 10) * 100) / 100);
  var standardHours = Math.min(regularHours, 10);
  var paidHours = Math.round((regularHours + mealPenaltyHours) * 100) / 100;
  var totalOT = Math.round((mealPenaltyHours + regularOTHours) * 100) / 100;

  var hourlyRate = dayRate / 10;
  var baseRate = standardHours <= 5 ? dayRate * 0.5 : dayRate;
  var otPay = totalOT * hourlyRate * 1.5;
  var rate = Math.round(baseRate + otPay);

  // Tier label
  var tier = "";
  if (paidHours <= 0) tier = "";
  else if (paidHours <= 5 && totalOT === 0) tier = "Half day (" + paidHours + "h)";
  else if (totalOT === 0) tier = "Full day (" + paidHours + "h)";
  else {
    var parts = [];
    if (standardHours > 0) parts.push(standardHours <= 5 ? "Half" : "Full");
    if (mealPenaltyHours > 0) parts.push(mealPenaltyHours + "h meal penalty");
    if (regularOTHours > 0) parts.push(regularOTHours + "h OT");
    tier = parts.join(" + ") + " (" + paidHours + "h)";
  }

  return { rate: rate, paidHours: paidHours, unpaidBreakHours: unpaidBreakHours, paidBreakHours: paidBreakHours, mealPenaltyHours: mealPenaltyHours, regularOTHours: regularOTHours, tier: tier, segments: segments };
};

// Effective person-SLOT for each position within ONE shift's positions.
// A slot is a person-identity within a role for the day: pos.slot when the user
// has set it (> 0), else the lowest unused integer for that role — so two of the
// same role on one shift are distinct people, and positions added in order fall
// back predictably. Returns { [positionId]: slot }. Shared by LTP_calcDayLabor
// and the schedule editor so display and billing group people identically.
window.LTP_effectiveSlots = function(positions) {
  var byRole = {};
  (positions || []).forEach(function(p) { if (p && p.serviceId) { (byRole[p.serviceId] = byRole[p.serviceId] || []).push(p); } });
  var out = {};
  Object.keys(byRole).forEach(function(sid) {
    var list = byRole[sid];
    var used = {};
    list.forEach(function(p) { if (p.slot > 0) used[p.slot] = true; });
    var next = 1;
    list.forEach(function(p) {
      var slot;
      if (p.slot > 0) { slot = p.slot; }
      else { while (used[next]) next++; used[next] = true; slot = next; }
      out[p.id] = slot;
    });
  });
  return out;
};

// Per-day, per-PERSON labor aggregation — the canonical billing model shared by
// the quote builder, the schedule summary, and the editor day totals so all
// three agree on what a day costs.
//
// A day's positions are grouped into UNITS keyed by (role, slot). Each unit is
// one person: positions sharing a role+slot across shifts merge into that
// person's day, so OT and meal penalty are computed on THEIR own hours, and the
// same person spread over several shifts isn't charged as several days. Two of
// the same role on different slots are two different people, tracked separately
// even with differing schedules. Slots default (see LTP_effectiveSlots) so that
// "same role across shifts = one person" and legacy data behave as before.
//
// MINIMUM CHARGES. A service resolved for a client (LTP_servicesForClient) can
// carry `minHours` / `minCostHours`: the day bills / pays as if at least that
// many hours were worked. A 4-hour call against a 10-hour minimum therefore
// bills the FULL day rate, not the half-day rate. Two rules keep it honest:
//   • the minimum floors the NON-PENALTY hours only, so meal-penalty hours
//     always stack on top of it (a 7h straight-through call on a 10h minimum
//     bills a full day PLUS its 2h penalty — the minimum can't absorb a penalty);
//   • the bill minimum and the pay minimum are independent, so a client's 10h
//     guarantee doesn't silently become a 10h payout. That splits the tier: a
//     unit can be billed `full` and paid `half` on the same hours.
// With no minimums set both sides collapse back to the actual hours and every
// figure is bit-identical to before the feature existed.
//
// items    = [{ time, endTime, breaks, positions: [{ serviceId, slot?, fullMargin?, crewId? }] }]
// services = [{ id, dayRate, dayCost, halfDay?, halfDayCost?, otRate?, otCost?,
//               minHours?, minCostHours? }]
// crewMins = optional { [crewId]: minDayCost } — a crew member's negotiated
//   payout floor. When set, that person's COST is computed at the greater of the
//   role's cost and their minimum (the minimum is treated like a normal day rate:
//   half-day → min*0.5, OT → min/10*1.5). RATE (client billing) is never touched.
//   Build one with LTP_crewMinMap(contacts). Absent → no floor (back-compat).
// Returns { units: [{ svc, serviceId, slot, crewId, fullMargin, minApplied,
//   tier:"half"|"full", paidHours, mealPenaltyHours, otHours, dayRate, dayCost,
//   otRate, otCost, rateTotal, costTotal,
//   costTier, billedHours, costHours, costOtHours,   ← the pay-side mirror
//   minHours, minCostHours, minHoursApplied, minCostHoursApplied }],
//   rateTotal, costTotal }.
window.LTP_calcDayLabor = function(items, services, crewMins) {
  var svcById = {}; (services || []).forEach(function(s) { svcById[s.id] = s; });

  // Group positions into labor units. A unit is full-margin only if EVERY one
  // of its positions is flagged (the owner marks all their own shifts); a mixed
  // unit is treated as paid so cost is never zeroed by accident.
  var unitMap = {}; // "serviceId#slot" → { svc, serviceId, slot, shifts, allMargin }
  (items || []).forEach(function(s) {
    var slots = window.LTP_effectiveSlots(s.positions);
    (s.positions || []).forEach(function(p) {
      if (!p.serviceId) return;
      var slot = slots[p.id] || 1;
      var key = p.serviceId + "#" + slot;
      if (!unitMap[key]) unitMap[key] = { svc: svcById[p.serviceId], serviceId: p.serviceId, slot: slot, shifts: [], allMargin: true, crewId: null };
      // A unit is one person (role+slot across the day); capture whoever fills it
      // so a per-crew negotiated minimum can be applied to their cost below.
      if (p.crewId != null && unitMap[key].crewId == null) unitMap[key].crewId = p.crewId;
      // A person's shift carries the item's crew-wide breaks PLUS their own
      // individual breaks (p.breaks) — so a meal break can be given to just
      // this person without affecting everyone else on the shift.
      unitMap[key].shifts.push({ time: s.time, endTime: s.endTime, breaks: (s.breaks || []).concat(p.breaks || []) });
      if (!p.fullMargin) unitMap[key].allMargin = false;
    });
  });

  var units = [];
  var rateTotal = 0, costTotal = 0;
  Object.keys(unitMap).forEach(function(key) {
    var u = unitMap[key];
    var svc = u.svc;
    if (!svc) return;
    var info = window.LTP_calcLaborDay(100, u.shifts);
    if (info.paidHours <= 0) return;

    // Hours the person actually worked, split into the part a minimum can floor
    // (regular) and the part it can't (meal penalty — always billed on top).
    var r2 = function(x) { return Math.round(x * 100) / 100; };
    var regularHours = r2(info.paidHours - info.mealPenaltyHours);
    // Resolve one side (bill or pay) against its minimum. With minH 0 this is
    // exactly the pre-minimums math: ot = meal + regular-over-10, half = ≤5h
    // with no OT of any kind.
    function side(minH) {
      var reg = Math.max(regularHours, minH > 0 ? minH : 0);
      var ot = r2(info.mealPenaltyHours + Math.max(0, r2(reg - 10)));
      return { half: reg <= 5 && ot === 0, ot: ot, hours: r2(reg + info.mealPenaltyHours),
               applied: minH > 0 && minH > regularHours };
    }
    var bill = side(Number(svc.minHours) || 0);
    var pay  = side(Number(svc.minCostHours) || 0);
    var otHours = bill.ot;
    var isHalf = bill.half;
    var tier = isHalf ? "half" : "full";
    var dayRate = isHalf ? (svc.halfDay || svc.dayRate * 0.5) : svc.dayRate;
    var dayCost = pay.half ? (svc.halfDayCost || svc.dayCost * 0.5) : svc.dayCost;
    var otRate = svc.otRate || (svc.dayRate / 10 * 1.5);
    var otCost = svc.otCost || (svc.dayCost / 10 * 1.5);
    var fullMargin = u.allMargin;
    // Per-crew negotiated minimum: floor this person's COST at their minimum day
    // rate, treated like a normal rate — so the half-day pays min*0.5 and OT pays
    // min/10*1.5. Applied per component (never lowers cost), so a role that's
    // already above the minimum on either the day or OT keeps its higher value.
    // Full-margin units are excluded (the owner works their own gig at $0). RATE
    // is deliberately left untouched — the minimum is a payout cost, not billed.
    var minDay = (crewMins && u.crewId != null && crewMins[u.crewId] > 0) ? crewMins[u.crewId] : 0;
    var minApplied = false;
    if (minDay > 0 && !fullMargin) {
      // Floors the PAY tier (which a pay minimum may have promoted to full),
      // not the billed tier — this is a payout figure.
      var floorDay = pay.half ? minDay * 0.5 : minDay;
      var floorOt = minDay / 10 * 1.5;
      if (floorDay > dayCost) { dayCost = floorDay; minApplied = true; }
      if (floorOt > otCost) { otCost = floorOt; minApplied = true; }
    }
    // Rate always bills the person; cost is $0 when the unit is full margin.
    // Each side uses its OWN overtime hours — they differ only when the bill and
    // pay minimums differ.
    var unitRate = dayRate + (bill.ot > 0 ? otRate * bill.ot : 0);
    var unitCost = fullMargin ? 0 : (dayCost + (pay.ot > 0 ? otCost * pay.ot : 0));
    rateTotal += unitRate;
    costTotal += unitCost;

    units.push({
      svc: svc, serviceId: svc.id, slot: u.slot, crewId: u.crewId, fullMargin: fullMargin, minApplied: minApplied, tier: tier,
      paidHours: info.paidHours, mealPenaltyHours: info.mealPenaltyHours, otHours: otHours,
      dayRate: dayRate, dayCost: dayCost, otRate: otRate, otCost: otCost,
      rateTotal: Math.round(unitRate * 100) / 100, costTotal: Math.round(unitCost * 100) / 100,
      // Pay-side mirror of tier/hours/OT. Identical to the billing fields unless
      // the two minimums differ; payout code (LTP_crewDayPay / LTP_crewDayActuals)
      // reads these so a client's billing minimum never inflates a crew payout.
      costTier: pay.half ? "half" : "full", billedHours: bill.hours, costHours: pay.hours, costOtHours: pay.ot,
      minHours: Number(svc.minHours) || 0, minCostHours: Number(svc.minCostHours) || 0,
      minHoursApplied: bill.applied, minCostHoursApplied: pay.applied,
    });
  });
  units.sort(function(a, b) { return (a.serviceId - b.serviceId) || (a.slot - b.slot); });

  return { units: units, rateTotal: Math.round(rateTotal * 100) / 100, costTotal: Math.round(costTotal * 100) / 100 };
};

// Job-site address for crew-facing surfaces — client-side mirror of
// backend/routes/crew.py::_resolve_site_address. Company-derived when the
// project opts in (so a company address edit flows through live), else the
// typed address; multi-line input flattens to one line.
window.LTP_siteAddress = function(project, companies) {
  if (!project) return "";
  var flat = function(t) { return String(t || "").split("\n").map(function(x) { return x.trim(); }).filter(Boolean).join(", "); };
  if (project.siteUseCompanyAddress && project.companyId) {
    var c = (companies || []).find(function(x) { return x.id === project.companyId; });
    if (c) {
      var locality = [String(c.state || "").trim(), String(c.zip || "").trim()].filter(Boolean).join(" ");
      var tail = [String(c.city || "").trim(), locality].filter(Boolean).join(", ");
      var addr = [flat(c.address), tail].filter(Boolean).join(", ");
      if (addr) return addr;
    }
  }
  return flat(project.siteAddress);
};

// Build the { [crewId]: minDayCost } map LTP_calcDayLabor consumes from the crew
// roster. Only crew with a positive negotiated minimum are included, so a person
// without one behaves exactly as before (role cost, no floor).
window.LTP_crewMinMap = function(contacts) {
  var m = {};
  (contacts || []).forEach(function(c) {
    if (c && c.isCrew && c.minDayCost > 0) m[c.id] = c.minDayCost;
  });
  return m;
};

// Per-PERSON meal-break fix. Given ONE person's shifts (each { time, endTime,
// breaks, positionId }), return the individual unpaid breaks needed to clear
// THEIR meal penalties — each tagged with the positionId (shift) it attaches
// to, so the break lands only on that person, not everyone else on the shift.
// Contiguous shifts merge into one span (the meal clock runs across them) and
// existing breaks (crew-wide or individual) are honored, so it only adds what
// is still missing.
window.LTP_mealFixBreaks = function(shifts) {
  var S = (shifts || []).filter(function(s) { return s && s.time && s.endTime; }).map(function(s) {
    var st = _timeToDecimal(s.time), en = _timeToDecimal(s.endTime);
    if (en <= st) en += 24;
    return { start: st, end: en, breaks: s.breaks || [], positionId: s.positionId };
  }).filter(function(s) {
    // Same skip the engine applies: an unparseable shift is dropped rather
    // than generating meal breaks against a NaN span.
    return !isNaN(s.start) && !isNaN(s.end);
  }).sort(function(a, b) { return a.start - b.start; });
  if (!S.length) return [];

  // Contiguous shifts → one span (a real gap splits spans, matching the engine).
  //
  // The gap test compares against the RUNNING MAX end, not the last pushed
  // piece's end. With a short block nested inside a longer one — 08:00-13:00,
  // 09:00-10:00, 12:00-16:00 — the last piece ends at 10:00, so 12:00 read as a
  // gap and the span split, while LTP_calcLaborDay (which tracks a running max)
  // kept one 08:00-16:00 span. The generator then saw two sub-5h spans, emitted
  // no breaks at all, and the engine still charged 3h of meal penalty: the
  // producer clicks "fix meal breaks", nothing happens, and the day stays
  // mispriced. Both functions must partition a day identically or the fix can
  // never converge.
  var spans = [];
  var cur = [S[0]];
  var curEnd = S[0].end;
  for (var i = 1; i < S.length; i++) {
    if (S[i].start <= curEnd) {
      cur.push(S[i]);
      if (S[i].end > curEnd) curEnd = S[i].end;
    } else {
      spans.push(cur);
      cur = [S[i]];
      curEnd = S[i].end;
    }
  }
  spans.push(cur);

  function posIdAt(pieces, t) {
    for (var k = 0; k < pieces.length; k++) { if (t >= pieces[k].start && t < pieces[k].end) return pieces[k].positionId; }
    return pieces[pieces.length - 1].positionId;
  }

  var added = [];
  spans.forEach(function(pieces) {
    var spanStart = pieces[0].start;
    var spanEnd = pieces.reduce(function(m, p) { return Math.max(m, p.end); }, pieces[0].end);
    var brks = [];
    // Same span-frame normalization the engine uses — without it a pre-existing
    // post-midnight break was placed before the span start here too, so the
    // generator measured the wrong work segments and inserted meal breaks that
    // the engine then priced as a 20-hour penalty.
    pieces.forEach(function(p) { (p.breaks || []).forEach(function(b) {
      var nb = _breakInSpan(b, spanStart, spanEnd);
      if (nb) brks.push(nb);
    }); });
    var guard = 0;
    while (guard++ < 24) {
      // Build work segments (span minus the breaks gathered so far).
      var sorted = brks.slice().sort(function(a, b) { return a.start - b.start; });
      var segs = []; var cursor = spanStart;
      sorted.forEach(function(b) { if (b.start > cursor) segs.push({ start: cursor, end: b.start }); cursor = Math.max(cursor, b.end); });
      if (cursor < spanEnd) segs.push({ start: cursor, end: spanEnd });
      var bad = null;
      for (var j = 0; j < segs.length; j++) { if (segs[j].end - segs[j].start > 5 + 1e-9) { bad = segs[j]; break; } }
      if (!bad) break; // no segment over 5h → no penalty left
      var bStart = bad.start + 5, bEnd = bStart + 1;
      if (bEnd > spanEnd) { bEnd = spanEnd; bStart = Math.max(bad.start, bEnd - 1); }
      brks.push({ start: bStart, end: bEnd });
      added.push({ positionId: posIdAt(pieces, bStart), id: window.LTP_genId("brk"),
        startTime: _decimalToTime(bStart), endTime: _decimalToTime(bEnd), type: "unpaid" });
    }
  });
  return added;
};

// Simple rate calc (backwards compatible — no breaks)
window.LTP_calcLaborRate = function(dayRate, hours) {
  if (!dayRate || hours <= 0) return 0;
  if (hours <= 5) return Math.round(dayRate * 0.5);
  if (hours <= 10) return dayRate;
  var hourlyRate = dayRate / 10;
  return Math.round(dayRate + ((hours - 10) * hourlyRate * 1.5));
};
window.LTP_calcLaborTier = function(hours) {
  if (hours <= 0) return "";
  if (hours <= 5) return "Half day (" + hours + "h)";
  if (hours <= 10) return "Full day (" + hours + "h)";
  return "Full + " + Math.round((hours - 10) * 100) / 100 + "h OT (" + hours + "h)";
};
// Calculate hours between two time strings "HH:MM"
window.LTP_calcHours = function(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  var sp = startTime.split(":"), ep = endTime.split(":");
  var sh = parseInt(sp[0], 10) + parseInt(sp[1], 10) / 60;
  var eh = parseInt(ep[0], 10) + parseInt(ep[1], 10) / 60;
  if (eh <= sh) eh += 24; // overnight
  return Math.round((eh - sh) * 100) / 100;
};
