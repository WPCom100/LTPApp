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
