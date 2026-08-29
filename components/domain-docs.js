// LTP domain — quotes and invoices: totals, references, terms, expiry, the
// document/project links, and the data-fault collectors. THIS IS MONEY MATH.
//
// Split out of theme.js. LTP_QUOTE_TOTALS and LTP_INVOICE_TOTALS are the
// frontend's authoritative totals; the same line-item rule (effective price =
// adjustedPrice ?? unitPrice, then the percent/amount/flat/target discount) is
// also implemented in backend/pdf_generator.py and backend/qbo_sync.py, and
// that duplication has already produced one production money bug. Treat any
// change here as a change to all three.
//
// KEEP TOGETHER: _termsVars builds the substitution map for LTP_docTerms.
// Currently a global rather than a true private (see domain-labor.js).
//
// LOAD ORDER CONTRACT — read before moving this <script> tag.
//   These domain-*.js files were split out of theme.js. They must stay in
//   index.html's THEME slot (group 3), together and in the listed order, and
//   BEFORE every components/ and modules/ file — NOT down in the components
//   group where their path suggests they belong. 46 frontend files alias these
//   exports into IIFE-locals at their OWN load time (modules/quotes-list.js:9
//   is `var computeTotals = window.LTP_QUOTE_TOTALS;`), so a symbol defined
//   after its consumer's <script> is captured as undefined, not late-bound.
//   They also belong in sw.js's SAME_ORIGIN_PRECACHE boot chain beside
//   /theme.js, or the shell drops them on a cold offline launch.
//
// Nothing here reads another LTP_ symbol at load time, so the order AMONG
// these files is free; it is fixed only for readability. The one genuine
// load-order edge in the original file (the LTP_STATUS_COLORS IIFE calling
// LTP_badgeFromHex) stayed behind in theme.js on purpose.


window.LTP_INVOICE_REF = function(inv) {
  if (!inv) return "INV-?";
  var year = (inv.invoiceDate || "").substring(0, 4) || new Date().getFullYear();
  var num = String(inv.id || 0).padStart(3, "0");
  return "INV-" + year + "-" + num;
};

window.LTP_INVOICE_TOTALS = function(inv) {
  if (!inv) return { subtotal: 0, adjusted: 0, discount: 0, tax: 0, total: 0, paid: 0, balance: 0 };
  // `subtotal` is the ORIGINAL list price and `adjusted` the sum after per-line
  // price overrides — the same split LTP_QUOTE_TOTALS, client-view.js::calcTotals
  // and pdf_generator.py::_calc_totals use, so the "Adjustments" line means the
  // same thing on all four surfaces. This function used to report only the
  // adjusted figure, under the name `subtotal`, with no `adjusted` at all; the
  // invoice editor's adjustments row compared against that missing key and so
  // rendered on every invoice (see modules/invoices.js).
  var subtotal = 0;
  var adjusted = 0;
  (inv.sections || []).forEach(function(sec) {
    (sec.items || []).forEach(function(it) {
      if (it.type === "note") return;
      var qty = it.qty || 0;
      var price = it.adjustedPrice != null ? it.adjustedPrice : (it.unitPrice || 0);
      subtotal += (it.unitPrice || 0) * qty;
      adjusted += price * qty;
    });
  });
  // Global discount. A fixed-dollar discount is "amount" — that is what BOTH
  // builders' "$" option writes (modules/invoices.js, modules/quotes-builder.js).
  // "flat" is a LEGACY ALIAS, accepted forever but never written: it was this
  // function's original spelling and never matched what the invoice UI actually
  // saved, so a "$" discount computed as $0 here (and in the QuickBooks payload)
  // while the client's PDF and share link — which already accepted both — showed
  // it applied. Three parties saw three totals. All four readers now agree:
  // here, backend/qbo_sync.py::_build_sales_lines,
  // backend/pdf_generator.py::_calc_totals, modules/client-view.js::calcTotals.
  // The discount applies to the ADJUSTED figure, not the original list price —
  // same base as the other three readers.
  var gd = inv.globalDiscount || {};
  var discount = 0;
  if (gd.type === "percent") discount = adjusted * (gd.value || 0) / 100;
  else if (gd.type === "amount" || gd.type === "flat") discount = gd.value || 0;
  else if (gd.type === "target") discount = Math.max(0, adjusted - (gd.value || 0));
  // Never discount past zero — an over-large amount or a >100% rate would
  // otherwise show a NEGATIVE total here while the PDF and client view (both
  // of which clamp) showed 0. Same rule as LTP_QUOTE_TOTALS below.
  if (discount > adjusted) discount = adjusted;
  if (discount < 0) discount = 0;
  var afterDiscount = adjusted - discount;
  // Tax is QuickBooks-authoritative: QB computes the sales tax (qbTaxTotal) on
  // push and the whole-invoice total reflects it everywhere LTP_INVOICE_TOTALS is
  // consumed (builder, list, dashboard, client view, PDF). Before any push it is
  // null and tax is 0 — never an estimate off a configured flat rate. This
  // function alone used to apply one, claiming a tax the PDF and the client view
  // both showed as zero; the setting behind it is gone. Same rule as
  // LTP_QUOTE_TOTALS below.
  var tax = (inv.qbTaxTotal != null) ? (Number(inv.qbTaxTotal) || 0) : 0;
  var total = afterDiscount + tax;
  var paid = (inv.payments || []).reduce(function(s, p) { return s + (Number(p.amount) || 0); }, 0);
  return { subtotal: subtotal, adjusted: adjusted, discount: discount, tax: tax,
           preTax: afterDiscount, total: total, paid: paid, balance: Math.max(0, total - paid) };
};

// ── Quote expiration ────────────────────────────────────────────────────────
// A quote's prices are only good for so long. The date that happens on is
// `quote.expiryDate`, set in the builder; when it's empty every reader falls
// back to the workspace default (Settings → Quote Validity, mirrored onto
// LTP_DEFAULT_QUOTE_VALIDITY) counted from the day the quote went out — which
// is the only rule that existed before the field did, so an old quote still
// reads exactly as it always has.
//
// Counting from `sentDate` and not from today matters: an unsent draft has no
// clock running on it yet, so it has no expiry to show. Once it's sent the
// builder stamps a concrete date, and the client's copy stops moving even if
// the workspace default is later changed.

// The workspace fallback, in days. `override` lets a surface that has the
// settings blob but not the app globals pass the value in — the public client
// view loads without a session, so app.js never ran to mirror it onto window.
window.LTP_QUOTE_VALIDITY_DAYS = function(override) {
  var n = Number(override != null && override !== "" ? override : window.LTP_DEFAULT_QUOTE_VALIDITY);
  return (isFinite(n) && n > 0) ? Math.floor(n) : 30;
};

// The ISO date this quote expires, or "" when there's nothing to count from.
// `asOf` (ISO) stands in for the sent date on a quote that hasn't gone out —
// the builder passes today so the field can preview what sending would stamp.
window.LTP_quoteExpiry = function(quote, asOf, validityDays) {
  if (!quote) return "";
  if (quote.expiryDate) return quote.expiryDate;
  var from = quote.sentDate || asOf || "";
  if (!from) return "";
  var d = new Date(from);
  if (isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + window.LTP_QUOTE_VALIDITY_DAYS(validityDays));
  return d.toISOString().substring(0, 10);
};

// True once a quote the client could still act on has gone stale. Only "sent"
// qualifies: a draft was never promised to anyone, and accepted / declined /
// converted are all settled — an accepted quote doesn't un-accept itself
// because a date passed.
window.LTP_isQuoteExpired = function(quote) {
  if (!quote || quote.status !== "sent") return false;
  var exp = window.LTP_quoteExpiry(quote);
  return !!exp && exp < window.LTP_todayISO();
};

// ── Terms & conditions ──────────────────────────────────────────────────────
// The bullet list printed at the foot of a quote or invoice. It used to be a
// hardcoded array in TWO places (backend/pdf_generator.py and the client view),
// so the business could not change its own terms without a code change, and the
// two copies could drift about what a client had been told.
//
// Resolution order, first non-empty wins:
//   1. the document's own `terms`  — edited in the builder, per document
//   2. the workspace default       — Settings → Business Defaults, per kind
//   3. the built-in below          — what the hardcoded arrays used to say
//
// One line per bullet. Blank lines are dropped, so a trailing newline or a
// spacer line in the textarea doesn't print an empty bullet.
//
// PLACEHOLDERS
//   Lines may use the same {{token}} syntax as the email templates, because a
//   term usually needs to name a date the document already knows — and freezing
//   that date into the text is how the printed terms come to contradict the
//   document they're printed on. Supported:
//
//     {{expiryDate}}    quote — the day the pricing stops being good for
//     {{validityDays}}  quote — that same window, in days
//     {{dueDate}}       invoice — the day payment is due
//     {{paymentTerms}}  invoice — the workspace net-terms number
//     {{companyName}}   either
//
//   A line naming a value the document does NOT have is dropped rather than
//   printed with a hole in it: an unsent quote carrying no expiry has no
//   deadline to promise, and "This quote is valid through ." is worse than
//   saying nothing. An UNKNOWN token is left literal instead — a typo should be
//   visible, not silently swallow the line it sits in.
//
// NB: window.LTP_DEFAULT_TERMS is something else entirely (the net payment-terms
// NUMBER, set in app.js) — hence the name here.
window.LTP_BUILTIN_TERMS = {
  quote: [
    "This quote is valid through {{expiryDate}}.",
    "Prices are subject to equipment availability at time of booking.",
    "All equipment rentals are subject to a damage waiver fee.",
    "Payment terms: 50% deposit upon acceptance, balance due prior to load-in.",
    "Cancellation within 72 hours of event may incur a 25% restocking fee.",
  ].join("\n"),
  invoice: [
    "Payment is due within {{paymentTerms}} days of the invoice date unless otherwise specified.",
    "Late payments are subject to a 1.5% monthly finance charge.",
    "Please include the invoice reference number with your payment.",
  ].join("\n"),
};

// The terms TEXT this document should start from — its own, else the workspace
// default, else the built-in. The builders use it to seed the editor and to
// power "Reset to default".
//
// `settings` is passed explicitly rather than read off a global because the
// public client view loads without a session, so app.js never ran there.
window.LTP_docTermsText = function(entity, kind, settings) {
  var k = kind === "invoice" ? "invoice" : "quote";
  var own = entity && entity.terms;
  if (own && String(own).trim()) return String(own);
  var key = k === "invoice" ? "defaultInvoiceTerms" : "defaultQuoteTerms";
  var fromSettings = (settings || {})[key];
  if (fromSettings && String(fromSettings).trim()) return String(fromSettings);
  return window.LTP_BUILTIN_TERMS[k];
};

// The {{token}} values available to a document's terms, by kind.
function _termsVars(entity, kind, settings) {
  var e = entity || {}, s = settings || {};
  if (kind === "invoice") {
    return {
      dueDate: e.dueDate ? window.LTP_formatDate(e.dueDate) : "",
      paymentTerms: String(s.defaultPaymentTerms || 30),
      companyName: s.companyName || "",
    };
  }
  var expiry = window.LTP_quoteExpiry(e, "", s.defaultQuoteValidity);
  return {
    expiryDate: expiry ? window.LTP_formatDate(expiry) : "",
    validityDays: String(window.LTP_QUOTE_VALIDITY_DAYS(s.defaultQuoteValidity)),
    companyName: s.companyName || "",
  };
}

// The resolved bullet lines to PRINT. Every surface that renders terms — the
// builder's preview, the client view, and (via its Python twin in
// backend/pdf_generator.py) the PDF — goes through here, so all three say the
// same thing to the same client.
window.LTP_docTerms = function(entity, kind, settings) {
  var k = kind === "invoice" ? "invoice" : "quote";
  var vars = _termsVars(entity, k, settings);
  return String(window.LTP_docTermsText(entity, k, settings))
    .split("\n")
    .map(function(line) { return line.trim(); })
    .filter(function(line) { return line.length > 0; })
    // Checked BEFORE substitution — after it, an empty token is indistinguishable
    // from prose, because the rest of the sentence still reads fine.
    .filter(function(line) {
      var hasEmpty = false;
      line.replace(/\{\{(\w+)\}\}/g, function(match, key) {
        if (Object.prototype.hasOwnProperty.call(vars, key) && !String(vars[key]).trim()) hasEmpty = true;
        return match;
      });
      return !hasEmpty;
    })
    .map(function(line) { return window.LTP_resolveTemplate(line, vars); });
};

window.LTP_isOverdue = function(inv) {
  if (!inv || !inv.dueDate || inv.status === "draft" || inv.status === "paid") return false;
  return inv.dueDate < window.LTP_todayISO();
};

window.LTP_displayStatus = function(inv) {
  if (!inv) return "draft";
  if (inv.status === "paid") return "paid";
  var t = window.LTP_INVOICE_TOTALS(inv);
  if (t.paid > 0 && t.balance > 0) return "partial";
  if (window.LTP_isOverdue(inv)) return "overdue";
  return inv.status || "draft";
};

// Quote helpers — moved here from quotes-list to ensure availability
// Per-SECTION totals for the quote and invoice builders' summary panels.
//
// Both builders had their own copy of this loop. They were not quite twins, and
// the difference was in the RETURN, which is the part that matters:
//   quotes-builder.js  returned { subtotal, margin: sub - cst }
//   invoices.js        returned { subtotal, cost }
// so `margin` and `cost` were genuinely different numbers, not two names for
// one value — unifying them naively would have shipped a money bug.
//
// Tracing the call sites settles it: quotes reads .subtotal and .margin
// (quotes-builder.js:2586 `sectionMargin: t.margin`), invoices reads .subtotal
// and NOTHING else — its `cost` field had no consumer at all. So returning all
// three fields serves both callers with no behaviour change in either.
//
// Note this is section-level and deliberately simpler than LTP_QUOTE_TOTALS /
// LTP_INVOICE_TOTALS below: no global discount, no tax, no payments. A section
// subtotal is the sum of its lines at the effective price, full stop.
// Apply one drag-reorder move to a document's sections. Pure: returns a NEW
// sections array, or the SAME reference when the move is a no-op, so a caller
// can skip the state update entirely.
//
// `m` is { kind, id, fromZone, toZone, targetId, after } from
// components/sortable.js, applied continuously while a row is in flight (once
// per hit-test), not once on release — that is what makes the list itself the
// drop preview. A null targetId means "append to toZone" (released over a
// section's empty space).
//
// Both builders carried this, byte-identical after comments and indentation;
// the only real difference was that invoices guarded on isDraft and quotes did
// not (quotes gates reordering at the sortable's `enabled:` instead, which
// covers the keyboard path too — components/sortable.js:389). That guard stays
// with each caller, where the policy belongs; only the transform moved here.
// Being pure, it is finally unit-testable — the drag path had no coverage at
// all while it lived inside two 1,700-line closures.
window.LTP_applySortMove = function(sections, m) {
  if (!sections || !m) return sections;

  if (m.kind === "section") {
    var secs = sections.slice();
    var from = secs.findIndex(function(s) { return s.id === m.id; });
    if (from === -1) return sections;
    var moved = secs.splice(from, 1)[0];
    var to = m.targetId == null ? secs.length : secs.findIndex(function(s) { return s.id === m.targetId; });
    if (to === -1) to = secs.length;
    else if (m.after) to += 1;
    secs.splice(to, 0, moved);
    return secs;
  }

  var copy = sections.map(function(s) { return Object.assign({}, s, { items: (s.items || []).slice() }); });
  var src = copy.find(function(s) { return s.id === m.fromZone; });
  var dest = copy.find(function(s) { return s.id === m.toZone; });
  if (!src || !dest) return sections;
  var idx = src.items.findIndex(function(i) { return i.id === m.id; });
  if (idx === -1) return sections;
  var item = src.items.splice(idx, 1)[0];
  // Resolve the target AFTER the removal so the index is already correct for a
  // same-section move.
  var at = m.targetId == null ? dest.items.length : dest.items.findIndex(function(i) { return i.id === m.targetId; });
  if (at === -1) at = dest.items.length;
  else if (m.after) at += 1;
  dest.items.splice(at, 0, item);
  return copy;
};

// ── Save-confirmation change summaries ─────────────────────────────────────
// What changed between the last saved document and the working draft, as a
// list of {cat, detail} rows the save dialog renders.
//
// Both lived inside their module: quotes at file scope, invoices buried inside
// the 1,998-line InvoiceBuilder closure. Neither could be tested — file scope
// inside an IIFE is readable, not reachable. Each had exactly ONE free
// identifier (`fmt`, an alias for window.LTP_formatDate), so both moved here
// verbatim with that inlined and nothing else changed.
//
// They are deliberately NOT merged. A quote's summary tracks expiry, client
// rates and section dates; an invoice's tracks due date, payments and the
// QuickBooks link. The overlap is the entity header, and folding two different
// documents' change vocabularies into one function with a `kind` flag would
// cost more than the ~30 lines it saves.
window.LTP_quoteChanges = function(before, after, projects, companies) {
  if (!before || !after) return null;
  var changes = [];
  projects = projects || [];
  companies = companies || [];

  // Helper: resolve effective dates for a quote snapshot
  function effectiveDates(q) {
    if (q.projectId) {
      var p = projects.find(function(pr) { return pr.id === q.projectId; });
      return p ? { start: p.startDate, end: p.endDate } : { start: "", end: "" };
    }
    return { start: q.customStartDate || "", end: q.customEndDate || "" };
  }

  // Totals
  var tBefore = window.LTP_QUOTE_TOTALS(before);
  var tAfter  = window.LTP_QUOTE_TOTALS(after);
  if (Math.round(tBefore.total * 100) !== Math.round(tAfter.total * 100)) {
    changes.push({ cat: "Quote Total", detail: "$" + window.LTP_money(tBefore.total) + " → $" + window.LTP_money(tAfter.total) });
  }

  // Status
  if (before.status !== after.status) {
    changes.push({ cat: "Status", detail: (before.status || "draft") + " \u2192 " + (after.status || "draft") });
  }

  // Client type
  if (before.clientType !== after.clientType) {
    changes.push({ cat: "Client Type", detail: (before.clientType || "company") + " \u2192 " + (after.clientType || "company") });
  }

  // Company
  if (before.companyId !== after.companyId) {
    var cB = window.LTP_diffEntityName(companies, before.companyId);
    var cA = window.LTP_diffEntityName(companies, after.companyId);
    changes.push({ cat: "Company", detail: cB + " \u2192 " + cA });
  }

  // Custom name
  if (before.customName !== after.customName) {
    changes.push({ cat: "Quote Name", detail: (before.customName || "None") + " \u2192 " + (after.customName || "None") });
  }

  // Global discount
  var gdB = before.globalDiscount || {}, gdA = after.globalDiscount || {};
  if (gdB.type !== gdA.type || gdB.value !== gdA.value) {
    var gdBLabel = gdB.type === "none" || !gdB.type ? "None" : gdB.type === "percent" ? gdB.value + "%" : gdB.type === "target" ? "Target $" + gdB.value : "$" + gdB.value;
    var gdALabel = gdA.type === "none" || !gdA.type ? "None" : gdA.type === "percent" ? gdA.value + "%" : gdA.type === "target" ? "Target $" + gdA.value : "$" + gdA.value;
    changes.push({ cat: "Global Discount", detail: gdBLabel + " \u2192 " + gdALabel });
  }

  // Notes
  if ((before.notes || "") !== (after.notes || "")) {
    changes.push({ cat: "Notes", detail: "Updated" });
  }
  // Terms are CLIENT-facing, unlike notes, so the log says which way it moved
  // rather than just "updated" — reverting to the default is a real decision.
  if ((before.terms || "") !== (after.terms || "")) {
    changes.push({ cat: "Terms", detail:
      !(after.terms || "").trim() ? "Reset to the default terms"
      : !(before.terms || "").trim() ? "Customized for this quote"
      : "Edited" });
  }

  // Project / dates — compare effective dates (project dates when linked, custom when not)
  if (before.projectId !== after.projectId) {
    var bProj = before.projectId ? projects.find(function(p) { return p.id === before.projectId; }) : null;
    var aProj = after.projectId ? projects.find(function(p) { return p.id === after.projectId; }) : null;
    var bName = bProj ? bProj.name : (before.projectId ? "Project #" + before.projectId : "No project");
    var aName = aProj ? aProj.name : (after.projectId ? "Project #" + after.projectId : "Custom dates");
    changes.push({ cat: "Project", detail: bName + " → " + aName });
  }
  var bDates = effectiveDates(before);
  var aDates = effectiveDates(after);
  if (bDates.start !== aDates.start || bDates.end !== aDates.end) {
    var bRange = bDates.start ? (window.LTP_formatDate(bDates.start) + " — " + window.LTP_formatDate(bDates.end)) : "No dates";
    var aRange = aDates.start ? (window.LTP_formatDate(aDates.start) + " — " + window.LTP_formatDate(aDates.end)) : "No dates";
    changes.push({ cat: "Quote Dates", detail: bRange + " → " + aRange });
  }
  // Worth logging on its own: moving the expiry changes what the client was
  // promised, and on a sent quote that's a term the two sides have to agree on.
  if ((before.expiryDate || "") !== (after.expiryDate || "")) {
    var bExp = before.expiryDate ? window.LTP_formatDate(before.expiryDate) : "Default validity";
    var aExp = after.expiryDate ? window.LTP_formatDate(after.expiryDate) : "Default validity";
    changes.push({ cat: "Expires", detail: bExp + " → " + aExp });
  }

  // Section-level changes
  var bSecMap = {}; (before.sections || []).forEach(function(s) { bSecMap[s.id] = s; });
  var aSecMap = {}; (after.sections || []).forEach(function(s) { aSecMap[s.id] = s; });

  // Added sections
  (after.sections || []).forEach(function(s) {
    if (!bSecMap[s.id]) changes.push({ cat: "Section Added", detail: "\"" + s.label + "\"" });
  });
  // Removed sections
  (before.sections || []).forEach(function(s) {
    if (!aSecMap[s.id]) changes.push({ cat: "Section Removed", detail: "\"" + s.label + "\"" });
  });

  // Per-section diffs
  (after.sections || []).forEach(function(aSec) {
    var bSec = bSecMap[aSec.id];
    if (!bSec) return;

    // Label change
    if (bSec.label !== aSec.label) changes.push({ cat: "Section Renamed", detail: "\"" + bSec.label + "\" → \"" + aSec.label + "\"" });

    // Custom dates change
    if (bSec.customDates !== aSec.customDates || bSec.startDate !== aSec.startDate || bSec.endDate !== aSec.endDate) {
      if (aSec.customDates) {
        var secRange = aSec.startDate && aSec.endDate ? window.LTP_formatDate(aSec.startDate) + " \u2192 " + window.LTP_formatDate(aSec.endDate) : "Not set";
        var prevRange = bSec.customDates && bSec.startDate && bSec.endDate ? window.LTP_formatDate(bSec.startDate) + " \u2192 " + window.LTP_formatDate(bSec.endDate) : "Quote dates";
        changes.push({ cat: aSec.label + " Rental Period", detail: prevRange + " \u2192 " + secRange });
      } else if (bSec.customDates) {
        changes.push({ cat: aSec.label + " Rental Period", detail: "Reset to quote dates" });
      }
    }

    // Section subtotal
    var stB = 0, stA = 0;
    (bSec.items || []).forEach(function(i) { if (i.type !== "note") stB += ((i.adjustedPrice != null ? i.adjustedPrice : i.unitPrice) || 0) * (i.qty || 0); });
    (aSec.items || []).forEach(function(i) { if (i.type !== "note") stA += ((i.adjustedPrice != null ? i.adjustedPrice : i.unitPrice) || 0) * (i.qty || 0); });
    if (Math.round(stB * 100) !== Math.round(stA * 100)) {
      changes.push({ cat: aSec.label + " Subtotal", detail: "$" + window.LTP_money(stB) + " → $" + window.LTP_money(stA) });
    }

    // Item-level diffs
    var bItemMap = {}; (bSec.items || []).forEach(function(i) { bItemMap[i.id] = i; });
    var aItemMap = {}; (aSec.items || []).forEach(function(i) { aItemMap[i.id] = i; });

    (aSec.items || []).forEach(function(i) {
      // Notes are editable in place, so an edited note has to show up here —
      // otherwise a changed note reads as a silent edit on a sent quote.
      if (i.type === "note") {
        if (!bItemMap[i.id]) {
          changes.push({ cat: aSec.label + " — Note Added", detail: window.LTP_noteSummary(i.text) });
        } else if ((bItemMap[i.id].text || "") !== (i.text || "")) {
          changes.push({ cat: aSec.label + " — Note Edited", detail: window.LTP_noteSummary(bItemMap[i.id].text) + " → " + window.LTP_noteSummary(i.text) });
        }
        return;
      }
      if (!bItemMap[i.id]) {
        changes.push({ cat: aSec.label + " — Item Added", detail: i.name + " (×" + i.qty + ")" });
      } else if (bItemMap[i.id]) {
        var bi = bItemMap[i.id];
        // Pricing-variant switch → one explicit from → to entry carrying both
        // labels AND both prices. Without this, only the plain Price entry
        // fired — and it prints the NEW name on both sides, so what the line
        // changed FROM was invisible. The Price entry is suppressed for a
        // variant switch since this entry already carries the prices.
        var variantChanged = i.type === "product" &&
          ((bi.productVariantId || null) !== (i.productVariantId || null) || bi.name !== i.name);
        if (variantChanged) {
          changes.push({ cat: aSec.label + " — Variant", detail: bi.name + " ($" + bi.unitPrice + ") → " + i.name + " ($" + i.unitPrice + ")" });
        }
        if (bi.qty !== i.qty) changes.push({ cat: aSec.label + " — Qty", detail: i.name + ": " + bi.qty + " → " + i.qty });
        if (!variantChanged && bi.unitPrice !== i.unitPrice) changes.push({ cat: aSec.label + " — Price", detail: i.name + ": $" + bi.unitPrice + " → $" + i.unitPrice });
        if ((bi.adjustedPrice || null) !== (i.adjustedPrice || null)) {
          var adjB = bi.adjustedPrice != null ? "$" + bi.adjustedPrice : "$" + bi.unitPrice + " (base)";
          var adjA = i.adjustedPrice != null ? "$" + i.adjustedPrice : "$" + i.unitPrice + " (base)";
          changes.push({ cat: aSec.label + " — Adj. Price", detail: i.name + ": " + adjB + " \u2192 " + adjA });
        }
        var dB = Number(bi.deliveredQty) || 0, dA = Number(i.deliveredQty) || 0;
        if (dB !== dA) changes.push({ cat: aSec.label + " — Delivered", detail: i.name + ": " + dB + " \u2192 " + dA + " of " + (i.qty || 0) });
        var iB = Number(bi.invoicedQty) || 0, iA = Number(i.invoicedQty) || 0;
        if (iB !== iA) changes.push({ cat: aSec.label + " — Invoiced", detail: i.name + ": " + iB + " \u2192 " + iA + " of " + (i.qty || 0) });
      }
    });
    (bSec.items || []).forEach(function(i) {
      if (aItemMap[i.id]) return;
      if (i.type === "note") {
        changes.push({ cat: aSec.label + " — Note Removed", detail: window.LTP_noteSummary(i.text) });
      } else {
        changes.push({ cat: aSec.label + " — Item Removed", detail: i.name });
      }
    });
  });

  return changes.length > 0 ? changes : null;
};

window.LTP_invoiceChanges = function(before, after, projects, companies) {
  if (!before || !after) return null;
  var changes = [];
  var tB = window.LTP_INVOICE_TOTALS(before), tA = window.LTP_INVOICE_TOTALS(after);
  if (Math.round(tB.total * 100) !== Math.round(tA.total * 100)) changes.push({ cat: "Invoice Total", detail: "$" + window.LTP_money(tB.total) + " \u2192 $" + window.LTP_money(tA.total) });
  if (before.status !== after.status) changes.push({ cat: "Status", detail: (before.status || "draft") + " \u2192 " + (after.status || "draft") });
  if (before.dueDate !== after.dueDate) {
    var dbf = before.dueDate ? window.LTP_formatDate(before.dueDate) : "Not set";
    var daf = after.dueDate ? window.LTP_formatDate(after.dueDate) : "Not set";
    changes.push({ cat: "Due Date", detail: dbf + " \u2192 " + daf });
  }
  if (before.invoiceDate !== after.invoiceDate) {
    var ibf = before.invoiceDate ? window.LTP_formatDate(before.invoiceDate) : "Not set";
    var iaf = after.invoiceDate ? window.LTP_formatDate(after.invoiceDate) : "Not set";
    changes.push({ cat: "Invoice Date", detail: ibf + " \u2192 " + iaf });
  }
  if (before.companyId !== after.companyId) {
    var cBefore = window.LTP_diffEntityName(companies, before.companyId);
    var cAfter = window.LTP_diffEntityName(companies, after.companyId);
    changes.push({ cat: "Company", detail: cBefore + " \u2192 " + cAfter });
  }
  if (before.projectId !== after.projectId) {
    var pBefore = window.LTP_diffEntityName(projects, before.projectId);
    var pAfter = window.LTP_diffEntityName(projects, after.projectId);
    changes.push({ cat: "Project", detail: pBefore + " \u2192 " + pAfter });
  }
  if (before.clientType !== after.clientType) changes.push({ cat: "Client Type", detail: (before.clientType || "company") + " \u2192 " + (after.clientType || "company") });
  var gdB = before.globalDiscount || {}, gdA = after.globalDiscount || {};
  if (gdB.type !== gdA.type || gdB.value !== gdA.value) {
    var gdBLabel = gdB.type === "none" ? "None" : gdB.type === "percent" ? gdB.value + "%" : gdB.type === "target" ? "Target $" + gdB.value : "$" + gdB.value;
    var gdALabel = gdA.type === "none" ? "None" : gdA.type === "percent" ? gdA.value + "%" : gdA.type === "target" ? "Target $" + gdA.value : "$" + gdA.value;
    changes.push({ cat: "Discount", detail: gdBLabel + " \u2192 " + gdALabel });
  }
  if (before.notes !== after.notes) changes.push({ cat: "Notes", detail: "Updated" });
  // Terms are CLIENT-facing, unlike notes, so the log says which way it
  // moved rather than just "updated" — reverting to the default is a real
  // decision, not a typo fix.
  if ((before.terms || "") !== (after.terms || "")) {
    changes.push({ cat: "Terms", detail:
      !(after.terms || "").trim() ? "Reset to the default terms"
      : !(before.terms || "").trim() ? "Customized for this invoice"
      : "Edited" });
  }
  // Section/item level
  var bSecMap = {}; (before.sections || []).forEach(function(s) { bSecMap[s.id] = s; });
  (after.sections || []).forEach(function(aSec) {
    if (!bSecMap[aSec.id]) { changes.push({ cat: "Section Added", detail: "\"" + aSec.label + "\"" }); return; }
    var bSec = bSecMap[aSec.id];
    if (bSec.label !== aSec.label) changes.push({ cat: "Section Renamed", detail: "\"" + bSec.label + "\" \u2192 \"" + aSec.label + "\"" });
    var bItemMap = {}; (bSec.items || []).forEach(function(i) { bItemMap[i.id] = i; });
    (aSec.items || []).forEach(function(i) {
      // Notes are editable in place, so an edited note has to show up here \u2014
      // otherwise a changed note reads as a silent edit on a sent invoice.
      if (i.type === "note") {
        if (!bItemMap[i.id]) {
          changes.push({ cat: aSec.label + " \u2014 Note Added", detail: window.LTP_noteSummary(i.text) });
        } else if ((bItemMap[i.id].text || "") !== (i.text || "")) {
          changes.push({ cat: aSec.label + " \u2014 Note Edited", detail: window.LTP_noteSummary(bItemMap[i.id].text) + " \u2192 " + window.LTP_noteSummary(i.text) });
        }
        return;
      }
      if (!bItemMap[i.id]) { changes.push({ cat: aSec.label + " \u2014 Added", detail: i.name + " \u00d7" + i.qty }); return; }
      var bi = bItemMap[i.id];
      // Pricing-variant switch \u2192 explicit from \u2192 to entry with both labels
      // and prices; the plain Price entry (new name on both sides) hid what
      // the line changed FROM, so it's suppressed for variant switches.
      var variantChanged = i.type === "product" &&
        ((bi.productVariantId || null) !== (i.productVariantId || null) || bi.name !== i.name);
      if (variantChanged) {
        changes.push({ cat: aSec.label + " \u2014 Variant", detail: bi.name + " ($" + bi.unitPrice + ") \u2192 " + i.name + " ($" + i.unitPrice + ")" });
      }
      if (bi.qty !== i.qty) changes.push({ cat: aSec.label + " \u2014 Qty", detail: i.name + ": " + bi.qty + " \u2192 " + i.qty });
      if (!variantChanged && bi.unitPrice !== i.unitPrice) changes.push({ cat: aSec.label + " \u2014 Price", detail: i.name + ": $" + bi.unitPrice + " \u2192 $" + i.unitPrice });
      if ((bi.adjustedPrice || null) !== (i.adjustedPrice || null)) {
        changes.push({ cat: aSec.label + " \u2014 Adj.", detail: i.name + ": " + (bi.adjustedPrice != null ? "$" + bi.adjustedPrice : "$" + bi.unitPrice + " (base)") + " \u2192 " + (i.adjustedPrice != null ? "$" + i.adjustedPrice : "$" + i.unitPrice + " (base)") });
      }
    });
    (bSec.items || []).forEach(function(i) {
      if ((aSec.items || []).find(function(ai) { return ai.id === i.id; })) return;
      changes.push(i.type === "note"
        ? { cat: aSec.label + " \u2014 Note Removed", detail: window.LTP_noteSummary(i.text) }
        : { cat: aSec.label + " \u2014 Removed", detail: i.name });
    });
  });
  (before.sections || []).forEach(function(s) { if (!(after.sections || []).find(function(as) { return as.id === s.id; })) changes.push({ cat: "Section Removed", detail: "\"" + s.label + "\"" }); });
  return changes.length > 0 ? changes : null;
};

window.LTP_sectionTotals = function(sec) {
  var subtotal = 0, cost = 0;
  ((sec && sec.items) || []).forEach(function(it) {
    if (it.type === "note") return;
    var qty = Number(it.qty) || 0;
    var eff = it.adjustedPrice != null ? (Number(it.adjustedPrice) || 0) : (Number(it.unitPrice) || 0);
    subtotal += eff * qty;
    cost += (Number(it.cost) || 0) * qty;
  });
  return { subtotal: subtotal, cost: cost, margin: subtotal - cost };
};

window.LTP_QUOTE_TOTALS = function(q) {
  var subtotal = 0, adjusted = 0, cost = 0;
  (q.sections || []).forEach(function(sec) {
    (sec.items || []).forEach(function(it) {
      if (it.type === "note") return;
      var qty = Number(it.qty) || 0;
      var orig = (Number(it.unitPrice) || 0) * qty;
      var adj  = it.adjustedPrice != null ? (Number(it.adjustedPrice) || 0) * qty : orig;
      subtotal += orig;
      adjusted += adj;
      cost     += (Number(it.cost) || 0) * qty;
    });
  });
  var afterDiscount = adjusted;
  var gd = q.globalDiscount || { type: "none", value: 0 };
  // "amount" is the fixed-dollar discount; "flat" is the legacy alias accepted
  // by every reader (see LTP_INVOICE_TOTALS above). Quotes have only ever
  // written "amount", but accepting both here keeps the two totals functions
  // literally interchangeable, which is the property that broke last time.
  if (gd.type === "percent") afterDiscount = adjusted * (1 - (Number(gd.value) || 0) / 100);
  else if (gd.type === "amount" || gd.type === "flat") afterDiscount = adjusted - (Number(gd.value) || 0);
  else if (gd.type === "target") afterDiscount = Number(gd.value) || 0;
  if (afterDiscount < 0) afterDiscount = 0;
  // Tax is QuickBooks-authoritative: a quote's tax comes from a temporary QB
  // estimate (backend/qbo_sync.py::get_quote_estimate_tax), stored read-only as
  // qbTaxTotal. Null until calculated → $0, exactly like invoices + the client
  // view. There is no flat-rate fallback anywhere — QuickBooks owns the number.
  var tax = (q.qbTaxTotal != null) ? (Number(q.qbTaxTotal) || 0) : 0;
  return { subtotal: subtotal, adjusted: adjusted, total: afterDiscount + tax, preTax: afterDiscount, tax: tax, taxAmount: tax, cost: cost };
};

window.LTP_QUOTE_REF = function(q) {
  var year = (q.createdDate || "").substring(0, 4) || String(new Date().getFullYear());
  return "Q-" + year + "-" + String(q.id).padStart(3, "0");
};

// ── Multi-project quotes & invoices ─────────────────────────────────────────
// A quote or invoice can gather work from more than one project: a schedule
// sends its labor into any of the client's existing DRAFT documents, whatever
// project that document started on.
//
// The scalar `projectId` survives as the PRIMARY project and keeps its old
// meaning everywhere it's already read — the PDF title (pdf_generator.py), the
// QuickBooks CustomerMemo (qbo_sync.py), the push-notification label
// (routes/_shared.py::doc_display_name), the project-delete wizard
// (modules/projects.js) and the CRM project's Quotes tab. `projectIds` is the
// full contributing set, primary first, and is what the "Includes" line on the
// document renders from.
//
// Rows written before this existed have no `projectIds` at all, so EVERY read
// goes through LTP_docProjectIds rather than touching the field directly.
window.LTP_docProjectIds = function(entity) {
  if (!entity) return [];
  var out = [], seen = {};
  function push(id) {
    if (id == null || id === "") return;
    var k = String(id);
    if (seen[k]) return;
    seen[k] = true;
    out.push(id);
  }
  push(entity.projectId);
  if (Array.isArray(entity.projectIds)) entity.projectIds.forEach(push);
  return out;
};

// The { projectId, projectIds } patch that records `projectId` as a contributor
// to `entity`. The primary is never rewritten when the document already has one
// — a quote the client has seen doesn't rename itself because a second job was
// added to it — and is adopted when it doesn't. Idempotent: linking a project
// that's already there just normalizes a legacy row's list.
window.LTP_linkDocProject = function(entity, projectId) {
  var ids = window.LTP_docProjectIds(entity);
  if (projectId != null && !ids.some(function(id) { return String(id) === String(projectId); })) {
    ids = ids.concat([projectId]);
  }
  var primary = (entity && entity.projectId != null) ? entity.projectId : (ids.length ? ids[0] : null);
  return { projectId: primary, projectIds: ids };
};

// Display names for a document's contributing projects, primary first. A
// project that's since been deleted (FKs are ON DELETE SET NULL, but the id can
// still sit in the list) degrades to "Project <id>" rather than vanishing —
// silently dropping it would understate what the document covers.
window.LTP_docProjectNames = function(entity, projects) {
  return window.LTP_docProjectIds(entity).map(function(id) {
    var p = (projects || []).find(function(x) { return x.id === id; });
    return (p && p.name) ? p.name : ("Project " + id);
  });
};

// Does this quote/invoice bill work for `projectId`? True for the PRIMARY
// project and for every other contributor equally — a document that gathered a
// second job's schedule belongs on that job's page too, which is the whole
// point of the contributor list. Every "this project's quotes/invoices" filter
// goes through here rather than comparing `.projectId` directly.
window.LTP_docHasProject = function(entity, projectId) {
  if (projectId == null) return false;
  return window.LTP_docProjectIds(entity).some(function(id) { return String(id) === String(projectId); });
};

// Note for a project's money figures when some of the documents behind them are
// shared with other jobs. Each project counts a shared document's FULL total —
// so its own page reads correctly in isolation — which means summing across
// projects would over-count. This is the sentence that says so out loud, naming
// the other jobs involved. Returns null when nothing is shared, i.e. for the
// overwhelmingly common single-project case.
//
//   docs      the quotes (or invoices) already filtered to this project
//   projects  the full project list, for name resolution
window.LTP_sharedDocNote = function(project, docs, projects) {
  if (!project) return null;
  var otherIds = [], seen = {}, shared = 0;
  (docs || []).forEach(function(d) {
    var ids = window.LTP_docProjectIds(d);
    if (ids.length < 2) return;
    shared++;
    ids.forEach(function(id) {
      if (String(id) === String(project.id) || seen[String(id)]) return;
      seen[String(id)] = true;
      otherIds.push(id);
    });
  });
  if (!shared) return null;
  var names = otherIds.map(function(id) {
    var p = (projects || []).find(function(x) { return x.id === id; });
    return (p && p.name) ? p.name : ("Project " + id);
  });
  var withWhom = names.length <= 2
    ? names.join(" and ")
    : names.slice(0, 2).join(", ") + " and " + (names.length - 2) + " more";
  return "Includes " + shared + " combined with " + withWhom + " — counted in full here and there.";
};

// Label for a section appended to an existing document. The project name goes
// in the LABEL specifically because `label` is one of the few section fields
// that survives the public-view scrub (backend/routes/_shared.py::
// public_section_items) — so the client sees which job each block of work
// belongs to without us widening that whitelist.
window.LTP_projectSectionLabel = function(baseLabel, projectName) {
  var base = String(baseLabel == null ? "" : baseLabel).trim() || "Items";
  var proj = String(projectName == null ? "" : projectName).trim();
  if (!proj) return base;
  if (base.toLowerCase().indexOf(proj.toLowerCase()) !== -1) return base;  // don't double-stamp
  return base + " — " + proj;
};

// Per-section date override for work appended from a DIFFERENT job.
//
// A document's rental window comes from its primary project (or its custom
// dates when it has none), and equipment lines price off that window. A second
// job almost always runs on other dates, so its sections carry their own —
// sections already support `customDates` + startDate/endDate, and both the
// builder's repricing and the PDF's "Rental Period" honor them, so this needs
// no new machinery.
//
// Returns the {customDates, startDate, endDate} patch to merge into each
// appended section, or null when nothing needs overriding: the work belongs to
// the document's own primary project, the project has no dates, or its dates
// already match the document's window.
window.LTP_sectionDateStamp = function(doc, project, projects) {
  if (!project || !project.startDate || !project.endDate) return null;
  var ids = window.LTP_docProjectIds(doc);
  var primaryId = ids.length ? ids[0] : (doc && doc.projectId != null ? doc.projectId : null);
  // Sections for the document's own primary job inherit the document window.
  if (primaryId != null && String(primaryId) === String(project.id)) return null;
  var prim = primaryId != null ? (projects || []).find(function(p) { return p.id === primaryId; }) : null;
  var start = prim ? (prim.startDate || "") : ((doc && doc.customStartDate) || "");
  var end   = prim ? (prim.endDate   || "") : ((doc && doc.customEndDate)   || "");
  if (start === project.startDate && end === project.endDate) return null;
  return { customDates: true, startDate: project.startDate, endDate: project.endDate };
};

// Append sections to a document WITHOUT touching what's already in it.
// Deliberately NOT a merge-by-label: pooling a second job's "Labor" into the
// first job's "Labor" section destroys exactly the per-project provenance a
// multi-project document exists to record, and silently edits a section the
// user already arranged. Section and item ids are regenerated on collision so
// lines copied out of one document can never clobber the target's own.
window.LTP_appendDocSections = function(existing, incoming, genId) {
  var gen = genId || window.LTP_genId;
  var used = {};
  (existing || []).forEach(function(sec) {
    if (sec && sec.id != null) used[sec.id] = true;
    (sec && sec.items || []).forEach(function(it) { if (it && it.id != null) used[it.id] = true; });
  });
  var added = (incoming || []).map(function(sec) {
    var secId = sec.id;
    while (secId == null || used[secId]) secId = gen("sec");
    used[secId] = true;
    return Object.assign({}, sec, {
      id: secId,
      items: (sec.items || []).map(function(it) {
        var itId = it.id;
        while (itId == null || used[itId]) itId = gen("item");
        used[itId] = true;
        return Object.assign({}, it, { id: itId });
      })
    });
  });
  return (existing || []).concat(added);
};

// Fee quick-pick names — the one-tap "custom fee" name suggestions in the
// quote/invoice Add-Item → Fees tab. Sourced from settings.feeQuickNames
// (editable in Quotes → Fees), falling back to a sensible default only when the
// setting is absent. Returns a normalized list: trimmed, non-empty, and
// de-duplicated case-insensitively, with authored order preserved. An
// explicitly-empty list stays empty (the user removed every quick-pick).
window.LTP_FEE_QUICKNAMES_DEFAULT = ["Lodging", "Meal Expenses", "Travel", "Consultation", "Project Prep"];
window.LTP_feeQuickNames = function(settings) {
  var raw = settings && settings.feeQuickNames;
  if (!Array.isArray(raw)) raw = window.LTP_FEE_QUICKNAMES_DEFAULT;
  var seen = {}, out = [];
  raw.forEach(function(n) {
    var s = (n == null ? "" : String(n)).trim();
    if (!s) return;
    var k = s.toLowerCase();
    if (seen[k]) return;
    seen[k] = true;
    out.push(s);
  });
  return out;
};

// Gather activity entries of a given fault type across invoices and quotes for
// the Settings Error Log. Backend paths stamp typed activity entries on their
// entity — `email_failed` (auto-receipt poller + manual sends) and
// `qbo_sync_failed` (invoice → QuickBooks push) — and this one reducer surfaces
// any of them. Returns display-ready rows { id, date, time, message,
// errorDetail, context } sorted newest-first. Pure (no DOM/React) so the Error
// Log logic is unit-tested.
window.LTP_collectActivityFaults = function(invoices, quotes, activityType) {
  var faults = [];
  function errorDetail(a) {
    var ch = (a.changes || []).filter(function(c) { return c && c.cat === "Error"; })[0];
    return ch ? String(ch.detail || "") : "";
  }
  function gather(list, refFn, prefix) {
    (list || []).forEach(function(ent) {
      (ent.activity || []).forEach(function(a) {
        if (a && a.type === activityType) {
          faults.push({
            id: a.id,
            date: a.date || "",
            time: a.time || "",
            message: a.message || "",
            errorDetail: errorDetail(a),
            context: refFn ? refFn(ent) : (prefix + (ent.id != null ? ent.id : "?")),
          });
        }
      });
    });
  }
  gather(invoices, window.LTP_INVOICE_REF, "INV-");
  gather(quotes, window.LTP_QUOTE_REF, "Q-");
  faults.sort(function(a, b) {
    return ((b.date || "") + (b.time || "")) > ((a.date || "") + (a.time || "")) ? 1 : -1;
  });
  return faults;
};

// Failed email sends (auto-receipt poller + manual quote/invoice sends).
window.LTP_collectEmailFaults = function(invoices, quotes) {
  return window.LTP_collectActivityFaults(invoices, quotes, "email_failed").map(function(f) {
    if (!f.message) f.message = "Email failed";
    return f;
  });
};

// Failed invoice → QuickBooks pushes. Connection-level QuickBooks errors from
// background contexts (the poller) aren't entity-stamped; they arrive via
// /api/qbo/status (status.lastError) and are shown alongside these in Settings.
window.LTP_collectQboFaults = function(invoices, quotes) {
  return window.LTP_collectActivityFaults(invoices, quotes, "qbo_sync_failed").map(function(f) {
    if (!f.message) f.message = "QuickBooks sync failed";
    return f;
  });
};

// A project's headline money figure. The budget entered on the project form is
// preliminary — once real quotes exist for the project they supersede it, and
// every surface that shows "the project's number" should show the quoted total
// instead. Declined quotes don't count; if every quote is declined the
// preliminary budget applies again. Returns { quoted, total, count }:
// quoted=true means `total` is the sum of the live quotes' totals (and `count`
// how many), quoted=false means `total` is the preliminary budget sum.
window.LTP_projectHeadlineTotal = function(project, quotes) {
  // Any quote this project contributes to, not just ones it's primary on — a
  // quote that absorbed this job's schedule bills this job's work and belongs
  // in its headline. A quote shared with another project counts its FULL total
  // on both; LTP_sharedDocNote is what tells the reader that's happening.
  var live = (quotes || []).filter(function(q) {
    return q && window.LTP_docHasProject(q, project.id) && q.status !== "declined";
  });
  if (live.length === 0) {
    var budget = project.budget || {};
    var tot = Object.keys(budget).reduce(function(a, k) { return a + (Number(budget[k]) || 0); }, 0);
    return { quoted: false, total: tot, count: 0 };
  }
  var sum = live.reduce(function(a, q) { return a + (window.LTP_QUOTE_TOTALS(q).total || 0); }, 0);
  return { quoted: true, total: sum, count: live.length };
};
