// ═══════════════════════════════════════════════════════════════════════════
//   INVOICES MODULE — List + Full Builder
// ═══════════════════════════════════════════════════════════════════════════
(function() {
  "use strict";
  var h = React.createElement, B = window.LTP_THEME;
  var useState = React.useState, useRef = React.useRef, useMemo = React.useMemo, useEffect = React.useEffect;
  var nav = window.LTPRouter.navigate;
  var fmt = window.LTP_formatDate;
  // Pure section/line-item transforms, shared with modules/quotes-builder.js.
  // See components/domain-docs.js — every invoice-specific rule (draft-only
  // edits, linkedQty clamping, rollback bookkeeping, the last-section guard)
  // stays in this file.
  var S = window.LTP_SECTIONS;
  var genId = window.LTP_genId;
  var todayISO = window.LTP_todayISO;
  var FEE_COLOR = "#B794F6";  // "FEE" line/badge accent (matches the quote builder)

  function net30(fromDate) {
    var d = new Date(fromDate || Date.now());
    d.setDate(d.getDate() + (window.LTP_DEFAULT_TERMS || 30));
    return d.toISOString().substring(0, 10);
  }

  // Exact currency (to the cent) — used for QuickBooks-computed sales tax and
  // tax-inclusive totals, which must NOT be rounded to whole dollars.
  function money2(n) {
    return "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // QuickBooks change-signature: a compact fingerprint of everything that maps
  // into the QB invoice (lines, dates, discount, recall state, taxability,
  // customer info, project name). An invoice is "in sync" iff this matches the
  // signature stored at the last successful push (invoice.qbSyncedSignature).
  // MUST stay aligned with backend/qbo_sync.build_invoice_payload — if a new
  // field starts affecting the QB invoice, add it here so edits surface the
  // "Update QuickBooks" button.
  function qbHash(s) {
    var h1 = 5381, h2 = 52711, i = s.length;
    while (i--) { var c = s.charCodeAt(i); h1 = (h1 * 33) ^ c; h2 = (h2 * 33) ^ c; }
    return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + "-" + s.length;
  }
  function qbSignature(inv, customer, project, customerTaxable) {
    if (!inv) return "";
    var gd = inv.globalDiscount || {};
    var parts = [
      inv.invoiceDate || "", inv.dueDate || "", inv.notes || "",
      gd.type || "none", String(gd.value || 0),
      (inv.status === "draft" && inv.sentDate) ? "recalled" : "",
      // The QB CustomerMemo carries the project name, or the customName when
      // there's no project (see qbo_sync build_invoice_payload) — so a rename of
      // either must surface the "Update QuickBooks" button.
      project ? (project.name || "") : (inv.customName || ""),
      String(!!customerTaxable)
    ];
    (inv.sections || []).forEach(function(sec) {
      (sec.items || []).forEach(function(it) {
        if (it.type === "note") { parts.push("n:" + (it.text || "")); return; }
        var price = it.adjustedPrice != null ? it.adjustedPrice : (it.unitPrice || 0);
        parts.push([it.type, it.name || "", it.qty || 0, price,
                    (typeof it.taxable === "boolean" ? it.taxable : "")].join("|"));
      });
    });
    if (customer) {
      parts.push(customer.name || ((customer.firstName || "") + " " + (customer.lastName || "")).trim());
      parts.push(customer.address || "", customer.city || "", customer.state || "", customer.zip || "");
      parts.push(customer.email || "", customer.phone || "");
    }
    return qbHash(parts.join(""));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   INVOICE LIST
  // ═══════════════════════════════════════════════════════════════════════════
  function InvoiceList({ invoices, companies, contacts, projects, quotes }) {
    var isMobile = window.LTP_useIsMobile();
    var [filter, setFilter] = useState("all");
    var [search, setSearch] = useState("");
    var [sortMode, setSortMode] = useState("date-desc");
    var [hidePaid, setHidePaid] = useState(false);
    var statuses = ["all", "draft", "sent", "partial", "paid", "overdue"];
    var sorts = [{ k: "date-desc", l: "Newest" }, { k: "date-asc", l: "Oldest" }, { k: "ref", l: "Ref #" }];

    // The primary contact on the invoice, shown next to the company name.
    function contactName(inv) {
      var c = (contacts || []).find(function(x) { return x.id === inv.clientContactId; });
      return c ? (c.firstName + " " + c.lastName).trim() : null;
    }
    function invDate(inv) { return inv.invoiceDate || inv.createdDate || ""; }

    var filtered = invoices.filter(function(inv) {
      // "Hide Paid" (off by default) drops fully-paid invoices from the list.
      if (hidePaid && window.LTP_displayStatus(inv) === "paid") return false;
      if (filter !== "all") {
        var ds = window.LTP_displayStatus(inv);
        if (filter === "overdue") { if (ds !== "overdue") return false; }
        else if (filter !== inv.status) return false;
      }
      if (search) {
        var q = search.toLowerCase();
        var ref = window.LTP_INVOICE_REF(inv).toLowerCase();
        var comp = inv.companyId ? ((companies.find(function(c) { return c.id === inv.companyId; }) || {}).name || "") : "";
        // A project-less invoice is named by its customName — search that too,
        // so it's findable by the same label it shows in the row.
        var proj = inv.projectId ? ((projects.find(function(p) { return p.id === inv.projectId; }) || {}).name || "") : (inv.customName || "");
        if ((ref + " " + comp + " " + proj).toLowerCase().indexOf(q) === -1) return false;
      }
      return true;
    }).sort(function(a, b) {
      if (sortMode === "date-asc")  return invDate(a) > invDate(b) ? 1 : -1;
      if (sortMode === "date-desc") return invDate(b) > invDate(a) ? 1 : -1;
      return window.LTP_INVOICE_REF(a).localeCompare(window.LTP_INVOICE_REF(b));
    });

    var totalPaid = invoices.filter(function(i) { return i.status === "paid"; }).reduce(function(s, i) { return s + (window.LTP_INVOICE_TOTALS(i).total || 0); }, 0);
    var totalPending = invoices.filter(function(i) { return i.status === "sent" || i.status === "partial"; }).reduce(function(s, i) { return s + (window.LTP_INVOICE_TOTALS(i).balance || 0); }, 0);
    var totalOverdue = invoices.filter(function(i) { return window.LTP_isOverdue(i); }).reduce(function(s, i) { return s + (window.LTP_INVOICE_TOTALS(i).balance || 0); }, 0);

    // "Hide Paid" toggle — rides the right of the filter row, mirroring the
    // Projects "Show Completed" / Quotes "Show Converted" controls.
    var hidePaidBtn = h("button", { onClick: function() { setHidePaid(!hidePaid); }, className: "ltp-tap",
      style: { flexShrink: 0, background: hidePaid ? B.accent : B.raised, color: hidePaid ? B.btnInk : B.textMut, border: "1px solid " + (hidePaid ? B.accent : B.border), borderRadius: isMobile ? "16px" : "4px", padding: isMobile ? "8px 14px" : "4px 12px", fontSize: isMobile ? "12px" : "11px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", minHeight: isMobile ? 36 : undefined } },
      hidePaid ? "✓ Hiding Paid" : "Hide Paid");

    var sortBtnsEl = h("div", { style: { display: "flex", gap: 4 } },
      sorts.map(function(s) {
        var active = sortMode === s.k;
        return h("button", { key: s.k, onClick: function() { setSortMode(s.k); },
          style: { background: active ? B.accent : B.raised, color: active ? B.btnInk : B.textMut, border: "1px solid " + (active ? B.accent : B.border), borderRadius: "4px", padding: "3px 10px", fontSize: "10px", fontWeight: 600, cursor: "pointer" } }, s.l);
      }));

    return h("div", null,
      // Title + search share the top row (search to the right of the title);
      // desktop keeps the + New button at the far right.
      h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14 } },
        h("h2", { style: { fontSize: "18px", fontWeight: 700, color: B.text, margin: 0, flexShrink: 0 } }, "Invoices"),
        h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search invoices…",
          style: { flex: 1, minWidth: 0, background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: isMobile ? "9px 12px" : "6px 12px", color: B.text, fontSize: isMobile ? undefined : "12px", fontFamily: "inherit", outline: "none" } }),
        !isMobile && h(window.Btn, { small: true, onClick: function() { nav("invoices/new"); } }, "+ New Invoice")),
      h("div", { style: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 } },
        // Mobile drops the Paid tile so Pending + Overdue sit on one row and
        // reclaim the vertical space; desktop keeps all three.
        !isMobile && h(window.StatCard, { label: "Paid", value: "$" + window.LTP_money(totalPaid), accent: B.success }),
        h(window.StatCard, { label: "Pending", value: "$" + window.LTP_money(totalPending), accent: B.warn }),
        h(window.StatCard, { label: "Overdue", value: "$" + window.LTP_money(totalOverdue), accent: B.danger })),
      // Filter chips (scroll strip with a swipe indicator) + Hide Paid on the right.
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: isMobile ? "flex-start" : "center", marginBottom: 10, flexWrap: isMobile ? "nowrap" : "wrap", gap: 8 } },
        h(window.LTPScrollStrip, { isMobile: isMobile, mobileStyle: { display: "flex", gap: 8, overflowX: "auto", flexWrap: "nowrap", WebkitOverflowScrolling: "touch", scrollbarWidth: "none", paddingBottom: 4 }, wrapStyle: { flex: 1, minWidth: 0 }, desktopStyle: { display: "flex", gap: 6, flexWrap: "wrap" } },
          statuses.map(function(f) {
            return h("button", { key: f, onClick: function() { setFilter(f); }, className: "ltp-tap",
              style: { flexShrink: 0, whiteSpace: "nowrap", background: filter === f ? B.accent : B.raised, color: filter === f ? B.btnInk : B.textMut, border: "1px solid " + (filter === f ? B.accent : B.border), borderRadius: isMobile ? "16px" : "4px", padding: isMobile ? "8px 16px" : "4px 12px", fontSize: isMobile ? "13px" : "11px", fontWeight: 600, cursor: "pointer", textTransform: "capitalize", minHeight: isMobile ? 36 : undefined } }, f);
          })),
        hidePaidBtn),
      // Sort row (Newest / Oldest / Ref #), matching the Quotes list.
      h("div", { style: { display: "flex", marginBottom: 14 } }, sortBtnsEl),
      h(window.LTPList, null,
        filtered.length === 0 && h("div", { style: { padding: 30, textAlign: "center", color: B.textMut, fontSize: "12px", fontStyle: "italic" } }, "No invoices found."),
        filtered.map(function(inv) {
          var ref = window.LTP_INVOICE_REF(inv);
          var t = window.LTP_INVOICE_TOTALS(inv);
          var comp = inv.companyId ? ((companies.find(function(c) { return c.id === inv.companyId; }) || {}).name || "") : "";
          // Row label: the linked project's name, or the typed customName for a
          // project-less invoice (matches the builder's displayName + the PDF).
          var proj = inv.projectId ? ((projects.find(function(p) { return p.id === inv.projectId; }) || {}).name || "") : (inv.customName || "");
          var qRef = inv.quoteId ? (function() { var q = quotes.find(function(q2) { return q2.id === inv.quoteId; }); return q ? window.LTP_QUOTE_REF(q) : ""; })() : "";
          var contact = contactName(inv);
          var clientLine = [comp, contact].filter(Boolean).join(" \u00b7 ");
          // Row top-aligned so the price + status chip sit in line with the ref.
          return h(window.LTPRow, { key: inv.id, onClick: function() { nav("invoices/" + inv.id); },
            style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 } },
            h("div", { style: { flex: 1, minWidth: 0 } },
              h("div", { style: { fontSize: "14px", fontWeight: 700, color: B.accent } }, ref),
              proj && h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text, marginTop: 1 } }, proj),
              clientLine && h("div", { style: { fontSize: "11px", color: B.textMut, marginTop: 2 } }, clientLine),
              (qRef || inv.dueDate) && h("div", { style: { fontSize: "11px", color: B.textMut, marginTop: 1 } },
                (qRef ? "from " + qRef : "") + (qRef && inv.dueDate ? " \u00b7 " : "") + (inv.dueDate ? "Due: " + fmt(inv.dueDate) : ""))),
            h("div", { style: { display: "flex", gap: 10, alignItems: "center", flexShrink: 0 } },
              h("div", { style: { textAlign: "right" } },
                h("div", { style: { fontSize: "15px", fontWeight: 700, color: window.LTP_isOverdue(inv) ? B.danger : B.accent } }, "$" + window.LTP_money(t.total)),
                t.paid > 0 && t.balance > 0 && h("div", { style: { fontSize: "9px", color: B.textMut } }, "bal: $" + window.LTP_money(t.balance))),
              h("div", { style: { display: "flex", gap: 4 } },
                h(window.Badge, { status: window.LTP_displayStatus(inv) }),
                t.paid > 0 && t.balance > 0 && window.LTP_isOverdue(inv) && h(window.Badge, { status: "overdue" })))
          );
        }))
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   ADD ITEM PICKER (simplified from quotes)
  // ═══════════════════════════════════════════════════════════════════════════
  function InvAddItemPicker({ onAdd, onClose, equipment, products, services, fees }) {
    var isMobile = window.LTP_useIsMobile();
    var [tab, setTab] = useState("equipment");
    var [search, setSearch] = useState("");
    var [noteText, setNoteText] = useState("");
    // Custom (ad-hoc) fee entry — a fee with no catalog row (feeId null).
    var [feeName, setFeeName] = useState("");
    var [feeAmount, setFeeAmount] = useState("");
    // Product id whose pricing-variant chooser popup is open (null = none).
    var [variantFor, setVariantFor] = useState(null);
    var q = search.trim().toLowerCase();

    function filterList(list, fields) {
      if (!q) return list;
      return list.filter(function(item) {
        return fields.some(function(f) { return ((item[f] || "") + "").toLowerCase().indexOf(q) !== -1; });
      });
    }

    // Fee add helpers. Fee lines carry the catalog default amount as unitPrice;
    // the price is then edited DIRECTLY on the line (adjustedPrice stays null),
    // so a fee never registers as a line adjustment. Custom fees have feeId null.
    function addFee(f) {
      onAdd({ id: genId("item"), type: "fee", feeId: f.id, name: f.name, category: f.category || "", unit: f.unit || "flat", qty: 1,
              unitPrice: Number(f.unitPrice) || 0, adjustedPrice: null, cost: Number(f.cost) || 0, notes: "", deliveredQty: 0, invoicedQty: 0 });
    }
    function addCustomFee() {
      var nm = feeName.trim();
      if (!nm) return;
      onAdd({ id: genId("item"), type: "fee", feeId: null, name: nm, category: "", unit: "flat", qty: 1,
              unitPrice: Number(feeAmount) || 0, adjustedPrice: null, cost: 0, notes: "", deliveredQty: 0, invoicedQty: 0 });
      setFeeName(""); setFeeAmount("");
    }

    var tabs = [
      { id: "equipment", label: "Equipment" },
      { id: "product",   label: "Products"  },
      { id: "service",   label: "Services"  },
      { id: "fee",       label: "Fees"      },
      { id: "note",      label: "Note"      },
    ];

    return h(window.LTPModal, { title: "Add Item", onClose: onClose, wide: true },
      h(window.LTPTabs, { tabs: tabs, active: tab, onChange: setTab }),

      tab === "equipment" && h("div", null,
        h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search equipment\u2026",
          style: { width: "100%", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", marginBottom: 10 } }),
        h("div", { style: { maxHeight: isMobile ? "calc(var(--app-h, 100dvh) - 220px)" : 350, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 } },
          filterList(equipment || [], ["name", "category", "subcategory"]).slice(0, 60).map(function(eq) {
            return h("div", { key: eq.id, onClick: function() {
                onAdd({ id: genId("item"), type: "equipment", equipmentId: eq.id, name: eq.name, qty: 1, unitPrice: (eq.rates && eq.rates.threeDay) || 0, adjustedPrice: null, cost: 0, notes: "", deliveredQty: 0, invoicedQty: 0 });
              },
              style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "4px", padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 },
              onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent; },
              onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
              h("div", { style: { flex: 1 } },
                h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, eq.name),
                h("div", { style: { fontSize: "10px", color: B.textMut } }, eq.category || "")),
              h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.accent } }, "$" + ((eq.rates && eq.rates.threeDay) || 0))
            );
          }))
      ),

      tab === "product" && h("div", null,
        h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search products\u2026",
          style: { width: "100%", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", marginBottom: 10 } }),
        h("div", { style: { maxHeight: isMobile ? "calc(var(--app-h, 100dvh) - 220px)" : 350, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 } },
          filterList(products || [], ["name", "category"]).slice(0, 60).map(function(p) {
            // One row per pricing variant when the product defines any (the
            // base Sale Price applies only to variant-less products) — same
            // fan-out as the quote builder's product picker.
            function addRow(variant) {
              onAdd({ id: genId("item"), type: "product", productId: p.id,
                      productVariantId: variant ? variant.id : null,
                      name: window.LTP_productVariantName(p, variant), qty: 1,
                      unitPrice: variant ? variant.unitPrice : (p.unitPrice || 0), adjustedPrice: null,
                      cost: variant ? variant.cost : (p.cost || 0), notes: "", deliveredQty: 0, invoicedQty: 0 });
            }
            var rowStyle = { background: B.raised, border: "1px solid " + B.border, borderRadius: "4px", padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 };
            var hover = {
              onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent; },
              onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; },
            };
            var pv = window.LTP_productVariants(p);
            // A product with pricing variants shows ONE row; clicking it opens
            // a small chooser popup (a single variant adds directly). Same UX
            // as the quote builder's product picker.
            if (pv.length > 0) {
              var open = variantFor === p.id;
              var lo = pv.reduce(function(m, v) { return Math.min(m, v.unitPrice); }, Infinity);
              var hi = pv.reduce(function(m, v) { return Math.max(m, v.unitPrice); }, 0);
              return h("div", { key: p.id, style: { position: "relative" } },
                h("div", Object.assign({
                  onClick: function() {
                    if (pv.length === 1) { addRow(pv[0]); setVariantFor(null); }
                    else setVariantFor(open ? null : p.id);
                  },
                  style: Object.assign({}, rowStyle, open ? { border: "1px solid " + B.accent } : null),
                }, hover),
                  h("div", { style: { flex: 1 } },
                    h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } },
                      p.name,
                      pv.length > 1 && h("span", { style: { fontSize: "9px", fontWeight: 700, color: B.info, background: B.info + "22", border: "1px solid " + B.info + "44", borderRadius: "3px", padding: "1px 5px", marginLeft: 6, verticalAlign: "1px" } },
                        pv.length + " prices " + (open ? "▴" : "▾"))),
                    h("div", { style: { fontSize: "10px", color: B.textMut } }, p.category || "")),
                  h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.accent } },
                    pv.length === 1 ? "$" + pv[0].unitPrice : (lo === hi ? "$" + lo : "$" + lo + "–$" + hi))
                ),
                // Variant chooser popup — pick one, it adds and closes.
                open && h("div", { style: { background: B.bg, border: "1px solid " + B.accent + "66", borderRadius: "6px", margin: "3px 0 3px 18px", padding: 4, boxShadow: "0 4px 14px rgba(0,0,0,0.35)", display: "flex", flexDirection: "column", gap: 2 } },
                  pv.map(function(v) {
                    return h("div", { key: v.id, onClick: function(e) { e.stopPropagation(); addRow(v); setVariantFor(null); },
                      style: { display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", borderRadius: "4px", cursor: "pointer" },
                      onMouseOver: function(e) { e.currentTarget.style.background = B.raised; },
                      onMouseOut:  function(e) { e.currentTarget.style.background = "transparent"; } },
                      h("div", { style: { flex: 1, fontSize: "11px", fontWeight: 600, color: B.text } }, v.label),
                      h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.accent } }, "$" + v.unitPrice));
                  }))
              );
            }
            return h("div", Object.assign({ key: p.id, onClick: function() { addRow(null); }, style: rowStyle }, hover),
              h("div", { style: { flex: 1 } },
                h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, p.name),
                h("div", { style: { fontSize: "10px", color: B.textMut } }, p.category || "")),
              h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.accent } }, "$" + (p.unitPrice || 0))
            );
          }))
      ),

      tab === "service" && h("div", null,
        h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search services\u2026",
          style: { width: "100%", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", marginBottom: 10 } }),
        h("div", { style: { maxHeight: isMobile ? "calc(var(--app-h, 100dvh) - 220px)" : 350, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 } },
          filterList(services || [], ["role", "department"]).slice(0, 60).map(function(s) {
            return h("div", { key: s.id, onClick: function() {
                onAdd({ id: genId("item"), type: "service", serviceId: s.id, name: s.role + " \u2014 " + s.description, rateType: "day", qty: 1, unitPrice: s.dayRate || 0, adjustedPrice: null, cost: s.dayCost || 0, notes: "", deliveredQty: 0, invoicedQty: 0 });
              },
              style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "4px", padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 },
              onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent; },
              onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
              h("div", { style: { flex: 1 } },
                h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, s.role),
                h("div", { style: { fontSize: "10px", color: B.textMut, display: "flex", gap: 5, alignItems: "center" } }, s.department || "",
                  // The price beside this row is already the client's negotiated
                  // rate (the list is resolved) — say where it came from.
                  h(window.ClientRateChip, { svc: s, tiny: true }))),
              h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.accent } }, "$" + (s.dayRate || 0) + "/day")
            );
          }))
      ),

      tab === "fee" && h("div", null,
        // Custom (ad-hoc) fee \u2014 name + amount, with common-fee quick fills.
        h("div", { style: { background: B.bg, border: "1px solid " + FEE_COLOR + "44", borderRadius: "6px", padding: 10, marginBottom: 12 } },
          h("div", { style: { fontSize: "10px", fontWeight: 700, color: FEE_COLOR, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 } }, "Custom Fee"),
          h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: isMobile ? "wrap" : "nowrap" } },
            h("input", { type: "text", value: feeName, onChange: function(e) { setFeeName(e.target.value); },
              onKeyDown: function(e) { if (e.key === "Enter") addCustomFee(); }, placeholder: "Fee description (e.g. Lodging \u2014 2 nights)",
              style: { flex: 1, minWidth: isMobile ? "100%" : 180, background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "7px 10px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none" } }),
            h("input", { type: "number", inputMode: "decimal", step: "0.01", value: feeAmount, onChange: function(e) { setFeeAmount(e.target.value); },
              onKeyDown: function(e) { if (e.key === "Enter") addCustomFee(); }, placeholder: "$ amount",
              style: { width: isMobile ? "100%" : 110, background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "7px 10px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", textAlign: "right" } }),
            h("button", { onClick: addCustomFee, disabled: !feeName.trim(),
              style: { background: feeName.trim() ? B.accent : B.raised, border: "none", borderRadius: "6px", color: feeName.trim() ? B.btnInk : B.textMut, cursor: feeName.trim() ? "pointer" : "default", fontSize: "12px", fontWeight: 700, padding: "8px 14px", whiteSpace: "nowrap", flexShrink: 0 } }, "Add")),
          (window.LTP_FEE_QUICKNAMES || window.LTP_FEE_QUICKNAMES_DEFAULT).length > 0 &&
          h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 } },
            (window.LTP_FEE_QUICKNAMES || window.LTP_FEE_QUICKNAMES_DEFAULT).map(function(sug) {
              return h("button", { key: sug, onClick: function() { setFeeName(sug); },
                style: { background: "transparent", border: "1px dashed " + B.border, borderRadius: "12px", color: B.textSec, cursor: "pointer", fontSize: "10px", fontWeight: 600, padding: "3px 10px" } }, "+ " + sug);
            }))),
        // Catalog fees
        h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search saved fees\u2026",
          style: { width: "100%", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", marginBottom: 10 } }),
        h("div", { style: { maxHeight: isMobile ? "calc(var(--app-h, 100dvh) - 320px)" : 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 } },
          (fees || []).length === 0
            ? h("div", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic", padding: "10px 2px" } }, "No saved fees yet. Add reusable fees in Quotes \u2192 Fees, or type a custom fee above.")
            : filterList(fees || [], ["name", "category"]).slice(0, 60).map(function(f) {
                return h("div", { key: f.id, onClick: function() { addFee(f); },
                  style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "4px", padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 },
                  onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent; },
                  onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
                  h("span", { style: { fontSize: "9px", fontWeight: 700, color: FEE_COLOR, background: FEE_COLOR + "22", border: "1px solid " + FEE_COLOR + "44", padding: "2px 5px", borderRadius: "3px", flexShrink: 0 } }, "FEE"),
                  h("div", { style: { flex: 1, minWidth: 0 } },
                    h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, f.name),
                    h("div", { style: { fontSize: "10px", color: B.textMut } }, (f.category || "Uncategorized") + (f.unit && f.unit !== "flat" ? " \u00b7 per " + f.unit : ""))),
                  h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.accent } }, "$" + (f.unitPrice || 0)));
              }))
      ),

      // Note text is stored with its authored spacing and newlines intact (see
      // LTP_noteText) \u2014 the textarea IS the formatting control for these lines.
      tab === "note" && h("div", null,
        h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 6 } }, "Notes appear as line items on the invoice but have no price. Line breaks and spacing are kept exactly as typed \u2014 on the invoice, the client view and the PDF."),
        h("textarea", { value: noteText, onChange: function(e) { setNoteText(e.target.value); }, placeholder: "Enter note text\u2026", rows: 4,
          style: { width: "100%", boxSizing: "border-box", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px 12px", color: B.text, fontSize: "12px", lineHeight: 1.5, fontFamily: "inherit", outline: "none", resize: "vertical", marginBottom: 10 } }),
        h(window.Btn, { small: true, disabled: !window.LTP_noteHasText(noteText), onClick: function() {
          if (!window.LTP_noteHasText(noteText)) return;
          onAdd({ id: genId("item"), type: "note", text: window.LTP_noteText(noteText) });
          setNoteText("");
        } }, "Add Note"))
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   INVOICE LINE ITEM ROW
  // ═══════════════════════════════════════════════════════════════════════════
  function InvLineItem({ item, sectionId, isDraft, onUpdate, onDelete, onMove, sortable, itemIndex, itemCount, services, products, equipment, fees, customerTaxable }) {
    var isMobile = window.LTP_useIsMobile();

    // Reorder affordance, matching the quote builder: a grab handle on desktop
    // (drag with live reordering, or focus it and press ↑/↓) and the two ▲▼
    // buttons on a phone.
    function reorderControl() {
      if (isMobile) {
        return h(window.LTPMoveArrows, {
          onMove: function(dir) { onMove(sectionId, item.id, dir); },
          canUp: itemIndex > 0, canDown: itemIndex < itemCount - 1, label: "line item",
        });
      }
      return h("button", sortable.handleProps("item", sectionId, item.id,
        { label: "Reorder line item", fontSize: "12px" }), "☰");
    }

    // Shared with the quote builder (components/ui.js): pre-wrap display so the
    // authored newlines/indentation survive, plus in-place editing while draft.
    if (item.type === "note") {
      return h(window.LTPNoteLineRow, {
        text: item.text,
        editable: !!isDraft,
        onSave: function(txt) { onUpdate(sectionId, item.id, { text: txt }); },
        onDelete: function() { onDelete(sectionId, item.id); },
        containerProps: sortable.itemProps(sectionId, item.id),
        // Desktop grab handle only — same reasoning as the quote builder: the
        // phone note row stays exactly as it was.
        handle: (isDraft && !isMobile) ? reorderControl() : null,
      });
    }

    var isFee = item.type === "fee";
    var typeBadge = item.type === "equipment" ? "EQ" : item.type === "product" ? "PR" : isFee ? "FEE" : "SV";
    var typeBadgeColor = item.type === "equipment" ? B.info : item.type === "product" ? B.success : isFee ? FEE_COLOR : B.warn;
    var RATE_TYPES = { day: "days", half: "half days", hourly: "hours", ot: "OT hours" };
    var svcRateType = item.type === "service" ? (item.rateType || "day") : null;
    var qtyLabel = svcRateType ? (RATE_TYPES[svcRateType] || "qty") : (isFee && item.unit && item.unit !== "flat" ? item.unit + "s" : "qty");
    var svcData = item.type === "service" && item.serviceId ? (services || []).find(function(sv) { return sv.id === item.serviceId; }) : null;
    // Product lookup for the pricing-variant selector (products with variants).
    var prodData = item.type === "product" && item.productId ? (products || []).find(function(pr) { return pr.id === item.productId; }) : null;
    var prodVariants = prodData ? window.LTP_productVariants(prodData) : [];
    var lineVariantId = item.productVariantId != null ? String(item.productVariantId) : "";
    var lineVariantMissing = lineVariantId !== "" && !prodVariants.some(function(v) { return v.id === lineVariantId; });
    // Source catalog record deleted since this line was created. The snapshot
    // price/qty stay intact; we just flag that it can no longer be re-sourced.
    var sourceMissing =
      (item.type === "service"   && item.serviceId   != null && !svcData) ||
      (item.type === "product"   && item.productId   != null && !(products  || []).some(function(p) { return p.id === item.productId; })) ||
      (item.type === "equipment" && item.equipmentId != null && !(equipment || []).some(function(e) { return e.id === item.equipmentId; }));
    var missingLabel = item.type === "service" ? "Service" : item.type === "product" ? "Product" : "Equipment";
    var unitP = Number(item.unitPrice) || 0;
    // Client-rate provenance (service lines). `services` is already resolved for
    // THIS invoice's client, so svcData carries `clientRate` when the role was
    // negotiated. The line keeps its snapshotted price — an invoice must not
    // silently re-price itself — so a mismatch offers a one-click apply instead.
    function clientRateNote(small) {
      if (!svcData || !svcData.clientRate) return null;
      var maps = window.LTP_serviceRateMaps(svcData);
      var live = Math.round((maps.priceMap[svcRateType] || 0) * 100) / 100;
      var stale = Math.abs(live - unitP) > 0.005;
      return h("div", { style: { display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", marginTop: 2 } },
        h(window.ClientRateChip, { svc: svcData, tiny: small }),
        svcData.minHours > 0 && h("span", { style: { fontSize: small ? "10px" : "11px", color: B.textMut } },
          svcData.minHours + "-hour day minimum"),
        stale && (!isDraft
          ? h("span", { style: { fontSize: small ? "10px" : "11px", color: B.warn } }, "contract rate is now $" + window.LTP_money(live))
          : h("button", { onClick: function() {
                onUpdate(sectionId, item.id, { unitPrice: live, cost: Math.round((maps.costMap[svcRateType] || 0) * 100) / 100, adjustedPrice: null });
              },
              title: "This line was priced at $" + window.LTP_money(unitP) + "; the client's contract rate for this tier is now $" + window.LTP_money(live) + ". Click to re-price the line.",
              style: { background: "transparent", border: "1px solid " + B.warn + "66", color: B.warn, borderRadius: "3px", padding: "0 5px",
                       fontSize: "10px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" } },
              "contract rate $" + window.LTP_money(live) + " — apply")));
    }
    var adjusted = item.adjustedPrice != null && item.adjustedPrice !== item.unitPrice;
    var eff = item.adjustedPrice != null ? (Number(item.adjustedPrice) || 0) : unitP;
    var lt = eff * (Number(item.qty) || 0);

    // ── Mobile: stacked card (the desktop row packs ~9 fixed-width cells into
    // one horizontal flex that overflows a phone). Name on top, then full-width
    // rate/variant selects, a Qty|Adj grid with the right iOS keyboards, and a
    // unit/tax/total footer. Desktop row is unchanged below.
    if (isMobile) {
      var fld = { width: "100%", background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px 10px", color: B.text, fontSize: "16px", fontFamily: "inherit", outline: "none" };
      var lbl = { fontSize: "10px", color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 };
      var selStyle = Object.assign({}, fld, { marginTop: 8, appearance: "auto" });
      return h("div", Object.assign({ style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: "10px 12px", marginBottom: 2 } }, sortable.itemProps(sectionId, item.id)),
        h("div", { style: { display: "flex", alignItems: "flex-start", gap: 8 } },
          h("span", { style: { fontSize: "9px", fontWeight: 700, color: typeBadgeColor, background: typeBadgeColor + "22", border: "1px solid " + typeBadgeColor + "44", padding: "3px 6px", borderRadius: "3px", flexShrink: 0, marginTop: 3 } }, typeBadge),
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { style: { fontSize: "15px", fontWeight: 600, color: B.text } }, item.name),
            item.notes && h("div", { style: { fontSize: "12px", color: B.textMut, fontStyle: "italic" } }, item.notes),
            clientRateNote(false),
            sourceMissing && h("div", { style: { fontSize: "11px", color: B.warn, fontWeight: 600 } }, "⚠ " + missingLabel + " deleted from catalog — price locked")),
          isDraft && reorderControl(),
          isDraft && h("button", { onClick: function() { onDelete(sectionId, item.id); }, "aria-label": "Remove line", className: "ltp-tap",
            style: { background: "transparent", border: "none", color: B.textMut, cursor: "pointer", fontSize: "22px", minWidth: 44, minHeight: 44, flexShrink: 0, lineHeight: 1 } }, "×")),
        // Rate-type (services) / variant (products) selects — full width on mobile.
        item.type === "service" && isDraft && svcData && h("select", { value: svcRateType, onChange: function(e) {
          var rt = e.target.value; var maps = window.LTP_serviceRateMaps(svcData);
          onUpdate(sectionId, item.id, { rateType: rt, unitPrice: maps.priceMap[rt] || 0, cost: maps.costMap[rt] || 0, adjustedPrice: null });
        }, style: selStyle },
          h("option", { value: "day" }, "Day"), h("option", { value: "half" }, "Half Day"),
          h("option", { value: "hourly" }, "Hourly"), h("option", { value: "ot" }, "OT")),
        item.type === "product" && isDraft && prodData && prodVariants.length > 0 && h("select", {
          value: lineVariantId, onChange: function(e) {
            var v = window.LTP_findProductVariant(prodData, e.target.value);
            onUpdate(sectionId, item.id, { productVariantId: v ? v.id : null, name: window.LTP_productVariantName(prodData, v), unitPrice: v ? v.unitPrice : (prodData.unitPrice || 0), cost: v ? v.cost : (prodData.cost || 0), adjustedPrice: null });
          }, style: selStyle },
          h("option", { value: "" }, "Base price"),
          prodVariants.map(function(v) { return h("option", { key: v.id, value: v.id }, v.label); }),
          lineVariantMissing && h("option", { value: lineVariantId }, "(removed variant)")),
        // Qty + Adjusted price (draft) with the right iOS keyboards.
        isDraft && h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 } },
          h("div", null, h("div", { style: lbl }, qtyLabel),
            h("input", { type: "number", inputMode: "numeric", value: item.qty, min: 0,
              onChange: function(e) { onUpdate(sectionId, item.id, { qty: Math.max(0, Number(e.target.value) || 0) }); }, style: fld })),
          // Fees edit the PRICE directly (unitPrice) — it varies per project and
          // is never a discount, so no adjustedPrice / strike-through.
          isFee
            ? h("div", null, h("div", { style: lbl }, "price ($)"),
                h("input", { type: "number", inputMode: "decimal", step: "0.01", value: item.unitPrice != null ? item.unitPrice : "", placeholder: "0.00",
                  onChange: function(e) { var v = e.target.value; onUpdate(sectionId, item.id, { unitPrice: v === "" ? 0 : Number(v) }); }, style: fld }))
            : h("div", null, h("div", { style: lbl }, "adj price"),
                h("input", { type: "number", inputMode: "decimal", step: "0.01", value: item.adjustedPrice != null ? item.adjustedPrice : "", placeholder: "$" + unitP,
                  onChange: function(e) { var v = e.target.value; onUpdate(sectionId, item.id, { adjustedPrice: v === "" ? null : Number(v) }); },
                  style: Object.assign({}, fld, { borderColor: adjusted ? B.accent : B.border, color: adjusted ? B.accent : B.text }) }))),
        // Unit · tax · total footer.
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 10, paddingTop: 8, borderTop: "1px solid " + B.border } },
          h("div", { style: { fontSize: "12px", color: B.textMut } },
            (isDraft ? "" : (item.qty + " " + qtyLabel + " · ")) + "unit ",
            h("span", { style: { textDecoration: adjusted ? "line-through" : "none" } }, "$" + unitP)),
          h("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
            isDraft && customerTaxable && h("label", { title: "Taxable in QuickBooks", style: { display: "flex", alignItems: "center", gap: 5, fontSize: "12px", color: B.textMut, cursor: "pointer", minHeight: 44 } },
              h("input", { type: "checkbox", checked: typeof item.taxable === "boolean" ? item.taxable : true, style: { width: 20, height: 20 },
                onChange: function(e) { onUpdate(sectionId, item.id, { taxable: e.target.checked }); } }), "tax"),
            h("div", { style: { fontSize: "16px", fontWeight: 700, color: B.accent } }, "$" + window.LTP_money(lt)))));
    }

    return h("div", Object.assign({ style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "4px", padding: "8px 12px", display: "flex", alignItems: "center", gap: 10 } }, sortable.itemProps(sectionId, item.id)),
      isDraft && reorderControl(),
      h("span", { style: { fontSize: "9px", fontWeight: 700, color: typeBadgeColor, background: typeBadgeColor + "22", border: "1px solid " + typeBadgeColor + "44", padding: "2px 5px", borderRadius: "3px" } }, typeBadge),
      h("div", { style: { flex: 1, minWidth: 0 } },
        h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, item.name),
        item.notes && h("div", { style: { fontSize: "10px", color: B.textMut, fontStyle: "italic" } }, item.notes),
        clientRateNote(true),
        sourceMissing && h("div", { style: { fontSize: "10px", color: B.warn, fontWeight: 600 } }, "⚠ " + missingLabel + " deleted from catalog — price locked to invoice")
      ),
      // Rate type selector (services only)
      item.type === "service" && isDraft && svcData && h("select", { value: svcRateType, onChange: function(e) {
        var rt = e.target.value;
        var maps = window.LTP_serviceRateMaps(svcData);
        onUpdate(sectionId, item.id, { rateType: rt, unitPrice: maps.priceMap[rt] || 0, cost: maps.costMap[rt] || 0, adjustedPrice: null });
      }, style: { width: 82, background: B.bg, border: "1px solid " + B.border, borderRadius: "3px", padding: "3px 4px", color: B.text, fontSize: "10px", fontFamily: "inherit", outline: "none" } },
        h("option", { value: "day" }, "Day"),
        h("option", { value: "half" }, "Half Day"),
        h("option", { value: "hourly" }, "Hourly"),
        h("option", { value: "ot" }, "OT")
      ),
      // Pricing-variant selector (products with variants only) — mirrors the
      // quote builder. Switching re-snapshots name/price/cost from the variant.
      item.type === "product" && isDraft && prodData && prodVariants.length > 0 && h("select", {
        value: lineVariantId, onChange: function(e) {
          var v = window.LTP_findProductVariant(prodData, e.target.value);
          onUpdate(sectionId, item.id, {
            productVariantId: v ? v.id : null,
            name: window.LTP_productVariantName(prodData, v),
            unitPrice: v ? v.unitPrice : (prodData.unitPrice || 0),
            cost: v ? v.cost : (prodData.cost || 0),
            adjustedPrice: null,
          });
        }, style: { width: 82, background: B.bg, border: "1px solid " + B.border, borderRadius: "3px", padding: "3px 4px", color: B.text, fontSize: "10px", fontFamily: "inherit", outline: "none" } },
        h("option", { value: "" }, "Base price"),
        prodVariants.map(function(v) { return h("option", { key: v.id, value: v.id }, v.label); }),
        lineVariantMissing && h("option", { value: lineVariantId }, "(removed variant)")
      ),
      // Read-only rate-type label when the invoice is locked, OR when the source
      // service was deleted (no svcData to recompute prices from — Option B).
      item.type === "service" && (!isDraft || !svcData) && h("div", { style: { fontSize: "10px", color: B.warn, fontWeight: 600, width: 82, textAlign: "center" } },
        svcRateType === "day" ? "Day" : svcRateType === "half" ? "Half Day" : svcRateType === "hourly" ? "Hourly" : svcRateType === "ot" ? "OT" : "Day"),
      // Qty
      h("div", { style: { width: 55 } },
        h("div", { style: { fontSize: "9px", color: B.textMut, textAlign: "center" } }, qtyLabel),
        isDraft
          ? h("input", { type: "number", value: item.qty, min: 0, step: "any",
              onChange: function(e) { onUpdate(sectionId, item.id, { qty: Math.max(0, Number(e.target.value) || 0) }); },
              style: { width: "100%", background: B.bg, border: "1px solid " + B.border, borderRadius: "3px", padding: "3px 6px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", textAlign: "center" } })
          : h("div", { style: { fontSize: "11px", color: B.text, textAlign: "center", padding: "3px 0" } }, item.qty)
      ),
      // Price cell. Fees edit their PRICE directly here (unitPrice) \u2014 it varies
      // per project and is not a discount, so there's no separate adjusted cell.
      isFee
        ? h("div", { style: { width: 75 } },
            h("div", { style: { fontSize: "9px", color: B.textMut, textAlign: "right" } }, "price"),
            isDraft
              ? h("input", { type: "number", value: item.unitPrice != null ? item.unitPrice : "", min: 0, step: "any",
                  onChange: function(e) { var v = e.target.value; onUpdate(sectionId, item.id, { unitPrice: v === "" ? 0 : Number(v) }); },
                  style: { width: "100%", background: B.bg, border: "1px solid " + B.border, borderRadius: "3px", padding: "3px 6px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", textAlign: "right" } })
              : h("div", { style: { fontSize: "11px", color: B.text, textAlign: "right", padding: "3px 6px" } }, "$" + unitP))
        : h("div", { style: { width: 75 } },
            h("div", { style: { fontSize: "9px", color: B.textMut, textAlign: "right" } }, "unit"),
            h("div", { style: { fontSize: "11px", color: B.textMut, textAlign: "right", padding: "3px 6px", textDecoration: adjusted ? "line-through" : "none" } }, "$" + unitP)
          ),
      // Adjusted price \u2014 not shown for fees (empty spacer keeps total aligned).
      // Once the invoice leaves draft the price can no longer be adjusted, so an
      // unadjusted line has nothing to report — render the spacer instead of an
      // "adj" heading over an em-dash. In draft the input always shows: it is
      // the control for MAKING an adjustment, not a report of one.
      isFee || (!isDraft && item.adjustedPrice == null)
        ? h("div", { style: { width: 75 } })
        : h("div", { style: { width: 75 } },
            h("div", { style: { fontSize: "9px", color: B.textMut, textAlign: "right" } }, "adj"),
            isDraft
              ? h("input", { type: "number", value: item.adjustedPrice != null ? item.adjustedPrice : "", placeholder: String(unitP),
                  onChange: function(e) { var v = e.target.value; onUpdate(sectionId, item.id, { adjustedPrice: v === "" ? null : Number(v) }); },
                  style: { width: "100%", background: B.bg, border: "1px solid " + (adjusted ? B.accent : B.border), borderRadius: "3px", padding: "3px 6px", color: adjusted ? B.accent : B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", textAlign: "right" } })
              : h("div", { style: { fontSize: "11px", color: adjusted ? B.accent : B.textMut, textAlign: "right", padding: "3px 0" } }, item.adjustedPrice != null ? "$" + (Number(item.adjustedPrice) || 0) : "\u2014")
          ),
      // Total
      h("div", { style: { width: 85, textAlign: "right" } },
        h("div", { style: { fontSize: "9px", color: B.textMut } }, "total"),
        h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.accent } }, "$" + window.LTP_money(lt))
      ),
      // Per-line tax override — only shown for taxable customers (the common
      // case is exempt, so we keep the row clean). Checked = taxable; unchecked
      // = explicit exemption for this line. QuickBooks computes the actual tax.
      isDraft && customerTaxable && h("label", { title: "Taxable in QuickBooks", style: { display: "flex", alignItems: "center", gap: 3, width: 42, fontSize: "9px", color: B.textMut, cursor: "pointer" } },
        h("input", { type: "checkbox", checked: typeof item.taxable === "boolean" ? item.taxable : true,
          onChange: function(e) { onUpdate(sectionId, item.id, { taxable: e.target.checked }); } }),
        h("span", null, "tax")),
      // Delete (draft only)
      isDraft
        ? h("button", { onClick: function() { onDelete(sectionId, item.id); },
            style: { background: "transparent", border: "none", color: B.textMut, cursor: "pointer", fontSize: "14px", padding: "2px 6px" } }, "\u00d7")
        : h("div", { style: { width: 20 } })
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   INVOICE BUILDER
  // ═══════════════════════════════════════════════════════════════════════════
  // A blank invoice, and a deep copy of an existing one for editing.
  //
  // At file scope so they can be read without scrolling through the builder,
  // matching modules/quotes-builder.js, where the equivalent emptyDraft and
  // cloneDraft have always lived outside the component. These reference no
  // props at all — only the file-scope net30/genId/todayISO helpers — so they
  // were inside InvoiceBuilder purely because that is where they were written.
  function emptyInvoice() {
    var today = todayISO();
    return {
      id: null, quoteId: null,
      // projectId is the PRIMARY project; projectIds is every project this
      // invoice bills work for (see window.LTP_docProjectIds in theme.js).
      clientType: "company", companyId: null, clientContactId: null, projectId: null, projectIds: [],
      customName: "", status: "draft",
      invoiceDate: today, createdDate: today, sentDate: null, dueDate: net30(today), paidDate: null,
      globalDiscount: { type: "none", value: 0 },
      sections: [{ id: genId("sec"), label: "Items", customDates: false, startDate: "", endDate: "", items: [] }],
      notes: window.LTP_DEFAULT_INVOICE_NOTES || "",
      // "" = follow the workspace / built-in terms. Only set once a producer
      // edits this document's own wording. See window.LTP_docTerms in theme.js.
      terms: "",
      payments: [],
      activity: [{ id: genId("act"), date: today, time: new Date().toTimeString().substring(0,5), type: "created", message: "Invoice created", user: (window.LTP_CURRENT_USER || "User") }],
    };
  }

  function cloneInvoice(inv) {
    // Spread the source FIRST so server-managed fields we don't normalize
    // explicitly survive into the draft — notably the QuickBooks link
    // (qbInvoiceId, qbSyncToken, qbSyncStatus, qbSyncedAt, qbTaxTotal,
    // qbTotalAmt, qbLastError). Without this, re-opening an invoice (e.g.
    // after editing its customer) dropped the qb link from the draft and the
    // UI reverted to "Send to QuickBooks" even though the server still had
    // it. The explicit keys below override/normalize and deep-clone the
    // nested arrays so edits never mutate the shared list objects.
    return Object.assign({}, inv, {
      id: inv.id, quoteId: inv.quoteId || null,
      shareToken: inv.shareToken || null,
      clientType: inv.clientType || "company", companyId: inv.companyId, clientContactId: inv.clientContactId,
      projectId: inv.projectId,
      // Normalized (not passed through raw) so a legacy row without the field
      // still round-trips a correct list instead of saving back an empty one
      // and dropping its "Includes" attribution.
      projectIds: window.LTP_docProjectIds(inv),
      customName: inv.customName || "",
      status: inv.status || "draft",
      invoiceDate: inv.invoiceDate || inv.createdDate || todayISO(),
      createdDate: inv.createdDate || todayISO(), sentDate: inv.sentDate || null,
      dueDate: inv.dueDate || "", paidDate: inv.paidDate || null,
      globalDiscount: Object.assign({ type: "none", value: 0 }, inv.globalDiscount || {}),
      // A whitelist rebuild, so every section field must be named here or
      // editing the invoice silently drops it — `projectId` records which job
      // an appended section came from. (Items are spread, so sourceQuoteId /
      // linkedQty survive automatically.)
      sections: (inv.sections || []).map(function(s) {
        return { id: s.id, label: s.label, customDates: !!s.customDates, startDate: s.startDate || "", endDate: s.endDate || "",
                 projectId: s.projectId != null ? s.projectId : null,
                 items: (s.items || []).map(function(i) { return Object.assign({}, i); }) };
      }),
      notes: inv.notes || "",
      // Carried by the spread above too; normalized here so a null from an
      // older row reads as "follow the default" rather than reaching the
      // editor as null.
      terms: inv.terms || "",
      payments: (inv.payments || []).map(function(p) { return Object.assign({}, p); }),
      activity: (inv.activity || []).map(function(a) { return Object.assign({}, a); }),
    });
  }

  function InvoiceBuilder({ invoiceId, isNew, invoices, setInvoices, getNextInvoiceId,
                            companies, setCompanies, contacts, setContacts, projects, quotes, setQuotes,
                            equipment, products, services, clientRates, fees, settings, isAdmin, qbo }) {
    var isMobile = window.LTP_useIsMobile();


    var initial = useMemo(function() {
      if (isNew) return emptyInvoice();
      var inv = invoices.find(function(x) { return x.id === invoiceId; });
      return inv ? cloneInvoice(inv) : emptyInvoice();
    }, [invoiceId, isNew]);

    var [draft, setDraftRaw] = useState(initial);
    // Owns dirty state AND mirrors to window.__LTP_UNSAVED synchronously
    // (see theme.js) so save+nav doesn't trigger a bogus "unsaved" prompt.
    var unsavedPair = window.LTP_useUnsavedGuard();
    var isDirty = unsavedPair[0];
    var setIsDirty = unsavedPair[1];
    var cleanRef = useRef(initial);
    var pendingRollbacks = useRef([]); // track deleted linked items for quote sync on save
    function setDraft(updater) { setDraftRaw(updater); setIsDirty(true); }
    function patchDraft(patch) { setDraft(function(d) { return Object.assign({}, d, patch); }); }

    var [dlg, setDlg] = useState(null);
    var [justSaved, setJustSaved] = useState(false);
    var [pickerForSection, setPickerForSection] = useState(null);
    var [viewActivity, setViewActivity] = useState(null);
    var [showPaymentForm, setShowPaymentForm] = useState(false);
    var [showSendModal, setShowSendModal] = useState(false);
    // Email recipients for the send/receipt modals: { to: [email], cc: [email] }.
    // Derived from the project's contacts (or remembered on the record) when a
    // modal opens; edited via the RecipientEditor; serialized to to/cc on send.
    var [sendRecipients, setSendRecipients] = useState({ to: [], cc: [] });
    var [sending, setSending] = useState(false);
    var [qboSyncing, setQboSyncing] = useState(false);
    var [showReceiptModal, setShowReceiptModal] = useState(false);
    var [sendSubject, setSendSubject] = useState("");
    var [sendMessage, setSendMessage] = useState("");
    // Per-entity values baked into the {{header}} block at send time —
    // captured at openSendModal / openReceiptModal so a later draft
    // mutation doesn't change what the user sees in the modal preview.
    var [sendHeaderVars, setSendHeaderVars] = useState(null);
    // Attach the invoice PDF to invoice + reminder emails. Default ON; the
    // user can uncheck per-send in the modal. Backend generates the PDF fresh.
    var [attachPdf, setAttachPdf] = useState(true);
    var [generatingPdf, setGeneratingPdf] = useState(false);

    // POST /api/invoices/{id}/pdf → trigger download + mirror activity entry.
    // Same pattern as quotes-builder.js. See that file's generatePdf for
    // detailed comments on the flow.
    function generatePdf() {
      if (draft.id == null || generatingPdf) return;
      // iOS standalone blocks BOTH programmatic downloads and window.open()
      // called after an async fetch (outside the click gesture). So on mobile
      // open a blank tab synchronously now (inside the gesture) and redirect it
      // to the PDF once ready — it opens in the iOS PDF viewer. Desktop keeps
      // the direct download.
      var pdfWin = isMobile ? window.open("", "_blank") : null;
      setGeneratingPdf(true);
      fetch("/api/invoices/" + draft.id + "/pdf", { method: "POST", credentials: "include" })
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
            var a = document.createElement("a");
            a.href = resp.downloadUrl;
            a.download = resp.filename || ("INV-" + draft.id + ".pdf");
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }
          var actEntry = {
            id: "pdf-" + Date.now(),
            date: todayISO(),
            time: new Date().toTimeString().substring(0, 5),
            type: "pdf_generated",
            user: (window.LTP_CURRENT_USER || "User"),
            userId: window.LTP_CURRENT_USER_ID || null,
            message: "PDF generated",
            pdfToken: resp.token,
            pdfFilename: resp.filename,
          };
          var updated = Object.assign({}, draft, { activity: (draft.activity || []).concat([actEntry]) });
          setDraftRaw(updated);
          cleanRef.current = updated;
          setInvoices(function(prev) { return prev.map(function(inv) { return inv.id === draft.id ? updated : inv; }); });
        })
        .catch(function(err) {
          if (pdfWin) { try { pdfWin.close(); } catch (e) {} }
          if (window.LTP_API_ERRORS) {
            window.LTP_API_ERRORS.push({ at: new Date().toISOString(), label: "POST invoices/" + draft.id + "/pdf", error: String(err) });
          }
          try {
            window.dispatchEvent(new CustomEvent("ltp-api-error", { detail: { label: "PDF generation", error: String(err), at: new Date().toISOString() } }));
          } catch (e) {}
          showAlert("PDF Error", "Could not generate the PDF. " + (err && err.message || err));
        })
        .finally(function() { setGeneratingPdf(false); });
    }

    // Native share of the invoice's public link via the iOS/Android share sheet
    // (Messages, Mail, WhatsApp, AirDrop…), with clipboard then mailto fallbacks
    // for browsers without the Web Share API.
    function shareInvoice() {
      if (draft.id == null || !draft.shareToken) { showAlert("Save First", "Save the invoice before sharing so it has a stable link."); return; }
      var url = window.location.origin + "/#/view/invoice/" + draft.shareToken;
      var title = refDisplay + (displayName ? " — " + displayName : "");
      if (navigator.share) {
        navigator.share({ title: title, text: title, url: url }).catch(function() {});
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function() { if (window.LTP_toast) window.LTP_toast("Invoice link copied", { variant: "success" }); });
      } else {
        window.location.href = "mailto:?subject=" + encodeURIComponent(title) + "&body=" + encodeURIComponent(url);
      }
    }


    // ── Payment helpers ──────────────────────────────────────────────────────
    function addPayment(payment) {
      var newPayment = Object.assign({ id: genId("pay") }, payment);
      var updatedPayments = (draft.payments || []).concat([newPayment]);
      var newTotal = updatedPayments.reduce(function(s, p) { return s + (Number(p.amount) || 0); }, 0);
      var invoiceTotal = t.total;
      // Auto-update status
      var newStatus = draft.status;
      if (newTotal >= invoiceTotal) { newStatus = "paid"; }
      else if (newTotal > 0 && draft.status !== "draft") { newStatus = "partial"; }
      var actEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0, 5),
        type: "paid", user: (window.LTP_CURRENT_USER || "User"), message: "Payment recorded: $" + window.LTP_money(payment.amount) + (newTotal >= invoiceTotal ? " \u2014 Paid in full" : ""),

        changes: [
          { cat: "Amount", detail: "$" + window.LTP_money(payment.amount) },
          { cat: "Method", detail: payment.method || "\u2014" },
          payment.reference ? { cat: "Reference", detail: payment.reference } : null,
          newStatus !== draft.status ? { cat: "Status", detail: draft.status + " \u2192 " + newStatus } : null
        ].filter(Boolean)
      };
      patchDraft({ payments: updatedPayments, status: newStatus, paidDate: newTotal >= invoiceTotal ? todayISO() : draft.paidDate, activity: (draft.activity || []).concat([actEntry]) });
      // Auto-save payment immediately (bypasses locked state)
      setTimeout(function() { autoSavePayment(); }, 50);
      setShowPaymentForm(false);
      // Trigger receipt email when fully paid
      if (newTotal >= invoiceTotal) {
        setTimeout(function() { openReceiptModal(updatedPayments); }, 300);
      }
    }

    // Recipients for the send/receipt modals: the record's remembered list, else
    // derived from the project's contacts (primary → To, the rest → Cc).
    function initSendRecipients() {
      var saved = draft.sendRecipients;
      if (saved && ((saved.to || []).length || (saved.cc || []).length)) {
        return { to: (saved.to || []).slice(), cc: (saved.cc || []).slice() };
      }
      return window.LTP_deriveRecipients(selectedProject, contacts, draft.clientContactId, draft.companyId);
    }
    // Persist recipient edits onto the record (remembered for next send) and
    // mirror into modal state.
    function onRecipientsChange(r) { setSendRecipients(r); patchDraft({ sendRecipients: r }); }

    function openReceiptModal(payments) {
      var clientName = "";
      if (draft.clientContactId) {
        var ct = contacts.find(function(c) { return c.id === draft.clientContactId; });
        if (ct) { clientName = ct.firstName + " " + ct.lastName; }
      } else if (draft.companyId) {
        var compContacts = contacts.filter(function(c) { return (c.companyIds || []).includes(draft.companyId); });
        if (compContacts.length > 0) { clientName = compContacts[0].firstName; }
      }
      var ref = draft.id != null ? window.LTP_INVOICE_REF(draft) : "Invoice";
      var projName = selectedProject ? selectedProject.name : (draft.customName || "");
      var paymentLines = (payments || draft.payments || []).map(function(p) {
        var methodLabels = { check: "Check", ach: "ACH", credit_card: "Credit Card", cash: "Cash", wire: "Wire", other: "Other" };
        return "  " + fmt(p.date) + " \u2014 $" + window.LTP_money(p.amount) + " via " + (methodLabels[p.method] || p.method) + (p.reference ? " (" + p.reference + ")" : "");
      }).join("\n");
      var resolve = window.LTP_resolveTemplate;
      var s = settings || {};
      var tmpl = (s.emailTemplates || {}).paymentReceipt || {};
      // {{signature}} stays unresolved — backend renders it per-user. {{viewUrl}}
      // isn't in the receipt template by default (receipts don't need a live
      // view link), but if an admin adds it, the backend handles it.
      var vars = {
        companyName: s.companyName || "LTP",
        refNumber: ref,
        projectName: projName,
        clientName: clientName || "there",
        total: "$" + window.LTP_money(t.total),
        lineItems: "Payments Received:\n" + paymentLines,
      };
      setSendRecipients(initSendRecipients());
      setSendSubject(resolve(tmpl.subject || "{{refNumber}} — Payment Received", vars));
      // Collapse an orphaned "()" the template leaves when projectName is empty
      // (a project-less invoice with no custom name): "...for {{refNumber}}
      // ({{projectName}})." would otherwise render "...for INV-2026-002 ()".
      // Mirrors backend/qbo_receipts.py::_strip_empty_parens so the manual and
      // auto receipts read identically.
      var receiptBody = resolve(tmpl.body || "{{header}}\n\nHi {{clientName}},\n\nThank you for your payment.\n\n{{lineItems}}\n\nBalance: $0.00\n\n{{signature}}", vars);
      setSendMessage(receiptBody.replace(/ ?\(\s*\)/g, ""));
      // headerVars feed both the editor preview and the send-time
      // expansion in sendReceipt. viewUrl blank — backend resolves
      // per-recipient if the receipt body uses {{viewUrl}}.
      // {{viewUrl}} stays literal — backend swaps in the per-recipient URL.
      setSendHeaderVars({ refNumber: ref, projectName: projName, total: vars.total });
      setShowReceiptModal(true);
    }

    function sendReceipt() {
      if (!(sendRecipients.to || []).length) { showAlert("No Recipient", "Add at least one To recipient."); return; }
      if (draft.id == null || !draft.shareToken) { showAlert("Save First", "Save the invoice before sending so it has a stable share link."); return; }
      if (!window.LTP_GMAIL_CONNECTED) {
        showAlert("Gmail Not Connected", "Sign out and back in with Google to grant the gmail.send permission, then try again.");
        return;
      }
      setSending(true);
      // Expand {{header}} into rendered HTML (with refNumber / projectName
      // / total inlined) JUST before send. See quotes-builder.js for
      // the full rationale. "receipt" selects the View Receipt CTA label.
      // Paragraph-wrap BEFORE injecting the header so the header's <table>
      // doesn't trip textToHtml's block-detection and collapse the body's
      // plain-text paragraph breaks; re-flatten {{signature}} to block level.
      var headerHtml = window.LTP_renderHeader("receipt", sendHeaderVars || {});
      var bodyWithHeader = window.LTP_injectBlock(window.LTP_textToHtml(String(sendMessage)), "{{header}}", headerHtml);
      bodyWithHeader = window.LTP_injectBlock(bodyWithHeader, "{{signature}}", "{{signature}}");
      fetch("/api/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "invoice",
          entityId: draft.id,
          to: (sendRecipients.to || []).join(", "),
          cc: (sendRecipients.cc || []).join(", ") || null,
          subject: sendSubject,
          bodyHtml: bodyWithHeader,  // already paragraph-wrapped HTML (see above)
          receipt: true,  // claim the receipt slot so the QB auto-receipt poller won't re-send
        }),
      })
        .then(function(r) { return r.json().then(function(body) { return { status: r.status, body: body }; }); })
        .then(function(resp) {
          setSending(false);
          if (resp.status === 200) {
            setShowReceiptModal(false);
            window.LTP_toast("Receipt Sent", { message: "Payment receipt sent to " + (sendRecipients.to || []).join(", ") + ((sendRecipients.cc || []).length ? " (+" + (sendRecipients.cc || []).length + " cc)" : "") + ".", variant: "success" });
            return;
          }
          if (resp.status === 409 && resp.body && resp.body.detail && resp.body.detail.reason === "reconnect") {
            showAlert("Reconnect Google", "Your Google connection no longer has Gmail send permission. Sign out and back in to reconnect.");
            return;
          }
          var msg = "Send failed (HTTP " + resp.status + ").";
          if (resp.body && resp.body.detail) {
            var d = resp.body.detail;
            if (typeof d === "string") msg = d;
            else if (d.error) msg = d.error;
            else if (d.reason) msg = d.reason;
          }
          showAlert("Send Failed", msg);
        })
        .catch(function(e) {
          setSending(false);
          showAlert("Send Failed", "Network or server error: " + String(e.message || e));
        });
    }

    function deletePayment(payId) {
      var updatedPayments = (draft.payments || []).filter(function(p) { return p.id !== payId; });
      var deletedPay = (draft.payments || []).find(function(p) { return p.id === payId; });
      var newTotal = updatedPayments.reduce(function(s, p) { return s + (Number(p.amount) || 0); }, 0);
      var invoiceTotal = t.total;
      var newStatus = draft.status;
      if (draft.status === "paid" && newTotal < invoiceTotal) { newStatus = newTotal > 0 ? "partial" : "sent"; }
      else if (draft.status === "partial" && newTotal === 0) { newStatus = "sent"; }
      var actEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0, 5),
        type: "saved", user: (window.LTP_CURRENT_USER || "User"), message: "Payment removed: $" + (deletedPay ? window.LTP_money(deletedPay.amount) : "?"),

        changes: [{ cat: "Payment Removed", detail: "$" + (deletedPay ? window.LTP_money(deletedPay.amount) : "?") + " via " + (deletedPay ? deletedPay.method : "?") }]
      };
      patchDraft({ payments: updatedPayments, status: newStatus, paidDate: newStatus === "paid" ? draft.paidDate : null, activity: (draft.activity || []).concat([actEntry]) });
      // Auto-save immediately (bypasses locked state)
      setTimeout(function() { autoSavePayment(); }, 50);
    }

    // ── Send Invoice ─────────────────────────────────────────────────────────
    function openSendModal() {
      // Validate before opening the modal
      var itemCount = draft.sections.reduce(function(n, s) { return n + s.items.filter(function(i) { return i.type !== "note"; }).length; }, 0);
      if (itemCount === 0) { showAlert("No Items", "Add at least one line item before sending."); return; }
      if (!draft.dueDate) { showAlert("No Due Date", "Set a due date before sending the invoice."); return; }
      if (!draft.companyId && !draft.clientContactId) { showAlert("No Client", "Select a company or contact before sending."); return; }
      var email = "";
      var clientName = "";
      if (draft.clientContactId) {
        var ct = contacts.find(function(c) { return c.id === draft.clientContactId; });
        if (ct) { email = ct.email || ""; clientName = ct.firstName + " " + ct.lastName; }
      } else if (draft.companyId) {
        var compContacts = contacts.filter(function(c) { return (c.companyIds || []).includes(draft.companyId); });
        if (compContacts.length > 0) { email = compContacts[0].email || ""; clientName = compContacts[0].firstName; }
      }
      var projName = selectedProject ? selectedProject.name : (draft.customName || "");
      var ref = draft.id != null ? window.LTP_INVOICE_REF(draft) : "Invoice";
      var resolve = window.LTP_resolveTemplate;
      var s = settings || {};
      // Draft = first send (Invoice Sent); any resend of an already-sent
      // invoice is a nudge, so it uses the Payment Reminder template.
      var templateKey = isDraft ? "invoiceSent" : "invoiceReminder";
      var tmpl = (s.emailTemplates || {})[templateKey] || {};
      // {{viewUrl}} and {{signature}} are intentionally LEFT unresolved here
      // — backend substitutes them per-recipient at send time. See the
      // corresponding comment in modules/quotes-builder.js openQuoteSendModal.
      var vars = {
        companyName: s.companyName || "LTP",
        refNumber: ref,
        projectName: projName,
        clientName: clientName || "there",
        total: "$" + window.LTP_money(t.total),
        dueDate: draft.dueDate ? fmt(draft.dueDate) : "Upon receipt",
      };
      setSendRecipients(initSendRecipients());
      setSendSubject(resolve(tmpl.subject || "{{refNumber}} — {{projectName}} from {{companyName}}", vars));
      setSendMessage(resolve(tmpl.body || "{{header}}\n\nHi {{clientName}},\n\nPlease find attached invoice {{refNumber}}.\n\nDue: {{dueDate}}\n\n{{signature}}", vars));
      // {{viewUrl}} stays literal — backend swaps in the per-recipient URL.
      // dueDate feeds the invoice-only due-date line in the header box (empty
      // when unset → the line is omitted).
      setSendHeaderVars({ refNumber: ref, projectName: projName, total: vars.total, dueDate: draft.dueDate ? fmt(draft.dueDate) : "" });
      setAttachPdf(true);  // default the PDF attachment ON for each invoice send
      setShowSendModal(true);
    }

    function executeSend() {
      if (!(sendRecipients.to || []).length) { showAlert("No Recipient", "Add at least one To recipient."); return; }
      if (draft.id == null || !draft.shareToken) { showAlert("Save First", "Save the invoice before sending so it has a stable share link."); return; }
      if (!window.LTP_GMAIL_CONNECTED) {
        showAlert("Gmail Not Connected", "Sign out and back in with Google to grant the gmail.send permission, then try again.");
        return;
      }
      // Sales tax is QuickBooks-authoritative, and the PDF the customer receives
      // is rendered server-side from the SAVED row (backend/routes/email.py) —
      // so the push that computes the tax has to land BEFORE the email goes out.
      // This used to run in the send's success handler, which mailed a
      // tax-exclusive PDF and only then learned the tax, leaving the customer's
      // copy permanently disagreeing with the app. Quotes already work this way
      // (modules/quotes-builder.js::executeSendQuote).
      var party = billingParty();
      var taxable = draft.clientType === "contact" ? !!party : !!(party && party.taxable);
      // `invoice.status` reaches the QuickBooks payload in exactly one place: a
      // draft that carries a sentDate is a RECALL, which prepends a warning line
      // to the QB invoice (backend/qbo_sync.py::build_invoice_payload). Pushing
      // BEFORE the send means that push still sees "draft", so a recalled invoice
      // has to be pushed again afterwards — once it is "sent" — to clear the
      // line. For every other invoice the second push is a no-op we can skip.
      var isRecalledDraft = draft.status === "draft" && !!String(draft.sentDate || "").trim();
      // A taxable invoice whose tax nobody can compute must not go out quietly
      // under-billed: without QuickBooks there is no tax figure at all, and the
      // customer's PDF would show a total the books later disagree with.
      if (taxable && !(isAdmin && qbConnected)) {
        showAlert("Sales Tax Unavailable",
          (qbConnected
            ? "This invoice is for a taxable customer, and only an admin can calculate its sales tax in QuickBooks."
            : "This invoice is for a taxable customer, and QuickBooks — which calculates the sales tax — is not connected.")
          + "\n\nThe invoice was NOT sent. "
          + (qbConnected ? "Ask an admin to send it, " : "Connect QuickBooks in Settings, ")
          + "or untick “Customer is taxable” if no tax applies.");
        return;
      }
      if (isAdmin && qbConnected && taxable) {
        setSending(true);
        persistAndPushQbo(draft, { quiet: true }).then(function(res) {
          if (!res || !res.ok) {
            setSending(false);
            // A taxable invoice must not go out with an unknown tax figure.
            showAlert("Sales Tax Unavailable",
              "QuickBooks calculates the sales tax on this invoice, and it could not be reached: "
              + ((res && res.error) || "unknown error")
              + "\n\nThe invoice was NOT sent. Fix the QuickBooks connection and send again, "
              + "or untick “Customer is taxable” if no tax applies.");
            return;
          }
          // Hand the send what it needs to undo this push if the email fails.
          sendInvoiceEmail(res.invoice, !isRecalledDraft,
            res.action === "created" ? res.qbInvoiceId : null);
        });
        return;
      }
      sendInvoiceEmail(draft, false);
    }

    // Build + POST the invoice email for `baseDraft` (the freshest invoice,
    // which carries the just-pushed qbTaxTotal). Kept separate from executeSend
    // so the QuickBooks push can resolve first. `alreadyPushed` suppresses the
    // redundant post-send export for invoices we pushed on the way in.
    // `unwindableQbId` is the QB invoice this send CREATED moments ago — passed
    // only for a create, and used to delete it again if the send fails, so a
    // failure leaves nothing stranded in QuickBooks (see unwindQboPush).
    function sendInvoiceEmail(baseDraft, alreadyPushed, unwindableQbId) {
      var isResend = baseDraft.status !== "draft";
      setSending(true);
      // Expand {{header}} into rendered HTML JUST before send. See
      // quotes-builder.js for the full rationale on this split.
      // "invoice" selects the View & Download CTA label.
      // Paragraph-wrap BEFORE injecting the header so the header's <table>
      // doesn't trip textToHtml's block-detection and collapse the body's
      // plain-text paragraph breaks; re-flatten {{signature}} to block level.
      // Re-derive the header total from baseDraft so the emailed figure includes
      // the tax QuickBooks just returned — sendHeaderVars was built when the
      // modal opened, before the push.
      var hv = sendHeaderVars || {};
      if (sendHeaderVars) {
        var nt = window.LTP_INVOICE_TOTALS(baseDraft);
        hv = Object.assign({}, sendHeaderVars, { total: "$" + window.LTP_money(nt.total) });
      }
      var headerHtml = window.LTP_renderHeader("invoice", hv);
      var bodyWithHeader = window.LTP_injectBlock(window.LTP_textToHtml(String(sendMessage)), "{{header}}", headerHtml);
      bodyWithHeader = window.LTP_injectBlock(bodyWithHeader, "{{signature}}", "{{signature}}");
      fetch("/api/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "invoice",
          entityId: baseDraft.id,
          to: (sendRecipients.to || []).join(", "),
          cc: (sendRecipients.cc || []).join(", ") || null,
          subject: sendSubject,
          bodyHtml: bodyWithHeader,  // already paragraph-wrapped HTML (see above)
          attachPdf: attachPdf,  // backend attaches the freshly-generated invoice PDF
        }),
      })
        .then(function(r) { return r.json().then(function(body) { return { status: r.status, body: body }; }); })
        .then(function(resp) {
          setSending(false);
          if (resp.status === 200) {
            var today = todayISO();
            var updated = Object.assign({}, baseDraft, {
              status: isResend ? baseDraft.status : "sent",
              sentDate: isResend ? baseDraft.sentDate : today,
              sendRecipients: sendRecipients,  // remember who this went to
            });
            setInvoices(function(prev) { return prev.map(function(i) { return i.id === updated.id ? updated : i; }); });
            setDraftRaw(updated); cleanRef.current = updated; setIsDirty(false);
            // Auto-export to QuickBooks on every send (first time + resends).
            // Skipped when we already pushed on the way in to price the tax —
            // that export is done and re-pushing would be a wasted round-trip.
            if (isAdmin && qbConnected && !alreadyPushed) { persistAndPushQbo(updated); }
            setShowSendModal(false);
            window.LTP_toast(isResend ? "Invoice Resent" : "Invoice Sent", { message: "Invoice " + (isResend ? "resent" : "sent") + " to " + (sendRecipients.to || []).join(", ") + ((sendRecipients.cc || []).length ? " (+" + (sendRecipients.cc || []).length + " cc)" : "") + ".", variant: "success" });
            return;
          }
          // Our own server answered, so the email definitively did not go out:
          // /api/email/send validates before sending and rolls its recipient
          // rows back on both Gmail failure paths (backend/routes/email.py).
          // That makes it safe to undo the QuickBooks invoice this send created.
          if (resp.status === 409 && resp.body && resp.body.detail && resp.body.detail.reason === "reconnect") {
            unwindQboPush(baseDraft, unwindableQbId, function(tail) {
              showAlert("Reconnect Google",
                "Your Google connection no longer has Gmail send permission. Sign out and back in to reconnect." + tail);
            });
            return;
          }
          var msg = "Send failed (HTTP " + resp.status + ").";
          if (resp.body && resp.body.detail) {
            var d = resp.body.detail;
            if (typeof d === "string") msg = d;
            else if (d.error) msg = d.error;
            else if (d.reason) msg = d.reason;
          }
          unwindQboPush(baseDraft, unwindableQbId, function(tail) { showAlert("Send Failed", msg + tail); });
        })
        .catch(function(e) {
          setSending(false);
          // A network error is NOT proof the send didn't happen — the server may
          // have sent and the response been lost. Deleting the QuickBooks invoice
          // here could erase one the customer is holding, so report what exists
          // instead of guessing.
          showAlert("Send Failed", "Network or server error: " + String(e.message || e)
            + (unwindableQbId
                ? "\n\nThis invoice WAS exported to QuickBooks before the error, and we cannot tell whether the email went out. "
                  + "Check with the recipient before resending — sending again updates that same QuickBooks invoice rather than duplicating it."
                : ""));
        });
    }

    // Delete the QuickBooks invoice a failed send created, so the failure leaves
    // nothing to clean up by hand. Only ever called with a CREATE's id (an
    // update's record pre-existed and isn't ours to delete) and only when the
    // server told us the send didn't happen. Always calls back — with a sentence
    // to append to the failure dialog saying what became of the QuickBooks
    // invoice — so a failed unwind is reported rather than silently stranded.
    function unwindQboPush(invoiceObj, qbInvoiceId, done) {
      if (!qbInvoiceId) { done(""); return; }
      var stranded = function(why) {
        return "\n\nWARNING: this invoice WAS exported to QuickBooks (id " + qbInvoiceId
          + ") and could not be removed automatically: " + why
          + "\nDelete it in QuickBooks, or use Remove from QuickBooks here.";
      };
      fetch("/api/qbo/invoices/" + invoiceObj.id + "/unwind-send", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ qbInvoiceId: String(qbInvoiceId) }),
      })
        .then(function(r) { return r.json().then(function(b) { return { status: r.status, body: b }; }); })
        .then(function(resp) {
          if (resp.status === 200 && resp.body && resp.body.unwound) {
            // Mirror the cleared link locally so the UI stops claiming a sync
            // that no longer exists.
            var cleared = Object.assign({}, invoiceObj, {
              qbInvoiceId: null, qbSyncToken: null, qbSyncStatus: null, qbSyncedAt: null,
              qbSyncedSignature: null, qbLastError: null, qbTaxTotal: null, qbTotalAmt: null,
            });
            setInvoices(function(prev) { return prev.map(function(i) { return i.id === cleared.id ? cleared : i; }); });
            setDraftRaw(function(d) { return (d && d.id === cleared.id) ? cleared : d; });
            if (cleanRef.current && cleanRef.current.id === cleared.id) cleanRef.current = cleared;
            done("\n\nNothing was left behind in QuickBooks — the export was undone automatically.");
            return;
          }
          done(stranded((resp.body && resp.body.error) || ("HTTP " + resp.status)));
        })
        .catch(function(e) { done(stranded(String(e.message || e))); });
    }

    function recallToDraft() {
      if (isDraft) return;
      // Check the PERSISTED row as well as the draft. This guard exists to stop
      // a recall from writing a payment-free record over one that has payments,
      // and consulting only the in-memory draft made it trust the very state
      // that could be wrong: a Discard against a stale baseline produced a
      // payment-free draft, the guard passed, and onConfirm below wrote it
      // through. The autoSavePayment fix removes that path, but a guard
      // protecting money should not depend on another function staying correct.
      var persisted = (invoices || []).find(function(i) { return i.id === draft.id; });
      var hasPayments = (draft.payments || []).length > 0
        || ((persisted && persisted.payments) || []).length > 0;
      if (hasPayments) {
        showAlert("Cannot Recall", "This invoice has recorded payments. Remove all payments before recalling to draft.");
        return;
      }
      var sentTo = "";
      (draft.activity || []).forEach(function(a) {
        if (a.type === "sent" && a.changes) {
          a.changes.forEach(function(ch) { if (ch.cat === "Sent To") sentTo = ch.detail; });
        }
      });
      var sentDate = draft.sentDate ? fmt(draft.sentDate) : "";
      setDlg({
        title: "Recall Invoice to Draft",
        message: "This invoice was sent" + (sentTo ? " to " + sentTo : "") + (sentDate ? " on " + sentDate : "") + ".\n\nRecalling will unlock it for editing. The client may have already viewed or printed a copy. You will need to resend the corrected invoice after making changes.",
        variant: "danger",
        confirmLabel: "Recall to Draft",
        onConfirm: function() {
          var actEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0, 5),
            type: "status", user: (window.LTP_CURRENT_USER || "User"), message: "Invoice recalled to draft for editing",

            changes: [{ cat: "Status", detail: draft.status + " \u2192 draft" }, { cat: "Reason", detail: "Recalled for corrections" }]
          };
          var updated = Object.assign({}, draft, { status: "draft", activity: (draft.activity || []).concat([actEntry]) });
          if (draft.id != null) { setInvoices(function(prev) { return prev.map(function(i) { return i.id === updated.id ? updated : i; }); }); }
          setDraftRaw(updated); cleanRef.current = updated; setIsDirty(false);
          // Immediately push the recall notice to QuickBooks (only if already exported there).
          if (isAdmin && qbConnected && updated.qbInvoiceId) { persistAndPushQbo(updated); }
          setDlg(null);
        }
      });
    }

    // ── QuickBooks Online ────────────────────────────────────────────────
    // Updates are explicit (this button). It only renders when the invoice is
    // out of sync — see qbOutOfSync below. We send the live change-signature so
    // the server can record it; qb* fields are server-authoritative and we only
    // patch them locally for an optimistic display. qbSig is assigned during
    // render (hoisted var) and holds the value as of the click.
    var qbSig = "";
    function sendToQuickBooks() {
      if (draft.id == null) { window.LTP_toast("Save first", { message: "Save the invoice before sending it to QuickBooks.", variant: "warn" }); return; }
      if (!draft.sentDate && !draft.qbInvoiceId) { window.LTP_toast("Send the invoice first", { message: "Invoices export to QuickBooks once they've been sent.", variant: "warn" }); return; }
      if (!isAdmin) { window.LTP_toast("Admin only", { message: "Only an admin can push invoices to QuickBooks.", variant: "warn" }); return; }
      if (!qbo || !qbo.connected) { window.LTP_toast("QuickBooks not connected", { message: "An admin must connect QuickBooks in Settings before pushing invoices.", variant: "warn" }); return; }
      setQboSyncing(true);
      fetch("/api/qbo/invoices/" + draft.id + "/push", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ signature: qbSig })
      })
        .then(function(r) { return r.json().then(function(body) { return { status: r.status, body: body }; }); })
        .then(function(resp) {
          setQboSyncing(false);
          if (resp.status === 200) {
            var b = resp.body || {};
            var updated = Object.assign({}, draft, {
              qbInvoiceId: b.qbInvoiceId, qbSyncToken: b.qbSyncToken, qbSyncStatus: "synced",
              qbSyncedAt: b.qbSyncedAt, qbTaxTotal: b.qbTaxTotal, qbTotalAmt: b.qbTotalAmt, qbLastError: null,
              qbSyncedSignature: b.qbSyncedSignature != null ? b.qbSyncedSignature : qbSig
            });
            setInvoices(function(prev) { return prev.map(function(i) { return i.id === updated.id ? updated : i; }); });
            setDraftRaw(updated); cleanRef.current = updated; setIsDirty(false);
            window.LTP_toast(b.action === "created" ? "Sent to QuickBooks" : "Updated in QuickBooks", {
              message: "Invoice " + (b.action === "created" ? "created in" : "updated in") + " QuickBooks"
                + (b.qbTaxTotal ? " — sales tax " + money2(b.qbTaxTotal) + " calculated by QuickBooks." : "."),
              variant: "success" });
            return;
          }
          var d = resp.body || {};
          if (resp.status === 409 && d.reason === "reconnect") { window.LTP_toast("Reconnect QuickBooks", { message: "The QuickBooks connection expired. An admin should reconnect it in Settings.", variant: "error" }); return; }
          if (resp.status === 409 && d.reason === "not_connected") { window.LTP_toast("QuickBooks not connected", { message: "An admin must connect QuickBooks in Settings first.", variant: "warn" }); return; }
          window.LTP_toast("QuickBooks sync failed", { message: d.error || ("HTTP " + resp.status + "."), variant: "error" });
        })
        .catch(function(e) { setQboSyncing(false); window.LTP_toast("QuickBooks sync failed", { message: "Network or server error: " + String(e.message || e), variant: "error" }); });
    }

    // Persist the invoice, THEN export/update it in QuickBooks. Used by the
    // auto-export on send and the recall auto-push: the push reads the invoice
    // from the server, so the new status/sentDate must be saved first (e.g. the
    // recall banner depends on the persisted status=draft). Best-effort — a sync
    // failure toasts but never blocks the send/recall.
    // Saves the invoice, then pushes it to QuickBooks. Resolves to
    // { ok, invoice, reason, error } so the SEND path can gate on the result —
    // QuickBooks owns the sales tax number, and the PDF the customer receives is
    // rendered server-side from the saved row, so a send that outruns this push
    // mails a tax-exclusive PDF that the app then contradicts.
    // `opts.quiet` suppresses the toasts for callers that report failure
    // themselves (the send path shows a blocking dialog instead).
    function persistAndPushQbo(invoiceObj, opts) {
      opts = opts || {};
      var party = (invoiceObj.clientType === "contact")
        ? (invoiceObj.clientContactId ? contacts.find(function(c) { return c.id === invoiceObj.clientContactId; }) : null)
        : (invoiceObj.companyId ? companies.find(function(c) { return c.id === invoiceObj.companyId; }) : null);
      var proj = invoiceObj.projectId ? projects.find(function(p) { return p.id === invoiceObj.projectId; }) : null;
      var taxable = invoiceObj.clientType === "contact" ? !!party : !!(party && party.taxable);
      var sig = qbSignature(invoiceObj, party, proj, taxable);
      return fetch("/api/invoices/" + invoiceObj.id, { method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(invoiceObj) })
        .then(function(r) { if (!r.ok) throw new Error("save failed (" + r.status + ")"); })
        .then(function() {
          return fetch("/api/qbo/invoices/" + invoiceObj.id + "/push", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ signature: sig }) });
        })
        .then(function(r) { return r.json().then(function(b) { return { status: r.status, body: b }; }); })
        .then(function(resp) {
          if (resp.status === 200) {
            var b = resp.body || {};
            var withQb = Object.assign({}, invoiceObj, {
              qbInvoiceId: b.qbInvoiceId, qbSyncToken: b.qbSyncToken, qbSyncStatus: "synced",
              qbSyncedAt: b.qbSyncedAt, qbTaxTotal: b.qbTaxTotal, qbTotalAmt: b.qbTotalAmt, qbLastError: null,
              qbSyncedSignature: b.qbSyncedSignature != null ? b.qbSyncedSignature : sig
            });
            setInvoices(function(prev) { return prev.map(function(i) { return i.id === withQb.id ? withQb : i; }); });
            setDraftRaw(function(d) { return (d && d.id === withQb.id) ? withQb : d; });
            if (cleanRef.current && cleanRef.current.id === withQb.id) cleanRef.current = withQb;
            if (!opts.quiet) {
              window.LTP_toast(b.action === "created" ? "Exported to QuickBooks" : "Updated in QuickBooks",
                { variant: "success", message: b.qbTaxTotal ? "Sales tax " + money2(b.qbTaxTotal) + " calculated by QuickBooks." : "" });
            }
            // `action` decides whether a failed send may unwind this push: only
            // a create is ours to delete. An update means the QB invoice existed
            // before this send (a resend, or an earlier push) — deleting it
            // would destroy a record the customer may already hold.
            return { ok: true, invoice: withQb, action: b.action, qbInvoiceId: b.qbInvoiceId };
          }
          var d = resp.body || {};
          if (resp.status === 409 && d.reason === "reconnect") {
            if (!opts.quiet) window.LTP_toast("QuickBooks needs reconnect", { message: "The invoice sent, but couldn't sync to QuickBooks — reconnect it in Settings.", variant: "error" });
            return { ok: false, reason: "reconnect", error: d.error || "The QuickBooks connection expired. Reconnect it in Settings." };
          }
          if (resp.status === 409 && d.reason === "not_connected") {
            return { ok: false, reason: "not_connected", error: d.error || "QuickBooks is not connected." };
          }
          if (!opts.quiet) window.LTP_toast("QuickBooks sync failed", { message: (d.error || ("HTTP " + resp.status)) + " — open the invoice and use Update QuickBooks to retry.", variant: "error" });
          return { ok: false, reason: d.reason || "error", error: d.error || ("HTTP " + resp.status) };
        })
        .catch(function(e) {
          if (!opts.quiet) window.LTP_toast("QuickBooks sync failed", { message: "Network or server error: " + String(e.message || e), variant: "error" });
          return { ok: false, reason: "network", error: "Network or server error: " + String(e.message || e) };
        });
    }

    function billingParty() {
      if (draft.clientType === "contact") return draft.clientContactId ? contacts.find(function(c) { return c.id === draft.clientContactId; }) : null;
      return draft.companyId ? companies.find(function(c) { return c.id === draft.companyId; }) : null;
    }
    // Tax is a COMPANY-level flag (with per-line overrides). Toggling it edits
    // the selected company so QuickBooks taxes their invoices. Contacts billed
    // directly are always tax-exempt, so there's nothing to toggle for them.
    function setCustomerTaxable(val) {
      if (draft.companyId && setCompanies) {
        setCompanies(function(prev) { return prev.map(function(c) { return c.id === draft.companyId ? Object.assign({}, c, { taxable: val }) : c; }); });
      }
    }

    useEffect(function() { setDraftRaw(initial); cleanRef.current = initial; setIsDirty(false); pendingRollbacks.current = []; }, [invoiceId, isNew]);

    // Informational / validation notice as a non-blocking toast (modals are
    // reserved for confirm/cancel decisions). Variant defaults to "error";
    // pass "info" for advisory notices.
    function showAlert(title, msg, variant) { window.LTP_toast(title, { message: msg, variant: variant || "error" }); }

    var isDraft = draft.status === "draft";
    var isLocked = !isDraft; // Invoices locked once sent — must recall to draft to edit
    var refDisplay = draft.id != null ? window.LTP_INVOICE_REF(draft) : "INV-NEW";
    var selectedProject = draft.projectId ? projects.find(function(p) { return p.id === draft.projectId; }) : null;
    var selectedCompany = draft.companyId ? companies.find(function(c) { return c.id === draft.companyId; }) : null;
    // The rate card AS THIS CLIENT SEES IT — negotiated overrides folded in, so
    // a service added or re-tiered here prices exactly as it did on the quote
    // this invoice came from (theme.js::LTP_servicesForClient).
    var svcs = React.useMemo(function() {
      return window.LTP_servicesForClient(services, clientRates,
        window.LTP_clientRef({ clientType: draft.clientType, companyId: draft.companyId, clientContactId: draft.clientContactId }));
    }, [services, clientRates, draft.clientType, draft.companyId, draft.clientContactId]);
    var displayName = selectedProject ? selectedProject.name : (draft.customName || "New Invoice");
    var linkedQuote = draft.quoteId ? quotes.find(function(q) { return q.id === draft.quoteId; }) : null;
    // Every project this invoice bills work for, primary first. More than one
    // when a schedule (or a quote) from another job was added to it.
    var docProjects = window.LTP_docProjectIds(draft).map(function(id) {
      var p = (projects || []).find(function(x) { return x.id === id; });
      return p || { id: id, name: "Project " + id };
    });
    var t = window.LTP_INVOICE_TOTALS(draft);

    // QuickBooks display state. Directly-billed contacts are always taxable;
    // companies use their own taxable flag.
    var custParty = billingParty();
    var customerTaxable = draft.clientType === "contact" ? !!custParty : !!(custParty && custParty.taxable);
    var qbConnected = !!(qbo && qbo.connected);
    // "Out of sync" = not pushed yet, OR the live change-signature differs from
    // the one stored at the last push (captures invoice + customer + project
    // changes). qbSig is hoisted, so sendToQuickBooks reads the current value.
    qbSig = qbConnected ? qbSignature(draft, custParty, selectedProject, customerTaxable) : "";
    var qbOutOfSync = !draft.qbInvoiceId || qbSig !== (draft.qbSyncedSignature || "");
    // QB status/controls only apply once the invoice has been sent (export is
    // gated to sent — see item 5; auto-export happens on send).
    var qbEligible = !!(draft.sentDate || draft.qbInvoiceId);
    var qbPill = null;
    if (draft.id != null && qbConnected && qbEligible) {
      if (!draft.qbInvoiceId) qbPill = { label: "Not in QuickBooks", color: B.textMut };
      else if (draft.qbSyncStatus === "error") qbPill = { label: "QB sync error", color: B.danger };
      else if (qbOutOfSync) qbPill = { label: "QB update needed", color: B.warn };
      else qbPill = { label: "✓ In QuickBooks", color: B.success };
    }
    // Deep link to the invoice inside QuickBooks (host depends on environment).
    var qbInvoiceUrl = (draft.qbInvoiceId && qbo)
      ? ((qbo.environment === "production" ? "https://app.qbo.intuit.com" : "https://app.sandbox.qbo.intuit.com") + "/app/invoice?txnId=" + draft.qbInvoiceId)
      : null;
    // Invoice totals always show exact cents — line items can carry fractional
    // quantities, and QuickBooks tax is itself cent-precise.
    var fmtT = money2;

    // Section helpers
    function updateItem(secId, itemId, patch) {
      if (!isDraft) return;
      setDraft(function(d) {
        return Object.assign({}, d, { sections: S.patchItem(d.sections, secId, itemId, function(i) {
          var effective = Object.assign({}, patch);
          // Clamp linkedQty when qty drops below it — qty added on top of
          // linkedQty is "direct" and reducing back through it doesn't
          // touch the source quote's invoicedQty. See sendToInvoice for
          // the model. Invoice-only rule, so it stays here rather than in
          // the shared transform.
          if (patch.qty != null && i.sourceItemId) {
            var newQty = Number(patch.qty) || 0;
            var oldLinked = i.linkedQty != null ? Number(i.linkedQty) : (Number(i.qty) || 0);
            effective.linkedQty = Math.min(newQty, oldLinked);
          }
          return effective;
        }) });
      });
    }
    // Which quote a converted line draws against. An invoice can gather lines
    // from several of a client's quotes (the send-to-invoice picker offers any
    // of their draft invoices, whatever project it started on), so the line's
    // own sourceQuoteId is authoritative; `draft.quoteId` is the fallback for
    // lines converted before that field existed. Returns null for a direct
    // bill — a hand-added line or one generated from a project schedule.
    function sourceQuoteOf(it) {
      if (!it || !it.sourceItemId) return null;
      if (it.sourceQuoteId != null) return it.sourceQuoteId;
      return draft.quoteId != null ? draft.quoteId : null;
    }

    function deleteItem(secId, itemId) {
      if (!isDraft) return;
      // Track deleted linked items for quote rollback on save
      (draft.sections || []).forEach(function(sec) {
        if (sec.id !== secId) return;
        (sec.items || []).forEach(function(it) {
          var srcQuote = sourceQuoteOf(it);
          if (it.id === itemId && srcQuote != null) {
            // Only the linked portion (capped at original conversion qty)
            // counts against the quote; legacy items without linkedQty fall
            // back to the full qty.
            var linked = it.linkedQty != null ? (Number(it.linkedQty) || 0) : (Number(it.qty) || 0);
            pendingRollbacks.current.push({ quoteId: srcQuote, sourceItemId: it.sourceItemId, qty: linked, name: it.name || "" });
          }
        });
      });
      // Remove item from draft
      setDraft(function(d) {
        return Object.assign({}, d, { sections: S.removeItem(d.sections, secId, itemId) });
      });
    }
    function addItemToSection(secId, item) {
      if (!isDraft) return;
      setDraft(function(d) {
        return Object.assign({}, d, { sections: S.addItem(d.sections, secId, item) });
      });
    }
    function addSection() {
      if (!isDraft) return;
      setDraft(function(d) {
        return Object.assign({}, d, { sections: d.sections.concat([{ id: genId("sec"), label: "New Section", customDates: false, startDate: "", endDate: "", items: [] }]) });
      });
    }
    function updateSectionLabel(secId, label) {
      if (!isDraft) return;
      setDraft(function(d) {
        return Object.assign({}, d, { sections: S.patchSection(d.sections, secId, { label: label }) });
      });
    }
    function deleteSection(secId) {
      if (!isDraft) return;
      if (draft.sections.length <= 1) { showAlert("Cannot Delete", "Invoice must have at least one section."); return; }
      setDraft(function(d) { return Object.assign({}, d, { sections: S.removeSection(d.sections, secId) }); });
    }

    // Single-step section reorder — swap a section with its neighbour. Drives
    // the ▲▼ buttons in each section header on mobile and the ↑/↓ keys on a
    // focused desktop grab handle.
    function moveSection(secId, dir) {
      if (!isDraft) return;
      setDraft(function(d) {
        var secs = S.nudgeSection(d.sections, secId, dir);
        return secs === d.sections ? d : Object.assign({}, d, { sections: secs });
      });
    }

    // Same, one line item at a time within its section.
    function moveItem(secId, itemId, dir) {
      if (!isDraft) return;
      setDraft(function(d) {
        return Object.assign({}, d, { sections: S.nudgeItem(d.sections, secId, itemId, dir) });
      });
    }

    // ── Reorder engine (components/sortable.js) ────────────────────────────
    // Matches the quote builder: pointer drag with the list reordering live
    // under the cursor on desktop/iPad, ▲▼ buttons on phones. Only draft
    // invoices reorder — once issued the line order is part of the document.
    var sortSnapshot = useRef(null);   // section order at pick-up, for Escape
    var sortable = window.LTP_useSortable({
      enabled: !isMobile && isDraft,
      onMove: function(m) { sortMove(m); },
      onDragStart: function() { sortSnapshot.current = draft.sections; },
      onDrop: function() { sortSnapshot.current = null; },
      onCancel: function() {
        var snap = sortSnapshot.current;
        sortSnapshot.current = null;
        if (snap) setDraft(function(d) { return Object.assign({}, d, { sections: snap }); });
      },
      onKeyMove: function(kind, zoneId, id, dir) {
        if (kind === "section") moveSection(id, dir);
        else moveItem(zoneId, id, dir);
      },
    });

    // Applied on every hit-test while a row is in flight (not once on release),
    // which is what makes the list its own drop preview. `m` is
    // { kind, id, fromZone, toZone, targetId, after }; a null targetId means
    // "append to toZone" (released over a section's empty space).
    function sortMove(m) {
      if (!isDraft) return;
      setDraft(function(d) {
        var secs = window.LTP_applySortMove(d.sections, m);
        return secs === d.sections ? d : Object.assign({}, d, { sections: secs });
      });
    }

    // Mobile ▲▼ taps go through the sortable's FLIP so rows slide into place
    // instead of snapping — the drag's motion, with no extra screen space.
    function moveItemAnimated(secId, itemId, dir) {
      sortable.animate(function() { moveItem(secId, itemId, dir); }, "item");
    }
    function moveSectionAnimated(secId, dir) {
      sortable.animate(function() { moveSection(secId, dir); }, "section");
    }

    // Section totals
    // Shared with modules/quotes-builder.js — see components/domain-docs.js.
    // Returns { subtotal, cost, margin }; this builder reads subtotal only.
    var sectionTotals = window.LTP_sectionTotals;

    // Actions

    // Auto-save after payment recording — bypasses lock since payments are operational, not edits
    function autoSavePayment() {
      setDraftRaw(function(cur) {
        setInvoices(function(prev) {
          if (cur.id == null) return prev;
          return prev.map(function(inv) { return inv.id === cur.id ? Object.assign({}, cur) : inv; });
        });
        // Advance the discard baseline too. Every other commit path pairs
        // setDraftRaw/setIsDirty(false) with this (see :792, :1155, :1262,
        // :1298, :1842, :1850); this one did not, so cleanRef kept the
        // PRE-payment snapshot for as long as the editor stayed open.
        // Discard is gated on isDirty alone — no !isLocked, unlike Save — so
        // dirtying any un-gated field (Notes) on a locked invoice and hitting
        // Discard reset the draft to that stale snapshot and the payment
        // vanished from the editor. It was still in the persisted row, so the
        // next path that wrote the draft over it (recallToDraft below) made
        // the loss permanent. This is the state that WAS persisted, so it is
        // the correct baseline.
        cleanRef.current = cur;
        setIsDirty(false);
        return cur;
      });
    }

    function save() {
      // Date sanity checks
      if (draft.dueDate && draft.invoiceDate && draft.dueDate < draft.invoiceDate) {
        showAlert("Invalid Dates", "Due date (" + fmt(draft.dueDate) + ") is before the invoice date (" + fmt(draft.invoiceDate) + "). Please fix before saving.");
        return;
      }
      var changes = window.LTP_invoiceChanges(cleanRef.current, draft, projects, companies);
      var changeCount = changes ? changes.length : 0;
      var saveMsg = "Invoice saved" + (changeCount > 0 ? " (" + changeCount + " change" + (changeCount > 1 ? "s" : "") + ")" : "");
      var saveEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0,5), type: "saved", message: saveMsg, user: (window.LTP_CURRENT_USER || "User"), changes: changes };

      // Process rollbacks — reduce invoicedQty on source quote items.
      // Two sources contribute: explicit deletes (pendingRollbacks, pushed by
      // deleteItem) and linkedQty decreases (diffed against the last-saved
      // snapshot in cleanRef). Only the LINKED portion of an invoice line
      // counts against the quote — direct qty added on top of linkedQty is
      // a free-form bill and never touches the source quote.
      function linkedOf(it) {
        if (it.linkedQty != null) return Number(it.linkedQty) || 0;
        return Number(it.qty) || 0;  // legacy items predating linkedQty
      }
      var rollbacks = pendingRollbacks.current.slice();
      var cleanSnap = cleanRef.current || {};
      if (Array.isArray(cleanSnap.sections)) {
        var cleanLinkedItems = {};
        cleanSnap.sections.forEach(function(sec) {
          (sec.items || []).forEach(function(it) {
            if (it.type !== "note" && it.sourceItemId) cleanLinkedItems[it.id] = it;
          });
        });
        var draftLinkedItems = {};
        (draft.sections || []).forEach(function(sec) {
          (sec.items || []).forEach(function(it) {
            if (it.type !== "note" && it.sourceItemId) draftLinkedItems[it.id] = it;
          });
        });
        Object.keys(cleanLinkedItems).forEach(function(itemId) {
          // Deletes are already covered by pendingRollbacks; skip here to avoid double-counting.
          if (!(itemId in draftLinkedItems)) return;
          var srcQuote = sourceQuoteOf(cleanLinkedItems[itemId]);
          if (srcQuote == null) return;
          var oldLinked = linkedOf(cleanLinkedItems[itemId]);
          var newLinked = linkedOf(draftLinkedItems[itemId]);
          var delta = oldLinked - newLinked;
          if (delta > 0) {
            rollbacks.push({ quoteId: srcQuote, sourceItemId: cleanLinkedItems[itemId].sourceItemId,
                             qty: delta, name: cleanLinkedItems[itemId].name || "" });
          }
        });
      }
      if (rollbacks.length > 0 && setQuotes) {
        // Group by SOURCE QUOTE, not by this invoice's quoteId \u2014 an invoice
        // that gathered lines from several quotes has to credit each one back
        // its own quantities, or that quote stays permanently marked invoiced.
        var byQuote = {};            // quoteId \u2192 { itemId: qtyReduced }
        var detailsByQuote = {};     // quoteId \u2192 [{cat, detail}]
        rollbacks.forEach(function(rb) {
          if (!(rb.qty > 0) || rb.quoteId == null) return;
          var k = String(rb.quoteId);
          (byQuote[k] = byQuote[k] || {});
          byQuote[k][rb.sourceItemId] = (byQuote[k][rb.sourceItemId] || 0) + rb.qty;
          (detailsByQuote[k] = detailsByQuote[k] || []).push({ cat: "Invoiced Qty Reduced", detail: (rb.name || "Item") + ": -" + rb.qty });
        });
        if (Object.keys(byQuote).length > 0) {
          setQuotes(function(prevQuotes) {
            return prevQuotes.map(function(q) {
              var reductions = byQuote[String(q.id)];
              if (!reductions) return q;
              var details = detailsByQuote[String(q.id)].slice();
              var updatedSections = (q.sections || []).map(function(sec) {
                return Object.assign({}, sec, { items: (sec.items || []).map(function(qi) {
                  if (!reductions[qi.id]) return qi;
                  return Object.assign({}, qi, { invoicedQty: Math.max(0, (Number(qi.invoicedQty) || 0) - reductions[qi.id]) });
                })});
              });
              var newStatus = q.status === "converted" ? "accepted" : q.status;
              if (newStatus !== q.status) details.push({ cat: "Status", detail: q.status + " \u2192 " + newStatus });
              var actEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0,5),
                type: "invoiced", user: (window.LTP_CURRENT_USER || "User"), message: "Invoiced quantities reduced from " + refDisplay,
                changes: details };
              return Object.assign({}, q, { sections: updatedSections, status: newStatus, activity: (q.activity || []).concat([actEntry]) });
            });
          });
        }
      }
      pendingRollbacks.current = [];

      if (draft.id == null) {
        var newId = getNextInvoiceId();
        // Client-mint shareToken so the Preview button appears immediately;
        // backend respects a client-supplied token. See theme.js LTP_genShareToken.
        var newToken = draft.shareToken || window.LTP_genShareToken();
        var toSave = Object.assign({}, draft, { id: newId, shareToken: newToken, activity: (draft.activity || []).concat([saveEntry]) });
        setInvoices(function(prev) { return prev.concat([toSave]); });
        setDraftRaw(toSave); cleanRef.current = toSave; setIsDirty(false);
        nav("invoices/" + newId);
      } else {
        // Backfill shareToken on older invoices that pre-date the column.
        var existingPatch = { activity: (draft.activity || []).concat([saveEntry]) };
        if (!draft.shareToken) existingPatch.shareToken = window.LTP_genShareToken();
        var updated = Object.assign({}, draft, existingPatch);
        setInvoices(function(prev) { return prev.map(function(i) { return i.id === updated.id ? updated : i; }); });
        setDraftRaw(updated); cleanRef.current = updated; setIsDirty(false);
      }
      setJustSaved(true); setTimeout(function() { setJustSaved(false); }, 2200);
    }

    function discard() {
      setDlg({ title: "Discard Changes", message: "Reset all unsaved changes?", variant: "danger", confirmLabel: "Discard",
        onConfirm: function() { setDraftRaw(cleanRef.current); setIsDirty(false); pendingRollbacks.current = []; setDlg(null); } });
    }

    function deleteInvoice() {
      if (draft.id == null) return;
      var hasPayments = (draft.payments || []).length > 0;
      var paymentWarning = hasPayments
        ? "\n\nThis invoice has " + draft.payments.length + " recorded payment" + (draft.payments.length > 1 ? "s" : "") + " totaling $" + window.LTP_money((draft.payments || []).reduce(function(s, p) { return s + (Number(p.amount) || 0); }, 0)) + ". Deleting will erase the payment records."
        : "";
      var qbWarning = draft.qbInvoiceId ? "\n\nThis invoice will also be deleted from QuickBooks." : "";
      // Count the DISTINCT quotes this invoice draws from — it can be more than
      // one, so "the source quote" isn't always accurate.
      var srcQuoteCount = (function() {
        var seen = {};
        (draft.sections || []).forEach(function(sec) {
          (sec.items || []).forEach(function(it) {
            var sq = sourceQuoteOf(it);
            if (sq != null) seen[String(sq)] = true;
          });
        });
        return Object.keys(seen).length;
      })();
      var quoteWarning = srcQuoteCount > 0
        ? " This will reduce invoiced quantities on " + (srcQuoteCount === 1 ? "the source quote" : srcQuoteCount + " source quotes") + "."
        : "";
      setDlg({ title: "Delete Invoice", message: "Permanently delete " + refDisplay + "?" + quoteWarning + qbWarning + paymentWarning, variant: "danger", confirmLabel: hasPayments ? "Delete with Payments" : "Delete",
        onConfirm: function() {
          // For a synced invoice, delete it from QuickBooks FIRST; only remove
          // it locally if that succeeds, so we never orphan it in QuickBooks.
          if (draft.qbInvoiceId) {
            fetch("/api/qbo/invoices/" + draft.id + "/delete", { method: "POST", credentials: "include" })
              .then(function(r) { return r.json().then(function(body) { return { status: r.status, body: body }; }); })
              .then(function(resp) {
                if (resp.status === 200) {
                  if (resp.body && resp.body.deleted) window.LTP_toast("Deleted from QuickBooks", { variant: "success" });
                  doLocalDelete();
                } else {
                  window.LTP_toast("Not deleted — still in QuickBooks", { message: ((resp.body && resp.body.error) || ("HTTP " + resp.status + ".")) + " The invoice was kept; resolve the issue and try again.", variant: "error" });
                  setDlg(null);
                }
              })
              .catch(function(e) { window.LTP_toast("Not deleted — still in QuickBooks", { message: "Network or server error: " + String(e.message || e) + ". The invoice was kept.", variant: "error" }); setDlg(null); });
            return;
          }
          doLocalDelete();
          function doLocalDelete() {
          // Credit every source quote back the quantities this invoice drew.
          // Grouped by each LINE's source quote, not the invoice's `quoteId`:
          // an invoice can gather lines from several of the client's quotes, and
          // crediting only one would leave the others permanently marked
          // invoiced with no invoice behind the quantity.
          var deleteReductions = {};   // quoteId → { sourceItemId: qty }
          (draft.sections || []).forEach(function(sec) {
            (sec.items || []).forEach(function(it) {
              if (it.type === "note") return;
              var srcQuote = sourceQuoteOf(it);
              if (srcQuote == null) return;
              // Use linkedQty (fallback qty for legacy items) so direct-added
              // qty above the linked baseline doesn't double-decrement.
              var linked = it.linkedQty != null ? (Number(it.linkedQty) || 0) : (Number(it.qty) || 0);
              var k = String(srcQuote);
              (deleteReductions[k] = deleteReductions[k] || {});
              deleteReductions[k][it.sourceItemId] = (deleteReductions[k][it.sourceItemId] || 0) + linked;
            });
          });
          if (Object.keys(deleteReductions).length > 0 && setQuotes) {
            setQuotes(function(prevQuotes) {
              return prevQuotes.map(function(q) {
                var reductions = deleteReductions[String(q.id)];
                if (!reductions) return q;
                // Apply reductions to quote sections
                var updatedSections = (q.sections || []).map(function(sec) {
                  var updatedItems = (sec.items || []).map(function(qi) {
                    if (!reductions[qi.id]) return qi;
                    var newInvQty = Math.max(0, (Number(qi.invoicedQty) || 0) - reductions[qi.id]);
                    return Object.assign({}, qi, { invoicedQty: newInvQty });
                  });
                  return Object.assign({}, sec, { items: updatedItems });
                });
                // If quote was "converted", check if it should revert to "accepted"
                var newStatus = q.status;
                if (q.status === "converted") {
                  newStatus = "accepted";
                }
                var actChanges = [];
                Object.keys(reductions).forEach(function(srcId) {
                  // Find the item name from the quote sections
                  var itemName = "";
                  (q.sections || []).forEach(function(sec) {
                    (sec.items || []).forEach(function(qi) { if (qi.id === srcId) itemName = qi.name; });
                  });
                  actChanges.push({ cat: "Invoiced Qty Reduced", detail: (itemName || "Item") + ": -" + reductions[srcId] });
                });
                if (newStatus !== q.status) actChanges.push({ cat: "Status", detail: q.status + " → " + newStatus });
                var actEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0,5),
                  type: "invoiced", user: (window.LTP_CURRENT_USER || "User"), message: "Invoice " + refDisplay + " deleted — invoiced quantities reduced",
                  changes: actChanges.length > 0 ? actChanges : null };
                return Object.assign({}, q, {
                  sections: updatedSections,
                  status: newStatus,
                  activity: (q.activity || []).concat([actEntry])
                });
              });
            });
          }
          setInvoices(function(prev) { return prev.filter(function(i) { return i.id !== draft.id; }); });
          setDlg(null);
          nav("invoices");
          }
        }
      });
    }

    // Available companies/projects for dropdowns
    var projectContacts = selectedProject
      ? contacts.filter(function(c) { return (selectedProject.contactIds || []).includes(c.id); })
      : selectedCompany ? contacts.filter(function(c) { return (c.companyIds || []).includes(selectedCompany.id); }) : [];

    // ── Render ───────────────────────────────────────────────────────────────
    return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" } },
      // Sticky header. In the full-screen builder the app topbar is hidden, so
      // on mobile this header is the topmost element and takes the status-bar
      // safe-area inset; its actions wrap instead of overflowing off-screen.
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "nowrap", gap: isMobile ? 8 : 0, background: B.surface, borderBottom: "1px solid " + B.border, padding: isMobile ? "calc(10px + env(safe-area-inset-top)) 12px 10px" : "12px 16px", flexShrink: 0, zIndex: 5 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: isMobile ? 10 : 14, flex: 1, minWidth: 0 } },
          h("button", { onClick: function() { nav("invoices"); },
            style: { flexShrink: 0, background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textSec, fontSize: "11px", fontFamily: "inherit", cursor: "pointer" } }, "\u2190 Back"),
          h("div", { style: { minWidth: 0 } },
            h("div", { style: { fontSize: isMobile ? "17px" : "22px", fontWeight: 700, color: B.accent, letterSpacing: "0.02em", lineHeight: 1.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, refDisplay),
            h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 3, minWidth: 0 } },
              h("span", { style: { fontSize: "12px", color: B.textSec, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 } }, displayName),
              !isMobile && h("div", { style: { flexShrink: 0 } }, h(window.Badge, { status: window.LTP_displayStatus(draft) })),
              t.paid > 0 && t.balance > 0 && window.LTP_isOverdue(draft) && h("div", { style: { flexShrink: 0 } }, h(window.Badge, { status: "overdue" })),
              !isMobile && linkedQuote && h("span", { style: { fontSize: "10px", color: B.textMut } }, "from " + window.LTP_QUOTE_REF(linkedQuote))))),
        isMobile
        ? h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexShrink: 0 } },
            justSaved && h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.success, background: B.successBg, border: "1px solid " + B.successBd, padding: "5px 8px", borderRadius: "6px" } }, "\u2713"),
            window.LTP_isOverdue(draft) && h("span", { style: { fontSize: "9px", fontWeight: 700, color: B.danger, background: B.danger + "22", border: "1px solid " + B.danger + "44", padding: "4px 7px", borderRadius: "6px" } }, "OD"),
            isDirty && h(window.Btn, { small: true, variant: "ghost", onClick: discard }, "Discard"),
            isDirty && !isLocked && h(window.Btn, { small: true, onClick: save }, "Save"),
            isDraft && draft.id != null && h("button", { onClick: openSendModal, style: { background: B.success, border: "none", borderRadius: "6px", padding: "8px 14px", color: B.btnInk, fontSize: "12px", fontWeight: 700, fontFamily: "inherit", cursor: "pointer", whiteSpace: "nowrap" } }, "Send"),
            draft.status === "paid" && h("button", { onClick: function() { openReceiptModal(); }, style: { background: B.success, border: "none", borderRadius: "6px", padding: "8px 12px", color: B.btnInk, fontSize: "12px", fontWeight: 700, fontFamily: "inherit", cursor: "pointer", whiteSpace: "nowrap" } }, "Receipt"),
            !isDraft && draft.status !== "paid" && draft.id != null && h("button", { onClick: openSendModal, style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "8px 12px", color: B.textSec, fontSize: "12px", fontFamily: "inherit", cursor: "pointer", whiteSpace: "nowrap" } }, "Resend"),
            h(window.LTPOverflowMenu, { align: "left", items: [
              draft.id != null && { label: generatingPdf ? "Generating\u2026" : "Generate PDF", onClick: generatePdf, disabled: generatingPdf },
              (draft.id != null && draft.shareToken) && { label: "Preview", href: "#/view/invoice/" + draft.shareToken + "?preview=1" },
              (draft.id != null && draft.shareToken) && { label: "Share", onClick: shareInvoice },
              !isDraft && { label: "Recall to Draft", onClick: recallToDraft },
              draft.status === "paid" && { label: "Resend", onClick: openSendModal },
              draft.id != null && { label: "Delete Invoice", onClick: deleteInvoice, variant: "danger" }
            ] }))
        : h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: isMobile ? "wrap" : "nowrap" } },
          justSaved && h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.success, background: B.successBg, border: "1px solid " + B.successBd, padding: "5px 10px", borderRadius: "6px" } }, "\u2713 Saved"),
          !isDraft && h("div", { style: { fontSize: "10px", color: B.warn, padding: "4px 10px", border: "1px solid " + B.warn, borderRadius: "6px" } }, "Locked"),
          // Generate PDF \u2014 only meaningful for saved invoices.
          draft.id != null && h("button", {
              onClick: generatePdf,
              disabled: generatingPdf,
              style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: generatingPdf ? B.textMut : B.textSec, fontSize: "11px", fontFamily: "inherit", cursor: generatingPdf ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 5, opacity: generatingPdf ? 0.6 : 1 } },
            generatingPdf ? "Generating\u2026" : "Generate PDF"
          ),
          // Preview the read-only client view (?preview=1 is UX-only;
          // invoice view has no actions anyway, but stay consistent with quotes).
          draft.id != null && draft.shareToken && h("a", {
              href: "#/view/invoice/" + draft.shareToken + "?preview=1",
              target: "_blank",
              rel: "noopener",
              style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textSec, fontSize: "11px", fontFamily: "inherit", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, textDecoration: "none" } },
            "Preview"
          ),
          // Share the public invoice link via the native share sheet (or copy /
          // mailto fallback). Handy on mobile to hand an invoice to Messages/Mail.
          draft.id != null && draft.shareToken && h("button", { onClick: shareInvoice,
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textSec, fontSize: "11px", fontFamily: "inherit", cursor: "pointer" } }, "Share"),
          // Recall to draft (any non-draft invoice)
          !isDraft && h("button", { onClick: recallToDraft,
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textMut, fontSize: "11px", fontFamily: "inherit", cursor: "pointer" },
            onMouseOver: function(e) { e.currentTarget.style.borderColor = B.warn; e.currentTarget.style.color = B.warn; },
            onMouseOut: function(e) { e.currentTarget.style.borderColor = B.border; e.currentTarget.style.color = B.textMut; } }, "Recall to Draft"),
          // Send Receipt (paid invoices)
          draft.status === "paid" && h("button", { onClick: function() { openReceiptModal(); },
            style: { background: B.success, border: "none", borderRadius: "6px", padding: "6px 12px", color: B.btnInk, fontSize: "11px", fontWeight: 700, fontFamily: "inherit", cursor: "pointer" } }, "Send Receipt"),
          // Send / Resend button
          isDraft && draft.id != null && h("button", { onClick: openSendModal,
            style: { background: B.success, border: "none", borderRadius: "6px", padding: "6px 16px", color: B.btnInk, fontSize: "11px", fontWeight: 700, fontFamily: "inherit", cursor: "pointer" } }, "Send Invoice"),
          !isDraft && draft.id != null && h("button", { onClick: openSendModal,
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textSec, fontSize: "11px", fontFamily: "inherit", cursor: "pointer" } }, "Resend"),
          window.LTP_isOverdue(draft) && h("span", { style: { fontSize: "10px", fontWeight: 700, color: B.danger, background: B.danger + "22", border: "1px solid " + B.danger + "44", padding: "4px 10px", borderRadius: "6px" } }, "OVERDUE"),
          draft.id != null && h(window.Btn, { small: true, variant: "danger", onClick: deleteInvoice }, "Delete"),
          isDirty && h(window.Btn, { small: true, variant: "ghost", onClick: discard }, "Discard"),
          isDirty && !isLocked && h(window.Btn, { small: true, onClick: save }, draft.id == null ? "Save Invoice" : "Save Changes"))
      ),

      // Body
      // Two-pane on desktop (line items + a 280px side panel). On mobile it
      // becomes a single scrolling column so neither pane is squeezed off-screen.
      h("div", { style: { flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", gap: 14, overflowY: isMobile ? "auto" : "hidden", overflowX: "hidden", paddingTop: 10 } },
        // Main content
        h("div", { style: { flex: 1, overflowY: isMobile ? "visible" : "auto", display: "flex", flexDirection: "column", gap: 4, minWidth: 0 } },

          // Invoice details card
          h("div", { style: { background: B.surface, borderTop: "1px solid " + B.border, padding: 16 } },
            // On mobile the status chip rides here (top-right of Invoice Details)
            // instead of crowding the header title row.
            h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, margin: "0 0 12px" } },
              h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.12em", margin: 0 } }, "Invoice Details"),
              isMobile && h(window.Badge, { status: window.LTP_displayStatus(draft) })),

            !isDraft
              // LOCKED — read-only summary
              ? h("div", { style: { display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: 12 } },
                  h("div", null,
                    h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4 } }, "Client"),
                    h("div", { style: { fontSize: "12px", color: B.text, fontWeight: 600 } },
                      selectedCompany ? selectedCompany.name :
                      draft.clientContactId ? ((contacts.find(function(c) { return c.id === draft.clientContactId; }) || {}).firstName || "") + " " + ((contacts.find(function(c) { return c.id === draft.clientContactId; }) || {}).lastName || "") : "\u2014")),
                  h("div", null,
                    h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4 } },
                      docProjects.length > 1 ? "Projects" : "Project"),
                    // A locked invoice has no picker, so every job it bills
                    // for has to be named here. Primary first.
                    h("div", { style: { fontSize: "12px", color: B.text, fontWeight: 600 } },
                      docProjects.length ? docProjects.map(function(p) { return p.name; }).join(", ") : (draft.customName || "\u2014"))),
                  h("div", null,
                    h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4 } }, "Invoice Date"),
                    h("div", { style: { fontSize: "11px", color: B.text } }, draft.invoiceDate ? fmt(draft.invoiceDate) : "\u2014")),
                  h("div", null,
                    h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4 } }, "Due Date"),
                    h("div", { style: { fontSize: "11px", color: B.text } }, draft.dueDate ? fmt(draft.dueDate) : "\u2014"))
                )
              // DRAFT — editable
              : h("div", null,
                  // Client type toggle
                  h("div", { style: { display: "flex", gap: 8, marginBottom: 12 } },
                    h("div", { style: { fontSize: "10px", color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, alignSelf: "center", marginRight: 6 } }, "Invoice To:"),
                    ["company", "contact"].map(function(ct) {
                      return h("button", { key: ct, onClick: function() {
                          if (ct === "company") patchDraft({ clientType: "company", clientContactId: null });
                          else patchDraft({ clientType: "contact", companyId: null, projectId: null });
                        },
                        style: { background: draft.clientType === ct ? B.accent : B.raised, color: draft.clientType === ct ? B.btnInk : B.textMut, border: "1px solid " + (draft.clientType === ct ? B.accent : B.border), borderRadius: "4px", padding: "5px 14px", fontSize: "11px", fontWeight: 600, cursor: "pointer" } },
                        ct === "company" ? "Company" : "Individual Contact");
                    })
                  ),

                  // Company mode
                  draft.clientType === "company" && h("div", { style: { display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12, alignItems: "start" } },
                    h(window.CompanySearchField, {
                      label: "Company *", compId: draft.companyId,
                      setCompId: function(id) { patchDraft({ companyId: id, clientContactId: null }); },
                      companies: companies, onClear: function() { patchDraft({ companyId: null, clientContactId: null }); },
                      createKind: "company", allowEdit: true
                    }),
                    // Same chip field as Company and Linked Projects beside it,
                    // so the whole header reads as one control type and this
                    // field's box starts at the same y as Company's. (Hanging
                    // the ＋/✎ off the LABEL, as this used to, grew the label
                    // row and pushed the field ~13px lower than its neighbour.)
                    //
                    // Narrowed to this client's contacts, so a client with none
                    // yet leaves tier 1 empty — the ＋ is the way out, and what
                    // it creates is linked to the company so it lands in this
                    // list. Tier 2 is everyone else, behind a click. Mirrors the
                    // quote builder.
                    h(window.ContactSearchField, {
                      label: "Primary Contact", contactId: draft.clientContactId,
                      setContactId: function(id) { patchDraft({ clientContactId: id }); },
                      contacts: contacts,
                      tiers: window.LTP_HELPERS.contactFieldTiers(
                        selectedCompany ? contacts.filter(function(c) { return (c.companyIds || []).includes(selectedCompany.id); }) : [],
                        draft.clientContactId, contacts),
                      placeholder: "Search contacts…",
                      createKind: "contact", allowEdit: true,
                      createPrefill: draft.companyId ? { companyIds: [draft.companyId] } : null
                    })
                  ),

                  // Contact mode
                  draft.clientType === "contact" && h("div", null,
                    h(window.ContactSearchField, {
                      label: "Contact *", contactId: draft.clientContactId,
                      setContactId: function(id) { patchDraft({ clientContactId: id }); },
                      contacts: contacts, placeholder: "Search all contacts\u2026",
                      createKind: "contact", allowEdit: true
                    })
                  ),

                  h("div", { style: { display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12, marginTop: 12, alignItems: "start" } },
                    // Project picker — typeahead, filtered by company. Clearing
                    // the chip is the old "(no project — use custom name)"
                    // option; a project created here inherits this invoice's
                    // company. Mirrors the quote builder's field.
                    h(window.ProjectSearchField, { label: "Linked Projects",
                      projectIds: docProjects.map(function(p) { return p.id; }),
                      projects: projects, companies: companies,
                      placeholder: "Search projects — or leave empty for a custom name",
                      filter: function(p) {
                        if (p.internal) return false;                   // manual shift, not invoiceable
                        // Already-linked projects render as chips, not dropdown
                        // rows, so a completed one needs no exception here.
                        if (p.status === "completed") return false;
                        if (draft.clientType === "company" && draft.companyId && p.companyId !== draft.companyId) return false;
                        return true;
                      },
                      createKind: "project", allowEdit: true,
                      createPrefill: Object.assign({},
                        draft.companyId ? { companyId: draft.companyId } : null,
                        draft.clientContactId ? { contactIds: [draft.clientContactId] } : null),
                      // First id is the PRIMARY — it titles the printed invoice
                      // and names the QuickBooks memo — so it's mirrored onto the
                      // scalar projectId that the rest of the app reads.
                      setProjectIds: function(pids) {
                        var added = pids.filter(function(id) { return !docProjects.some(function(p) { return p.id === id; }); });
                        added.forEach(function(pid) {
                          if (!draft.companyId) return;
                          var proj = projects.find(function(p) { return p.id === pid; });
                          if (proj && proj.companyId && proj.companyId !== draft.companyId) {
                            var projComp = companies.find(function(c) { return c.id === proj.companyId; });
                            var invComp = companies.find(function(c) { return c.id === draft.companyId; });
                            showAlert("Company Mismatch", "This project belongs to " + (projComp ? projComp.name : "a different company") + " but this invoice is for " + (invComp ? invComp.name : "another company") + ".", "info");
                          }
                        });
                        patchDraft({ projectId: pids.length ? pids[0] : null, projectIds: pids });
                      }
                    }),
                    // Custom name when no project
                    !draft.projectId && h(window.LTPInput, {
                      label: "Custom Invoice Name", value: draft.customName || "",
                      onChange: function(v) { patchDraft({ customName: v }); },
                      placeholder: "e.g. Consulting \u2014 May 2026"
                    })
                  ),
                  // Invoice + Due date share one row (each in a minWidth:0 cell so
                  // the native date inputs shrink to fit instead of overflowing).
                  h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: isMobile ? 8 : 12, marginTop: 12, alignItems: "start" } },
                    // Invoice date
                    h("div", { style: { minWidth: 0 } },
                      h(window.LTPInput, { label: "Invoice Date", value: draft.invoiceDate || "", type: "date",
                        onChange: function(v) { patchDraft({ invoiceDate: v }); } })),
                    // Due date with net options
                    h("div", { style: { minWidth: 0 } },
                      h(window.LTPInput, { label: "Due Date", value: draft.dueDate || "", type: "date",
                        onChange: function(v) { patchDraft({ dueDate: v }); } }),
                      h("div", { style: { display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" } },
                        [
                          { label: "Today", fn: function() { return draft.invoiceDate || draft.createdDate || todayISO(); } },
                          { label: "Net 15", fn: function() { var d = new Date(draft.invoiceDate || draft.createdDate || Date.now()); d.setDate(d.getDate() + 15); return d.toISOString().substring(0, 10); } },
                          { label: "Net 20", fn: function() { var d = new Date(draft.invoiceDate || draft.createdDate || Date.now()); d.setDate(d.getDate() + 20); return d.toISOString().substring(0, 10); } },
                          { label: "Net 30", fn: function() { return net30(draft.invoiceDate || draft.createdDate); } },
                          { label: "Net 60", fn: function() { var d = new Date(draft.invoiceDate || draft.createdDate || Date.now()); d.setDate(d.getDate() + 60); return d.toISOString().substring(0, 10); } },
                        ].map(function(opt) {
                          return h("button", { key: opt.label, onClick: function() { patchDraft({ dueDate: opt.fn() }); },
                            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "4px", padding: "2px 6px", color: B.accent, fontSize: "9px", fontWeight: 600, cursor: "pointer" } }, opt.label);
                        })
                      )
                    )
                  )
                ),
            linkedQuote && h("div", { style: { marginTop: 10, fontSize: "10px", color: B.textMut } },
              "Linked to: ", h("span", { style: { color: B.accent, cursor: "pointer", fontWeight: 600 }, onClick: function() { nav("quotes/" + linkedQuote.id); } }, window.LTP_QUOTE_REF(linkedQuote))),
          ),

          // Sections
          draft.sections.map(function(sec, secIdx) {
            var st = sectionTotals(sec);
            // Document core — flat orange-ruled panel (customer line-item treatment)
            return h("div", Object.assign({ key: sec.id, style: { background: B.raised, borderTop: "1px solid " + B.border, padding: 12 } }, sortable.zoneProps(sec.id)),
              // Section header
              h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 } },
                // Reorder: grab handle on desktop, ▲▼ buttons on a phone.
                isDraft && (isMobile
                  ? h(window.LTPMoveArrows, { boxed: true, label: "section",
                      onMove: function(dir) { moveSectionAnimated(sec.id, dir); },
                      canUp: secIdx > 0, canDown: secIdx < draft.sections.length - 1 })
                  : h("button", sortable.handleProps("section", sec.id, sec.id,
                      { label: "Reorder section", fontSize: "14px" }), "☰")),
                isDraft
                  ? h("input", { type: "text", value: sec.label,
                      onChange: function(e) { updateSectionLabel(sec.id, e.target.value); },
                      style: { flex: 1, background: "transparent", border: "none", borderBottom: "1px solid " + B.border, color: B.text, fontSize: "14px", fontWeight: 700, outline: "none", padding: "4px 0" } })
                  : h("div", { style: { flex: 1, fontSize: "14px", fontWeight: 700, color: B.accent } }, sec.label),
                h("div", { style: { fontSize: "11px", color: B.textMut } }, "$" + window.LTP_money(st.subtotal)),
                isDraft && draft.sections.length > 1 && h("button", { onClick: function() { deleteSection(sec.id); },
                  style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "4px", color: B.textMut, cursor: "pointer", fontSize: "11px", padding: "3px 8px" } }, "Delete")
              ),
              // Items
              h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 } },
                sec.items.length === 0 && h("div", { style: { padding: 14, textAlign: "center", color: B.textMut, fontSize: "11px", fontStyle: "italic", background: B.surface, borderRadius: "4px", border: "1px dashed " + B.border } }, "No items yet."),
                sec.items.map(function(it, itIdx) {
                  return h(InvLineItem, { key: it.id, item: it, sectionId: sec.id, isDraft: isDraft,
                    onUpdate: updateItem, onDelete: deleteItem, onMove: moveItemAnimated,
                    sortable: sortable, itemIndex: itIdx, itemCount: sec.items.length,
                    services: svcs, products: products, equipment: equipment, fees: fees, customerTaxable: customerTaxable });
                })
              ),
              isDraft && h("button", { onClick: function() { setPickerForSection(sec.id); },
                style: { background: "transparent", border: "1px dashed " + B.accent + "66", color: B.accent, cursor: "pointer", fontSize: "11px", fontWeight: 600, padding: "8px", borderRadius: "4px", width: "100%" } }, "+ Add Item")
            );
          }),
          isDraft && h("button", { onClick: addSection,
            style: { background: "transparent", border: "1px dashed " + B.border, color: B.textMut, cursor: "pointer", fontSize: "12px", fontWeight: 600, padding: "12px", width: "100%" } }, "+ Add Section"),

          // Totals
          h("div", { style: { background: B.raised, borderTop: "1px solid " + B.border, borderBottom: "1px solid " + B.border, padding: "14px 18px" } },
            h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: "12px", color: B.textSec } },
              h("span", null, "Subtotal"), h("span", null, "$" + window.LTP_money(t.subtotal))),
            // Only once a line has actually been re-priced. Epsilon-guarded (not
            // !==) so float residue can't surface an "Adjustments -$0.00" row —
            // same 1¢ threshold the PDF and client view use.
            Math.abs(t.subtotal - t.adjusted) > 0.01 && h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: "11px", color: B.textMut } },
              h("span", null, "Adjustments"), h("span", null, (t.subtotal > t.adjusted ? "-$" : "+$") + window.LTP_money(Math.abs(t.subtotal - t.adjusted)))),
            // Global discount (editable in draft)
            isDraft && h("div", { style: { display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderTop: "1px solid " + B.border, marginTop: 4 } },
              h("span", { style: { fontSize: "11px", color: B.textMut } }, "Discount:"),
              h("select", { value: draft.globalDiscount.type, onChange: function(e) { patchDraft({ globalDiscount: Object.assign({}, draft.globalDiscount, { type: e.target.value }) }); },
                style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 6px", color: B.text, fontSize: "11px", fontFamily: "inherit" } },
                h("option", { value: "none" }, "None"),
                h("option", { value: "percent" }, "%"),
                h("option", { value: "amount" }, "$"),
                h("option", { value: "target" }, "Target")),
              draft.globalDiscount.type !== "none" && h("input", { type: "number", value: draft.globalDiscount.value || "",
                onChange: function(e) { patchDraft({ globalDiscount: Object.assign({}, draft.globalDiscount, { value: Number(e.target.value) || 0 }) }); },
                style: { width: 70, background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 6px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", textAlign: "right" } })
            ),
            // Customer taxability (draft) — drives whether QuickBooks taxes the
            // lines. Company-level only (contacts billed directly are exempt);
            // most clients are exempt, so this defaults off.
            isDraft && draft.clientType === "company" && custParty && h("div", { style: { display: "flex", gap: 8, alignItems: "center", padding: "6px 0", fontSize: "11px", color: B.textMut } },
              h("label", { style: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer" } },
                h("input", { type: "checkbox", checked: customerTaxable, onChange: function(e) { setCustomerTaxable(e.target.checked); } }),
                h("span", null, "Customer is taxable")),
              customerTaxable && h("span", { style: { fontSize: "9px", color: B.textMut, fontStyle: "italic" } }, draft.qbTaxTotal != null ? "tax via QuickBooks" : "tax pending QuickBooks")),
            // Directly-billed contacts are always taxable — informational, no toggle.
            isDraft && draft.clientType === "contact" && custParty && h("div", { style: { display: "flex", gap: 8, alignItems: "center", padding: "6px 0", fontSize: "11px", color: B.textMut } },
              h("span", null, "Taxable (billed directly)"),
              h("span", { style: { fontSize: "9px", color: B.textMut, fontStyle: "italic" } }, draft.qbTaxTotal != null ? "tax via QuickBooks" : "tax pending QuickBooks")),
            // QuickBooks-computed sales tax (read-only, pulled back after push).
            draft.qbTaxTotal != null && draft.qbTaxTotal > 0 && h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: "11px", color: B.textMut } },
              h("span", null, "Sales Tax (QuickBooks)"), h("span", null, money2(draft.qbTaxTotal))),
            // Brand-gradient rule sets the grand total apart (client-view stroke)
            h("div", { style: { height: 3, background: B.gradRule, marginTop: 6 } }),
            h("div", { style: { display: "flex", justifyContent: "space-between", padding: "8px 0 4px", fontSize: "14px", fontWeight: 700 } },
              h("span", { style: { color: B.text } }, "Total"), h("span", { style: { color: B.accent } }, fmtT(t.total))),
            t.paid > 0 && h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: "11px", color: B.success } },
              h("span", null, "Paid"), h("span", null, fmtT(t.paid))),
            t.balance > 0 && h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: "12px", fontWeight: 700, color: t.balance > 0 ? B.warn : B.success } },
              h("span", null, "Balance Due"), h("span", null, fmtT(t.balance)))
          ),

          // Terms & Conditions — collapsed, directly under the totals, because
          // that is where they print on the document itself. Locked once the
          // invoice leaves draft: the client already has this copy.
          h(window.LTPDocTerms, { kind: "invoice", entity: draft, settings: settings,
            isLocked: !isDraft,
            onChange: function(text) { patchDraft({ terms: text }); } })
        ),

        // Side panel
        h("div", { style: { width: isMobile ? "100%" : 280, flexShrink: 0, display: "flex", flexDirection: "column", gap: 4, overflowY: isMobile ? "visible" : "auto" } },
          // QuickBooks section — status + actions + deep link (shown once sent)
          qbConnected && qbEligible && h("div", { style: { background: B.surface, borderTop: "1px solid " + B.border, padding: 14 } },
            h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 } },
              h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.12em", margin: 0 } }, "QuickBooks"),
              qbPill && h("span", { style: { fontSize: "10px", fontWeight: 700, color: qbPill.color, background: qbPill.color + "18", border: "1px solid " + qbPill.color + "44", padding: "3px 8px", borderRadius: "5px", whiteSpace: "nowrap" } }, qbPill.label)),
            draft.qbSyncedAt && h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: (draft.qbSyncStatus === "error" ? 6 : 10) } },
              "Last synced " + (function() { try { return new Date(draft.qbSyncedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) { return draft.qbSyncedAt; } })()),
            draft.qbSyncStatus === "error" && draft.qbLastError && h("div", { style: { fontSize: "10px", color: B.danger, marginBottom: 10, lineHeight: 1.4, wordBreak: "break-word" } }, draft.qbLastError),
            h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
              isAdmin && (qbOutOfSync || draft.qbSyncStatus === "error") && h("button", { onClick: sendToQuickBooks, disabled: qboSyncing,
                style: { background: "#2CA01C", border: "1px solid #2CA01C", borderRadius: "6px", padding: "6px 12px", color: "#fff", fontSize: "11px", fontWeight: 700, fontFamily: "inherit", cursor: qboSyncing ? "wait" : "pointer", opacity: qboSyncing ? 0.6 : 1, whiteSpace: "nowrap" } },
                qboSyncing ? "Syncing…" : (draft.qbInvoiceId ? "↻ Update QuickBooks" : "→ Export to QuickBooks")),
              qbInvoiceUrl && h("a", { href: qbInvoiceUrl, target: "_blank", rel: "noopener noreferrer",
                style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textSec, fontSize: "11px", fontWeight: 600, fontFamily: "inherit", textDecoration: "none", whiteSpace: "nowrap" } }, "View in QuickBooks ↗"))
          ),
          // Summary — redundant on mobile (section subtotals + the totals panel
          // already cover it), so hidden there to reclaim vertical space.
          !isMobile && h("div", { style: { background: B.surface, borderTop: "1px solid " + B.border, padding: 14 } },
            h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.12em", margin: "0 0 10px" } }, "Invoice Summary"),
            draft.sections.map(function(sec) {
              var st = sectionTotals(sec);
              var cnt = sec.items.filter(function(i) { return i.type !== "note"; }).length;
              return h("div", { key: sec.id, style: { display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid " + B.border } },
                h("div", null,
                  h("div", { style: { fontSize: "11px", fontWeight: 600, color: B.text } }, sec.label),
                  h("div", { style: { fontSize: "9px", color: B.textMut } }, cnt + " items")),
                h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.accent } }, "$" + window.LTP_money(st.subtotal)));
            }),
            h("div", { style: { display: "flex", justifyContent: "space-between", padding: "6px 0 4px", borderTop: "1px solid " + B.border, marginTop: 4 } },
              h("span", { style: { fontSize: "13px", fontWeight: 700, color: B.text } }, "Total"),
              h("span", { style: { fontSize: "14px", fontWeight: 700, color: B.accent } }, fmtT(t.total))),
            t.paid > 0 && h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0" } },
              h("span", { style: { fontSize: "11px", color: B.success } }, "Paid"),
              h("span", { style: { fontSize: "11px", fontWeight: 600, color: B.success } }, fmtT(t.paid))),
            t.balance > 0 && h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0" } },
              h("span", { style: { fontSize: "12px", fontWeight: 700, color: B.warn } }, "Balance"),
              h("span", { style: { fontSize: "12px", fontWeight: 700, color: B.warn } }, fmtT(t.balance)))
          ),
          // Notes
          h("div", { style: { background: B.surface, borderTop: "1px solid " + B.border, padding: 14 } },
            h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.12em", margin: "0 0 8px" } }, "Notes"),
            h("textarea", { value: draft.notes || "", onChange: function(e) { patchDraft({ notes: e.target.value }); },
              placeholder: "Invoice notes\u2026",
              style: { width: "100%", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", resize: "vertical", minHeight: 50 } })
          ),
          // Payments — only visible after invoice is sent
          !isDraft && h("div", { style: { background: B.surface, borderTop: "1px solid " + B.border, padding: 14 } },
            h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
              h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.12em", margin: 0 } }, "Payments"),
              h("button", { onClick: function() { setShowPaymentForm(!showPaymentForm); },
                style: { background: showPaymentForm ? B.raised : B.success, border: "none", borderRadius: "4px", padding: "3px 10px", color: showPaymentForm ? B.textMut : B.btnInk, fontSize: "10px", fontWeight: 700, cursor: "pointer" } },
                showPaymentForm ? "Cancel" : "+ Record Payment")),
            // Payment list
            (draft.payments || []).length === 0
              ? h("div", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic", textAlign: "center", padding: "8px 0" } }, "No payments recorded.")
              : h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                  (draft.payments || []).map(function(pay) {
                    var methodLabels = { check: "Check", ach: "ACH", credit_card: "CC", cash: "Cash", wire: "Wire", other: "Other" };
                    return h("div", { key: pay.id, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", background: B.raised, borderRadius: "4px", border: "1px solid " + B.border } },
                      h("div", null,
                        h("div", { style: { fontSize: "11px", fontWeight: 600, color: B.success } }, "$" + window.LTP_money(pay.amount)),
                        h("div", { style: { fontSize: "9px", color: B.textMut } },
                          (methodLabels[pay.method] || pay.method || "") +
                          (pay.reference ? " \u00b7 " + pay.reference : "") +
                          " \u00b7 " + fmt(pay.date))),
                      h("button", { onClick: function() { deletePayment(pay.id); },
                        style: { background: "transparent", border: "none", color: B.textMut, cursor: "pointer", fontSize: "12px" },
                        onMouseOver: function(e) { e.currentTarget.style.color = B.danger; },
                        onMouseOut: function(e) { e.currentTarget.style.color = B.textMut; } }, "\u00d7")
                    );
                  }),
                  h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 8px 0", borderTop: "1px dashed " + B.border, marginTop: 2, fontSize: "10px" } },
                    h("span", { style: { color: B.textMut } }, "Total Paid"),
                    h("span", { style: { color: B.success, fontWeight: 700 } }, "$" + window.LTP_money(t.paid)))
                )
          ),
          // Linked Quote
          linkedQuote && h("div", { style: { background: B.surface, borderTop: "1px solid " + B.border, padding: 14 } },
            h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.12em", margin: "0 0 8px" } }, "Linked Quote"),
            h("div", {
              onClick: function() { nav("quotes/" + linkedQuote.id); },
              style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", background: B.raised, borderRadius: "4px", cursor: "pointer", border: "1px solid " + B.border },
              onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent + "44"; },
              onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
              h("div", null,
                h("div", { style: { fontSize: "11px", fontWeight: 600, color: B.accent } }, window.LTP_QUOTE_REF(linkedQuote)),
                h("div", { style: { fontSize: "9px", color: B.textMut } }, fmt(linkedQuote.createdDate || ""))),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                h("span", { style: { fontSize: "11px", fontWeight: 700, color: B.text } }, "$" + window.LTP_money((window.LTP_QUOTE_TOTALS(linkedQuote) || {}).total || 0)),
                h(window.Badge, { status: linkedQuote.status }))
            )
          ),
          // Activity
          h("div", { style: { background: B.surface, borderTop: "1px solid " + B.border, padding: 14, flex: 1, display: "flex", flexDirection: "column", minHeight: 100 } },
            h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.12em", margin: "0 0 8px" } }, "Activity"),
            h("div", { style: { flex: 1, overflowY: "auto" } },
              (draft.activity || []).slice().reverse().map(function(a) {
                var typeColors = { created: B.info, saved: B.success, status: B.warn, paid: B.success, sent: B.accent, pdf_generated: B.accent,
                  // Email + view-tracking types (commits 2 + 3)
                  email_sent: B.accent, email_failed: B.danger,
                  recipient_opened: B.info, recipient_downloaded_pdf: B.info,
                  client_viewed: B.textMut, client_downloaded_pdf: B.textMut };
                var tc = typeColors[a.type] || B.textMut;
                var hasChanges = a.changes && a.changes.length > 0;
                var isPdf = a.type === "pdf_generated" && a.pdfToken;
                var rowOnClick = isPdf
                  ? undefined
                  : (hasChanges ? function() { setViewActivity(a); } : undefined);
                var rowClickable = isPdf || hasChanges;
                return h("div", { key: a.id,
                  onClick: rowOnClick,
                  style: { padding: "5px 0", borderBottom: "1px solid " + B.border, display: "flex", gap: 6, cursor: rowClickable && !isPdf ? "pointer" : "default" },
                  onMouseOver: rowClickable ? function(e) { e.currentTarget.style.background = B.raised; } : undefined,
                  onMouseOut: rowClickable ? function(e) { e.currentTarget.style.background = "transparent"; } : undefined },
                  h("div", { style: { width: 5, borderRadius: "3px", background: tc, flexShrink: 0, marginTop: 2 } }),
                  h("div", { style: { flex: 1 } },
                    h("div", { style: { fontSize: "11px", color: B.text, display: "flex", gap: 6, alignItems: "center" } },
                      a.message,
                      hasChanges && h("span", { style: { fontSize: "9px", color: B.accent, fontWeight: 600 } }, "\u25b8"),
                      isPdf && h("a", {
                        href: "/pdf/" + a.pdfToken,
                        download: a.pdfFilename || "invoice.pdf",
                        onClick: function(e) { e.stopPropagation(); },
                        style: { fontSize: "10px", color: B.accent, fontWeight: 600, textDecoration: "none", border: "1px solid " + B.accent, borderRadius: "4px", padding: "1px 6px" }
                      }, "\u2193 Download")),
                    h("div", { style: { fontSize: "9px", color: B.textMut } }, (a.user || "") + (a.date ? " \u00b7 " + fmt(a.date) : "")))
                );
              }))
          )
        )
      ),

      // Item picker
      pickerForSection && h(InvAddItemPicker, {
        equipment: equipment, products: products, services: svcs, fees: fees,
        onAdd: function(item) { addItemToSection(pickerForSection, item); },
        onClose: function() { setPickerForSection(null); }
      }),

      // Activity detail popup
      viewActivity && h(window.LTPModal, { title: viewActivity.message, onClose: function() { setViewActivity(null); } },
        h("div", { style: { marginBottom: 10, fontSize: "11px", color: B.textMut } }, (viewActivity.user || "") + " \u00b7 " + fmt(viewActivity.date || "")),
        h("div", { style: { display: "flex", flexDirection: "column" } },
          (viewActivity.changes || []).map(function(ch, i) {
            return h("div", { key: i, style: { display: "flex", gap: 10, padding: "7px 0", borderBottom: "1px solid " + B.border } },
              h("div", { style: { width: 120, flexShrink: 0, fontSize: "11px", fontWeight: 600, color: B.accent } }, ch.cat),
              h("div", { style: { flex: 1, fontSize: "11px", color: B.textSec } }, ch.detail));
          }))
      ),

      // Confirm dialog
      dlg && h(window.LTPConfirmDialog, { dlg: dlg, onCancel: function() { setDlg(null); } }),

      // Record Payment modal
      // Record Payment — components/doc-payment-form.js. It owns the form's
      // own state; what happens to a valid payment stays here in addPayment.
      showPaymentForm && h(window.LTPPaymentForm, {
        totals: t,
        onSubmit: function(payment) { addPayment(payment); },
        onClose: function() { setShowPaymentForm(false); },
        onAlert: showAlert,
      }),

      // Send Invoice modal
      showSendModal && h(window.LTPModal, { title: isDraft ? "Send Invoice" : "Resend Invoice", onClose: function() { setShowSendModal(false); }, wide: true },
        h("div", { style: { display: "flex", gap: 16, minHeight: 380 } },
          // Left: Invoice preview
          h("div", { style: { width: 260, flexShrink: 0, background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: 16, display: "flex", flexDirection: "column" } },
            h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 } }, "Invoice Preview"),
            h("div", { style: { fontSize: "16px", fontWeight: 700, color: B.accent, marginBottom: 4 } }, refDisplay),
            h("div", { style: { fontSize: "11px", color: B.textSec, marginBottom: 2 } }, displayName),
            selectedCompany && h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 10 } }, selectedCompany.name),
            h("div", { style: { borderTop: "1px solid " + B.border, paddingTop: 8, flex: 1 } },
              h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: 4 } },
                h("span", { style: { color: B.textMut } }, "Invoice Date"),
                h("span", { style: { color: B.text } }, draft.invoiceDate ? fmt(draft.invoiceDate) : "\u2014")),
              h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: 4 } },
                h("span", { style: { color: B.textMut } }, "Due Date"),
                h("span", { style: { color: B.text } }, draft.dueDate ? fmt(draft.dueDate) : "\u2014")),
              h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: 4 } },
                h("span", { style: { color: B.textMut } }, "Line Items"),
                h("span", { style: { color: B.text } }, draft.sections.reduce(function(n, s) { return n + s.items.filter(function(i) { return i.type !== "note"; }).length; }, 0))),
              h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "14px", fontWeight: 700, paddingTop: 8, borderTop: "1px solid " + B.border, marginTop: 4 } },
                h("span", { style: { color: B.text } }, "Total"),
                h("span", { style: { color: B.accent } }, fmtT(t.total))),
              t.paid > 0 && h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "11px", marginTop: 4 } },
                h("span", { style: { color: B.success } }, "Paid"),
                h("span", { style: { color: B.success } }, fmtT(t.paid))),
              t.balance > 0 && t.balance !== t.total && h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "12px", fontWeight: 700, marginTop: 4 } },
                h("span", { style: { color: B.warn } }, "Balance"),
                h("span", { style: { color: B.warn } }, fmtT(t.balance)))
            )
          ),
          // Right: Email preview
          // Shared with the other send modals — components/doc-email-pane.js.
          h(window.LTPEmailComposePane, {
            recipients: sendRecipients, onRecipientsChange: onRecipientsChange, contacts: contacts,
            subject: sendSubject, onSubjectChange: setSendSubject,
            body: sendMessage, onBodyChange: setSendMessage,
            headerKind: "invoice", headerVars: sendHeaderVars, settings: settings,
          })
        ),
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 14, paddingTop: 14, borderTop: "1px solid " + B.border } },
          // Attach the invoice PDF (default on). Invoice + reminder sends only;
          // the backend generates it fresh and attaches it to the email.
          h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: "11px", color: B.textSec, cursor: "pointer", userSelect: "none" } },
            h("input", { type: "checkbox", checked: attachPdf, onChange: function(e) { setAttachPdf(e.target.checked); }, style: { cursor: "pointer", accentColor: B.accent } }),
            "Attach invoice PDF"),
          h("div", { style: { display: "flex", gap: 8 } },
            h(window.Btn, { variant: "ghost", onClick: function() { setShowSendModal(false); } }, "Cancel"),
            h(window.Btn, {
              onClick: executeSend,
              disabled: sending || !window.LTP_GMAIL_CONNECTED,
            }, sending ? "Sending\u2026" : (isDraft ? "Send Invoice" : "Resend"))))
      ),

      // Payment Receipt modal
      showReceiptModal && h(window.LTPModal, { title: "Send Payment Receipt", onClose: function() { setShowReceiptModal(false); }, wide: true },
        h("div", { style: { display: "flex", gap: 16, minHeight: 380 } },
          // Left: Receipt preview
          h("div", { style: { width: 260, flexShrink: 0, background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: 16, display: "flex", flexDirection: "column" } },
            h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 } }, "Receipt Preview"),
            h("div", { style: { fontSize: "16px", fontWeight: 700, color: B.accent, marginBottom: 4 } }, refDisplay),
            h("div", { style: { fontSize: "11px", color: B.textSec, marginBottom: 10 } }, displayName),
            h("div", { style: { borderTop: "1px solid " + B.border, paddingTop: 8, flex: 1 } },
              h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: 6 } },
                h("span", { style: { color: B.textMut } }, "Invoice Total"),
                h("span", { style: { color: B.text } }, "$" + window.LTP_money(t.total))),
              h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4, fontWeight: 600 } }, "Payments"),
              (draft.payments || []).map(function(p) {
                var ml = { check: "Check", ach: "ACH", credit_card: "CC", cash: "Cash", wire: "Wire", other: "Other" };
                return h("div", { key: p.id, style: { display: "flex", justifyContent: "space-between", fontSize: "10px", padding: "2px 0" } },
                  h("span", { style: { color: B.textMut } }, fmt(p.date) + " \u00b7 " + (ml[p.method] || p.method)),
                  h("span", { style: { color: B.success } }, "$" + window.LTP_money(p.amount)));
              }),
              h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "13px", fontWeight: 700, paddingTop: 8, borderTop: "1px solid " + B.border, marginTop: 6 } },
                h("span", { style: { color: B.success } }, "Paid in Full"),
                h("span", { style: { color: B.success } }, "$" + window.LTP_money(t.paid)))
            )
          ),
          // Right: Email preview
          // Shared with the other send modals — components/doc-email-pane.js.
          h(window.LTPEmailComposePane, {
            recipients: sendRecipients, onRecipientsChange: onRecipientsChange, contacts: contacts,
            subject: sendSubject, onSubjectChange: setSendSubject,
            body: sendMessage, onBodyChange: setSendMessage,
            headerKind: "receipt", headerVars: sendHeaderVars, settings: settings,
          })
        ),
        h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14, paddingTop: 14, borderTop: "1px solid " + B.border } },
          h(window.Btn, { variant: "ghost", onClick: function() { setShowReceiptModal(false); } }, "Skip"),
          h(window.Btn, {
            onClick: sendReceipt,
            disabled: sending || !window.LTP_GMAIL_CONNECTED,
          }, sending ? "Sending\u2026" : "Send Receipt"))
      )
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   MAIN VIEW — routes between list and builder
  // ═══════════════════════════════════════════════════════════════════════════
  window.InvoicesView = function(props) {
    var route = props.route;
    var isBuilder = (route.id !== null || route.action === "new");

    if (isBuilder) {
      return h(InvoiceBuilder, {
        invoiceId: route.id, isNew: !route.id && route.action === "new",
        invoices: props.invoices, setInvoices: props.setInvoices, getNextInvoiceId: props.getNextInvoiceId,
        companies: props.companies, setCompanies: props.setCompanies,
        contacts: props.contacts, setContacts: props.setContacts, projects: props.projects,
        quotes: props.quotes, setQuotes: props.setQuotes,
        equipment: props.equipment, products: props.products, services: props.services, clientRates: props.clientRates, fees: props.fees,
        settings: props.settings, isAdmin: props.isAdmin, qbo: props.qbo,
      });
    }
    return h(InvoiceList, {
      invoices: props.invoices, companies: props.companies, contacts: props.contacts, projects: props.projects, quotes: props.quotes,
    });
  };
})();
