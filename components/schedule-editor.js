// ═══════════════════════════════════════════════════════════════════════════
//   SCHEDULE EDITOR — project days with positional labor needs
// ═══════════════════════════════════════════════════════════════════════════
(function() {
  var B = window.LTP_THEME, h = React.createElement, useState = React.useState;
  var fmt = window.LTP_formatDate, calc = window.LTP_calcDuration;
  var genId = window.LTP_genId;
  var calcRate = window.LTP_calcLaborRate, calcTier = window.LTP_calcLaborTier, calcHours = window.LTP_calcHours;

  var inp = { background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "6px 8px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", width: "100%" };
  var lbl = { fontSize: "10px", color: B.textMut, marginBottom: 2 };
  var POS_COLORS = { open: B.textMut, requested: B.warn, accepted: B.success, declined: B.danger, confirmed: B.info };

  // Helper: add minutes to a time string
  function _addTime(timeStr, minutes) {
    if (!timeStr) return "";
    var p = timeStr.split(":");
    var h = parseInt(p[0], 10);
    var m = parseInt(p[1], 10) + minutes;
    h += Math.floor(m / 60);
    m = m % 60;
    return String(h % 24).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }

  window.ScheduleEditor = function({ schedule, onChange, contacts, services, crewConflicts, checkCrewConflict }) {
    var isMobile = window.LTP_useIsMobile();
    var [assignCrewModal, setAssignCrewModal] = useState(false);
    var [crewSearch, setCrewSearch] = useState("");
    var [deletionDlg, setDeletionDlg] = useState(null);
    var [conflictWarn, setConflictWarn] = useState(null);
    var crew = (contacts || []).filter(function(c) { return c.isCrew && c.crewStatus === "active"; });
    var svcs = services || [];
    // Per-crew negotiated minimums, so the cost totals below reflect what each
    // assigned person is actually paid (never the client rate).
    var crewMins = window.LTP_crewMinMap(contacts);
    // Roster shown in the "Assign Crew to All Days" modal, narrowed by its
    // search box (name, roles, or department).
    var shownCrew = (function() {
      var cq = crewSearch.trim().toLowerCase();
      if (!cq) return crew;
      return crew.filter(function(c) {
        var hay = (c.firstName + " " + c.lastName + " " + (c.crewRoles || []).join(" ") + " " + (c.crewDepartments || []).join(" ")).toLowerCase();
        return hay.indexOf(cq) !== -1;
      });
    })();
    var POS_COLORS = { open: B.textMut, requested: B.warn, accepted: B.success, declined: B.danger, confirmed: B.info };

    // Removing a day/position that has crew assigned just confirms here — the
    // crew-removal notice is parked on save by the parent (LTP_diffRemovedCrew →
    // the notify tray), grouped per person + type, so one person pulled from
    // several shifts is emailed once instead of once per removal.

    // Live conflict detection from draft schedule (before save)
    var liveConflicts = React.useMemo(function() {
      var merged = {};
      // Copy cross-project conflicts
      if (crewConflicts) Object.keys(crewConflicts).forEach(function(k) { merged[k] = crewConflicts[k]; });
      // Detect same-project duplicates from current draft
      var byCrewDate = {};
      (schedule || []).forEach(function(s) {
        if (!s.date) return;
        (s.positions || []).forEach(function(p) {
          if (!p.crewId || p.status === "declined") return;
          var key = p.crewId + "|" + s.date;
          if (!byCrewDate[key]) byCrewDate[key] = [];
          byCrewDate[key].push({ posId: p.id, serviceId: p.serviceId, status: p.status, schedTitle: s.title, projectName: "this project" });
        });
      });
      Object.keys(byCrewDate).forEach(function(key) {
        var b = byCrewDate[key];
        if (b.length < 2) return;
        var svcIds = {};
        b.forEach(function(bk) { svcIds[bk.serviceId || bk.posId] = true; });
        if (Object.keys(svcIds).length < 2) return; // same role across items = normal
        b.forEach(function(bk) {
          // Confirmed = settled/purposeful — never badge the confirmed side
          // (same rule as LTP_detectCrewConflicts); it still shows up in the
          // unsettled side's list via `others`.
          if (bk.status === "confirmed") return;
          var others = b.filter(function(o) { return o.posId !== bk.posId; });
          if (!merged[bk.posId]) merged[bk.posId] = [];
          others.forEach(function(o) {
            // Avoid duplicates
            if (!merged[bk.posId].some(function(ex) { return ex.posId === o.posId; })) {
              merged[bk.posId].push(o);
            }
          });
        });
      });
      // Also check cross-project for newly assigned (unsaved) crew. Confirmed
      // positions are skipped here too — a settled booking is purposeful, so
      // it never wears the passive badge (the assign-time dialog still warns
      // BEFORE a double-booking is created).
      if (checkCrewConflict) {
        (schedule || []).forEach(function(s) {
          if (!s.date) return;
          (s.positions || []).forEach(function(p) {
            if (!p.crewId || p.status === "declined" || p.status === "confirmed" || merged[p.id]) return;
            var otherBookings = checkCrewConflict(p.crewId, s.date);
            if (otherBookings.length > 0) {
              merged[p.id] = otherBookings.map(function(ob) { return { projectName: ob, posId: "ext" }; });
            }
          });
        });
      }
      return merged;
    }, [schedule, crewConflicts, checkCrewConflict]);

    function addItem() {
      onChange(schedule.concat([{ id: genId("sch"), title: "", date: "", time: "08:00", endDate: "", endTime: "18:00", showOnCalendar: true, positions: [], breaks: [] }]));
    }
    function addItemToDay(date, afterTime) {
      var newTime = afterTime || "08:00";
      var newEnd = _addTime(newTime, 240); // default 4h block
      onChange(schedule.concat([{ id: genId("sch"), title: "", date: date, time: newTime, endDate: date, endTime: newEnd, showOnCalendar: true, positions: [], breaks: [] }]));
    }
    function updateItem(id, field, val) {
      onChange(schedule.map(function(s) {
        if (s.id !== id) return s;
        var upd = Object.assign({}, s);
        upd[field] = val;
        // endDate has no input in this editor, so it must follow the date for
        // single-day rows — empty, tracking the old date, or now before the
        // new date all snap to the new date. Only a deliberate multi-day span
        // (endDate after the new date) is preserved. Leaving it behind made
        // the project form reject saves against a date the user can't see.
        if (field === "date" && (!s.endDate || s.endDate === s.date || s.endDate < val)) upd.endDate = val;
        return upd;
      }));
    }
    function removeItem(id) {
      var item = schedule.find(function(s) { return s.id === id; });
      if (!item) return;
      var doRemove = function() { onChange(schedule.filter(function(s) { return s.id !== id; })); };
      var activeCrew = (item.positions || []).filter(function(p) {
        return p.crewId && (p.status === "requested" || p.status === "accepted" || p.status === "confirmed");
      });
      if (activeCrew.length > 0) {
        setDeletionDlg({
          title: "Delete \"" + (item.title || "Untitled") + "\"",
          message: "This day has " + activeCrew.length + " active crew assignment" + (activeCrew.length > 1 ? "s" : "") +
            ". The shifts will be removed — the crew are added to the notify tray when you save, where you can email them or decline.",
          confirmLabel: "Delete Day",
          onConfirm: function() { doRemove(); setDeletionDlg(null); },
        });
        return;
      }
      doRemove();
    }

    // Position helpers
    function addPosition(schedId) {
      onChange(schedule.map(function(s) {
        if (s.id !== schedId) return s;
        return Object.assign({}, s, { positions: (s.positions || []).concat([{ id: genId("pos"), role: "", serviceId: null, crewId: null, status: "open", fullMargin: false }]) });
      }));
    }
    function updatePosition(schedId, posId, patch) {
      onChange(schedule.map(function(s) {
        if (s.id !== schedId) return s;
        return Object.assign({}, s, { positions: (s.positions || []).map(function(p) { return p.id === posId ? Object.assign({}, p, patch) : p; }) });
      }));
    }
    // Status for the clicked position after a crew pick: a DIFFERENT (or
    // cleared) person means the prior request/answer no longer applies, so it
    // resets to "open" and re-enters the send flow — the same rule the Labor
    // reassign path uses (modules/labor.js), and the invariant crew_integrity's
    // stale-write guard relies on (a status downgrade always changes/clears the
    // assignee). Without this, swapping a confirmed slot to a new person would
    // leave them "confirmed", which the suppress-confirmed conflict rule would
    // then hide — a double-booking for someone who never accepted. Re-picking
    // the same person keeps the status.
    function reassignStatus(pos, crewId) {
      return (crewId && crewId === pos.crewId) ? pos.status : "open";
    }
    // Auto-assign crew to matching roles on all items the same day
    function doAssignCrewToDay(schedId, pos, crewId) {
      var item = schedule.find(function(s) { return s.id === schedId; });
      if (!item || !item.date || !pos.serviceId) {
        updatePosition(schedId, pos.id, { crewId: crewId, status: reassignStatus(pos, crewId) });
        return;
      }
      var sameDayItems = schedule.filter(function(s) { return s.date === item.date; });
      if (sameDayItems.length <= 1) {
        updatePosition(schedId, pos.id, { crewId: crewId, status: reassignStatus(pos, crewId) });
        return;
      }
      onChange(schedule.map(function(s) {
        if (s.date !== item.date) return s;
        return Object.assign({}, s, { positions: (s.positions || []).map(function(p) {
          if (s.id === schedId && p.id === pos.id) return Object.assign({}, p, { crewId: crewId, status: reassignStatus(pos, crewId) });
          if (p.serviceId === pos.serviceId && !p.crewId && p.status === "open") return Object.assign({}, p, { crewId: crewId });
          return p;
        })});
      }));
    }

    function assignCrewToDay(schedId, pos, crewId) {
      var item = schedule.find(function(s) { return s.id === schedId; });
      var warnings = [];

      // Check for same-project duplicates (same person already on another position this day)
      if (item && item.date && crewId) {
        schedule.forEach(function(s) {
          if (s.date !== item.date) return;
          (s.positions || []).forEach(function(p) {
            if (p.id === pos.id) return; // skip the position being assigned
            if (p.crewId === crewId) {
              var svc = p.serviceId ? (services || []).find(function(sv) { return sv.id === p.serviceId; }) : null;
              warnings.push("Already assigned as " + (svc ? svc.role + " \u2014 " + svc.description : p.role || "?") + " on " + s.title);
            }
          });
        });
      }

      // Check for cross-project conflicts
      if (checkCrewConflict && item && item.date && crewId) {
        var otherBookings = checkCrewConflict(crewId, item.date);
        otherBookings.forEach(function(b) { warnings.push(b); });
      }

      if (warnings.length > 0) {
        var cm = (contacts || []).find(function(c) { return c.id === crewId; });
        var crewName = cm ? cm.firstName + " " + cm.lastName : "This crew member";
        setConflictWarn({
          title: "Scheduling Conflict",
          message: crewName + " on " + (item && item.date ? fmt(item.date) : "this day") + ":\n\n" + warnings.join("\n") + "\n\nAssign anyway?",
          onConfirm: function() { doAssignCrewToDay(schedId, pos, crewId); setConflictWarn(null); }
        });
        return;
      }

      doAssignCrewToDay(schedId, pos, crewId);
    }

    function removePosition(schedId, posId) {
      var sched = schedule.find(function(s) { return s.id === schedId; });
      var pos = sched ? (sched.positions || []).find(function(p) { return p.id === posId; }) : null;
      var doRemove = function() {
        onChange(schedule.map(function(s) {
          if (s.id !== schedId) return s;
          return Object.assign({}, s, { positions: (s.positions || []).filter(function(p) { return p.id !== posId; }) });
        }));
      };
      if (pos && pos.crewId && (pos.status === "requested" || pos.status === "accepted" || pos.status === "confirmed")) {
        var cm = (contacts || []).find(function(c) { return c.id === pos.crewId; });
        var crewName = cm ? cm.firstName + " " + cm.lastName : "Assigned crew";
        setDeletionDlg({
          title: "Remove Position",
          message: crewName + " has a " + pos.status + " assignment for this position. It will be removed — they're added to the notify tray when you save, where you can email them or decline.",
          confirmLabel: "Remove Position",
          onConfirm: function() { doRemove(); setDeletionDlg(null); },
        });
        return;
      }
      doRemove();
    }

    // Break helpers
    function addBreak(schedId) {
      onChange(schedule.map(function(s) {
        if (s.id !== schedId) return s;
        return Object.assign({}, s, { breaks: (s.breaks || []).concat([{ id: genId("brk"), startTime: "12:00", endTime: "13:00", type: "unpaid" }]) });
      }));
    }
    function updateBreak(schedId, brkId, patch) {
      onChange(schedule.map(function(s) {
        if (s.id !== schedId) return s;
        return Object.assign({}, s, { breaks: (s.breaks || []).map(function(b) { return b.id === brkId ? Object.assign({}, b, patch) : b; }) });
      }));
    }
    function removeBreak(schedId, brkId) {
      onChange(schedule.map(function(s) {
        if (s.id !== schedId) return s;
        return Object.assign({}, s, { breaks: (s.breaks || []).filter(function(b) { return b.id !== brkId; }) });
      }));
    }

    // Assign crew to all days macro. Only a role backed by a rate-card service
    // can be assigned — the buttons below are suppressed for a crew role with no
    // matching service, and this guards again — so the macro can never mint a
    // serviceId-less (phantom, unrateable) position.
    function assignToAllDays(crewId, serviceId, roleCode) {
      var c = crew.find(function(cr) { return cr.id === crewId; });
      var svc = serviceId ? svcs.find(function(sv) { return sv.id === serviceId; }) : null;
      if (!c || !svc) return;
      onChange(schedule.map(function(s) {
        // Check if this crew is already on this day
        var already = (s.positions || []).some(function(p) { return p.crewId === crewId; });
        if (already) return s;
        var newPos = { id: genId("pos"), role: svc.role, serviceId: svc.id, crewId: crewId, status: "open" };
        return Object.assign({}, s, { positions: (s.positions || []).concat([newPos]) });
      }));
      setAssignCrewModal(false);
    }

    // Copy a position to the next schedule item down the list (role + service only, status = open)
    function copyPositionToNext(fromSchedIndex, pos) {
      if (fromSchedIndex >= schedule.length - 1) return;
      var nextSchedId = schedule[fromSchedIndex + 1].id;
      onChange(schedule.map(function(s) {
        if (s.id !== nextSchedId) return s;
        var newPos = { id: genId("pos"), role: pos.role, serviceId: pos.serviceId, crewId: null, status: "open" };
        return Object.assign({}, s, { positions: (s.positions || []).concat([newPos]) });
      }));
    }

    // Total positions stats — only confirmed counts as filled
    var totalPositions = schedule.reduce(function(n, s) { return n + (s.positions || []).length; }, 0);
    var filledPositions = schedule.reduce(function(n, s) { return n + (s.positions || []).filter(function(p) { return p.status === "confirmed"; }).length; }, 0);

    return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
      // Header
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
        h("label", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } },
          "Schedule" + (totalPositions > 0 ? " \u00b7 " + filledPositions + "/" + totalPositions + " confirmed" : "")),
        h("div", { style: { display: "flex", gap: 6 } },
          schedule.length > 0 && h("button", { onClick: function() { setAssignCrewModal(true); },
            style: { background: "transparent", border: "1px solid " + B.accent, borderRadius: "4px", padding: "3px 10px", color: B.accent, fontSize: "10px", fontWeight: 600, cursor: "pointer" } }, "\u21bb Assign Crew to All Days"),
          h(window.Btn, { small: true, variant: "ghost", onClick: addItem }, "+ New Schedule Day"))
      ),


      // Group schedule items by date for day-level rate calculation
      function() {
        var grouped = [];
        var dateMap = {};
        schedule.forEach(function(s, i) {
          var d = s.date || "_unscheduled";
          if (!dateMap[d]) { dateMap[d] = { date: d, items: [] }; grouped.push(dateMap[d]); }
          dateMap[d].items.push({ item: s, index: i });
        });
        grouped.sort(function(a, b) { return a.date > b.date ? 1 : a.date < b.date ? -1 : 0; });
        grouped.forEach(function(g) { g.items.sort(function(a, b) { return (a.item.time || "") > (b.item.time || "") ? 1 : -1; }); });

        return grouped.map(function(group) {
          // Day-level aggregation
          var dayItems = group.items;
          var dayCall = null, dayWrap = null;
          var allPositions = [];
          var dayItemList = [];
          dayItems.forEach(function(di) {
            var s = di.item;
            if (s.time && (!dayCall || s.time < dayCall)) dayCall = s.time;
            if (s.endTime && (!dayWrap || s.endTime > dayWrap)) dayWrap = s.endTime;
            (s.positions || []).forEach(function(p) { allPositions.push(p); });
            dayItemList.push(s);
          });
          // Rate/meal/OT use the day's actual items (contiguous items merge into
          // one span; real gaps are unpaid) — NOT a flat call→wrap span.
          // Day rate/cost totals bill per PERSON per day (same model as the quote),
          // so the footer matches what will be billed — not a per-position sum.
          var dayLabor = window.LTP_calcDayLabor(dayItemList, svcs, crewMins);
          // Map each position to its labor unit, and pick the PRIMARY position
          // per unit (earliest shift in the day) — the per-person rate shows on
          // that row once; the person's other shifts read "same person" so the
          // rows reconcile with the day total instead of repeating a rate.
          var unitByKey = {};
          dayLabor.units.forEach(function(u) { unitByKey[u.serviceId + "#" + u.slot] = u; });
          var posUnitKey = {}, unitPrimaryPos = {};
          dayItemList.forEach(function(it) {
            var slots = window.LTP_effectiveSlots(it.positions);
            (it.positions || []).forEach(function(p) {
              if (!p.serviceId) return;
              var key = p.serviceId + "#" + (slots[p.id] || 1);
              posUnitKey[p.id] = key;
              if (unitPrimaryPos[key] === undefined) unitPrimaryPos[key] = p.id;
            });
          });
          // OT / meal-penalty warnings fire per PERSON (what the quote actually
          // charges), not off the whole-day span — so a break on a position-less
          // item can't hide a penalty a working person still incurs.
          var dayMealPenaltyHours = Math.round(dayLabor.units.reduce(function(t, u) { return t + u.mealPenaltyHours; }, 0) * 100) / 100;
          var dayHasMealPenalty = dayMealPenaltyHours > 0;
          var dayHasOT = dayLabor.units.some(function(u) { return u.paidHours > 10; });
          var dayPosCount = allPositions.length;
          var dayFilled = allPositions.filter(function(p) { return p.status === "confirmed"; }).length;
          // Day state shows in the top rule: brand orange normally, warn/danger
          // when the day carries OT or a meal penalty (flat ledger panel — the
          // rounded 2px-outlined card is gone).
          var dayRuleColor = dayHasMealPenalty ? B.danger + "88" : dayHasOT ? B.warn + "88" : B.border;

          return h("div", { key: group.date, style: { background: B.raised, borderTop: "2px solid " + dayRuleColor, marginBottom: 4, overflow: "hidden" } },
            // Day header
            h("div", { style: { background: B.surface, padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid " + B.border } },
              h("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
                h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.accent } },
                  group.date !== "_unscheduled" ? fmt(group.date) : "Unscheduled"),
                dayCall && h("span", { style: { fontSize: "10px", color: B.textMut } }, window.LTP_formatTime(dayCall) + " \u2192 " + window.LTP_formatTime(dayWrap)),
                h("span", { style: { fontSize: "10px", color: B.textMut } }, dayItems.length + " item" + (dayItems.length > 1 ? "s" : "")),
                dayPosCount > 0 && h("span", { style: { fontSize: "10px", color: dayFilled === dayPosCount ? B.success : B.textMut } }, dayFilled + "/" + dayPosCount + " confirmed")
              ),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                dayHasOT && h("span", { style: { color: B.btnInk, background: B.warn, fontSize: "9px", fontWeight: 700, padding: "2px 6px", borderRadius: "3px" } }, "OT WARNING"),
                dayHasMealPenalty && h("span", { onClick: function() {
                    // Per-PERSON fix: give a meal break only to the people who
                    // actually incur a penalty, on their own position — so no one
                    // else on the shift is docked. Crew-wide item breaks are kept
                    // as context; individual breaks are recomputed from scratch
                    // (idempotent on repeat clicks).
                    var dayIds = {}; dayItems.forEach(function(di) { dayIds[di.item.id] = true; });
                    var clearedItems = dayItems.map(function(di) {
                      return Object.assign({}, di.item, { positions: (di.item.positions || []).map(function(p) {
                        return (p.breaks && p.breaks.length) ? Object.assign({}, p, { breaks: [] }) : p;
                      }) });
                    });
                    var labor = window.LTP_calcDayLabor(clearedItems, svcs);
                    var breaksByPos = {};
                    labor.units.forEach(function(u) {
                      if (!(u.mealPenaltyHours > 0)) return;
                      var unitKey = u.serviceId + "#" + u.slot;
                      var shifts = [];
                      clearedItems.forEach(function(it) {
                        var slots = window.LTP_effectiveSlots(it.positions);
                        (it.positions || []).forEach(function(p) {
                          if (!p.serviceId) return;
                          if (p.serviceId + "#" + (slots[p.id] || 1) !== unitKey) return;
                          shifts.push({ time: it.time, endTime: it.endTime, breaks: it.breaks || [], positionId: p.id });
                        });
                      });
                      window.LTP_mealFixBreaks(shifts).forEach(function(g) {
                        (breaksByPos[g.positionId] = breaksByPos[g.positionId] || []).push({ id: g.id, startTime: g.startTime, endTime: g.endTime, type: g.type });
                      });
                    });
                    // Apply: rewrite each of this day's positions' individual breaks.
                    onChange(schedule.map(function(sc) {
                      if (!dayIds[sc.id]) return sc;
                      return Object.assign({}, sc, { positions: (sc.positions || []).map(function(p) {
                        var nb = breaksByPos[p.id] || [];
                        if ((p.breaks && p.breaks.length) || nb.length) return Object.assign({}, p, { breaks: nb });
                        return p;
                      }) });
                    }));
                  },
                  title: "Auto-insert a meal break for each person who has a penalty (theirs only — others on the shift aren't affected)",
                  style: { color: B.btnInk, background: B.danger, fontSize: "9px", fontWeight: 700, padding: "2px 6px", borderRadius: "3px", cursor: "pointer" } },
                  "MEAL PENALTY: " + dayMealPenaltyHours + "h \u2014 fix")
              )
            ),

            // Items within this day
            h("div", { style: { padding: "8px" } },
              dayItems.map(function(di) {
                var s = di.item, i = di.index;
                var itemBreaks = s.breaks || [];
                var itemPositions = s.positions || [];
                // Person-slot per position on this shift (drives the # selector).
                var itemSlots = window.LTP_effectiveSlots(itemPositions);
                // Crew already committed to this shift (requested/accepted/confirmed)
                // — editing its date/times re-notifies them (queued on save).
                var committedCrew = itemPositions.filter(function(p) {
                  return p.crewId && (p.status === "requested" || p.status === "accepted" || p.status === "confirmed");
                });

                return h("div", { key: s.id, style: { background: B.bg, borderRadius: "6px", border: "1px solid " + B.border, padding: "8px 10px", marginBottom: 6 } },
                  // Item header: title + times + delete. On mobile the title
                  // takes a full row (delete beside it) and the date/time controls
                  // flex to fit, instead of three fixed 120px inputs wrapping into
                  // an unreadable stack.
                  h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: isMobile ? "wrap" : "nowrap", marginBottom: 4 } },
                    h("input", { type: "text", value: s.title, onChange: function(e) { updateItem(s.id, "title", e.target.value); }, placeholder: "e.g. Load-In",
                      style: Object.assign({}, inp, { flex: 1, minWidth: 0 }) }),
                    isMobile && h("button", { onClick: function() { removeItem(s.id); }, "aria-label": "Delete item",
                      style: { flexShrink: 0, background: "none", border: "none", color: B.danger, cursor: "pointer", fontSize: "20px", padding: "0 4px", lineHeight: 1 } }, "×"),
                    h("div", { style: { display: "flex", gap: isMobile ? 6 : 4, alignItems: "center", flexWrap: "wrap", flex: isMobile ? "1 1 100%" : undefined } },
                      // LTPDateField, not a raw <input type="date">: rows are
                      // grouped and sorted by day below, so publishing every
                      // keystroke would re-key the day card mid-edit (a
                      // half-typed date reads as "" → the row jumps to
                      // "Unscheduled" and the input is destroyed under the
                      // caret). The field buffers typed/arrow edits and
                      // publishes on blur, Enter, or a calendar pick.
                      // One updateItem only — it syncs endDate itself. A second
                      // call here recomputed from the stale `schedule` prop and
                      // clobbered the date update entirely (freezing half-typed
                      // dates like "0002-08-14" into the hidden endDate).
                      h(window.LTPDateField, { value: s.date, onChange: function(v) { updateItem(s.id, "date", v); },
                        ariaLabel: "Shift date",
                        style: Object.assign({}, inp, { flex: isMobile ? "1 1 100%" : undefined, width: isMobile ? undefined : 120, minWidth: 0, borderColor: s.date && s.date < window.LTP_todayISO() ? B.warn : undefined }) }),
                      s.date && s.date < window.LTP_todayISO() && h("span", { style: { fontSize: "8px", color: B.warn, fontWeight: 700 } }, "PAST"),
                      h("input", { type: "time", value: s.time, onChange: function(e) { updateItem(s.id, "time", e.target.value); },
                        style: Object.assign({}, inp, { flex: isMobile ? 1 : undefined, width: isMobile ? undefined : 120, minWidth: 0 }) }),
                      h("span", { style: { color: B.textMut, fontSize: "10px" } }, "\u2192"),
                      h("input", { type: "time", value: s.endTime, onChange: function(e) { updateItem(s.id, "endTime", e.target.value); },
                        style: Object.assign({}, inp, { flex: isMobile ? 1 : undefined, width: isMobile ? undefined : 120, minWidth: 0 }) }),
                      h("span", { style: { fontSize: "10px", fontWeight: 600, color: B.textMut, flexShrink: 0 } }, calcHours(s.time, s.endTime) ? calcHours(s.time, s.endTime) + "h" : ""),
                      h("button", { onClick: function() { updateItem(s.id, "showOnCalendar", !s.showOnCalendar); },
                        style: { flexShrink: 0, background: s.showOnCalendar ? B.accent + "22" : "transparent", border: "1px solid " + (s.showOnCalendar ? B.accent : B.border), borderRadius: "3px", padding: isMobile ? "5px 10px" : "2px 6px", color: s.showOnCalendar ? B.accent : B.textMut, fontSize: isMobile ? "10px" : "8px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" } },
                        s.showOnCalendar ? "\u2713 Cal" : "Cal"),
                      !isMobile && h("button", { onClick: function() { removeItem(s.id); }, style: { background: "none", border: "none", color: B.danger, cursor: "pointer", fontSize: "13px", padding: "2px 4px" } }, "\u00d7")
                    )
                  ),
                  // Heads-up when this shift has crew already committed — editing
                  // its date/times will queue them to be re-notified on save.
                  committedCrew.length > 0 && h("div", { style: { fontSize: "10px", color: B.warn, background: B.warn + "14", border: "1px solid " + B.warn + "44", borderRadius: "4px", padding: "3px 8px", marginBottom: 4, display: "flex", alignItems: "center", gap: 5 } },
                    h("span", { style: { fontWeight: 700, flexShrink: 0 } }, "⚠"),
                    h("span", null, committedCrew.length + " committed crew member" + (committedCrew.length > 1 ? "s" : "") + " on this shift — changing its date or times will queue a re-notification when you save.")),
                  // Item breaks
                  h("div", { style: { display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", marginBottom: itemPositions.length > 0 ? 4 : 0 } },
                    itemBreaks.map(function(brk) {
                      var isPaid = brk.type === "paid";
                      return h("div", { key: brk.id, style: { display: "inline-flex", gap: 3, alignItems: "center", background: isPaid ? B.accent + "11" : B.surface, border: "1px solid " + (isPaid ? B.accent + "44" : B.border), borderRadius: "3px", padding: "2px 6px", fontSize: "9px" } },
                        h("button", { onClick: function() { updateBreak(s.id, brk.id, { type: isPaid ? "unpaid" : "paid", endTime: isPaid ? _addTime(brk.startTime, 60) : _addTime(brk.startTime, 30) }); },
                          style: { background: isPaid ? B.accent : B.raised, color: isPaid ? B.btnInk : B.textMut, border: "none", borderRadius: "2px", padding: "0 4px", fontSize: "8px", fontWeight: 700, cursor: "pointer" } },
                          isPaid ? "PAID" : "UNPAID"),
                        h("input", { type: "time", value: brk.startTime, onChange: function(e) { updateBreak(s.id, brk.id, { startTime: e.target.value }); },
                          style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "2px", padding: "1px 4px", color: B.text, fontSize: "9px", fontFamily: "inherit", outline: "none", width: 105 } }),
                        h("span", { style: { color: B.textMut } }, "\u2192"),
                        h("input", { type: "time", value: brk.endTime, onChange: function(e) { updateBreak(s.id, brk.id, { endTime: e.target.value }); },
                          style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "2px", padding: "1px 4px", color: B.text, fontSize: "9px", fontFamily: "inherit", outline: "none", width: 105 } }),
                        h("button", { onClick: function() { removeBreak(s.id, brk.id); }, style: { background: "transparent", border: "none", color: B.textMut, cursor: "pointer", fontSize: "10px", padding: 0 } }, "\u00d7")
                      );
                    }),
                    h("button", { onClick: function() { addBreak(s.id); },
                      style: { background: "transparent", border: "1px dashed " + B.border, borderRadius: "3px", padding: "2px 6px", color: B.textMut, cursor: "pointer", fontSize: "8px", fontWeight: 600 } }, "+ Break")
                  ),
                  // Item positions
                  itemPositions.length > 0 && h("div", { style: { display: "flex", flexDirection: "column", gap: 3 } },
                    itemPositions.map(function(pos) {
                      var svc = pos.serviceId ? svcs.find(function(sv) { return sv.id === pos.serviceId; }) : null;
                      var crewMember = pos.crewId ? contacts.find(function(c) { return c.id === pos.crewId; }) : null;
                      // Per-row rate reflects THIS shift's hours (its own item),
                      // so a short shift reads as a half day. The day total below
                      // bills per role per day (LTP_calcDayLabor) and is the
                      // authoritative figure — rows are indicative and won't sum
                      // to it when a role spans multiple items.
                      var posUnit = svc ? unitByKey[posUnitKey[pos.id]] : null;
                      var isUnitPrimary = posUnit && unitPrimaryPos[posUnitKey[pos.id]] === pos.id;
                      var pc = POS_COLORS[pos.status] || B.textMut;
                      var posConflicts = (liveConflicts || {})[pos.id];
                      var hasConflict = posConflicts && posConflicts.length > 0;
                      return h("div", { key: pos.id, style: { background: hasConflict ? B.danger + "08" : B.surface, border: "1px solid " + (hasConflict ? B.danger + "66" : B.border), borderRadius: "3px", padding: isMobile ? "8px" : "4px 8px", display: "flex", gap: 6, alignItems: "center", flexWrap: isMobile ? "wrap" : "nowrap" } },
                        hasConflict && h("div", { title: "Double-booked: also on " + posConflicts.map(function(c) { return c.projectName; }).join(", "),
                          style: { width: 16, height: 16, borderRadius: "50%", background: B.danger + "22", border: "1px solid " + B.danger, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "help" } },
                          h("span", { style: { fontSize: "9px", color: B.danger, fontWeight: 700 } }, "!")),
                        // Role + person-slot share one row on mobile; the wrapper is
                        // display:contents on desktop so that layout is unchanged.
                        h("div", { style: { display: isMobile ? "flex" : "contents", flex: isMobile ? "1 1 100%" : undefined, gap: 6, alignItems: "center" } },
                        // Searchable: the rate card grows, and scrolling a bare
                        // <select> for "the L2 role" got old fast.
                        h(window.LTPSearchSelect, {
                          value: pos.serviceId || "",
                          onChange: function(v) {
                            var sid = (v === "" || v == null) ? null : Number(v);
                            var sv = sid ? svcs.find(function(sv2) { return sv2.id === sid; }) : null;
                            updatePosition(s.id, pos.id, { serviceId: sid, role: sv ? sv.role : "" });
                          },
                          options: [{ value: "", label: "Role\u2026" }].concat(svcs.map(function(sv) {
                            return { value: sv.id, label: sv.role, sublabel: sv.description };
                          })),
                          searchPlaceholder: "Search roles\u2026",
                          style: { flex: 1, minWidth: 0 },
                          triggerStyle: { borderRadius: "3px", padding: isMobile ? "8px" : "3px 5px", fontSize: "10px", minHeight: 0 },
                          panelMinWidth: 250,
                        }),
                        // Person slot \u2014 shown when a role has 2+ on the day. Give
                        // distinct people different numbers so each is tracked
                        // separately (own hours / OT / meal penalty); leave two
                        // shifts on the same number to mark them the same person.
                        (function() {
                          var roleCountInDay = pos.serviceId ? allPositions.filter(function(p) { return p.serviceId === pos.serviceId; }).length : 0;
                          if (roleCountInDay < 2) return null;
                          var effSlot = itemSlots[pos.id] || 1;
                          var opts = [];
                          for (var n = 1; n <= roleCountInDay; n++) opts.push(n);
                          return h("select", { value: effSlot,
                            title: "Person #" + effSlot + " for this role. Different number = different person (tracked separately); same number across shifts = same person.",
                            onChange: function(e) { updatePosition(s.id, pos.id, { slot: Number(e.target.value) }); },
                            style: { flexShrink: 0, width: isMobile ? 58 : 46, background: B.bg, border: "1px solid " + B.border, borderRadius: "3px", padding: isMobile ? "8px 4px" : "3px 2px", color: B.text, fontSize: "10px", fontFamily: "inherit" } },
                            opts.map(function(n) { return h("option", { key: n, value: n }, "#" + n); }));
                        })()
                        ),
                        // Only crew tagged with this role are listed; everyone
                        // else sits behind a deliberate "Other crew" click, so a
                        // role nobody is tagged with never leaves the position
                        // unassignable. Crew is PICKED here, never authored —
                        // this field deliberately has no inline-create.
                        (function() {
                          // Filter on the LINKED SERVICE's role, not the
                          // denormalized pos.role: a stale or free-text code
                          // matches nobody and would push the whole roster
                          // behind "Other crew". No service = no role being
                          // filled = offer everyone.
                          var posSvc = pos.serviceId ? svcs.find(function(sv) { return sv.id === pos.serviceId; }) : null;
                          var co = window.LTP_crewSelectOptions({
                            crew: crew, role: posSvc ? posSvc.role : "", selectedId: pos.crewId,
                            allContacts: contacts, leading: [{ value: "", label: "Crew\u2026" }],
                          });
                          return h(window.LTPSearchSelect, {
                            value: pos.crewId || "",
                            onChange: function(v) {
                              var cid = (v === "" || v == null) ? null : Number(v);
                              if (cid) { assignCrewToDay(s.id, pos, cid); }
                              // Clearing the crew reopens the slot — an unassigned position
                              // can't stay requested/accepted/confirmed (same reason as
                              // reassignStatus, and it keeps the stale-write guard's
                              // "downgrade clears the assignee" invariant intact).
                              else { updatePosition(s.id, pos.id, { crewId: null, status: "open" }); }
                            },
                            options: co.options, moreOptions: co.moreOptions, moreLabel: co.moreLabel,
                            searchPlaceholder: "Search crew\u2026",
                            style: { flex: isMobile ? "1 1 100%" : 1, minWidth: 0 },
                            triggerStyle: { borderRadius: "3px", padding: isMobile ? "8px" : "3px 5px", fontSize: "10px", minHeight: 0 },
                            panelMinWidth: 260,
                          });
                        })(),
                        // Footer row on mobile: status + margin toggle + breaks on
                        // the left, rate + copy + delete pushed to the right. The
                        // wrapper is display:contents on desktop so the single-line
                        // layout there is unchanged.
                        h("div", { style: { display: isMobile ? "flex" : "contents", flex: isMobile ? "1 1 100%" : undefined, alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: isMobile ? 2 : undefined } },
                        // Status — read-only in schedule editor, manage via Labor module
                        h("span", { style: { flexShrink: 0, width: 70, textAlign: "center", fontSize: "9px", fontWeight: 600, color: (POS_COLORS[pos.status] || B.textMut), background: (POS_COLORS[pos.status] || B.textMut) + "18", border: "1px solid " + (POS_COLORS[pos.status] || B.textMut) + "33", borderRadius: "3px", padding: "4px 6px" } }, pos.status),
                        // Full-margin toggle — bills the rate, zeroes the cost (e.g. owner working)
                        h("button", { onClick: function() { updatePosition(s.id, pos.id, { fullMargin: !pos.fullMargin }); },
                          title: pos.fullMargin ? "Full margin: company cost is $0 for this position (rate still billed). Click to cost it normally." : "Mark full margin — zero the company cost (rate still billed), e.g. the owner working.",
                          style: { flexShrink: 0, background: pos.fullMargin ? B.success + "22" : "transparent", border: "1px solid " + (pos.fullMargin ? B.success : B.border), borderRadius: "3px", padding: isMobile ? "5px 10px" : "2px 5px", color: pos.fullMargin ? B.success : B.textMut, fontSize: isMobile ? "10px" : "8px", fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" } },
                          pos.fullMargin ? "✓ MGN" : "MGN"),
                        // Individual meal break(s) for THIS person (added by the
                        // meal-penalty fix; removable). Distinct from the item's
                        // crew-wide breaks above.
                        (pos.breaks && pos.breaks.length > 0) && h("div", { style: { display: "flex", gap: 2, alignItems: "center" } },
                          pos.breaks.map(function(br) {
                            return h("span", { key: br.id, title: "Individual meal break " + window.LTP_formatTime(br.startTime) + " – " + window.LTP_formatTime(br.endTime) + " (this person only)",
                              style: { display: "inline-flex", alignItems: "center", gap: 2, background: B.warn + "22", border: "1px solid " + B.warn + "55", borderRadius: "3px", padding: "1px 4px", fontSize: "8px", color: B.warn, fontWeight: 600, whiteSpace: "nowrap" } },
                              "⏸ " + window.LTP_formatTime(br.startTime),
                              h("button", { onClick: function() { updatePosition(s.id, pos.id, { breaks: (pos.breaks || []).filter(function(x) { return x.id !== br.id; }) }); },
                                style: { background: "transparent", border: "none", color: B.warn, cursor: "pointer", fontSize: "9px", padding: 0, lineHeight: 1 } }, "×"));
                          })),
                        h("div", { style: { flexShrink: 0, width: 92, textAlign: "right", fontSize: "9px", marginLeft: isMobile ? "auto" : undefined } },
                          !posUnit ? null : (isUnitPrimary
                            ? [
                                h("div", { key: "r", style: { color: B.accent, fontWeight: 600 } }, "$" + Math.round(posUnit.rateTotal)),
                                posUnit.fullMargin
                                  ? h("div", { key: "c", style: { color: B.success, fontWeight: 600 } }, "margin")
                                  : h("div", { key: "c", style: { color: posUnit.minApplied ? B.warn : B.textMut },
                                      title: posUnit.minApplied ? "Raised to this crew member's negotiated minimum (payout only — the client rate above is unchanged)." : undefined },
                                      "$" + Math.round(posUnit.costTotal) + (posUnit.minApplied ? " min" : ""))
                              ]
                            : h("div", { style: { color: B.textMut, fontStyle: "italic" }, title: "Same person as an earlier shift this day — billed once (see above)." }, "↳ same person"))),
                        h("button", { onClick: function() { removePosition(s.id, pos.id); }, "aria-label": "Remove position",
                          style: { flexShrink: 0, background: "transparent", border: "none", color: isMobile ? B.danger : B.textMut, cursor: "pointer", fontSize: isMobile ? "20px" : "12px", padding: isMobile ? "4px 6px" : 0, minHeight: isMobile ? 40 : undefined } }, "\u00d7"),
                        i < schedule.length - 1 && h("button", { onClick: function() { copyPositionToNext(i, pos); },
                          title: "Copy role to next item",
                          // Hover reveal doesn't fire on touch, so keep it visible on mobile.
                          style: { flexShrink: 0, background: "transparent", border: "none", color: isMobile ? B.accent : B.border, cursor: "pointer", fontSize: isMobile ? "18px" : "10px", padding: isMobile ? "4px 8px" : "1px 3px", minHeight: isMobile ? 40 : undefined },
                          onMouseOver: function(e) { e.currentTarget.style.color = B.accent; },
                          onMouseOut:  function(e) { e.currentTarget.style.color = isMobile ? B.accent : B.border; } }, "\u21e9")
                        )
                      );
                    })
                  ),
                  // Add position button
                  h("button", { onClick: function() { addPosition(s.id); },
                    style: { background: "transparent", border: "1px dashed " + B.accent + "44", color: B.accent, cursor: "pointer", fontSize: "9px", fontWeight: 600, padding: "3px 8px", borderRadius: "3px", marginTop: 4, width: "100%" } }, "+ Position")
                );
              }),

              // Add item to this day
              h("button", { onClick: function() {
                  var lastItem = dayItems[dayItems.length - 1].item;
                  addItemToDay(group.date !== "_unscheduled" ? group.date : "", lastItem.endTime || "08:00");
                },
                style: { background: "transparent", border: "1px dashed " + B.accent + "44", color: B.accent, cursor: "pointer", fontSize: "9px", fontWeight: 600, padding: "6px", borderRadius: "4px", width: "100%", marginBottom: 4 } }, "+ Add Item to This Day"),

              // Day totals + per-PERSON breakdown. Each unit is one person
              // (role + slot); their meal penalty / OT depend on the shifts they
              // work, so two people in the same role can differ. The badge up top
              // shows the day total; this lists where it comes from, person by
              // person. Slot numbers (#1, #2) appear when a role has 2+ people.
              allPositions.length > 0 && h("div", { style: { padding: "6px 10px 2px", borderTop: "1px dashed " + B.border, fontSize: "10px", display: "flex", flexDirection: "column", gap: 2 } },
                (function() {
                  var roleUnitCount = {};
                  dayLabor.units.forEach(function(u) { roleUnitCount[u.serviceId] = (roleUnitCount[u.serviceId] || 0) + 1; });
                  return dayLabor.units.map(function(u) {
                    var regOT = Math.round((u.otHours - u.mealPenaltyHours) * 100) / 100;
                    var extras = [];
                    if (u.mealPenaltyHours > 0) extras.push(u.mealPenaltyHours + "h meal penalty");
                    if (regOT > 0) extras.push(regOT + "h OT");
                    var label = u.svc.role + (roleUnitCount[u.serviceId] > 1 ? " #" + u.slot : "") + " — " + (u.tier === "half" ? "Half" : "Full") + " " + u.paidHours + "h";
                    return h("div", { key: u.serviceId + "#" + u.slot, style: { display: "flex", gap: 6 } },
                      h("span", { style: { color: B.textMut } }, label),
                      extras.length > 0 && h("span", { style: { color: B.danger, fontWeight: 600 } }, "+ " + extras.join(" + ")),
                      u.fullMargin && h("span", { style: { color: B.success, fontWeight: 600 } }, "· full margin"));
                  });
                })(),
                h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 14, marginTop: 2, paddingTop: 3, borderTop: "1px solid " + B.border } },
                  h("span", { style: { color: B.accent, fontWeight: 700 } }, "Rate: $" + Math.round(dayLabor.rateTotal)),
                  h("span", { style: { color: B.textMut } }, "Cost: $" + Math.round(dayLabor.costTotal)))
              )
            )
          );
        });
      }(),
      // Assign crew to all days modal
      // Not a dropdown (each row is a person × one button per role they hold),
      // so it keeps its list shape — but it gets the same search box, because
      // scrolling a long roster is exactly what this change is about.
      assignCrewModal && h(window.LTPModal, { title: "Assign Crew to All Days", onClose: function() { setAssignCrewModal(false); setCrewSearch(""); } },
        h("p", { style: { fontSize: "12px", color: B.textMut, marginBottom: 12 } }, "Select a crew member and role. They will be added to every schedule day they aren't already on."),
        h("input", { type: "text", value: crewSearch, placeholder: "Search crew\u2026", autoFocus: true,
          onChange: function(e) { setCrewSearch(e.target.value); },
          style: { width: "100%", boxSizing: "border-box", background: B.bg, border: "1px solid " + B.border, borderRadius: "8px", padding: "9px 12px", color: B.text, fontSize: isMobile ? "16px" : "13px", fontFamily: "inherit", outline: "none", marginBottom: 10 } }),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 6, maxHeight: 350, overflowY: "auto" } },
          shownCrew.map(function(c) {
            // Only offer roles that map to a rate-card service — a role with no
            // service would create a position that carries no rate and no
            // DB-backed identity. A crew member with no rate-card roles shows
            // none (assign them from the schedule row via the Role dropdown).
            var assignable = (c.crewRoles || []).map(function(roleCode) {
              return svcs.find(function(sv) { return sv.role === roleCode; });
            }).filter(Boolean);
            return h("div", { key: c.id, style: { display: "flex", gap: 8, alignItems: "center" } },
              h("div", { style: { flex: 1 } },
                h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, c.firstName + " " + c.lastName),
                h("div", { style: { fontSize: "10px", color: B.textMut } }, assignable.length ? assignable.map(function(sv) { return sv.role; }).join(", ") : "No rate-card roles")),
              assignable.map(function(sv) {
                return h("button", { key: sv.id, onClick: function() { assignToAllDays(c.id, sv.id, sv.role); },
                  style: { background: B.accent + "22", border: "1px solid " + B.accent + "44", borderRadius: "4px", padding: "4px 10px", color: B.accent, fontSize: "10px", fontWeight: 600, cursor: "pointer" } }, "as " + sv.role);
              })
            );
          }),
          shownCrew.length === 0 && h("div", { key: "_nores", style: { fontSize: "12px", color: B.textMut, fontStyle: "italic", padding: "8px 0" } },
            crew.length === 0 ? "No active crew yet." : "No crew match \u201c" + crewSearch.trim() + "\u201d.")
        )
      ),

      // Conflict warning dialog
      conflictWarn && h(window.LTPModal, { title: conflictWarn.title, onClose: function() { setConflictWarn(null); } },
        h("p", { style: { fontSize: "12px", color: B.textSec, marginBottom: 16, lineHeight: 1.6, whiteSpace: "pre-line" } }, conflictWarn.message),
        h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
          h(window.Btn, { variant: "ghost", onClick: function() { setConflictWarn(null); } }, "Cancel"),
          h(window.Btn, { variant: "danger", onClick: conflictWarn.onConfirm }, "Assign Anyway"))
      ),

      // Deletion confirmation \u2014 a plain "are you sure" for removing a staffed
      // day/position. The crew-withdrawal email is NOT decided here; it's batched
      // at save (parent diffs the schedule and prompts once), so removing one
      // person from several shifts doesn't spam them once per removal.
      deletionDlg && h(window.LTPModal, { title: deletionDlg.title, onClose: function() { setDeletionDlg(null); } },
        h("p", { style: { fontSize: "12px", color: B.textSec, marginBottom: 16, lineHeight: 1.5 } }, deletionDlg.message),
        h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
          h(window.Btn, { variant: "ghost", onClick: function() { setDeletionDlg(null); } }, "Cancel"),
          h(window.Btn, { variant: "danger", onClick: deletionDlg.onConfirm }, deletionDlg.confirmLabel))
      )
    );
  };
})();
