// LTP domain — per-client service rates (negotiated contract rates + day
// minimums) and product variants.
//
// Split out of theme.js. The whole client-rate feature resolves at ONE seam:
// LTP_servicesForClient folds a client's overrides into the base rate card, and
// every consumer downstream reads the resolved card. Keeping that seam in its
// own file is the point of the split.
//
// KEEP TOGETHER: _crNum is the numeric coercion behind LTP_applyClientRate.
// Like the other file-scope helpers in this layer it is currently a global (see
// the note in domain-labor.js), so separating them would still run — but it
// would break the day a file gets IIFE-wrapped, and it reads as private.
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


// ── Per-client service rates (negotiated contract rates + day minimums) ─────
//
// A client can negotiate a different rate for SPECIFIC roles — "A1 for FUMC is
// a reduced day rate, but carries a full 10-hour day minimum". Those overrides
// live one row per (client, service) in the `clientRates` entity
// (backend/models.py::ClientRate); a role with no row bills the base card
// exactly as before.
//
// The whole feature resolves at ONE seam: LTP_servicesForClient folds a client's
// overrides into the rate card, and every downstream consumer (the labor engine,
// LTP_serviceRateMaps, the quote/invoice pickers, the schedule editor) keeps
// taking a plain `services` array and needs no client awareness at all.
//
// A resolved service carries two extra fields the base card doesn't have:
//   minHours / minCostHours — minimum billable / payable hours for a day (see
//     LTP_calcDayLabor, the only place they're interpreted)
//   clientRate — { id, label, notes } marking it as overridden (UI badges)

// Normalize any client-bearing entity (quote, invoice, or project) to the
// { clientType, companyId, clientContactId } shape the lookups key on. Returns
// null when there's no client to match — an unassigned quote or an internal
// project bills base rates.
window.LTP_clientRef = function(entity) {
  if (!entity) return null;
  if (entity.clientType === "contact") {
    return entity.clientContactId != null
      ? { clientType: "contact", companyId: null, clientContactId: entity.clientContactId } : null;
  }
  // Everything else (including a project, which is always billed to its company)
  // keys on companyId.
  return entity.companyId != null
    ? { clientType: "company", companyId: entity.companyId, clientContactId: null } : null;
};

// Does this override row belong to `ref`'s client? Inactive rows never match.
window.LTP_clientRateMatches = function(row, ref) {
  if (!row || !ref || row.active === false) return false;
  if (ref.clientType === "contact") {
    return row.clientType === "contact" && row.clientContactId != null
      && row.clientContactId === ref.clientContactId;
  }
  return row.clientType !== "contact" && row.companyId != null && row.companyId === ref.companyId;
};

// { [serviceId]: row } for one client. Later rows win, so a duplicate created by
// two tabs resolves deterministically instead of applying twice.
window.LTP_clientRateMap = function(clientRates, ref) {
  var out = {};
  if (!ref) return out;
  (clientRates || []).forEach(function(r) {
    if (window.LTP_clientRateMatches(r, ref) && r.serviceId != null) out[r.serviceId] = r;
  });
  return out;
};

// A finite, non-negative number, else null. "" / null / undefined / NaN all mean
// "not set" → inherit. 0 is a REAL value (a genuinely free tier).
function _crNum(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  return (isFinite(n) && n >= 0) ? n : null;
}

// Fold ONE override row into ONE service, returning a new resolved service.
//
// Derived-tier rule: the base card stores 0 for a tier that should derive from
// the day rate (LTP_serviceRateMaps reads `svc.halfDay || svc.dayRate * 0.5`).
// So when a contract restates the DAY rate but not the half/hourly/OT tier, the
// tier must derive from the NEW day rate — inheriting the base card's absolute
// half-day next to a discounted day rate would price the contract wrong. Passing
// 0 through re-triggers that derivation. A tier the contract DOES restate is
// used verbatim on both sides.
window.LTP_applyClientRate = function(svc, row) {
  if (!svc || !row) return svc;
  var out = Object.assign({}, svc);
  var dayR = _crNum(row.dayRate), dayC = _crNum(row.dayCost);
  function tier(key, ovr, dayOverridden) {
    var v = _crNum(ovr);
    if (v !== null) out[key] = v;
    else if (dayOverridden) out[key] = 0;   // 0 = derive from the new day rate
  }
  if (dayR !== null) out.dayRate = dayR;
  tier("halfDay",    row.halfDay,    dayR !== null);
  tier("hourlyRate", row.hourlyRate, dayR !== null);
  tier("otRate",     row.otRate,     dayR !== null);
  if (dayC !== null) out.dayCost = dayC;
  tier("halfDayCost", row.halfDayCost, dayC !== null);
  tier("hourlyCost",  row.hourlyCost,  dayC !== null);
  tier("otCost",      row.otCost,      dayC !== null);
  out.minHours     = _crNum(row.minHours) || 0;
  out.minCostHours = _crNum(row.minCostHours) || 0;
  out.clientRate = { id: row.id, label: row.label || "", notes: row.notes || "" };
  return out;
};

// The rate card AS THIS CLIENT SEES IT — base services with their overrides
// folded in. Returns the SAME array reference when nothing applies, so callers
// memoizing on identity don't re-render for clients with no negotiated rates.
window.LTP_servicesForClient = function(services, clientRates, ref) {
  var list = services || [];
  if (!ref || !clientRates || !clientRates.length) return list;
  var byService = window.LTP_clientRateMap(clientRates, ref);
  var hit = false;
  var out = list.map(function(s) {
    var row = s && byService[s.id];
    if (!row) return s;
    hit = true;
    return window.LTP_applyClientRate(s, row);
  });
  return hit ? out : list;
};

// ── Role ordering ────────────────────────────────────────────────────────────
// One comparator for every role/position list in the app — the schedule
// editor's and flat-rate panel's role pickers, the manual-shift and
// client-rate pickers, the quote/invoice item pickers, the roster's role tags —
// so "L1, L2, L10, LD, PM, SM, SPOT" reads the same everywhere. Natural order:
// a number inside a code compares as a number (L2 before L10), case is ignored.
window.LTP_compareRoleCodes = function(a, b) {
  return String(a == null ? "" : a).trim().localeCompare(String(b == null ? "" : b).trim(), "en", { numeric: true, sensitivity: "base" });
};
window.LTP_compareServices = function(a, b) {
  return window.LTP_compareRoleCodes(a && a.role, b && b.role)
    || String((a && a.description) || "").localeCompare(String((b && b.description) || ""), "en", { sensitivity: "base" })
    || (((a && a.id) || 0) - ((b && b.id) || 0));
};
window.LTP_sortServices = function(list) {
  return (list || []).slice().sort(window.LTP_compareServices);
};

// Position groups for a billed schedule (Send to Quote / Send to Invoice, in
// window.LTP_scheduleLaborSections): roles that are letters only (PM, SPOT, LD,
// SM) come first, then letter+number roles (L1, L2, L3 …), then anything else
// (a code with punctuation or spaces); alphabetical within each group.
window.LTP_roleGroup = function(role) {
  var r = String(role == null ? "" : role).trim();
  if (/^[A-Za-z]+$/.test(r)) return 0;
  if (/^[A-Za-z]+\d+$/.test(r)) return 1;
  return 2;
};
window.LTP_compareRoleGroups = function(a, b) {
  return (window.LTP_roleGroup(a) - window.LTP_roleGroup(b)) || window.LTP_compareRoleCodes(a, b);
};

// Service line rate maps. Given a service's rate card, returns { priceMap,
// costMap } keyed by rate type (day/half/hourly/ot). Half/hourly/OT fall back
// to derived ratios (×0.5, ÷10, ÷10×1.5) when not explicitly set. Single
// source of truth shared by the quote builder and invoice editor so a rate-type
// switch prices identically in both and converted invoices never drift.
window.LTP_serviceRateMaps = function(svc) {
  svc = svc || {};
  return {
    priceMap: { day: svc.dayRate, half: svc.halfDay || svc.dayRate * 0.5, hourly: svc.hourlyRate || svc.dayRate / 10, ot: svc.otRate || svc.dayRate / 10 * 1.5 },
    costMap:  { day: svc.dayCost, half: svc.halfDayCost || svc.dayCost * 0.5, hourly: svc.hourlyCost || svc.dayCost / 10, ot: svc.otCost || svc.dayCost / 10 * 1.5 },
  };
};

// Product pricing variants — alternative pricing structures for ONE product
// (e.g. Transportation: Local Delivery flat / Per Mile / Client Goods), stored
// as product.variants: [{id, label, unitPrice, cost}]. Every variant maps to
// the product's single QB item (the variant label rides in the line name), so
// QuickBooks sync is untouched. These helpers are the single source of truth
// shared by the quote builder, invoice editor, and the Products catalog so a
// variant prices identically everywhere. A product with no usable variants
// prices from its base unitPrice/cost exactly as before variants existed.
window.LTP_productVariants = function(product) {
  var raw = (product && Array.isArray(product.variants)) ? product.variants : [];
  var out = [];
  raw.forEach(function(v) {
    if (!v || !String(v.label == null ? "" : v.label).trim()) return; // unlabeled rows are editor noise
    out.push({
      id: v.id != null ? String(v.id) : "",
      label: String(v.label).trim(),
      unitPrice: Number(v.unitPrice) || 0,
      cost: Number(v.cost) || 0,
    });
  });
  return out;
};

window.LTP_findProductVariant = function(product, variantId) {
  if (variantId == null || variantId === "") return null;
  var list = window.LTP_productVariants(product);
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === String(variantId)) return list[i];
  }
  return null;
};

// Line-item display name for a product (+ chosen variant). The variant label
// is baked into the name so it survives snapshots, prints on quotes/invoices,
// and flows to the QuickBooks line description with zero sync changes.
window.LTP_productVariantName = function(product, variant) {
  var base = (product && product.name) || "";
  return variant ? base + " — " + variant.label : base;
};
