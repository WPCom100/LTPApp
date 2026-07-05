// Rentals — Shared Utilities
// Exposes: window.LTP_RENTALS
(function() {
  var h = React.createElement;
  var useState = React.useState;
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

  // Serial/barcode typeahead: pick one unit from a serialized item's units by
  // typing its barcode or serial. Shared by the equipment and container detail
  // forms (each wraps this with its own placeholder/emptyHint strings).
  function SerialSearch(props) {
    var units = props.units, value = props.value, onChange = props.onChange;
    var placeholder = props.placeholder || "Type barcode or serial…";
    var emptyHint = props.emptyHint || "Type to search…";
    var sel = value ? (units || []).find(function(u) { return u.id === value; }) : null;
    function displayLabel(u) { return u.barcode || u.serial || ("Unit " + u.id); }
    var qPair = useState(sel ? displayLabel(sel) : "");
    var query = qPair[0], setQuery = qPair[1];
    var fPair = useState(false);
    var focused = fPair[0], setFocused = fPair[1];
    var q = query.toLowerCase();
    var filtered = (units || []).filter(function(u) {
      return (u.barcode || "").toLowerCase().indexOf(q) !== -1 || (u.serial || "").toLowerCase().indexOf(q) !== -1;
    });
    return h("div", { style: { position: "relative" } },
      h("div", { style: { display: "flex", alignItems: "center", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "0 10px", minHeight: 37 } },
        sel && h("span", { style: { background: B.accent, color: "#000", fontSize: "11px", padding: "2px 8px", borderRadius: "4px", fontWeight: 600, marginRight: 6, whiteSpace: "nowrap" } },
          displayLabel(sel),
          h("button", { onClick: function(e) { e.stopPropagation(); onChange(null); setQuery(""); }, style: { background: "none", border: "none", color: "#000", cursor: "pointer", fontSize: "12px", fontWeight: 700, padding: "0 0 0 4px" } }, "×")
        ),
        h("input", { type: "text", value: sel ? "" : query, placeholder: sel ? "" : placeholder,
          onChange: function(e) { if (!sel) { setQuery(e.target.value); setFocused(true); } },
          onFocus: function() { if (!sel) setFocused(true); },
          onBlur:  function() { setTimeout(function() { setFocused(false); }, 180); },
          onClick: function() { if (sel) { onChange(null); setQuery(""); setFocused(true); } },
          style: { background: "transparent", border: "none", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", flex: 1, padding: "8px 0", cursor: sel ? "pointer" : "text" }
        })
      ),
      focused && !sel && h("div", { style: { position: "absolute", top: "100%", left: 0, right: 0, background: B.surface, border: "1px solid " + B.border, borderRadius: "0 0 6px 6px", maxHeight: 160, overflowY: "auto", zIndex: 20 } },
        filtered.length === 0
          ? h("div", { style: { padding: "10px 12px", fontSize: "12px", color: B.textMut, fontStyle: "italic" } }, query ? "No matching units." : emptyHint)
          : filtered.map(function(u) {
              var hasIssue = (u.maintenanceLogs || []).some(function(l) { return l.status === "open"; });
              return h("div", { key: u.id, onMouseDown: function(e) { e.preventDefault(); }, onClick: function() { onChange(u.id); setQuery(""); setFocused(false); },
                style: { padding: "8px 12px", fontSize: "12px", cursor: "pointer", borderBottom: "1px solid " + B.border },
                onMouseOver: function(e) { e.currentTarget.style.background = B.raised; },
                onMouseOut:  function(e) { e.currentTarget.style.background = "transparent"; }
              },
                h("span", { style: { color: B.text, fontWeight: 600 } }, u.barcode || u.serial || "No ID"),
                u.barcode && u.serial && h("span", { style: { color: B.textMut, marginLeft: 8, fontSize: "11px" } }, "S/N: " + u.serial),
                hasIssue && h("span", { style: { color: B.danger, marginLeft: 8, fontSize: "11px", fontWeight: 700 } }, "open issue")
              );
            })
      )
    );
  }

  window.LTP_RENTALS = {
    SerialSearch:  SerialSearch,
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
    baseRate:      baseRate,
    today:         today,
    addDays:       addDays,
  };
})();
