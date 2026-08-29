// LTP Brand Theme — the slate + brand-orange system shared with the
// customer-facing surfaces (modules/client-view.js, modules/crew-view.js,
// backend/email_compose.py), with the masthead orange as the single accent.
//
// NOTE: accent/success/warn/danger/info (and text*) MUST stay 6-digit hexes —
// several call sites build translucent fills by appending alpha ("18"/"44").
window.LTP_THEME = {
  // Slate surface ramp: page field → card/panel → control fill, hairline
  // border. A step DARKER than the public client pages' field — the app is
  // lived-in all day, so surfaces recede and the content carries the light.
  // Keep in sync with the hardcoded slate hexes in index.html (body,
  // scrollbars, select options, .ltp-list hairlines).
  bg: "#131C21", surface: "#19242B", raised: "#22303A", border: "#2E3E48",
  // Brand orange family (sampled from the masthead artwork)
  accent: "#EF5822", accentHover: "#FF6B35", accentMuted: "#4A2313", accentSoft: "#F9B998",
  text: "#EDF3F2", textSec: "#93A3AB", textMut: "#6E7E86",
  // Feedback hues — soft-on-slate; *Bg/*Bd are the translucent badge fills
  success: "#5FD08A", successBg: "rgba(95,208,138,0.10)", successBd: "rgba(95,208,138,0.32)",
  warn: "#F5B83D", warnBg: "rgba(245,184,61,0.10)", warnBd: "rgba(245,184,61,0.32)",
  danger: "#F0857A", dangerBg: "rgba(240,133,122,0.10)", dangerBd: "rgba(240,133,122,0.32)",
  info: "#6FA8F5", infoBg: "rgba(111,168,245,0.10)", infoBd: "rgba(111,168,245,0.32)",
  // Shared brand strokes — identical values to the client/crew views
  gradBtn: "linear-gradient(135deg,#FF921E,#EF5822)",
  gradRule: "linear-gradient(90deg,#FF921E 0%,#EF5822 50%,#64260F 100%)",
  btnInk: "#1B130D",   // near-black ink on orange/colored fills
  mono: "'SFMono-Regular',ui-monospace,'Roboto Mono','DM Mono',Menlo,monospace",
};
// Generate badge colors from a single hex: { bg, text, bd }
window.LTP_badgeFromHex = function(hex) {
  if (!hex) hex = "#666666";
  // Parse hex to RGB
  var r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
  return {
    bg: "rgba(" + r + "," + g + "," + b + ",0.12)",
    text: hex,
    bd: "rgba(" + r + "," + g + "," + b + ",0.35)"
  };
};

// Get department tag color (reads from settings tagColors)
window.LTP_deptColor = function(dept) {
  var tc = (window.LTP_TAG_COLORS || {});
  return tc[dept] || "#6FA8F5";
};

// Status badges — every entry is the soft translucent treatment the customer
// views use (12% fill / 35% border via LTP_badgeFromHex), keyed by semantic hue.
(function() {
  var b = window.LTP_badgeFromHex;
  var GREEN = "#5FD08A", RED = "#F0857A", BLUE = "#6FA8F5",
      AMBER = "#F5B83D", ORANGE = "#FF8A50", GREY = "#8A99A0";
  window.LTP_STATUS_COLORS = {
    active: b(GREEN),
    inactive: b(GREY),
    "one-time": b(BLUE),
    prospect: b(AMBER),
    client: b(GREEN),
    vendor: b(BLUE),
    available: b(GREEN),
    partial: b(AMBER),
    rented: b(ORANGE),
    accepted: b(GREEN),
    pending: b(AMBER),
    draft: b("#6E7E86"),
    sent: b(BLUE),
    paid: b(GREEN),
    overdue: b(RED),
    declined: b(RED),
    converted: b(GREEN),
    invoiced: b(ORANGE),
    requesting: b(ORANGE),
    completed: b(GREEN),
    cancelled: b(GREY),
    booked: b(AMBER),
    rental: b(BLUE),
    labor: b(AMBER),
    service: b(GREEN),
    "full-production": b(ORANGE),
    "in-progress": b(AMBER),
    upcoming: b(BLUE),
  };
})();
window.LTP_PROJECT_CATS = ["Rental", "Labor", "Service", "Full Production"];
window.LTP_CAT_KEYS = { "Rental": "rental", "Labor": "labor", "Service": "service", "Full Production": "full-production" };
window.LTP_CAT_COLORS = { "Rental": "#6FA8F5", "Labor": "#F5B83D", "Service": "#5FD08A", "Full Production": "#FF8A50" };
window.LTP_MODULES = [
  { id: "dashboard", label: "Dashboard"  },
  { id: "crm",       label: "CRM"        },
  { id: "projects",  label: "Projects"   },
  { id: "calendar",  label: "Calendar"   },
  { id: "rentals",   label: "Rentals"    },
  { id: "quotes",    label: "Quotes"     },
  { id: "invoices",  label: "Invoicing"  },
  { id: "labor",     label: "Labor"      },
  { id: "settings",  label: "Settings"   },
];

// Global date formatter: "2026-04-22" => "April 22nd, 2026"
window.LTP_formatDate = function(dateStr) {
  if (!dateStr) return "";
  var parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  var months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  var y = parts[0], m = parseInt(parts[1], 10), d = parseInt(parts[2], 10);
  var suffix = "th";
  if (d === 1 || d === 21 || d === 31) suffix = "st";
  else if (d === 2 || d === 22) suffix = "nd";
  else if (d === 3 || d === 23) suffix = "rd";
  return months[m - 1] + " " + d + suffix + ", " + y;
};

// Duration calculator: given start date/time and end date/time, return human string
window.LTP_calcDuration = function(startDate, startTime, endDate, endTime) {
  if (!startDate || !startTime || !endDate || !endTime) return "";
  var s = new Date(startDate + "T" + startTime);
  var e = new Date(endDate + "T" + endTime);
  var diff = e - s;
  if (diff <= 0) return "";
  var hrs = Math.floor(diff / 3600000);
  var mins = Math.floor((diff % 3600000) / 60000);
  if (hrs > 0 && mins > 0) return hrs + "h " + mins + "m";
  if (hrs > 0) return hrs + "h";
  return mins + "m";
};

// Time formatter: "14:00" => "2:00 PM", "08:30" => "8:30 AM"
window.LTP_formatTime = function(timeStr) {
  if (!timeStr) return "";
  var parts = timeStr.split(":");
  if (parts.length < 2) return timeStr;
  var hr = parseInt(parts[0], 10);
  var min = parts[1];
  var ampm = hr >= 12 ? "PM" : "AM";
  var hr12 = hr % 12;
  if (hr12 === 0) hr12 = 12;
  return hr12 + ":" + min + " " + ampm;
};

// ── Shared Utilities ─────────────────────────────────────────────────────────
var _idCounter = 0;
window.LTP_genId = function(prefix) { _idCounter++; return (prefix || "x") + "-" + Date.now() + "-" + _idCounter; };
window.LTP_todayISO = function() { return new Date().toISOString().substring(0, 10); };

// 256-bit URL-safe random token, equivalent to Python's secrets.token_urlsafe(32).
// Used by quote/invoice save flows to mint a share_token at the moment of
// creation, so the entity's React state has the token immediately — the
// Preview button (gated on draft.shareToken) appears without waiting for
// the server round-trip. Backend's create() respects a client-supplied
// shareToken (only mints when absent), so this is the source of truth.
window.LTP_genShareToken = function() {
  var bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // Base64-encode → URL-safe → strip padding.
  var b64 = "";
  for (var i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
  return btoa(b64).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// Unsaved-changes guard. Owns the dirty-state for the calling component
// and keeps window.__LTP_UNSAVED in sync — synchronously, not via useEffect.
//
// Why synchronous matters: router.navigate() reads window.__LTP_UNSAVED in
// the click handler. If a save() does
//     setIsDirty(false);
//     nav("quotes/" + newId);
// React queues the state update but doesn't commit until the handler
// returns. A useEffect-based mirror would still see the OLD value of
// isDirty when nav() runs, and the user would get a bogus "You have
// unsaved changes" prompt right after a successful save.
//
// API change: this hook used to take `isDirty` as an arg and just mirror
// to the global from a useEffect. It now OWNS the state — caller does:
//     var [isDirty, setIsDirty] = window.LTP_useUnsavedGuard();
// Every call to setIsDirty writes the global immediately, then schedules
// the React update. Both are in sync at every observable moment.
//
// (Render-time mirror is also kept as belt-and-suspenders — covers the
// rare cases where state changes from somewhere other than the returned
// setter, e.g. component re-mount.)
window.LTP_useUnsavedGuard = function() {
  var pair = React.useState(false);
  var isDirty = pair[0];
  var setRaw = pair[1];

  // Render-time mirror keeps the global in sync with whatever value React
  // is currently rendering. Catches the unmount/remount case.
  window.__LTP_UNSAVED = !!isDirty;

  // Setter that writes the global FIRST (synchronously), then schedules
  // the React state update. Supports the (prev) => next functional form.
  function setIsDirty(next) {
    var resolved = typeof next === "function" ? !!next(isDirty) : !!next;
    window.__LTP_UNSAVED = resolved;
    setRaw(resolved);
  }

  React.useEffect(function() {
    function onBeforeUnload(e) { if (isDirty) { e.preventDefault(); e.returnValue = ""; } }
    window.addEventListener("beforeunload", onBeforeUnload);
    return function() {
      window.removeEventListener("beforeunload", onBeforeUnload);
      // Component leaving the tree no longer owns any dirty state.
      window.__LTP_UNSAVED = false;
    };
  }, [isDirty]);

  return [isDirty, setIsDirty];
};

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

// ── Per-client service rates (negotiated contract rates + day minimums) ─────
//
// A client can negotiate a different rate for SPECIFIC roles — "A1 for FUMC is
// a reduced day rate, but carries a full 10-hour day minimum". Those overrides
// live one row per (client, service) in the `clientRates` entity
// (backend/models.py::ClientRate); a role with no row bills the base card
// exactly as before.
//
// The whole feature resolves at ONE seam: LTP_servicesForClient folds a client's
// overrides into the rate card, and every downstream consumer (the labor engine,
// LTP_serviceRateMaps, the quote/invoice pickers, the schedule editor) keeps
// taking a plain `services` array and needs no client awareness at all.
//
// A resolved service carries two extra fields the base card doesn't have:
//   minHours / minCostHours — minimum billable / payable hours for a day (see
//     LTP_calcDayLabor, the only place they're interpreted)
//   clientRate — { id, label, notes } marking it as overridden (UI badges)

// Normalize any client-bearing entity (quote, invoice, or project) to the
// { clientType, companyId, clientContactId } shape the lookups key on. Returns
// null when there's no client to match — an unassigned quote or an internal
// project bills base rates.
window.LTP_clientRef = function(entity) {
  if (!entity) return null;
  if (entity.clientType === "contact") {
    return entity.clientContactId != null
      ? { clientType: "contact", companyId: null, clientContactId: entity.clientContactId } : null;
  }
  // Everything else (including a project, which is always billed to its company)
  // keys on companyId.
  return entity.companyId != null
    ? { clientType: "company", companyId: entity.companyId, clientContactId: null } : null;
};

// Does this override row belong to `ref`'s client? Inactive rows never match.
window.LTP_clientRateMatches = function(row, ref) {
  if (!row || !ref || row.active === false) return false;
  if (ref.clientType === "contact") {
    return row.clientType === "contact" && row.clientContactId != null
      && row.clientContactId === ref.clientContactId;
  }
  return row.clientType !== "contact" && row.companyId != null && row.companyId === ref.companyId;
};

// { [serviceId]: row } for one client. Later rows win, so a duplicate created by
// two tabs resolves deterministically instead of applying twice.
window.LTP_clientRateMap = function(clientRates, ref) {
  var out = {};
  if (!ref) return out;
  (clientRates || []).forEach(function(r) {
    if (window.LTP_clientRateMatches(r, ref) && r.serviceId != null) out[r.serviceId] = r;
  });
  return out;
};

// A finite, non-negative number, else null. "" / null / undefined / NaN all mean
// "not set" → inherit. 0 is a REAL value (a genuinely free tier).
function _crNum(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  return (isFinite(n) && n >= 0) ? n : null;
}

// Fold ONE override row into ONE service, returning a new resolved service.
//
// Derived-tier rule: the base card stores 0 for a tier that should derive from
// the day rate (LTP_serviceRateMaps reads `svc.halfDay || svc.dayRate * 0.5`).
// So when a contract restates the DAY rate but not the half/hourly/OT tier, the
// tier must derive from the NEW day rate — inheriting the base card's absolute
// half-day next to a discounted day rate would price the contract wrong. Passing
// 0 through re-triggers that derivation. A tier the contract DOES restate is
// used verbatim on both sides.
window.LTP_applyClientRate = function(svc, row) {
  if (!svc || !row) return svc;
  var out = Object.assign({}, svc);
  var dayR = _crNum(row.dayRate), dayC = _crNum(row.dayCost);
  function tier(key, ovr, dayOverridden) {
    var v = _crNum(ovr);
    if (v !== null) out[key] = v;
    else if (dayOverridden) out[key] = 0;   // 0 = derive from the new day rate
  }
  if (dayR !== null) out.dayRate = dayR;
  tier("halfDay",    row.halfDay,    dayR !== null);
  tier("hourlyRate", row.hourlyRate, dayR !== null);
  tier("otRate",     row.otRate,     dayR !== null);
  if (dayC !== null) out.dayCost = dayC;
  tier("halfDayCost", row.halfDayCost, dayC !== null);
  tier("hourlyCost",  row.hourlyCost,  dayC !== null);
  tier("otCost",      row.otCost,      dayC !== null);
  out.minHours     = _crNum(row.minHours) || 0;
  out.minCostHours = _crNum(row.minCostHours) || 0;
  out.clientRate = { id: row.id, label: row.label || "", notes: row.notes || "" };
  return out;
};

// The rate card AS THIS CLIENT SEES IT — base services with their overrides
// folded in. Returns the SAME array reference when nothing applies, so callers
// memoizing on identity don't re-render for clients with no negotiated rates.
window.LTP_servicesForClient = function(services, clientRates, ref) {
  var list = services || [];
  if (!ref || !clientRates || !clientRates.length) return list;
  var byService = window.LTP_clientRateMap(clientRates, ref);
  var hit = false;
  var out = list.map(function(s) {
    var row = s && byService[s.id];
    if (!row) return s;
    hit = true;
    return window.LTP_applyClientRate(s, row);
  });
  return hit ? out : list;
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

// Aggregate confirmed crew work across all projects into payout rows for a date
// range. One row = one person's day on one project. Each row carries:
//   locked  — the pay snapshot agreed at confirm (null on legacy pre-snapshot
//             confirmations → "unlocked")
//   current — the same day recomputed with today's schedule/rates/minimums
//   drift   — locked exists but no longer matches current (unsigned rows only —
//             a signed day's figure is frozen, drift no longer applies)
//   signed  — { state: worked|adjusted|no_show, pay, signedAt, signedBy } from
//             the day-of sign-off, or null while the day is still pending
//   adjustments/adjTotal — manual extras/deductions for the day (LTP_setPayAdjustments)
//   estimate — (locked else current) + adjustments: the pre-sign-off figure
//   payable — the FINAL figure (signed.pay.total + adjustments); null until signed off.
// Payout requires sign-off: grandTotal sums signed days only; pending days are
// counted separately (pendingCount/pendingTotal of estimates).
//
// `clientRates` (optional) re-prices the RECOMPUTED figure per project against
// that project's client — a project for a client with a negotiated payout rate
// or hours minimum recomputes on those, so "drift" compares like with like.
// Omit it and every project prices off the base card exactly as before.
window.LTP_payoutRows = function(projects, contacts, services, startDate, endDate, clientRates) {
  var crewMins = window.LTP_crewMinMap(contacts);
  var byCrew = {};   // String(crewId) → { crewId, rows: [] }
  (projects || []).forEach(function(proj) {
    // A project is always billed to its company; an internal/manual shift has
    // none and prices off the base card.
    var svcs = window.LTP_servicesForClient(services, clientRates, window.LTP_clientRef(proj));
    var byDate = {};
    (proj.schedule || []).forEach(function(s) {
      if (!s.date) return;
      if (startDate && s.date < startDate) return;
      if (endDate && s.date > endDate) return;
      (byDate[s.date] = byDate[s.date] || []).push(s);
    });
    Object.keys(byDate).forEach(function(d) {
      var seen = {};  // String(crewId) → { id, locked, work, states, adj }
      byDate[d].forEach(function(s) {
        (s.positions || []).forEach(function(p) {
          if (!p || p.crewId == null || p.status !== "confirmed") return;
          var k = String(p.crewId);
          if (!seen[k]) seen[k] = { id: p.crewId, locked: null, work: null, states: {}, adj: null };
          if (p.pay && !seen[k].locked) seen[k].locked = p.pay;
          if (p.work) { if (!seen[k].work) seen[k].work = p.work; seen[k].states[p.work.state] = true; }
          if (p.adj && p.adj.length && !seen[k].adj) seen[k].adj = p.adj;
        });
      });
      Object.keys(seen).forEach(function(k) {
        var entry = seen[k];
        var current = window.LTP_crewDayPay(byDate[d], entry.id, svcs, crewMins);
        var locked = entry.locked;
        var signed = null;
        if (entry.work && entry.work.pay) {
          // Day state rolls up from the position states: all no-show → no_show,
          // any adjusted (or a dropped shift alongside worked ones) → adjusted.
          var st = entry.states.no_show && !entry.states.worked && !entry.states.adjusted ? "no_show"
            : (entry.states.adjusted || entry.states.no_show) ? "adjusted" : "worked";
          signed = { state: st, pay: entry.work.pay, signedAt: entry.work.signedAt, signedBy: entry.work.signedBy };
        }
        var drift = !!(!signed && locked && (!current
          || Math.abs(locked.total - current.total) > 0.005
          || locked.paidHours !== current.paidHours
          || locked.otHours !== current.otHours));
        // Adjustments (extras/deductions) sit on top of both the pre-sign-off
        // estimate and the frozen final. Drift compares BASE figures only —
        // an adjustment shifts locked and current equally.
        var adjustments = entry.adj || [];
        var adjTotal = Math.round(adjustments.reduce(function(t, a) { return t + (a.amount || 0); }, 0) * 100) / 100;
        var estimate = Math.round(((locked ? locked.total : (current ? current.total : 0)) + adjTotal) * 100) / 100;
        if (!byCrew[k]) byCrew[k] = { crewId: entry.id, rows: [] };
        byCrew[k].rows.push({ crewId: entry.id, projectId: proj.id, projectName: proj.name,
          date: d, locked: locked, current: current, drift: drift,
          signed: signed, adjustments: adjustments, adjTotal: adjTotal, estimate: estimate,
          payable: signed ? Math.round((signed.pay.total + adjTotal) * 100) / 100 : null });
      });
    });
  });
  var groups = Object.keys(byCrew).map(function(k) {
    var g = byCrew[k];
    var cm = (contacts || []).find(function(c) { return c.id === g.crewId; });
    g.crewName = cm ? ((cm.firstName || "") + " " + (cm.lastName || "")).trim() : "Unknown";
    g.rows.sort(function(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.projectName < b.projectName ? -1 : 1); });
    g.total = Math.round(g.rows.reduce(function(t, r) { return t + (r.payable || 0); }, 0) * 100) / 100;
    g.pendingTotal = Math.round(g.rows.reduce(function(t, r) { return t + (r.signed ? 0 : r.estimate); }, 0) * 100) / 100;
    return g;
  });
  groups.sort(function(a, b) { return a.crewName < b.crewName ? -1 : 1; });
  var grandTotal = 0, pendingTotal = 0, pendingCount = 0, driftCount = 0, unlockedCount = 0;
  groups.forEach(function(g) {
    grandTotal += g.total;
    pendingTotal += g.pendingTotal;
    g.rows.forEach(function(r) {
      if (!r.signed) { pendingCount++; if (r.drift) driftCount++; if (!r.locked) unlockedCount++; }
    });
  });
  return { groups: groups, grandTotal: Math.round(grandTotal * 100) / 100,
    pendingTotal: Math.round(pendingTotal * 100) / 100, pendingCount: pendingCount,
    driftCount: driftCount, unlockedCount: unlockedCount };
};

// ── Pay periods (bi-weekly payroll cycles) ───────────────────────────────────
//
// A pay period is a fixed-length window (default 14 days) that tiles the calendar
// from a configured anchor date. All arithmetic is whole-UTC-day math so no
// wall-clock/DST term ever enters — every date maps to exactly one integer-indexed
// period (dates before the anchor get negative indices; there are no gaps). Inputs
// and outputs are date-only ISO strings "YYYY-MM-DD".
//
// The Python mirror is backend/payouts.py (pay_period_index / pay_period_bounds) —
// the two MUST agree; tests/fixtures/payout_periods.json locks them together.
//
// Helpers return null (never throw) on a missing/invalid anchor or date so callers
// can fall back to the week/month presets.

// Whole days between the UNIX epoch and an ISO date, in UTC. Returns null for a
// malformed or overflow-normalized date (e.g. "2026-02-31").
function _ppEpochDays(iso) {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  var p = iso.split("-");
  var y = parseInt(p[0], 10), m = parseInt(p[1], 10), d = parseInt(p[2], 10);
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  var t = Date.UTC(y, m - 1, d);
  if (isNaN(t)) return null;
  var back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return Math.floor(t / 86400000);
}
function _ppISO(days) {
  var dt = new Date(days * 86400000);
  return dt.getUTCFullYear() + "-" + String(dt.getUTCMonth() + 1).padStart(2, "0") + "-" + String(dt.getUTCDate()).padStart(2, "0");
}
function _ppLen(lengthDays) {
  var n = parseInt(lengthDays, 10);
  return (n >= 1 && n <= 31) ? n : 14;   // guard/default to bi-weekly
}

// Integer index of the period containing `dateISO` (0 = the anchor's own period).
window.LTP_payPeriodIndex = function(anchorISO, lengthDays, dateISO) {
  var a = _ppEpochDays(anchorISO), d = _ppEpochDays(dateISO);
  if (a === null || d === null) return null;
  return Math.floor((d - a) / _ppLen(lengthDays));
};

// { index, start, end } for a given period index (end inclusive = start + len - 1).
window.LTP_payPeriodForIndex = function(anchorISO, lengthDays, index) {
  var a = _ppEpochDays(anchorISO);
  if (a === null || typeof index !== "number" || isNaN(index)) return null;
  var len = _ppLen(lengthDays);
  var startDays = a + index * len;
  return { index: index, start: _ppISO(startDays), end: _ppISO(startDays + len - 1) };
};

// The period { index, start, end } containing `asOfISO`.
window.LTP_payPeriodBounds = function(anchorISO, lengthDays, asOfISO) {
  var idx = window.LTP_payPeriodIndex(anchorISO, lengthDays, asOfISO);
  if (idx === null) return null;
  return window.LTP_payPeriodForIndex(anchorISO, lengthDays, idx);
};

// The pay date for a period: its end date plus `offsetDays` (e.g. period ends
// Sunday, offset 5 → the following Friday).
window.LTP_payPeriodPayDay = function(endISO, offsetDays) {
  var e = _ppEpochDays(endISO);
  if (e === null) return null;
  var off = parseInt(offsetDays, 10);
  if (isNaN(off) || off < 0) off = 0;
  return _ppISO(e + off);
};

// Human label for a period, e.g. "July 6th, 2026 – July 19th, 2026".
window.LTP_payPeriodLabel = function(startISO, endISO) {
  if (!startISO || !endISO) return "";
  return window.LTP_formatDate(startISO) + " – " + window.LTP_formatDate(endISO);
};

// { year, year2, number } for a period index — 'number' is the 1-based ordinal
// of this period within its start date's calendar year (period #1 = first period
// starting that year; resets each January). Drives the "PAY-26-14" bill number
// and the navigator's "Period 14 · 2026" label. Python mirror:
// backend/payouts.py::pay_period_number_in_year.
window.LTP_payPeriodNumberInYear = function(anchorISO, lengthDays, index) {
  var pp = window.LTP_payPeriodForIndex(anchorISO, lengthDays, index);
  if (!pp) return null;
  var aDays = _ppEpochDays(anchorISO);
  var year = new Date(_ppEpochDays(pp.start) * 86400000).getUTCFullYear();
  var len = _ppLen(lengthDays);
  var idxJan1 = Math.floor((_ppEpochDays(year + "-01-01") - aDays) / len);
  var startJan1Year = new Date((aDays + idxJan1 * len) * 86400000).getUTCFullYear();
  var firstIdx = (startJan1Year === year) ? idxJan1 : idxJan1 + 1;
  return { year: year, year2: year % 100, number: index - firstIdx + 1 };
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

// ── textToHtml ──────────────────────────────────────────────────────────
// Convert a body that was typed as plain text (blank lines = paragraphs,
// single newlines = line breaks) into the HTML that the email pipeline
// expects. If the input already contains HTML structure (a <p>, <div>,
// <br>, <h*>, or <table> tag — common when the admin pasted from a
// marketing-tool export), pass it through unchanged.
//
// Why this exists: the email body field accepts both plain text and
// HTML. The send pipeline ALWAYS sends as text/html (multipart/alt with
// a derived text/plain), so plain-text bodies typed at the textarea get
// their whitespace collapsed by every HTML rendering layer downstream
// (Send modal preview, backend sanitizer, recipient mail client).
// This helper bridges the gap so what the user sees in the preview
// matches what their recipient gets.
//
// Detection heuristic: presence of any common block-level or
// line-break tag means "treat as HTML." Markup-free user input gets
// the paragraph + br conversion. The check is intentionally loose —
// false positives (HTML passes through untouched) are fine; false
// negatives (plain-text wrongly classified as HTML) lose the
// formatting we're trying to add.
// Fallback photo URL used when the signed-in user has no Google profile
// picture (rare). Served by the app itself (absolute, so the same URL works
// in the sent email) — the old marketing-site URL started 404ing, leaving a
// broken image in the signature. MUST stay in sync with
// backend/email_compose.py::_photo_fallback_url (_AVATAR_ASSET_PATH).
window.LTP_SIGNATURE_PHOTO_FALLBACK =
  (typeof window !== "undefined" && window.location ? window.location.origin : "")
  + "/assets/logos/ltp-avatar.png";

// Render the {{signature}} placeholder against the currently signed-in
// user, using the workspace-wide signature template from settings.
// This is the FRONTEND counterpart of backend/routes/email.py::_render_signature;
// it exists so the Send-modal preview shows what the recipient will see
// instead of literal {{signature}}. The real substitution at send time
// still happens server-side (authoritative).
//
// {{userPhoto}} resolves to the Google profile picture, falling back
// to the LTP logo when absent. Other placeholders coerce missing
// values to empty string so the template never leaks literal {{...}}.
window.LTP_renderSignature = function(template) {
  if (!template) return "";
  return template
    .replace(/\{\{userName\}\}/g, window.LTP_SENDER_NAME || "")
    .replace(/\{\{userEmail\}\}/g, window.LTP_SENDER_EMAIL || "")
    .replace(/\{\{userTitle\}\}/g, window.LTP_SENDER_TITLE || "")
    .replace(/\{\{userPhone\}\}/g, window.LTP_SENDER_PHONE || "")
    .replace(/\{\{userPhoto\}\}/g, window.LTP_SENDER_PHOTO || window.LTP_SIGNATURE_PHOTO_FALLBACK);
};

// ── Customer-facing email {{header}} block ───────────────────────────────
// The {{header}} placeholder renders a branded "action box" at the top of
// quote / invoice / receipt emails: a card with the refNumber + project +
// total summary and one centered call-to-action button. The box container
// is identical across types (the same crew-availability box, so every email
// reads the same); ONLY the CTA label differs by type — hence the per-type
// map below. This used to be a single editable emailHeaderTemplate in
// Settings, but each email type needs its own button wording, so the header
// is generated here per type instead of stored as one shared string.
//
// `kind` is one of "quote" | "invoice" | "receipt" (passed by each send
// modal). Unknown/empty kinds fall back to the quote label so a header
// never renders an empty button.
window.LTP_HEADER_CTA = {
  quote: "View &amp; Accept or Decline",
  invoice: "View &amp; Download",
  receipt: "View Receipt",
};

// Build the {{header}} block for `kind`, baking in the per-entity tokens
// (refNumber / projectName / total) so the Send-modal preview shows real
// values AND the expanded HTML carries them to the backend. {{viewUrl}} is
// INTENTIONALLY left literal: it's per-recipient (each To/CC gets its own
// tracking_token) and only the backend knows the token — the backend's
// per-recipient chain swaps href="{{viewUrl}}" for the real URL just before
// the wire. Kept structurally in sync with the box the crew emails use
// (backend/routes/crew.py::_crew_header_html) so the card reads identically;
// tests/test_header_block.py pins the structure + per-type labels.
window.LTP_renderHeader = function(kind, vars) {
  vars = vars || {};
  var cta = window.LTP_HEADER_CTA[kind] || window.LTP_HEADER_CTA.quote;
  // Invoice emails emphasize the financials: a larger reference + total plus a
  // due-date line. Quotes/receipts keep the standard (smaller) sizing and have
  // no due date.
  var invoice = (kind === "invoice");
  var refPx = invoice ? 14 : 12;
  var totalPx = invoice ? 17 : 14;
  var totalWeight = invoice ? "font-weight:bold;" : "";
  // The total's bottom gap closes up when a due-date line follows it.
  var totalGap = (invoice && vars.dueDate) ? 2 : 18;
  var dueLine = (invoice && vars.dueDate)
    ? '<div style="font-size:14px;color:#233038;margin-bottom:18px">Due ' + vars.dueDate + '</div>'
    : '';
  return '<div style="padding:0px">'
    + '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" '
    + 'style="width:100%;margin-top:5px;background-color:#f7f9fa;border:1px solid #eceef0;border-radius:10px">'
    + '<tbody><tr><td style="padding:22px;text-align:center">'
    + '<div style="font-size:' + refPx + 'px;color:#8a949e;text-transform:uppercase;letter-spacing:0.06em">' + (vars.refNumber || "") + '</div>'
    + '<div style="font-size:19px;font-weight:bold;color:#233038;margin:4px 0 2px">' + (vars.projectName || "") + '</div>'
    + '<div style="font-size:' + totalPx + 'px;color:#233038;' + totalWeight + 'margin-bottom:' + totalGap + 'px">' + (vars.total || "") + '</div>'
    + dueLine
    + '<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto">'
    + '<tbody><tr><td style="background-color:#f15927;border-radius:7px">'
    + '<a href="{{viewUrl}}" style="display:inline-block;padding:14px 38px;font-size:15px;'
    + 'font-weight:bold;color:#ffffff;text-decoration:none">' + cta + '</a>'
    + '</td></tr></tbody></table>'
    + '</td></tr></tbody></table></div>';
};

// Build a Send-modal preview body: substitute the placeholders the
// backend would normally fill in at send time, so the preview pane
// shows the SAME shape the recipient gets. Real send still leaves
// these placeholders intact for backend resolution.
//
// `viewUrl` should be the entity's share-link URL with no `?r=` (or a
// sample one); `signatureTemplate` should be the workspace signature
// template string (frontend reads settings.emailSignatureTemplate with
// the data/settings.js default).
window.LTP_renderPreviewBody = function(body, viewUrl, signatureTemplate) {
  if (!body) return "";
  var sig = window.LTP_renderSignature(signatureTemplate || "");
  return String(body)
    .replace(/\{\{viewUrl\}\}/g, viewUrl || "")
    .replace(/\{\{signature\}\}/g, sig);
};

// ── EmailBodyEditor bidirectional conversion ─────────────────────────────
// The Send modal uses a WYSIWYG contentEditable rather than a textarea —
// the user shouldn't have to look at raw HTML to tweak an email. The
// body that gets STORED + SENT keeps placeholders intact ({{viewUrl}},
// {{signature}}, {{header}}) so the backend can substitute per-recipient
// values. The body that gets DISPLAYED has signature and header
// substituted as non-editable marker blocks (so the user sees what the
// recipient sees without being able to accidentally mangle the
// table-based structure). {{viewUrl}} stays inline in href attributes
// — invisible to the user because it lives in attribute space, not
// text content.
//
// `LTP_bodyToEditableHtml(rawBody, signatureTemplate, headerKind, headerVars)`
//   — call when opening the modal. Produces HTML safe to drop into a
//   contentEditable. headerKind ("quote"|"invoice"|"receipt") selects the
//   header's CTA label; headerVars is {refNumber, projectName, total} for
//   the preview render; if missing the summary lines render empty (only
//   matters in tests or call sites without entity context).
//
// `LTP_editableHtmlToBody(html)` — call on every input event. Reverses
// both substitutions so the stored body still has {{signature}} +
// {{header}} for the backend to resolve.
//
// MARKER WRAPPER: <section class="ltp-sig-block"> and <section
// class="ltp-header-block">. We use <section> instead of <div> because
// the inner template HTML for BOTH blocks contains <div>s — a non-greedy
// /<div[^>]*class="ltp-sig-block"[^>]*>...<\/div>/ regex would match
// the first inner </div> instead of the wrapper's close. <section> is
// chosen because neither the signature template nor the header template
// contains a <section> tag, so the non-greedy /<section[^>]*>...
// <\/section>/ pattern matches exactly the wrapper. Both class and
// section are in the email sanitizer allowlist; contenteditable is NOT
// (admin-authored templates can't pre-mark blocks as non-editable). The
// editor component re-applies contenteditable="false" via DOM API after
// setting innerHTML.
// Drop a block-level HTML fragment (a <table>-based header/signature, or a
// literal token the backend will expand) into a paragraph-wrapped body at
// BLOCK level. If `token` sits inside a <p>...</p>, the paragraph is split so
// `block` is NOT nested inside the inline <p> — browsers/email clients
// auto-close the <p> at the first <table>, which strands trailing text and
// leaves a stray empty paragraph. Surrounding text in the same <p> stays
// wrapped; empty halves are dropped so "<p>{{token}}</p>" collapses to just
// `block`. Bare tokens outside any <p> are replaced directly. Passing
// block === token re-flattens a wrapped token back to a bare one (used so the
// backend-resolved {{signature}} <table> also lands at block level).
window.LTP_injectBlock = function(html, token, block) {
  if (!html) return html;
  var stripEnds = function(s) {
    return s.replace(/^(?:\s|<br\s*\/?>)+/i, '').replace(/(?:\s|<br\s*\/?>)+$/i, '');
  };
  return String(html).replace(/<p>([\s\S]*?)<\/p>/g, function(match, inner) {
    if (inner.indexOf(token) === -1) return match;
    var pieces = inner.split(token);
    var out = [];
    for (var i = 0; i < pieces.length; i++) {
      var clean = stripEnds(pieces[i]);
      if (clean) out.push('<p>' + clean + '</p>');
      if (i < pieces.length - 1) out.push(block);
    }
    return out.join('\n');
  }).split(token).join(block);  // catch any bare token outside <p>
};

window.LTP_bodyToEditableHtml = function(rawBody, signatureTemplate, headerKind, headerVars) {
  if (!rawBody) return "";
  // 1. Paragraph-wrap FIRST, while the body still has placeholders as
  //    plain-text tokens. If we substituted the blocks first, the
  //    rendered <table>/<div> would trigger textToHtml's block-detection
  //    early and the surrounding plain-text paragraphs wouldn't get
  //    wrapped — collapsing all whitespace in the editor.
  var withParagraphs = window.LTP_textToHtml(String(rawBody));
  // 2. Build the marker blocks.
  var sigBlock = '<section class="ltp-sig-block">'
    + window.LTP_renderSignature(signatureTemplate || "") + '</section>';
  var headerBlock = '<section class="ltp-header-block">'
    + window.LTP_renderHeader(headerKind || "", headerVars || {}) + '</section>';

  // 3. Drop the marker blocks in at block level — LTP_injectBlock splits any
  //    surrounding <p> so the <section><table> isn't nested inside an inline
  //    <p>. Header first (top of body), then signature; order doesn't affect
  //    correctness since paragraphs are split independently.
  var withHeader = window.LTP_injectBlock(withParagraphs, '{{header}}', headerBlock);
  var withSig = window.LTP_injectBlock(withHeader, '{{signature}}', sigBlock);
  return window.LTP_SANITIZE.emailHtml(withSig);
};

window.LTP_editableHtmlToBody = function(html) {
  if (!html) return "";
  // Reverse both marker substitutions. Tolerates single OR double
  // quoted class attribute and any additional attributes (e.g.
  // contenteditable="false" + inline styles added by the editor).
  return String(html)
    .replace(
      /<section[^>]*class\s*=\s*["']ltp-header-block["'][^>]*>[\s\S]*?<\/section>/gi,
      '{{header}}'
    )
    .replace(
      /<section[^>]*class\s*=\s*["']ltp-sig-block["'][^>]*>[\s\S]*?<\/section>/gi,
      '{{signature}}'
    );
};

window.LTP_textToHtml = (function() {
  // Detect block-level structure. If the body already has paragraphs,
  // divs, tables, headings, etc. then it was authored as full HTML and
  // we leave it alone. If only inline tags (<a>, <strong>, <img>) appear
  // — or no tags at all — we paragraph-wrap so blank lines render as
  // <p> blocks and single newlines as <br>. Crucially we DON'T escape
  // inline tags in the plain-text path; the downstream sanitizer
  // (bleach server-side, DOMPurify in-app) is the trust boundary that
  // strips anything dangerous. Escaping here would turn legitimate
  // <a href="{{viewUrl}}">...</a> in plain-text templates into literal
  // "&lt;a href=...&gt;" text in the recipient's inbox — the exact bug
  // this rewrite fixes.
  var BLOCK_DETECT_RE = /<\/?(p|div|h[1-6]|table|tr|td|th|ul|ol|li|blockquote|hr|article|section)\b/i;
  var PLACEHOLDER_RE = /^\{\{\s*\w+\s*\}\}$/;

  // Canonical paragraph styling for every email body. Applied INLINE (email
  // clients strip <style>; bleach's CSS allowlist keeps margin + line-height)
  // so a single source of truth controls paragraph spacing in the sent mail.
  // margin:0 = paragraphs are single-spaced (one line apart) by default; the
  // sender adds blank lines (empty paragraphs) manually for bigger gaps. MUST
  // match the editor's `.ltp-email-editor` rule in index.html so the Send-modal
  // preview renders the same spacing the recipient sees.
  var PARA_STYLE = "margin:0;line-height:1";

  // Give top-level text paragraphs the canonical spacing. This is what makes a
  // body authored across browsers render consistently: Chrome's Enter inserts
  // <p>, Safari's inserts <div>, and a plain-text template has neither — here
  // they all converge on the same inline margin. Idempotent (skips anything
  // that already carries a margin), and leaves structural blocks (tables,
  // lists, nested layout) and lone {{placeholder}} lines untouched so the
  // header/signature blocks substituted downstream aren't disturbed.
  function normalizeParagraphs(htmlStr) {
    if (!htmlStr || typeof document === "undefined") return htmlStr;
    var tmp = document.createElement("div");
    tmp.innerHTML = String(htmlStr);
    var kids = tmp.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      var tag = el.tagName.toLowerCase();
      if (tag !== "p" && tag !== "div") continue;
      var st = el.getAttribute("style") || "";
      if (/margin/i.test(st)) continue;                                  // already spaced
      if (PLACEHOLDER_RE.test((el.textContent || "").trim())) continue;  // lone {{placeholder}}
      if (el.querySelector("table,ul,ol,p,div,blockquote,h1,h2,h3,h4,section,hr")) continue;  // structural
      el.setAttribute("style", PARA_STYLE + (st ? ";" + st : ""));
    }
    return tmp.innerHTML;
  }

  return function(input) {
    if (input == null) return "";
    var s = String(input);
    // Already block-structured (full HTML, or content round-tripped through the
    // contentEditable editor) — normalize the paragraph spacing in place.
    if (BLOCK_DETECT_RE.test(s)) return normalizeParagraphs(s);
    // Plain-text-with-maybe-inline-HTML path: render newlines LITERALLY so the
    // textarea is WYSIWYG — every line becomes its own line, and a blank line
    // becomes a visible empty paragraph (a gap). This matches the contentEditable
    // editor (Enter = next line, Enter-twice = a blank line) so a template and a
    // hand-edited body space identically. No escape — inline tags pass through to
    // the sanitizer. A lone {{placeholder}} line stays bare so the downstream
    // block injection can split it.
    var lines = String(s).split("\n");
    while (lines.length && lines[0].trim() === "") lines.shift();               // trim leading blank lines
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();  // trim trailing blank lines
    if (lines.length === 0) return "";
    return lines.map(function(line) {
      var t = line.trim();
      if (t === "") return '<p style="' + PARA_STYLE + '"><br></p>';            // blank line → gap
      var attr = PLACEHOLDER_RE.test(t) ? "" : ' style="' + PARA_STYLE + '"';
      return "<p" + attr + ">" + line + "</p>";
    }).join("\n");
  };
})();

// ── Invoice & Quote display helpers (used across modules) ────────────────
// Format a client's billing address (Company or Contact) into one string:
// "<street>, City, ST ZIP". `joiner` (default ", ") also replaces newlines in
// the multi-line street field. Used everywhere a client address is displayed
// (CRM, client view) so the structured city/state/zip fields show up too.
// Protocol-guard a user/calendar-supplied URL before using it as an href.
// Anything with an explicit scheme other than http/https/mailto/tel (notably
// javascript:) becomes "" so the link is inert; relative/scheme-relative URLs
// pass (they can't carry a javascript: payload). Control chars are stripped
// first so "java\tscript:" can't slip past. SECURITY_REVIEW.md L7.
window.LTP_safeUrl = function(url) {
  if (!url) return "";
  var s = String(url).replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (/^[a-z][a-z0-9+.\-]*:/i.test(s)) {
    return /^(https?|mailto|tel):/i.test(s) ? s : "";
  }
  return s;
};

// ── Note line items ─────────────────────────────────────────────────────────
// Notes are authored in a plain <textarea> on quotes and invoices, so the
// author's blank lines, indentation and runs of spaces are part of the content
// — they carry meaning (bulleted call-times, indented sub-points). Historically
// the builders stored `noteText.trim()`, which was fine for the emptiness check
// but silently ate a leading indent on the first line.
//
// LTP_noteText normalizes line endings and drops only TRAILING whitespace (a
// stray newline left by the Enter key renders as a blank gap in the PDF and
// client view, and is never intentional). Everything else survives verbatim —
// leading indentation included.
window.LTP_noteText = function(raw) {
  if (raw == null) return "";
  return String(raw).replace(/\r\n?/g, "\n").replace(/[ \t\n]+$/, "");
};

// True when a note has any visible content — the guard for "Add Note".
window.LTP_noteHasText = function(raw) {
  return window.LTP_noteText(raw).trim() !== "";
};

// One-line digest of a note for places that can only show a single line — the
// quote/invoice change log. Takes the first line that has content, collapses
// its internal whitespace and ellipsizes past `max` (default 60).
window.LTP_noteSummary = function(raw, max) {
  var lines = window.LTP_noteText(raw).split("\n");
  var first = "";
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].trim()) { first = lines[i].trim().replace(/\s+/g, " "); break; }
  }
  var lim = max || 60;
  if (first.length > lim) first = first.slice(0, lim - 1).replace(/\s+$/, "") + "…";
  return first;
};

// Shared style fragment for every surface that DISPLAYS note text (builder
// rows, invoice rows, the client-facing view). `pre-wrap` is what makes the
// authored newlines and spacing survive into the DOM; the break rules keep a
// long unbroken token from blowing out the column.
window.LTP_NOTE_TEXT_STYLE = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  wordBreak: "break-word",
};

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

window.LTP_formatAddress = function(e, joiner) {
  if (!e) return "";
  joiner = joiner || ", ";
  var street = (e.address || "").replace(/\n+/g, joiner).trim();
  var city = (e.city || "").trim(), st = (e.state || "").trim(), zip = (e.zip || "").trim();
  var sz = [st, zip].filter(function(x) { return x; }).join(" ");
  var cityLine = (city && sz) ? (city + ", " + sz) : (city || sz);
  return [street, cityLine].filter(function(x) { return x; }).join(joiner);
};

// Settings-shaped address (street/suite/city/state/zip) → single inline string.
// Used by the public client-view and crew-view headers. Distinct from
// LTP_formatAddress, which works on CRM entity shapes (address/city/state/zip).
window.LTP_settingsAddress = function(s) {
  if (!s) return "";
  var line1 = (s.street || "") + (s.suite ? ", " + s.suite : "");
  var line2 = (s.city || "") + (s.state ? ", " + s.state : "") + (s.zip ? " " + s.zip : "");
  return [line1, line2].filter(function(p) { return p && p.trim(); }).join(". ");
};

// Build a Google Calendar "add event" template URL. Shared by the CRM meetings
// and projects views and the public crew call sheet. When {endTime} is given it
// sets the wrap (rolling to the next day for an overnight shift whose wrap is
// earlier than the call); otherwise the event runs one hour (same minutes, hour
// clamped to 23). {location} adds a place; attendees is an array of emails;
// details is optional. Times are floating (no timezone) so they render as the
// posted wall-clock wherever the crew member opens the link.
window.LTP_gcalUrl = function(opts) {
  opts = opts || {};
  var time = opts.time || "00:00";
  var d = (opts.date || "").replace(/-/g, "");
  var startStamp = d + "T" + time.replace(":", "") + "00";
  var endStamp;
  if (opts.endTime) {
    // A wrap earlier than the call means the shift runs past midnight, so the
    // end date advances one calendar day.
    var endD = d;
    if (opts.date && opts.endTime < time) {
      var nd = new Date(opts.date + "T00:00:00");
      nd.setDate(nd.getDate() + 1);
      endD = "" + nd.getFullYear() + String(nd.getMonth() + 1).padStart(2, "0") + String(nd.getDate()).padStart(2, "0");
    }
    endStamp = endD + "T" + opts.endTime.replace(":", "") + "00";
  } else {
    var eh = String(Math.min(23, parseInt(time.split(":")[0]) + 1)).padStart(2, "0");
    endStamp = d + "T" + eh + time.split(":")[1] + "00";
  }
  var url = "https://calendar.google.com/calendar/render?action=TEMPLATE"
    + "&text=" + encodeURIComponent(opts.title || "")
    + "&dates=" + startStamp + "/" + endStamp;
  if (opts.details) url += "&details=" + encodeURIComponent(opts.details);
  if (opts.location) url += "&location=" + encodeURIComponent(opts.location);
  return url + "&add=" + (opts.attendees || []).join(",");
};

// Resolve an entity's display name for an activity-log diff: its name, else
// "ID <n>" when the row is missing, else "None" when unset. Shared by the
// quote/invoice change-diff engines (company + project fields).
window.LTP_diffEntityName = function(list, id) {
  if (!id) return "None";
  return (((list || []).find(function(x) { return x.id === id; }) || {}).name) || ("ID " + id);
};

window.LTP_INVOICE_REF = function(inv) {
  if (!inv) return "INV-?";
  var year = (inv.invoiceDate || "").substring(0, 4) || new Date().getFullYear();
  var num = String(inv.id || 0).padStart(3, "0");
  return "INV-" + year + "-" + num;
};

// Service line rate maps. Given a service's rate card, returns { priceMap,
// costMap } keyed by rate type (day/half/hourly/ot). Half/hourly/OT fall back
// to derived ratios (×0.5, ÷10, ÷10×1.5) when not explicitly set. Single
// source of truth shared by the quote builder and invoice editor so a rate-type
// switch prices identically in both and converted invoices never drift.
window.LTP_serviceRateMaps = function(svc) {
  svc = svc || {};
  return {
    priceMap: { day: svc.dayRate, half: svc.halfDay || svc.dayRate * 0.5, hourly: svc.hourlyRate || svc.dayRate / 10, ot: svc.otRate || svc.dayRate / 10 * 1.5 },
    costMap:  { day: svc.dayCost, half: svc.halfDayCost || svc.dayCost * 0.5, hourly: svc.hourlyCost || svc.dayCost / 10, ot: svc.otCost || svc.dayCost / 10 * 1.5 },
  };
};

// Product pricing variants — alternative pricing structures for ONE product
// (e.g. Transportation: Local Delivery flat / Per Mile / Client Goods), stored
// as product.variants: [{id, label, unitPrice, cost}]. Every variant maps to
// the product's single QB item (the variant label rides in the line name), so
// QuickBooks sync is untouched. These helpers are the single source of truth
// shared by the quote builder, invoice editor, and the Products catalog so a
// variant prices identically everywhere. A product with no usable variants
// prices from its base unitPrice/cost exactly as before variants existed.
window.LTP_productVariants = function(product) {
  var raw = (product && Array.isArray(product.variants)) ? product.variants : [];
  var out = [];
  raw.forEach(function(v) {
    if (!v || !String(v.label == null ? "" : v.label).trim()) return; // unlabeled rows are editor noise
    out.push({
      id: v.id != null ? String(v.id) : "",
      label: String(v.label).trim(),
      unitPrice: Number(v.unitPrice) || 0,
      cost: Number(v.cost) || 0,
    });
  });
  return out;
};

window.LTP_findProductVariant = function(product, variantId) {
  if (variantId == null || variantId === "") return null;
  var list = window.LTP_productVariants(product);
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === String(variantId)) return list[i];
  }
  return null;
};

// Line-item display name for a product (+ chosen variant). The variant label
// is baked into the name so it survives snapshots, prints on quotes/invoices,
// and flows to the QuickBooks line description with zero sync changes.
window.LTP_productVariantName = function(product, variant) {
  var base = (product && product.name) || "";
  return variant ? base + " — " + variant.label : base;
};

// Currency display — always to the cent. Line items can carry fractional
// quantities, so totals and subtotals have real cents; rounding them to whole
// dollars (the app's former display convention) silently dropped that money.
// Returns a thousands-separated two-decimal string WITHOUT a currency symbol,
// so callers keep their own "$" / "−$" prefix. Mirrors the PDF's _fmt_money
// and the client view's fmtMoney so every surface reads to the same cent.
window.LTP_money = function(n) {
  return (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

window.LTP_INVOICE_TOTALS = function(inv) {
  if (!inv) return { subtotal: 0, adjusted: 0, discount: 0, tax: 0, total: 0, paid: 0, balance: 0 };
  // `subtotal` is the ORIGINAL list price and `adjusted` the sum after per-line
  // price overrides — the same split LTP_QUOTE_TOTALS, client-view.js::calcTotals
  // and pdf_generator.py::_calc_totals use, so the "Adjustments" line means the
  // same thing on all four surfaces. This function used to report only the
  // adjusted figure, under the name `subtotal`, with no `adjusted` at all; the
  // invoice editor's adjustments row compared against that missing key and so
  // rendered on every invoice (see modules/invoices.js).
  var subtotal = 0;
  var adjusted = 0;
  (inv.sections || []).forEach(function(sec) {
    (sec.items || []).forEach(function(it) {
      if (it.type === "note") return;
      var qty = it.qty || 0;
      var price = it.adjustedPrice != null ? it.adjustedPrice : (it.unitPrice || 0);
      subtotal += (it.unitPrice || 0) * qty;
      adjusted += price * qty;
    });
  });
  // Global discount. A fixed-dollar discount is "amount" — that is what BOTH
  // builders' "$" option writes (modules/invoices.js, modules/quotes-builder.js).
  // "flat" is a LEGACY ALIAS, accepted forever but never written: it was this
  // function's original spelling and never matched what the invoice UI actually
  // saved, so a "$" discount computed as $0 here (and in the QuickBooks payload)
  // while the client's PDF and share link — which already accepted both — showed
  // it applied. Three parties saw three totals. All four readers now agree:
  // here, backend/qbo_sync.py::_build_sales_lines,
  // backend/pdf_generator.py::_calc_totals, modules/client-view.js::calcTotals.
  // The discount applies to the ADJUSTED figure, not the original list price —
  // same base as the other three readers.
  var gd = inv.globalDiscount || {};
  var discount = 0;
  if (gd.type === "percent") discount = adjusted * (gd.value || 0) / 100;
  else if (gd.type === "amount" || gd.type === "flat") discount = gd.value || 0;
  else if (gd.type === "target") discount = Math.max(0, adjusted - (gd.value || 0));
  // Never discount past zero — an over-large amount or a >100% rate would
  // otherwise show a NEGATIVE total here while the PDF and client view (both
  // of which clamp) showed 0. Same rule as LTP_QUOTE_TOTALS below.
  if (discount > adjusted) discount = adjusted;
  if (discount < 0) discount = 0;
  var afterDiscount = adjusted - discount;
  // Tax is QuickBooks-authoritative: QB computes the sales tax (qbTaxTotal) on
  // push and the whole-invoice total reflects it everywhere LTP_INVOICE_TOTALS is
  // consumed (builder, list, dashboard, client view, PDF). Before any push it is
  // null and tax is 0 — never an estimate off a configured flat rate. This
  // function alone used to apply one, claiming a tax the PDF and the client view
  // both showed as zero; the setting behind it is gone. Same rule as
  // LTP_QUOTE_TOTALS below.
  var tax = (inv.qbTaxTotal != null) ? (Number(inv.qbTaxTotal) || 0) : 0;
  var total = afterDiscount + tax;
  var paid = (inv.payments || []).reduce(function(s, p) { return s + (Number(p.amount) || 0); }, 0);
  return { subtotal: subtotal, adjusted: adjusted, discount: discount, tax: tax,
           preTax: afterDiscount, total: total, paid: paid, balance: Math.max(0, total - paid) };
};

// ── Quote expiration ────────────────────────────────────────────────────────
// A quote's prices are only good for so long. The date that happens on is
// `quote.expiryDate`, set in the builder; when it's empty every reader falls
// back to the workspace default (Settings → Quote Validity, mirrored onto
// LTP_DEFAULT_QUOTE_VALIDITY) counted from the day the quote went out — which
// is the only rule that existed before the field did, so an old quote still
// reads exactly as it always has.
//
// Counting from `sentDate` and not from today matters: an unsent draft has no
// clock running on it yet, so it has no expiry to show. Once it's sent the
// builder stamps a concrete date, and the client's copy stops moving even if
// the workspace default is later changed.

// The workspace fallback, in days. `override` lets a surface that has the
// settings blob but not the app globals pass the value in — the public client
// view loads without a session, so app.js never ran to mirror it onto window.
window.LTP_QUOTE_VALIDITY_DAYS = function(override) {
  var n = Number(override != null && override !== "" ? override : window.LTP_DEFAULT_QUOTE_VALIDITY);
  return (isFinite(n) && n > 0) ? Math.floor(n) : 30;
};

// The ISO date this quote expires, or "" when there's nothing to count from.
// `asOf` (ISO) stands in for the sent date on a quote that hasn't gone out —
// the builder passes today so the field can preview what sending would stamp.
window.LTP_quoteExpiry = function(quote, asOf, validityDays) {
  if (!quote) return "";
  if (quote.expiryDate) return quote.expiryDate;
  var from = quote.sentDate || asOf || "";
  if (!from) return "";
  var d = new Date(from);
  if (isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + window.LTP_QUOTE_VALIDITY_DAYS(validityDays));
  return d.toISOString().substring(0, 10);
};

// True once a quote the client could still act on has gone stale. Only "sent"
// qualifies: a draft was never promised to anyone, and accepted / declined /
// converted are all settled — an accepted quote doesn't un-accept itself
// because a date passed.
window.LTP_isQuoteExpired = function(quote) {
  if (!quote || quote.status !== "sent") return false;
  var exp = window.LTP_quoteExpiry(quote);
  return !!exp && exp < window.LTP_todayISO();
};

// ── Terms & conditions ──────────────────────────────────────────────────────
// The bullet list printed at the foot of a quote or invoice. It used to be a
// hardcoded array in TWO places (backend/pdf_generator.py and the client view),
// so the business could not change its own terms without a code change, and the
// two copies could drift about what a client had been told.
//
// Resolution order, first non-empty wins:
//   1. the document's own `terms`  — edited in the builder, per document
//   2. the workspace default       — Settings → Business Defaults, per kind
//   3. the built-in below          — what the hardcoded arrays used to say
//
// One line per bullet. Blank lines are dropped, so a trailing newline or a
// spacer line in the textarea doesn't print an empty bullet.
//
// PLACEHOLDERS
//   Lines may use the same {{token}} syntax as the email templates, because a
//   term usually needs to name a date the document already knows — and freezing
//   that date into the text is how the printed terms come to contradict the
//   document they're printed on. Supported:
//
//     {{expiryDate}}    quote — the day the pricing stops being good for
//     {{validityDays}}  quote — that same window, in days
//     {{dueDate}}       invoice — the day payment is due
//     {{paymentTerms}}  invoice — the workspace net-terms number
//     {{companyName}}   either
//
//   A line naming a value the document does NOT have is dropped rather than
//   printed with a hole in it: an unsent quote carrying no expiry has no
//   deadline to promise, and "This quote is valid through ." is worse than
//   saying nothing. An UNKNOWN token is left literal instead — a typo should be
//   visible, not silently swallow the line it sits in.
//
// NB: window.LTP_DEFAULT_TERMS is something else entirely (the net payment-terms
// NUMBER, set in app.js) — hence the name here.
window.LTP_BUILTIN_TERMS = {
  quote: [
    "This quote is valid through {{expiryDate}}.",
    "Prices are subject to equipment availability at time of booking.",
    "All equipment rentals are subject to a damage waiver fee.",
    "Payment terms: 50% deposit upon acceptance, balance due prior to load-in.",
    "Cancellation within 72 hours of event may incur a 25% restocking fee.",
  ].join("\n"),
  invoice: [
    "Payment is due within {{paymentTerms}} days of the invoice date unless otherwise specified.",
    "Late payments are subject to a 1.5% monthly finance charge.",
    "Please include the invoice reference number with your payment.",
  ].join("\n"),
};

// The terms TEXT this document should start from — its own, else the workspace
// default, else the built-in. The builders use it to seed the editor and to
// power "Reset to default".
//
// `settings` is passed explicitly rather than read off a global because the
// public client view loads without a session, so app.js never ran there.
window.LTP_docTermsText = function(entity, kind, settings) {
  var k = kind === "invoice" ? "invoice" : "quote";
  var own = entity && entity.terms;
  if (own && String(own).trim()) return String(own);
  var key = k === "invoice" ? "defaultInvoiceTerms" : "defaultQuoteTerms";
  var fromSettings = (settings || {})[key];
  if (fromSettings && String(fromSettings).trim()) return String(fromSettings);
  return window.LTP_BUILTIN_TERMS[k];
};

// The {{token}} values available to a document's terms, by kind.
function _termsVars(entity, kind, settings) {
  var e = entity || {}, s = settings || {};
  if (kind === "invoice") {
    return {
      dueDate: e.dueDate ? window.LTP_formatDate(e.dueDate) : "",
      paymentTerms: String(s.defaultPaymentTerms || 30),
      companyName: s.companyName || "",
    };
  }
  var expiry = window.LTP_quoteExpiry(e, "", s.defaultQuoteValidity);
  return {
    expiryDate: expiry ? window.LTP_formatDate(expiry) : "",
    validityDays: String(window.LTP_QUOTE_VALIDITY_DAYS(s.defaultQuoteValidity)),
    companyName: s.companyName || "",
  };
}

// The resolved bullet lines to PRINT. Every surface that renders terms — the
// builder's preview, the client view, and (via its Python twin in
// backend/pdf_generator.py) the PDF — goes through here, so all three say the
// same thing to the same client.
window.LTP_docTerms = function(entity, kind, settings) {
  var k = kind === "invoice" ? "invoice" : "quote";
  var vars = _termsVars(entity, k, settings);
  return String(window.LTP_docTermsText(entity, k, settings))
    .split("\n")
    .map(function(line) { return line.trim(); })
    .filter(function(line) { return line.length > 0; })
    // Checked BEFORE substitution — after it, an empty token is indistinguishable
    // from prose, because the rest of the sentence still reads fine.
    .filter(function(line) {
      var hasEmpty = false;
      line.replace(/\{\{(\w+)\}\}/g, function(match, key) {
        if (Object.prototype.hasOwnProperty.call(vars, key) && !String(vars[key]).trim()) hasEmpty = true;
        return match;
      });
      return !hasEmpty;
    })
    .map(function(line) { return window.LTP_resolveTemplate(line, vars); });
};

window.LTP_isOverdue = function(inv) {
  if (!inv || !inv.dueDate || inv.status === "draft" || inv.status === "paid") return false;
  return inv.dueDate < window.LTP_todayISO();
};

window.LTP_displayStatus = function(inv) {
  if (!inv) return "draft";
  if (inv.status === "paid") return "paid";
  var t = window.LTP_INVOICE_TOTALS(inv);
  if (t.paid > 0 && t.balance > 0) return "partial";
  if (window.LTP_isOverdue(inv)) return "overdue";
  return inv.status || "draft";
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

// Quote helpers — moved here from quotes-list to ensure availability
window.LTP_QUOTE_TOTALS = function(q) {
  var subtotal = 0, adjusted = 0, cost = 0;
  (q.sections || []).forEach(function(sec) {
    (sec.items || []).forEach(function(it) {
      if (it.type === "note") return;
      var qty = Number(it.qty) || 0;
      var orig = (Number(it.unitPrice) || 0) * qty;
      var adj  = it.adjustedPrice != null ? (Number(it.adjustedPrice) || 0) * qty : orig;
      subtotal += orig;
      adjusted += adj;
      cost     += (Number(it.cost) || 0) * qty;
    });
  });
  var afterDiscount = adjusted;
  var gd = q.globalDiscount || { type: "none", value: 0 };
  // "amount" is the fixed-dollar discount; "flat" is the legacy alias accepted
  // by every reader (see LTP_INVOICE_TOTALS above). Quotes have only ever
  // written "amount", but accepting both here keeps the two totals functions
  // literally interchangeable, which is the property that broke last time.
  if (gd.type === "percent") afterDiscount = adjusted * (1 - (Number(gd.value) || 0) / 100);
  else if (gd.type === "amount" || gd.type === "flat") afterDiscount = adjusted - (Number(gd.value) || 0);
  else if (gd.type === "target") afterDiscount = Number(gd.value) || 0;
  if (afterDiscount < 0) afterDiscount = 0;
  // Tax is QuickBooks-authoritative: a quote's tax comes from a temporary QB
  // estimate (backend/qbo_sync.py::get_quote_estimate_tax), stored read-only as
  // qbTaxTotal. Null until calculated → $0, exactly like invoices + the client
  // view. There is no flat-rate fallback anywhere — QuickBooks owns the number.
  var tax = (q.qbTaxTotal != null) ? (Number(q.qbTaxTotal) || 0) : 0;
  return { subtotal: subtotal, adjusted: adjusted, total: afterDiscount + tax, preTax: afterDiscount, tax: tax, taxAmount: tax, cost: cost };
};

window.LTP_QUOTE_REF = function(q) {
  var year = (q.createdDate || "").substring(0, 4) || String(new Date().getFullYear());
  return "Q-" + year + "-" + String(q.id).padStart(3, "0");
};

// ── Multi-project quotes & invoices ─────────────────────────────────────────
// A quote or invoice can gather work from more than one project: a schedule
// sends its labor into any of the client's existing DRAFT documents, whatever
// project that document started on.
//
// The scalar `projectId` survives as the PRIMARY project and keeps its old
// meaning everywhere it's already read — the PDF title (pdf_generator.py), the
// QuickBooks CustomerMemo (qbo_sync.py), the push-notification label
// (routes/_shared.py::doc_display_name), the project-delete wizard
// (modules/projects.js) and the CRM project's Quotes tab. `projectIds` is the
// full contributing set, primary first, and is what the "Includes" line on the
// document renders from.
//
// Rows written before this existed have no `projectIds` at all, so EVERY read
// goes through LTP_docProjectIds rather than touching the field directly.
window.LTP_docProjectIds = function(entity) {
  if (!entity) return [];
  var out = [], seen = {};
  function push(id) {
    if (id == null || id === "") return;
    var k = String(id);
    if (seen[k]) return;
    seen[k] = true;
    out.push(id);
  }
  push(entity.projectId);
  if (Array.isArray(entity.projectIds)) entity.projectIds.forEach(push);
  return out;
};

// The { projectId, projectIds } patch that records `projectId` as a contributor
// to `entity`. The primary is never rewritten when the document already has one
// — a quote the client has seen doesn't rename itself because a second job was
// added to it — and is adopted when it doesn't. Idempotent: linking a project
// that's already there just normalizes a legacy row's list.
window.LTP_linkDocProject = function(entity, projectId) {
  var ids = window.LTP_docProjectIds(entity);
  if (projectId != null && !ids.some(function(id) { return String(id) === String(projectId); })) {
    ids = ids.concat([projectId]);
  }
  var primary = (entity && entity.projectId != null) ? entity.projectId : (ids.length ? ids[0] : null);
  return { projectId: primary, projectIds: ids };
};

// Display names for a document's contributing projects, primary first. A
// project that's since been deleted (FKs are ON DELETE SET NULL, but the id can
// still sit in the list) degrades to "Project <id>" rather than vanishing —
// silently dropping it would understate what the document covers.
window.LTP_docProjectNames = function(entity, projects) {
  return window.LTP_docProjectIds(entity).map(function(id) {
    var p = (projects || []).find(function(x) { return x.id === id; });
    return (p && p.name) ? p.name : ("Project " + id);
  });
};

// Does this quote/invoice bill work for `projectId`? True for the PRIMARY
// project and for every other contributor equally — a document that gathered a
// second job's schedule belongs on that job's page too, which is the whole
// point of the contributor list. Every "this project's quotes/invoices" filter
// goes through here rather than comparing `.projectId` directly.
window.LTP_docHasProject = function(entity, projectId) {
  if (projectId == null) return false;
  return window.LTP_docProjectIds(entity).some(function(id) { return String(id) === String(projectId); });
};

// Note for a project's money figures when some of the documents behind them are
// shared with other jobs. Each project counts a shared document's FULL total —
// so its own page reads correctly in isolation — which means summing across
// projects would over-count. This is the sentence that says so out loud, naming
// the other jobs involved. Returns null when nothing is shared, i.e. for the
// overwhelmingly common single-project case.
//
//   docs      the quotes (or invoices) already filtered to this project
//   projects  the full project list, for name resolution
window.LTP_sharedDocNote = function(project, docs, projects) {
  if (!project) return null;
  var otherIds = [], seen = {}, shared = 0;
  (docs || []).forEach(function(d) {
    var ids = window.LTP_docProjectIds(d);
    if (ids.length < 2) return;
    shared++;
    ids.forEach(function(id) {
      if (String(id) === String(project.id) || seen[String(id)]) return;
      seen[String(id)] = true;
      otherIds.push(id);
    });
  });
  if (!shared) return null;
  var names = otherIds.map(function(id) {
    var p = (projects || []).find(function(x) { return x.id === id; });
    return (p && p.name) ? p.name : ("Project " + id);
  });
  var withWhom = names.length <= 2
    ? names.join(" and ")
    : names.slice(0, 2).join(", ") + " and " + (names.length - 2) + " more";
  return "Includes " + shared + " combined with " + withWhom + " — counted in full here and there.";
};

// Label for a section appended to an existing document. The project name goes
// in the LABEL specifically because `label` is one of the few section fields
// that survives the public-view scrub (backend/routes/_shared.py::
// public_section_items) — so the client sees which job each block of work
// belongs to without us widening that whitelist.
window.LTP_projectSectionLabel = function(baseLabel, projectName) {
  var base = String(baseLabel == null ? "" : baseLabel).trim() || "Items";
  var proj = String(projectName == null ? "" : projectName).trim();
  if (!proj) return base;
  if (base.toLowerCase().indexOf(proj.toLowerCase()) !== -1) return base;  // don't double-stamp
  return base + " — " + proj;
};

// Per-section date override for work appended from a DIFFERENT job.
//
// A document's rental window comes from its primary project (or its custom
// dates when it has none), and equipment lines price off that window. A second
// job almost always runs on other dates, so its sections carry their own —
// sections already support `customDates` + startDate/endDate, and both the
// builder's repricing and the PDF's "Rental Period" honor them, so this needs
// no new machinery.
//
// Returns the {customDates, startDate, endDate} patch to merge into each
// appended section, or null when nothing needs overriding: the work belongs to
// the document's own primary project, the project has no dates, or its dates
// already match the document's window.
window.LTP_sectionDateStamp = function(doc, project, projects) {
  if (!project || !project.startDate || !project.endDate) return null;
  var ids = window.LTP_docProjectIds(doc);
  var primaryId = ids.length ? ids[0] : (doc && doc.projectId != null ? doc.projectId : null);
  // Sections for the document's own primary job inherit the document window.
  if (primaryId != null && String(primaryId) === String(project.id)) return null;
  var prim = primaryId != null ? (projects || []).find(function(p) { return p.id === primaryId; }) : null;
  var start = prim ? (prim.startDate || "") : ((doc && doc.customStartDate) || "");
  var end   = prim ? (prim.endDate   || "") : ((doc && doc.customEndDate)   || "");
  if (start === project.startDate && end === project.endDate) return null;
  return { customDates: true, startDate: project.startDate, endDate: project.endDate };
};

// Append sections to a document WITHOUT touching what's already in it.
// Deliberately NOT a merge-by-label: pooling a second job's "Labor" into the
// first job's "Labor" section destroys exactly the per-project provenance a
// multi-project document exists to record, and silently edits a section the
// user already arranged. Section and item ids are regenerated on collision so
// lines copied out of one document can never clobber the target's own.
window.LTP_appendDocSections = function(existing, incoming, genId) {
  var gen = genId || window.LTP_genId;
  var used = {};
  (existing || []).forEach(function(sec) {
    if (sec && sec.id != null) used[sec.id] = true;
    (sec && sec.items || []).forEach(function(it) { if (it && it.id != null) used[it.id] = true; });
  });
  var added = (incoming || []).map(function(sec) {
    var secId = sec.id;
    while (secId == null || used[secId]) secId = gen("sec");
    used[secId] = true;
    return Object.assign({}, sec, {
      id: secId,
      items: (sec.items || []).map(function(it) {
        var itId = it.id;
        while (itId == null || used[itId]) itId = gen("item");
        used[itId] = true;
        return Object.assign({}, it, { id: itId });
      })
    });
  });
  return (existing || []).concat(added);
};

// Fee quick-pick names — the one-tap "custom fee" name suggestions in the
// quote/invoice Add-Item → Fees tab. Sourced from settings.feeQuickNames
// (editable in Quotes → Fees), falling back to a sensible default only when the
// setting is absent. Returns a normalized list: trimmed, non-empty, and
// de-duplicated case-insensitively, with authored order preserved. An
// explicitly-empty list stays empty (the user removed every quick-pick).
window.LTP_FEE_QUICKNAMES_DEFAULT = ["Lodging", "Meal Expenses", "Travel", "Consultation", "Project Prep"];
window.LTP_feeQuickNames = function(settings) {
  var raw = settings && settings.feeQuickNames;
  if (!Array.isArray(raw)) raw = window.LTP_FEE_QUICKNAMES_DEFAULT;
  var seen = {}, out = [];
  raw.forEach(function(n) {
    var s = (n == null ? "" : String(n)).trim();
    if (!s) return;
    var k = s.toLowerCase();
    if (seen[k]) return;
    seen[k] = true;
    out.push(s);
  });
  return out;
};

// Gather activity entries of a given fault type across invoices and quotes for
// the Settings Error Log. Backend paths stamp typed activity entries on their
// entity — `email_failed` (auto-receipt poller + manual sends) and
// `qbo_sync_failed` (invoice → QuickBooks push) — and this one reducer surfaces
// any of them. Returns display-ready rows { id, date, time, message,
// errorDetail, context } sorted newest-first. Pure (no DOM/React) so the Error
// Log logic is unit-tested.
window.LTP_collectActivityFaults = function(invoices, quotes, activityType) {
  var faults = [];
  function errorDetail(a) {
    var ch = (a.changes || []).filter(function(c) { return c && c.cat === "Error"; })[0];
    return ch ? String(ch.detail || "") : "";
  }
  function gather(list, refFn, prefix) {
    (list || []).forEach(function(ent) {
      (ent.activity || []).forEach(function(a) {
        if (a && a.type === activityType) {
          faults.push({
            id: a.id,
            date: a.date || "",
            time: a.time || "",
            message: a.message || "",
            errorDetail: errorDetail(a),
            context: refFn ? refFn(ent) : (prefix + (ent.id != null ? ent.id : "?")),
          });
        }
      });
    });
  }
  gather(invoices, window.LTP_INVOICE_REF, "INV-");
  gather(quotes, window.LTP_QUOTE_REF, "Q-");
  faults.sort(function(a, b) {
    return ((b.date || "") + (b.time || "")) > ((a.date || "") + (a.time || "")) ? 1 : -1;
  });
  return faults;
};

// Failed email sends (auto-receipt poller + manual quote/invoice sends).
window.LTP_collectEmailFaults = function(invoices, quotes) {
  return window.LTP_collectActivityFaults(invoices, quotes, "email_failed").map(function(f) {
    if (!f.message) f.message = "Email failed";
    return f;
  });
};

// Failed invoice → QuickBooks pushes. Connection-level QuickBooks errors from
// background contexts (the poller) aren't entity-stamped; they arrive via
// /api/qbo/status (status.lastError) and are shown alongside these in Settings.
window.LTP_collectQboFaults = function(invoices, quotes) {
  return window.LTP_collectActivityFaults(invoices, quotes, "qbo_sync_failed").map(function(f) {
    if (!f.message) f.message = "QuickBooks sync failed";
    return f;
  });
};

// A project's headline money figure. The budget entered on the project form is
// preliminary — once real quotes exist for the project they supersede it, and
// every surface that shows "the project's number" should show the quoted total
// instead. Declined quotes don't count; if every quote is declined the
// preliminary budget applies again. Returns { quoted, total, count }:
// quoted=true means `total` is the sum of the live quotes' totals (and `count`
// how many), quoted=false means `total` is the preliminary budget sum.
window.LTP_projectHeadlineTotal = function(project, quotes) {
  // Any quote this project contributes to, not just ones it's primary on — a
  // quote that absorbed this job's schedule bills this job's work and belongs
  // in its headline. A quote shared with another project counts its FULL total
  // on both; LTP_sharedDocNote is what tells the reader that's happening.
  var live = (quotes || []).filter(function(q) {
    return q && window.LTP_docHasProject(q, project.id) && q.status !== "declined";
  });
  if (live.length === 0) {
    var budget = project.budget || {};
    var tot = Object.keys(budget).reduce(function(a, k) { return a + (Number(budget[k]) || 0); }, 0);
    return { quoted: false, total: tot, count: 0 };
  }
  var sum = live.reduce(function(a, q) { return a + (window.LTP_QUOTE_TOTALS(q).total || 0); }, 0);
  return { quoted: true, total: sum, count: live.length };
};

// Select a number field's contents when it gains focus, so the user's first
// keystroke replaces the current value (e.g. a default 0) instead of
// appending to it — no more "type, then go back and delete the leading 0".
// Bound once at the document level (event delegation) so it covers EVERY
// numeric input app-wide, regardless of which component renders it (LTPInput,
// the rentals R.INP inputs, raw <input type="number">, etc.). The setTimeout
// lets the browser's own click cursor-placement settle first, then we select.
if (typeof document !== "undefined" && !window.__LTP_NUM_SELECT_BOUND) {
  window.__LTP_NUM_SELECT_BOUND = true;
  document.addEventListener("focusin", function(e) {
    var el = e.target;
    if (el && el.tagName === "INPUT" && el.type === "number") {
      setTimeout(function() { try { el.select(); } catch (_e) {} }, 0);
    }
  });
}
