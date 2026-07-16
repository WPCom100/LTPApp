// Dashboard — daily overview with schedule, crew, invoices, activity, cash flow
window.DashboardView = function({ companies, projects, quotes, equipment, invoices, contacts, services, settings }) {
  var B = window.LTP_THEME, h = React.createElement, fmt = window.LTP_formatDate, ft = window.LTP_formatTime;
  var isMobile = window.LTP_useIsMobile();
  var nav = window.LTPRouter.navigate;
  var today = window.LTP_todayISO();
  var inv = invoices || [];
  var qt = quotes || [];
  var crew = (contacts || []).filter(function(c) { return c.isCrew && c.crewStatus === "active"; });

  // ── Upcoming schedule (next 7 days) ────────────────────────────────────
  var upcoming = [];
  var endDate = new Date(); endDate.setDate(endDate.getDate() + 7);
  var endISO = endDate.toISOString().substring(0, 10);
  (projects || []).forEach(function(p) {
    if (p.status === "completed") return;
    (p.schedule || []).forEach(function(s) {
      if (s.date && s.date >= today && s.date <= endISO) {
        var crewCount = (s.positions || []).filter(function(pos) { return pos.crewId; }).length;
        var openCount = (s.positions || []).filter(function(pos) { return !pos.crewId && pos.status === "open"; }).length;
        upcoming.push({ projectId: p.id, projectName: p.name, title: s.title, date: s.date, time: s.time, endTime: s.endTime, crewCount: crewCount, openCount: openCount, venue: p.venue });
      }
    });
  });
  upcoming.sort(function(a, b) { return (a.date + (a.time || "")) > (b.date + (b.time || "")) ? 1 : -1; });

  // ── Pending crew requests ──────────────────────────────────────────────
  var pendingCrew = [];
  (projects || []).forEach(function(p) {
    (p.schedule || []).forEach(function(s) {
      (s.positions || []).forEach(function(pos) {
        if (pos.status === "requested" && pos.crewId) {
          var cm = contacts.find(function(c) { return c.id === pos.crewId; });
          var svc = pos.serviceId ? (services || []).find(function(sv) { return sv.id === pos.serviceId; }) : null;
          pendingCrew.push({ projectName: p.name, projectId: p.id, crewName: cm ? cm.firstName + " " + cm.lastName : "?", role: svc ? svc.role : pos.role || "?", date: s.date, title: s.title });
        }
      });
    });
  });
  // Deduplicate by crew+date+project
  var seenPending = {};
  pendingCrew = pendingCrew.filter(function(p) {
    var k = p.crewName + "|" + p.date + "|" + p.projectId;
    if (seenPending[k]) return false; seenPending[k] = true; return true;
  });

  // ── Overdue invoices ───────────────────────────────────────────────────
  var overdue = inv.filter(function(i) { return window.LTP_isOverdue(i); }).map(function(i) {
    var t = window.LTP_INVOICE_TOTALS(i);
    var comp = companies.find(function(c) { return c.id === i.companyId; });
    return { id: i.id, ref: window.LTP_INVOICE_REF(i), company: comp ? comp.name : "?", balance: t.balance, dueDate: i.dueDate, daysPast: Math.floor((new Date() - new Date(i.dueDate)) / 86400000) };
  });

  // ── Cash flow summary ─────────────────────────────────────────────────
  var cashPaid = inv.filter(function(i) { return i.status === "paid"; }).reduce(function(s, i) { return s + window.LTP_INVOICE_TOTALS(i).total; }, 0);
  var cashOutstanding = inv.filter(function(i) { return i.status === "sent" || window.LTP_displayStatus(i) === "partial"; }).reduce(function(s, i) { return s + window.LTP_INVOICE_TOTALS(i).balance; }, 0);
  var cashDraft = inv.filter(function(i) { return i.status === "draft"; }).reduce(function(s, i) { return s + window.LTP_INVOICE_TOTALS(i).total; }, 0);
  var cashOverdue = overdue.reduce(function(s, o) { return s + o.balance; }, 0);
  var quotePipeline = qt.filter(function(q) { return q.status === "sent"; }).reduce(function(s, q) { return s + (window.LTP_QUOTE_TOTALS ? window.LTP_QUOTE_TOTALS(q).total : 0); }, 0);

  // ── Recent activity (across all modules) ───────────────────────────────
  var recentActivity = [];
  qt.forEach(function(q) { (q.activity || []).forEach(function(a) { recentActivity.push(Object.assign({}, a, { context: window.LTP_QUOTE_REF(q), module: "quotes", navTo: "quotes/" + q.id })); }); });
  inv.forEach(function(i) { (i.activity || []).forEach(function(a) { recentActivity.push(Object.assign({}, a, { context: window.LTP_INVOICE_REF(i), module: "invoices", navTo: "invoices/" + i.id })); }); });
  (projects || []).forEach(function(p) { (p.scheduleActivity || []).forEach(function(a) { recentActivity.push(Object.assign({}, a, { context: p.name, module: "schedule", navTo: "projects/" + p.id + "/schedule" })); }); });
  recentActivity.sort(function(a, b) { return (b.date + (b.time || "")) > (a.date + (a.time || "")) ? 1 : -1; });
  recentActivity = recentActivity.slice(0, 15);

  // ── Greeting ───────────────────────────────────────────────────────────
  var hr = new Date().getHours();
  var greeting = hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
  var userName = (settings || {}).userName || "";

  // ── Render ─────────────────────────────────────────────────────────────
  var cardStyle = { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: 16, overflow: "hidden" };
  var headerStyle = { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 };

  return h("div", null,
    // Greeting
    h("div", { style: { marginBottom: 20 } },
      h("h1", { style: { fontSize: "22px", fontWeight: 700, color: B.text, margin: "0 0 2px" } }, greeting + (userName ? ", " + userName.split(" ")[0] : "")),
      h("p", { style: { color: B.textMut, fontSize: "12px", margin: 0 } }, fmt(today))),

    // Cash flow cards
    h("div", { style: { display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" } },
      h(window.StatCard, { label: "Collected", value: "$" + window.LTP_money(cashPaid), accent: B.success }),
      h(window.StatCard, { label: "Outstanding", value: "$" + window.LTP_money(cashOutstanding), accent: cashOutstanding > 0 ? B.warn : B.textMut }),
      h(window.StatCard, { label: "Overdue", value: "$" + window.LTP_money(cashOverdue), accent: cashOverdue > 0 ? B.danger : B.textMut }),
      h(window.StatCard, { label: "Draft", value: "$" + window.LTP_money(cashDraft) }),
      h(window.StatCard, { label: "Quote Pipeline", value: "$" + window.LTP_money(quotePipeline), accent: B.info })
    ),

    // Main grid: two columns
    h("div", { style: { display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 14 } },

      // LEFT COLUMN
      h("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },

        // Upcoming Schedule
        h("div", { style: cardStyle },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 } },
            h("div", { style: headerStyle }, "Upcoming Schedule (" + upcoming.length + ")"),
            h("button", { onClick: function() { nav("calendar"); }, style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "4px", padding: "2px 8px", color: B.textMut, fontSize: "9px", cursor: "pointer", fontFamily: "inherit" } }, "Calendar \u203a")),
          upcoming.length === 0 && h("div", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic", padding: "8px 0" } }, "No events in the next 7 days."),
          upcoming.slice(0, 8).map(function(u, i) {
            var isToday = u.date === today;
            return h("div", { key: i, onClick: function() { nav("projects/" + u.projectId + "/schedule"); },
              style: { display: "flex", gap: 10, alignItems: "center", padding: "6px 8px", borderRadius: "4px", cursor: "pointer", borderLeft: "3px solid " + (isToday ? B.accent : B.border), marginBottom: 2, background: isToday ? B.accent + "08" : "transparent" },
              onMouseOver: function(e) { e.currentTarget.style.background = B.raised; },
              onMouseOut: function(e) { e.currentTarget.style.background = isToday ? B.accent + "08" : "transparent"; } },
              h("div", { style: { width: 50, textAlign: "center", flexShrink: 0 } },
                h("div", { style: { fontSize: "9px", color: isToday ? B.accent : B.textMut, fontWeight: 700, textTransform: "uppercase" } }, isToday ? "Today" : new Date(u.date + "T12:00").toLocaleDateString("en", { weekday: "short" })),
                h("div", { style: { fontSize: "14px", fontWeight: 700, color: B.text } }, new Date(u.date + "T12:00").getDate())),
              h("div", { style: { flex: 1, minWidth: 0 } },
                h("div", { style: { fontSize: "11px", fontWeight: 600, color: B.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, u.title),
                h("div", { style: { fontSize: "10px", color: B.textMut } }, u.projectName + (u.time ? " \u00b7 " + ft(u.time) + "\u2192" + ft(u.endTime) : ""))),
              h("div", { style: { textAlign: "right", flexShrink: 0 } },
                h("div", { style: { fontSize: "10px", color: B.text } }, u.crewCount + " crew"),
                u.openCount > 0 && h("div", { style: { fontSize: "9px", color: B.warn } }, u.openCount + " open"))
            );
          })
        ),

        // Pending Crew
        h("div", { style: cardStyle },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 } },
            h("div", { style: headerStyle }, "Awaiting Response (" + pendingCrew.length + ")"),
            pendingCrew.length > 0 && h("button", { onClick: function() { nav("labor"); }, style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "4px", padding: "2px 8px", color: B.textMut, fontSize: "9px", cursor: "pointer", fontFamily: "inherit" } }, "Labor \u203a")),
          pendingCrew.length === 0 && h("div", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic", padding: "8px 0" } }, "No pending crew requests."),
          pendingCrew.slice(0, 6).map(function(pc, i) {
            return h("div", { key: i, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", borderRadius: "4px", background: B.raised, marginBottom: 3 } },
              h("div", null,
                h("span", { style: { fontSize: "11px", fontWeight: 600, color: B.text } }, pc.crewName),
                h("span", { style: { fontSize: "10px", color: B.textMut, marginLeft: 6 } }, pc.role)),
              h("div", { style: { textAlign: "right" } },
                h("div", { style: { fontSize: "10px", color: B.textMut } }, pc.projectName),
                h("div", { style: { fontSize: "9px", color: B.warn } }, pc.date ? fmt(pc.date) : ""))
            );
          })
        )
      ),

      // RIGHT COLUMN
      h("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },

        // Overdue Invoices
        h("div", { style: Object.assign({}, cardStyle, overdue.length > 0 ? { borderColor: B.danger + "44" } : {}) },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 } },
            h("div", { style: Object.assign({}, headerStyle, { color: overdue.length > 0 ? B.danger : B.textMut }) }, "Overdue (" + overdue.length + ")"),
            h("button", { onClick: function() { nav("invoices"); }, style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "4px", padding: "2px 8px", color: B.textMut, fontSize: "9px", cursor: "pointer", fontFamily: "inherit" } }, "Invoices \u203a")),
          overdue.length === 0 && h("div", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic", padding: "8px 0" } }, "No overdue invoices. \u2713"),
          overdue.map(function(o) {
            return h("div", { key: o.id, onClick: function() { nav("invoices/" + o.id); },
              style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", borderRadius: "4px", cursor: "pointer", background: B.danger + "08", border: "1px solid " + B.danger + "22", marginBottom: 3 },
              onMouseOver: function(e) { e.currentTarget.style.background = B.danger + "15"; },
              onMouseOut: function(e) { e.currentTarget.style.background = B.danger + "08"; } },
              h("div", null,
                h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.danger } }, o.ref),
                h("div", { style: { fontSize: "10px", color: B.textMut } }, o.company)),
              h("div", { style: { textAlign: "right" } },
                h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.danger } }, "$" + window.LTP_money(o.balance)),
                h("div", { style: { fontSize: "9px", color: B.danger } }, o.daysPast + " day" + (o.daysPast !== 1 ? "s" : "") + " past due"))
            );
          })
        ),

        // Recent Activity
        h("div", { style: cardStyle },
          h("div", { style: headerStyle }, "Recent Activity"),
          recentActivity.length === 0 && h("div", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic", padding: "8px 0" } }, "No recent activity."),
          recentActivity.map(function(a, i) {
            var typeColors = { created: B.success, sent: B.info, saved: B.textMut, status: B.warn, paid: B.success, invoiced: B.accent, updated: B.info };
            var tc = typeColors[a.type] || B.textMut;
            return h("div", { key: i, onClick: a.navTo ? function() { nav(a.navTo); } : undefined,
              style: { display: "flex", gap: 8, padding: "4px 6px", borderRadius: "3px", cursor: a.navTo ? "pointer" : "default", marginBottom: 1 },
              onMouseOver: a.navTo ? function(e) { e.currentTarget.style.background = B.raised; } : undefined,
              onMouseOut: a.navTo ? function(e) { e.currentTarget.style.background = "transparent"; } : undefined },
              h("div", { style: { width: 50, fontSize: "9px", color: B.textMut, flexShrink: 0, paddingTop: 1 } }, a.date ? a.date.substring(5).replace("-", "/") : ""),
              h("span", { style: { fontSize: "8px", fontWeight: 700, color: tc, background: tc + "18", border: "1px solid " + tc + "33", padding: "1px 5px", borderRadius: "3px", textTransform: "uppercase", flexShrink: 0, alignSelf: "flex-start", marginTop: 1 } }, a.type),
              h("div", { style: { flex: 1, minWidth: 0 } },
                h("div", { style: { fontSize: "10px", color: B.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, a.message),
                h("div", { style: { fontSize: "9px", color: B.textMut } }, a.context))
            );
          })
        )
      )
    ),

    // Quick nav
    h("div", { style: { display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" } },
      [{ m: "crm", t: "CRM", c: B.accent }, { m: "projects", t: "Projects", c: B.info }, { m: "quotes", t: "Quotes", c: B.success }, { m: "invoices", t: "Invoicing", c: B.warn }, { m: "labor", t: "Labor", c: B.text }, { m: "rentals", t: "Rentals", c: B.info }].map(function(m) {
        return h("button", { key: m.m, onClick: function() { nav(m.m); },
          style: { flex: 1, minWidth: 100, background: B.surface, border: "1px solid " + B.border, borderLeft: "3px solid " + m.c, borderRadius: "6px", padding: "10px 14px", textAlign: "left", cursor: "pointer", fontFamily: "inherit" },
          onMouseOver: function(e) { e.currentTarget.style.background = B.raised; },
          onMouseOut: function(e) { e.currentTarget.style.background = B.surface; } },
          h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.text } }, m.t));
      })
    )
  );
};
