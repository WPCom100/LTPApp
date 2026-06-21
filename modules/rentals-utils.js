// Rentals — Shared Utilities
// Exposes: window.LTP_RENTALS
(function() {
  var h = React.createElement;
  var B = window.LTP_THEME;

  var ALLOC_COLORS = {
    "reserved":          { bg: "#0f1a2e", text: "#3B82F6", bd: "#1a3a6e" },
    "allocated":         { bg: "#2e2208", text: "#F5A623", bd: "#7a5a0a" },
    "checked-out":       { bg: "#3d2008", text: "#E8731A", bd: "#5a3010" },
    "returned":          { bg: "#0f2a10", text: "#4CAF50", bd: "#1b5e20" },
    "under-maintenance": { bg: "#2e0f0f", text: "#E74C3C", bd: "#7a1a1a" },
  };

  var ALLOC_STATES = ["reserved", "allocated", "checked-out", "returned", "under-maintenance"];

  var CATEGORIES = ["Lighting", "SFX", "Control", "Accessories", "Power", "Audio", "Video", "Rigging", "Staging", "Other"];

  var RATE_LABELS = { threeDay: "3-Day", week: "Week", month: "Month" };
  var RATE_KEYS   = ["threeDay", "week", "month"];

  var INP = {
    background: B.raised, border: "1px solid " + B.border, borderRadius: "6px",
    padding: "8px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none",
  };

  var LBL = {
    fontSize: "11px", fontWeight: 600, color: B.textMut,
    textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4, display: "block",
  };

  function Field(label, content) {
    return h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
      h("label", { style: LBL }, label), content);
  }

  function allocBadge(state) {
    var c = ALLOC_COLORS[state] || ALLOC_COLORS["reserved"];
    var label = state === "under-maintenance" ? "Under Maintenance" : state;
    return h("span", { style: { background: c.bg, color: c.text, border: "1px solid " + c.bd, padding: "2px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" } }, label);
  }

  // Sum of qty across open maintenance logs on a non-serialized item.
  // Per-log qty is the new partial-out-of-service mechanism: a single
  // log row can mark 2 of 10 units down (e.g. "two hazers leaking")
  // without flipping the whole line to under-maintenance. Legacy logs
  // (created before the qty field existed) have qty === undefined and
  // contribute 0 — they were already informational-only.
  function outOfServiceQty(eq) {
    if (!eq || eq.serialized) return 0;
    return (eq.maintenanceLogs || []).reduce(function(sum, l) {
      if (!l || l.status !== "open") return sum;
      // Clamp negative qty at the source — backend doesn't validate
      // nested JSON shapes, so a stale or malicious PUT with qty=-5
      // would otherwise INFLATE availability (eqQty would add 5).
      // eqQty also floors the final result at 0, but defense in depth.
      return sum + Math.max(0, Number(l.qty) || 0);
    }, 0);
  }

  // Get total rentable qty for an equipment item.
  //   Serialized: count units NOT in under-maintenance/retired.
  //   Non-serialized: qty MINUS open-log qty. Legacy parent-level
  //     status === "under-maintenance" / "retired" still forces 0
  //     (full decommission; preserved for back-compat with rows that
  //     used the old all-or-nothing toggle before qty-aware logs).
  function eqQty(eq) {
    if (eq.serialized) {
      return (eq.units || []).filter(function(u) {
        return u.status !== "under-maintenance" && u.status !== "retired";
      }).length;
    }
    if (eq.status === "under-maintenance" || eq.status === "retired") return 0;
    return Math.max(0, (eq.qty || 0) - outOfServiceQty(eq));
  }

  // How many units consumed in date range (excluding exId allocation)
  function allocatedQty(allocations, equipmentId, startDate, endDate, exId) {
    return allocations.filter(function(a) {
      if (a.equipmentId !== equipmentId) return false;
      if (exId && a.id === exId) return false;
      if (a.state === "returned" || a.state === "under-maintenance") return false;
      return a.startDate <= endDate && a.endDate >= startDate;
    }).reduce(function(sum, a) { return sum + a.qty; }, 0);
  }

  function availableQty(equipment, allocations, equipmentId, startDate, endDate, exId) {
    var eq = equipment.find(function(e) { return e.id === equipmentId; });
    if (!eq) return 0;
    return eqQty(eq) - allocatedQty(allocations, equipmentId, startDate, endDate, exId);
  }

  // Base display rate — use 3-day as the primary display rate
  function baseRate(eq) {
    return eq.rates && eq.rates.threeDay ? eq.rates.threeDay : 0;
  }

  function today() { return new Date().toISOString().split("T")[0]; }

  function addDays(dateStr, n) {
    var d = new Date(dateStr);
    d.setDate(d.getDate() + n);
    return d.toISOString().split("T")[0];
  }

  window.LTP_RENTALS = {
    ALLOC_COLORS:  ALLOC_COLORS,
    ALLOC_STATES:  ALLOC_STATES,
    CATEGORIES:    CATEGORIES,
    RATE_LABELS:   RATE_LABELS,
    RATE_KEYS:     RATE_KEYS,
    INP:           INP,
    LBL:           LBL,
    Field:         Field,
    allocBadge:    allocBadge,
    eqQty:            eqQty,
    outOfServiceQty:  outOfServiceQty,
    allocatedQty:     allocatedQty,
    availableQty:     availableQty,
    baseRate:      baseRate,
    today:         today,
    addDays:       addDays,
  };
})();
