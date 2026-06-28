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

      (proj.schedule || []).forEach(function(s) {
        var dg = dateGroups[s.date || "_unscheduled"];
        (s.positions || []).forEach(function(p) {
          var svc = p.serviceId ? (services || []).find(function(sv) { return sv.id === p.serviceId; }) : null;
          var cm = p.crewId ? (contacts || []).find(function(c) { return c.id === p.crewId; }) : null;
          all.push({
            projectId: proj.id, projectName: proj.name, companyId: proj.companyId,
            schedItemId: s.id, schedTitle: s.title,
            date: s.date, callTime: s.time, endTime: s.endTime,
            dayCall: dg ? dg.dayCall : s.time, dayWrap: dg ? dg.dayWrap : s.endTime,
            posId: p.id, role: p.role, serviceId: p.serviceId,
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
  // statuses, advancing only positions still at "requested" so a producer's
  // manual changes (confirmed, released) are never disturbed. The app doesn't
  // poll `projects` for inbound server changes, so this bridges a crew member's
  // accept/decline (written server-side to the position status) into the grouped
  // view without a full reload.
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
            if (entry && pos.status === "requested" && pos.crewId === entry.crewId) { changed = true; return Object.assign({}, pos, { status: entry.target }); }
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
    var [search, setSearch] = useState("");
    var [deptFilter, setDeptFilter] = useState("all");
    var [editingCrew, setEditingCrew] = useState(null);
    var [crewDlg, setCrewDlg] = useState(null);
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
          h("h3", { style: { fontSize: "15px", fontWeight: 700, color: B.text, margin: 0, fontFamily: "'Playfair Display', serif" } }, isNew ? "Add Crew Member" : "Edit Crew Member"),
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
            // Roles — toggle tags
            h("div", null,
              h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 6, fontWeight: 600 } }, "Roles"),
              h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
                (settings.crewRoleOptions || ["L1", "L2", "L3", "A1", "A2", "V1", "RIG", "PM"]).map(function(r) {
                  var active = (f.crewRoles || []).indexOf(r) !== -1;
                  return h("button", { key: r, onClick: function() {
                    var cur = f.crewRoles || [];
                    set("crewRoles", active ? cur.filter(function(x) { return x !== r; }) : cur.concat([r]));
                  }, style: { background: active ? B.accent + "22" : B.bg, color: active ? B.accent : B.textMut, border: "1px solid " + (active ? B.accent + "55" : B.border), borderRadius: "4px", padding: "3px 10px", fontSize: "10px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" } }, r);
                })
              ))),
          h("div", { style: { marginTop: 12 } },
            h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4, fontWeight: 600 } }, "Notes"),
            h("textarea", { value: f.crewNotes || "", onChange: function(e) { set("crewNotes", e.target.value); },
              placeholder: "Skills, certifications, preferences, gear they own\u2026",
              style: { width: "100%", minHeight: 60, background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", resize: "vertical" } })),
          h("div", { style: { marginTop: 12 } },
            h(window.LTPSelect, { label: "Status", value: f.crewStatus || "active", onChange: function(v) { set("crewStatus", v); },
              options: [{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }] })),
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
        h(window.Btn, { small: true, onClick: function() { setEditingCrew({ firstName: "", lastName: "", email: "", phone: "", role: "", crewDepartments: [], crewRoles: [], crewNotes: "", crewStatus: "active", isCrew: true, companyIds: [] }); } }, "+ Add Crew")),
      h("div", { style: { display: "flex", gap: 8, marginBottom: 14, alignItems: "center" } },
        departments.map(function(d) {
          return h("button", { key: d, onClick: function() { setDeptFilter(d); },
            style: { background: deptFilter === d ? B.accent : B.raised, color: deptFilter === d ? "#000" : B.textMut, border: "1px solid " + (deptFilter === d ? B.accent : B.border), borderRadius: "4px", padding: "4px 12px", fontSize: "11px", fontWeight: 600, cursor: "pointer", textTransform: "capitalize" } }, d);
        }),
        h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search crew\u2026",
          style: { flex: 1, maxWidth: 250, background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "5px 12px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none" } })
      ),
      h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
        filtered.length === 0 && h(window.EmptyState, { text: "No crew members found." }),
        filtered.map(function(c) {
          var shifts = upcomingShifts(c.id);
          return h("div", { key: c.id, onClick: function() { setEditingCrew(Object.assign({}, c)); },
            style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: "12px 16px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" },
            onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent + "44"; },
            onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
            h("div", null,
              h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text } }, c.firstName + " " + c.lastName),
              h("div", { style: { fontSize: "11px", color: B.textMut, marginTop: 2 } },
                (c.crewRoles || []).join(", ") + (shifts > 0 ? " \u00b7 " + shifts + " upcoming" : "")),
              h("div", { style: { display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 } },
                c.crewNotes && h("div", { style: { fontSize: "10px", color: B.textMut, fontStyle: "italic", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, c.crewNotes))),
            h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
              (c.crewDepartments || []).map(function(d) {
                return h("span", { key: d, style: { fontSize: "10px", color: window.LTP_deptColor(d), background: window.LTP_deptColor(d) + "22", border: "1px solid " + window.LTP_deptColor(d) + "44", padding: "2px 6px", borderRadius: "3px", fontWeight: 600 } }, d);
              }),
              h(window.Badge, { status: c.crewStatus || "active" }))
          );
        }))
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   ASSIGNMENTS TAB — positions from project schedules
  // ═══════════════════════════════════════════════════════════════════════════
  function AssignmentsTab({ allPositions, contacts, services, projects, setProjects, crewConflicts, settings, reloadCrewRequests, crewRequests }) {
    var [filter, setFilter] = useState("all");
    var [projFilter, setProjFilter] = useState("all");
    var [statusDlg, setStatusDlg] = useState(null);
    var [showSendPanel, setShowSendPanel] = useState(false);
    var [sendSelection, setSendSelection] = useState({});
    var [conflictWarn, setConflictWarn] = useState(null);
    var [confirmDlg, setConfirmDlg] = useState(null); // posId → true/false
    var crew = contacts.filter(function(c) { return c.isCrew && c.crewStatus === "active"; });

    // Sending crew requests lives here (you select positions and send); the
    // sent-requests list + accept/decline tracking lives in the Crew Requests
    // tab (CrewRequestsTab). After a send we call reloadCrewRequests() so that
    // tab — and the reconcile that advances accepted/declined positions — picks
    // up the new requests. Send confirmations + errors surface as toasts
    // (window.LTP_toast), consistent with the rest of the app.

    function crewLabel(id) { var c = contacts.find(function(x) { return x.id === id; }); return c ? (c.firstName + " " + c.lastName).trim() : "Unknown"; }

    // Immediate informational crew email — only the POSITIVE confirmation
    // (crewConfirmed) still sends inline; removals are parked in the tray
    // (parkRemoval) instead. Surfaces only failures so the producer can follow up.
    function crewNotify(contactId, projectId, template, positionIds) {
      window.LTP_crewNotify(contactId, projectId, template, { positionIds: positionIds || [] })
        .then(function(res) {
          var es = (res.ok && res.body.emailStatus) || {};
          if (!es.emailed) {
            if (es.needsReconnect) {
              window.LTP_toast("Notification email not sent", { message: "Status saved — connect Google in Settings to email " + crewLabel(contactId) + ".", variant: "warn" });
            } else {
              window.LTP_toast("Notification email failed", { message: crewLabel(contactId) + ": " + (es.error || "email not sent"), variant: "error" });
            }
          }
        });
    }

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

    var filtered = allPositions.filter(function(p) {
      if (filter === "conflicts") { return (crewConflicts || {})[p.posId]; }
      if (filter !== "all" && p.status !== filter) return false;
      if (projFilter !== "all" && p.projectId !== Number(projFilter)) return false;
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
        var ck = pos.crewId;
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
    var pendingConfirm = countUnique(allPositions, function(p) { return p.status === "accepted"; });

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

    function confirmAllAccepted() {
      setProjects(function(prev) {
        return prev.map(function(proj) {
          var projConfirmed = 0;
          var updated = Object.assign({}, proj, { schedule: (proj.schedule || []).map(function(s) {
            return Object.assign({}, s, { positions: (s.positions || []).map(function(pos) {
              if (pos.status === "accepted") { projConfirmed++; return Object.assign({}, pos, { status: "confirmed" }); }
              return pos;
            })});
          })});
          if (projConfirmed > 0) {
            var actEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0, 5),
              type: "saved", user: (window.LTP_CURRENT_USER || "User"), message: projConfirmed + " crew position" + (projConfirmed > 1 ? "s" : "") + " confirmed",
 changes: [{ cat: "Crew Confirmed", detail: projConfirmed + " position" + (projConfirmed > 1 ? "s" : "") + " moved from accepted \u2192 confirmed" }] };
            updated = Object.assign({}, updated, { scheduleActivity: (updated.scheduleActivity || []).concat([actEntry]) });
          }
          return updated;
        });
      });
    }

    // Quick action: confirm a single position (cascades to all same crew+day)
    function confirmPosition(pos, posIds) {
      var cm = contacts.find(function(c) { return c.id === pos.crewId; });
      var s = settings || {};
      var tmpl = (s.emailTemplates || {}).crewConfirmed || { subject: "", body: "" };
      var proj = (projects || []).find(function(pr) { return pr.id === pos.projectId; });
      var vars = { companyName: s.companyName || "LTP", crewName: cm ? cm.firstName : "there",
        projectName: pos.projectName || "", role: pos.svcName || pos.role || "",
        date: pos.date ? fmt(pos.date) : "", callTime: pos.dayCall ? ft(pos.dayCall) : "",
        wrapTime: pos.dayWrap ? ft(pos.dayWrap) : "", location: proj ? proj.venue || "" : "",
        signature: s.emailSignature || "" };
      setConfirmDlg({
        pos: pos, posIds: posIds,
        crewName: cm ? cm.firstName + " " + cm.lastName : "?",
        emailTo: cm ? cm.email || "(no email)" : "?",
        emailSubject: window.LTP_resolveTemplate(tmpl.subject, vars),
        emailBody: window.LTP_resolveTemplate(tmpl.body, vars),
      });
    }

    function executeConfirm(notify) {
      if (!confirmDlg) return;
      var p = confirmDlg.pos;
      confirmDayBooking(p, confirmDlg.posIds);
      if (notify) crewNotify(p.crewId, p.projectId, "crewConfirmed", confirmDlg.posIds || [p.posId]);
      setConfirmDlg(null);
    }

    // Confirm this booking's positions. posIds scopes it to one booking (so a
    // conflicting shift isn't confirmed alongside the one you clicked); without
    // it, confirm every same-date shift for this crew (legacy whole-day).
    function confirmDayBooking(pos, posIds) {
      var targetDate = pos.date;
      var targetCrew = pos.crewId;
      var targetProject = pos.projectId;
      var affectIds = (posIds && posIds.length) ? posIds.reduce(function(m, id) { m[id] = true; return m; }, {}) : null;
      setProjects(function(prev) {
        return prev.map(function(p) {
          if (p.id !== targetProject) return p;
          var confirmedCount = 0;
          var updated = Object.assign({}, p, { schedule: (p.schedule || []).map(function(s) {
            if (s.date !== targetDate) return s;
            return Object.assign({}, s, { positions: (s.positions || []).map(function(ps) {
              var hit = affectIds ? affectIds[ps.id] : (ps.crewId === targetCrew);
              if (hit && (ps.status === "accepted" || ps.status === "requested" || ps.status === "open")) {
                confirmedCount++;
                return Object.assign({}, ps, { status: "confirmed" });
              }
              return ps;
            })});
          })});
          if (confirmedCount > 0) {
            var actEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0, 5),
              type: "saved", user: (window.LTP_CURRENT_USER || "User"),
              message: "Position confirmed: " + (pos.crewName || "?") + " as " + (pos.role || pos.svcName || "?") + " (" + confirmedCount + " item" + (confirmedCount > 1 ? "s" : "") + ")",
              changes: [{ cat: (pos.schedTitle || "") + (pos.date ? " (" + fmt(pos.date) + ")" : ""), detail: (pos.crewName || "?") + " \u2192 confirmed across " + confirmedCount + " item" + (confirmedCount > 1 ? "s" : "") }] };
            updated = Object.assign({}, updated, { scheduleActivity: (updated.scheduleActivity || []).concat([actEntry]) });
          }
          return updated;
        });
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
            style: { background: filter === f ? (isConflict ? B.danger : B.accent) : B.raised, color: filter === f ? "#000" : (isConflict ? B.danger : B.textMut), border: "1px solid " + (filter === f ? (isConflict ? B.danger : B.accent) : (isConflict && stats.conflicts > 0 ? B.danger + "44" : B.border)), borderRadius: "4px", padding: "4px 10px", fontSize: "10px", fontWeight: 600, cursor: "pointer", textTransform: "capitalize" } },
            isConflict ? "Conflicts" + (stats.conflicts > 0 ? " (" + stats.conflicts + ")" : "") : f);
        }),
        h("select", { value: projFilter, onChange: function(e) { setProjFilter(e.target.value); },
          style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "4px", padding: "4px 8px", color: B.text, fontSize: "10px", fontFamily: "inherit" } },
          h("option", { value: "all" }, "All Projects"),
          projOptions.map(function(p) { return h("option", { key: p.id, value: p.id }, p.name); })
        ),
        h("div", { style: { flex: 1 } }),
        pendingConfirm > 0 && h("button", { onClick: confirmAllAccepted,
          style: { background: B.info, border: "none", borderRadius: "4px", padding: "5px 14px", color: "#000", fontSize: "11px", fontWeight: 700, cursor: "pointer" } }, "\u2713 Confirm All Accepted (" + pendingConfirm + ")"),
        pendingSendUnique > 0 && h("button", { onClick: openSendPanel,
          style: { background: B.success, border: "none", borderRadius: "4px", padding: "5px 14px", color: "#000", fontSize: "11px", fontWeight: 700, cursor: "pointer" } }, "Send " + pendingSendUnique + " Request" + (pendingSendUnique > 1 ? "s" : "") + " \u25b8")
      ),

      // Grouped by project
      projectGroups.length === 0 && h(window.EmptyState, { text: "No positions found. Add positions to project schedules." }),
      projectGroups.map(function(pg) {
        var totalBookings = pg.dates.reduce(function(s, d) { return s + (d.dayBookings || []).length; }, 0);
        return h("div", { key: pg.projectId, style: { background: B.raised, borderRadius: "8px", border: "1px solid " + B.border, marginBottom: 12, overflow: "hidden" } },
          // Project header
          h("div", { style: { background: B.accent + "12", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "2px solid " + B.accent + "44", borderLeft: "3px solid " + B.accent } },
            h("span", { style: { fontSize: "13px", fontWeight: 700, color: B.accent, cursor: "pointer" }, onClick: function() { nav("projects/" + pg.projectId + "/schedule"); } }, pg.projectName),
            h("span", { style: { fontSize: "10px", color: B.textMut } }, totalBookings + " crew booking" + (totalBookings !== 1 ? "s" : ""))),
          // Date groups
          pg.dates.map(function(g) {
            return h("div", { key: pg.projectId + "|" + (g.date || "_") },
              h("div", { style: { padding: "8px 14px", display: "flex", gap: 10, alignItems: "center", background: "#222", borderBottom: "1px solid " + B.border, borderLeft: "3px solid " + B.info } },
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
                        return h("div", { key: pos.posId + "-" + bi, style: { padding: "6px 10px", display: "flex", gap: 8, alignItems: "center", borderTop: bi > 0 ? "1px solid " + B.border : "none", background: hasConflict ? B.danger + "08" : "transparent" } },
                          hasConflict && h("div", { title: "Double-booked: also on " + conflicts.map(function(c) { return c.projectName; }).join(", "),
                            style: { width: 16, height: 16, borderRadius: "50%", background: B.danger + "22", border: "1px solid " + B.danger, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "help" } },
                            h("span", { style: { fontSize: "9px", color: B.danger, fontWeight: 700 } }, "!")),
                          h("div", { style: { flex: 1, minWidth: 0 } },
                            h("span", { style: { fontSize: "11px", fontWeight: 600, color: B.text } }, pos.svcName),
                            pos.dept && h("span", { style: { fontSize: "9px", color: window.LTP_deptColor(pos.dept), background: window.LTP_deptColor(pos.dept) + "22", border: "1px solid " + window.LTP_deptColor(pos.dept) + "44", padding: "1px 5px", borderRadius: "3px", fontWeight: 600, marginLeft: 6 } }, pos.dept)),
                          h("select", { value: pos.crewId || "", onChange: function(e) {
                            var cid = Number(e.target.value) || null;
                            if (!cid && pos.crewId && (SEVERITY[pos.status] || 0) >= 2) { handleStatusChange(Object.assign({}, pos), "open", bkPosIds); return; }
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
                          }, style: { width: 150, background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 6px", color: B.text, fontSize: "10px", fontFamily: "inherit" } },
                            h("option", { value: "" }, "Assign crew\u2026"),
                            crew.filter(function(c) { return !pos.role || (c.crewRoles || []).indexOf(pos.role) !== -1; })
                              .map(function(c) { return h("option", { key: c.id, value: c.id }, c.firstName + " " + c.lastName); })
                          ),
                          pos.status === "open" && !pos.crewId && h("span", { style: { fontSize: "9px", color: B.textMut, fontStyle: "italic" } }, "Needs crew"),
                          pos.status === "open" && pos.crewId && h("span", { style: { fontSize: "9px", color: B.warn, fontWeight: 600 } }, "Ready to send"),
                          pos.status === "requested" && h("span", { style: { fontSize: "9px", color: B.warn, fontWeight: 600, background: B.warn + "18", border: "1px solid " + B.warn + "33", borderRadius: "3px", padding: "2px 8px" } }, "Awaiting\u2026"),
                          pos.status === "accepted" && h("div", { style: { display: "flex", gap: 4 } },
                            h("button", { onClick: function() { confirmPosition(pos, bkPosIds); },
                              style: { background: B.info, border: "none", borderRadius: "3px", padding: "3px 10px", color: "#000", fontSize: "9px", fontWeight: 700, cursor: "pointer" } }, "\u2713 Confirm"),
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
                            }, style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "3px", padding: "3px 8px", color: B.textMut, fontSize: "9px", fontWeight: 600, cursor: "pointer" } }, "Reassign"))
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

      // Crew confirmation email dialog
      confirmDlg && h(window.LTPModal, { title: "Confirm " + confirmDlg.crewName, onClose: function() { setConfirmDlg(null); }, wide: true },
        h("div", { style: { display: "flex", gap: 16, minHeight: 300 } },
          // Left: position info
          h("div", { style: { width: 220, flexShrink: 0 } },
            h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 } }, "Position Details"),
            h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.text, marginBottom: 4 } }, confirmDlg.crewName),
            h("div", { style: { fontSize: "11px", color: B.textSec, marginBottom: 2 } }, confirmDlg.pos.svcName),
            h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 2 } }, confirmDlg.pos.projectName),
            confirmDlg.pos.date && h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 2 } }, fmt(confirmDlg.pos.date)),
            confirmDlg.pos.dayCall && h("div", { style: { fontSize: "10px", color: B.textMut } }, ft(confirmDlg.pos.dayCall) + " \u2192 " + ft(confirmDlg.pos.dayWrap))),
          // Right: email preview
          h("div", { style: { flex: 1, background: B.bg, border: "1px solid " + B.border, borderRadius: "8px", display: "flex", flexDirection: "column", overflow: "hidden" } },
            h("div", { style: { padding: "10px 14px", borderBottom: "1px solid " + B.border, background: B.surface } },
              h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 } }, "Confirmation Email Preview"),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 4 } },
                h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "To:"),
                h("span", { style: { fontSize: "11px", color: B.text, fontWeight: 600 } }, confirmDlg.emailTo)),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 4 } },
                h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "From:"),
                h("span", { style: { fontSize: "11px", color: B.textMut } }, (settings || {}).emailFrom || "")),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "Subj:"),
                h("span", { style: { fontSize: "11px", color: B.text, fontWeight: 600 } }, confirmDlg.emailSubject))),
            h("div", { style: { flex: 1, padding: "14px", overflowY: "auto" } },
              h("pre", { style: { fontSize: "11px", color: B.textSec, lineHeight: 1.6, fontFamily: "inherit", margin: 0, whiteSpace: "pre-wrap" } }, confirmDlg.emailBody))
          )
        ),
        h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14, paddingTop: 14, borderTop: "1px solid " + B.border } },
          h(window.Btn, { variant: "ghost", onClick: function() { setConfirmDlg(null); } }, "Cancel"),
          h(window.Btn, { variant: "ghost", onClick: function() { executeConfirm(false); } }, "Confirm Quietly"),
          h(window.Btn, { onClick: function() { executeConfirm(true); } }, "Confirm & Notify"))
      ),

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
                        isSelected && h("span", { style: { color: "#000", fontSize: "10px", fontWeight: 700 } }, "\u2713")),
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
                          h("span", { style: { fontWeight: 600 } }, sp.svcName || sp.role || "Crew"),
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

    return h("div", null,
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
        h("button", { onClick: function() { setMonthOffset(monthOffset - 1); }, style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "4px", padding: "4px 12px", color: B.textMut, cursor: "pointer", fontSize: "12px" } }, "\u25c0"),
        h("h3", { style: { fontSize: "15px", fontWeight: 700, color: B.text, margin: 0, fontFamily: "'Playfair Display', serif" } }, monthName),
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
    var [weekOffset, setWeekOffset] = useState(0);
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

    return h("div", null,
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
        h("button", { onClick: function() { setWeekOffset(weekOffset - 1); }, style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "4px", padding: "4px 12px", color: B.textMut, cursor: "pointer" } }, "\u25c0"),
        h("h3", { style: { fontSize: "14px", fontWeight: 700, color: B.text, margin: 0, fontFamily: "'Playfair Display', serif" } }, weekLabel),
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
  //   CREW REQUESTS TAB
  // ═══════════════════════════════════════════════════════════════════════════
  // Sent tokenized crew requests with live accept/decline status + the note the
  // crew member left, plus Resend / Withdraw on still-pending ones. Crew
  // responses also flow back as POSITION status changes (reconciled into the
  // Assignments view); this tab tracks the request envelope itself.
  function CrewRequestsTab({ crewRequests, reloadCrewRequests, contacts, projects, setProjects, services }) {
    // Resend / withdraw confirmations + errors surface as toasts (window.LTP_toast).
    var [withdrawDlg, setWithdrawDlg] = useState(null);  // request awaiting a withdraw decision

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

    var STBADGE = { pending: B.warn, accepted: B.success, declined: B.danger, withdrawn: B.textMut };
    var active = (crewRequests || []).filter(function(r) { return r.status !== "withdrawn"; });

    return h("div", null,
      active.length === 0
        ? h(window.EmptyState, { text: "No crew requests yet. Select positions in the Assignments tab and send requests to crew." })
        : h("div", { style: { border: "1px solid " + B.border, borderRadius: "8px", overflow: "hidden" } },
            h("div", { style: { padding: "8px 14px", background: B.surface, borderBottom: "1px solid " + B.border, fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } },
              "Crew Requests (" + active.length + ")"),
            active.map(function(r, i) {
              var st = r.status || "pending";
              return h("div", { key: r.id, style: { display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 14px", borderBottom: i < active.length - 1 ? "1px solid " + B.border : "none" } },
                h("div", { style: { flex: 1, minWidth: 0 } },
                  h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, crewLabel(r.contactId)),
                  h("div", { style: { fontSize: "10px", color: B.textMut } }, projLabel(r.projectId) + "  ·  " + (r.positionIds || []).length + " shift" + ((r.positionIds || []).length !== 1 ? "s" : "")),
                  // Note the crew member left when they accepted/declined.
                  r.comment && h("div", { style: { fontSize: "10px", color: B.textSec, fontStyle: "italic", marginTop: 3, whiteSpace: "pre-wrap" } }, "“" + r.comment + "”")),
                h("span", { style: { flexShrink: 0, marginTop: 1, fontSize: "9px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: STBADGE[st] || B.textMut, background: (STBADGE[st] || B.textMut) + "18", border: "1px solid " + (STBADGE[st] || B.textMut) + "44", borderRadius: "3px", padding: "2px 8px" } }, st),
                st === "pending" && h("button", { onClick: function() { resendRequest(r); },
                  style: { flexShrink: 0, background: "transparent", border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 10px", color: B.textSec, fontSize: "10px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" } }, "Resend"),
                st === "pending" && h("button", { onClick: function() { setWithdrawDlg(r); },
                  style: { flexShrink: 0, background: "transparent", border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 10px", color: B.textMut, fontSize: "10px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" } }, "Withdraw")
              );
            })),

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
          h(window.Btn, { variant: "danger", onClick: function() { doWithdraw(withdrawDlg); } }, "Withdraw")))
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   MAIN VIEW
  // ═══════════════════════════════════════════════════════════════════════════
  window.LaborView = function({ contacts, setContacts, projects, setProjects, services, quotes, companies, settings, route }) {
    // Active tab is URL-derived — the sidebar sub-nav drives it, exactly like
    // CRM / Rentals / Quotes (see modules/crm-shell.js, rentals-shell.js).
    //   labor            → assignments (default)
    //   labor/requests   → Crew Requests
    //   labor/roster     → Crew Roster
    //   labor/calendar   → Calendar
    //   labor/schedule   → Weekly Schedule
    var validTabs = { assignments: 1, requests: 1, roster: 1, calendar: 1, schedule: 1 };
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
      : "Crew Assignments";

    return h("div", null,
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
        h("h2", { style: { fontSize: "18px", fontWeight: 700, color: B.text, margin: 0, fontFamily: "'Playfair Display', serif" } }, tabTitle),
        conflictCount > 0 && h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.danger, background: B.danger + "22", border: "1px solid " + B.danger + "44", padding: "4px 10px", borderRadius: "6px" } },
          conflictCount + " scheduling conflict" + (conflictCount > 1 ? "s" : ""))
      ),
      tab === "roster" && h(CrewRoster, { contacts: contacts, setContacts: setContacts, services: services, allPositions: allPositions, settings: settings }),
      tab === "assignments" && h(AssignmentsTab, { allPositions: allPositions, contacts: contacts, services: services, projects: projects, setProjects: setProjects, crewConflicts: crewConflicts, settings: settings, reloadCrewRequests: loadCrewRequests, crewRequests: crewRequests }),
      tab === "requests" && h(CrewRequestsTab, { crewRequests: crewRequests, reloadCrewRequests: loadCrewRequests, contacts: contacts, projects: projects, setProjects: setProjects, services: services }),
      tab === "calendar" && h(LaborCalendar, { allPositions: allPositions }),
      tab === "schedule" && h(WeeklySchedule, { allPositions: allPositions, contacts: contacts })
    );
  };
})();
