// Quotes → Client Rates — pick a client, then add the roles they negotiated.
//
// The same editor is embedded in the CRM company detail; this tab is the
// "start from the client" entry point, and the only place a directly-billed
// CONTACT (clientType "contact") can be given negotiated rates.
//
// Everything about how a rate resolves lives in components/client-rates.js and
// theme.js — this module is picker + navigation only.
(function() {
  var h = React.createElement, useState = React.useState;
  var B = window.LTP_THEME;

  window.QuotesClientRates = function({ services, clientRates, setClientRates, companies, contacts }) {
    var isMobile = window.LTP_useIsMobile();
    var [clientType, setClientType] = useState("company");
    var [companyId, setCompanyId]   = useState(null);
    var [contactId, setContactId]   = useState(null);

    var rows = clientRates || [];
    // Clients that already have negotiated rates, for the jump list. Counts
    // include paused rows (they're still something you'd come back to).
    var summary = (function() {
      var byKey = {};
      rows.forEach(function(r) {
        var isContact = r.clientType === "contact";
        var id = isContact ? r.clientContactId : r.companyId;
        if (id == null) return;
        var key = (isContact ? "c" : "co") + id;
        if (!byKey[key]) {
          var who = isContact
            ? (contacts || []).find(function(x) { return x.id === id; })
            : (companies || []).find(function(x) { return x.id === id; });
          byKey[key] = {
            key: key, isContact: isContact, id: id, count: 0, paused: 0,
            name: who ? (isContact ? ((who.firstName || "") + " " + (who.lastName || "")).trim() : who.name) : "Deleted client",
          };
        }
        byKey[key].count++;
        if (r.active === false) byKey[key].paused++;
      });
      return Object.keys(byKey).map(function(k) { return byKey[k]; })
        .sort(function(a, b) { return a.name.localeCompare(b.name); });
    })();

    var selectedId = clientType === "contact" ? contactId : companyId;
    var selected = selectedId == null ? null : (clientType === "contact"
      ? (contacts || []).find(function(c) { return c.id === selectedId; })
      : (companies || []).find(function(c) { return c.id === selectedId; }));
    var clientName = !selected ? "" : (clientType === "contact"
      ? ((selected.firstName || "") + " " + (selected.lastName || "")).trim()
      : selected.name);

    function jump(row) {
      if (row.isContact) { setClientType("contact"); setContactId(row.id); }
      else { setClientType("company"); setCompanyId(row.id); }
    }

    var tabBtn = function(on) {
      return { background: on ? B.accent : B.raised, color: on ? B.btnInk : B.textMut,
               border: "1px solid " + (on ? B.accent : B.border), borderRadius: "4px",
               padding: "5px 14px", fontSize: "11px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" };
    };

    return h("div", null,
      isMobile && h("h2", { style: { fontSize: "18px", fontWeight: 700, color: B.text, margin: "0 0 12px" } }, "Client Rates"),
      h("div", { style: { fontSize: "12px", color: B.textMut, lineHeight: 1.6, marginBottom: 14, maxWidth: 720 } },
        "Contract rates for one client, added a role at a time. A role listed here prices at the negotiated rate — and, when it carries a minimum, bills a short call as a full day — everywhere it's used: schedules, quotes, invoices, and payouts. Every role you don't list keeps the base rate card."),

      // ── Client picker ───────────────────────────────────────────────────────
      h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: 12, marginBottom: 16 } },
        h("div", { style: { display: "flex", gap: 6, marginBottom: 10 } },
          h("button", { onClick: function() { setClientType("company"); }, style: tabBtn(clientType === "company") }, "Company"),
          h("button", { onClick: function() { setClientType("contact"); }, style: tabBtn(clientType === "contact") }, "Individual")
        ),
        clientType === "company"
          ? h(window.CompanySearchField, { label: "Client", compId: companyId, setCompId: setCompanyId,
              companies: (companies || []).filter(function(c) { return c.isClient !== false; }),
              onClear: function() { setCompanyId(null); } })
          : h(window.ContactSearchField, { label: "Client", contactId: contactId, setContactId: setContactId,
              contacts: contacts || [], placeholder: "Search people…",
              onClear: function() { setContactId(null); } })
      ),

      // ── Editor for the selected client ──────────────────────────────────────
      selected
        ? h("div", { style: { marginBottom: 22 } },
            h("h4", { style: { fontSize: "13px", fontWeight: 700, color: B.textSec, margin: "0 0 10px", textTransform: "uppercase", letterSpacing: "0.06em" } },
              clientName),
            h(window.ClientRatesEditor, {
              clientType: clientType,
              companyId: clientType === "company" ? companyId : null,
              clientContactId: clientType === "contact" ? contactId : null,
              clientName: clientName,
              services: services, clientRates: clientRates, setClientRates: setClientRates }))
        : h("div", { style: { padding: "18px", textAlign: "center", color: B.textMut, fontSize: "12px", fontStyle: "italic", marginBottom: 22 } },
            "Pick a client to add or edit their negotiated rates."),

      // ── Everyone with negotiated rates ──────────────────────────────────────
      h("h4", { style: { fontSize: "13px", fontWeight: 700, color: B.textSec, margin: "0 0 10px", textTransform: "uppercase", letterSpacing: "0.06em" } },
        "Clients With Negotiated Rates (" + summary.length + ")"),
      h(window.LTPList, null,
        summary.length === 0 && h("div", { style: { padding: "18px", textAlign: "center", color: B.textMut, fontSize: "12px", fontStyle: "italic" } },
          "None yet — every client bills the base rate card."),
        summary.map(function(row) {
          return h(window.LTPRow, { key: row.key, onClick: function() { jump(row); },
            style: { display: "flex", alignItems: "center", gap: 10 } },
            h("div", { style: { flex: 1, minWidth: 0 } },
              h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text } }, row.name),
              h("div", { style: { fontSize: "10px", color: B.textMut } },
                (row.isContact ? "Individual" : "Company") + " · " + row.count + " role" + (row.count === 1 ? "" : "s")
                + (row.paused > 0 ? " · " + row.paused + " paused" : ""))),
            h("span", { style: { fontSize: "11px", color: B.accent } }, "Edit →"));
        })
      )
    );
  };
})();
