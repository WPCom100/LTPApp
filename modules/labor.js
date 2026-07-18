// ═══════════════════════════════════════════════════════════════════════════
//   LABOR MODULE — reads positions from project schedules
// ═══════════════════════════════════════════════════════════════════════════
(function() {
  "use strict";
  var h = React.createElement, B = window.LTP_THEME;
  var useState = React.useState, useMemo = React.useMemo;
  var nav = window.LTPRouter.navigate;
  var fmt = window.LTP_formatDate, ft = window.LTP_formatTime;
  var genId = window.LTP_genId, todayISO = window.LTP_todayISO;
  var calcHours = window.LTP_calcHours;

  var POS_STATUSES = { open: { label: "Open", color: B.textMut }, requested: { label: "Requested", color: B.warn }, accepted: { label: "Accepted", color: B.success }, declined: { label: "Declined", color: B.danger }, confirmed: { label: "Confirmed", color: B.info } };

  // ── Aggregate positions from all project schedules ─────────────────────
  function aggregatePositions(projects, contacts, services) {
    var all = [];
    (projects || []).forEach(function(proj) {
      // Group schedule items by date for day-level info
      var dateGroups = {};
      (proj.schedule || []).forEach(function(s) {
        var d = s.date || "_unscheduled";
        if (!dateGroups[d]) dateGroups[d] = { date: d, items: [], dayCall: null, dayWrap: null };
        var g = dateGroups[d];
        g.items.push(s);
        if (s.time && (!g.dayCall || s.time < g.dayCall)) g.dayCall = s.time;
        if (s.endTime && (!g.dayWrap || s.endTime > g.dayWrap)) g.dayWrap = s.endTime;
      });

      // Person-slot per role per DAY (same identity model the schedule editor
      // and billing use): needed to tell "L1 #1" from "L1 #2" when a role has
      // several people, so the right person lands in the right slot.
      var dayRoleCounts = {};   // date → { serviceId: count across the day }
      Object.keys(dateGroups).forEach(function(dk) {
        var counts = {};
        dateGroups[dk].items.forEach(function(it) {
          (it.positions || []).forEach(function(p) { if (p.serviceId) counts[p.serviceId] = (counts[p.serviceId] || 0) + 1; });
        });
        dayRoleCounts[dk] = counts;
      });

      (proj.schedule || []).forEach(function(s) {
        // An unscheduled day (no date) is not a real, assignable shift: a crew
        // member can't be booked — or sent an availability request — for a day
        // with no date. Skip its positions entirely so they never surface on any
        // Labor tab or in the send-request selection, even when crew is attached.
        if (!s.date) return;
        var dg = dateGroups[s.date || "_unscheduled"];
        var slots = window.LTP_effectiveSlots(s.positions);
        (s.positions || []).forEach(function(p) {
          var svc = p.serviceId ? (services || []).find(function(sv) { return sv.id === p.serviceId; }) : null;
          var cm = p.crewId ? (contacts || []).find(function(c) { return c.id === p.crewId; }) : null;
          all.push({
            projectId: proj.id, projectName: proj.name, companyId: proj.companyId,
            schedItemId: s.id, schedTitle: s.title,
            date: s.date, callTime: s.time, endTime: s.endTime,
            dayCall: dg ? dg.dayCall : s.time, dayWrap: dg ? dg.dayWrap : s.endTime,
            posId: p.id, role: p.role, serviceId: p.serviceId,
            slot: slots[p.id] || 1,
            dayRoleCount: (dayRoleCounts[s.date] || {})[p.serviceId] || 0,
            crewId: p.crewId, status: p.status,
            svcName: svc ? svc.role + " — " + svc.description : (p.role || "?"),
            dept: svc ? svc.department : "",
            crewName: cm ? cm.firstName + " " + cm.lastName : null,
          });
        });
      });
    });
    all.sort(function(a, b) { return (a.date + " " + (a.callTime || "")) > (b.date + " " + (b.callTime || "")) ? 1 : -1; });
    return all;
  }

  // ── Update a position on a project schedule ────────────────────────────
  function updatePosition(setProjects, projectId, schedItemId, posId, patch) {
    setProjects(function(prev) {
      return prev.map(function(p) {
        if (p.id !== projectId) return p;
        return Object.assign({}, p, { schedule: (p.schedule || []).map(function(s) {
          if (s.id !== schedItemId) return s;
          return Object.assign({}, s, { positions: (s.positions || []).map(function(pos) {
            if (pos.id !== posId) return pos;
            return Object.assign({}, pos, patch);
          })});
        })});
      });
    });
  }

  // Optimistically move a set of positions to a status locally, only when they're
  // currently at `fromStatus`. Mirrors what the server already did (send/withdraw
  // mutate positions server-side); keeps the UI in sync without a project refetch.
  // Same-result writes converge with the debounced PUT.
  function flipPositionsLocal(setProjects, projectId, posIds, fromStatus, toStatus, clearCrew) {
    var idSet = {}; (posIds || []).forEach(function(id) { idSet[id] = true; });
    setProjects(function(prev) {
      return prev.map(function(proj) {
        if (projectId != null && proj.id !== projectId) return proj;
        return Object.assign({}, proj, { schedule: (proj.schedule || []).map(function(s) {
          return Object.assign({}, s, { positions: (s.positions || []).map(function(pos) {
            if (idSet[pos.id] && pos.status === fromStatus) {
              var patch = { status: toStatus };
              if (clearCrew) patch.crewId = null;
              return Object.assign({}, pos, patch);
            }
            return pos;
          }) });
        }) });
      });
    });
  }

  // Reconcile crew-request answers (accepted/declined) into local position
  // statuses, advancing positions still at "requested" — or at "open", which
  // under an answered request with the SAME crew member still assigned can only
  // be drift from a stale save that reverted the send (the backend heals the
  // same way; see crew_integrity._STATUS_FLOOR). Producer settlements are never
  // disturbed: confirmed positions are above both statuses, and released /
  // reassigned slots fail the crewId match. The app doesn't poll `projects` for
  // inbound server changes, so this bridges a crew member's accept/decline
  // (written server-side to the position status) into the grouped view without
  // a full reload.
  function reconcileFromRequests(setProjects, reqs) {
    var byProject = {};
    (reqs || []).forEach(function(r) {
      var target = r.status === "accepted" ? "accepted" : (r.status === "declined" ? "declined" : null);
      if (!target) return;
      byProject[r.projectId] = byProject[r.projectId] || {};
      // Keep the request's crew member with the answer so we only apply it to a
      // position STILL assigned to them — a reassigned position must not inherit
      // the previous person's accept/decline.
      (r.positionIds || []).forEach(function(pid) { byProject[r.projectId][pid] = { target: target, crewId: r.contactId }; });
    });
    if (Object.keys(byProject).length === 0) return;
    setProjects(function(prev) {
      var changed = false;
      var next = prev.map(function(proj) {
        var map = byProject[proj.id];
        if (!map) return proj;
        return Object.assign({}, proj, { schedule: (proj.schedule || []).map(function(s) {
          return Object.assign({}, s, { positions: (s.positions || []).map(function(pos) {
            var entry = map[pos.id];
            if (entry && (pos.status === "requested" || pos.status === "open") && pos.crewId === entry.crewId) { changed = true; return Object.assign({}, pos, { status: entry.target }); }
            return pos;
          }) });
        }) });
      });
      return changed ? next : prev;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   CREW ROSTER TAB
  // ═══════════════════════════════════════════════════════════════════════════
  function CrewRoster({ contacts, setContacts, services, allPositions, settings }) {
    var isMobile = window.LTP_useIsMobile();
    var [search, setSearch] = useState("");
    var [deptFilter, setDeptFilter] = useState("all");
    var [editingCrew, setEditingCrew] = useState(null);
    var [crewDlg, setCrewDlg] = useState(null);
    var [customRole, setCustomRole] = useState("");
    var crew = contacts.filter(function(c) { return c.isCrew; });
    var q = search.toLowerCase();

    var departments = ["all"];
    crew.forEach(function(c) { (c.crewDepartments || []).forEach(function(d) { if (departments.indexOf(d) === -1) departments.push(d); }); });

    var filtered = crew.filter(function(c) {
      if (deptFilter !== "all" && (c.crewDepartments || []).indexOf(deptFilter) === -1) return false;
      if (q) {
        var hay = (c.firstName + " " + c.lastName + " " + (c.crewNotes || "") + " " + (c.crewRoles || []).join(" ")).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    function upcomingShifts(crewId) {
      var today = todayISO();
      return allPositions.filter(function(p) { return p.crewId === crewId && p.date >= today && (p.status === "accepted" || p.status === "confirmed"); }).length;
    }

    if (editingCrew) {
      var isNew = !editingCrew.id;
      var f = editingCrew;
      function set(k, v) { setEditingCrew(Object.assign({}, f, (function() { var o = {}; o[k] = v; return o; })())); }
      function saveCrew() {
        if (!f.firstName || !f.lastName) return;
        if (!isNew && f.crewStatus === "inactive") {
          var activePos = allPositions.filter(function(p) { return p.crewId === f.id && (p.status === "requested" || p.status === "accepted" || p.status === "confirmed"); });
          if (activePos.length > 0) {
            setCrewDlg({
              title: "Deactivate " + f.firstName + " " + f.lastName + "?",
              message: "This crew member has " + activePos.length + " active position" + (activePos.length > 1 ? "s" : "") + ". Setting to inactive will not remove existing assignments. Address them in the Labor module's Assignments tab.",
              confirmLabel: "Deactivate Anyway",
              onConfirm: function() { doSaveCrew(); setCrewDlg(null); }
            });
            return;
          }
        }
        doSaveCrew();
      }
      function doSaveCrew() {
        if (isNew) {
          var maxId = Math.max.apply(null, contacts.map(function(c) { return c.id; }).concat([0]));
          setContacts(function(prev) { return prev.concat([Object.assign({}, f, { id: maxId + 1, isCrew: true, companyIds: f.companyIds || [] })]); });
        } else {
          setContacts(function(prev) { return prev.map(function(c) { return c.id === f.id ? f : c; }); });
        }
        setEditingCrew(null);
      }
      return h("div", null,
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
          h("h3", { style: { fontSize: "15px", fontWeight: 700, color: B.text, margin: 0 } }, isNew ? "Add Crew Member" : "Edit Crew Member"),
          h("div", { style: { display: "flex", gap: 8 } },
            h(window.Btn, { small: true, variant: "ghost", onClick: function() { setEditingCrew(null); } }, "Cancel"),
            h(window.Btn, { small: true, onClick: saveCrew }, "Save"))),
        h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: 16 } },
          h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
            h(window.LTPInput, { label: "First Name *", value: f.firstName || "", onChange: function(v) { set("firstName", v); } }),
            h(window.LTPInput, { label: "Last Name *", value: f.lastName || "", onChange: function(v) { set("lastName", v); } }),
            h(window.LTPInput, { label: "Email", value: f.email || "", onChange: function(v) { set("email", v); }, type: "email",
              validate: function(v) { return v && !window.LTP_isValidEmail(v) ? "Enter a valid email" : null; } }),
            h(window.LTPInput, { label: "Phone", value: f.phone || "", onChange: function(v) { set("phone", v); },
              validate: function(v) { return v && !window.LTP_isValidPhone(v) ? "Enter a valid phone" : null; },
              onBlur: function() { if (f.phone) set("phone", window.LTP_formatPhone(f.phone)); } }),
            h(window.LTPInput, { label: "Role / Title", value: f.role || "", onChange: function(v) { set("role", v); } })),
          h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 } },
            // Departments — toggle tags
            h("div", null,
              h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 6, fontWeight: 600 } }, "Departments"),
              h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
                (settings.crewDepartmentOptions || ["Lighting", "Audio", "Video", "Stage", "Rigging", "Production"]).map(function(d) {
                  var active = (f.crewDepartments || []).indexOf(d) !== -1;
                  return h("button", { key: d, onClick: function() {
                    var cur = f.crewDepartments || [];
                    set("crewDepartments", active ? cur.filter(function(x) { return x !== d; }) : cur.concat([d]));
                  }, style: { background: active ? window.LTP_deptColor(d) + "22" : B.bg, color: active ? window.LTP_deptColor(d) : B.textMut, border: "1px solid " + (active ? window.LTP_deptColor(d) + "55" : B.border), borderRadius: "4px", padding: "3px 10px", fontSize: "10px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" } }, d);
                })
              )),
            // Roles — toggle tags. Options merge the Settings list with every
            // role on the labor rate card and any custom roles already on this
            // person, so a rate-card role like "A1 FUMC" is assignable here
            // without first adding it in Settings.
            function() {
              var roleOptions = (settings.crewRoleOptions || ["L1", "L2", "L3", "A1", "A2", "V1", "RIG", "PM"]).slice();
              (services || []).forEach(function(s) { if (s.role && roleOptions.indexOf(s.role) === -1) roleOptions.push(s.role); });
              (f.crewRoles || []).forEach(function(r) { if (roleOptions.indexOf(r) === -1) roleOptions.push(r); });
              function addCustomRole() {
                var v = customRole.trim();
                if (!v) return;
                if ((f.crewRoles || []).indexOf(v) === -1) set("crewRoles", (f.crewRoles || []).concat([v]));
                setCustomRole("");
              }
              return h("div", null,
                h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 6, fontWeight: 600 } }, "Roles"),
                h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
                  roleOptions.map(function(r) {
                    var active = (f.crewRoles || []).indexOf(r) !== -1;
                    return h("button", { key: r, onClick: function() {
                      var cur = f.crewRoles || [];
                      set("crewRoles", active ? cur.filter(function(x) { return x !== r; }) : cur.concat([r]));
                    }, style: { background: active ? B.accent + "22" : B.bg, color: active ? B.accent : B.textMut, border: "1px solid " + (active ? B.accent + "55" : B.border), borderRadius: "4px", padding: "3px 10px", fontSize: "10px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" } }, r);
                  })
                ),
                h("div", { style: { display: "flex", gap: 4, marginTop: 6 } },
                  h("input", { type: "text", value: customRole, placeholder: "Custom role…",
                    onChange: function(e) { setCustomRole(e.target.value); },
                    onKeyDown: function(e) { if (e.key === "Enter") { e.preventDefault(); addCustomRole(); } },
                    style: { flex: 1, maxWidth: 160, background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 8px", color: B.text, fontSize: "10px", fontFamily: "inherit", outline: "none" } }),
                  h("button", { onClick: addCustomRole,
                    style: { background: B.accent, border: "none", borderRadius: "4px", padding: "3px 10px", color: B.btnInk, fontSize: "10px", fontWeight: 700, cursor: "pointer" } }, "+"))
              );
            }()),
          h("div", { style: { marginTop: 12 } },
            h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4, fontWeight: 600 } }, "Notes"),
            h("textarea", { value: f.crewNotes || "", onChange: function(e) { set("crewNotes", e.target.value); },
              placeholder: "Skills, certifications, preferences, gear they own\u2026",
              style: { width: "100%", minHeight: 60, background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", resize: "vertical" } })),
          h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12, alignItems: "start" } },
            h(window.LTPSelect, { label: "Status", value: f.crewStatus || "active", onChange: function(v) { set("crewStatus", v); },
              options: [{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }] }),
            h("div", null,
              h(window.LTPInput, { label: "Minimum Day Rate ($)", value: f.minDayCost || 0, onChange: function(v) { set("minDayCost", Number(v) || 0); }, type: "number" }),
              h("div", { style: { fontSize: "9px", color: B.textMut, marginTop: 3, lineHeight: 1.4 } },
                "Negotiated payout floor — we pay at least this per day when the assigned role costs less. Not billed to the client. Leave 0 for none."))),
        ),

        crewDlg && h(window.LTPModal, { title: crewDlg.title, onClose: function() { setCrewDlg(null); } },
          h("p", { style: { fontSize: "12px", color: B.textSec, marginBottom: 16, lineHeight: 1.5 } }, crewDlg.message),
          h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
            h(window.Btn, { variant: "ghost", onClick: function() { setCrewDlg(null); } }, "Cancel"),
            h(window.Btn, { variant: "danger", onClick: crewDlg.onConfirm }, crewDlg.confirmLabel))
        )
      );
    }

    return h("div", null,
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
        h("h3", { style: { fontSize: "15px", fontWeight: 700, color: B.text, margin: 0 } }, "Crew Roster (" + crew.length + ")"),
        h(window.Btn, { small: true, onClick: function() { setCustomRole(""); setEditingCrew({ firstName: "", lastName: "", email: "", phone: "", role: "", crewDepartments: [], crewRoles: [], crewNotes: "", crewStatus: "active", minDayCost: 0, isCrew: true, companyIds: [] }); } }, "+ Add Crew")),
      h("div", { style: { display: "flex", gap: 8, marginBottom: 14, alignItems: "center" } },
        departments.map(function(d) {
          return h("button", { key: d, onClick: function() { setDeptFilter(d); },
            style: { background: deptFilter === d ? B.accent : B.raised, color: deptFilter === d ? B.btnInk : B.textMut, border: "1px solid " + (deptFilter === d ? B.accent : B.border), borderRadius: "4px", padding: "4px 12px", fontSize: "11px", fontWeight: 600, cursor: "pointer", textTransform: "capitalize" } }, d);
        }),
        h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search crew\u2026",
          style: { flex: 1, maxWidth: 250, background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "5px 12px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none" } })
      ),
      h(window.LTPList, null,
        filtered.length === 0 && h(window.EmptyState, { text: "No crew members found." }),
        filtered.map(function(c) {
          var shifts = upcomingShifts(c.id);
          return h(window.LTPRow, { key: c.id, onClick: function() { setCustomRole(""); setEditingCrew(Object.assign({}, c)); },
            style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
            h("div", null,
              h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text } }, c.firstName + " " + c.lastName),
              h("div", { style: { fontSize: "11px", color: B.textMut, marginTop: 2 } },
                (c.crewRoles || []).join(", ") + (!isMobile && shifts > 0 ? " \u00b7 " + shifts + " upcoming" : "") + (c.minDayCost > 0 ? " \u00b7 min $" + Math.round(c.minDayCost) : "")),
              h("div", { style: { display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 } },
                c.crewNotes && h("div", { style: { fontSize: "10px", color: B.textMut, fontStyle: "italic", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, c.crewNotes))),
            h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexShrink: 0 } },
              // Mobile swaps the department chips for tap-to-call / tap-to-email
              // (the chips are visible when the row is tapped open to edit).
              isMobile
                ? [ h(window.LTPCallBtn, { key: "call", phone: c.phone, name: c.firstName + " " + c.lastName }),
                    h(window.LTPMailBtn, { key: "mail", email: c.email, name: c.firstName + " " + c.lastName }) ]
                : (c.crewDepartments || []).map(function(d) {
                    return h("span", { key: d, style: { fontSize: "10px", color: window.LTP_deptColor(d), background: window.LTP_deptColor(d) + "22", border: "1px solid " + window.LTP_deptColor(d) + "44", padding: "2px 6px", borderRadius: "3px", fontWeight: 600 } }, d);
                  }),
              h(window.Badge, { status: c.crewStatus || "active" }))
          );
        }))
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   MANUAL SHIFT MODAL — one-off adder for labor not tied to a client project
  // ═══════════════════════════════════════════════════════════════════════════
  // Warehouse load-outs, prep days, and other work that "doesn't fall into a
  // project" still need crew requests and payouts. Rather than the full schedule
  // editor, this is a single-screen adder: name + one day + roles (and optional
  // crew). It builds an "internal" project (window.LTP_manualShiftProject) — the
  // same Project + schedule shape everything else reads — so the new shift flows
  // straight into Assignments, crew requests, and Payouts with no special-casing.
  function ManualShiftModal({ services, contacts, onSave, onClose, editProject }) {
    var isMobile = window.LTP_useIsMobile();
    // Edit mode: prefill from an existing internal (manual-shift) project. Only
    // the shift's times/date/name/location/notes are editable here — roles and
    // crew are managed on the Assignments tab, so editShift.positions is left
    // untouched (its ids/crew/status survive, and so do any crew requests).
    var editing = !!editProject;
    var editShift = editing ? ((editProject.schedule && editProject.schedule[0]) || {}) : {};
    var [title, setTitle] = useState(editing ? (editProject.name || editShift.title || "") : "");
    var [date, setDate] = useState(editing ? (editShift.date || editProject.startDate || "") : todayISO());
    var [start, setStart] = useState(editing ? (editShift.time || "08:00") : "08:00");
    var [end, setEnd] = useState(editing ? (editShift.endTime || "18:00") : "18:00");
    var [location, setLocation] = useState(editing ? (editProject.siteAddress || "") : "");
    var [notes, setNotes] = useState(editing ? (editProject.scheduleNotes || "") : "");
    // Position rows — each is a role (rate-card Service) + optional crew member.
    var [rows, setRows] = useState([{ serviceId: "", crewId: "" }]);
    // Crew-wide meal breaks on the shift (same {id,startTime,endTime,type} shape
    // the schedule editor uses). Editable in both create and edit modes — unpaid
    // breaks are deducted from paid hours in Payouts. Prefilled when editing.
    var [breaks, setBreaks] = useState(editing
      ? (editShift.breaks || []).map(function(b) { return { id: b.id || genId("brk"), startTime: b.startTime || "12:00", endTime: b.endTime || "13:00", type: b.type === "paid" ? "paid" : "unpaid" }; })
      : []);
    var [err, setErr] = useState("");
    // Crew already committed to this shift (edit mode) — a heads-up that saving a
    // time/date change queues them to be re-notified.
    var editCommitted = (editShift.positions || []).filter(function(p) {
      return p.crewId && (p.status === "requested" || p.status === "accepted" || p.status === "confirmed");
    });

    var crew = (contacts || []).filter(function(c) { return c.isCrew && c.crewStatus === "active"; })
      .sort(function(a, b) { return ((a.firstName || "") + (a.lastName || "")).localeCompare((b.firstName || "") + (b.lastName || "")); });
    var svcs = (services || []).slice().sort(function(a, b) { return (a.role || "").localeCompare(b.role || ""); });

    function updateRow(i, patch) { setRows(function(rs) { return rs.map(function(r, j) { return j === i ? Object.assign({}, r, patch) : r; }); }); }
    function addRow() { setRows(function(rs) { return rs.concat([{ serviceId: "", crewId: "" }]); }); }
    function removeRow(i) { setRows(function(rs) { return rs.length > 1 ? rs.filter(function(_, j) { return j !== i; }) : rs; }); }

    function addBreak() { setBreaks(function(bs) { return bs.concat([{ id: genId("brk"), startTime: "12:00", endTime: "13:00", type: "unpaid" }]); }); }
    function updateBreak(i, patch) { setBreaks(function(bs) { return bs.map(function(b, j) { return j === i ? Object.assign({}, b, patch) : b; }); }); }
    function removeBreak(i) { setBreaks(function(bs) { return bs.filter(function(_, j) { return j !== i; }); }); }

    // Crew tagged with the row's role float to the top (like the schedule editor),
    // but everyone stays selectable so an untagged role is never unassignable.
    function crewOptionsFor(serviceId) {
      var sv = serviceId ? svcs.find(function(s) { return s.id === Number(serviceId); }) : null;
      var roleCode = sv ? sv.role : "";
      var tagged = [], others = [];
      crew.forEach(function(c) {
        if (roleCode && (c.crewRoles || []).indexOf(roleCode) !== -1) tagged.push(c); else others.push(c);
      });
      var toOpt = function(c) { return { value: String(c.id), label: (c.firstName + " " + c.lastName).trim() }; };
      var opts = [{ value: "", label: "Unassigned" }];
      if (tagged.length && others.length) {
        return opts.concat(tagged.map(toOpt)).concat([{ value: "__sep", label: "— other crew —" }]).concat(others.map(toOpt));
      }
      return opts.concat(crew.map(toOpt));
    }

    function handleSave() {
      if (!title.trim()) { setErr("Give the shift a name."); return; }
      if (!date) { setErr("Pick a date for the shift."); return; }
      if (!(end > start)) { setErr("End time must be after start time. For overnight shifts, use a project's schedule builder."); return; }
      if (breaks.some(function(b) { return !(b.endTime > b.startTime); })) { setErr("Each break's end time must be after its start time."); return; }
      setErr("");
      var cleanBreaks = breaks.map(function(b) { return { id: b.id || genId("brk"), startTime: b.startTime, endTime: b.endTime, type: b.type === "paid" ? "paid" : "unpaid" }; });
      if (editing) {
        // Roles/crew aren't touched here — only the shift's scalar fields + breaks.
        onSave({ title: title.trim(), date: date, startTime: start, endTime: end,
          location: location.trim(), notes: notes.trim(), breaks: cleanBreaks });
        return;
      }
      var positions = rows.filter(function(r) { return r.serviceId; }).map(function(r) {
        var sv = svcs.find(function(s) { return s.id === Number(r.serviceId); });
        return { serviceId: Number(r.serviceId), role: sv ? sv.role : "", crewId: (r.crewId && r.crewId !== "__sep") ? Number(r.crewId) : null };
      });
      if (!positions.length) { setErr("Add at least one role."); return; }
      onSave({ title: title.trim(), date: date, startTime: start, endTime: end,
        location: location.trim(), notes: notes.trim(), breaks: cleanBreaks, positions: positions });
    }

    var half = { display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12 };
    return h(window.LTPModal, { title: editing ? "Edit Manual Shift" : "Add Manual Shift", onClose: onClose, wide: true, disableBackdrop: true },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
        h("div", { style: { fontSize: "11px", color: B.textMut, lineHeight: 1.5 } },
          editing
            ? "Adjust this one-off shift's date, time, or details. Roles and crew stay on the Assignments tab — any crew already committed are queued to be re-notified (in the notify tray) when you save a time or date change."
            : "A one-off shift for labor not tied to a client project (e.g. warehouse work). It joins crew requests and payouts like any other shift — no schedule editor needed."),
        h(window.LTPInput, { label: "Shift Name *", value: title, onChange: setTitle, placeholder: "e.g. Warehouse Load-out" }),
        h("div", { style: half },
          h(window.LTPInput, { label: "Date *", value: date, onChange: setDate, type: "date" }),
          h(window.LTPInput, { label: "Location", value: location, onChange: setLocation, placeholder: "Job-site address (optional)" })
        ),
        h("div", { style: half },
          h(window.LTPInput, { label: "Start Time", value: start, onChange: setStart, type: "time" }),
          h(window.LTPInput, { label: "End Time", value: end, onChange: setEnd, type: "time" })
        ),
        // Heads-up (edit mode) when crew are already committed to this shift.
        editing && editCommitted.length > 0 && h("div", { style: { fontSize: "10px", color: B.warn, background: B.warn + "14", border: "1px solid " + B.warn + "44", borderRadius: "4px", padding: "6px 8px", display: "flex", alignItems: "center", gap: 6 } },
          h("span", { style: { fontWeight: 700, flexShrink: 0 } }, "⚠"),
          h("span", null, editCommitted.length + " committed crew member" + (editCommitted.length > 1 ? "s" : "") + " on this shift — changing the date or time will queue a re-notification when you save.")),
        // Meal breaks — crew-wide, editable in both create and edit. Same
        // {id,startTime,endTime,type} shape the schedule editor uses; unpaid
        // breaks are deducted from paid hours in Payouts.
        h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
          h("label", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Meal Breaks"),
          h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
            breaks.map(function(brk, i) {
              var isPaid = brk.type === "paid";
              var tInp = { background: B.bg, border: "1px solid " + B.border, borderRadius: "3px", padding: "2px 4px", color: B.text, fontSize: "10px", fontFamily: "inherit", outline: "none", width: 110 };
              return h("div", { key: brk.id, style: { display: "inline-flex", gap: 4, alignItems: "center", background: isPaid ? B.accent + "11" : B.surface, border: "1px solid " + (isPaid ? B.accent + "44" : B.border), borderRadius: "4px", padding: "3px 6px" } },
                h("button", { type: "button", onClick: function() { updateBreak(i, { type: isPaid ? "unpaid" : "paid" }); }, title: "Toggle paid / unpaid",
                  style: { background: isPaid ? B.accent : B.raised, color: isPaid ? B.btnInk : B.textMut, border: "none", borderRadius: "3px", padding: "1px 5px", fontSize: "8px", fontWeight: 700, cursor: "pointer" } }, isPaid ? "PAID" : "UNPAID"),
                h("input", { type: "time", value: brk.startTime, onChange: function(e) { updateBreak(i, { startTime: e.target.value }); }, style: tInp }),
                h("span", { style: { color: B.textMut, fontSize: "10px" } }, "→"),
                h("input", { type: "time", value: brk.endTime, onChange: function(e) { updateBreak(i, { endTime: e.target.value }); }, style: tInp }),
                h("button", { type: "button", onClick: function() { removeBreak(i); }, "aria-label": "Remove break",
                  style: { background: "transparent", border: "none", color: B.textMut, cursor: "pointer", fontSize: "12px", padding: "0 2px", lineHeight: 1 } }, "×")
              );
            }),
            h("button", { type: "button", onClick: addBreak,
              style: { background: "transparent", border: "1px dashed " + B.border, borderRadius: "4px", padding: "3px 8px", color: B.textMut, cursor: "pointer", fontSize: "10px", fontWeight: 600 } }, "+ Break")
          ),
          h("div", { style: { fontSize: "10px", color: B.textMut } }, "Unpaid breaks are deducted from paid hours in Payouts.")
        ),
        // Roles / crew — editable when creating, read-only summary when editing
        // (crew are managed on the Assignments tab, so a time edit never disturbs them).
        editing
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
              h("label", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Roles & Crew"),
              (editShift.positions || []).length === 0
                ? h("div", { style: { fontSize: "11px", color: B.textMut } }, "No roles on this shift yet.")
                : h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                    (editShift.positions || []).map(function(p, i) {
                      var sv = svcs.find(function(s) { return s.id === Number(p.serviceId); });
                      var roleName = sv ? (sv.role + (sv.description ? " — " + sv.description : "")) : (p.role || "Role");
                      var cm = p.crewId ? contacts.find(function(c) { return c.id === p.crewId; }) : null;
                      var crewName = cm ? (cm.firstName + " " + cm.lastName).trim() : "Unassigned";
                      return h("div", { key: i, style: { fontSize: "11px", color: B.text, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
                        h("span", { style: { fontWeight: 600 } }, roleName),
                        h("span", { style: { color: B.textMut } }, "— " + crewName),
                        p.status && p.status !== "open" && h("span", { style: { fontSize: "9px", color: B.textMut, textTransform: "capitalize" } }, "(" + p.status + ")"));
                    })
                  ),
              h("div", { style: { fontSize: "10px", color: B.textMut, fontStyle: "italic" } }, "Manage roles and crew on the Assignments tab.")
            )
          : h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
              h("label", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Roles *"),
              svcs.length === 0 && h("div", { style: { fontSize: "11px", color: B.warn } }, "No labor rate-card roles exist yet — add roles under Quotes › Services first."),
              rows.map(function(r, i) {
                return h("div", { key: i, style: { display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr auto" : "1.2fr 1fr auto", gap: 8, alignItems: "end" } },
                  h(window.LTPSelect, { label: i === 0 ? "Role" : "", value: r.serviceId, onChange: function(v) { updateRow(i, { serviceId: v }); },
                    options: [{ value: "", label: "Select role…" }].concat(svcs.map(function(s) { return { value: String(s.id), label: s.role + (s.description ? " — " + s.description : "") }; })) }),
                  h(window.LTPSelect, { label: i === 0 ? "Crew (optional)" : "", value: r.crewId, onChange: function(v) { updateRow(i, { crewId: v }); },
                    options: crewOptionsFor(r.serviceId) }),
                  h(window.Btn, { small: true, variant: "ghost", onClick: function() { removeRow(i); }, style: { opacity: rows.length > 1 ? 1 : 0.4 } }, "✕")
                );
              }),
              h("div", null, h(window.Btn, { small: true, variant: "ghost", onClick: addRow }, "+ Add role"))
            ),
        h(window.LTPInput, { label: "Notes", value: notes, onChange: setNotes, textarea: true, placeholder: "Optional notes for this shift" }),
        err && h("div", { style: { fontSize: "11px", color: B.danger } }, err),
        h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 } },
          h(window.Btn, { variant: "ghost", onClick: onClose }, "Cancel"),
          h(window.Btn, { onClick: handleSave, disabled: !editing && svcs.length === 0 }, editing ? "Save Changes" : "Create Shift")
        )
      )
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   ASSIGNMENTS TAB — positions from project schedules
  // ═══════════════════════════════════════════════════════════════════════════
  function AssignmentsTab({ allPositions, contacts, services, projects, setProjects, crewConflicts, settings, reloadCrewRequests, crewRequests }) {
    var isMobile = window.LTP_useIsMobile();
    var [filter, setFilter] = useState("all");
    var [projFilter, setProjFilter] = useState("all");
    var [statusDlg, setStatusDlg] = useState(null);
    var [showSendPanel, setShowSendPanel] = useState(false);
    var [sendSelection, setSendSelection] = useState({});
    var [conflictWarn, setConflictWarn] = useState(null);
    var [showManualShift, setShowManualShift] = useState(false);
    var [editManualProject, setEditManualProject] = useState(null);
    var crew = contacts.filter(function(c) { return c.isCrew && c.crewStatus === "active"; });

    // Create a one-off manual shift: build an internal project (no client, no
    // schedule editor) and append it to the projects collection — data-state.js
    // POSTs it like any other project. It then appears in Assignments (and, once
    // crew are assigned + confirmed, in crew requests and Payouts) automatically.
    function createManualShift(form) {
      var newId = Math.max.apply(null, (projects || []).map(function(x) { return x.id; }).concat([0])) + 1;
      var proj = window.LTP_manualShiftProject(Object.assign({ id: newId }, form));
      setProjects(function(prev) { return (prev || []).concat([proj]); });
      setShowManualShift(false);
      var assigned = (proj.schedule[0].positions || []).filter(function(p) { return p.crewId; }).length;
      window.LTP_toast("Manual shift created", {
        variant: "success",
        message: assigned > 0
          ? "Assigned crew are ready to send as requests below."
          : "Assign crew to its roles below, then send requests.",
      });
    }

    // Edit an existing manual shift (an internal project) — times & details only.
    // Only the shift's scalar fields change; schedule[0].positions is preserved
    // verbatim, so position ids/crew/status (and any crew requests) survive. Crew
    // committed to a moved time/date are parked in the notify tray, exactly like
    // the Schedule Builder save path (window.LTP_diffChangedShifts).
    function updateManualShift(form) {
      var proj = editManualProject;
      setEditManualProject(null);
      if (!proj) return;
      var before = proj.schedule || [];
      var shift0 = (proj.schedule && proj.schedule[0]) || {};
      var newShift0 = Object.assign({}, shift0, {
        title: form.title, date: form.date, time: form.startTime, endDate: form.date, endTime: form.endTime,
        breaks: form.breaks || shift0.breaks || [],
      });
      var newSchedule = before.length ? [newShift0].concat(before.slice(1)) : [newShift0];
      setProjects(function(prev) {
        return (prev || []).map(function(p) {
          return p.id === proj.id ? Object.assign({}, p, {
            name: form.title, startDate: form.date, endDate: form.date,
            siteAddress: form.location, scheduleNotes: form.notes, schedule: newSchedule,
          }) : p;
        });
      });
      var changed = window.LTP_diffChangedShifts(before, newSchedule, contacts, services);
      changed.forEach(function(g) {
        window.LTP_outbox.add({ crewId: g.crewId, crewName: g.crewName, projectId: proj.id, projectName: form.title || proj.name || "", template: g.template, shifts: g.shifts });
      });
      if (changed.length) {
        window.LTP_toast("Shift updated — crew to notify", {
          variant: "info",
          message: changed.length + " crew member" + (changed.length > 1 ? "s" : "") + " queued — review and send from the notify tray (bottom-left).",
        });
      } else {
        window.LTP_toast("Manual shift updated", { variant: "success" });
      }
    }

    // Sending crew requests lives here (you select positions and send); the
    // sent-requests list + accept/decline tracking lives in the Crew Requests
    // tab (CrewRequestsTab). After a send we call reloadCrewRequests() so that
    // tab — and the reconcile that advances accepted/declined positions — picks
    // up the new requests. Send confirmations + errors surface as toasts
    // (window.LTP_toast), consistent with the rest of the app.

    function crewLabel(id) { var c = contacts.find(function(x) { return x.id === id; }); return c ? (c.firstName + " " + c.lastName).trim() : "Unknown"; }

    // Park a crew-removal notice (typed by the shift's prior status) into the
    // notify tray, snapshotting the shifts so the email still renders after the
    // positions are reopened/removed. The tray sends or declines — nothing emails
    // inline.
    function parkRemoval(crewId, projectId, template, positionIds) {
      var proj = (projects || []).find(function(p) { return p.id === projectId; });
      var cm = contacts.find(function(c) { return c.id === crewId; });
      window.LTP_outbox.add({
        crewId: crewId, crewName: cm ? (cm.firstName + " " + cm.lastName).trim() : "Crew",
        projectId: projectId, projectName: proj ? proj.name : "", template: template,
        shifts: proj ? window.LTP_shiftSnapshots(proj.schedule, positionIds, services) : [],
      });
    }

    // Backward status moves that need confirmation
    var SEVERITY = { confirmed: 4, accepted: 3, requested: 2, open: 1, declined: 0 };

    // posIds (optional) scopes the change to a specific booking's positions. A
    // conflicting (double-booked) shift is its own booking, so resolving it must
    // touch ONLY its position — not blanket-match every shift this crew holds
    // that day, which would clear the conflicting shift you meant to keep.
    function handleStatusChange(pos, newStatus, posIds) {
      var oldSev = SEVERITY[pos.status] || 0;
      var newSev = SEVERITY[newStatus] || 0;
      var crewName = pos.crewName || "this crew member";
      var context = pos.projectName + " \u2014 " + pos.schedTitle + (pos.date ? " (" + fmt(pos.date) + ")" : "");

      // Backward move with crew assigned — needs confirmation
      if (newSev < oldSev && pos.crewId && oldSev >= 2) {
        // Each status change is scoped to THIS booking's shift(s) (posIds) — a
        // conflicting double-booking is its own booking, so withdrawing/releasing
        // one shift never touches the other. The request record is trimmed (or
        // withdrawn, if this was its last shift) server-side on save.
        var tray = " They're added to the notify tray (bottom-left), where you can email them — or decline — when ready.";
        var messages = {
          "confirmed": "This cancels " + crewName + "'s confirmed position on " + context + "." + tray,
          "accepted": crewName + " already accepted this position on " + context + ". This releases their assignment." + tray,
          "requested": "This withdraws " + crewName + " from " + context + ". Only this shift reopens — any other shifts they're on are unaffected." + tray,
        };
        var actions = {
          "confirmed": "Cancel Position",
          "accepted": "Release",
          "requested": "Withdraw",
        };
        setStatusDlg({
          pos: pos, newStatus: newStatus, posIds: posIds,
          title: pos.status === "confirmed" ? "Cancel Confirmed Position" : pos.status === "accepted" ? "Release Accepted Crew" : "Withdraw Request",
          message: messages[pos.status] || "Change status from " + pos.status + " to " + newStatus + "?",
          actionLabel: actions[pos.status] || "Confirm",
          clearCrew: newStatus === "open" || newStatus === "declined",
        });
        return;
      }

      // Forward move or no crew — apply directly
      updatePosition(setProjects, pos.projectId, pos.schedItemId, pos.posId, { status: newStatus });
    }

    function executeStatusChange() {
      if (!statusDlg) return;
      // A reassign dialog carries its own onConfirm (park the removal notice
      // for the outgoing person, then run the assign flow for the incoming
      // one); the plain status-change cascade below doesn't apply to it.
      if (statusDlg.onConfirm) {
        var fn = statusDlg.onConfirm;
        setStatusDlg(null);
        fn();
        return;
      }
      var pos = statusDlg.pos;
      var newStatus = statusDlg.newStatus;
      var clearCrew = statusDlg.clearCrew;
      // Scope the change to this booking's positions when known (so a conflict
      // resolution touches only its shift); fall back to every same-date shift
      // for this crew (the legacy whole-day behaviour) when not.
      var scopeIds = (statusDlg.posIds && statusDlg.posIds.length) ? statusDlg.posIds : null;
      var affectIds = scopeIds ? scopeIds.reduce(function(m, id) { m[id] = true; return m; }, {}) : null;
      // Park a typed notice (requested→withdrawn, accepted→not-selected,
      // confirmed→cancelled) for the affected shifts — scopeIds (this booking's
      // positions) when known, else every same-date shift for this crew. The
      // snapshot is read from the live schedule, before the cascade mutates it.
      // Nothing emails inline.
      var template = window.LTP_removalTemplate(pos.status);
      var affectedIds = scopeIds ? scopeIds.slice() : [];
      if (!scopeIds) {
        var proj = (projects || []).find(function(p) { return p.id === pos.projectId; });
        if (proj) (proj.schedule || []).forEach(function(s) {
          if (s.date !== pos.date) return;
          (s.positions || []).forEach(function(ps) {
            if (ps.crewId === pos.crewId && (ps.status === "requested" || ps.status === "accepted" || ps.status === "confirmed")) affectedIds.push(ps.id);
          });
        });
      }
      parkRemoval(pos.crewId, pos.projectId, template, affectedIds);
      var doneLabel = pos.status === "confirmed" ? "Position cancelled" : pos.status === "accepted" ? "Crew released" : "Request withdrawn";
      window.LTP_toast(doneLabel, { message: (pos.crewName || "Crew") + " queued in the notify tray.", variant: "success" });
      // Cascade to ALL positions for this crew on this date in this project
      setProjects(function(prev) {
        return prev.map(function(p) {
          if (p.id !== pos.projectId) return p;
          var changeCount = 0;
          var updated = Object.assign({}, p, { schedule: (p.schedule || []).map(function(s) {
            if (s.date !== pos.date) return s;
            return Object.assign({}, s, { positions: (s.positions || []).map(function(ps) {
              var hit = affectIds ? affectIds[ps.id] : (ps.crewId === pos.crewId);
              if (hit) {
                changeCount++;
                var patch = { status: newStatus };
                if (clearCrew) patch.crewId = null;
                return Object.assign({}, ps, patch);
              }
              return ps;
            })});
          })});
          var actionLabel = pos.status === "confirmed" ? "Position cancelled" : pos.status === "accepted" ? "Crew released" : "Request withdrawn";
          var actEntry = {
            id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0, 5),
            type: "saved", user: (window.LTP_CURRENT_USER || "User"),
            message: actionLabel + ": " + (pos.crewName || "?") + " as " + (pos.role || "?") + " (" + changeCount + " item" + (changeCount > 1 ? "s" : "") + ")",
            changes: [{ cat: (pos.date ? fmt(pos.date) : ""), detail: (pos.crewName || "?") + " " + pos.status + " \u2192 " + newStatus + (clearCrew ? " (crew removed)" : "") + " \u00d7" + changeCount }]
          };
          return Object.assign({}, updated, { scheduleActivity: (updated.scheduleActivity || []).concat([actEntry]) });
        });
      });
      setStatusDlg(null);
    }

    var projOptions = [];
    var projSeen = {};
    allPositions.forEach(function(p) { if (!projSeen[p.projectId]) { projSeen[p.projectId] = true; projOptions.push({ id: p.projectId, name: p.projectName }); } });

    // A project stays on this tab only while it still needs assignment work —
    // any position open (unfilled or reopened by a withdrawal) or declined.
    // Once every position is requested-or-later the whole card disappears; the
    // Crew Requests tab manages it from there. While a project IS shown, ALL
    // its positions show, so the full day picture stays visible. Explicit
    // status/project filters bypass the rule (that's a search, not the queue).
    var projNeeds = {};
    allPositions.forEach(function(p) { if (p.status === "open" || p.status === "declined") projNeeds[p.projectId] = true; });
    var defaultView = filter === "all" && projFilter === "all";
    var fullyRequestedCount = projOptions.filter(function(p) { return !projNeeds[p.id]; }).length;

    var filtered = allPositions.filter(function(p) {
      if (filter === "conflicts") { return (crewConflicts || {})[p.posId]; }
      if (filter !== "all" && p.status !== filter) return false;
      if (projFilter !== "all" && p.projectId !== Number(projFilter)) return false;
      if (defaultView && !projNeeds[p.projectId]) return false;
      return true;
    });

    // Group by project → date
    var projectGroups = [];
    var projMap = {};
    filtered.forEach(function(p) {
      if (!projMap[p.projectId]) {
        projMap[p.projectId] = { projectId: p.projectId, projectName: p.projectName, dates: [], dateMap: {} };
        projectGroups.push(projMap[p.projectId]);
      }
      var pg = projMap[p.projectId];
      var dk = p.date || "_unscheduled";
      if (!pg.dateMap[dk]) {
        pg.dateMap[dk] = { date: p.date, dayCall: p.dayCall, dayWrap: p.dayWrap, positions: [] };
        pg.dates.push(pg.dateMap[dk]);
      }
      pg.dateMap[dk].positions.push(p);
    });

    // Within each date group, collapse positions by crewId into "day bookings"
    projectGroups.forEach(function(pg) {
      pg.dates.forEach(function(g) {
      var crewMap = {};
      var dayBookings = [];
      g.positions.forEach(function(pos) {
        if (!pos.crewId) {
          // No crew — keep as individual entry
          dayBookings.push({ type: "single", pos: pos, items: [pos.schedTitle], allPosIds: [pos] });
          return;
        }
        // A double-booked (conflicting) position stands on its OWN row so both
        // sides of the conflict stay visible and individually resolvable —
        // folding it into the crew member's day booking would collapse the two
        // into one row and hide one of the conflicting shifts.
        if ((crewConflicts || {})[pos.posId]) {
          dayBookings.push({ type: "single", pos: pos, items: [pos.schedTitle], allPosIds: [pos] });
          return;
        }
        // Merge a person's day-parts into ONE row PER ROLE (serviceId), not per
        // person: two distinct roles are two bookings with their own pay and
        // their own resolve/cancel scope, so they must stay separate rows —
        // otherwise the second role's label is hidden and a cancel bundles both.
        // Same role across several schedule items still collapses (same key).
        // This used to fall out of the conflict split (different roles same day
        // were always flagged); now that CONFIRMED double-bookings are no longer
        // flagged, the key has to enforce it directly. Free-text roles (no
        // serviceId) fall back to posId, so each stands alone — matching how the
        // conflict detector already keys them.
        var ck = pos.crewId + "|" + (pos.serviceId || pos.posId);
        if (!crewMap[ck]) {
          crewMap[ck] = { type: "day", pos: pos, items: [], allPosIds: [] };
          dayBookings.push(crewMap[ck]);
        }
        crewMap[ck].items.push(pos.schedTitle);
        crewMap[ck].allPosIds.push(pos);
        // Use the "lowest" status as the representative (most actionable)
        var SEVERITY = { open: 1, declined: 0, requested: 2, accepted: 3, confirmed: 4 };
        if ((SEVERITY[pos.status] || 0) < (SEVERITY[crewMap[ck].pos.status] || 0)) {
          crewMap[ck].pos = pos;
        }
      });
      g.dayBookings = dayBookings;
      // Group bookings by matching schedule-item set
      var itemSetMap = {};
      var itemSetGroups = [];
      dayBookings.forEach(function(bk) {
        var key = bk.items.filter(function(v, i, a) { return a.indexOf(v) === i; }).sort().join("|");
        if (!itemSetMap[key]) {
          itemSetMap[key] = { items: bk.items.filter(function(v, i, a) { return a.indexOf(v) === i; }), bookings: [] };
          itemSetGroups.push(itemSetMap[key]);
        }
        itemSetMap[key].bookings.push(bk);
      });
      g.itemSetGroups = itemSetGroups;
      });
    });

    // Count unique crew+day bookings for stats (not individual positions)
    function countUnique(positions, filterFn) {
      var seen = {};
      var count = 0;
      positions.forEach(function(p) {
        if (filterFn && !filterFn(p)) return;
        var key = (p.crewId || "none") + "|" + (p.date || "_") + "|" + p.projectId;
        if (!seen[key]) { seen[key] = true; count++; }
      });
      return count;
    }

    var stats = {
      total: countUnique(allPositions),
      open: countUnique(allPositions, function(p) { return p.status === "open"; }),
      requested: countUnique(allPositions, function(p) { return p.status === "requested"; }),
      accepted: countUnique(allPositions, function(p) { return p.status === "accepted"; }),
      confirmed: countUnique(allPositions, function(p) { return p.status === "confirmed"; }),
      conflicts: Object.keys(crewConflicts || {}).length,
    };

    var pendingSend = allPositions.filter(function(p) { return p.crewId && p.status === "open"; });
    // Count unique crew+PROJECT combos for the send button label — that's how
    // many requests will be created (one per crew member per project).
    var pendingSendUnique = (function() {
      var seen = {}, n = 0;
      pendingSend.forEach(function(p) { var k = p.crewId + "|" + p.projectId; if (!seen[k]) { seen[k] = true; n++; } });
      return n;
    })();

    // One request per crew member per project (the chosen default) — so the
    // selection is keyed by crewId|projectId, collapsing all of a person's open
    // shifts on a project into a single request.
    function openSendPanel() {
      var sel = {};
      var seen = {};
      pendingSend.forEach(function(p) {
        var key = p.crewId + "|" + p.projectId;
        if (!seen[key]) { seen[key] = true; sel[key] = true; }
      });
      setSendSelection(sel);
      setShowSendPanel(true);
    }

    function toggleSendSelection(key) {
      setSendSelection(function(prev) { var n = Object.assign({}, prev); n[key] = !n[key]; return n; });
    }

    function selectAllSend(val) {
      var sel = {};
      var seen = {};
      pendingSend.forEach(function(p) {
        var key = p.crewId + "|" + p.projectId;
        if (!seen[key]) { seen[key] = true; sel[key] = val; }
      });
      setSendSelection(sel);
    }

    function sendSelected() {
      // Build one request per selected (crew, project), collecting that
      // person's open positions on the project. POST /api/crew-requests/send
      // creates the tokenized request, flips the positions server-side, and
      // emails the crew member (best-effort) their Accept/Decline link.
      var selectedKeys = {};
      Object.keys(sendSelection).forEach(function(k) { if (k !== "_previewIdx" && sendSelection[k]) selectedKeys[k] = true; });
      var groups = {};
      pendingSend.forEach(function(p) {
        var key = p.crewId + "|" + p.projectId;
        if (!selectedKeys[key]) return;
        if (!groups[key]) groups[key] = { projectId: p.projectId, contactId: p.crewId, positionIds: [] };
        groups[key].positionIds.push(p.posId);
      });
      var groupList = Object.keys(groups).map(function(k) { return groups[k]; });
      if (groupList.length === 0) { setShowSendPanel(false); return; }

      // Optimistically reflect the open \u2192 requested move locally (the server
      // does the same), so the grouped view updates without a project refetch.
      var allIds = [];
      groupList.forEach(function(g) { allIds = allIds.concat(g.positionIds); });
      flipPositionsLocal(setProjects, null, allIds, "open", "requested");

      setShowSendPanel(false);
      Promise.all(groupList.map(function(g) {
        return fetch("/api/crew-requests/send", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(g),
        }).then(function(r) {
          return r.json().then(function(j) { return { ok: r.ok, body: j, group: g }; },
                               function() { return { ok: r.ok, body: {}, group: g }; });
        }).catch(function(e) { return { ok: false, body: { error: String(e) }, group: g }; });
      })).then(function(results) {
        var sent = 0, reconnect = false, errors = [];
        results.forEach(function(res) {
          if (res.ok) {
            sent++;
            if (res.body && res.body.emailStatus && res.body.emailStatus.needsReconnect) reconnect = true;
          } else {
            var detail = (res.body && res.body.detail) || (res.body && res.body.error) || "send failed";
            if (typeof detail === "object") detail = detail.reason || detail.message || "send failed";
            errors.push(crewLabel(res.group.contactId) + ": " + detail);
          }
        });
        if (errors.length) {
          window.LTP_toast(sent > 0 ? "Some requests didn't send" : "Send failed", { message: errors.join("; "), variant: "error" });
        } else if (reconnect) {
          window.LTP_toast(sent + " crew request" + (sent !== 1 ? "s" : "") + " created", { message: "Email not sent — connect Google in Settings, then Resend from the Crew Requests tab.", variant: "warn" });
        } else if (sent > 0) {
          window.LTP_toast(sent + " crew request" + (sent !== 1 ? "s" : "") + " sent", { variant: "success" });
        }
        reloadCrewRequests();
      });
    }

    // Quick action: release an accepted position (polite decline)
    function releasePosition(pos, posIds) {
      handleStatusChange(pos, "open", posIds);
    }

    return h("div", null,
      // Stats
      h("div", { style: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 } },
        h(window.StatCard, { label: "Total Positions", value: stats.total }),
        h(window.StatCard, { label: "Open", value: stats.open, accent: stats.open > 0 ? B.warn : B.textMut }),
        h(window.StatCard, { label: "Requested", value: stats.requested, accent: B.warn }),
        h(window.StatCard, { label: "Accepted", value: stats.accepted, accent: stats.accepted > 0 ? B.success : B.textMut }),
        h(window.StatCard, { label: "Confirmed", value: stats.confirmed, accent: B.success }),
        stats.conflicts > 0 && h(window.StatCard, { label: "Conflicts", value: stats.conflicts, accent: B.danger })
      ),
      // Filters + Batch Actions
      h("div", { style: { display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" } },
        ["all", "open", "requested", "accepted", "confirmed", "declined", "conflicts"].map(function(f) {
          var isConflict = f === "conflicts";
          return h("button", { key: f, onClick: function() { setFilter(f); },
            style: { background: filter === f ? (isConflict ? B.danger : B.accent) : B.raised, color: filter === f ? B.btnInk : (isConflict ? B.danger : B.textMut), border: "1px solid " + (filter === f ? (isConflict ? B.danger : B.accent) : (isConflict && stats.conflicts > 0 ? B.danger + "44" : B.border)), borderRadius: "4px", padding: "4px 10px", fontSize: "10px", fontWeight: 600, cursor: "pointer", textTransform: "capitalize" } },
            isConflict ? "Conflicts" + (stats.conflicts > 0 ? " (" + stats.conflicts + ")" : "") : f);
        }),
        h("select", { value: projFilter, onChange: function(e) { setProjFilter(e.target.value); },
          style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "4px", padding: "4px 8px", color: B.text, fontSize: "10px", fontFamily: "inherit" } },
          h("option", { value: "all" }, "All Projects"),
          projOptions.map(function(p) { return h("option", { key: p.id, value: p.id }, p.name); })
        ),
        h("div", { style: { flex: 1 } }),
        h("button", { onClick: function() { setShowManualShift(true); }, title: "Add a one-off shift not tied to a client project (e.g. warehouse labor)",
          style: { background: B.accent, border: "none", borderRadius: "4px", padding: "5px 14px", color: B.btnInk, fontSize: "11px", fontWeight: 700, cursor: "pointer" } }, "+ Manual Shift"),
        pendingSendUnique > 0 && h("button", { onClick: openSendPanel,
          style: { background: B.success, border: "none", borderRadius: "4px", padding: "5px 14px", color: B.btnInk, fontSize: "11px", fontWeight: 700, cursor: "pointer" } }, "Send " + pendingSendUnique + " Request" + (pendingSendUnique > 1 ? "s" : "") + " \u25b8")
      ),
      // One-off manual-shift adder (warehouse labor etc. \u2014 see ManualShiftModal).
      showManualShift && h(ManualShiftModal, { services: services, contacts: contacts, onSave: createManualShift, onClose: function() { setShowManualShift(false); } }),
      // Lightweight editor for an existing manual shift (internal project) \u2014
      // times & details only; roles/crew stay on this tab.
      editManualProject && h(ManualShiftModal, { services: services, contacts: contacts, editProject: editManualProject, onSave: updateManualShift, onClose: function() { setEditManualProject(null); } }),

      // Grouped by project
      defaultView && fullyRequestedCount > 0 && projectGroups.length > 0 && h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 10, fontStyle: "italic" } },
        fullyRequestedCount + " fully-requested project" + (fullyRequestedCount > 1 ? "s" : "") + " hidden — manage responses on the Crew Requests tab, or use the filters above."),
      projectGroups.length === 0 && h(window.EmptyState, { text: allPositions.length === 0
        ? "No positions found. Add positions to project schedules."
        : defaultView
          ? "All positions are requested or booked — manage responses on the Crew Requests tab. Withdrawn or declined shifts reopen here automatically."
          : "No positions match this filter." }),
      projectGroups.map(function(pg) {
        var totalBookings = pg.dates.reduce(function(s, d) { return s + (d.dayBookings || []).length; }, 0);
        var pgProject = (projects || []).find(function(p) { return p.id === pg.projectId; });
        var isInternal = !!(pgProject && pgProject.internal);
        return h("div", { key: pg.projectId, style: { background: B.raised, borderRadius: "8px", border: "1px solid " + B.border, marginBottom: 12, overflow: "hidden" } },
          // Project header — a manual shift (internal project) opens the
          // lightweight editor; a real project opens its Schedule Builder.
          h("div", { style: { background: B.accent + "12", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "2px solid " + B.accent + "44", borderLeft: "3px solid " + B.accent } },
            h("span", { style: { fontSize: "13px", fontWeight: 700, color: B.accent, cursor: "pointer" }, onClick: function() { if (isInternal && pgProject) { setEditManualProject(pgProject); } else { nav("projects/" + pg.projectId + "/schedule"); } } }, pg.projectName),
            h("div", { style: { display: "flex", gap: 10, alignItems: "center" } },
              isInternal && pgProject && h("button", { onClick: function() { setEditManualProject(pgProject); }, title: "Edit this manual shift's date, time, or details",
                style: { background: "transparent", border: "1px solid " + B.accent + "55", borderRadius: "4px", padding: "2px 8px", color: B.accent, fontSize: "10px", fontWeight: 700, cursor: "pointer" } }, "✎ Edit"),
              h("span", { style: { fontSize: "10px", color: B.textMut } }, totalBookings + " crew booking" + (totalBookings !== 1 ? "s" : "")))),
          // Date groups
          pg.dates.map(function(g) {
            return h("div", { key: pg.projectId + "|" + (g.date || "_") },
              h("div", { style: { padding: "8px 14px", display: "flex", gap: 10, alignItems: "center", background: B.raised, borderBottom: "1px solid " + B.border, borderLeft: "3px solid " + B.info } },
                h("span", { style: { fontSize: "11px", fontWeight: 700, color: B.text } }, g.date ? fmt(g.date) : "Unscheduled"),
                g.dayCall && h("span", { style: { fontSize: "10px", color: B.textMut } }, ft(g.dayCall) + " \u2192 " + ft(g.dayWrap)),
                h("span", { style: { fontSize: "9px", color: B.textMut } }, (g.dayBookings || []).length + " crew")),
              // Crew rows grouped by matching schedule items
              h("div", { style: { padding: "6px 8px", display: "flex", flexDirection: "column", gap: 6 } },
                (g.itemSetGroups || []).map(function(isg, gi) {
                  return h("div", { key: "isg-" + gi, style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "6px", overflow: "hidden" } },
                    // Item set header
                    h("div", { style: { padding: "5px 10px", background: B.bg, borderBottom: "1px solid " + B.border, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
                      isg.items.map(function(item, ii) {
                        return h("span", { key: ii, style: { fontSize: "10px", color: B.textMut, display: "flex", alignItems: "center", gap: 4 } },
                          ii > 0 && h("span", { style: { color: B.textMut, margin: "0 2px" } }, "\u203a"),
                          item);
                      })
                    ),
                    // Crew rows under this item set
                    h("div", { style: { display: "flex", flexDirection: "column" } },
                      isg.bookings.map(function(booking, bi) {
                        var pos = booking.pos;
                        // The positions this booking represents — status actions
                        // act on exactly these (a conflicting shift is its own
                        // booking, so it isn't swept up with the one you click).
                        var bkPosIds = (booking.allPosIds || []).map(function(bp) { return bp.posId; });
                        var conflicts = (crewConflicts || {})[pos.posId];
                        var hasConflict = conflicts && conflicts.length > 0;
                        return h("div", { key: pos.posId + "-" + bi, style: { padding: isMobile ? "8px 10px" : "6px 10px", display: "flex", gap: 8, alignItems: "center", flexWrap: isMobile ? "wrap" : "nowrap", borderTop: bi > 0 ? "1px solid " + B.border : "none", background: hasConflict ? B.danger + "08" : "transparent" } },
                          hasConflict && h("div", { title: "Double-booked: also on " + conflicts.map(function(c) { return c.projectName; }).join(", "),
                            style: { width: 16, height: 16, borderRadius: "50%", background: B.danger + "22", border: "1px solid " + B.danger, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "help" } },
                            h("span", { style: { fontSize: "9px", color: B.danger, fontWeight: 700 } }, "!")),
                          h("div", { style: { flex: isMobile ? "1 1 100%" : 1, minWidth: 0 } },
                            h("span", { style: { fontSize: isMobile ? "13px" : "11px", fontWeight: 600, color: B.text } }, pos.svcName),
                            // Person # within the role for this day (same numbering
                            // as the schedule editor) — shown when a role has 2+
                            // people so the right person goes into the right slot.
                            pos.dayRoleCount > 1 && h("span", { title: "Person #" + pos.slot + " of " + pos.dayRoleCount + " for this role on this day — matches the # in the schedule editor.",
                              style: { fontSize: "9px", fontWeight: 700, color: B.accent, background: B.accent + "18", border: "1px solid " + B.accent + "44", padding: "1px 5px", borderRadius: "3px", marginLeft: 6, cursor: "help" } }, "#" + pos.slot),
                            pos.dept && h("span", { style: { fontSize: "9px", color: window.LTP_deptColor(pos.dept), background: window.LTP_deptColor(pos.dept) + "22", border: "1px solid " + window.LTP_deptColor(pos.dept) + "44", padding: "1px 5px", borderRadius: "3px", fontWeight: 600, marginLeft: 6 } }, pos.dept)),
                          h("select", { value: pos.crewId || "", onChange: function(e) {
                            var cid = Number(e.target.value) || null;
                            if (!cid && pos.crewId && (SEVERITY[pos.status] || 0) >= 2) { handleStatusChange(Object.assign({}, pos), "open", bkPosIds); return; }
                            function doAssign() {
                              // Check for conflicts before assigning
                              if (cid && pos.date) {
                                var otherBookings = [];
                                // Same-project duplicates
                                (projects || []).forEach(function(pr) {
                                  if (pr.id !== pos.projectId) return;
                                  (pr.schedule || []).forEach(function(sc) {
                                    if (sc.date !== pos.date) return;
                                    (sc.positions || []).forEach(function(ps) {
                                      if (ps.crewId === cid && ps.id !== pos.posId) {
                                        var svc = ps.serviceId ? (services || []).find(function(sv) { return sv.id === ps.serviceId; }) : null;
                                        otherBookings.push("Already assigned as " + (svc ? svc.role + " \u2014 " + svc.description : ps.role || "?") + " on " + sc.title);
                                      }
                                    });
                                  });
                                });
                                // Cross-project conflicts
                                (projects || []).forEach(function(pr) {
                                  if (pr.id === pos.projectId) return;
                                  (pr.schedule || []).forEach(function(sc) {
                                    if (sc.date !== pos.date) return;
                                    (sc.positions || []).forEach(function(ps) {
                                      if (ps.crewId === cid && ps.status !== "declined") {
                                        otherBookings.push(pr.name + " (" + sc.title + ")");
                                      }
                                    });
                                  });
                                });
                                if (otherBookings.length > 0) {
                                  var cm = contacts.find(function(c) { return c.id === cid; });
                                  var crewName = cm ? cm.firstName + " " + cm.lastName : "This crew member";
                                  setConflictWarn({ title: "Scheduling Conflict", message: crewName + " is already booked on " + fmt(pos.date) + " for:\n\n" + otherBookings.join("\n") + "\n\nAssign anyway?",
                                    onConfirm: function() { booking.allPosIds.forEach(function(bp) { updatePosition(setProjects, bp.projectId, bp.schedItemId, bp.posId, { crewId: cid, status: (cid && cid === bp.crewId) ? bp.status : "open" }); }); setConflictWarn(null); } });
                                  return;
                                }
                              }
                              booking.allPosIds.forEach(function(bp) { updatePosition(setProjects, bp.projectId, bp.schedItemId, bp.posId, { crewId: cid, status: (cid && cid === bp.crewId) ? bp.status : "open" }); });
                            }
                            // Swapping an active booking (requested/accepted/confirmed) to a
                            // DIFFERENT person releases the current one \u2014 confirm it like
                            // un-assigning does, instead of silently resetting the shift out
                            // from under a live request. The outgoing person is parked in the
                            // notify tray with the notice typed by their prior status.
                            if (cid && pos.crewId && cid !== pos.crewId && (SEVERITY[pos.status] || 0) >= 2) {
                              var newCm = contacts.find(function(c) { return c.id === cid; });
                              var newName = newCm ? (newCm.firstName + " " + newCm.lastName).trim() : "another crew member";
                              var oldName = pos.crewName || "The current crew member";
                              var swapContext = pos.projectName + " \u2014 " + pos.schedTitle + (pos.date ? " (" + fmt(pos.date) + ")" : "");
                              var stateVerb = { requested: "has already been requested for", accepted: "already accepted", confirmed: "is confirmed on" };
                              setStatusDlg({
                                title: "Reassign to " + newName + "?",
                                message: oldName + " " + (stateVerb[pos.status] || "holds") + " " + swapContext + ". Reassigning hands the shift to " + newName + " as a fresh request (Ready to send), and " + oldName + " is added to the notify tray (bottom-left), where you can email them \u2014 or decline \u2014 when ready.",
                                actionLabel: "Reassign",
                                onConfirm: function() {
                                  parkRemoval(pos.crewId, pos.projectId, window.LTP_removalTemplate(pos.status), bkPosIds);
                                  window.LTP_toast("Crew reassigned", { message: (pos.crewName || "Crew") + " released and queued in the notify tray.", variant: "success" });
                                  doAssign();
                                }
                              });
                              return;
                            }
                            doAssign();
                          }, style: { width: isMobile ? "100%" : 150, flex: isMobile ? "1 1 140px" : undefined, boxSizing: "border-box", background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: isMobile ? "8px" : "3px 6px", color: B.text, fontSize: "10px", fontFamily: "inherit" } },
                            h("option", { value: "" }, "Assign crew\u2026"),
                            // Role-tagged crew first; everyone else stays reachable under
                            // "Other crew" so a role nobody is tagged with (e.g. a custom
                            // rate-card role) never leaves the position unassignable.
                            (function() {
                              var opt = function(c) { return h("option", { key: c.id, value: c.id }, c.firstName + " " + c.lastName); };
                              var matching = crew.filter(function(c) { return !pos.role || (c.crewRoles || []).indexOf(pos.role) !== -1; });
                              if (matching.length === crew.length) return crew.map(opt);
                              var others = crew.filter(function(c) { return matching.indexOf(c) === -1; });
                              return matching.map(opt).concat([h("optgroup", { key: "_other", label: "Other crew" }, others.map(opt))]);
                            })()
                          ),
                          pos.status === "open" && !pos.crewId && h("span", { style: { fontSize: "9px", color: B.textMut, fontStyle: "italic" } }, "Needs crew"),
                          pos.status === "open" && pos.crewId && h("span", { style: { fontSize: "9px", color: B.warn, fontWeight: 600 } }, "Ready to send"),
                          pos.status === "requested" && h("span", { style: { fontSize: "9px", color: B.warn, fontWeight: 600, background: B.warn + "18", border: "1px solid " + B.warn + "33", borderRadius: "3px", padding: "2px 8px" } }, "Awaiting\u2026"),
                          pos.status === "accepted" && h("div", { style: { display: "flex", gap: 4, alignItems: "center" } },
                            h("span", { title: "Confirm this position from the Crew Requests tab", style: { fontSize: "9px", color: B.success, fontWeight: 700, background: B.success + "18", border: "1px solid " + B.success + "33", borderRadius: "3px", padding: "2px 8px" } }, "Accepted"),
                            h("button", { onClick: function() { releasePosition(pos, bkPosIds); },
                              style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "3px", padding: "3px 8px", color: B.textMut, fontSize: "9px", fontWeight: 600, cursor: "pointer" } }, "Release")),
                          pos.status === "confirmed" && h("div", { style: { display: "flex", gap: 4, alignItems: "center" } },
                            h("span", { style: { fontSize: "9px", color: B.info, fontWeight: 700, background: B.info + "18", border: "1px solid " + B.info + "33", borderRadius: "3px", padding: "2px 8px" } }, "\u2713 Confirmed"),
                            h("button", { onClick: function() { handleStatusChange(pos, "open", bkPosIds); },
                              style: { background: "transparent", border: "none", color: B.border, cursor: "pointer", fontSize: "9px", padding: "2px 4px" } }, "cancel")),
                          pos.status === "declined" && h("div", { style: { display: "flex", gap: 4, alignItems: "center" } },
                            h("span", { style: { fontSize: "9px", color: B.danger, fontWeight: 600, background: B.danger + "18", border: "1px solid " + B.danger + "33", borderRadius: "3px", padding: "2px 8px" } }, "Declined"),
                            h("button", { onClick: function() {
                              booking.allPosIds.forEach(function(bp) { updatePosition(setProjects, bp.projectId, bp.schedItemId, bp.posId, { status: "open", crewId: null }); });
                            }, style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "3px", padding: "3px 8px", color: B.textMut, fontSize: "9px", fontWeight: 600, cursor: "pointer" } }, "Reassign")),
                          // Mobile: tap-to-call the assigned crew member straight from
                          // the booking row (field leads confirming a shift on-site).
                          isMobile && pos.crewId && (function() {
                            var acm = contacts.find(function(c) { return c.id === pos.crewId; });
                            return acm ? h(window.LTPCallBtn, { phone: acm.phone, name: acm.firstName + " " + acm.lastName, size: 36 }) : null;
                          })()
                        );
                      })
                    )
                  );
                })
              )
            );
          })
        );
      }),

      // Conflict warning dialog
      conflictWarn && h(window.LTPModal, { title: conflictWarn.title, onClose: function() { setConflictWarn(null); } },
        h("p", { style: { fontSize: "12px", color: B.textSec, marginBottom: 16, lineHeight: 1.6, whiteSpace: "pre-line" } }, conflictWarn.message),
        h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
          h(window.Btn, { variant: "ghost", onClick: function() { setConflictWarn(null); } }, "Cancel"),
          h(window.Btn, { variant: "danger", onClick: conflictWarn.onConfirm }, "Assign Anyway"))
      ),

      // Status change confirmation dialog. The notification itself is decided in
      // the notify tray (send / decline), so this is a single confirm — no inline
      // email preview or send/skip split.
      statusDlg && h(window.LTPModal, { title: statusDlg.title, onClose: function() { setStatusDlg(null); } },
        h("div", null,
          h("p", { style: { fontSize: "12px", color: B.textSec, marginBottom: 16, lineHeight: 1.5 } }, statusDlg.message),
          h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
            h(window.Btn, { variant: "ghost", onClick: function() { setStatusDlg(null); } }, "Keep"),
            h(window.Btn, { variant: "danger", onClick: function() { executeStatusChange(); } }, statusDlg.actionLabel)))
      ),

      // Send Requests review panel with email preview
      showSendPanel && h(window.LTPModal, { title: "Send Crew Requests", onClose: function() { setShowSendPanel(false); }, wide: true },
        function() {
          var selectedCount = Object.keys(sendSelection).filter(function(k) { return k !== "_previewIdx" && sendSelection[k]; }).length;
          // One entry per crew+project (the chosen default): all of a person's
          // open shifts on a project collapse into a single tokenized request.
          var allEntries = [];
          var entrySeen = {};
          pendingSend.forEach(function(p) {
            var key = p.crewId + "|" + p.projectId;
            if (!entrySeen[key]) {
              entrySeen[key] = { key: key, crewId: p.crewId, projectId: p.projectId, projectName: p.projectName, shifts: [] };
              allEntries.push(entrySeen[key]);
            }
            entrySeen[key].shifts.push(p);
          });
          var previewIdx = Math.max(0, Math.min(sendSelection._previewIdx || 0, allEntries.length - 1));
          var pe = allEntries[previewIdx];
          var s = settings || {};
          var previewSubject = "", previewTo = "", peShifts = [];
          if (pe) {
            var pcm = contacts.find(function(c) { return c.id === pe.crewId; });
            var tmpl = (s.emailTemplates || {}).crewRequest || { subject: "", body: "" };
            previewSubject = window.LTP_resolveTemplate(tmpl.subject || "", {
              companyName: s.companyName || "LTP",
              crewName: pcm ? pcm.firstName : "there",
              projectName: pe.projectName || "",
            });
            previewTo = pcm ? (pcm.email || "(no email on file)") : "?";
            peShifts = pe.shifts.slice().sort(function(a, b) { return (a.date + (a.callTime || "")) > (b.date + (b.callTime || "")) ? 1 : -1; });
          }
          return h("div", null,
            h("div", { style: { display: "flex", gap: 16, minHeight: 360 } },
              // Left: crew+project selection list
              h("div", { style: { flex: "0 0 300px", display: "flex", flexDirection: "column" } },
                h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
                  h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Recipients (" + allEntries.length + ")"),
                  h("div", { style: { display: "flex", gap: 6 } },
                    h("button", { onClick: function() { selectAllSend(true); },
                      style: { background: "transparent", border: "1px solid " + B.accent, borderRadius: "3px", padding: "2px 8px", color: B.accent, fontSize: "9px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" } }, "All"),
                    h("button", { onClick: function() { selectAllSend(false); },
                      style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "3px", padding: "2px 8px", color: B.textMut, fontSize: "9px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" } }, "None"))),
                h("div", { style: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 } },
                  allEntries.map(function(entry, ei) {
                    var isSelected = sendSelection[entry.key];
                    var isPreviewed = ei === previewIdx;
                    var cm = contacts.find(function(c) { return c.id === entry.crewId; });
                    return h("div", { key: entry.key, style: { display: "flex", gap: 8, alignItems: "center", padding: "6px 8px",
                      background: isPreviewed ? B.accent + "18" : (isSelected ? B.success + "0a" : B.surface),
                      border: "1px solid " + (isPreviewed ? B.accent + "55" : isSelected ? B.success + "33" : B.border), borderRadius: "4px", cursor: "pointer", userSelect: "none" } },
                      h("div", { onClick: function(e) { e.stopPropagation(); toggleSendSelection(entry.key); },
                        style: { width: 16, height: 16, borderRadius: "3px", border: "2px solid " + (isSelected ? B.success : B.border), background: isSelected ? B.success : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 } },
                        isSelected && h("span", { style: { color: B.btnInk, fontSize: "10px", fontWeight: 700 } }, "\u2713")),
                      h("div", { onClick: function() { setSendSelection(function(prev) { return Object.assign({}, prev, { _previewIdx: ei }); }); }, style: { flex: 1, minWidth: 0 } },
                        h("div", { style: { fontSize: "11px", fontWeight: 600, color: B.text } }, cm ? cm.firstName + " " + cm.lastName : "Unknown"),
                        h("div", { style: { fontSize: "9px", color: B.textMut } }, entry.projectName + " \u00b7 " + entry.shifts.length + " shift" + (entry.shifts.length !== 1 ? "s" : ""))),
                      !cm || !cm.email ? h("span", { title: "No email on file", style: { fontSize: "8px", color: B.warn, fontWeight: 700 } }, "no email") : null
                    );
                  }))
              ),
              // Right: what-will-be-sent summary. The email itself is composed
              // server-side from the crewRequest template (Accept/Decline buttons
              // linking to each crew member's private page), so we summarize
              // rather than render a drift-prone client copy.
              h("div", { style: { flex: 1, background: B.bg, border: "1px solid " + B.border, borderRadius: "8px", display: "flex", flexDirection: "column", overflow: "hidden" } },
                h("div", { style: { padding: "10px 14px", borderBottom: "1px solid " + B.border, background: B.surface } },
                  h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 } }, "Request Summary"),
                  h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 4 } },
                    h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "To:"),
                    h("span", { style: { fontSize: "11px", color: B.text, fontWeight: 600 } }, previewTo)),
                  h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                    h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "Subj:"),
                    h("span", { style: { fontSize: "11px", color: B.text, fontWeight: 600 } }, previewSubject))),
                h("div", { style: { flex: 1, padding: "14px", overflowY: "auto" } },
                  h("div", { style: { fontSize: "11px", color: B.textSec, lineHeight: 1.5, marginBottom: 12 } },
                    "An email with ", h("strong", { style: { color: B.success } }, "Accept"), " / ", h("strong", { style: { color: B.danger } }, "Decline"),
                    " buttons linking to ", (pe ? (pe.shifts.length === 1 ? "this person's" : (contacts.find(function(c) { return c.id === pe.crewId; }) || {}).firstName || "their") + "'s" : "their"),
                    " private page will be sent. They can accept or decline and leave a note."),
                  h("div", { style: { fontSize: "9px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 } }, "Shifts in this request (" + peShifts.length + ")"),
                  peShifts.length === 0
                    ? h("div", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic" } }, "No open shifts.")
                    : peShifts.map(function(sp, i) {
                        return h("div", { key: i, style: { fontSize: "11px", color: B.text, padding: "5px 0", borderBottom: i < peShifts.length - 1 ? "1px solid " + B.border : "none" } },
                          h("span", { style: { fontWeight: 600 } }, (sp.svcName || sp.role || "Crew") + (sp.dayRoleCount > 1 ? " #" + sp.slot : "")),
                          h("span", { style: { color: B.textMut } }, "  \u00b7  " + (sp.date ? fmt(sp.date) : "TBD") + (sp.schedTitle ? "  \u00b7  " + sp.schedTitle : "")));
                      }))
              )
            ),
            h("div", { style: { borderTop: "1px solid " + B.border, paddingTop: 14, marginTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center" } },
              h("div", { style: { fontSize: "11px", color: B.textMut } }, selectedCount + " request" + (selectedCount !== 1 ? "s" : "") + " of " + allEntries.length),
              h("div", { style: { display: "flex", gap: 8 } },
                h(window.Btn, { variant: "ghost", onClick: function() { setShowSendPanel(false); } }, "Cancel"),
                h(window.Btn, { onClick: selectedCount > 0 ? sendSelected : undefined,
                  style: selectedCount > 0 ? {} : { opacity: 0.4, cursor: "not-allowed" } },
                  "Send " + selectedCount + " Request" + (selectedCount !== 1 ? "s" : ""))))
          );
        }()
      )
    );
  }
  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════
  //   CALENDAR TAB
  // ═══════════════════════════════════════════════════════════════════════════
  function LaborCalendar({ allPositions }) {
    var [monthOffset, setMonthOffset] = useState(0);
    var isMobile = window.LTP_useIsMobile();
    var todayRef = React.useRef(null);
    React.useEffect(function() {
      if (isMobile && todayRef.current) todayRef.current.scrollIntoView({ block: "start" });
    }, [isMobile, monthOffset]);
    var now = new Date();
    var viewDate = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    var year = viewDate.getFullYear(), month = viewDate.getMonth();
    var monthName = viewDate.toLocaleString("default", { month: "long", year: "numeric" });
    var firstDay = new Date(year, month, 1).getDay();
    var daysInMonth = new Date(year, month + 1, 0).getDate();

    var cells = [];
    for (var i = 0; i < firstDay; i++) cells.push(null);
    for (var d = 1; d <= daysInMonth; d++) {
      var dateStr = year + "-" + String(month + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
      var dayPos = allPositions.filter(function(p) { return p.date === dateStr; });
      cells.push({ day: d, date: dateStr, positions: dayPos });
    }

    // \u2500\u2500 Mobile: day-list agenda (opens to today) instead of the month grid \u2500\u2500\u2500\u2500
    if (isMobile) {
      var agDays = cells.filter(function(c) { return c && c.positions.length > 0; });
      var tISO = todayISO();
      var tgt = null;
      for (var gi = 0; gi < agDays.length; gi++) { if (agDays[gi].date >= tISO) { tgt = agDays[gi].date; break; } }
      return h("div", null,
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
          h("button", { onClick: function() { setMonthOffset(monthOffset - 1); }, className: "ltp-tap", style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: "8px 16px", color: B.textMut, cursor: "pointer", minHeight: 40 } }, "\u25c0"),
          h("h3", { style: { fontSize: "15px", fontWeight: 700, color: B.text, margin: 0 } }, monthName),
          h("button", { onClick: function() { setMonthOffset(monthOffset + 1); }, className: "ltp-tap", style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: "8px 16px", color: B.textMut, cursor: "pointer", minHeight: 40 } }, "\u25b6")),
        agDays.length === 0
          ? h(window.EmptyState, { text: "No crew positions this month." })
          : agDays.map(function(cell) {
              var d2 = new Date(cell.date + "T12:00:00");
              var isToday = cell.date === tISO;
              var confirmed = cell.positions.filter(function(p) { return p.status === "confirmed"; }).length;
              var projGroups = {};
              cell.positions.forEach(function(p) { if (!projGroups[p.projectId]) projGroups[p.projectId] = { name: p.projectName, count: 0 }; projGroups[p.projectId].count++; });
              return h("div", { key: cell.date, ref: cell.date === tgt ? todayRef : null, style: { marginBottom: 16, scrollMarginTop: "8px" } },
                h("div", { style: { fontSize: "13px", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: isToday ? B.accent : B.textSec, marginBottom: 8, paddingBottom: 6, borderBottom: "1px solid " + B.border } },
                  d2.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) + (isToday ? " \u00b7 Today" : "") + "  \u00b7  " + confirmed + "/" + cell.positions.length + " confirmed"),
                Object.keys(projGroups).map(function(pid) {
                  var pg = projGroups[pid];
                  return h("div", { key: pid, style: { background: B.surface, border: "1px solid " + B.border, borderLeft: "3px solid " + B.accent, borderRadius: 8, padding: "10px 12px", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" } },
                    h("div", { style: { fontSize: "15px", fontWeight: 600, color: B.text } }, pg.name),
                    h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.accent } }, pg.count + (pg.count > 1 ? " positions" : " position")));
                }));
            }));
    }

    return h("div", null,
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
        h("button", { onClick: function() { setMonthOffset(monthOffset - 1); }, style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "4px", padding: "4px 12px", color: B.textMut, cursor: "pointer", fontSize: "12px" } }, "\u25c0"),
        h("h3", { style: { fontSize: "15px", fontWeight: 700, color: B.text, margin: 0 } }, monthName),
        h("button", { onClick: function() { setMonthOffset(monthOffset + 1); }, style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "4px", padding: "4px 12px", color: B.textMut, cursor: "pointer", fontSize: "12px" } }, "\u25b6")),
      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 1, marginBottom: 2 } },
        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(function(dn) {
          return h("div", { key: dn, style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textAlign: "center", padding: "4px 0", textTransform: "uppercase" } }, dn);
        })),
      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 1 } },
        cells.map(function(cell, idx) {
          if (!cell) return h("div", { key: "e" + idx, style: { minHeight: 80, background: B.bg, borderRadius: "4px" } });
          var today = cell.date === todayISO();
          var confirmed = cell.positions.filter(function(p) { return p.status === "confirmed"; }).length;
          var total = cell.positions.length;
          // Group by project for display
          var projGroups = {};
          cell.positions.forEach(function(p) { if (!projGroups[p.projectId]) projGroups[p.projectId] = { name: p.projectName, count: 0 }; projGroups[p.projectId].count++; });
          return h("div", { key: cell.date, style: { minHeight: 80, background: today ? B.accent + "11" : B.surface, border: "1px solid " + (today ? B.accent + "44" : B.border), borderRadius: "4px", padding: 4 } },
            h("div", { style: { fontSize: "11px", fontWeight: today ? 700 : 500, color: today ? B.accent : B.textMut, marginBottom: 2 } }, cell.day),
            Object.keys(projGroups).map(function(pid) {
              var pg = projGroups[pid];
              return h("div", { key: pid, style: { fontSize: "9px", background: B.accent + "22", border: "1px solid " + B.accent + "44", borderRadius: "3px", padding: "2px 4px", marginBottom: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: B.text } },
                pg.name + " (" + pg.count + ")");
            }),
            total > 0 && h("div", { style: { fontSize: "8px", color: confirmed === total ? B.success : B.textMut, marginTop: 1 } }, confirmed + "/" + total + " conf")
          );
        }))
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   WEEKLY SCHEDULE TAB
  // ═══════════════════════════════════════════════════════════════════════════
  function WeeklySchedule({ allPositions, contacts }) {
    var isMobile = window.LTP_useIsMobile();
    // A tap on a Calendar day parks that date in window.LTP_weeklyFocusDate
    // before navigating here. Consume it once (lazy init) to open on that day's
    // week and scroll to it; clear it so a later revisit opens on the current week.
    function weekOffsetForDate(iso) {
      var n = new Date();
      var nmo = n.getDay() === 0 ? -6 : 1 - n.getDay();
      var thisMon = new Date(n.getFullYear(), n.getMonth(), n.getDate() + nmo);
      var t = new Date(iso + "T12:00:00");
      var tmo = t.getDay() === 0 ? -6 : 1 - t.getDay();
      var tMon = new Date(t.getFullYear(), t.getMonth(), t.getDate() + tmo);
      return Math.round((tMon - thisMon) / (7 * 86400000));
    }
    var [focusDate] = useState(function() {
      var f = window.LTP_weeklyFocusDate || null;
      window.LTP_weeklyFocusDate = null;
      return f;
    });
    var [weekOffset, setWeekOffset] = useState(function() { return focusDate ? weekOffsetForDate(focusDate) : 0; });
    var scrollDate = focusDate || todayISO();
    var todayRef = React.useRef(null);
    React.useEffect(function() {
      if (isMobile && todayRef.current) todayRef.current.scrollIntoView({ block: "start" });
    }, [isMobile, weekOffset]);
    var crew = contacts.filter(function(c) { return c.isCrew && c.crewStatus === "active"; });

    var now = new Date();
    var dayOfWeek = now.getDay();
    var mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    var monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset + (weekOffset * 7));
    var weekDates = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
      weekDates.push(d.toISOString().substring(0, 10));
    }
    var weekLabel = fmt(weekDates[0]) + " \u2014 " + fmt(weekDates[6]);

    // Build schedule: crewId → [{ date, projectName, role, callTime }]
    var scheduleMap = {};
    crew.forEach(function(c) { scheduleMap[c.id] = []; });
    allPositions.forEach(function(p) {
      if (!p.crewId || weekDates.indexOf(p.date) === -1) return;
      if (p.status !== "accepted" && p.status !== "confirmed" && p.status !== "requested") return;
      if (scheduleMap[p.crewId]) scheduleMap[p.crewId].push(p);
    });

    var activeCrew = crew.filter(function(c) { return scheduleMap[c.id] && scheduleMap[c.id].length > 0; });
    if (activeCrew.length === 0) activeCrew = crew.slice(0, 6);

    // \u2500\u2500 Mobile: day-first agenda \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    // The crew\u00d77 matrix (140px + repeat(7,1fr)) is illegible on a phone. On
    // mobile, pivot to a day-list: one section per day of the week listing who's
    // working (crew \u2192 role \u2192 project, tap-to-call). Auto-scrolls to today. The
    // desktop matrix is unchanged below.
    if (isMobile) {
      var byDay = {};
      weekDates.forEach(function(ds) { byDay[ds] = []; });
      activeCrew.forEach(function(c) {
        (scheduleMap[c.id] || []).forEach(function(s) { if (byDay[s.date]) byDay[s.date].push({ crew: c, pos: s }); });
      });
      return h("div", null,
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
          h("button", { onClick: function() { setWeekOffset(weekOffset - 1); }, className: "ltp-tap", style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: "8px 16px", color: B.textMut, cursor: "pointer", minHeight: 40 } }, "\u25c0"),
          h("h3", { style: { fontSize: "14px", fontWeight: 700, color: B.text, margin: 0 } }, weekLabel),
          h("button", { onClick: function() { setWeekOffset(weekOffset + 1); }, className: "ltp-tap", style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: "8px 16px", color: B.textMut, cursor: "pointer", minHeight: 40 } }, "\u25b6")),
        weekDates.map(function(ds) {
          var d2 = new Date(ds + "T12:00:00");
          var isToday = ds === todayISO();
          var rows = byDay[ds];
          var label = d2.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
          return h("div", { key: ds, ref: ds === scrollDate ? todayRef : null, style: { marginBottom: 16, scrollMarginTop: "8px" } },
            h("div", { style: { fontSize: "13px", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: isToday ? B.accent : B.textSec, marginBottom: 8, paddingBottom: 6, borderBottom: "1px solid " + B.border } }, label + (isToday ? " \u00b7 Today" : "")),
            rows.length === 0
              ? h("div", { style: { fontSize: "13px", color: B.textMut, fontStyle: "italic", padding: "4px 2px 10px" } }, "No crew scheduled.")
              : rows.map(function(r, ri) {
                  var sc = POS_STATUSES[r.pos.status] || POS_STATUSES.open;
                  var cname = r.crew.firstName + " " + r.crew.lastName;
                  return h("div", { key: ri, style: { background: B.surface, border: "1px solid " + B.border, borderLeft: "3px solid " + sc.color, borderRadius: 8, padding: "10px 12px", marginBottom: 8, display: "flex", alignItems: "center", gap: 10 } },
                    h("div", { style: { flex: 1, minWidth: 0 } },
                      h("div", { style: { fontSize: "15px", fontWeight: 600, color: B.text } }, cname),
                      h("div", { style: { fontSize: "13px", color: B.textMut, marginTop: 2 } }, r.pos.role + (r.pos.projectName ? " \u00b7 " + r.pos.projectName : ""))),
                    h(window.Badge, { status: r.pos.status }),
                    h(window.LTPCallBtn, { phone: r.crew.phone, name: cname }),
                    h(window.LTPMailBtn, { email: r.crew.email, name: cname }));
                }));
        }));
    }

    return h("div", null,
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
        h("button", { onClick: function() { setWeekOffset(weekOffset - 1); }, style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "4px", padding: "4px 12px", color: B.textMut, cursor: "pointer" } }, "\u25c0"),
        h("h3", { style: { fontSize: "14px", fontWeight: 700, color: B.text, margin: 0 } }, weekLabel),
        h("button", { onClick: function() { setWeekOffset(weekOffset + 1); }, style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "4px", padding: "4px 12px", color: B.textMut, cursor: "pointer" } }, "\u25b6")),
      h("div", { style: { display: "grid", gridTemplateColumns: "140px repeat(7, 1fr)", gap: 1, marginBottom: 2 } },
        h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, padding: "6px 8px" } }, "Crew"),
        weekDates.map(function(ds) {
          var d2 = new Date(ds + "T12:00:00");
          var today = ds === todayISO();
          return h("div", { key: ds, style: { fontSize: "10px", fontWeight: today ? 700 : 500, color: today ? B.accent : B.textMut, textAlign: "center", padding: "4px 0" } }, d2.toLocaleDateString("en-US", { weekday: "short" }) + " " + d2.getDate());
        })),
      h("div", { style: { display: "flex", flexDirection: "column", gap: 1 } },
        activeCrew.map(function(c) {
          var shifts = scheduleMap[c.id] || [];
          return h("div", { key: c.id, style: { display: "grid", gridTemplateColumns: "140px repeat(7, 1fr)", gap: 1 } },
            h("div", { style: { fontSize: "11px", fontWeight: 600, color: B.text, padding: "8px", background: B.surface, borderRadius: "4px", display: "flex", flexDirection: "column", justifyContent: "center" } },
              h("div", null, c.firstName + " " + c.lastName),
              h("div", { style: { fontSize: "9px", color: B.textMut } }, (c.crewRoles || []).join(", "))),
            weekDates.map(function(ds) {
              var dayShifts = shifts.filter(function(s) { return s.date === ds; });
              return h("div", { key: ds, style: { background: dayShifts.length > 0 ? B.accent + "11" : B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: 3, minHeight: 40 } },
                dayShifts.map(function(s, si) {
                  var sc = POS_STATUSES[s.status] || POS_STATUSES.open;
                  return h("div", { key: si, style: { fontSize: "9px", background: sc.color + "22", borderRadius: "3px", padding: "2px 4px", marginBottom: 1, color: B.text, borderLeft: "2px solid " + sc.color } },
                    h("div", { style: { fontWeight: 600 } }, s.role),
                    h("div", { style: { color: B.textMut, fontSize: "8px" } }, s.projectName));
                }));
            }));
        }))
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   PAYOUTS TAB
  // ═══════════════════════════════════════════════════════════════════════════
  // What we OWE crew for confirmed work in a pay period. Rows read the `pay`
  // snapshot locked at confirm time (LTP_stampPay via doConfirm) — never live
  // math — so rate-card or schedule edits after hire don't silently change the
  // figure. A recompute runs alongside purely to FLAG drift; the producer
  // resolves it with an explicit Re-lock. Legacy positions confirmed before
  // snapshots existed show as "not locked" with a live figure and a Lock button.
  function fmtMoney(n) { return "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  // ── QuickBooks payout export — review + push modal ─────────────────────────
  // Loads the server's preview (no side effects), shows a per-person bill review
  // with a validation checklist, and pushes the selected bills. All money comes
  // from the server (re-derived from signed snapshots) — this UI never sends
  // amounts. Mirrors the invoice sendToQuickBooks fetch/toast pattern.
  function PayoutExportModal({ range, onClose }) {
    var [state, setState] = useState({ loading: true, error: null, data: null });
    var [selected, setSelected] = useState({});
    var [pushing, setPushing] = useState(false);
    var [results, setResults] = useState(null);

    function loadPreview() {
      setState({ loading: true, error: null, data: null });
      setResults(null);
      fetch("/api/qbo/payouts/preview", { method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify({ periodStart: range.start, periodEnd: range.end }) })
        .then(function(r) { return r.json().then(function(b) { return { status: r.status, body: b }; }); })
        .then(function(resp) {
          if (resp.status !== 200) { setState({ loading: false, error: (resp.body && resp.body.error) || ("HTTP " + resp.status), data: null }); return; }
          var data = resp.body;
          var sel = {};
          (data.contacts || []).forEach(function(c) { if (!c.blocked && c.billStatus !== "up_to_date") sel[c.contactId] = true; });
          setSelected(sel);
          setState({ loading: false, error: null, data: data });
        })
        .catch(function(e) { setState({ loading: false, error: "Network or server error: " + String(e.message || e), data: null }); });
    }
    React.useEffect(loadPreview, [range.start, range.end]);

    var data = state.data;
    var hasBlocks = !!(data && data.blocks && data.blocks.length);
    var selectedIds = Object.keys(selected).filter(function(k) { return selected[k]; }).map(Number);

    function toggle(cid) { setSelected(function(prev) { var n = Object.assign({}, prev); if (n[cid]) delete n[cid]; else n[cid] = true; return n; }); }

    function doPush() {
      if (!selectedIds.length || pushing) return;
      setPushing(true);
      fetch("/api/qbo/payouts/push", { method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify({ periodStart: range.start, periodEnd: range.end, contactIds: selectedIds }) })
        .then(function(r) { return r.json().then(function(b) { return { status: r.status, body: b }; }); })
        .then(function(resp) {
          setPushing(false);
          if (resp.status !== 200) {
            var d = resp.body || {};
            if (resp.status === 409 && (d.reason === "reconnect" || d.reason === "not_connected"))
              window.LTP_toast(d.reason === "reconnect" ? "Reconnect QuickBooks" : "QuickBooks not connected", { message: d.error, variant: "warn" });
            else window.LTP_toast("Export failed", { message: d.error || ("HTTP " + resp.status), variant: "error" });
            return;
          }
          var res = (resp.body && resp.body.results) || [];
          var byId = {}; res.forEach(function(x) { byId[x.contactId] = x; });
          setResults(byId);
          var posted = res.filter(function(x) { return x.action === "created" || x.action === "updated"; }).length;
          var errs = res.filter(function(x) { return x.action === "error"; }).length;
          var skipped = res.filter(function(x) { return x.action === "skipped"; }).length;
          window.LTP_toast(errs ? "Export finished with errors" : "Payouts exported to QuickBooks", {
            message: posted + " bill" + (posted === 1 ? "" : "s") + " posted"
              + (skipped ? ", " + skipped + " skipped" : "") + (errs ? ", " + errs + " failed" : ""),
            variant: errs ? "error" : "success" });
          loadPreview();   // refresh statuses (created/updated -> up to date)
        })
        .catch(function(e) { setPushing(false); window.LTP_toast("Export failed", { message: "Network or server error: " + String(e.message || e), variant: "error" }); });
    }

    var STATUS = {
      "new": { label: "New", color: B.info }, needs_update: { label: "Needs update", color: B.warn },
      up_to_date: { label: "Up to date", color: B.success }, error: { label: "Error", color: B.danger },
      paid: { label: "Paid", color: B.success }, paid_changed: { label: "Paid · changed", color: B.danger },
      blocked: { label: "Blocked", color: B.danger },
    };
    var RESULT = {
      created: { label: "Created", color: B.success }, updated: { label: "Updated", color: B.success },
      unchanged: { label: "No change", color: B.textMut }, skipped: { label: "Skipped", color: B.warn },
      error: { label: "Failed", color: B.danger },
    };
    function pill(text, color) {
      return h("span", { style: { fontSize: "9px", fontWeight: 700, color: color, background: color + "18",
        border: "1px solid " + color + "44", padding: "2px 7px", borderRadius: "4px", textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" } }, text);
    }

    var body;
    if (state.loading) {
      body = h("div", { style: { fontSize: "12px", color: B.textMut, fontStyle: "italic", padding: "20px 0" } }, "Loading payout preview…");
    } else if (state.error) {
      body = h("div", null,
        h("div", { style: { background: B.danger + "12", border: "1px solid " + B.danger + "33", borderRadius: "6px", padding: "10px 12px", fontSize: "12px", color: B.danger, marginBottom: 12 } }, state.error),
        h(window.Btn, { small: true, variant: "ghost", onClick: loadPreview }, "Retry"));
    } else {
      var contacts = data.contacts || [];
      var billable = contacts.filter(function(c) { return !c.blocked; });
      body = h("div", null,
        // Period + pay day.
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 12 } },
          h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.text } }, data.period.label),
          h("div", { style: { fontSize: "11px", color: B.textMut } }, "Pay day: " + fmt(data.period.payDay)
            + (data.environment ? "  ·  " + data.environment : ""))),
        // Global blocks (must fix before pushing) + warnings.
        (data.blocks || []).map(function(bmsg, i) {
          return h("div", { key: "blk" + i, style: { background: B.danger + "12", border: "1px solid " + B.danger + "33", borderRadius: "6px", padding: "8px 12px", fontSize: "11px", color: B.danger, marginBottom: 8, lineHeight: 1.5 } }, "⛔ " + bmsg);
        }),
        (data.warnings || []).map(function(wmsg, i) {
          return h("div", { key: "wrn" + i, style: { background: B.warn + "12", border: "1px solid " + B.warn + "33", borderRadius: "6px", padding: "8px 12px", fontSize: "11px", color: B.warn, marginBottom: 8, lineHeight: 1.5 } }, "⚠ " + wmsg);
        }),
        contacts.length === 0 && h("div", { style: { fontSize: "12px", color: B.textMut, fontStyle: "italic", padding: "12px 0" } },
          "No signed-off payouts in this pay period. Sign off crew days first."),
        // Per-person rows.
        contacts.length > 0 && h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 4 } },
          contacts.map(function(c) {
            var r = results && results[c.contactId];
            var st = STATUS[c.billStatus] || STATUS["new"];
            var checkable = !c.blocked;
            return h("div", { key: c.contactId, style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px 12px" } },
              h("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
                h("input", { type: "checkbox", checked: !!selected[c.contactId], disabled: !checkable || pushing,
                  onChange: function() { toggle(c.contactId); }, style: { cursor: checkable ? "pointer" : "not-allowed", width: 15, height: 15 } }),
                h("div", { style: { flex: 1, minWidth: 0 } },
                  h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
                    h("span", { style: { fontSize: "12px", fontWeight: 700, color: B.text } }, c.name),
                    c.vendorStatus === "new" && pill("New vendor", B.info),
                    r ? pill((RESULT[r.action] || { label: r.action }).label, (RESULT[r.action] || { color: B.textMut }).color) : pill(st.label, st.color)),
                  h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } },
                    c.blocked ? c.reason
                      : (c.lineCount + " line" + (c.lineCount === 1 ? "" : "s")
                         + (c.existingBill && c.existingBill.docNumber ? "  ·  " + c.existingBill.docNumber : "")))),
                h("span", { style: { fontSize: "13px", fontWeight: 700, color: c.blocked ? B.textMut : B.accent } }, fmtMoney(c.total))),
              // Per-contact warnings + push error detail.
              ((c.warnings && c.warnings.length) || (r && r.action === "error")) && h("div", { style: { marginTop: 6, paddingLeft: 25 } },
                (c.warnings || []).map(function(w, wi) { return h("div", { key: "cw" + wi, style: { fontSize: "10px", color: B.warn } }, "⚠ " + w); }),
                r && r.action === "error" && h("div", { style: { fontSize: "10px", color: B.danger } }, "⛔ " + (r.error || "failed"))));
          })),
        // Totals.
        contacts.length > 0 && h("div", { style: { display: "flex", justifyContent: "space-between", marginTop: 12, paddingTop: 10, borderTop: "1px solid " + B.border, fontSize: "12px" } },
          h("span", { style: { color: B.textMut } }, billable.length + " billable · " + selectedIds.length + " selected"),
          h("span", { style: { fontWeight: 700, color: B.text } }, "Period total: " + fmtMoney(data.grandTotal))));
    }

    return h(window.LTPModal, { title: "Export payouts to QuickBooks", onClose: onClose, wide: true },
      body,
      h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", marginTop: 16 } },
        hasBlocks && h("span", { style: { fontSize: "10px", color: B.danger, marginRight: "auto" } }, "Resolve the blockers above before exporting."),
        h(window.Btn, { variant: "ghost", onClick: onClose }, "Close"),
        h(window.Btn, { onClick: doPush, disabled: state.loading || !!state.error || hasBlocks || !selectedIds.length || pushing },
          pushing ? "Exporting…" : "Export " + selectedIds.length + " bill" + (selectedIds.length === 1 ? "" : "s"))));
  }

  function PayoutsTab({ projects, setProjects, contacts, services, settings, isAdmin, qbo }) {
    var isMobile = window.LTP_useIsMobile();
    function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

    // ── Pay-period config (bi-weekly payroll cycle) ──────────────────────────
    // Anchor + length come from Settings; when unset, the pay-period presets
    // hide and the tab falls back to the week/month presets. The period range
    // is computed by the same helpers the backend mirrors (theme.js::LTP_payPeriod*).
    var payAnchor = settings && settings.payPeriodAnchor;
    var payLen = (settings && settings.payPeriodLengthDays) || 14;
    var payOffset = (settings && settings.payPeriodPayDayOffsetDays) || 0;
    var curPeriod = window.LTP_payPeriodBounds(payAnchor, payLen, todayISO());
    var payConfigured = !!curPeriod;
    function periodRange(idx) {
      var pp = window.LTP_payPeriodForIndex(payAnchor, payLen, idx);
      return pp ? { start: pp.start, end: pp.end } : null;
    }

    function rangeFor(preset) {
      var d = new Date(todayISO() + "T12:00:00"); // noon: immune to DST/tz edges
      if (preset === "month") {
        return { start: iso(new Date(d.getFullYear(), d.getMonth(), 1)), end: iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
      }
      var mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7) - (preset === "lastweek" ? 7 : 0));
      var sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      return { start: iso(mon), end: iso(sun) };
    }
    var [preset, setPreset] = useState(payConfigured ? "period" : "week");
    var [periodIndex, setPeriodIndex] = useState(payConfigured ? curPeriod.index : 0);
    var [range, setRange] = useState(function() { return payConfigured ? periodRange(curPeriod.index) : rangeFor("week"); });
    function pickPreset(p) {
      // "period" = this cycle; "lastperiod" = previous cycle. Both live under the
      // "period" preset (the navigator drives the index); other presets are date-window.
      if (p === "period" || p === "lastperiod") {
        var i = (curPeriod ? curPeriod.index : 0) - (p === "lastperiod" ? 1 : 0);
        setPreset("period"); setPeriodIndex(i); setRange(periodRange(i) || rangeFor("week"));
      } else { setPreset(p); setRange(rangeFor(p)); }
    }
    function shiftPeriod(delta) {
      var i = periodIndex + delta;
      var r = periodRange(i); if (!r) return;
      setPreset("period"); setPeriodIndex(i); setRange(r);
    }

    var data = useMemo(function() {
      return window.LTP_payoutRows(projects, contacts, services, range.start, range.end);
    }, [projects, contacts, services, range.start, range.end]);

    function crewLabel(id) { var c = contacts.find(function(x) { return x.id === id; }); return c ? (c.firstName + " " + c.lastName).trim() : "Unknown"; }

    // ── Day-of sign-off ──────────────────────────────────────────────────────
    var [adjustDlg, setAdjustDlg] = useState(null);  // { row, shifts, actuals }
    var [noShowDlg, setNoShowDlg] = useState(null);  // row awaiting no-show confirm
    var [adjPayDlg, setAdjPayDlg] = useState(null);  // { row, list, label, amount } — pay adjustments
    var [exportDlg, setExportDlg] = useState(null);  // QuickBooks payout export modal (truthy = open)
    var canExport = isAdmin && qbo && qbo.connected;

    // Persist a row's pay adjustments (extras/deductions on top of the day's pay).
    function savePayAdjustments(row, list) {
      var net = Math.round(list.reduce(function(t, a) { return t + (a.amount || 0); }, 0) * 100) / 100;
      setProjects(function(prev) {
        return prev.map(function(p) {
          if (p.id !== row.projectId) return p;
          var updated = Object.assign({}, p, { schedule: window.LTP_setPayAdjustments(p.schedule || [], row.crewId, row.date, list) });
          var actEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0, 5),
            type: "saved", user: (window.LTP_CURRENT_USER || "User"),
            message: "Pay adjustments: " + crewLabel(row.crewId) + " · " + fmt(row.date) + " → " +
              (list.length ? (list.length + " item" + (list.length > 1 ? "s" : "") + ", net " + (net < 0 ? "−" : "+") + fmtMoney(Math.abs(net))) : "cleared"),
            changes: [{ cat: "Pay Adjusted", detail: crewLabel(row.crewId) + " " + fmt(row.date) + " net " + (net < 0 ? "−" : "+") + fmtMoney(Math.abs(net)) }] };
          return Object.assign({}, updated, { scheduleActivity: (updated.scheduleActivity || []).concat([actEntry]) });
        });
      });
      window.LTP_toast("Pay adjustments saved", { message: crewLabel(row.crewId) + " · " + fmt(row.date) + (list.length ? " — net " + (net < 0 ? "−" : "+") + fmtMoney(Math.abs(net)) : " — cleared"), variant: "success" });
    }

    // The person's confirmed shifts on a row's day — the entries the adjust
    // modal edits and the no-show path marks.
    function dayShifts(row) {
      var proj = projects.find(function(p) { return p.id === row.projectId; });
      var out = [];
      ((proj && proj.schedule) || []).forEach(function(s) {
        if (s.date !== row.date) return;
        (s.positions || []).forEach(function(p) {
          if (p.crewId === row.crewId && p.status === "confirmed") {
            out.push({ posId: p.id, title: s.title || "Shift", time: s.time || "", endTime: s.endTime || "" });
          }
        });
      });
      return out;
    }

    // Preview the final figure a sign-off would freeze (same engine call the
    // real sign-off makes) — used for toasts and the adjust modal's live total.
    function finalTotalFor(row, actuals) {
      var proj = projects.find(function(p) { return p.id === row.projectId; });
      if (!proj) return 0;
      var next = window.LTP_signOffDay(proj.schedule || [], row.crewId, row.date, actuals, services, window.LTP_crewMinMap(contacts), "preview", "preview");
      var t = 0;
      next.forEach(function(s) {
        if (s.date !== row.date) return;
        (s.positions || []).forEach(function(p) { if (p.crewId === row.crewId && p.status === "confirmed" && p.work && p.work.pay) t = p.work.pay.total; });
      });
      return t;
    }

    function signOff(row, actuals, stateLabel) {
      var total = finalTotalFor(row, actuals);
      var now = new Date().toISOString();
      var user = window.LTP_CURRENT_USER || "User";
      var mins = window.LTP_crewMinMap(contacts);
      setProjects(function(prev) {
        return prev.map(function(p) {
          if (p.id !== row.projectId) return p;
          var updated = Object.assign({}, p, { schedule: window.LTP_signOffDay(p.schedule || [], row.crewId, row.date, actuals, services, mins, now, user) });
          var actEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0, 5),
            type: "saved", user: user,
            message: "Day signed off (" + stateLabel + "): " + crewLabel(row.crewId) + " · " + fmt(row.date) + " → " + fmtMoney(total),
            changes: [{ cat: "Day Signed Off", detail: crewLabel(row.crewId) + " " + fmt(row.date) + " " + stateLabel + " → " + fmtMoney(total) }] };
          return Object.assign({}, updated, { scheduleActivity: (updated.scheduleActivity || []).concat([actEntry]) });
        });
      });
      window.LTP_toast("Day signed off", { message: crewLabel(row.crewId) + " · " + fmt(row.date) + " (" + stateLabel + ") → " + fmtMoney(total), variant: "success" });
    }

    function markWorked(row) { signOff(row, {}, "worked as scheduled"); }

    function doNoShow(row) {
      setNoShowDlg(null);
      var actuals = {};
      dayShifts(row).forEach(function(sh) { actuals[sh.posId] = { state: "no_show" }; });
      signOff(row, actuals, "no-show");
    }

    function openAdjust(row) {
      var shifts = dayShifts(row);
      var actuals = {};
      shifts.forEach(function(sh) { actuals[sh.posId] = { worked: true, time: sh.time, endTime: sh.endTime }; });
      setAdjustDlg({ row: row, shifts: shifts, actuals: actuals });
    }

    function saveAdjust() {
      var d = adjustDlg;
      setAdjustDlg(null);
      var actuals = {};
      d.shifts.forEach(function(sh) {
        var a = d.actuals[sh.posId];
        if (!a.worked) actuals[sh.posId] = { state: "no_show" };
        else if (a.time !== sh.time || a.endTime !== sh.endTime) actuals[sh.posId] = { state: "adjusted", time: a.time, endTime: a.endTime };
        // unchanged + worked → omitted → "worked"
      });
      signOff(d.row, actuals, "adjusted");
    }

    function undoSign(row) {
      setProjects(function(prev) {
        return prev.map(function(p) {
          if (p.id !== row.projectId) return p;
          var updated = Object.assign({}, p, { schedule: window.LTP_unsignDay(p.schedule || [], row.crewId, row.date) });
          var actEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0, 5),
            type: "saved", user: (window.LTP_CURRENT_USER || "User"),
            message: "Sign-off undone: " + crewLabel(row.crewId) + " · " + fmt(row.date) + " (was " + fmtMoney(row.payable || 0) + ")",
            changes: [{ cat: "Sign-off Undone", detail: crewLabel(row.crewId) + " " + fmt(row.date) + " back to pending" }] };
          return Object.assign({}, updated, { scheduleActivity: (updated.scheduleActivity || []).concat([actEntry]) });
        });
      });
      window.LTP_toast("Sign-off undone", { message: crewLabel(row.crewId) + " · " + fmt(row.date) + " is pending again.", variant: "success" });
    }

    // Lock (or re-lock) one person's day at today's computed figure. Explicit,
    // per-row — this is the producer accepting the current number as agreed.
    function lockRow(row) {
      var wasLocked = !!row.locked;
      var newTotal = row.current ? row.current.total : 0;
      var mins = window.LTP_crewMinMap(contacts);
      var now = new Date().toISOString();
      setProjects(function(prev) {
        return prev.map(function(p) {
          if (p.id !== row.projectId) return p;
          var updated = Object.assign({}, p, { schedule: window.LTP_stampPay(p.schedule, row.crewId, services, mins, now, [row.date]) });
          var actEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0, 5),
            type: "saved", user: (window.LTP_CURRENT_USER || "User"),
            message: "Pay " + (wasLocked ? "re-locked" : "locked") + ": " + crewLabel(row.crewId) + " · " + fmt(row.date) + " → " + fmtMoney(newTotal),
            changes: [{ cat: "Pay Locked", detail: crewLabel(row.crewId) + " " + fmt(row.date) + " → " + fmtMoney(newTotal) }] };
          return Object.assign({}, updated, { scheduleActivity: (updated.scheduleActivity || []).concat([actEntry]) });
        });
      });
      window.LTP_toast(wasLocked ? "Pay re-locked" : "Pay locked", { message: crewLabel(row.crewId) + " · " + fmt(row.date) + " → " + fmtMoney(newTotal), variant: "success" });
    }

    function exportCSV() {
      var esc = function(v) { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      var lines = [["Crew", "Date", "Project", "State", "Tier", "Paid Hours", "OT Hours", "Meal Penalty Hours", "Pay", "Adjustments", "Adjustment Notes", "Locked", "Locked At", "Signed At", "Signed By", "Changed Since Lock"].join(",")];
      data.groups.forEach(function(g) {
        g.rows.forEach(function(r) {
          var src = r.signed ? r.signed.pay : (r.locked || r.current || {});
          lines.push([esc(g.crewName), r.date, esc(r.projectName),
            r.signed ? r.signed.state.replace("_", "-") : "pending",
            src.tier || "",
            src.paidHours != null ? src.paidHours : "", src.otHours != null ? src.otHours : "",
            src.mealPenaltyHours != null ? src.mealPenaltyHours : "",
            (r.payable != null ? r.payable : r.estimate).toFixed(2),
            r.adjTotal ? r.adjTotal.toFixed(2) : "",
            esc((r.adjustments || []).map(function(a) { return (a.amount < 0 ? "-" : "+") + Math.abs(a.amount) + (a.label ? " " + a.label : ""); }).join("; ")),
            r.locked ? "yes" : "no", r.locked ? r.locked.lockedAt : "",
            r.signed ? r.signed.signedAt : "", r.signed ? esc(r.signed.signedBy) : "",
            r.drift ? "yes" : ""].join(","));
        });
      });
      var blob = new Blob([lines.join("\n")], { type: "text/csv" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "crew-payouts_" + range.start + "_" + range.end + ".csv";
      a.click();
      URL.revokeObjectURL(a.href);
    }

    function tierLabel(src) {
      if (!src) return "—";
      if (!src.tier && !(src.paidHours > 0)) return "No-show";
      var t = src.tier === "half" ? "Half day" : src.tier === "full" ? "Full day" : "Mixed";
      var hrs = src.paidHours + "h" + (src.otHours > 0 ? " · " + src.otHours + "h OT" : "");
      return t + " · " + hrs;
    }

    var presetBtn = function(key, label) {
      var active = preset === key;
      return h("button", { key: key, onClick: function() { pickPreset(key); },
        style: { background: active ? B.accent : B.raised, color: active ? B.btnInk : B.textMut, border: "1px solid " + (active ? B.accent : B.border), borderRadius: "4px", padding: "4px 12px", fontSize: "11px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" } }, label);
    };
    // Pay-period presets: "period" (this cycle) / "lastperiod" (previous). Active
    // highlight tracks the navigator index, not a distinct preset value.
    var payPeriodBtn = function(key, label) {
      var active = preset === "period" && curPeriod && (key === "period" ? periodIndex === curPeriod.index : periodIndex === curPeriod.index - 1);
      return h("button", { key: key, onClick: function() { pickPreset(key); },
        style: { background: active ? B.accent : B.raised, color: active ? B.btnInk : B.textMut, border: "1px solid " + (active ? B.accent : B.border), borderRadius: "4px", padding: "4px 12px", fontSize: "11px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" } }, label);
    };
    // ◀ [period label · pay day] ▶ — shown only when a cycle is configured and a
    // pay-period preset is active (not for week/month/custom).
    var periodNav = (payConfigured && preset === "period") ? h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" } },
      h("button", { onClick: function() { shiftPeriod(-1); }, className: "ltp-tap", "aria-label": "Previous pay period", style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "4px 12px", color: B.textMut, cursor: "pointer", fontFamily: "inherit" } }, "◀"),
      h("div", null,
        h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.text } },
          (function() { var n = window.LTP_payPeriodNumberInYear(payAnchor, payLen, periodIndex); return n ? ("Pay Period #" + n.number + " · " + n.year + "  ") : ""; })()
          + window.LTP_payPeriodLabel(range.start, range.end)),
        h("div", { style: { fontSize: "10px", color: B.textMut } }, "Pay day: " + window.LTP_formatDate(window.LTP_payPeriodPayDay(range.end, payOffset)))),
      h("button", { onClick: function() { shiftPeriod(1); }, className: "ltp-tap", "aria-label": "Next pay period", style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "4px 12px", color: B.textMut, cursor: "pointer", fontFamily: "inherit" } }, "▶")) : null;

    var fromInput = h(window.LTPInput, { label: "From", value: range.start, onChange: function(v) { setPreset("custom"); setRange({ start: v, end: range.end }); }, type: "date" });
    var toInput = h(window.LTPInput, { label: "To", value: range.end, onChange: function(v) { setPreset("custom"); setRange({ start: range.start, end: v }); }, type: "date" });

    return h("div", null,
      // Range controls + export. On mobile the custom From/To inputs drop to
      // their own row so the presets + export don't crush against them.
      isMobile
      ? h("div", { style: { marginBottom: 14 } },
          h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 } },
            payConfigured && payPeriodBtn("period", "This Pay Period"), payConfigured && payPeriodBtn("lastperiod", "Last Pay Period"),
            presetBtn("week", "This Week"), presetBtn("lastweek", "Last Week"), presetBtn("month", "This Month"),
            h("div", { style: { flex: 1 } }),
            canExport && h(window.Btn, { small: true, onClick: function() { if (preset !== "period") pickPreset("period"); setExportDlg({}); } }, "Export to QuickBooks"),
            h(window.Btn, { small: true, variant: "ghost", onClick: exportCSV, disabled: data.groups.length === 0 }, "Export CSV")),
          h("div", { style: { display: "flex", gap: 8 } },
            h("div", { style: { flex: 1 } }, fromInput),
            h("div", { style: { flex: 1 } }, toInput)))
      : h("div", { style: { display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 14, flexWrap: "wrap" } },
          payConfigured && payPeriodBtn("period", "This Pay Period"), payConfigured && payPeriodBtn("lastperiod", "Last Pay Period"),
          presetBtn("week", "This Week"), presetBtn("lastweek", "Last Week"), presetBtn("month", "This Month"),
          h("div", { style: { width: 130 } }, fromInput),
          h("div", { style: { width: 130 } }, toInput),
          h("div", { style: { flex: 1 } }),
          canExport && h(window.Btn, { small: true, onClick: function() { if (preset !== "period") pickPreset("period"); setExportDlg({}); } }, "Export to QuickBooks"),
          h(window.Btn, { small: true, variant: "ghost", onClick: exportCSV, disabled: data.groups.length === 0 }, "Export CSV")),

      periodNav,

      // Period summary — payable is SIGNED work only; pending days are estimates.
      h("div", { style: { display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" } },
        h(window.StatCard, { label: "Period Payout", value: fmtMoney(data.grandTotal), sub: "signed off", accent: B.accent }),
        h(window.StatCard, { label: "Crew", value: String(data.groups.length) }),
        data.pendingCount > 0 && h(window.StatCard, { label: "Pending Sign-off", value: String(data.pendingCount), sub: "est. " + fmtMoney(data.pendingTotal), accent: B.warn }),
        data.unlockedCount > 0 && h(window.StatCard, { label: "Not Locked", value: String(data.unlockedCount), accent: B.warn }),
        data.driftCount > 0 && h(window.StatCard, { label: "Changed Since Lock", value: String(data.driftCount), accent: B.danger })),

      data.groups.length === 0
        ? h(window.EmptyState, { text: "No confirmed crew shifts between " + fmt(range.start) + " and " + fmt(range.end) + ". Payouts show confirmed work only." })
        : data.groups.map(function(g) {
            return h("div", { key: g.crewId, style: { background: B.raised, borderRadius: "8px", border: "1px solid " + B.border, marginBottom: 12, overflow: "hidden" } },
              h("div", { style: { background: B.accent + "12", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "2px solid " + B.accent + "44", borderLeft: "3px solid " + B.accent } },
                h("span", { style: { fontSize: "13px", fontWeight: 700, color: B.text } }, g.crewName),
                h("span", { style: { display: "flex", gap: 8, alignItems: "baseline" } },
                  g.pendingTotal > 0 && h("span", { style: { fontSize: "10px", color: B.textMut, fontStyle: "italic" } }, "+ est. " + fmtMoney(g.pendingTotal) + " pending"),
                  h("span", { style: { fontSize: "13px", fontWeight: 700, color: B.accent } }, fmtMoney(g.total)))),
              h("div", { style: { padding: "6px 8px", display: "flex", flexDirection: "column", gap: 6 } },
                g.rows.map(function(r, ri) {
                  var chip = function(color, text, title) {
                    return h("span", { style: { flexShrink: 0, fontSize: "9px", fontWeight: 700, color: color, background: color + "18", border: "1px solid " + color + "44", borderRadius: "3px", padding: "2px 6px", whiteSpace: "nowrap" }, title: title }, text);
                  };
                  var src = r.signed ? r.signed.pay : (r.locked || r.current);
                  var minApplied = !!(src && (src.units || []).some(function(u) { return u.minApplied; }));
                  var allMargin = !!(src && (src.units || []).length > 0 && (src.units || []).every(function(u) { return u.fullMargin; }));
                  var canSign = !r.signed && r.date <= todayISO();  // no signing off the future
                  var stateChips = { worked: { c: B.success, t: "✓ worked" }, adjusted: { c: B.info, t: "adjusted" }, no_show: { c: B.danger, t: "no-show" } };
                  var sBtn = function(label, onClick, bg, title) {
                    return h("button", { onClick: onClick, title: title,
                      style: { flexShrink: 0, background: bg || "transparent", border: bg ? "none" : "1px solid " + B.border, borderRadius: "4px", padding: "3px 10px", color: bg ? B.btnInk : B.textSec, fontSize: "10px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" } }, label);
                  };
                  return h("div", { key: ri, style: { background: B.surface, border: "1px solid " + (r.drift ? B.danger + "66" : B.border), borderRadius: "6px", padding: "8px 10px", display: "flex", gap: 8, alignItems: isMobile ? "flex-start" : "center", flexWrap: isMobile ? "wrap" : "nowrap" } },
                    h("div", { style: { width: 86, flexShrink: 0, order: isMobile ? 0 : undefined, fontSize: "11px", fontWeight: 600, color: B.text } }, fmt(r.date)),
                    h("div", { style: { flex: 1, minWidth: 0, order: isMobile ? 1 : undefined } },
                      h("div", { style: { fontSize: "11px", fontWeight: 600, color: B.accent, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, onClick: function() { nav("projects/" + r.projectId + "/schedule"); } }, r.projectName),
                      h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 1 } }, tierLabel(src)),
                      (r.adjustments || []).length > 0 && h("div", { style: { fontSize: "10px", color: B.info, marginTop: 1 } },
                        r.adjustments.map(function(a) { return (a.amount < 0 ? "−" : "+") + fmtMoney(Math.abs(a.amount)) + (a.label ? " " + a.label : ""); }).join(" · ")),
                      r.drift && h("div", { style: { fontSize: "10px", color: B.danger, marginTop: 2 } },
                        "Changed since lock: " + fmtMoney(r.locked.total) + " locked → " + (r.current ? fmtMoney(r.current.total) : "no timed shifts") + " now")),
                    // Pay amount: pinned to the top row's right on mobile (order 2),
                    // trails the action buttons on desktop.
                    h("div", { style: { width: 84, flexShrink: 0, textAlign: "right", order: isMobile ? 2 : undefined, marginLeft: isMobile ? "auto" : undefined, fontSize: "12px", fontWeight: 700, color: r.signed ? B.text : B.textMut, fontStyle: r.signed ? "normal" : "italic" },
                      title: r.signed ? "Final signed-off pay." : "Estimate — becomes payable when the day is signed off." },
                      (r.signed ? "" : "est. ") + fmtMoney(r.payable != null ? r.payable : r.estimate)),
                    // Chips + sign-off buttons: a wrapped second line on mobile,
                    // inline on desktop (display:contents leaves the row unchanged).
                    h("div", { style: isMobile ? { order: 3, flexBasis: "100%", display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 2 } : { display: "contents" } },
                      minApplied && chip(B.warn, "min rate", "Includes this crew member's negotiated minimum day rate."),
                      allMargin && chip(B.success, "margin"),
                      r.signed
                        ? h(React.Fragment, null,
                            chip(stateChips[r.signed.state].c, stateChips[r.signed.state].t,
                              "Signed off " + String(r.signed.signedAt || "").slice(0, 10) + (r.signed.signedBy ? " by " + r.signed.signedBy : "")),
                            sBtn("undo", function() { undoSign(r); }, null, "Undo the sign-off — the day returns to pending."))
                        : h(React.Fragment, null,
                            !r.locked && chip(B.warn, "not locked", "Confirmed before pay locking existed — the figure shown is computed from today's rates."),
                            (!r.locked || r.drift) && h("button", { onClick: function() { lockRow(r); },
                              style: { flexShrink: 0, background: r.drift ? B.danger : B.info, border: "none", borderRadius: "4px", padding: "3px 10px", color: B.btnInk, fontSize: "10px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" } }, r.drift ? "Re-lock" : "Lock"),
                            canSign && sBtn("✓ Worked", function() { markWorked(r); }, B.success, "Sign off: worked as scheduled."),
                            canSign && sBtn("Adjust…", function() { openAdjust(r); }, null, "Sign off with actual times / dropped shifts."),
                            canSign && sBtn("No-show", function() { setNoShowDlg(r); }, null, "Sign off: didn't work — pays $0."),
                            !canSign && chip(B.textMut, "upcoming", "Sign-off opens once the day has arrived.")),
                      sBtn("$±", function() { setAdjPayDlg({ row: r, list: (r.adjustments || []).slice(), label: "", amount: "" }); }, null,
                        "Add extras or deductions for this day (parking, gear, bonus, advance…). Negative amounts deduct.")));
                })));
          }),

      // Pay adjustments — extras/deductions on top of the day's pay, usable
      // before or after sign-off (independent of the worked-hours math).
      adjPayDlg && (function() {
        var d = adjPayDlg;
        var net = Math.round(d.list.reduce(function(t, a) { return t + (a.amount || 0); }, 0) * 100) / 100;
        var pendingAmt = parseFloat(d.amount);
        var canAdd = !isNaN(pendingAmt) && pendingAmt !== 0;
        function addItem() {
          if (!canAdd) return;
          setAdjPayDlg(Object.assign({}, d, { list: d.list.concat([{ id: genId("adj"), amount: Math.round(pendingAmt * 100) / 100, label: d.label.trim(), addedAt: todayISO(), addedBy: (window.LTP_CURRENT_USER || "User") }]), label: "", amount: "" }));
        }
        function save() {
          var list = d.list;
          if (canAdd) list = list.concat([{ id: genId("adj"), amount: Math.round(pendingAmt * 100) / 100, label: d.label.trim(), addedAt: todayISO(), addedBy: (window.LTP_CURRENT_USER || "User") }]);
          setAdjPayDlg(null);
          savePayAdjustments(d.row, list);
        }
        return h(window.LTPModal, { title: "Pay adjustments — " + crewLabel(d.row.crewId) + " · " + fmt(d.row.date), onClose: function() { setAdjPayDlg(null); } },
          h("p", { style: { fontSize: "11px", color: B.textSec, lineHeight: 1.5, marginBottom: 12 } },
            "Extras or deductions on top of the day's pay — parking, gear rental, a bonus, an advance. Use a negative amount to deduct. These are payout-only and never billed to the client."),
          d.list.length > 0 && h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 } },
            d.list.map(function(a, ai) {
              return h("div", { key: a.id || ai, style: { display: "flex", gap: 10, alignItems: "center", background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 10px" } },
                h("span", { style: { fontSize: "12px", fontWeight: 700, color: a.amount < 0 ? B.danger : B.success, width: 80 } }, (a.amount < 0 ? "−" : "+") + fmtMoney(Math.abs(a.amount))),
                h("span", { style: { flex: 1, fontSize: "11px", color: B.text } }, a.label || "—"),
                a.addedBy && h("span", { style: { fontSize: "9px", color: B.textMut } }, a.addedBy + (a.addedAt ? " · " + fmt(a.addedAt) : "")),
                h("button", { onClick: function() { setAdjPayDlg(Object.assign({}, d, { list: d.list.filter(function(x, xi) { return xi !== ai; }) })); },
                  style: { background: "transparent", border: "none", color: B.textMut, cursor: "pointer", fontSize: "13px", padding: 0, lineHeight: 1 } }, "×"));
            })),
          h("div", { style: { display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 14 } },
            h("div", { style: { width: 110 } },
              h(window.LTPInput, { label: "Amount ($)", value: d.amount, onChange: function(v) { setAdjPayDlg(Object.assign({}, d, { amount: v })); }, type: "number" })),
            h("div", { style: { flex: 1 } },
              h(window.LTPInput, { label: "Reason", value: d.label, onChange: function(v) { setAdjPayDlg(Object.assign({}, d, { label: v })); }, placeholder: "e.g. parking, gear rental, stayed late bonus" })),
            h(window.Btn, { small: true, variant: "ghost", onClick: addItem, disabled: !canAdd }, "+ Add")),
          h("div", { style: { display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" } },
            h("span", { style: { fontSize: "12px", fontWeight: 700, color: net < 0 ? B.danger : B.accent } },
              "Net: " + (net < 0 ? "−" : "+") + fmtMoney(Math.abs(net))),
            h("div", { style: { display: "flex", gap: 8 } },
              h(window.Btn, { variant: "ghost", onClick: function() { setAdjPayDlg(null); } }, "Cancel"),
              h(window.Btn, { onClick: save }, "Save"))));
      })(),

      // No-show confirm
      noShowDlg && h(window.LTPModal, { title: "No-show — " + crewLabel(noShowDlg.crewId), onClose: function() { setNoShowDlg(null); } },
        h("p", { style: { fontSize: "12px", color: B.textSec, lineHeight: 1.6, marginBottom: 16 } },
          crewLabel(noShowDlg.crewId) + " didn't work " + fmt(noShowDlg.date) + " on " + noShowDlg.projectName + "? The day is signed off at $0.00. You can undo this later."),
        h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
          h(window.Btn, { variant: "ghost", onClick: function() { setNoShowDlg(null); } }, "Cancel"),
          h(window.Btn, { variant: "danger", onClick: function() { doNoShow(noShowDlg); } }, "Mark No-show"))),

      // QuickBooks payout export (review + push)
      exportDlg && h(PayoutExportModal, { range: range, onClose: function() { setExportDlg(null); } }),

      // Adjust-day sign-off
      adjustDlg && (function() {
        var d = adjustDlg;
        var previewActuals = {};
        d.shifts.forEach(function(sh) {
          var a = d.actuals[sh.posId];
          if (!a.worked) previewActuals[sh.posId] = { state: "no_show" };
          else if (a.time !== sh.time || a.endTime !== sh.endTime) previewActuals[sh.posId] = { state: "adjusted", time: a.time, endTime: a.endTime };
        });
        var preview = finalTotalFor(d.row, previewActuals);
        function setA(posId, patch) {
          var next = Object.assign({}, d.actuals);
          next[posId] = Object.assign({}, next[posId], patch);
          setAdjustDlg(Object.assign({}, d, { actuals: next }));
        }
        var timeInp = function(val, disabled, onChange) {
          return h("input", { type: "time", value: val, disabled: disabled, onChange: function(e) { onChange(e.target.value); },
            style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "4px 6px", color: disabled ? B.textMut : B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", opacity: disabled ? 0.5 : 1 } });
        };
        return h(window.LTPModal, { title: "Adjust day — " + crewLabel(d.row.crewId) + " · " + fmt(d.row.date), onClose: function() { setAdjustDlg(null); } },
          h("p", { style: { fontSize: "11px", color: B.textSec, lineHeight: 1.5, marginBottom: 12 } },
            "Enter what was actually worked. Unchecked shifts pay nothing; times start at the scheduled values."),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 } },
            d.shifts.map(function(sh) {
              var a = d.actuals[sh.posId];
              return h("div", { key: sh.posId, style: { display: "flex", gap: 10, alignItems: "center", background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px 10px" } },
                h("input", { type: "checkbox", checked: !!a.worked, onChange: function(e) { setA(sh.posId, { worked: e.target.checked }); }, style: { cursor: "pointer" } }),
                h("div", { style: { flex: 1, minWidth: 0 } },
                  h("div", { style: { fontSize: "11px", fontWeight: 600, color: a.worked ? B.text : B.textMut, textDecoration: a.worked ? "none" : "line-through" } }, sh.title),
                  h("div", { style: { fontSize: "9px", color: B.textMut } }, "scheduled " + (ft(sh.time) || "—") + " – " + (ft(sh.endTime) || "—"))),
                timeInp(a.time, !a.worked, function(v) { setA(sh.posId, { time: v }); }),
                h("span", { style: { color: B.textMut, fontSize: "11px" } }, "–"),
                timeInp(a.endTime, !a.worked, function(v) { setA(sh.posId, { endTime: v }); }));
            })),
          h("div", { style: { display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" } },
            h("span", { style: { fontSize: "12px", fontWeight: 700, color: B.accent } }, "Final: " + fmtMoney(preview)),
            h("div", { style: { display: "flex", gap: 8 } },
              h(window.Btn, { variant: "ghost", onClick: function() { setAdjustDlg(null); } }, "Cancel"),
              h(window.Btn, { onClick: saveAdjust }, "Save & Sign Off"))));
      })());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   CREW REQUESTS TAB
  // ═══════════════════════════════════════════════════════════════════════════
  // Sent tokenized crew requests with live accept/decline status + the note the
  // crew member left, plus Resend / Withdraw on still-pending ones. Crew
  // responses also flow back as POSITION status changes (reconciled into the
  // Assignments view); this tab tracks the request envelope itself.
  function CrewRequestsTab({ crewRequests, reloadCrewRequests, contacts, projects, setProjects, services, companies }) {
    var isMobile = window.LTP_useIsMobile();
    // Resend / withdraw / confirm confirmations + errors surface as toasts (window.LTP_toast).
    var [withdrawDlg, setWithdrawDlg] = useState(null);  // pending request awaiting a withdraw decision
    var [confirmDlg, setConfirmDlg] = useState(null);    // accepted request awaiting a confirm decision
    // Default to OPEN requests only — the ones still needing action (waiting on
    // the crew member, or accepted and awaiting confirm). Fully-confirmed and
    // declined requests are done; the pills opt them back in.
    var [filter, setFilter] = useState("open");

    // Refresh on open so a crew member's response since last load shows up here
    // (and reconciles into the Assignments view).
    React.useEffect(function() { reloadCrewRequests(); }, []);

    function crewLabel(id) { var c = contacts.find(function(x) { return x.id === id; }); return c ? (c.firstName + " " + c.lastName).trim() : "Unknown"; }
    function projLabel(id) { var p = (projects || []).find(function(x) { return x.id === id; }); return p ? p.name : "Project"; }

    // Withdraw a pending request: kill the crew link now, reopen its shifts, and
    // park the crew-withdrawn email in the notify tray (coalesced per person,
    // sent on demand) rather than emailing inline — so withdrawing several of one
    // person's requests doesn't email them once each.
    function doWithdraw(req) {
      setWithdrawDlg(null);
      fetch("/api/crew-requests/" + req.id + "/withdraw", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notify: false }),
      })
        .then(function(r) { return r.json().then(function(j) { return { ok: r.ok, body: j }; }, function() { return { ok: r.ok, body: {} }; }); })
        .then(function(res) {
          if (!res.ok) {
            window.LTP_toast("Withdraw failed", { message: (res.body && res.body.detail && (res.body.detail.message || res.body.detail)) || "could not withdraw the request", variant: "error" });
            reloadCrewRequests();
            return;
          }
          var proj = (projects || []).find(function(p) { return p.id === req.projectId; });
          // Snapshot the shifts BEFORE flipping (it reads the live positions),
          // then reopen them AND clear the crew so the slot returns to empty.
          var snapshotShifts = proj ? window.LTP_shiftSnapshots(proj.schedule, req.positionIds, services) : [];
          flipPositionsLocal(setProjects, req.projectId, req.positionIds, "requested", "open", true);
          window.LTP_outbox.add({ crewId: req.contactId, crewName: crewLabel(req.contactId), projectId: req.projectId, projectName: projLabel(req.projectId),
            template: "crewWithdrawn", shifts: snapshotShifts });
          window.LTP_toast("Request withdrawn", { message: crewLabel(req.contactId) + " queued in the notify tray.", variant: "success" });
          reloadCrewRequests();
        })
        .catch(function() { reloadCrewRequests(); });
    }

    function resendRequest(req) {
      fetch("/api/crew-requests/" + req.id + "/resend", { method: "POST", credentials: "include" })
        .then(function(r) { return r.json().then(function(j) { return { ok: r.ok, body: j }; }, function() { return { ok: r.ok, body: {} }; }); })
        .then(function(res) {
          var es = (res.ok && res.body.emailStatus) || {};
          if (es.emailed) {
            window.LTP_toast("Request re-sent", { message: "Email re-sent to " + crewLabel(req.contactId) + ".", variant: "success" });
          } else if (es.needsReconnect) {
            window.LTP_toast("Email not re-sent", { message: "Connect Google in Settings, then try Resend again.", variant: "warn" });
          } else {
            window.LTP_toast("Resend failed", { message: crewLabel(req.contactId) + ": " + ((res.body && res.body.detail && res.body.detail.message) || es.error || "resend failed"), variant: "error" });
          }
          reloadCrewRequests();
        })
        .catch(function() { reloadCrewRequests(); });
    }

    function roleLabelFor(pos) {
      var svc = pos.serviceId ? (services || []).find(function(s) { return s.id === pos.serviceId; }) : null;
      return svc ? (svc.role + (svc.description ? " — " + svc.description : "")) : (pos.role || "Crew");
    }

    // Live positions + status counts for a request, read from its project's
    // schedule (the request only stores position ids; the schedule is the truth).
    function reqInfo(req) {
      var proj = (projects || []).find(function(p) { return p.id === req.projectId; });
      var ids = {}; (req.positionIds || []).forEach(function(id) { ids[id] = true; });
      var positions = [];
      if (proj) (proj.schedule || []).forEach(function(s) {
        (s.positions || []).forEach(function(p) {
          if (ids[p.id]) positions.push({ posId: p.id, status: p.status, roleLabel: roleLabelFor(p), date: s.date });
        });
      });
      var counts = { open: 0, requested: 0, accepted: 0, confirmed: 0, declined: 0 };
      positions.forEach(function(p) { counts[p.status] = (counts[p.status] || 0) + 1; });
      return { proj: proj, positions: positions, counts: counts };
    }

    // Badge label/color + which actions show, from the request + its live
    // position statuses. Confirming lives HERE (not on the Assignments tab).
    function displayState(req, info) {
      if (req.status === "pending") return { label: "Requested", color: B.warn, resend: true, withdraw: true };
      if (req.status === "declined") return { label: "Declined", color: B.danger };
      if (req.status === "accepted") {
        if (info.counts.accepted > 0) return { label: info.counts.confirmed > 0 ? "Confirm remaining" : "Accepted", color: B.success, confirm: true };
        if (info.counts.confirmed > 0) return { label: "Confirmed", color: B.info };
        return { label: "Accepted", color: B.success };
      }
      return { label: req.status || "—", color: B.textMut };
    }

    // Confirm a request's accepted positions → confirmed in its project, and
    // optionally email the crew member the confirmation (server-composed).
    function doConfirm(req, notify) {
      setConfirmDlg(null);
      var accepted = reqInfo(req).counts.accepted;
      var ids = {}; (req.positionIds || []).forEach(function(id) { ids[id] = true; });
      setProjects(function(prev) {
        return prev.map(function(p) {
          if (p.id !== req.projectId) return p;
          var changed = 0;
          var confirmDates = {};
          var updated = Object.assign({}, p, { schedule: (p.schedule || []).map(function(s) {
            return Object.assign({}, s, { positions: (s.positions || []).map(function(ps) {
              if (ids[ps.id] && ps.status === "accepted") { changed++; if (s.date) confirmDates[s.date] = true; return Object.assign({}, ps, { status: "confirmed" }); }
              return ps;
            })});
          })});
          if (changed > 0) {
            // Lock this person's pay for the days this confirm touched — the
            // agreed figure the Payouts tab reads. Only the confirmed dates are
            // (re)stamped so a rate change since an EARLIER confirm still shows
            // as drift there instead of being silently re-locked here.
            updated = Object.assign({}, updated, { schedule: window.LTP_stampPay(
              updated.schedule, req.contactId, services, window.LTP_crewMinMap(contacts),
              new Date().toISOString(), Object.keys(confirmDates)) });
            var actEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0, 5),
              type: "saved", user: (window.LTP_CURRENT_USER || "User"),
              message: "Crew confirmed: " + crewLabel(req.contactId) + " (" + changed + " position" + (changed > 1 ? "s" : "") + ")",
              changes: [{ cat: "Crew Confirmed", detail: crewLabel(req.contactId) + " → confirmed across " + changed + " position" + (changed > 1 ? "s" : "") }] };
            updated = Object.assign({}, updated, { scheduleActivity: (updated.scheduleActivity || []).concat([actEntry]) });
          }
          return updated;
        });
      });
      if (notify) {
        window.LTP_crewNotify(req.contactId, req.projectId, "crewConfirmed", { positionIds: req.positionIds || [] })
          .then(function(res) {
            var es = (res.ok && res.body.emailStatus) || {};
            if (es.emailed) window.LTP_toast("Crew confirmed", { message: "Confirmation email sent to " + crewLabel(req.contactId) + ".", variant: "success" });
            else if (es.needsReconnect) window.LTP_toast("Confirmed — email not sent", { message: "Connect Google in Settings to email " + crewLabel(req.contactId) + ".", variant: "warn" });
            else window.LTP_toast("Confirmed — email failed", { message: crewLabel(req.contactId) + ": " + (es.error || "email not sent"), variant: "error" });
          });
      } else {
        window.LTP_toast("Crew confirmed", { message: crewLabel(req.contactId) + (accepted ? " — " + accepted + " position" + (accepted > 1 ? "s" : "") : "") + " confirmed.", variant: "success" });
      }
    }

    var active = (crewRequests || []).filter(function(r) { return r.status !== "withdrawn"; });

    // Bucket each request: open (pending, or accepted with positions still
    // awaiting confirm), confirmed (all its work confirmed), declined.
    function categoryOf(req) {
      if (req.status === "declined") return "declined";
      if (req.status === "accepted") {
        var counts = reqInfo(req).counts;
        if (counts.accepted === 0 && counts.confirmed > 0) return "confirmed";
      }
      return "open";
    }
    var catCounts = { open: 0, confirmed: 0, declined: 0 };
    var withCat = active.map(function(r) { var c = categoryOf(r); catCounts[c]++; return { r: r, cat: c }; });
    var shown = withCat.filter(function(x) { return filter === "all" || x.cat === filter; }).map(function(x) { return x.r; });

    // Group by project so a project's crew read as one linked block, mirroring
    // the Assignments tab.
    var byProject = {}; var order = [];
    shown.forEach(function(r) { if (!byProject[r.projectId]) { byProject[r.projectId] = []; order.push(r.projectId); } byProject[r.projectId].push(r); });

    var filterPill = function(key, label, count) {
      var isActive = filter === key;
      return h("button", { key: key, onClick: function() { setFilter(key); },
        style: { background: isActive ? B.accent : B.raised, color: isActive ? B.btnInk : B.textMut, border: "1px solid " + (isActive ? B.accent : B.border), borderRadius: "4px", padding: "4px 12px", fontSize: "11px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" } },
        label + (count != null ? " (" + count + ")" : ""));
    };

    return h("div", null,
      h("div", { style: { display: "flex", gap: 8, marginBottom: 14, alignItems: "center" } },
        filterPill("open", "Open", catCounts.open),
        filterPill("confirmed", "Confirmed", catCounts.confirmed),
        filterPill("declined", "Declined", catCounts.declined),
        filterPill("all", "All", active.length)),
      shown.length === 0
        ? h(window.EmptyState, { text: active.length === 0
            ? "No crew requests yet. Select positions in the Assignments tab and send requests to crew."
            : filter === "open"
              ? "No open requests — everything is confirmed or answered. Use the filters above to see the rest."
              : "No " + filter + " requests in this view." })
        : order.map(function(pid) {
            var reqs = byProject[pid];
            return h("div", { key: pid, style: { background: B.raised, borderRadius: "8px", border: "1px solid " + B.border, marginBottom: 12, overflow: "hidden" } },
              // Project header (matches the Assignments project card)
              h("div", { style: { background: B.accent + "12", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "2px solid " + B.accent + "44", borderLeft: "3px solid " + B.accent } },
                h("span", { style: { fontSize: "13px", fontWeight: 700, color: B.accent, cursor: "pointer" }, onClick: function() { nav("projects/" + pid + "/schedule"); } }, projLabel(pid)),
                h("span", { style: { fontSize: "10px", color: B.textMut } }, reqs.length + " crew member" + (reqs.length !== 1 ? "s" : ""))),
              // Crew under this project
              h("div", { style: { padding: "6px 8px", display: "flex", flexDirection: "column", gap: 6 } },
                reqs.map(function(r) {
                  var info = reqInfo(r);
                  var ds = displayState(r, info);
                  var contentEl = h("div", { style: { flex: 1, minWidth: 0 } },
                      h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, crewLabel(r.contactId)),
                      info.positions.length > 0
                        ? h("div", { style: { marginTop: 3, display: "flex", flexDirection: "column", gap: 1 } },
                            info.positions.map(function(p, pi) {
                              return h("div", { key: pi, style: { fontSize: "10px", color: p.status === "confirmed" ? B.info : B.textMut } },
                                (p.status === "confirmed" ? "✓ " : "") + p.roleLabel + (p.date ? "  ·  " + fmt(p.date) : ""));
                            }))
                        : h("div", { style: { fontSize: "10px", color: B.textMut } }, (r.positionIds || []).length + " shift" + ((r.positionIds || []).length !== 1 ? "s" : "")),
                      // Note the crew member left when they accepted/declined.
                      r.comment && h("div", { style: { fontSize: "10px", color: B.textSec, fontStyle: "italic", marginTop: 3, whiteSpace: "pre-wrap" } }, "“" + r.comment + "”"));
                  var badgeEl = h("span", { key: "badge", style: { flexShrink: 0, marginTop: 1, fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: ds.color, background: ds.color + "18", border: "1px solid " + ds.color + "44", borderRadius: "3px", padding: "2px 8px", whiteSpace: "nowrap" } }, ds.label);
                  var actionEls = [
                    ds.confirm && h("button", { key: "confirm", onClick: function() { setConfirmDlg(r); },
                      style: Object.assign({ flexShrink: 0, background: B.info, border: "none", borderRadius: "4px", padding: "3px 12px", color: B.btnInk, fontSize: "10px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }, isMobile ? { flex: 1, padding: "8px 14px", fontSize: "12px" } : null) }, "✓ Confirm"),
                    ds.resend && h("button", { key: "resend", onClick: function() { resendRequest(r); },
                      style: Object.assign({ flexShrink: 0, background: "transparent", border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 10px", color: B.textSec, fontSize: "10px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }, isMobile ? { flex: 1, padding: "8px 14px", fontSize: "12px" } : null) }, "Resend"),
                    ds.withdraw && h("button", { key: "withdraw", onClick: function() { setWithdrawDlg(r); },
                      style: Object.assign({ flexShrink: 0, background: "transparent", border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 10px", color: B.textMut, fontSize: "10px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }, isMobile ? { flex: 1, padding: "8px 14px", fontSize: "12px" } : null) }, "Withdraw")
                  ].filter(Boolean);
                  return isMobile
                    ? h("div", { key: r.id, style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 8 } },
                        h("div", { style: { display: "flex", gap: 10, alignItems: "flex-start", justifyContent: "space-between" } }, contentEl, badgeEl),
                        actionEls.length > 0 && h("div", { style: { display: "flex", gap: 6 } }, actionEls))
                    : h("div", { key: r.id, style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px 10px", display: "flex", gap: 10, alignItems: "flex-start" } },
                        contentEl, badgeEl, actionEls);
                })
              )
            );
          }),

      // Withdraw confirmation. Withdrawing reopens the shifts and parks a
      // crew-withdrawn notice in the notify tray (bottom-left) — the producer
      // sends it (combined with any other withdrawals for that person) or
      // declines from there, so the email is never fired one-per-withdrawal.
      withdrawDlg && h(window.LTPModal, { title: "Withdraw Request", onClose: function() { setWithdrawDlg(null); } },
        h("div", { style: { fontSize: "12px", color: B.textSec, lineHeight: 1.6, marginBottom: 16 } },
          "Withdraw the request to ", h("strong", { style: { color: B.text } }, crewLabel(withdrawDlg.contactId)),
          " for ", h("strong", { style: { color: B.text } }, projLabel(withdrawDlg.projectId)),
          "? Their requested shifts reopen, and they're added to the notify tray so you can email them (or decline) when ready."),
        h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
          h(window.Btn, { variant: "ghost", onClick: function() { setWithdrawDlg(null); } }, "Cancel"),
          h(window.Btn, { variant: "danger", onClick: function() { doWithdraw(withdrawDlg); } }, "Withdraw"))),

      // Confirm confirmation — accepted positions → confirmed, with the same
      // notify choice the Assignments tab used to offer.
      confirmDlg && (function() {
        var proj = (projects || []).find(function(p) { return p.id === confirmDlg.projectId; });
        var site = [((proj && proj.venue) || "").trim(), window.LTP_siteAddress(proj, companies)].filter(Boolean).join(" — ");
        return h(window.LTPModal, { title: "Confirm " + crewLabel(confirmDlg.contactId), onClose: function() { setConfirmDlg(null); } },
          h("div", { style: { fontSize: "12px", color: B.textSec, lineHeight: 1.6, marginBottom: site ? 8 : 16 } },
            "Confirm ", h("strong", { style: { color: B.text } }, crewLabel(confirmDlg.contactId)),
            " for ", h("strong", { style: { color: B.text } }, projLabel(confirmDlg.projectId)),
            "? Their accepted positions move to confirmed."),
          site && h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 16 } }, site),
          h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
            h(window.Btn, { variant: "ghost", onClick: function() { setConfirmDlg(null); } }, "Cancel"),
            h(window.Btn, { variant: "ghost", onClick: function() { doConfirm(confirmDlg, false); } }, "Confirm Quietly"),
            h(window.Btn, { onClick: function() { doConfirm(confirmDlg, true); } }, "Confirm & Notify")));
      })()
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   MAIN VIEW
  // ═══════════════════════════════════════════════════════════════════════════
  window.LaborView = function({ contacts, setContacts, projects, setProjects, services, quotes, companies, settings, route, isAdmin, qbo }) {
    // Active tab is URL-derived — the sidebar sub-nav drives it, exactly like
    // CRM / Rentals / Quotes (see modules/crm-shell.js, rentals-shell.js).
    //   labor            → assignments (default)
    //   labor/requests   → Crew Requests
    //   labor/roster     → Crew Roster
    //   labor/calendar   → Calendar
    //   labor/schedule   → Weekly Schedule
    //   labor/payouts    → Payouts
    var validTabs = { assignments: 1, requests: 1, roster: 1, calendar: 1, schedule: 1, payouts: 1 };
    var tab = (route && validTabs[route.sub]) ? route.sub : "assignments";
    var crew = contacts.filter(function(c) { return c.isCrew; });

    // Crew requests live at the LaborView level (not inside a single tab) so the
    // reconcile that advances accepted/declined positions into the Assignments
    // view runs on load regardless of which crew tab is open. Both the
    // Assignments tab (after a send) and the Crew Requests tab refresh via
    // reloadCrewRequests.
    var [crewRequests, setCrewRequests] = useState([]);
    function loadCrewRequests() {
      fetch("/api/crew-requests", { credentials: "include" })
        .then(function(r) { return r.ok ? r.json() : []; })
        .then(function(d) {
          var list = Array.isArray(d) ? d : [];
          setCrewRequests(list);
          reconcileFromRequests(setProjects, list);
        })
        .catch(function() {});
    }
    React.useEffect(loadCrewRequests, []);

    var allPositions = useMemo(function() {
      return aggregatePositions(projects, contacts, services);
    }, [projects, contacts, services]);

    var crewConflicts = useMemo(function() {
      return window.LTP_detectCrewConflicts(projects);
    }, [projects]);

    var conflictCount = Object.keys(crewConflicts).length;

    var tabTitle = tab === "requests" ? "Crew Requests"
      : tab === "roster" ? "Crew Roster"
      : tab === "calendar" ? "Crew Calendar"
      : tab === "schedule" ? "Weekly Schedule"
      : tab === "payouts" ? "Crew Payouts"
      : "Crew Assignments";

    return h("div", null,
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
        h("h2", { style: { fontSize: "18px", fontWeight: 700, color: B.text, margin: 0 } }, tabTitle),
        conflictCount > 0 && h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.danger, background: B.danger + "22", border: "1px solid " + B.danger + "44", padding: "4px 10px", borderRadius: "6px" } },
          conflictCount + " scheduling conflict" + (conflictCount > 1 ? "s" : ""))
      ),
      tab === "roster" && h(CrewRoster, { contacts: contacts, setContacts: setContacts, services: services, allPositions: allPositions, settings: settings }),
      tab === "assignments" && h(AssignmentsTab, { allPositions: allPositions, contacts: contacts, services: services, projects: projects, setProjects: setProjects, crewConflicts: crewConflicts, settings: settings, reloadCrewRequests: loadCrewRequests, crewRequests: crewRequests }),
      tab === "requests" && h(CrewRequestsTab, { crewRequests: crewRequests, reloadCrewRequests: loadCrewRequests, contacts: contacts, projects: projects, setProjects: setProjects, services: services, companies: companies }),
      tab === "calendar" && h(LaborCalendar, { allPositions: allPositions }),
      tab === "schedule" && h(WeeklySchedule, { allPositions: allPositions, contacts: contacts }),
      tab === "payouts" && h(PayoutsTab, { projects: projects, setProjects: setProjects, contacts: contacts, services: services, settings: settings, isAdmin: isAdmin, qbo: qbo })
    );
  };
})();
