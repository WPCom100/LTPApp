// Public crew-facing view of a crew request — "The Call Sheet".
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
//
// Visual language mirrors the branded email (backend/email_compose.py): the
// orange-on-transparent masthead lockup as a left-aligned hero butting a 4px
// brand-gradient rule, then a ruled "call sheet" — numbered call lines with a
// tabular mono time column. Premium, flat, unmistakably LTP.
(function() {
  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useRef = React.useRef;

  // ── Palette (crew public surface — explicit hexes, like client-view) ───────
  var BG = "#233038";           // page field
  var TEXT = "#D1DBDA";         // primary
  var WHITE = "#FFFFFF";        // emphasis (titles, roles, greeting)
  var MUTE = "#93A3AB";         // secondary
  var FAINT = "#6E7E86";        // footer / receipts
  var ORANGE = "#EF5822";
  var ORANGE_SOFT = "#F9B998";
  var MASTHEAD_ORANGE = "#f15927"; // sampled from the logo PNG so the rule reads as the masthead's own underline
  var INSET = "#1B262C";        // surfaces that recede below the field
  var SHIFT_BG = "#202d35";     // the call-list panel — a hair off the page field
  var HAIR = "#34454E";         // structural hairlines / borders
  var GRAD_RULE = "linear-gradient(90deg,#FF921E 0%,#EF5822 50%,#64260F 100%)";
  var GRAD_BTN = "linear-gradient(135deg,#FF921E,#EF5822)";
  var BTN_INK = "#1B130D";      // near-black on the orange button
  var SUCCESS = "#5FD08A", SUCCESS_BG = "rgba(95,208,138,0.10)", SUCCESS_BD = "rgba(95,208,138,0.30)";
  var DECLINE = "#F0857A", DECLINE_BG = "rgba(240,133,122,0.10)", DECLINE_BD = "rgba(240,133,122,0.30)";
  var NEUTRAL = "#8A99A0", NEUTRAL_BG = "rgba(138,153,160,0.07)";
  var MONO = "'SFMono-Regular',ui-monospace,'Roboto Mono','DM Mono',Menlo,monospace";
  var FONT = "'DM Sans','Segoe UI',system-ui,sans-serif";
  var MASTHEAD_SRC = "/assets/logos/luminary-masthead.png";
  var FULL_LOGO_SRC = "/assets/logos/primary.png"; // full stacked lockup (mask + wordmark)

  // ── Date / time helpers (deterministic — no toLocaleString) ────────────────
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

  // respondedAt ISO → "Thu, July 3rd, 2026 · 4:32 PM"
  function fmtRespondedAt(iso) {
    if (!iso) return "";
    var parts = String(iso).split("T");
    var datePart = fmtDate(parts[0]);
    var timePart = parts[1] ? fmtTime(parts[1].slice(0, 5)) : "";
    return [datePart, timePart].filter(function(x) { return x; }).join(" · ");
  }

  // One-time stylesheet for the three micro-moments (hover lift, success pop,
  // loading shimmer). Idempotent — safe to leave mounted.
  function injectStyle() {
    if (document.getElementById("ltp-crew-style")) return;
    var el = document.createElement("style");
    el.id = "ltp-crew-style";
    el.textContent = [
      ".ltp-accept-btn{transition:transform .14s ease,filter .14s ease,box-shadow .14s ease}",
      ".ltp-accept-btn:hover{transform:translateY(-1px);filter:brightness(1.06);box-shadow:0 8px 26px rgba(239,88,34,0.34)}",
      ".ltp-accept-btn:active{transform:translateY(0)}",
      ".ltp-decline-btn{transition:border-color .14s ease,color .14s ease}",
      ".ltp-decline-btn:hover{border-color:#5A6E78}",
      "@keyframes ltp-check-pop{0%{transform:scale(.8);opacity:0}60%{transform:scale(1.08)}100%{transform:scale(1);opacity:1}}",
      ".ltp-check-pop{animation:ltp-check-pop .32s cubic-bezier(0.34,1.56,0.64,1) both}",
      "@keyframes ltp-shimmer{0%{background-position:-120px 0}100%{background-position:240px 0}}",
      ".ltp-shimmer{background-image:linear-gradient(90deg,#64260F 0%,#FF921E 50%,#64260F 100%);background-size:240px 4px;animation:ltp-shimmer 1.1s linear infinite}",
    ].join("\n");
    document.head.appendChild(el);
  }

  // ── Masthead hero (img with text-wordmark fallback) + gradient rule ────────
  function Masthead(props) {
    // props: { failed, onFail, companyName, maxWidth }
    // Solid masthead-orange rule pulled up 1px to overlap the logo's base, and
    // painted after the img (same DOM parent) so it sits ON the bottom edge —
    // the lockup and rule read as one image, like the email masthead.
    var rule = h("div", { style: { height: 4, width: "100%", background: MASTHEAD_ORANGE, marginTop: -1, position: "relative", zIndex: 1 } });
    var art;
    if (props.failed) {
      art = h("div", { style: { display: "block" } },
        h("span", { style: { display: "block", fontSize: "30px", fontWeight: 800, color: ORANGE, letterSpacing: "0.04em", lineHeight: 1 } }, "LUMINARY"),
        h("div", { style: { fontSize: "10px", fontWeight: 700, color: ORANGE_SOFT, letterSpacing: "0.22em", marginTop: 4 } }, "TECHNOLOGY & PRODUCTIONS"));
    } else {
      art = h("img", {
        src: MASTHEAD_SRC,
        alt: props.companyName || "Luminary Technology & Productions",
        onError: props.onFail,
        style: { display: "block", width: "100%", maxWidth: (props.maxWidth || 360) + "px", height: "auto", margin: 0 },
      });
    }
    return h("div", null, art, rule);
  }

  // ── A single ruled "call line" ─────────────────────────────────────────────
  function renderShift(s, i, isLast, compact) {
    var dateLine = fmtDate(s.date);
    var start = fmtTime(s.startTime);
    var end = fmtTime(s.endTime);
    var timeRange = start ? (end ? start + " – " + end : start) : "";
    var hasTimeframe = dateLine || timeRange;
    var subTitle = s.shiftTitle || "";
    var subMeta = (subTitle || s.department)
      ? h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" } },
          subTitle && h("span", { style: { fontSize: "13px", fontWeight: 400, color: MUTE, letterSpacing: "0.02em" } }, subTitle),
          s.department && h("span", { style: { fontSize: "11px", fontWeight: 700, color: ORANGE_SOFT, letterSpacing: "0.08em", textTransform: "uppercase", border: "1px solid " + HAIR, padding: "2px 6px", borderRadius: 3 } }, s.department))
      : null;

    return h("div", {
      key: s.positionId || i,
      style: { display: "flex", alignItems: "flex-start", padding: "18px 0", borderBottom: isLast ? "none" : "1px solid " + HAIR },
    },
      // number gutter
      h("div", { style: { width: 36, flexShrink: 0, paddingTop: 1, fontSize: "14px", fontWeight: 800, color: ORANGE, fontFamily: MONO, fontVariantNumeric: "tabular-nums" } }, String(i + 1).padStart(2, "0")),
      // content
      h("div", { style: { flex: 1, minWidth: 0 } },
        // timeframe line: date (left) · time range (right, mono)
        hasTimeframe && h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 } },
          h("div", { style: { fontSize: (compact ? "13px" : "15px"), fontWeight: 600, color: ORANGE_SOFT } }, dateLine),
          timeRange && h("div", { style: { flexShrink: 0, whiteSpace: "nowrap", fontSize: (compact ? "13px" : "16px"), fontWeight: 500, color: ORANGE_SOFT, fontFamily: MONO, fontVariantNumeric: "tabular-nums" } }, timeRange)),
        // position title — its own full-width line below the timeframe, so a long
        // role can run the whole width instead of fighting the time column.
        h("div", { style: { fontSize: (compact ? "17px" : "19px"), fontWeight: 700, color: WHITE, letterSpacing: "-0.01em", lineHeight: 1.25, marginTop: hasTimeframe ? 6 : 0 } }, (s.roleLabel || "Crew")),
        subMeta)
    );
  }

  // ── Terminal banner (accepted / declined / withdrawn) ──────────────────────
  function renderBanner(status, crewName, respondedAt) {
    var cfg;
    if (status === "accepted") {
      cfg = { color: SUCCESS, bg: SUCCESS_BG, bd: SUCCESS_BD,
              glyph: h("span", { className: "ltp-check-pop", style: { color: "#fff", fontSize: "16px", lineHeight: 1 } }, "✓"),
              headline: "You're penciled in",
              note: "Thanks" + (crewName ? ", " + crewName : "") + "! Please pencil these calls into your calendar — a production manager will confirm you've been selected for the position in a separate email." };
    } else if (status === "declined") {
      cfg = { color: DECLINE, bg: DECLINE_BG, bd: DECLINE_BD,
              glyph: h("svg", { width: 16, height: 16, viewBox: "0 0 16 16" },
                        h("line", { x1: 3, y1: 8, x2: 13, y2: 8, stroke: BTN_INK, strokeWidth: 2, strokeLinecap: "round" })),
              headline: "Thanks for letting us know",
              note: "We've noted your response and will re-staff. If you shared partial availability in your note, we'll review it and reach back out if we think we can work something out." };
    } else { // withdrawn
      cfg = { color: TEXT, bg: NEUTRAL_BG, bd: HAIR, glyph: null,
              headline: "This request was withdrawn",
              note: "The production team withdrew this request — no action is needed." };
    }
    var receipt = (status !== "withdrawn" && respondedAt)
      ? h("div", { style: { fontSize: "12px", fontWeight: 500, color: FAINT, fontFamily: MONO, fontVariantNumeric: "tabular-nums", marginTop: 8 } }, "Responded " + fmtRespondedAt(respondedAt))
      : null;

    return h("div", { style: { background: cfg.bg, border: "1px solid " + cfg.bd, borderRadius: 14, padding: 20 } },
      h("div", { style: { display: "flex", alignItems: "flex-start", gap: 14 } },
        cfg.glyph && h("div", { style: { width: 28, height: 28, borderRadius: "50%", background: cfg.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 } }, cfg.glyph),
        h("div", null,
          h("div", { style: { fontSize: "16px", fontWeight: 700, color: cfg.color } }, cfg.headline),
          h("div", { style: { fontSize: "13px", color: TEXT, lineHeight: 1.55, marginTop: 4 } }, cfg.note),
          receipt)));
  }

  // ── Main component ─────────────────────────────────────────────────────────
  window.LTPCrewView = function(props) {
    var token = props.route && props.route.id;

    var dataState = useState(null); var data = dataState[0], setData = dataState[1];
    var errState = useState(null); var loadErr = errState[0], setLoadErr = errState[1];
    var mhState = useState(false); var mastheadFailed = mhState[0], setMastheadFailed = mhState[1];
    var rmState = useState(null); var respondMode = rmState[0], setRespondMode = rmState[1];   // null | "accept" | "decline"
    var cmState = useState(""); var comment = cmState[0], setComment = cmState[1];
    var subState = useState(false); var submitting = subState[0], setSubmitting = subState[1];
    var fErrState = useState(null); var formErr = fErrState[0], setFormErr = fErrState[1];
    var mqState = useState(false); var isMobile = mqState[0], setIsMobile = mqState[1];
    var actionRef = useRef(null);

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

    // Inject the micro-interaction stylesheet once.
    useEffect(injectStyle, []);

    // This public page is a normal scrolling document; the app shell sets
    // body{overflow:hidden}. Re-enable while mounted, restore on unmount.
    useEffect(function() {
      var prev = document.body.style.overflow;
      document.body.style.overflow = "auto";
      return function() { document.body.style.overflow = prev; };
    }, []);

    // Track the mobile breakpoint for the handful of responsive branches.
    useEffect(function() {
      if (!window.matchMedia) return undefined;
      var mq = window.matchMedia("(max-width:600px)");
      var apply = function() { setIsMobile(mq.matches); };
      apply();
      if (mq.addEventListener) { mq.addEventListener("change", apply); return function() { mq.removeEventListener("change", apply); }; }
      mq.addListener(apply); return function() { mq.removeListener(apply); };
    }, []);

    // ── Loading ──────────────────────────────────────────────────────────────
    if (!data && !loadErr) {
      return h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: BG, fontFamily: FONT } },
        h("div", { className: "ltp-shimmer", style: { height: 4, width: 120, borderRadius: 2 } }),
        h("div", { style: { fontSize: "13px", color: MUTE, marginTop: 16, textAlign: "center" } }, "Loading call sheet…"));
    }

    // ── Load error ───────────────────────────────────────────────────────────
    if (loadErr) {
      return h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: BG, padding: 30, fontFamily: FONT } },
        h("div", { style: { maxWidth: 420, textAlign: "center" } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase", color: DECLINE } }, "Link unavailable"),
          h("div", { style: { fontSize: "20px", fontWeight: 800, color: WHITE, marginTop: 10 } }, "This call sheet isn't available"),
          h("div", { style: { fontSize: "13px", color: MUTE, marginTop: 8, lineHeight: 1.5 } }, loadErr),
          h("div", { style: { marginTop: 32, display: "flex", justifyContent: "center", opacity: 0.9 } },
            mastheadFailed
              ? h("span", { style: { fontSize: "18px", fontWeight: 800, color: ORANGE, letterSpacing: "0.04em" } }, "LUMINARY")
              : h("img", { src: FULL_LOGO_SRC, alt: "Luminary Technology & Productions", onError: function() { setMastheadFailed(true); }, style: { display: "block", width: "100%", maxWidth: "180px", height: "auto" } }))));
    }

    var status = data.status;
    var crewName = data.crewName;
    var project = data.project || {};
    var shifts = data.shifts || [];
    var settings = data.settings || {};
    var terminal = status !== "pending";
    var withdrawn = status === "withdrawn";

    var dateRange = [fmtDate(project.startDate), fmtDate(project.endDate)].filter(function(x) { return x; });
    var dateLine = dateRange.length === 2 && dateRange[0] !== dateRange[1]
      ? dateRange[0] + " – " + dateRange[1]
      : (dateRange[0] || "");
    var projectMeta = [project.venue, dateLine].filter(function(x) { return x; }).join("  ·  ");

    // Overline status eyebrow per state.
    var statusEyebrow = status === "accepted" ? { t: "Confirmed", c: SUCCESS }
      : status === "declined" ? { t: "Declined", c: DECLINE }
      : status === "withdrawn" ? { t: "Withdrawn", c: NEUTRAL }
      : { t: "Awaiting your response", c: ORANGE_SOFT };

    var intent = withdrawn ? null
      : (terminal ? "Here are the calls on this request." : "You've been requested for the following calls.");

    // ── Accept / Decline submit (inline reveal → POST → reload) ───────────────
    function submit() {
      setFormErr(null);
      setSubmitting(true);
      var body = {};
      if (comment.trim()) body.comment = comment.trim();
      var kind = respondMode === "accept" ? "accept" : "decline";
      fetch("/api/crew/" + token + "/" + kind, {
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
              } catch (e) { if (e instanceof Error) throw e; }
              throw new Error("Server returned " + r.status);
            });
          }
          return r.json();
        })
        .then(function() { setRespondMode(null); setComment(""); setSubmitting(false); reload(); })
        .catch(function(e) { setFormErr(String(e.message || e)); setSubmitting(false); });
    }

    function openMode(mode, fromSticky) {
      setFormErr(null);
      setRespondMode(mode);
      // Only the mobile sticky bar needs to pull the in-flow action zone into
      // view; switching Accept↔Decline in place shouldn't jump the page.
      if (fromSticky && actionRef.current && actionRef.current.scrollIntoView) {
        try { actionRef.current.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) { actionRef.current.scrollIntoView(); }
      }
    }

    function pendingChoiceButtons(stacked) {
      // Both stay live so a crew member can switch their choice directly —
      // no need to hit Back first. Only a submit-in-flight disables them; the
      // un-chosen side just dims while the other's note panel is open.
      return h("div", { style: { display: "flex", flexDirection: stacked ? "column" : "row", gap: 12 } },
        h("button", {
          type: "button", className: "ltp-accept-btn",
          disabled: submitting, onClick: function() { openMode("accept"); },
          style: { flex: stacked ? "0 0 auto" : "1.4 1 0", minHeight: 52, background: GRAD_BTN, color: BTN_INK, fontSize: "15px", fontWeight: 700, letterSpacing: "0.02em", border: "none", borderRadius: 10, padding: "16px 24px", cursor: submitting ? "default" : "pointer", fontFamily: "inherit", boxShadow: "0 6px 20px rgba(239,88,34,0.28)", boxSizing: "border-box", opacity: (respondMode === "decline") ? 0.45 : 1 },
        }, "Accept These Calls"),
        h("button", {
          type: "button", className: "ltp-decline-btn",
          disabled: submitting, onClick: function() { openMode("decline"); },
          style: { flex: stacked ? "0 0 auto" : "1 1 0", minHeight: 52, background: "transparent", color: TEXT, fontSize: "15px", fontWeight: 600, border: "1.5px solid " + HAIR, borderRadius: 10, padding: "15px 24px", cursor: submitting ? "default" : "pointer", fontFamily: "inherit", boxSizing: "border-box", opacity: (respondMode === "accept") ? 0.45 : 1 },
        }, "I Can't Make It"));
    }

    function inlineReveal() {
      var open = respondMode !== null;
      var isAccept = respondMode === "accept";
      return h("div", { style: { overflow: "hidden", transition: "max-height 280ms ease, opacity 220ms ease, margin-top 200ms ease", maxHeight: open ? 460 : 0, opacity: open ? 1 : 0, marginTop: open ? 16 : 0 } },
        h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: isAccept ? SUCCESS : DECLINE } },
          isAccept ? "Confirming — leave a note (optional)" : "Letting us know — what's the conflict? (optional)"),
        h("textarea", {
          value: comment,
          onChange: function(e) { setComment(e.target.value); },
          maxLength: 1000,
          placeholder: isAccept ? "Anything the team should know" : "e.g. I can't do the Saturday load-in but the rest works — or I'm unavailable for all of these",
          onFocus: function(e) { e.target.style.borderColor = ORANGE; },
          onBlur: function(e) { e.target.style.borderColor = HAIR; },
          style: { width: "100%", minHeight: 84, background: BG, border: "1px solid " + HAIR, borderRadius: 8, padding: 12, color: TEXT, fontSize: "16px", fontFamily: "inherit", outline: "none", resize: "vertical", boxSizing: "border-box", marginTop: 10 },
        }),
        formErr && h("div", { style: { marginTop: 12, padding: "8px 12px", background: DECLINE_BG, border: "1px solid " + DECLINE_BD, borderRadius: 6, color: DECLINE, fontSize: "12px" } }, formErr),
        h("div", { style: { display: "flex", alignItems: "center", gap: 14, marginTop: 14 } },
          h("button", { type: "button", disabled: submitting, onClick: function() { setRespondMode(null); setComment(""); setFormErr(null); }, style: { marginRight: "auto", background: "none", border: "none", color: NEUTRAL, fontSize: "13px", cursor: submitting ? "default" : "pointer", fontFamily: "inherit", padding: 0 } }, "Back"),
          isAccept
            ? h("button", { type: "button", className: "ltp-accept-btn", disabled: submitting, onClick: submit, style: { minHeight: 48, padding: "0 24px", background: GRAD_BTN, color: BTN_INK, border: "none", borderRadius: 10, fontSize: "15px", fontWeight: 700, letterSpacing: "0.02em", cursor: submitting ? "wait" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.6 : 1, boxShadow: "0 6px 20px rgba(239,88,34,0.28)" } }, submitting ? "Sending…" : "Confirm Accept")
            : h("button", { type: "button", disabled: submitting, onClick: submit, style: { minHeight: 48, padding: "0 24px", background: "transparent", color: DECLINE, border: "1px solid " + DECLINE, borderRadius: 10, fontSize: "15px", fontWeight: 700, letterSpacing: "0.02em", cursor: submitting ? "wait" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.6 : 1 } }, submitting ? "Sending…" : "Confirm Decline")));
    }

    // ── Action zone (pending prompt+buttons+reveal, or terminal banner) ───────
    var crewNote = (terminal && data.comment)
      ? h("div", { style: { marginTop: 28, borderLeft: "2px solid " + HAIR, paddingLeft: 14 } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: NEUTRAL } }, "Your note"),
          h("div", { style: { fontSize: "13px", color: TEXT, fontStyle: "italic", lineHeight: 1.55, marginTop: 6 } }, data.comment))
      : null;

    var actionZone;
    if (terminal) {
      actionZone = h("div", { style: { marginTop: 40 } }, renderBanner(status, crewName, data.respondedAt));
    } else {
      actionZone = h("div", { ref: actionRef, style: { marginTop: 40, background: INSET, border: "1px solid " + HAIR, borderRadius: 14, padding: 24 } },
        h("div", { style: { fontSize: "14px", fontWeight: 600, color: WHITE, textAlign: "center", marginBottom: 18 } }, "Can you take these calls?"),
        pendingChoiceButtons(isMobile),
        inlineReveal());
    }

    // ── Shift section (suppressed on withdrawn) ──────────────────────────────
    var shiftSection = null;
    if (!withdrawn) {
      var listInner;
      if (shifts.length === 0) {
        listInner = h("div", { style: { padding: "18px 0", fontSize: "13px", fontStyle: "italic", color: MUTE } }, "No calls are listed on this request yet.");
      } else {
        listInner = shifts.map(function(s, i) {
          return renderShift(s, i, i === shifts.length - 1, isMobile);
        });
      }
      shiftSection = h("div", { style: { marginTop: 36 } },
        h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: ORANGE } },
          "Shifts — " + shifts.length + " call" + (shifts.length === 1 ? "" : "s")),
        // Panel fill + 10px side padding, pulled out 10px each side with negative
        // margins so the rows keep their exact width (the table doesn't shrink) —
        // the slightly-lighter background just bleeds 10px past the content edges.
        h("div", { style: { marginTop: 16, marginLeft: -10, marginRight: -10, padding: "0 10px", background: SHIFT_BG, borderTop: "1px solid " + ORANGE, borderBottom: "1px solid " + ORANGE } }, listInner));
    }

    // ── Mobile sticky action bar (pending only, before a choice is made) ──────
    var showSticky = isMobile && status === "pending" && respondMode === null;
    var stickyBar = showSticky
      ? h("div", { style: { position: "fixed", left: 0, right: 0, bottom: 0, background: INSET, borderTop: "1px solid " + HAIR, zIndex: 3000 } },
          h("div", { style: { height: 4, background: GRAD_RULE } }),
          h("div", { style: { display: "flex", gap: 12, padding: "12px 16px", paddingBottom: "calc(12px + env(safe-area-inset-bottom))" } },
            h("button", { type: "button", className: "ltp-accept-btn", onClick: function() { openMode("accept", true); }, style: { flex: "1.4 1 0", minHeight: 48, background: GRAD_BTN, color: BTN_INK, fontSize: "15px", fontWeight: 700, border: "none", borderRadius: 10, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 6px 20px rgba(239,88,34,0.28)" } }, "Accept"),
            h("button", { type: "button", className: "ltp-decline-btn", onClick: function() { openMode("decline", true); }, style: { flex: "1 1 0", minHeight: 48, background: "transparent", color: TEXT, fontSize: "15px", fontWeight: 600, border: "1.5px solid " + HAIR, borderRadius: 10, cursor: "pointer", fontFamily: "inherit" } }, "I Can't Make It")))
      : null;

    var pad = isMobile ? "28px 28px 0" : "40px 36px 0";
    var bottomPad = showSticky ? 96 : 56;

    // Footer — one centered "Company · website" line, matching the email shell.
    var websiteHref = settings.website
      ? (/^https?:\/\//i.test(settings.website) ? settings.website : "https://" + settings.website)
      : null;
    var footer = h("div", { style: { marginTop: 44, paddingTop: 24, borderTop: "1px solid " + HAIR, textAlign: "center", fontSize: "11px", color: MUTE, lineHeight: 1.6 } },
      h("span", null, settings.companyName || "Luminary Technology & Productions"),
      settings.website && h("span", { style: { color: FAINT } }, "  ·  "),
      settings.website && h("a", { href: websiteHref, target: "_blank", rel: "noopener noreferrer", style: { color: MUTE, textDecoration: "none" } }, settings.website));

    return h("div", { style: { minHeight: "100vh", background: BG, color: TEXT, fontFamily: FONT, padding: "0 0 " + bottomPad + "px" } },
      h("div", { style: { maxWidth: 820, margin: "0 auto", padding: pad } },
        // Masthead hero + gradient rule
        h(Masthead, { failed: mastheadFailed, onFail: function() { setMastheadFailed(true); }, companyName: settings.companyName, maxWidth: 360 }),

        // Overline row: CREW CALL SHEET · status eyebrow
        h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginTop: 18 } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase", color: ORANGE_SOFT } }, "Crew Call Sheet"),
          h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase", color: statusEyebrow.c } }, statusEyebrow.t)),

        // Greeting cluster
        crewName && h("div", { style: { fontSize: "16px", fontWeight: 600, color: WHITE, marginTop: 28 } }, "Hi " + crewName + ","),
        intent && h("div", { style: { fontSize: "14px", color: MUTE, lineHeight: 1.5, marginTop: 6 } }, intent),

        // Project marquee (greyed when withdrawn)
        h("div", { style: { marginTop: 40 } },
          h("div", { style: { fontSize: "30px", fontWeight: 800, color: withdrawn ? NEUTRAL : WHITE, letterSpacing: "-0.02em", lineHeight: 1.08, textTransform: "uppercase", overflowWrap: "break-word" } }, (project.name || "Project").toUpperCase()),
          projectMeta && h("div", { style: { fontSize: "13px", fontWeight: 600, color: withdrawn ? NEUTRAL : ORANGE_SOFT, letterSpacing: "0.01em", marginTop: 8 } }, projectMeta),
          // Job-site address — linked to a map so crew can navigate in one tap.
          project.siteAddress && h("a", { href: "https://maps.google.com/?q=" + encodeURIComponent(project.siteAddress), target: "_blank", rel: "noopener",
            style: { display: "inline-block", fontSize: "12px", fontWeight: 500, color: withdrawn ? NEUTRAL : MUTE, textDecoration: "underline", textDecorationColor: HAIR, textUnderlineOffset: "3px", marginTop: 6 } },
            "📍 " + project.siteAddress)),

        // Shifts
        shiftSection,

        // Crew note (terminal) then action zone / banner
        crewNote,
        actionZone,

        // Footer
        footer
      ),
      stickyBar
    );
  };
})();
