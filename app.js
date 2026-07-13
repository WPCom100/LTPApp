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
    return h(window.LTPLoadingScreen, { label: "Loading…" });
  }
  if (authUser === null) {
    return h(LTPSignInScreen);
  }
  return h(LTPSignedInApp, { authUser: authUser });
};


// ── Sign-in screen for unauthenticated users ────────────────────────────────
// Masthead lockup on its orange rule — the same hero treatment as the
// customer-facing crew/client pages, with the LTP-chip fallback if the
// image fails to load.
function LTPSignInScreen() {
  var h = React.createElement;
  var B = window.LTP_THEME;
  var pair = React.useState(false);
  var logoFailed = pair[0], setLogoFailed = pair[1];
  return h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: "100dvh", background: B.bg, fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif", padding: "env(safe-area-inset-top) 16px env(safe-area-inset-bottom)" } },
    h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "16px", padding: "40px 48px", maxWidth: 400, width: "90%", textAlign: "center", boxShadow: "0 24px 64px rgba(0,0,0,0.45)" } },
      h("div", { style: { marginBottom: 24 } },
        logoFailed
          ? h("div", { style: { width: 44, height: 44, background: B.gradBtn, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px", fontWeight: 700, color: B.btnInk, margin: "0 auto" } }, "LTP")
          : h("img", { src: "/assets/logos/luminary-masthead.png", alt: "Luminary Technology & Productions", onError: function() { setLogoFailed(true); }, style: { display: "block", width: "100%", maxWidth: 260, height: "auto", margin: "0 auto" } }),
        h("div", { style: { height: 3, background: B.gradRule, maxWidth: 260, margin: "0 auto", marginTop: -1, borderRadius: 1 } })),
      h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase", color: B.accentSoft, marginBottom: 10 } }, "Business Suite"),
      h("div", { style: { fontSize: "18px", fontWeight: 700, color: B.text, marginBottom: 6, letterSpacing: "-0.01em" } }, "Welcome back"),
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
  // Mobile shell: below 600px the desktop sidebar is replaced by a bottom tab
  // bar (window.LTP_useIsMobile matches the index.html CSS breakpoint). moreOpen
  // drives the "More" sheet that reaches the overflow modules + every sub-nav.
  var isMobile = window.LTP_useIsMobile();
  var [moreOpen, setMoreOpen] = useState(false);
  var [createOpen, setCreateOpen] = useState(false);
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
      .then(function(s) { if (s) { setQboStatus(s); } })
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
        settings: settings, isAdmin: isAdmin, qbo: qboStatus,
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
      h(window.LTPLoadingScreen, { label: "Loading your workspace…" }),
      h(window.LTPErrorToasts)
    );
  }

  return h(React.Fragment, null,
   // Shell frame. Desktop = a row (sidebar | content). Mobile = a column
   // (content | bottom tab bar) so the tab bar is an in-flow row at the bottom
   // of the real 100dvh box rather than a position:fixed element (see below).
   h("div", { style: { display: "flex", flexDirection: isMobile ? "column" : "row", height: "100%", background: B.bg, fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif", color: B.text, overflow: "hidden" } },
    !isMobile && h("div", { style: { width: sidebarOpen ? 210 : 52, transition: "width 0.25s ease", background: B.surface, borderRight: "1px solid " + B.border, display: "flex", flexDirection: "column", overflow: "hidden", flexShrink: 0 } },
      h("div", { style: { padding: sidebarOpen ? "18px 16px" : "18px 10px", borderBottom: "1px solid " + B.border, display: "flex", alignItems: "center", gap: 10, cursor: "pointer", minHeight: 58 }, onClick: function() { setSidebarOpen(!sidebarOpen); } },
        h("div", { style: { width: 30, height: 30, background: B.gradBtn, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: 700, color: B.btnInk, flexShrink: 0, boxShadow: "0 2px 10px rgba(239,88,34,0.25)" } }, "LTP"),
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
              { path: "labor/requests",    label: "Crew Requests"   },
              { path: "labor/roster",      label: "Crew Roster"     },
              { path: "labor/calendar",    label: "Calendar"        },
              { path: "labor/schedule",    label: "Weekly Schedule" },
              { path: "labor/payouts",     label: "Payouts"         },
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
      // On mobile the topbar extends under the translucent status bar via
      // env(safe-area-inset-top) (height auto so the inset adds to the 52px bar
      // rather than eating into it), with tighter horizontal padding.
      h("div", { style: { height: isMobile ? "auto" : 52, minHeight: 52, borderBottom: "1px solid " + B.border, display: "flex", alignItems: "center", justifyContent: "space-between", padding: isMobile ? "env(safe-area-inset-top) 12px 4px" : "0 22px", background: B.surface, flexShrink: 0 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
          h("span", { style: { width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center" } },
            window.LTP_NAV_ICON(activeModule, 18, B.accent)),
          h("span", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: B.textSec } }, (MODULES.find(function(m) { return m.id === activeModule; }) || {}).label)),
        h("div", { ref: searchRef, style: { position: "relative", flex: 1, maxWidth: 720, margin: isMobile ? "0 8px" : "0 24px" } },
          h("div", { style: { position: "relative" } },
            h("input", { type: "text", value: globalSearch, placeholder: "Search companies, contacts, projects, invoices\u2026",
              onChange: function(e) { setGlobalSearch(e.target.value); setSearchOpen(true); },
              onFocus: function() { if (globalSearch) setSearchOpen(true); },
              style: { width: "100%", background: B.bg, border: "1px solid " + (searchOpen && globalSearch ? B.accent : B.border), borderRadius: "8px", padding: "6px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", transition: "border-color 0.15s" } })
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
          !isMobile && h("span", { ref: clockRef, style: { fontSize: "11px", color: B.textMut } }),
          h(LTPUserMenu, { user: props.authUser }))
      ),
      // The quote builder manages its own internal scroll (overflow:hidden);
      // it needs a real bottom padding here so the last card (Totals) clears
      // the viewport edge. Padding on this wrapper (not the inner scroll
      // columns) works in every engine — WebKit ignores padding-bottom on a
      // scrolling flex container, so the inner-column approach fails in Safari.
      // The mobile tab bar is a sibling flex row below (not overlaying), so no
      // extra bottom clearance is needed here for it.
      h("div", { style: { flex: 1, overflow: isQuoteBuilder ? "hidden" : "auto", padding: isQuoteBuilder ? "10px 16px 16px" : (isMobile ? "14px 14px 16px" : "22px") } }, renderModule())
    ),
    // Mobile bottom tab bar — an in-flow row at the bottom of the shell COLUMN,
    // deliberately NOT position:fixed. A fixed bottom:0 bar in an iOS standalone
    // PWA anchors to the layout viewport, which can sit above the physical
    // screen bottom and leave a large dead gap beneath the bar; as a flex child
    // it's pinned to the real 100dvh shell box. Hidden in the full-screen
    // builders (they own the whole screen and provide their own Back control).
    isMobile && !isQuoteBuilder && h(LTPBottomNav, { activeModule: activeModule, isAdmin: isAdmin, nav: nav, onMore: function() { setMoreOpen(true); }, onCreate: function() { setCreateOpen(true); } })
   ),
   isMobile && moreOpen && h(LTPMoreSheet, { route: route, isAdmin: isAdmin, nav: nav, onClose: function() { setMoreOpen(false); } }),
   isMobile && createOpen && h(LTPCreateSheet, { nav: nav, onClose: function() { setCreateOpen(false); } }),
   h(window.LTPErrorToasts),
   h(window.LTPCrewOutbox)
  );
}


// ── Mobile bottom tab bar ────────────────────────────────────────────────────
// Reuses window.LTP_MODULES + window.LTP_NAV_ICON (the same source as the
// desktop sidebar) so nav stays in one place. Four primary tabs plus "More",
// which opens LTPMoreSheet for every other module and all sub-navigation.
// Each entry is { id, label? } — label overrides the module's own label for
// the tab (e.g. Calendar shows as "Schedule"; Rentals opens its Availability
// Checker default sub). Anything not here lives behind "More".
// Schedule/Calendar lives in the More sheet (window.LTP_MODULES has it) so the
// bottom nav can stay four tabs — two either side of the centre create button.
var LTP_PRIMARY_TABS = [
  { id: "projects" },
  { id: "quotes" },
  { id: "rentals" },
];
// Sub-navigation per module (mirrors the sidebar's inline lists), centralized
// here so the More sheet can reach every sub-view the sidebar exposes.
var LTP_MODULE_SUBS = {
  crm: [
    { path: "crm/companies", label: "Companies" },
    { path: "crm/contacts",  label: "Contacts"  },
  ],
  rentals: [
    { path: "rentals",            label: "Availability Checker" },
    { path: "rentals/equipment",  label: "Equipment List"       },
    { path: "rentals/containers", label: "Containers List"      },
    { path: "rentals/kits",       label: "Kits & Packages"      },
  ],
  quotes: [
    { path: "quotes",          label: "Quotes"   },
    { path: "quotes/products", label: "Products" },
    { path: "quotes/services", label: "Services" },
  ],
  labor: [
    { path: "labor/assignments", label: "Assignments"     },
    { path: "labor/requests",    label: "Crew Requests"   },
    { path: "labor/roster",      label: "Crew Roster"     },
    { path: "labor/calendar",    label: "Calendar"        },
    { path: "labor/schedule",    label: "Weekly Schedule" },
    { path: "labor/payouts",     label: "Payouts"         },
  ],
};

function LTPBottomNav(props) {
  var h = React.createElement;
  var B = window.LTP_THEME, MODULES = window.LTP_MODULES;
  var active = props.activeModule;
  var moreActive = !LTP_PRIMARY_TABS.some(function(t) { return t.id === active; });  // in an overflow module

  function tab(id, label, onClick, isActive, iconEl) {
    return h("button", { key: id, onClick: onClick,
      style: { flex: 1, minWidth: 0, minHeight: 48, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, background: "transparent", border: "none", cursor: "pointer", padding: "4px 2px", fontFamily: "inherit" } },
      h("span", { style: { width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center" } }, iconEl),
      h("span", { style: { fontSize: "10px", fontWeight: isActive ? 700 : 500, letterSpacing: "0.02em", color: isActive ? B.accent : B.textMut, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" } }, label));
  }

  var tabs = LTP_PRIMARY_TABS.map(function(t) {
    var m = MODULES.find(function(x) { return x.id === t.id; }) || { id: t.id, label: t.id };
    var isActive = active === t.id;
    return tab(t.id, t.label || m.label, function() { props.nav(t.id); },
      isActive, window.LTP_NAV_ICON(t.id, 20, isActive ? B.accent : B.textMut));
  });
  // "More" — a hamburger-style trio, tinted active when in an overflow module.
  tabs.push(tab("more", "More", props.onMore, moreActive,
    h("svg", { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none" },
      [4, 12, 20].map(function(cx) {
        return h("circle", { key: cx, cx: cx, cy: 12, r: 2, fill: moreActive ? B.accent : B.textMut });
      }))));

  // Center create button — a raised orange "+" (same look as the list FABs)
  // that opens the create sheet (new Project / Quote / Invoice). Spliced into
  // the middle of the row so it reads as the primary "add" affordance; the
  // negative margin lifts the circle above the bar's top edge.
  var createBtn = h("button", { key: "create", onClick: props.onCreate, "aria-label": "Create new", className: "ltp-tap",
    style: { flex: "0 0 auto", position: "relative", zIndex: 2, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", cursor: "pointer", padding: "0 10px", fontFamily: "inherit" } },
    h("span", { style: { width: 48, height: 48, borderRadius: "50%", background: B.gradBtn || B.accent, color: B.btnInk, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "29px", fontWeight: 400, lineHeight: 1, marginTop: -14, boxShadow: "0 4px 14px rgba(239,88,34,0.45)" } }, "+"));
  tabs.splice(2, 0, createBtn);

  // In-flow flex row (flexShrink:0) pinned to the bottom of the shell column by
  // the parent's flex layout — NOT position:fixed (see the shell comment). The
  // safe-area-bottom padding keeps the labels above the home indicator.
  return h("nav", { className: "ltp-bottom-nav",
    // Trim the bottom padding: the full home-indicator inset (~34px on modern
    // iPhones) left too much blank space under the labels. Subtract ~14px but
    // keep an 8px floor so the labels still clear the home indicator (and stay
    // padded on devices with no inset).
    // position:relative + a stacking context above page content (but below
    // modals/sheets at 1000+) so the raised "+" circle, which overflows above
    // the bar via negative margin, never paints behind a positioned card/FAB.
    style: { flexShrink: 0, position: "relative", zIndex: 900, display: "flex", background: B.surface, borderTop: "1px solid " + B.border, paddingBottom: "max(8px, calc(env(safe-area-inset-bottom) - 14px))", boxShadow: "0 -2px 12px rgba(0,0,0,0.25)" } },
    tabs);
}

// ── Mobile "More" sheet ──────────────────────────────────────────────────────
// A bottom sheet listing every module (with icon) and its sub-navigation, so a
// phone user with no sidebar can still reach any section/sub-section. Mirrors
// the sidebar content; tapping navigates and closes.
function LTPMoreSheet(props) {
  var h = React.createElement;
  var B = window.LTP_THEME, MODULES = window.LTP_MODULES;
  var route = props.route;
  function go(path) { props.nav(path); props.onClose(); }

  var items = MODULES.filter(function(m) {
    return !(m.id === "settings" && !props.isAdmin);
  }).map(function(m) {
    var isActive = route.module === m.id;
    var subs = LTP_MODULE_SUBS[m.id] || [];
    var rows = [
      h("button", { key: m.id, onClick: function() { go(m.id); }, className: "ltp-tap",
        style: { display: "flex", alignItems: "center", gap: 12, width: "100%", minHeight: 48, padding: "10px 8px", background: "transparent", border: "none", borderRadius: "8px", cursor: "pointer", textAlign: "left" } },
        h("span", { style: { width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 } },
          window.LTP_NAV_ICON(m.id, 20, isActive ? B.accent : B.textSec)),
        h("span", { style: { fontSize: "15px", fontWeight: isActive ? 700 : 500, color: isActive ? B.text : B.textSec } }, m.label)),
    ];
    subs.forEach(function(sub) {
      rows.push(h("button", { key: sub.path, onClick: function() { go(sub.path); }, className: "ltp-tap",
        style: { display: "flex", alignItems: "center", width: "100%", minHeight: 44, padding: "8px 8px 8px 46px", background: "transparent", border: "none", borderRadius: "8px", cursor: "pointer", textAlign: "left" } },
        h("span", { style: { fontSize: "14px", color: B.textMut } }, sub.label)));
    });
    return h("div", { key: "grp-" + m.id, style: { borderBottom: "1px solid " + B.border, paddingBottom: 4, marginBottom: 4 } }, rows);
  });

  return h("div", { className: "ltp-modal-backdrop",
    onClick: props.onClose,
    style: { position: "fixed", inset: 0, background: "rgba(15,21,25,0.72)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 1500 } },
    h("div", { onClick: function(e) { e.stopPropagation(); },
      style: { background: B.surface, borderTop: "1px solid " + B.border, borderTopLeftRadius: 16, borderTopRightRadius: 16, width: "100%", maxHeight: "80dvh", overflowY: "auto", padding: "8px 14px calc(16px + env(safe-area-inset-bottom))", boxShadow: "0 -12px 40px rgba(0,0,0,0.5)" } },
      h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 4px 12px" } },
        h("div", { style: { fontSize: "12px", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: B.textMut } }, "Menu"),
        h("button", { onClick: props.onClose, "aria-label": "Close", className: "ltp-tap",
          style: { minWidth: 44, minHeight: 44, background: "transparent", border: "none", color: B.textMut, fontSize: "18px", cursor: "pointer", fontFamily: "inherit" } }, "✕")),
      items));
}


// ── Mobile "Create" sheet ────────────────────────────────────────────────────
// Opened by the raised center "+" in the bottom nav. A short bottom sheet with
// the three things a field user most often creates. Tapping navigates to that
// builder's "new" route and closes.
function LTPCreateSheet(props) {
  var h = React.createElement;
  var B = window.LTP_THEME;
  function go(path) { props.nav(path); props.onClose(); }

  var options = [
    { path: "projects/new",      module: "projects", label: "New Project",  sub: "Start a project and its schedule" },
    { path: "quotes/new",        module: "quotes",   label: "New Quote",    sub: "Build a quote from scratch" },
    { path: "invoices/new",      module: "invoices", label: "New Invoice",  sub: "Bill a client directly" },
    { path: "crm/companies/new", module: "crm",      label: "New Company",  sub: "Add a client or vendor" },
    { path: "crm/contacts/new",  module: "crm",      label: "New Contact",  sub: "Add a person or crew member" },
  ];

  return h("div", { className: "ltp-modal-backdrop",
    onClick: props.onClose,
    style: { position: "fixed", inset: 0, background: "rgba(15,21,25,0.72)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 1500 } },
    h("div", { onClick: function(e) { e.stopPropagation(); },
      style: { background: B.surface, borderTop: "1px solid " + B.border, borderTopLeftRadius: 16, borderTopRightRadius: 16, width: "100%", maxHeight: "80dvh", overflowY: "auto", padding: "8px 14px calc(16px + env(safe-area-inset-bottom))", boxShadow: "0 -12px 40px rgba(0,0,0,0.5)" } },
      h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 4px 12px" } },
        h("div", { style: { fontSize: "12px", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: B.textMut } }, "Create"),
        h("button", { onClick: props.onClose, "aria-label": "Close", className: "ltp-tap",
          style: { minWidth: 44, minHeight: 44, background: "transparent", border: "none", color: B.textMut, fontSize: "18px", cursor: "pointer", fontFamily: "inherit" } }, "✕")),
      options.map(function(o) {
        return h("button", { key: o.path, onClick: function() { go(o.path); }, className: "ltp-tap",
          style: { display: "flex", alignItems: "center", gap: 14, width: "100%", minHeight: 56, padding: "10px 8px", background: "transparent", border: "none", borderRadius: "8px", cursor: "pointer", textAlign: "left" } },
          h("span", { style: { width: 40, height: 40, borderRadius: "10px", background: B.accent + "18", border: "1px solid " + B.accent + "44", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 } },
            window.LTP_NAV_ICON(o.module, 20, B.accent)),
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { style: { fontSize: "15px", fontWeight: 700, color: B.text } }, o.label),
            h("div", { style: { fontSize: "12px", color: B.textMut } }, o.sub)),
          h("span", { style: { fontSize: "18px", color: B.textMut } }, "›"));
      })));
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
    avatarInner = h("span", { style: { fontSize: "10px", fontWeight: 700, color: B.btnInk } }, initials);
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
