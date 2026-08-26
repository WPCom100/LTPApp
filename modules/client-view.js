// Public client-facing view of a Quote or Invoice.
//
// Rendered by app.js's outer LTPApp when route.module === "view".
// Bypasses every auth gate — the share_token in the URL is the credential.
//
// Two URL shapes (both parsed by router.js into the same {module, sub, id}):
//   #/view/quote/<share_token>     → quote client view (with accept/decline)
//   #/view/invoice/<share_token>   → invoice client view (read-only)
//
// Query param ?preview=1 (set by the in-app Preview button) disables the
// Accept/Decline actions so the LTP user can't accidentally finalize a
// quote while previewing. NOT a security control — anyone can remove the
// param. The backend still happily processes the accept/decline if hit;
// we just don't surface the buttons in preview mode.
//
// Visual language mirrors the crew call sheet (modules/crew-view.js) and the
// branded email (backend/email_compose.py): the orange masthead lockup as a
// left-aligned hero — logo, a vertical brand rule, then the company contact
// block — all sitting on the 4px masthead-orange underline; then ruled
// line-item tables with mono money columns, the gradient Accept button, and
// the same terminal banners. Premium, flat, unmistakably LTP.
(function() {
  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useRef = React.useRef;

  // ── Palette (public client surface — explicit hexes, mirrors crew-view) ───
  var BG = "#233038";           // page field
  var TEXT = "#D1DBDA";         // primary
  var WHITE = "#FFFFFF";        // emphasis (titles, totals, names)
  var MUTE = "#93A3AB";         // secondary
  var FAINT = "#6E7E86";        // footer / receipts / struck prices
  var ORANGE = "#EF5822";
  var ORANGE_SOFT = "#F9B998";
  var MASTHEAD_ORANGE = "#f15927"; // sampled from the logo PNG so the rules read as the masthead's own
  var INSET = "#1B262C";        // surfaces that recede below the field
  var PANEL_BG = "#202d35";     // the line-item panels — a hair off the page field
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

  var settingsAddress = window.LTP_settingsAddress;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function fmtMoney(n) {
    var v = Number(n) || 0;
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Quantity display: whole numbers stay clean ("2"), genuine decimals keep
  // their fractional part ("2.5"). Rounds to 5 dp first so float noise from a
  // computed qty (e.g. delivered−invoiced) never reaches the client. Mirrors
  // the PDF's _fmt_qty so the web preview and PDF read identically.
  function fmtQty(n) {
    var v = Number(n);
    if (!isFinite(v)) return "0";
    return String(Math.round(v * 1e5) / 1e5);
  }

  // Deterministic date formatting (no toLocaleString) — "July 3rd, 2026".
  var _MONTHS = ["January", "February", "March", "April", "May", "June",
                 "July", "August", "September", "October", "November", "December"];

  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return iso;
    var day = d.getDate();
    var sfx = (day >= 11 && day <= 13) ? "th"
            : ({ 1: "st", 2: "nd", 3: "rd" }[day % 10] || "th");
    return _MONTHS[d.getMonth()] + " " + day + sfx + ", " + d.getFullYear();
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

  // Activity entry {date: "YYYY-MM-DD", time: "HH:MM"} → "July 3rd, 2026 · 4:32 PM"
  function fmtStamp(dateIso, timeStr) {
    return [fmtDate(dateIso), fmtTime(timeStr)].filter(function(x) { return x; }).join(" · ");
  }

  function pad2(n) { return String(n).padStart(2, "0"); }

  function calcTotals(entity) {
    var sub = 0, adj = 0;
    (entity.sections || []).forEach(function(s) {
      (s.items || []).forEach(function(it) {
        if (it.type === "note") return;
        var qty = Number(it.qty) || 0;
        var orig = (Number(it.unitPrice) || 0) * qty;
        var eff = (it.adjustedPrice != null ? Number(it.adjustedPrice) : Number(it.unitPrice) || 0) * qty;
        sub += orig;
        adj += eff;
      });
    });
    var after = adj;
    var gd = entity.globalDiscount || {};
    var gt = gd.type || "none";
    var gv = Number(gd.value) || 0;
    if (gt === "percent") after = adj * (1 - gv / 100);
    else if (gt === "amount" || gt === "flat") after = adj - gv;  // "amount" is current; "flat" a legacy alias
    else if (gt === "target") after = gv;
    after = Math.max(after, 0);
    // QuickBooks-computed sales tax (quotes and invoices alike) makes the total
    // tax-inclusive, matching the app + PDF.
    var tax = (entity.qbTaxTotal != null) ? (Number(entity.qbTaxTotal) || 0) : 0;
    return { subtotal: sub, adjusted: adj, preTax: after, tax: tax, total: after + tax };
  }

  // One-time stylesheet for the micro-moments (hover lift, success pop,
  // loading shimmer). Idempotent — safe to leave mounted. Same rules as the
  // crew view's ltp-crew-style; own id so each public page stays standalone.
  function injectStyle() {
    if (document.getElementById("ltp-client-style")) return;
    var el = document.createElement("style");
    el.id = "ltp-client-style";
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
    // Identical treatment to the crew call sheet (modules/crew-view.js):
    // solid masthead-orange rule pulled up 1px to overlap the logo's base, and
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

  // ── Signature pad component ────────────────────────────────────────────────

  function SignaturePadComponent(props) {
    // Wraps the third-party signature_pad library. Exposes an imperative
    // handle via props.onReady so the parent can call getDataUrl()/clear()
    // without re-rendering on each stroke.
    var canvasRef = useRef(null);
    var padRef = useRef(null);

    useEffect(function() {
      if (!canvasRef.current || !window.SignaturePad) return;
      // Match canvas backing-store size to its CSS size for sharp lines on
      // hidpi displays. signature_pad recommends doing this on mount + resize.
      function resize() {
        var canvas = canvasRef.current;
        if (!canvas) return;
        var ratio = Math.max(window.devicePixelRatio || 1, 1);
        canvas.width = canvas.offsetWidth * ratio;
        canvas.height = canvas.offsetHeight * ratio;
        canvas.getContext("2d").scale(ratio, ratio);
        if (padRef.current) padRef.current.clear();
      }
      resize();
      // White background + dark pen — the exported PNG is the same pixels,
      // so when the signature is later rendered against a white (or any
      // light) background in the activity feed / "View signature" popup,
      // the strokes remain visible.
      var pad = new window.SignaturePad(canvasRef.current, {
        backgroundColor: "#ffffff",
        penColor: "#233038",   // page-field slate — brand-consistent dark
      });
      padRef.current = pad;
      window.addEventListener("resize", resize);

      // Expose handle to parent
      if (typeof props.onReady === "function") {
        props.onReady({
          getDataUrl: function() {
            if (!padRef.current) return "";
            if (padRef.current.isEmpty()) return "";
            return padRef.current.toDataURL("image/png");
          },
          isEmpty: function() { return !padRef.current || padRef.current.isEmpty(); },
          clear: function() { if (padRef.current) padRef.current.clear(); },
        });
      }
      return function() {
        window.removeEventListener("resize", resize);
        if (padRef.current) padRef.current.off();
      };
    }, []);

    return h("div", { style: { background: "#fff", border: "1px solid " + HAIR, borderRadius: 8, overflow: "hidden" } },
      // Canvas is visually white so dark pen strokes are visible while
      // drawing, AND the exported PNG (configured above with white
      // background) matches what the user sees in the form.
      h("canvas", {
        ref: canvasRef,
        style: { width: "100%", height: 160, display: "block", cursor: "crosshair", touchAction: "none", background: "#fff" },
      }),
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 12px", background: INSET, borderTop: "1px solid " + HAIR, fontSize: "11px", color: MUTE } },
        h("span", null, "Sign with mouse or finger"),
        h("button", {
          type: "button",
          onClick: function() { if (padRef.current) padRef.current.clear(); },
          style: { background: "transparent", border: "1px solid " + HAIR, borderRadius: 6, padding: "3px 12px", color: MUTE, fontSize: "11px", cursor: "pointer", fontFamily: "inherit" },
        }, "Clear"),
      )
    );
  }

  // ── Section rendering — the ruled line-item table ──────────────────────────

  function renderSection(sec, idx, entity, project, compact) {
    var allItems = sec.items || [];
    var lineItems = allItems.filter(function(it) { return it.type !== "note"; });
    var secTotal = 0;
    lineItems.forEach(function(it) {
      var qty = Number(it.qty) || 0;
      var eff = it.adjustedPrice != null ? Number(it.adjustedPrice) : Number(it.unitPrice) || 0;
      secTotal += eff * qty;
    });

    // Rental period line (only on equipment-containing sections)
    var hasEquip = lineItems.some(function(it) { return it.type === "equipment"; });
    var secStart = sec.customDates ? sec.startDate : (entity.customStartDate || (project && project.startDate));
    var secEnd   = sec.customDates ? sec.endDate   : (entity.customEndDate   || (project && project.endDate));

    var cols = compact ? "minmax(0,1fr) 34px 80px 84px" : "minmax(0,1fr) 56px 112px 112px";
    var moneySize = compact ? "12px" : "13px";

    var headerRow = h("div", { style: { display: "grid", gridTemplateColumns: cols, columnGap: compact ? 8 : 12, padding: "10px 0", borderBottom: "1px solid " + HAIR, fontSize: "10px", fontWeight: 700, color: MUTE, letterSpacing: "0.14em", textTransform: "uppercase" } },
      h("div", null, "Item"),
      h("div", { style: { textAlign: "center" } }, "Qty"),
      h("div", { style: { textAlign: "right" } }, compact ? "Unit" : "Unit Price"),
      h("div", { style: { textAlign: "right" } }, "Total"));

    // Render line items and notes in their authored order (the order set in the
    // builder), so the client view matches the editor. A note is a full-width
    // caption row; a priced line is the 4-column grid row. Whichever element is
    // last in the section drops its bottom border.
    // A note's blank lines, indentation and runs of spaces are authored content
    // (LTP_NOTE_TEXT_STYLE → white-space: pre-wrap), so the customer sees the
    // same shape the builder and the PDF show. The "Note:" label sits in its own
    // span so the body's own leading indent isn't measured from after the label.
    function noteRow(n, key, isLast) {
      return h("div", { key: key, style: { padding: "10px 0", borderBottom: isLast ? "none" : "1px solid " + HAIR, fontSize: "12px", color: MUTE, fontStyle: "italic", lineHeight: 1.5 } },
        h("span", { style: { fontStyle: "normal", fontWeight: 700, letterSpacing: "0.04em" } }, "Note: "),
        h("span", { style: window.LTP_NOTE_TEXT_STYLE }, n.text || n.name || ""));
    }
    function lineRow(it, key, isLast) {
      var qty = Number(it.qty) || 0;
      var up  = Number(it.unitPrice) || 0;
      var ap  = it.adjustedPrice;
      var eff = ap != null ? Number(ap) : up;
      var lineTotal = eff * qty;
      var hasAdj = ap != null && Number(ap) !== up;
      return h("div", { key: key, style: { display: "grid", gridTemplateColumns: cols, columnGap: compact ? 8 : 12, padding: "12px 0", borderBottom: isLast ? "none" : "1px solid " + HAIR, alignItems: "baseline" } },
        h("div", { style: { fontSize: compact ? "13px" : "14px", fontWeight: 600, color: TEXT, lineHeight: 1.4, overflowWrap: "break-word" } },
          it.name || "",
          (it.rentalLabel && it.type === "equipment") && h("span", { style: { fontSize: "11px", fontWeight: 400, color: MUTE } }, "  (" + it.rentalLabel + ")")),
        h("div", { style: { textAlign: "center", fontSize: moneySize, color: TEXT, fontFamily: MONO, fontVariantNumeric: "tabular-nums" } }, fmtQty(qty)),
        h("div", { style: { textAlign: "right", fontSize: moneySize, color: TEXT, fontFamily: MONO, fontVariantNumeric: "tabular-nums" } },
          hasAdj
            ? h("div", null,
                h("div", { style: { fontSize: "10px", color: FAINT, textDecoration: "line-through" } }, fmtMoney(up)),
                h("div", { style: { color: ORANGE, fontWeight: 600 } }, fmtMoney(eff)))
            : fmtMoney(eff)),
        h("div", { style: { textAlign: "right", fontSize: moneySize, color: ORANGE_SOFT, fontWeight: 600, fontFamily: MONO, fontVariantNumeric: "tabular-nums" } }, fmtMoney(lineTotal)));
    }

    var rows;
    if (lineItems.length === 0) {
      // No priced lines — show the placeholder, then any notes in order.
      var noteOnly = allItems.filter(function(it) { return it.type === "note"; });
      rows = [h("div", { key: "empty", style: { padding: "14px 0", fontSize: "13px", fontStyle: "italic", color: MUTE, borderBottom: noteOnly.length ? "1px solid " + HAIR : "none" } }, "No line items in this section.")]
        .concat(noteOnly.map(function(n, i) { return noteRow(n, n.id || ("n" + i), i === noteOnly.length - 1); }));
    } else {
      var last = allItems.length - 1;
      rows = allItems.map(function(it, i) {
        var key = it.id || i;
        return it.type === "note" ? noteRow(it, key, i === last) : lineRow(it, key, i === last);
      });
    }

    return h("div", { key: sec.id || idx, style: { marginTop: 36 } },
      // Section eyebrow: mono index gutter + label (call-sheet numbering)
      h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 } },
          h("span", { style: { fontSize: "13px", fontWeight: 800, color: ORANGE, fontFamily: MONO, fontVariantNumeric: "tabular-nums" } }, pad2(idx + 1)),
          h("span", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: ORANGE } }, sec.label || "Section")),
        hasEquip && secStart && secEnd && h("div", { style: { fontSize: "11px", color: MUTE } },
          "Rental Period: " + fmtDate(secStart) + " — " + fmtDate(secEnd))),
      // Panel fill + 10px side padding, pulled out 10px each side with negative
      // margins so the rows keep their exact width — the slightly-lighter
      // background just bleeds 10px past the content edges (call-sheet panel).
      h("div", { style: { marginTop: 14, marginLeft: -10, marginRight: -10, padding: "0 10px", background: PANEL_BG, borderTop: "1px solid " + ORANGE, borderBottom: "1px solid " + ORANGE } },
        headerRow, rows),
      // Section subtotal — quiet receipt line under the panel
      h("div", { style: { display: "flex", justifyContent: "flex-end", alignItems: "baseline", gap: 12, marginTop: 10 } },
        h("span", { style: { fontSize: "10px", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: MUTE } }, (sec.label || "Section") + " subtotal"),
        h("span", { style: { fontSize: "14px", fontWeight: 700, color: ORANGE_SOFT, fontFamily: MONO, fontVariantNumeric: "tabular-nums" } }, fmtMoney(secTotal))));
  }

  // ── Totals block ───────────────────────────────────────────────────────────

  function renderTotals(entity, compact) {
    var t = calcTotals(entity);
    var gd = entity.globalDiscount || {};
    var gt = gd.type || "none";
    var disc = t.adjusted - t.preTax;
    var diff = t.subtotal - t.adjusted;

    function row(label, value, emphasize) {
      return h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, padding: "6px 0" } },
        h("span", { style: { fontSize: "12px", color: MUTE } }, label),
        h("span", { style: { fontSize: "13px", fontWeight: emphasize ? 600 : 400, color: TEXT, fontFamily: MONO, fontVariantNumeric: "tabular-nums" } }, value));
    }

    return h("div", { style: { marginTop: 36, marginLeft: "auto", maxWidth: compact ? "100%" : 360 } },
      h("div", { style: { borderTop: "1px solid " + HAIR, paddingTop: 8 } },
        row("Subtotal", fmtMoney(t.subtotal), true),
        Math.abs(diff) > 0.01 && row("Line Adjustments", (diff > 0 ? "-" : "+") + fmtMoney(Math.abs(diff))),
        gt !== "none" && Math.abs(disc) > 0.01 && row(gt === "percent" ? "Discount (" + (gd.value || 0) + "%)" : "Discount", "-" + fmtMoney(disc)),
        t.tax > 0.005 && row("Sales Tax", fmtMoney(t.tax))),
      // The brand-gradient rule sets the grand total apart — the same stroke
      // as the email/call-sheet masthead family.
      h("div", { style: { height: 3, background: GRAD_RULE, marginTop: 10 } }),
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, marginTop: 12 } },
        h("span", { style: { fontSize: "12px", fontWeight: 800, letterSpacing: "0.18em", textTransform: "uppercase", color: ORANGE_SOFT } }, "Total"),
        h("span", { style: { fontSize: compact ? "22px" : "26px", fontWeight: 800, color: WHITE, letterSpacing: "-0.01em", fontVariantNumeric: "tabular-nums" } }, fmtMoney(t.total))));
  }

  // ── Terminal banner (accepted / declined / finalized / paid) ──────────────
  function renderBanner(cfg) {
    // cfg: { tone: "success" | "decline" | "neutral", headline, note, receipt?, signatureDataUrl? }
    var color, bg, bd, glyph;
    if (cfg.tone === "success") {
      color = SUCCESS; bg = SUCCESS_BG; bd = SUCCESS_BD;
      glyph = h("span", { className: "ltp-check-pop", style: { color: "#fff", fontSize: "16px", lineHeight: 1 } }, "✓");
    } else if (cfg.tone === "decline") {
      color = DECLINE; bg = DECLINE_BG; bd = DECLINE_BD;
      glyph = h("svg", { width: 16, height: 16, viewBox: "0 0 16 16" },
        h("line", { x1: 3, y1: 8, x2: 13, y2: 8, stroke: BTN_INK, strokeWidth: 2, strokeLinecap: "round" }));
    } else {
      color = TEXT; bg = NEUTRAL_BG; bd = HAIR; glyph = null;
    }
    return h("div", { style: { background: bg, border: "1px solid " + bd, borderRadius: 14, padding: 20 } },
      h("div", { style: { display: "flex", alignItems: "flex-start", gap: 14 } },
        glyph && h("div", { style: { width: 28, height: 28, borderRadius: "50%", background: color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 } }, glyph),
        h("div", { style: { minWidth: 0 } },
          h("div", { style: { fontSize: "16px", fontWeight: 700, color: color } }, cfg.headline),
          cfg.note && h("div", { style: { fontSize: "13px", color: TEXT, lineHeight: 1.55, marginTop: 4 } }, cfg.note),
          cfg.receipt && h("div", { style: { fontSize: "12px", fontWeight: 500, color: FAINT, fontFamily: MONO, fontVariantNumeric: "tabular-nums", marginTop: 8 } }, cfg.receipt),
          cfg.signatureDataUrl && h("div", { style: { marginTop: 12 } },
            h("div", { style: { fontSize: "10px", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: FAINT, marginBottom: 6 } }, "Signature"),
            h("img", { src: cfg.signatureDataUrl, alt: "signature", style: { maxWidth: 260, maxHeight: 100, background: "#fff", padding: 6, borderRadius: 6, display: "block" } })))));
  }

  // ── Main component ─────────────────────────────────────────────────────────

  window.LTPClientView = function(props) {
    var token = props.route && props.route.id;
    var isPreview = props.route && props.route.query && props.route.query.preview === "1";
    // Per-recipient tracking token. Embedded in URLs the server sends
    // out via /api/email/send; absent for share-link-via-copy-paste opens.
    // We forward it verbatim to the backend so it can stamp
    // `recipient_opened` instead of anonymous `client_viewed`. The
    // PDF download URL below also carries it.
    var trackingToken = props.route && props.route.query && props.route.query.r;

    var dataState = useState(null); var data = dataState[0], setData = dataState[1];
    var errState = useState(null); var loadErr = errState[0], setLoadErr = errState[1];
    var mhState = useState(false); var mastheadFailed = mhState[0], setMastheadFailed = mhState[1];
    var rmState = useState(null); var respondMode = rmState[0], setRespondMode = rmState[1];   // null | "accept" | "decline"
    var nmState = useState(""); var clientName = nmState[0], setClientName = nmState[1];
    var cmState = useState(""); var comment = cmState[0], setComment = cmState[1];
    var sigState = useState(null); var sigHandle = sigState[0], setSigHandle = sigState[1];
    var subState = useState(false); var submitting = subState[0], setSubmitting = subState[1];
    var fErrState = useState(null); var formErr = fErrState[0], setFormErr = fErrState[1];
    var mqState = useState(false); var isMobile = mqState[0], setIsMobile = mqState[1];
    var actionRef = useRef(null);

    function _buildTrackingQs() {
      // Build a query string carrying the tracking token (if any) AND
      // the preview flag (if set). Backend reads preview to skip the
      // log-stamping gate so an LTP user clicking Preview doesn't
      // pollute the activity feed.
      var parts = [];
      if (trackingToken) parts.push("r=" + encodeURIComponent(trackingToken));
      if (isPreview) parts.push("preview=1");
      return parts.length ? "?" + parts.join("&") : "";
    }

    function reload() {
      if (!token) {
        setLoadErr("No share token in URL.");
        return;
      }
      fetch("/api/view/" + token + _buildTrackingQs())
        .then(function(r) {
          if (r.status === 404) throw new Error("This quote link is invalid or has been removed.");
          if (!r.ok) throw new Error("Server returned " + r.status);
          return r.json();
        })
        .then(function(d) { setData(d); setLoadErr(null); })
        .catch(function(e) { setLoadErr(String(e.message || e)); });
    }

    useEffect(reload, [token]);

    // Inject the micro-interaction stylesheet once.
    useEffect(injectStyle, []);

    // The app shell sets `body { overflow: hidden }` (index.html) for its
    // fixed-height, internally-scrolled layout. This public client view is a
    // normal top-to-bottom scrolling document, so that rule clips everything
    // below the fold — including the Accept / Decline buttons — and the
    // customer can't reach them. Re-enable body scroll while this view is
    // mounted; restore the prior value on unmount so navigating back into the
    // app shell (e.g. from Preview mode) keeps its layout intact.
    useEffect(function() {
      var prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "auto";
      return function() { document.body.style.overflow = prevOverflow; };
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
        h("div", { style: { fontSize: "13px", color: MUTE, marginTop: 16, textAlign: "center" } }, "Loading…"));
    }

    // ── Load error ───────────────────────────────────────────────────────────
    if (loadErr) {
      return h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: BG, padding: 30, fontFamily: FONT } },
        h("div", { style: { maxWidth: 420, textAlign: "center" } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase", color: DECLINE } }, "Link unavailable"),
          h("div", { style: { fontSize: "20px", fontWeight: 800, color: WHITE, marginTop: 10 } }, "This document isn't available"),
          h("div", { style: { fontSize: "13px", color: MUTE, marginTop: 8, lineHeight: 1.5 } }, loadErr),
          h("div", { style: { marginTop: 32, display: "flex", justifyContent: "center", opacity: 0.9 } },
            mastheadFailed
              ? h("span", { style: { fontSize: "18px", fontWeight: 800, color: ORANGE, letterSpacing: "0.04em" } }, "LUMINARY")
              : h("img", { src: FULL_LOGO_SRC, alt: "Luminary Technology & Productions", onError: function() { setMastheadFailed(true); }, style: { display: "block", width: "100%", maxWidth: "180px", height: "auto" } }))));
    }

    var entity = data.entity;
    var company = data.company;
    var contact = data.contact;
    var project = data.project;
    var settings = data.settings || {};
    var kind = data.kind;
    var ref = data.ref;

    var isQuote = kind === "quote";
    var displayName = (project && project.name) || entity.customName || (isQuote ? "Quote" : "Invoice");
    var dateLabel, dateValue;
    if (isQuote) {
      dateLabel = "Issued";
      dateValue = entity.sentDate || entity.createdDate;
    } else {
      dateLabel = "Invoiced";
      dateValue = entity.invoiceDate || entity.createdDate;
    }

    var terminal = entity.status === "accepted" || entity.status === "declined" || entity.status === "converted";
    var clientAction = (entity.activity || []).filter(function(a) {
      return a.type === "client_accepted" || a.type === "client_declined";
    }).slice(-1)[0];

    function downloadPdf() {
      // Carry the tracking + preview flags so the backend can stamp
      // `recipient_downloaded_pdf` instead of anonymous `client_downloaded_pdf`,
      // and so an LTP user clicking download from Preview mode doesn't
      // pollute the activity feed.
      window.location.href = "/api/view/" + token + "/pdf" + _buildTrackingQs();
    }

    // Overline status eyebrow per kind × state.
    var statusEyebrow;
    if (isQuote) {
      statusEyebrow = entity.status === "accepted" ? { t: "Accepted", c: SUCCESS }
        : entity.status === "declined" ? { t: "Declined", c: DECLINE }
        : entity.status === "converted" ? { t: "Finalized", c: NEUTRAL }
        : { t: "Awaiting your response", c: ORANGE_SOFT };
    } else {
      statusEyebrow = entity.status === "paid" ? { t: "Paid", c: SUCCESS }
        : entity.status === "partial" ? { t: "Partially paid", c: ORANGE_SOFT }
        : entity.status === "overdue" ? { t: "Payment past due", c: DECLINE }
        : { t: "Payment due", c: ORANGE_SOFT };
    }

    // ── Accept / Decline submit (inline reveal → POST → reload) ───────────────
    function submit() {
      // Defense in depth: the confirm buttons only exist while the reveal is
      // open, but never fire the real decision from a closed form or preview.
      if (isPreview || respondMode === null) return;
      setFormErr(null);
      if (!clientName.trim()) {
        setFormErr("Please enter your name.");
        return;
      }
      var isAccept = respondMode === "accept";
      var body = { clientName: clientName.trim() };
      if (comment.trim()) body.comment = comment.trim();
      if (isAccept) {
        if (!sigHandle || sigHandle.isEmpty()) {
          setFormErr("Please draw your signature before accepting.");
          return;
        }
        body.signatureDataUrl = sigHandle.getDataUrl();
      }
      setSubmitting(true);
      fetch("/api/view/" + token + "/" + (isAccept ? "accept" : "decline"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(function(r) {
          if (!r.ok) {
            return r.text().then(function(t) {
              // Pull out the field-specific reason when present
              try {
                var parsed = JSON.parse(t);
                if (parsed && parsed.detail) {
                  if (typeof parsed.detail === "string") throw new Error(parsed.detail);
                  if (parsed.detail.reason) throw new Error(parsed.detail.reason);
                  if (parsed.detail.message) throw new Error(parsed.detail.message);
                }
              } catch (e) {
                if (e instanceof Error) throw e;
              }
              throw new Error("Server returned " + r.status);
            });
          }
          return r.json();
        })
        .then(function() { setRespondMode(null); setClientName(""); setComment(""); setSubmitting(false); reload(); })
        .catch(function(e) { setFormErr(String(e.message || e)); setSubmitting(false); });
    }

    function openMode(mode, fromSticky) {
      if (isPreview) return;
      setFormErr(null);
      setRespondMode(mode);
      // Only the mobile sticky bar needs to pull the in-flow action zone into
      // view; switching Accept↔Decline in place shouldn't jump the page.
      if (fromSticky && actionRef.current && actionRef.current.scrollIntoView) {
        try { actionRef.current.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) { actionRef.current.scrollIntoView(); }
      }
    }

    function pendingChoiceButtons(stacked) {
      // Both stay live so the client can switch their choice directly — no
      // need to hit Back first. Only a submit-in-flight disables them; the
      // un-chosen side just dims while the other's form is open.
      var blocked = submitting || isPreview;
      return h("div", { style: { display: "flex", flexDirection: stacked ? "column" : "row", gap: 12 } },
        h("button", {
          type: "button", className: "ltp-accept-btn",
          disabled: blocked, onClick: function() { openMode("accept"); },
          style: { flex: stacked ? "0 0 auto" : "1.4 1 0", minHeight: 52, background: GRAD_BTN, color: BTN_INK, fontSize: "15px", fontWeight: 700, letterSpacing: "0.02em", border: "none", borderRadius: 10, padding: "16px 24px", cursor: blocked ? (isPreview ? "not-allowed" : "default") : "pointer", fontFamily: "inherit", boxShadow: "0 6px 20px rgba(239,88,34,0.28)", boxSizing: "border-box", opacity: isPreview ? 0.5 : (respondMode === "decline") ? 0.45 : 1 },
        }, "Accept This Quote"),
        h("button", {
          type: "button", className: "ltp-decline-btn",
          disabled: blocked, onClick: function() { openMode("decline"); },
          style: { flex: stacked ? "0 0 auto" : "1 1 0", minHeight: 52, background: "transparent", color: TEXT, fontSize: "15px", fontWeight: 600, border: "1.5px solid " + HAIR, borderRadius: 10, padding: "15px 24px", cursor: blocked ? (isPreview ? "not-allowed" : "default") : "pointer", fontFamily: "inherit", boxSizing: "border-box", opacity: isPreview ? 0.5 : (respondMode === "accept") ? 0.45 : 1 },
        }, "Decline"));
    }

    var labelStyle = { display: "block", fontSize: "11px", fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: MUTE, marginBottom: 6 };
    var inputStyle = { width: "100%", background: BG, border: "1px solid " + HAIR, borderRadius: 8, padding: 12, color: TEXT, fontSize: "16px", fontFamily: "inherit", outline: "none", boxSizing: "border-box" };

    function inlineReveal() {
      var open = respondMode !== null;
      var isAccept = respondMode === "accept";
      // The wrapper div persists across renders (so the max-height transition
      // animates), but the form CONTENT only mounts while open — a collapsed
      // overflow:hidden box would otherwise keep its inputs and Confirm button
      // focusable from the keyboard, invisibly. The 1600px cap comfortably
      // exceeds the tallest possible content (the textarea's user-resize is
      // bounded below) so the confirm row can never be clipped out of reach.
      var wrapStyle = { overflow: "hidden", transition: "max-height 280ms ease, opacity 220ms ease, margin-top 200ms ease", maxHeight: open ? 1600 : 0, opacity: open ? 1 : 0, marginTop: open ? 16 : 0 };
      if (!open) return h("div", { style: wrapStyle });
      return h("div", { style: wrapStyle },
        h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: isAccept ? SUCCESS : DECLINE, marginBottom: 14 } },
          isAccept ? "Accepting — confirm with your name & signature" : "Declining — let the team know why (optional)"),
        h("label", { style: labelStyle }, "Your Name *"),
        h("input", {
          type: "text",
          value: clientName,
          onChange: function(e) { setClientName(e.target.value); },
          maxLength: 100,
          placeholder: "Sarah Chen",
          onFocus: function(e) { e.target.style.borderColor = ORANGE; },
          onBlur: function(e) { e.target.style.borderColor = HAIR; },
          style: Object.assign({}, inputStyle, { marginBottom: 14 }),
        }),
        h("label", { style: labelStyle }, isAccept ? "Note (optional)" : "Reason (optional)"),
        h("textarea", {
          value: comment,
          onChange: function(e) { setComment(e.target.value); },
          maxLength: 1000,
          placeholder: isAccept ? "Looking forward to working together" : "e.g. we went another direction, or the dates moved",
          onFocus: function(e) { e.target.style.borderColor = ORANGE; },
          onBlur: function(e) { e.target.style.borderColor = HAIR; },
          style: Object.assign({}, inputStyle, { minHeight: 64, maxHeight: 320, resize: "vertical", marginBottom: isAccept ? 14 : 0 }),
        }),
        // Signature only mounts while the accept form is open, so the pad
        // initializes against its real on-screen width.
        isAccept && h("div", null,
          h("label", { style: labelStyle }, "Signature *"),
          h(SignaturePadComponent, { onReady: setSigHandle })),
        formErr && h("div", { style: { marginTop: 12, padding: "8px 12px", background: DECLINE_BG, border: "1px solid " + DECLINE_BD, borderRadius: 6, color: DECLINE, fontSize: "12px" } }, formErr),
        h("div", { style: { display: "flex", alignItems: "center", gap: 14, marginTop: 14 } },
          h("button", { type: "button", disabled: submitting, onClick: function() { setRespondMode(null); setFormErr(null); }, style: { marginRight: "auto", background: "none", border: "none", color: NEUTRAL, fontSize: "13px", cursor: submitting ? "default" : "pointer", fontFamily: "inherit", padding: 0 } }, "Back"),
          isAccept
            ? h("button", { type: "button", className: "ltp-accept-btn", disabled: submitting, onClick: submit, style: { minHeight: 48, padding: "0 24px", background: GRAD_BTN, color: BTN_INK, border: "none", borderRadius: 10, fontSize: "15px", fontWeight: 700, letterSpacing: "0.02em", cursor: submitting ? "wait" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.6 : 1, boxShadow: "0 6px 20px rgba(239,88,34,0.28)" } }, submitting ? "Sending…" : "Confirm & Accept")
            : h("button", { type: "button", disabled: submitting, onClick: submit, style: { minHeight: 48, padding: "0 24px", background: "transparent", color: DECLINE, border: "1px solid " + DECLINE, borderRadius: 10, fontSize: "15px", fontWeight: 700, letterSpacing: "0.02em", cursor: submitting ? "wait" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.6 : 1 } }, submitting ? "Sending…" : "Confirm Decline")));
    }

    // ── Action zone (pending prompt+buttons+reveal, or terminal banner) ───────
    var clientNote = (terminal && clientAction && clientAction.comment)
      ? h("div", { style: { marginTop: 28, borderLeft: "2px solid " + HAIR, paddingLeft: 14 } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: NEUTRAL } }, "Your note"),
          h("div", { style: { fontSize: "13px", color: TEXT, fontStyle: "italic", lineHeight: 1.55, marginTop: 6 } }, clientAction.comment))
      : null;

    var ghostDownloadBtn = h("div", { style: { display: "flex", justifyContent: "center", marginTop: 20 } },
      h("button", {
        type: "button", className: "ltp-decline-btn",
        onClick: downloadPdf,
        style: { background: "transparent", border: "1.5px solid " + HAIR, borderRadius: 10, padding: "10px 22px", color: TEXT, fontSize: "13px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" },
      }, "↓ Download PDF"));

    var actionZone;
    if (isQuote && terminal) {
      var bannerCfg;
      if (clientAction && clientAction.type === "client_accepted") {
        bannerCfg = { tone: "success", headline: "Quote accepted",
                      note: "Accepted by " + (clientAction.user || "client") + ". Thank you — we'll be in touch with next steps shortly.",
                      receipt: "Signed " + fmtStamp(clientAction.date, clientAction.time),
                      signatureDataUrl: clientAction.signatureDataUrl };
      } else if (clientAction && clientAction.type === "client_declined") {
        bannerCfg = { tone: "decline", headline: "Quote declined",
                      note: "Declined by " + (clientAction.user || "client") + ". Thanks for letting us know — if anything changes, just reach out.",
                      receipt: "Responded " + fmtStamp(clientAction.date, clientAction.time) };
      } else if (entity.status === "converted") {
        bannerCfg = { tone: "neutral", headline: "This quote has been finalized",
                      note: "It's been converted to an invoice — no further action is needed here." };
      } else {
        bannerCfg = { tone: entity.status === "accepted" ? "success" : "decline",
                      headline: "Quote " + entity.status,
                      note: "This quote has already been " + entity.status + " — no further action is needed." };
      }
      actionZone = h("div", { style: { marginTop: 40 } }, renderBanner(bannerCfg), ghostDownloadBtn);
    } else if (isQuote) {
      actionZone = h("div", { style: { marginTop: 40 } },
        h("div", { ref: actionRef, style: { background: INSET, border: "1px solid " + HAIR, borderRadius: 14, padding: 24 } },
          h("div", { style: { fontSize: "14px", fontWeight: 600, color: WHITE, textAlign: "center", marginBottom: 18 } }, "Ready to move forward?"),
          pendingChoiceButtons(isMobile),
          inlineReveal()),
        ghostDownloadBtn);
    } else {
      // Invoices are read-only — the primary action is the PDF copy.
      var paid = entity.status === "paid";
      actionZone = h("div", { style: { marginTop: 40 } },
        paid && h("div", { style: { marginBottom: 20 } },
          renderBanner({ tone: "success", headline: "Paid — thank you!", note: "This invoice has been settled in full." })),
        h("div", { style: { background: INSET, border: "1px solid " + HAIR, borderRadius: 14, padding: 24 } },
          h("div", { style: { fontSize: "14px", fontWeight: 600, color: WHITE, textAlign: "center", marginBottom: 16 } }, "Need a copy for your records?"),
          h("div", { style: { display: "flex", justifyContent: "center" } },
            h("button", {
              type: "button", className: "ltp-accept-btn",
              onClick: downloadPdf,
              style: { minHeight: 48, background: GRAD_BTN, color: BTN_INK, fontSize: "14px", fontWeight: 700, letterSpacing: "0.02em", border: "none", borderRadius: 10, padding: "12px 28px", cursor: "pointer", fontFamily: "inherit", boxShadow: "0 6px 20px rgba(239,88,34,0.28)" },
            }, "↓ Download PDF")),
          settings.phone && h("div", { style: { fontSize: "12px", color: MUTE, textAlign: "center", marginTop: 14 } },
            "Questions about this invoice? Call " + settings.phone + ".")));
    }

    // ── Prepared-for block ────────────────────────────────────────────────────
    var clientTitle = (company && company.name) || (contact && ((contact.firstName || "") + " " + (contact.lastName || "")).trim()) || "";
    var clientAddr = company ? window.LTP_formatAddress(company) : (contact ? window.LTP_formatAddress(contact) : "");
    var contactLine = (company && contact && (contact.firstName || contact.lastName))
      ? ((contact.firstName || "") + " " + (contact.lastName || "")).trim() + (contact.role ? "  —  " + contact.role : "")
      : (!company && contact && contact.role) ? contact.role : "";
    var preparedFor = (clientTitle || clientAddr || contactLine || (contact && contact.email))
      ? h("div", { style: { marginTop: 28, borderLeft: "2px solid " + HAIR, paddingLeft: 14 } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: NEUTRAL } }, "Prepared for"),
          clientTitle && h("div", { style: { fontSize: "15px", fontWeight: 700, color: WHITE, marginTop: 6 } }, clientTitle),
          clientAddr && h("div", { style: { fontSize: "12px", color: MUTE, marginTop: 3, lineHeight: 1.5 } }, clientAddr),
          contactLine && h("div", { style: { fontSize: "12px", color: MUTE, marginTop: 3 } }, contactLine),
          contact && contact.email && h("div", { style: { fontSize: "12px", color: FAINT, marginTop: 3 } }, contact.email))
      : null;

    // ── Mobile sticky action bar (pending quotes, before a choice is made) ────
    var showSticky = isMobile && isQuote && !terminal && !isPreview && respondMode === null;
    var stickyBar = showSticky
      ? h("div", { style: { position: "fixed", left: 0, right: 0, bottom: 0, background: INSET, borderTop: "1px solid " + HAIR, zIndex: 3000 } },
          h("div", { style: { height: 4, background: GRAD_RULE } }),
          h("div", { style: { display: "flex", gap: 12, padding: "12px 16px", paddingBottom: "calc(12px + env(safe-area-inset-bottom))" } },
            h("button", { type: "button", className: "ltp-accept-btn", onClick: function() { openMode("accept", true); }, style: { flex: "1.4 1 0", minHeight: 48, background: GRAD_BTN, color: BTN_INK, fontSize: "15px", fontWeight: 700, border: "none", borderRadius: 10, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 6px 20px rgba(239,88,34,0.28)" } }, "Accept"),
            h("button", { type: "button", className: "ltp-decline-btn", onClick: function() { openMode("decline", true); }, style: { flex: "1 1 0", minHeight: 48, background: "transparent", color: TEXT, fontSize: "15px", fontWeight: 600, border: "1.5px solid " + HAIR, borderRadius: 10, cursor: "pointer", fontFamily: "inherit" } }, "Decline")))
      : null;

    var pad = isMobile ? "28px 20px 0" : "40px 36px 0";
    var bottomPad = showSticky ? 96 : 56;

    // Footer — centered "Company · website" line matching the email shell/crew
    // page, plus a quieter address · phone line (the document's issuing-party
    // contact block, which the crew masthead doesn't carry but an invoice must).
    var websiteHref = settings.website
      ? (/^https?:\/\//i.test(settings.website) ? settings.website : "https://" + settings.website)
      : null;
    var addrLine = settingsAddress ? settingsAddress(settings) : "";
    var contactBits = [addrLine, settings.phone].filter(function(x) { return x; });
    var footer = h("div", { style: { marginTop: 44, paddingTop: 24, borderTop: "1px solid " + HAIR, textAlign: "center", fontSize: "11px", color: MUTE, lineHeight: 1.6 } },
      h("span", null, settings.companyName || "Luminary Technology & Productions"),
      settings.website && h("span", { style: { color: FAINT } }, "  ·  "),
      settings.website && h("a", { href: websiteHref, target: "_blank", rel: "noopener noreferrer", style: { color: MUTE, textDecoration: "none" } }, settings.website),
      contactBits.length > 0 && h("div", { style: { color: FAINT, marginTop: 2 } }, contactBits.join("  ·  ")));

    return h("div", { style: { minHeight: "100vh", background: BG, color: TEXT, fontFamily: FONT, padding: "0 0 " + bottomPad + "px" } },
      // Preview banner
      isPreview && h("div", { style: { background: ORANGE, color: BTN_INK, padding: "8px 20px", fontSize: "12px", fontWeight: 700, textAlign: "center", letterSpacing: "0.05em" } },
        "PREVIEW MODE — Accept and Decline are disabled. Remove ?preview=1 to use the real client view."),

      h("div", { style: { maxWidth: 820, margin: "0 auto", padding: pad } },
        // Masthead hero + brand rule (same lockup as the crew call sheet)
        h(Masthead, { failed: mastheadFailed, onFail: function() { setMastheadFailed(true); }, companyName: settings.companyName, maxWidth: 360 }),

        // Overline row: CUSTOMER QUOTE / INVOICE · status eyebrow
        h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginTop: 18 } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase", color: ORANGE_SOFT } }, isQuote ? "Customer Quote" : "Invoice"),
          h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase", color: statusEyebrow.c } }, statusEyebrow.t)),

        // Project marquee: big title + ref · date meta line
        h("div", { style: { marginTop: 32 } },
          h("div", { style: { fontSize: isMobile ? "26px" : "30px", fontWeight: 800, color: WHITE, letterSpacing: "-0.02em", lineHeight: 1.08, textTransform: "uppercase", overflowWrap: "break-word" } }, String(displayName).toUpperCase()),
          h("div", { style: { fontSize: "13px", fontWeight: 600, color: ORANGE_SOFT, letterSpacing: "0.01em", marginTop: 8 } },
            (isQuote ? "Quote " : "Invoice ") + ref + (dateValue ? "  ·  " + dateLabel + " " + fmtDate(dateValue) : ""))),

        // Prepared for
        preparedFor,

        // Line-item sections — the ruled tables
        (entity.sections || []).map(function(sec, i) { return renderSection(sec, i, entity, project, isMobile); }),

        // Totals
        renderTotals(entity, isMobile),

        // Terms
        h("div", { style: { marginTop: 44 } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: ORANGE } }, "Terms & Conditions"),
          h("div", { style: { marginTop: 12 } },
            // Whatever this document actually says — its own terms when it
            // carries any, else the workspace default, else the built-in list
            // that used to be hardcoded right here (and again, separately, in
            // backend/pdf_generator.py, which is how the printed PDF and this
            // page could come to disagree). Shared resolver: theme.js.
            window.LTP_docTerms(entity, kind, settings).map(function(line, i) {
              return h("div", { key: i, style: { fontSize: "12px", color: MUTE, lineHeight: 1.6, marginBottom: 4, paddingLeft: 12 } }, "•  " + line);
            }))),

        // Client note (terminal) then action zone / banner
        clientNote,
        actionZone,

        // Footer
        footer
      ),
      stickyBar
    );
  };
})();
