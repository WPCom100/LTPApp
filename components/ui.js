// Core UI Components
(function() {
  var B = window.LTP_THEME, SC = window.LTP_STATUS_COLORS, h = React.createElement, useState = React.useState, useRef = React.useRef;

  // ── Shared mobile breakpoint ───────────────────────────────────────────────
  // One source of truth for "are we on a phone-width screen", matching the
  // 600px breakpoint the public crew/client views and the index.html mobile
  // CSS layer use. window.LTP_useIsMobile() is a React hook that re-renders on
  // viewport crossing the breakpoint; components branch inline styles / choose
  // card-vs-table / agenda-vs-grid on it. Desktop ( > 600px ) → false.
  window.LTP_MOBILE_QUERY = "(max-width: 600px)";
  // Generic matchMedia hook: returns whether `query` currently matches and
  // re-renders when it crosses. LTP_useIsMobile is the mobile-width
  // specialization; other views pass their own query (e.g. a wide-desktop
  // breakpoint) to branch layout on viewport size.
  window.LTP_useMediaQuery = function(query) {
    var useEffect = React.useEffect;
    function read() {
      try { return window.matchMedia(query).matches; }
      catch (e) { return false; }
    }
    var pair = useState(read);
    var matches = pair[0], setMatches = pair[1];
    useEffect(function() {
      var m;
      try { m = window.matchMedia(query); } catch (e) { return; }
      function onChange() { setMatches(m.matches); }
      // addEventListener is the modern API; addListener is the Safari < 14
      // fallback (older iOS still in the field for a home-screen PWA).
      if (m.addEventListener) m.addEventListener("change", onChange);
      else if (m.addListener) m.addListener(onChange);
      onChange();
      return function() {
        if (m.removeEventListener) m.removeEventListener("change", onChange);
        else if (m.removeListener) m.removeListener(onChange);
      };
    }, [query]);
    return matches;
  };
  window.LTP_useIsMobile = function() { return window.LTP_useMediaQuery(window.LTP_MOBILE_QUERY); };

  window.Badge = function({ status }) {
    var c = SC[status] || SC.draft;
    return h("span", { style: { background: c.bg, color: c.text, border: "1px solid " + c.bd, padding: "2px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap" } }, status);
  };

  // Primary buttons wear the brand gradient + hover lift from the customer
  // views (classes ltp-btn-primary / ltp-btn-quiet live in index.html).
  window.Btn = function({ children, onClick, variant, small, disabled, style: sx }) {
    variant = variant || "primary";
    var base = { border: "none", borderRadius: "8px", fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer", fontSize: small ? "11px" : "12px", padding: small ? "4px 11px" : "8px 18px", letterSpacing: "0.02em", fontFamily: "inherit" };
    var v = {
      primary: { background: B.gradBtn, color: B.btnInk, boxShadow: "0 2px 10px rgba(239,88,34,0.22)" },
      ghost: { background: "transparent", color: B.textSec, border: "1px solid " + B.border },
      danger: { background: B.dangerBg, color: B.danger, border: "1px solid " + B.dangerBd },
    };
    var disabledStyle = disabled ? { opacity: 0.5, pointerEvents: "none", boxShadow: "none" } : {};
    return h("button", {
      onClick: disabled ? undefined : onClick,
      disabled: !!disabled,
      // Hover micro-moments come from CSS classes so they never "light up"
      // a disabled button.
      className: disabled ? undefined : (variant === "primary" ? "ltp-btn-primary" : "ltp-btn-quiet"),
      style: Object.assign({}, base, v[variant], disabledStyle, sx),
    }, children);
  };

  // ── Ruled list — the customer views' call-sheet / ledger treatment ───────
  // Replaces the stack-of-rounded-cards look on list screens: one flat panel
  // a step above the page field, bounded by brand-orange rules, with rows
  // separated by hairlines. Hairline + hover rules live in index.html
  // (.ltp-list / .ltp-row) so the last row drops its hairline automatically
  // and hover never needs JS handlers.
  //
  //   h(window.LTPList, null, items.map(function(it) {
  //     return h(window.LTPRow, { key: it.id, onClick: ..., style: {...} }, ...);
  //   }))
  window.LTPList = function({ children, style: sx }) {
    return h("div", { className: "ltp-list", style: Object.assign({ background: B.surface, borderTop: "1px solid " + B.border, borderBottom: "1px solid " + B.border }, sx) }, children);
  };
  window.LTPRow = function({ onClick, style: sx, children }) {
    return h("div", {
      onClick: onClick,
      className: "ltp-row" + (onClick ? " ltp-row-click" : ""),
      style: Object.assign({ padding: "13px 16px", cursor: onClick ? "pointer" : "default" }, sx),
    }, children);
  };

  // ── Loading — the orange shimmer bar from the customer-facing pages ──────
  // LTPLoadingBar: inline shimmer + optional quiet label underneath.
  // LTPLoadingScreen: full-height centered version for app-level gates.
  window.LTPLoadingBar = function({ label, width }) {
    return h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center" } },
      h("div", { className: "ltp-shimmer", style: { height: 4, width: width || 120, borderRadius: 2 } }),
      label && h("div", { style: { fontSize: "13px", color: B.textSec, marginTop: 14, textAlign: "center" } }, label));
  };
  window.LTPLoadingScreen = function({ label }) {
    return h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: "100dvh", background: B.bg, fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif" } },
      h(window.LTPLoadingBar, { label: label || "Loading…" }));
  };

  // ── Phone formatting ─────────────────────────────────────────────────────
  window.LTP_formatPhone = function(raw) {
    if (!raw) return "";
    var digits = raw.replace(/\D/g, "");
    if (digits.length === 11 && digits[0] === "1") digits = digits.substring(1);
    if (digits.length === 10) return "(" + digits.substring(0, 3) + ") " + digits.substring(3, 6) + "-" + digits.substring(6);
    if (digits.length === 7) return digits.substring(0, 3) + "-" + digits.substring(3);
    return raw; // return as-is if we can't parse it
  };

  window.LTP_isValidEmail = function(email) {
    if (!email) return true; // empty is OK (not required by default)
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  window.LTP_isValidPhone = function(phone) {
    if (!phone) return true;
    var digits = phone.replace(/\D/g, "");
    return digits.length === 7 || digits.length === 10 || digits.length === 11;
  };

  // ── Shared field label ────────────────────────────────────────────────────
  // Every labelled form control in the app — LTPInput, LTPSelect,
  // LTPSearchSelect and the chip search fields in components/search-select.js —
  // renders its label through here.
  //
  // WHY IT'S SHARED, AND WHY THE HEIGHT IS FIXED
  //   Fields sit side by side in CSS grids (the Company / Primary Contact row
  //   on a quote, Invoice Date / Due Date, half the entity forms). A grid cell
  //   starts at the top of the row, so two neighbours line up only if their
  //   LABELS are exactly the same height. Each component used to spell its own
  //   label out inline, and they had drifted: some rendered a bare <label>
  //   (whose height is whatever line-height the loaded font happens to give an
  //   11px string), and the ones carrying a ＋/✎ action grew a 26px row to fit
  //   the button — which pushed that field's control ~13px below its
  //   neighbour's and made the quote/invoice header read as staggered.
  //
  //   So: one explicit LABEL_H for the row, and `action` is scaled to fit
  //   INSIDE it rather than being allowed to stretch it. A field needing a
  //   bigger action affordance should put it in the control (the way the chip
  //   fields do), not in the label.
  var LABEL_H = 16;
  var LABEL_TEXT = { fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", lineHeight: LABEL_H + "px" };
  window.LTP_FIELD_LABEL_HEIGHT = LABEL_H;
  window.LTPFieldLabel = function({ label, action, color }) {
    if (label == null && !action) return null;
    return h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, height: LABEL_H } },
      h("label", { style: Object.assign({}, LABEL_TEXT, { color: color || B.textMut, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }) }, label || ""),
      action || null);
  };

  // inputMode/step/enterKeyHint/autoComplete pass straight through to the
  // control so callers can request the right iOS keyboard (inputMode:"decimal"
  // for currency, "numeric" for counts, "tel"/"email"), without every field
  // needing a bespoke element. Unset props are simply undefined (ignored).
  window.LTPInput = function({ label, value, onChange, placeholder, type, textarea, style: sx, validate, onBlur: onBlurProp, inputMode, step, enterKeyHint, autoComplete }) {
    var [touched, setTouched] = useState(false);
    var error = touched && validate ? validate(value) : null;
    var borderColor = error ? B.danger : B.border;
    // Inputs recede below the card (page-field fill) and warm to the brand
    // orange on focus — the customer views' field treatment.
    var fs = { width: "100%", minWidth: 0, boxSizing: "border-box", background: B.bg, border: "1px solid " + borderColor, borderRadius: "8px", padding: "8px 12px", color: B.text, fontSize: "13px", fontFamily: "inherit", outline: "none", transition: "border-color 0.15s" };
    function handleFocus(e) {
      if (!error) e.target.style.borderColor = B.accent;
    }
    function handleBlur(e) {
      var err = validate ? validate(value) : null;
      e.target.style.borderColor = err ? B.danger : B.border;
      setTouched(true);
      if (onBlurProp) onBlurProp(value);
    }
    // Number fields: show a 0 value as an empty field (with a "0" placeholder)
    // so the user types into a blank box instead of fighting a stuck leading
    // zero, and can clear it back to empty. select-on-focus (theme.js, global)
    // also lets a non-zero value be overtyped without manual deleting.
    var isNum = (type === "number");
    var shownValue = (isNum && (value === 0 || value === "0")) ? "" : value;
    var shownPlaceholder = (isNum && (placeholder == null || placeholder === "")) ? "0" : placeholder;
    return h("div", { style: Object.assign({ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }, sx) },
      label && h(window.LTPFieldLabel, { label: label, color: error ? B.danger : B.textMut }),
      textarea ? h("textarea", { value: value, onChange: function(e) { onChange(e.target.value); }, onFocus: handleFocus, onBlur: handleBlur, placeholder: placeholder, rows: 3, enterKeyHint: enterKeyHint, autoComplete: autoComplete, style: Object.assign({}, fs, { resize: "vertical" }) })
               : h("input", { type: type || "text", value: shownValue, onChange: function(e) { onChange(e.target.value); }, onFocus: handleFocus, onBlur: handleBlur, placeholder: shownPlaceholder, inputMode: inputMode, step: step, enterKeyHint: enterKeyHint, autoComplete: autoComplete, style: fs }),
      error && h("div", { style: { fontSize: "9px", color: B.danger, marginTop: 1 } }, error)
    );
  };

  // ── Deferred-commit date / time fields ────────────────────────────────────
  // Bare <input type="date"> and <input type="time"> that hold keyboard edits
  // locally and only publish them when the field is done being edited.
  //
  // Why: a native date/time input emits a value on EVERY segment keystroke, and
  // the in-between values are garbage — a half-typed year reads as
  // "0002-08-14", a half-typed hour reads as "01:00" on the way to "11:00", and
  // any incomplete value reads as "" (empty). A parent that re-orders or
  // re-groups its rows off that value re-renders the row out from under the
  // caret. The schedule editor does exactly that twice over: it groups rows by
  // day (so a half-typed date lands under "Unscheduled") and sorts the rows
  // within a day by start time (so a half-typed hour jumps the row past its
  // neighbours). The field is moved — or torn down and rebuilt — mid-word, so
  // it deselects after a single digit and the value can never be typed through.
  //
  // Buffering while the user types keeps the caret and the row put. The value
  // is published on blur, on Enter, and immediately for a pick from the
  // browser's calendar/clock popup (a change with no keystroke behind it) — so
  // the picker still feels instant. Escape drops the buffer and restores the
  // committed value.
  //
  // `value` is the native string a raw input of that type carries — ISO
  // yyyy-mm-dd for a date, 24-hour hh:mm for a time — or "". onChange fires
  // with the new string only when it actually differs from `value`.
  function deferredTemporalField(inputType) {
    return function({ value, onChange, style: sx, title, disabled, ariaLabel, step }) {
      // null = not editing (mirror the prop); a string = a buffered edit.
      var [buf, setBuf] = useState(null);
      var typingRef = useRef(false);
      var shown = buf === null ? (value || "") : buf;

      function commit(next) {
        typingRef.current = false;
        setBuf(null);
        if ((next || "") !== (value || "")) onChange(next || "");
      }
      return h("input", {
        type: inputType,
        value: shown,
        disabled: disabled,
        title: title,
        step: step,
        "aria-label": ariaLabel,
        onKeyDown: function(e) {
          // Enter commits; Escape abandons the buffer. Anything else that can
          // alter a segment (digits, arrows, backspace, AM/PM letters) marks
          // this edit as keyboard-driven so the change it produces is buffered,
          // not published.
          if (e.key === "Enter") { commit(e.target.value); return; }
          if (e.key === "Escape") { typingRef.current = false; setBuf(null); return; }
          if (e.key !== "Tab") typingRef.current = true;
        },
        onChange: function(e) {
          if (typingRef.current) { setBuf(e.target.value); return; }
          commit(e.target.value);   // popup pick → publish right away
        },
        onBlur: function(e) { commit(e.target.value); },
        style: sx,
      });
    };
  }
  window.LTPDateField = deferredTemporalField("date");
  window.LTPTimeField = deferredTemporalField("time");

  // ── Phone density kit ──────────────────────────────────────────────────────
  // On a phone every input renders at 16px whether we like it or not
  // (index.html forces it so iOS never zooms on focus), so the phone layouts
  // are designed around that size instead of against it: 36px controls, one
  // labelled box per field, native pickers behind formatted chips. Shared by
  // the schedule builder, the quote/invoice builders and the Labor tabs so
  // every phone screen uses the same pieces.
  window.LTP_CTL = 36;

  // Native date/time pickers behind a chip. A raw <input type="date"> on iOS
  // is a wide, oddly tall control reading "09/10/2026". The caller renders the
  // real field (LTPDateField / LTPTimeField or a raw input) styled with
  // LTP_NATIVE and hands it here: it is stretched over a formatted chip at
  // opacity 0, so the chip is what you see ("Thu, Sep 10", "8:00 AM") and the
  // field is what you tap — the tap opens the native wheel picker exactly as
  // before, and whatever buffering/commit rules the field carries are
  // untouched. opts: { label, prefix?, empty?, warn?, small?, bare?, divider?,
  // style? } — `bare` chips sit inside LTP_pickerSeg, which draws the box.
  window.LTP_NATIVE = { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", opacity: 0, margin: 0, padding: 0, border: 0,
                        fontSize: "16px", background: "transparent", color: "transparent", cursor: "pointer", zIndex: 1 };
  // A phone opens the picker on the tap itself. A narrow DESKTOP window (mouse,
  // no touch) only focuses the invisible input, and the calendar glyph that
  // would open the popup is hidden with it — so ask for the picker outright
  // there (showPicker needs a user gesture; a click is one).
  var pointerOpensPicker = (function() { try { return window.matchMedia("(hover: none)").matches; } catch (e) { return true; } })();
  function openPicker(e) {
    if (pointerOpensPicker) return;
    var el = e.currentTarget.querySelector("input");
    if (el && typeof el.showPicker === "function") { try { el.showPicker(); } catch (err) { /* unsupported type or not a gesture */ } }
  }
  window.LTP_pickerChip = function(opts, field) {
    var tone = opts.warn ? B.warn : opts.empty ? B.textMut : B.text;
    var style = { position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, height: opts.small ? 30 : window.LTP_CTL,
                  padding: opts.small ? "0 8px" : "0 10px", fontSize: opts.small ? "12px" : "13px", fontWeight: 600, color: tone,
                  whiteSpace: "nowrap", boxSizing: "border-box", overflow: "hidden", minWidth: 0 };
    if (!opts.bare) Object.assign(style, { borderRadius: "8px", background: B.bg, border: "1px solid " + (opts.warn ? B.warn : B.border) });
    if (opts.divider) style.borderLeft = "1px solid " + B.border;
    return h("div", { style: Object.assign(style, opts.style), onClick: openPicker },
      opts.prefix ? h("span", { "aria-hidden": "true", style: { fontSize: "9px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: B.textMut, flexShrink: 0 } }, opts.prefix) : null,
      h("span", { "aria-hidden": "true", style: { overflow: "hidden", textOverflow: "ellipsis" } }, opts.label),
      field);
  };
  // Two bare chips in one bordered pill: [ 8:00 AM | 6:00 PM ].
  window.LTP_pickerSeg = function(a, b, small) {
    return h("div", { style: { display: "inline-flex", alignItems: "stretch", border: "1px solid " + B.border, borderRadius: "8px", background: B.bg,
                               overflow: "hidden", flexShrink: 0, height: small ? 30 : window.LTP_CTL, boxSizing: "border-box" } }, a, b);
  };

  // Labelled inline field — "FEE $ [1500]" in one 36px box — so a label never
  // sits on its own line above a phone-width input. `input` is the caller's
  // <input> styled with LTP_INLINE_INPUT (or a read-only element).
  // opts: { flex, title, borderColor, style }
  window.LTP_INLINE_INPUT = { flex: 1, minWidth: 0, width: "100%", background: "transparent", border: "none", outline: "none", color: B.text, fontSize: "16px", fontFamily: "inherit", padding: 0 };
  window.LTP_inlineField = function(label, input, opts) {
    opts = opts || {};
    return h("label", { title: opts.title,
      style: Object.assign({ flex: opts.flex || 1, display: "flex", alignItems: "center", gap: 6, minWidth: 0, height: window.LTP_CTL, padding: "0 10px",
                             background: B.bg, border: "1px solid " + (opts.borderColor || B.border), borderRadius: "8px", boxSizing: "border-box" }, opts.style) },
      h("span", { style: { fontSize: "9px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: B.textMut, whiteSpace: "nowrap", flexShrink: 0 } }, label),
      input);
  };

  // Compact stat strip — the phone stand-in for a row of StatCards (which
  // stack into a screenful of 180px tiles): N tiles in one bordered row, the
  // value over a small uppercase label. items: [{ label, value, color?, sub?,
  // title? }]; falsy entries are skipped so callers can inline conditionals.
  window.LTPStatStrip = function({ items, style: sx }) {
    var list = (items || []).filter(Boolean);
    if (!list.length) return null;
    var dense = list.length > 4;
    return h("div", { style: Object.assign({ display: "grid", gridTemplateColumns: "repeat(" + list.length + ", minmax(0, 1fr))", background: B.surface, border: "1px solid " + B.border, borderRadius: "10px", overflow: "hidden" }, sx) },
      list.map(function(it, i) {
        return h("div", { key: i, title: it.title, style: { padding: "8px 4px", textAlign: "center", borderLeft: i ? "1px solid " + B.border : "none", minWidth: 0 } },
          h("div", { style: { fontSize: dense ? "14px" : "15px", fontWeight: 700, color: it.color || B.text, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, it.value),
          h("div", { style: { fontSize: "9px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: dense ? "0.04em" : "0.1em", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, it.label),
          it.sub ? h("div", { style: { fontSize: "9px", color: B.textMut, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, it.sub) : null);
      }));
  };

  // ── Note line item row (quotes + invoices) ────────────────────────────────
  // A note is the one line item whose whole payload is free text, authored in
  // a <textarea>. Its blank lines, indentation and runs of spaces are content,
  // so the row displays with LTP_NOTE_TEXT_STYLE (white-space: pre-wrap) and
  // edits back into a textarea — never a single-line input, which would strip
  // the newlines the author just typed.
  //
  // Both builders render the same component so the display, the edit affordance
  // and the text normalization can't drift apart:
  //   quotes-builder.js — passes drag handlers via `containerProps` + a handle
  //   invoices.js       — no drag; `editable` follows the draft/issued state
  //
  // `editable` false collapses the row to a read-only caption (locked quote,
  // issued invoice). Save is disabled while the text is blank so clearing the
  // box can't silently empty a note — deleting is the × button's job.
  window.LTPNoteLineRow = function({ text, editable, onSave, onDelete, containerProps, handle }) {
    var isMobile = window.LTP_useIsMobile();
    var [editing, setEditing] = useState(false);
    var [val, setVal] = useState("");
    var body = text || "";

    function begin() { setVal(body); setEditing(true); }
    function cancel() { setEditing(false); setVal(""); }
    function save() {
      if (!window.LTP_noteHasText(val)) return;
      onSave(window.LTP_noteText(val));
      setEditing(false);
      setVal("");
    }
    function onKeyDown(e) {
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
      // ⌘/Ctrl+Enter commits — a bare Enter has to stay a newline in here.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
    }

    var shell = { background: B.bg, border: "1px dashed " + B.border, borderRadius: "4px", padding: "8px 12px", display: "flex", alignItems: "flex-start", gap: 10 };
    var label = h("span", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.05em", flexShrink: 0, marginTop: 1 } }, "Note");
    // Touch targets: 44px minimum on a phone (the app-wide .ltp-tap treatment),
    // a compact glyph button on desktop.
    var iconBtn = { background: "transparent", border: "none", color: B.textMut, cursor: "pointer", padding: "2px 6px", flexShrink: 0, fontFamily: "inherit", lineHeight: 1 };
    if (isMobile) iconBtn = Object.assign(iconBtn, { minWidth: 40, minHeight: 44 });
    var iconCls = isMobile ? "ltp-tap" : undefined;

    if (editing) {
      return h("div", { style: Object.assign({}, shell, { flexDirection: "column", alignItems: "stretch", gap: 8 }) },
        label,
        h("textarea", {
          value: val, autoFocus: true, rows: Math.min(12, Math.max(3, val.split("\n").length + 1)),
          onChange: function(e) { setVal(e.target.value); }, onKeyDown: onKeyDown,
          "aria-label": "Note text",
          style: { width: "100%", boxSizing: "border-box", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px 10px", color: B.text, fontSize: "13px", lineHeight: 1.5, fontFamily: "inherit", outline: "none", resize: "vertical" },
        }),
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" } },
          h("span", { style: { fontSize: "10px", color: B.textMut } }, "Line breaks and spacing are kept on the quote, client view and PDF."),
          h("div", { style: { display: "flex", gap: 6 } },
            h(window.Btn, { small: true, variant: "ghost", onClick: cancel }, "Cancel"),
            h(window.Btn, { small: true, onClick: save, disabled: !window.LTP_noteHasText(val) }, "Save")))
      );
    }

    return h("div", Object.assign({ style: shell }, containerProps || {}),
      handle || null,
      label,
      h("div", {
        onDoubleClick: editable ? begin : undefined,
        style: Object.assign({ flex: 1, minWidth: 0, fontSize: "12px", color: B.textSec, fontStyle: "italic", lineHeight: 1.5 }, window.LTP_NOTE_TEXT_STYLE),
      }, body),
      editable && h("button", { onClick: begin, className: iconCls, title: "Edit note", "aria-label": "Edit note", style: Object.assign({}, iconBtn, { fontSize: isMobile ? "16px" : "12px" }) }, "✎"),
      editable && onDelete && h("button", { onClick: onDelete, className: iconCls, title: "Remove note", "aria-label": "Remove note", style: Object.assign({}, iconBtn, { fontSize: isMobile ? "22px" : "14px" }) }, "×")
    );
  };

  // labelAction renders a small control (typically the ＋ / ✎ affordance from
  // components/entity-quick-form.js) at the right end of the label row. A
  // native <select> can't host a "create new" row that opens a form, so the
  // entity-backed selects hang that action off the label instead. Size it to
  // LTP_FIELD_LABEL_HEIGHT or smaller — the label row no longer grows to fit,
  // because growing is what knocked neighbouring fields out of alignment.
  window.LTPSelect = function({ label, value, onChange, options, style: sx, labelAction }) {
    return h("div", { style: Object.assign({ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }, sx) },
      (label != null || labelAction) && h(window.LTPFieldLabel, { label: label || "", action: labelAction }),
      h("select", { value: value, onChange: function(e) { onChange(e.target.value); },
        onFocus: function(e) { e.target.style.borderColor = B.accent; },
        onBlur: function(e) { e.target.style.borderColor = B.border; },
        style: { width: "100%", minWidth: 0, boxSizing: "border-box", background: B.bg, border: "1px solid " + B.border, borderRadius: "8px", padding: "8px 12px", color: B.text, fontSize: "13px", fontFamily: "inherit", outline: "none", appearance: "auto", transition: "border-color 0.15s" } },
        options.map(function(o) { return h("option", { key: o.value, value: o.value }, o.label); }))
    );
  };

  // Tabs read as the uppercase letter-spaced "eyebrow" overlines from the
  // customer views, with the active one underlined in brand orange.
  // Scroll-hint hook: given a ref to a horizontally-scrollable element, returns
  // true while there is more content off the right edge. Drives the little
  // "›" affordance on tab/filter strips so a phone user knows they can swipe
  // for more (drag isn't otherwise discoverable on touch).
  window.LTP_useScrollHint = function(ref) {
    var pair = React.useState(false); var more = pair[0], setMore = pair[1];
    React.useEffect(function() {
      var el = ref.current; if (!el) return undefined;
      function check() { setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 2); }
      check();
      // Re-check after layout/fonts settle so a first-paint measurement that
      // read 0 widths doesn't leave the hint stuck off.
      var t = setTimeout(check, 250);
      el.addEventListener("scroll", check, { passive: true });
      window.addEventListener("resize", check);
      return function() { clearTimeout(t); el.removeEventListener("scroll", check); window.removeEventListener("resize", check); };
    }, []);
    return more;
  };

  // Right-edge "more →" affordance overlay for a scroll strip. Absolutely
  // positioned inside a position:relative wrapper; pointer-events:none so it
  // never blocks taps/swipes on the strip beneath. `fade` is the background it
  // blends into (defaults to the page bg).
  window.LTPScrollHint = function({ show, fade, bottom }) {
    if (!show) return null;
    return h("div", { "aria-hidden": "true",
      style: { position: "absolute", right: 0, top: 0, bottom: bottom || 0, width: 34, pointerEvents: "none",
               display: "flex", alignItems: "center", justifyContent: "flex-end",
               background: "linear-gradient(to right, transparent, " + (fade || B.bg) + " 70%)" } },
      h("span", { style: { color: B.accent, fontSize: "15px", fontWeight: 700 } }, "›"));
  };

  // Reusable horizontal filter/chip strip with the swipe-for-more chevron.
  // Drops in for the hand-rolled `<div className="ltp-tabs-strip">` used by
  // every list toolbar. On desktop it renders the plain strip with the
  // caller's desktopStyle (often display:contents or flexWrap:wrap) and no
  // hint; on mobile it wraps the scrolling strip in a relative box and shows
  // the LTPScrollHint when content runs off the right edge. Children are the
  // chip buttons.
  window.LTPScrollStrip = function(props) {
    var isMobile = props.isMobile, mobileStyle = props.mobileStyle, desktopStyle = props.desktopStyle;
    var ref = React.useRef(null);
    var more = window.LTP_useScrollHint(ref);   // always called (stable hook order); no-op until ref attaches
    if (!isMobile) {
      return h("div", { className: "ltp-tabs-strip", style: desktopStyle }, props.children);
    }
    var wrapStyle = Object.assign(
      { position: "relative", minWidth: 0 },
      mobileStyle && mobileStyle.width ? { width: mobileStyle.width } : null,
      props.wrapStyle
    );
    return h("div", { style: wrapStyle },
      h("div", { ref: ref, className: "ltp-tabs-strip", style: mobileStyle }, props.children),
      h(window.LTPScrollHint, { show: more, fade: props.fade }));
  };

  window.LTPTabs = function({ tabs, active, onChange }) {
    // The strip scrolls horizontally instead of wrapping/overflowing so a wide
    // tab set (e.g. the 7-tab project detail) stays fully reachable on a phone.
    // scrollbarWidth:none + the webkit rule keep the scrollbar invisible; the
    // LTPScrollHint chevron signals there's more to swipe to.
    var stripRef = React.useRef(null);
    var more = window.LTP_useScrollHint(stripRef);
    return h("div", { style: { position: "relative", marginBottom: 18 } },
      h("div", { ref: stripRef, className: "ltp-tabs-strip", style: { display: "flex", gap: 0, borderBottom: "1px solid " + B.border, overflowX: "auto", flexWrap: "nowrap", WebkitOverflowScrolling: "touch", scrollbarWidth: "none" } },
        tabs.map(function(t) {
          return h("button", { key: t.id, onClick: function() { onChange(t.id); },
            className: "ltp-tap",
            style: { background: "transparent", border: "none", borderBottom: active === t.id ? "2px solid " + B.accent : "2px solid transparent", padding: "9px 14px", fontSize: "11px", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: active === t.id ? B.accent : B.textMut, cursor: "pointer", transition: "all 0.15s", fontFamily: "inherit", whiteSpace: "nowrap", flexShrink: 0 }
          }, t.label + (t.count !== undefined ? " (" + t.count + ")" : ""));
        })
      ),
      h(window.LTPScrollHint, { show: more, bottom: 1 }));
  };

  // On mobile (<=600px) the ltp-modal-backdrop / ltp-modal-panel classes are
  // upgraded by the index.html CSS layer into a full-screen sheet (no floating
  // card, safe-area insets). Desktop keeps the centered fixed-width dialog.
  // zIndex lifts a modal above the default 1000 layer. Used by the inline
  // entity add/edit stack (components/entity-quick-form.js), where a form can
  // be opened from inside another modal and must render above it.
  window.LTPModal = function({ title, onClose, children, wide, disableBackdrop, zIndex }) {
    return h("div", { className: "ltp-modal-backdrop", style: { position: "fixed", inset: 0, background: "rgba(15,21,25,0.72)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: zIndex || 1000 },
      onClick: disableBackdrop ? null : onClose },
      h("div", { className: "ltp-modal-panel", onClick: function(e) { e.stopPropagation(); }, style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "14px", padding: "24px", width: wide ? "90%" : "480px", maxWidth: wide ? 900 : 480, maxHeight: "85vh", overflowY: "auto", overflowX: "visible", position: "relative", boxShadow: "0 24px 64px rgba(0,0,0,0.45)" } },
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 } },
          h("h3", { style: { margin: 0, fontSize: "16px", fontWeight: 700, color: B.text, letterSpacing: "-0.01em" } }, title),
          h("button", { onClick: onClose, style: { background: "none", border: "none", color: B.textMut, fontSize: "18px", cursor: "pointer" } }, "\u2715")
        ), children)
    );
  };

  // Overflow "⋯" menu — collapses a pile of secondary actions behind one
  // kebab button so a cramped header (e.g. the quote/invoice builders) stays a
  // single tidy row on mobile. items: [{ label, onClick, href, variant, icon,
  // disabled }] — falsy entries are ignored so callers can inline conditionals.
  window.LTPOverflowMenu = function({ items, align }) {
    var op = React.useState(false); var open = op[0], setOpen = op[1];
    var ref = React.useRef(null);
    React.useEffect(function() {
      if (!open) return undefined;
      function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
      document.addEventListener("mousedown", onDoc);
      return function() { document.removeEventListener("mousedown", onDoc); };
    }, [open]);
    var list = (items || []).filter(Boolean);
    if (!list.length) return null;
    function rowStyle(it) {
      return { display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", background: "transparent",
               border: "none", borderRadius: "6px", padding: "10px 10px", color: it.disabled ? B.textMut : (it.variant === "danger" ? B.danger : B.text),
               fontSize: "13px", fontWeight: 500, cursor: it.disabled ? "default" : "pointer", fontFamily: "inherit", textDecoration: "none", opacity: it.disabled ? 0.5 : 1, whiteSpace: "nowrap" };
    }
    return h("div", { ref: ref, style: { position: "relative", display: "inline-block" } },
      h("button", { onClick: function() { setOpen(!open); }, "aria-label": "More actions", className: "ltp-tap",
        style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "5px 12px", color: B.textSec, fontSize: "18px", lineHeight: 1, cursor: "pointer", fontFamily: "inherit" } }, "⋯"),
      open && h("div", { style: { position: "absolute", top: "calc(100% + 6px)", right: align === "left" ? undefined : 0, left: align === "left" ? 0 : undefined, minWidth: 190, background: B.surface, border: "1px solid " + B.border, borderRadius: "10px", boxShadow: "0 12px 32px rgba(0,0,0,0.45)", zIndex: 60, overflow: "hidden", padding: "5px" } },
        list.map(function(it, i) {
          if (it.href) {
            return h("a", { key: i, href: it.href, target: it.target || "_blank", rel: "noopener", className: "ltp-tap",
              onClick: function() { setOpen(false); }, style: rowStyle(it) }, it.icon && h("span", null, it.icon), it.label);
          }
          return h("button", { key: i, disabled: it.disabled, className: "ltp-tap",
            onClick: function() { setOpen(false); it.onClick && it.onClick(); }, style: rowStyle(it) },
            it.icon && h("span", null, it.icon), it.label);
        })));
  };

  window.StatCard = function({ label, value, sub, accent }) {
    return h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "12px", padding: "18px 20px", flex: 1, minWidth: 140 } },
      h("div", { style: { fontSize: "11px", color: B.textMut, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6, fontWeight: 700 } }, label),
      h("div", { style: { fontSize: "24px", fontWeight: 700, color: accent || B.text, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums", lineHeight: 1.1 } }, value),
      sub && h("div", { style: { fontSize: "11px", color: B.textMut, marginTop: 5 } }, sub)
    );
  };

  // ── Mobile floating action button (FAB) ────────────────────────────────────
  // Thumb-reachable create affordance, bottom-right above the tab bar + home
  // indicator. Rendered by list views only on mobile (window.LTP_useIsMobile),
  // replacing the small top-right "+ New" button. label is the aria-label.
  window.LTPFab = function({ onClick, label, icon }) {
    return h("button", {
      onClick: onClick,
      "aria-label": label || "Create",
      className: "ltp-tap",
      style: {
        position: "fixed", right: 16, bottom: "calc(78px + env(safe-area-inset-bottom))",
        zIndex: 800, width: 56, height: 56, borderRadius: "50%",
        background: B.gradBtn, color: B.btnInk, border: "none",
        boxShadow: "0 6px 20px rgba(239,88,34,0.42)",
        fontSize: "30px", fontWeight: 400, lineHeight: 1, cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "inherit",
      },
    }, icon || "+");
  };

  // Round tap-to-call / tap-to-email links for mobile list rows. They return
  // null when there's no number/address so callers can drop them in without a
  // guard, and stopPropagation so tapping the action never fires the row's own
  // onClick (which usually opens an editor/detail). Used by the crew agenda,
  // Crew Roster, Assignments, and CRM contact rows.
  function contactActionBtn(href, ariaLabel, glyph, size) {
    var s = size || 40;
    return h("a", { href: href, "aria-label": ariaLabel, className: "ltp-tap",
      onClick: function(e) { e.stopPropagation(); },
      style: { flexShrink: 0, width: s, height: s, borderRadius: "50%", background: B.accent + "18",
               border: "1px solid " + B.accent + "44", display: "flex", alignItems: "center",
               justifyContent: "center", textDecoration: "none", fontSize: "16px" } }, glyph);
  }
  window.LTPCallBtn = function({ phone, name, size }) {
    var digits = phone ? String(phone).replace(/[^\d+]/g, "") : "";
    if (!digits) return null;
    return contactActionBtn("tel:" + digits, "Call " + (name || "").trim(), "📞", size);
  };
  window.LTPMailBtn = function({ email, name, size }) {
    if (!email) return null;
    return contactActionBtn("mailto:" + email, "Email " + (name || "").trim(), "✉️", size);
  };

  window.EmptyState = function({ text }) {
    return h("div", { style: { padding: "32px", textAlign: "center", color: B.textMut, fontSize: "13px", fontStyle: "italic" } }, text);
  };

  // Company logo: shows uploaded/linked image or SVG placeholder
  window.CompanyLogo = function({ src, size }) {
    size = size || 32;
    if (src) return h("img", { src: src, alt: "", style: { width: size, height: size, borderRadius: "6px", objectFit: "contain", background: B.raised, padding: 2, flexShrink: 0 } });
    return h("svg", { width: size, height: size, viewBox: "0 0 32 32", style: { flexShrink: 0, borderRadius: "6px", background: B.raised } },
      h("rect", { x: 0, y: 0, width: 32, height: 32, rx: 6, fill: B.raised }),
      h("rect", { x: 8, y: 10, width: 16, height: 14, rx: 1.5, fill: B.textMut, opacity: 0.3 }),
      h("rect", { x: 8, y: 6, width: 10, height: 18, rx: 1, fill: B.textMut, opacity: 0.5 }),
      h("rect", { x: 10, y: 9, width: 2, height: 2, rx: 0.5, fill: B.raised }),
      h("rect", { x: 14, y: 9, width: 2, height: 2, rx: 0.5, fill: B.raised }),
      h("rect", { x: 10, y: 13, width: 2, height: 2, rx: 0.5, fill: B.raised }),
      h("rect", { x: 14, y: 13, width: 2, height: 2, rx: 0.5, fill: B.raised }),
      h("rect", { x: 10, y: 17, width: 2, height: 2, rx: 0.5, fill: B.raised }),
      h("rect", { x: 14, y: 17, width: 2, height: 2, rx: 0.5, fill: B.raised }),
      h("rect", { x: 20, y: 14, width: 2, height: 2, rx: 0.5, fill: B.raised }),
      h("rect", { x: 20, y: 18, width: 2, height: 2, rx: 0.5, fill: B.raised })
    );
  };

  // Navigation icons — simple geometric SVGs matching the CompanyLogo art style
  window.LTP_NAV_ICON = function(moduleId, size, color) {
    size  = size  || 18;
    color = color || B.textMut;
    var s = { flexShrink: 0 };

    function svg(children) {
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", style: s }, children);
    }

    switch (moduleId) {

      // Dashboard — four rounded squares in a 2x2 grid
      case "dashboard":
        return svg([
          h("rect", { key: "a", x: 3,   y: 3,   width: 8, height: 8, rx: 1.5, fill: color, opacity: 0.9 }),
          h("rect", { key: "b", x: 13,  y: 3,   width: 8, height: 8, rx: 1.5, fill: color, opacity: 0.6 }),
          h("rect", { key: "c", x: 3,   y: 13,  width: 8, height: 8, rx: 1.5, fill: color, opacity: 0.6 }),
          h("rect", { key: "d", x: 13,  y: 13,  width: 8, height: 8, rx: 1.5, fill: color, opacity: 0.35 }),
        ]);

      // CRM — person silhouette (circle head + rounded body)
      case "crm":
        return svg([
          h("circle", { key: "head", cx: 12, cy: 7.5, r: 3.5, fill: color, opacity: 0.9 }),
          h("path",   { key: "body", d: "M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8", fill: color, opacity: 0.7 }),
        ]);

      // Projects — pencil
      case "projects":
        return svg([
          h("rect", { key: "body", x: 10.5, y: 3.5, width: 5, height: 14, rx: 1, fill: color, opacity: 0.8,
            transform: "rotate(45 10.5 3.5)" }),
          h("path", { key: "tip",  d: "M4 18.5l1.5-4 2.5 2.5z", fill: color, opacity: 0.9 }),
          h("rect", { key: "eraser", x: 3.5, y: 20, width: 6, height: 1.5, rx: 0.75, fill: color, opacity: 0.5 }),
        ]);

      // Calendar — clock face
      case "calendar":
        return svg([
          h("circle", { key: "face",   cx: 12, cy: 12, r: 9,   fill: color, opacity: 0.18 }),
          h("circle", { key: "rim",    cx: 12, cy: 12, r: 9,   fill: color, opacity: 0, stroke: color, strokeWidth: 1.8, strokeOpacity: 0.7 }),
          h("rect",   { key: "hour",   x: 11.2, y: 5,  width: 1.6, height: 7,   rx: 0.8, fill: color, opacity: 0.9 }),
          h("rect",   { key: "min",    x: 11.2, y: 7,  width: 1.6, height: 5.5, rx: 0.8, fill: color, opacity: 0.9,
            transform: "rotate(90 12 12)" }),
          h("circle", { key: "center", cx: 12, cy: 12, r: 1.2, fill: color, opacity: 1 }),
        ]);

      // Rentals — moving light (beam projector silhouette pointing down)
      case "rentals":
        return svg([
          h("rect",    { key: "body",  x: 8,   y: 2,   width: 8,  height: 6,  rx: 1.5, fill: color, opacity: 0.9 }),
          h("circle",  { key: "lens",  cx: 12, cy: 10, r: 2.5,    fill: color, opacity: 0.7 }),
          h("path",    { key: "beam",  d: "M7.5 13 L5 22 L19 22 L16.5 13 Z", fill: color, opacity: 0.25 }),
          h("ellipse", { key: "pool",  cx: 12, cy: 22, rx: 7, ry: 1.2, fill: color, opacity: 0.35 }),
        ]);

      // Quotes — single dollar sign
      case "quotes":
        return svg([
          h("rect",  { key: "bg",   x: 3, y: 3, width: 18, height: 18, rx: 3, fill: color, opacity: 0.12 }),
          h("text",  { key: "sign", x: 12, y: 17, textAnchor: "middle", fontSize: 14, fontWeight: 700,
            fontFamily: "serif", fill: color, opacity: 0.9 }, "$"),
        ]);

      // Invoices — three dollar signs stacked
      case "invoices":
        return svg([
          h("rect",  { key: "bg",   x: 3, y: 3, width: 18, height: 18, rx: 3, fill: color, opacity: 0.12 }),
          h("text",  { key: "s1", x: 7,  y: 16, textAnchor: "middle", fontSize: 10, fontWeight: 700,
            fontFamily: "serif", fill: color, opacity: 0.5 }, "$"),
          h("text",  { key: "s2", x: 12, y: 16, textAnchor: "middle", fontSize: 10, fontWeight: 700,
            fontFamily: "serif", fill: color, opacity: 0.75 }, "$"),
          h("text",  { key: "s3", x: 17, y: 16, textAnchor: "middle", fontSize: 10, fontWeight: 700,
            fontFamily: "serif", fill: color, opacity: 1 }, "$"),
        ]);

      // Labor — wrench
      case "labor":
        return svg([
          h("path", { key: "handle", d: "M14.5 9.5 L6 18 Q5 19 4.5 19.5 Q4 20 4.5 19.5 L5 20.5 Q5.5 21 6.5 20 L15 11.5",
            fill: color, opacity: 0.85, stroke: color, strokeWidth: 0.5, strokeOpacity: 0.5 }),
          h("circle", { key: "head", cx: 17, cy: 7, r: 4.5, fill: color, opacity: 0.2 }),
          h("circle", { key: "head2", cx: 17, cy: 7, r: 4.5, fill: "none", stroke: color, strokeWidth: 1.8, strokeOpacity: 0.8 }),
          h("rect",   { key: "jaw1", x: 14.5, y: 4.5, width: 2, height: 5, rx: 0.5, fill: color, opacity: 0.9 }),
          h("rect",   { key: "jaw2", x: 17.5, y: 4.5, width: 2, height: 5, rx: 0.5, fill: color, opacity: 0.9 }),
        ]);

      case "settings":
        return svg([
          h("circle", { key: "c", cx: 12, cy: 12, r: 3.5, fill: "none", stroke: color, strokeWidth: 1.8 }),
          h("path", { key: "g", d: "M12 1.5 L13 4.5 L15 5 L17.5 3 L19.5 5 L17.5 7 L18 9 L21 10 L21 14 L18 13.5 L17.5 15.5 L19.5 18 L17 20 L15 18 L13 18.5 L12 21.5 L10 21.5 L9 18.5 L7 18 L5 20 L3 18 L5 15.5 L4.5 13.5 L1.5 14 L1.5 10 L4.5 9 L5 7 L3 5 L5 3 L7 5 L9 4.5 L10 1.5 Z",
            fill: "none", stroke: color, strokeWidth: 1.2, strokeLinejoin: "round" })
        ]);

      default:
        return h("span", { style: { width: size, height: size, display: "inline-block" } });
    }
  };


  window.ImageUpload = function({ label, value, onChange }) {
    var [mode, setMode] = useState("url");
    var fileRef = React.useRef(null);
    function handleFile(e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function(ev) { onChange(ev.target.result); };
      reader.readAsDataURL(file);
    }
    return h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
      label && h("label", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, label),
      h("div", { style: { display: "flex", gap: 6, marginBottom: 4 } },
        h("button", { onClick: function() { setMode("url"); }, style: { background: mode === "url" ? B.accent : B.raised, color: mode === "url" ? B.btnInk : B.textMut, border: "1px solid " + (mode === "url" ? B.accent : B.border), borderRadius: "4px", padding: "3px 10px", fontSize: "10px", fontWeight: 600, cursor: "pointer" } }, "URL"),
        h("button", { onClick: function() { setMode("upload"); }, style: { background: mode === "upload" ? B.accent : B.raised, color: mode === "upload" ? B.btnInk : B.textMut, border: "1px solid " + (mode === "upload" ? B.accent : B.border), borderRadius: "4px", padding: "3px 10px", fontSize: "10px", fontWeight: 600, cursor: "pointer" } }, "Upload")
      ),
      mode === "url" && h("input", { type: "text", value: (value && value.startsWith("data:")) ? "" : (value || ""), onChange: function(e) { onChange(e.target.value); }, placeholder: "https://example.com/logo.png", style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px 12px", color: B.text, fontSize: "13px", fontFamily: "inherit", outline: "none" } }),
      mode === "upload" && h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
        h("input", { ref: fileRef, type: "file", accept: "image/*", onChange: handleFile, style: { display: "none" } }),
        h(window.Btn, { small: true, variant: "ghost", onClick: function() { fileRef.current && fileRef.current.click(); } }, "Choose File"),
        value && value.startsWith("data:") && h("span", { style: { fontSize: "11px", color: B.success } }, "\u2713 Uploaded")
      ),
      value && h("div", { style: { marginTop: 4, display: "flex", alignItems: "center", gap: 8 } },
        h("img", { src: value, alt: "Preview", style: { width: 48, height: 48, borderRadius: "6px", objectFit: "contain", background: B.raised, padding: 2 } }),
        h(window.Btn, { small: true, variant: "danger", onClick: function() { onChange(""); } }, "Remove"))
    );
  };
})();
