// Rentals — Shared Utilities
// Exposes: window.LTP_RENTALS
(function() {
  var h = React.createElement;
  var useState = React.useState;
  var B = window.LTP_THEME;

  // Soft-on-slate badge treatment (12% fill / 35% border), matching
  // theme.js LTP_STATUS_COLORS.
  var ALLOC_COLORS = {
    "reserved":          window.LTP_badgeFromHex("#6FA8F5"),
    "allocated":         window.LTP_badgeFromHex("#F5B83D"),
    "checked-out":       window.LTP_badgeFromHex("#FF8A50"),
    "returned":          window.LTP_badgeFromHex("#5FD08A"),
    "under-maintenance": window.LTP_badgeFromHex("#F0857A"),
  };

  var ALLOC_STATES = ["reserved", "allocated", "checked-out", "returned", "under-maintenance"];

  var CATEGORIES = ["Lighting", "SFX", "Control", "Accessories", "Power", "Audio", "Video", "Rigging", "Staging", "Other"];

  var RATE_LABELS = { threeDay: "3-Day", week: "Week", month: "Month" };
  var RATE_KEYS   = ["threeDay", "week", "month"];

  var INP = {
    background: B.bg, border: "1px solid " + B.border, borderRadius: "8px",
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
      h("div", { style: { display: "flex", alignItems: "center", background: B.bg, border: "1px solid " + B.border, borderRadius: "8px", padding: "0 10px", minHeight: 37 } },
        sel && h("span", { style: { background: B.accent, color: B.btnInk, fontSize: "11px", padding: "2px 8px", borderRadius: "4px", fontWeight: 600, marginRight: 6, whiteSpace: "nowrap" } },
          displayLabel(sel),
          h("button", { onClick: function(e) { e.stopPropagation(); onChange(null); setQuery(""); }, style: { background: "none", border: "none", color: B.btnInk, cursor: "pointer", fontSize: "12px", fontWeight: 700, padding: "0 0 0 4px" } }, "×")
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

  // Vendor typeahead (type-to-filter CRM vendors → pick a companyId). Shared by
  // the equipment form's per-unit vendor picker AND the scan-import session's
  // persistent-info panel, so it lives here rather than in one surface. Only
  // needs the theme (B); no LTP_RENTALS deref, so it's safe to define here.
  function VendorSearch(props) {
    var vendors = props.vendors, value = props.value, onChange = props.onChange;
    var sel = value ? (vendors || []).find(function(v) { return v.id === value; }) : null;
    var qPair = useState(sel ? sel.name : "");
    var query = qPair[0], setQuery = qPair[1];
    var fPair = useState(false);
    var focused = fPair[0], setFocused = fPair[1];
    var filtered = (vendors || []).filter(function(v) { return v.name.toLowerCase().indexOf(query.toLowerCase()) !== -1; });

    return h("div", { style: { position: "relative" } },
      h("div", { style: { display: "flex", alignItems: "center", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "0 10px", minHeight: 37 } },
        sel && h("span", { style: { background: B.accent, color: B.btnInk, fontSize: "11px", padding: "2px 8px", borderRadius: "4px", fontWeight: 600, marginRight: 6, whiteSpace: "nowrap" } },
          sel.name,
          h("button", { onClick: function(e) { e.stopPropagation(); onChange(null); setQuery(""); }, style: { background: "none", border: "none", color: B.btnInk, cursor: "pointer", fontSize: "12px", fontWeight: 700, padding: "0 0 0 4px" } }, "×")
        ),
        h("input", { type: "text", value: sel ? "" : query, placeholder: sel ? "" : "Type to search vendors...",
          onChange: function(e) { if (!sel) { setQuery(e.target.value); setFocused(true); } },
          onFocus: function() { if (!sel) setFocused(true); },
          onBlur:  function() { setTimeout(function() { setFocused(false); }, 180); },
          onClick: function() { if (sel) { onChange(null); setQuery(""); setFocused(true); } },
          style: { background: "transparent", border: "none", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", flex: 1, padding: "8px 0", cursor: sel ? "pointer" : "text" }
        })
      ),
      focused && !sel && query.length > 0 && filtered.length > 0 && h("div", { style: { position: "absolute", top: "100%", left: 0, right: 0, background: B.surface, border: "1px solid " + B.border, borderRadius: "0 0 6px 6px", maxHeight: 140, overflowY: "auto", zIndex: 20 } },
        filtered.map(function(v) {
          return h("div", { key: v.id, onMouseDown: function(e) { e.preventDefault(); }, onClick: function() { onChange(v.id); setQuery(""); setFocused(false); },
            style: { padding: "8px 12px", fontSize: "12px", cursor: "pointer", color: B.text, borderBottom: "1px solid " + B.border },
            onMouseOver: function(e) { e.currentTarget.style.background = B.raised; },
            onMouseOut:  function(e) { e.currentTarget.style.background = "transparent"; }
          }, v.name);
        })
      )
    );
  }

  // ── Scan-import pure helpers (barcode → unit) ─────────────────────────────
  // Kept as plain functions (no React/DOM) so they're unit-testable in Node
  // (tests/test_rentals_scan.js) and reusable by the future check-in/out flow.

  // Normalize a scanned/typed code before it touches state or the DB. Scanned
  // text is the one string a NON-user can author (anyone can print a QR sticker
  // and have staff scan it), so: trim, strip control + bidi-override characters
  // (which can visually spoof adjacent UI), and cap the length — real asset
  // tags are tens of characters; a QR can carry kilobytes.
  function cleanScanCode(code) {
    var c = (code == null ? "" : String(code)).trim();
    c = c.replace(/[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
    return c.slice(0, 128);
  }

  // Build one serialized-unit record from a scanned/typed code + the active
  // "persistent info" for the current batch. Per the product decision the
  // scanned value lands in `barcode` (asset #); `serial` stays blank/editable.
  // `existingIds` = every unit id already present (DB units + this session's) so
  // the new id can't collide during a rapid scan burst — we take max+1 rather
  // than Date.now() (which can repeat within the same millisecond).
  function buildScannedUnit(code, info, existingIds) {
    info = info || {};
    var ids = (existingIds || []).map(function(x) { return Number(x); }).filter(function(n) { return !isNaN(n); });
    var nextId = (ids.length ? Math.max.apply(null, ids) : 0) + 1;
    var costRaw = info.purchaseCost;
    var cost = (costRaw === "" || costRaw === null || costRaw === undefined) ? null : (Number(costRaw) || null);
    return {
      id: nextId,
      serial: "",
      barcode: cleanScanCode(code),
      purchaseDate: info.purchaseDate || "",
      purchaseVendorId: info.purchaseVendorId || null,
      purchaseCost: cost,
      status: info.status || "available",
      location: info.location || "",
      maintenanceLogs: [],
    };
  }

  // True if `code` already exists as a barcode OR serial on any of `units`
  // (case/whitespace-insensitive). Guards against scanning the same physical
  // item twice into the same product.
  function isDuplicateCode(code, units) {
    var c = (code == null ? "" : String(code)).trim().toLowerCase();
    if (!c) return false;
    return (units || []).some(function(u) {
      return (u.barcode || "").trim().toLowerCase() === c ||
             (u.serial  || "").trim().toLowerCase() === c;
    });
  }

  // Human-readable divider for a batch (a run of scans sharing the same
  // persistent info): "Vendor · Date · Location". Empty → "No batch info set".
  function batchLabel(info, vendors) {
    info = info || {};
    var parts = [];
    if (info.purchaseVendorId) {
      var v = (vendors || []).find(function(x) { return x.id === info.purchaseVendorId; });
      parts.push(v ? v.name : "Vendor #" + info.purchaseVendorId);
    }
    if (info.purchaseDate) parts.push(info.purchaseDate);
    if (info.location) parts.push(info.location);
    return parts.length ? parts.join(" · ") : "No batch info set";
  }

  window.LTP_RENTALS = {
    SerialSearch:  SerialSearch,
    VendorSearch:  VendorSearch,
    buildScannedUnit: buildScannedUnit,
    cleanScanCode:    cleanScanCode,
    isDuplicateCode:  isDuplicateCode,
    batchLabel:       batchLabel,
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
