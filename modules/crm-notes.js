// CRM Notes — Add, View, Edit, Print, Copy, Meeting linking
(function() {
  var B = window.LTP_THEME, h = React.createElement, useState = React.useState, fmt = window.LTP_formatDate;

  // Strip HTML for plain text copy
  function stripHtml(html) { var tmp = document.createElement("div"); tmp.innerHTML = html; return tmp.textContent || tmp.innerText || ""; }

  // Add Note Modal (rich text + optional meeting link)
  window.CRMAddNote = function({ ctx }) {
    var projectId = ctx.showAddNote;
    var project = ctx.projects.find(function(p) { return p.id === projectId; });
    var [text, setText] = useState("");
    var [author, setAuthor] = useState(window.LTP_CURRENT_USER || "User");
    var [linkedMeetingId, setLinkedMeetingId] = useState(null);
    var meetings = project ? project.meetings : [];

    return h(window.LTPModal, { title: "Add Note", onClose: function() { ctx.setShowAddNote(null); }, disableBackdrop: true },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
        h(window.LTPSelect, { label: "Author", value: author, onChange: setAuthor, options: [{ value: window.LTP_CURRENT_USER || "User", label: window.LTP_CURRENT_USER || "User" }] }),
        meetings.length > 0 && h(window.LTPSelect, { label: "Link to Meeting (optional)", value: linkedMeetingId || "", onChange: function(v) { setLinkedMeetingId(v ? Number(v) : null); }, options: [{ value: "", label: "None" }].concat(meetings.map(function(m) { return { value: m.id, label: m.title + " (" + fmt(m.date) + ")" }; })) }),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("label", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Note"),
          h(window.RichTextEditor, { value: "", onChange: setText, placeholder: "Meeting notes, decisions, action items..." })
        ),
        h(window.Btn, { onClick: function() {
          if (!text.trim() || text === "<br>") return;
          var noteId = Date.now();
          ctx.setProjects(function(prev) { return prev.map(function(p) {
            if (p.id !== projectId) return p;
            var newNotes = p.notes.concat([{ id: noteId, date: new Date().toISOString().split("T")[0], author: author, text: text, linkedMeetingId: linkedMeetingId }]);
            var newMeetings = linkedMeetingId ? p.meetings.map(function(m) { return m.id === linkedMeetingId ? Object.assign({}, m, { linkedNoteIds: (m.linkedNoteIds || []).concat([noteId]) }) : m; }) : p.meetings;
            return Object.assign({}, p, { notes: newNotes, meetings: newMeetings });
          }); });
          ctx.setShowAddNote(null);
        } }, "Save Note")
      )
    );
  };

  // Note Viewer — read-only view with print, copy, edit buttons
  window.CRMNoteViewer = function({ ctx }) {
    var vn = ctx.viewNote; if (!vn) return null;
    var project = ctx.projects.find(function(p) { return p.id === vn.projectId; });
    if (!project) return null;
    var note = project.notes.find(function(n) { return n.id === vn.noteId; });
    if (!note) return null;
    var linkedMeeting = note.linkedMeetingId ? project.meetings.find(function(m) { return m.id === note.linkedMeetingId; }) : null;
    var [copied, setCopied] = useState(false);

    function copyNote() {
      var plain = stripHtml(note.text);
      var header = note.author + " \u2014 " + fmt(note.date) + (linkedMeeting ? " (Meeting: " + linkedMeeting.title + ")" : "") + "\n\n";
      navigator.clipboard.writeText(header + plain).then(function() { setCopied(true); setTimeout(function() { setCopied(false); }, 2000); });
    }
    function printNote() {
      var w = window.open("", "_blank");
      w.document.write("<html><head><title>Note</title><style>body{font-family:sans-serif;padding:40px;max-width:700px;margin:auto;}h2{margin:0 0 4px;}p.meta{color:#666;font-size:13px;margin:0 0 16px;}.content{font-size:14px;line-height:1.7;}</style></head><body>");
      w.document.write("<h2>" + (project.name || "") + "</h2>");
      w.document.write("<p class='meta'>" + note.author + " \u2014 " + fmt(note.date) + (linkedMeeting ? " | Meeting: " + linkedMeeting.title : "") + "</p>");
      w.document.write("<div class='content'>" + note.text + "</div>");
      w.document.write("</body></html>");
      w.document.close(); w.print();
    }

    return h(window.LTPModal, { title: "Note", onClose: function() { ctx.setViewNote(null); } },
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 } },
        h("div", null,
          h("span", { style: { fontSize: "13px", fontWeight: 600, color: B.accent } }, note.author),
          h("span", { style: { fontSize: "12px", color: B.textMut, marginLeft: 8 } }, fmt(note.date))
        ),
        h("div", { style: { display: "flex", gap: 6 } },
          h(window.Btn, { small: true, variant: "ghost", onClick: function() { ctx.setViewNote(null); ctx.setEditNote({ projectId: vn.projectId, noteId: vn.noteId }); } }, "Edit"),
          h(window.Btn, { small: true, variant: "ghost", onClick: copyNote }, copied ? "\u2713 Copied" : "Copy"),
          h(window.Btn, { small: true, variant: "ghost", onClick: printNote }, "Print")
        )
      ),
      linkedMeeting && h("div", { style: { fontSize: "11px", color: B.info, marginBottom: 10, padding: "6px 10px", background: B.infoBg, borderRadius: "4px", border: "1px solid " + B.infoBd } }, "Linked to meeting: " + linkedMeeting.title + " (" + fmt(linkedMeeting.date) + ")"),
      h("div", { style: { fontSize: "13px", color: B.textSec, lineHeight: 1.6, padding: "12px 14px", background: B.raised, borderRadius: "6px", borderLeft: "3px solid " + B.accent }, dangerouslySetInnerHTML: { __html: note.text } })
    );
  };

  // Note Editor — edit existing note
  window.CRMNoteEditor = function({ ctx }) {
    var en = ctx.editNote; if (!en) return null;
    var project = ctx.projects.find(function(p) { return p.id === en.projectId; });
    if (!project) return null;
    var note = project.notes.find(function(n) { return n.id === en.noteId; });
    if (!note) return null;
    var [text, setText] = useState(note.text);
    var [author, setAuthor] = useState(note.author);
    var [linkedMeetingId, setLinkedMeetingId] = useState(note.linkedMeetingId || null);
    var meetings = project.meetings;

    return h(window.LTPModal, { title: "Edit Note", onClose: function() { ctx.setEditNote(null); }, disableBackdrop: true },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
        h(window.LTPSelect, { label: "Author", value: author, onChange: setAuthor, options: [{ value: window.LTP_CURRENT_USER || "User", label: window.LTP_CURRENT_USER || "User" }] }),
        meetings.length > 0 && h(window.LTPSelect, { label: "Link to Meeting (optional)", value: linkedMeetingId || "", onChange: function(v) { setLinkedMeetingId(v ? Number(v) : null); }, options: [{ value: "", label: "None" }].concat(meetings.map(function(m) { return { value: m.id, label: m.title + " (" + fmt(m.date) + ")" }; })) }),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("label", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Note"),
          h(window.RichTextEditor, { value: note.text, onChange: setText, placeholder: "Edit note..." })
        ),
        h(window.Btn, { onClick: function() {
          if (!text.trim()) return;
          ctx.setProjects(function(prev) { return prev.map(function(p) {
            if (p.id !== en.projectId) return p;
            // Update note
            var newNotes = p.notes.map(function(n) { return n.id === en.noteId ? Object.assign({}, n, { text: text, author: author, linkedMeetingId: linkedMeetingId }) : n; });
            // Update meeting links
            var newMeetings = p.meetings.map(function(m) {
              var ids = (m.linkedNoteIds || []).filter(function(id) { return id !== en.noteId; });
              if (linkedMeetingId === m.id) ids.push(en.noteId);
              return Object.assign({}, m, { linkedNoteIds: ids });
            });
            return Object.assign({}, p, { notes: newNotes, meetings: newMeetings });
          }); });
          ctx.setEditNote(null);
        } }, "Save Changes")
      )
    );
  };

  // Helper: Copy all notes for a project
  window.CRMCopyAllNotes = function(project) {
    if (!project || !project.notes.length) return;
    var text = project.notes.map(function(n) {
      return n.author + " \u2014 " + fmt(n.date) + "\n" + stripHtml(n.text);
    }).join("\n\n---\n\n");
    navigator.clipboard.writeText(project.name + " \u2014 Notes\n\n" + text);
  };

  // Helper: Print all notes for a project
  window.CRMPrintAllNotes = function(project) {
    if (!project || !project.notes.length) return;
    var w = window.open("", "_blank");
    w.document.write("<html><head><title>" + project.name + " Notes</title><style>body{font-family:sans-serif;padding:40px;max-width:700px;margin:auto;}h1{font-size:20px;margin:0 0 24px;}.note{margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid #ddd;}.meta{color:#666;font-size:13px;margin:0 0 8px;}.content{font-size:14px;line-height:1.7;}</style></head><body>");
    w.document.write("<h1>" + project.name + " \u2014 Notes</h1>");
    project.notes.forEach(function(n) {
      w.document.write("<div class='note'><p class='meta'>" + n.author + " \u2014 " + fmt(n.date) + "</p><div class='content'>" + n.text + "</div></div>");
    });
    w.document.write("</body></html>");
    w.document.close(); w.print();
  };
})();
