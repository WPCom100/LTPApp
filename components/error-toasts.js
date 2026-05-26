// LTP Error Toasts — fixed-position UI surface for API sync failures.
//
// Listens for `ltp-api-error` CustomEvents dispatched by recordError() in
// components/data-state.js. Each event becomes a red toast card in the
// bottom-right corner, stacked newest-on-top, auto-dismissed after 20s.
// Failures pile up here even during the initial loading gate, so the user
// sees connection problems immediately on first paint.
(function() {
  var h = React.createElement;

  var AUTO_DISMISS_MS = 20000;
  var MAX_VISIBLE = 5;

  // Monotonic id for keying toasts so React doesn't reuse DOM nodes when
  // an older toast disappears.
  var nextId = 1;

  function formatTime(iso) {
    try {
      var d = new Date(iso);
      var hh = String(d.getHours()).padStart(2, "0");
      var mm = String(d.getMinutes()).padStart(2, "0");
      var ss = String(d.getSeconds()).padStart(2, "0");
      return hh + ":" + mm + ":" + ss;
    } catch (e) { return ""; }
  }

  function ErrorToasts() {
    var useState  = React.useState;
    var useEffect = React.useEffect;
    var useRef    = React.useRef;
    var B = window.LTP_THEME || {};

    var pair = useState([]);
    var toasts = pair[0], setToasts = pair[1];
    // Hold the active dismiss timers so cleanup is clean on unmount.
    var timersRef = useRef({});

    useEffect(function() {
      function onError(e) {
        var entry = (e && e.detail) || {};
        var id = nextId++;
        var toast = {
          id: id,
          at: entry.at || new Date().toISOString(),
          label: entry.label || "API error",
          status: entry.status,
          body: entry.body,
          error: entry.error,
        };
        setToasts(function(prev) {
          var next = prev.concat([toast]);
          // Drop oldest if over the cap. We slice from the tail so the
          // newest 5 are always visible.
          if (next.length > MAX_VISIBLE) {
            var dropped = next.slice(0, next.length - MAX_VISIBLE);
            dropped.forEach(function(t) {
              if (timersRef.current[t.id]) {
                clearTimeout(timersRef.current[t.id]);
                delete timersRef.current[t.id];
              }
            });
            next = next.slice(next.length - MAX_VISIBLE);
          }
          return next;
        });
        timersRef.current[id] = setTimeout(function() {
          delete timersRef.current[id];
          setToasts(function(prev) {
            return prev.filter(function(t) { return t.id !== id; });
          });
        }, AUTO_DISMISS_MS);
      }
      window.addEventListener("ltp-api-error", onError);
      return function() {
        window.removeEventListener("ltp-api-error", onError);
        Object.keys(timersRef.current).forEach(function(k) {
          clearTimeout(timersRef.current[k]);
        });
        timersRef.current = {};
      };
    }, []);

    function dismiss(id) {
      if (timersRef.current[id]) {
        clearTimeout(timersRef.current[id]);
        delete timersRef.current[id];
      }
      setToasts(function(prev) {
        return prev.filter(function(t) { return t.id !== id; });
      });
    }

    if (toasts.length === 0) return null;

    return h("div", {
      style: {
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 3000,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxWidth: 380,
        pointerEvents: "none",  // children re-enable so the page below stays clickable
      }
    }, toasts.map(function(t) {
      // Body excerpt: clip long server tracebacks so the toast stays small.
      var bodyExcerpt = t.body ? String(t.body).slice(0, 200) : null;
      var bodyTruncated = t.body && String(t.body).length > 200;
      return h("div", {
        key: t.id,
        style: {
          pointerEvents: "auto",
          width: 360,
          background: B.dangerBg || "#2e0f0f",
          border: "1px solid " + (B.danger || "#e74c3c"),
          borderRadius: "8px",
          padding: "12px 14px",
          boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif",
          color: B.text || "#fff",
        }
      },
        h("div", { style: { display: "flex", alignItems: "flex-start", gap: 10, marginBottom: (bodyExcerpt || t.error) ? 8 : 0 } },
          h("div", {
            style: {
              width: 22, height: 22, borderRadius: "50%",
              background: (B.danger || "#e74c3c") + "33",
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0,
              fontSize: "12px", fontWeight: 700, color: B.danger || "#e74c3c",
            }
          }, "!"),
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.text || "#fff", wordBreak: "break-word" } }, t.label),
            h("div", { style: { fontSize: "10px", color: B.textMut || "#666", marginTop: 2 } },
              (t.status != null ? "HTTP " + t.status + " · " : "") + formatTime(t.at))
          ),
          h("button", {
            onClick: function() { dismiss(t.id); },
            "aria-label": "Dismiss",
            style: {
              background: "transparent", border: "none", color: B.textMut || "#888",
              fontSize: "16px", lineHeight: 1, cursor: "pointer", padding: "0 0 0 8px",
              fontFamily: "inherit", flexShrink: 0,
            }
          }, "✕")
        ),
        bodyExcerpt && h("pre", {
          style: {
            margin: 0, fontSize: "10px", lineHeight: 1.4,
            color: B.textSec || "#aaa",
            background: B.bg || "#000",
            border: "1px solid " + (B.border || "#333"),
            borderRadius: "4px",
            padding: "6px 8px",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            maxHeight: 120, overflow: "auto",
          }
        }, bodyExcerpt + (bodyTruncated ? "…" : "")),
        !bodyExcerpt && t.error && h("div", {
          style: {
            fontSize: "11px", color: B.textSec || "#aaa", lineHeight: 1.4,
            wordBreak: "break-word",
          }
        }, String(t.error))
      );
    }));
  }

  window.LTPErrorToasts = ErrorToasts;
})();
