// ── Cancel labor: the dialog behind every "Cancel…" ─────────────────────────
//
// One dialog for the Labor tab's Assignments and Payouts rows and the schedule
// editor's positions and days (docs/LABOR_SYNC_PLAN.md, B4/B6). It only
// gathers a decision — what the client is charged and what the crew member is
// paid, each a percentage of the booking's reference or a typed amount, and an
// optional reason — and hands it to the caller, which writes it through
// components/domain-crew.js (LTP_cancelBooking / LTP_setBookingCancellationShares).
//
//   refBill / refPay  the booking's reference: the shift priced as billed and
//                     as paid at the moment of cancelling
//                     (LTP_bookingCancelReference) — or, when editing, the
//                     reference it was cancelled against, which never moves
//   hasCrew           false → nobody committed to pay (LTP_projectBooking
//                     .paysCrew), no pay side
//   fullMargin        the owner's own position: charged, never paid
//   initial           { bill: { mode, value }, pay: { mode, value } } — the
//                     workspace defaults (LTP_cancelDefaults) or the current
//                     shares
//   edit              editing a cancellation already made (Save, not Cancel)
//   notify            null hides the notify-tray choice; otherwise its
//                     starting value
//   onConfirm(shares, reason, notify), onClose
//   onReopen          optional: the old reset-to-open path, for a person who
//                     is off the call while the call itself goes ahead
//   onRestore         optional (edit): undo the cancellation
//
// The pay share is held at or under the reference: paying more than the call
// was worth is an adjustment ($±), not a cancellation — and the server holds a
// non-admin to that ceiling too (backend/crew_integrity.py).
//
// Copy is held to labels (decision 17).
(function() {
  var B = window.LTP_THEME, h = React.createElement, useState = React.useState;

  function money(n) { return "$" + window.LTP_money(Math.round((Number(n) || 0) * 100) / 100); }
  function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  // The pay side never exceeds its reference.
  function clampPay(side, ref) {
    var v = Number(side.value) || 0;
    if (side.mode === "percent") return { mode: "percent", value: Math.min(100, Math.max(0, v)) };
    if (side.mode === "amount") return { mode: "amount", value: Math.min(r2(ref), Math.max(0, r2(v))) };
    return { mode: "none", value: 0 };
  }

  function ShareRow(p) {
    var isMobile = window.LTP_useIsMobile();
    var side = p.side, total = window.LTP_cancelShare(p.refTotal, side.mode, side.value);
    var ctlH = isMobile ? 40 : 30;
    var box = { height: ctlH, background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", color: B.text,
                fontSize: isMobile ? "16px" : "12px", fontFamily: "inherit", padding: "0 8px", boxSizing: "border-box" };
    return h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 0", borderBottom: "1px solid " + B.border } },
      h("div", { style: { flex: "1 1 120px", minWidth: 0 } },
        h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, p.label),
        !p.locked && h("div", { style: { fontSize: "10px", color: B.textMut } }, "of " + money(p.refTotal))),
      p.locked
        ? h("div", { style: { fontSize: "11px", color: B.textMut } }, p.locked)
        : h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
            h("select", { value: side.mode, "aria-label": p.label + " by",
              onChange: function(e) {
                var m = e.target.value;
                // Switching mode carries the figure across: a percent becomes
                // the amount it came to, an amount starts a percent at 50.
                p.onChange({ mode: m, value: m === "amount" ? r2(total) : m === "percent" ? 50 : 0 });
              },
              style: Object.assign({}, box, { width: isMobile ? 76 : 64, padding: "0 4px" }) },
              h("option", { value: "percent" }, "%"), h("option", { value: "amount" }, "$"), h("option", { value: "none" }, "None")),
            side.mode !== "none" && h("input", { type: "number", inputMode: "decimal", min: 0, step: side.mode === "percent" ? "1" : "0.01",
              "aria-label": p.label, value: side.value, onChange: function(e) { p.onChange({ mode: side.mode, value: e.target.value }); },
              style: Object.assign({}, box, { width: isMobile ? 96 : 80, textAlign: "right" }) })),
      h("div", { style: { width: 84, textAlign: "right", fontSize: "13px", fontWeight: 700, color: p.color, fontVariantNumeric: "tabular-nums" } },
        p.locked ? "" : money(total)));
  }

  window.LTPCancelDialog = function(p) {
    var isMobile = window.LTP_useIsMobile();
    var init = p.initial || window.LTP_cancelDefaults({});
    var billState = useState({ mode: init.bill.mode, value: init.bill.value });
    var payState = useState({ mode: init.pay.mode, value: init.pay.value });
    var reasonState = useState(p.reason || "");
    var notifyState = useState(p.notify == null ? false : !!p.notify);
    var bill = billState[0], pay = payState[0];
    var payable = p.hasCrew && !p.fullMargin;
    var payClamped = payable ? clampPay(pay, p.refPay) : { mode: "none", value: 0 };
    var billTotal = window.LTP_cancelShare(p.refBill, bill.mode, bill.value);
    var payTotal = payable ? window.LTP_cancelShare(p.refPay, payClamped.mode, payClamped.value) : 0;
    var btnStyle = isMobile ? window.LTP_SHEET_BTN : null;

    function confirm() {
      p.onConfirm({ bill: { mode: bill.mode, value: Number(bill.value) || 0 },
                    pay: payable ? { mode: payClamped.mode, value: Number(payClamped.value) || 0 } : { mode: "none", value: 0 } },
                  reasonState[0].trim(), !!notifyState[0]);
    }

    var footer = h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" } },
      p.onRestore && h(window.Btn, { variant: "ghost", onClick: p.onRestore, style: Object.assign({}, btnStyle, { marginRight: "auto" }) }, "Restore"),
      h(window.Btn, { variant: "ghost", onClick: p.onClose, style: btnStyle }, "Back"),
      p.onReopen && h(window.Btn, { variant: "ghost", onClick: p.onReopen, style: btnStyle }, "Reopen slot instead"),
      h(window.Btn, { variant: p.edit ? "primary" : "danger", onClick: confirm, style: Object.assign({}, btnStyle, isMobile ? { flex: 1 } : null) },
        p.edit ? "Save" : (p.confirmLabel || "Cancel shift")));

    return h(window.LTPModal, { title: p.title, onClose: p.onClose, footer: footer },
      p.subtitle && h("div", { style: { fontSize: "11px", color: B.textSec, marginBottom: 6 } }, p.subtitle),
      h(ShareRow, { label: "Charge client", refTotal: p.refBill, side: bill, onChange: billState[1], color: B.accent }),
      h(ShareRow, { label: "Pay crew", refTotal: p.refPay, side: payClamped, onChange: payState[1], color: B.text,
        locked: !p.hasCrew ? "none" : (p.fullMargin ? "full margin · $0" : null) }),
      h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 12, flexWrap: "wrap", fontSize: "11px", color: B.textSec, padding: "8px 0" } },
        h("span", null, "Charged " + money(billTotal)),
        h("span", null, "Paid " + money(payTotal)),
        h("span", { style: { fontWeight: 700, color: billTotal - payTotal >= 0 ? B.success : B.danger } }, "Margin " + money(billTotal - payTotal))),
      h("input", { type: "text", placeholder: "Reason (optional)", value: reasonState[0], "aria-label": "Reason", maxLength: 300,
        onChange: function(e) { reasonState[1](e.target.value); },
        style: { width: "100%", boxSizing: "border-box", background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", color: B.text,
                 fontSize: isMobile ? "16px" : "12px", fontFamily: "inherit", padding: "8px 10px", marginTop: 4 } }),
      p.notify != null && p.hasCrew && h("label", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: "12px", color: B.text, cursor: "pointer" } },
        h("input", { type: "checkbox", checked: !!notifyState[0], onChange: function(e) { notifyState[1](e.target.checked); }, style: { width: 18, height: 18 } }),
        "Add to notify tray"));
  };

  // ── The Labor tab's flow: dialog + write + notice + activity ───────────────
  // The Assignments and Payouts tabs cancel, re-share, restore and refill
  // whole project rows; this does it for both, so the two can't drift. The
  // schedule editor writes its own draft instead (components/schedule-editor.js)
  // and its save logs the change.
  //
  //   project       the live project row
  //   positionIds   the booking: shift positions of one person (a day's
  //                 bookings), or one flat-rate position
  //   services / clientRates / contacts / settings / setProjects
  //   onClose
  //   onReopen      optional, passed through to the dialog
  //   guard(run)    optional: wraps the write (the Payouts tab's paid-day
  //                 check); runs straight away when absent
  function names(project, booking, services, contacts) {
    var svcById = {}; (services || []).forEach(function(s) { svcById[s.id] = s; });
    var cm = booking.crewId != null ? (contacts || []).find(function(c) { return c.id === booking.crewId; }) : null;
    var roles = [];
    function add(p) {
      var sv = p && svcById[p.serviceId];
      var r = sv ? sv.role : (p && p.role) || "Crew";
      if (roles.indexOf(r) < 0) roles.push(r);
    }
    var want = {}; booking.ids.forEach(function(id) { want[id] = true; });
    if (booking.flat) (project.fixedPositions || []).forEach(function(p) { if (p && want[p.id]) add(p); });
    else (project.schedule || []).forEach(function(s) { ((s && s.positions) || []).forEach(function(p) { if (p && want[p.id]) add(p); }); });
    return { crew: cm ? ((cm.firstName || "") + " " + (cm.lastName || "")).trim() : "",
             role: (booking.flat ? "Flat-rate " : "") + (roles.join("/") || "Crew") };
  }

  window.LTPCancelFlow = function(p) {
    var project = p.project;
    var svcs = project ? window.LTP_servicesForClient(p.services, p.clientRates, window.LTP_clientRef(project)) : p.services;
    var mins = window.LTP_crewMinMap(p.contacts);
    // Read once, when the dialog opens: the figures it shows are the ones the
    // producer decides on (the write re-prices a cancel on the live row).
    var booking = useState(function() { return window.LTP_projectBooking(project, p.positionIds, svcs, mins); })[0];
    if (!project || !booking) return null;
    var nm = names(project, booking, p.services, p.contacts);
    var fmtDay = booking.date ? window.LTP_formatDate(booking.date) : "";
    // The day is signed off (LTP_projectBooking.signedDay): its frozen pay
    // covers the shifts here, so nothing moves until the sign-off is undone.
    if (booking.signedDay && !booking.cancelled) {
      return h(window.LTPModal, { title: "Day signed off", onClose: p.onClose,
        footer: h("div", { style: { display: "flex", justifyContent: "flex-end" } }, h(window.Btn, { variant: "ghost", onClick: p.onClose }, "Back")) },
        h("div", { style: { fontSize: "12px", color: B.textSec, lineHeight: 1.6 } }, "Undo the sign-off in Payouts first."));
    }

    function commit(action, shares, reason, notify) {
      var now = new Date();
      var meta = { at: now.toISOString(), by: window.LTP_CURRENT_USER || "User",
                   byId: window.LTP_CURRENT_USER_ID != null ? window.LTP_CURRENT_USER_ID : null, reason: reason };
      // What the write comes to, read from the row as it stands — for the
      // activity line, the toast and the notice. The stored write below runs
      // the same function on the live row.
      var preview = window.LTP_projectBookingWrite(project, booking, action, shares, svcs, mins, meta, window.LTP_genId);
      var after = window.LTP_projectBooking(preview.project, booking.ids, svcs, mins);
      var cancelNow = after && after.cancelled
        ? { bill: Object.assign({}, after.shares.bill, { total: after.billTotal }), pay: Object.assign({}, after.shares.pay, { total: after.payTotal }) }
        : null;
      var WORDS = { cancel: ["Shift cancelled", "Cancelled"], edit: ["Cancellation edited", "Cancellation Edited"],
                    restore: ["Cancellation restored", "Restored"], refill: ["Role refilled", "Refilled"] }[action];
      var detail = cancelNow ? window.LTP_cancelActivityDetail(nm.crew, cancelNow)
        : action === "refill" ? (preview.positionIds.length + " open position" + (preview.positionIds.length === 1 ? "" : "s") + " added")
        : (nm.crew || "Unassigned") + " · back to " + (booking.crewId != null ? "confirmed" : "open");
      var entry = { id: window.LTP_genId("act"), date: window.LTP_todayISO(), time: now.toTimeString().substring(0, 5),
        type: "saved", user: meta.by,
        message: WORDS[0] + ": " + (nm.crew || "Unassigned") + " as " + nm.role + (fmtDay ? " · " + fmtDay : ""),
        changes: [{ cat: (fmtDay ? fmtDay + " — " : "") + nm.role + " " + WORDS[1], detail: detail }] };
      var ids = booking.ids;
      var run = function() {
        p.setProjects(function(prev) {
          return prev.map(function(pr) {
            if (pr.id !== project.id) return pr;
            var w = window.LTP_projectBookingWrite(pr, booking, action, shares, svcs, mins, meta, window.LTP_genId);
            if (w.project === pr) return pr;
            return Object.assign({}, w.project, { scheduleActivity: (w.project.scheduleActivity || []).concat([entry]) });
          });
        });
        var parked = false;
        if (action === "cancel" && notify && booking.crewId != null) {
          var snaps = window.LTP_cancelSnapshots(preview.project, ids, p.services);
          var paid = snaps.some(function(sn) { return sn.cancellationPay > 0; });
          window.LTP_outbox.add({ crewId: booking.crewId, crewName: nm.crew || "Crew", projectId: project.id, projectName: project.name || "",
            template: paid ? "crewCancelledWithPay" : window.LTP_removalTemplate(booking.status), shifts: snaps });
          parked = true;
        }
        window.LTP_toast(WORDS[0], { variant: "success",
          message: (cancelNow ? "Charged " + money(cancelNow.bill.total) + " · paid " + money(cancelNow.pay.total) : detail)
            + (parked ? " · notice in the tray" : "") });
      };
      p.onClose();
      if (p.guard) p.guard(run); else run();
    }

    return h(window.LTPCancelDialog, {
      title: booking.cancelled ? "Cancellation" : (booking.flat ? "Cancel position" : "Cancel shift"),
      subtitle: [nm.crew || "Nobody booked", nm.role, fmtDay].filter(Boolean).join(" · "),
      refBill: booking.ref.bill, refPay: booking.ref.pay,
      hasCrew: booking.paysCrew, fullMargin: booking.fullMargin,
      initial: booking.cancelled ? booking.shares : window.LTP_cancelDefaults(p.settings),
      reason: booking.reason, edit: booking.cancelled,
      notify: booking.cancelled ? null : true,
      confirmLabel: booking.flat ? "Cancel position" : "Cancel shift",
      onClose: p.onClose,
      onReopen: !booking.cancelled && p.onReopen ? function() { p.onClose(); p.onReopen(); } : null,
      onRestore: booking.cancelled && !booking.signedDay ? function() { commit("restore", null, booking.reason, false); } : null,
      onConfirm: function(shares, reason, notify) { commit(booking.cancelled ? "edit" : "cancel", shares, reason, notify); },
    });
  };

  // Refill: the call still needs someone. Its own action (not a dialog) —
  // exported so both Labor tabs log it the same way.
  window.LTP_refillBooking = function(project, positionIds, setProjects, services, contacts) {
    var booking = window.LTP_projectBooking(project, positionIds, services, window.LTP_crewMinMap(contacts));
    if (!booking) return;
    var nm = names(project, booking, services, contacts);
    var fmtDay = booking.date ? window.LTP_formatDate(booking.date) : "";
    var now = new Date();
    var n = booking.flat ? 1 : booking.ids.length;
    var entry = { id: window.LTP_genId("act"), date: window.LTP_todayISO(), time: now.toTimeString().substring(0, 5),
      type: "saved", user: window.LTP_CURRENT_USER || "User",
      message: "Role refilled: " + nm.role + (fmtDay ? " · " + fmtDay : ""),
      changes: [{ cat: (fmtDay ? fmtDay + " — " : "") + nm.role + " Refilled", detail: n + " open position" + (n === 1 ? "" : "s") + " added" }] };
    setProjects(function(prev) {
      return prev.map(function(pr) {
        if (pr.id !== project.id) return pr;
        var w = window.LTP_projectBookingWrite(pr, booking, "refill", null, services, null, {}, window.LTP_genId);
        if (w.project === pr) return pr;
        return Object.assign({}, w.project, { scheduleActivity: (w.project.scheduleActivity || []).concat([entry]) });
      });
    });
    window.LTP_toast("Role refilled", { variant: "success", message: nm.role + (fmtDay ? " · " + fmtDay : "") + " is open again." });
  };

  // A write refused because it changes a day already paid in QuickBooks
  // (backend/routes/api.py → the "ltp-paid-day-conflict" event). The Payouts
  // tab and the schedule builder prompt for it; this is the same prompt for a
  // tab that has neither — Assignments, where a cancellation can now be
  // re-shared or restored after its day was paid. Confirming arms the
  // override header and re-issues the pending write. Returns the modal (or null).
  window.LTP_usePaidDayConflict = function(setProjects, contacts) {
    var pair = useState(null), conflict = pair[0], setConflict = pair[1];
    React.useEffect(function() {
      function onConflict(e) {
        var d = e && e.detail;
        if (!d || d.collection !== "projects" || !(d.days || []).length) return;
        setConflict({ id: d.id, day: d.days[0] });
      }
      window.addEventListener("ltp-paid-day-conflict", onConflict);
      return function() { window.removeEventListener("ltp-paid-day-conflict", onConflict); };
    }, []);
    if (!conflict) return null;
    var cm = (contacts || []).find(function(c) { return c.id === conflict.day.contactId; });
    var who = (cm ? ((cm.firstName || "") + " " + (cm.lastName || "")).trim() : "Crew") + " · " + window.LTP_formatDate(conflict.day.date);
    return h(window.LTPModal, { title: "Edit a paid day?", onClose: function() { setConflict(null); } },
      h("p", { style: { fontSize: "12px", color: B.textSec, lineHeight: 1.6, marginBottom: 16 } },
        who + " was already paid in QuickBooks" + (conflict.day.docNumber ? " (bill " + conflict.day.docNumber + ")" : "")
        + ". Changing it here will NOT update the paid QuickBooks bill. Continue?"),
      h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
        h(window.Btn, { variant: "ghost", onClick: function() { setConflict(null); } }, "Cancel"),
        h(window.Btn, { variant: "danger", onClick: function() {
          var id = conflict.id;
          setConflict(null);
          if (window.LTP_STATE && window.LTP_STATE.armWrite) window.LTP_STATE.armWrite("projects", id, { "X-LTP-Paid-Day-Override": "1" });
          setProjects(function(prev) { return prev.slice(); });
        } }, "Edit anyway")));
  };
})();
