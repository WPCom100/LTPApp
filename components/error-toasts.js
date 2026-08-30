// LTP Toasts — fixed-position notification surface (bottom-right).
//
// Two event sources, one surface:
//   • `ltp-api-error`  — dispatched by recordError() in data-state.js for API
//                        sync failures. Rendered as a red error toast with the
//                        HTTP status + a body excerpt.
//   • `ltp-toast`      — general-purpose toasts (success / error / warn / info)
//                        dispatched via the window.LTP_toast(title, opts) helper
//                        below. Used by feature flows that want a non-blocking
//                        notification instead of a modal dialog (e.g. the
//                        QuickBooks push flow).
//
// Toasts stack newest-on-top, cap at MAX_VISIBLE, and auto-dismiss (errors
// linger longer than successes). The surface mounts inside the signed-in app
// (see app.js) so it's available on every screen.
//
// STICKY toasts (opts.sticky) carry no timer at all. A clock is right for
// "Quote sent" — you were there, you saw it happen. It is wrong for "this
// record changed in another window", which is not news about the past but a
// warning about the save you are about to make: nine seconds of it is nine
// seconds you might have spent at the coffee machine, and what you do when you
// come back is hit Save on a form you still believe is current. So a sticky
// toast ends exactly two ways — the reader dismisses it, or they navigate away
// from the page the warning was about, at which point it no longer describes
// anything on screen.
(function() {
  var h = React.createElement;

  // Per-variant auto-dismiss. Errors linger so the user can read the cause;
  // successes clear quickly. Sticky toasts opt out of this entirely.
  var DISMISS_MS = { error: 20000, warn: 9000, info: 7000, success: 5000 };
  var MAX_VISIBLE = 5;

  // ── Toast policy ──────────────────────────────────────────────────────────
  // Pure functions, no React: the component below is the only caller, and
  // tests/test_live_sync.js exercises them directly rather than mounting a DOM.

  // Which page we are on, ignoring the query string. Compared by value rather
  // than "did the hash change at all" so a sticky toast raised DURING a
  // navigation is judged against the page it names, not the one being left.
  function routePath() {
    try {
      return String((window.location && window.location.hash) || "")
        .replace(/^#\/?/, "").split("?")[0];
    } catch (e) { return ""; }
  }

  // null = no timer; this toast waits for a person.
  function dismissAfter(t) {
    if (!t || t.sticky) return null;
    return t.duration || DISMISS_MS[t.variant] || 9000;
  }

  function survivesNavigation(t, toPath) {
    if (!t || !t.sticky) return true;      // timed toasts keep their own clock
    return t.path === toPath;
  }

  // Two identical warnings say nothing the first one didn't, and live sync can
  // legitimately notice the same row moving more than once. Sticky toasts are
  // therefore deduplicated by content — the one already on screen is, by
  // definition, still unread.
  function dedupeKey(t) {
    return [t.variant, t.title || "", t.message || "", t.body || ""].join("\u0000");
  }
  function isDuplicate(list, t) {
    if (!t.sticky) return false;
    var key = dedupeKey(t);
    for (var i = 0; i < list.length; i++) {
      if (list[i].sticky && dedupeKey(list[i]) === key) return true;
    }
    return false;
  }

  // Over the cap, evict the oldest TIMED toast first. A sticky one is unread by
  // definition, and dropping it would be exactly the silent disappearance the
  // sticky mode exists to prevent — so those go only when nothing else is left.
  function evict(list) {
    var next = list.slice(), dropped = [];
    while (next.length > MAX_VISIBLE) {
      var i = 0;
      for (var k = 0; k < next.length; k++) { if (!next[k].sticky) { i = k; break; } }
      dropped.push(next[i]);
      next.splice(i, 1);
    }
    return { list: next, dropped: dropped };
  }

  // Monotonic id for keying toasts so React doesn't reuse DOM nodes when
  // an older toast disappears.
  var nextId = 1;

  // ── Public helper ─────────────────────────────────────────────────────────
  // window.LTP_toast("Sent to QuickBooks", { message: "...", variant: "success" })
  // variant ∈ {success, error, warn, info} (default info). `duration` (ms)
  // overrides the per-variant default. `sticky` drops the timer altogether —
  // see the note at the top of this file for when that is the right call.
  // Safe to call before the component mounts — the event simply has no listener
  // yet (rare; mount is early).
  window.LTP_toast = function(title, opts) {
    opts = opts || {};
    try {
      window.dispatchEvent(new CustomEvent("ltp-toast", {
        detail: {
          title: title || "",
          message: opts.message || "",
          variant: opts.variant || "info",
          duration: opts.duration,
          sticky: opts.sticky === true,
          at: new Date().toISOString(),
        }
      }));
    } catch (e) { /* CustomEvent unsupported — silently skip */ }
  };

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
    // The authoritative list. Three things mutate it — a new toast, a dismiss,
    // and a navigation — and the dedupe and eviction rules need to see the
    // others' results immediately rather than after a render, so the ref leads
    // and state exists only to draw it.
    var listRef = useRef([]);

    function commit(next, dropped) {
      (dropped || []).forEach(function(t) {
        if (timersRef.current[t.id]) {
          clearTimeout(timersRef.current[t.id]);
          delete timersRef.current[t.id];
        }
      });
      listRef.current = next;
      setToasts(next);
    }

    useEffect(function() {
      function add(toast) {
        if (isDuplicate(listRef.current, toast)) return;
        // Stamp the page this warning is about, so navigating away retires it
        // and navigating anywhere else does not.
        if (toast.sticky) toast.path = routePath();
        toast.id = nextId++;
        var res = evict(listRef.current.concat([toast]));
        commit(res.list, res.dropped);

        var dur = dismissAfter(toast);
        if (dur == null) return;          // sticky — dismissed by hand or by nav
        timersRef.current[toast.id] = setTimeout(function() {
          delete timersRef.current[toast.id];
          commit(listRef.current.filter(function(t) { return t.id !== toast.id; }));
        }, dur);
      }

      function onError(e) {
        var entry = (e && e.detail) || {};
        add({
          at: entry.at || new Date().toISOString(),
          variant: "error",
          title: entry.label || "API error",
          status: entry.status,
          body: entry.body,
          message: entry.error,
          // recordError() marks the entries that describe divergence rather
          // than plain failure — a lost race, a refused write. Those must not
          // time out; see the sticky note at the top of this file.
          sticky: entry.sticky === true,
        });
      }
      function onToast(e) {
        var d = (e && e.detail) || {};
        add({
          at: d.at || new Date().toISOString(),
          variant: d.variant || "info",
          title: d.title || "",
          message: d.message || "",
          duration: d.duration,
          sticky: d.sticky === true,
        });
      }
      // Leaving the page a sticky warning is about retires it: it described
      // what was on screen, and that is no longer on screen.
      function onNavigate() {
        var now = routePath();
        var next = listRef.current.filter(function(t) { return survivesNavigation(t, now); });
        if (next.length !== listRef.current.length) commit(next);
      }
      window.addEventListener("ltp-api-error", onError);
      window.addEventListener("ltp-toast", onToast);
      window.addEventListener("hashchange", onNavigate);
      return function() {
        window.removeEventListener("ltp-api-error", onError);
        window.removeEventListener("ltp-toast", onToast);
        window.removeEventListener("hashchange", onNavigate);
        Object.keys(timersRef.current).forEach(function(k) {
          clearTimeout(timersRef.current[k]);
        });
        timersRef.current = {};
      };
    }, []);

    function dismiss(id) {
      var gone = listRef.current.filter(function(t) { return t.id === id; });
      commit(listRef.current.filter(function(t) { return t.id !== id; }), gone);
    }

    if (toasts.length === 0) return null;

    function variantColor(v) {
      if (v === "success") return B.success || "#3fb950";
      if (v === "warn")    return B.warn || "#d29922";
      if (v === "info")    return B.info || "#58a6ff";
      return B.danger || "#e74c3c";
    }

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
      var color = variantColor(t.variant);
      var icon = t.variant === "success" ? "✓" : t.variant === "info" ? "i" : "!";
      // Solid (opaque) per-variant background so toasts are easy to read — a
      // translucent tint over the page content was the readability problem.
      var bg = t.variant === "success" ? (B.successBg || "#0f2a10")
             : t.variant === "warn"    ? (B.warnBg || "#2e2208")
             : t.variant === "info"    ? (B.infoBg || "#0f1a2e")
             : (B.dangerBg || "#2e0f0f");
      // Body excerpt: clip long server tracebacks so the toast stays small.
      var bodyExcerpt = t.body ? String(t.body).slice(0, 200) : null;
      var bodyTruncated = t.body && String(t.body).length > 200;
      var hasDetail = bodyExcerpt || t.message;
      return h("div", {
        key: t.id,
        style: {
          pointerEvents: "auto",
          width: 360,
          background: bg,
          border: "1px solid " + color,
          borderRadius: "8px",
          padding: "12px 14px",
          boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif",
          color: B.text || "#fff",
        }
      },
        h("div", { style: { display: "flex", alignItems: "flex-start", gap: 10, marginBottom: hasDetail ? 8 : 0 } },
          h("div", {
            style: {
              width: 22, height: 22, borderRadius: "50%",
              background: color + "33",
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0,
              fontSize: "12px", fontWeight: 700, color: color,
            }
          }, icon),
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.text || "#fff", wordBreak: "break-word" } }, t.title),
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
            background: B.bg || "#131C21",
            border: "1px solid " + (B.border || "#333"),
            borderRadius: "4px",
            padding: "6px 8px",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            maxHeight: 120, overflow: "auto",
          }
        }, bodyExcerpt + (bodyTruncated ? "…" : "")),
        !bodyExcerpt && t.message && h("div", {
          style: {
            fontSize: "11px", color: B.textSec || "#aaa", lineHeight: 1.4,
            wordBreak: "break-word",
          }
        }, String(t.message))
      );
    }));
  }

  window.LTPErrorToasts = ErrorToasts;

  // Test seam (tests/test_live_sync.js). Not used by the app.
  window.LTP_TOAST_POLICY = {
    routePath: routePath,
    dismissAfter: dismissAfter,
    survivesNavigation: survivesNavigation,
    isDuplicate: isDuplicate,
    evict: evict,
    MAX_VISIBLE: MAX_VISIBLE,
  };
})();
