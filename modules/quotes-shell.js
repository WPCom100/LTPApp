// Quotes Shell — URL routing only. All persistent state lives in app.js and
// flows in via props. This module owns no data.
//
// URL schema:
//   #/quotes                list of all quotes
//   #/quotes/new            full-screen builder for new quote
//   #/quotes/:id            full-screen builder for existing quote
//   #/quotes/products       products management tab
//   #/quotes/services       services management tab
//   #/quotes/fees           fees management tab (misc billable line items)
//   #/quotes/client-rates   per-client service rate overrides (contract rates)
(function() {
  var h = React.createElement;
  var B = window.LTP_THEME;
  var nav = window.LTPRouter.navigate;

  window.QuotesView = function({ companies, contacts, projects, setProjects, route,
                                  quotes, setQuotes, products, setProducts, services, setServices,
                                  fees, setFees, clientRates, setClientRates,
                                  equipment, allocations, getNextQuoteId, invoices, setInvoices, getNextInvoiceId, settings, setSettings, isAdmin, qbo }) {
    var isMobile = window.LTP_useIsMobile();

    // ── Route-derived state ────────────────────────────────────────────────────
    var sub    = route.sub;
    var id     = route.id;
    var action = route.action;

    // Determine active tab for header nav
    var activeTab =
      sub === "products" ? "products" :
      sub === "services" ? "services" :
      sub === "fees"     ? "fees"     :
      sub === "client-rates" ? "client-rates" :
      "quotes";

    // Determine if we're in the builder
    var isBuilder = (activeTab === "quotes" && (id !== null || action === "new"));
    var editingQuoteId = (activeTab === "quotes" && id !== null) ? id : null;
    var isNewQuote     = (activeTab === "quotes" && !id && action === "new");

    // ── Tab header (shown on list, products, services — NOT on builder) ───────
    function TabHeader() {
      var tabs = [
        { key: "quotes",   label: "Quotes",   path: "quotes"          },
        { key: "products", label: "Products", path: "quotes/products" },
        { key: "services", label: "Services", path: "quotes/services" },
        { key: "fees",     label: "Fees",     path: "quotes/fees"     },
        { key: "client-rates", label: "Client Rates", path: "quotes/client-rates" },
      ];
      return h("div", { style: { display: "flex", gap: 0, borderBottom: "1px solid " + B.border, marginBottom: 18 } },
        tabs.map(function(t) {
          var active = activeTab === t.key;
          return h("button", { key: t.key, onClick: function() { nav(t.path); },
            style: { background: "transparent", border: "none", borderBottom: active ? "2px solid " + B.accent : "2px solid transparent",
                     padding: "8px 16px", fontSize: "12px", fontWeight: active ? 700 : 500,
                     color: active ? B.accent : B.textMut, cursor: "pointer", transition: "all 0.15s" }
          }, t.label);
        })
      );
    }

    // ── Render ─────────────────────────────────────────────────────────────────
    if (isBuilder) {
      // Full-screen builder — no tab header, no outer page title
      return h(window.QuotesBuilder, {
        quoteId:    editingQuoteId,
        isNew:      isNewQuote,
        quotes:     quotes,     setQuotes: setQuotes,
        getNextQuoteId: getNextQuoteId,
        products:   products,
        services:   services,
        clientRates: clientRates,
        fees:       fees,
        equipment:  equipment,
        allocations: allocations,
        companies:  companies,
        contacts:   contacts,
        projects:   projects,   setProjects: setProjects,
        invoices:   invoices,   setInvoices: setInvoices,
        getNextInvoiceId: getNextInvoiceId,
        settings:   settings,
        isAdmin:    isAdmin,    qbo: qbo,
      });
    }

    return h("div", null,
      // On mobile the page title + Products/Services tabs are dropped — the top
      // bar already reads "QUOTES", Products/Services are reached via the More
      // nav, and each list renders its own title + search row.
      !isMobile && h("h2", { style: { fontSize: "20px", fontWeight: 700, color: B.text, margin: "0 0 16px" } }, "Quotes"),
      !isMobile && h(TabHeader, null),

      activeTab === "quotes"   && h(window.QuotesList, {
        quotes: quotes, setQuotes: setQuotes,
        companies: companies, contacts: contacts, projects: projects,
      }),

      activeTab === "products" && h(window.QuotesProducts, {
        products: products, setProducts: setProducts, quotes: quotes,
        settings: settings, qbo: qbo,
      }),

      activeTab === "services" && h(window.QuotesServices, {
        services: services, setServices: setServices, projects: projects, quotes: quotes,
        clientRates: clientRates, companies: companies, contacts: contacts,
        settings: settings, qbo: qbo,
      }),

      activeTab === "fees" && h(window.QuotesFees, {
        fees: fees, setFees: setFees, quotes: quotes, invoices: invoices,
        settings: settings, setSettings: setSettings, isAdmin: isAdmin, qbo: qbo,
      }),

      activeTab === "client-rates" && h(window.QuotesClientRates, {
        services: services, clientRates: clientRates, setClientRates: setClientRates,
        companies: companies, contacts: contacts,
      })
    );
  };
})();
