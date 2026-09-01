// The "what changed" popup behind an entry in a document's revision log.
//
// Both builders had one, copy-pasted and then drifted: the quote version gained
// the entry's TIME and an empty-state message, the invoice version kept neither
// and used a narrower label column. That was not two designs — invoices store a
// time on every one of their activity-entry types and simply never rendered it,
// and clicking an entry with no recorded changes gave you a blank modal. This
// is the quote version, now shared, so the invoice side gains both.
//
// Presentational and stateless: it renders one entry and calls onClose. What
// puts an entry on screen, and what the entries mean, stays in the builders.
(function() {
  var h = React.createElement;
  var B = window.LTP_THEME;

  /**
   * props:
   *   entry    an activity record: { message, user, date, time, changes: [{cat, detail}] }
   *   onClose  () -> void
   */
  window.LTPActivityDetail = function LTPActivityDetail({ entry, onClose }) {
    if (!entry) return null;
    var changes = entry.changes || [];
    return h(window.LTPModal, { title: entry.message, onClose: onClose },
      // Who and when. The time matters more than it looks: several entries a
      // day is normal on an active document, so a date alone cannot tell you
      // which edit came first.
      h("div", { style: { marginBottom: 10, fontSize: "11px", color: B.textMut } },
        (entry.user || "") + " · "
        + (entry.date ? window.LTP_formatDate(entry.date) : "")
        + (entry.time ? " " + window.LTP_formatTime(entry.time) : "")
      ),
      h("div", { style: { display: "flex", flexDirection: "column", gap: 0 } },
        changes.map(function(ch, i) {
          return h("div", { key: i, style: { display: "flex", gap: 10, padding: "7px 0", borderBottom: "1px solid " + B.border } },
            h("div", { style: { width: 140, flexShrink: 0, fontSize: "11px", fontWeight: 600, color: B.accent } }, ch.cat),
            h("div", { style: { flex: 1, fontSize: "11px", color: B.textSec } }, ch.detail)
          );
        })
      ),
      // Say so, rather than showing an empty box. Older entries predate the
      // change log, so this is a normal thing to land on.
      changes.length === 0 && h("div", { style: { fontSize: "12px", color: B.textMut, fontStyle: "italic", padding: 16, textAlign: "center" } },
        "No detailed changes recorded.")
    );
  };
})();
