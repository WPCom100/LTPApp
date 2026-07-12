// CRM Projects — ProjectDetail + ProjectForm
(function() {
  var B = window.LTP_THEME, CATS = window.LTP_PROJECT_CATS, CAT_KEYS = window.LTP_CAT_KEYS, CAT_COLORS = window.LTP_CAT_COLORS;
  var h = React.createElement, useState = React.useState, fmt = window.LTP_formatDate, calc = window.LTP_calcDuration, ft = window.LTP_formatTime;
  // Sanitize all note HTML before render — closure-bound at module load.
  // The editor sanitizes on save too; this is defense in depth (defends
  // against legacy rows + any save-path bypass).
  var purify = function(s) { return window.LTP_SANITIZE.html(s); };

  // Private — schedule tab with draft state + validated save
  function ScheduleTab({ project, company, ctx }) {
    var schedule = project.schedule || [];
    var crew = (ctx.contacts || []).filter(function(c) { return c.isCrew; });

    return h("div", null,
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
        h("div", null,
          h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text } }, schedule.length + " schedule day" + (schedule.length !== 1 ? "s" : "")),
          h("div", { style: { fontSize: "11px", color: B.textMut, marginTop: 2 } },
            schedule.reduce(function(n, s) { return n + (s.positions || []).length; }, 0) + " positions \u00b7 " +
            schedule.reduce(function(n, s) { return n + (s.positions || []).filter(function(p) { return p.status === "confirmed"; }).length; }, 0) + " confirmed")),
        h(window.Btn, { small: true, onClick: function() { window.LTPRouter.navigate("projects/" + project.id + "/schedule"); } }, "Open Schedule Builder")),
      schedule.length === 0
        ? h(window.EmptyState, { text: "No schedule yet. Open the Schedule Builder to start planning." })
        : h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            schedule.slice().sort(function(a, b) { return (a.date + " " + (a.time || "")) > (b.date + " " + (b.time || "")) ? 1 : -1; }).map(function(s) {
              var posCount = (s.positions || []).length;
              var filled = (s.positions || []).filter(function(p) { return p.status === "confirmed"; }).length;
              var hours = window.LTP_calcHours(s.time, s.endTime);
              return h("div", { key: s.id, style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" } },
                h("div", null,
                  h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, s.title),
                  h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } },
                    fmt(s.date) + " \u00b7 " + (s.time ? ft(s.time) : "") + (s.endTime ? " \u2192 " + ft(s.endTime) : "") + (hours ? " (" + hours + "h)" : ""))),
                h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                  posCount > 0 && h("div", { style: { fontSize: "10px", color: filled === posCount ? B.success : B.textMut, fontWeight: 600 } }, filled + "/" + posCount + " crew"),
                  (s.positions || []).slice(0, 3).map(function(p) {
                    var cm = p.crewId ? ctx.contacts.find(function(c) { return c.id === p.crewId; }) : null;
                    return h("span", { key: p.id, style: { fontSize: "9px", background: cm ? B.accent + "22" : B.raised, color: cm ? B.accent : B.textMut, border: "1px solid " + (cm ? B.accent + "44" : B.border), padding: "2px 6px", borderRadius: "3px", fontWeight: 600 } }, p.role + (cm ? ": " + cm.firstName : ""));
                  }))
              );
            })
          )
    );
  }

  window.CRMProjectDetail = function({ ctx }) {
    var isMobile = window.LTP_useIsMobile();
    var project = ctx.selectedProject; if (!project) return null;
    var company = ctx.companies.find(function(c) { return c.id === project.companyId; });
    var projContacts = ctx.contacts.filter(function(c) { return project.contactIds.includes(c.id); });
    var totalBudget = Object.values(project.budget).reduce(function(a, b) { return a + b; }, 0);
    // Headline figure: once quotes exist they supersede the preliminary budget.
    var headline = window.LTP_projectHeadlineTotal(project, ctx.quotes);
    // Initial tab comes from ctx.projectOpenTab (URL-derived in projects.js, or set by
    // other callers). When it changes, update the local tab state. Local in-modal tab
    // clicks update setProjTab only — they do not navigate or clear the URL.
    var initTab = ctx.projectOpenTab || "overview";
    var [projTab, setProjTab] = useState(initTab);
    React.useEffect(function() { if (ctx.projectOpenTab) setProjTab(ctx.projectOpenTab); }, [ctx.projectOpenTab]);
    var today = new Date().toISOString().split("T")[0];
    var upcomingMeetings = project.meetings.filter(function(m) { return m.date >= today; }).sort(function(a, b) { return a.date > b.date ? 1 : -1; }).slice(0, 3);
    var recentNotes = project.notes.slice().sort(function(a, b) { return b.date > a.date ? 1 : -1; }).slice(0, 3);
    var upcomingSched = project.schedule.filter(function(s) { return s.date >= today; }).sort(function(a, b) { return (a.date + " " + (a.time || "")) > (b.date + " " + (b.time || "")) ? 1 : -1; }).slice(0, 5);
    var inp = { background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "6px 8px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", width: "100%" };
    var lbl = { fontSize: "10px", color: B.textMut, marginBottom: 2 };
    var [allCopied, setAllCopied] = useState(false);

    // Note click handler — opens viewer
    function onNoteClick(noteId) { ctx.setViewNote({ projectId: project.id, noteId: noteId }); }

    var projectQuotes = (ctx.quotes || []).filter(function(q) { return q.projectId === project.id; });
    var projectInvoices = (ctx.invoices || []).filter(function(inv) { return inv.projectId === project.id; });
    var localNav = window.LTPRouter.navigate;

    return h(window.LTPModal, { title: project.name, onClose: function() { ctx.setSelectedProjectId(null); }, wide: true },
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 } },
        h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } }, h(window.Badge, { status: CAT_KEYS[project.category] }), h(window.Badge, { status: project.status }), h("span", { style: { fontSize: "12px", color: B.textMut } }, "\u00b7"), h("span", { style: { fontSize: "12px", color: B.textSec, cursor: "pointer", textDecoration: "underline" }, onClick: function() { ctx.setSelectedProjectId(null); ctx.setSelectedCompanyId(company ? company.id : null); } }, company ? company.name : "")),
        h("div", { style: { display: "flex", gap: 6 } }, h(window.Btn, { small: true, variant: "ghost", onClick: function() { ctx.setEditProjectId(project.id); } }, "Edit"), h(window.Btn, { small: true, variant: "danger", onClick: function() { ctx.setDeleteConfirm({ type: "project", id: project.id, name: project.name }); } }, "Delete"))
      ),
      h("div", { style: { fontSize: "12px", color: B.textMut, marginBottom: 16 } }, fmt(project.startDate) + " \u2192 " + fmt(project.endDate)),
      h(window.LTPTabs, { tabs: [{ id: "overview", label: "Overview" }, { id: "notes", label: "Notes", count: project.notes.length }, { id: "schedule", label: "Schedule", count: project.schedule.length }, { id: "meetings", label: "Meetings", count: project.meetings.length }, { id: "budget", label: "Budget" }, { id: "quotes", label: "Quotes", count: projectQuotes.length }, { id: "invoices", label: "Invoices", count: projectInvoices.length }], active: projTab, onChange: setProjTab }),

      // OVERVIEW
      projTab === "overview" && h("div", null,
        h("div", { style: { display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 20 } },
          h("div", { style: { background: B.raised, borderRadius: "8px", padding: "14px" } },
            h("div", { style: { fontSize: "11px", color: B.textMut, textTransform: "uppercase", marginBottom: 4, fontWeight: 600 } }, headline.quoted ? "Total Quoted" : "Total Budget"),
            h("div", { style: { fontSize: "20px", fontWeight: 700, color: B.accent } }, "$" + Math.round(headline.total).toLocaleString()),
            headline.quoted && h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } }, "across " + headline.count + " quote" + (headline.count !== 1 ? "s" : ""))),
          h("div", { style: { background: B.raised, borderRadius: "8px", padding: "14px" } }, h("div", { style: { fontSize: "11px", color: B.textMut, textTransform: "uppercase", marginBottom: 4, fontWeight: 600 } }, "Category"), h("div", { style: { fontSize: "14px", fontWeight: 600, color: CAT_COLORS[project.category] } }, project.category)),
          h("div", { style: { background: B.raised, borderRadius: "8px", padding: "14px" } }, h("div", { style: { fontSize: "11px", color: B.textMut, textTransform: "uppercase", marginBottom: 4, fontWeight: 600 } }, "Contacts"), h("div", { style: { fontSize: "14px", fontWeight: 600, color: B.text } }, projContacts.length)),
          h("div", { style: { background: B.raised, borderRadius: "8px", padding: "14px", cursor: "pointer" }, onClick: function() { setProjTab("quotes"); } }, h("div", { style: { fontSize: "11px", color: B.textMut, textTransform: "uppercase", marginBottom: 4, fontWeight: 600 } }, "Quotes"), h("div", { style: { fontSize: "14px", fontWeight: 600, color: B.accent } }, projectQuotes.length))
        ),
        h("h4", { style: { fontSize: "12px", fontWeight: 700, color: B.textSec, margin: "0 0 8px", textTransform: "uppercase" } }, "Location"),
        (function() {
          // Same live resolution the crew emails use: the "use company address"
          // flag reads the client company's CURRENT address at render time.
          var siteAddr = project.siteUseCompanyAddress
            ? (company ? window.LTP_formatAddress(company) : "")
            : (project.siteAddress || "").trim();
          if (!project.venue && !siteAddr) {
            return h("div", { style: { fontSize: "12px", color: B.textMut, marginBottom: 16, fontStyle: "italic" } }, "No location set — add a venue or site address via Edit.");
          }
          return h("div", { style: { display: "flex", gap: 12, alignItems: "center", padding: "10px 14px", background: B.raised, borderRadius: "6px", borderLeft: "3px solid " + B.accent, marginBottom: 16 } },
            h("div", null,
              project.venue && h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text } }, project.venue),
              siteAddr && h("div", { style: { fontSize: "12px", color: B.textMut, marginTop: project.venue ? 2 : 0 } },
                siteAddr + (project.siteUseCompanyAddress ? "  ·  client company address" : ""))));
        })(),
        h("h4", { style: { fontSize: "12px", fontWeight: 700, color: B.textSec, margin: "0 0 8px", textTransform: "uppercase" } }, "Contacts"),
        projContacts.length > 0 ? projContacts.map(function(c) { return h("div", { key: c.id, style: { fontSize: "13px", color: B.textSec, marginBottom: 4, cursor: "pointer" }, onClick: function() { ctx.setSelectedProjectId(null); ctx.setEditContactId(c.id); } }, h("span", { style: { color: B.accent, textDecoration: "underline" } }, c.firstName + " " + c.lastName), " \u2014 " + c.role + " \u00b7 " + c.email); }) : h("div", { style: { fontSize: "12px", color: B.textMut, marginBottom: 8, fontStyle: "italic" } }, "No contacts assigned."),
        h("h4", { style: { fontSize: "12px", fontWeight: 700, color: B.textSec, margin: "16px 0 8px", textTransform: "uppercase" } }, "Upcoming Schedule"),
        upcomingSched.length > 0 ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 } }, upcomingSched.map(function(s) { var dur = calc(s.date, s.time, s.endDate || s.date, s.endTime); return h("div", { key: s.id, style: { display: "flex", gap: 12, alignItems: "center", padding: "8px 12px", background: B.raised, borderRadius: "6px", borderLeft: "3px solid " + B.accent } }, h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text, flex: 1 } }, s.title), h("div", { style: { fontSize: "11px", color: B.textMut } }, fmt(s.date) + " " + ft(s.time) + " \u2192 " + (s.endDate !== s.date ? fmt(s.endDate) + " " : "") + ft(s.endTime)), dur && h("div", { style: { fontSize: "11px", fontWeight: 600, color: B.accent } }, dur)); })) : h("div", { style: { fontSize: "12px", color: B.textMut, marginBottom: 8, fontStyle: "italic" } }, "No upcoming schedule items."),
        h("h4", { style: { fontSize: "12px", fontWeight: 700, color: B.textSec, margin: "8px 0 8px", textTransform: "uppercase" } }, "Upcoming Meetings"),
        upcomingMeetings.length > 0 ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 } }, upcomingMeetings.map(function(m) { return h("div", { key: m.id, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: B.raised, borderRadius: "6px", borderLeft: "3px solid " + B.info } }, h("div", null, h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, m.title), h("div", { style: { fontSize: "11px", color: B.textMut } }, fmt(m.date) + " at " + ft(m.time) + " \u00b7 " + m.attendees.length + " attendees")), m.meetLink && h("a", { href: window.LTP_safeUrl(m.meetLink), target: "_blank", rel: "noopener noreferrer", style: { fontSize: "11px", color: B.info, textDecoration: "none", fontWeight: 600 } }, "Join \u2197")); })) : h("div", { style: { fontSize: "12px", color: B.textMut, marginBottom: 8, fontStyle: "italic" } }, "No upcoming meetings."),
        h("h4", { style: { fontSize: "12px", fontWeight: 700, color: B.textSec, margin: "8px 0 8px", textTransform: "uppercase" } }, "Recent Notes"),
        recentNotes.length > 0 ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, recentNotes.map(function(n) { return h("div", { key: n.id, onClick: function() { onNoteClick(n.id); }, style: { background: B.raised, borderRadius: "6px", padding: "10px 12px", borderLeft: "3px solid " + B.accent, cursor: "pointer", transition: "all 0.15s" }, onMouseOver: function(e) { e.currentTarget.style.background = B.surface; }, onMouseOut: function(e) { e.currentTarget.style.background = B.raised; } }, h("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: 4 } }, h("span", { style: { fontSize: "11px", fontWeight: 600, color: B.accent } }, n.author), h("span", { style: { fontSize: "10px", color: B.textMut } }, fmt(n.date))), h("div", { style: { fontSize: "12px", color: B.textSec, lineHeight: 1.4, maxHeight: 60, overflow: "hidden" }, dangerouslySetInnerHTML: { __html: purify(n.text) } })); })) : h("div", { style: { fontSize: "12px", color: B.textMut, fontStyle: "italic" } }, "No notes yet.")
      ),

      // NOTES TAB — click to view, not edit
      projTab === "notes" && h("div", null,
        h("div", { style: { display: "flex", gap: 8, marginBottom: 14 } },
          h(window.Btn, { small: true, onClick: function() { ctx.setShowAddNote(project.id); } }, "+ Add Note"),
          project.notes.length > 0 && h(window.Btn, { small: true, variant: "ghost", onClick: function() { window.CRMCopyAllNotes(project); setAllCopied(true); setTimeout(function() { setAllCopied(false); }, 2000); } }, allCopied ? "\u2713 Copied All" : "Copy All"),
          project.notes.length > 0 && h(window.Btn, { small: true, variant: "ghost", onClick: function() { window.CRMPrintAllNotes(project); } }, "Print All")
        ),
        project.notes.length === 0 ? h(window.EmptyState, { text: "No notes yet." }) :
        h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } }, project.notes.map(function(n) {
          var linkedMeeting = n.linkedMeetingId ? project.meetings.find(function(m) { return m.id === n.linkedMeetingId; }) : null;
          return h("div", { key: n.id, onClick: function() { onNoteClick(n.id); }, style: { background: B.raised, borderRadius: "8px", padding: "14px", borderLeft: "3px solid " + B.accent, cursor: "pointer", transition: "all 0.15s" }, onMouseOver: function(e) { e.currentTarget.style.background = B.surface; }, onMouseOut: function(e) { e.currentTarget.style.background = B.raised; } },
            h("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: 6 } },
              h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                h("span", { style: { fontSize: "12px", fontWeight: 600, color: B.accent } }, n.author),
                linkedMeeting && h("span", { style: { fontSize: "10px", color: B.info, padding: "1px 6px", background: B.infoBg, borderRadius: "3px" } }, linkedMeeting.title)
              ),
              h("span", { style: { fontSize: "11px", color: B.textMut } }, fmt(n.date))
            ),
            h("div", { style: { fontSize: "13px", color: B.textSec, lineHeight: 1.5, maxHeight: 80, overflow: "hidden" }, dangerouslySetInnerHTML: { __html: purify(n.text) } })
          );
        }))
      ),

      // SCHEDULE TAB — draft state, validated Save button
      projTab === "schedule" && h(ScheduleTab, { project: project, company: company, ctx: ctx }),

      // MEETINGS TAB (with linked notes shown)
      projTab === "meetings" && h("div", null, h(window.Btn, { small: true, onClick: function() { ctx.setShowAddMeeting(project.id); }, style: { marginBottom: 14 } }, "+ Schedule Meeting"), project.meetings.length === 0 ? h(window.EmptyState, { text: "No meetings scheduled." }) : h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, project.meetings.map(function(m) {
        var linkedNotes = (m.linkedNoteIds || []).map(function(nid) { return project.notes.find(function(n) { return n.id === nid; }); }).filter(Boolean);
        return h("div", { key: m.id, style: { background: B.raised, borderRadius: "8px", padding: "14px" } },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: linkedNotes.length > 0 ? 8 : 0 } },
            h("div", null, h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text } }, m.title), h("div", { style: { fontSize: "11px", color: B.textMut } }, fmt(m.date) + " at " + ft(m.time) + " \u00b7 " + m.attendees.length + " attendees")),
            h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
              m.meetLink && h("a", { href: window.LTP_safeUrl(m.meetLink), target: "_blank", rel: "noopener noreferrer", style: { fontSize: "11px", color: B.info, textDecoration: "none", fontWeight: 600 } }, "Join Meet \u2197"),
              h(window.Btn, { small: true, variant: m.calSynced ? "ghost" : "primary", onClick: function() { var ae = ctx.contacts.filter(function(c) { return m.attendees.includes(c.id); }).map(function(c) { return c.email; }); var u = window.LTP_gcalUrl({ title: m.title + " \u2014 " + project.name, date: m.date, time: m.time, attendees: ae, details: "LTP Project: " + project.name }); window.open(u, "_blank"); ctx.setProjects(function(prev) { return prev.map(function(pr) { return pr.id === project.id ? Object.assign({}, pr, { meetings: pr.meetings.map(function(mt) { return mt.id === m.id ? Object.assign({}, mt, { calSynced: true }) : mt; }) }) : pr; }); }); } }, m.calSynced ? "\u2713 Synced" : "Export to GCal"))
          ),
          linkedNotes.length > 0 && h("div", { style: { marginTop: 6, padding: "6px 10px", background: B.bg, borderRadius: "4px", border: "1px solid " + B.border } },
            h("div", { style: { fontSize: "10px", color: B.textMut, fontWeight: 600, marginBottom: 4 } }, "Linked Notes:"),
            linkedNotes.map(function(n) { return h("div", { key: n.id, onClick: function() { onNoteClick(n.id); }, style: { fontSize: "11px", color: B.accent, cursor: "pointer", marginBottom: 2 } }, n.author + " \u2014 " + fmt(n.date) + ": " + (n.text.substring(0, 60).replace(/<[^>]*>/g, "")) + "..."); })
          )
        );
      }))),

      // BUDGET TAB — the preliminary breakdown stays visible for reference,
      // but once quotes exist the quoted total is the headline figure.
      projTab === "budget" && h("div", null, h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
        headline.quoted && h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", background: B.accentMuted, borderRadius: "6px", borderTop: "2px solid " + B.accent } },
          h("div", null,
            h("span", { style: { fontSize: "14px", fontWeight: 700, color: B.text } }, "Total Quoted"),
            h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } }, headline.count + " quote" + (headline.count !== 1 ? "s" : "") + " — supersedes the preliminary budget")),
          h("span", { style: { fontSize: "18px", fontWeight: 700, color: B.accent, cursor: "pointer" }, onClick: function() { setProjTab("quotes"); } }, "$" + Math.round(headline.total).toLocaleString())),
        Object.entries(project.budget).map(function(e) { return h("div", { key: e[0], style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: B.raised, borderRadius: "6px", opacity: headline.quoted ? 0.75 : 1 } }, h("span", { style: { fontSize: "13px", fontWeight: 600, color: B.text, textTransform: "capitalize" } }, e[0]), h("span", { style: { fontSize: "14px", fontWeight: 700, color: B.accent } }, "$" + e[1].toLocaleString())); }),
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", background: headline.quoted ? B.raised : B.accentMuted, borderRadius: "6px", borderTop: "2px solid " + (headline.quoted ? B.border : B.accent), opacity: headline.quoted ? 0.75 : 1 } },
          h("span", { style: { fontSize: "14px", fontWeight: 700, color: B.text } }, headline.quoted ? "Preliminary Budget Total" : "Total"),
          h("span", { style: { fontSize: "18px", fontWeight: 700, color: headline.quoted ? B.textSec : B.accent } }, "$" + totalBudget.toLocaleString())))),

      // QUOTES TAB
      projTab === "quotes" && h("div", null,
        h(window.Btn, { small: true, onClick: function() {
          window.__LTP_PREFILL_QUOTE = { projectId: project.id, companyId: project.companyId };
          ctx.setSelectedProjectId(null); localNav("quotes/new");
        }, style: { marginBottom: 14 } }, "+ Create Quote for this Project"),
        projectQuotes.length === 0
          ? h("div", { style: { fontSize: "12px", color: B.textMut, fontStyle: "italic", padding: 20, textAlign: "center" } }, "No quotes linked to this project yet.")
          : h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
              projectQuotes.map(function(qt) {
                var ref = window.LTP_QUOTE_REF ? window.LTP_QUOTE_REF(qt) : ("Q-" + qt.id);
                var tot = window.LTP_QUOTE_TOTALS ? window.LTP_QUOTE_TOTALS(qt) : { total: 0 };
                var itemCount = (qt.sections || []).reduce(function(n, s) { return n + (s.items || []).filter(function(i) { return i.type !== "note"; }).length; }, 0);
                return h("div", { key: qt.id,
                  onClick: function() { ctx.setSelectedProjectId(null); localNav("quotes/" + qt.id); },
                  style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "10px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" },
                  onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent + "44"; },
                  onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
                  h("div", null,
                    h("div", { style: { fontSize: "14px", fontWeight: 700 } },
                      h("span", { style: { color: B.accent } }, ref),
                      h("span", { style: { color: B.textMut, margin: "0 8px" } }, "\u00b7"),
                      h("span", { style: { color: B.text } }, project.name)
                    ),
                    h("div", { style: { fontSize: "11px", color: B.textMut, marginTop: 2 } }, itemCount + " line items \u00b7 " + (qt.sections || []).length + " sections \u00b7 " + fmt(qt.createdDate))
                  ),
                  h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                    h("span", { style: { fontSize: "15px", fontWeight: 700, color: B.accent } }, "$" + Math.round(tot.total).toLocaleString()),
                    h(window.Badge, { status: qt.status })
                  )
                );
              })
            )
      ),

      // INVOICES
      projTab === "invoices" && h("div", null,
        projectInvoices.length === 0
          ? h("div", { style: { fontSize: "12px", color: B.textMut, fontStyle: "italic", padding: 20, textAlign: "center" } }, "No invoices linked to this project yet.")
          : h("div", null,
              h("div", { style: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 } },
                h(window.StatCard, { label: "Paid", value: "$" + projectInvoices.filter(function(i) { return i.status === "paid"; }).reduce(function(s, i) { return s + (window.LTP_INVOICE_TOTALS(i).total || 0); }, 0).toLocaleString(), accent: B.success }),
                h(window.StatCard, { label: "Outstanding", value: "$" + projectInvoices.filter(function(i) { return i.status === "sent" || i.status === "partial"; }).reduce(function(s, i) { return s + (window.LTP_INVOICE_TOTALS(i).balance || 0); }, 0).toLocaleString(), accent: B.danger }),
                h(window.StatCard, { label: "Draft", value: projectInvoices.filter(function(i) { return i.status === "draft"; }).length })
              ),
              h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                projectInvoices.map(function(inv) {
                  var ref = window.LTP_INVOICE_REF(inv);
                  var tot = window.LTP_INVOICE_TOTALS(inv);
                  var itemCount = (inv.sections || []).reduce(function(n, s) { return n + (s.items || []).filter(function(i) { return i.type !== "note"; }).length; }, 0);
                  return h("div", { key: inv.id,
                    onClick: function() { ctx.setSelectedProjectId(null); localNav("invoices/" + inv.id); },
                    style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "10px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" },
                    onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent + "44"; },
                    onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
                    h("div", null,
                      h("div", { style: { fontSize: "14px", fontWeight: 700 } },
                        h("span", { style: { color: B.accent } }, ref)),
                      h("div", { style: { fontSize: "11px", color: B.textMut, marginTop: 2 } },
                        itemCount + " items \u00b7 " + fmt(inv.invoiceDate) + (inv.dueDate ? " \u00b7 Due: " + fmt(inv.dueDate) : ""))),
                    h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                      h("div", { style: { textAlign: "right" } },
                        h("div", { style: { fontSize: "15px", fontWeight: 700, color: B.accent } }, "$" + Math.round(tot.total).toLocaleString()),
                        tot.balance > 0 && tot.balance !== tot.total && h("div", { style: { fontSize: "10px", color: B.danger } }, "$" + Math.round(tot.balance).toLocaleString() + " due")),
                      h(window.Badge, { status: window.LTP_displayStatus(inv) }))
                  );
                })
              )
            )
      )
    );
  };

  window.CRMProjectForm = function({ ctx, initial, onSave, onClose }) {
    var [name, setName] = useState(initial ? initial.name : "");
    var [compId, setCompId] = useState(initial ? initial.companyId : null);
    var [cat, setCat] = useState(initial ? initial.category : "Rental");
    var [projStatus, setProjStatus] = useState(initial ? initial.status : "upcoming");
    var [start, setStart] = useState(initial ? initial.startDate : "");
    var [end, setEnd] = useState(initial ? initial.endDate : "");
    var [venue, setVenue] = useState(initial ? (initial.venue || "") : "");
    var [siteAddr, setSiteAddr] = useState(initial ? (initial.siteAddress || "") : "");
    var [siteUseComp, setSiteUseComp] = useState(initial ? !!initial.siteUseCompanyAddress : false);
    var [cIds, setCIds] = useState(initial ? initial.contactIds : []);
    var [budL, setBudL] = useState(initial ? initial.budget.lighting : 0);
    var [budLb, setBudLb] = useState(initial ? initial.budget.labor : 0);
    var [budR, setBudR] = useState(initial ? initial.budget.rentals : 0);
    var [budM, setBudM] = useState(initial ? initial.budget.misc : 0);

    var [schedError, setSchedError] = useState("");

    // The schedule itself is planned in the full-screen Schedule Builder
    // (#/projects/<id>/schedule) — this form no longer edits it. But the
    // project DATES are edited here, so the saved schedule is still checked
    // against the new range before saving (normalized first: rows can carry
    // a stale hidden endDate the editor never displays).
    function validateSchedule() {
      if (!start || !end) return true; // no project dates to check against
      var rows = window.LTP_normalizeScheduleRows(
        ((initial && initial.schedule) || []).filter(window.LTP_scheduleRowHasContent));
      for (var i = 0; i < rows.length; i++) {
        var s = rows[i];
        if (s.date && (s.date < start || s.date > end)) {
          setSchedError("\"" + s.title + "\" starts on " + fmt(s.date) + " which is outside the project date range (" + fmt(start) + " \u2192 " + fmt(end) + "). Widen the dates here, or move that day in the Schedule Builder first.");
          return false;
        }
        if (s.endDate && (s.endDate < start || s.endDate > end)) {
          setSchedError("\"" + s.title + "\" ends on " + fmt(s.endDate) + " which is outside the project date range (" + fmt(start) + " \u2192 " + fmt(end) + "). Widen the dates here, or move that day in the Schedule Builder first.");
          return false;
        }
      }
      setSchedError("");
      return true;
    }

    // No schedule key in the payload: the edit save merges d over the project
    // and keeps x.schedule when absent (projects.js), so the builder-managed
    // schedule is untouched; the create save defaults it to []. Crew-removal
    // notices are handled where removals can actually happen now — the
    // Schedule Builder's save.
    function doSubmit() {
      onSave({ name: name, companyId: compId, category: cat, status: projStatus, startDate: start, endDate: end,
        venue: venue, siteAddress: siteAddr, siteUseCompanyAddress: siteUseComp,
        contactIds: cIds, budget: { lighting: budL, labor: budLb, rentals: budR, misc: budM } });
    }

    function handleSaveClick() {
      if (!name.trim() || !compId) return;
      if (!validateSchedule()) return;
      doSubmit();
    }

    return h(window.LTPModal, { title: initial ? "Edit Project" : "Create Project", onClose: onClose, wide: true, disableBackdrop: true },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
        h(window.LTPInput, { label: "Project Name *", value: name, onChange: setName, placeholder: "e.g. Fall Musical 2026" }),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
          h(window.CompanySearchField, { label: "Company *", compId: compId, setCompId: setCompId, companies: ctx.companies, onClear: function() { setCIds([]); } }),
          h(window.LTPSelect, { label: "Category", value: cat, onChange: setCat, options: CATS.map(function(c) { return { value: c, label: c }; }) })
        ),
        initial && h(window.LTPSelect, { label: "Status", value: projStatus, onChange: setProjStatus, options: [{ value: "upcoming", label: "Upcoming" }, { value: "in-progress", label: "In Progress" }, { value: "completed", label: "Completed" }] }),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
          h(window.LTPInput, { label: "Start Date", value: start, onChange: setStart, type: "date" }),
          h(window.LTPInput, { label: "End Date", value: end, onChange: setEnd, type: "date" })
        ),
        // Site / location — sent to crew with shift requests and shown on their
        // public call sheet. The checkbox derives the address from the client
        // company's billing address LIVE (resolved at send time), so a company
        // address update flows to future sends without re-saving the project.
        (function() {
          var comp = siteUseComp && compId ? (ctx.companies || []).find(function(c) { return c.id === compId; }) : null;
          var compAddr = comp ? [comp.address, [comp.city, [comp.state, comp.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(", ").replace(/\n/g, ", ") : "";
          return h("div", null,
            h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
              h(window.LTPInput, { label: "Venue Name", value: venue, onChange: setVenue, placeholder: "e.g. Moody Center" }),
              siteUseComp
                ? h("div", null,
                    h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 2, fontWeight: 600 } }, "Site Address"),
                    h("div", { style: { background: B.bg, border: "1px dashed " + B.border, borderRadius: "6px", padding: "7px 10px", fontSize: "11px", color: compAddr ? B.textSec : B.textMut, fontStyle: compAddr ? "normal" : "italic", minHeight: 30 } },
                      compAddr || (compId ? "No address on the company record yet." : "Pick a company above first.")))
                : h(window.LTPInput, { label: "Site Address", value: siteAddr, onChange: setSiteAddr, placeholder: "Street, city, state — sent to crew with requests" })),
            h("label", { style: { display: "flex", gap: 6, alignItems: "center", marginTop: 6, cursor: "pointer", fontSize: "11px", color: B.textSec, width: "fit-content" } },
              h("input", { type: "checkbox", checked: siteUseComp, onChange: function(e) { setSiteUseComp(e.target.checked); }, style: { cursor: "pointer" } }),
              "Use the client company's address as the site address"));
        })(),
        h(window.SearchSelect, { label: "Project Contacts", items: ctx.contacts, selectedIds: cIds, onChange: setCIds, nameField: function(c) { return c.firstName + " " + c.lastName; } }),
        h("h4", { style: { fontSize: "12px", fontWeight: 700, color: B.textSec, margin: "8px 0 0", textTransform: "uppercase" } }, "Preliminary Budget"),
        h("div", { style: { display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: 10 } },
          h(window.LTPInput, { label: "Lighting", value: budL, onChange: function(v) { setBudL(Number(v) || 0); }, type: "number" }),
          h(window.LTPInput, { label: "Labor", value: budLb, onChange: function(v) { setBudLb(Number(v) || 0); }, type: "number" }),
          h(window.LTPInput, { label: "Rentals", value: budR, onChange: function(v) { setBudR(Number(v) || 0); }, type: "number" }),
          h(window.LTPInput, { label: "Misc", value: budM, onChange: function(v) { setBudM(Number(v) || 0); }, type: "number" })
        ),
        // Schedule hand-off — planning lives in the full-screen Schedule
        // Builder, not this form (the inline editor here was redundant).
        h("h4", { style: { fontSize: "12px", fontWeight: 700, color: B.textSec, margin: "8px 0 0", textTransform: "uppercase" } }, "Schedule"),
        initial
          ? (function() {
              var rows = (initial.schedule || []).filter(window.LTP_scheduleRowHasContent);
              var posCount = rows.reduce(function(n, s) { return n + (s.positions || []).length; }, 0);
              return h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "10px 14px" } },
                h("div", null,
                  h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } },
                    rows.length + " schedule day" + (rows.length !== 1 ? "s" : "") + (posCount ? " · " + posCount + " position" + (posCount !== 1 ? "s" : "") : "")),
                  h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } },
                    "Days, times, and crew are planned in the full-screen Schedule Builder.")),
                h(window.Btn, { small: true, variant: "ghost", onClick: function() { window.LTPRouter.navigate("projects/" + initial.id + "/schedule"); } }, "Open Schedule Builder"));
            })()
          : h("div", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic" } },
              "Create the project first — then plan its days in the full-screen Schedule Builder."),
        schedError && h("div", { style: { fontSize: "12px", color: B.danger, padding: "8px 12px", background: B.dangerBg, borderRadius: "6px", border: "1px solid " + B.dangerBd } }, schedError),
        h(window.Btn, { onClick: handleSaveClick }, initial ? "Save Changes" : "Create Project")
      )
    );
  };
})();
