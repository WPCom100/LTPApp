// Core UI Components
(function() {
  var B = window.LTP_THEME, SC = window.LTP_STATUS_COLORS, h = React.createElement, useState = React.useState;

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

  // ── Loading — the orange shimmer bar from the customer-facing pages ──────
  // LTPLoadingBar: inline shimmer + optional quiet label underneath.
  // LTPLoadingScreen: full-height centered version for app-level gates.
  window.LTPLoadingBar = function({ label, width }) {
    return h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center" } },
      h("div", { className: "ltp-shimmer", style: { height: 4, width: width || 120, borderRadius: 2 } }),
      label && h("div", { style: { fontSize: "13px", color: B.textSec, marginTop: 14, textAlign: "center" } }, label));
  };
  window.LTPLoadingScreen = function({ label }) {
    return h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: B.bg, fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif" } },
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

  window.LTPInput = function({ label, value, onChange, placeholder, type, textarea, style: sx, validate, onBlur: onBlurProp }) {
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
      label && h("label", { style: { fontSize: "11px", fontWeight: 600, color: error ? B.danger : B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, label),
      textarea ? h("textarea", { value: value, onChange: function(e) { onChange(e.target.value); }, onFocus: handleFocus, onBlur: handleBlur, placeholder: placeholder, rows: 3, style: Object.assign({}, fs, { resize: "vertical" }) })
               : h("input", { type: type || "text", value: shownValue, onChange: function(e) { onChange(e.target.value); }, onFocus: handleFocus, onBlur: handleBlur, placeholder: shownPlaceholder, style: fs }),
      error && h("div", { style: { fontSize: "9px", color: B.danger, marginTop: 1 } }, error)
    );
  };

  window.LTPSelect = function({ label, value, onChange, options, style: sx }) {
    return h("div", { style: Object.assign({ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }, sx) },
      label && h("label", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, label),
      h("select", { value: value, onChange: function(e) { onChange(e.target.value); },
        onFocus: function(e) { e.target.style.borderColor = B.accent; },
        onBlur: function(e) { e.target.style.borderColor = B.border; },
        style: { width: "100%", minWidth: 0, boxSizing: "border-box", background: B.bg, border: "1px solid " + B.border, borderRadius: "8px", padding: "8px 12px", color: B.text, fontSize: "13px", fontFamily: "inherit", outline: "none", appearance: "auto", transition: "border-color 0.15s" } },
        options.map(function(o) { return h("option", { key: o.value, value: o.value }, o.label); }))
    );
  };

  // Tabs read as the uppercase letter-spaced "eyebrow" overlines from the
  // customer views, with the active one underlined in brand orange.
  window.LTPTabs = function({ tabs, active, onChange }) {
    return h("div", { style: { display: "flex", gap: 0, borderBottom: "1px solid " + B.border, marginBottom: 18 } },
      tabs.map(function(t) {
        return h("button", { key: t.id, onClick: function() { onChange(t.id); },
          style: { background: "transparent", border: "none", borderBottom: active === t.id ? "2px solid " + B.accent : "2px solid transparent", padding: "9px 14px", fontSize: "11px", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: active === t.id ? B.accent : B.textMut, cursor: "pointer", transition: "all 0.15s", fontFamily: "inherit" }
        }, t.label + (t.count !== undefined ? " (" + t.count + ")" : ""));
      })
    );
  };

  window.LTPModal = function({ title, onClose, children, wide, disableBackdrop }) {
    return h("div", { style: { position: "fixed", inset: 0, background: "rgba(15,21,25,0.72)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 },
      onClick: disableBackdrop ? null : onClose },
      h("div", { onClick: function(e) { e.stopPropagation(); }, style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "14px", padding: "24px", width: wide ? "90%" : "480px", maxWidth: wide ? 900 : 480, maxHeight: "85vh", overflowY: "auto", overflowX: "visible", position: "relative", boxShadow: "0 24px 64px rgba(0,0,0,0.45)" } },
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 } },
          h("h3", { style: { margin: 0, fontSize: "16px", fontWeight: 700, color: B.text, letterSpacing: "-0.01em" } }, title),
          h("button", { onClick: onClose, style: { background: "none", border: "none", color: B.textMut, fontSize: "18px", cursor: "pointer" } }, "\u2715")
        ), children)
    );
  };

  window.StatCard = function({ label, value, sub, accent }) {
    return h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "12px", padding: "18px 20px", flex: 1, minWidth: 140 } },
      h("div", { style: { fontSize: "11px", color: B.textMut, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6, fontWeight: 700 } }, label),
      h("div", { style: { fontSize: "24px", fontWeight: 700, color: accent || B.text, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums", lineHeight: 1.1 } }, value),
      sub && h("div", { style: { fontSize: "11px", color: B.textMut, marginTop: 5 } }, sub)
    );
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
