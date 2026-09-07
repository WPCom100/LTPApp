// The email side of every send modal: From, recipients, subject, the Gmail
// reconnect banner, and the WYSIWYG body editor.
//
// This block appeared verbatim three times — the quote send modal, the invoice
// send modal, and the payment-receipt modal — differing in exactly ONE value,
// the header kind ("quote" / "invoice" / "receipt") passed through to
// EmailBodyEditor. One parameter is a parameter; it is not a config flag, so
// this is a shared component rather than three near-copies.
//
// It is deliberately presentational. It owns no state: the send modals keep
// recipients / subject / body in the builder, because that is where the send
// itself reads them from and where they are seeded when the modal opens.
(function() {
  var h = React.createElement, useState = React.useState;
  var B = window.LTP_THEME;

  var LABEL = { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" };

  /**
   * The body of every document send modal: the document preview beside the
   * compose pane. Desktop keeps the 260px preview column on the left. On a
   * phone that column left the compose pane about fifty pixels wide, so there
   * the preview folds into a one-line summary card above the compose pane —
   * ref · name and the amount, tap to open the breakdown — and the email, the
   * thing actually being written, gets the whole width.
   *
   * props:
   *   previewTitle           "Quote Preview" / "Invoice Preview" / "Receipt Preview"
   *   refLabel, name         the document's reference and display name
   *   company                optional company line under the name
   *   amount, amountColor    the headline figure for the folded card
   *   children               the breakdown block (sections, dates, payments…)
   *   compose                the LTPEmailComposePane element
   */
  window.LTPSendModalBody = function LTPSendModalBody(props) {
    var isMobile = window.LTP_useIsMobile();
    var openPair = useState(false); var open = openPair[0], setOpen = openPair[1];
    var company = props.company ? h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 10 } }, props.company) : null;

    if (!isMobile) {
      return h("div", { style: { display: "flex", gap: 16, minHeight: 380 } },
        h("div", { style: { width: 260, flexShrink: 0, background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: 16, display: "flex", flexDirection: "column" } },
          h("div", { style: Object.assign({ marginBottom: 10 }, LABEL) }, props.previewTitle),
          h("div", { style: { fontSize: "16px", fontWeight: 700, color: B.accent, marginBottom: 4 } }, props.refLabel),
          h("div", { style: { fontSize: "11px", color: B.textSec, marginBottom: company ? 2 : 10 } }, props.name),
          company,
          props.children),
        props.compose);
    }

    // Folded card: the reference and amount on one line, the name (and
    // company) wrapping underneath, so nothing has to be cut short.
    var sub = [props.name, props.company].filter(Boolean).join("  \u00b7  ");
    return h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
      h("div", { style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "10px", overflow: "hidden" } },
        h("button", { type: "button", onClick: function() { setOpen(!open); }, "aria-expanded": open, className: "ltp-tap",
          style: { display: "flex", alignItems: "center", gap: 10, width: "100%", minHeight: 44, padding: "7px 10px", background: "transparent", border: "none", textAlign: "left", cursor: "pointer", fontFamily: "inherit", color: B.text } },
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { style: { display: "flex", alignItems: "baseline", gap: 8 } },
              h("span", { style: Object.assign({ fontSize: "9px" }, LABEL) }, props.previewTitle),
              h("span", { style: { fontSize: "12px", fontWeight: 700, color: B.accent } }, props.refLabel)),
            sub ? h("div", { style: { fontSize: "11px", color: B.textSec, marginTop: 1, lineHeight: 1.3 } }, sub) : null),
          props.amount != null && h("div", { style: { fontSize: "14px", fontWeight: 700, color: props.amountColor || B.text, fontVariantNumeric: "tabular-nums", flexShrink: 0 } }, props.amount),
          h("span", { "aria-hidden": "true", style: { color: B.textMut, fontSize: "10px", flexShrink: 0, display: "inline-block", transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" } }, "\u25bc")),
        open && h("div", { style: { padding: "0 10px 10px" } }, props.children)),
      props.compose);
  };

  /**
   * props:
   *   recipients, onRecipientsChange, contacts   RecipientEditor wiring
   *   subject, onSubjectChange                   subject line
   *   body, onBodyChange                         message body (carries
   *                                              {{placeholders}} intact)
   *   headerKind   "quote" | "invoice" | "receipt"
   *   headerVars   substitutions for the rendered header block
   *   settings     workspace settings (for the signature template)
   */
  // Phone subject line: a one-line <input> shows about 28 characters at the
  // 16px every phone input renders at (index.html forces it so iOS never
  // zooms on focus), which cut most subjects short. A textarea that sizes
  // itself to its text shows the whole subject on two lines instead. Enter
  // is swallowed and any pasted newline flattened, so the value stays the
  // single line a subject header has to be.
  function PhoneSubject(props) {
    var ref = React.useRef(null);
    React.useEffect(function() {
      var el = ref.current;
      if (!el) return;
      el.style.height = "0px";
      el.style.height = Math.max(window.LTP_CTL, el.scrollHeight) + "px";
    }, [props.value]);
    return h("textarea", { ref: ref, value: props.value, rows: 1, "aria-label": "Subject",
      onChange: function(e) { props.onChange(e.target.value.replace(/[\r\n]+/g, " ")); },
      onKeyDown: function(e) { if (e.key === "Enter") e.preventDefault(); },
      style: { flex: 1, minWidth: 0, background: B.bg, border: "1px solid " + B.border, borderRadius: "8px", padding: "8px 10px", color: B.text,
               fontSize: "16px", lineHeight: 1.25, fontWeight: 600, fontFamily: "inherit", outline: "none", resize: "none", overflow: "hidden", boxSizing: "border-box", height: window.LTP_CTL } });
  }

  window.LTPEmailComposePane = function LTPEmailComposePane(props) {
    // Phone: the pane is the full sheet width. The header is kept lean — no
    // section label, tighter rows, 11px meta — so the email underneath gets
    // as much of the screen as possible; the fields themselves stay at the
    // 16px / 36px every phone input has (index.html forces 16px on inputs).
    var isMobile = window.LTP_useIsMobile();
    var metaLabel = { fontSize: isMobile ? "11px" : "10px", color: B.textMut, width: isMobile ? 40 : 35, flexShrink: 0 };
    var subjectStyle = { flex: 1, minWidth: 0, background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 8px", color: B.text, fontSize: "11px", fontWeight: 600, fontFamily: "inherit", outline: "none" };
    return h("div", { style: { flex: 1, minWidth: 0, background: B.bg, border: "1px solid " + B.border, borderRadius: "8px", display: "flex", flexDirection: "column", overflow: "hidden" } },
      h("div", { style: { padding: isMobile ? "8px 10px" : "10px 14px", borderBottom: "1px solid " + B.border, background: B.surface } },
        !isMobile && h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 } }, "Email Preview"),
        // From: read-only — the recipient sees the signed-in LTP user's Google
        // identity. Surfacing it here removes the "who's it actually from?"
        // surprise some users get with multi-account apps.
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: isMobile ? 6 : 5 } },
          h("span", { style: metaLabel }, "From:"),
          h("span", { style: { fontSize: "11px", color: B.text, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            (window.LTP_SENDER_NAME || "") + (window.LTP_SENDER_EMAIL ? " <" + window.LTP_SENDER_EMAIL + ">" : ""))),
        h("div", { style: { marginBottom: isMobile ? 6 : 8 } },
          h(window.RecipientEditor, { value: props.recipients, onChange: props.onRecipientsChange, contacts: props.contacts })),
        h("div", { style: { display: "flex", gap: 6, alignItems: isMobile ? "flex-start" : "center" } },
          h("span", { style: isMobile ? Object.assign({}, metaLabel, { paddingTop: 10 }) : metaLabel }, "Subj:"),
          isMobile
            ? h(PhoneSubject, { value: props.subject, onChange: props.onSubjectChange })
            : h("input", { value: props.subject, onChange: function(e) { props.onSubjectChange(e.target.value); },
                style: subjectStyle }))),
      // Reconnect banner — surfaced inside the modal so the user sees it AT the
      // moment they're trying to send rather than at app load.
      !window.LTP_GMAIL_CONNECTED && h("div", { style: { padding: "8px 14px", background: B.warn + "11", borderBottom: "1px solid " + B.warn + "44", fontSize: "11px", color: B.warn } },
        "Gmail isn't connected for your account. Sign out and back in with Google to grant the gmail.send permission."),
      // WYSIWYG body editor. The user sees the rendered email and edits text
      // inline; the signature block is rendered and locked
      // (contenteditable="false" inside EmailBodyEditor) and {{viewUrl}} lives
      // in href attributes invisibly. HTML editing happens in the template
      // editor in Settings, not at send time.
      //
      // `body` still carries placeholders intact — EmailBodyEditor extracts the
      // editable HTML and reverses the signature substitution on every input,
      // so what is POSTed to /api/email/send still has {{signature}} for the
      // backend to render per-user.
      h(window.EmailBodyEditor, {
        value: props.body,
        signatureTemplate: ((props.settings || {}).emailSignatureTemplate || (window.LTP_DATA_SETTINGS || {}).emailSignatureTemplate),
        headerKind: props.headerKind,
        headerVars: props.headerVars,
        onChange: props.onBodyChange,
        minHeight: isMobile ? 180 : 240,
      })
    );
  };
})();
