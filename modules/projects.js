// Projects Module — top-level view (formerly nested under CRM)
window.ProjectsView = function({ companies, contacts, setContacts, projects, setProjects, quotes, setQuotes, getNextQuoteId, services, clientRates, invoices, setInvoices, getNextInvoiceId, route }) {
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
  // Blocks a delete while other jobs' quotes/invoices still list this project
  // as a contributor: { name, docs: [{ref, kind, id}] }. See handleDelete.
  var [sharedLinkBlock, setSharedLinkBlock] = useState(null);

  // Full-screen schedule builder. This conditional return MUST stay below every
  // hook above: an early return placed before the useState calls changes the
  // hook count between the list route and the schedule route (which keep the
  // same ProjectsView instance mounted), tripping React error #310 — "rendered
  // fewer hooks than during the previous render."
  if (urlId && urlAction === "schedule") {
    var schedProject = projects.find(function(p) { return p.id === urlId; });
    // Deleted in another window while the builder was open. Falling through to
    // the list silently unmounted ScheduleBuilder mid-edit — the draft gone, the
    // unsaved-changes guard reset by its own unmount effect, and the user dumped
    // on the list with no dialog and no explanation. Say what happened and make
    // leaving deliberate.
    if (!schedProject) {
      return h("div", { style: { padding: "40px 20px", maxWidth: 560, margin: "0 auto", textAlign: "center" } },
        h("h2", { style: { fontSize: "18px", fontWeight: 700, color: window.LTP_THEME.text, margin: "0 0 10px" } },
          "This project was deleted"),
        h("p", { style: { fontSize: "13px", color: window.LTP_THEME.textSec, lineHeight: 1.6, margin: "0 0 18px" } },
          "Someone removed it in another window while you had its schedule open. " +
          "Any unsaved changes to it could not be kept \u2014 there is no longer a project to save them to."),
        h(window.Btn, { onClick: function() { nav("projects"); } }, "Back to projects"));
    }
    if (schedProject) {
      return h(window.ScheduleBuilder, {
        project: schedProject, projects: projects, setProjects: setProjects,
        contacts: contacts, setContacts: setContacts, services: services,
        clientRates: clientRates, companies: companies,
        quotes: quotes, setQuotes: setQuotes, getNextQuoteId: getNextQuoteId,
        // Send to Invoice bills a schedule straight to the client, bypassing
        // the quote's delivered/invoiced ledger — see sendToDoc there.
        invoices: invoices, setInvoices: setInvoices, getNextInvoiceId: getNextInvoiceId
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
      // Documents this project is PRIMARY on — the wizard's unlink-or-delete
      // steps operate on these.
      var projQuotes = (quotes || []).filter(function(q) { return q.projectId === dc.id; });
      var projInvoices = (invoices || []).filter(function(i) { return i.projectId === dc.id; });
      // Documents this project merely CONTRIBUTES to: it's one of several jobs
      // they bill, and they belong to someone else's primary. Deleting the
      // project would strand its id inside their projectIds with no row behind
      // it, and neither "unlink" nor "delete" is the right call on a document
      // that's mostly another job's work — so this blocks the delete and hands
      // the decision back, naming the documents to detach first.
      var sharedDocs = []
        .concat((quotes || []).filter(function(q) { return q.projectId !== dc.id && window.LTP_docHasProject(q, dc.id); })
          .map(function(q) { return { ref: window.LTP_QUOTE_REF(q), kind: "quote", id: q.id }; }))
        .concat((invoices || []).filter(function(i) { return i.projectId !== dc.id && window.LTP_docHasProject(i, dc.id); })
          .map(function(i) { return { ref: window.LTP_INVOICE_REF(i), kind: "invoice", id: i.id }; }));
      if (sharedDocs.length > 0) {
        setDeleteConfirm(null);
        setSharedLinkBlock({ name: dc.name, docs: sharedDocs });
        return;
      }
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

  // Drop the project from a document's links entirely — the scalar AND the
  // contributor list. Leaving it in projectIds would keep the deleted project
  // "linked" to a document that no longer has a row behind it.
  function _unlinkDoc(doc, projectId) {
    var ids = window.LTP_docProjectIds(doc).filter(function(id) { return String(id) !== String(projectId); });
    return Object.assign({}, doc, { projectId: ids.length ? ids[0] : null, projectIds: ids });
  }

  function wizardUnlinkQuotes() {
    if (!deleteWizard) return;
    setQuotes(function(prev) {
      return prev.map(function(q) {
        if (q.projectId !== deleteWizard.projectId) return q;
        return _unlinkDoc(q, deleteWizard.projectId);
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
        return _unlinkDoc(i, deleteWizard.projectId);
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
    if (p.internal) return false;  // manual/one-off shifts live in Labor, not the client Projects list
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
    // Title + search share the top row (search to the right of the title);
    // desktop keeps the + Create button at the far right — matching Invoices.
    h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14 } },
      h("h2", { style: { fontSize: "20px", fontWeight: 700, color: B.text, margin: 0, flexShrink: 0 } }, "Projects"),
      h("input", { type: "text", value: searchQuery, onChange: function(e) { setSearchQuery(e.target.value); }, placeholder: "Search projects…",
        style: { flex: 1, minWidth: 0, background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: isMobile ? "9px 12px" : "6px 12px", color: B.text, fontSize: isMobile ? undefined : "12px", fontFamily: "inherit", outline: "none" } }),
      !isMobile && h(window.Btn, { small: true, onClick: function() { nav("projects/new"); } }, "+ Create Project")),

    // Category filters + Show Completed on the right (both viewports).
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: isMobile ? "flex-start" : "center", marginBottom: 10, flexWrap: isMobile ? "nowrap" : "wrap", gap: 8 } },
      h(window.LTPScrollStrip, { isMobile: isMobile, mobileStyle: { display: "flex", gap: 8, overflowX: "auto", flexWrap: "nowrap", WebkitOverflowScrolling: "touch", scrollbarWidth: "none", paddingBottom: 4 }, wrapStyle: { flex: 1, minWidth: 0 }, desktopStyle: { display: "flex", gap: 6, flexWrap: "wrap" } },
        ["all"].concat(CATS).map(function(f) {
          return h("button", { key: f, onClick: function() { setProjectFilter(f); }, className: "ltp-tap",
            style: { flexShrink: 0, whiteSpace: "nowrap", background: projectFilter === f ? B.accent : B.raised, color: projectFilter === f ? B.btnInk : B.textMut, border: "1px solid " + (projectFilter === f ? B.accent : B.border), borderRadius: isMobile ? "16px" : "4px", padding: isMobile ? "8px 16px" : "4px 12px", fontSize: isMobile ? "13px" : "11px", fontWeight: 600, cursor: "pointer", minHeight: isMobile ? 36 : undefined } }, f === "all" ? "All" : f);
        })
      ),
      showCompletedBtn
    ),

    // Sort row (both viewports).
    h("div", { style: { display: "flex", marginBottom: 14 } }, sortBtns()),

    fp.length === 0 ? h(window.EmptyState, { text: !showCompleted && projects.some(function(p) { return p.status === "completed"; }) ? "No active projects. Use \"Show Completed\" to see finished projects." : "No projects match your search." }) :
    h(window.LTPList, null,
      fp.map(function(p) {
        var comp = companies.find(function(c) { return c.id === p.companyId; });
        return h(window.LTPRow, { key: p.id, onClick: function() { setSelectedProjectId(p.id); },
          style: { borderLeft: "3px solid " + CAT_COLORS[p.category] } },
          isMobile
            ? h("div", null,
                h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 } },
                  h("div", { style: { fontSize: "15px", fontWeight: 600, color: B.text, flex: 1, minWidth: 0 } }, p.name),
                  h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexShrink: 0 } },
                    h(window.Badge, { status: CAT_KEYS[p.category] }),
                    p.status !== "upcoming" && h(window.Badge, { status: p.status }))),
                comp && h("div", { style: { fontSize: "12px", color: B.textMut, marginTop: 2 } }, comp.name),
                h("div", { style: { fontSize: "12px", color: B.textMut } }, fmt(p.startDate) + " \u2192 " + fmt(p.endDate)))
            : h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" } },
                h("div", null,
                  h("div", { style: { fontSize: "14px", fontWeight: 600, color: B.text, marginBottom: 3 } }, p.name),
                  h("div", { style: { fontSize: "11px", color: B.textMut } }, (comp ? comp.name + " \u00b7 " : "") + fmt(p.startDate) + " \u2192 " + fmt(p.endDate))),
                h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                  h(window.Badge, { status: CAT_KEYS[p.category] }),
                  p.status !== "upcoming" && h(window.Badge, { status: p.status }))));
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

    // Blocked delete: other jobs' documents still bill work for this project.
    // Deliberately offers no bulk "unlink all" — each of these belongs to
    // another project, and removing this one from it is an edit to THAT
    // document, made deliberately on it.
    sharedLinkBlock && h(window.LTPModal, { title: "Can’t delete “" + sharedLinkBlock.name + "” yet", onClose: function() { setSharedLinkBlock(null); } },
      h("p", { style: { fontSize: "12px", color: B.textSec, lineHeight: 1.6, marginBottom: 12 } },
        sharedLinkBlock.docs.length === 1
          ? "One document belonging to another project also bills work for this one. Remove this project from it first, then delete."
          : sharedLinkBlock.docs.length + " documents belonging to other projects also bill work for this one. Remove this project from each first, then delete."),
      h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 14, maxHeight: 260, overflowY: "auto" } },
        sharedLinkBlock.docs.map(function(d) {
          return h("button", { key: d.kind + d.id,
            onClick: function() { setSharedLinkBlock(null); setDeleteConfirm(null); nav((d.kind === "quote" ? "quotes/" : "invoices/") + d.id); },
            style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "6px", padding: "10px 14px", cursor: "pointer", textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, fontFamily: "inherit" },
            onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent; },
            onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
            h("span", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, d.ref),
            h("span", { style: { fontSize: "10px", color: B.accent } }, "Open " + d.kind + " →"));
        })),
      h("div", { style: { display: "flex", justifyContent: "flex-end" } },
        h(window.Btn, { variant: "ghost", onClick: function() { setSharedLinkBlock(null); } }, "Close"))),

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
