window.LTP_DATA_INVOICES = [
  // INV-2026-001: Spring Gala — Sent, partial payment received
  { id: 1, clientType: "company", companyId: 1, clientContactId: 1, projectId: 1,
    quoteId: 1, status: "sent", invoiceDate: "2026-04-02", dueDate: "2026-05-02", sentDate: "2026-04-02", paidDate: null,
    globalDiscount: { type: "none", value: 0 },
    sections: [
      { id: "is1", label: "Equipment", items: [
        { id: "ii1", type: "equipment", name: "SolaFrame 3000", qty: 12, unitPrice: 150, adjustedPrice: null, sourceItemId: "qi1" },
        { id: "ii2", type: "equipment", name: "ETC Eos Ti Console", qty: 1, unitPrice: 400, adjustedPrice: null, sourceItemId: "qi3" },
      ]},
      { id: "is2", label: "Labor (Phase 1)", items: [
        { id: "ii3", type: "service", name: "L1 — Lead Lighting Tech", qty: 2, unitPrice: 450, adjustedPrice: null, rateType: "day", serviceId: 1, sourceItemId: "qi4" },
        { id: "ii4", type: "service", name: "PM — Production Manager", qty: 2, unitPrice: 600, adjustedPrice: null, rateType: "day", serviceId: 15, sourceItemId: "qi7" },
      ]},
    ],
    notes: "Payment is due within 30 days. Covers equipment rental and Phase 1 labor (Load In through Programming).",
    payments: [
      { id: "pay1", date: "2026-04-10", amount: 2000, method: "ACH", reference: "Avant Ballet ACH 04/10", notes: "Partial — equipment deposit" },
    ],
    activity: [
      { id: "ia1", date: "2026-04-02", time: "11:00", type: "created", user: "Landry Strickland", message: "Invoice created from QT-2026-001" },
      { id: "ia2", date: "2026-04-02", time: "11:15", type: "sent", user: "Landry Strickland", message: "Invoice sent to sarah@avantballet.org", changes: [{ cat: "Sent To", detail: "sarah@avantballet.org" }] },
      { id: "ia3", date: "2026-04-10", time: "09:30", type: "paid", user: "Landry Strickland", message: "Payment recorded: $2,000", changes: [{ cat: "Payment", detail: "$2,000 via ACH" }] },
    ],
  },
  // INV-2025-002: Holiday Concert — Paid in full
  { id: 2, clientType: "company", companyId: 3, clientContactId: 5, projectId: 3,
    quoteId: 3, status: "paid", invoiceDate: "2025-12-01", dueDate: "2025-12-31", sentDate: "2025-12-01", paidDate: "2025-12-20",
    globalDiscount: { type: "none", value: 0 },
    sections: [
      { id: "is3", label: "Equipment Rental", items: [
        { id: "ii5", type: "equipment", name: "ETC Source 4 PAR", qty: 24, unitPrice: 20, adjustedPrice: null, sourceItemId: "qi22" },
        { id: "ii6", type: "equipment", name: "ETC Source 4 Leko 36°", qty: 12, unitPrice: 25, adjustedPrice: null, sourceItemId: "qi23" },
        { id: "ii7", type: "equipment", name: "ETC ColorSource Spot Jr", qty: 8, unitPrice: 45, adjustedPrice: null, sourceItemId: "qi24" },
        { id: "ii8", type: "equipment", name: "ETC Ion Xe Console", qty: 1, unitPrice: 300, adjustedPrice: null, sourceItemId: "qi25" },
      ]},
      { id: "is4", label: "Crew", items: [
        { id: "ii9", type: "service", name: "L1 — Lead Lighting Tech", qty: 3, unitPrice: 450, adjustedPrice: null, rateType: "day", serviceId: 1, sourceItemId: "qi26" },
        { id: "ii10", type: "service", name: "L3 — Lighting Electrician", qty: 2, unitPrice: 350, adjustedPrice: null, rateType: "day", serviceId: 3, sourceItemId: "qi27" },
      ]},
      { id: "is5", label: "Consumables", items: [
        { id: "ii11", type: "product", name: "R02 Bastard Amber (per sheet)", qty: 6, unitPrice: 8, adjustedPrice: null, sourceItemId: "qi28" },
        { id: "ii12", type: "product", name: "R321 Soft Golden Amber (per sheet)", qty: 6, unitPrice: 8, adjustedPrice: null, sourceItemId: "qi29" },
      ]},
    ],
    notes: "Thank you for a wonderful holiday concert series!",
    payments: [
      { id: "pay2", date: "2025-12-15", amount: 1500, method: "Check", reference: "Check #4892", notes: "Deposit" },
      { id: "pay3", date: "2025-12-20", amount: 1346, method: "ACH", reference: "City Arts ACH 12/20", notes: "Final balance" },
    ],
    activity: [
      { id: "ia4", date: "2025-12-01", time: "10:00", type: "created", user: "Landry Strickland", message: "Invoice created from QT-2025-003 — all items invoiced" },
      { id: "ia5", date: "2025-12-01", time: "10:15", type: "sent", user: "Landry Strickland", message: "Invoice sent to rachel@cityartsfoundation.org", changes: [{ cat: "Sent To", detail: "rachel@cityartsfoundation.org" }] },
      { id: "ia6", date: "2025-12-15", time: "14:00", type: "paid", user: "Landry Strickland", message: "Payment recorded: $1,500", changes: [{ cat: "Payment", detail: "$1,500 via Check #4892" }] },
      { id: "ia7", date: "2025-12-20", time: "11:00", type: "paid", user: "Landry Strickland", message: "Payment recorded: $1,346 — Paid in full", changes: [{ cat: "Payment", detail: "$1,346 via ACH — balance cleared" }] },
      { id: "ia8", date: "2025-12-20", time: "11:30", type: "paid", user: "Landry Strickland", message: "Payment receipt sent to rachel@cityartsfoundation.org" },
    ],
  },
];
