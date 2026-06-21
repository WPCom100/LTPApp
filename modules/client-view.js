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
(function() {
  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useRef = React.useRef;
  var B = window.LTP_THEME;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function fmtMoney(n) {
    var v = Number(n) || 0;
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return iso;
    var day = d.getDate();
    var sfx = (day >= 11 && day <= 13) ? "th"
            : ({1:"st", 2:"nd", 3:"rd"}[day % 10] || "th");
    return d.toLocaleString("en-US", { month: "long" }) + " " + day + sfx + ", " + d.getFullYear();
  }

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
    else if (gt === "amount" || gt === "flat") after = adj - gv;  // quotes: amount, invoices: flat
    else if (gt === "target") after = gv;
    after = Math.max(after, 0);
    // QuickBooks-computed sales tax (invoices only) makes the total tax-inclusive,
    // matching the app + PDF.
    var tax = (entity.qbTaxTotal != null) ? (Number(entity.qbTaxTotal) || 0) : 0;
    return { subtotal: sub, adjusted: adj, preTax: after, tax: tax, total: after + tax };
  }

  function settingsAddress(s) {
    if (!s) return "";
    var line1 = (s.street || "") + (s.suite ? ", " + s.suite : "");
    var line2 = (s.city || "") + (s.state ? ", " + s.state : "") + (s.zip ? " " + s.zip : "");
    return [line1, line2].filter(function(p) { return p && p.trim(); }).join(". ");
  }

  // ── Signature pad component ──────────────────────────────────────────────

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
      // the strokes remain visible. (Previously: white strokes on a
      // transparent PNG vanished against the white display background.)
      var pad = new window.SignaturePad(canvasRef.current, {
        backgroundColor: "#ffffff",
        penColor: "#233038",   // BLUE_OUT — brand-consistent dark
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

    return h("div", { style: { background: "#fff", border: "1px solid " + B.border, borderRadius: "6px", overflow: "hidden" } },
      // Canvas is visually white so dark pen strokes are visible while
      // drawing, AND the exported PNG (configured above with white
      // background) matches what the user sees in the form. No surprises
      // between draw-time and view-time.
      h("canvas", {
        ref: canvasRef,
        style: { width: "100%", height: 160, display: "block", cursor: "crosshair", touchAction: "none", background: "#fff" },
      }),
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", background: B.bg, borderTop: "1px solid " + B.border, fontSize: "10px", color: B.textMut } },
        h("span", null, "Sign with mouse or finger"),
        h("button", {
          type: "button",
          onClick: function() { if (padRef.current) padRef.current.clear(); },
          style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 10px", color: B.textMut, fontSize: "10px", cursor: "pointer", fontFamily: "inherit" },
        }, "Clear"),
      )
    );
  }

  // ── Accept / Decline modal ───────────────────────────────────────────────

  function AcceptDeclineForm(props) {
    // props: { kind: "accept" | "decline", token, onComplete(newStatus), onCancel }
    var [clientName, setClientName] = useState("");
    var [comment, setComment] = useState("");
    var [submitting, setSubmitting] = useState(false);
    var [error, setError] = useState(null);
    var [sigHandle, setSigHandle] = useState(null);

    var isAccept = props.kind === "accept";

    function submit() {
      setError(null);
      if (!clientName.trim()) {
        setError("Please enter your name.");
        return;
      }
      var body = { clientName: clientName.trim() };
      if (comment.trim()) body.comment = comment.trim();
      if (isAccept) {
        if (!sigHandle || sigHandle.isEmpty()) {
          setError("Please draw your signature before accepting.");
          return;
        }
        body.signatureDataUrl = sigHandle.getDataUrl();
      }
      setSubmitting(true);
      fetch("/api/view/" + props.token + "/" + props.kind, {
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
        .then(function(resp) {
          if (props.onComplete) props.onComplete(resp.status);
        })
        .catch(function(e) {
          setError(String(e.message || e));
          setSubmitting(false);
        });
    }

    var title = isAccept ? "Accept Quote" : "Decline Quote";
    var ctaLabel = isAccept ? "Accept" : "Decline";
    var ctaColor = isAccept ? B.success : B.danger;

    return h("div", {
      style: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 4000, padding: 20 }
    },
      h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "10px", padding: 24, maxWidth: 520, width: "100%", maxHeight: "90vh", overflowY: "auto" } },
        h("div", { style: { fontSize: "18px", fontWeight: 700, color: B.text, marginBottom: 4 } }, title),
        h("div", { style: { fontSize: "12px", color: B.textMut, marginBottom: 20 } },
          isAccept ? "Confirm your acceptance with name and signature." : "Let the team know why."),

        h("label", { style: { display: "block", fontSize: "10px", color: B.textMut, marginBottom: 4, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" } }, "Your Name *"),
        h("input", {
          type: "text",
          value: clientName,
          onChange: function(e) { setClientName(e.target.value); },
          maxLength: 100,
          placeholder: "Sarah Chen",
          style: { width: "100%", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px 10px", color: B.text, fontSize: "13px", fontFamily: "inherit", outline: "none", marginBottom: 14 }
        }),

        h("label", { style: { display: "block", fontSize: "10px", color: B.textMut, marginBottom: 4, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" } }, "Comment (optional)"),
        h("textarea", {
          value: comment,
          onChange: function(e) { setComment(e.target.value); },
          maxLength: 1000,
          placeholder: isAccept ? "Looking forward to working together" : "Reason for declining",
          style: { width: "100%", minHeight: 60, background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px 10px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", marginBottom: 14, resize: "vertical" }
        }),

        isAccept && h("div", null,
          h("label", { style: { display: "block", fontSize: "10px", color: B.textMut, marginBottom: 4, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" } }, "Signature *"),
          h(SignaturePadComponent, { onReady: setSigHandle })
        ),

        error && h("div", { style: { marginTop: 14, padding: "8px 12px", background: B.dangerBg, border: "1px solid " + B.dangerBd, borderRadius: "6px", color: B.danger, fontSize: "12px" } }, error),

        h("div", { style: { display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 } },
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
            style: { background: ctaColor, border: "none", borderRadius: "6px", padding: "8px 20px", color: "#000", fontSize: "12px", fontWeight: 700, cursor: submitting ? "wait" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.6 : 1 }
          }, submitting ? "Submitting…" : ctaLabel)
        )
      )
    );
  }

  // ── Section rendering ────────────────────────────────────────────────────

  function renderSection(sec, entity, project) {
    var items = (sec.items || []).filter(function(it) { return it.type !== "note"; });
    var notes = (sec.items || []).filter(function(it) { return it.type === "note"; });
    var secTotal = 0;
    items.forEach(function(it) {
      var qty = Number(it.qty) || 0;
      var eff = it.adjustedPrice != null ? Number(it.adjustedPrice) : Number(it.unitPrice) || 0;
      secTotal += eff * qty;
    });

    // Rental period line (only on equipment-containing sections)
    var hasEquip = items.some(function(it) { return it.type === "equipment"; });
    var secStart = sec.customDates ? sec.startDate : (entity.customStartDate || (project && project.startDate));
    var secEnd   = sec.customDates ? sec.endDate   : (entity.customEndDate   || (project && project.endDate));

    return h("div", { key: sec.id, style: { marginBottom: 26 } },
      h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 } },
        h("div", { style: { fontSize: "15px", fontWeight: 700, color: "#F9B998", letterSpacing: "0.03em", textTransform: "uppercase" } }, sec.label || "Section"),
        hasEquip && secStart && secEnd && h("div", { style: { fontSize: "11px", color: B.textMut } },
          "Rental Period: " + fmtDate(secStart) + " — " + fmtDate(secEnd))
      ),
      h("div", { style: { border: "1px solid #F9B998", borderRadius: "4px", overflow: "hidden" } },
        // Column headers
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 80px 110px 110px", padding: "8px 12px", borderBottom: "1px solid #3a4a52", fontSize: "10px", fontWeight: 700, color: B.textMut, letterSpacing: "0.05em" } },
          h("div", null, "ITEM"),
          h("div", { style: { textAlign: "center" } }, "QTY"),
          h("div", { style: { textAlign: "right" } }, "UNIT PRICE"),
          h("div", { style: { textAlign: "right" } }, "TOTAL")
        ),
        items.map(function(it, i) {
          var qty = Number(it.qty) || 0;
          var up  = Number(it.unitPrice) || 0;
          var ap  = it.adjustedPrice;
          var eff = ap != null ? Number(ap) : up;
          var lineTotal = eff * qty;
          var hasAdj = ap != null && Number(ap) !== up;
          var name = it.name || "";
          if (it.rentalLabel && it.type === "equipment") name += "  (" + it.rentalLabel + ")";
          return h("div", { key: it.id || i, style: { display: "grid", gridTemplateColumns: "1fr 80px 110px 110px", padding: "8px 12px", borderBottom: i < items.length - 1 ? "1px solid #2a3a42" : "none", fontSize: "12px", color: B.text, alignItems: "center", background: i % 2 === 0 ? "#2a3a42" : "transparent" } },
            h("div", null, name),
            h("div", { style: { textAlign: "center" } }, qty),
            h("div", { style: { textAlign: "right" } },
              hasAdj
                ? h("div", null,
                    h("div", { style: { fontSize: "10px", color: "#667777", textDecoration: "line-through" } }, fmtMoney(up)),
                    h("div", { style: { color: B.accent, fontWeight: 600 } }, fmtMoney(eff)))
                : fmtMoney(eff)
            ),
            h("div", { style: { textAlign: "right", color: "#F9B998", fontWeight: 600 } }, fmtMoney(lineTotal))
          );
        }),
        notes.map(function(n) {
          return h("div", { key: n.id, style: { padding: "8px 12px", fontSize: "11px", color: B.textMut, fontStyle: "italic", borderTop: "1px solid #2a3a42" } },
            "Note: " + (n.text || n.name || ""));
        })
      ),
      h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 6, paddingRight: 4 } },
        h("span", { style: { fontSize: "12px", color: B.textMut, marginRight: 12 } }, (sec.label || "Section") + " Subtotal:"),
        h("span", { style: { fontSize: "13px", color: B.accent, fontWeight: 700 } }, fmtMoney(secTotal)))
    );
  }

  function renderTotals(entity) {
    var t = calcTotals(entity);
    var gd = entity.globalDiscount || {};
    var gt = gd.type || "none";
    var disc = t.adjusted - t.preTax;
    var diff = t.subtotal - t.adjusted;

    return h("div", { style: { marginTop: 30, marginLeft: "auto", maxWidth: 340 } },
      h("div", { style: { borderTop: "2px solid #F9B998", paddingTop: 14 } },
        h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "13px", color: B.text, marginBottom: 8 } },
          h("span", null, "Subtotal:"),
          h("span", { style: { fontWeight: 600 } }, fmtMoney(t.subtotal))),
        Math.abs(diff) > 0.01 && h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "11px", color: B.textMut, marginBottom: 6 } },
          h("span", null, "Line Adjustments:"),
          h("span", null, (diff > 0 ? "-" : "+") + fmtMoney(Math.abs(diff)))),
        gt !== "none" && Math.abs(disc) > 0.01 && h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "11px", color: B.textMut, marginBottom: 6 } },
          h("span", null, gt === "percent" ? "Discount (" + (gd.value || 0) + "%):" : "Discount:"),
          h("span", null, "-" + fmtMoney(disc))),
        t.tax > 0.005 && h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "11px", color: B.textMut, marginBottom: 6 } },
          h("span", null, "Sales Tax:"),
          h("span", null, fmtMoney(t.tax)))
      ),
      h("div", { style: { borderTop: "2px solid " + B.accent, paddingTop: 14, marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
        h("span", { style: { fontSize: "18px", fontWeight: 800, color: B.accent, letterSpacing: "0.04em" } }, "TOTAL:"),
        h("span", { style: { fontSize: "20px", fontWeight: 800, color: B.text } }, fmtMoney(t.total)))
    );
  }

  // ── Main component ───────────────────────────────────────────────────────

  window.LTPClientView = function(props) {
    var token = props.route && props.route.id;
    var isPreview = props.route && props.route.query && props.route.query.preview === "1";
    // Per-recipient tracking token. Embedded in URLs the server sends
    // out via /api/email/send; absent for share-link-via-copy-paste opens.
    // We forward it verbatim to the backend so it can stamp
    // `recipient_opened` instead of anonymous `client_viewed`. The
    // PDF download URL below also carries it.
    var trackingToken = props.route && props.route.query && props.route.query.r;

    var [data, setData] = useState(null);
    var [loadErr, setLoadErr] = useState(null);
    var [showAccept, setShowAccept] = useState(false);
    var [showDecline, setShowDecline] = useState(false);

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

    // Loading state
    if (!data && !loadErr) {
      return h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "#233038", color: "#D1DBDA", fontFamily: "'DM Sans', sans-serif", fontSize: "13px" } }, "Loading…");
    }
    // Error state
    if (loadErr) {
      return h("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "#233038", padding: 30, fontFamily: "'DM Sans', sans-serif" } },
        h("div", { style: { maxWidth: 420, textAlign: "center", color: "#D1DBDA" } },
          h("div", { style: { fontSize: "20px", fontWeight: 700, marginBottom: 10 } }, "Not available"),
          h("div", { style: { fontSize: "13px", color: "#8899a0" } }, loadErr))
      );
    }

    var entity = data.entity;
    var company = data.company;
    var contact = data.contact;
    var project = data.project;
    var settings = data.settings;
    var kind = data.kind;
    var ref = data.ref;

    var displayName = (project && project.name) || entity.customName || (kind === "invoice" ? "Invoice" : "Quote");
    var dateLabel, dateValue;
    if (kind === "invoice") {
      dateLabel = "Invoice Date";
      dateValue = entity.invoiceDate || entity.createdDate;
    } else {
      dateLabel = "Date Issued";
      dateValue = entity.sentDate || entity.createdDate;
    }

    // What action UI to render
    var isQuote = kind === "quote";
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

    var BLUE_OUT = "#233038";
    var ORANGE = "#EF5822";
    var BACKUP_ORANGE = "#F9B998";
    var FULL_UP_GRAY = "#D1DBDA";

    return h("div", { style: { minHeight: "100vh", background: BLUE_OUT, color: FULL_UP_GRAY, fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif", padding: "0 0 40px" } },
      // Preview banner
      isPreview && h("div", { style: { background: ORANGE, color: "#000", padding: "8px 20px", fontSize: "12px", fontWeight: 700, textAlign: "center", letterSpacing: "0.05em" } },
        "PREVIEW MODE — Accept and Decline are disabled. Remove ?preview=1 to use the real client view."),

      h("div", { style: { maxWidth: 820, margin: "0 auto", padding: "30px 24px 0" } },
        // ── Top gradient bar ────────────────────────────────────────────
        h("div", { style: { height: 4, background: "linear-gradient(90deg, #FF921E 0%, #EF5822 50%, #64260F 100%)", borderRadius: "2px", marginBottom: 18 } }),

        // ── Header: company + ref ─────────────────────────────────────────
        h("div", { style: { display: "flex", alignItems: "center", gap: 14, marginBottom: 18 } },
          h("div", { style: { fontSize: "20px", fontWeight: 800, color: ORANGE, lineHeight: 1.1, letterSpacing: "0.02em", flex: 1 } },
            (settings.companyName || "LTP").toUpperCase(),
            h("div", { style: { fontSize: "10px", color: FULL_UP_GRAY, marginTop: 4, fontWeight: 400, letterSpacing: 0 } },
              settingsAddress(settings),
              (settings.phone || settings.emailFrom) && h("div", null,
                [settings.phone, settings.emailFrom].filter(function(x) { return x; }).join("  |  ")
              )
            )
          )
        ),

        // ── Project + ref ─────────────────────────────────────────────────
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 } },
          h("div", { style: { fontSize: "22px", fontWeight: 800, color: "#fff", letterSpacing: "0.03em" } }, displayName.toUpperCase()),
          h("div", { style: { fontSize: "20px", fontWeight: 800, color: BACKUP_ORANGE } }, (isQuote ? "Quote " : "Invoice ") + ref)
        ),

        // ── Client + date ─────────────────────────────────────────────────
        h("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: 4 } },
          h("div", { style: { fontSize: "12px", fontWeight: 700, color: BACKUP_ORANGE } },
            "Prepared for: " + ((company && company.name) || (contact && (contact.firstName + " " + contact.lastName).trim()) || "")),
          h("div", { style: { fontSize: "11px", color: FULL_UP_GRAY } }, dateLabel + ": " + fmtDate(dateValue))
        ),
        company && window.LTP_formatAddress(company) && h("div", { style: { fontSize: "11px", color: FULL_UP_GRAY, marginBottom: 4 } }, window.LTP_formatAddress(company)),
        contact && (contact.firstName || contact.lastName) && h("div", { style: { fontSize: "11px", color: FULL_UP_GRAY, marginBottom: 4 } },
          (contact.firstName + " " + (contact.lastName || "")).trim() + (contact.role ? "  —  " + contact.role : "")),
        !company && contact && window.LTP_formatAddress(contact) && h("div", { style: { fontSize: "11px", color: FULL_UP_GRAY, marginBottom: 4 } }, window.LTP_formatAddress(contact)),
        contact && contact.email && h("div", { style: { fontSize: "10px", color: "#8899a0", marginBottom: 16 } }, contact.email),

        h("div", { style: { height: 1, background: "#3a4a52", margin: "10px 0 24px" } }),

        // ── Sections ──────────────────────────────────────────────────────
        (entity.sections || []).map(function(sec) { return renderSection(sec, entity, project); }),

        // ── Totals ────────────────────────────────────────────────────────
        renderTotals(entity),

        // ── Terms ─────────────────────────────────────────────────────────
        h("div", { style: { marginTop: 36, borderTop: "1px solid #3a4a52", paddingTop: 14 } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, color: BACKUP_ORANGE, marginBottom: 10, letterSpacing: "0.05em" } }, "TERMS & CONDITIONS"),
          (isQuote
            ? [
                "This quote is valid for 30 days from the date of issue.",
                "Prices are subject to equipment availability at time of booking.",
                "All equipment rentals are subject to a damage waiver fee.",
                "Payment terms: 50% deposit upon acceptance, balance due prior to load-in.",
                "Cancellation within 72 hours of event may incur a 25% restocking fee.",
              ]
            : [
                "Payment is due within 30 days of the invoice date unless otherwise specified.",
                "Late payments are subject to a 1.5% monthly finance charge.",
                "Please include the invoice reference number with your payment.",
              ]
          ).map(function(line, i) {
            return h("div", { key: i, style: { fontSize: "11px", color: "#8899a0", marginBottom: 4, paddingLeft: 12 } }, "•  " + line);
          })
        ),

        // ── Action area ───────────────────────────────────────────────────
        h("div", { style: { marginTop: 36, padding: 20, background: "#1a2429", borderRadius: "10px", border: "1px solid #3a4a52" } },
          // If client already acted: show banner instead of buttons
          terminal && clientAction
            ? h("div", null,
                h("div", { style: { fontSize: "14px", fontWeight: 700, color: clientAction.type === "client_accepted" ? "#4CAF50" : "#E74C3C", marginBottom: 6 } },
                  (clientAction.type === "client_accepted" ? "✓ Accepted" : "✗ Declined") + " by " + (clientAction.user || "client") +
                  " on " + fmtDate(clientAction.date)),
                clientAction.comment && h("div", { style: { fontSize: "12px", color: FULL_UP_GRAY, fontStyle: "italic", marginBottom: 8 } }, "\"" + clientAction.comment + "\""),
                clientAction.signatureDataUrl && h("div", { style: { marginTop: 10 } },
                  h("div", { style: { fontSize: "10px", color: "#8899a0", marginBottom: 4 } }, "Signature:"),
                  h("img", { src: clientAction.signatureDataUrl, alt: "signature", style: { maxWidth: 280, maxHeight: 100, background: "#fff", padding: 6, borderRadius: "4px" } })
                )
              )
            : terminal
              // Terminal status but no client action recorded (e.g. LTP user
              // accepted manually in-app). Show a simple status banner.
              ? h("div", { style: { fontSize: "13px", color: FULL_UP_GRAY } }, "Status: " + entity.status)
              // Quotes get accept/decline buttons; invoices are view-only
              : isQuote
                ? h("div", { style: { display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" } },
                    h("button", {
                      type: "button",
                      onClick: function() { if (!isPreview) setShowAccept(true); },
                      disabled: isPreview,
                      style: { background: "#4CAF50", border: "none", borderRadius: "8px", padding: "12px 28px", color: "#000", fontSize: "14px", fontWeight: 700, cursor: isPreview ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: isPreview ? 0.5 : 1 }
                    }, "✓ Accept Quote"),
                    h("button", {
                      type: "button",
                      onClick: function() { if (!isPreview) setShowDecline(true); },
                      disabled: isPreview,
                      style: { background: "transparent", border: "2px solid #E74C3C", borderRadius: "8px", padding: "10px 24px", color: "#E74C3C", fontSize: "14px", fontWeight: 700, cursor: isPreview ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: isPreview ? 0.5 : 1 }
                    }, "Decline"),
                  )
                : null,
          h("div", { style: { display: "flex", justifyContent: "center", marginTop: 20 } },
            h("button", {
              type: "button",
              onClick: downloadPdf,
              style: { background: "transparent", border: "1px solid " + BACKUP_ORANGE, borderRadius: "6px", padding: "8px 18px", color: BACKUP_ORANGE, fontSize: "12px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }
            }, "↓ Download PDF")
          )
        )
      ),

      // Modals
      showAccept && h(AcceptDeclineForm, {
        kind: "accept", token: token,
        onComplete: function() { setShowAccept(false); reload(); },
        onCancel: function() { setShowAccept(false); },
      }),
      showDecline && h(AcceptDeclineForm, {
        kind: "decline", token: token,
        onComplete: function() { setShowDecline(false); reload(); },
        onCancel: function() { setShowDecline(false); },
      })
    );
  };
})();
