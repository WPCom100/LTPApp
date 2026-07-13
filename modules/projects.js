// Projects Module — top-level view (formerly nested under CRM)
window.ProjectsView = function({ companies, contacts, setContacts, projects, setProjects, quotes, setQuotes, getNextQuoteId, services, invoices, setInvoices, route }) {
  var B = window.LTP_THEME, CATS = window.LTP_PROJECT_CATS, CAT_KEYS = window.LTP_CAT_KEYS, CAT_COLORS = window.LTP_CAT_COLORS;
  var h = React.createElement, useState = React.useState, fmt = window.LTP_formatDate;
  var isMobile = window.LTP_useIsMobile();
  var nav = window.LTPRouter.navigate;

  // URL shapes:
  //   #/projects                  list
  //   #/projects/new              create form
  //   #/projects/7                detail (opens on Overview)
  //   #/projects/7/schedule       full-screen schedule builder
  //   #/projects/7/edit           edit form
  var urlId     = route.id     || null;
  var urlAction = route.action || null;

  var PROJECT_TABS = { overview: 1, notes: 1, schedule: 1, meetings: 1, budget: 1, quotes: 1 };
  var urlTab = (urlId && PROJECT_TABS[urlAction]) ? urlAction : null;

  // URL-derived state
  var editProjectId     = (urlId && urlAction === "edit") ? urlId : null;
  var selectedProjectId = (urlId && urlAction !== "edit") ? urlId : null;
  var showAddProject    = (!urlId && urlAction === "new");

  function setSelectedProjectId(id, tab) {
    if (!id) return nav("projects");
    nav("projects/" + id + (tab ? "/" + tab : ""));
  }

  var [projectFilter,   setProjectFilter]   = useState("all");
  var [searchQuery,     setSearchQuery]     = useState("");
  var [sortMode,        setSortMode]        = useState("date-asc");
  var [showCompleted,   setShowCompleted]   = useState(false);
  var [showAddMeeting,  setShowAddMeeting]  = useState(null);
  var [showAddNote,     setShowAddNote]     = useState(null);
  var [viewNote,        setViewNote]        = useState(null);
  var [editNote,        setEditNote]        = useState(null);
  var [deleteConfirm,   setDeleteConfirm]   = useState(null);
  var [deleteWizard,    setDeleteWizard]    = useState(null); // { projectId, name, steps completed tracking }

  // Full-screen schedule builder. This conditional return MUST stay below every
  // hook above: an early return placed before the useState calls changes the
  // hook count between the list route and the schedule route (which keep the
  // same ProjectsView instance mounted), tripping React error #310 — "rendered
  // fewer hooks than during the previous render."
  if (urlId && urlAction === "schedule") {
    var schedProject = projects.find(function(p) { return p.id === urlId; });
    if (schedProject) {
      return h(window.ScheduleBuilder, {
        project: schedProject, projects: projects, setProjects: setProjects,
        contacts: contacts, setContacts: setContacts, services: services,
        companies: companies,
        quotes: quotes, setQuotes: setQuotes, getNextQuoteId: getNextQuoteId
      });
    }
  }

  var selectedProject = selectedProjectId ? projects.find(function(p) { return p.id === selectedProjectId; }) : null;

  // ctx for CRMProjectDetail/Form + CRMAddMeeting + CRMAddNote + CRMNoteViewer/Editor.
  // Keep in sync with ctx.* references in those files.
  // projectOpenTab is URL-derived (see urlTab above). setProjectOpenTab is a no-op
  // because in-modal tab clicks use local state in crm-projects.js and do not nav.
  var ctx = {
    companies: companies,
    contacts:  contacts,
    projects:  projects, setProjects: setProjects,
    quotes: quotes || [],
    services: services || [],
    invoices: invoices || [],
    selectedProject: selectedProject,
    setSelectedProjectId: setSelectedProjectId,
    setEditProjectId: function(id) {
      id ? nav("projects/" + id + "/edit") : nav("projects/" + (selectedProjectId || ""));
    },
    projectOpenTab: urlTab, setProjectOpenTab: function() {},
    showAddMeeting: showAddMeeting, setShowAddMeeting: setShowAddMeeting,
    showAddNote:    showAddNote,    setShowAddNote:    setShowAddNote,
    viewNote:       viewNote,       setViewNote:       setViewNote,
    editNote:       editNote,       setEditNote:       setEditNote,
    setSelectedCompanyId: function(id) { id ? nav("crm/companies/" + id) : nav("crm/companies"); },
    setEditContactId: function(id) { id ? nav("crm/contacts/" + id) : nav("crm/contacts"); },
    setDeleteConfirm: setDeleteConfirm,
  };

  function handleDelete(dc) {
    if (dc.type === "project") {
      var projQuotes = (quotes || []).filter(function(q) { return q.projectId === dc.id; });
      var projInvoices = (invoices || []).filter(function(i) { return i.projectId === dc.id; });
      var proj = projects.find(function(p) { return p.id === dc.id; });
      var crewPositions = [];
      var buckets = {};  // "crewId:template" — one notify-tray notice per person + type
      if (proj && proj.schedule) {
        proj.schedule.forEach(function(s) {
          (s.positions || []).forEach(function(p) {
            if (p.crewId && (p.status === "requested" || p.status === "accepted" || p.status === "confirmed")) {
              var cm = contacts.find(function(c) { return c.id === p.crewId; });
              var nm = cm ? cm.firstName + " " + cm.lastName : "Unknown";
              crewPositions.push({ crewName: nm, status: p.status });
              // Confirmed crew get a cancellation, accepted a not-selected,
              // requested a withdrawal — not all "withdrawn".
              var template = window.LTP_removalTemplate(p.status);
              var k = p.crewId + ":" + template;
              if (!buckets[k]) buckets[k] = { crewId: p.crewId, crewName: nm, template: template, positionIds: [] };
              buckets[k].positionIds.push(p.id);
            }
          });
        });
      }
      // Snapshot the shifts now (before the project is deleted) so each notice
      // still renders its shift list when the tray sends it.
      var affectedGroups = Object.keys(buckets).map(function(k) {
        var g = buckets[k];
        return { crewId: g.crewId, crewName: g.crewName, template: g.template, shifts: window.LTP_shiftSnapshots(proj.schedule, g.positionIds, services) };
      });

      if (projQuotes.length > 0 || projInvoices.length > 0 || crewPositions.length > 0) {
        setDeleteConfirm(null);
        setDeleteWizard({ projectId: dc.id, name: dc.name, crewReleased: false, quotesHandled: false, invoicesHandled: false,
          crewPositions: crewPositions, affectedGroups: affectedGroups, projQuotes: projQuotes, projInvoices: projInvoices });
        return;
      }
      setProjects(function(p) { return p.filter(function(x) { return x.id !== dc.id; }); });
      if (selectedProjectId === dc.id) nav("projects");
    }
    setDeleteConfirm(null);
  }

  function wizardReleaseCrew() {
    if (!deleteWizard) return;
    // Park a removal notice per person + type into the notify tray (send or
    // decline there). Snapshots were captured at delete time, so they survive
    // the project being deleted.
    (deleteWizard.affectedGroups || []).forEach(function(g) {
      window.LTP_outbox.add({ crewId: g.crewId, crewName: g.crewName, projectId: deleteWizard.projectId, projectName: deleteWizard.name, template: g.template, shifts: g.shifts });
    });
    if ((deleteWizard.affectedGroups || []).length) {
      window.LTP_toast("Added to notify tray", { message: "Crew queued — send or decline from the tray (bottom-left).", variant: "info" });
    }
    setProjects(function(prev) {
      return prev.map(function(p) {
        if (p.id !== deleteWizard.projectId) return p;
        return Object.assign({}, p, { schedule: (p.schedule || []).map(function(s) {
          return Object.assign({}, s, { positions: (s.positions || []).map(function(pos) {
            if (pos.crewId && (pos.status === "requested" || pos.status === "accepted" || pos.status === "confirmed")) {
              return Object.assign({}, pos, { status: "open", crewId: null });
            }
            return pos;
          })});
        })});
      });
    });
    setDeleteWizard(Object.assign({}, deleteWizard, { crewReleased: true }));
  }

  function wizardUnlinkQuotes() {
    if (!deleteWizard) return;
    setQuotes(function(prev) {
      return prev.map(function(q) {
        if (q.projectId !== deleteWizard.projectId) return q;
        return Object.assign({}, q, { projectId: null });
      });
    });
    setDeleteWizard(Object.assign({}, deleteWizard, { quotesHandled: true }));
  }

  function wizardDeleteQuotes() {
    if (!deleteWizard) return;
    var qIds = deleteWizard.projQuotes.map(function(q) { return q.id; });
    setQuotes(function(prev) { return prev.filter(function(q) { return qIds.indexOf(q.id) === -1; }); });
    setDeleteWizard(Object.assign({}, deleteWizard, { quotesHandled: true }));
  }

  function wizardUnlinkInvoices() {
    if (!deleteWizard) return;
    setInvoices(function(prev) {
      return prev.map(function(i) {
        if (i.projectId !== deleteWizard.projectId) return i;
        return Object.assign({}, i, { projectId: null });
      });
    });
    setDeleteWizard(Object.assign({}, deleteWizard, { invoicesHandled: true }));
  }

  function wizardFinalDelete() {
    if (!deleteWizard) return;
    setProjects(function(p) { return p.filter(function(x) { return x.id !== deleteWizard.projectId; }); });
    if (selectedProjectId === deleteWizard.projectId) nav("projects");
    setDeleteWizard(null);
  }

  var q = searchQuery.toLowerCase();

  var fp = projects.filter(function(p) {
    if (!showCompleted && p.status === "completed") return false;
    if (projectFilter !== "all" && p.category !== projectFilter) return false;
    var comp = companies.find(function(c) { return c.id === p.companyId; });
    if (q && p.name.toLowerCase().indexOf(q) === -1 && (comp ? comp.name : "").toLowerCase().indexOf(q) === -1) return false;
    return true;
  }).sort(function(a, b) {
    if (sortMode === "date-asc")  return a.startDate > b.startDate ?  1 : -1;
    if (sortMode === "date-desc") return b.startDate > a.startDate ?  1 : -1;
    if (sortMode === "za")        return b.name.localeCompare(a.name);
    return a.name.localeCompare(b.name);
  });

  var searchBar = h("input", { type: "text", value: searchQuery, onChange: function(e) { setSearchQuery(e.target.value); }, placeholder: "Search...",
    style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", width: 180 } });

  // Show/Hide completed toggle — a chip on mobile (rides the filter row at the
  // right), the small inline button on desktop (rides the sort row).
  var showCompletedBtn = h("button", { onClick: function() { setShowCompleted(!showCompleted); }, className: "ltp-tap",
    style: { flexShrink: 0, background: showCompleted ? B.accent : B.raised, color: showCompleted ? B.btnInk : B.textMut, border: "1px solid " + (showCompleted ? B.accent : B.border), borderRadius: isMobile ? "16px" : "4px", padding: isMobile ? "8px 14px" : "4px 12px", fontSize: isMobile ? "12px" : "11px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", minHeight: isMobile ? 36 : undefined } },
    showCompleted ? "✓ Completed" : "Show Completed");

  function sortBtns() {
    var opts = [{ k: "az", l: "A\u2192Z" }, { k: "za", l: "Z\u2192A" }, { k: "date-asc", l: "Date \u2191" }, { k: "date-desc", l: "Date \u2193" }];
    return h("div", { style: { display: "flex", gap: 4 } }, opts.map(function(o) {
      return h("button", { key: o.k, onClick: function() { setSortMode(o.k); },
        style: { background: sortMode === o.k ? B.accent : B.raised, color: sortMode === o.k ? B.btnInk : B.textMut, border: "1px solid " + (sortMode === o.k ? B.accent : B.border), borderRadius: "4px", padding: "3px 8px", fontSize: "10px", fontWeight: 600, cursor: "pointer" } }, o.l);
    }));
  }

  return h("div", null,
    h("h2", { style: { fontSize: "20px", fontWeight: 700, color: B.text, margin: "0 0 16px" } }, "Projects"),

    // Mobile: full-width search sits above the category filters.
    isMobile && h("input", { type: "text", value: searchQuery, onChange: function(e) { setSearchQuery(e.target.value); }, placeholder: "Search projects…",
      style: { width: "100%", background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: "9px 12px", color: B.text, fontFamily: "inherit", outline: "none", marginBottom: 10 } }),

    // Category filters. On mobile the Show Completed toggle rides at the right
    // of this row (chip height); on desktop the + Create button lives here.
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: isMobile ? "nowrap" : "wrap", gap: 8 } },
      h(window.LTPScrollStrip, { isMobile: isMobile, mobileStyle: { display: "flex", gap: 8, overflowX: "auto", flexWrap: "nowrap", WebkitOverflowScrolling: "touch", scrollbarWidth: "none", paddingBottom: 4 }, wrapStyle: { flex: 1, minWidth: 0 }, desktopStyle: { display: "flex", gap: 6, flexWrap: "wrap" } },
        ["all"].concat(CATS).map(function(f) {
          return h("button", { key: f, onClick: function() { setProjectFilter(f); }, className: "ltp-tap",
            style: { flexShrink: 0, whiteSpace: "nowrap", background: projectFilter === f ? B.accent : B.raised, color: projectFilter === f ? B.btnInk : B.textMut, border: "1px solid " + (projectFilter === f ? B.accent : B.border), borderRadius: isMobile ? "16px" : "4px", padding: isMobile ? "8px 16px" : "4px 12px", fontSize: isMobile ? "13px" : "11px", fontWeight: 600, cursor: "pointer", minHeight: isMobile ? 36 : undefined } }, f === "all" ? "All" : f);
        })
      ),
      isMobile ? showCompletedBtn : h(window.Btn, { small: true, onClick: function() { nav("projects/new"); } }, "+ Create Project")
    ),
    isMobile && h(window.LTPFab, { label: "Create project", onClick: function() { nav("projects/new"); } }),

    // Sort row. Desktop keeps search + Show Completed here; on mobile those
    // moved above so it's just the sort buttons.
    isMobile
      ? h("div", { style: { display: "flex", marginBottom: 14 } }, sortBtns())
      : h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 8, flexWrap: "wrap" } },
          h("div", { style: { display: "flex", gap: 6, alignItems: "center" } }, searchBar, showCompletedBtn),
          sortBtns()),

    fp.length === 0 ? h(window.EmptyState, { text: !showCompleted && projects.some(function(p) { return p.status === "completed"; }) ? "No active projects. Use \"Show Completed\" to see finished projects." : "No projects match your search." }) :
    h(window.LTPList, null,
      fp.map(function(p) {
        var comp = companies.find(function(c) { return c.id === p.companyId; });
        // Quoted total once quotes exist; preliminary budget until then.
        var tot  = Math.round(window.LTP_projectHeadlineTotal(p, quotes).total);
        return h(window.LTPRow, { key: p.id, onClick: function() { setSelectedProjectId(p.id); },
          style: { borderLeft: "3px solid " + CAT_COLORS[p.category] } },
          isMobile
            ? h("div", null,
                h("div", { style: { fontSize: "15px", fontWeight: 600, color: B.text, marginBottom: 2 } }, p.name),
                comp && h("div", { style: { fontSize: "12px", color: B.textMut } }, comp.name),
                h("div", { style: { fontSize: "12px", color: B.textMut } }, fmt(p.startDate) + " \u2192 " + fmt(p.endDate)),
                h("div", { style: { display: "flex", gap: 8, marginTop: 6, alignItems: "center", flexWrap: "wrap" } },
                  h("span", { style: { fontSize: "15px", fontWeight: 700, color: B.accent } }, "$" + tot.toLocaleString()),
                  h(window.Badge, { status: CAT_KEYS[p.category] }),
                  p.status !== "upcoming" && h(window.Badge, { status: p.status })),
                h("div", { style: { display: "flex", gap: 12, marginTop: 6, fontSize: "11px", color: B.textMut } },
                  h("span", null, p.notes.length + " notes"),
                  h("span", null, p.schedule.length + " schedule"),
                  h("span", null, p.meetings.length + " meetings")))
            : h(React.Fragment, null,
                h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" } },
                  h("div", null,
                    h("div", { style: { fontSize: "14px", fontWeight: 600, color: B.text, marginBottom: 3 } }, p.name),
                    h("div", { style: { fontSize: "11px", color: B.textMut } }, (comp ? comp.name + " \u00b7 " : "") + fmt(p.startDate) + " \u2192 " + fmt(p.endDate))),
                  h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                    h("span", { style: { fontSize: "14px", fontWeight: 700, color: B.accent } }, "$" + tot.toLocaleString()),
                    h(window.Badge, { status: CAT_KEYS[p.category] }),
                    p.status !== "upcoming" && h(window.Badge, { status: p.status }))),
                h("div", { style: { display: "flex", gap: 12, marginTop: 6, fontSize: "11px", color: B.textMut } },
                  h("span", null, p.notes.length + " notes"),
                  h("span", null, p.schedule.length + " schedule"),
                  h("span", null, p.meetings.length + " meetings"))));
      })
    ),

    // ── Modals ────────────────────────────────────────────────────────────────
    selectedProject && !editProjectId && h(window.CRMProjectDetail, { ctx: ctx }),

    showAddProject && h(window.CRMProjectForm, { ctx: ctx, initial: null,
      onClose: function() { nav("projects"); },
      onSave: function(d) {
        var newId = Math.max.apply(null, projects.map(function(x) { return x.id; }).concat([0])) + 1;
        setProjects(function(p) { return p.concat([Object.assign({ id: newId, notes: [], meetings: [] }, d, { schedule: d.schedule || [] })]); });
        nav("projects/" + newId);
      }}),

    editProjectId && h(window.CRMProjectForm, { ctx: ctx, initial: projects.find(function(p) { return p.id === editProjectId; }),
      onClose: function() { ctx.setEditProjectId(null); },
      onSave: function(d) {
        setProjects(function(p) { return p.map(function(x) { return x.id === editProjectId ? Object.assign({}, x, d, { schedule: d.schedule || x.schedule }) : x; }); });
        nav("projects/" + editProjectId);
      }}),

    showAddMeeting && h(window.CRMAddMeeting, { ctx: ctx }),
    showAddNote    && h(window.CRMAddNote,    { ctx: ctx }),
    viewNote       && h(window.CRMNoteViewer, { ctx: ctx }),
    editNote       && h(window.CRMNoteEditor, { ctx: ctx }),
    deleteConfirm  && h(window.LTPConfirmDialog, { dlg: { title: "Confirm Delete", message: 'Are you sure you want to delete "' + deleteConfirm.name + '"? This cannot be undone.', variant: "danger", confirmLabel: "Delete", onConfirm: function() { handleDelete(deleteConfirm); } }, onCancel: function() { setDeleteConfirm(null); } }),

    // Guided project deletion wizard
    deleteWizard && function() {
      var w = deleteWizard;
      var hasCrew = w.crewPositions.length > 0;
      var hasQuotes = w.projQuotes.length > 0;
      var hasInvoices = w.projInvoices.length > 0;
      var crewDone = !hasCrew || w.crewReleased;
      var quotesDone = !hasQuotes || w.quotesHandled;
      var invoicesDone = !hasInvoices || w.invoicesHandled;
      var allDone = crewDone && quotesDone && invoicesDone;

      var stepStyle = function(done) { return { background: done ? B.success + "11" : B.raised, border: "1px solid " + (done ? B.success + "44" : B.border), borderRadius: "8px", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }; };
      var checkmark = h("span", { style: { fontSize: "14px", color: B.success, fontWeight: 700 } }, "\u2713");

      return h(window.LTPModal, { title: "Delete \"" + w.name + "\"", onClose: function() { setDeleteWizard(null); } },
        h("p", { style: { fontSize: "12px", color: B.textSec, marginBottom: 16, lineHeight: 1.5 } },
          "This project has linked data. Complete or skip each step before deleting."),

        h("div", { style: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 } },
          // Step 1: Crew
          hasCrew && h("div", { style: stepStyle(w.crewReleased) },
            h("div", null,
              h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, w.crewReleased ? "\u2713 Crew released" : "Active Crew Assignments"),
              h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } },
                w.crewReleased
                  ? w.crewPositions.length + " crew member" + (w.crewPositions.length > 1 ? "s" : "") + " released from positions"
                  : w.crewPositions.map(function(c) { return c.crewName + " (" + c.status + ")"; }).slice(0, 4).join(", ") + (w.crewPositions.length > 4 ? "..." : ""))),
            w.crewReleased ? checkmark : h(window.Btn, { small: true, variant: "danger", onClick: function() { wizardReleaseCrew(); } }, "Release Crew")
          ),

          // Step 2: Quotes
          hasQuotes && h("div", { style: stepStyle(w.quotesHandled) },
            h("div", null,
              h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, w.quotesHandled ? "\u2713 Quotes handled" : w.projQuotes.length + " Linked Quote" + (w.projQuotes.length > 1 ? "s" : "")),
              h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } },
                w.quotesHandled
                  ? "Quotes have been processed"
                  : w.projQuotes.map(function(q) { return window.LTP_QUOTE_REF(q) + " (" + q.status + ")"; }).join(", "))),
            w.quotesHandled ? checkmark : h("div", { style: { display: "flex", gap: 6 } },
              h(window.Btn, { small: true, variant: "ghost", onClick: wizardUnlinkQuotes }, "Unlink"),
              h(window.Btn, { small: true, variant: "danger", onClick: wizardDeleteQuotes }, "Delete Quotes"))
          ),

          // Step 3: Invoices
          hasInvoices && h("div", { style: stepStyle(w.invoicesHandled) },
            h("div", null,
              h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, w.invoicesHandled ? "\u2713 Invoices unlinked" : w.projInvoices.length + " Linked Invoice" + (w.projInvoices.length > 1 ? "s" : "")),
              h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } },
                w.invoicesHandled
                  ? "Invoices preserved and unlinked from project"
                  : w.projInvoices.map(function(i) { return window.LTP_INVOICE_REF(i) + " (" + window.LTP_displayStatus(i) + ")"; }).join(", "))),
            w.invoicesHandled ? checkmark : h(window.Btn, { small: true, variant: "ghost", onClick: wizardUnlinkInvoices }, "Unlink Invoices")
          )
        ),

        // Final delete
        h("div", { style: { borderTop: "1px solid " + B.border, paddingTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center" } },
          h("div", { style: { fontSize: "11px", color: allDone ? B.textSec : B.textMut } },
            allDone ? "All steps completed. Ready to delete." : "Complete the steps above to proceed."),
          h("div", { style: { display: "flex", gap: 8 } },
            h(window.Btn, { variant: "ghost", onClick: function() { setDeleteWizard(null); } }, "Cancel"),
            h(window.Btn, { variant: "danger", onClick: allDone ? wizardFinalDelete : undefined,
              style: allDone ? {} : { opacity: 0.4, cursor: "not-allowed" } }, "Delete Project"))
        )
      );
    }()
  );
};
