// CRM Notes — Add, View, Edit, Print, Copy, Meeting linking
(function() {
  var B = window.LTP_THEME, h = React.createElement, useState = React.useState, fmt = window.LTP_formatDate;

  // Capture the sanitizer at module load. Closure-bound so the print-window
  // popup (which runs in its own Document) can still access it via the
  // parent's scope. NEVER write user-controlled HTML to the DOM without
  // running it through purify().
  var purify = function(s) { return window.LTP_SANITIZE.html(s); };

  // Strip HTML for plain text copy. innerHTML write here is safe — we never
  // read .innerHTML back, only .textContent, and the div is detached. The
  // browser doesn't execute scripts inserted via innerHTML on a detached node.
  function stripHtml(html) { var tmp = document.createElement("div"); tmp.innerHTML = html; return tmp.textContent || tmp.innerText || ""; }

  // Escape a string for safe use inside an HTML attribute or text node when
  // we're writing to document.write (a print window) where React isn't doing
  // it for us. Used for project name + author + date in print headers.
  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

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
        meetings.length > 0 && h(window.LTPSearchSelect, { label: "Link to Meeting (optional)", value: linkedMeetingId || "",
          onChange: function(v) { setLinkedMeetingId(v === "" ? null : Number(v)); },
          searchPlaceholder: "Search meetings\u2026",
          options: [{ value: "", label: "None" }].concat(meetings.map(function(m) { return { value: m.id, label: m.title, sublabel: fmt(m.date) }; })) }),
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
    // EVERY hook runs before the first early return. React counts hooks per
    // render of the same fiber: this component is re-rendered (not remounted)
    // whenever `projects` changes, because ctx.viewNote is ProjectsView state
    // that a remote delete never clears. Returning null above a useState made a
    // note deleted in another window render fewer hooks than the render before
    // it, which React throws on — and the "Projects" error boundary then blanked
    // the whole page.
    var [copied, setCopied] = useState(false);

    var vn = ctx.viewNote;
    var project = vn ? ctx.projects.find(function(p) { return p.id === vn.projectId; }) : null;
    var note = (vn && project && project.notes)
      ? project.notes.find(function(n) { return n.id === vn.noteId; }) : null;
    if (!vn || !project || !note) return null;
    var linkedMeeting = note.linkedMeetingId ? project.meetings.find(function(m) { return m.id === note.linkedMeetingId; }) : null;

    function copyNote() {
      var plain = stripHtml(note.text);
      var header = note.author + " \u2014 " + fmt(note.date) + (linkedMeeting ? " (Meeting: " + linkedMeeting.title + ")" : "") + "\n\n";
      navigator.clipboard.writeText(header + plain).then(function() { setCopied(true); setTimeout(function() { setCopied(false); }, 2000); });
    }
    function printNote() {
      var w = window.open("", "_blank");
      // Sanitize note body; escape header fields (plain-text-only attrs/text).
      var safeBody = purify(note.text);
      var safeName = escAttr(project.name || "");
      var safeAuthor = escAttr(note.author);
      var safeDate = escAttr(fmt(note.date));
      var safeMeetingSuffix = linkedMeeting ? " | Meeting: " + escAttr(linkedMeeting.title) : "";
      w.document.write("<html><head><title>Note</title><style>body{font-family:sans-serif;padding:40px;max-width:700px;margin:auto;}h2{margin:0 0 4px;}p.meta{color:#666;font-size:13px;margin:0 0 16px;}.content{font-size:14px;line-height:1.7;}</style></head><body>");
      w.document.write("<h2>" + safeName + "</h2>");
      w.document.write("<p class='meta'>" + safeAuthor + " \u2014 " + safeDate + safeMeetingSuffix + "</p>");
      w.document.write("<div class='content'>" + safeBody + "</div>");
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
      h("div", { style: { fontSize: "13px", color: B.textSec, lineHeight: 1.6, padding: "12px 14px", background: B.raised, borderRadius: "6px", borderLeft: "3px solid " + B.accent }, dangerouslySetInnerHTML: { __html: purify(note.text) } })
    );
  };

  // Note Editor — edit existing note
  window.CRMNoteEditor = function({ ctx }) {
    // EVERY hook runs before the first early return — see CRMNoteViewer above for
    // why. This one mattered twice over: the record watch below exists precisely
    // to warn that the note was deleted elsewhere, and it sat underneath the
    // early return that the deletion triggered, so it could never fire.
    var en = ctx.editNote;
    var project = en ? ctx.projects.find(function(p) { return p.id === en.projectId; }) : null;
    var note = (en && project && project.notes)
      ? project.notes.find(function(n) { return n.id === en.noteId; }) : null;

    var [text, setText] = useState(note ? note.text : "");
    var [author, setAuthor] = useState(note ? note.author : "");
    var [linkedMeetingId, setLinkedMeetingId] = useState(note ? (note.linkedMeetingId || null) : null);
    // Notes live inside the project row, so watch just THIS note — an unrelated
    // change elsewhere in the project is not this editor's business. `pick`
    // returning null means the note itself was deleted in another window, which
    // is worth saying. See theme.js::LTP_useRecordWatch.
    window.LTP_useRecordWatch("projects", en && en.projectId,
      { title: "This note changed elsewhere",
        message: "Another window updated it while this form was open. Saving will replace the newer version." },
      function(p) {
        return (p.notes || []).find(function(x) { return x.id === (en && en.noteId); }) || null;
      });

    if (!en || !project || !note) return null;   // after every hook, never before
    var meetings = project.meetings;

    return h(window.LTPModal, { title: "Edit Note", onClose: function() { ctx.setEditNote(null); }, disableBackdrop: true },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
        h(window.LTPSelect, { label: "Author", value: author, onChange: setAuthor, options: [{ value: window.LTP_CURRENT_USER || "User", label: window.LTP_CURRENT_USER || "User" }] }),
        meetings.length > 0 && h(window.LTPSearchSelect, { label: "Link to Meeting (optional)", value: linkedMeetingId || "",
          onChange: function(v) { setLinkedMeetingId(v === "" ? null : Number(v)); },
          searchPlaceholder: "Search meetings\u2026",
          options: [{ value: "", label: "None" }].concat(meetings.map(function(m) { return { value: m.id, label: m.title, sublabel: fmt(m.date) }; })) }),
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
    var safeProjectName = escAttr(project.name);
    w.document.write("<html><head><title>" + safeProjectName + " Notes</title><style>body{font-family:sans-serif;padding:40px;max-width:700px;margin:auto;}h1{font-size:20px;margin:0 0 24px;}.note{margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid #ddd;}.meta{color:#666;font-size:13px;margin:0 0 8px;}.content{font-size:14px;line-height:1.7;}</style></head><body>");
    w.document.write("<h1>" + safeProjectName + " \u2014 Notes</h1>");
    project.notes.forEach(function(n) {
      w.document.write("<div class='note'><p class='meta'>" + escAttr(n.author) + " \u2014 " + escAttr(fmt(n.date)) + "</p><div class='content'>" + purify(n.text) + "</div></div>");
    });
    w.document.write("</body></html>");
    w.document.close(); w.print();
  };
})();
