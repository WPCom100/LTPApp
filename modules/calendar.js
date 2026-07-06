// Calendar Module — top-level view. Wraps CalendarGrid with a minimal ctx.
window.CalendarView = function({ projects }) {
  var B = window.LTP_THEME, h = React.createElement, useState = React.useState;
  var nav = window.LTPRouter.navigate;

  var [calMonth, setCalMonth] = useState(function() { var d = new Date(); return { year: d.getFullYear(), month: d.getMonth() }; });

  // Only the 4 properties CalendarGrid actually reads.
  // setSelectedProjectId supports an optional tab arg, encoded in the URL so the project
  // detail opens directly on Schedule/Meetings/etc. when clicked from the calendar.
  var ctx = {
    projects: projects,
    calMonth: calMonth,
    setCalMonth: setCalMonth,
    setSelectedProjectId: function(id, tab) {
      if (!id) return nav("projects");
      nav("projects/" + id + (tab ? "/" + tab : ""));
    },
  };

  return h("div", null,
    h("h2", { style: { fontSize: "20px", fontWeight: 700, color: B.text, margin: "0 0 16px" } }, "Calendar"),
    h(window.CalendarGrid, { ctx: ctx })
  );
};
