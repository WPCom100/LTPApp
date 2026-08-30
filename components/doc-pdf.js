// Generate a document's PDF and hand back the activity entry to record.
//
// This was 64 lines in the quote builder and 57 in the invoice builder,
// functionally identical — after normalising the document naming the ONLY
// difference between them was a loop variable called `q` in one and `inv` in
// the other. It covers three things that are easy to get subtly wrong and were
// therefore worth having in one place:
//
//   * the iOS standalone workaround. A home-screen PWA blocks programmatic
//     downloads AND window.open after an await, so on mobile a blank tab has to
//     be opened SYNCHRONOUSLY inside the click gesture and redirected once the
//     PDF is ready. Desktop keeps the direct <a download>. Get this wrong and
//     the button silently does nothing on a phone.
//   * error reporting. Failures go to the LTP_API_ERRORS ring buffer AND an
//     "ltp-api-error" CustomEvent, so the existing toast system surfaces them.
//   * the optimistic activity entry. The server is the source of truth; this is
//     mirrored into local state so the feed updates before the next save sync.
//
// It deliberately does NOT touch component state. It resolves with the activity
// entry and lets the caller decide what to do with it, because what that is —
// which list setter, which ref to advance — differs between the two builders
// and is the only part that legitimately does.
//
// window.fetch is called explicitly rather than bare so tests can stub it; the
// same reason backend/gmail.py takes an injectable httpx_client.
(function() {
  /**
   * opts:
   *   kind        "quote" | "invoice"  — selects the API path and the fallback
   *                                      filename prefix
   *   id          document id
   *   isMobile    open-a-tab-first path vs direct download
   * Resolves with the activity entry to append. Rejects with an Error whose
   * message is safe to show; reporting has already happened by then.
   */
  window.LTP_generateDocPdf = function(opts) {
    var o = opts || {};
    var kind = o.kind === "invoice" ? "invoice" : "quote";
    var path = kind === "invoice" ? "/api/invoices/" : "/api/quotes/";
    var prefix = kind === "invoice" ? "INV-" : "Q-";
    var label = (kind === "invoice" ? "POST invoices/" : "POST quotes/") + o.id + "/pdf";

    // Synchronously, inside the click gesture — see the note above.
    var pdfWin = o.isMobile ? window.open("", "_blank") : null;

    return window.fetch(path + o.id + "/pdf", { method: "POST", credentials: "include" })
      .then(function(r) {
        if (!r.ok) {
          return r.text().then(function(body) {
            throw new Error("PDF generation failed: " + r.status + " " + body.slice(0, 200));
          });
        }
        return r.json();
      })
      .then(function(resp) {
        if (pdfWin) {
          pdfWin.location = resp.downloadUrl;
        } else {
          // <a download> on a same-origin URL just works.
          var a = document.createElement("a");
          a.href = resp.downloadUrl;
          a.download = resp.filename || (prefix + o.id + ".pdf");
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }
        return {
          id: "pdf-" + Date.now(),
          date: window.LTP_todayISO(),
          time: new Date().toTimeString().substring(0, 5),
          type: "pdf_generated",
          user: (window.LTP_CURRENT_USER || "User"),
          userId: window.LTP_CURRENT_USER_ID || null,
          message: "PDF generated",
          pdfToken: resp.token,
          pdfFilename: resp.filename,
        };
      })
      .catch(function(err) {
        if (pdfWin) { try { pdfWin.close(); } catch (e) {} }
        // data-state.js's fetch wrapper handles 401 by redirecting; everything
        // else surfaces through the existing toast system.
        if (window.LTP_API_ERRORS) {
          window.LTP_API_ERRORS.push({ at: new Date().toISOString(), label: label, error: String(err) });
        }
        try {
          window.dispatchEvent(new CustomEvent("ltp-api-error",
            { detail: { label: "PDF generation", error: String(err), at: new Date().toISOString() } }));
        } catch (e) {}
        throw err;
      });
  };
})();
