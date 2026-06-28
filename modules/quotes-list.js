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
    var [filter, setFilter]     = useState("all");
    var [search, setSearch]     = useState("");
    var [sortMode, setSortMode] = useState("date-desc");

    // Resolve the client label — either a company or a contact's full name.
    function clientLabel(qt) {
      if (qt.clientType === "contact" || (!qt.companyId && qt.clientContactId)) {
        var c = (contacts || []).find(function(x) { return x.id === qt.clientContactId; });
        return c ? (c.firstName + " " + c.lastName) : "(no contact)";
      }
      var co = (companies || []).find(function(x) { return x.id === qt.companyId; });
      return co ? co.name : "(no company)";
    }

    var q = search.trim().toLowerCase();
    var filtered = quotes.filter(function(qt) {
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

    var filters = ["all", "draft", "sent", "accepted", "declined", "converted"];
    var sorts = [{ k: "date-desc", l: "Newest" }, { k: "date-asc", l: "Oldest" }, { k: "ref", l: "Ref #" }];

    return h("div", null,
      // Toolbar
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 } },
        h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
          filters.map(function(f) {
            var active = filter === f;
            return h("button", { key: f, onClick: function() { setFilter(f); },
              style: { background: active ? B.accent : B.raised, color: active ? "#000" : B.textMut,
                       border: "1px solid " + (active ? B.accent : B.border), borderRadius: "4px",
                       padding: "4px 12px", fontSize: "11px", fontWeight: 600, cursor: "pointer", textTransform: "capitalize" } }, f);
          })
        ),
        h("button", { onClick: function() { nav("quotes/new"); },
          style: { background: B.accent, color: "#000", border: "none", borderRadius: "6px", padding: "7px 16px", fontSize: "12px", fontWeight: 700, cursor: "pointer" } }, "+ New Quote")
      ),

      // Search + sort
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8 } },
        h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search by ref, company, or project…",
          style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", width: 260 } }),
        h("div", { style: { display: "flex", gap: 4 } },
          sorts.map(function(s) {
            var active = sortMode === s.k;
            return h("button", { key: s.k, onClick: function() { setSortMode(s.k); },
              style: { background: active ? B.accent : B.raised, color: active ? "#000" : B.textMut,
                       border: "1px solid " + (active ? B.accent : B.border), borderRadius: "4px",
                       padding: "3px 10px", fontSize: "10px", fontWeight: 600, cursor: "pointer" } }, s.l);
          })
        )
      ),

      // List
      h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
        filtered.length === 0 && h("div", { style: { padding: "32px", textAlign: "center", color: B.textMut, fontSize: "13px", fontStyle: "italic" } }, "No quotes match your search."),
        filtered.map(function(qt) {
          var proj = projects.find(function(p) { return p.id === qt.projectId; });
          var name = proj ? proj.name : (qt.customName || "Untitled Quote");
          var tot  = computeTotals(qt);
          var itemCount = (qt.sections || []).reduce(function(n, s) { return n + (s.items || []).filter(function(i) { return i.type !== "note"; }).length; }, 0);
          return h("div", { key: qt.id, onClick: function() { nav("quotes/" + qt.id); },
            style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: "12px 16px", cursor: "pointer", transition: "all 0.15s" },
            onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent + "44"; },
            onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
            h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 } },
              h("div", null,
                h("div", { style: { fontSize: "16px", fontWeight: 700, marginBottom: 3, fontFamily: "'Playfair Display', Georgia, serif", letterSpacing: "0.01em" } },
                  h("span", { style: { color: B.accent } }, displayRef(qt)),
                  h("span", { style: { color: B.textMut, margin: "0 10px" } }, "\u00b7"),
                  h("span", { style: { color: B.text } }, name)
                ),
                h("div", { style: { fontSize: "11px", color: B.textMut } }, clientLabel(qt) + " \u00b7 " + fmt(qt.createdDate))
              ),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                h("span", { style: { fontSize: "15px", fontWeight: 700, color: B.accent } }, "$" + Math.round(tot.total).toLocaleString()),
                h(window.Badge, { status: qt.status })
              )
            ),
            h("div", { style: { fontSize: "11px", color: B.textMut } }, itemCount + " line items \u00b7 " + (qt.sections || []).length + " sections")
          );
        })
      )
    );
  };

})();
