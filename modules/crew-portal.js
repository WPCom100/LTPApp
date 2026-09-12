// Crew portal — a crew member's own sign-in and dashboard.
//
// Rendered by app.js's outer LTPApp when route.module === "crew-portal",
// bypassing the staff auth gate: the crew member has no staff session. Their
// credential is the ltp_crew_session cookie set by /api/crew-portal/auth/*
// (backend/routes/crew_portal.py), a separate credential system from the
// Google sign-in the staff app uses — see backend/crew_auth.py.
//
//   #/crew-portal                   → overview when signed in, else sign-in
//   #/crew-portal/login             → sign-in
//   #/crew-portal/forgot            → email a password-reset link
//   #/crew-portal/request-access    → email an invitation to a roster address
//   #/crew-portal/signup/<token>    → accept an invitation (choose a password)
//   #/crew-portal/reset/<token>     → finish a password reset
//   #/crew-portal/overview | schedule | payouts | account     (signed in)
//
// Visual language is the crew call sheet's (modules/crew-view.js): slate
// field, masthead hero on the brand rule, mono time/money columns, orange
// accents. Phone first — crew live on their phones — so under 600px the tabs
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
  var PUBLIC = { login: 1, forgot: 1, "request-access": 1, signup: 1, reset: 1 };

  // ── Date / time / money helpers (deterministic — no toLocaleString) ────────
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

  // ── API helper — cookie-authenticated, JSON in/out, never throws ──────────
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
    if (res && res.network) return "Can't reach the server — check your connection and try again.";
    var d = res && res.data && res.data.detail;
    if (typeof d === "string") return d;
    if (d && d.message) return d.message;
    if (d && d.reason) return String(d.reason);
    if (res && res.data && res.data.error) return String(res.data.error);
    if (res && res.status === 429) return "Too many attempts — please wait a minute and try again.";
    return fallback || "Something went wrong. Please try again.";
  }
  function go(path) { window.LTPRouter.navigate("crew-portal" + (path ? "/" + path : "")); }

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
      }));
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
  // in their inbox; "accepted" means they said yes and a producer still has to
  // confirm; "confirmed" is locked in.
  function statusChip(status) {
    if (status === "confirmed") return Chip("Confirmed", "success");
    if (status === "accepted") return Chip("Awaiting confirmation", "amber");
    if (status === "requested") return Chip("Needs your answer", "info");
    if (status === "declined") return Chip("Declined", "danger");
    return Chip(status || "—");
  }
  function Card(children, style) {
    return h("div", { style: Object.assign({ background: INSET, border: "1px solid " + HAIR, borderRadius: 14, padding: 18 }, style || {}) }, children);
  }
  function Tile(label, value, sub, color) {
    return h("div", { style: { flex: "1 1 120px", minWidth: 0, background: INSET, border: "1px solid " + HAIR, borderRadius: 12, padding: "14px 16px" } },
      h("div", { style: { fontSize: "10px", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: MUTE } }, label),
      h("div", { style: { fontSize: "22px", fontWeight: 800, color: color || WHITE, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums", marginTop: 4, lineHeight: 1.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, value),
      sub && h("div", { style: { fontSize: "11px", color: FAINT, marginTop: 4, lineHeight: 1.4 } }, sub));
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
  // Google-Calendar link for one call (confirmed only) — same event shape the
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
      footer: h("div", null, "First time here? ", LinkBtn({ onClick: function() { go("request-access"); } }, "Request access")) }),
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
      footer: LinkBtn({ onClick: function() { go("login"); } }, "← Back to sign in") }),
      done
        ? Notice("success", "If " + email.trim() + " is on our crew roster, an email is on its way. Check your inbox — and your spam folder — for a link from us.")
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
        : info.reason === "inactive" ? "This crew profile is no longer active — please contact the production team."
        : "This link isn't valid any more.";
      body = h("div", null,
        Notice("error", why),
        info.reason !== "inactive" && (info.kind === "invite"
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
              PrimaryBtn({ onClick: function() { go("login"); } }, "Sign In"),
              QuietBtn({ onClick: function() { props.onPresetEmail(info.email || ""); go("request-access"); } }, "Request a New Invitation"))
          : h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
              PrimaryBtn({ onClick: function() { props.onPresetEmail(info.email || ""); go("forgot"); } }, "Request a New Reset Link"),
              QuietBtn({ onClick: function() { go("login"); } }, "Back to Sign In"))));
    } else {
      body = h("div", null,
        Notice("error", err),
        h("div", { style: { fontSize: "13px", color: MUTE, lineHeight: 1.6, marginBottom: 16 } },
          "Signing in as ", h("strong", { style: { color: WHITE } }, info.email)),
        // A hidden username field lets password managers pair the new password
        // with the right login.
        h("input", { type: "email", value: info.email || "", readOnly: true, autoComplete: "username", "aria-hidden": "true", tabIndex: -1, style: { position: "absolute", opacity: 0, height: 0, width: 0, border: 0, padding: 0 } }),
        h(Field, { id: "cp-pw1", label: "New password", type: "password", value: password, onChange: setPassword, autoComplete: "new-password", onEnter: submit, placeholder: "At least 8 characters" }),
        h(Field, { id: "cp-pw2", label: "Confirm password", type: "password", value: password2, onChange: setPassword2, autoComplete: "new-password", onEnter: submit }),
        PrimaryBtn({ onClick: submit, disabled: busy, style: { width: "100%" } }, busy ? "Saving…" : (isSignup ? "Create My Account" : "Save New Password")));
    }
    return h(AuthShell, Object.assign({}, props.shell, {
      title: (info && info.valid && info.firstName ? "Hi " + info.firstName + " — " : "") + title,
      companyName: info && info.companyName,
      footer: info === undefined ? null : LinkBtn({ onClick: function() { go("login"); } }, "Already have a password? Sign in") }), body);
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
        setData(res.data); setLoadErr(null);
      });
    }
    useEffect(function() { reload(); }, [user && user.id]);
    // Refresh whenever the phone comes back to the app — the moment it is
    // most likely to be wrong — and on the freshness poll below.
    useEffect(function() {
      function onVisible() { if (!document.hidden) reload(); }
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("focus", onVisible);
      return function() { document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
    }, []);
    // A producer moving a call, confirming them, or signing off a day changes
    // this page under them; the dashboard has no live feed, so it polls the
    // same way the call sheet does (components/domain-util.js) and adopts the
    // change silently — nothing here is mid-edit.
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
      h("div", { style: { maxWidth: 820, margin: "0 auto", padding: isMobile ? "24px 20px 0" : "36px 32px 0" } },
        h("div", { style: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 } },
          h("div", { style: { flex: 1, minWidth: 0 } }, h(Masthead, { failed: props.mastheadFailed, onFail: props.onMastheadFail, companyName: settings.companyName, maxWidth: isMobile ? 220 : 300 })),
          !isMobile && LinkBtn({ onClick: signOut, style: { color: MUTE, textDecoration: "none", fontSize: "12px", paddingBottom: 8 } }, "Sign out")),
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
        props.showToast(mode === "accept" ? "Accepted — a producer will confirm you shortly." : "Thanks for letting us know.");
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
          mode === "accept" ? "Confirming — leave a note (optional)" : "Letting us know — what's the conflict? (optional)"),
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
  function OverviewTab(props) {
    var d = props.data, today = props.today;
    var stats = d.stats || {};
    var requests = d.requests || [];
    var upcoming = d.upcoming || [];
    var recent = d.recent || [];
    var pay = d.payouts || {};
    var current = (pay.periods || []).find(function(p) { return p.current; });
    var next = stats.nextCall;
    var nextLabel = next ? (next.flat ? fmtRange(next.projectStart, next.projectEnd) : (relDay(next.date, today) || fmtDateShort(next.date))) : "—";

    return h("div", null,
      h("div", { style: { display: "flex", gap: 10, flexWrap: "wrap" } },
        Tile("Needs your answer", String(stats.pendingRequests || 0), (stats.pendingRequests || 0) === 1 ? "open request" : "open requests", (stats.pendingRequests || 0) > 0 ? ORANGE_SOFT : WHITE),
        Tile("Awaiting confirmation", String(stats.awaitingConfirmation || 0), "accepted, not yet confirmed"),
        Tile("Confirmed calls", String(stats.confirmedUpcoming || 0), "coming up"),
        Tile("Next call", nextLabel, next ? (next.roleLabel || "") + " · " + (next.projectName || "") : "nothing confirmed yet")),

      h("div", { style: { marginTop: 30 } },
        SectionTitle("Needs your answer"),
        requests.length === 0
          ? Empty("No requests waiting on you.")
          : h("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
              requests.map(function(r) { return h(RequestCard, { key: r.id, request: r, reload: props.reload, showToast: props.showToast }); }))),

      h("div", { style: { marginTop: 30 } },
        SectionTitle("Next up", LinkBtn({ onClick: function() { go("schedule"); } }, "Full schedule →")),
        callList(upcoming.slice(0, 5), today, { compact: true, empty: "No upcoming calls yet." })),

      h("div", { style: { marginTop: 30, display: "grid", gridTemplateColumns: props.isMobile ? "minmax(0,1fr)" : "minmax(0,1fr) minmax(0,1fr)", gap: 14 } },
        h("div", null,
          SectionTitle("This pay period", LinkBtn({ onClick: function() { go("payouts"); } }, "All pay →")),
          pay.configured === false || !current
            ? Card(Empty("Pay periods aren't set up yet."))
            : Card(h("div", null,
                h("div", { style: { fontSize: "12px", color: MUTE } }, current.label),
                h("div", { style: { display: "flex", alignItems: "baseline", gap: 10, marginTop: 6, flexWrap: "wrap" } },
                  h("div", { style: { fontSize: "26px", fontWeight: 800, color: WHITE, fontFamily: MONO, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" } }, fmtMoney(current.signedTotal)),
                  h("div", { style: { fontSize: "12px", color: MUTE } }, "signed off" + (current.pendingEstimate > 0 ? " · ~" + fmtMoney(current.pendingEstimate) + " pending" : ""))),
                h("div", { style: { fontSize: "12px", color: MUTE, marginTop: 8 } }, "Pay day " + fmtDateShort(current.payDay)),
                h("div", { style: { marginTop: 10 } }, billChip(current.bill))))),
        h("div", null,
          SectionTitle("Recent responses"),
          recent.length === 0
            ? Card(Empty("No responses yet."))
            : Card(h("div", null, recent.slice(0, 5).map(function(r, i) {
                var tone = r.status === "declined" ? "danger" : r.released ? "neutral" : r.confirmed ? "success" : "amber";
                var label = r.status === "declined" ? "Declined" : r.released ? "Released" : r.confirmed ? "Confirmed" : "Awaiting confirmation";
                return h("div", { key: r.id, style: { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", padding: "8px 0", borderBottom: i === Math.min(recent.length, 5) - 1 ? "none" : "1px solid " + HAIR } },
                  h("div", { style: { minWidth: 0 } },
                    h("div", { style: { fontSize: "13px", fontWeight: 600, color: WHITE, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, r.projectName),
                    h("div", { style: { fontSize: "11px", color: FAINT, marginTop: 2 } }, fmtStamp(r.respondedAt))),
                  Chip(label, tone));
              }))))));
  }

  // ── Schedule ───────────────────────────────────────────────────────────────
  function ScheduleTab(props) {
    var d = props.data, today = props.today;
    var viewState = useState("upcoming"), view = viewState[0], setView = viewState[1];
    var upcoming = d.upcoming || [], past = d.past || [];
    var seg = function(id, label, n) {
      var active = view === id;
      return h("button", { key: id, type: "button", className: "ltp-cp-tap", onClick: function() { setView(id); },
        style: { flex: 1, minHeight: 36, background: active ? "rgba(239,88,34,0.16)" : "transparent", color: active ? ORANGE_SOFT : MUTE, border: "1px solid " + (active ? "rgba(239,88,34,0.5)" : HAIR), borderRadius: 8, fontFamily: "inherit", fontSize: "12px", fontWeight: 700, cursor: "pointer" } },
        label + " (" + n + ")");
    };
    var list = view === "upcoming" ? upcoming : past;
    // Group by date so a multi-call day reads as one block.
    var groups = [];
    list.forEach(function(e) {
      var key = e.flat ? "flat:" + e.projectId : e.date;
      var g = groups.length && groups[groups.length - 1].key === key ? groups[groups.length - 1] : null;
      if (!g) { g = { key: key, entries: [] }; groups.push(g); }
      g.entries.push(e);
    });
    return h("div", null,
      h("div", { style: { display: "flex", gap: 8 } }, seg("upcoming", "Upcoming", upcoming.length), seg("past", "Recently worked", past.length)),
      h("div", { style: { marginTop: 18 } },
        groups.length === 0
          ? Empty(view === "upcoming" ? "No upcoming calls." : "No recent calls to show.")
          : groups.map(function(g) {
              return h("div", { key: g.key, style: { marginBottom: 22 } },
                h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, marginBottom: 8 } },
                  h("div", { style: { fontSize: "13px", fontWeight: 700, color: ORANGE_SOFT } }, g.entries[0].flat ? "Flat-rate · " + g.entries[0].projectName : fmtDate(g.key)),
                  !g.entries[0].flat && relDay(g.key, today) && h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: relDay(g.key, today) === "Today" ? ORANGE : MUTE } }, relDay(g.key, today))),
                callList(g.entries, today));
            })));
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
            h("div", { style: { fontSize: "13px", fontWeight: 600, color: AMBER, fontFamily: MONO, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } }, day.estimate != null ? "~" + fmtMoney(day.estimate) : "—"));
        })));
  }

  function PayoutsTab(props) {
    var pay = props.data.payouts || {};
    var periods = pay.periods || [];
    var current = periods.find(function(p) { return p.current; });
    var nextPayDay = current ? current.payDay : "";
    if (pay.configured === false) {
      return Card(Empty("Pay periods aren't set up yet."));
    }
    return h("div", null,
      h("div", { style: { display: "flex", gap: 10, flexWrap: "wrap" } },
        Tile("Paid this year", fmtMoney(pay.ytdPaid || 0), "bills paid through payroll"),
        Tile("This period", fmtMoney(current ? current.signedTotal : 0), current ? "signed off so far" : ""),
        Tile("Pending", "~" + fmtMoney(pay.pendingEstimate || 0), "confirmed, awaiting sign-off", AMBER),
        Tile("Next pay day", nextPayDay ? fmtMonthDay(nextPayDay) : "—", nextPayDay ? fmtDate(nextPayDay).split(",")[0] : "")),
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
    var roleChips = (user.roles || []).map(function(r) { return h("span", { key: "r" + r, style: { fontSize: "11px", fontWeight: 700, color: ORANGE_SOFT, border: "1px solid " + HAIR, borderRadius: 4, padding: "3px 8px", letterSpacing: "0.06em" } }, r); })
      .concat((user.departments || []).map(function(d) { return h("span", { key: "d" + d, style: { fontSize: "11px", fontWeight: 600, color: MUTE, border: "1px solid " + HAIR, borderRadius: 4, padding: "3px 8px" } }, d); }));
    var row = function(label, value) {
      return h("div", { style: { display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: "1px solid " + HAIR, fontSize: "13px" } },
        h("span", { style: { color: MUTE, flexShrink: 0 } }, label),
        h("span", { style: { color: WHITE, textAlign: "right", minWidth: 0, overflowWrap: "anywhere" } }, value || "—"));
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
            roleChips.length ? h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } }, roleChips) : h("div", { style: { fontSize: "13px", color: FAINT } }, "—")),
          h("div", { style: { paddingTop: 14 } },
            h(Field, { id: "cp-phone", label: "Phone", type: "tel", value: phone, onChange: setPhone, autoComplete: "tel", inputMode: "tel", placeholder: "(555) 555-5555", onEnter: savePhone }),
            Notice("error", pErr),
            QuietBtn({ onClick: savePhone, disabled: pBusy || phone.trim() === (user.phone || "") }, pBusy ? "Saving…" : "Save Phone")))),
        h("div", { style: { marginTop: 22 } },
          SectionTitle("Session"),
          Card(h("div", null,
            user.lastLoginAt && h("div", { style: { fontSize: "12px", color: MUTE, lineHeight: 1.55, marginBottom: 12 } }, "Last sign-in " + fmtStamp(user.lastLoginAt)),
            QuietBtn({ onClick: props.onSignOut, style: { width: "100%" } }, "Sign Out"))))),
      h("div", null,
        SectionTitle("Change password"),
        Card(h("div", null,
          Notice("error", wErr),
          wOk && Notice("success", "Your password has been changed."),
          h("input", { type: "email", value: user.email || "", readOnly: true, autoComplete: "username", "aria-hidden": "true", tabIndex: -1, style: { position: "absolute", opacity: 0, height: 0, width: 0, border: 0, padding: 0 } }),
          h(Field, { id: "cp-cur", label: "Current password", type: "password", value: curPw, onChange: setCurPw, autoComplete: "current-password" }),
          h(Field, { id: "cp-new", label: "New password", type: "password", value: newPw, onChange: setNewPw, autoComplete: "new-password", placeholder: "At least 8 characters" }),
          h(Field, { id: "cp-new2", label: "Confirm new password", type: "password", value: newPw2, onChange: setNewPw2, autoComplete: "new-password", onEnter: changePassword }),
          PrimaryBtn({ onClick: changePassword, disabled: wBusy, style: { width: "100%", minHeight: 46 } }, wBusy ? "Saving…" : "Change Password")))));
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
    // replace — the router's hashchange would re-render the outer app while
    // this component is still rendering.
    useEffect(function() {
      if (user && sub && PUBLIC[sub] && sub !== "signup" && sub !== "reset") {
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
    // One-time links work whether or not someone is signed in on this device —
    // a shared phone must still be able to accept an invitation.
    if (sub === "signup" || sub === "reset") {
      return h(TokenScreen, { kind: sub, token: route.id, shell: shell, onSignedIn: signedIn, onPresetEmail: setPresetEmail });
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
})();
