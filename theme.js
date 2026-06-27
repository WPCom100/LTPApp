// LTP Brand Theme
window.LTP_THEME = {
  bg: "#000000", surface: "#111111", raised: "#1a1a1a", border: "#2a2a2a",
  accent: "#E8731A", accentHover: "#F28A3D", accentMuted: "#3d2008",
  text: "#FFFFFF", textSec: "#AAAAAA", textMut: "#666666",
  success: "#4CAF50", successBg: "#0f2a10", successBd: "#1b5e20",
  warn: "#F5A623", warnBg: "#2e2208", warnBd: "#7a5a0a",
  danger: "#E74C3C", dangerBg: "#2e0f0f", dangerBd: "#7a1a1a",
  info: "#3B82F6", infoBg: "#0f1a2e", infoBd: "#1a3a6e",
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
  return tc[dept] || "#3B82F6";
};

window.LTP_STATUS_COLORS = {
  active: { bg: "#0f2a10", text: "#4CAF50", bd: "#1b5e20" },
  inactive: { bg: "#2e0f0f", text: "#E74C3C", bd: "#7a1a1a" },
  "one-time": { bg: "#0f1a2e", text: "#3B82F6", bd: "#1a3a6e" },
  prospect: { bg: "#2e2208", text: "#F5A623", bd: "#7a5a0a" },
  client: { bg: "#0f2a10", text: "#4CAF50", bd: "#1b5e20" },
  vendor: { bg: "#0f1a2e", text: "#3B82F6", bd: "#1a3a6e" },
  available: { bg: "#0f2a10", text: "#4CAF50", bd: "#1b5e20" },
  partial: { bg: "#2e2208", text: "#F5A623", bd: "#7a5a0a" },
  rented: { bg: "#3d2008", text: "#E8731A", bd: "#5a3010" },
  accepted: { bg: "#0f2a10", text: "#4CAF50", bd: "#1b5e20" },
  pending: { bg: "#2e2208", text: "#F5A623", bd: "#7a5a0a" },
  draft: { bg: "#1a1a1a", text: "#666666", bd: "#333333" },
  sent: { bg: "#0f1a2e", text: "#3B82F6", bd: "#1a3a6e" },
  paid: { bg: "#0f2a10", text: "#4CAF50", bd: "#1b5e20" },
  overdue: { bg: "#2e0f0f", text: "#E74C3C", bd: "#7a1a1a" },
  declined: { bg: "#2e0f0f", text: "#E74C3C", bd: "#7a1a1a" },
  converted: { bg: "#0f2a10", text: "#4CAF50", bd: "#1b5e20" },
  invoiced: { bg: "#3d2008", text: "#E8731A", bd: "#5a3010" },
  active: { bg: "#0f2a10", text: "#4CAF50", bd: "#1b5e20" },
  inactive: { bg: "#1a1a1a", text: "#888", bd: "#333" },
  requesting: { bg: "#3d2008", text: "#E8731A", bd: "#5a3010" },
  completed: { bg: "#0f2a10", text: "#4CAF50", bd: "#1b5e20" },
  cancelled: { bg: "#1a1a1a", text: "#888", bd: "#333" },
  booked: { bg: "#2e2208", text: "#F5A623", bd: "#7a5a0a" },
  rental: { bg: "#0f1a2e", text: "#3B82F6", bd: "#1a3a6e" },
  labor: { bg: "#2e2208", text: "#F5A623", bd: "#7a5a0a" },
  service: { bg: "#0f2a10", text: "#4CAF50", bd: "#1b5e20" },
  "full-production": { bg: "#3d2008", text: "#E8731A", bd: "#5a3010" },
  "in-progress": { bg: "#2e2208", text: "#F5A623", bd: "#7a5a0a" },
  completed: { bg: "#0f2a10", text: "#4CAF50", bd: "#1b5e20" },
  upcoming: { bg: "#0f1a2e", text: "#3B82F6", bd: "#1a3a6e" },
};
window.LTP_PROJECT_CATS = ["Rental", "Labor", "Service", "Full Production"];
window.LTP_CAT_KEYS = { "Rental": "rental", "Labor": "labor", "Service": "service", "Full Production": "full-production" };
window.LTP_CAT_COLORS = { "Rental": "#3B82F6", "Labor": "#F5A623", "Service": "#4CAF50", "Full Production": "#E8731A" };
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

// Parse "HH:MM" to decimal hours from midnight
function _timeToDecimal(t) {
  if (!t) return 0;
  var p = t.split(":");
  return parseInt(p[0], 10) + parseInt(p[1], 10) / 60;
}
function _decimalToTime(d) {
  if (d < 0) d += 24;
  var h = Math.floor(d) % 24;
  var m = Math.round((d - Math.floor(d)) * 60);
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
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
window.LTP_calcLaborDay = function(dayRate, items) {
  var EMPTY = { rate: 0, paidHours: 0, unpaidBreakHours: 0, paidBreakHours: 0, mealPenaltyHours: 0, regularOTHours: 0, tier: "", segments: [] };
  if (!dayRate || !items || !items.length) return EMPTY;

  // Normalize items to decimal-hour blocks, dropping any without both times.
  var blocks = [];
  items.forEach(function(it) {
    if (!it || !it.time || !it.endTime) return;
    var start = _timeToDecimal(it.time);
    var end = _timeToDecimal(it.endTime);
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
    var sortedBreaks = span.breaks.slice().sort(function(a, b) { return _timeToDecimal(a.startTime) - _timeToDecimal(b.startTime); });
    var cursor = span.start;
    sortedBreaks.forEach(function(brk) {
      var bs = _timeToDecimal(brk.startTime);
      var be = _timeToDecimal(brk.endTime);
      if (be <= bs) be += 24;
      if (bs > cursor) {
        segments.push({ start: cursor, end: bs, hours: Math.round((bs - cursor) * 100) / 100 });
      }
      var brkHours = Math.round((be - bs) * 100) / 100;
      if (brk.type === "paid") {
        paidBreakHours += brkHours;
      } else {
        unpaidBreakHours += brkHours;
      }
      cursor = be;
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

// Single-block convenience wrapper — one call/wrap span with its breaks.
// Equivalent to LTP_calcLaborDay with a single item, preserved for callers that
// only ever deal with one continuous block.
// breaks = [{ startTime, endTime, type: "unpaid"|"paid" }, ...]
window.LTP_calcLaborFull = function(dayRate, callTime, endTime, breaks) {
  return window.LTP_calcLaborDay(dayRate, [{ time: callTime, endTime: endTime, breaks: breaks || [] }]);
};

// Per-day, per-ROLE labor aggregation — the canonical billing model shared by
// the quote builder, the schedule summary, and the editor day totals so all
// three agree on what a day costs.
//
// A day bills each ROLE once, not each position. If a role appears on several
// items in the day it is a SINGLE day rate, sized by the MAX count of that role
// on any one item (2 stagehands on load-in + 1 on strike → bill 2 for the day),
// and its hours are that role's items merged into spans — so OT and meal penalty
// are computed across the shifts that role actually works, and the same person
// spread over several items isn't charged as several days.
//
// items    = [{ time, endTime, breaks, positions: [{ serviceId }] }]
// services = [{ id, dayRate, dayCost, halfDay?, halfDayCost?, otRate?, otCost? }]
// Returns { roles: [{ svc, serviceId, count, tier:"half"|"full", paidHours,
//   mealPenaltyHours, otHours, dayRate, dayCost, otRate, otCost,
//   rateTotal, costTotal }], rateTotal, costTotal }.
window.LTP_calcDayLabor = function(items, services) {
  var svcById = {}; (services || []).forEach(function(s) { svcById[s.id] = s; });

  // serviceId → [{ item, count }] — which items each role works, and how many.
  var roleItemMap = {};
  (items || []).forEach(function(s) {
    var counts = {};
    (s.positions || []).forEach(function(p) { if (p.serviceId) counts[p.serviceId] = (counts[p.serviceId] || 0) + 1; });
    Object.keys(counts).forEach(function(sid) {
      if (!roleItemMap[sid]) roleItemMap[sid] = [];
      roleItemMap[sid].push({ item: s, count: counts[sid] });
    });
  });

  var roles = [];
  var rateTotal = 0, costTotal = 0;
  Object.keys(roleItemMap).forEach(function(sid) {
    var svc = svcById[Number(sid)];
    if (!svc) return;
    var entries = roleItemMap[sid];
    var count = 0;
    entries.forEach(function(e) { count = Math.max(count, e.count); });

    var roleItems = entries.map(function(e) { return e.item; });
    var info = window.LTP_calcLaborDay(100, roleItems);
    if (info.paidHours <= 0) return;

    var otHours = Math.round((info.mealPenaltyHours + info.regularOTHours) * 100) / 100;
    var isHalf = info.paidHours <= 5 && otHours === 0;
    var tier = isHalf ? "half" : "full";
    var dayRate = isHalf ? (svc.halfDay || svc.dayRate * 0.5) : svc.dayRate;
    var dayCost = isHalf ? (svc.halfDayCost || svc.dayCost * 0.5) : svc.dayCost;
    var otRate = svc.otRate || (svc.dayRate / 10 * 1.5);
    var otCost = svc.otCost || (svc.dayCost / 10 * 1.5);
    var roleRate = dayRate * count + (otHours > 0 ? otRate * otHours * count : 0);
    var roleCost = dayCost * count + (otHours > 0 ? otCost * otHours * count : 0);
    rateTotal += roleRate;
    costTotal += roleCost;

    roles.push({
      svc: svc, serviceId: svc.id, count: count, tier: tier,
      paidHours: info.paidHours, mealPenaltyHours: info.mealPenaltyHours, otHours: otHours,
      dayRate: dayRate, dayCost: dayCost, otRate: otRate, otCost: otCost,
      rateTotal: Math.round(roleRate * 100) / 100, costTotal: Math.round(roleCost * 100) / 100,
    });
  });

  return { roles: roles, rateTotal: Math.round(rateTotal * 100) / 100, costTotal: Math.round(costTotal * 100) / 100 };
};

// Auto-generate optimal meal breaks for a call/wrap window
// Returns an array of break objects placed every 5h
window.LTP_autoGenerateBreaks = function(callTime, endTime, existingBreaks) {
  var call = _timeToDecimal(callTime);
  var wrap = _timeToDecimal(endTime);
  if (wrap <= call) wrap += 24;
  var totalHours = wrap - call;
  if (totalHours <= 5) return existingBreaks || []; // no breaks needed

  var newBreaks = [];
  var cursor = call;
  while (cursor + 5 < wrap) {
    cursor += 5;
    // Don't place a break in the last 30 min before wrap
    if (cursor + 1 > wrap) break;
    newBreaks.push({
      id: window.LTP_genId("brk"),
      startTime: _decimalToTime(cursor),
      endTime: _decimalToTime(cursor + 1),
      type: "unpaid"
    });
    cursor += 1; // skip past the break
  }
  return newBreaks;
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
// picture (rare). Same image as the legacy logo position in the signature
// template, so the layout doesn't break on first send. MUST stay in sync
// with backend/routes/email.py::_PHOTO_FALLBACK_URL.
window.LTP_SIGNATURE_PHOTO_FALLBACK = "https://www.luminarytechnology.productions/wp-content/uploads/2024/07/LTP-Logo-Stacked.png";

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

window.LTP_formatAddress = function(e, joiner) {
  if (!e) return "";
  joiner = joiner || ", ";
  var street = (e.address || "").replace(/\n+/g, joiner).trim();
  var city = (e.city || "").trim(), st = (e.state || "").trim(), zip = (e.zip || "").trim();
  var sz = [st, zip].filter(function(x) { return x; }).join(" ");
  var cityLine = (city && sz) ? (city + ", " + sz) : (city || sz);
  return [street, cityLine].filter(function(x) { return x; }).join(joiner);
};

window.LTP_INVOICE_REF = function(inv) {
  if (!inv) return "INV-?";
  var year = (inv.invoiceDate || "").substring(0, 4) || new Date().getFullYear();
  var num = String(inv.id || 0).padStart(3, "0");
  return "INV-" + year + "-" + num;
};

window.LTP_QUOTE_REF = function(qt) {
  if (!qt) return "QT-?";
  var year = (qt.sentDate || "").substring(0, 4) || new Date().getFullYear();
  var num = String(qt.id || 0).padStart(3, "0");
  return "QT-" + year + "-" + num;
};

window.LTP_INVOICE_TOTALS = function(inv) {
  if (!inv) return { subtotal: 0, discount: 0, tax: 0, total: 0, paid: 0, balance: 0 };
  var subtotal = 0;
  (inv.sections || []).forEach(function(sec) {
    (sec.items || []).forEach(function(it) {
      if (it.type === "note") return;
      var price = it.adjustedPrice != null ? it.adjustedPrice : (it.unitPrice || 0);
      subtotal += price * (it.qty || 0);
    });
  });
  var gd = inv.globalDiscount || {};
  var discount = 0;
  if (gd.type === "percent") discount = subtotal * (gd.value || 0) / 100;
  else if (gd.type === "flat") discount = gd.value || 0;
  else if (gd.type === "target") discount = Math.max(0, subtotal - (gd.value || 0));
  var afterDiscount = subtotal - discount;
  // Tax is QuickBooks-authoritative: once the invoice has been pushed, QB
  // computes the sales tax (qbTaxTotal) and the whole-invoice total reflects it
  // everywhere LTP_INVOICE_TOTALS is consumed (builder, list, dashboard, client
  // view, PDF). Before any push, qbTaxTotal is null and tax is 0.
  var taxRate = window.LTP_TAX_RATE || 0;
  var tax = (inv.qbTaxTotal != null) ? (Number(inv.qbTaxTotal) || 0) : (afterDiscount * taxRate / 100);
  var total = afterDiscount + tax;
  var paid = (inv.payments || []).reduce(function(s, p) { return s + (Number(p.amount) || 0); }, 0);
  return { subtotal: subtotal, discount: discount, tax: tax, total: total, paid: paid, balance: Math.max(0, total - paid) };
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
  if (gd.type === "percent") afterDiscount = adjusted * (1 - (Number(gd.value) || 0) / 100);
  else if (gd.type === "amount") afterDiscount = adjusted - (Number(gd.value) || 0);
  else if (gd.type === "target") afterDiscount = Number(gd.value) || 0;
  if (afterDiscount < 0) afterDiscount = 0;
  var taxRate = window.LTP_TAX_RATE || 0;
  var taxAmount = taxRate > 0 ? Math.round(afterDiscount * (taxRate / 100) * 100) / 100 : 0;
  return { subtotal: subtotal, adjusted: adjusted, total: afterDiscount + taxAmount, preTax: afterDiscount, taxRate: taxRate, taxAmount: taxAmount, cost: cost };
};

window.LTP_QUOTE_REF = function(q) {
  var year = (q.createdDate || "").substring(0, 4) || String(new Date().getFullYear());
  return "Q-" + year + "-" + String(q.id).padStart(3, "0");
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
