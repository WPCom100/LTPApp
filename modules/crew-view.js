// Public crew-facing view of a crew request.
//
// Rendered by app.js's outer LTPApp when route.module === "crew". Bypasses
// every auth gate — the token in the URL is the credential (mirrors
// modules/client-view.js for quotes/invoices).
//
//   #/crew/<token>   → this crew member's shifts on the request + Accept/Decline
//
// The crew member is identified by the token, so — unlike the quote client
// view — there is no name field and no signature: accept/decline just carries
// an optional comment. The backend (backend/routes/crew.py) drives the
// position status machine and locks the response once answered.
(function() {
  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var B = window.LTP_THEME;

  // Brand palette — same constants as modules/client-view.js so the two
  // public surfaces look like one product.
  var BLUE_OUT = "#233038";
  var ORANGE = "#EF5822";
  var BACKUP_ORANGE = "#F9B998";
  var FULL_UP_GRAY = "#D1DBDA";

  // ── Helpers ──────────────────────────────────────────────────────────────

  // Deterministic names — do NOT use toLocaleString({weekday,month}): on a JS
  // engine without full Intl/ICU data it emits fallback junk like
  // "Thu (month: July)" instead of "Thu, July".
  var _WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var _MONTHS = ["January", "February", "March", "April", "May", "June",
                 "July", "August", "September", "October", "November", "December"];

  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return iso;
    var day = d.getDate();
    var sfx = (day >= 11 && day <= 13) ? "th"
            : ({ 1: "st", 2: "nd", 3: "rd" }[day % 10] || "th");
    return _WEEKDAYS[d.getDay()] + ", " + _MONTHS[d.getMonth()] + " " + day + sfx + ", " + d.getFullYear();
  }

  function fmtTime(t) {
    if (!t) return "";
    var parts = String(t).split(":");
    if (parts.length < 2) return t;
    var hh = parseInt(parts[0], 10);
    var mm = parts[1];
    if (isNaN(hh)) return t;
    var ampm = hh >= 12 ? "PM" : "AM";
    var h12 = hh % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ":" + mm + " " + ampm;
  }

  function settingsAddress(s) {
    if (!s) return "";
    var line1 = (s.street || "") + (s.suite ? ", " + s.suite : "");
    var line2 = (s.city || "") + (s.state ? ", " + s.state : "") + (s.zip ? " " + s.zip : "");
    return [line1, line2].filter(function(p) { return p && p.trim(); }).join(". ");
  }

  // ── Accept / Decline form (comment only) ─────────────────────────────────

  function RespondForm(props) {
    // props: { kind: "accept" | "decline", token, onComplete(newStatus), onCancel }
    var [comment, setComment] = useState("");
    var [submitting, setSubmitting] = useState(false);
    var [error, setError] = useState(null);

    var isAccept = props.kind === "accept";

    function submit() {
      setError(null);
      setSubmitting(true);
      var body = {};
      if (comment.trim()) body.comment = comment.trim();
      fetch("/api/crew/" + props.token + "/" + props.kind, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(function(r) {
          if (!r.ok) {
            return r.text().then(function(t) {
              try {
                var parsed = JSON.parse(t);
                if (parsed && parsed.detail) {
                  if (typeof parsed.detail === "string") throw new Error(parsed.detail);
                  if (parsed.detail.message) throw new Error(parsed.detail.message);
                  if (parsed.detail.reason) throw new Error(parsed.detail.reason);
                }
              } catch (e) {
                if (e instanceof Error) throw e;
              }
              throw new Error("Server returned " + r.status);
            });
          }
          return r.json();
        })
        .then(function(resp) { if (props.onComplete) props.onComplete(resp.status); })
        .catch(function(e) {
          setError(String(e.message || e));
          setSubmitting(false);
        });
    }

    var title = isAccept ? "Accept this request" : "Decline this request";
    var ctaLabel = isAccept ? "Confirm Accept" : "Confirm Decline";
    var ctaColor = isAccept ? "#4CAF50" : "#E74C3C";

    return h("div", {
      style: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 4000, padding: 20 }
    },
      h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "10px", padding: 24, maxWidth: 480, width: "100%", maxHeight: "90vh", overflowY: "auto" } },
        h("div", { style: { fontSize: "18px", fontWeight: 700, color: B.text, marginBottom: 4 } }, title),
        h("div", { style: { fontSize: "12px", color: B.textMut, marginBottom: 20 } },
          isAccept ? "We'll let the production team know you're confirmed for these shifts."
                   : "If you can't make some or all of these shifts, let us know which ones (or the whole request) — it helps us re-staff."),

        h("label", { style: { display: "block", fontSize: "10px", color: B.textMut, marginBottom: 4, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" } }, "Comment (optional)"),
        h("textarea", {
          value: comment,
          onChange: function(e) { setComment(e.target.value); },
          maxLength: 1000,
          placeholder: isAccept
            ? "Anything the team should know"
            : "e.g. I can't do the Saturday load-in but the rest works — or I'm unavailable for all of these",
          style: { width: "100%", minHeight: 70, background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px 10px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", marginBottom: 14, resize: "vertical" }
        }),

        error && h("div", { style: { marginBottom: 14, padding: "8px 12px", background: (B.dangerBg || "#3a1a1a"), border: "1px solid " + (B.dangerBd || "#E74C3C"), borderRadius: "6px", color: B.danger || "#E74C3C", fontSize: "12px" } }, error),

        h("div", { style: { display: "flex", gap: 10, justifyContent: "flex-end" } },
          h("button", {
            type: "button",
            onClick: props.onCancel,
            disabled: submitting,
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "8px 16px", color: B.textSec, fontSize: "12px", cursor: submitting ? "wait" : "pointer", fontFamily: "inherit" }
          }, "Cancel"),
          h("button", {
            type: "button",
            onClick: submit,
            disabled: submitting,
            style: { background: ctaColor, border: "none", borderRadius: "6px", padding: "8px 20px", color: "#fff", fontSize: "12px", fontWeight: 700, cursor: submitting ? "wait" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.6 : 1 }
          }, submitting ? "Submitting…" : ctaLabel)
        )
      )
    );
  }

  // ── Shift card ───────────────────────────────────────────────────────────

  function renderShift(s, i) {
    var timeRange = [fmtTime(s.startTime), fmtTime(s.endTime)].filter(function(x) { return x; }).join(" – ");
    // Stacked (not two-column): role, then date · time, then the day
    // description beneath the times — keeps each line short so nothing wraps.
    var dateTime = [fmtDate(s.date), timeRange].filter(function(x) { return x; }).join("  ·  ");
    var desc = [s.shiftTitle, s.department].filter(function(x) { return x; }).join("  ·  ");
    return h("div", { key: s.positionId || i, style: { padding: "12px 16px", background: "#2a3a42", border: "1px solid #3a4a52", borderLeft: "3px solid " + BACKUP_ORANGE, borderRadius: "8px", marginBottom: 8 } },
      h("div", { style: { fontSize: "14px", fontWeight: 700, color: "#fff" } }, s.roleLabel || "Crew"),
      dateTime && h("div", { style: { fontSize: "12px", fontWeight: 600, color: BACKUP_ORANGE, marginTop: 3 } }, dateTime),
      desc && h("div", { style: { fontSize: "11px", color: FULL_UP_GRAY, marginTop: 2 } }, desc)
    );
  }

  // ── Main component ───────────────────────────────────────────────────────

  window.LTPCrewView = function(props) {
    var token = props.route && props.route.id;

    var [data, setData] = useState(null);
    var [loadErr, setLoadErr] = useState(null);
    var [showAccept, setShowAccept] = useState(false);
    var [showDecline, setShowDecline] = useState(false);

    function reload() {
      if (!token) { setLoadErr("No request token in this link."); return; }
      fetch("/api/crew/" + token)
        .then(function(r) {
          if (r.status === 404) throw new Error("This crew request link is invalid or has been removed.");
          if (!r.ok) throw new Error("Server returned " + r.status);
          return r.json();
        })
        .then(function(d) { setData(d); setLoadErr(null); })
        .catch(function(e) { setLoadErr(String(e.message || e)); });
    }

    useEffect(reload, [token]);

    // The app shell sets `body { overflow: hidden }`; this public page is a
    // normal scrolling document. Re-enable body scroll while mounted, restore
    // on unmount (same pattern as modules/client-view.js).
    useEffect(function() {
      var prev = document.body.style.overflow;
      document.body.style.overflow = "auto";
      return function() { document.body.style.overflow = prev; };
    }, []);

    if (!data && !loadErr) {
      return h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: BLUE_OUT, color: FULL_UP_GRAY, fontFamily: "'DM Sans', sans-serif", fontSize: "13px" } }, "Loading…");
    }
    if (loadErr) {
      return h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: BLUE_OUT, padding: 30, fontFamily: "'DM Sans', sans-serif" } },
        h("div", { style: { maxWidth: 420, textAlign: "center", color: FULL_UP_GRAY } },
          h("div", { style: { fontSize: "20px", fontWeight: 700, marginBottom: 10 } }, "Not available"),
          h("div", { style: { fontSize: "13px", color: "#8899a0" } }, loadErr))
      );
    }

    var status = data.status;
    var crewName = data.crewName;
    var project = data.project || {};
    var shifts = data.shifts || [];
    var settings = data.settings || {};
    var terminal = status !== "pending";

    var dateRange = [fmtDate(project.startDate), fmtDate(project.endDate)]
      .filter(function(x) { return x; });
    var dateLine = dateRange.length === 2 && dateRange[0] !== dateRange[1]
      ? dateRange[0] + " – " + dateRange[1]
      : (dateRange[0] || "");

    // Terminal banner content
    var banner = null;
    if (status === "accepted") {
      banner = { color: "#4CAF50", label: "✓ You accepted this request", note: "You're confirmed pending final scheduling. Thank you!" };
    } else if (status === "declined") {
      banner = { color: "#E74C3C", label: "✗ You declined this request", note: "Thanks for letting us know." };
    } else if (status === "withdrawn") {
      banner = { color: "#8899a0", label: "This request has been withdrawn", note: "The production team withdrew this request. No action is needed." };
    }

    return h("div", { style: { minHeight: "100vh", background: BLUE_OUT, color: FULL_UP_GRAY, fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif", padding: "0 0 40px" } },
      h("div", { style: { maxWidth: 720, margin: "0 auto", padding: "30px 24px 0" } },
        // Top gradient bar
        h("div", { style: { height: 4, background: "linear-gradient(90deg, #FF921E 0%, #EF5822 50%, #64260F 100%)", borderRadius: "2px", marginBottom: 18 } }),

        // Company header + CREW REQUEST tag
        h("div", { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, marginBottom: 20 } },
          h("div", { style: { fontSize: "20px", fontWeight: 800, color: ORANGE, lineHeight: 1.1, letterSpacing: "0.02em" } },
            (settings.companyName || "LTP").toUpperCase(),
            h("div", { style: { fontSize: "10px", color: FULL_UP_GRAY, marginTop: 4, fontWeight: 400, letterSpacing: 0 } },
              settingsAddress(settings),
              settings.phone && h("div", null, settings.phone))
          ),
          h("div", { style: { fontSize: "11px", fontWeight: 800, color: BLUE_OUT, background: BACKUP_ORANGE, padding: "5px 12px", borderRadius: "6px", letterSpacing: "0.08em", whiteSpace: "nowrap" } }, "CREW REQUEST")
        ),

        // Greeting
        crewName && h("div", { style: { fontSize: "15px", color: "#fff", fontWeight: 700, marginBottom: 4 } }, "Hi " + crewName + ","),
        h("div", { style: { fontSize: "13px", color: FULL_UP_GRAY, marginBottom: 18 } },
          terminal ? "Here are the shifts on this request:" : "You've been requested for the following shifts:"),

        // Project block
        h("div", { style: { marginBottom: 20 } },
          h("div", { style: { fontSize: "22px", fontWeight: 800, color: "#fff", letterSpacing: "0.02em", marginBottom: 4 } }, (project.name || "Project").toUpperCase()),
          h("div", { style: { fontSize: "12px", color: BACKUP_ORANGE } },
            [project.venue, dateLine].filter(function(x) { return x; }).join("  ·  "))
        ),

        h("div", { style: { height: 1, background: "#3a4a52", margin: "6px 0 20px" } }),

        // Shifts
        shifts.length === 0
          ? h("div", { style: { fontSize: "12px", color: "#8899a0", fontStyle: "italic", marginBottom: 20 } }, "No shifts are attached to this request.")
          : shifts.map(renderShift),

        // Comment they left (terminal)
        terminal && data.comment && h("div", { style: { marginTop: 16, fontSize: "12px", color: FULL_UP_GRAY, fontStyle: "italic" } }, "Your note: \"" + data.comment + "\""),

        // Action area
        h("div", { style: { marginTop: 30, padding: 20, background: "#1a2429", borderRadius: "10px", border: "1px solid #3a4a52" } },
          banner
            ? h("div", null,
                h("div", { style: { fontSize: "15px", fontWeight: 700, color: banner.color, marginBottom: 6 } }, banner.label),
                h("div", { style: { fontSize: "12px", color: FULL_UP_GRAY } }, banner.note))
            : h("div", null,
                h("div", { style: { fontSize: "12px", color: FULL_UP_GRAY, textAlign: "center", marginBottom: 16 } }, "Can you take these shifts?"),
                h("div", { style: { display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" } },
                  h("button", {
                    type: "button",
                    onClick: function() { setShowAccept(true); },
                    style: { background: "#4CAF50", border: "none", borderRadius: "8px", padding: "12px 28px", color: "#000", fontSize: "14px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }
                  }, "✓ Accept"),
                  h("button", {
                    type: "button",
                    onClick: function() { setShowDecline(true); },
                    style: { background: "transparent", border: "2px solid #E74C3C", borderRadius: "8px", padding: "10px 24px", color: "#E74C3C", fontSize: "14px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }
                  }, "Decline")
                ))
        )
      ),

      showAccept && h(RespondForm, {
        kind: "accept", token: token,
        onComplete: function() { setShowAccept(false); reload(); },
        onCancel: function() { setShowAccept(false); },
      }),
      showDecline && h(RespondForm, {
        kind: "decline", token: token,
        onComplete: function() { setShowDecline(false); reload(); },
        onCancel: function() { setShowDecline(false); },
      })
    );
  };
})();
