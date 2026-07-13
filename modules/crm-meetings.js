// CRM Meetings — Add Meeting Modal with note linking
(function() {
  var B = window.LTP_THEME, h = React.createElement, useState = React.useState, fmt = window.LTP_formatDate;

  window.CRMAddMeeting = function({ ctx }) {
    var projectId = ctx.showAddMeeting;
    var project = ctx.projects.find(function(p) { return p.id === projectId; });
    var [title, setTitle] = useState("");
    var [date, setDate] = useState(window.LTP_todayISO());
    var [time, setTime] = useState("10:00");
    var [attIds, setAttIds] = useState(project ? project.contactIds : []);
    var [linkedNoteIds, setLinkedNoteIds] = useState([]);
    var notes = project ? project.notes : [];

    return h(window.LTPModal, { title: "Schedule Meeting", onClose: function() { ctx.setShowAddMeeting(null); }, disableBackdrop: true },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
        h(window.LTPInput, { label: "Meeting Title", value: title, onChange: setTitle, placeholder: "e.g. Production Meeting" }),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
          h(window.LTPInput, { label: "Date", value: date, onChange: setDate, type: "date" }),
          h(window.LTPInput, { label: "Time", value: time, onChange: setTime, type: "time" })
        ),
        h(window.SearchSelect, { label: "Attendees", items: ctx.contacts, selectedIds: attIds, onChange: setAttIds, nameField: function(c) { return c.firstName + " " + c.lastName; } }),
        notes.length > 0 && h(window.SearchSelect, { label: "Link to Notes (optional)", items: notes, selectedIds: linkedNoteIds, onChange: setLinkedNoteIds, nameField: function(n) { return n.author + " \u2014 " + fmt(n.date); } }),
        h(window.Btn, { onClick: function() {
          if (!title.trim() || !date) return;
          var ae = ctx.contacts.filter(function(c) { return attIds.includes(c.id); }).map(function(c) { return c.email; });
          var meetingId = Date.now();
          ctx.setProjects(function(prev) { return prev.map(function(p) {
            if (p.id !== projectId) return p;
            var newMeetings = p.meetings.concat([{ id: meetingId, title: title, date: date, time: time, attendees: attIds, meetLink: "", calSynced: false, linkedNoteIds: linkedNoteIds }]);
            var newNotes = linkedNoteIds.length > 0 ? p.notes.map(function(n) { return linkedNoteIds.includes(n.id) ? Object.assign({}, n, { linkedMeetingId: meetingId }) : n; }) : p.notes;
            return Object.assign({}, p, { meetings: newMeetings, notes: newNotes });
          }); });
          window.open(window.LTP_gcalUrl({ title: title + " \u2014 " + (project ? project.name : ""), date: date, time: time, attendees: ae }), "_blank");
          ctx.setShowAddMeeting(null);
        } }, "Create & Export to Google Calendar")
      )
    );
  };
})();
