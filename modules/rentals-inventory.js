// Rentals — Equipment Inventory View
// Depends on: rentals-utils.js
(function() {
  var h = React.createElement, useState = React.useState;

  window.RentalsInventoryView = function({ equipment, allocations, onOpenEquipment }) {
    var R = window.LTP_RENTALS, B = window.LTP_THEME;
    var isMobile = window.LTP_useIsMobile();

    var [catFilter, setCatFilter] = useState("all");
    var [search,    setSearch]    = useState("");
    // ONE sort state for both viewports — { key, dir } naming a column in COLS
    // below. The phone chips and the desktop column headers set the same state.
    var [sort,      setSort]      = useState({ key: "name", dir: "asc" });

    var cats = ["all"].concat(Array.from(new Set(equipment.map(function(e) { return e.category; }))));
    var q = search.toLowerCase();

    // Units on the road right now, and open maintenance issues. Both were muted
    // scraps at the right edge of the old row; as columns they can be ordered
    // by, which is how you find what is out and what is broken.
    function outQty(eq) {
      return allocations.filter(function(a) { return a.equipmentId === eq.id && a.state !== "returned"; })
        .reduce(function(s, a) { return s + a.qty; }, 0);
    }
    function issueCount(eq) {
      return eq.serialized
        ? (eq.units || []).reduce(function(s, u) { return s + (u.maintenanceLogs || []).filter(function(l) { return l.status === "open"; }).length; }, 0)
        : (eq.maintenanceLogs || []).filter(function(l) { return l.status === "open"; }).length;
    }
    function availability(eq) { return outQty(eq) > 0 ? "partial" : "available"; }

    var COLS = [
      { key: "name",     label: "Item",         w: "minmax(0,1.8fr)",
        sort: function(e) { return e.name || ""; } },
      { key: "category", label: "Category",     w: "minmax(0,1.1fr)", flex: true,
        sort: function(e) { return e.category || ""; } },
      { key: "mfr",      label: "Manufacturer", w: "minmax(0,1fr)",
        sort: function(e) { return e.manufacturer || ""; } },
      { key: "units",    label: "Units",  w: "78px",  align: "right", mono: true, dir: "desc", sort: R.eqQty },
      { key: "out",      label: "Out",    w: "68px",  align: "right", mono: true, dir: "desc", sort: outQty },
      { key: "issues",   label: "Issues", w: "76px",  align: "right", mono: true, dir: "desc", sort: issueCount },
      { key: "rate",     label: "3-Day",  w: "100px", align: "right", mono: true, dir: "desc",
        sort: function(e) { return (e.rates && e.rates.threeDay) || 0; } },
      { key: "status",   label: "Status", w: "104px", sort: availability },
    ];

    var filtered = equipment.filter(function(e) {
      if (catFilter !== "all" && e.category !== catFilter) return false;
      if (q && e.name.toLowerCase().indexOf(q) === -1 && (e.manufacturer || "").toLowerCase().indexOf(q) === -1 && (e.model || "").toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    var ordered = window.LTP_sortRows(filtered, COLS, sort);

    var totalUnits = equipment.reduce(function(s, e) { return s + e.qty; }, 0);
    var totalCost  = equipment.reduce(function(s, e) { return s + (e.purchaseCost || 0) * e.qty; }, 0);
    var checkedOut = allocations.filter(function(a) { return a.state === "checked-out"; }).length;

    return h("div", null,

      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12, flexWrap: "wrap" } },
        h(window.LTPScrollStrip, { isMobile: isMobile, mobileStyle: { display: "flex", gap: 8, overflowX: "auto", flexWrap: "nowrap", WebkitOverflowScrolling: "touch", scrollbarWidth: "none", width: "100%", paddingBottom: 4 }, desktopStyle: { display: "flex", gap: 6, flexWrap: "wrap" } },
          cats.map(function(c) {
            return h("button", { key: c, onClick: function() { setCatFilter(c); }, className: "ltp-tap",
              style: { flexShrink: 0, whiteSpace: "nowrap", background: catFilter === c ? B.accent : B.raised, color: catFilter === c ? B.btnInk : B.textMut, border: "1px solid " + (catFilter === c ? B.accent : B.border), borderRadius: isMobile ? "16px" : 4, padding: isMobile ? "8px 16px" : "4px 12px", fontSize: isMobile ? "13px" : "11px", fontWeight: 600, cursor: "pointer", textTransform: "capitalize", minHeight: isMobile ? 36 : undefined } }, c);
          })
        ),
        h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
          h("input", { value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search inventory...", style: Object.assign({}, R.INP, { width: isMobile ? "100%" : 180 }, isMobile ? { borderRadius: "8px", padding: "9px 12px" } : {}) }),
          // Sort chips \u2014 PHONE ONLY; the desktop table sorts from its headers.
          isMobile && [{ l: "A\u2192Z", s: { key: "name", dir: "asc" } },
                       { l: "Z\u2192A", s: { key: "name", dir: "desc" } },
                       { l: "$ \u2191", s: { key: "rate", dir: "asc" } },
                       { l: "$ \u2193", s: { key: "rate", dir: "desc" } }].map(function(o) {
            var active = sort.key === o.s.key && sort.dir === o.s.dir;
            return h("button", { key: o.l, onClick: function() { setSort(o.s); },
              style: { background: active ? B.accent : B.raised, color: active ? B.btnInk : B.textMut, border: "1px solid " + (active ? B.accent : B.border), borderRadius: 4, padding: "4px 10px", fontSize: "11px", fontWeight: 600, cursor: "pointer" } }, o.l);
          })
        )
      ),

      ordered.length === 0 ? h(window.EmptyState, { text: "No equipment matches your search." }) :
      isMobile
        // \u2500\u2500 Phone: the stacked card rows, unchanged \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
        ? h(window.LTPList, null,
        ordered.map(function(eq) {
          var totalUnitQty = R.eqQty(eq);
          var activeOut  = outQty(eq);
          var openIssues = issueCount(eq);

          return h(window.LTPRow, { key: eq.id, onClick: function() { onOpenEquipment(eq.id); },
            style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },

            h("div", null,
              h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text, marginBottom: 3 } }, eq.name),
              h("div", { style: { fontSize: "11px", color: B.textMut } }, [eq.category, eq.subcategory, eq.manufacturer].filter(Boolean).join(" \u00b7 "))
            ),

            h("div", { style: { display: "flex", gap: 16, alignItems: "center" } },
              openIssues > 0 && h("span", { style: { fontSize: "10px", color: B.danger, fontWeight: 700 } }, openIssues + " issue" + (openIssues > 1 ? "s" : "")),
              h("div", { style: { textAlign: "right" } },
                h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.accent } }, "$" + R.baseRate(eq) + "/3-day"),
                h("div", { style: { fontSize: "11px", color: B.textMut } }, totalUnitQty + " units" + (activeOut > 0 ? " \u00b7 " + activeOut + " out" : ""))
              ),
              activeOut > 0
                ? h("span", { style: { fontSize: "10px", fontWeight: 700, background: B.accentMuted, color: B.accent, border: "1px solid " + B.accent + "44", padding: "2px 8px", borderRadius: 4, textTransform: "uppercase" } }, "partial")
                // The green "available" chip is the default state — redundant on
                // a phone, so it's dropped there (the desktop table keeps it).
                : null
            )
          );
        })
      )
        // ── Desktop: one line per item. "Out" and "Issues" were muted scraps
        //    at the right edge; as their own columns they sort, so the gear
        //    that is on the road or broken comes to the top on one click. ──
        : h(window.LTPTable, { columns: COLS, sort: sort, onSort: setSort,
            rows: ordered.map(function(eq) {
              var activeOut = outQty(eq), openIssues = issueCount(eq);
              var chip = { fontSize: "10px", fontWeight: 700, padding: "2px 8px", borderRadius: 4, textTransform: "uppercase", whiteSpace: "nowrap" };
              return { key: eq.id, onClick: function() { onOpenEquipment(eq.id); }, cells: [
                h("span", { style: { fontSize: "13px", fontWeight: 600, color: B.text } }, eq.name),
                // Category and subcategory name one thing between them, so they
                // sit adjacent — nothing grows to push them to opposite edges of
                // the column, where the subcategory would read as the next one.
                [h("span", { key: "c", style: { fontSize: "12px", color: B.textSec, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, eq.category || "—"),
                 eq.subcategory && h("span", { key: "s", style: { fontSize: "10px", color: B.textMut, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, eq.subcategory)],
                h("span", { style: { fontSize: "12px", color: B.textSec } }, eq.manufacturer || "—"),
                h("span", { style: { fontSize: "12px", color: B.textSec } }, R.eqQty(eq)),
                h("span", { style: { fontSize: "12px", color: activeOut > 0 ? B.accent : B.textMut, fontWeight: activeOut > 0 ? 700 : 400 } }, activeOut || "—"),
                h("span", { style: { fontSize: "12px", color: openIssues > 0 ? B.danger : B.textMut, fontWeight: openIssues > 0 ? 700 : 400 } }, openIssues || "—"),
                h("span", { style: { fontSize: "13px", fontWeight: 700, color: B.accent } }, "$" + R.baseRate(eq)),
                activeOut > 0
                  ? h("span", { style: Object.assign({}, chip, { background: B.accentMuted, color: B.accent, border: "1px solid " + B.accent + "44" }) }, "partial")
                  : h("span", { style: Object.assign({}, chip, { background: B.successBg, color: B.success, border: "1px solid " + B.successBd }) }, "available"),
              ] };
            }) })
    );
  };
})();
