// Quotes List — browse existing quotes. Click one to open the full-screen builder.
(function() {
  var h = React.createElement, useState = React.useState;
  var B = window.LTP_THEME;
  var nav = window.LTPRouter.navigate;
  var fmt = window.LTP_formatDate;
  // Date-column format for the desktop table: "Mar 4", with the year only when
  // it isn't the current one (see components/domain-util.js).
  function fmtS(d) { return window.LTP_formatDateShort(d, { weekday: false }); }

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
    // ONE sort state for both viewports — { key, dir } naming a column in COLS
    // below. The phone chips and the desktop column headers set the same state
    // and order through the same accessors, so they cannot disagree.
    var [sort, setSort] = useState({ key: "created", dir: "desc" });
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

    // The quote's job name — the linked project, or the typed customName for a
    // project-less quote. One field for searching, sorting and display alike.
    function jobName(qt) {
      var proj = projects.find(function(p) { return p.id === qt.projectId; });
      return proj ? proj.name : (qt.customName || "");
    }
    // Only a SENT quote carries a shelf life: a draft was never promised to
    // anyone, and accepted/declined/converted are settled. The blank for every
    // other status sinks to the bottom of the Expires column in both
    // directions, so sorting by it surfaces the live quotes and nothing else.
    function expiryOf(qt) { return qt.status === "sent" ? window.LTP_quoteExpiry(qt) : ""; }

    // The desktop columns, and the ordering accessors behind every sort here.
    var COLS = [
      { key: "ref",     label: "Ref",     w: "126px", sort: displayRef },
      { key: "job",     label: "Job",     w: "minmax(0,2fr)", flex: true, sort: jobName },
      { key: "client",  label: "Client",  w: "minmax(0,1.5fr)", flex: true, sort: clientLabel },
      { key: "created", label: "Created", w: "104px", dir: "desc",
        sort: function(qt) { return qt.createdDate || ""; } },
      { key: "expires", label: "Expires", w: "104px", dir: "desc", sort: expiryOf },
      { key: "total",   label: "Total",   w: "118px", align: "right", mono: true, dir: "desc",
        sort: function(qt) { return computeTotals(qt).total || 0; } },
      { key: "status",  label: "Status",  w: "104px", sort: function(qt) { return qt.status || ""; } },
    ];

    var q = search.trim().toLowerCase();
    var filtered = quotes.filter(function(qt) {
      // Converted quotes are hidden by default (they've become invoices) — the
      // "Show Converted" toggle brings them back into the list.
      if (!showConverted && qt.status === "converted") return false;
      if (filter !== "all" && qt.status !== filter) return false;
      if (q) {
        var hay = (displayRef(qt) + " " + clientLabel(qt) + " " + jobName(qt)).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    var ordered = window.LTP_sortRows(filtered, COLS, sort);

    var filters = ["all", "draft", "sent", "accepted", "declined"];
    var sorts = [{ l: "Newest", s: { key: "created", dir: "desc" } },
                 { l: "Oldest", s: { key: "created", dir: "asc"  } },
                 { l: "Ref #",  s: { key: "ref",     dir: "asc"  } }];

    // Show/Hide converted toggle — rides the filter row at the right (chip
    // height on mobile), mirroring the Projects "Show Completed" control.
    var showConvertedBtn = h("button", { onClick: function() { setShowConverted(!showConverted); }, className: "ltp-tap",
      style: { flexShrink: 0, background: showConverted ? B.accent : B.raised, color: showConverted ? B.btnInk : B.textMut, border: "1px solid " + (showConverted ? B.accent : B.border), borderRadius: isMobile ? "16px" : "4px", padding: isMobile ? "8px 14px" : "4px 12px", fontSize: isMobile ? "12px" : "11px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", minHeight: isMobile ? 36 : undefined } },
      showConverted ? "✓ Converted" : "Show Converted");

    // Sort chips — PHONE ONLY. On desktop the column headers carry the sort, so
    // a chip row there would be a second control driving the same state.
    var sortBtnsEl = h("div", { style: { display: "flex", gap: 4 } },
      sorts.map(function(s) {
        var active = sort.key === s.s.key && sort.dir === s.s.dir;
        return h("button", { key: s.l, onClick: function() { setSort(s.s); },
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

      // Sort row. The phone gets the chips; desktop keeps only the search here,
      // because its column headers do the sorting.
      isMobile
        ? h("div", { style: { display: "flex", marginBottom: 10 } }, sortBtnsEl)
        : h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8 } },
            h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search by ref, company, or project…",
              style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", width: 260 } })),

      isMobile
        // ── Phone: the stacked ledger rows, unchanged ──────────────────────
        ? h(window.LTPList, null,
        ordered.length === 0 && h("div", { style: { padding: "32px", textAlign: "center", color: B.textMut, fontSize: "13px", fontStyle: "italic" } }, "No quotes match your search."),
        ordered.map(function(qt) {
          var name = jobName(qt) || "Untitled Quote";
          var tot  = computeTotals(qt);
          var contact = (qt.clientType !== "contact" && qt.companyId) ? contactName(qt) : null;
          // A sent quote's shelf life, on the row so the list can be scanned for
          // the ones that have gone stale — those need their pricing re-checked
          // (and their expiry pushed out in the builder) before they're honoured.
          var expiry = expiryOf(qt);
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
            // Joined from the parts that exist, so a quote with no created date
            // does not trail a lone separator. Short dates too: the long form is
            // most of a phone row on its own.
            h("div", { style: { fontSize: "11px", color: B.textMut, marginTop: 2 } },
              [clientLabel(qt), contact, fmtS(qt.createdDate)].filter(Boolean).join(" \u00b7 "),
              expiry && h("span", { style: { color: expired ? B.danger : B.textMut, fontWeight: expired ? 700 : 400 } },
                " \u00b7 " + (expired ? "Expired " : "Expires ") + fmtS(expiry)))
          );
        })
      )
        // \u2500\u2500 Desktop: one line per quote, across the full width \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
        : h(window.LTPTable, { columns: COLS, sort: sort, onSort: setSort, empty: "No quotes match your search.",
            rows: ordered.map(function(qt) {
              var tot = computeTotals(qt);
              var contact = (qt.clientType !== "contact" && qt.companyId) ? contactName(qt) : null;
              var expiry = expiryOf(qt);
              // A stale quote needs its pricing re-checked (and its expiry
              // pushed out in the builder) before it is honoured, so the Expires
              // column shouts once the date has passed.
              var expired = window.LTP_isQuoteExpired(qt);
              var grow = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
              return { key: qt.id, onClick: function() { nav("quotes/" + qt.id); }, cells: [
                h("span", { style: { fontSize: "13px", fontWeight: 700, color: B.accent, letterSpacing: "0.01em" } }, displayRef(qt)),
                h("span", { style: Object.assign({ fontSize: "13px", fontWeight: 600, color: B.text }, grow) }, jobName(qt) || "Untitled Quote"),
                [h("span", { key: "c", style: Object.assign({ fontSize: "12px", color: B.textSec }, grow) }, clientLabel(qt)),
                 contact && h("span", { key: "p", style: { fontSize: "10px", color: B.textMut, flexShrink: 0 } }, contact)],
                h("span", { style: { fontSize: "11px", color: B.textSec } }, fmtS(qt.createdDate)),
                h("span", { style: { fontSize: "11px", color: expired ? B.danger : B.textSec, fontWeight: expired ? 700 : 400 } },
                  expiry ? fmtS(expiry) : "\u2014"),
                h("span", { style: { fontSize: "13px", fontWeight: 700, color: B.accent } }, "$" + window.LTP_money(tot.total)),
                h(window.Badge, { status: qt.status }),
              ] };
            }) })
    );
  };

})();
