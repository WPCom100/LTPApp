// Crew withdrawal outbox — a pinned, can't-be-missed notification tray.
//
// Withdrawals made OUTSIDE the schedule editor (Crew Requests tab, Assignments)
// have no Save to batch against. Emailing the crew the instant each request is
// withdrawn spams anyone pulled from several shifts/requests. Instead the
// withdrawal itself happens immediately (the crew link dies, the request is
// withdrawn) and the *email* is parked here, coalesced per crew member. The
// producer sends them all (one combined crewWithdrawn email each) when ready,
// or declines to inform. The tray is a pinned card that persists — and survives
// reload via localStorage — so a pending notice can't be forgotten.
//
// Store is a window global (window.LTP_outbox) so labor.js can enqueue from deep
// in its tree while the card mounts once at the app root — same split as the
// LTP_toast event surface. Changes broadcast on the "ltp-outbox-change" event.
(function() {
  var h = React.createElement;
  var LS_KEY = "ltp_crew_outbox";

  function loadEntries() {
    try { var raw = window.localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : {}; }
    catch (e) { return {}; }
  }
  function persist(entries) {
    try { window.localStorage.setItem(LS_KEY, JSON.stringify(entries)); } catch (e) { /* private mode / quota */ }
  }

  // key "crewId:projectId" → { crewId, crewName, projectId, projectName, positionIds: [] }
  var entries = loadEntries();

  function keyFor(crewId, projectId) { return String(crewId) + ":" + String(projectId); }
  function emit() {
    persist(entries);
    try { window.dispatchEvent(new CustomEvent("ltp-outbox-change")); } catch (e) { /* unsupported */ }
  }

  window.LTP_outbox = {
    // Park a withdrawal for later notification. positionIds merge into any
    // existing notice for the same person+project, so one combined email covers
    // every shift they were pulled from.
    add: function(entry) {
      if (!entry || entry.crewId == null || entry.projectId == null) return;
      var k = keyFor(entry.crewId, entry.projectId);
      var cur = entries[k] || { crewId: entry.crewId, crewName: entry.crewName || "Crew", projectId: entry.projectId, projectName: entry.projectName || "", positionIds: [] };
      (entry.positionIds || []).forEach(function(pid) { if (cur.positionIds.indexOf(pid) === -1) cur.positionIds.push(pid); });
      if (entry.crewName) cur.crewName = entry.crewName;
      if (entry.projectName) cur.projectName = entry.projectName;
      entries[k] = cur;
      emit();
    },
    list: function() { return Object.keys(entries).map(function(k) { return entries[k]; }); },
    removeKey: function(k) { if (entries[k]) { delete entries[k]; emit(); } },
    clear: function() { entries = {}; emit(); },
    keyFor: keyFor,
  };

  function CrewOutbox() {
    var useState = React.useState, useEffect = React.useEffect;
    var B = window.LTP_THEME || {};
    var setTick = useState(0)[1];
    var sendingPair = useState(false); var sending = sendingPair[0], setSending = sendingPair[1];

    useEffect(function() {
      function onChange() { setTick(function(n) { return n + 1; }); }
      window.addEventListener("ltp-outbox-change", onChange);
      return function() { window.removeEventListener("ltp-outbox-change", onChange); };
    }, []);

    var items = window.LTP_outbox.list();
    if (items.length === 0) return null;
    var totalShifts = items.reduce(function(n, it) { return n + (it.positionIds || []).length; }, 0);

    function sendAll() {
      if (sending || !window.LTP_crewNotify) return;
      setSending(true);
      Promise.all(items.map(function(it) {
        return window.LTP_crewNotify(it.crewId, it.projectId, "crewWithdrawn", it.positionIds)
          .then(function(res) { return { it: it, es: (res.ok && res.body && res.body.emailStatus) || {} }; });
      })).then(function(results) {
        var emailed = results.filter(function(r) { return r.es.emailed; }).length;
        var reconnect = results.some(function(r) { return r.es.needsReconnect; });
        // Clear the ones that sent; leave failures in the tray to retry.
        results.forEach(function(r) { if (r.es.emailed) window.LTP_outbox.removeKey(keyFor(r.it.crewId, r.it.projectId)); });
        setSending(false);
        if (emailed === results.length) window.LTP_toast("Crew notified", { message: emailed + " crew member" + (emailed !== 1 ? "s" : "") + " emailed about their withdrawn shifts.", variant: "success" });
        else if (reconnect) window.LTP_toast("Some not notified", { message: "Connect Google in Settings, then Notify again from the tray.", variant: "warn" });
        else window.LTP_toast(emailed ? "Some crew notified" : "Notification failed", { message: emailed + " of " + results.length + " emailed; the rest stay in the tray to retry.", variant: emailed ? "warn" : "error" });
      }, function() {
        setSending(false);
        window.LTP_toast("Notification failed", { message: "Could not reach the server — your pending notices were kept.", variant: "error" });
      });
    }

    function declineOne(it) { window.LTP_outbox.removeKey(keyFor(it.crewId, it.projectId)); }
    function declineAll() {
      window.LTP_outbox.clear();
      window.LTP_toast("Withdrawal notices dismissed", { message: "Crew were not emailed.", variant: "info" });
    }

    var accent = B.warn || "#d29922";
    return h("div", { style: { position: "fixed", left: 16, bottom: 16, zIndex: 3000, width: 340, maxWidth: "calc(100vw - 32px)",
        background: B.warnBg || "#2e2208", border: "1px solid " + accent, borderRadius: "8px", boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif", color: B.text || "#fff", overflow: "hidden" } },
      h("div", { style: { padding: "10px 12px", borderBottom: "1px solid " + accent + "55", display: "flex", alignItems: "center", gap: 8 } },
        h("span", { style: { fontSize: "14px", flexShrink: 0 } }, "✉"),
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { style: { fontSize: "12px", fontWeight: 700 } }, "Crew to notify (" + items.length + ")"),
          h("div", { style: { fontSize: "10px", color: B.textMut || "#888", marginTop: 1 } },
            "Withdrawn from " + totalShifts + " shift" + (totalShifts !== 1 ? "s" : "") + " — not emailed yet"))),
      h("div", { style: { maxHeight: 200, overflowY: "auto", padding: "6px 8px", display: "flex", flexDirection: "column", gap: 4 } },
        items.map(function(it) {
          var n = (it.positionIds || []).length;
          return h("div", { key: keyFor(it.crewId, it.projectId), style: { display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", background: B.bg || "#000", borderRadius: "4px", border: "1px solid " + (B.border || "#333") } },
            h("div", { style: { flex: 1, minWidth: 0 } },
              h("div", { style: { fontSize: "11px", fontWeight: 600, color: B.text || "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, it.crewName),
              h("div", { style: { fontSize: "9px", color: B.textMut || "#888" } }, (it.projectName || "Project") + " · " + n + " shift" + (n !== 1 ? "s" : ""))),
            h("button", { onClick: function() { declineOne(it); }, title: "Don't notify", "aria-label": "Don't notify " + it.crewName,
              style: { background: "transparent", border: "none", color: B.textMut || "#888", fontSize: "13px", lineHeight: 1, cursor: "pointer", padding: "2px 4px", fontFamily: "inherit", flexShrink: 0 } }, "✕"));
        })),
      h("div", { style: { padding: "8px 12px", borderTop: "1px solid " + accent + "55", display: "flex", gap: 8, alignItems: "center" } },
        h("button", { onClick: sendAll, disabled: sending,
          style: { flex: 1, background: B.success || "#3fb950", border: "none", borderRadius: "6px", padding: "7px 12px", color: "#000", fontSize: "11px", fontWeight: 700, cursor: sending ? "default" : "pointer", opacity: sending ? 0.6 : 1, fontFamily: "inherit" } },
          sending ? "Sending…" : "✉ Notify all"),
        h("button", { onClick: declineAll, disabled: sending,
          style: { background: "transparent", border: "1px solid " + (B.border || "#333"), borderRadius: "6px", padding: "7px 12px", color: B.textMut || "#888", fontSize: "11px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" } },
          "Dismiss all")));
  }

  window.LTPCrewOutbox = CrewOutbox;
})();
