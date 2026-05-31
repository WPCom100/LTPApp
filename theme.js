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

// Full labor rate with break/meal penalty support
// breaks = [{ startTime, endTime, type: "unpaid"|"paid" }, ...]
window.LTP_calcLaborFull = function(dayRate, callTime, endTime, breaks) {
  if (!dayRate || !callTime || !endTime) return { rate: 0, paidHours: 0, unpaidBreakHours: 0, paidBreakHours: 0, mealPenaltyHours: 0, regularOTHours: 0, tier: "", segments: [] };

  var call = _timeToDecimal(callTime);
  var wrap = _timeToDecimal(endTime);
  if (wrap <= call) wrap += 24;

  // Sort breaks by start time
  var sortedBreaks = (breaks || []).slice().sort(function(a, b) { return _timeToDecimal(a.startTime) - _timeToDecimal(b.startTime); });

  // Build work segments (both break types create segment boundaries)
  var segments = [];
  var cursor = call;
  var unpaidBreakHours = 0;
  var paidBreakHours = 0;

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
  if (cursor < wrap) {
    segments.push({ start: cursor, end: wrap, hours: Math.round((wrap - cursor) * 100) / 100 });
  }

  // Calculate meal penalty: any segment > 5h, excess is penalty OT
  var mealPenaltyHours = 0;
  var regularHours = 0;
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

// ── Invoice & Quote display helpers (used across modules) ────────────────
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
  var taxRate = window.LTP_TAX_RATE || 0;
  var tax = afterDiscount * taxRate / 100;
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
