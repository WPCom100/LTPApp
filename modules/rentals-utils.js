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
    // Newly-created vendors are selected straight away — the parent recomputes
    // `vendors` from the app-level companies array in the same batched update.
    function onCreated(rec) { if (rec && rec.id != null) { onChange(rec.id); setQuery(""); setFocused(false); } }
    var showCreate = focused && !sel && query.length > 0;

    // minWidth: 0 (twice) + width: 100% on the input: a text input's intrinsic
    // width (~20 characters) otherwise pushes the whole field past a phone's
    // edge inside a grid cell (the scan modal's batch panel).
    return h("div", { style: { position: "relative", minWidth: 0 } },
      h("div", { style: { display: "flex", alignItems: "center", gap: 6, background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "0 8px 0 10px", minHeight: 37, minWidth: 0 } },
        sel && h("span", { style: { background: B.accent, color: B.btnInk, fontSize: "11px", padding: "2px 8px", borderRadius: "4px", fontWeight: 600, marginRight: 6, whiteSpace: "nowrap" } },
          sel.name,
          h("button", { onClick: function(e) { e.stopPropagation(); onChange(null); setQuery(""); }, style: { background: "none", border: "none", color: B.btnInk, cursor: "pointer", fontSize: "12px", fontWeight: 700, padding: "0 0 0 4px" } }, "×")
        ),
        h("input", { type: "text", value: sel ? "" : query, placeholder: sel ? "" : "Type to search vendors...",
          onChange: function(e) { if (!sel) { setQuery(e.target.value); setFocused(true); } },
          onFocus: function() { if (!sel) setFocused(true); },
          onBlur:  function() { setTimeout(function() { setFocused(false); }, 180); },
          onClick: function() { if (sel) { onChange(null); setQuery(""); setFocused(true); } },
          style: { background: "transparent", border: "none", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", flex: 1, minWidth: 0, width: "100%", padding: "8px 0", cursor: sel ? "pointer" : "text" }
        }),
        // Inline add/edit of the CRM company itself. A vendor you're buying
        // from often doesn't exist in CRM yet at the moment you're logging the
        // gear, and the old field simply had no answer for that.
        h(window.LTPEntityQuickAction, { kind: "company", id: sel ? sel.id : null,
          prefill: { isVendor: true, isClient: false },
          onSaved: onCreated })
      ),
      (showCreate || (focused && !sel && query.length > 0 && filtered.length > 0)) && h("div", { style: { position: "absolute", top: "100%", left: 0, right: 0, background: B.surface, border: "1px solid " + B.border, borderRadius: "0 0 6px 6px", maxHeight: 140, overflowY: "auto", zIndex: 20 } },
        filtered.map(function(v) {
          return h("div", { key: v.id, onMouseDown: function(e) { e.preventDefault(); }, onClick: function() { onChange(v.id); setQuery(""); setFocused(false); },
            style: { padding: "8px 12px", fontSize: "12px", cursor: "pointer", color: B.text, borderBottom: "1px solid " + B.border },
            onMouseOver: function(e) { e.currentTarget.style.background = B.raised; },
            onMouseOut:  function(e) { e.currentTarget.style.background = "transparent"; }
          }, v.name);
        }).concat(showCreate
          ? [h(window.LTPEntityCreateRow, { key: "_create", kind: "company", query: query,
              prefill: { isVendor: true, isClient: false }, onSaved: onCreated, first: filtered.length === 0 })]
          : [])
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

  // ── Rental pricing engine (moved here from quotes-builder.js) ────────────
  // Calculate rental pricing from a date range.
  // Calculate rental pricing by stacking tiers from largest to smallest.
  // Consumes days greedily: months first, then weeks, then 3-day blocks.
  //
  // Returns { breakdown: [{tier, count, unitRate, subtotal}], totalPrice, label }
  //   31 days → 1× month + 1× 3-day
  //   38 days → 1× month + 1× week + 1× 3-day
  //   64 days → 2× month + 1× 3-day + 1× 3-day  (4 remaining days → week is cheaper check)
  //
  // The function picks the cheapest option for the remainder at each step:
  //   remainder 4-7 days → compare 1× week vs ceil(days/3)× 3-day, pick cheaper
  //   remainder 1-3 days → 1× 3-day
  function calcRentalPrice(startDate, endDate, rates) {
    rates = rates || {};
    var r3 = rates.threeDay || 0, rw = rates.week || 0, rm = rates.month || 0;
    if (!startDate || !endDate) return { breakdown: [{ tier: "threeDay", count: 1, unitRate: r3, subtotal: r3 }], totalPrice: r3, label: "3-Day rate" };
    var start = new Date(startDate), end = new Date(endDate);
    var days = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1; // inclusive
    if (days <= 0) days = 1;

    var breakdown = [];
    var remaining = days;

    // Consume full months (30-day blocks)
    if (remaining >= 30 && rm > 0) {
      var months = Math.floor(remaining / 30);
      breakdown.push({ tier: "month", count: months, unitRate: rm, subtotal: rm * months });
      remaining -= months * 30;
    }

    // Remainder: pick cheapest combo of weeks and 3-days
    if (remaining > 0) {
      if (remaining >= 4 && rw > 0) {
        // Compare: 1 week vs multiple 3-day blocks
        var threeDayCost = Math.ceil(remaining / 3) * r3;
        if (rw <= threeDayCost && remaining <= 7) {
          breakdown.push({ tier: "week", count: 1, unitRate: rw, subtotal: rw });
          remaining = 0;
        } else if (remaining > 7) {
          // More than a week left but less than a month — use week + remainder
          var weeks = Math.floor(remaining / 7);
          breakdown.push({ tier: "week", count: weeks, unitRate: rw, subtotal: rw * weeks });
          remaining -= weeks * 7;
        }
      }

      // Remaining days as 3-day blocks
      if (remaining > 0 && r3 > 0) {
        var blocks = Math.ceil(remaining / 3);
        breakdown.push({ tier: "threeDay", count: blocks, unitRate: r3, subtotal: r3 * blocks });
      }
    }

    // Edge case: no rates set
    if (breakdown.length === 0) {
      breakdown.push({ tier: "threeDay", count: 1, unitRate: 0, subtotal: 0 });
    }

    var totalPrice = breakdown.reduce(function(s, b) { return s + b.subtotal; }, 0);

    // Build a human-readable label
    var label = breakdown.map(function(b) {
      var tl = b.tier === "month" ? "Mo" : b.tier === "week" ? "Wk" : "3-Day";
      return b.count + "\u00d7 " + tl;
    }).join(" + ");

    // Primary rateType = the largest tier used (for display purposes)
    var rateType = breakdown[0].tier;

    return { breakdown: breakdown, totalPrice: totalPrice, rateType: rateType, label: label };
  }


  // ── Cross rentals (docs/CROSS_RENTAL_PLAN.md) ─────────────────────────────
  // An ORDER of gear rented in from a vendor, with lines. Only confirmed and
  // picked-up orders count as inventory; a quoted order is flagged, never
  // counted (the owner's rule: "like a quote, it's not marked as unavailable
  // until it's confirmed").
  var CROSS_STATES = ["quoted", "confirmed", "picked-up", "returned", "cancelled"];
  var CROSS_COUNTS = { "confirmed": true, "picked-up": true };
  var CROSS_COLORS = {
    "quoted":    window.LTP_badgeFromHex("#6FA8F5"),
    "confirmed": window.LTP_badgeFromHex("#5FD08A"),
    "picked-up": window.LTP_badgeFromHex("#FF8A50"),
    "returned":  window.LTP_badgeFromHex("#9AA5B1"),
    "cancelled": window.LTP_badgeFromHex("#F0857A"),
  };
  var CROSS_LABELS = { "quoted": "Quoted", "confirmed": "Confirmed", "picked-up": "Picked Up", "returned": "Returned", "cancelled": "Cancelled" };

  function crossBadge(status) {
    var c = CROSS_COLORS[status] || CROSS_COLORS["quoted"];
    return h("span", { style: { background: c.bg, color: c.text, border: "1px solid " + c.bd, padding: "2px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" } }, CROSS_LABELS[status] || status);
  }

  // A line's effective rental period: its own dates, else the order's.
  function lineDates(order, line) {
    order = order || {}; line = line || {};
    return { start: line.startDate || order.startDate || "", end: line.endDate || order.endDate || "" };
  }

  // Does the period [s, e] cover the whole query range? Deliberately
  // "covers", not "overlaps": allocatedQty counts any overlapping booking
  // against the whole range, so supply must be good for the whole range too.
  function covers(s, e, startDate, endDate) {
    if (!s || !e || !startDate || !endDate) return false;
    return s <= startDate && e >= endDate;
  }

  // Every (order, line) pair for an item whose period covers the range and
  // whose order is in one of `statuses`. Shared by the qty sums and the chips.
  function crossLinesFor(crossRentals, equipmentId, startDate, endDate, statuses) {
    var out = [];
    (crossRentals || []).forEach(function(o) {
      if (!o || !statuses[o.status]) return;
      (o.lines || []).forEach(function(l) {
        if (!l || l.equipmentId == null || l.equipmentId !== equipmentId) return;
        var d = lineDates(o, l);
        if (!covers(d.start, d.end, startDate, endDate)) return;
        out.push({ order: o, line: l, qty: Math.max(0, Number(l.qty) || 0) });
      });
    });
    return out;
  }

  // Units supplied by confirmed cross rentals for the range.
  function crossRentedQty(crossRentals, equipmentId, startDate, endDate) {
    return crossLinesFor(crossRentals, equipmentId, startDate, endDate, CROSS_COUNTS)
      .reduce(function(s, x) { return s + x.qty; }, 0);
  }

  // Units a vendor has QUOTED for the range — never counted, only flagged.
  function crossQuotedQty(crossRentals, equipmentId, startDate, endDate) {
    return crossLinesFor(crossRentals, equipmentId, startDate, endDate, { "quoted": true })
      .reduce(function(s, x) { return s + x.qty; }, 0);
  }

  // Owned rentable stock PLUS confirmed cross-rented units for the range.
  // Every ranged availability check reads this; eqQty stays "owned, rentable".
  // With no range there is nothing to cover, so it is just the owned figure.
  function totalQty(eq, crossRentals, startDate, endDate) {
    var owned = eqQty(eq);
    if (!startDate || !endDate) return owned;
    return owned + crossRentedQty(crossRentals, eq.id, startDate, endDate);
  }

  // What ONE line costs: a negotiated flat total when set, else the pricing
  // engine over the line's rates × qty.
  function lineCost(order, line) {
    if (!line) return 0;
    var qty = Math.max(0, Number(line.qty) || 0);
    if (line.costOverride !== null && line.costOverride !== undefined && line.costOverride !== "") {
      var o = Number(line.costOverride);
      return isFinite(o) && o >= 0 ? o : 0;
    }
    var d = lineDates(order, line);
    return calcRentalPrice(d.start || null, d.end || null, line.rates).totalPrice * qty;
  }

  function orderCost(order) {
    return ((order && order.lines) || []).reduce(function(s, l) { return s + lineCost(order, l); }, 0);
  }

  // The vendors that price an item, costed for a range: preferred first, then
  // cheapest. Inactive prices are skipped. Feeds the "cross-rent from…" hints.
  function vendorOptions(vendorRates, companies, equipmentId, startDate, endDate) {
    var out = [];
    (vendorRates || []).forEach(function(v) {
      if (!v || v.equipmentId !== equipmentId || v.active === false) return;
      var vendor = (companies || []).find(function(c) { return c.id === v.vendorCompanyId; });
      var rp = calcRentalPrice(startDate || null, endDate || null, v.rates);
      out.push({ rate: v, vendor: vendor || null, vendorName: vendor ? vendor.name : "Vendor #" + v.vendorCompanyId,
                 cost: rp.totalPrice, label: rp.label, preferred: !!v.preferred });
    });
    out.sort(function(a, b) {
      if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
      return a.cost - b.cost;
    });
    return out;
  }

  // Past its end date and still out (or confirmed but never marked returned).
  function crossOverdue(order, todayStr) {
    if (!order || !CROSS_COUNTS[order.status]) return false;
    var end = order.endDate || "";
    return !!end && end < (todayStr || today());
  }

  // ── Saving an order (shared by the Cross Rentals tab and the quote picker) ─
  // Assigns an id to a new order and writes it through the app-level setter.
  // Returns the saved id.
  function upsertCrossRental(data, crossRentals, setCrossRentals) {
    var saved;
    if (data.id) {
      saved = data;
      setCrossRentals(function(prev) { return prev.map(function(o) { return o.id === data.id ? data : o; }); });
    } else {
      var newId = Math.max.apply(null, (crossRentals || []).map(function(o) { return o.id; }).concat([0])) + 1;
      saved = Object.assign({ id: newId }, data);
      setCrossRentals(function(prev) { return prev.concat([saved]); });
    }
    return saved.id;
  }

  // Saving an order with "remember these prices" on refreshes the vendor's
  // price rows for every catalog-item line whose rates differ from what is on
  // file (or that has no row yet), stamped with today's quoted date. A line
  // still at the price on file leaves the row — and its date — alone, so
  // re-saving an old order to mark it returned never re-dates a price.
  function rememberVendorRates(order, setVendorRates) {
    if (!order || !order.rememberRates || order.vendorCompanyId == null || !setVendorRates) return;
    var todayStr = today();
    setVendorRates(function(prev) {
      var next = prev.slice();
      var nextId = Math.max.apply(null, next.map(function(v) { return v.id; }).concat([0])) + 1;
      (order.lines || []).forEach(function(l) {
        if (!l || l.equipmentId == null) return;
        var rates = l.rates || {};
        if (!RATE_KEYS.some(function(k) { return (Number(rates[k]) || 0) > 0; })) return;
        var clean = { threeDay: Number(rates.threeDay) || 0, week: Number(rates.week) || 0, month: Number(rates.month) || 0 };
        var idx = -1;
        for (var i = 0; i < next.length; i++) {
          if (next[i].vendorCompanyId === order.vendorCompanyId && next[i].equipmentId === l.equipmentId) { idx = i; break; }
        }
        if (idx === -1) {
          next.push({ id: nextId++, vendorCompanyId: order.vendorCompanyId, equipmentId: l.equipmentId, rates: clean,
                      vendorItem: "", quotedDate: todayStr, preferred: false, active: true, notes: "" });
        } else {
          var cur = next[idx].rates || {};
          var same = RATE_KEYS.every(function(k) { return (Number(cur[k]) || 0) === clean[k]; });
          if (!same) next[idx] = Object.assign({}, next[idx], { rates: clean, quotedDate: todayStr, active: true });
        }
      });
      return next;
    });
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
    calcRentalPrice:  calcRentalPrice,
    lineDates:        lineDates,
    crossLinesFor:    crossLinesFor,
    crossRentedQty:   crossRentedQty,
    crossQuotedQty:   crossQuotedQty,
    totalQty:         totalQty,
    lineCost:         lineCost,
    orderCost:        orderCost,
    vendorOptions:    vendorOptions,
    crossOverdue:     crossOverdue,
    upsertCrossRental:  upsertCrossRental,
    rememberVendorRates: rememberVendorRates,
    crossBadge:       crossBadge,
    CROSS_STATES:     CROSS_STATES,
    CROSS_COUNTS:     CROSS_COUNTS,
    CROSS_COLORS:     CROSS_COLORS,
    CROSS_LABELS:     CROSS_LABELS,
    baseRate:      baseRate,
    today:         today,
    addDays:       addDays,
  };
})();
