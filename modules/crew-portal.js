// Crew portal: a crew member's own sign-in and dashboard.
//
// Rendered by app.js's outer LTPApp when route.module === "crew-portal",
// bypassing the staff auth gate: the crew member has no staff session. Their
// credential is the ltp_crew_session cookie set by /api/crew-portal/auth/*
// (backend/routes/crew_portal.py), a separate credential system from the
// Google sign-in the staff app uses (see backend/crew_auth.py).
//
//   #/crew-portal                   → overview when signed in, else sign-in
//   #/crew-portal/login             → sign-in
//   #/crew-portal/forgot            → email a password-reset link
//   #/crew-portal/request-access    → email an invitation to a roster address
//   #/crew-portal/signup/<token>    → accept an invitation (choose a password)
//   #/crew-portal/reset/<token>     → finish a password reset
//   #/crew-portal/confirm-email/<token> → make a new sign-in email take effect
//   #/crew-portal/overview | schedule | payouts | account     (signed in)
//
// Visual language is the crew call sheet's (modules/crew-view.js): slate
// field, masthead hero on the brand rule, mono time/money columns, orange
// accents. Phone first, since crew live on their phones: under 600px the tabs
// become a bottom bar and every control is finger-sized; above it the same
// tabs sit under the masthead.
(function() {
  var h = React.createElement;
  var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef;

  // ── Palette (mirrors modules/crew-view.js) ─────────────────────────────────
  var BG = "#233038", TEXT = "#D1DBDA", WHITE = "#FFFFFF", MUTE = "#93A3AB", FAINT = "#6E7E86";
  var ORANGE = "#EF5822", ORANGE_SOFT = "#F9B998", MASTHEAD_ORANGE = "#f15927";
  var INSET = "#1B262C", PANEL = "#202d35", HAIR = "#34454E";
  var GRAD_RULE = "linear-gradient(90deg,#FF921E 0%,#EF5822 50%,#64260F 100%)";
  var GRAD_BTN = "linear-gradient(135deg,#FF921E,#EF5822)";
  var BTN_INK = "#1B130D";
  var SUCCESS = "#5FD08A", SUCCESS_BG = "rgba(95,208,138,0.10)", SUCCESS_BD = "rgba(95,208,138,0.30)";
  var DANGER = "#F0857A", DANGER_BG = "rgba(240,133,122,0.10)", DANGER_BD = "rgba(240,133,122,0.30)";
  var AMBER = "#F5B83D", AMBER_BG = "rgba(245,184,61,0.10)", AMBER_BD = "rgba(245,184,61,0.32)";
  var INFO = "#6FA8F5", INFO_BG = "rgba(111,168,245,0.10)", INFO_BD = "rgba(111,168,245,0.32)";
  var NEUTRAL = "#8A99A0", NEUTRAL_BG = "rgba(138,153,160,0.08)", NEUTRAL_BD = "rgba(138,153,160,0.30)";
  var MONO = "'SFMono-Regular',ui-monospace,'Roboto Mono','DM Mono',Menlo,monospace";
  var FONT = "'DM Sans','Segoe UI',system-ui,sans-serif";
  var MASTHEAD_SRC = "/assets/logos/luminary-masthead.png";
  var API = "/api/crew-portal";

  var TABS = [
    { id: "overview", label: "Overview" },
    { id: "schedule", label: "Schedule" },
    { id: "payouts",  label: "Pay" },
    { id: "account",  label: "Account" },
  ];
  var PUBLIC = { login: 1, forgot: 1, "request-access": 1, signup: 1, reset: 1, "confirm-email": 1 };

  // ── Date / time / money helpers (deterministic, no toLocaleString) ─────────
  var _WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var _MONTHS = ["January", "February", "March", "April", "May", "June",
                 "July", "August", "September", "October", "November", "December"];
  var _MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function parseISO(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  function todayLocalISO() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function ordinal(day) {
    return (day >= 11 && day <= 13) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[day % 10] || "th");
  }
  function fmtDate(iso) {
    var d = parseISO(iso);
    if (!d) return iso || "";
    return _WEEKDAYS[d.getDay()] + ", " + _MONTHS[d.getMonth()] + " " + d.getDate() + ordinal(d.getDate()) + ", " + d.getFullYear();
  }
  function fmtDateShort(iso) {
    var d = parseISO(iso);
    if (!d) return iso || "";
    return _WEEKDAYS[d.getDay()] + ", " + _MONTHS_SHORT[d.getMonth()] + " " + d.getDate();
  }
  function fmtMonthDay(iso) {
    var d = parseISO(iso);
    if (!d) return iso || "";
    return _MONTHS_SHORT[d.getMonth()] + " " + d.getDate();
  }
  function fmtRange(a, b) {
    if (a && b && a !== b) return fmtMonthDay(a) + " – " + fmtMonthDay(b) + (b.slice(0, 4) !== a.slice(0, 4) ? ", " + b.slice(0, 4) : "");
    return a ? fmtDateShort(a) : (b ? fmtDateShort(b) : "");
  }
  function fmtTime(t) {
    if (!t) return "";
    var parts = String(t).split(":");
    if (parts.length < 2) return t;
    var hh = parseInt(parts[0], 10);
    if (isNaN(hh)) return t;
    var h12 = hh % 12; if (h12 === 0) h12 = 12;
    return h12 + ":" + parts[1] + " " + (hh >= 12 ? "PM" : "AM");
  }
  function fmtStamp(iso) {
    if (!iso) return "";
    var parts = String(iso).split("T");
    return [fmtDateShort(parts[0]), parts[1] ? fmtTime(parts[1].slice(0, 5)) : ""].filter(Boolean).join(" · ");
  }
  function fmtMoney(n) {
    return "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function daysUntil(iso, today) {
    var a = parseISO(today), b = parseISO(iso);
    if (!a || !b) return null;
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }
  function relDay(iso, today) {
    var n = daysUntil(iso, today);
    if (n === null) return "";
    if (n === 0) return "Today";
    if (n === 1) return "Tomorrow";
    if (n === -1) return "Yesterday";
    if (n > 1 && n < 7) return "In " + n + " days";
    if (n < -1 && n > -7) return (-n) + " days ago";
    return "";
  }

  // ── API helper: cookie-authenticated, JSON in/out, never throws ───────────
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", credentials: "include", headers: {} };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return fetch(API + path, init).then(function(r) {
      return r.text().then(function(t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        return { ok: r.ok, status: r.status, data: data };
      });
    }).catch(function() {
      return { ok: false, status: 0, data: null, network: true };
    });
  }
  function errMessage(res, fallback) {
    if (res && res.network) return "Can't reach the server. Check your connection and try again.";
    var d = res && res.data && res.data.detail;
    if (typeof d === "string") return d;
    if (d && d.message) return d.message;
    if (d && d.reason) return String(d.reason);
    if (res && res.data && res.data.error) return String(res.data.error);
    if (res && res.status === 429) return "Too many attempts. Please wait a minute and try again.";
    return fallback || "Something went wrong. Please try again.";
  }
  function go(path) { window.LTPRouter.navigate("crew-portal" + (path ? "/" + path : "")); }

  // The server joins a role's code and description with an em dash. The
  // portal carries none, so every role label is rewritten to "L2 · Lighting
  // Tech" once, when the dashboard arrives, rather than at each place it is
  // shown.
  function roleText(label) { return String(label || "").replace(/\s*\u2014\s*/g, " · "); }
  function tidyDashboard(d) {
    if (!d || typeof d !== "object") return d;
    function fix(e) { return (e && typeof e === "object") ? Object.assign({}, e, { roleLabel: roleText(e.roleLabel) }) : e; }
    var out = Object.assign({}, d, {
      upcoming: (d.upcoming || []).map(fix),
      past: (d.past || []).map(fix),
      requests: (d.requests || []).map(function(r) { return Object.assign({}, r, { shifts: (r.shifts || []).map(fix) }); }),
    });
    if (d.stats && d.stats.nextCall) out.stats = Object.assign({}, d.stats, { nextCall: fix(d.stats.nextCall) });
    return out;
  }

  // ── One-time stylesheet (hover lifts, shimmer, focus rings) ───────────────
  function injectStyle() {
    if (document.getElementById("ltp-crew-portal-style")) return;
    var el = document.createElement("style");
    el.id = "ltp-crew-portal-style";
    el.textContent = [
      ".ltp-cp-primary{transition:transform .14s ease,filter .14s ease,box-shadow .14s ease}",
      ".ltp-cp-primary:hover{transform:translateY(-1px);filter:brightness(1.06);box-shadow:0 8px 26px rgba(239,88,34,0.34)}",
      ".ltp-cp-primary:active{transform:translateY(0)}",
      ".ltp-cp-quiet{transition:border-color .14s ease,color .14s ease,background .14s ease}",
      ".ltp-cp-quiet:hover{border-color:#5A6E78;color:#fff}",
      ".ltp-cp-input:focus{border-color:" + ORANGE + " !important;outline:none}",
      ".ltp-cp-row{transition:background .12s ease}",
      ".ltp-cp-row:hover{background:rgba(237,243,242,0.04)}",
      ".ltp-cp-tab{transition:color .12s ease,border-color .12s ease}",
      "@keyframes ltp-cp-shimmer{0%{background-position:-120px 0}100%{background-position:240px 0}}",
      ".ltp-cp-shimmer{background-image:linear-gradient(90deg,#64260F 0%,#FF921E 50%,#64260F 100%);background-size:240px 4px;animation:ltp-cp-shimmer 1.1s linear infinite}",
      "@keyframes ltp-cp-pop{0%{transform:scale(.9);opacity:0}100%{transform:scale(1);opacity:1}}",
      ".ltp-cp-pop{animation:ltp-cp-pop .22s ease both}",
      ".ltp-cp-tap{-webkit-tap-highlight-color:transparent}",
    ].join("\n");
    document.head.appendChild(el);
  }

  // ── Masthead hero (img with wordmark fallback) + brand rule ────────────────
  function Masthead(props) {
    var rule = h("div", { style: { height: 4, width: "100%", background: MASTHEAD_ORANGE, marginTop: -1, position: "relative", zIndex: 1 } });
    var art = props.failed
      ? h("div", null,
          h("span", { style: { display: "block", fontSize: "26px", fontWeight: 800, color: ORANGE, letterSpacing: "0.04em", lineHeight: 1 } }, "LUMINARY"),
          h("div", { style: { fontSize: "10px", fontWeight: 700, color: ORANGE_SOFT, letterSpacing: "0.22em", marginTop: 4 } }, "TECHNOLOGY & PRODUCTIONS"))
      : h("img", { src: MASTHEAD_SRC, alt: props.companyName || "Luminary Technology & Productions", onError: props.onFail,
          style: { display: "block", width: "100%", maxWidth: (props.maxWidth || 300) + "px", height: "auto", margin: 0 } });
    return h("div", null, art, rule);
  }

  // ── Shared atoms ───────────────────────────────────────────────────────────
  function Eyebrow(text, color) {
    return h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: color || ORANGE_SOFT } }, text);
  }
  function SectionTitle(text, right) {
    return h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 12 } },
      h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: ORANGE } }, text),
      right || null);
  }
  function PrimaryBtn(props, label) {
    return h("button", Object.assign({ type: "button", className: "ltp-cp-primary ltp-cp-tap" }, props, {
      style: Object.assign({ minHeight: 48, padding: "0 22px", background: GRAD_BTN, color: BTN_INK, border: "none", borderRadius: 10,
        fontFamily: "inherit", fontSize: "15px", fontWeight: 700, letterSpacing: "0.02em", cursor: props.disabled ? "default" : "pointer",
        opacity: props.disabled ? 0.55 : 1, boxShadow: "0 6px 20px rgba(239,88,34,0.28)", boxSizing: "border-box" }, props.style || {}) }), label);
  }
  function QuietBtn(props, label) {
    return h("button", Object.assign({ type: "button", className: "ltp-cp-quiet ltp-cp-tap" }, props, {
      style: Object.assign({ minHeight: 44, padding: "0 18px", background: "transparent", color: TEXT, border: "1.5px solid " + HAIR, borderRadius: 10,
        fontFamily: "inherit", fontSize: "14px", fontWeight: 600, cursor: props.disabled ? "default" : "pointer", opacity: props.disabled ? 0.55 : 1, boxSizing: "border-box" }, props.style || {}) }), label);
  }
  function LinkBtn(props, label) {
    return h("button", Object.assign({ type: "button", className: "ltp-cp-tap" }, props, {
      style: Object.assign({ background: "none", border: "none", padding: 0, color: ORANGE_SOFT, fontSize: "13px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline", textDecorationColor: HAIR, textUnderlineOffset: "3px" }, props.style || {}) }), label);
  }
  // 16px inputs so iOS never zooms on focus; the dark field so it reads as
  // part of the sheet rather than a white box dropped on it.
  function Field(props) {
    return h("div", { style: { marginBottom: 14 } },
      props.label && h("label", { htmlFor: props.id, style: { display: "block", fontSize: "11px", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: MUTE, marginBottom: 6 } }, props.label),
      h("input", {
        id: props.id, className: "ltp-cp-input", type: props.type || "text", value: props.value, placeholder: props.placeholder || "",
        autoComplete: props.autoComplete, inputMode: props.inputMode, autoCapitalize: props.type === "email" ? "none" : undefined,
        onChange: function(e) { props.onChange(e.target.value); },
        onKeyDown: props.onEnter ? function(e) { if (e.key === "Enter") { e.preventDefault(); props.onEnter(); } } : undefined,
        disabled: !!props.disabled,
        style: { width: "100%", boxSizing: "border-box", minHeight: 48, background: BG, border: "1px solid " + HAIR, borderRadius: 10, padding: "0 14px", color: WHITE, fontSize: "16px", fontFamily: "inherit" },
      }),
      props.hint && h("div", { style: { fontSize: "12px", color: FAINT, marginTop: 5, lineHeight: 1.45 } }, props.hint));
  }
  function Notice(kind, text) {
    if (!text) return null;
    var c = kind === "error" ? { fg: DANGER, bg: DANGER_BG, bd: DANGER_BD }
      : kind === "success" ? { fg: SUCCESS, bg: SUCCESS_BG, bd: SUCCESS_BD }
      : { fg: ORANGE_SOFT, bg: "rgba(249,185,152,0.10)", bd: "rgba(249,185,152,0.32)" };
    return h("div", { role: kind === "error" ? "alert" : "status", className: "ltp-cp-pop",
      style: { padding: "10px 14px", background: c.bg, border: "1px solid " + c.bd, borderRadius: 8, color: c.fg, fontSize: "13px", lineHeight: 1.5, marginBottom: 14 } }, text);
  }
  function Chip(label, tone) {
    var c = tone === "success" ? { fg: SUCCESS, bg: SUCCESS_BG, bd: SUCCESS_BD }
      : tone === "danger" ? { fg: DANGER, bg: DANGER_BG, bd: DANGER_BD }
      : tone === "amber" ? { fg: AMBER, bg: AMBER_BG, bd: AMBER_BD }
      : tone === "info" ? { fg: INFO, bg: INFO_BG, bd: INFO_BD }
      : { fg: NEUTRAL, bg: NEUTRAL_BG, bd: NEUTRAL_BD };
    return h("span", { style: { display: "inline-block", fontSize: "10px", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: c.fg, background: c.bg, border: "1px solid " + c.bd, padding: "3px 8px", borderRadius: 4, whiteSpace: "nowrap" } }, label);
  }
  // Position status → what the crew member reads. "requested" means the ask is
  // in their inbox; "accepted" means they said yes and a production manager
  // still has to confirm; "confirmed" is locked in.
  function statusChip(status) {
    if (status === "confirmed") return Chip("Confirmed", "success");
    if (status === "accepted") return Chip("Awaiting confirmation", "amber");
    if (status === "requested") return Chip("Needs your answer", "info");
    if (status === "declined") return Chip("Declined", "danger");
    return Chip(status || "Unknown");
  }
  function Card(children, style) {
    return h("div", { style: Object.assign({ background: INSET, border: "1px solid " + HAIR, borderRadius: 14, padding: 18 }, style || {}) }, children);
  }
  // Stat tiles: one grid of equal columns and equal heights (four across,
  // two on a phone). Inside each tile the label sits at the top and the
  // figure with its caption sits on a shared bottom line, so the figures line
  // up across the row whether or not a label wraps. The caption row is always
  // rendered, so a tile without one is the same height as its neighbours. A
  // figure too long for the tile is cut with an ellipsis and carried in full
  // on the tooltip.
  function TileGrid(isMobile) {
    var tiles = Array.prototype.slice.call(arguments, 1);
    return h.apply(null, ["div", { style: { display: "grid", gridTemplateColumns: "repeat(" + (isMobile ? 2 : 4) + ", minmax(0, 1fr))", gridAutoRows: "1fr", gap: 10, alignItems: "stretch" } }].concat(tiles));
  }
  function Tile(label, value, sub, color) {
    return h("div", { style: { display: "flex", flexDirection: "column", minWidth: 0, minHeight: 100, background: INSET, border: "1px solid " + HAIR, borderRadius: 12, padding: "14px 16px", boxSizing: "border-box" } },
      h("div", { style: { fontSize: "10px", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: MUTE, lineHeight: 1.3 } }, label),
      h("div", { title: value, style: { fontSize: "22px", fontWeight: 800, color: color || WHITE, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums", marginTop: "auto", paddingTop: 10, lineHeight: 1.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, value),
      h("div", { title: sub || undefined, style: { fontSize: "11px", color: FAINT, marginTop: 4, lineHeight: 1.4, minHeight: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, sub || "\u00a0"));
  }
  function Empty(text) {
    return h("div", { style: { padding: "18px 0", fontSize: "13px", fontStyle: "italic", color: MUTE, lineHeight: 1.5 } }, text);
  }
  function mapsHref(addr) { return "https://maps.google.com/?q=" + encodeURIComponent(addr); }
  function calGlyph(color) {
    return h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", style: { flexShrink: 0 } },
      h("rect", { x: 2, y: 3, width: 12, height: 11, rx: 2, fill: "none", stroke: color, strokeWidth: 1.4 }),
      h("line", { x1: 2, y1: 6, x2: 14, y2: 6, stroke: color, strokeWidth: 1.4 }),
      h("line", { x1: 5, y1: 1.6, x2: 5, y2: 4, stroke: color, strokeWidth: 1.4, strokeLinecap: "round" }),
      h("line", { x1: 11, y1: 1.6, x2: 11, y2: 4, stroke: color, strokeWidth: 1.4, strokeLinecap: "round" }));
  }
  // Google-Calendar link for one call (confirmed only), the same event shape the
  // call sheet builds, so the crew member's calendar reads identically.
  function calHref(e) {
    if (!window.LTP_gcalUrl) return null;
    var title = "LTP - " + (e.role || e.roleLabel || "Crew") + " - " + (e.projectName || "Project");
    var note = (e.note || "").trim();
    if (e.flat) {
      var lines = (e.projectDates || []).filter(function(d) { return d && d.date; }).map(function(d) {
        return fmtDateShort(d.date) + (d.endDate ? " – " + fmtDateShort(d.endDate) : "") + (d.title ? " · " + d.title : "");
      });
      var body = ["Flat-rate position · " + fmtMoney(e.fee)].concat(lines).join("\n");
      return window.LTP_gcalUrl({ title: title, date: e.projectStart || e.date, endDate: e.projectEnd || e.projectStart || e.date, allDay: true,
        location: e.siteAddress || "", details: note ? body + "\n\n" + note : body });
    }
    var base = [e.startTime ? "Call " + fmtTime(e.startTime) : "", e.endTime ? "Wrap " + fmtTime(e.endTime) : "", e.shiftTitle || ""].filter(Boolean).join("  ·  ");
    return window.LTP_gcalUrl({ title: title, date: e.date, time: e.startTime || "", endTime: e.endTime || "",
      location: e.siteAddress || "", details: note ? (base ? base + "\n\n" + note : note) : base });
  }

  // ── Public screens: the sheet the sign-in forms sit on ────────────────────
  function AuthShell(props) {
    return h("div", { style: { minHeight: "100vh", background: BG, color: TEXT, fontFamily: FONT, padding: "0 0 40px" } },
      h("div", { style: { maxWidth: 480, margin: "0 auto", padding: props.isMobile ? "28px 24px 0" : "44px 28px 0" } },
        h(Masthead, { failed: props.mastheadFailed, onFail: props.onMastheadFail, companyName: props.companyName, maxWidth: 300 }),
        h("div", { style: { marginTop: 18 } }, Eyebrow("Crew Portal")),
        h("div", { style: { fontSize: "26px", fontWeight: 800, color: WHITE, letterSpacing: "-0.02em", lineHeight: 1.1, marginTop: 10 } }, props.title),
        props.intro && h("div", { style: { fontSize: "14px", color: MUTE, lineHeight: 1.55, marginTop: 8 } }, props.intro),
        h("div", { style: { marginTop: 26, background: INSET, border: "1px solid " + HAIR, borderRadius: 14, padding: props.isMobile ? 18 : 24 } }, props.children),
        props.footer && h("div", { style: { marginTop: 22, fontSize: "13px", color: MUTE, lineHeight: 1.6, textAlign: "center" } }, props.footer)));
  }

  function LoginScreen(props) {
    var emState = useState(""), email = emState[0], setEmail = emState[1];
    var pwState = useState(""), password = pwState[0], setPassword = pwState[1];
    var busyState = useState(false), busy = busyState[0], setBusy = busyState[1];
    var errState = useState(null), err = errState[0], setErr = errState[1];
    function submit() {
      if (busy) return;
      if (!email.trim() || !password) { setErr("Enter your email and password."); return; }
      setBusy(true); setErr(null);
      api("/auth/login", { method: "POST", body: { email: email.trim(), password: password } }).then(function(res) {
        setBusy(false);
        if (!res.ok) { setErr(errMessage(res)); return; }
        props.onSignedIn(res.data);
      });
    }
    return h(AuthShell, Object.assign({}, props.shell, {
      title: "Welcome back",
      intro: "Sign in to see your upcoming calls, answer requests, and check your pay.",
      footer: h("div", null,
        h("div", null, "First time here? ", LinkBtn({ onClick: function() { go("request-access"); } }, "Request access")),
        h("div", { style: { marginTop: 8, color: FAINT, fontSize: "12px" } }, "Access is by invitation from the production team.")) }),
      Notice("error", err),
      h(Field, { id: "cp-email", label: "Email", type: "email", value: email, onChange: setEmail, autoComplete: "username", inputMode: "email", placeholder: "you@example.com", onEnter: submit }),
      h(Field, { id: "cp-password", label: "Password", type: "password", value: password, onChange: setPassword, autoComplete: "current-password", onEnter: submit }),
      h("div", { style: { display: "flex", flexDirection: "column", gap: 12, marginTop: 6 } },
        PrimaryBtn({ onClick: submit, disabled: busy }, busy ? "Signing in…" : "Sign In"),
        h("div", { style: { textAlign: "center" } }, LinkBtn({ onClick: function() { go("forgot"); } }, "Forgot your password?"))));
  }

  // Forgot-password and request-access share one form; the copy differs. The
  // server answers the same way whether or not the address is known.
  function EmailScreen(props) {
    var isForgot = props.mode === "forgot";
    var emState = useState(props.presetEmail || ""), email = emState[0], setEmail = emState[1];
    var busyState = useState(false), busy = busyState[0], setBusy = busyState[1];
    var doneState = useState(false), done = doneState[0], setDone = doneState[1];
    var errState = useState(null), err = errState[0], setErr = errState[1];
    function submit() {
      if (busy) return;
      var v = email.trim();
      if (!v || v.indexOf("@") < 1) { setErr("Enter the email address we have on file for you."); return; }
      setBusy(true); setErr(null);
      api(isForgot ? "/auth/forgot" : "/auth/request-access", { method: "POST", body: { email: v } }).then(function(res) {
        setBusy(false);
        if (!res.ok) { setErr(errMessage(res)); return; }
        setDone(true);
      });
    }
    return h(AuthShell, Object.assign({}, props.shell, {
      title: isForgot ? "Reset your password" : "Request access",
      intro: isForgot
        ? "Enter the email you sign in with and we'll send you a link to choose a new password."
        : "Enter the email address the production team has on file for you. If it's on the crew roster, we'll email you an invitation to set up your account.",
      footer: LinkBtn({ onClick: function() { go("login"); } }, "← Back to sign in") }),
      done
        ? h("div", null,
            Notice("success", "If " + email.trim() + " is on our crew roster, an email is on its way. Check your inbox, and your spam folder, for a link from us."),
            h("div", { style: { fontSize: "13px", color: MUTE, lineHeight: 1.6 } }, isForgot
              ? "The link works for one hour. If nothing arrives, the address may not be the one we have on file. Get in touch with the production team."
              : "The invitation link works for seven days. If nothing arrives, the address may not match the roster. Get in touch with the production team."))
        : h("div", null,
            Notice("error", err),
            h(Field, { id: "cp-email2", label: "Email", type: "email", value: email, onChange: setEmail, autoComplete: "username", inputMode: "email", placeholder: "you@example.com", onEnter: submit }),
            PrimaryBtn({ onClick: submit, disabled: busy, style: { width: "100%" } }, busy ? "Sending…" : (isForgot ? "Email Me a Reset Link" : "Email Me an Invitation"))));
  }

  // Invitation acceptance and password reset: both take a one-time link and a
  // new password, both sign the crew member in on success.
  function TokenScreen(props) {
    var isSignup = props.kind === "signup";
    var infoState = useState(undefined), info = infoState[0], setInfo = infoState[1];   // undefined=loading, null=unknown
    var pwState = useState(""), password = pwState[0], setPassword = pwState[1];
    var pw2State = useState(""), password2 = pw2State[0], setPassword2 = pw2State[1];
    var busyState = useState(false), busy = busyState[0], setBusy = busyState[1];
    var errState = useState(null), err = errState[0], setErr = errState[1];
    useEffect(function() {
      if (!props.token) { setInfo(null); return; }
      api("/auth/token/" + encodeURIComponent(props.token)).then(function(res) {
        setInfo(res.ok ? res.data : null);
      });
    }, [props.token]);

    function submit() {
      if (busy) return;
      if (password.length < 8) { setErr("Use at least 8 characters."); return; }
      if (password !== password2) { setErr("Those passwords don't match."); return; }
      setBusy(true); setErr(null);
      api(isSignup ? "/auth/signup" : "/auth/reset", { method: "POST", body: { token: props.token, password: password } }).then(function(res) {
        setBusy(false);
        if (!res.ok) { setErr(errMessage(res)); return; }
        props.onSignedIn(res.data);
      });
    }
    var title = isSignup ? "Set up your account" : "Choose a new password";
    var body;
    if (info === undefined) {
      body = h("div", { style: { padding: "12px 0" } }, h("div", { className: "ltp-cp-shimmer", style: { height: 4, width: 120, borderRadius: 2 } }));
    } else if (!info || info.kind !== (isSignup ? "invite" : "reset")) {
      body = h("div", null,
        Notice("error", "This link isn't valid. It may have been copied incompletely."),
        LinkBtn({ onClick: function() { go(isSignup ? "request-access" : "forgot"); } }, isSignup ? "Request a new invitation" : "Request a new reset link"));
    } else if (!info.valid) {
      var why = info.reason === "used" ? "This link has already been used."
        : info.reason === "expired" ? "This link has expired."
        : info.reason === "inactive" ? "This crew profile is no longer active. Please contact the production team."
        : "This link isn't valid any more.";
      body = h("div", null,
        Notice("error", why),
        info.reason !== "inactive" && (info.kind === "invite"
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
              h("div", { style: { fontSize: "13px", color: MUTE, lineHeight: 1.6 } }, "Already set up? Sign in instead. Otherwise ask for a fresh invitation. It's sent to " + (info.email || "your roster email") + "."),
              PrimaryBtn({ onClick: function() { go("login"); } }, "Sign In"),
              QuietBtn({ onClick: function() { props.onPresetEmail(info.email || ""); go("request-access"); } }, "Request a New Invitation"))
          : h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
              PrimaryBtn({ onClick: function() { props.onPresetEmail(info.email || ""); go("forgot"); } }, "Request a New Reset Link"),
              QuietBtn({ onClick: function() { go("login"); } }, "Back to Sign In"))));
    } else {
      body = h("div", null,
        Notice("error", err),
        h("div", { style: { fontSize: "13px", color: MUTE, lineHeight: 1.6, marginBottom: 16 } },
          isSignup
            ? h("span", null, "You'll sign in as ", h("strong", { style: { color: WHITE } }, info.email), ". Pick a password that's at least 8 characters. A few words you'll remember work best.")
            : h("span", null, "Choose a new password for ", h("strong", { style: { color: WHITE } }, info.email), ". Any other device signed in as you will be signed out.")),
        // A hidden username field lets password managers pair the new password
        // with the right login.
        h("input", { type: "email", value: info.email || "", readOnly: true, autoComplete: "username", "aria-hidden": "true", tabIndex: -1, style: { position: "absolute", opacity: 0, height: 0, width: 0, border: 0, padding: 0 } }),
        h(Field, { id: "cp-pw1", label: "New password", type: "password", value: password, onChange: setPassword, autoComplete: "new-password", onEnter: submit, hint: "At least 8 characters." }),
        h(Field, { id: "cp-pw2", label: "Confirm password", type: "password", value: password2, onChange: setPassword2, autoComplete: "new-password", onEnter: submit }),
        PrimaryBtn({ onClick: submit, disabled: busy, style: { width: "100%" } }, busy ? "Saving…" : (isSignup ? "Create My Account" : "Save New Password")));
    }
    return h(AuthShell, Object.assign({}, props.shell, {
      title: (info && info.valid && info.firstName ? "Hi " + info.firstName + ", " + title.charAt(0).toLowerCase() + title.slice(1) : title),
      intro: isSignup && info && info.valid
        ? "Your account gives you one place for your upcoming calls, the requests waiting on you, and what you're owed."
        : null,
      companyName: info && info.companyName,
      footer: info === undefined ? null : LinkBtn({ onClick: function() { go("login"); } }, "Already have a password? Sign in") }), body);
  }

  // Finishing an email change. The link went to the NEW address, so opening
  // it proves the crew member can read that inbox; the change itself was
  // already authorised with their password on the Account tab. Works signed
  // in or out (a phone may open the link while the app is signed out), and
  // never signs anyone in by itself, unlike a reset.
  function EmailConfirmScreen(props) {
    var infoState = useState(undefined), info = infoState[0], setInfo = infoState[1];   // undefined=loading, null=unknown
    var busyState = useState(false), busy = busyState[0], setBusy = busyState[1];
    var errState = useState(null), err = errState[0], setErr = errState[1];
    var doneState = useState(""), done = doneState[0], setDone = doneState[1];          // the confirmed address
    useEffect(function() {
      if (!props.token) { setInfo(null); return; }
      api("/auth/token/" + encodeURIComponent(props.token)).then(function(res) {
        setInfo(res.ok ? res.data : null);
      });
    }, [props.token]);
    function confirm() {
      if (busy) return;
      setBusy(true); setErr(null);
      api("/auth/confirm-email", { method: "POST", body: { token: props.token } }).then(function(res) {
        setBusy(false);
        if (!res.ok) { setErr(errMessage(res)); return; }
        setDone(res.data.email || (info && info.email) || "your new address");
        props.onConfirmed();
      });
    }
    var back = LinkBtn({ onClick: function() { go(props.signedIn ? "account" : "login"); } }, props.signedIn ? "Back to my account" : "Back to sign in");
    var body;
    if (info === undefined) {
      body = h("div", { style: { padding: "12px 0" } }, h("div", { className: "ltp-cp-shimmer", style: { height: 4, width: 120, borderRadius: 2 } }));
    } else if (done) {
      body = h("div", null,
        Notice("success", "Done. " + done + " is now your sign-in email, and where crew requests are sent."),
        PrimaryBtn({ onClick: function() { go(props.signedIn ? "account" : "login"); }, style: { width: "100%" } }, props.signedIn ? "Back to My Account" : "Sign In"));
    } else if (!info || info.kind !== "email") {
      body = h("div", null,
        Notice("error", "This link isn't valid. It may have been copied incompletely."),
        back);
    } else if (!info.valid) {
      var why = info.reason === "used" ? "This link has already been used."
        : info.reason === "expired" ? "This link has expired. Start the change again from the Account tab and a fresh link will be sent."
        : info.reason === "inactive" ? "This crew profile is no longer active. Please contact the production team."
        : "This link isn't valid any more.";
      body = h("div", null, Notice("error", why), back);
    } else {
      body = h("div", null,
        Notice("error", err),
        h("div", { style: { fontSize: "13px", color: MUTE, lineHeight: 1.6, marginBottom: 16 } },
          "Make ", h("strong", { style: { color: WHITE } }, info.email), " your sign-in email? It also becomes the address crew requests are sent to."),
        PrimaryBtn({ onClick: confirm, disabled: busy, style: { width: "100%" } }, busy ? "Confirming…" : "Confirm New Email"));
    }
    return h(AuthShell, Object.assign({}, props.shell, {
      title: (info && info.valid && info.firstName ? "Hi " + info.firstName + ", confirm your new email" : "Confirm your new email"),
      companyName: info && info.companyName,
      footer: (info === undefined || done) ? null : back }), body);
  }

  // ── Dashboard: the signed-in shell ────────────────────────────────────────
  function tabIcon(id, color) {
    var s = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: color, strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" };
    if (id === "overview") return h("svg", s, h("path", { d: "M3 11 12 4l9 7" }), h("path", { d: "M5 10v10h14V10" }), h("path", { d: "M10 20v-6h4v6" }));
    if (id === "schedule") return h("svg", s, h("rect", { x: 3, y: 5, width: 18, height: 16, rx: 2 }), h("path", { d: "M3 10h18M8 3v4M16 3v4" }));
    if (id === "payouts") return h("svg", s, h("circle", { cx: 12, cy: 12, r: 9 }), h("path", { d: "M12 7v10M14.5 9.5c0-1-1.1-1.7-2.5-1.7s-2.5.7-2.5 1.7 1 1.5 2.5 1.8 2.5.8 2.5 1.9-1.1 1.7-2.5 1.7-2.5-.7-2.5-1.7" }));
    return h("svg", s, h("circle", { cx: 12, cy: 8, r: 4 }), h("path", { d: "M4 21c0-4 3.6-7 8-7s8 3 8 7" }));
  }

  function Portal(props) {
    var user = props.user, route = props.route, isMobile = props.isMobile;
    var tab = TABS.some(function(t) { return t.id === route.sub; }) ? route.sub : "overview";
    var today = todayLocalISO();
    var dataState = useState(null), data = dataState[0], setData = dataState[1];
    var errState = useState(null), loadErr = errState[0], setLoadErr = errState[1];
    var toastState = useState(null), toast = toastState[0], setToast = toastState[1];
    var toastTimer = useRef(null);

    function reload() {
      return api("/dashboard?today=" + today).then(function(res) {
        if (res.status === 401) { props.onSignedOut(); return; }
        if (!res.ok) { setLoadErr(errMessage(res, "Couldn't load your dashboard.")); return; }
        setData(tidyDashboard(res.data)); setLoadErr(null);
      });
    }
    useEffect(function() { reload(); }, [user && user.id]);
    // Refresh whenever the phone comes back to the app (the moment it is
    // most likely to be wrong) and on the freshness poll below.
    useEffect(function() {
      function onVisible() { if (!document.hidden) reload(); }
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("focus", onVisible);
      return function() { document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
    }, []);
    // A production manager moving a call, confirming them, or signing off a
    // day changes this page under them; the dashboard has no live feed, so it
    // polls the same way the call sheet does (components/domain-util.js) and
    // adopts the change silently: nothing here is mid-edit.
    var freshness = window.LTP_useDocFreshness(
      user ? API + "/dashboard/version?today=" + today : null, data && data._v);
    useEffect(function() { if (freshness === "stale") reload(); }, [freshness]);

    function showToast(text, kind) {
      setToast({ text: text, kind: kind || "success" });
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(function() { setToast(null); }, 3200);
    }
    useEffect(function() { return function() { if (toastTimer.current) clearTimeout(toastTimer.current); }; }, []);

    function signOut() {
      api("/auth/logout", { method: "POST", body: {} }).then(function() { props.onSignedOut(); });
    }

    var first = user.firstName || (user.name || "").split(" ")[0] || "";
    var hr = new Date().getHours();
    var greeting = hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";

    var tabStrip = h("div", { role: "tablist", style: { display: "flex", gap: 4, marginTop: 22, borderBottom: "1px solid " + HAIR } },
      TABS.map(function(t) {
        var active = t.id === tab;
        return h("button", { key: t.id, role: "tab", "aria-selected": active, className: "ltp-cp-tab ltp-cp-tap", onClick: function() { go(t.id); },
          style: { background: "none", border: "none", borderBottom: "2px solid " + (active ? ORANGE : "transparent"), marginBottom: -1, padding: "10px 14px", color: active ? WHITE : MUTE, fontFamily: "inherit", fontSize: "13px", fontWeight: 700, letterSpacing: "0.04em", cursor: "pointer" } }, t.label);
      }));

    var bottomNav = h("nav", { style: { position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 900, background: INSET, borderTop: "1px solid " + HAIR, boxShadow: "0 -2px 12px rgba(0,0,0,0.25)" } },
      h("div", { style: { height: 3, background: GRAD_RULE } }),
      h("div", { style: { display: "flex", paddingBottom: "max(8px, calc(env(safe-area-inset-bottom) - 10px))" } },
        TABS.map(function(t) {
          var active = t.id === tab;
          return h("button", { key: t.id, className: "ltp-cp-tap", onClick: function() { go(t.id); }, "aria-label": t.label,
            style: { flex: 1, minHeight: 52, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit", padding: "6px 2px" } },
            tabIcon(t.id, active ? ORANGE : MUTE),
            h("span", { style: { fontSize: "10px", fontWeight: active ? 700 : 500, color: active ? ORANGE_SOFT : MUTE, letterSpacing: "0.03em" } }, t.label));
        })));

    var content;
    if (!data && !loadErr) {
      content = h("div", { style: { padding: "48px 0", display: "flex", flexDirection: "column", alignItems: "center" } },
        h("div", { className: "ltp-cp-shimmer", style: { height: 4, width: 120, borderRadius: 2 } }),
        h("div", { style: { fontSize: "13px", color: MUTE, marginTop: 16 } }, "Loading your dashboard…"));
    } else if (loadErr && !data) {
      content = h("div", { style: { padding: "32px 0" } }, Notice("error", loadErr), QuietBtn({ onClick: reload }, "Try Again"));
    } else if (tab === "schedule") {
      content = h(ScheduleTab, { data: data, today: today, isMobile: isMobile });
    } else if (tab === "payouts") {
      content = h(PayoutsTab, { data: data, today: today, isMobile: isMobile });
    } else if (tab === "account") {
      content = h(AccountTab, { user: user, data: data, onUser: props.onUser, onSignOut: signOut, showToast: showToast, isMobile: isMobile });
    } else {
      content = h(OverviewTab, { data: data, today: today, isMobile: isMobile, reload: reload, showToast: showToast });
    }

    var settings = (data && data.settings) || {};
    var websiteHref = settings.website ? (/^https?:\/\//i.test(settings.website) ? settings.website : "https://" + settings.website) : null;

    return h("div", { style: { minHeight: "100vh", background: BG, color: TEXT, fontFamily: FONT, padding: "0 0 " + (isMobile ? 96 : 48) + "px" } },
      h("div", { style: { maxWidth: 1180, margin: "0 auto", padding: isMobile ? "24px 20px 0" : "36px 32px 0" } },
        h("div", { style: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 } },
          h("div", { style: { flex: 1, minWidth: 0 } }, h(Masthead, { failed: props.mastheadFailed, onFail: props.onMastheadFail, companyName: settings.companyName, maxWidth: isMobile ? 220 : 300 }))),
        h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginTop: 18 } },
          Eyebrow("Crew Portal"),
          h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: MUTE } }, fmtDateShort(today))),
        h("div", { style: { fontSize: isMobile ? "24px" : "28px", fontWeight: 800, color: WHITE, letterSpacing: "-0.02em", lineHeight: 1.1, marginTop: 10 } },
          tab === "overview" ? greeting + (first ? ", " + first : "") : (TABS.find(function(t) { return t.id === tab; }) || {}).label),
        !isMobile && tabStrip,
        toast && h("div", { style: { position: "fixed", top: "max(16px, env(safe-area-inset-top))", left: "50%", transform: "translateX(-50%)", zIndex: 1200, minWidth: 220, maxWidth: "calc(100% - 32px)", background: INSET, borderRadius: 8, boxShadow: "0 12px 32px rgba(0,0,0,0.45)" } },
          h("div", { style: { marginBottom: -14 } }, Notice(toast.kind, toast.text))),
        h("div", { style: { marginTop: 24 } }, content),
        h("div", { style: { marginTop: 44, paddingTop: 20, borderTop: "1px solid " + HAIR, textAlign: "center", fontSize: "11px", color: MUTE, lineHeight: 1.6 } },
          h("span", null, settings.companyName || "Luminary Technology & Productions"),
          websiteHref && h("span", { style: { color: FAINT } }, "  ·  "),
          websiteHref && h("a", { href: websiteHref, target: "_blank", rel: "noopener noreferrer", style: { color: MUTE, textDecoration: "none" } }, settings.website))),
      isMobile && bottomNav);
  }

  // ── A request awaiting the crew member's answer ───────────────────────────
  function RequestCard(props) {
    var r = props.request;
    var modeState = useState(null), mode = modeState[0], setMode = modeState[1];   // null | accept | decline
    var noteState = useState(""), note = noteState[0], setNote = noteState[1];
    var busyState = useState(false), busy = busyState[0], setBusy = busyState[1];
    var errState = useState(null), err = errState[0], setErr = errState[1];
    var shifts = r.shifts || [];
    var flatOnly = shifts.length > 0 && shifts.every(function(s) { return s.flat; });
    var hasFlat = shifts.some(function(s) { return s.flat; });
    function submit() {
      if (busy || !mode) return;
      setBusy(true); setErr(null);
      api("/requests/" + r.id + "/respond", { method: "POST", body: { decision: mode, comment: note.trim() } }).then(function(res) {
        setBusy(false);
        if (!res.ok) { setErr(errMessage(res)); return; }
        props.showToast(mode === "accept" ? "Accepted. A production manager will confirm you shortly." : "Thanks for letting us know.");
        props.reload();
      });
    }
    var range = fmtRange(r.startDate, r.endDate);
    var meta = [r.venue, range].filter(Boolean).join("  ·  ");
    var preview = shifts.slice(0, 4).map(function(s, i) {
      if (s.flat) return h("div", { key: i, style: { display: "flex", gap: 10, alignItems: "baseline", fontSize: "13px", padding: "4px 0" } },
        h("span", { style: { color: ORANGE_SOFT, fontFamily: MONO, fontSize: "12px", flexShrink: 0 } }, "Flat-rate"),
        h("span", { style: { color: TEXT } }, s.roleLabel + (s.fee != null ? " · " + fmtMoney(s.fee) : "")));
      return h("div", { key: i, style: { display: "flex", gap: "4px 10px", alignItems: "baseline", flexWrap: "wrap", fontSize: "13px", padding: "4px 0" } },
        h("span", { style: { color: ORANGE_SOFT, fontFamily: MONO, fontVariantNumeric: "tabular-nums", fontSize: "12px", flexShrink: 0, minWidth: 82 } }, fmtDateShort(s.date)),
        h("span", { style: { color: MUTE, fontFamily: MONO, fontVariantNumeric: "tabular-nums", fontSize: "12px", flexShrink: 0 } }, s.startTime ? fmtTime(s.startTime) + (s.endTime ? " – " + fmtTime(s.endTime) : "") : ""),
        h("span", { style: { color: TEXT, minWidth: 0, flex: "1 1 160px" } }, s.roleLabel));
    });
    return Card(h("div", null,
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" } },
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { style: { fontSize: "18px", fontWeight: 800, color: WHITE, letterSpacing: "-0.01em", lineHeight: 1.2 } }, r.projectName),
          meta && h("div", { style: { fontSize: "12px", fontWeight: 600, color: ORANGE_SOFT, marginTop: 4 } }, meta)),
        Chip(r.askLabel || (shifts.length + " calls"), "info")),
      h("div", { style: { marginTop: 12, borderTop: "1px solid " + HAIR, paddingTop: 8 } }, preview,
        shifts.length > 4 && h("div", { style: { fontSize: "12px", color: FAINT, paddingTop: 4 } }, "+ " + (shifts.length - 4) + " more on the call sheet")),
      r.siteAddress && h("a", { href: mapsHref(r.siteAddress), target: "_blank", rel: "noopener", style: { display: "inline-block", fontSize: "12px", color: MUTE, marginTop: 8, textDecoration: "underline", textDecorationColor: HAIR, textUnderlineOffset: "3px" } }, r.siteAddress),
      h("div", { style: { display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" } },
        PrimaryBtn({ onClick: function() { setMode("accept"); setErr(null); }, disabled: busy, style: { flex: "1 1 160px", minHeight: 46, opacity: mode === "decline" ? 0.45 : 1 } }, flatOnly ? "Accept This Position" : (hasFlat ? "Accept" : "Accept These Calls")),
        QuietBtn({ onClick: function() { setMode("decline"); setErr(null); }, disabled: busy, style: { flex: "1 1 120px", minHeight: 46, opacity: mode === "accept" ? 0.45 : 1 } }, "I Can't Make It"),
        h("a", { href: "/#/crew/" + r.token, target: "_blank", rel: "noopener", className: "ltp-cp-tap",
          style: { flex: "1 1 120px", minHeight: 46, display: "inline-flex", alignItems: "center", justifyContent: "center", color: ORANGE_SOFT, fontSize: "13px", fontWeight: 700, textDecoration: "none", border: "1.5px dashed " + HAIR, borderRadius: 10, boxSizing: "border-box" } }, "Full call sheet ↗")),
      mode && h("div", { className: "ltp-cp-pop", style: { marginTop: 14 } },
        h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: mode === "accept" ? SUCCESS : DANGER } },
          mode === "accept" ? "Confirming. Leave a note (optional)" : "Letting us know. What's the conflict? (optional)"),
        h("textarea", { value: note, maxLength: 1000, onChange: function(e) { setNote(e.target.value); },
          placeholder: mode === "accept" ? "Anything the team should know" : "e.g. I can't do the Saturday load-in but the rest works",
          style: { width: "100%", minHeight: 76, background: BG, border: "1px solid " + HAIR, borderRadius: 8, padding: 12, color: TEXT, fontSize: "16px", fontFamily: "inherit", outline: "none", resize: "vertical", boxSizing: "border-box", marginTop: 10 } }),
        Notice("error", err),
        h("div", { style: { display: "flex", alignItems: "center", gap: 12, marginTop: 10 } },
          LinkBtn({ onClick: function() { setMode(null); setNote(""); setErr(null); }, style: { color: NEUTRAL, textDecoration: "none", marginRight: "auto" } }, "Back"),
          mode === "accept"
            ? PrimaryBtn({ onClick: submit, disabled: busy, style: { minHeight: 44 } }, busy ? "Sending…" : "Confirm Accept")
            : QuietBtn({ onClick: submit, disabled: busy, style: { color: DANGER, borderColor: DANGER } }, busy ? "Sending…" : "Confirm Decline")))));
  }

  // ── One call on the schedule ───────────────────────────────────────────────
  function CallRow(props) {
    var e = props.entry, today = props.today, compact = props.compact;
    var when = e.flat ? fmtRange(e.projectStart, e.projectEnd) || fmtDateShort(e.date) : fmtDateShort(e.date);
    var rel = e.flat ? "" : relDay(e.date, today);
    var time = e.flat ? "Flat rate · " + fmtMoney(e.fee) : (e.startTime ? fmtTime(e.startTime) + (e.endTime ? " – " + fmtTime(e.endTime) : "") : "");
    var cal = e.status === "confirmed" ? calHref(e) : null;
    return h("div", { className: "ltp-cp-row", style: { display: "flex", gap: 14, padding: compact ? "12px 6px" : "16px 6px", borderBottom: props.isLast ? "none" : "1px solid " + HAIR, alignItems: "flex-start" } },
      h("div", { style: { width: 62, flexShrink: 0 } },
        h("div", { style: { fontSize: "11px", fontWeight: 700, color: rel === "Today" ? ORANGE : ORANGE_SOFT, textTransform: "uppercase", letterSpacing: "0.06em" } }, rel || (e.flat ? "Project" : _WEEKDAYS[(parseISO(e.date) || new Date()).getDay()])),
        h("div", { style: { fontSize: "13px", fontWeight: 600, color: WHITE, marginTop: 2, lineHeight: 1.25 } }, e.flat ? when : fmtMonthDay(e.date))),
      h("div", { style: { flex: 1, minWidth: 0 } },
        h("div", { style: { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline", flexWrap: "wrap" } },
          h("div", { style: { fontSize: compact ? "14px" : "15px", fontWeight: 700, color: WHITE, letterSpacing: "-0.01em", lineHeight: 1.25 } }, e.roleLabel || "Crew"),
          time && h("div", { style: { fontSize: "12px", fontWeight: 500, color: ORANGE_SOFT, fontFamily: MONO, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } }, time)),
        h("div", { style: { fontSize: "12px", color: MUTE, marginTop: 3, lineHeight: 1.4 } },
          e.projectName + (e.shiftTitle ? "  ·  " + e.shiftTitle : "") + (e.venue ? "  ·  " + e.venue : "")),
        !compact && e.note && h("div", { style: { marginTop: 8, padding: "7px 10px", background: PANEL, borderRadius: 6, borderLeft: "2px solid " + ORANGE, fontSize: "12px", color: TEXT, lineHeight: 1.5, whiteSpace: "pre-wrap" } }, e.note),
        h("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 8 } },
          statusChip(e.status),
          e.signedOff && Chip("Signed off", "success"),
          !compact && e.siteAddress && h("a", { href: mapsHref(e.siteAddress), target: "_blank", rel: "noopener", style: { fontSize: "12px", color: MUTE, textDecoration: "underline", textDecorationColor: HAIR, textUnderlineOffset: "3px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" } }, e.siteAddress),
          !compact && cal && h("a", { href: cal, target: "_blank", rel: "noopener", style: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: "12px", fontWeight: 600, color: SUCCESS, textDecoration: "none" } }, calGlyph(SUCCESS), "Add to calendar"),
          !compact && e.requestToken && h("a", { href: "/#/crew/" + e.requestToken, target: "_blank", rel: "noopener", style: { fontSize: "12px", fontWeight: 600, color: ORANGE_SOFT, textDecoration: "none" } }, "Call sheet ↗"))));
  }

  function callList(entries, today, opts) {
    opts = opts || {};
    if (!entries.length) return Empty(opts.empty || "Nothing here yet.");
    return h("div", { style: { marginLeft: -6, marginRight: -6, background: PANEL, borderTop: "1px solid " + ORANGE, borderBottom: "1px solid " + ORANGE, padding: "0 6px" } },
      entries.map(function(e, i) {
        return h(CallRow, { key: (e.projectId || "p") + ":" + (e.positionId || i), entry: e, today: today, compact: !!opts.compact, isLast: i === entries.length - 1 });
      }));
  }

  // ── Overview ───────────────────────────────────────────────────────────────
  // Top to bottom: the four tiles; this pay period beside the recent answers
  // (the two things a crew member checks most often); whatever is waiting on
  // their answer; and the next few calls last, with the full schedule one tap
  // away on its own tab.
  function OverviewTab(props) {
    var d = props.data, today = props.today, isMobile = props.isMobile;
    var stats = d.stats || {};
    var requests = d.requests || [];
    var upcoming = d.upcoming || [];
    var recent = d.recent || [];
    var pay = d.payouts || {};
    var current = (pay.periods || []).find(function(p) { return p.current; });
    var next = stats.nextCall;
    var nextLabel = next ? (next.flat ? fmtRange(next.projectStart, next.projectEnd) : (relDay(next.date, today) || fmtDateShort(next.date))) : "None";

    var payCard = pay.configured === false || !current
      ? Card(Empty("Pay periods aren't set up yet."))
      : Card(h("div", null,
          h("div", { style: { fontSize: "12px", color: MUTE } }, current.label),
          h("div", { style: { display: "flex", alignItems: "baseline", gap: 10, marginTop: 6, flexWrap: "wrap" } },
            h("div", { style: { fontSize: "26px", fontWeight: 800, color: WHITE, fontFamily: MONO, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" } }, fmtMoney(current.signedTotal)),
            h("div", { style: { fontSize: "12px", color: MUTE } }, "signed off" + (current.pendingEstimate > 0 ? " · ~" + fmtMoney(current.pendingEstimate) + " pending" : ""))),
          h("div", { style: { fontSize: "12px", color: MUTE, marginTop: 8 } }, "Pay day " + fmtDateShort(current.payDay)),
          h("div", { style: { marginTop: 10 } }, billChip(current.bill))));

    var recentCard = recent.length === 0
      ? Card(Empty("Your answers to recent requests show up here."))
      : Card(h("div", null, recent.slice(0, 5).map(function(r, i) {
          var tone = r.status === "declined" ? "danger" : r.released ? "neutral" : r.confirmed ? "success" : "amber";
          var label = r.status === "declined" ? "Declined" : r.released ? "Released" : r.confirmed ? "Confirmed" : "Awaiting confirmation";
          return h("div", { key: r.id, style: { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", padding: "8px 0", borderBottom: i === Math.min(recent.length, 5) - 1 ? "none" : "1px solid " + HAIR } },
            h("div", { style: { minWidth: 0 } },
              h("div", { style: { fontSize: "13px", fontWeight: 600, color: WHITE, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, r.projectName),
              h("div", { style: { fontSize: "11px", color: FAINT, marginTop: 2 } }, fmtStamp(r.respondedAt))),
            Chip(label, tone));
        })));

    return h("div", null,
      TileGrid(isMobile,
        Tile("Needs your answer", String(stats.pendingRequests || 0), (stats.pendingRequests || 0) === 1 ? "open request" : "open requests", (stats.pendingRequests || 0) > 0 ? ORANGE_SOFT : WHITE),
        Tile("Awaiting confirmation", String(stats.awaitingConfirmation || 0), "accepted, unconfirmed"),
        Tile("Confirmed calls", String(stats.confirmedUpcoming || 0), "coming up"),
        Tile("Next call", nextLabel, next ? (next.role || next.roleLabel || "Crew") + " · " + (next.projectName || "") : "nothing confirmed yet")),

      h("div", { style: { marginTop: 30, display: "grid", gridTemplateColumns: isMobile ? "minmax(0,1fr)" : "minmax(0,1fr) minmax(0,1fr)", gap: 14 } },
        h("div", null,
          SectionTitle("This pay period", LinkBtn({ onClick: function() { go("payouts"); } }, "All pay →")),
          payCard),
        h("div", null,
          SectionTitle("Recent responses"),
          recentCard)),

      h("div", { style: { marginTop: 30 } },
        SectionTitle("Needs your answer"),
        requests.length === 0
          ? Empty("No requests are waiting on you. When a production manager sends one it appears here and in your email.")
          : h("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
              requests.map(function(r) { return h(RequestCard, { key: r.id, request: r, reload: props.reload, showToast: props.showToast }); }))),

      h("div", { style: { marginTop: 30 } },
        SectionTitle("Next up", LinkBtn({ onClick: function() { go("schedule"); } }, "Full schedule →")),
        callList(upcoming.slice(0, 5), today, { compact: true, empty: "No upcoming calls yet." })));
  }

  // ── Schedule: calendar math ────────────────────────────────────────────────
  // Pure ISO-date helpers (exported on LTPCrewPortal._cal for the tests).
  // Weeks run Sunday to Saturday, like the Labor calendar.
  function addDaysISO(iso, n) {
    var d = parseISO(iso);
    if (!d) return iso;
    d.setDate(d.getDate() + n);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function weekStartISO(iso) { var d = parseISO(iso); return d ? addDaysISO(iso, -d.getDay()) : iso; }
  function monthStartISO(iso) { return String(iso || "").slice(0, 7) + "-01"; }
  function addMonthsISO(iso, n) {
    var d = parseISO(iso);
    if (!d) return iso;
    var m = d.getMonth() + n, y = d.getFullYear() + Math.floor(m / 12);
    m = ((m % 12) + 12) % 12;
    return y + "-" + pad2(m + 1) + "-01";
  }
  // The seven ISO dates of the week holding `iso`.
  function weekDays(iso) {
    var start = weekStartISO(iso), out = [];
    for (var i = 0; i < 7; i++) out.push(addDaysISO(start, i));
    return out;
  }
  // The month grid: whole weeks from the Sunday on or before the 1st to the
  // Saturday on or after the last day (four to six rows of seven), each cell
  // { iso, inMonth }.
  function monthGrid(iso) {
    var first = monthStartISO(iso), d = parseISO(first);
    if (!d) return [];
    var last = addDaysISO(first, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - 1);
    var cur = weekStartISO(first), stop = addDaysISO(weekStartISO(last), 6), month = first.slice(0, 7), out = [];
    while (cur <= stop && out.length < 42) { out.push({ iso: cur, inMonth: cur.slice(0, 7) === month }); cur = addDaysISO(cur, 1); }
    return out;
  }
  // Calls keyed by ISO date, timed calls first by call time. A flat-rate
  // position has no call times, so the calendar lays it onto every day of its
  // project's date range (capped at 62 days, the spread Labor's Weekly
  // Schedule uses) to show the job is running; the list view keeps it as one
  // block.
  function entriesByDate(entries) {
    var map = {};
    function add(iso, e) { if (iso) (map[iso] = map[iso] || []).push(e); }
    (entries || []).forEach(function(e) {
      if (!e) return;
      if (!e.flat) { add(e.date, e); return; }
      var start = e.projectStart || e.date, end = e.projectEnd || start;
      if (!parseISO(start)) return;
      if (!parseISO(end) || end < start) end = start;
      var cur = start, n = 0;
      while (cur <= end && n < 62) { add(cur, e); cur = addDaysISO(cur, 1); n++; }
    });
    Object.keys(map).forEach(function(k) {
      map[k].sort(function(a, b) { return (a.flat ? 1 : 0) - (b.flat ? 1 : 0) || String(a.startTime || "").localeCompare(String(b.startTime || "")); });
    });
    return map;
  }
  function statusColor(status) {
    return status === "confirmed" ? SUCCESS : status === "accepted" ? AMBER : status === "requested" ? INFO : status === "declined" ? DANGER : NEUTRAL;
  }
  // "8:00a" / "4:30p": the compact clock for calendar cells.
  function fmtTimeShort(t) { return fmtTime(t).replace(" AM", "a").replace(" PM", "p"); }

  // ── Schedule ───────────────────────────────────────────────────────────────
  // Three ways to read the same calls: the list (upcoming, or recently
  // worked), a week, or a month. The calendars hold every upcoming call plus
  // the last few weeks of confirmed work, the same span the list covers.
  function ScheduleTab(props) {
    var d = props.data, today = props.today, isMobile = props.isMobile;
    var modeState = useState("list"), mode = modeState[0], setMode = modeState[1];          // list | week | month
    var viewState = useState("upcoming"), view = viewState[0], setView = viewState[1];     // list only: upcoming | past
    var anchorState = useState(today), anchor = anchorState[0], setAnchor = anchorState[1]; // a day inside the shown week or month
    var pickState = useState(today), picked = pickState[0], setPicked = pickState[1];     // month view: the day whose calls are listed
    var upcoming = d.upcoming || [], past = d.past || [];
    var confirmedCal = upcoming.filter(function(e) { return e.status === "confirmed"; });
    var byDate = entriesByDate(upcoming.concat(past));

    function segRow(items, active, onPick) {
      return h("div", { style: { display: "flex", gap: 8, flex: "1 1 220px", minWidth: 0 } }, items.map(function(it) {
        var on = it.id === active;
        return h("button", { key: it.id, type: "button", className: "ltp-cp-tap", "aria-pressed": on, onClick: function() { onPick(it.id); },
          style: { flex: 1, minHeight: 36, background: on ? "rgba(239,88,34,0.16)" : "transparent", color: on ? ORANGE_SOFT : MUTE, border: "1px solid " + (on ? "rgba(239,88,34,0.5)" : HAIR), borderRadius: 8, fontFamily: "inherit", fontSize: "12px", fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" } },
          it.label);
      }));
    }
    function navBtn(label, onClick, aria) {
      return h("button", { type: "button", className: "ltp-cp-quiet ltp-cp-tap", "aria-label": aria, onClick: onClick,
        style: { minWidth: 40, minHeight: 36, padding: "0 12px", background: "transparent", color: TEXT, border: "1px solid " + HAIR, borderRadius: 8, fontFamily: "inherit", fontSize: "13px", fontWeight: 700, cursor: "pointer" } }, label);
    }
    function navBar(title, onPrev, onNext) {
      return h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 16 } },
        navBtn("‹", onPrev, "Previous"), navBtn("›", onNext, "Next"),
        h("div", { style: { flex: 1, minWidth: 0, fontSize: "15px", fontWeight: 800, color: WHITE, letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingLeft: 4 } }, title),
        navBtn("Today", function() { setAnchor(today); setPicked(today); }, "Jump to today"));
    }
    // Where a month lands you: today when it is in that month, else the 1st.
    function pickFor(monthIso) { return monthIso.slice(0, 7) === today.slice(0, 7) ? today : monthStartISO(monthIso); }

    // One call inside a calendar cell: call time, role, project. The left
    // edge carries the status colour; a dashed edge is a flat-rate job.
    function calBlock(e, i, iso, first) {
      var c = statusColor(e.status);
      var time = e.flat ? "Flat rate" : (e.startTime ? fmtTimeShort(e.startTime) + (e.endTime ? " – " + fmtTimeShort(e.endTime) : "") : "Time TBD");
      var tip = (e.roleLabel || "Crew") + " · " + (e.projectName || "") + (e.shiftTitle ? " · " + e.shiftTitle : "") + (e.venue ? " · " + e.venue : "") + " · " + (e.status === "confirmed" ? "Confirmed" : e.status === "accepted" ? "Awaiting confirmation" : e.status === "requested" ? "Needs your answer" : e.status || "");
      return h("div", { key: (e.positionId || i) + ":" + iso, title: tip,
        style: { marginTop: first ? 0 : 6, padding: "6px 8px", background: PANEL, borderRadius: 6, borderLeft: "3px " + (e.flat ? "dashed" : "solid") + " " + c, minWidth: 0 } },
        h("div", { style: { fontSize: "11px", fontWeight: 700, color: c, fontFamily: MONO, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, time),
        h("div", { style: { fontSize: "12px", fontWeight: 700, color: WHITE, lineHeight: 1.25, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, e.roleLabel || "Crew"),
        h("div", { style: { fontSize: "11px", color: MUTE, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, (e.projectName || "") + (e.shiftTitle ? " · " + e.shiftTitle : "")));
    }
    function dayHead(iso, isToday, big) {
      var dd = parseISO(iso) || new Date();
      return [
        h("div", { key: "w", style: { fontSize: "10px", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: isToday ? ORANGE : MUTE } }, _WEEKDAYS[dd.getDay()]),
        h("div", { key: "n", style: { fontSize: big ? "16px" : "13px", fontWeight: 800, color: isToday ? ORANGE : WHITE, fontVariantNumeric: "tabular-nums", lineHeight: 1.1, marginTop: 1 } }, dd.getDate()),
      ];
    }
    function weekTitle(days) {
      var a = days[0], b = days[6];
      return fmtRange(a, b) + (a.slice(0, 4) === b.slice(0, 4) ? ", " + a.slice(0, 4) : "");
    }

    // Week: seven columns on a desktop, seven stacked day rows on a phone.
    function weekView() {
      var days = weekDays(anchor);
      var bar = navBar(weekTitle(days), function() { setAnchor(addDaysISO(anchor, -7)); }, function() { setAnchor(addDaysISO(anchor, 7)); });
      if (isMobile) {
        return h("div", null, bar,
          h("div", { style: { marginTop: 12, marginLeft: -6, marginRight: -6, background: PANEL, borderTop: "1px solid " + ORANGE, borderBottom: "1px solid " + ORANGE, padding: "0 6px" } },
            days.map(function(iso, di) {
              var list = byDate[iso] || [], isToday = iso === today;
              return h("div", { key: iso, style: { display: "flex", gap: 12, padding: "10px 0", borderBottom: di === 6 ? "none" : "1px solid " + HAIR } },
                h("div", { style: { width: 44, flexShrink: 0 } }, dayHead(iso, isToday, true)),
                h("div", { style: { flex: 1, minWidth: 0 } },
                  list.length === 0
                    ? h("div", { style: { fontSize: "12px", color: FAINT, fontStyle: "italic", paddingTop: 6 } }, "No calls")
                    : list.map(function(e, i) { return calBlock(e, i, iso, i === 0); })));
            })));
      }
      return h("div", null, bar,
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 6, marginTop: 12 } },
          days.map(function(iso) {
            var list = byDate[iso] || [], isToday = iso === today;
            return h("div", { key: iso, style: { minHeight: 150, background: INSET, border: "1px solid " + (isToday ? "rgba(239,88,34,0.6)" : HAIR), borderRadius: 10, padding: "8px 8px 10px", minWidth: 0, boxSizing: "border-box" } },
              h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 4 } }, dayHead(iso, isToday, false)),
              list.length === 0
                ? h("div", { style: { fontSize: "11px", color: FAINT, fontStyle: "italic", marginTop: 10 } }, "No calls")
                : h("div", { style: { marginTop: 8 } }, list.map(function(e, i) { return calBlock(e, i, iso, i === 0); })));
          })));
    }

    // Month: a grid of days (a short line per call on a desktop, status dots
    // on a phone), then the picked day's calls in full underneath.
    function monthView() {
      var cells = monthGrid(anchor), md = parseISO(monthStartISO(anchor)) || new Date();
      var maxLines = 3;
      var bar = navBar(_MONTHS[md.getMonth()] + " " + md.getFullYear(),
        function() { var m = addMonthsISO(anchor, -1); setAnchor(m); setPicked(pickFor(m)); },
        function() { var m = addMonthsISO(anchor, 1); setAnchor(m); setPicked(pickFor(m)); });
      var pickedList = byDate[picked] || [];
      return h("div", null, bar,
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 4, marginTop: 12 } },
          _WEEKDAYS.map(function(w) {
            return h("div", { key: w, style: { textAlign: "center", fontSize: "10px", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: MUTE, padding: "4px 0" } }, isMobile ? w.charAt(0) : w);
          }),
          cells.map(function(c) {
            var list = byDate[c.iso] || [], isToday = c.iso === today, isPicked = c.iso === picked, dd = parseISO(c.iso) || new Date();
            return h("button", { key: c.iso, type: "button", className: "ltp-cp-tap", onClick: function() { setPicked(c.iso); },
              "aria-label": fmtDate(c.iso) + (list.length ? ", " + list.length + (list.length === 1 ? " call" : " calls") : ", no calls"), "aria-pressed": isPicked,
              style: { minHeight: isMobile ? 46 : 92, textAlign: "left", background: isPicked ? "rgba(239,88,34,0.14)" : INSET, border: "1px solid " + (isPicked ? "rgba(239,88,34,0.6)" : (isToday ? "rgba(249,185,152,0.55)" : HAIR)), borderRadius: 8, padding: isMobile ? "6px 2px" : "6px 8px", color: TEXT, fontFamily: "inherit", cursor: "pointer", opacity: c.inMonth ? 1 : 0.45, minWidth: 0, display: "flex", flexDirection: "column", alignItems: isMobile ? "center" : "stretch", boxSizing: "border-box" } },
              h("span", { style: { fontSize: isMobile ? "13px" : "12px", fontWeight: 800, color: isToday ? ORANGE : (c.inMonth ? WHITE : MUTE), fontVariantNumeric: "tabular-nums" } }, dd.getDate()),
              isMobile
                ? (list.length ? h("span", { style: { display: "flex", gap: 3, marginTop: 4 } },
                    list.slice(0, 3).map(function(e, i) { return h("span", { key: i, style: { width: 6, height: 6, borderRadius: "50%", background: statusColor(e.status), border: e.flat ? "1px dashed " + statusColor(e.status) : "none", boxSizing: "border-box" } }); })) : null)
                : list.slice(0, maxLines).map(function(e, i) {
                    var col = statusColor(e.status);
                    return h("span", { key: (e.positionId || i) + ":" + c.iso, title: (e.roleLabel || "Crew") + " · " + (e.projectName || ""),
                      style: { display: "block", marginTop: 3, fontSize: "10px", fontWeight: 600, color: WHITE, background: PANEL, borderLeft: "2px " + (e.flat ? "dashed" : "solid") + " " + col, borderRadius: 3, padding: "2px 5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                      (e.flat ? "Flat" : (e.startTime ? fmtTimeShort(e.startTime) : "")) + " " + (e.role || e.roleLabel || "Crew"));
                  }),
              !isMobile && list.length > maxLines && h("span", { style: { fontSize: "10px", color: FAINT, marginTop: 2 } }, "+" + (list.length - maxLines) + " more"));
          })),
        h("div", { style: { marginTop: 18 } },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, marginBottom: 8 } },
            h("div", { style: { fontSize: "13px", fontWeight: 700, color: ORANGE_SOFT } }, fmtDate(picked)),
            relDay(picked, today) && h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: relDay(picked, today) === "Today" ? ORANGE : MUTE } }, relDay(picked, today))),
          callList(pickedList, today, { empty: "No calls on this day." })));
    }

    // List: grouped by date so a multi-call day reads as one block.
    function listView() {
      var list = view === "upcoming" ? upcoming : past;
      var groups = [];
      list.forEach(function(e) {
        var key = e.flat ? "flat:" + e.projectId : e.date;
        var g = groups.length && groups[groups.length - 1].key === key ? groups[groups.length - 1] : null;
        if (!g) { g = { key: key, entries: [] }; groups.push(g); }
        g.entries.push(e);
      });
      return h("div", { style: { marginTop: 18 } },
        groups.length === 0
          ? Empty(view === "upcoming" ? "No upcoming calls. When a production manager books you, your calls appear here." : "No recent calls to show.")
          : groups.map(function(g) {
              return h("div", { key: g.key, style: { marginBottom: 22 } },
                h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, marginBottom: 8 } },
                  h("div", { style: { fontSize: "13px", fontWeight: 700, color: ORANGE_SOFT } }, g.entries[0].flat ? "Flat-rate · " + g.entries[0].projectName : fmtDate(g.key)),
                  !g.entries[0].flat && relDay(g.key, today) && h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: relDay(g.key, today) === "Today" ? ORANGE : MUTE } }, relDay(g.key, today))),
                callList(g.entries, today));
            }),
        view === "upcoming" && confirmedCal.length > 1 && h("div", { style: { marginTop: 8, fontSize: "12px", color: FAINT, lineHeight: 1.5 } },
          "Each confirmed call has its own Add to calendar button. One tap drops the date, times, role and address into your calendar."));
    }

    var intro = mode === "week"
      ? "Seven days at a glance. The coloured edge is the status: green is confirmed, amber is awaiting confirmation, blue still needs your answer. A dashed edge is a flat-rate job running that day."
      : mode === "month"
        ? "Tap a day to see its calls underneath. Past days show the last few weeks of confirmed work."
        : view === "upcoming"
          ? "Every call you're on, from today forward. A call is only locked in once it says Confirmed. Until then a production manager still has to confirm you."
          : "Confirmed calls from the last few weeks. Signed off means the day's pay has been finalized and is on its way through payroll.";

    return h("div", null,
      h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
        segRow([{ id: "list", label: "List" }, { id: "week", label: "Week" }, { id: "month", label: "Month" }], mode, function(id) {
          setMode(id);
          if (id !== "list") { setAnchor(today); setPicked(today); }
        }),
        mode === "list" && segRow([{ id: "upcoming", label: "Upcoming (" + upcoming.length + ")" }, { id: "past", label: "Recently worked (" + past.length + ")" }], view, setView)),
      h("div", { style: { fontSize: "12px", color: FAINT, marginTop: 10, lineHeight: 1.5 } }, intro),
      mode === "week" ? weekView() : mode === "month" ? monthView() : listView());
  }

  // ── Pay ────────────────────────────────────────────────────────────────────
  function billChip(bill) {
    if (!bill) return Chip("Not yet submitted");
    if (bill.status === "paid") return Chip("Paid" + (bill.paidAt ? " · " + fmtDateShort(bill.paidAt.slice(0, 10)) : ""), "success");
    if (bill.status === "submitted") return Chip("Submitted for payment", "info");
    return Chip("Not yet submitted");
  }

  function PeriodCard(props) {
    var p = props.period, isMobile = props.isMobile;
    var openState = useState(!!props.defaultOpen), open = openState[0], setOpen = openState[1];
    var hasRows = p.days.length + p.pending.length > 0;
    var tierLabel = { day: "Day", half: "Half day", hourly: "Hourly", ot: "OT", flat: "Flat rate", mixed: "Day + flat" };
    return h("div", { style: { background: INSET, border: "1px solid " + (p.current ? "rgba(249,185,152,0.45)" : HAIR), borderRadius: 14, overflow: "hidden", opacity: (hasRows || p.current || p.upcoming) ? 1 : 0.62 } },
      h("button", { type: "button", className: "ltp-cp-tap", onClick: function() { if (hasRows) setOpen(!open); }, "aria-expanded": open,
        style: { display: "flex", width: "100%", alignItems: "center", gap: 14, padding: 16, background: "transparent", border: "none", color: TEXT, fontFamily: "inherit", textAlign: "left", cursor: hasRows ? "pointer" : "default" } },
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
            h("div", { style: { fontSize: "14px", fontWeight: 700, color: WHITE } }, fmtRange(p.start, p.end)),
            p.current && Chip("Current", "amber"),
            p.upcoming && Chip("Next", "info"),
            p.number != null && h("span", { style: { fontSize: "11px", color: FAINT } }, "Period " + p.number + " · " + p.year)),
          h("div", { style: { fontSize: "12px", color: MUTE, marginTop: 4 } }, "Pay day " + fmtDateShort(p.payDay) + "  ·  " + (p.days.length + p.pending.length) + (p.days.length + p.pending.length === 1 ? " day" : " days")),
          h("div", { style: { marginTop: 8 } }, billChip(p.bill))),
        h("div", { style: { textAlign: "right", flexShrink: 0 } },
          h("div", { style: { fontSize: "20px", fontWeight: 800, color: WHITE, fontFamily: MONO, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" } }, fmtMoney(p.signedTotal)),
          p.pendingEstimate > 0 && h("div", { style: { fontSize: "11px", color: AMBER, marginTop: 2, fontFamily: MONO } }, "+ ~" + fmtMoney(p.pendingEstimate) + " pending"),
          hasRows && h("div", { style: { fontSize: "11px", color: FAINT, marginTop: 6 } }, open ? "Hide days ▴" : "Show days ▾"))),
      open && hasRows && h("div", { style: { borderTop: "1px solid " + HAIR, padding: "6px 16px 12px" } },
        p.days.map(function(day, i) {
          return h("div", { key: "d" + i, style: { padding: "10px 0", borderBottom: "1px solid " + HAIR } },
            h("div", { style: { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" } },
              h("div", { style: { minWidth: 0 } },
                h("div", { style: { fontSize: "13px", fontWeight: 600, color: WHITE } }, fmtDateShort(day.date) + "  ·  " + day.projectName),
                h("div", { style: { fontSize: "11px", color: MUTE, marginTop: 2 } },
                  [tierLabel[day.tier] || day.tier || "", day.paidHours ? day.paidHours + "h paid" : "", day.otHours ? day.otHours + "h OT" : "",
                   day.state === "no_show" ? "no show" : day.state === "adjusted" ? "adjusted" : ""].filter(Boolean).join("  ·  "))),
              h("div", { style: { fontSize: "14px", fontWeight: 700, color: WHITE, fontFamily: MONO, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } }, fmtMoney(day.payable))),
            (day.adjustments || []).map(function(a, j) {
              return h("div", { key: "a" + j, style: { display: "flex", justifyContent: "space-between", gap: 10, fontSize: "11px", color: MUTE, marginTop: 4, paddingLeft: 10 } },
                h("span", null, "↳ " + (a.label || "Adjustment")),
                h("span", { style: { fontFamily: MONO, color: a.amount < 0 ? DANGER : SUCCESS } }, (a.amount < 0 ? "− " : "+ ") + fmtMoney(Math.abs(a.amount))));
            }));
        }),
        p.pending.map(function(day, i) {
          return h("div", { key: "p" + i, style: { padding: "10px 0", borderBottom: i === p.pending.length - 1 ? "none" : "1px solid " + HAIR, display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" } },
            h("div", { style: { minWidth: 0 } },
              h("div", { style: { fontSize: "13px", fontWeight: 600, color: TEXT } }, fmtDateShort(day.date) + "  ·  " + day.projectName),
              h("div", { style: { fontSize: "11px", color: AMBER, marginTop: 2 } }, day.flat ? "Flat rate · awaiting completion sign-off" : "Awaiting sign-off")),
            h("div", { style: { fontSize: "13px", fontWeight: 600, color: AMBER, fontFamily: MONO, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } }, day.estimate != null ? "~" + fmtMoney(day.estimate) : "TBD"));
        })));
  }

  function PayoutsTab(props) {
    var pay = props.data.payouts || {};
    var periods = pay.periods || [];
    var current = periods.find(function(p) { return p.current; });
    var nextPayDay = current ? current.payDay : "";
    if (pay.configured === false) {
      return Card(Empty("Pay periods aren't configured yet. The production team sets the payroll calendar in the app. Your signed-off days will show here once they do."));
    }
    return h("div", null,
      TileGrid(props.isMobile,
        Tile("Paid this year", fmtMoney(pay.ytdPaid || 0), "bills paid through payroll"),
        Tile("This period", fmtMoney(current ? current.signedTotal : 0), current ? "signed off so far" : "no current period"),
        Tile("Pending", "~" + fmtMoney(pay.pendingEstimate || 0), "confirmed, awaiting sign-off", AMBER),
        Tile("Next pay day", nextPayDay ? fmtMonthDay(nextPayDay) : "Not set", nextPayDay ? fmtDate(nextPayDay).split(",")[0] : "no pay period yet")),
      h("div", { style: { fontSize: "12px", color: FAINT, marginTop: 14, lineHeight: 1.55 } },
        "A day's pay is finalized when the production manager signs it off after the call. Each pay period is paid on its pay day: ",
        h("strong", { style: { color: MUTE } }, "Submitted"), " means the period has gone to payroll, ",
        h("strong", { style: { color: MUTE } }, "Paid"), " means it has been paid. Pending figures are estimates from your booking and can change at sign-off."),
      h("div", { style: { marginTop: 22, display: "flex", flexDirection: "column", gap: 12 } },
        periods.length === 0 ? Empty("No pay periods to show yet.") : periods.map(function(p) {
          return h(PeriodCard, { key: p.index, period: p, isMobile: props.isMobile, defaultOpen: p.current && (p.days.length + p.pending.length) > 0 });
        })));
  }

  // ── Account ────────────────────────────────────────────────────────────────
  function AccountTab(props) {
    var user = props.user;
    var phoneState = useState(user.phone || ""), phone = phoneState[0], setPhone = phoneState[1];
    var phoneBusy = useState(false), pBusy = phoneBusy[0], setPBusy = phoneBusy[1];
    var phoneErr = useState(null), pErr = phoneErr[0], setPErr = phoneErr[1];
    var cur = useState(""), curPw = cur[0], setCurPw = cur[1];
    var nw = useState(""), newPw = nw[0], setNewPw = nw[1];
    var nw2 = useState(""), newPw2 = nw2[0], setNewPw2 = nw2[1];
    var pwBusy = useState(false), wBusy = pwBusy[0], setWBusy = pwBusy[1];
    var pwErr = useState(null), wErr = pwErr[0], setWErr = pwErr[1];
    var pwOk = useState(false), wOk = pwOk[0], setWOk = pwOk[1];
    var emState = useState(""), newEmail = emState[0], setNewEmail = emState[1];
    var emPwState = useState(""), emPw = emPwState[0], setEmPw = emPwState[1];
    var emBusyState = useState(false), emBusy = emBusyState[0], setEmBusy = emBusyState[1];
    var emErrState = useState(null), emErr = emErrState[0], setEmErr = emErrState[1];
    useEffect(function() { setPhone(user.phone || ""); }, [user.phone]);

    function savePhone() {
      if (pBusy) return;
      setPBusy(true); setPErr(null);
      api("/me", { method: "PUT", body: { phone: phone.trim() } }).then(function(res) {
        setPBusy(false);
        if (!res.ok) { setPErr(errMessage(res)); return; }
        props.onUser(res.data);
        props.showToast("Phone number saved.");
      });
    }
    function changePassword() {
      if (wBusy) return;
      if (!curPw) { setWErr("Enter your current password."); return; }
      if (newPw.length < 8) { setWErr("Use at least 8 characters for the new password."); return; }
      if (newPw !== newPw2) { setWErr("Those new passwords don't match."); return; }
      setWBusy(true); setWErr(null); setWOk(false);
      api("/auth/change-password", { method: "POST", body: { currentPassword: curPw, newPassword: newPw } }).then(function(res) {
        setWBusy(false);
        if (!res.ok) { setWErr(errMessage(res)); return; }
        setCurPw(""); setNewPw(""); setNewPw2(""); setWOk(true);
        props.showToast("Password changed. Other devices were signed out.");
      });
    }
    // A new sign-in email takes effect only when the link sent to it is
    // opened, so a typo can't lock anyone out; the current password is asked
    // for because the email IS the credential.
    function requestEmailChange() {
      if (emBusy) return;
      var v = newEmail.trim();
      if (!v || v.indexOf("@") < 1) { setEmErr("Enter the new email address."); return; }
      if (!emPw) { setEmErr("Enter your current password to change your email."); return; }
      setEmBusy(true); setEmErr(null);
      api("/me/email", { method: "POST", body: { email: v, currentPassword: emPw } }).then(function(res) {
        setEmBusy(false);
        if (!res.ok) { setEmErr(errMessage(res)); return; }
        setNewEmail(""); setEmPw("");
        if (res.data && res.data.me) props.onUser(res.data.me);
        props.showToast("Confirmation link sent to " + ((res.data && res.data.email) || v) + ".");
      });
    }
    function cancelEmailChange() {
      api("/me/email/cancel", { method: "POST", body: {} }).then(function(res) {
        if (!res.ok) { props.showToast(errMessage(res), "error"); return; }
        props.onUser(res.data);
        props.showToast("Email change cancelled.");
      });
    }
    var roleChips = (user.roles || []).map(function(r) { return h("span", { key: "r" + r, style: { fontSize: "11px", fontWeight: 700, color: ORANGE_SOFT, border: "1px solid " + HAIR, borderRadius: 4, padding: "3px 8px", letterSpacing: "0.06em" } }, r); })
      .concat((user.departments || []).map(function(d) { return h("span", { key: "d" + d, style: { fontSize: "11px", fontWeight: 600, color: MUTE, border: "1px solid " + HAIR, borderRadius: 4, padding: "3px 8px" } }, d); }));
    var row = function(label, value) {
      return h("div", { style: { display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: "1px solid " + HAIR, fontSize: "13px" } },
        h("span", { style: { color: MUTE, flexShrink: 0 } }, label),
        h("span", { style: { color: WHITE, textAlign: "right", minWidth: 0, overflowWrap: "anywhere" } }, value || "Not set"));
    };
    return h("div", { style: { display: "grid", gridTemplateColumns: props.isMobile ? "minmax(0,1fr)" : "minmax(0,1fr) minmax(0,1fr)", gap: 16 } },
      h("div", null,
        SectionTitle("Your profile"),
        Card(h("div", null,
          row("Name", user.name),
          row("Sign-in email", user.email),
          user.contactEmail && user.contactEmail.toLowerCase() !== (user.email || "").toLowerCase() && row("Requests go to", user.contactEmail),
          h("div", { style: { padding: "9px 0", borderBottom: "1px solid " + HAIR } },
            h("div", { style: { fontSize: "13px", color: MUTE, marginBottom: 6 } }, "Roles & departments"),
            roleChips.length ? h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } }, roleChips) : h("div", { style: { fontSize: "13px", color: FAINT } }, "None on file")),
          h("div", { style: { paddingTop: 14 } },
            h(Field, { id: "cp-phone", label: "Phone", type: "tel", value: phone, onChange: setPhone, autoComplete: "tel", inputMode: "tel", placeholder: "(555) 555-5555", onEnter: savePhone, hint: "The number production managers reach you on for day-of changes. Everything else on your profile is kept by the production team. Let them know if something's wrong." }),
            Notice("error", pErr),
            QuietBtn({ onClick: savePhone, disabled: pBusy || phone.trim() === (user.phone || "") }, pBusy ? "Saving…" : "Save Phone")),
          h("div", { style: { marginTop: 18, paddingTop: 16, borderTop: "1px solid " + HAIR } },
            h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: MUTE, marginBottom: 6 } }, "Change email"),
            h("div", { style: { fontSize: "12px", color: FAINT, lineHeight: 1.5, marginBottom: 12 } },
              "We'll email a confirmation link to the new address. Your sign-in email, and where crew requests are sent, changes when you open it."),
            user.pendingEmail && Notice("info", h("span", null,
              "A confirmation link is waiting at ", h("strong", { style: { color: WHITE } }, user.pendingEmail), ". Open it to finish the change, or ",
              LinkBtn({ onClick: cancelEmailChange, style: { fontSize: "13px" } }, "cancel it"), ".")),
            h(Field, { id: "cp-newemail", label: "New email", type: "email", value: newEmail, onChange: setNewEmail, autoComplete: "email", inputMode: "email", placeholder: "you@example.com" }),
            h(Field, { id: "cp-email-pw", label: "Current password", type: "password", value: emPw, onChange: setEmPw, autoComplete: "current-password", onEnter: requestEmailChange }),
            Notice("error", emErr),
            QuietBtn({ onClick: requestEmailChange, disabled: emBusy || !newEmail.trim() || !emPw }, emBusy ? "Sending…" : "Send Confirmation Link")))),
        h("div", { style: { marginTop: 22 } },
          SectionTitle("Session"),
          Card(h("div", null,
            h("div", { style: { fontSize: "12px", color: MUTE, lineHeight: 1.55, marginBottom: 12 } },
              "You stay signed in on this device for 30 days" + (user.lastLoginAt ? " · last sign-in " + fmtStamp(user.lastLoginAt) : "") + "."),
            QuietBtn({ onClick: props.onSignOut, style: { width: "100%" } }, "Sign Out"))))),
      h("div", null,
        SectionTitle("Change password"),
        Card(h("div", null,
          Notice("error", wErr),
          wOk && Notice("success", "Your password has been changed."),
          h("input", { type: "email", value: user.email || "", readOnly: true, autoComplete: "username", "aria-hidden": "true", tabIndex: -1, style: { position: "absolute", opacity: 0, height: 0, width: 0, border: 0, padding: 0 } }),
          h(Field, { id: "cp-cur", label: "Current password", type: "password", value: curPw, onChange: setCurPw, autoComplete: "current-password" }),
          h(Field, { id: "cp-new", label: "New password", type: "password", value: newPw, onChange: setNewPw, autoComplete: "new-password", hint: "At least 8 characters." }),
          h(Field, { id: "cp-new2", label: "Confirm new password", type: "password", value: newPw2, onChange: setNewPw2, autoComplete: "new-password", onEnter: changePassword }),
          PrimaryBtn({ onClick: changePassword, disabled: wBusy, style: { width: "100%", minHeight: 46 } }, wBusy ? "Saving…" : "Change Password"),
          h("div", { style: { fontSize: "12px", color: FAINT, marginTop: 12, lineHeight: 1.5 } }, "Forgot it? Sign out and use “Forgot your password?” on the sign-in screen.")))));
  }

  // ── Entry point ────────────────────────────────────────────────────────────
  window.LTPCrewPortal = function(props) {
    var route = props.route || {};
    var userState = useState(undefined), user = userState[0], setUser = userState[1];   // undefined=checking, null=signed out
    var mhState = useState(false), mastheadFailed = mhState[0], setMastheadFailed = mhState[1];
    var presetState = useState(""), presetEmail = presetState[0], setPresetEmail = presetState[1];
    var isMobile = window.LTP_useIsMobile();

    useEffect(injectStyle, []);
    // This is a normal scrolling page; the app shell sets body{overflow:hidden}.
    useEffect(function() {
      var prev = document.body.style.overflow;
      document.body.style.overflow = "auto";
      return function() { document.body.style.overflow = prev; };
    }, []);
    useEffect(function() {
      api("/auth/me").then(function(res) { setUser(res.ok ? res.data : null); });
    }, []);

    var sub = route.sub || null;
    // Signed in and on a sign-in route (a bookmarked #/crew-portal/login, the
    // back button): land on the dashboard. An effect, not a render-time
    // replace, since the router's hashchange would re-render the outer app while
    // this component is still rendering.
    useEffect(function() {
      if (user && sub && PUBLIC[sub] && sub !== "signup" && sub !== "reset" && sub !== "confirm-email") {
        window.LTPRouter.replace("crew-portal/overview");
      }
    }, [user, sub]);
    var shell = { isMobile: isMobile, mastheadFailed: mastheadFailed, onMastheadFail: function() { setMastheadFailed(true); } };

    function signedIn(u) { setUser(u); go("overview"); }
    function signedOut() { setUser(null); go("login"); }

    if (user === undefined) {
      return h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: BG, fontFamily: FONT } },
        h("div", { className: "ltp-cp-shimmer", style: { height: 4, width: 120, borderRadius: 2 } }),
        h("div", { style: { fontSize: "13px", color: MUTE, marginTop: 16 } }, "Loading…"));
    }
    // One-time links work whether or not someone is signed in on this device:
    // a shared phone must still be able to accept an invitation.
    if (sub === "signup" || sub === "reset") {
      return h(TokenScreen, { kind: sub, token: route.id, shell: shell, onSignedIn: signedIn, onPresetEmail: setPresetEmail });
    }
    if (sub === "confirm-email") {
      return h(EmailConfirmScreen, { token: route.id, shell: shell, signedIn: !!user, onConfirmed: function() {
        // A signed-in device picks up the new address straight away.
        if (user) api("/auth/me").then(function(res) { if (res.ok) setUser(res.data); });
      } });
    }
    if (user === null) {
      if (sub === "forgot" || sub === "request-access") {
        return h(EmailScreen, { mode: sub, shell: shell, presetEmail: presetEmail });
      }
      return h(LoginScreen, { shell: shell, onSignedIn: signedIn });
    }
    // Signed in: a bare #/crew-portal (or a sign-in route, until the effect
    // above moves the hash) shows the overview.
    var portalRoute = (!sub || PUBLIC[sub]) ? { sub: "overview" } : route;
    return h(Portal, { user: user, route: portalRoute, isMobile: isMobile, mastheadFailed: mastheadFailed, onMastheadFail: function() { setMastheadFailed(true); }, onSignedOut: signedOut, onUser: setUser });
  };
  // The Schedule tab's calendar math, exposed for tests/test_crew_portal_routes.js.
  window.LTPCrewPortal._cal = { addDaysISO: addDaysISO, weekStartISO: weekStartISO, addMonthsISO: addMonthsISO, weekDays: weekDays, monthGrid: monthGrid, entriesByDate: entriesByDate };
})();
