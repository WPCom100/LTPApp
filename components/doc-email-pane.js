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
  var h = React.createElement;
  var B = window.LTP_THEME;

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
    return h("div", { style: { flex: 1, background: B.bg, border: "1px solid " + B.border, borderRadius: "8px", display: "flex", flexDirection: "column", overflow: "hidden" } },
      h("div", { style: { padding: "10px 14px", borderBottom: "1px solid " + B.border, background: B.surface } },
        h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 } }, "Email Preview"),
        // From: read-only — the recipient sees the signed-in LTP user's Google
        // identity. Surfacing it here removes the "who's it actually from?"
        // surprise some users get with multi-account apps.
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 5 } },
          h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "From:"),
          h("span", { style: { fontSize: "11px", color: B.text } },
            (window.LTP_SENDER_NAME || "") + (window.LTP_SENDER_EMAIL ? " <" + window.LTP_SENDER_EMAIL + ">" : ""))),
        h("div", { style: { marginBottom: 8 } },
          h(window.RecipientEditor, { value: props.recipients, onChange: props.onRecipientsChange, contacts: props.contacts })),
        h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
          h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "Subj:"),
          h("input", { value: props.subject, onChange: function(e) { props.onSubjectChange(e.target.value); },
            style: { flex: 1, background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 8px", color: B.text, fontSize: "11px", fontWeight: 600, fontFamily: "inherit", outline: "none" } }))),
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
        minHeight: 240,
      })
    );
  };
})();
