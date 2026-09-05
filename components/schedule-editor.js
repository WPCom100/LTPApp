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

    // ── Density presets ──────────────────────────────────────────────────────
    // Desktop keeps the dense 10–12px ledger look and renders exactly as it
    // always has. On a phone every input is 16px whether we like it or not
    // (index.html forces it so iOS never zooms on focus), so the mobile layout
    // is designed AROUND that size instead of against it: 36px controls, role
    // and crew sharing one row, one slim footer row per position, and the
    // native date/time pickers tucked behind compact formatted chips (`chip`).
    var M = isMobile;
    var CTL = window.LTP_CTL;
    var ft = window.LTP_formatTime, fmtShort = window.LTP_formatDateShort;
    var mInp = { background: B.bg, border: "1px solid " + B.border, borderRadius: "8px", padding: "0 10px", height: CTL, color: B.text, fontSize: "16px", fontFamily: "inherit", outline: "none", width: "100%", minWidth: 0, boxSizing: "border-box" };
    var trig = M ? { borderRadius: "8px", padding: "0 10px", fontSize: "13px", minHeight: CTL }
                 : { borderRadius: "3px", padding: "3px 5px", fontSize: "10px", minHeight: 0 };
    // Glyph buttons (×, ⇩) on a phone: a square tap target, no border.
    function glyphBtn(color, fontSize, box) {
      return { flexShrink: 0, width: box || CTL, height: box || CTL, display: "inline-flex", alignItems: "center", justifyContent: "center",
               background: "transparent", border: "none", borderRadius: "8px", color: color, cursor: "pointer", fontSize: fontSize, lineHeight: 1, padding: 0, fontFamily: "inherit" };
    }
    // Small pill toggles (Cal, MGN, PAID/UNPAID) on a phone.
    function pill(on, color, height) {
      return { flexShrink: 0, height: height || 28, padding: "0 9px", borderRadius: "7px", fontSize: "10px", fontWeight: 700, lineHeight: 1,
               background: on ? color + "22" : "transparent", border: "1px solid " + (on ? color : B.border), color: on ? color : B.textMut,
               cursor: "pointer", whiteSpace: "nowrap", fontFamily: "inherit" };
    }
    // Native pickers behind a chip (window.LTP_pickerChip, ui.js): on a phone
    // the deferred field is rendered over a formatted chip at opacity 0 — the
    // chip is what you see ("Thu, Sep 10"), the field is what you tap, and its
    // buffering/commit rules are untouched. Desktop gets the field itself.
    var NATIVE = window.LTP_NATIVE;
    function chip(opts, field) { return M ? window.LTP_pickerChip(opts, field) : field; }
    var seg = window.LTP_pickerSeg;
    var dashedBtn = M
      ? { background: "transparent", border: "1px dashed " + B.accent + "55", color: B.accent, cursor: "pointer", fontSize: "12px", fontWeight: 600, padding: "0 10px", height: 34, borderRadius: "8px", width: "100%", fontFamily: "inherit" }
      : null;

    return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
      // Header
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: M ? 8 : undefined } },
        h("label", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em",
                              minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: M ? "nowrap" : undefined } },
          "Schedule" + (totalPositions > 0 ? " · " + filledPositions + "/" + totalPositions + " confirmed" : "")),
        h("div", { style: { display: "flex", gap: 6, flexShrink: 0 } },
          schedule.length > 0 && h("button", { onClick: function() { setAssignCrewModal(true); },
            style: M ? { background: "transparent", border: "1px solid " + B.accent, borderRadius: "8px", padding: "0 10px", height: 32, color: B.accent, fontSize: "11px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }
                     : { background: "transparent", border: "1px solid " + B.accent, borderRadius: "4px", padding: "3px 10px", color: B.accent, fontSize: "10px", fontWeight: 600, cursor: "pointer" } },
            M ? "↻ Assign all" : "↻ Assign Crew to All Days"),
          h(window.Btn, { small: true, variant: "ghost", onClick: addItem, style: M ? { height: 32, padding: "0 12px" } : undefined }, M ? "+ Day" : "+ New Schedule Day"))
      ),

      // Phone-only empty state — the first "+ Day" is otherwise a lone button.
      M && schedule.length === 0 && h("div", { style: { border: "1px dashed " + B.border, borderRadius: "10px", padding: "22px 14px", textAlign: "center", fontSize: "12px", color: B.textMut, lineHeight: 1.5 } },
        "No schedule days yet. Tap ", h("b", { style: { color: B.textSec } }, "+ Day"), " to add the first call."),

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

          var dayTitle = group.date !== "_unscheduled" ? (M ? fmtShort(group.date) : fmt(group.date)) : "Unscheduled";
          var dayBadges = [
            dayHasOT && h("span", { key: "ot", style: { color: B.btnInk, background: B.warn, fontSize: "9px", fontWeight: 700, padding: M ? "3px 7px" : "2px 6px", borderRadius: M ? "5px" : "3px", whiteSpace: "nowrap" } }, "OT WARNING"),
            dayHasMealPenalty && h("span", { key: "meal", onClick: function() {
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
              style: { color: B.btnInk, background: B.danger, fontSize: "9px", fontWeight: 700, padding: M ? "3px 7px" : "2px 6px", borderRadius: M ? "5px" : "3px", cursor: "pointer", whiteSpace: "nowrap" } },
              "MEAL PENALTY: " + dayMealPenaltyHours + "h — fix")
          ];
          var dayMeta = [
            dayCall && h("span", { key: "t", style: { fontSize: M ? "11px" : "10px", color: B.textMut } }, window.LTP_formatTime(dayCall) + " → " + window.LTP_formatTime(dayWrap)),
            h("span", { key: "n", style: { fontSize: M ? "11px" : "10px", color: B.textMut } }, dayItems.length + " item" + (dayItems.length > 1 ? "s" : "")),
            dayPosCount > 0 && h("span", { key: "c", style: { fontSize: M ? "11px" : "10px", color: dayFilled === dayPosCount ? B.success : B.textMut } }, dayFilled + "/" + dayPosCount + " confirmed")
          ];

          return h("div", { key: group.date, style: M
              ? { background: B.raised, border: "1px solid " + B.border, borderTop: "2px solid " + dayRuleColor, borderRadius: "10px", marginBottom: 10, overflow: "hidden" }
              : { background: B.raised, borderTop: "2px solid " + dayRuleColor, marginBottom: 4, overflow: "hidden" } },
            // Day header. Phone: the date on its own line with the badges, the
            // call→wrap / item / confirmed meta beneath it as one muted line —
            // instead of four columns squeezing the date into two.
            M
              ? h("div", { style: { background: B.surface, padding: "9px 12px", borderBottom: "1px solid " + B.border } },
                  h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" } },
                    h("div", { style: { fontSize: "14px", fontWeight: 700, color: B.accent, letterSpacing: "-0.01em" } }, dayTitle),
                    h("div", { style: { display: "flex", gap: 6, alignItems: "center" } }, dayBadges)),
                  h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 2 } }, dayMeta))
              : h("div", { style: { background: B.surface, padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid " + B.border } },
                  h("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
                    h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.accent } }, dayTitle),
                    dayMeta),
                  h("div", { style: { display: "flex", gap: 6, alignItems: "center" } }, dayBadges)),

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
                var isPast = !!(s.date && s.date < window.LTP_todayISO());
                var hrs = calcHours(s.time, s.endTime);

                // ── Item header controls, built once and laid out per width ──
                var titleInput = h("input", { type: "text", value: s.title, onChange: function(e) { updateItem(s.id, "title", e.target.value); }, placeholder: "e.g. Load-In",
                  style: M ? Object.assign({}, mInp, { flex: 1, fontWeight: 600 }) : Object.assign({}, inp, { flex: 1, minWidth: 0 }) });
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
                var dateField = chip({ label: s.date ? fmtShort(s.date) : "Date", empty: !s.date, warn: isPast, style: { flex: "1 1 auto" } },
                  h(window.LTPDateField, { value: s.date, onChange: function(v) { updateItem(s.id, "date", v); },
                    ariaLabel: "Shift date",
                    style: M ? NATIVE : Object.assign({}, inp, { width: 120, minWidth: 0, borderColor: isPast ? B.warn : undefined }) }));
                var pastTag = isPast && h("span", { style: { fontSize: M ? "9px" : "8px", color: B.warn, fontWeight: 700, letterSpacing: "0.04em" } }, "PAST");
                // Deferred like the date, and for the same reason twice
                // over: the rows inside a day are sorted by start time, so
                // publishing a half-typed hour ("01:00" on the way to
                // "11:00", or "" while a segment is empty) jumps this row
                // past its neighbours mid-word — the field moves out from
                // under the caret and the time can't be typed through.
                var startField = chip({ label: s.time ? ft(s.time) : "Start", empty: !s.time, bare: true },
                  h(window.LTPTimeField, { value: s.time, onChange: function(v) { updateItem(s.id, "time", v); },
                    ariaLabel: "Shift start time",
                    style: M ? NATIVE : Object.assign({}, inp, { width: 120, minWidth: 0 }) }));
                var endField = chip({ label: s.endTime ? ft(s.endTime) : "End", empty: !s.endTime, bare: true, divider: true },
                  h(window.LTPTimeField, { value: s.endTime, onChange: function(v) { updateItem(s.id, "endTime", v); },
                    ariaLabel: "Shift end time",
                    style: M ? NATIVE : Object.assign({}, inp, { width: 120, minWidth: 0 }) }));
                var hoursLabel = h("span", { style: { fontSize: M ? "11px" : "10px", fontWeight: 600, color: B.textMut, flexShrink: 0 } }, hrs ? hrs + "h" : "");
                var calBtn = h("button", { onClick: function() { updateItem(s.id, "showOnCalendar", !s.showOnCalendar); },
                  title: s.showOnCalendar ? "Shown on the calendar" : "Hidden from the calendar",
                  style: M ? pill(s.showOnCalendar, B.accent, 30)
                           : { flexShrink: 0, background: s.showOnCalendar ? B.accent + "22" : "transparent", border: "1px solid " + (s.showOnCalendar ? B.accent : B.border), borderRadius: "3px", padding: "2px 6px", color: s.showOnCalendar ? B.accent : B.textMut, fontSize: "8px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" } },
                  s.showOnCalendar ? "✓ Cal" : "Cal");
                var delItemBtn = h("button", { onClick: function() { removeItem(s.id); }, "aria-label": "Delete item",
                  style: M ? glyphBtn(B.danger, "22px") : { background: "none", border: "none", color: B.danger, cursor: "pointer", fontSize: "13px", padding: "2px 4px" } }, "×");

                return h("div", { key: s.id, style: M
                    ? { background: B.bg, borderRadius: "10px", border: "1px solid " + B.border, padding: "10px", marginBottom: 8 }
                    : { background: B.bg, borderRadius: "6px", border: "1px solid " + B.border, padding: "8px 10px", marginBottom: 6 } },
                  // Item header. Phone: the title with its delete on one row,
                  // then date · [start | end] · hours · Cal as chips on the next.
                  // Desktop: the single line it has always been.
                  M
                    ? [
                        h("div", { key: "t", style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 6 } }, titleInput, delItemBtn),
                        h("div", { key: "w", style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 } },
                          dateField, pastTag, seg(startField, endField), hoursLabel, calBtn)
                      ]
                    : h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "nowrap", marginBottom: 4 } },
                        titleInput,
                        h("div", { style: { display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" } },
                          dateField, pastTag, startField,
                          h("span", { style: { color: B.textMut, fontSize: "10px" } }, "→"),
                          endField, hoursLabel, calBtn, delItemBtn)),
                  // Heads-up when this shift has crew already committed — editing
                  // its date/times will queue them to be re-notified on save.
                  committedCrew.length > 0 && h("div", { style: { fontSize: M ? "11px" : "10px", color: B.warn, background: B.warn + "14", border: "1px solid " + B.warn + "44", borderRadius: M ? "8px" : "4px", padding: M ? "6px 10px" : "3px 8px", marginBottom: M ? 6 : 4, display: "flex", alignItems: "center", gap: 5, lineHeight: 1.4 } },
                    h("span", { style: { fontWeight: 700, flexShrink: 0 } }, "⚠"),
                    h("span", null, committedCrew.length + " committed crew member" + (committedCrew.length > 1 ? "s" : "") +
                      (M ? " on this shift — a date or time change re-notifies them when you save."
                         : " on this shift — changing its date or times will queue a re-notification when you save."))),
                  // Item breaks
                  h("div", { style: { display: "flex", gap: M ? 6 : 4, alignItems: "center", flexWrap: "wrap", marginBottom: itemPositions.length > 0 ? (M ? 6 : 4) : 0 } },
                    itemBreaks.map(function(brk) {
                      var isPaid = brk.type === "paid";
                      var brkInp = { background: B.bg, border: "1px solid " + B.border, borderRadius: "2px", padding: "1px 4px", color: B.text, fontSize: "9px", fontFamily: "inherit", outline: "none", width: 105 };
                      var typeBtn = h("button", { onClick: function() { updateBreak(s.id, brk.id, { type: isPaid ? "unpaid" : "paid", endTime: isPaid ? _addTime(brk.startTime, 60) : _addTime(brk.startTime, 30) }); },
                        style: M ? { flexShrink: 0, height: 30, padding: "0 8px", background: isPaid ? B.accent : B.raised, color: isPaid ? B.btnInk : B.textMut, border: "none", borderRadius: "7px", fontSize: "10px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }
                                 : { background: isPaid ? B.accent : B.raised, color: isPaid ? B.btnInk : B.textMut, border: "none", borderRadius: "2px", padding: "0 4px", fontSize: "8px", fontWeight: 700, cursor: "pointer" } },
                        isPaid ? "PAID" : "UNPAID");
                      // Break times defer too: a half-typed break feeds the
                      // labor engine a bogus span, so the day's OT / meal-
                      // penalty badges flicker (and the "fix" button appears
                      // and vanishes) between keystrokes.
                      var bStart = chip({ label: brk.startTime ? ft(brk.startTime) : "Start", empty: !brk.startTime, small: true, bare: true },
                        h(window.LTPTimeField, { value: brk.startTime, onChange: function(v) { updateBreak(s.id, brk.id, { startTime: v }); },
                          ariaLabel: "Break start time",
                          style: M ? NATIVE : brkInp }));
                      var bEnd = chip({ label: brk.endTime ? ft(brk.endTime) : "End", empty: !brk.endTime, small: true, bare: true, divider: true },
                        h(window.LTPTimeField, { value: brk.endTime, onChange: function(v) { updateBreak(s.id, brk.id, { endTime: v }); },
                          ariaLabel: "Break end time",
                          style: M ? NATIVE : brkInp }));
                      var bDel = h("button", { onClick: function() { removeBreak(s.id, brk.id); }, "aria-label": "Remove break",
                        style: M ? glyphBtn(B.textMut, "18px", 30) : { background: "transparent", border: "none", color: B.textMut, cursor: "pointer", fontSize: "10px", padding: 0 } }, "×");
                      return M
                        ? h("div", { key: brk.id, style: { display: "inline-flex", gap: 5, alignItems: "center", background: isPaid ? B.accent + "11" : B.surface, border: "1px solid " + (isPaid ? B.accent + "44" : B.border), borderRadius: "10px", padding: "3px 3px 3px 4px" } },
                            typeBtn, seg(bStart, bEnd, true), bDel)
                        : h("div", { key: brk.id, style: { display: "inline-flex", gap: 3, alignItems: "center", background: isPaid ? B.accent + "11" : B.surface, border: "1px solid " + (isPaid ? B.accent + "44" : B.border), borderRadius: "3px", padding: "2px 6px", fontSize: "9px" } },
                            typeBtn, bStart, h("span", { style: { color: B.textMut } }, "→"), bEnd, bDel);
                    }),
                    h("button", { onClick: function() { addBreak(s.id); },
                      style: M ? { background: "transparent", border: "1px dashed " + B.border, borderRadius: "8px", padding: "0 10px", height: 30, color: B.textMut, cursor: "pointer", fontSize: "11px", fontWeight: 600, fontFamily: "inherit" }
                               : { background: "transparent", border: "1px dashed " + B.border, borderRadius: "3px", padding: "2px 6px", color: B.textMut, cursor: "pointer", fontSize: "8px", fontWeight: 600 } }, "+ Break")
                  ),
                  // Item positions
                  itemPositions.length > 0 && h("div", { style: { display: "flex", flexDirection: "column", gap: M ? 6 : 3 } },
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

                      // ── Row controls, built once and laid out per width ──
                      var conflictDot = hasConflict && h("div", { title: "Double-booked: also on " + posConflicts.map(function(c) { return c.projectName; }).join(", "),
                        style: { width: 16, height: 16, borderRadius: "50%", background: B.danger + "22", border: "1px solid " + B.danger, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "help" } },
                        h("span", { style: { fontSize: "9px", color: B.danger, fontWeight: 700 } }, "!"));
                      // Searchable: the rate card grows, and scrolling a bare
                      // <select> for "the L2 role" got old fast.
                      var roleSel = h(window.LTPSearchSelect, {
                        value: pos.serviceId || "",
                        onChange: function(v) {
                          var sid = (v === "" || v == null) ? null : Number(v);
                          var sv = sid ? svcs.find(function(sv2) { return sv2.id === sid; }) : null;
                          updatePosition(s.id, pos.id, { serviceId: sid, role: sv ? sv.role : "" });
                        },
                        options: [{ value: "", label: "Role…" }].concat(window.LTP_sortServices(svcs).map(function(sv) {
                          return { value: sv.id, label: sv.role, sublabel: sv.description };
                        })),
                        searchPlaceholder: "Search roles…",
                        style: { flex: M ? "1 1 38%" : 1, minWidth: 0 },
                        triggerStyle: trig,
                        panelMinWidth: 250,
                      });
                      // Person slot — shown when a role has 2+ on the day. Give
                      // distinct people different numbers so each is tracked
                      // separately (own hours / OT / meal penalty); leave two
                      // shifts on the same number to mark them the same person.
                      var slotSel = (function() {
                        var roleCountInDay = pos.serviceId ? allPositions.filter(function(p) { return p.serviceId === pos.serviceId; }).length : 0;
                        if (roleCountInDay < 2) return null;
                        var effSlot = itemSlots[pos.id] || 1;
                        var opts = [];
                        for (var n = 1; n <= roleCountInDay; n++) opts.push(n);
                        return h("select", { value: effSlot,
                          title: "Person #" + effSlot + " for this role. Different number = different person (tracked separately); same number across shifts = same person.",
                          onChange: function(e) { updatePosition(s.id, pos.id, { slot: Number(e.target.value) }); },
                          style: M ? { flexShrink: 0, width: 62, height: CTL, background: B.bg, border: "1px solid " + B.border, borderRadius: "8px", padding: "0 6px", color: B.text, fontSize: "13px", fontFamily: "inherit", boxSizing: "border-box" }
                                   : { flexShrink: 0, width: 46, background: B.bg, border: "1px solid " + B.border, borderRadius: "3px", padding: "3px 2px", color: B.text, fontSize: "10px", fontFamily: "inherit" } },
                          opts.map(function(n) { return h("option", { key: n, value: n }, "#" + n); }));
                      })();
                      // Only crew tagged with this role are listed; everyone
                      // else sits behind a deliberate "Other crew" click, so a
                      // role nobody is tagged with never leaves the position
                      // unassignable. Crew is PICKED here, never authored —
                      // this field deliberately has no inline-create.
                      var crewSel = (function() {
                        // Filter on the LINKED SERVICE's role, not the
                        // denormalized pos.role: a stale or free-text code
                        // matches nobody and would push the whole roster
                        // behind "Other crew". No service = no role being
                        // filled = offer everyone.
                        var posSvc = pos.serviceId ? svcs.find(function(sv) { return sv.id === pos.serviceId; }) : null;
                        var co = window.LTP_crewSelectOptions({
                          crew: crew, role: posSvc ? posSvc.role : "", selectedId: pos.crewId,
                          allContacts: contacts, leading: [{ value: "", label: "Crew…" }],
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
                          searchPlaceholder: "Search crew…",
                          style: { flex: M ? "1 1 52%" : 1, minWidth: 0 },
                          triggerStyle: trig,
                          panelMinWidth: 260,
                        });
                      })();
                      // Status — read-only in schedule editor, manage via Labor module
                      var statusChip = h("span", { style: M
                          ? { flexShrink: 0, fontSize: "9px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: pc, background: pc + "18", border: "1px solid " + pc + "33", borderRadius: "6px", padding: "0 8px", height: 28, display: "inline-flex", alignItems: "center", lineHeight: 1 }
                          : { flexShrink: 0, width: 70, textAlign: "center", fontSize: "9px", fontWeight: 600, color: pc, background: pc + "18", border: "1px solid " + pc + "33", borderRadius: "3px", padding: "4px 6px" } }, pos.status);
                      // Full-margin toggle — bills the rate, zeroes the cost (e.g. owner working)
                      var mgnBtn = h("button", { onClick: function() { updatePosition(s.id, pos.id, { fullMargin: !pos.fullMargin }); },
                        title: pos.fullMargin ? "Full margin: company cost is $0 for this position (rate still billed). Click to cost it normally." : "Mark full margin — zero the company cost (rate still billed), e.g. the owner working.",
                        style: M ? pill(!!pos.fullMargin, B.success)
                                 : { flexShrink: 0, background: pos.fullMargin ? B.success + "22" : "transparent", border: "1px solid " + (pos.fullMargin ? B.success : B.border), borderRadius: "3px", padding: "2px 5px", color: pos.fullMargin ? B.success : B.textMut, fontSize: "8px", fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" } },
                        pos.fullMargin ? "✓ MGN" : "MGN");
                      // Individual meal break(s) for THIS person (added by the
                      // meal-penalty fix; removable). Distinct from the item's
                      // crew-wide breaks above.
                      var indivBreaks = (pos.breaks && pos.breaks.length > 0) && h("div", { style: { display: "flex", gap: M ? 4 : 2, alignItems: "center", flexWrap: "wrap" } },
                        pos.breaks.map(function(br) {
                          return h("span", { key: br.id, title: "Individual meal break " + window.LTP_formatTime(br.startTime) + " – " + window.LTP_formatTime(br.endTime) + " (this person only)",
                            style: { display: "inline-flex", alignItems: "center", gap: M ? 4 : 2, background: B.warn + "22", border: "1px solid " + B.warn + "55", borderRadius: M ? "6px" : "3px", padding: M ? "0 4px 0 7px" : "1px 4px", height: M ? 28 : undefined, fontSize: M ? "10px" : "8px", color: B.warn, fontWeight: 600, whiteSpace: "nowrap" } },
                            "⏸ " + window.LTP_formatTime(br.startTime),
                            h("button", { onClick: function() { updatePosition(s.id, pos.id, { breaks: (pos.breaks || []).filter(function(x) { return x.id !== br.id; }) }); }, "aria-label": "Remove meal break",
                              style: M ? { background: "transparent", border: "none", color: B.warn, cursor: "pointer", fontSize: "14px", padding: "0 4px", lineHeight: 1, height: 26, fontFamily: "inherit" }
                                       : { background: "transparent", border: "none", color: B.warn, cursor: "pointer", fontSize: "9px", padding: 0, lineHeight: 1 } }, "×"));
                        }));
                      var rateTitle = posUnit && posUnit.minHoursApplied
                        ? ("Billed as " + posUnit.billedHours + "h — this client's " + posUnit.minHours + "-hour minimum for " + (posUnit.svc.role || "this role") + " (worked " + posUnit.paidHours + "h).")
                        : undefined;
                      var costTitle = posUnit && posUnit.minApplied ? "Raised to this crew member's negotiated minimum (payout only — the client rate above is unchanged)." : undefined;
                      var rateBox = !posUnit ? null : (M
                        // Phone: rate and cost side by side on the footer line.
                        ? h("div", { style: { flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" } },
                            isUnitPrimary
                              ? [
                                  (posUnit.svc && posUnit.svc.clientRate) ? h(window.ClientRateChip, { key: "cr", svc: posUnit.svc, tiny: true }) : null,
                                  h("span", { key: "r", style: { fontSize: "13px", fontWeight: 700, color: B.accent }, title: rateTitle }, "$" + Math.round(posUnit.rateTotal)),
                                  posUnit.fullMargin
                                    ? h("span", { key: "c", style: { fontSize: "10px", fontWeight: 700, color: B.success } }, "margin")
                                    : h("span", { key: "c", style: { fontSize: "11px", color: posUnit.minApplied ? B.warn : B.textMut }, title: costTitle },
                                        "/ $" + Math.round(posUnit.costTotal) + (posUnit.minApplied ? " min" : ""))
                                ]
                              : h("span", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic" }, title: "Same person as an earlier shift this day — billed once (see above)." }, "↳ same person"))
                        : h("div", { style: { flexShrink: 0, width: 92, textAlign: "right", fontSize: "9px" } },
                            isUnitPrimary
                              ? [
                                  // A rate that came from this client's contract is
                                  // marked, so a figure that doesn't match the base
                                  // rate card is never a mystery.
                                  (posUnit.svc && posUnit.svc.clientRate) ? h("div", { key: "cr", style: { marginBottom: 1 } },
                                    h(window.ClientRateChip, { svc: posUnit.svc, tiny: true })) : null,
                                  h("div", { key: "r", style: { color: B.accent, fontWeight: 600 }, title: rateTitle }, "$" + Math.round(posUnit.rateTotal)),
                                  posUnit.fullMargin
                                    ? h("div", { key: "c", style: { color: B.success, fontWeight: 600 } }, "margin")
                                    : h("div", { key: "c", style: { color: posUnit.minApplied ? B.warn : B.textMut }, title: costTitle },
                                        "$" + Math.round(posUnit.costTotal) + (posUnit.minApplied ? " min" : ""))
                                ]
                              : h("div", { style: { color: B.textMut, fontStyle: "italic" }, title: "Same person as an earlier shift this day — billed once (see above)." }, "↳ same person")));
                      // Desktop's placeholder keeps the footer aligned when a row has no rate yet.
                      if (!rateBox && !M) rateBox = h("div", { style: { flexShrink: 0, width: 92, textAlign: "right", fontSize: "9px" } });
                      var delBtn = h("button", { onClick: function() { removePosition(s.id, pos.id); }, "aria-label": "Remove position",
                        style: M ? glyphBtn(B.danger, "22px") : { flexShrink: 0, background: "transparent", border: "none", color: B.textMut, cursor: "pointer", fontSize: "12px", padding: 0 } }, "×");
                      var copyBtn = i < schedule.length - 1 && h("button", { onClick: function() { copyPositionToNext(i, pos); },
                        title: "Copy role to next item", "aria-label": "Copy role to next item",
                        // Hover reveal doesn't fire on touch, so keep it visible on mobile.
                        style: M ? glyphBtn(B.accent, "18px") : { flexShrink: 0, background: "transparent", border: "none", color: B.border, cursor: "pointer", fontSize: "10px", padding: "1px 3px" },
                        onMouseOver: function(e) { e.currentTarget.style.color = B.accent; },
                        onMouseOut:  function(e) { e.currentTarget.style.color = M ? B.accent : B.border; } }, "⇩");

                      var rowBg = hasConflict ? B.danger + "08" : B.surface, rowBd = "1px solid " + (hasConflict ? B.danger + "66" : B.border);
                      return M
                        // Phone: [!] role · #slot · crew on one line; status ·
                        // MGN · breaks … rate / cost · ⇩ · × on a slim line under.
                        ? h("div", { key: pos.id, style: { background: rowBg, border: rowBd, borderRadius: "10px", padding: "8px" } },
                            h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } }, conflictDot, roleSel, slotSel, crewSel),
                            h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 6, minWidth: 0 } },
                              statusChip, mgnBtn, indivBreaks,
                              // Rate + the two glyphs stay right-aligned even on a
                              // row that has no rate yet (no role picked).
                              h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" } }, rateBox, copyBtn, delBtn)))
                        : h("div", { key: pos.id, style: { background: rowBg, border: rowBd, borderRadius: "3px", padding: "4px 8px", display: "flex", gap: 6, alignItems: "center", flexWrap: "nowrap" } },
                            conflictDot, roleSel, slotSel, crewSel, statusChip, mgnBtn, indivBreaks, rateBox, delBtn, copyBtn);
                    })
                  ),
                  // Add position button
                  h("button", { onClick: function() { addPosition(s.id); },
                    style: M ? Object.assign({}, dashedBtn, { marginTop: 6 })
                             : { background: "transparent", border: "1px dashed " + B.accent + "44", color: B.accent, cursor: "pointer", fontSize: "9px", fontWeight: 600, padding: "3px 8px", borderRadius: "3px", marginTop: 4, width: "100%" } }, "+ Position")
                );
              }),

              // Add item to this day
              h("button", { onClick: function() {
                  var lastItem = dayItems[dayItems.length - 1].item;
                  addItemToDay(group.date !== "_unscheduled" ? group.date : "", lastItem.endTime || "08:00");
                },
                style: M ? Object.assign({}, dashedBtn, { marginBottom: 4 })
                         : { background: "transparent", border: "1px dashed " + B.accent + "44", color: B.accent, cursor: "pointer", fontSize: "9px", fontWeight: 600, padding: "6px", borderRadius: "4px", width: "100%", marginBottom: 4 } }, "+ Add Item to This Day"),

              // Day totals + per-PERSON breakdown. Each unit is one person
              // (role + slot); their meal penalty / OT depend on the shifts they
              // work, so two people in the same role can differ. The badge up top
              // shows the day total; this lists where it comes from, person by
              // person. Slot numbers (#1, #2) appear when a role has 2+ people.
              allPositions.length > 0 && h("div", { style: { padding: M ? "8px 6px 2px" : "6px 10px 2px", borderTop: "1px dashed " + B.border, fontSize: M ? "11px" : "10px", display: "flex", flexDirection: "column", gap: M ? 3 : 2 } },
                (function() {
                  var roleUnitCount = {};
                  dayLabor.units.forEach(function(u) { roleUnitCount[u.serviceId] = (roleUnitCount[u.serviceId] || 0) + 1; });
                  return dayLabor.units.map(function(u) {
                    var regOT = Math.round((u.otHours - u.mealPenaltyHours) * 100) / 100;
                    var extras = [];
                    if (u.mealPenaltyHours > 0) extras.push(u.mealPenaltyHours + "h meal penalty");
                    if (regOT > 0) extras.push(regOT + "h OT");
                    var label = u.svc.role + (roleUnitCount[u.serviceId] > 1 ? " #" + u.slot : "") + " — " + (u.tier === "half" ? "Half" : "Full") + " " + u.paidHours + "h";
                    return h("div", { key: u.serviceId + "#" + u.slot, style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } },
                      h("span", { style: { color: B.textMut } }, label),
                      extras.length > 0 && h("span", { style: { color: B.danger, fontWeight: 600 } }, "+ " + extras.join(" + ")),
                      // Minimum charge: the day is short but bills (and/or pays)
                      // up to the client's contracted floor.
                      u.minHoursApplied && h("span", { style: { color: B.info, fontWeight: 600 },
                        title: "Billed as " + u.billedHours + "h under this client's " + u.minHours + "-hour minimum for " + u.svc.role + "." },
                        "· billed " + u.billedHours + "h (" + u.minHours + "h min)"),
                      u.minCostHoursApplied && h("span", { style: { color: B.info, fontWeight: 600 },
                        title: "Paid as " + u.costHours + "h under this client's " + u.minCostHours + "-hour payout minimum for " + u.svc.role + "." },
                        "· paid " + u.costHours + "h (" + u.minCostHours + "h min)"),
                      u.svc.clientRate && h(window.ClientRateChip, { svc: u.svc, tiny: true }),
                      u.fullMargin && h("span", { style: { color: B.success, fontWeight: 600 } }, "· full margin"));
                  });
                })(),
                h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 14, marginTop: 2, paddingTop: M ? 5 : 3, borderTop: "1px solid " + B.border, fontSize: M ? "12px" : undefined } },
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
            }).filter(Boolean).sort(window.LTP_compareServices);
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
