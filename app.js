// ── Outer auth gate ─────────────────────────────────────────────────────────
// Picks what to render based on the route AND window.LTP_AUTH_USER:
//   route.module === "view"  → public client view; render LTPClientView with
//                              NO auth gate (the share token is the credential)
//   authUser === undefined   → auth check in flight; show "Loading…"
//   authUser === null        → not signed in; show sign-in screen
//   authUser === {…}         → signed in; render LTPSignedInApp (the real app)
//
// The view-route check comes FIRST because the client doesn't have an LTP
// session — falling through to the sign-in screen would block them from
// seeing the quote they were invited to review. components/auth.js skips
// the /auth/me call for #view/ routes so authUser stays null indefinitely
// (which we'd otherwise treat as "show sign-in").
window.LTPApp = function() {
  var h = React.createElement;
  var B = window.LTP_THEME;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var route = window.LTPRouter.useRoute();

  // Public client view bypasses auth entirely. Token is the credential.
  if (route.module === "view") {
    return h(window.LTPClientView, { route: route });
  }

  // Public crew-request landing page — same deal: the token in #/crew/<token>
  // is the credential, no LTP session required (see modules/crew-view.js).
  if (route.module === "crew") {
    return h(window.LTPCrewView, { route: route });
  }

  // Re-render when auth.js publishes the result.
  var pair = useState(window.LTP_AUTH_USER);
  var authUser = pair[0], setAuthUser = pair[1];
  useEffect(function() {
    function onReady() { setAuthUser(window.LTP_AUTH_USER); }
    window.addEventListener("ltp-auth-ready", onReady);
    return function() { window.removeEventListener("ltp-auth-ready", onReady); };
  }, []);

  if (authUser === undefined) {
    return h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: B.bg, color: B.textMut, fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif", fontSize: "13px", letterSpacing: "0.05em" } }, "Loading…");
  }
  if (authUser === null) {
    return h(LTPSignInScreen);
  }
  return h(LTPSignedInApp, { authUser: authUser });
};


// ── Sign-in screen for unauthenticated users ────────────────────────────────
function LTPSignInScreen() {
  var h = React.createElement;
  var B = window.LTP_THEME;
  return h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: B.bg, fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif" } },
    h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "10px", padding: "40px 48px", maxWidth: 380, width: "90%", textAlign: "center", boxShadow: "0 8px 32px rgba(0,0,0,0.4)" } },
      h("div", { style: { width: 44, height: 44, background: B.accent, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px", fontWeight: 700, color: "#000", margin: "0 auto 18px" } }, "LTP"),
      h("div", { style: { fontSize: "18px", fontWeight: 700, color: B.text, marginBottom: 6 } }, "LTP Business Suite"),
      h("div", { style: { fontSize: "12px", color: B.textMut, marginBottom: 28, lineHeight: 1.5 } }, "Sign in with your Google account to continue."),
      h("a", { href: "/auth/login",
        style: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 10, background: "#fff", color: "#1f1f1f", border: "1px solid #dadce0", borderRadius: "6px", padding: "10px 24px", fontSize: "13px", fontWeight: 600, textDecoration: "none", fontFamily: "inherit", cursor: "pointer", minWidth: 220 } },
        // Inline Google "G" mark
        h("svg", { width: 18, height: 18, viewBox: "0 0 48 48" },
          h("path", { fill: "#4285F4", d: "M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" }),
          h("path", { fill: "#34A853", d: "M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z" }),
          h("path", { fill: "#FBBC05", d: "M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z" }),
          h("path", { fill: "#EA4335", d: "M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7C13.42 14.62 18.27 10.75 24 10.75z" })
        ),
        "Sign in with Google"
      )
    )
  );
}


// Main App Shell — owns all persistent state. Modules receive live state via props.
function LTPSignedInApp(props) {
  var B = window.LTP_THEME, MODULES = window.LTP_MODULES;
  var h = React.createElement, useState = React.useState, useEffect = React.useEffect, useRef = React.useRef;
  var nav = window.LTPRouter.navigate;
  var route = window.LTPRouter.useRoute();
  var activeModule = route.module;
  var usePersistentState = window.LTP_STATE.usePersistentState;

  var [sidebarOpen, setSidebarOpen] = useState(true);
  var [globalSearch, setGlobalSearch] = useState("");
  var [searchOpen, setSearchOpen] = useState(false);
  var [searchResults, setSearchResults] = useState([]);
  var [qboStatus, setQboStatus] = useState(null);
  var clockRef = useRef(null);
  var searchRef = useRef(null);

  // ── Persistent state (single source of truth for the entire app) ─────────────
  // Each hook returns [value, setValue, ready]. ready flips to true once the
  // initial API fetch resolves; we gate first render on all-ready below so
  // nothing tries to read/write data before the server responds.
  // CRM
  var [companies, setCompanies, companiesReady] = usePersistentState("companies", window.LTP_DATA_COMPANIES);
  var [contacts,  setContacts,  contactsReady]  = usePersistentState("contacts",  window.LTP_DATA_CONTACTS);
  var [projects,  setProjects,  projectsReady]  = usePersistentState("projects",  window.LTP_DATA_PROJECTS);
  // Rentals
  var [equipment,   setEquipment,   equipmentReady]   = usePersistentState("equipment",   window.LTP_DATA_EQUIPMENT);
  var [allocations, setAllocations, allocationsReady] = usePersistentState("allocations", window.LTP_DATA_ALLOCATIONS);
  var [containers,  setContainers,  containersReady]  = usePersistentState("containers",  window.LTP_DATA_CONTAINERS);
  var [kits,        setKits,        kitsReady]        = usePersistentState("kits",        window.LTP_DATA_KITS);
  // Quotes + catalogs
  var [quotes,   setQuotes,   quotesReady]   = usePersistentState("quotes",   window.LTP_DATA_QUOTES);
  var [products, setProducts, productsReady] = usePersistentState("products", window.LTP_DATA_PRODUCTS);
  var [services, setServices, servicesReady] = usePersistentState("services", window.LTP_DATA_SERVICES);
  // Invoices
  var [invoices, setInvoices, invoicesReady] = usePersistentState("invoices", window.LTP_DATA_INVOICES);
  // Settings
  var [settings, setSettings, settingsReady] = usePersistentState("settings", window.LTP_DATA_SETTINGS);

  var allReady = companiesReady && contactsReady && projectsReady
              && equipmentReady && allocationsReady && containersReady && kitsReady
              && quotesReady && productsReady && servicesReady
              && invoicesReady && settingsReady;

  var isAdmin = props.authUser.role === "admin";

  // Expose globals for activity logging and prints. LTP_CURRENT_USER feeds
  // every "user" field in activity entries (quotes-builder.js, invoices.js,
  // schedule-builder.js, labor.js, crm-notes.js). Backend overwrites the
  // value in _stamp_activity, but sending it locally keeps the optimistic UI
  // consistent until the next refresh.
  window.LTP_CURRENT_USER = props.authUser.name || props.authUser.email || "User";
  window.LTP_CURRENT_USER_ID = props.authUser.id;
  // Gmail-send capability flags from /auth/me. Used by the Send modals
  // (quotes-builder.js / invoices.js) to gate the Send button:
  //   gmailConnected=false → no refresh token on file (user never granted scope)
  //   gmailScope="none"    → consent didn't include gmail.send
  // Either case surfaces the "Reconnect Google" affordance + disables Send.
  window.LTP_GMAIL_CONNECTED = props.authUser.gmailConnected === true;
  window.LTP_GMAIL_SCOPE = props.authUser.gmailScope || "none";
  // Sender identity surfaced in the Send modal's read-only From: line
  // so the user knows exactly what the recipient will see as the From address.
  // Title + phone feed the {{userTitle}}/{{userPhone}} placeholders when
  // the Send modal renders a SAMPLE signature for preview (real-send
  // substitution happens server-side against the canonical User row).
  window.LTP_SENDER_EMAIL = props.authUser.email || "";
  window.LTP_SENDER_NAME = props.authUser.name || "";
  window.LTP_SENDER_TITLE = props.authUser.title || "";
  window.LTP_SENDER_PHONE = props.authUser.phone || "";
  // Google-hosted profile photo (lh*.googleusercontent.com) — feeds
  // {{userPhoto}} in the signature template, falling back to the LTP
  // logo when this is empty (rare for Google OAuth users).
  window.LTP_SENDER_PHOTO = props.authUser.pictureUrl || "";
  window.LTP_COMPANY_NAME = settings.companyName || "LTP";
  window.LTP_COMPANY_SHORT = settings.companyShort || "LTP";
  window.LTP_DEFAULT_TERMS = settings.defaultPaymentTerms || 30;
  window.LTP_DEFAULT_QUOTE_NOTES = settings.defaultQuoteNotes || "";
  window.LTP_DEFAULT_INVOICE_NOTES = settings.defaultInvoiceNotes || "";
  window.LTP_TAX_RATE = settings.taxRate || 0;

  // Rebuild tag/badge colors from settings
  window.LTP_TAG_COLORS = settings.tagColors || {};
  var tc = window.LTP_TAG_COLORS;
  var bfh = window.LTP_badgeFromHex;
  Object.keys(tc).forEach(function(key) {
    window.LTP_STATUS_COLORS[key] = bfh(tc[key]);
  });

  // Quote / Invoice ID counters — derived from max(entity.id) + 1, kept in a
  // ref so successive calls within the same render advance correctly. We
  // lose "monotonic across deletes" (a deleted highest-id can be reused);
  // acceptable for solo use, and the user already lost that on every DB reset.
  var counterRef = useRef(0);
  useEffect(function() {
    var maxId = (quotes || []).reduce(function(m, q) {
      return typeof q.id === "number" ? Math.max(m, q.id) : m;
    }, 0);
    if (counterRef.current <= maxId) counterRef.current = maxId + 1;
  }, [quotes]);
  function getNextQuoteId() {
    var id = counterRef.current;
    counterRef.current = id + 1;
    return id;
  }

  var invCounterRef = useRef(0);
  useEffect(function() {
    var maxInvId = (invoices || []).reduce(function(m, i) {
      return typeof i.id === "number" ? Math.max(m, i.id) : m;
    }, 0);
    if (invCounterRef.current <= maxInvId) invCounterRef.current = maxInvId + 1;
  }, [invoices]);
  function getNextInvoiceId() {
    var id = invCounterRef.current;
    invCounterRef.current = id + 1;
    return id;
  }

  useEffect(function() {
    function tick() {
      if (clockRef.current) {
        var now = new Date();
        clockRef.current.textContent = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) + " \u00b7 " + now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      }
    }
    tick();
    var t = setInterval(tick, 60000);
    return function() { clearInterval(t); };
  }, []);

  // QuickBooks Online connection status — drives the "Send to QuickBooks"
  // gate in the invoice builder and the Settings connect panel. Non-secret
  // (booleans + masked metadata); see backend/routes/qbo.py GET /api/qbo/status.
  useEffect(function() {
    fetch("/api/qbo/status", { credentials: "include" })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(s) { if (s) { setQboStatus(s); window.LTP_QBO_CONNECTED = s.connected === true; } })
      .catch(function() {});
  }, []);

  useEffect(function() {
    if (!searchOpen) return;
    function handler(e) { if (searchRef.current && !searchRef.current.contains(e.target)) { setSearchOpen(false); } }
    document.addEventListener("mousedown", handler);
    return function() { document.removeEventListener("mousedown", handler); };
  }, [searchOpen]);

  useEffect(function() {
    var q = globalSearch.trim().toLowerCase();
    if (!q) { setSearchResults([]); return; }
    var results = [];

    // findById / contactName come from components/helpers.js \u2014 prefer these
    // over inline list.find / string-concat patterns in new code.
    var findById    = window.LTP_HELPERS.findById;
    var contactName = window.LTP_HELPERS.contactName;

    companies.forEach(function(c) {
      if (c.name.toLowerCase().indexOf(q) !== -1 || (c.address || "").toLowerCase().indexOf(q) !== -1) {
        results.push({ type: "Company", label: c.name, sub: c.address || ((c.isClient ? "Client" : "") + (c.isVendor ? " Vendor" : "")).trim(), module: "crm",
          action: function(id) { return function() { nav("crm/companies/" + id); setSearchOpen(false); setGlobalSearch(""); }; }(c.id) });
      }
    });

    contacts.forEach(function(c) {
      var full = contactName(c).toLowerCase();
      // NOTE: this is a containment check (companyIds includes x.id), not an
      // id lookup \u2014 findById doesn't fit here. Leave as-is.
      var co = companies.find(function(x) { return c.companyIds && c.companyIds.includes(x.id); });
      var coName = co ? co.name.toLowerCase() : "";
      if (full.indexOf(q) !== -1 || (c.email || "").toLowerCase().indexOf(q) !== -1 || (c.phone || "").toLowerCase().indexOf(q) !== -1 || coName.indexOf(q) !== -1) {
        results.push({ type: "Contact", label: contactName(c), sub: c.role + (co ? " \u00b7 " + co.name : ""), module: "crm",
          action: function(id) { return function() { nav("crm/contacts/" + id); setSearchOpen(false); setGlobalSearch(""); }; }(c.id) });
      }
    });

    projects.forEach(function(p) {
      var co = findById(companies, p.companyId);
      if (p.name.toLowerCase().indexOf(q) !== -1 || (co && co.name.toLowerCase().indexOf(q) !== -1)) {
        results.push({ type: "Project", label: p.name, sub: (co ? co.name + " \u00b7 " : "") + p.category + " \u00b7 " + p.status, module: "projects",
          action: function(id) { return function() { nav("projects/" + id); setSearchOpen(false); setGlobalSearch(""); }; }(p.id) });
      }
    });

    // Quotes — uses live state so newly-created quotes are searchable
    quotes.forEach(function(qt) {
      var co      = findById(companies, qt.companyId);
      var proj    = findById(projects,  qt.projectId);
      var contact = findById(contacts,  qt.clientContactId);
      var clientName = (qt.clientType === "contact" || (!qt.companyId && contact))
        ? contactName(contact)
        : (co ? co.name : "");
      var name = proj ? proj.name : (qt.customName || "");
      var ref = window.LTP_QUOTE_REF ? window.LTP_QUOTE_REF(qt) : ("Q-" + qt.id);
      var hay = (ref + " " + clientName + " " + name).toLowerCase();
      if (hay.indexOf(q) !== -1) {
        results.push({ type: "Quote", label: ref, sub: (clientName ? clientName + " \u00b7 " : "") + name + " \u00b7 " + qt.status, module: "quotes",
          action: function(id) { return function() { nav("quotes/" + id); setSearchOpen(false); setGlobalSearch(""); }; }(qt.id) });
      }
    });

    // Equipment — live state, so user-added equipment is findable
    equipment.forEach(function(eq) {
      if (eq.name.toLowerCase().indexOf(q) !== -1 || eq.category.toLowerCase().indexOf(q) !== -1 || (eq.manufacturer || "").toLowerCase().indexOf(q) !== -1 || (eq.model || "").toLowerCase().indexOf(q) !== -1) {
        results.push({ type: "Equipment", label: eq.name, sub: eq.category + (eq.subcategory ? " \u00b7 " + eq.subcategory : "") + " \u00b7 $" + (eq.rates && eq.rates.threeDay ? eq.rates.threeDay : 0) + "/3-day", module: "rentals",
          action: function(id) { return function() { nav("rentals/equipment/" + id); setSearchOpen(false); setGlobalSearch(""); }; }(eq.id) });
      }
    });

    // Products — quote catalog sale items
    products.forEach(function(p) {
      if (p.name.toLowerCase().indexOf(q) !== -1 || (p.category || "").toLowerCase().indexOf(q) !== -1) {
        results.push({ type: "Product", label: p.name, sub: p.category + " \u00b7 $" + p.unitPrice + "/" + p.unit, module: "quotes",
          action: function() { nav("quotes/products"); setSearchOpen(false); setGlobalSearch(""); } });
      }
    });

    // Services — labor rate card
    services.forEach(function(s) {
      var hay = (s.role + " " + s.description + " " + s.department).toLowerCase();
      if (hay.indexOf(q) !== -1) {
        results.push({ type: "Service", label: s.role + " \u2014 " + s.description, sub: s.department + " \u00b7 $" + s.dayRate + "/day", module: "quotes",
          action: function() { nav("quotes/services"); setSearchOpen(false); setGlobalSearch(""); } });
      }
    });

    // Invoices
    (invoices || []).forEach(function(inv) {
      var ref = window.LTP_INVOICE_REF(inv);
      var comp = (findById(companies, inv.companyId) || {}).name || "";
      var proj = (findById(projects,  inv.projectId) || {}).name || "";
      var t = window.LTP_INVOICE_TOTALS(inv);
      if ((ref + " " + comp + " " + proj).toLowerCase().indexOf(q) !== -1) {
        results.push({ type: "Invoice", label: ref, sub: comp + " \u00b7 " + proj + " \u00b7 $" + Math.round(t.total).toLocaleString() + " \u00b7 " + window.LTP_displayStatus(inv), module: "invoices",
          action: function() { nav("invoices/" + inv.id); setSearchOpen(false); setGlobalSearch(""); } });
      }
    });

    // Crew members
    contacts.filter(function(c) { return c.isCrew; }).forEach(function(c) {
      var full = (contactName(c) + " " + (c.crewRoles || []).join(" ") + " " + (c.crewNotes || "")).toLowerCase();
      if (full.indexOf(q) !== -1) {
        results.push({ type: "Crew", label: contactName(c), sub: (c.crewRoles || []).join(", ") + " \u00b7 " + (c.crewStatus || "active"), module: "labor",
          action: function() { nav("labor/roster"); setSearchOpen(false); setGlobalSearch(""); } });
      }
    });

    setSearchResults(results.slice(0, 12));
  }, [globalSearch, companies, contacts, projects, quotes, equipment, products, services, invoices]);

  function renderModule() {
    switch (activeModule) {
      case "dashboard": return h(window.LTPErrorBoundary, { name: "Dashboard" }, h(window.DashboardView, { companies: companies, projects: projects, quotes: quotes, equipment: equipment, invoices: invoices, contacts: contacts, services: services, settings: settings }));
      case "crm":       return h(window.LTPErrorBoundary, { name: "CRM" }, h(window.CRMView,       { companies: companies, setCompanies: setCompanies, contacts: contacts, setContacts: setContacts, projects: projects, setProjects: setProjects, quotes: quotes, invoices: invoices, route: route, services: services }));
      case "projects":  return h(window.LTPErrorBoundary, { name: "Projects" }, h(window.ProjectsView,  { companies: companies, contacts: contacts, setContacts: setContacts, projects: projects, setProjects: setProjects, quotes: quotes, setQuotes: setQuotes, getNextQuoteId: getNextQuoteId, services: services, invoices: invoices, setInvoices: setInvoices, route: route }));
      case "calendar":  return h(window.LTPErrorBoundary, { name: "Calendar" }, h(window.CalendarView,  { projects: projects }));
      case "rentals":   return h(window.LTPErrorBoundary, { name: "Rentals" }, h(window.RentalsView,   {
        companies: companies, projects: projects, route: route,
        equipment: equipment,     setEquipment: setEquipment,
        allocations: allocations, setAllocations: setAllocations,
        containers: containers,   setContainers: setContainers,
        kits: kits,               setKits: setKits,
      }));
      case "quotes":    return h(window.LTPErrorBoundary, { name: "Quotes" }, h(window.QuotesView,    {
        companies: companies, contacts: contacts, projects: projects, setProjects: setProjects, route: route,
        quotes: quotes,     setQuotes: setQuotes,
        products: products, setProducts: setProducts,
        services: services, setServices: setServices,
        equipment: equipment, allocations: allocations,
        getNextQuoteId: getNextQuoteId,
        invoices: invoices, setInvoices: setInvoices,
        getNextInvoiceId: getNextInvoiceId,
        settings: settings,
      }));
      case "invoices":  return h(window.LTPErrorBoundary, { name: "Invoices" }, h(window.InvoicesView, {
        invoices: invoices, setInvoices: setInvoices, getNextInvoiceId: getNextInvoiceId,
        companies: companies, setCompanies: setCompanies, contacts: contacts, setContacts: setContacts, projects: projects,
        quotes: quotes, setQuotes: setQuotes, route: route,
        equipment: equipment, products: products, services: services, allocations: allocations,
        settings: settings, isAdmin: isAdmin, qbo: qboStatus,
      }));
      case "labor":     return h(window.LTPErrorBoundary, { name: "Labor" }, h(window.LaborView, {
        contacts: contacts, setContacts: setContacts,
        projects: projects, setProjects: setProjects,
        services: services, quotes: quotes, companies: companies, settings: settings, route: route,
      }));
      case "settings":
        if (!isAdmin) return h(LTPPermissionDenied, { what: "Settings" });
        return h(window.LTPErrorBoundary, { name: "Settings" }, h(window.SettingsView, { settings: settings, setSettings: setSettings }));
      default: nav("dashboard"); return null;
    }
  }

  var typeColors = { Company: B.accent, Contact: B.success, Project: B.info, Invoice: B.warn, Quote: B.warn, Equipment: B.textSec, Product: B.success, Service: B.info, Crew: B.info };

  // Detect when we're in the full-screen quote builder — hides topbar to maximize space
  var isQuoteBuilder = (route.module === "quotes" && (route.id !== null || route.action === "new"))
    || (route.module === "invoices" && (route.id !== null || route.action === "new"))
    || (route.module === "projects" && route.id !== null && route.action === "schedule");

  // Loading gate — block first render until every API fetch has resolved.
  // Hooks above always run; we only short-circuit the main render here.
  // Error toasts mount alongside in a Fragment so failures during hydration
  // (e.g. wrong API key) still surface immediately.
  if (!allReady) {
    return h(React.Fragment, null,
      h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: B.bg, color: B.textMut, fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif", fontSize: "13px", letterSpacing: "0.05em" } }, "Loading…"),
      h(window.LTPErrorToasts)
    );
  }

  return h(React.Fragment, null,
   h("div", { style: { display: "flex", height: "100vh", background: B.bg, fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif", color: B.text, overflow: "hidden" } },
    h("div", { style: { width: sidebarOpen ? 210 : 52, transition: "width 0.25s ease", background: B.surface, borderRight: "1px solid " + B.border, display: "flex", flexDirection: "column", overflow: "hidden", flexShrink: 0 } },
      h("div", { style: { padding: sidebarOpen ? "18px 16px" : "18px 10px", borderBottom: "1px solid " + B.border, display: "flex", alignItems: "center", gap: 10, cursor: "pointer", minHeight: 58 }, onClick: function() { setSidebarOpen(!sidebarOpen); } },
        h("div", { style: { width: 30, height: 30, background: B.accent, borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: 700, color: "#000", flexShrink: 0 } }, "LTP"),
        sidebarOpen && h("div", null, h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.text, lineHeight: 1.2 } }, settings.companyShort || "LTP"), h("div", { style: { fontSize: "9px", color: B.textMut, letterSpacing: "0.05em" } }, settings.tagline ? settings.tagline.toUpperCase().substring(0, 30) : "BUSINESS SUITE"))
      ),
      h("nav", { style: { flex: 1, padding: "10px 6px", display: "flex", flexDirection: "column", gap: 2, overflowY: "auto" } },
        MODULES.filter(function(m) {
          // Hide Settings link from non-admins — they can't load the module
          // either (renderModule short-circuits to permission-denied) so
          // having the nav item would be a dead end.
          return !(m.id === "settings" && !isAdmin);
        }).map(function(m) {
          var isActive = activeModule === m.id;
          var rows = [
            h("button", { key: m.id, onClick: function() { nav(m.id); },
              style: { display: "flex", alignItems: "center", gap: 10, padding: sidebarOpen ? "9px 11px" : "9px 0", justifyContent: sidebarOpen ? "flex-start" : "center", background: isActive ? B.raised : "transparent", border: "none", borderRadius: "6px", cursor: "pointer", borderLeft: isActive ? "2px solid " + B.accent : "2px solid transparent", width: "100%" } },
              h("span", { style: { width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 } },
                window.LTP_NAV_ICON(m.id, 18, isActive ? B.accent : B.textMut)),
              sidebarOpen && h("span", { style: { fontSize: "12px", fontWeight: isActive ? 600 : 400, color: isActive ? B.text : B.textSec, whiteSpace: "nowrap" } }, m.label))
          ];

          // CRM sub-nav
          if (sidebarOpen && m.id === "crm") {
            var crmSubs = [
              { path: "crm/companies", label: "Companies" },
              { path: "crm/contacts",  label: "Contacts"  },
            ];
            crmSubs.forEach(function(sub) {
              var subActive = route.module === "crm" && (route.sub === sub.path.split("/")[1] || (!route.sub && sub.path === "crm/companies"));
              rows.push(h("button", { key: "sub-" + sub.path, onClick: function() { nav(sub.path); },
                style: { display: "flex", alignItems: "center", gap: 10, padding: "6px 11px 6px 32px", background: subActive ? B.accent + "18" : "transparent", border: "none", borderRadius: "6px", cursor: "pointer", borderLeft: subActive ? "2px solid " + B.accent : "2px solid transparent", width: "100%", textAlign: "left" } },
                h("span", { style: { fontSize: "11px", fontWeight: subActive ? 600 : 400, color: subActive ? B.accent : B.textMut, whiteSpace: "nowrap" } }, sub.label)));
            });
          }

          // Rentals sub-nav
          if (sidebarOpen && m.id === "rentals") {
            var rentalSubs = [
              { path: "rentals", label: "Availability Checker" },
              { path: "rentals/equipment",  label: "Equipment List"       },
              { path: "rentals/containers", label: "Containers List"      },
              { path: "rentals/kits",       label: "Kits & Packages"      },
            ];
            rentalSubs.forEach(function(sub) {
              var subActive = sub.path === "rentals"
                ? (route.module === "rentals" && !route.sub)
                : sub.path === "rentals/equipment"
                  ? (route.module === "rentals" && route.sub === "equipment")
                  : sub.path === "rentals/containers"
                    ? (route.module === "rentals" && route.sub === "containers")
                    : (route.module === "rentals" && route.sub === "kits");
              rows.push(h("button", { key: "sub-" + sub.path, onClick: function() { nav(sub.path); },
                style: { display: "flex", alignItems: "center", gap: 10, padding: "6px 11px 6px 32px", background: subActive ? B.accent + "18" : "transparent", border: "none", borderRadius: "6px", cursor: "pointer", borderLeft: subActive ? "2px solid " + B.accent : "2px solid transparent", width: "100%", textAlign: "left" } },
                h("span", { style: { fontSize: "11px", fontWeight: subActive ? 600 : 400, color: subActive ? B.accent : B.textMut, whiteSpace: "nowrap" } }, sub.label)));
            });
          }

          // Quotes sub-nav
          if (sidebarOpen && m.id === "quotes") {
            var quotesSubs = [
              { path: "quotes", label: "Quotes"   },
              { path: "quotes/products", label: "Products" },
              { path: "quotes/services", label: "Services" },
            ];
            quotesSubs.forEach(function(sub) {
              var subActive = sub.path === "quotes"
                ? (route.module === "quotes" && (!route.sub || route.sub !== "products" && route.sub !== "services"))
                : sub.path === "quotes/products"
                  ? (route.module === "quotes" && route.sub === "products")
                  : (route.module === "quotes" && route.sub === "services");
              rows.push(h("button", { key: "sub-" + sub.path, onClick: function() { nav(sub.path); },
                style: { display: "flex", alignItems: "center", gap: 10, padding: "6px 11px 6px 32px", background: subActive ? B.accent + "18" : "transparent", border: "none", borderRadius: "6px", cursor: "pointer", borderLeft: subActive ? "2px solid " + B.accent : "2px solid transparent", width: "100%", textAlign: "left" } },
                h("span", { style: { fontSize: "11px", fontWeight: subActive ? 600 : 400, color: subActive ? B.accent : B.textMut, whiteSpace: "nowrap" } }, sub.label)));
            });
          }

          // Labor sub-nav
          if (sidebarOpen && m.id === "labor") {
            var laborSubs = [
              { path: "labor/assignments", label: "Assignments"    },
              { path: "labor/roster",      label: "Crew Roster"     },
              { path: "labor/calendar",    label: "Calendar"        },
              { path: "labor/schedule",    label: "Weekly Schedule" },
            ];
            laborSubs.forEach(function(sub) {
              var subKey = sub.path.split("/")[1];
              // Bare `labor` (no sub) defaults to Assignments — highlight it then too.
              var subActive = route.module === "labor" && (route.sub === subKey || (!route.sub && subKey === "assignments"));
              rows.push(h("button", { key: "sub-" + sub.path, onClick: function() { nav(sub.path); },
                style: { display: "flex", alignItems: "center", gap: 10, padding: "6px 11px 6px 32px", background: subActive ? B.accent + "18" : "transparent", border: "none", borderRadius: "6px", cursor: "pointer", borderLeft: subActive ? "2px solid " + B.accent : "2px solid transparent", width: "100%", textAlign: "left" } },
                h("span", { style: { fontSize: "11px", fontWeight: subActive ? 600 : 400, color: subActive ? B.accent : B.textMut, whiteSpace: "nowrap" } }, sub.label)));
            });
          }

          return rows;
        })
      ),
      sidebarOpen && h("div", { style: { padding: "12px 16px", borderTop: "1px solid " + B.border, fontSize: "9px", color: B.textMut } }, (settings.companyShort || "LTP") + " Business Suite v1.0")
    ),
    h("div", { style: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" } },
      // Topbar — hidden when in quote builder (builder has its own sticky header)
      isQuoteBuilder ? null :
      h("div", { style: { height: 52, borderBottom: "1px solid " + B.border, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 22px", background: B.surface, flexShrink: 0 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
          h("span", { style: { width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center" } },
            window.LTP_NAV_ICON(activeModule, 18, B.accent)),
          h("span", { style: { fontSize: "13px", fontWeight: 600, color: B.textSec } }, (MODULES.find(function(m) { return m.id === activeModule; }) || {}).label)),
        h("div", { ref: searchRef, style: { position: "relative", flex: 1, maxWidth: 720, margin: "0 24px" } },
          h("div", { style: { position: "relative" } },
            h("span", { style: { position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: "13px", color: B.textMut, pointerEvents: "none" } }, "\uD83D\uDD0D"),
            h("input", { type: "text", value: globalSearch, placeholder: "Search companies, contacts, projects, invoices\u2026",
              onChange: function(e) { setGlobalSearch(e.target.value); setSearchOpen(true); },
              onFocus: function() { if (globalSearch) setSearchOpen(true); },
              style: { width: "100%", background: B.raised, border: "1px solid " + (searchOpen && globalSearch ? B.accent : B.border), borderRadius: "6px", padding: "6px 12px 6px 30px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", transition: "border-color 0.15s" } })
          ),
          searchOpen && globalSearch && h("div", { style: { position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", boxShadow: "0 8px 24px rgba(0,0,0,0.4)", zIndex: 2000, overflow: "hidden", maxHeight: 400, overflowY: "auto" } },
            searchResults.length === 0
              ? h("div", { style: { padding: "14px 16px", fontSize: "12px", color: B.textMut, fontStyle: "italic" } }, "No results found.")
              : searchResults.map(function(r, i) {
                  var tc = typeColors[r.type] || B.textMut;
                  return h("div", { key: i, onClick: r.action, style: { display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", cursor: "pointer", borderBottom: i < searchResults.length - 1 ? "1px solid " + B.border : "none", transition: "background 0.1s" },
                    onMouseOver: function(e) { e.currentTarget.style.background = B.raised; },
                    onMouseOut:  function(e) { e.currentTarget.style.background = "transparent"; } },
                    h("span", { style: { fontSize: "9px", fontWeight: 700, color: tc, background: tc + "18", border: "1px solid " + tc + "44", padding: "2px 6px", borderRadius: "3px", textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" } }, r.type),
                    h("div", { style: { flex: 1, minWidth: 0 } },
                      h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, r.label),
                      h("div", { style: { fontSize: "11px", color: B.textMut, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, r.sub)),
                    h("span", { style: { fontSize: "10px", color: B.textMut } }, r.module)
                  );
                })
          )
        ),
        h("div", { style: { display: "flex", alignItems: "center", gap: 14 } },
          h("span", { ref: clockRef, style: { fontSize: "11px", color: B.textMut } }),
          h(LTPUserMenu, { user: props.authUser }))
      ),
      h("div", { style: { flex: 1, overflow: isQuoteBuilder ? "hidden" : "auto", padding: isQuoteBuilder ? "10px 16px 0" : "22px" } }, renderModule())
    )
   ),
   h(window.LTPErrorToasts)
  );
}


// ── User menu: avatar + dropdown with email + sign-out ─────────────────────
function LTPUserMenu(props) {
  var h = React.createElement;
  var useState = React.useState;
  var useRef = React.useRef;
  var useEffect = React.useEffect;
  var B = window.LTP_THEME;
  var user = props.user;

  var openPair = useState(false);
  var open = openPair[0], setOpen = openPair[1];
  var errPair = useState(false);
  var imgFailed = errPair[0], setImgFailed = errPair[1];
  var rootRef = useRef(null);

  // Close on outside click — same pattern as the search dropdown above.
  useEffect(function() {
    if (!open) return;
    function handler(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return function() { document.removeEventListener("mousedown", handler); };
  }, [open]);

  // Initials fallback when Google's picture URL 404s (they expire) or the
  // user has no picture set. Two-letter from name preferred, else email.
  var initials = "";
  if (user.name) {
    var parts = user.name.trim().split(/\s+/);
    initials = (parts[0] || "").charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : "");
  } else if (user.email) {
    initials = user.email.charAt(0);
  }
  initials = initials.toUpperCase() || "U";

  var avatarInner;
  if (user.pictureUrl && !imgFailed) {
    avatarInner = h("img", {
      src: user.pictureUrl,
      alt: "",
      referrerPolicy: "no-referrer",
      onError: function() { setImgFailed(true); },
      style: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
    });
  } else {
    avatarInner = h("span", { style: { fontSize: "10px", fontWeight: 700, color: "#000" } }, initials);
  }

  return h("div", { ref: rootRef, style: { position: "relative" } },
    h("button", {
      onClick: function() { setOpen(!open); },
      "aria-label": "User menu",
      style: { width: 28, height: 28, background: B.accent, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", border: "none", padding: 0, overflow: "hidden", cursor: "pointer" },
    }, avatarInner),
    open && h("div", {
      style: { position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 220, background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", boxShadow: "0 8px 24px rgba(0,0,0,0.4)", zIndex: 2500, fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif", overflow: "hidden" }
    },
      h("div", { style: { padding: "12px 14px", borderBottom: "1px solid " + B.border } },
        h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, user.name || "—"),
        h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, user.email),
        h("div", { style: { fontSize: "9px", color: B.textMut, marginTop: 6, textTransform: "uppercase", letterSpacing: "0.06em" } }, user.role)
      ),
      h("button", {
        onClick: function() { setOpen(false); window.LTP_AUTH.logout(); },
        style: { display: "block", width: "100%", background: "transparent", border: "none", padding: "10px 14px", textAlign: "left", fontSize: "12px", color: B.text, cursor: "pointer", fontFamily: "inherit" },
        onMouseOver: function(e) { e.currentTarget.style.background = B.raised; },
        onMouseOut:  function(e) { e.currentTarget.style.background = "transparent"; },
      }, "Sign out")
    )
  );
}


// ── Permission-denied inline card (used by renderModule for admin-gated modules) ─
function LTPPermissionDenied(props) {
  var h = React.createElement;
  var B = window.LTP_THEME;
  return h("div", { style: { background: (B.danger || "#e74c3c") + "08", border: "1px solid " + (B.danger || "#e74c3c") + "33", borderRadius: "8px", padding: "24px 28px", maxWidth: 520, margin: "20px auto" } },
    h("div", { style: { display: "flex", alignItems: "center", gap: 12, marginBottom: 8 } },
      h("div", { style: { width: 28, height: 28, borderRadius: "50%", background: (B.danger || "#e74c3c") + "22", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 } },
        h("span", { style: { fontSize: "14px", fontWeight: 700, color: B.danger || "#e74c3c" } }, "!")),
      h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.text || "#fff" } }, (props.what || "This area") + " is admin-only")),
    h("div", { style: { fontSize: "11px", color: B.textMut || "#888", lineHeight: 1.5, paddingLeft: 40 } }, "Your account doesn't have permission to access this. Ask an admin to promote your role if you need access.")
  );
}
