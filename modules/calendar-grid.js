// Calendar Grid — full page, project headers, schedule+meeting items, filters, click-to-tab
(function() {
  var B = window.LTP_THEME, CAT_COLORS = window.LTP_CAT_COLORS, h = React.createElement, useState = React.useState;
  var useEffect = React.useEffect, useRef = React.useRef;
  var ft = window.LTP_formatTime;

  window.CalendarGrid = function({ ctx }) {
    var [calFilter, setCalFilter] = useState("all");
    var isMobile = window.LTP_useIsMobile();
    // On mobile the agenda auto-scrolls to today (or the next day with events)
    // on mount, so the schedule opens on the current day rather than the 1st.
    var todayRef = useRef(null);
    useEffect(function() {
      if (isMobile && todayRef.current) {
        todayRef.current.scrollIntoView({ block: "start" });
      }
    }, [isMobile]);
    var year = ctx.calMonth.year, month = ctx.calMonth.month;
    var firstDay = new Date(year, month, 1).getDay();
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var monthName = new Date(year, month).toLocaleString("default", { month: "long", year: "numeric" });
    var days = [];
    for (var i = 0; i < firstDay; i++) days.push(null);
    for (var i = 1; i <= daysInMonth; i++) days.push(i);
    // Pad to fill complete rows
    while (days.length % 7 !== 0) days.push(null);
    var numRows = days.length / 7;

    // Build structured events per day: grouped by project
    function getEventsForDay(day) {
      if (!day) return [];
      var ds = year + "-" + String(month + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0");
      var groups = []; // { project, color, schedules[], meetings[], isInRange }

      ctx.projects.forEach(function(p) {
        var color = CAT_COLORS[p.category] || B.accent;
        var isInRange = p.startDate <= ds && p.endDate >= ds;
        var daySchedules = p.schedule.filter(function(s) {
          return s.showOnCalendar && (s.date === ds || (s.endDate && s.date <= ds && s.endDate >= ds));
        });
        var dayMeetings = p.meetings.filter(function(m) { return m.date === ds; });

        // Only include this project if it has something on this day
        if (!isInRange && dayMeetings.length === 0) return;

        var group = { project: p, color: color, schedules: [], meetings: [], isInRange: isInRange };

        if (calFilter === "all" || calFilter === "schedules") {
          group.schedules = daySchedules;
        }
        if (calFilter === "all" || calFilter === "meetings") {
          group.meetings = dayMeetings;
        }

        // Filter: if showing only schedules, skip projects with no schedules
        if (calFilter === "schedules" && daySchedules.length === 0 && !isInRange) return;
        // If showing only meetings, skip projects with no meetings
        if (calFilter === "meetings" && dayMeetings.length === 0) return;
        // If showing only projects, skip schedule/meeting details
        if (calFilter === "projects") { group.schedules = []; group.meetings = []; }
        // If showing only projects and project not in range, skip
        if (calFilter === "projects" && !isInRange) return;

        groups.push(group);
      });

      return groups;
    }

    // Filter buttons with integrated legend styling
    var filters = [
      { k: "all", l: "All", color: B.text },
      { k: "projects", l: "Projects", color: B.accent },
      { k: "schedules", l: "Schedules", color: B.success },
      { k: "meetings", l: "\u25b2 Meetings", color: B.info },
    ];

    function prevMonth() { ctx.setCalMonth(function(p) { return p.month === 0 ? { year: p.year - 1, month: 11 } : { year: p.year, month: p.month - 1 }; }); }
    function nextMonth() { ctx.setCalMonth(function(p) { return p.month === 11 ? { year: p.year + 1, month: 0 } : { year: p.year, month: p.month + 1 }; }); }

    // ── Mobile agenda / day-list ─────────────────────────────────────────────
    // The fixed-height 7-col month grid squeezes each day to ~50px on a phone,
    // clipping schedule text. On mobile we render a scrolling day-list instead:
    // one section per date that has events, each row a full-width tap target.
    // The desktop month grid below is unchanged.
    if (isMobile) {
      var agendaDays = [];
      for (var ad = 1; ad <= daysInMonth; ad++) {
        var agGroups = getEventsForDay(ad);
        if (agGroups.length) agendaDays.push({ day: ad, groups: agGroups });
      }
      var todayD = new Date();
      // The day to open on: today if the shown month is the current month, else
      // the first day-with-events on/after today (so it lands on the current or
      // next scheduled day). null in other months → no auto-scroll.
      var targetDay = null;
      if (year === todayD.getFullYear() && month === todayD.getMonth()) {
        for (var ti = 0; ti < agendaDays.length; ti++) {
          if (agendaDays[ti].day >= todayD.getDate()) { targetDay = agendaDays[ti].day; break; }
        }
      }
      return h("div", { style: { display: "flex", flexDirection: "column" } },
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 } },
          h(window.Btn, { small: true, variant: "ghost", onClick: prevMonth }, "← Prev"),
          h("h3", { style: { fontSize: "17px", fontWeight: 700, color: B.text, margin: 0 } }, monthName),
          h(window.Btn, { small: true, variant: "ghost", onClick: nextMonth }, "Next →")),
        h("div", { style: { display: "flex", gap: 8, marginBottom: 14, overflowX: "auto", flexWrap: "nowrap", scrollbarWidth: "none", WebkitOverflowScrolling: "touch" } },
          filters.map(function(f) {
            var active = calFilter === f.k;
            return h("button", { key: f.k, onClick: function() { setCalFilter(f.k); }, className: "ltp-tap",
              style: { flexShrink: 0, background: active ? f.color : B.raised, color: active ? B.btnInk : f.color, border: "1px solid " + (active ? f.color : B.border), borderRadius: "16px", padding: "8px 16px", fontSize: "13px", fontWeight: 600, cursor: "pointer", minHeight: 36, whiteSpace: "nowrap" } }, f.l);
          })),
        agendaDays.length === 0
          ? h(window.EmptyState, { text: "Nothing scheduled this month." })
          : agendaDays.map(function(entry) {
              var dObj = new Date(year, month, entry.day);
              var isToday = year === todayD.getFullYear() && month === todayD.getMonth() && entry.day === todayD.getDate();
              var dateLabel = dObj.toLocaleDateString("default", { weekday: "short", month: "short", day: "numeric" });
              return h("div", { key: entry.day, ref: entry.day === targetDay ? todayRef : null, style: { marginBottom: 18, scrollMarginTop: "8px" } },
                h("div", { style: { fontSize: "13px", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: isToday ? B.accent : B.textSec, marginBottom: 8, paddingBottom: 6, borderBottom: "1px solid " + B.border } }, dateLabel + (isToday ? " · Today" : "")),
                entry.groups.map(function(g, gi) {
                  var p = g.project;
                  return h("div", { key: p.id + "-" + gi, style: { background: g.color + "14", borderLeft: "3px solid " + g.color, borderRadius: 8, padding: "4px 12px 8px", marginBottom: 8 } },
                    (calFilter !== "meetings") && g.isInRange && h("div", {
                      onClick: function(e) { e.stopPropagation(); ctx.setSelectedProjectId(p.id, "overview"); },
                      className: "ltp-tap",
                      style: { fontSize: "15px", fontWeight: 700, color: g.color, cursor: "pointer", minHeight: 40, display: "flex", alignItems: "center" } }, p.name),
                    g.schedules.map(function(s) {
                      return h("div", { key: "s" + s.id, className: "ltp-tap",
                        onClick: function(e) { e.stopPropagation(); ctx.setSelectedProjectId(p.id, "schedule"); },
                        style: { fontSize: "14px", color: B.textSec, cursor: "pointer", minHeight: 38, display: "flex", alignItems: "center", paddingLeft: 4 } }, s.title + " · " + ft(s.time));
                    }),
                    g.meetings.map(function(m) {
                      return h("div", { key: "m" + m.id, className: "ltp-tap",
                        onClick: function(e) { e.stopPropagation(); ctx.setSelectedProjectId(p.id, "meetings"); },
                        style: { fontSize: "14px", color: B.info, cursor: "pointer", minHeight: 38, display: "flex", alignItems: "center", paddingLeft: 4 } }, "▲ " + m.title + " · " + ft(m.time));
                    })
                  );
                })
              );
            })
      );
    }

    return h("div", { className: "ltp-calendar-grid", style: { display: "flex", flexDirection: "column", overflow: "hidden" } },
      // Header
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexShrink: 0 } },
        h(window.Btn, { small: true, variant: "ghost", onClick: function() { ctx.setCalMonth(function(p) { return p.month === 0 ? { year: p.year - 1, month: 11 } : { year: p.year, month: p.month - 1 }; }); } }, "\u2190 Prev"),
        h("h3", { style: { fontSize: "18px", fontWeight: 700, color: B.text, margin: 0 } }, monthName),
        h(window.Btn, { small: true, variant: "ghost", onClick: function() { ctx.setCalMonth(function(p) { return p.month === 11 ? { year: p.year + 1, month: 0 } : { year: p.year, month: p.month + 1 }; }); } }, "Next \u2192")
      ),

      // Filter bar (combined with legend)
      h("div", { style: { display: "flex", gap: 6, marginBottom: 8, flexShrink: 0 } },
        filters.map(function(f) {
          var active = calFilter === f.k;
          return h("button", { key: f.k, onClick: function() { setCalFilter(f.k); },
            style: { background: active ? f.color : B.raised, color: active ? B.btnInk : f.color, border: "1px solid " + (active ? f.color : B.border), borderRadius: "4px", padding: "4px 12px", fontSize: "11px", fontWeight: 600, cursor: "pointer", transition: "all 0.15s" }
          }, f.l);
        })
      ),

      // Day headers
      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, flexShrink: 0 } },
        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(function(d) {
          return h("div", { key: d, style: { padding: "4px", textAlign: "center", fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase" } }, d);
        })
      ),

      // Calendar grid — fills remaining space, no scrollbar
      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gridTemplateRows: "repeat(" + numRows + ", 1fr)", gap: 2, flex: 1, overflow: "hidden" } },
        days.map(function(day, i) {
          var groups = getEventsForDay(day);
          var td = new Date();
          var isToday = day && year === td.getFullYear() && month === td.getMonth() && day === td.getDate();

          return h("div", { key: i, style: { background: day ? B.surface : "transparent", border: "1px solid " + (isToday ? B.accent : day ? B.border : "transparent"), borderRadius: "3px", padding: "3px", overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 0 } },
            day && h(React.Fragment, null,
              // Day number
              h("div", { style: { fontSize: "11px", fontWeight: isToday ? 700 : 500, color: isToday ? B.accent : B.textMut, marginBottom: 2, flexShrink: 0 } }, day),
              // Events container
              h("div", { style: { flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", gap: 2 } },
                groups.map(function(g, gi) {
                  var p = g.project;
                  var bgColor = g.color + "18";
                  var borderColor = g.color + "44";

                  return h("div", { key: p.id + "-" + gi, style: { background: bgColor, borderRadius: "3px", borderLeft: "2px solid " + g.color, padding: "2px 4px", marginBottom: 1 } },
                    // Project header — 12px, bold, underlined, with background color
                    (calFilter !== "meetings") && g.isInRange && h("div", {
                      onClick: function(e) { e.stopPropagation(); ctx.setSelectedProjectId(p.id, "overview"); },
                      style: { fontSize: "12px", fontWeight: 700, color: g.color, cursor: "pointer", textDecoration: "underline", lineHeight: 1.3 }
                    }, p.name),

                    // Schedule items — 11px, indented, no wrap, start time only
                    g.schedules.map(function(s) {
                      var timeStr = ft(s.time);
                      return h("div", { key: "s" + s.id,
                        onClick: function(e) { e.stopPropagation(); ctx.setSelectedProjectId(p.id, "schedule"); },
                        style: { fontSize: "11px", color: B.textSec, cursor: "pointer", lineHeight: 1.3, paddingLeft: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }
                      }, s.title + " - " + timeStr);
                    }),

                    // Meeting items — 11px, wrapping text, includes project name
                    g.meetings.map(function(m) {
                      return h("div", { key: "m" + m.id,
                        onClick: function(e) { e.stopPropagation(); ctx.setSelectedProjectId(p.id, "meetings"); },
                        style: { fontSize: "11px", color: B.info, cursor: "pointer", lineHeight: 1.3 }
                      }, "\u25b2 " + p.name + " - " + m.title + " " + ft(m.time));
                    })
                  );
                })
              )
            )
          );
        })
      )
    );
  };
})();
