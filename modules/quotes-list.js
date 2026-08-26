// Quotes List — browse existing quotes. Click one to open the full-screen builder.
(function() {
  var h = React.createElement, useState = React.useState;
  var B = window.LTP_THEME;
  var nav = window.LTPRouter.navigate;
  var fmt = window.LTP_formatDate;

  // Quote totals — the canonical, QB-tax-aware helper (single source of truth).
  var computeTotals = window.LTP_QUOTE_TOTALS;

  // Display reference "Q-YEAR-NNN" derived from id + createdDate
  function displayRef(q) {
    var year = (q.createdDate || "").substring(0, 4) || String(new Date().getFullYear());
    return "Q-" + year + "-" + String(q.id).padStart(3, "0");
  }

  window.QuotesList = function({ quotes, setQuotes, companies, contacts, projects }) {
    var isMobile = window.LTP_useIsMobile();
    var [filter, setFilter]     = useState("all");
    var [search, setSearch]     = useState("");
    var [sortMode, setSortMode] = useState("date-desc");
    var [showConverted, setShowConverted] = useState(false);

    // Resolve the client label — either a company or a contact's full name.
    function clientLabel(qt) {
      if (qt.clientType === "contact" || (!qt.companyId && qt.clientContactId)) {
        var c = (contacts || []).find(function(x) { return x.id === qt.clientContactId; });
        return c ? (c.firstName + " " + c.lastName) : "(no contact)";
      }
      var co = (companies || []).find(function(x) { return x.id === qt.companyId; });
      return co ? co.name : "(no company)";
    }

    // The primary contact on the quote, shown next to the company name.
    function contactName(qt) {
      var c = (contacts || []).find(function(x) { return x.id === qt.clientContactId; });
      return c ? (c.firstName + " " + c.lastName).trim() : null;
    }

    var q = search.trim().toLowerCase();
    var filtered = quotes.filter(function(qt) {
      // Converted quotes are hidden by default (they've become invoices) — the
      // "Show Converted" toggle brings them back into the list.
      if (!showConverted && qt.status === "converted") return false;
      if (filter !== "all" && qt.status !== filter) return false;
      if (q) {
        var proj = projects.find(function(p) { return p.id === qt.projectId; });
        var name = proj ? proj.name : (qt.customName || "");
        var hay  = (displayRef(qt) + " " + clientLabel(qt) + " " + name).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    }).sort(function(a, b) {
      if (sortMode === "date-asc")  return (a.createdDate || "") > (b.createdDate || "") ? 1 : -1;
      if (sortMode === "date-desc") return (b.createdDate || "") > (a.createdDate || "") ? 1 : -1;
      return displayRef(a).localeCompare(displayRef(b));
    });

    var filters = ["all", "draft", "sent", "accepted", "declined"];
    var sorts = [{ k: "date-desc", l: "Newest" }, { k: "date-asc", l: "Oldest" }, { k: "ref", l: "Ref #" }];

    // Show/Hide converted toggle — rides the filter row at the right (chip
    // height on mobile), mirroring the Projects "Show Completed" control.
    var showConvertedBtn = h("button", { onClick: function() { setShowConverted(!showConverted); }, className: "ltp-tap",
      style: { flexShrink: 0, background: showConverted ? B.accent : B.raised, color: showConverted ? B.btnInk : B.textMut, border: "1px solid " + (showConverted ? B.accent : B.border), borderRadius: isMobile ? "16px" : "4px", padding: isMobile ? "8px 14px" : "4px 12px", fontSize: isMobile ? "12px" : "11px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", minHeight: isMobile ? 36 : undefined } },
      showConverted ? "✓ Converted" : "Show Converted");

    var sortBtnsEl = h("div", { style: { display: "flex", gap: 4 } },
      sorts.map(function(s) {
        var active = sortMode === s.k;
        return h("button", { key: s.k, onClick: function() { setSortMode(s.k); },
          style: { background: active ? B.accent : B.raised, color: active ? B.btnInk : B.textMut,
                   border: "1px solid " + (active ? B.accent : B.border), borderRadius: "4px",
                   padding: "3px 10px", fontSize: "10px", fontWeight: 600, cursor: "pointer" } }, s.l);
      }));

    return h("div", null,
      // Mobile: page title + search share the top row (the shell hides its own
      // title/tabs on mobile; the top bar already reads "QUOTES").
      isMobile && h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12 } },
        h("h2", { style: { fontSize: "20px", fontWeight: 700, color: B.text, margin: 0, flexShrink: 0 } }, "Quotes"),
        h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search…",
          style: { flex: 1, minWidth: 0, background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: "9px 12px", color: B.text, fontFamily: "inherit", outline: "none" } })),

      // Filter chips; Show Converted rides the right (+ New Quote on desktop).
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: isMobile ? "flex-start" : "center", marginBottom: 14, flexWrap: isMobile ? "nowrap" : "wrap", gap: 8 } },
        h(window.LTPScrollStrip, { isMobile: isMobile, mobileStyle: { display: "flex", gap: 8, overflowX: "auto", flexWrap: "nowrap", WebkitOverflowScrolling: "touch", scrollbarWidth: "none", paddingBottom: 4 }, wrapStyle: { flex: 1, minWidth: 0 }, desktopStyle: { display: "flex", gap: 6, flexWrap: "wrap" } },
          filters.map(function(f) {
            var active = filter === f;
            return h("button", { key: f, onClick: function() { setFilter(f); }, className: "ltp-tap",
              style: { flexShrink: 0, whiteSpace: "nowrap", background: active ? B.accent : B.raised, color: active ? B.btnInk : B.textMut,
                       border: "1px solid " + (active ? B.accent : B.border), borderRadius: isMobile ? "16px" : "4px",
                       padding: isMobile ? "8px 16px" : "4px 12px", fontSize: isMobile ? "13px" : "11px", fontWeight: 600, cursor: "pointer", textTransform: "capitalize", minHeight: isMobile ? 36 : undefined } }, f);
          })
        ),
        h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexShrink: 0 } },
          showConvertedBtn,
          !isMobile && h("button", { onClick: function() { nav("quotes/new"); },
            style: { background: B.accent, color: B.btnInk, border: "none", borderRadius: "6px", padding: "7px 16px", fontSize: "12px", fontWeight: 700, cursor: "pointer" } }, "+ New Quote"))
      ),

      // Sort row. Desktop pairs it with the search; on mobile search moved up top.
      isMobile
        ? h("div", { style: { display: "flex", marginBottom: 10 } }, sortBtnsEl)
        : h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8 } },
            h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search by ref, company, or project…",
              style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", width: 260 } }),
            sortBtnsEl),

      // List — ruled ledger panel (see components/ui.js LTPList)
      h(window.LTPList, null,
        filtered.length === 0 && h("div", { style: { padding: "32px", textAlign: "center", color: B.textMut, fontSize: "13px", fontStyle: "italic" } }, "No quotes match your search."),
        filtered.map(function(qt) {
          var proj = projects.find(function(p) { return p.id === qt.projectId; });
          var name = proj ? proj.name : (qt.customName || "Untitled Quote");
          var tot  = computeTotals(qt);
          var contact = (qt.clientType !== "contact" && qt.companyId) ? contactName(qt) : null;
          // A sent quote's shelf life, on the row so the list can be scanned for
          // the ones that have gone stale — those need their pricing re-checked
          // (and their expiry pushed out in the builder) before they're honoured.
          // Only "sent" carries one: a draft was never promised to anyone, and
          // accepted/declined/converted are settled.
          var expiry = qt.status === "sent" ? window.LTP_quoteExpiry(qt) : "";
          var expired = window.LTP_isQuoteExpired(qt);
          return h(window.LTPRow, { key: qt.id, onClick: function() { nav("quotes/" + qt.id); } },
            // Ref (left) + price/status (right) stay on the top row.
            h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 } },
              h("div", { style: { fontSize: "15px", fontWeight: 700, color: B.accent, letterSpacing: "0.01em", minWidth: 0 } }, displayRef(qt)),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexShrink: 0 } },
                h("span", { style: { fontSize: "15px", fontWeight: 700, color: B.accent } }, "$" + window.LTP_money(tot.total)),
                h(window.Badge, { status: qt.status })
              )
            ),
            // Full-width project name below \u2014 shows in full (wraps if very long).
            h("div", { style: { fontSize: "14px", fontWeight: 600, color: B.text, marginTop: 2 } }, name),
            h("div", { style: { fontSize: "11px", color: B.textMut, marginTop: 2 } },
              clientLabel(qt) + (contact ? " \u00b7 " + contact : "") + " \u00b7 " + fmt(qt.createdDate),
              expiry && h("span", { style: { color: expired ? B.danger : B.textMut, fontWeight: expired ? 700 : 400 } },
                " \u00b7 " + (expired ? "Expired " : "Expires ") + fmt(expiry)))
          );
        })
      )
    );
  };

})();
