// Rentals — Availability View
// Depends on: rentals-utils.js
(function() {
  var h = React.createElement, useState = React.useState;

  window.RentalsAvailabilityView = function({ equipment, allocations, crossRentals, vendorRates, companies, projects, onOpenEquipment, onCrossRent }) {
    var R = window.LTP_RENTALS, B = window.LTP_THEME;
    var isMobile = window.LTP_useIsMobile();

    var [startDate, setStartDate] = useState(R.today());
    var [endDate,   setEndDate]   = useState(R.addDays(R.today(), 7));
    var [catFilter, setCatFilter] = useState("all");
    var [search,    setSearch]    = useState("");

    var cats = ["all"].concat(
      Array.from(new Set(
        equipment.filter(function(e) { return e.category !== "Accessories"; }).map(function(e) { return e.category; })
      ))
    );

    var q = search.toLowerCase();
    var filtered = equipment.filter(function(e) {
      if (e.category === "Accessories") return false;
      if (catFilter !== "all" && e.category !== catFilter) return false;
      if (q && e.name.toLowerCase().indexOf(q) === -1 && (e.manufacturer || "").toLowerCase().indexOf(q) === -1) return false;
      return true;
    });

    // Mobile gets a fuller set of quick presets (short rental durations are
    // common); desktop keeps its original three so its row stays unchanged.
    // The five mobile presets are sized to fit on a single row (see below).
    var datePresets = isMobile
      ? [{ l: "3 Days", d: 3 }, { l: "1 Week", d: 7 }, { l: "2 Weeks", d: 14 }, { l: "3 Weeks", d: 21 }, { l: "1 Month", d: 30 }]
      : [{ l: "1 Week", d: 7 }, { l: "2 Weeks", d: 14 }, { l: "1 Month", d: 30 }];
    var dateColStyle = { display: "flex", flexDirection: "column", gap: 4, flex: isMobile ? 1 : undefined, minWidth: isMobile ? 0 : undefined };
    var dateInpStyle = isMobile ? Object.assign({}, R.INP, { width: "100%", boxSizing: "border-box" }) : R.INP;

    return h("div", null,

      // Date range picker + quick presets
      h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: 8, padding: "14px 18px", marginBottom: 16, display: "flex", gap: isMobile ? 10 : 16, alignItems: "flex-end", flexWrap: "wrap" } },
        h("div", { style: dateColStyle },
          h("label", { style: R.LBL }, "From"),
          h(window.LTPDateField, { value: startDate, onChange: function(v) { setStartDate(v); }, ariaLabel: "Start date", style: dateInpStyle })),
        h("div", { style: dateColStyle },
          h("label", { style: R.LBL }, "To"),
          h(window.LTPDateField, { value: endDate, onChange: function(v) { setEndDate(v); }, ariaLabel: "End date", style: dateInpStyle })),
        h("div", { style: { display: "flex", gap: 6, flexWrap: isMobile ? "nowrap" : "wrap", alignItems: "flex-end", flexBasis: isMobile ? "100%" : undefined } },
          datePresets.map(function(p) {
            return h("button", { key: p.l, onClick: function() { var s = R.today(); setStartDate(s); setEndDate(R.addDays(s, p.d)); },
              style: Object.assign(
                { background: B.raised, border: "1px solid " + B.border, borderRadius: 4, color: B.textMut, padding: isMobile ? "7px 4px" : "7px 12px", fontSize: "11px", fontWeight: 600, cursor: "pointer" },
                isMobile ? { flex: 1, minWidth: 0, textAlign: "center", whiteSpace: "nowrap" } : null
              ) }, p.l);
          })
        )
      ),

      // Category filter + search
      isMobile
      ? h("div", { style: { marginBottom: 14 } },
          h("input", { value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search equipment...", style: Object.assign({}, R.INP, { width: "100%", boxSizing: "border-box", marginBottom: 10 }) }),
          h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
            cats.map(function(c) {
              return h("button", { key: c, onClick: function() { setCatFilter(c); },
                style: { background: catFilter === c ? B.accent : B.raised, color: catFilter === c ? B.btnInk : B.textMut, border: "1px solid " + (catFilter === c ? B.accent : B.border), borderRadius: 4, padding: "6px 12px", fontSize: "11px", fontWeight: 600, cursor: "pointer", textTransform: "capitalize" } }, c);
            })
          )
        )
      : h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 } },
          h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
            cats.map(function(c) {
              return h("button", { key: c, onClick: function() { setCatFilter(c); },
                style: { background: catFilter === c ? B.accent : B.raised, color: catFilter === c ? B.btnInk : B.textMut, border: "1px solid " + (catFilter === c ? B.accent : B.border), borderRadius: 4, padding: "4px 12px", fontSize: "11px", fontWeight: 600, cursor: "pointer", textTransform: "capitalize" } }, c);
            })
          ),
          h("input", { value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search equipment...", style: Object.assign({}, R.INP, { width: 200 }) })
        ),

      // Availability grid
      h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
        filtered.map(function(eq) {
          var consumed = R.allocatedQty(allocations, eq.id, startDate, endDate, null);
          // Owned stock plus confirmed cross-rented units covering the range.
          var total    = R.totalQty(eq, crossRentals, startDate, endDate);
          var avail    = total - consumed;
          var pct      = total > 0 ? consumed / total : 0;
          var barColor = avail === 0 ? B.danger : pct > 0.5 ? B.warn : B.success;

          var rangeAllocs = allocations.filter(function(a) {
            return a.equipmentId === eq.id && a.state !== "returned" && a.startDate <= endDate && a.endDate >= startDate;
          });
          // Cross rentals covering the range: confirmed ones are already in
          // `total`; quoted ones are shown but never counted.
          var crossLines  = R.crossLinesFor(crossRentals || [], eq.id, startDate, endDate, R.CROSS_COUNTS);
          var quotedLines = R.crossLinesFor(crossRentals || [], eq.id, startDate, endDate, { "quoted": true });
          var vendorName = function(id) { var c = (companies || []).find(function(x) { return x.id === id; }); return c ? c.name : "vendor"; };
          // Short for the range: who could supply it, and at what.
          var options = avail <= 0 ? R.vendorOptions(vendorRates || [], companies || [], eq.id, startDate, endDate) : [];
          var crossChip = function(x, quoted) {
            var tone = quoted ? B.warn : B.info;
            return h("span", { key: x.order.id + ":" + x.line.id, style: { fontSize: "10px", background: tone + "14", border: "1px solid " + tone + "55", borderRadius: 4, padding: "2px 8px", color: tone, fontWeight: 600 } },
              (quoted ? "×" + x.qty + " quoted · " : "incl. ×" + x.qty + " cross-rented · ") + vendorName(x.order.vendorCompanyId));
          };

          return h("div", { key: eq.id, onClick: function() { onOpenEquipment(eq.id); },
            style: { background: B.surface, border: "1px solid " + B.border, borderRadius: 8, padding: "12px 16px", cursor: "pointer", transition: "all 0.15s" },
            onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent + "44"; },
            onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },

            h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
              h("div", null,
                h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text, marginBottom: 2 } }, eq.name),
                h("div", { style: { fontSize: "11px", color: B.textMut } }, eq.category + (eq.subcategory ? " \u00b7 " + eq.subcategory : "") + " \u00b7 $" + R.baseRate(eq) + "/3-day" + (eq.crossRentalOnly ? " \u00b7 cross-rental only" : ""))),
              h("div", { style: { textAlign: "right" } },
                h("div", { style: { fontSize: "16px", fontWeight: 700, color: barColor } }, avail + "/" + total),
                h("div", { style: { fontSize: "10px", color: B.textMut } }, "available"))
            ),

            h("div", { style: { height: 6, background: B.raised, borderRadius: 3, overflow: "hidden", marginBottom: (rangeAllocs.length > 0 || crossLines.length > 0 || quotedLines.length > 0 || avail <= 0) ? 8 : 0 } },
              h("div", { style: { width: (pct * 100) + "%", height: "100%", background: barColor, borderRadius: 3, transition: "width 0.3s" } })
            ),

            (crossLines.length > 0 || quotedLines.length > 0) && h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: rangeAllocs.length > 0 || avail <= 0 ? 6 : 0 } },
              crossLines.map(function(x) { return crossChip(x, false); }).concat(quotedLines.map(function(x) { return crossChip(x, true); }))),

            // Nothing free for these dates: the vendors who price it, cheapest
            // after preferred, and a one-click order form already filled in.
            avail <= 0 && onCrossRent && h("div", { onClick: function(e) { e.stopPropagation(); },
              style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: "11px", color: B.textSec, marginBottom: rangeAllocs.length > 0 ? 6 : 0 } },
              h("span", { style: { fontWeight: 600, color: B.textMut } }, "Cross-rent:"),
              options.length === 0
                ? h("span", { style: { fontStyle: "italic", color: B.textMut } }, "no vendor prices on file")
                : options.slice(0, 3).map(function(o) {
                    return h("button", { key: o.rate.id, onClick: function() { onCrossRent(eq.id, startDate, endDate, o.rate.vendorCompanyId); },
                      title: o.label + " at " + o.vendorName + (o.preferred ? " (preferred)" : ""),
                      style: { background: B.raised, border: "1px solid " + B.border, borderRadius: 4, color: B.text, padding: "3px 8px", fontSize: "11px", cursor: "pointer" } },
                      (o.preferred ? "★ " : "") + o.vendorName + " $" + window.LTP_money(o.cost));
                  }),
              h(window.Btn, { small: true, onClick: function() { onCrossRent(eq.id, startDate, endDate, options.length ? options[0].rate.vendorCompanyId : null); } }, "+ Cross rental")),

            rangeAllocs.length > 0 && h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
              rangeAllocs.map(function(a) {
                var proj = projects.find(function(p) { return p.id === a.projectId; });
                return h("span", { key: a.id, style: { fontSize: "10px", background: B.raised, border: "1px solid " + B.border, borderRadius: 4, padding: "2px 8px", color: B.textSec, display: "inline-flex", gap: 4, alignItems: "center" } },
                  (proj ? proj.name : "?") + " \u00d7" + a.qty + " \u00b7 ", R.allocBadge(a.state));
              })
            )
          );
        })
      )
    );
  };
})();
