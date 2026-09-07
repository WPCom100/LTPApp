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

    return h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
      h("div", { style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "10px", overflow: "hidden" } },
        h("button", { type: "button", onClick: function() { setOpen(!open); }, "aria-expanded": open, className: "ltp-tap",
          style: { display: "flex", alignItems: "center", gap: 10, width: "100%", minHeight: 52, padding: "8px 12px", background: "transparent", border: "none", textAlign: "left", cursor: "pointer", fontFamily: "inherit", color: B.text } },
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { style: Object.assign({ fontSize: "9px" }, LABEL) }, props.previewTitle),
            h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.accent, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
              props.refLabel,
              props.name ? h("span", { style: { color: B.textSec, fontWeight: 500 } }, "  \u00b7  " + props.name) : null)),
          props.amount != null && h("div", { style: { fontSize: "15px", fontWeight: 700, color: props.amountColor || B.text, fontVariantNumeric: "tabular-nums", flexShrink: 0 } }, props.amount),
          h("span", { "aria-hidden": "true", style: { color: B.textMut, fontSize: "10px", flexShrink: 0, display: "inline-block", transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" } }, "\u25bc")),
        open && h("div", { style: { padding: "0 12px 12px" } }, company, props.children)),
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
  window.LTPEmailComposePane = function LTPEmailComposePane(props) {
    // Phone: the pane is the full sheet width, so the meta rows get a little
    // more air and the subject field the 16px / 36px size every other phone
    // input has (index.html forces 16px on inputs anyway; the padding is what
    // stops that from producing a cramped 22px-tall field).
    var isMobile = window.LTP_useIsMobile();
    var metaLabel = { fontSize: isMobile ? "11px" : "10px", color: B.textMut, width: isMobile ? 42 : 35, flexShrink: 0 };
    var subjectStyle = { flex: 1, minWidth: 0, background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 8px", color: B.text, fontSize: "11px", fontWeight: 600, fontFamily: "inherit", outline: "none" };
    if (isMobile) Object.assign(subjectStyle, { borderRadius: "8px", padding: "0 10px", height: window.LTP_CTL, fontSize: "16px", boxSizing: "border-box" });
    return h("div", { style: { flex: 1, minWidth: 0, background: B.bg, border: "1px solid " + B.border, borderRadius: "8px", display: "flex", flexDirection: "column", overflow: "hidden" } },
      h("div", { style: { padding: isMobile ? "10px 12px" : "10px 14px", borderBottom: "1px solid " + B.border, background: B.surface } },
        h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 } }, "Email Preview"),
        // From: read-only — the recipient sees the signed-in LTP user's Google
        // identity. Surfacing it here removes the "who's it actually from?"
        // surprise some users get with multi-account apps.
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 5 } },
          h("span", { style: metaLabel }, "From:"),
          h("span", { style: { fontSize: isMobile ? "12px" : "11px", color: B.text, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            (window.LTP_SENDER_NAME || "") + (window.LTP_SENDER_EMAIL ? " <" + window.LTP_SENDER_EMAIL + ">" : ""))),
        h("div", { style: { marginBottom: 8 } },
          h(window.RecipientEditor, { value: props.recipients, onChange: props.onRecipientsChange, contacts: props.contacts })),
        h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
          h("span", { style: metaLabel }, "Subj:"),
          h("input", { value: props.subject, onChange: function(e) { props.onSubjectChange(e.target.value); },
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
        minHeight: isMobile ? 200 : 240,
      })
    );
  };
})();
