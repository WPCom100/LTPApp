// ═══════════════════════════════════════════════════════════════════════════
//   INVOICES MODULE — List + Full Builder
// ═══════════════════════════════════════════════════════════════════════════
(function() {
  "use strict";
  var h = React.createElement, B = window.LTP_THEME;
  var useState = React.useState, useRef = React.useRef, useMemo = React.useMemo, useEffect = React.useEffect;
  var nav = window.LTPRouter.navigate;
  var fmt = window.LTP_formatDate;
  var genId = window.LTP_genId;
  var todayISO = window.LTP_todayISO;

  function net30(fromDate) {
    var d = new Date(fromDate || Date.now());
    d.setDate(d.getDate() + (window.LTP_DEFAULT_TERMS || 30));
    return d.toISOString().substring(0, 10);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   INVOICE LIST
  // ═══════════════════════════════════════════════════════════════════════════
  function InvoiceList({ invoices, companies, contacts, projects, quotes }) {
    var [filter, setFilter] = useState("all");
    var [search, setSearch] = useState("");
    var statuses = ["all", "draft", "sent", "partial", "paid", "overdue"];

    var filtered = invoices.filter(function(inv) {
      if (filter !== "all") {
        var ds = window.LTP_displayStatus(inv);
        if (filter === "overdue") { if (ds !== "overdue") return false; }
        else if (filter !== inv.status) return false;
      }
      if (search) {
        var q = search.toLowerCase();
        var ref = window.LTP_INVOICE_REF(inv).toLowerCase();
        var comp = inv.companyId ? ((companies.find(function(c) { return c.id === inv.companyId; }) || {}).name || "") : "";
        var proj = inv.projectId ? ((projects.find(function(p) { return p.id === inv.projectId; }) || {}).name || "") : "";
        if ((ref + " " + comp + " " + proj).toLowerCase().indexOf(q) === -1) return false;
      }
      return true;
    });

    var totalPaid = invoices.filter(function(i) { return i.status === "paid"; }).reduce(function(s, i) { return s + (window.LTP_INVOICE_TOTALS(i).total || 0); }, 0);
    var totalPending = invoices.filter(function(i) { return i.status === "sent" || i.status === "partial"; }).reduce(function(s, i) { return s + (window.LTP_INVOICE_TOTALS(i).balance || 0); }, 0);
    var totalOverdue = invoices.filter(function(i) { return window.LTP_isOverdue(i); }).reduce(function(s, i) { return s + (window.LTP_INVOICE_TOTALS(i).balance || 0); }, 0);

    return h("div", null,
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
        h("h2", { style: { fontSize: "18px", fontWeight: 700, color: B.text, margin: 0, fontFamily: "'Playfair Display', serif" } }, "Invoices ",
          h("span", { style: { fontSize: "13px", color: B.textMut, fontFamily: "'DM Sans', sans-serif", fontWeight: 500 } }, "(" + invoices.length + ")")),
        h(window.Btn, { small: true, onClick: function() { nav("invoices/new"); } }, "+ New Invoice")),
      h("div", { style: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 } },
        h(window.StatCard, { label: "Paid", value: "$" + Math.round(totalPaid).toLocaleString(), accent: B.success }),
        h(window.StatCard, { label: "Pending", value: "$" + Math.round(totalPending).toLocaleString(), accent: B.warn }),
        h(window.StatCard, { label: "Overdue", value: "$" + Math.round(totalOverdue).toLocaleString(), accent: B.danger })),
      h("div", { style: { display: "flex", gap: 8, marginBottom: 14, alignItems: "center" } },
        statuses.map(function(f) {
          return h("button", { key: f, onClick: function() { setFilter(f); },
            style: { background: filter === f ? B.accent : B.raised, color: filter === f ? "#000" : B.textMut, border: "1px solid " + (filter === f ? B.accent : B.border), borderRadius: "4px", padding: "4px 12px", fontSize: "11px", fontWeight: 600, cursor: "pointer", textTransform: "capitalize" } }, f);
        }),
        h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search invoices\u2026",
          style: { flex: 1, maxWidth: 300, background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "5px 12px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none" } })),
      h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
        filtered.length === 0 && h("div", { style: { padding: 30, textAlign: "center", color: B.textMut, fontSize: "12px", fontStyle: "italic" } }, "No invoices found."),
        filtered.map(function(inv) {
          var ref = window.LTP_INVOICE_REF(inv);
          var t = window.LTP_INVOICE_TOTALS(inv);
          var comp = inv.companyId ? ((companies.find(function(c) { return c.id === inv.companyId; }) || {}).name || "") : "";
          var proj = inv.projectId ? ((projects.find(function(p) { return p.id === inv.projectId; }) || {}).name || "") : "";
          var qRef = inv.quoteId ? (function() { var q = quotes.find(function(q2) { return q2.id === inv.quoteId; }); return q ? window.LTP_QUOTE_REF(q) : ""; })() : "";
          var itemCount = (inv.sections || []).reduce(function(n, s) { return n + (s.items || []).filter(function(i) { return i.type !== "note"; }).length; }, 0);
          return h("div", { key: inv.id, onClick: function() { nav("invoices/" + inv.id); },
            style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: "12px 16px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" },
            onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent + "44"; },
            onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
            h("div", null,
              h("div", { style: { fontSize: "14px", fontWeight: 700, fontFamily: "'Playfair Display', serif" } },
                h("span", { style: { color: B.accent } }, ref),
                proj && h("span", { style: { color: B.textMut, margin: "0 8px" } }, "\u00b7"),
                proj && h("span", { style: { color: B.text } }, proj)),
              h("div", { style: { fontSize: "11px", color: B.textMut, marginTop: 2 } },
                comp + " \u00b7 " + itemCount + " items" + (qRef ? " \u00b7 from " + qRef : "") + (inv.dueDate ? " \u00b7 Due: " + fmt(inv.dueDate) : ""))),
            h("div", { style: { display: "flex", gap: 10, alignItems: "center" } },
              h("div", { style: { textAlign: "right" } },
                h("div", { style: { fontSize: "15px", fontWeight: 700, color: window.LTP_isOverdue(inv) ? B.danger : B.accent } }, "$" + Math.round(t.total).toLocaleString()),
                t.paid > 0 && t.balance > 0 && h("div", { style: { fontSize: "9px", color: B.textMut } }, "bal: $" + Math.round(t.balance).toLocaleString())),
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
  function InvAddItemPicker({ onAdd, onClose, equipment, products, services }) {
    var [tab, setTab] = useState("equipment");
    var [search, setSearch] = useState("");
    var q = search.trim().toLowerCase();

    function filterList(list, fields) {
      if (!q) return list;
      return list.filter(function(item) {
        return fields.some(function(f) { return ((item[f] || "") + "").toLowerCase().indexOf(q) !== -1; });
      });
    }

    var tabs = [
      { id: "equipment", label: "Equipment" },
      { id: "product",   label: "Products"  },
      { id: "service",   label: "Services"  },
      { id: "note",      label: "Note"      },
    ];

    return h(window.LTPModal, { title: "Add Item", onClose: onClose, wide: true },
      h(window.LTPTabs, { tabs: tabs, active: tab, onChange: setTab }),

      tab === "equipment" && h("div", null,
        h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search equipment\u2026",
          style: { width: "100%", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", marginBottom: 10 } }),
        h("div", { style: { maxHeight: 350, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 } },
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
        h("div", { style: { maxHeight: 350, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 } },
          filterList(products || [], ["name", "category"]).slice(0, 60).map(function(p) {
            return h("div", { key: p.id, onClick: function() {
                onAdd({ id: genId("item"), type: "product", productId: p.id, name: p.name, qty: 1, unitPrice: p.unitPrice || 0, adjustedPrice: null, cost: p.cost || 0, notes: "", deliveredQty: 0, invoicedQty: 0 });
              },
              style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "4px", padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 },
              onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent; },
              onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
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
        h("div", { style: { maxHeight: 350, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 } },
          filterList(services || [], ["role", "department"]).slice(0, 60).map(function(s) {
            return h("div", { key: s.id, onClick: function() {
                onAdd({ id: genId("item"), type: "service", serviceId: s.id, name: s.role + " \u2014 " + s.description, rateType: "day", qty: 1, unitPrice: s.dayRate || 0, adjustedPrice: null, cost: s.dayCost || 0, notes: "", deliveredQty: 0, invoicedQty: 0 });
              },
              style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "4px", padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 },
              onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent; },
              onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
              h("div", { style: { flex: 1 } },
                h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, s.role),
                h("div", { style: { fontSize: "10px", color: B.textMut } }, s.department || "")),
              h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.accent } }, "$" + (s.dayRate || 0) + "/day")
            );
          }))
      ),

      tab === "note" && h("div", null,
        h("textarea", { id: "_inv_note", placeholder: "Enter note text\u2026", rows: 3,
          style: { width: "100%", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", resize: "vertical", marginBottom: 10 } }),
        h(window.Btn, { small: true, onClick: function() {
          var el = document.getElementById("_inv_note");
          var txt = el ? el.value.trim() : "";
          if (txt) { onAdd({ id: genId("item"), type: "note", text: txt }); }
        } }, "Add Note"))
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   INVOICE LINE ITEM ROW
  // ═══════════════════════════════════════════════════════════════════════════
  function InvLineItem({ item, sectionId, isDraft, onUpdate, onDelete, services, customerTaxable }) {
    if (item.type === "note") {
      return h("div", { style: { background: B.bg, border: "1px dashed " + B.border, borderRadius: "4px", padding: "8px 12px", display: "flex", alignItems: "center", gap: 10 } },
        h("span", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase" } }, "Note"),
        h("div", { style: { flex: 1, fontSize: "12px", color: B.textSec, fontStyle: "italic" } }, item.text),
        isDraft && h("button", { onClick: function() { onDelete(sectionId, item.id); },
          style: { background: "transparent", border: "none", color: B.textMut, cursor: "pointer", fontSize: "14px" } }, "\u00d7")
      );
    }

    var typeBadge = item.type === "equipment" ? "EQ" : item.type === "product" ? "PR" : "SV";
    var typeBadgeColor = item.type === "equipment" ? B.info : item.type === "product" ? B.success : B.warn;
    var RATE_TYPES = { day: "days", half: "half days", hourly: "hours", ot: "OT hours" };
    var svcRateType = item.type === "service" ? (item.rateType || "day") : null;
    var qtyLabel = svcRateType ? (RATE_TYPES[svcRateType] || "qty") : "qty";
    var svcData = item.type === "service" && item.serviceId ? (services || []).find(function(sv) { return sv.id === item.serviceId; }) : null;
    var adjusted = item.adjustedPrice != null && item.adjustedPrice !== item.unitPrice;
    var eff = item.adjustedPrice != null ? item.adjustedPrice : item.unitPrice;
    var lt = eff * (Number(item.qty) || 0);

    return h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "4px", padding: "8px 12px", display: "flex", alignItems: "center", gap: 10 } },
      h("span", { style: { fontSize: "9px", fontWeight: 700, color: typeBadgeColor, background: typeBadgeColor + "22", border: "1px solid " + typeBadgeColor + "44", padding: "2px 5px", borderRadius: "3px" } }, typeBadge),
      h("div", { style: { flex: 1, minWidth: 0 } },
        h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, item.name),
        item.notes && h("div", { style: { fontSize: "10px", color: B.textMut, fontStyle: "italic" } }, item.notes)
      ),
      // Rate type selector (services only)
      item.type === "service" && isDraft && svcData && h("select", { value: svcRateType, onChange: function(e) {
        var rt = e.target.value;
        var priceMap = { day: svcData.dayRate, half: svcData.halfDay || svcData.dayRate * 0.5, hourly: svcData.hourlyRate || svcData.dayRate / 10, ot: svcData.otRate || svcData.dayRate / 10 * 1.5 };
        var costMap  = { day: svcData.dayCost, half: svcData.halfDayCost || svcData.dayCost * 0.5, hourly: svcData.hourlyCost || svcData.dayCost / 10, ot: svcData.otCost || svcData.dayCost / 10 * 1.5 };
        onUpdate(sectionId, item.id, { rateType: rt, unitPrice: priceMap[rt] || 0, cost: costMap[rt] || 0, adjustedPrice: null });
      }, style: { width: 82, background: B.bg, border: "1px solid " + B.border, borderRadius: "3px", padding: "3px 4px", color: B.text, fontSize: "10px", fontFamily: "inherit", outline: "none" } },
        h("option", { value: "day" }, "Day"),
        h("option", { value: "half" }, "Half Day"),
        h("option", { value: "hourly" }, "Hourly"),
        h("option", { value: "ot" }, "OT")
      ),
      item.type === "service" && !isDraft && h("div", { style: { fontSize: "10px", color: B.warn, fontWeight: 600, width: 82, textAlign: "center" } },
        svcRateType === "day" ? "Day" : svcRateType === "half" ? "Half Day" : svcRateType === "hourly" ? "Hourly" : svcRateType === "ot" ? "OT" : "Day"),
      // Qty
      h("div", { style: { width: 55 } },
        h("div", { style: { fontSize: "9px", color: B.textMut, textAlign: "center" } }, qtyLabel),
        isDraft
          ? h("input", { type: "number", value: item.qty, min: 0,
              onChange: function(e) { onUpdate(sectionId, item.id, { qty: Math.max(0, Number(e.target.value) || 0) }); },
              style: { width: "100%", background: B.bg, border: "1px solid " + B.border, borderRadius: "3px", padding: "3px 6px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", textAlign: "center" } })
          : h("div", { style: { fontSize: "11px", color: B.text, textAlign: "center", padding: "3px 0" } }, item.qty)
      ),
      // Unit price
      h("div", { style: { width: 75 } },
        h("div", { style: { fontSize: "9px", color: B.textMut, textAlign: "right" } }, "unit"),
        h("div", { style: { fontSize: "11px", color: B.textMut, textAlign: "right", padding: "3px 6px", textDecoration: adjusted ? "line-through" : "none" } }, "$" + item.unitPrice)
      ),
      // Adjusted price
      h("div", { style: { width: 75 } },
        h("div", { style: { fontSize: "9px", color: B.textMut, textAlign: "right" } }, "adj"),
        isDraft
          ? h("input", { type: "number", value: item.adjustedPrice != null ? item.adjustedPrice : "", placeholder: String(item.unitPrice),
              onChange: function(e) { var v = e.target.value; onUpdate(sectionId, item.id, { adjustedPrice: v === "" ? null : Number(v) }); },
              style: { width: "100%", background: B.bg, border: "1px solid " + (adjusted ? B.accent : B.border), borderRadius: "3px", padding: "3px 6px", color: adjusted ? B.accent : B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", textAlign: "right" } })
          : h("div", { style: { fontSize: "11px", color: adjusted ? B.accent : B.textMut, textAlign: "right", padding: "3px 0" } }, item.adjustedPrice != null ? "$" + item.adjustedPrice : "\u2014")
      ),
      // Total
      h("div", { style: { width: 85, textAlign: "right" } },
        h("div", { style: { fontSize: "9px", color: B.textMut } }, "total"),
        h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.accent } }, "$" + Math.round(lt).toLocaleString())
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
  function InvoiceBuilder({ invoiceId, isNew, invoices, setInvoices, getNextInvoiceId,
                            companies, setCompanies, contacts, setContacts, projects, quotes, setQuotes,
                            equipment, products, services, settings, isAdmin, qbo }) {

    function emptyInvoice() {
      var today = todayISO();
      return {
        id: null, quoteId: null,
        clientType: "company", companyId: null, clientContactId: null, projectId: null,
        customName: "", status: "draft",
        invoiceDate: today, createdDate: today, sentDate: null, dueDate: net30(today), paidDate: null,
        globalDiscount: { type: "none", value: 0 },
        sections: [{ id: genId("sec"), label: "Items", customDates: false, startDate: "", endDate: "", items: [] }],
        notes: window.LTP_DEFAULT_INVOICE_NOTES || "",
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
        projectId: inv.projectId, customName: inv.customName || "",
        status: inv.status || "draft",
        invoiceDate: inv.invoiceDate || inv.createdDate || todayISO(),
        createdDate: inv.createdDate || todayISO(), sentDate: inv.sentDate || null,
        dueDate: inv.dueDate || "", paidDate: inv.paidDate || null,
        globalDiscount: Object.assign({ type: "none", value: 0 }, inv.globalDiscount || {}),
        sections: (inv.sections || []).map(function(s) {
          return { id: s.id, label: s.label, customDates: !!s.customDates, startDate: s.startDate || "", endDate: s.endDate || "",
                   items: (s.items || []).map(function(i) { return Object.assign({}, i); }) };
        }),
        notes: inv.notes || "",
        payments: (inv.payments || []).map(function(p) { return Object.assign({}, p); }),
        activity: (inv.activity || []).map(function(a) { return Object.assign({}, a); }),
      });
    }

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
    var [sendCc, setSendCc] = useState("");
    var [sending, setSending] = useState(false);
    var [qboSyncing, setQboSyncing] = useState(false);
    var [showReceiptModal, setShowReceiptModal] = useState(false);
    var [sendEmail, setSendEmail] = useState("");
    var [sendSubject, setSendSubject] = useState("");
    var [sendMessage, setSendMessage] = useState("");
    // Per-entity values baked into the {{header}} block at send time —
    // captured at openSendModal / openReceiptModal so a later draft
    // mutation doesn't change what the user sees in the modal preview.
    var [sendHeaderVars, setSendHeaderVars] = useState(null);
    var [payDate, setPayDate] = useState(todayISO());
    var [payAmount, setPayAmount] = useState("");
    var [generatingPdf, setGeneratingPdf] = useState(false);

    // POST /api/invoices/{id}/pdf → trigger download + mirror activity entry.
    // Same pattern as quotes-builder.js. See that file's generatePdf for
    // detailed comments on the flow.
    function generatePdf() {
      if (draft.id == null || generatingPdf) return;
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
          var a = document.createElement("a");
          a.href = resp.downloadUrl;
          a.download = resp.filename || ("INV-" + draft.id + ".pdf");
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
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
    var [payMethod, setPayMethod] = useState("check");
    var [payRef, setPayRef] = useState("");
    var [payNotes, setPayNotes] = useState("");

    function openPaymentForm() {
      setPayDate(todayISO());
      setPayAmount(String(Math.round((t.balance > 0 ? t.balance : 0) * 100) / 100));
      setPayMethod("check");
      setPayRef("");
      setPayNotes("");
      setShowPaymentForm(true);
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
        type: "paid", user: (window.LTP_CURRENT_USER || "User"), message: "Payment recorded: $" + Number(payment.amount).toLocaleString() + (newTotal >= invoiceTotal ? " \u2014 Paid in full" : ""),

        changes: [
          { cat: "Amount", detail: "$" + Number(payment.amount).toLocaleString() },
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

    function openReceiptModal(payments) {
      var email = "";
      var clientName = "";
      if (draft.clientContactId) {
        var ct = contacts.find(function(c) { return c.id === draft.clientContactId; });
        if (ct) { email = ct.email || ""; clientName = ct.firstName + " " + ct.lastName; }
      } else if (draft.companyId) {
        var compContacts = contacts.filter(function(c) { return (c.companyIds || []).includes(draft.companyId); });
        if (compContacts.length > 0) { email = compContacts[0].email || ""; clientName = compContacts[0].firstName; }
      }
      var ref = draft.id != null ? window.LTP_INVOICE_REF(draft) : "Invoice";
      var projName = selectedProject ? selectedProject.name : (draft.customName || "");
      var paymentLines = (payments || draft.payments || []).map(function(p) {
        var methodLabels = { check: "Check", ach: "ACH", credit_card: "Credit Card", cash: "Cash", wire: "Wire", other: "Other" };
        return "  " + fmt(p.date) + " \u2014 $" + Number(p.amount).toLocaleString() + " via " + (methodLabels[p.method] || p.method) + (p.reference ? " (" + p.reference + ")" : "");
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
        total: "$" + Math.round(t.total).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        lineItems: "Payments Received:\n" + paymentLines,
      };
      setSendEmail(email);
      setSendCc(resolve(tmpl.cc || "", vars));
      setSendSubject(resolve(tmpl.subject || "{{refNumber}} — Payment Received", vars));
      setSendMessage(resolve(tmpl.body || "{{header}}\n\nHi {{clientName}},\n\nThank you for your payment.\n\n{{lineItems}}\n\nBalance: $0.00\n\n{{signature}}", vars));
      // headerVars feed both the editor preview and the send-time
      // expansion in sendReceipt. viewUrl blank — backend resolves
      // per-recipient if the receipt body uses {{viewUrl}}.
      // {{viewUrl}} stays literal — backend swaps in the per-recipient URL.
      setSendHeaderVars({ refNumber: ref, projectName: projName, total: vars.total });
      setShowReceiptModal(true);
    }

    function sendReceipt() {
      if (!sendEmail) { showAlert("No Email", "Enter a recipient email address."); return; }
      if (draft.id == null || !draft.shareToken) { showAlert("Save First", "Save the invoice before sending so it has a stable share link."); return; }
      if (!window.LTP_GMAIL_CONNECTED) {
        showAlert("Gmail Not Connected", "Sign out and back in with Google to grant the gmail.send permission, then try again.");
        return;
      }
      setSending(true);
      // Expand {{header}} into rendered HTML (with refNumber / projectName
      // / total inlined) JUST before send. See quotes-builder.js for
      // the full rationale.
      var headerHtml = window.LTP_renderHeader(
        ((settings || {}).emailHeaderTemplate || (window.LTP_DATA_SETTINGS || {}).emailHeaderTemplate),
        sendHeaderVars || {}
      );
      var bodyWithHeader = String(sendMessage).split("{{header}}").join(headerHtml);
      fetch("/api/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "invoice",
          entityId: draft.id,
          to: sendEmail,
          cc: (sendCc || "").trim() || null,  // whitespace-only → omit
          subject: sendSubject,
          bodyHtml: window.LTP_textToHtml(bodyWithHeader),  // plain-text bodies keep paragraph spacing
        }),
      })
        .then(function(r) { return r.json().then(function(body) { return { status: r.status, body: body }; }); })
        .then(function(resp) {
          setSending(false);
          if (resp.status === 200) {
            setShowReceiptModal(false);
            setDlg({ title: "Receipt Sent", message: "Payment receipt sent to " + sendEmail + ".", confirmLabel: "OK", onConfirm: function() { setDlg(null); } });
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
        type: "saved", user: (window.LTP_CURRENT_USER || "User"), message: "Payment removed: $" + (deletedPay ? Number(deletedPay.amount).toLocaleString() : "?"),

        changes: [{ cat: "Payment Removed", detail: "$" + (deletedPay ? Number(deletedPay.amount).toLocaleString() : "?") + " via " + (deletedPay ? deletedPay.method : "?") }]
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
      var templateKey = isDraft ? "invoiceSent" : (window.LTP_isOverdue(draft) ? "invoiceReminder" : "invoiceSent");
      var tmpl = (s.emailTemplates || {})[templateKey] || {};
      // {{viewUrl}} and {{signature}} are intentionally LEFT unresolved here
      // — backend substitutes them per-recipient at send time. See the
      // corresponding comment in modules/quotes-builder.js openQuoteSendModal.
      var vars = {
        companyName: s.companyName || "LTP",
        refNumber: ref,
        projectName: projName,
        clientName: clientName || "there",
        total: "$" + Math.round(t.total).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        dueDate: draft.dueDate ? fmt(draft.dueDate) : "Upon receipt",
      };
      setSendEmail(email);
      setSendCc(resolve(tmpl.cc || "", vars));
      setSendSubject(resolve(tmpl.subject || "{{refNumber}} — {{projectName}} from {{companyName}}", vars));
      setSendMessage(resolve(tmpl.body || "{{header}}\n\nHi {{clientName}},\n\nPlease find attached invoice {{refNumber}}.\n\nDue: {{dueDate}}\n\n{{signature}}", vars));
      // {{viewUrl}} stays literal — backend swaps in the per-recipient URL.
      setSendHeaderVars({ refNumber: ref, projectName: projName, total: vars.total });
      setShowSendModal(true);
    }

    function executeSend() {
      if (!sendEmail || !window.LTP_isValidEmail(sendEmail)) { showAlert("Invalid Email", "Enter a valid email address."); return; }
      if (draft.id == null || !draft.shareToken) { showAlert("Save First", "Save the invoice before sending so it has a stable share link."); return; }
      if (!window.LTP_GMAIL_CONNECTED) {
        showAlert("Gmail Not Connected", "Sign out and back in with Google to grant the gmail.send permission, then try again.");
        return;
      }
      var isResend = draft.status !== "draft";
      setSending(true);
      // Expand {{header}} into rendered HTML JUST before send. See
      // quotes-builder.js for the full rationale on this split.
      var headerHtml = window.LTP_renderHeader(
        ((settings || {}).emailHeaderTemplate || (window.LTP_DATA_SETTINGS || {}).emailHeaderTemplate),
        sendHeaderVars || {}
      );
      var bodyWithHeader = String(sendMessage).split("{{header}}").join(headerHtml);
      fetch("/api/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "invoice",
          entityId: draft.id,
          to: sendEmail,
          cc: (sendCc || "").trim() || null,  // whitespace-only → omit
          subject: sendSubject,
          bodyHtml: window.LTP_textToHtml(bodyWithHeader),  // plain-text bodies keep paragraph spacing
        }),
      })
        .then(function(r) { return r.json().then(function(body) { return { status: r.status, body: body }; }); })
        .then(function(resp) {
          setSending(false);
          if (resp.status === 200) {
            var today = todayISO();
            var updated = Object.assign({}, draft, {
              status: isResend ? draft.status : "sent",
              sentDate: isResend ? draft.sentDate : today,
            });
            setInvoices(function(prev) { return prev.map(function(i) { return i.id === updated.id ? updated : i; }); });
            setDraftRaw(updated); cleanRef.current = updated; setIsDirty(false);
            setShowSendModal(false);
            setDlg({ title: isResend ? "Invoice Resent" : "Invoice Sent", message: "Invoice " + (isResend ? "resent" : "sent") + " to " + sendEmail + ".", confirmLabel: "OK", onConfirm: function() { setDlg(null); } });
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

    function recallToDraft() {
      if (isDraft) return;
      var hasPayments = (draft.payments || []).length > 0;
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
          setDlg(null);
        }
      });
    }

    // ── QuickBooks Online ────────────────────────────────────────────────
    // First push is this explicit button; afterwards edits auto-resync
    // server-side (see backend/routes/api.py). qb* fields are server-
    // authoritative — we only patch them locally for an optimistic display.
    function sendToQuickBooks() {
      if (draft.id == null) { showAlert("Save First", "Save the invoice before sending it to QuickBooks."); return; }
      if (!isAdmin) { showAlert("Admin Only", "Only an admin can push invoices to QuickBooks."); return; }
      if (!qbo || !qbo.connected) { showAlert("QuickBooks Not Connected", "An admin must connect QuickBooks in Settings before pushing invoices."); return; }
      setQboSyncing(true);
      fetch("/api/qbo/invoices/" + draft.id + "/push", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include" })
        .then(function(r) { return r.json().then(function(body) { return { status: r.status, body: body }; }); })
        .then(function(resp) {
          setQboSyncing(false);
          if (resp.status === 200) {
            var b = resp.body || {};
            var updated = Object.assign({}, draft, {
              qbInvoiceId: b.qbInvoiceId, qbSyncToken: b.qbSyncToken, qbSyncStatus: "synced",
              qbSyncedAt: b.qbSyncedAt, qbTaxTotal: b.qbTaxTotal, qbTotalAmt: b.qbTotalAmt, qbLastError: null
            });
            setInvoices(function(prev) { return prev.map(function(i) { return i.id === updated.id ? updated : i; }); });
            setDraftRaw(updated); cleanRef.current = updated; setIsDirty(false);
            setDlg({ title: "Sent to QuickBooks",
              message: "Invoice " + (b.action === "created" ? "created in" : "updated in") + " QuickBooks"
                + (b.qbTaxTotal ? " — sales tax $" + Math.round(b.qbTaxTotal).toLocaleString() + " calculated by QuickBooks." : "."),
              confirmLabel: "OK", onConfirm: function() { setDlg(null); } });
            return;
          }
          var d = resp.body || {};
          if (resp.status === 409 && d.reason === "reconnect") { showAlert("Reconnect QuickBooks", "The QuickBooks connection expired. An admin should reconnect it in Settings."); return; }
          if (resp.status === 409 && d.reason === "not_connected") { showAlert("QuickBooks Not Connected", "An admin must connect QuickBooks in Settings first."); return; }
          showAlert("QuickBooks Sync Failed", d.error || ("HTTP " + resp.status + "."));
        })
        .catch(function(e) { setQboSyncing(false); showAlert("QuickBooks Sync Failed", "Network or server error: " + String(e.message || e)); });
    }

    function billingParty() {
      if (draft.clientType === "contact") return draft.clientContactId ? contacts.find(function(c) { return c.id === draft.clientContactId; }) : null;
      return draft.companyId ? companies.find(function(c) { return c.id === draft.companyId; }) : null;
    }
    // Tax is a CUSTOMER-level flag (with per-line overrides). Toggling it edits
    // the selected Company/Contact row so QuickBooks taxes their invoices.
    function setCustomerTaxable(val) {
      if (draft.clientType === "contact" && draft.clientContactId && setContacts) {
        setContacts(function(prev) { return prev.map(function(c) { return c.id === draft.clientContactId ? Object.assign({}, c, { taxable: val }) : c; }); });
      } else if (draft.companyId && setCompanies) {
        setCompanies(function(prev) { return prev.map(function(c) { return c.id === draft.companyId ? Object.assign({}, c, { taxable: val }) : c; }); });
      }
    }

    useEffect(function() { setDraftRaw(initial); cleanRef.current = initial; setIsDirty(false); pendingRollbacks.current = []; }, [invoiceId, isNew]);

    function showAlert(title, msg) { setDlg({ title: title, message: msg, confirmLabel: "OK", onConfirm: function() { setDlg(null); } }); }

    var isDraft = draft.status === "draft";
    var isLocked = !isDraft; // Invoices locked once sent — must recall to draft to edit
    var refDisplay = draft.id != null ? window.LTP_INVOICE_REF(draft) : "INV-NEW";
    var selectedProject = draft.projectId ? projects.find(function(p) { return p.id === draft.projectId; }) : null;
    var selectedCompany = draft.companyId ? companies.find(function(c) { return c.id === draft.companyId; }) : null;
    var displayName = selectedProject ? selectedProject.name : (draft.customName || "New Invoice");
    var linkedQuote = draft.quoteId ? quotes.find(function(q) { return q.id === draft.quoteId; }) : null;
    var t = window.LTP_INVOICE_TOTALS(draft);

    // QuickBooks display state
    var custParty = billingParty();
    var customerTaxable = !!(custParty && custParty.taxable);
    var qbConnected = !!(qbo && qbo.connected);
    var qbPill = null;
    if (draft.id != null && qbConnected) {
      if (!draft.qbInvoiceId) qbPill = { label: "Not in QuickBooks", color: B.textMut };
      else if (draft.qbSyncStatus === "error") qbPill = { label: "QB sync error", color: B.danger };
      else if (draft.qbSyncStatus === "out_of_date") qbPill = { label: "QB out of date", color: B.warn };
      else qbPill = { label: "✓ In QuickBooks", color: B.success };
    }

    // Section helpers
    function updateItem(secId, itemId, patch) {
      if (!isDraft) return;
      setDraft(function(d) {
        return Object.assign({}, d, { sections: d.sections.map(function(s) {
          if (s.id !== secId) return s;
          return Object.assign({}, s, { items: s.items.map(function(i) {
            if (i.id !== itemId) return i;
            var effective = Object.assign({}, patch);
            // Clamp linkedQty when qty drops below it — qty added on top of
            // linkedQty is "direct" and reducing back through it doesn't
            // touch the source quote's invoicedQty. See sendToInvoice for
            // the model.
            if (patch.qty != null && i.sourceItemId) {
              var newQty = Number(patch.qty) || 0;
              var oldLinked = i.linkedQty != null ? Number(i.linkedQty) : (Number(i.qty) || 0);
              effective.linkedQty = Math.min(newQty, oldLinked);
            }
            return Object.assign({}, i, effective);
          }) });
        })});
      });
    }
    function deleteItem(secId, itemId) {
      if (!isDraft) return;
      // Track deleted linked items for quote rollback on save
      (draft.sections || []).forEach(function(sec) {
        if (sec.id !== secId) return;
        (sec.items || []).forEach(function(it) {
          if (it.id === itemId && it.sourceItemId && draft.quoteId) {
            // Only the linked portion (capped at original conversion qty)
            // counts against the quote; legacy items without linkedQty fall
            // back to the full qty.
            var linked = it.linkedQty != null ? (Number(it.linkedQty) || 0) : (Number(it.qty) || 0);
            pendingRollbacks.current.push({ sourceItemId: it.sourceItemId, qty: linked, name: it.name || "" });
          }
        });
      });
      // Remove item from draft
      setDraft(function(d) {
        return Object.assign({}, d, { sections: d.sections.map(function(s) {
          if (s.id !== secId) return s;
          return Object.assign({}, s, { items: s.items.filter(function(i) { return i.id !== itemId; }) });
        })});
      });
    }
    function addItemToSection(secId, item) {
      if (!isDraft) return;
      setDraft(function(d) {
        return Object.assign({}, d, { sections: d.sections.map(function(s) {
          if (s.id !== secId) return s;
          return Object.assign({}, s, { items: s.items.concat([item]) });
        })});
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
        return Object.assign({}, d, { sections: d.sections.map(function(s) { return s.id === secId ? Object.assign({}, s, { label: label }) : s; }) });
      });
    }
    function deleteSection(secId) {
      if (!isDraft) return;
      if (draft.sections.length <= 1) { showAlert("Cannot Delete", "Invoice must have at least one section."); return; }
      setDraft(function(d) { return Object.assign({}, d, { sections: d.sections.filter(function(s) { return s.id !== secId; }) }); });
    }

    // Section totals
    function sectionTotals(sec) {
      var sub = 0, cost = 0;
      sec.items.forEach(function(it) {
        if (it.type === "note") return;
        var qty = Number(it.qty) || 0;
        var eff = it.adjustedPrice != null ? it.adjustedPrice : it.unitPrice;
        sub += eff * qty;
        cost += (it.cost || 0) * qty;
      });
      return { subtotal: sub, cost: cost };
    }

    // Actions
    function computeInvChanges(before, after) {
      if (!before || !after) return null;
      var changes = [];
      var tB = window.LTP_INVOICE_TOTALS(before), tA = window.LTP_INVOICE_TOTALS(after);
      if (Math.round(tB.total) !== Math.round(tA.total)) changes.push({ cat: "Invoice Total", detail: "$" + Math.round(tB.total).toLocaleString() + " \u2192 $" + Math.round(tA.total).toLocaleString() });
      if (before.status !== after.status) changes.push({ cat: "Status", detail: (before.status || "draft") + " \u2192 " + (after.status || "draft") });
      if (before.dueDate !== after.dueDate) {
        var dbf = before.dueDate ? fmt(before.dueDate) : "Not set";
        var daf = after.dueDate ? fmt(after.dueDate) : "Not set";
        changes.push({ cat: "Due Date", detail: dbf + " \u2192 " + daf });
      }
      if (before.invoiceDate !== after.invoiceDate) {
        var ibf = before.invoiceDate ? fmt(before.invoiceDate) : "Not set";
        var iaf = after.invoiceDate ? fmt(after.invoiceDate) : "Not set";
        changes.push({ cat: "Invoice Date", detail: ibf + " \u2192 " + iaf });
      }
      if (before.companyId !== after.companyId) {
        var cBefore = before.companyId ? ((companies.find(function(c) { return c.id === before.companyId; }) || {}).name || "ID " + before.companyId) : "None";
        var cAfter = after.companyId ? ((companies.find(function(c) { return c.id === after.companyId; }) || {}).name || "ID " + after.companyId) : "None";
        changes.push({ cat: "Company", detail: cBefore + " \u2192 " + cAfter });
      }
      if (before.projectId !== after.projectId) {
        var pBefore = before.projectId ? ((projects.find(function(p) { return p.id === before.projectId; }) || {}).name || "ID " + before.projectId) : "None";
        var pAfter = after.projectId ? ((projects.find(function(p) { return p.id === after.projectId; }) || {}).name || "ID " + after.projectId) : "None";
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
      // Section/item level
      var bSecMap = {}; (before.sections || []).forEach(function(s) { bSecMap[s.id] = s; });
      (after.sections || []).forEach(function(aSec) {
        if (!bSecMap[aSec.id]) { changes.push({ cat: "Section Added", detail: "\"" + aSec.label + "\"" }); return; }
        var bSec = bSecMap[aSec.id];
        if (bSec.label !== aSec.label) changes.push({ cat: "Section Renamed", detail: "\"" + bSec.label + "\" \u2192 \"" + aSec.label + "\"" });
        var bItemMap = {}; (bSec.items || []).forEach(function(i) { bItemMap[i.id] = i; });
        (aSec.items || []).forEach(function(i) {
          if (i.type === "note") return;
          if (!bItemMap[i.id]) { changes.push({ cat: aSec.label + " \u2014 Added", detail: i.name + " \u00d7" + i.qty }); return; }
          var bi = bItemMap[i.id];
          if (bi.qty !== i.qty) changes.push({ cat: aSec.label + " \u2014 Qty", detail: i.name + ": " + bi.qty + " \u2192 " + i.qty });
          if (bi.unitPrice !== i.unitPrice) changes.push({ cat: aSec.label + " \u2014 Price", detail: i.name + ": $" + bi.unitPrice + " \u2192 $" + i.unitPrice });
          if ((bi.adjustedPrice || null) !== (i.adjustedPrice || null)) {
            changes.push({ cat: aSec.label + " \u2014 Adj.", detail: i.name + ": " + (bi.adjustedPrice != null ? "$" + bi.adjustedPrice : "$" + bi.unitPrice + " (base)") + " \u2192 " + (i.adjustedPrice != null ? "$" + i.adjustedPrice : "$" + i.unitPrice + " (base)") });
          }
        });
        (bSec.items || []).forEach(function(i) { if (i.type !== "note" && !(aSec.items || []).find(function(ai) { return ai.id === i.id; })) changes.push({ cat: aSec.label + " \u2014 Removed", detail: i.name }); });
      });
      (before.sections || []).forEach(function(s) { if (!(after.sections || []).find(function(as) { return as.id === s.id; })) changes.push({ cat: "Section Removed", detail: "\"" + s.label + "\"" }); });
      return changes.length > 0 ? changes : null;
    }

    // Auto-save after payment recording — bypasses lock since payments are operational, not edits
    function autoSavePayment() {
      setDraftRaw(function(cur) {
        setInvoices(function(prev) {
          if (cur.id == null) return prev;
          return prev.map(function(inv) { return inv.id === cur.id ? Object.assign({}, cur) : inv; });
        });
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
      var changes = computeInvChanges(cleanRef.current, draft);
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
      if (draft.quoteId && Array.isArray(cleanSnap.sections)) {
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
          var oldLinked = linkedOf(cleanLinkedItems[itemId]);
          var newLinked = linkedOf(draftLinkedItems[itemId]);
          var delta = oldLinked - newLinked;
          if (delta > 0) {
            rollbacks.push({ sourceItemId: cleanLinkedItems[itemId].sourceItemId, qty: delta, name: cleanLinkedItems[itemId].name || "" });
          }
        });
      }
      if (rollbacks.length > 0 && draft.quoteId && setQuotes) {
        var reductions = {};
        var rollbackDetails = [];
        rollbacks.forEach(function(rb) {
          if (rb.qty > 0) {
            reductions[rb.sourceItemId] = (reductions[rb.sourceItemId] || 0) + rb.qty;
            rollbackDetails.push({ cat: "Invoiced Qty Reduced", detail: (rb.name || "Item") + ": -" + rb.qty });
          }
        });
        if (Object.keys(reductions).length > 0) {
          setQuotes(function(prevQuotes) {
            return prevQuotes.map(function(q) {
              if (q.id !== draft.quoteId) return q;
              var updatedSections = q.sections.map(function(sec) {
                return Object.assign({}, sec, { items: sec.items.map(function(qi) {
                  if (!reductions[qi.id]) return qi;
                  return Object.assign({}, qi, { invoicedQty: Math.max(0, (Number(qi.invoicedQty) || 0) - reductions[qi.id]) });
                })});
              });
              var newStatus = q.status === "converted" ? "accepted" : q.status;
              if (newStatus !== q.status) rollbackDetails.push({ cat: "Status", detail: q.status + " \u2192 " + newStatus });
              var actEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0,5),
                type: "invoiced", user: (window.LTP_CURRENT_USER || "User"), message: "Invoiced quantities reduced from " + refDisplay,
 changes: rollbackDetails };
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
        ? "\n\nThis invoice has " + draft.payments.length + " recorded payment" + (draft.payments.length > 1 ? "s" : "") + " totaling $" + Math.round((draft.payments || []).reduce(function(s, p) { return s + (Number(p.amount) || 0); }, 0)).toLocaleString() + ". Deleting will erase the payment records."
        : "";
      setDlg({ title: "Delete Invoice", message: "Permanently delete " + refDisplay + "?" + (draft.quoteId ? " This will reduce invoiced quantities on the source quote." : "") + paymentWarning, variant: "danger", confirmLabel: hasPayments ? "Delete with Payments" : "Delete",
        onConfirm: function() {
          // If linked to a quote, reduce invoicedQty on matching quote items
          if (draft.quoteId && setQuotes) {
            setQuotes(function(prevQuotes) {
              return prevQuotes.map(function(q) {
                if (q.id !== draft.quoteId) return q;
                // Build a map of sourceItemId → qty to reduce. Use linkedQty
                // (fallback qty for legacy items) so direct-added qty above
                // the linked baseline doesn't double-decrement the quote.
                var reductions = {};
                (draft.sections || []).forEach(function(sec) {
                  (sec.items || []).forEach(function(it) {
                    if (it.type === "note" || !it.sourceItemId) return;
                    var linked = it.linkedQty != null ? (Number(it.linkedQty) || 0) : (Number(it.qty) || 0);
                    reductions[it.sourceItemId] = (reductions[it.sourceItemId] || 0) + linked;
                  });
                });
                // Apply reductions to quote sections
                var updatedSections = q.sections.map(function(sec) {
                  var updatedItems = sec.items.map(function(qi) {
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
                  q.sections.forEach(function(sec) {
                    sec.items.forEach(function(qi) { if (qi.id === srcId) itemName = qi.name; });
                  });
                  actChanges.push({ cat: "Invoiced Qty Reduced", detail: (itemName || "Item") + ": -" + reductions[srcId] });
                });
                if (newStatus !== q.status) actChanges.push({ cat: "Status", detail: q.status + " \u2192 " + newStatus });
                var actEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0,5),
                  type: "invoiced", user: (window.LTP_CURRENT_USER || "User"), message: "Invoice " + refDisplay + " deleted \u2014 invoiced quantities reduced",
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
      });
    }

    // Available companies/projects for dropdowns
    var projectContacts = selectedProject
      ? contacts.filter(function(c) { return (selectedProject.contactIds || []).includes(c.id); })
      : selectedCompany ? contacts.filter(function(c) { return (c.companyIds || []).includes(selectedCompany.id); }) : [];

    // ── Render ───────────────────────────────────────────────────────────────
    return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" } },
      // Sticky header
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: "12px 16px", flexShrink: 0, zIndex: 5 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 14 } },
          h("button", { onClick: function() { nav("invoices"); },
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textSec, fontSize: "11px", fontFamily: "inherit", cursor: "pointer" } }, "\u2190 Back"),
          h("div", null,
            h("div", { style: { fontSize: "22px", fontWeight: 700, color: B.accent, fontFamily: "'Playfair Display', serif", letterSpacing: "0.02em", lineHeight: 1.1 } }, refDisplay),
            h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 3 } },
              h("span", { style: { fontSize: "12px", color: B.textSec } }, displayName),
              h(window.Badge, { status: window.LTP_displayStatus(draft) }),
              t.paid > 0 && t.balance > 0 && window.LTP_isOverdue(draft) && h(window.Badge, { status: "overdue" }),
              linkedQuote && h("span", { style: { fontSize: "10px", color: B.textMut } }, "from " + window.LTP_QUOTE_REF(linkedQuote))))),
        h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
          justSaved && h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.success, background: B.successBg, border: "1px solid " + B.successBd, padding: "5px 10px", borderRadius: "6px" } }, "\u2713 Saved"),
          !isDraft && h("div", { style: { fontSize: "10px", color: B.warn, padding: "4px 10px", border: "1px solid " + B.warn, borderRadius: "6px" } }, "\ud83d\udd12 Locked"),
          // Generate PDF \u2014 only meaningful for saved invoices.
          draft.id != null && h("button", {
              onClick: generatePdf,
              disabled: generatingPdf,
              style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: generatingPdf ? B.textMut : B.textSec, fontSize: "11px", fontFamily: "inherit", cursor: generatingPdf ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 5, opacity: generatingPdf ? 0.6 : 1 } },
            generatingPdf ? "\u23f3 Generating\u2026" : "\ud83d\udcc4 Generate PDF"
          ),
          // Preview the read-only client view (?preview=1 is UX-only;
          // invoice view has no actions anyway, but stay consistent with quotes).
          draft.id != null && draft.shareToken && h("a", {
              href: "#/view/invoice/" + draft.shareToken + "?preview=1",
              target: "_blank",
              rel: "noopener",
              style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textSec, fontSize: "11px", fontFamily: "inherit", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, textDecoration: "none" } },
            "\ud83d\udc41 Preview"
          ),
          // Recall to draft (any non-draft invoice)
          !isDraft && h("button", { onClick: recallToDraft,
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textMut, fontSize: "11px", fontFamily: "inherit", cursor: "pointer" },
            onMouseOver: function(e) { e.currentTarget.style.borderColor = B.warn; e.currentTarget.style.color = B.warn; },
            onMouseOut: function(e) { e.currentTarget.style.borderColor = B.border; e.currentTarget.style.color = B.textMut; } }, "\u21a9 Recall to Draft"),
          // Send Receipt (paid invoices)
          draft.status === "paid" && h("button", { onClick: function() { openReceiptModal(); },
            style: { background: B.success, border: "none", borderRadius: "6px", padding: "6px 12px", color: "#000", fontSize: "11px", fontWeight: 700, fontFamily: "inherit", cursor: "pointer" } }, "\u2709 Send Receipt"),
          // Send / Resend button
          isDraft && draft.id != null && h("button", { onClick: openSendModal,
            style: { background: B.success, border: "none", borderRadius: "6px", padding: "6px 16px", color: "#000", fontSize: "11px", fontWeight: 700, fontFamily: "inherit", cursor: "pointer" } }, "\u2709 Send Invoice"),
          !isDraft && draft.id != null && h("button", { onClick: openSendModal,
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textSec, fontSize: "11px", fontFamily: "inherit", cursor: "pointer" } }, "\u2709 Resend"),
          window.LTP_isOverdue(draft) && h("span", { style: { fontSize: "10px", fontWeight: 700, color: B.danger, background: B.danger + "22", border: "1px solid " + B.danger + "44", padding: "4px 10px", borderRadius: "6px" } }, "OVERDUE"),
          // QuickBooks status pill + push button (admin + connected)
          qbPill && h("span", { title: draft.qbLastError || "", style: { fontSize: "10px", fontWeight: 700, color: qbPill.color, background: qbPill.color + "18", border: "1px solid " + qbPill.color + "44", padding: "4px 9px", borderRadius: "6px", whiteSpace: "nowrap" } }, qbPill.label),
          draft.id != null && isAdmin && qbConnected && h("button", { onClick: sendToQuickBooks, disabled: qboSyncing,
            style: { background: draft.qbInvoiceId ? "transparent" : "#2CA01C", border: "1px solid " + (draft.qbInvoiceId ? B.border : "#2CA01C"), borderRadius: "6px", padding: "6px 12px", color: draft.qbInvoiceId ? B.textSec : "#fff", fontSize: "11px", fontWeight: 700, fontFamily: "inherit", cursor: qboSyncing ? "wait" : "pointer", opacity: qboSyncing ? 0.6 : 1, whiteSpace: "nowrap" } },
            qboSyncing ? "⏳ Syncing…" : (draft.qbInvoiceId ? "↻ Update QuickBooks" : "→ Send to QuickBooks")),
          draft.id != null && h(window.Btn, { small: true, variant: "danger", onClick: deleteInvoice }, "Delete"),
          isDirty && h(window.Btn, { small: true, variant: "ghost", onClick: discard }, "Discard"),
          isDirty && !isLocked && h(window.Btn, { small: true, onClick: save }, draft.id == null ? "Save Invoice" : "Save Changes"))
      ),

      // Body
      h("div", { style: { flex: 1, display: "flex", gap: 14, overflow: "hidden", paddingTop: 14 } },
        // Main content
        h("div", { style: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, minWidth: 0 } },

          // Invoice details card
          h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: 16 } },
            h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 12px" } }, "Invoice Details"),

            !isDraft
              // LOCKED — read-only summary
              ? h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 } },
                  h("div", null,
                    h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4 } }, "Client"),
                    h("div", { style: { fontSize: "12px", color: B.text, fontWeight: 600 } },
                      selectedCompany ? selectedCompany.name :
                      draft.clientContactId ? ((contacts.find(function(c) { return c.id === draft.clientContactId; }) || {}).firstName || "") + " " + ((contacts.find(function(c) { return c.id === draft.clientContactId; }) || {}).lastName || "") : "\u2014")),
                  h("div", null,
                    h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4 } }, "Project"),
                    h("div", { style: { fontSize: "12px", color: B.text, fontWeight: 600 } }, selectedProject ? selectedProject.name : (draft.customName || "\u2014"))),
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
                        style: { background: draft.clientType === ct ? B.accent : B.raised, color: draft.clientType === ct ? "#000" : B.textMut, border: "1px solid " + (draft.clientType === ct ? B.accent : B.border), borderRadius: "4px", padding: "5px 14px", fontSize: "11px", fontWeight: 600, cursor: "pointer" } },
                        ct === "company" ? "Company" : "Individual Contact");
                    })
                  ),

                  // Company mode
                  draft.clientType === "company" && h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
                    h(window.CompanySearchField, {
                      label: "Company *", compId: draft.companyId,
                      setCompId: function(id) { patchDraft({ companyId: id, clientContactId: null }); },
                      companies: companies, onClear: function() { patchDraft({ companyId: null, clientContactId: null }); }
                    }),
                    h(window.LTPSelect, { label: "Primary Contact",
                      value: draft.clientContactId || "",
                      onChange: function(v) { patchDraft({ clientContactId: v ? Number(v) : null }); },
                      options: [{ value: "", label: "(none)" }].concat(
                        (selectedCompany ? contacts.filter(function(c) { return (c.companyIds || []).includes(selectedCompany.id); }) : [])
                          .map(function(c) { return { value: c.id, label: c.firstName + " " + c.lastName + (c.role ? " \u2014 " + c.role : "") }; }))
                    })
                  ),

                  // Contact mode
                  draft.clientType === "contact" && h("div", null,
                    h(window.ContactSearchField, {
                      label: "Contact *", contactId: draft.clientContactId,
                      setContactId: function(id) { patchDraft({ clientContactId: id }); },
                      contacts: contacts, placeholder: "Search all contacts\u2026"
                    })
                  ),

                  h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 } },
                    // Project picker — filtered by company
                    h(window.LTPSelect, { label: "Linked Project",
                      value: draft.projectId || "",
                      onChange: function(v) {
                        var pid = Number(v) || null;
                        if (pid && draft.companyId) {
                          var proj = projects.find(function(p) { return p.id === pid; });
                          if (proj && proj.companyId && proj.companyId !== draft.companyId) {
                            var projComp = companies.find(function(c) { return c.id === proj.companyId; });
                            var invComp = companies.find(function(c) { return c.id === draft.companyId; });
                            showAlert("Company Mismatch", "This project belongs to " + (projComp ? projComp.name : "a different company") + " but this invoice is for " + (invComp ? invComp.name : "another company") + ".");
                          }
                        }
                        patchDraft({ projectId: pid });
                      },
                      options: [{ value: "", label: "(no project \u2014 use custom name)" }].concat(
                        (draft.clientType === "company" && draft.companyId ? projects.filter(function(p) { return p.companyId === draft.companyId; }) : projects)
                          .filter(function(p) { return p.status !== "completed" || p.id === draft.projectId; })
                          .map(function(p) { return { value: p.id, label: p.name + " \u00b7 " + fmt(p.startDate) }; }))
                    }),
                    // Custom name when no project
                    !draft.projectId && h(window.LTPInput, {
                      label: "Custom Invoice Name", value: draft.customName || "",
                      onChange: function(v) { patchDraft({ customName: v }); },
                      placeholder: "e.g. Consulting \u2014 May 2026"
                    })
                  ),
                  h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 } },
                    // Invoice date
                    h(window.LTPInput, { label: "Invoice Date", value: draft.invoiceDate || "", type: "date",
                      onChange: function(v) { patchDraft({ invoiceDate: v }); } }),
                    // Due date with net options
                    h("div", null,
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
              "Linked to: ", h("span", { style: { color: B.accent, cursor: "pointer", fontWeight: 600 }, onClick: function() { nav("quotes/" + linkedQuote.id); } }, window.LTP_QUOTE_REF(linkedQuote)))
          ),

          // Sections
          draft.sections.map(function(sec) {
            var st = sectionTotals(sec);
            return h("div", { key: sec.id, style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: 12 } },
              // Section header
              h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 } },
                isDraft
                  ? h("input", { type: "text", value: sec.label,
                      onChange: function(e) { updateSectionLabel(sec.id, e.target.value); },
                      style: { flex: 1, background: "transparent", border: "none", borderBottom: "1px solid " + B.border, color: B.text, fontSize: "14px", fontWeight: 700, fontFamily: "'Playfair Display', serif", outline: "none", padding: "4px 0" } })
                  : h("div", { style: { flex: 1, fontSize: "14px", fontWeight: 700, color: B.accent, fontFamily: "'Playfair Display', serif" } }, sec.label),
                h("div", { style: { fontSize: "11px", color: B.textMut } }, "$" + Math.round(st.subtotal).toLocaleString()),
                isDraft && draft.sections.length > 1 && h("button", { onClick: function() { deleteSection(sec.id); },
                  style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "4px", color: B.textMut, cursor: "pointer", fontSize: "11px", padding: "3px 8px" } }, "Delete")
              ),
              // Items
              h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 } },
                sec.items.length === 0 && h("div", { style: { padding: 14, textAlign: "center", color: B.textMut, fontSize: "11px", fontStyle: "italic", background: B.surface, borderRadius: "4px", border: "1px dashed " + B.border } }, "No items yet."),
                sec.items.map(function(it) {
                  return h(InvLineItem, { key: it.id, item: it, sectionId: sec.id, isDraft: isDraft, onUpdate: updateItem, onDelete: deleteItem, services: services, customerTaxable: customerTaxable });
                })
              ),
              isDraft && h("button", { onClick: function() { setPickerForSection(sec.id); },
                style: { background: "transparent", border: "1px dashed " + B.accent + "66", color: B.accent, cursor: "pointer", fontSize: "11px", fontWeight: 600, padding: "8px", borderRadius: "4px", width: "100%" } }, "+ Add Item")
            );
          }),
          isDraft && h("button", { onClick: addSection,
            style: { background: "transparent", border: "1px dashed " + B.border, color: B.textMut, cursor: "pointer", fontSize: "12px", fontWeight: 600, padding: "12px", borderRadius: "8px", width: "100%" } }, "+ Add Section"),

          // Totals
          h("div", { style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: "14px 18px" } },
            h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: "12px", color: B.textSec } },
              h("span", null, "Subtotal"), h("span", null, "$" + Math.round(t.subtotal).toLocaleString())),
            t.subtotal !== t.adjusted && h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: "11px", color: B.textMut } },
              h("span", null, "Adjustments"), h("span", null, "-$" + Math.round(t.subtotal - t.adjusted).toLocaleString())),
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
            // lines. Most clients are exempt, so this defaults off.
            isDraft && custParty && h("div", { style: { display: "flex", gap: 8, alignItems: "center", padding: "6px 0", fontSize: "11px", color: B.textMut } },
              h("label", { style: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer" } },
                h("input", { type: "checkbox", checked: customerTaxable, onChange: function(e) { setCustomerTaxable(e.target.checked); } }),
                h("span", null, "Customer is taxable")),
              customerTaxable && h("span", { style: { fontSize: "9px", color: B.textMut, fontStyle: "italic" } }, draft.qbTaxTotal != null ? "tax via QuickBooks" : "tax pending QuickBooks")),
            // QuickBooks-computed sales tax (read-only, pulled back after push).
            draft.qbTaxTotal != null && draft.qbTaxTotal > 0 && h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: "11px", color: B.textMut } },
              h("span", null, "Sales Tax (QuickBooks)"), h("span", null, "$" + Math.round(draft.qbTaxTotal).toLocaleString())),
            h("div", { style: { display: "flex", justifyContent: "space-between", padding: "8px 0 4px", borderTop: "2px solid " + B.accent, marginTop: 6, fontSize: "14px", fontWeight: 700 } },
              h("span", { style: { color: B.text } }, "Total"), h("span", { style: { color: B.accent } }, "$" + Math.round(t.total).toLocaleString())),
            // QB tax-inclusive total when it differs (taxable invoices).
            draft.qbTotalAmt != null && Math.abs((draft.qbTotalAmt || 0) - t.total) > 0.5 && h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: "11px", color: B.success } },
              h("span", null, "Total incl. tax (QuickBooks)"), h("span", null, "$" + Math.round(draft.qbTotalAmt).toLocaleString())),
            t.paid > 0 && h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: "11px", color: B.success } },
              h("span", null, "Paid"), h("span", null, "$" + Math.round(t.paid).toLocaleString())),
            t.balance > 0 && h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: "12px", fontWeight: 700, color: t.balance > 0 ? B.warn : B.success } },
              h("span", null, "Balance Due"), h("span", null, "$" + Math.round(t.balance).toLocaleString()))
          )
        ),

        // Side panel
        h("div", { style: { width: 280, flexShrink: 0, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto" } },
          // Summary
          h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: 14 } },
            h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 10px" } }, "Invoice Summary"),
            draft.sections.map(function(sec) {
              var st = sectionTotals(sec);
              var cnt = sec.items.filter(function(i) { return i.type !== "note"; }).length;
              return h("div", { key: sec.id, style: { display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid " + B.border } },
                h("div", null,
                  h("div", { style: { fontSize: "11px", fontWeight: 600, color: B.text } }, sec.label),
                  h("div", { style: { fontSize: "9px", color: B.textMut } }, cnt + " items")),
                h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.accent } }, "$" + Math.round(st.subtotal).toLocaleString()));
            }),
            h("div", { style: { display: "flex", justifyContent: "space-between", padding: "6px 0 4px", borderTop: "2px solid " + B.accent, marginTop: 4 } },
              h("span", { style: { fontSize: "13px", fontWeight: 700, color: B.text } }, "Total"),
              h("span", { style: { fontSize: "14px", fontWeight: 700, color: B.accent } }, "$" + Math.round(t.total).toLocaleString())),
            t.paid > 0 && h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0" } },
              h("span", { style: { fontSize: "11px", color: B.success } }, "Paid"),
              h("span", { style: { fontSize: "11px", fontWeight: 600, color: B.success } }, "$" + Math.round(t.paid).toLocaleString())),
            t.balance > 0 && h("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0" } },
              h("span", { style: { fontSize: "12px", fontWeight: 700, color: B.warn } }, "Balance"),
              h("span", { style: { fontSize: "12px", fontWeight: 700, color: B.warn } }, "$" + Math.round(t.balance).toLocaleString()))
          ),
          // Notes
          h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: 14 } },
            h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 8px" } }, "Notes"),
            h("textarea", { value: draft.notes || "", onChange: function(e) { patchDraft({ notes: e.target.value }); },
              placeholder: "Invoice notes\u2026",
              style: { width: "100%", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", resize: "vertical", minHeight: 50 } })
          ),
          // Payments — only visible after invoice is sent
          !isDraft && h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: 14 } },
            h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
              h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.05em", margin: 0 } }, "Payments"),
              h("button", { onClick: function() { showPaymentForm ? setShowPaymentForm(false) : openPaymentForm(); },
                style: { background: showPaymentForm ? B.raised : B.success, border: "none", borderRadius: "4px", padding: "3px 10px", color: showPaymentForm ? B.textMut : "#000", fontSize: "10px", fontWeight: 700, cursor: "pointer" } },
                showPaymentForm ? "Cancel" : "+ Record Payment")),
            // Payment list
            (draft.payments || []).length === 0
              ? h("div", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic", textAlign: "center", padding: "8px 0" } }, "No payments recorded.")
              : h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                  (draft.payments || []).map(function(pay) {
                    var methodLabels = { check: "Check", ach: "ACH", credit_card: "CC", cash: "Cash", wire: "Wire", other: "Other" };
                    return h("div", { key: pay.id, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", background: B.raised, borderRadius: "4px", border: "1px solid " + B.border } },
                      h("div", null,
                        h("div", { style: { fontSize: "11px", fontWeight: 600, color: B.success } }, "$" + Number(pay.amount).toLocaleString()),
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
                    h("span", { style: { color: B.success, fontWeight: 700 } }, "$" + Math.round(t.paid).toLocaleString()))
                )
          ),
          // Linked Quote
          linkedQuote && h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: 14 } },
            h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 8px" } }, "Linked Quote"),
            h("div", {
              onClick: function() { nav("quotes/" + linkedQuote.id); },
              style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", background: B.raised, borderRadius: "4px", cursor: "pointer", border: "1px solid " + B.border },
              onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent + "44"; },
              onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
              h("div", null,
                h("div", { style: { fontSize: "11px", fontWeight: 600, color: B.accent } }, window.LTP_QUOTE_REF(linkedQuote)),
                h("div", { style: { fontSize: "9px", color: B.textMut } }, fmt(linkedQuote.createdDate || ""))),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                h("span", { style: { fontSize: "11px", fontWeight: 700, color: B.text } }, "$" + Math.round((window.LTP_QUOTE_TOTALS(linkedQuote) || {}).total || 0).toLocaleString()),
                h(window.Badge, { status: linkedQuote.status }))
            )
          ),
          // Activity
          h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: 14, flex: 1, display: "flex", flexDirection: "column", minHeight: 100 } },
            h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 8px" } }, "Activity"),
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
        equipment: equipment, products: products, services: services,
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
      showPaymentForm && h(window.LTPModal, { title: "Record Payment", onClose: function() { setShowPaymentForm(false); } },
        h("div", { style: { marginBottom: 12 } },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: B.raised, borderRadius: "6px", border: "1px solid " + B.border } },
            h("div", null,
              h("div", { style: { fontSize: "10px", color: B.textMut } }, "Invoice Total"),
              h("div", { style: { fontSize: "14px", fontWeight: 700, color: B.accent } }, "$" + Math.round(t.total).toLocaleString())),
            h("div", { style: { textAlign: "center" } },
              h("div", { style: { fontSize: "10px", color: B.textMut } }, "Already Paid"),
              h("div", { style: { fontSize: "14px", fontWeight: 700, color: t.paid > 0 ? B.success : B.textMut } }, "$" + Math.round(t.paid).toLocaleString())),
            h("div", { style: { textAlign: "right" } },
              h("div", { style: { fontSize: "10px", color: B.textMut } }, "Balance Due"),
              h("div", { style: { fontSize: "14px", fontWeight: 700, color: t.balance > 0 ? B.warn : B.success } }, "$" + Math.round(t.balance).toLocaleString())))
        ),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
          h(window.LTPInput, { label: "Payment Date", value: payDate, onChange: setPayDate, type: "date" }),
          h(window.LTPInput, { label: "Amount *", value: payAmount, onChange: setPayAmount, type: "number", placeholder: "0.00" })),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 } },
          h(window.LTPSelect, { label: "Payment Method", value: payMethod, onChange: setPayMethod,
            options: [{ value: "check", label: "Check" }, { value: "ach", label: "ACH / Bank Transfer" }, { value: "credit_card", label: "Credit Card" }, { value: "cash", label: "Cash" }, { value: "wire", label: "Wire Transfer" }, { value: "other", label: "Other" }] }),
          h(window.LTPInput, { label: "Reference / Check #", value: payRef, onChange: setPayRef, placeholder: "e.g. CHK-4412" })),
        h("div", { style: { marginTop: 12 } },
          h(window.LTPInput, { label: "Notes (optional)", value: payNotes, onChange: setPayNotes, placeholder: "Payment notes\u2026" })),
        h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 } },
          h(window.Btn, { variant: "ghost", onClick: function() { setShowPaymentForm(false); } }, "Cancel"),
          h(window.Btn, { onClick: function() {
            var amt = Number(payAmount);
            if (!payAmount || amt <= 0) { alert("Enter a valid payment amount."); return; }
            if (!payDate) { alert("Enter a payment date."); return; }
            if (amt > t.balance && t.balance > 0) {
              if (!window.confirm("This payment ($" + amt.toLocaleString() + ") exceeds the balance due ($" + Math.round(t.balance).toLocaleString() + "). Record anyway?")) return;
            }
            addPayment({ date: payDate, amount: amt, method: payMethod, reference: payRef, notes: payNotes });
          } }, "Record Payment"))
      ),

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
                h("span", { style: { color: B.accent } }, "$" + Math.round(t.total).toLocaleString())),
              t.paid > 0 && h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "11px", marginTop: 4 } },
                h("span", { style: { color: B.success } }, "Paid"),
                h("span", { style: { color: B.success } }, "$" + Math.round(t.paid).toLocaleString())),
              t.balance > 0 && t.balance !== t.total && h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "12px", fontWeight: 700, marginTop: 4 } },
                h("span", { style: { color: B.warn } }, "Balance"),
                h("span", { style: { color: B.warn } }, "$" + Math.round(t.balance).toLocaleString()))
            )
          ),
          // Right: Email preview
          h("div", { style: { flex: 1, background: B.bg, border: "1px solid " + B.border, borderRadius: "8px", display: "flex", flexDirection: "column", overflow: "hidden" } },
            h("div", { style: { padding: "10px 14px", borderBottom: "1px solid " + B.border, background: B.surface } },
              h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 } }, "Email Preview"),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 5 } },
                h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "From:"),
                h("span", { style: { fontSize: "11px", color: B.text } },
                  (window.LTP_SENDER_NAME || "") + (window.LTP_SENDER_EMAIL ? " <" + window.LTP_SENDER_EMAIL + ">" : ""))),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 5 } },
                h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "To:"),
                h("input", { value: sendEmail, onChange: function(e) { setSendEmail(e.target.value); },
                  style: { flex: 1, background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none" }, placeholder: "client@example.com" })),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 5 } },
                h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "CC:"),
                h("input", { value: sendCc, onChange: function(e) { setSendCc(e.target.value); },
                  style: { flex: 1, background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none" }, placeholder: "comma-separated (optional)" })),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "Subj:"),
                h("input", { value: sendSubject, onChange: function(e) { setSendSubject(e.target.value); },
                  style: { flex: 1, background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 8px", color: B.text, fontSize: "11px", fontWeight: 600, fontFamily: "inherit", outline: "none" } }))),
            !window.LTP_GMAIL_CONNECTED && h("div", { style: { padding: "8px 14px", background: B.warn + "11", borderBottom: "1px solid " + B.warn + "44", fontSize: "11px", color: B.warn } },
              "\u26a0 Gmail isn't connected for your account. Sign out and back in with Google to grant the gmail.send permission."),
            // WYSIWYG body editor (see modules/quotes-builder.js for the
            // matching block + rationale). sendMessage state still keeps
            // placeholders intact; EmailBodyEditor renders the signature
            // as a non-editable block locally and reverses the
            // substitution on every input.
            h(window.EmailBodyEditor, {
              value: sendMessage,
              signatureTemplate: ((settings || {}).emailSignatureTemplate || (window.LTP_DATA_SETTINGS || {}).emailSignatureTemplate),
              headerTemplate: ((settings || {}).emailHeaderTemplate || (window.LTP_DATA_SETTINGS || {}).emailHeaderTemplate),
              headerVars: sendHeaderVars,
              onChange: setSendMessage,
              minHeight: 240,
            })
          )
        ),
        h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14, paddingTop: 14, borderTop: "1px solid " + B.border } },
          h(window.Btn, { variant: "ghost", onClick: function() { setShowSendModal(false); } }, "Cancel"),
          h(window.Btn, {
            onClick: executeSend,
            disabled: sending || !window.LTP_GMAIL_CONNECTED,
          }, sending ? "Sending\u2026" : (isDraft ? "\u2709 Send Invoice" : "\u2709 Resend")))
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
                h("span", { style: { color: B.text } }, "$" + Math.round(t.total).toLocaleString())),
              h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4, fontWeight: 600 } }, "Payments"),
              (draft.payments || []).map(function(p) {
                var ml = { check: "Check", ach: "ACH", credit_card: "CC", cash: "Cash", wire: "Wire", other: "Other" };
                return h("div", { key: p.id, style: { display: "flex", justifyContent: "space-between", fontSize: "10px", padding: "2px 0" } },
                  h("span", { style: { color: B.textMut } }, fmt(p.date) + " \u00b7 " + (ml[p.method] || p.method)),
                  h("span", { style: { color: B.success } }, "$" + Number(p.amount).toLocaleString()));
              }),
              h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "13px", fontWeight: 700, paddingTop: 8, borderTop: "1px solid " + B.border, marginTop: 6 } },
                h("span", { style: { color: B.success } }, "Paid in Full"),
                h("span", { style: { color: B.success } }, "$" + Math.round(t.paid).toLocaleString()))
            )
          ),
          // Right: Email preview
          h("div", { style: { flex: 1, background: B.bg, border: "1px solid " + B.border, borderRadius: "8px", display: "flex", flexDirection: "column", overflow: "hidden" } },
            h("div", { style: { padding: "10px 14px", borderBottom: "1px solid " + B.border, background: B.surface } },
              h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 } }, "Email Preview"),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 5 } },
                h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "From:"),
                h("span", { style: { fontSize: "11px", color: B.text } },
                  (window.LTP_SENDER_NAME || "") + (window.LTP_SENDER_EMAIL ? " <" + window.LTP_SENDER_EMAIL + ">" : ""))),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 5 } },
                h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "To:"),
                h("input", { value: sendEmail, onChange: function(e) { setSendEmail(e.target.value); },
                  style: { flex: 1, background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none" }, placeholder: "client@example.com" })),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 5 } },
                h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "CC:"),
                h("input", { value: sendCc, onChange: function(e) { setSendCc(e.target.value); },
                  style: { flex: 1, background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none" }, placeholder: "comma-separated (optional)" })),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "Subj:"),
                h("input", { value: sendSubject, onChange: function(e) { setSendSubject(e.target.value); },
                  style: { flex: 1, background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 8px", color: B.text, fontSize: "11px", fontWeight: 600, fontFamily: "inherit", outline: "none" } }))),
            !window.LTP_GMAIL_CONNECTED && h("div", { style: { padding: "8px 14px", background: B.warn + "11", borderBottom: "1px solid " + B.warn + "44", fontSize: "11px", color: B.warn } },
              "\u26a0 Gmail isn't connected for your account. Sign out and back in with Google to grant the gmail.send permission."),
            // WYSIWYG body editor (see modules/quotes-builder.js for the
            // matching block + rationale). sendMessage state still keeps
            // placeholders intact; EmailBodyEditor renders the signature
            // as a non-editable block locally and reverses the
            // substitution on every input.
            h(window.EmailBodyEditor, {
              value: sendMessage,
              signatureTemplate: ((settings || {}).emailSignatureTemplate || (window.LTP_DATA_SETTINGS || {}).emailSignatureTemplate),
              headerTemplate: ((settings || {}).emailHeaderTemplate || (window.LTP_DATA_SETTINGS || {}).emailHeaderTemplate),
              headerVars: sendHeaderVars,
              onChange: setSendMessage,
              minHeight: 240,
            })
          )
        ),
        h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14, paddingTop: 14, borderTop: "1px solid " + B.border } },
          h(window.Btn, { variant: "ghost", onClick: function() { setShowReceiptModal(false); } }, "Skip"),
          h(window.Btn, {
            onClick: sendReceipt,
            disabled: sending || !window.LTP_GMAIL_CONNECTED,
          }, sending ? "Sending\u2026" : "\u2709 Send Receipt"))
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
        equipment: props.equipment, products: props.products, services: props.services,
        settings: props.settings, isAdmin: props.isAdmin, qbo: props.qbo,
      });
    }
    return h(InvoiceList, {
      invoices: props.invoices, companies: props.companies, contacts: props.contacts, projects: props.projects, quotes: props.quotes,
    });
  };
})();
