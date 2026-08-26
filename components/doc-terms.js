// Terms & Conditions editor — the bullet block printed at the foot of a quote
// or invoice, edited per document.
//
// WHY IT EXISTS
//   These bullets were a hardcoded array in backend/pdf_generator.py and again
//   in modules/client-view.js. The business could not change its own terms
//   without a code change, and the two copies could drift about what a client
//   had been told. Now the document carries them, falling back to a workspace
//   default and then to the built-ins those arrays used to hold.
//
// SHAPE
//   One line per bullet. Lines may carry {{token}} placeholders resolved at
//   render time (window.LTP_docTerms, theme.js) so a date named in the terms
//   tracks the document instead of freezing when the text was written.
//
//   The editor shows the EFFECTIVE text — the document's own when it has any,
//   otherwise whatever it is currently falling back to — so you edit from what
//   the client would actually see rather than from a blank box.
//
//   `onChange("")` is how "stop overriding" is expressed: an empty value means
//   "track the default", so a later change to the workspace terms flows through
//   to this document. That is what Reset to default does, and it is why the
//   editor distinguishes DEFAULT from CUSTOMIZED rather than just showing text.
//
// Collapsed by default. Terms are the part of a document you set once and rarely
// revisit, so they announce their state in the header and stay out of the way.
(function() {
  var h = React.createElement, useState = React.useState;
  var B = window.LTP_THEME;

  var TOKEN_HELP = {
    quote: "{{expiryDate}} · {{validityDays}} · {{companyName}}",
    invoice: "{{dueDate}} · {{paymentTerms}} · {{companyName}}",
  };

  window.LTPDocTerms = function({ kind, entity, settings, onChange, isLocked }) {
    var k = kind === "invoice" ? "invoice" : "quote";
    var openPair = useState(false), open = openPair[0], setOpen = openPair[1];

    var effective = window.LTP_docTermsText(entity, k, settings);
    var resolved = window.LTP_docTerms(entity, k, settings);
    var customized = !!(entity && entity.terms && String(entity.terms).trim());
    // What Reset would go back to — shown as the reason Reset is worth clicking.
    var fallbackSource = ((settings || {})[k === "invoice" ? "defaultInvoiceTerms" : "defaultQuoteTerms"] || "").trim()
      ? "workspace default"
      : "built-in default";

    function header() {
      return h("button", {
        type: "button",
        onClick: function() { setOpen(!open); },
        "aria-expanded": open ? "true" : "false",
        style: { width: "100%", background: "transparent", border: "none", padding: 0, margin: 0,
                 cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                 display: "flex", alignItems: "center", gap: 8 },
      },
        h("span", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.12em" } },
          "Terms & Conditions"),
        h("span", { style: { fontSize: "10px", color: customized ? B.accent : B.textMut, fontWeight: customized ? 700 : 400 } },
          resolved.length + (resolved.length === 1 ? " line" : " lines") + " · " + (customized ? "customized" : fallbackSource)),
        h("span", { style: { flex: 1 } }),
        h("span", { style: { fontSize: "10px", color: B.textMut } }, open ? "▴" : "▾"));
    }

    // Locked documents (an accepted quote, a sent invoice) show what they say
    // without offering to change it — the client already has this copy.
    if (isLocked) {
      return h("div", { style: { background: B.surface, borderTop: "1px solid " + B.border, padding: "12px 18px" } },
        header(),
        open && h("div", { style: { marginTop: 10 } }, resolved.map(function(line, i) {
          return h("div", { key: i, style: { fontSize: "11px", color: B.textSec, lineHeight: 1.6, paddingLeft: 10 } }, "•  " + line);
        })));
    }

    return h("div", { style: { background: B.surface, borderTop: "1px solid " + B.border, padding: "12px 18px" } },
      header(),
      open && h("div", { style: { marginTop: 10 } },
        h("textarea", {
          value: effective,
          onChange: function(e) { onChange(e.target.value); },
          rows: Math.max(4, resolved.length + 1),
          spellCheck: true,
          "aria-label": "Terms and conditions, one line per bullet",
          style: { width: "100%", boxSizing: "border-box", background: B.bg, border: "1px solid " + B.border,
                   borderRadius: "8px", padding: "8px 12px", color: B.text, fontSize: "12px",
                   fontFamily: "inherit", outline: "none", resize: "vertical", lineHeight: 1.6 },
          onFocus: function(e) { e.target.style.borderColor = B.accent; },
          onBlur: function(e) { e.target.style.borderColor = B.border; },
        }),
        h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" } },
          h("span", { style: { fontSize: "9px", color: B.textMut, lineHeight: 1.5 } },
            "One line per bullet. Available: " + TOKEN_HELP[k]),
          h("span", { style: { flex: 1, minWidth: 8 } }),
          customized && h("button", {
            type: "button",
            onClick: function() { onChange(""); },
            title: "Drop this document's own wording and follow the " + fallbackSource + " again",
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "4px",
                     padding: "3px 8px", color: B.textMut, fontSize: "9px", fontWeight: 600,
                     cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" } },
            "Reset to " + fallbackSource)),
        // The printed result, because a {{token}} in the box above is not what
        // the client reads and a line that resolves to nothing disappears here
        // rather than surprising someone on the PDF.
        h("div", { style: { marginTop: 10, paddingTop: 8, borderTop: "1px dashed " + B.border } },
          h("div", { style: { fontSize: "9px", color: B.textMut, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 } },
            "What the client sees"),
          resolved.length === 0
            ? h("div", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic" } }, "No terms will be printed.")
            : resolved.map(function(line, i) {
                return h("div", { key: i, style: { fontSize: "11px", color: B.textSec, lineHeight: 1.6, paddingLeft: 10 } }, "•  " + line);
              }))));
  };
})();
