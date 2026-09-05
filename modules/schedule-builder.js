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

  // ── Flat-rate positions panel ─────────────────────────────────────────────
  // People hired for the WHOLE project at a fixed fee with no call times — a
  // lighting designer, a stage manager. They live in project.fixedPositions,
  // not on a schedule day (see backend/models.py::Project.fixed_positions and
  // the helpers in components/domain-crew.js): the fee (what we pay) and the
  // bill (what the client pays) are typed per position, margin is the
  // difference, and the fee lands in the payroll period the PROJECT'S END DATE
  // falls into — paid on that period's pay day with everything else, no
  // per-position pay date. Status is read-only here, exactly like a shift
  // position: requests, confirms and releases happen in Labor.
  var POS_COLORS = { open: B.textMut, requested: B.warn, accepted: B.success, declined: B.danger, confirmed: B.info };
  var ACTIVE_POS = { requested: 1, accepted: 1, confirmed: 1 };

  function FixedPositionsPanel({ list, onChange, onRemove, contacts, svcs, project, settings, isMobile }) {
    var crew = (contacts || []).filter(function(c) { return c.isCrew && c.crewStatus === "active"; });
    var money = window.LTP_money;
    var rows = list || [];
    function update(id, patch) {
      onChange(rows.map(function(p) { return p.id === id ? Object.assign({}, p, patch) : p; }));
    }
    function add() {
      onChange(rows.concat([{ id: genId("fpos"), serviceId: null, role: "", crewId: null, status: "open",
                              fee: 0, bill: 0, fullMargin: false, note: "" }]));
    }
    // When the fee is paid: the payroll period the project's end date falls
    // into, on that period's pay day (Settings → pay period anchor / length /
    // pay-day offset). Spelled out here so the producer never has to work it out.
    var endISO = window.LTP_fixedPayDate(project);
    var ppCfg = settings || {};
    var pp = (endISO && ppCfg.payPeriodAnchor) ? window.LTP_payPeriodBounds(ppCfg.payPeriodAnchor, ppCfg.payPeriodLengthDays || 14, endISO) : null;
    var payDay = pp ? window.LTP_payPeriodPayDay(pp.end, ppCfg.payPeriodPayDayOffsetDays || 0) : null;
    var payLine = !endISO
      ? "Set the project's end date \u2014 the fee is paid with the payroll period that date falls into."
      : pp
        ? "Paid with the payroll period the project end date (" + fmt(endISO) + ") falls into \u2014 pay day " + fmt(payDay) + ", alongside every other payout in that period."
        : "Paid with the payroll period the project end date (" + fmt(endISO) + ") falls into. Set the pay-period start date in Settings to see the pay day.";
    var inp = { background: B.bg, border: "1px solid " + B.border, borderRadius: "3px", padding: isMobile ? "8px" : "3px 5px",
                color: B.text, fontSize: "10px", fontFamily: "inherit", outline: "none", minWidth: 0, boxSizing: "border-box" };
    var lbl = { display: "inline-flex", alignItems: "center", gap: 4, fontSize: "9px", color: B.textMut, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 };
    var trig = { borderRadius: "3px", padding: isMobile ? "8px" : "3px 5px", fontSize: "10px", minHeight: 0 };
    return h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "6px", padding: isMobile ? 10 : 12, marginBottom: 12 } },
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap", marginBottom: rows.length ? 8 : 0 } },
        h("div", { style: { minWidth: 0, flex: "1 1 320px" } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.12em" } }, "Flat-rate positions"),
          h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2, lineHeight: 1.4 } },
            "Hired for the whole project at a fixed fee, no call times \u2014 they get the schedule outline and set their own hours. "
            + "The fee is stated on their request. " + payLine)),
        h("button", { onClick: add,
          style: { background: "transparent", border: "1px dashed " + B.accent + "44", color: B.accent, cursor: "pointer", fontSize: "9px", fontWeight: 600, padding: "4px 10px", borderRadius: "3px", whiteSpace: "nowrap", flexShrink: 0 } },
          "+ Flat-rate position")),
      rows.map(function(p) {
        var svc = p.serviceId ? svcs.find(function(sv) { return sv.id === p.serviceId; }) : null;
        var pc = POS_COLORS[p.status] || B.textMut;
        var fee = Number(p.fee) || 0, bill = Number(p.bill) || 0;
        var margin = Math.round((bill - (p.fullMargin ? 0 : fee)) * 100) / 100;
        var co = window.LTP_crewSelectOptions({
          crew: crew, role: svc ? svc.role : "", selectedId: p.crewId,
          allContacts: contacts, leading: [{ value: "", label: "Crew\u2026" }],
        });
        return h("div", { key: p.id, style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "3px", padding: isMobile ? "8px" : "5px 8px", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 4 } },
          // Role — a rate-card service, required: it routes the fee to that
          // role's QuickBooks expense account and names the quote line.
          h(window.LTPSearchSelect, {
            value: p.serviceId || "",
            onChange: function(v) {
              var sid = (v === "" || v == null) ? null : Number(v);
              var sv = sid ? svcs.find(function(sv2) { return sv2.id === sid; }) : null;
              update(p.id, { serviceId: sid, role: sv ? sv.role : "" });
            },
            options: [{ value: "", label: "Role\u2026" }].concat(svcs.map(function(sv) {
              return { value: sv.id, label: sv.role, sublabel: sv.description };
            })),
            searchPlaceholder: "Search roles\u2026",
            style: { flex: isMobile ? "1 1 45%" : "1 1 110px", minWidth: 0 },
            triggerStyle: trig, panelMinWidth: 250,
          }),
          // Crew — role-matched first, like every crew picker. Clearing or
          // changing the person reopens the slot (a request belongs to whoever
          // was asked).
          h(window.LTPSearchSelect, {
            value: p.crewId || "",
            onChange: function(v) {
              var cid = (v === "" || v == null) ? null : Number(v);
              if (cid) update(p.id, { crewId: cid, status: cid === p.crewId ? p.status : "open" });
              else update(p.id, { crewId: null, status: "open" });
            },
            options: co.options, moreOptions: co.moreOptions, moreLabel: co.moreLabel,
            searchPlaceholder: "Search crew\u2026",
            style: { flex: isMobile ? "1 1 45%" : "1 1 130px", minWidth: 0 },
            triggerStyle: trig, panelMinWidth: 260,
          }),
          h("label", { style: lbl, title: "What we pay this person for the whole project." }, "Fee $",
            h("input", { type: "number", min: 0, step: "0.01", inputMode: "decimal", value: fee === 0 ? "" : p.fee, placeholder: "0",
              onChange: function(e) { update(p.id, { fee: e.target.value === "" ? 0 : Number(e.target.value) }); },
              style: Object.assign({}, inp, { width: isMobile ? 84 : 72 }) })),
          h("label", { style: lbl, title: "What the client is charged for this position (0 = absorbed in the package price, no quote line)." }, "Bill $",
            h("input", { type: "number", min: 0, step: "0.01", inputMode: "decimal", value: bill === 0 ? "" : p.bill, placeholder: "0",
              onChange: function(e) { update(p.id, { bill: e.target.value === "" ? 0 : Number(e.target.value) }); },
              style: Object.assign({}, inp, { width: isMobile ? 84 : 72 }) })),
          // Full-margin toggle — bills the client, zeroes the cost (the owner filling the role).
          h("button", { onClick: function() { update(p.id, { fullMargin: !p.fullMargin }); },
            title: p.fullMargin ? "Full margin: company cost is $0 for this position (bill still charged). Click to cost it at the fee." : "Mark full margin \u2014 zero the company cost (bill still charged), e.g. the owner filling the role.",
            style: { flexShrink: 0, background: p.fullMargin ? B.success + "22" : "transparent", border: "1px solid " + (p.fullMargin ? B.success : B.border), borderRadius: "3px", padding: isMobile ? "5px 10px" : "2px 5px", color: p.fullMargin ? B.success : B.textMut, fontSize: isMobile ? "10px" : "8px", fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" } },
            p.fullMargin ? "\u2713 MGN" : "MGN"),
          h("input", { type: "text", value: p.note || "", placeholder: "Scope note for the crew (optional)", maxLength: 500,
            onChange: function(e) { update(p.id, { note: e.target.value }); },
            style: Object.assign({}, inp, { flex: "1 1 150px" }) }),
          // Status — read-only here, managed in Labor (same as shift positions).
          h("span", { style: { flexShrink: 0, width: 70, textAlign: "center", fontSize: "9px", fontWeight: 600, color: pc, background: pc + "18", border: "1px solid " + pc + "33", borderRadius: "3px", padding: "4px 6px" } }, p.status),
          h("div", { style: { flexShrink: 0, width: 96, textAlign: "right", fontSize: "9px" } },
            h("div", { style: { color: B.accent, fontWeight: 600 } }, "$" + money(bill)),
            p.fullMargin
              ? h("div", { style: { color: B.success, fontWeight: 600 } }, "margin")
              : h("div", { style: { color: margin >= 0 ? B.textMut : B.danger } }, "margin $" + money(margin))),
          !p.serviceId && h("span", { title: "Pick a rate-card role \u2014 it routes the fee to that role's expense account and names the quote line.",
            style: { color: B.warn, fontSize: "9px", fontWeight: 700, whiteSpace: "nowrap" } }, "\u26a0 role needed"),
          !endISO && h("span", { title: "The project has no end date \u2014 this fee can't land in a payroll period until one is set (Projects \u2192 edit the project).",
            style: { color: B.warn, fontSize: "9px", fontWeight: 700, whiteSpace: "nowrap" } }, "\u26a0 no project end date"),
          h("button", { onClick: function() { onRemove(p); }, "aria-label": "Remove flat-rate position",
            style: { flexShrink: 0, background: "transparent", border: "none", color: isMobile ? B.danger : B.textMut, cursor: "pointer", fontSize: isMobile ? "20px" : "12px", padding: isMobile ? "4px 6px" : 0, minHeight: isMobile ? 40 : undefined } }, "\u00d7"));
      }));
  }

  window.ScheduleBuilder = function({ project, projects, setProjects, contacts, setContacts, services, clientRates, companies, quotes, setQuotes, getNextQuoteId, invoices, setInvoices, getNextInvoiceId, settings }) {
    var isMobile = window.LTP_useIsMobile();
    var company = companies.find(function(c) { return c.id === project.companyId; });

    // THE rate card for this project — the catalog with this client's negotiated
    // overrides folded in (theme.js::LTP_servicesForClient). Everything below
    // prices off `svcs`, never the raw `services` prop, so a contract rate or an
    // hours minimum lands on the editor, the summary, and the generated quote
    // identically. Memoized on identity: a client with no negotiated rates gets
    // the same array back, so this is free for the common case.
    var svcs = useMemo(function() {
      return window.LTP_servicesForClient(services, clientRates, window.LTP_clientRef(project));
    }, [services, clientRates, project.companyId]);
    // Roles this client has negotiated — surfaced as a banner so the producer
    // knows the day totals aren't the base card.
    var clientRateRoles = useMemo(function() {
      return svcs.filter(function(s) { return s && s.clientRate; });
    }, [svcs]);

    // Deep clone schedule with positions. Named rather than inlined because the
    // live-refresh effect below has to build the same shape from a project that
    // changed under us, and the two must not drift.
    function initialFrom(p) {
      return {
        schedule: (p.schedule || []).map(function(s) {
          return Object.assign({}, s, {
            positions: (s.positions || []).map(function(x) { return Object.assign({}, x); }),
            breaks: (s.breaks || []).map(function(b) { return Object.assign({}, b); })
          });
        }),
        scheduleNotes: p.scheduleNotes || "",
        scheduleActivity: (p.scheduleActivity || []).map(function(a) { return Object.assign({}, a); }),
        // Flat-rate engagements (no schedule day). Shallow-cloned like
        // positions; their pay/work/adj snapshots are only ever replaced.
        fixedPositions: (p.fixedPositions || []).map(function(x) { return Object.assign({}, x); }),
      };
    }
    var initial = useMemo(function() { return initialFrom(project); }, [project.id]);

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
    // "Send to Quote" / "Send to Invoice". One two-step dialog drives both:
    //   { kind: "quote"|"invoice", step: "grouping" }             → how to organize the lines
    //   { kind, step: "target", grouping, sections }              → which document receives them
    // null when closed. See openSend / chooseGrouping / executeSend below.
    var [sendDlg, setSendDlg] = useState(null);

    useEffect(function() { setDraftRaw(initial); cleanRef.current = initial; setIsDirty(false); }, [project.id]);

    // Someone else moved this project while we have it open — a crew member
    // accepting from their emailed link, or the other producer saving from a
    // second window. Adopt it if we have nothing unsaved, otherwise keep our
    // edits and say so once. See theme.js::LTP_useRemoteEdits.
    window.LTP_useRemoteEdits(
      project, initialFrom, isDirty,
      function(fresh) { setDraftRaw(fresh); cleanRef.current = fresh; },
      { title: "This schedule changed elsewhere",
        message: "Another window updated it while you were editing. Your unsaved changes are kept \u2014 saving will replace the newer version." },
      project.id, "projects");

    // Informational / validation notice as a non-blocking toast (modals are
    // reserved for confirm/cancel decisions). Variant defaults to "error".
    function showAlert(title, msg, variant) { window.LTP_toast(title, { message: msg, variant: variant || "error" }); }

    // ── Paid-day guard ───────────────────────────────────────────────────────
    // Days already PAID in QuickBooks (crewId|date -> {docNumber,…}) for THIS
    // project. Editing a shift's time/positions reprices the day, so a save that
    // touches a paid day is gated behind a warn+confirm; confirming records the
    // override (web-pushes admins). See /api/qbo/payouts/day-status + notify-edit.
    var [paidDays, setPaidDays] = useState({});
    var [paidWarn, setPaidWarn] = useState(null);   // [{crewId, date, ds}] while confirming
    var paidSeq = React.useRef(0);
    useEffect(function() {
      var dates = (project.schedule || []).map(function(s) { return s.date; })
        .concat((project.fixedPositions || []).length ? [window.LTP_fixedPayDate(project)] : [])
        .filter(Boolean).sort();
      if (!dates.length) { setPaidDays({}); return; }
      var seq = ++paidSeq.current;   // ignore a slower earlier project's late response
      fetch("/api/qbo/payouts/day-status", { method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify({ periodStart: dates[0], periodEnd: dates[dates.length - 1] }) })
        .then(function(r) { return r.ok ? r.json() : { days: {} }; })
        .then(function(b) {
          if (seq !== paidSeq.current) return;
          var days = (b && b.days) || {}, mine = {};
          Object.keys(days).forEach(function(k) {
            var parts = k.split("|");   // crewId|projectId|date
            if (String(parts[1]) === String(project.id) && days[k].paid) mine[parts[0] + "|" + parts[2]] = days[k];
          });
          setPaidDays(mine);
        })
        .catch(function() { if (seq === paidSeq.current) setPaidDays({}); });
    }, [project.id]);

    // Serialize a break list to a stable string: unpaid-break time/type changes
    // reprice pay (unpaid minutes are deducted from paid hours), so the fingerprint
    // must include each break's start:end:type, not just the count.
    function _serBreaks(breaks) {
      return (breaks || []).map(function(b) {
        return (b.startTime || "") + ":" + (b.endTime || "") + ":" + (b.type || "");
      }).sort().join("|");
    }
    // Payout-relevant fingerprint of each (crewId, date): shift times, the
    // crew-wide breaks AND the position's individual breaks, and the crew's
    // positions (role/service/status). A change to any of these reprices pay, so
    // all of them must be in the signature or the paid-day guard misses the edit.
    function _paidSig(schedule, fixed) {
      var m = {};
      // Flat-rate engagements fingerprint under the project's END date:
      // service, role, status, fee and the full-margin flag all reprice the
      // fee. Mirrors the "flat" branch of backend/payouts.py::paid_day_signature.
      var flatDate = window.LTP_fixedPayDate(project);
      (fixed || []).forEach(function(p) {
        if (!p || p.crewId == null) return;
        var d = flatDate;
        if (!d) return;
        var key = p.crewId + "|" + d;
        (m[key] = m[key] || []).push(["flat", p.serviceId, p.role, p.status, Number(p.fee) || 0, !!p.fullMargin].join(","));
      });
      (schedule || []).forEach(function(s) {
        if (!s.date) return;
        (s.positions || []).forEach(function(p) {
          if (p.crewId == null) return;
          var key = p.crewId + "|" + s.date;
          (m[key] = m[key] || []).push([s.time, s.endTime, p.serviceId, p.role, p.status,
            _serBreaks(s.breaks), _serBreaks(p.breaks)].join(","));
        });
      });
      Object.keys(m).forEach(function(k) { m[k].sort(); });
      return m;
    }
    function changedPaidDays() {
      if (!Object.keys(paidDays).length) return [];
      var before = _paidSig(cleanRef.current.schedule, cleanRef.current.fixedPositions);
      var after = _paidSig(draft.schedule, draft.fixedPositions);
      var out = [];
      Object.keys(paidDays).forEach(function(cd) {
        if ((before[cd] || []).join(";") !== (after[cd] || []).join(";")) {
          var parts = cd.split("|");
          out.push({ crewId: Number(parts[0]), date: parts[1], ds: paidDays[cd] });
        }
      });
      return out;
    }
    function notifyPaidEdit(cp) {
      fetch("/api/qbo/payouts/notify-edit", { method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify({ contactId: cp.crewId, projectId: project.id, date: cp.date, where: "schedule" }) }).catch(function() {});
    }

    // The producer confirmed the override. Record it, arm the header the server
    // requires (backend/routes/api.py::_paid_day_override), then save. Arming
    // BEFORE the save matters: persisted state issues the PUT on a debounce, and
    // it reads the armed header when it fires.
    function confirmPaidEdit(cps) {
      (cps || []).forEach(notifyPaidEdit);
      if (window.LTP_STATE && window.LTP_STATE.armWrite) {
        window.LTP_STATE.armWrite("projects", project.id, { "X-LTP-Paid-Day-Override": "1" });
      }
      _runSave();
    }

    // The server refused the save because it reprices a paid day this window did
    // not know about — `paidDays` is fetched once when the editor opens, so a
    // bill paid since then, or a second window's save, leaves it stale.
    //
    // This is why the check moved server-side: rather than trusting a map that
    // can be wrong, we let the server tell us and prompt from ITS answer. Saving
    // again after confirming works because the failed write never advanced the
    // sync baseline, so the same change is still pending.
    useEffect(function() {
      function onConflict(e) {
        var d = e && e.detail;
        if (!d || d.collection !== "projects" || d.id !== project.id) return;
        setPaidWarn((d.days || []).map(function(day) {
          return { crewId: day.contactId, date: day.date, ds: { docNumber: day.docNumber } };
        }));
      }
      window.addEventListener("ltp-paid-day-conflict", onConflict);
      return function() { window.removeEventListener("ltp-paid-day-conflict", onConflict); };
    }, [project.id]);

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
        var dayLabor = window.LTP_calcDayLabor(dateMap[d].items, svcs, crewMins);
        totalRate += dayLabor.rateTotal;
        totalCost += dayLabor.costTotal;
      });
      var days = Object.keys(dateMap).length;
      // Flat-rate engagements: typed bill/fee, no rate engine — added on top of
      // the day labor so the summary previews the whole project's margin.
      var flat = window.LTP_fixedPositionsTotals(draft.fixedPositions);
      totalRate += flat.rateTotal;
      totalCost += flat.costTotal;
      totalPos += flat.count;
      filledPos += flat.filled;
      return { days: days, totalPos: totalPos, filledPos: filledPos, totalRate: Math.round(totalRate), totalCost: Math.round(totalCost), margin: Math.round(totalRate - totalCost),
               flatCount: flat.count, flatFilled: flat.filled, flatRate: Math.round(flat.rateTotal), flatCost: Math.round(flat.costTotal) };
    }, [draft.schedule, draft.fixedPositions, contacts]);

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
      // Flat-rate engagements — same shape of entries, keyed on the role.
      var bf = before.fixedPositions || [], af = after.fixedPositions || [];
      var bfMap = {}; bf.forEach(function(p) { bfMap[p.id] = p; });
      var money = window.LTP_money;
      function roleName(p) { var sv = p.serviceId ? svcs.find(function(x) { return x.id === p.serviceId; }) : null; return sv ? sv.role : (p.role || "?"); }
      function crewName(id) { var c = id ? contacts.find(function(x) { return x.id === id; }) : null; return c ? c.firstName + " " + c.lastName : "Unassigned"; }
      af.forEach(function(p) {
        var label = "Flat-rate " + roleName(p);
        var bp = bfMap[p.id];
        if (!bp) { changes.push({ cat: "Flat-rate Position Added", detail: roleName(p) + (Number(p.fee) ? " \u00b7 fee $" + money(p.fee) : "") }); return; }
        if (bp.serviceId !== p.serviceId) changes.push({ cat: label + " \u2014 Role Changed", detail: roleName(bp) + " \u2192 " + roleName(p) });
        if (bp.crewId !== p.crewId) changes.push({ cat: label, detail: crewName(bp.crewId) + " \u2192 " + crewName(p.crewId) });
        if (bp.status !== p.status) changes.push({ cat: label + " Status", detail: bp.status + " \u2192 " + p.status });
        if ((Number(bp.fee) || 0) !== (Number(p.fee) || 0)) changes.push({ cat: label + " Fee", detail: "$" + money(bp.fee) + " \u2192 $" + money(p.fee) });
        if ((Number(bp.bill) || 0) !== (Number(p.bill) || 0)) changes.push({ cat: label + " Bill", detail: "$" + money(bp.bill) + " \u2192 $" + money(p.bill) });
        if (!!bp.fullMargin !== !!p.fullMargin) changes.push({ cat: label + " Cost", detail: p.fullMargin ? "Full margin ($0 cost)" : "Costed at the fee" });
        if ((bp.note || "") !== (p.note || "")) changes.push({ cat: label + " Note", detail: "Updated" });
      });
      bf.forEach(function(p) { if (!af.find(function(a) { return a.id === p.id; })) changes.push({ cat: "Flat-rate Position Removed", detail: roleName(p) }); });
      if ((before.scheduleNotes || "") !== (after.scheduleNotes || "")) changes.push({ cat: "Notes", detail: "Updated" });
      return changes.length > 0 ? changes : null;
    }

    // ── Actions ──────────────────────────────────────────────────────────────
    // On save, park a removal notice (per person, per type) for any crew this
    // save pulls off shifts — into the notify tray, where the producer sends or
    // declines. Snapshot the shifts here (the positions are about to be deleted)
    // so the email still renders. Then persist.
    function save() {
      // Guard: a save that reprices a paid day warns first; confirming records
      // the override and continues via _runSave().
      var cp = changedPaidDays();
      if (cp.length) { setPaidWarn(cp); return; }
      _runSave();
    }

    function _runSave() {
      if (project.id) {
        // Two kinds of crew notice come out of a save: crew pulled off a shift
        // (removed/reassigned) and crew whose still-held shift was MOVED. Both
        // park into the notify tray, grouped per person, for the producer to
        // send or decline. Snapshot here (the draft is about to persist).
        var removed = window.LTP_diffRemovedCrew(cleanRef.current.schedule, draft.schedule, contacts, svcs)
          .concat(window.LTP_diffRemovedFixed(cleanRef.current.fixedPositions, draft.fixedPositions, contacts, svcs));
        var changed = window.LTP_diffChangedShifts(cleanRef.current.schedule, draft.schedule, contacts, svcs);
        removed.concat(changed).forEach(function(g) {
          window.LTP_outbox.add({ crewId: g.crewId, crewName: g.crewName, projectId: project.id, projectName: project.name || "", template: g.template, shifts: g.shifts });
        });
        if (removed.length || changed.length) {
          var people = {};
          removed.concat(changed).forEach(function(g) { people[g.crewId] = true; });
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
      // A flat-rate row survives once anything was entered into it; a pristine
      // "+ Flat-rate position" row that was never touched is dropped.
      var cleanFixed = (draft.fixedPositions || []).filter(function(p) {
        return p && (p.serviceId || p.crewId != null || (Number(p.fee) || 0) > 0 || (Number(p.bill) || 0) > 0 || (p.note || "").trim());
      });

      setProjects(function(prev) {
        return prev.map(function(p) {
          return p.id === project.id ? Object.assign({}, p, { schedule: cleanSchedule, fixedPositions: cleanFixed, scheduleNotes: draft.scheduleNotes, scheduleActivity: newActivity }) : p;
        });
      });

      var saved = { schedule: cleanSchedule, fixedPositions: cleanFixed, scheduleNotes: draft.scheduleNotes, scheduleActivity: newActivity };
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
    function handleFixedChange(list) {
      setDraft(function(d) { return Object.assign({}, d, { fixedPositions: list }); });
    }
    // Removing an engagement someone already holds confirms first — the
    // removal notice itself is parked on save (LTP_diffRemovedFixed).
    function removeFixed(pos) {
      var drop = function() {
        setDraft(function(d) { return Object.assign({}, d, { fixedPositions: (d.fixedPositions || []).filter(function(p) { return p.id !== pos.id; }) }); });
      };
      if (pos.crewId && ACTIVE_POS[pos.status]) {
        var cm = contacts.find(function(c) { return c.id === pos.crewId; });
        setDlg({ title: "Remove flat-rate position", variant: "danger", confirmLabel: "Remove",
          message: (cm ? cm.firstName + " " + cm.lastName : "This crew member") + " is " + pos.status + " for this engagement. Removing it releases them \u2014 a notice is queued to the notify tray when you save.",
          onConfirm: function() { drop(); setDlg(null); } });
        return;
      }
      drop();
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
      var flatRows = (draft.fixedPositions || []).map(function(p) {
        var sv = p.serviceId ? svcs.find(function(x) { return x.id === p.serviceId; }) : null;
        var cm = p.crewId ? contacts.find(function(c) { return c.id === p.crewId; }) : null;
        return "<tr><td>" + escAttr(sv ? sv.role + " \u2014 " + sv.description : (p.role || "?")) + "</td><td>" + (cm ? escAttr(cm.firstName + " " + cm.lastName) : "(open)") + "</td><td>" + escAttr(p.status) + "</td><td>" + escAttr(p.note || "") + "</td></tr>";
      }).join("");
      var flatHtml = flatRows ? "<h2 style='margin:22px 0 8px'>Flat-rate positions \u2014 whole project, no call times</h2><table><thead><tr><th>Role</th><th>Crew</th><th>Status</th><th>Scope</th></tr></thead><tbody>" + flatRows + "</tbody></table>" : "";
      w.document.write("<html><head><title>" + escAttr(project.name) + " Schedule</title><style>body{font-family:sans-serif;padding:20px;max-width:1000px;margin:auto;color:#333}h1{margin:0 0 4px;font-size:22px}h2{margin:0 0 12px;font-size:14px;color:#666}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd;font-size:12px}th{border-bottom:2px solid #333;font-size:13px}.footer{margin-top:30px;padding-top:10px;border-top:1px solid #ddd;font-size:10px;color:#999;display:flex;justify-content:space-between}</style></head><body><h1>" + escAttr(project.name) + " \u2014 Schedule</h1><h2>" + escAttr(company ? company.name : "") + " \u00b7 " + fmt(project.startDate) + " \u2192 " + fmt(project.endDate) + "</h2><table><thead><tr><th>Day</th><th>Date</th><th>Times</th><th>Duration</th><th>Crew</th></tr></thead><tbody>" + rows + "</tbody></table>" + flatHtml + "<div class='footer'><span>" + escAttr(window.LTP_COMPANY_NAME || "") + "</span><span>Printed: " + fmt(todayISO()) + "</span></div></body></html>");
      w.document.close(); w.print();
    }

    // ── Send to Quote / Send to Invoice ──────────────────────────────────────
    // Both destinations bill the same lines off window.LTP_scheduleLaborSections
    // (theme.js), which owns the per-role day-rate aggregation — a divergence
    // between the two would be an invisible pricing bug. The only thing that
    // differs is the document literal built around those lines. Flow:
    //   openSend(kind) → grouping picker → target picker → executeSend(target).
    //
    // The target is either a NEW document or any of this client's existing DRAFT
    // quotes / invoices, whichever project that document started on — which is
    // what lets one quote or invoice cover several jobs.

    var KIND = {
      quote:   { label: "Quote",   noun: "quote",   route: "quotes",   ref: window.LTP_QUOTE_REF,
                 totals: window.LTP_QUOTE_TOTALS,   date: function(d) { return d.createdDate; } },
      invoice: { label: "Invoice", noun: "invoice", route: "invoices", ref: window.LTP_INVOICE_REF,
                 totals: window.LTP_INVOICE_TOTALS, date: function(d) { return d.invoiceDate || d.createdDate; } },
    };

    // This client's draft documents of the given kind, across ALL projects.
    // A project is always billed to its COMPANY (window.LTP_clientRef), so a
    // contact-billed quote/invoice can never be a target; and a project with no
    // company has no client at all, so its only option is a new document.
    // Draft-only is a hard requirement on the invoice side — invoices lock as
    // soon as they're sent (modules/invoices.js) — and is applied to quotes too
    // so a document the client has already received never changes underneath
    // them.
    function clientDrafts(kind) {
      if (project.companyId == null) return [];
      var list = (kind === "quote" ? quotes : invoices) || [];
      return list.filter(function(d) {
        return d && d.status === "draft" && d.clientType !== "contact" && d.companyId === project.companyId;
      }).slice().sort(function(a, b) { return (b.id || 0) - (a.id || 0); });
    }

    function openSend(kind) {
      var noun = KIND[kind].noun;
      var hasFlat = (draft.fixedPositions || []).some(function(p) { return p && p.serviceId && (Number(p.bill) || 0) > 0; });
      if (draft.schedule.length === 0 && !hasFlat) { showAlert("No Schedule", "Add schedule days before creating a " + noun + "."); return; }
      // Lines are priced off `draft`, not the persisted project — sending an
      // unsaved schedule would bill times the project doesn't have.
      if (isDirty) { showAlert("Unsaved Changes", "Save the schedule before sending to a " + noun + "."); return; }
      var hasPositions = hasFlat || draft.schedule.some(function(s) { return (s.positions || []).some(function(p) { return p.serviceId; }); });
      if (!hasPositions) { showAlert("No Positions", "Add positions to schedule days (or a billed flat-rate position) before creating a " + noun + "."); return; }
      setSendDlg({ kind: kind, step: "grouping" });
    }

    // grouping === "one" → a single "Labor" section; otherwise one section per
    // department. Per-crew negotiated minimums flow into unit cost via crewMins
    // so the document's margin reflects the higher payout, while the price
    // billed to the client stays the role rate.
    function chooseGrouping(grouping) {
      var kind = sendDlg.kind;
      var sections = window.LTP_scheduleLaborSections(
        draft.schedule, svcs, window.LTP_crewMinMap(contacts), grouping, fmt, genId, draft.fixedPositions);
      if (sections.length === 0) {
        setSendDlg(null);
        // Positions exist (openSend checked) but nothing priced — every day is
        // missing a start or end time. Say that precisely instead of repeating
        // the "no positions" guard, which sent people looking in the wrong place.
        showAlert("Nothing to bill", "No schedule day has both a start and an end time, so there's nothing to price.");
        return;
      }
      setSendDlg({ kind: kind, step: "target", grouping: grouping, sections: sections });
    }

    function executeSend(targetId) {
      if (!sendDlg || sendDlg.step !== "target") return;
      var kind = sendDlg.kind, sections = sendDlg.sections;
      var K = KIND[kind];
      var today = todayISO();
      var now = new Date().toTimeString().substring(0, 5);
      setSendDlg(null);

      function changeList(secs) {
        return secs.map(function(sec) {
          return { cat: sec.label, detail: sec.items.map(function(i) { return i.name + " ×" + i.qty; }).join(", ") };
        });
      }

      if (targetId != null) {
        // ── Append into an existing draft ──────────────────────────────────
        // Deliberately NOT a merge: the incoming lines arrive as NEW sections
        // stamped with this project's name, so whatever the user already
        // arranged in that document is left exactly as it was and each job's
        // work stays identifiable on the printed doc. The project name goes in
        // the section LABEL because that is what survives the public-view scrub.
        var setList = kind === "quote" ? setQuotes : setInvoices;
        setList(function(prev) {
          return prev.map(function(doc) {
            if (doc.id !== targetId) return doc;
            // This job usually runs on different dates than the document's, so
            // its sections carry their own rental window (null when they match,
            // or when this IS the document's primary job).
            var dateStamp = window.LTP_sectionDateStamp(doc, project, projects);
            var labeled = sections.map(function(sec) {
              return Object.assign({}, sec, {
                label: window.LTP_projectSectionLabel(sec.label, project.name),
                projectId: project.id,
              }, dateStamp || {});
            });
            // Records this project as a contributor; the document's PRIMARY
            // project (its title on the PDF) is never rewritten.
            var link = window.LTP_linkDocProject(doc, project.id);
            return Object.assign({}, doc, {
              projectId: link.projectId, projectIds: link.projectIds,
              sections: window.LTP_appendDocSections(doc.sections, labeled, genId),
              activity: (doc.activity || []).concat([{
                id: genId("act"), date: today, time: now, type: "updated",
                user: (window.LTP_CURRENT_USER || "User"),
                message: "Labor added from " + project.name + " schedule",
                changes: changeList(labeled),
              }]),
            });
          });
        });
        nav(K.route + "/" + targetId);
        return;
      }

      // ── Create a new document ────────────────────────────────────────────
      var stamped = sections.map(function(sec) { return Object.assign({}, sec, { projectId: project.id }); });
      var common = {
        clientType: "company", companyId: project.companyId, clientContactId: null,
        projectId: project.id, projectIds: [project.id], customName: "",
        status: "draft", createdDate: today, sentDate: null,
        globalDiscount: { type: "none", value: 0 },
        sections: stamped,
        notes: "Generated from " + project.name + " schedule.",
        activity: [{
          id: genId("act"), date: today, time: now, type: "created",
          user: (window.LTP_CURRENT_USER || "User"),
          message: K.label + " created from project schedule",
          changes: changeList(stamped),
        }],
      };

      var newId;
      if (kind === "quote") {
        newId = getNextQuoteId();
        setQuotes(function(prev) {
          return prev.concat([Object.assign({}, common, {
            id: newId,
            customStartDate: "", customEndDate: "",
            rentalStartDate: null, rentalEndDate: null,
          })]);
        });
      } else {
        newId = getNextInvoiceId();
        // Schedule-billed lines carry no sourceItemId / sourceQuoteId — there is
        // no quote line behind them — so they are a direct bill and the
        // invoicedQty rollback in modules/invoices.js correctly skips them.
        var due = new Date();
        due.setDate(due.getDate() + (window.LTP_DEFAULT_TERMS || 30));
        setInvoices(function(prev) {
          return prev.concat([Object.assign({}, common, {
            id: newId, quoteId: null,
            // Minted client-side so Preview works without a server round-trip,
            // matching the other two invoice-creation sites.
            shareToken: window.LTP_genShareToken(),
            invoiceDate: today, dueDate: due.toISOString().substring(0, 10), paidDate: null,
            payments: [],
            notes: window.LTP_DEFAULT_INVOICE_NOTES || common.notes,
          })]);
        });
      }
      nav(K.route + "/" + newId);
    }

    // ── Render ───────────────────────────────────────────────────────────────
    return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" } },
      // Sticky header. In the full-screen builder the app topbar is hidden, so
      // on mobile this header takes the status-bar safe-area inset and its
      // actions wrap instead of overflowing off-screen.
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: isMobile ? "wrap" : "nowrap", gap: isMobile ? 10 : 0, background: B.surface, borderBottom: "1px solid " + B.border, padding: isMobile ? "calc(10px + env(safe-area-inset-top)) 12px 10px" : "12px 16px", flexShrink: 0, zIndex: 5 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 14 } },
          h("button", { onClick: function() { nav("projects/" + project.id); },
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textSec, fontSize: "11px", fontFamily: "inherit", cursor: "pointer" } }, "\u2190 Back to Project"),
          h("div", null,
            h("div", { style: { fontSize: "20px", fontWeight: 700, color: B.accent, lineHeight: 1.1 } }, project.name + " \u2014 Schedule"),
            h("div", { style: { fontSize: "11px", color: B.textMut, marginTop: 2 } },
              (company ? company.name + " \u00b7 " : "") + fmt(project.startDate) + " \u2192 " + fmt(project.endDate)))),
        h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: isMobile ? "wrap" : "nowrap" } },
          justSaved && h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.success, background: B.successBg, border: "1px solid " + B.successBd, padding: "5px 10px", borderRadius: "6px" } }, "\u2713 Saved"),
          h("button", { onClick: function() { openSend("quote"); },
            style: { background: B.accent, border: "none", borderRadius: "6px", padding: "6px 12px", color: B.btnInk, fontSize: "11px", fontWeight: 700, fontFamily: "inherit", cursor: "pointer" } }, "\u2192 Send to Quote"),
          // Bills the schedule straight to the client, skipping the quote's
          // delivered/invoiced ledger entirely \u2014 these are direct-bill lines.
          h("button", { onClick: function() { openSend("invoice"); },
            style: { background: "transparent", border: "1px solid " + B.accent, borderRadius: "6px", padding: "6px 12px", color: B.accent, fontSize: "11px", fontWeight: 700, fontFamily: "inherit", cursor: "pointer" } }, "\u2192 Send to Invoice"),
          h("button", { onClick: printSchedule,
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textSec, fontSize: "11px", fontFamily: "inherit", cursor: "pointer" } }, "Print"),
          isDirty && h(window.Btn, { small: true, variant: "ghost", onClick: discard }, "Discard"),
          isDirty && h(window.Btn, { small: true, onClick: save }, "Save Schedule"))
      ),

      // Body: main + side panel on desktop; single scrolling column on mobile
      // so the editor gets full width and the summary/notes/activity stack below.
      h("div", { style: { flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", gap: 14, overflowY: isMobile ? "auto" : "hidden", overflowX: "hidden", paddingTop: 10 } },
        // Main content (scrollable)
        h("div", { style: { flex: 1, overflowY: isMobile ? "visible" : "auto", minWidth: 0 } },
          h(FixedPositionsPanel, { list: draft.fixedPositions || [], onChange: handleFixedChange, onRemove: removeFixed,
            contacts: contacts, svcs: svcs, project: project, settings: settings, isMobile: isMobile }),
          h(window.ScheduleEditor, { schedule: draft.schedule, onChange: handleScheduleChange, contacts: contacts, services: svcs,
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
        h("div", { style: { width: isMobile ? "100%" : 280, flexShrink: 0, display: "flex", flexDirection: "column", gap: 4, overflowY: isMobile ? "visible" : "auto" } },
          // SUMMARY
          h("div", { style: { background: B.surface, borderTop: "1px solid " + B.border, padding: 14 } },
            h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.12em", margin: "0 0 10px" } }, "Schedule Summary"),
            h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid " + B.border } },
              h("span", { style: { fontSize: "11px", color: B.textSec } }, "Schedule Days"),
              h("span", { style: { fontSize: "12px", fontWeight: 700, color: B.text } }, stats.days)),
            h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid " + B.border } },
              h("span", { style: { fontSize: "11px", color: B.textSec } }, "Positions"),
              h("span", { style: { fontSize: "12px", fontWeight: 600, color: stats.filledPos === stats.totalPos && stats.totalPos > 0 ? B.success : B.text } }, stats.filledPos + " / " + stats.totalPos + " filled")),
            stats.flatCount > 0 && h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid " + B.border } },
              h("span", { style: { fontSize: "11px", color: B.textSec } }, "Flat-rate"),
              h("span", { style: { fontSize: "11px", fontWeight: 600, color: B.text }, title: "Bill $" + stats.flatRate.toLocaleString() + " · cost $" + stats.flatCost.toLocaleString() + " (included in the totals below)" },
                stats.flatFilled + " / " + stats.flatCount + " confirmed \u00b7 $" + stats.flatRate.toLocaleString())),
            h("div", { style: { display: "flex", justifyContent: "space-between", padding: "6px 0 4px", borderTop: "1px solid " + B.border, marginTop: 4 } },
              h("span", { style: { fontSize: "12px", fontWeight: 700, color: B.text } }, "Total Rate"),
              h("span", { style: { fontSize: "13px", fontWeight: 700, color: B.accent } }, "$" + stats.totalRate.toLocaleString())),
            h("div", { style: { display: "flex", justifyContent: "space-between", padding: "3px 0" } },
              h("span", { style: { fontSize: "11px", color: B.textMut } }, "Total Cost"),
              h("span", { style: { fontSize: "11px", color: B.textMut } }, "$" + stats.totalCost.toLocaleString())),
            h("div", { style: { display: "flex", justifyContent: "space-between", padding: "3px 0", borderTop: "1px dashed " + B.border, marginTop: 2 } },
              h("span", { style: { fontSize: "11px", color: B.textMut } }, "Margin"),
              h("span", { style: { fontSize: "11px", fontWeight: 700, color: stats.margin >= 0 ? B.success : B.danger } }, "$" + stats.margin.toLocaleString())),
            // Which roles on this schedule are priced on the client's contract
            // rather than the base card — the totals above already reflect them.
            clientRateRoles.length > 0 && h("div", { style: { marginTop: 8, paddingTop: 8, borderTop: "1px solid " + B.border } },
              h("div", { style: { fontSize: "9px", fontWeight: 700, color: B.info, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 5 } },
                (company ? company.name : "Client") + " rates"),
              clientRateRoles.map(function(s) {
                var maps = window.LTP_serviceRateMaps(s);
                return h("div", { key: s.id, style: { display: "flex", justifyContent: "space-between", gap: 6, fontSize: "10px", padding: "1px 0" } },
                  h("span", { style: { color: B.textSec, fontWeight: 600 } }, s.role,
                    s.minHours > 0 && h("span", { style: { color: B.info, fontWeight: 700 } }, " · " + s.minHours + "h min")),
                  h("span", { style: { color: B.textMut } }, "$" + Math.round(maps.priceMap.day) + "/day"));
              }))
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

      // Paid-day change guard (warn + confirm; confirming records the override).
      paidWarn && h(window.LTPModal, { title: "Changing a paid day", onClose: function() { setPaidWarn(null); } },
        h("p", { style: { fontSize: "12px", color: B.textSec, lineHeight: 1.6, marginBottom: 10 } },
          "This save changes " + paidWarn.length + " day" + (paidWarn.length > 1 ? "s" : "") + " already paid in QuickBooks. The paid QuickBooks bill" + (paidWarn.length > 1 ? "s" : "") + " won't update automatically — adjust " + (paidWarn.length > 1 ? "them" : "it") + " in QuickBooks to stay in sync."),
        h("ul", { style: { margin: "0 0 14px", paddingLeft: 18, fontSize: "11px", color: B.text } },
          paidWarn.map(function(cp, i) {
            var c = contacts.find(function(x) { return x.id === cp.crewId; });
            return h("li", { key: i, style: { marginBottom: 3 } }, (c ? (c.firstName + " " + c.lastName).trim() : "Crew") + " · " + fmt(cp.date) + (cp.ds && cp.ds.docNumber ? " (" + cp.ds.docNumber + ")" : ""));
          })),
        h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
          h(window.Btn, { variant: "ghost", onClick: function() { setPaidWarn(null); } }, "Cancel"),
          h(window.Btn, { variant: "danger", onClick: function() { var cps = paidWarn; setPaidWarn(null); confirmPaidEdit(cps); } }, "Save anyway"))),

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

      // Send to Quote / Send to Invoice — step 1: how to organize the lines.
      sendDlg && sendDlg.step === "grouping" && h(window.LTPModal, { title: "Send to " + KIND[sendDlg.kind].label, onClose: function() { setSendDlg(null); } },
        h("p", { style: { fontSize: "12px", color: B.textSec, marginBottom: 16, lineHeight: 1.5 } },
          "How should the labor lines be organized in the " + KIND[sendDlg.kind].noun + "?"),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
          h("button", { onClick: function() { chooseGrouping("one"); },
            style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: "12px 14px", textAlign: "left", cursor: "pointer", fontFamily: "inherit" } },
            h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.text } }, "One section"),
            h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } }, "All roles in a single “Labor” section.")),
          h("button", { onClick: function() { chooseGrouping("split"); },
            style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: "12px 14px", textAlign: "left", cursor: "pointer", fontFamily: "inherit" } },
            h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.text } }, "Split by department"),
            h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } }, "One section per department (Lighting, Audio, …).")),
          h("button", { onClick: function() { setSendDlg(null); },
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "8px", padding: "8px 14px", color: B.textMut, fontSize: "11px", cursor: "pointer", fontFamily: "inherit" } }, "Cancel"))),

      // Step 2: which document receives them — a new one, or any of this
      // client's existing drafts regardless of which project it started on.
      sendDlg && sendDlg.step === "target" && function() {
        var K = KIND[sendDlg.kind];
        var drafts = clientDrafts(sendDlg.kind);
        var lineCount = sendDlg.sections.reduce(function(n, s) { return n + s.items.length; }, 0);
        return h(window.LTPModal, { title: "Send to " + K.label, onClose: function() { setSendDlg(null); } },
          h("p", { style: { fontSize: "12px", color: B.textSec, marginBottom: 4, lineHeight: 1.5 } },
            lineCount + " labor line" + (lineCount !== 1 ? "s" : "") + " from " + project.name + "."),
          h("p", { style: { fontSize: "11px", color: B.textMut, marginBottom: 14, lineHeight: 1.5 } },
            drafts.length > 0
              ? "Add them to one of " + (company ? company.name + "’s" : "this client’s") + " draft " + K.noun + "s — they’ll arrive as new sections, leaving what’s already there untouched — or start a new " + K.noun + "."
              : (project.companyId == null
                  ? "This project has no client company, so there are no existing " + K.noun + "s to add to."
                  : "No draft " + K.noun + "s for " + (company ? company.name : "this client") + " yet.")),
          drafts.length > 0 && h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 14, maxHeight: 260, overflowY: "auto" } },
            drafts.map(function(d) {
              var itemCount = (d.sections || []).reduce(function(n, s) {
                return n + (s.items || []).filter(function(i) { return i.type !== "note"; }).length; }, 0);
              // Which jobs this document already covers — the reason a draft
              // from another project is a legitimate target at all.
              var names = window.LTP_docProjectNames(d, projects);
              var total = (K.totals(d) || {}).total || 0;
              return h("button", { key: d.id, onClick: function() { executeSend(d.id); },
                style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "6px", padding: "10px 14px", cursor: "pointer", textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, fontFamily: "inherit" },
                onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent; },
                onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
                h("div", { style: { minWidth: 0 } },
                  h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, K.ref(d)),
                  h("div", { style: { fontSize: "10px", color: B.textMut } },
                    itemCount + " item" + (itemCount !== 1 ? "s" : "") + " · " + (fmt(K.date(d)) || "—")),
                  names.length > 0 && h("div", { style: { fontSize: "10px", color: names.length > 1 ? B.info : B.textMut, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                    names.join(", "))),
                h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.accent, flexShrink: 0 } }, "$" + window.LTP_money(total)));
            })),
          h("div", { style: { display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" } },
            h("button", { onClick: function() { setSendDlg({ kind: sendDlg.kind, step: "grouping" }); },
              style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "8px", padding: "8px 14px", color: B.textMut, fontSize: "11px", cursor: "pointer", fontFamily: "inherit" } }, "← Back"),
            h(window.Btn, { onClick: function() { executeSend(null); } }, "+ Create New " + K.label)));
      }()
    );
  };
})();
