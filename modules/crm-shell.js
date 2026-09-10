// CRM Shell — Companies + Contacts only (Projects → /projects, Calendar → /calendar)
window.CRMView = function CRMView({ companies, setCompanies, contacts, setContacts, projects, setProjects, quotes, invoices, route, services, clientRates, setClientRates }) {
  var B = window.LTP_THEME;
  var h = React.createElement, useState = React.useState, fmt = window.LTP_formatDate;
  var nav = window.LTPRouter.navigate;
  var isMobile = window.LTP_useIsMobile();

  // URL-derived state — all shapes:
  //   crm/companies            list
  //   crm/companies/new        add form
  //   crm/companies/:id        detail
  //   crm/companies/:id/edit   edit form
  //   crm/contacts             list
  //   crm/contacts/new         add form
  //   crm/contacts/:id         contact detail
  var urlSub    = route.sub    || "companies";
  var urlId     = route.id     || null;
  var urlAction = route.action || null;

  var crmTab            = urlSub === "contacts" ? "contacts" : "companies";
  var selectedCompanyId = (urlSub === "companies" && urlId && !urlAction)       ? urlId : null;
  var editCompanyId     = (urlSub === "companies" && urlId && urlAction === "edit") ? urlId : null;
  var showAddCompany    = (urlSub === "companies" && !urlId && urlAction === "new");
  var editContactId     = (urlSub === "contacts"  && urlId)                        ? urlId : null;
  var showAddContact    = (urlSub === "contacts"  && !urlId && urlAction === "new");

  function setSelectedCompanyId(id) { id ? nav("crm/companies/" + id) : nav("crm/companies"); }
  function setEditContactId(id)     { id ? nav("crm/contacts/"  + id) : nav("crm/contacts"); }

  // Transient UI state (not worth URL-encoding)
  var [companyFilter,  setCompanyFilter]  = useState("all");
  var [typeFilter,     setTypeFilter]     = useState("all");
  var [searchQuery,    setSearchQuery]    = useState("");
  // A sort per tab — { key, dir } naming a column in COMPANY_COLS / CONTACT_COLS
  // below. The two tabs share no columns, so they cannot share a sort: ordering
  // companies by project count says nothing about how to order contacts.
  var [compSort,       setCompSort]       = useState({ key: "name", dir: "asc" });
  var [contSort,       setContSort]       = useState({ key: "name", dir: "asc" });
  var [deleteConfirm,  setDeleteConfirm]  = useState(null);
  var [deleteWizard,   setDeleteWizard]   = useState(null);

  var selectedCompany = selectedCompanyId ? companies.find(function(c) { return c.id === selectedCompanyId; }) : null;

  // ctx for CRMCompanyDetail/Form + CRMContactDetail/Form. Keep in sync with
  // the ctx.* references in modules/crm-companies.js and modules/crm-contacts.js.
  var ctx = {
    companies: companies, setCompanies: setCompanies,
    contacts:  contacts,  setContacts:  setContacts,
    projects:  projects,  services: services || [],
    quotes: quotes || [],
    // Per-client negotiated service rates — edited from the company detail
    // (CRMCompanyDetail) and read by every pricing surface via
    // theme.js::LTP_servicesForClient.
    clientRates: clientRates || [], setClientRates: setClientRates,
    selectedCompany: selectedCompany,
    setSelectedCompanyId: setSelectedCompanyId,
    setEditCompanyId: function(id) {
      id ? nav("crm/companies/" + id + "/edit") : nav("crm/companies/" + (selectedCompanyId || ""));
    },
    editContactId: editContactId,
    setEditContactId: setEditContactId,
    contactAction: urlAction,
    setSelectedProjectId: function(id) { id ? nav("projects/" + id) : nav("projects"); },
    setDeleteConfirm: setDeleteConfirm,
  };

  function compTypeBadges(c) {
    var b = [];
    if (c.isClient) b.push(h(window.Badge, { key: "cl", status: "client" }));
    if (c.isVendor) b.push(h(window.Badge, { key: "vn", status: "vendor" }));
    return b;
  }

  function handleDelete(dc) {
    if (dc.type === "company") {
      var compProjects = (projects || []).filter(function(p) { return p.companyId === dc.id; });
      var compQuotes = (quotes || []).filter(function(q) { return q.companyId === dc.id; });
      var compInvoices = (invoices || []).filter(function(i) { return i.companyId === dc.id; });
      var compContacts = (contacts || []).filter(function(c) { return (c.companyIds || []).includes(dc.id); });
      if (compProjects.length > 0 || compQuotes.length > 0 || compInvoices.length > 0 || compContacts.length > 0) {
        setDeleteConfirm(null);
        setDeleteWizard({ type: "company", id: dc.id, name: dc.name,
          projects: compProjects, compQuotes: compQuotes, compInvoices: compInvoices, compContacts: compContacts,
          projectsDone: false, quotesDone: false, invoicesDone: false, contactsDone: false });
        return;
      }
      setCompanies(function(p) { return p.filter(function(c) { return c.id !== dc.id; }); });
      if (selectedCompanyId === dc.id) nav("crm/companies");
    } else if (dc.type === "contact") {
      var ct = contacts.find(function(c) { return c.id === dc.id; });
      var crewPositions = [];
      if (ct && ct.isCrew) {
        (projects || []).forEach(function(p) {
          (p.schedule || []).forEach(function(s) {
            (s.positions || []).forEach(function(pos) {
              if (pos.crewId === dc.id && (pos.status === "requested" || pos.status === "accepted" || pos.status === "confirmed")) {
                crewPositions.push({ projectName: p.name, schedTitle: s.title, status: pos.status, projectId: p.id, schedId: s.id, posId: pos.id });
              }
            });
          });
        });
      }
      var linkedQuotes = (quotes || []).filter(function(q) { return q.clientContactId === dc.id; });
      var linkedInvoices = (invoices || []).filter(function(i) { return i.clientContactId === dc.id; });
      if (crewPositions.length > 0 || linkedQuotes.length > 0 || linkedInvoices.length > 0) {
        setDeleteConfirm(null);
        setDeleteWizard({ type: "contact", id: dc.id, name: dc.name,
          crewPositions: crewPositions, linkedQuotes: linkedQuotes, linkedInvoices: linkedInvoices,
          crewDone: false, quotesDone: false, invoicesDone: false });
        return;
      }
      setContacts(function(p) { return p.filter(function(c) { return c.id !== dc.id; }); });
      if (editContactId === dc.id) nav("crm/contacts");
    }
    setDeleteConfirm(null);
  }

  function wizardFinalDelete() {
    if (!deleteWizard) return;
    if (deleteWizard.type === "company") {
      setCompanies(function(p) { return p.filter(function(c) { return c.id !== deleteWizard.id; }); });
      if (selectedCompanyId === deleteWizard.id) nav("crm/companies");
    } else if (deleteWizard.type === "contact") {
      setContacts(function(p) { return p.filter(function(c) { return c.id !== deleteWizard.id; }); });
      if (editContactId === deleteWizard.id) nav("crm/contacts");
    }
    setDeleteWizard(null);
  }

  function switchTab(t) {
    nav("crm/" + t); setSearchQuery("");
    setCompSort({ key: "name", dir: "asc" }); setContSort({ key: "name", dir: "asc" });
  }

  var q = searchQuery.toLowerCase();

  // Per-company tallies. The old row fused these into one sentence ("… · 4
  // contacts · 2 projects"); as columns they line up down the list and can be
  // ordered by, which is how you find your busiest client.
  function contactCount(c) { return contacts.filter(function(ct) { return ct.companyIds.includes(c.id); }).length; }
  function projectCount(c) { return projects.filter(function(p) { return p.companyId === c.id; }).length; }
  function typeLabel(c) { return [c.isClient ? "Client" : "", c.isVendor ? "Vendor" : ""].filter(Boolean).join(" "); }
  // Contacts file under last name, the way a directory reads.
  function contactSortName(c) { return (c.lastName || "") + " " + (c.firstName || ""); }
  function contactCompanies(c) { return companies.filter(function(co) { return c.companyIds.includes(co.id); }); }

  var COMPANY_COLS = [
    { key: "name",     label: "Company",  w: "minmax(0,1.8fr)", flex: true,
      sort: function(c) { return c.name || ""; } },
    { key: "location", label: "Location", w: "minmax(0,1.5fr)",
      sort: function(c) { return window.LTP_formatAddress(c) || ""; } },
    { key: "contacts", label: "Contacts", w: "96px", align: "right", mono: true, dir: "desc", sort: contactCount },
    { key: "projects", label: "Projects", w: "96px", align: "right", mono: true, dir: "desc", sort: projectCount },
    { key: "type",     label: "Type",     w: "136px", flex: true, sort: typeLabel },
    { key: "status",   label: "Status",   w: "104px", sort: function(c) { return c.status || ""; } },
  ];

  var CONTACT_COLS = [
    { key: "name",      label: "Name",      w: "minmax(0,1.3fr)", sort: contactSortName },
    { key: "role",      label: "Role",      w: "minmax(0,1fr)",   sort: function(c) { return c.role || ""; } },
    { key: "email",     label: "Email",     w: "minmax(0,1.6fr)", sort: function(c) { return c.email || ""; } },
    { key: "phone",     label: "Phone",     w: "136px",           sort: function(c) { return c.phone || ""; } },
    { key: "companies", label: "Companies", w: "minmax(0,1.4fr)", flex: true,
      sort: function(c) { var l = contactCompanies(c); return l.length ? l[0].name : ""; } },
  ];

  var fc = window.LTP_sortRows(companies.filter(function(c) {
    if (companyFilter !== "all" && c.status !== companyFilter) return false;
    if (typeFilter === "client" && !c.isClient) return false;
    if (typeFilter === "vendor" && !c.isVendor) return false;
    if (typeFilter === "both"   && !(c.isClient && c.isVendor)) return false;
    if (q && c.name.toLowerCase().indexOf(q) === -1) return false;
    return true;
  }), COMPANY_COLS, compSort);

  var fcon = window.LTP_sortRows(contacts.filter(function(c) {
    if (q && (c.firstName + " " + c.lastName).toLowerCase().indexOf(q) === -1) return false;
    return true;
  }), CONTACT_COLS, contSort);

  var searchBar = h("input", { type: "text", value: searchQuery, onChange: function(e) { setSearchQuery(e.target.value); }, placeholder: "Search...",
    style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", width: 180 } });

  // Sort chips \u2014 PHONE ONLY; on desktop the column headers carry the sort. Each
  // tab passes its own state pair, since the two sort independently.
  function sortBtns(sort, setSort) {
    return h("div", { style: { display: "flex", gap: 4 } },
      [{ l: "A\u2192Z", d: "asc" }, { l: "Z\u2192A", d: "desc" }].map(function(o) {
        var active = sort.key === "name" && sort.dir === o.d;
        return h("button", { key: o.l, onClick: function() { setSort({ key: "name", dir: o.d }); },
          style: { background: active ? B.accent : B.raised, color: active ? B.btnInk : B.textMut, border: "1px solid " + (active ? B.accent : B.border), borderRadius: "4px", padding: "3px 8px", fontSize: "10px", fontWeight: 600, cursor: "pointer" } }, o.l);
      }));
  }

  return h("div", null,
    h("h2", { style: { fontSize: "20px", fontWeight: 700, color: B.text, margin: "0 0 16px" } }, "CRM"),

    // ── Companies ─────────────────────────────────────────────────────────────
    crmTab === "companies" && h("div", null,
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 } },
        h(window.LTPScrollStrip, { isMobile: isMobile, mobileStyle: { display: "flex", gap: 8, overflowX: "auto", flexWrap: "nowrap", alignItems: "center", WebkitOverflowScrolling: "touch", scrollbarWidth: "none", width: "100%", paddingBottom: 4 }, desktopStyle: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } },
          ["all", "active", "inactive", "one-time", "prospect"].map(function(f) {
            var active = companyFilter === f;
            return h("button", { key: f, onClick: function() { setCompanyFilter(f); }, className: "ltp-tap",
              style: { flexShrink: 0, whiteSpace: "nowrap", background: active ? B.accent : B.raised, color: active ? B.btnInk : B.textMut, border: "1px solid " + (active ? B.accent : B.border), borderRadius: isMobile ? "16px" : "4px", padding: isMobile ? "8px 16px" : "4px 12px", fontSize: isMobile ? "13px" : "11px", fontWeight: 600, cursor: "pointer", textTransform: "capitalize", minHeight: isMobile ? 36 : undefined } }, f);
          }),
          h("span", { style: { flexShrink: 0, width: 1, background: B.border, margin: "0 4px", height: 20 } }),
          ["all", "client", "vendor", "both"].map(function(f) {
            var active = typeFilter === f;
            return h("button", { key: "t" + f, onClick: function() { setTypeFilter(f); }, className: "ltp-tap",
              style: { flexShrink: 0, whiteSpace: "nowrap", background: active ? B.accent : B.raised, color: active ? B.btnInk : B.textMut, border: "1px solid " + (active ? B.accent : B.border), borderRadius: isMobile ? "16px" : "4px", padding: isMobile ? "8px 16px" : "4px 12px", fontSize: isMobile ? "13px" : "11px", fontWeight: 600, cursor: "pointer", textTransform: "capitalize", minHeight: isMobile ? 36 : undefined } }, f);
          })
        ),
        !isMobile && h(window.Btn, { small: true, onClick: function() { nav("crm/companies/new"); } }, "+ Add Company")
      ),
      isMobile && h(window.LTPFab, { label: "Add company", onClick: function() { nav("crm/companies/new"); } }),
      h("div", { style: { display: "flex", flexDirection: isMobile ? "column" : "row", justifyContent: "space-between", alignItems: isMobile ? "stretch" : "center", marginBottom: 10, gap: 8 } },
        isMobile ? h("input", { type: "text", value: searchQuery, onChange: function(e) { setSearchQuery(e.target.value); }, placeholder: "Search companies...",
          style: { width: "100%", background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: "9px 12px", color: B.text, fontFamily: "inherit", outline: "none" } }) : searchBar,
        isMobile && sortBtns(compSort, setCompSort)),
      isMobile
        // \u2500\u2500 Phone: the stacked card rows, unchanged \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
        ? h(window.LTPList, null,
            fc.length === 0 && h(window.EmptyState, { text: "No companies match your search." }),
            fc.map(function(c) {
              var cc = contactCount(c), pp = projectCount(c);
              var meta = [window.LTP_formatAddress(c),
                          cc + (cc === 1 ? " contact" : " contacts"),
                          pp + (pp === 1 ? " project" : " projects")].filter(Boolean).join(" \u00b7 ");
              return h(window.LTPRow, { key: c.id, onClick: function() { setSelectedCompanyId(c.id); },
                style: { display: "flex", alignItems: "flex-start", gap: 12 } },
                h(window.CompanyLogo, { src: c.logo, size: 32 }),
                h("div", { style: { flex: 1, minWidth: 0 } },
                  // The name owns its line. It used to sit beside the badges,
                  // and a company that is both client and vendor carries three
                  // of them — enough to wrap an ordinary company name in two.
                  h("div", { style: { fontSize: "14px", fontWeight: 600, color: B.text } }, c.name),
                  // The badges share the meta line, which is short. flexWrap is
                  // the safety valve: on the rare three-badge row they drop to
                  // their own line rather than squeezing the text beside them.
                  h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 3 } },
                    // "1 1 auto", not "1": flex:1 sets a ZERO basis, so this div
                    // reports no width, the badges always "fit" beside it, and
                    // the text ends up shrunk and broken mid-phrase instead. A
                    // content basis is what lets the row decide to wrap at all.
                    h("div", { style: { fontSize: "11px", color: B.textMut, flex: "1 1 auto", minWidth: 0 } }, meta),
                    // The badges wrap as ONE unit. Left as loose flex items they
                    // each compete with the meta text, which then shrinks and
                    // breaks mid-phrase on a client+vendor row; grouped, they
                    // drop to their own line together and the text stays whole.
                    h("div", { style: { display: "flex", gap: 6, flexShrink: 0 } },
                      compTypeBadges(c), h(window.Badge, { status: c.status })))));
            })
          )
        // \u2500\u2500 Desktop: one line per company, across the full width \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
        : h(window.LTPTable, { columns: COMPANY_COLS, sort: compSort, onSort: setCompSort,
            empty: "No companies match your search.",
            rows: fc.map(function(c) {
              return { key: c.id, onClick: function() { setSelectedCompanyId(c.id); }, cells: [
                [h(window.CompanyLogo, { key: "l", src: c.logo, size: 24 }),
                 h("span", { key: "n", style: { fontSize: "13px", fontWeight: 600, color: B.text, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, c.name)],
                h("span", { style: { fontSize: "11px", color: B.textMut } }, window.LTP_formatAddress(c) || "\u2014"),
                h("span", { style: { fontSize: "12px", color: B.textSec } }, contactCount(c)),
                h("span", { style: { fontSize: "12px", color: B.textSec } }, projectCount(c)),
                compTypeBadges(c),
                h(window.Badge, { status: c.status }),
              ] };
            }) })
    ),

    // ── Contacts ──────────────────────────────────────────────────────────────
    crmTab === "contacts" && h("div", null,
      isMobile
        ? h("div", { style: { display: "flex", flexDirection: "column", marginBottom: 10, gap: 8 } },
            h("input", { type: "text", value: searchQuery, onChange: function(e) { setSearchQuery(e.target.value); }, placeholder: "Search contacts...",
              style: { width: "100%", background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: "9px 12px", color: B.text, fontFamily: "inherit", outline: "none" } }),
            sortBtns(contSort, setContSort))
        : h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8 } },
            h("div", { style: { display: "flex", gap: 8, alignItems: "center" } }, searchBar),
            h(window.Btn, { small: true, onClick: function() { nav("crm/contacts/new"); } }, "+ Add Contact")
          ),
      isMobile && h(window.LTPFab, { label: "Add contact", onClick: function() { nav("crm/contacts/new"); } }),
      isMobile
        // \u2500\u2500 Phone: the stacked rows with tap-to-call / tap-to-email \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
        ? h(window.LTPList, null,
            fcon.length === 0 && h(window.EmptyState, { text: "No contacts match your search." }),
            fcon.map(function(c) {
              var cname = c.firstName + " " + c.lastName;
              return h(window.LTPRow, { key: c.id, onClick: function() { setEditContactId(c.id); } },
                h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 } },
                  h("div", { style: { minWidth: 0 } },
                    h("div", { style: { fontSize: "14px", fontWeight: 600, color: B.text, marginBottom: 3 } }, cname),
                    h("div", { style: { fontSize: "11px", color: B.textMut, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, c.role + " \u00b7 " + c.email + " \u00b7 " + c.phone)),
                  h("div", { style: { display: "flex", gap: 8, flexShrink: 0, alignItems: "center" } },
                    h(window.LTPCallBtn, { phone: c.phone, name: cname }),
                    h(window.LTPMailBtn, { email: c.email, name: cname }))));
            })
          )
        // \u2500\u2500 Desktop: role, email and phone were one fused muted sentence;
        //    as columns they line up and each one sorts. The linked-company
        //    chips keep their own click-through to the company. \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
        : h(window.LTPTable, { columns: CONTACT_COLS, sort: contSort, onSort: setContSort,
            empty: "No contacts match your search.",
            rows: fcon.map(function(c) {
              return { key: c.id, onClick: function() { setEditContactId(c.id); }, cells: [
                h("span", { style: { fontSize: "13px", fontWeight: 600, color: B.text } }, c.firstName + " " + c.lastName),
                h("span", { style: { fontSize: "12px", color: B.textSec } }, c.role || "\u2014"),
                h("span", { style: { fontSize: "12px", color: B.textSec } }, c.email || "\u2014"),
                h("span", { style: { fontSize: "12px", color: B.textSec } }, window.LTP_formatPhone(c.phone) || "\u2014"),
                contactCompanies(c).map(function(co) {
                  return h("span", { key: co.id, onClick: function(e) { e.stopPropagation(); setSelectedCompanyId(co.id); },
                    style: { background: B.accentMuted, color: B.accent, fontSize: "10px", padding: "2px 8px", borderRadius: "3px", fontWeight: 600, cursor: "pointer", border: "1px solid " + B.accent + "44", whiteSpace: "nowrap" } }, co.name);
                }),
              ] };
            }) })
    ),

    // ── Modals ────────────────────────────────────────────────────────────────
    selectedCompany && !editCompanyId && h(window.CRMCompanyDetail, { ctx: ctx }),

    showAddCompany && h(window.CRMCompanyForm, { ctx: ctx, initial: null,
      onClose: function() { nav("crm/companies"); },
      onSave: function(d) {
        var newId = Math.max.apply(null, companies.map(function(c) { return c.id; }).concat([0])) + 1;
        setCompanies(function(p) { return p.concat([Object.assign({ id: newId }, d)]); });
        nav("crm/companies/" + newId);
      }}),

    editCompanyId && h(window.CRMCompanyForm, { ctx: ctx, initial: companies.find(function(c) { return c.id === editCompanyId; }),
      onClose: function() { ctx.setEditCompanyId(null); },
      onSave: function(d) {
        setCompanies(function(p) { return p.map(function(c) { return c.id === editCompanyId ? Object.assign({}, c, d) : c; }); });
        nav("crm/companies/" + editCompanyId);
      }}),

    showAddContact && h(window.CRMContactForm, { ctx: ctx, initial: null,
      onClose: function() { nav("crm/contacts"); },
      onSave: function(d) {
        // Check for duplicates
        var dupes = contacts.filter(function(c) {
          if (d.firstName && d.lastName && c.firstName.toLowerCase() === d.firstName.toLowerCase() && c.lastName.toLowerCase() === d.lastName.toLowerCase()) return true;
          if (d.email && c.email && c.email.toLowerCase() === d.email.toLowerCase()) return true;
          return false;
        });
        if (dupes.length > 0) {
          var names = dupes.map(function(c) { return c.firstName + " " + c.lastName + (c.email ? " (" + c.email + ")" : ""); }).join(", ");
          if (!window.confirm("A similar contact already exists:\n\n" + names + "\n\nCreate anyway?")) return;
        }
        var newId = Math.max.apply(null, contacts.map(function(c) { return c.id; }).concat([0])) + 1;
        setContacts(function(p) { return p.concat([Object.assign({ id: newId }, d)]); });
        nav("crm/contacts/" + newId);
      }}),

    editContactId && h(window.CRMContactDetail, { ctx: ctx }),

    deleteConfirm && h(window.LTPConfirmDialog, { dlg: { title: "Confirm Delete", message: 'Are you sure you want to delete "' + deleteConfirm.name + '"? This cannot be undone.', variant: "danger", confirmLabel: "Delete", onConfirm: function() { handleDelete(deleteConfirm); } }, onCancel: function() { setDeleteConfirm(null); } }),

    // Guided deletion wizard
    deleteWizard && function() {
      var w = deleteWizard;
      var stepStyle = function(done) { return { background: done ? B.success + "11" : B.raised, border: "1px solid " + (done ? B.success + "44" : B.border), borderRadius: "8px", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }; };
      var check = h("span", { style: { fontSize: "14px", color: B.success, fontWeight: 700 } }, "\u2713");
      var steps, allDone;

      if (w.type === "company") {
        var pDone = w.projectsDone || w.projects.length === 0;
        var qDone = w.quotesDone || w.compQuotes.length === 0;
        var iDone = w.invoicesDone || w.compInvoices.length === 0;
        var cDone = w.contactsDone || w.compContacts.length === 0;
        allDone = pDone && qDone && iDone && cDone;

        var companySteps = [];
        if (w.projects.length > 0) companySteps.push(h("div", { key: "p", style: stepStyle(w.projectsDone) },
          h("div", null,
            h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, w.projectsDone ? "\u2713 Projects unlinked" : w.projects.length + " Linked Project" + (w.projects.length > 1 ? "s" : "")),
            h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } }, w.projects.map(function(p) { return p.name; }).join(", "))),
          w.projectsDone ? check : h(window.Btn, { small: true, variant: "ghost", onClick: function() {
            setProjects(function(prev) { return prev.map(function(p) { return p.companyId === w.id ? Object.assign({}, p, { companyId: null }) : p; }); });
            setDeleteWizard(Object.assign({}, w, { projectsDone: true }));
          } }, "Unlink")));
        if (w.compQuotes.length > 0) companySteps.push(h("div", { key: "q", style: stepStyle(w.quotesDone) },
          h("div", null,
            h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, w.quotesDone ? "\u2713 Quotes acknowledged" : w.compQuotes.length + " Quote" + (w.compQuotes.length > 1 ? "s" : "")),
            h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } }, w.compQuotes.map(function(q) { return window.LTP_QUOTE_REF(q); }).join(", "))),
          w.quotesDone ? check : h(window.Btn, { small: true, variant: "ghost", onClick: function() {
            setDeleteWizard(Object.assign({}, w, { quotesDone: true }));
          } }, "Acknowledge")));
        if (w.compInvoices.length > 0) companySteps.push(h("div", { key: "i", style: stepStyle(w.invoicesDone) },
          h("div", null,
            h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, w.invoicesDone ? "\u2713 Invoices acknowledged" : w.compInvoices.length + " Invoice" + (w.compInvoices.length > 1 ? "s" : "")),
            h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } }, w.compInvoices.map(function(i) { return window.LTP_INVOICE_REF(i); }).join(", "))),
          w.invoicesDone ? check : h(window.Btn, { small: true, variant: "ghost", onClick: function() {
            setDeleteWizard(Object.assign({}, w, { invoicesDone: true }));
          } }, "Acknowledge")));
        if (w.compContacts.length > 0) companySteps.push(h("div", { key: "c", style: stepStyle(w.contactsDone) },
          h("div", null,
            h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, w.contactsDone ? "\u2713 Contacts unlinked" : w.compContacts.length + " Contact" + (w.compContacts.length > 1 ? "s" : "")),
            h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } }, w.compContacts.map(function(c) { return c.firstName + " " + c.lastName; }).join(", "))),
          w.contactsDone ? check : h(window.Btn, { small: true, variant: "ghost", onClick: function() {
            setContacts(function(prev) { return prev.map(function(c) { return (c.companyIds || []).includes(w.id) ? Object.assign({}, c, { companyIds: c.companyIds.filter(function(cid) { return cid !== w.id; }) }) : c; }); });
            setDeleteWizard(Object.assign({}, w, { contactsDone: true }));
          } }, "Unlink")));
        steps = h("div", { style: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 } }, companySteps);
      } else {
        // Contact wizard
        var crD = w.crewDone || w.crewPositions.length === 0;
        var qD = w.quotesDone || w.linkedQuotes.length === 0;
        var iD = w.invoicesDone || w.linkedInvoices.length === 0;
        allDone = crD && qD && iD;

        var contactSteps = [];
        if (w.crewPositions.length > 0) contactSteps.push(h("div", { key: "cr", style: stepStyle(w.crewDone) },
          h("div", null,
            h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, w.crewDone ? "\u2713 Crew released" : w.crewPositions.length + " Active Assignment" + (w.crewPositions.length > 1 ? "s" : "")),
            h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } }, w.crewPositions.map(function(c) { return c.projectName + " \u2014 " + c.schedTitle + " (" + c.status + ")"; }).slice(0, 3).join(", "))),
          w.crewDone ? check : h(window.Btn, { small: true, variant: "danger", onClick: function() {
            setProjects(function(prev) { return prev.map(function(p) {
              return Object.assign({}, p, { schedule: (p.schedule || []).map(function(s) {
                return Object.assign({}, s, { positions: (s.positions || []).map(function(pos) {
                  if (pos.crewId === w.id) return Object.assign({}, pos, { crewId: null, status: "open" });
                  return pos;
                })});
              })});
            }); });
            setDeleteWizard(Object.assign({}, w, { crewDone: true }));
          } }, "Release & Notify")));
        if (w.linkedQuotes.length > 0) contactSteps.push(h("div", { key: "cq", style: stepStyle(w.quotesDone) },
          h("div", null,
            h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, w.quotesDone ? "\u2713 Quotes acknowledged" : "Primary Contact on " + w.linkedQuotes.length + " Quote" + (w.linkedQuotes.length > 1 ? "s" : "")),
            h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } }, w.linkedQuotes.map(function(q) { return window.LTP_QUOTE_REF(q); }).join(", "))),
          w.quotesDone ? check : h(window.Btn, { small: true, variant: "ghost", onClick: function() {
            setDeleteWizard(Object.assign({}, w, { quotesDone: true }));
          } }, "Acknowledge")));
        if (w.linkedInvoices.length > 0) contactSteps.push(h("div", { key: "ci", style: stepStyle(w.invoicesDone) },
          h("div", null,
            h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, w.invoicesDone ? "\u2713 Invoices acknowledged" : "Contact on " + w.linkedInvoices.length + " Invoice" + (w.linkedInvoices.length > 1 ? "s" : "")),
            h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } }, w.linkedInvoices.map(function(i) { return window.LTP_INVOICE_REF(i); }).join(", "))),
          w.invoicesDone ? check : h(window.Btn, { small: true, variant: "ghost", onClick: function() {
            setDeleteWizard(Object.assign({}, w, { invoicesDone: true }));
          } }, "Acknowledge")));
        steps = h("div", { style: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 } }, contactSteps);
      }

      return h(window.LTPModal, { title: "Delete \"" + w.name + "\"", onClose: function() { setDeleteWizard(null); } },
        h("p", { style: { fontSize: "12px", color: B.textSec, marginBottom: 16, lineHeight: 1.5 } },
          "This " + w.type + " has linked data. Review each item before deleting."),
        steps,
        h("div", { style: { borderTop: "1px solid " + B.border, paddingTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center" } },
          h("div", { style: { fontSize: "11px", color: allDone ? B.textSec : B.textMut } },
            allDone ? "All steps completed. Ready to delete." : "Complete the steps above to proceed."),
          h("div", { style: { display: "flex", gap: 8 } },
            h(window.Btn, { variant: "ghost", onClick: function() { setDeleteWizard(null); } }, "Cancel"),
            h(window.Btn, { variant: "danger", onClick: allDone ? wizardFinalDelete : undefined,
              style: allDone ? {} : { opacity: 0.4, cursor: "not-allowed" } }, "Delete " + (w.type === "company" ? "Company" : "Contact"))))
      );
    }()
  );
};
