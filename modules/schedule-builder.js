// ═══════════════════════════════════════════════════════════════════════════
//   SCHEDULE BUILDER — full-screen project schedule editor
// ═══════════════════════════════════════════════════════════════════════════
(function() {
  "use strict";
  var h = React.createElement, B = window.LTP_THEME;
  var useState = React.useState, useRef = React.useRef, useMemo = React.useMemo, useEffect = React.useEffect;
  var nav = window.LTPRouter.navigate;
  var fmt = window.LTP_formatDate, ft = window.LTP_formatTime;
  var genId = window.LTP_genId, todayISO = window.LTP_todayISO;
  var calcRate = window.LTP_calcLaborRate, calcHours = window.LTP_calcHours, calcTier = window.LTP_calcLaborTier;

  // Escape a string for safe interpolation into markup written via
  // document.write (the print window below). project/company/crew names and
  // schedule titles are user-controlled; document.write executes script, so
  // every dynamic value MUST be escaped. SECURITY_REVIEW.md H1.
  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  window.ScheduleBuilder = function({ project, projects, setProjects, contacts, setContacts, services, companies, quotes, setQuotes, getNextQuoteId }) {
    var company = companies.find(function(c) { return c.id === project.companyId; });

    // Deep clone schedule with positions
    var initial = useMemo(function() {
      return {
        schedule: (project.schedule || []).map(function(s) {
          return Object.assign({}, s, {
            positions: (s.positions || []).map(function(p) { return Object.assign({}, p); }),
            breaks: (s.breaks || []).map(function(b) { return Object.assign({}, b); })
          });
        }),
        scheduleNotes: project.scheduleNotes || "",
        scheduleActivity: (project.scheduleActivity || []).map(function(a) { return Object.assign({}, a); }),
      };
    }, [project.id]);

    var [draft, setDraftRaw] = useState(initial);
    // Owned-state guard — see theme.js. Synchronous global mirror prevents
    // a save+nav from flashing a bogus "unsaved changes" prompt.
    var unsavedPair = window.LTP_useUnsavedGuard();
    var isDirty = unsavedPair[0];
    var setIsDirty = unsavedPair[1];
    var cleanRef = useRef(initial);
    function setDraft(updater) {
      setDraftRaw(typeof updater === "function" ? function(d) { var next = updater(d); return next; } : updater);
      setIsDirty(true);
    }

    var [dlg, setDlg] = useState(null);
    var [justSaved, setJustSaved] = useState(false);
    var [viewActivity, setViewActivity] = useState(null);
    var [quoteGroupDlg, setQuoteGroupDlg] = useState(false);  // "Send to Quote" grouping picker

    useEffect(function() { setDraftRaw(initial); cleanRef.current = initial; setIsDirty(false); }, [project.id]);

    // Informational / validation notice as a non-blocking toast (modals are
    // reserved for confirm/cancel decisions). Variant defaults to "error".
    function showAlert(title, msg, variant) { window.LTP_toast(title, { message: msg, variant: variant || "error" }); }

    // ── Compute summary stats ────────────────────────────────────────────────
    var stats = useMemo(function() {
      var totalPos = 0, filledPos = 0, totalRate = 0, totalCost = 0;
      // Positions are counted per-position, but rate/cost are billed per ROLE
      // per day via LTP_calcDayLabor — the same model the quote uses — so the
      // summary previews the actual quote total instead of charging each
      // position a full day (which double-counts a role spread over items).
      var dateMap = {};
      draft.schedule.forEach(function(s) {
        var d = s.date || "_unscheduled";
        if (!dateMap[d]) dateMap[d] = { items: [] };
        dateMap[d].items.push(s);
        (s.positions || []).forEach(function(p) {
          totalPos++;
          if (p.status === "confirmed") filledPos++;
        });
      });
      var crewMins = window.LTP_crewMinMap(contacts);
      Object.keys(dateMap).forEach(function(d) {
        var dayLabor = window.LTP_calcDayLabor(dateMap[d].items, services, crewMins);
        totalRate += dayLabor.rateTotal;
        totalCost += dayLabor.costTotal;
      });
      var days = Object.keys(dateMap).length;
      return { days: days, totalPos: totalPos, filledPos: filledPos, totalRate: Math.round(totalRate), totalCost: Math.round(totalCost), margin: Math.round(totalRate - totalCost) };
    }, [draft.schedule, contacts]);

    // ── Compute changes for activity ─────────────────────────────────────────
    function computeSchedChanges(before, after) {
      if (!before || !after) return null;
      var changes = [];
      var bs = before.schedule || [], as = after.schedule || [];
      if (bs.length !== as.length) changes.push({ cat: "Schedule Days", detail: bs.length + " \u2192 " + as.length });
      var bMap = {}; bs.forEach(function(s) { bMap[s.id] = s; });
      as.forEach(function(s) {
        var dayLabel = (s.title || "Untitled") + (s.date ? " (" + fmt(s.date) + ")" : "");
        if (!bMap[s.id]) { changes.push({ cat: "Day Added", detail: dayLabel }); return; }
        var b = bMap[s.id];
        if (b.title !== s.title) changes.push({ cat: dayLabel + " Renamed", detail: "\"" + (b.title || "?") + "\" \u2192 \"" + (s.title || "?") + "\"" });
        if (b.date !== s.date) changes.push({ cat: dayLabel + " Date", detail: (fmt(b.date) || "Not set") + " \u2192 " + (fmt(s.date) || "Not set") });
        if (b.time !== s.time || b.endTime !== s.endTime) changes.push({ cat: dayLabel + " Times", detail: (ft(b.time) || "?") + "-" + (ft(b.endTime) || "?") + " \u2192 " + (ft(s.time) || "?") + "-" + (ft(s.endTime) || "?") });
        // Break changes
        var bBreaks = (b.breaks || []).length, aBreaks = (s.breaks || []).length;
        if (bBreaks !== aBreaks) changes.push({ cat: dayLabel + " Breaks", detail: bBreaks + " \u2192 " + aBreaks + " meal break" + (aBreaks !== 1 ? "s" : "") });
        // Position changes
        var bpMap = {}; (b.positions || []).forEach(function(p) { bpMap[p.id] = p; });
        (s.positions || []).forEach(function(p) {
          if (!bpMap[p.id]) { changes.push({ cat: dayLabel + " \u2014 Position Added", detail: p.role || "?" }); return; }
          var bp = bpMap[p.id];
          if (bp.role !== p.role || bp.serviceId !== p.serviceId) {
            changes.push({ cat: dayLabel + " \u2014 Role Changed", detail: (bp.role || "None") + " \u2192 " + (p.role || "None") });
          }
          if (bp.crewId !== p.crewId) {
            var bcn = bp.crewId ? contacts.find(function(c) { return c.id === bp.crewId; }) : null;
            var acn = p.crewId ? contacts.find(function(c) { return c.id === p.crewId; }) : null;
            changes.push({ cat: dayLabel + " \u2014 " + (p.role || "?"), detail: (bcn ? bcn.firstName + " " + bcn.lastName : "Unassigned") + " \u2192 " + (acn ? acn.firstName + " " + acn.lastName : "Unassigned") });
          }
          if (bp.status !== p.status) changes.push({ cat: dayLabel + " \u2014 " + (p.role || "?") + " Status", detail: bp.status + " \u2192 " + p.status });
        });
        (b.positions || []).forEach(function(p) {
          if (!(s.positions || []).find(function(sp) { return sp.id === p.id; })) changes.push({ cat: dayLabel + " \u2014 Position Removed", detail: p.role || "?" });
        });
      });
      bs.forEach(function(s) { if (!as.find(function(a) { return a.id === s.id; })) changes.push({ cat: "Day Removed", detail: (s.title || "?") + (s.date ? " (" + fmt(s.date) + ")" : "") }); });
      if ((before.scheduleNotes || "") !== (after.scheduleNotes || "")) changes.push({ cat: "Notes", detail: "Updated" });
      return changes.length > 0 ? changes : null;
    }

    // ── Actions ──────────────────────────────────────────────────────────────
    // On save, park a removal notice (per person, per type) for any crew this
    // save pulls off shifts — into the notify tray, where the producer sends or
    // declines. Snapshot the shifts here (the positions are about to be deleted)
    // so the email still renders. Then persist.
    function save() {
      if (project.id) {
        var removed = window.LTP_diffRemovedCrew(cleanRef.current.schedule, draft.schedule, contacts, services);
        removed.forEach(function(g) {
          window.LTP_outbox.add({ crewId: g.crewId, crewName: g.crewName, projectId: project.id, projectName: project.name || "", template: g.template, shifts: g.shifts });
        });
        if (removed.length) {
          var people = {}; removed.forEach(function(g) { people[g.crewId] = true; });
          var n = Object.keys(people).length;
          window.LTP_toast("Added to notify tray", { message: n + " crew member" + (n !== 1 ? "s" : "") + " queued — review and send from the tray (bottom-left).", variant: "info" });
        }
      }
      doSave();
    }

    function doSave() {
      var changes = computeSchedChanges(cleanRef.current, draft);
      var changeCount = changes ? changes.length : 0;
      var saveMsg = "Schedule saved" + (changeCount > 0 ? " (" + changeCount + " change" + (changeCount > 1 ? "s" : "") + ")" : "");
      var saveEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0,5), type: "saved", message: saveMsg, user: (window.LTP_CURRENT_USER || "User"), changes: changes };
      var newActivity = (draft.scheduleActivity || []).concat([saveEntry]);
      // Keep any row with real content (title/date/crew/breaks), not just
      // titled rows — unlabeled-but-real days were being dropped on save.
      var cleanSchedule = draft.schedule.filter(window.LTP_scheduleRowHasContent);

      setProjects(function(prev) {
        return prev.map(function(p) {
          return p.id === project.id ? Object.assign({}, p, { schedule: cleanSchedule, scheduleNotes: draft.scheduleNotes, scheduleActivity: newActivity }) : p;
        });
      });

      var saved = { schedule: cleanSchedule, scheduleNotes: draft.scheduleNotes, scheduleActivity: newActivity };
      setDraftRaw(saved);
      cleanRef.current = saved;
      setIsDirty(false);
      setJustSaved(true);
      setTimeout(function() { setJustSaved(false); }, 2200);
    }

    function discard() {
      setDlg({ title: "Discard Changes", message: "Reset all unsaved schedule changes?", variant: "danger", confirmLabel: "Discard",
        onConfirm: function() { setDraftRaw(cleanRef.current); setIsDirty(false); setDlg(null); } });
    }

    function handleScheduleChange(newSchedule) {
      setDraft(function(d) { return Object.assign({}, d, { schedule: newSchedule }); });
    }

    function printSchedule() {
      var sorted = draft.schedule.slice().sort(function(a, b) { return (a.date + a.time) > (b.date + b.time) ? 1 : -1; });
      var rows = sorted.map(function(s) {
        var dur = window.LTP_calcDuration(s.date, s.time, s.endDate || s.date, s.endTime);
        var posText = (s.positions || []).map(function(p) {
          var cm = p.crewId ? contacts.find(function(c) { return c.id === p.crewId; }) : null;
          return escAttr(p.role || "?") + (cm ? ": " + escAttr(cm.firstName + " " + cm.lastName) : " (open)");
        }).join(", ") || "\u2014";
        return "<tr><td>" + escAttr(s.title) + "</td><td>" + fmt(s.date) + "</td><td>" + ft(s.time) + " \u2192 " + ft(s.endTime) + "</td><td>" + (dur || "\u2014") + "</td><td>" + posText + "</td></tr>";
      }).join("");
      var w = window.open("", "_blank");
      w.document.write("<html><head><title>" + escAttr(project.name) + " Schedule</title><style>body{font-family:sans-serif;padding:20px;max-width:1000px;margin:auto;color:#333}h1{margin:0 0 4px;font-size:22px}h2{margin:0 0 12px;font-size:14px;color:#666}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd;font-size:12px}th{border-bottom:2px solid #333;font-size:13px}.footer{margin-top:30px;padding-top:10px;border-top:1px solid #ddd;font-size:10px;color:#999;display:flex;justify-content:space-between}</style></head><body><h1>" + escAttr(project.name) + " \u2014 Schedule</h1><h2>" + escAttr(company ? company.name : "") + " \u00b7 " + fmt(project.startDate) + " \u2192 " + fmt(project.endDate) + "</h2><table><thead><tr><th>Day</th><th>Date</th><th>Times</th><th>Duration</th><th>Crew</th></tr></thead><tbody>" + rows + "</tbody></table><div class='footer'><span>" + escAttr(window.LTP_COMPANY_NAME || "") + "</span><span>Printed: " + fmt(todayISO()) + "</span></div></body></html>");
      w.document.close(); w.print();
    }

    // ── Send to Quote ────────────────────────────────────────────────────────
    // Validate, then ask how to organize the line items (one section vs. split
    // by department) before building the quote.
    function openSendToQuote() {
      if (draft.schedule.length === 0) { showAlert("No Schedule", "Add schedule days before creating a quote."); return; }
      if (isDirty) { showAlert("Unsaved Changes", "Save the schedule before sending to a quote."); return; }
      var hasPositions = draft.schedule.some(function(s) { return (s.positions || []).some(function(p) { return p.serviceId; }); });
      if (!hasPositions) { showAlert("No Positions", "Add positions to schedule days before creating a quote."); return; }
      setQuoteGroupDlg(true);
    }

    function sendToQuote(grouping) {
      setQuoteGroupDlg(false);
      if (draft.schedule.length === 0) { showAlert("No Schedule", "Add schedule days before creating a quote."); return; }
      if (isDirty) { showAlert("Unsaved Changes", "Save the schedule before sending to a quote."); return; }

      // Group by date for day-level rate calculation
      var dateGroups = {};
      draft.schedule.forEach(function(s) {
        var d = s.date || "_unscheduled";
        if (!dateGroups[d]) dateGroups[d] = { dayCall: null, dayWrap: null, items: [], date: d };
        var g = dateGroups[d];
        if (s.time && (!g.dayCall || s.time < g.dayCall)) g.dayCall = s.time;
        if (s.endTime && (!g.dayWrap || s.endTime > g.dayWrap)) g.dayWrap = s.endTime;
        g.items.push(s);
      });

      // Bill each day per ROLE (not per position): a role on several items is
      // one day rate sized by its MAX count on any single item, rated over the
      // role's actual worked span. LTP_calcDayLabor owns that model; here we
      // just aggregate its per-role output across days into quote line items —
      // day rates keyed by role+tier, OT pooled by role.
      var dayRateItems = {};
      var otItems = {};
      // Per-crew negotiated minimums flow into unit cost (u.dayCost / u.otCost),
      // so the quote's margin reflects the higher payout — while unitPrice/OT rate
      // billed to the client stays the role rate.
      var crewMins = window.LTP_crewMinMap(contacts);

      Object.keys(dateGroups).forEach(function(dateKey) {
        var g = dateGroups[dateKey];
        if (!g.dayCall || !g.dayWrap) return;
        var fmtDate = g.date !== "_unscheduled" ? fmt(g.date) : "TBD";

        window.LTP_calcDayLabor(g.items, services, crewMins).units.forEach(function(u) {
          // Each unit is one person. The day-rate line aggregates units of the
          // same role+tier (qty = how many people); costAccum adds $0 for a
          // full-margin unit so its rate is pure margin. Per-unit cost is
          // blended at build time so a single line stays correct.
          var drKey = u.serviceId + "|" + u.tier;
          if (!dayRateItems[drKey]) {
            dayRateItems[drKey] = { svc: u.svc, tier: u.tier, rate: u.dayRate, qty: 0, costAccum: 0, dates: [], dept: u.svc.department || "Other" };
          }
          dayRateItems[drKey].qty += 1;
          dayRateItems[drKey].costAccum = Math.round((dayRateItems[drKey].costAccum + (u.fullMargin ? 0 : u.dayCost)) * 100) / 100;
          if (dayRateItems[drKey].dates.indexOf(fmtDate) === -1) dayRateItems[drKey].dates.push(fmtDate);

          // OT line item — this person's own OT hours (cost $0 if full margin)
          if (u.otHours > 0) {
            var otKey = u.serviceId;
            if (!otItems[otKey]) {
              otItems[otKey] = { svc: u.svc, otRate: u.otRate, rateHours: 0, costAccum: 0, dates: [], dept: u.svc.department || "Other" };
            }
            otItems[otKey].rateHours = Math.round((otItems[otKey].rateHours + u.otHours) * 100) / 100;
            otItems[otKey].costAccum = Math.round((otItems[otKey].costAccum + (u.fullMargin ? 0 : u.otCost * u.otHours)) * 100) / 100;
            if (otItems[otKey].dates.indexOf(fmtDate) === -1) otItems[otKey].dates.push(fmtDate);
          }
        });
      });

      // Build the labor line items once (identical for both groupings); each
      // carries its department so we can either split by department or pool
      // everything into a single section.
      var laborItems = [];  // [{ dept, item }]

      // Day rate line items. Per-unit cost is the blended cost across the qty
      // (full-margin positions contribute $0), so one line carries the right
      // margin without splitting paid vs owner crew.
      Object.keys(dayRateItems).forEach(function(key) {
        var li = dayRateItems[key];
        var dayList = li.dates.length <= 4 ? li.dates.join(", ") : li.dates.slice(0, 3).join(", ") + " + " + (li.dates.length - 3) + " more";
        laborItems.push({ dept: li.dept, item: {
          id: genId("item"), type: "service", serviceId: li.svc.id,
          name: li.svc.role + " \u2014 " + li.svc.description,
          rateType: li.tier === "half" ? "half" : "day",
          qty: li.qty, unitPrice: li.rate, adjustedPrice: null,
          cost: li.qty > 0 ? Math.round((li.costAccum / li.qty) * 100) / 100 : 0,
          notes: dayList, deliveredQty: 0, invoicedQty: 0
        } });
      });

      // OT line items (blended per-hour cost; margin OT hours cost $0)
      Object.keys(otItems).forEach(function(key) {
        var li = otItems[key];
        if (li.rateHours <= 0) return;
        var dayList = li.dates.length <= 4 ? li.dates.join(", ") : li.dates.slice(0, 3).join(", ") + " + " + (li.dates.length - 3) + " more";
        laborItems.push({ dept: li.dept, item: {
          id: genId("item"), type: "service", serviceId: li.svc.id,
          name: li.svc.role + " \u2014 " + li.svc.description,
          rateType: "ot",
          qty: li.rateHours, unitPrice: li.otRate, adjustedPrice: null,
          cost: li.rateHours > 0 ? Math.round((li.costAccum / li.rateHours) * 100) / 100 : 0,
          notes: "Overtime hours: " + dayList, deliveredQty: 0, invoicedQty: 0
        } });
      });

      if (laborItems.length === 0) { showAlert("No Positions", "Add positions to schedule days before creating a quote."); return; }

      // grouping === "one" \u2192 a single "Labor" section; otherwise split by
      // department (one section each), the legacy behavior.
      var quoteSections;
      if (grouping === "one") {
        quoteSections = [{ id: genId("sec"), label: "Labor", customDates: false, startDate: "", endDate: "", items: laborItems.map(function(x) { return x.item; }) }];
      } else {
        var sectionMap = {};
        laborItems.forEach(function(x) { (sectionMap[x.dept] = sectionMap[x.dept] || []).push(x.item); });
        quoteSections = Object.keys(sectionMap).map(function(dept) {
          return { id: genId("sec"), label: dept, customDates: false, startDate: "", endDate: "", items: sectionMap[dept] };
        });
      }

      // Create the quote
      var quoteId = getNextQuoteId();
      var today = todayISO();
      var newQuote = {
        id: quoteId,
        clientType: "company", companyId: project.companyId, clientContactId: null,
        projectId: project.id, customName: "",
        customStartDate: "", customEndDate: "",
        rentalStartDate: null, rentalEndDate: null,
        status: "draft", createdDate: today, sentDate: null,
        globalDiscount: { type: "none", value: 0 },
        sections: quoteSections,
        notes: "Generated from " + project.name + " schedule.",
        activity: [{
          id: genId("act"), date: today, time: new Date().toTimeString().substring(0, 5),
          type: "created", user: (window.LTP_CURRENT_USER || "User"), message: "Quote created from project schedule",

          changes: quoteSections.map(function(sec) {
            return { cat: sec.label, detail: sec.items.map(function(i) { return i.name + " \u00d7" + i.qty; }).join(", ") };
          })
        }]
      };

      setQuotes(function(prev) { return prev.concat([newQuote]); });
      nav("quotes/" + quoteId);
    }

    // ── Render ───────────────────────────────────────────────────────────────
    return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" } },
      // Sticky header
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", background: B.surface, borderBottom: "1px solid " + B.accent, padding: "12px 16px", flexShrink: 0, zIndex: 5 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 14 } },
          h("button", { onClick: function() { nav("projects/" + project.id); },
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textSec, fontSize: "11px", fontFamily: "inherit", cursor: "pointer" } }, "\u2190 Back to Project"),
          h("div", null,
            h("div", { style: { fontSize: "20px", fontWeight: 700, color: B.accent, lineHeight: 1.1 } }, project.name + " \u2014 Schedule"),
            h("div", { style: { fontSize: "11px", color: B.textMut, marginTop: 2 } },
              (company ? company.name + " \u00b7 " : "") + fmt(project.startDate) + " \u2192 " + fmt(project.endDate)))),
        h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
          justSaved && h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.success, background: B.successBg, border: "1px solid " + B.successBd, padding: "5px 10px", borderRadius: "6px" } }, "\u2713 Saved"),
          h("button", { onClick: openSendToQuote,
            style: { background: B.accent, border: "none", borderRadius: "6px", padding: "6px 12px", color: B.btnInk, fontSize: "11px", fontWeight: 700, fontFamily: "inherit", cursor: "pointer" } }, "\u2192 Send to Quote"),
          h("button", { onClick: printSchedule,
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textSec, fontSize: "11px", fontFamily: "inherit", cursor: "pointer" } }, "Print"),
          isDirty && h(window.Btn, { small: true, variant: "ghost", onClick: discard }, "Discard"),
          isDirty && h(window.Btn, { small: true, onClick: save }, "Save Schedule"))
      ),

      // Body: main + side panel
      h("div", { style: { flex: 1, display: "flex", gap: 14, overflow: "hidden", paddingTop: 10 } },
        // Main content (scrollable)
        h("div", { style: { flex: 1, overflowY: "auto", minWidth: 0 } },
          h(window.ScheduleEditor, { schedule: draft.schedule, onChange: handleScheduleChange, contacts: contacts, services: services,
            crewConflicts: window.LTP_detectCrewConflicts(projects),
            checkCrewConflict: function(crewId, date) {
              var otherBookings = [];
              (projects || []).forEach(function(pr) {
                if (pr.id === project.id) return;
                (pr.schedule || []).forEach(function(sc) {
                  if (sc.date !== date) return;
                  (sc.positions || []).forEach(function(ps) {
                    if (ps.crewId === crewId && ps.status !== "open" && ps.status !== "declined") {
                      otherBookings.push(pr.name + " (" + sc.title + ")");
                    }
                  });
                });
              });
              return otherBookings;
            } })
        ),

        // Side panel
        h("div", { style: { width: 280, flexShrink: 0, display: "flex", flexDirection: "column", gap: 4, overflowY: "auto" } },
          // SUMMARY
          h("div", { style: { background: B.surface, borderTop: "1px solid " + B.border, padding: 14 } },
            h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.12em", margin: "0 0 10px" } }, "Schedule Summary"),
            h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid " + B.border } },
              h("span", { style: { fontSize: "11px", color: B.textSec } }, "Schedule Days"),
              h("span", { style: { fontSize: "12px", fontWeight: 700, color: B.text } }, stats.days)),
            h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid " + B.border } },
              h("span", { style: { fontSize: "11px", color: B.textSec } }, "Positions"),
              h("span", { style: { fontSize: "12px", fontWeight: 600, color: stats.filledPos === stats.totalPos && stats.totalPos > 0 ? B.success : B.text } }, stats.filledPos + " / " + stats.totalPos + " filled")),
            h("div", { style: { display: "flex", justifyContent: "space-between", padding: "6px 0 4px", borderTop: "2px solid " + B.accent, marginTop: 4 } },
              h("span", { style: { fontSize: "12px", fontWeight: 700, color: B.text } }, "Total Rate"),
              h("span", { style: { fontSize: "13px", fontWeight: 700, color: B.accent } }, "$" + stats.totalRate.toLocaleString())),
            h("div", { style: { display: "flex", justifyContent: "space-between", padding: "3px 0" } },
              h("span", { style: { fontSize: "11px", color: B.textMut } }, "Total Cost"),
              h("span", { style: { fontSize: "11px", color: B.textMut } }, "$" + stats.totalCost.toLocaleString())),
            h("div", { style: { display: "flex", justifyContent: "space-between", padding: "3px 0", borderTop: "1px dashed " + B.border, marginTop: 2 } },
              h("span", { style: { fontSize: "11px", color: B.textMut } }, "Margin"),
              h("span", { style: { fontSize: "11px", fontWeight: 700, color: stats.margin >= 0 ? B.success : B.danger } }, "$" + stats.margin.toLocaleString()))
          ),

          // CONFLICTS
          function() {
            var conflicts = window.LTP_detectCrewConflicts(projects);
            var projectConflicts = [];
            Object.keys(conflicts).forEach(function(posId) {
              // Check if this conflict involves our project
              draft.schedule.forEach(function(s) {
                (s.positions || []).forEach(function(p) {
                  if (p.id === posId && conflicts[posId]) {
                    var cm = contacts.find(function(c) { return c.id === p.crewId; });
                    conflicts[posId].forEach(function(other) {
                      if (other.projectId !== project.id) {
                        projectConflicts.push({ crewName: cm ? cm.firstName + " " + cm.lastName : "?", otherProject: other.projectName, date: other.date, schedTitle: s.title });
                      }
                    });
                  }
                });
              });
            });
            // Deduplicate
            var seen = {};
            projectConflicts = projectConflicts.filter(function(c) { var k = c.crewName + "|" + c.date + "|" + c.otherProject; if (seen[k]) return false; seen[k] = true; return true; });
            if (projectConflicts.length === 0) return null;
            return h("div", { style: { background: B.danger + "11", borderTop: "1px solid " + B.danger + "44", padding: 14 } },
              h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.danger, textTransform: "uppercase", letterSpacing: "0.12em", margin: "0 0 8px" } }, "Scheduling Conflicts"),
              h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                projectConflicts.map(function(c, i) {
                  return h("div", { key: i, style: { fontSize: "10px", color: B.text, padding: "4px 6px", background: B.bg, borderRadius: "3px", border: "1px solid " + B.danger + "33" } },
                    h("span", { style: { fontWeight: 600 } }, c.crewName),
                    " is also booked on ",
                    h("span", { style: { fontWeight: 600, color: B.accent } }, c.otherProject),
                    " on " + fmt(c.date));
                }))
            );
          }(),

          // NOTES
          h("div", { style: { background: B.surface, borderTop: "1px solid " + B.border, padding: 14 } },
            h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.12em", margin: "0 0 8px" } }, "Internal Notes"),
            h("textarea", { value: draft.scheduleNotes || "",
              onChange: function(e) { setDraft(function(d) { return Object.assign({}, d, { scheduleNotes: e.target.value }); }); },
              placeholder: "Schedule notes, crew preferences, special requirements\u2026",
              style: { width: "100%", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", resize: "vertical", minHeight: 60 } })
          ),

          // ACTIVITY
          h("div", { style: { background: B.surface, borderTop: "1px solid " + B.border, padding: 14, flex: 1, display: "flex", flexDirection: "column", minHeight: 120 } },
            h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.12em", margin: "0 0 8px" } }, "Activity"),
            h("div", { style: { flex: 1, overflowY: "auto" } },
              (draft.scheduleActivity || []).slice().reverse().map(function(a) {
                var typeColors = { created: B.info, saved: B.success };
                var tc = typeColors[a.type] || B.textMut;
                var hasChanges = a.changes && a.changes.length > 0;
                return h("div", { key: a.id,
                  onClick: hasChanges ? function() { setViewActivity(a); } : undefined,
                  style: { padding: "5px 0", borderBottom: "1px solid " + B.border, display: "flex", gap: 6, cursor: hasChanges ? "pointer" : "default" },
                  onMouseOver: hasChanges ? function(e) { e.currentTarget.style.background = B.raised; } : undefined,
                  onMouseOut: hasChanges ? function(e) { e.currentTarget.style.background = "transparent"; } : undefined },
                  h("div", { style: { width: 5, borderRadius: "3px", background: tc, flexShrink: 0, marginTop: 2 } }),
                  h("div", { style: { flex: 1 } },
                    h("div", { style: { fontSize: "11px", color: B.text, display: "flex", gap: 4, alignItems: "center" } },
                      a.message,
                      hasChanges && h("span", { style: { fontSize: "9px", color: B.accent, fontWeight: 600 } }, "\u25b8")),
                    h("div", { style: { fontSize: "9px", color: B.textMut } }, (a.user || "") + (a.date ? " \u00b7 " + fmt(a.date) : "")))
                );
              }),
              (draft.scheduleActivity || []).length === 0 && h("div", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic", padding: "12px 0", textAlign: "center" } }, "No activity yet. Save the schedule to start tracking changes.")
            )
          )
        )
      ),

      // Activity detail modal
      viewActivity && h(window.LTPModal, { title: viewActivity.message, onClose: function() { setViewActivity(null); } },
        h("div", { style: { marginBottom: 10, fontSize: "11px", color: B.textMut } }, (viewActivity.user || "") + " \u00b7 " + fmt(viewActivity.date || "")),
        h("div", { style: { display: "flex", flexDirection: "column" } },
          (viewActivity.changes || []).map(function(ch, i) {
            return h("div", { key: i, style: { display: "flex", gap: 10, padding: "7px 0", borderBottom: "1px solid " + B.border } },
              h("div", { style: { width: 140, flexShrink: 0, fontSize: "11px", fontWeight: 600, color: B.accent } }, ch.cat),
              h("div", { style: { flex: 1, fontSize: "11px", color: B.textSec } }, ch.detail));
          }))
      ),

      // Confirm dialog
      dlg && h(window.LTPConfirmDialog, { dlg: dlg, onCancel: function() { setDlg(null); } }),

      // "Send to Quote" — choose how to organize the schedule's labor lines.
      quoteGroupDlg && h(window.LTPModal, { title: "Send to Quote", onClose: function() { setQuoteGroupDlg(false); } },
        h("p", { style: { fontSize: "12px", color: B.textSec, marginBottom: 16, lineHeight: 1.5 } },
          "How should the labor lines be organized in the quote?"),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
          h("button", { onClick: function() { sendToQuote("one"); },
            style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: "12px 14px", textAlign: "left", cursor: "pointer", fontFamily: "inherit" } },
            h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.text } }, "One section"),
            h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } }, "All roles in a single “Labor” section.")),
          h("button", { onClick: function() { sendToQuote("split"); },
            style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: "12px 14px", textAlign: "left", cursor: "pointer", fontFamily: "inherit" } },
            h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.text } }, "Split by department"),
            h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } }, "One section per department (Lighting, Audio, …).")),
          h("button", { onClick: function() { setQuoteGroupDlg(false); },
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "8px", padding: "8px 14px", color: B.textMut, fontSize: "11px", cursor: "pointer", fontFamily: "inherit" } }, "Cancel")))
    );
  };
})();
