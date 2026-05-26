window.LTP_DATA_QUOTES = [
  // QT-2026-001: Spring Gala — Accepted, partially invoiced
  { id: 1, clientType: "company", companyId: 1, clientContactId: 1, projectId: 1,
    status: "accepted", sentDate: "2026-03-20", customStartDate: "", customEndDate: "",
    globalDiscount: { type: "none", value: 0 },
    sections: [
      { id: "qs1", label: "Lighting Equipment", items: [
        { id: "qi1", type: "equipment", name: "SolaFrame 3000", qty: 12, unitPrice: 150, adjustedPrice: null, deliveredQty: 12, invoicedQty: 12, equipmentId: null },
        { id: "qi2", type: "equipment", name: "ColorSource V", qty: 24, unitPrice: 35, adjustedPrice: null, deliveredQty: 24, invoicedQty: 0, equipmentId: null },
        { id: "qi3", type: "equipment", name: "ETC Eos Ti Console", qty: 1, unitPrice: 400, adjustedPrice: null, deliveredQty: 1, invoicedQty: 1, equipmentId: null },
      ]},
      { id: "qs2", label: "Labor", items: [
        { id: "qi4", type: "service", name: "L1 — Lead Lighting Tech", qty: 3, unitPrice: 450, adjustedPrice: null, rateType: "day", deliveredQty: 2, invoicedQty: 2, serviceId: 1 },
        { id: "qi5", type: "service", name: "L3 — Lighting Electrician", qty: 3, unitPrice: 350, adjustedPrice: null, rateType: "day", deliveredQty: 0, invoicedQty: 0, serviceId: 3 },
        { id: "qi6", type: "service", name: "RIG — Rigger (ETCP)", qty: 2, unitPrice: 500, adjustedPrice: 475, rateType: "day", deliveredQty: 0, invoicedQty: 0, serviceId: 14 },
        { id: "qi7", type: "service", name: "PM — Production Manager", qty: 2, unitPrice: 600, adjustedPrice: null, rateType: "day", deliveredQty: 2, invoicedQty: 2, serviceId: 15 },
        { id: "qi8", type: "service", name: "A1 — Lead Audio Engineer", qty: 2, unitPrice: 450, adjustedPrice: null, rateType: "day", deliveredQty: 0, invoicedQty: 0, serviceId: 5 },
      ]},
      { id: "qs3", label: "Production", items: [
        { id: "qi9", type: "product", name: "Haze Fluid (1 gal)", qty: 3, unitPrice: 45, adjustedPrice: null, deliveredQty: 3, invoicedQty: 0, productId: null },
        { id: "qi10", type: "product", name: "Gaff Tape (black, 2\")", qty: 6, unitPrice: 12, adjustedPrice: null, deliveredQty: 6, invoicedQty: 0, productId: null },
        { id: "qi11", type: "note", name: "Gel & gobos provided by client" },
      ]},
    ],
    notes: "This quote is valid for 30 days from the date of issue. Equipment rental is for 3-day period inclusive of load-in through strike.",
    activity: [
      { id: "qa1", date: "2026-03-18", time: "16:00", type: "created", user: "Landry Strickland", message: "Quote created" },
      { id: "qa2", date: "2026-03-19", time: "10:30", type: "saved", user: "Landry Strickland", message: "Quote saved (4 changes)", changes: [{ cat: "Equipment", detail: "Added SolaFrame 3000 ×12" }, { cat: "Labor", detail: "Added L1, L3, RIG, PM, A1" }] },
      { id: "qa3", date: "2026-03-20", time: "09:00", type: "sent", user: "Landry Strickland", message: "Quote sent to sarah@avantballet.org", changes: [{ cat: "Sent To", detail: "sarah@avantballet.org" }] },
      { id: "qa4", date: "2026-03-25", time: "14:00", type: "status", user: "Landry Strickland", message: "Quote accepted by client", changes: [{ cat: "Status", detail: "sent → accepted" }] },
      { id: "qa5", date: "2026-04-02", time: "11:00", type: "invoiced", user: "Landry Strickland", message: "Invoice created: INV-2026-001", changes: [{ cat: "Invoiced", detail: "SolaFrame 3000 ×12, Eos Ti ×1, L1 ×2, PM ×2" }] },
    ],
  },
  // QT-2026-002: Corporate Awards — Sent, awaiting response
  { id: 2, clientType: "company", companyId: 2, clientContactId: 3, projectId: 2,
    status: "sent", sentDate: "2026-04-08", customStartDate: "", customEndDate: "",
    globalDiscount: { type: "percent", value: 10 },
    sections: [
      { id: "qs4", label: "AV Equipment", items: [
        { id: "qi12", type: "equipment", name: "LED Video Wall (per panel)", qty: 48, unitPrice: 75, adjustedPrice: null, deliveredQty: 0, invoicedQty: 0, equipmentId: null },
        { id: "qi13", type: "equipment", name: "Confidence Monitor (55\")", qty: 2, unitPrice: 200, adjustedPrice: null, deliveredQty: 0, invoicedQty: 0, equipmentId: null },
        { id: "qi14", type: "equipment", name: "PTZ Camera System", qty: 3, unitPrice: 250, adjustedPrice: null, deliveredQty: 0, invoicedQty: 0, equipmentId: null },
      ]},
      { id: "qs5", label: "Lighting", items: [
        { id: "qi15", type: "equipment", name: "Martin MAC Encore WRM", qty: 8, unitPrice: 125, adjustedPrice: null, deliveredQty: 0, invoicedQty: 0, equipmentId: null },
        { id: "qi16", type: "equipment", name: "ETC Source 4 Leko 26°", qty: 16, unitPrice: 25, adjustedPrice: null, deliveredQty: 0, invoicedQty: 0, equipmentId: null },
      ]},
      { id: "qs6", label: "Crew", items: [
        { id: "qi17", type: "service", name: "L1 — Lead Lighting Tech", qty: 2, unitPrice: 450, adjustedPrice: null, rateType: "day", deliveredQty: 0, invoicedQty: 0, serviceId: 1 },
        { id: "qi18", type: "service", name: "A1 — Lead Audio Engineer", qty: 2, unitPrice: 450, adjustedPrice: null, rateType: "day", deliveredQty: 0, invoicedQty: 0, serviceId: 5 },
        { id: "qi19", type: "service", name: "V1 — Video Engineer", qty: 2, unitPrice: 400, adjustedPrice: null, rateType: "day", deliveredQty: 0, invoicedQty: 0, serviceId: 8 },
        { id: "qi20", type: "service", name: "PM — Production Manager", qty: 1, unitPrice: 600, adjustedPrice: null, rateType: "day", deliveredQty: 0, invoicedQty: 0, serviceId: 15 },
        { id: "qi21", type: "note", name: "Strike crew (2× L3) billed at hourly if past midnight" },
      ]},
    ],
    notes: "10% multi-service discount applied. This quote is valid for 30 days. Venue power and rigging provided by hotel.",
    activity: [
      { id: "qa6", date: "2026-04-05", time: "15:00", type: "created", user: "Landry Strickland", message: "Quote created" },
      { id: "qa7", date: "2026-04-07", time: "09:30", type: "saved", user: "Landry Strickland", message: "Quote saved (6 changes)", changes: [{ cat: "Discount", detail: "None → 10%" }] },
      { id: "qa8", date: "2026-04-08", time: "10:00", type: "sent", user: "Landry Strickland", message: "Quote sent to jessica@techstart.io", changes: [{ cat: "Sent To", detail: "jessica@techstart.io" }] },
    ],
  },
  // QT-2025-003: Holiday Concert — Converted (fully invoiced)
  { id: 3, clientType: "company", companyId: 3, clientContactId: 5, projectId: 3,
    status: "converted", sentDate: "2025-11-15", customStartDate: "", customEndDate: "",
    globalDiscount: { type: "none", value: 0 },
    sections: [
      { id: "qs7", label: "Equipment Rental", items: [
        { id: "qi22", type: "equipment", name: "ETC Source 4 PAR", qty: 24, unitPrice: 20, adjustedPrice: null, deliveredQty: 24, invoicedQty: 24, equipmentId: null },
        { id: "qi23", type: "equipment", name: "ETC Source 4 Leko 36°", qty: 12, unitPrice: 25, adjustedPrice: null, deliveredQty: 12, invoicedQty: 12, equipmentId: null },
        { id: "qi24", type: "equipment", name: "ETC ColorSource Spot Jr", qty: 8, unitPrice: 45, adjustedPrice: null, deliveredQty: 8, invoicedQty: 8, equipmentId: null },
        { id: "qi25", type: "equipment", name: "ETC Ion Xe Console", qty: 1, unitPrice: 300, adjustedPrice: null, deliveredQty: 1, invoicedQty: 1, equipmentId: null },
      ]},
      { id: "qs8", label: "Crew", items: [
        { id: "qi26", type: "service", name: "L1 — Lead Lighting Tech", qty: 3, unitPrice: 450, adjustedPrice: null, rateType: "day", deliveredQty: 3, invoicedQty: 3, serviceId: 1 },
        { id: "qi27", type: "service", name: "L3 — Lighting Electrician", qty: 2, unitPrice: 350, adjustedPrice: null, rateType: "day", deliveredQty: 2, invoicedQty: 2, serviceId: 3 },
      ]},
      { id: "qs9", label: "Consumables", items: [
        { id: "qi28", type: "product", name: "R02 Bastard Amber (per sheet)", qty: 6, unitPrice: 8, adjustedPrice: null, deliveredQty: 6, invoicedQty: 6, productId: null },
        { id: "qi29", type: "product", name: "R321 Soft Golden Amber (per sheet)", qty: 6, unitPrice: 8, adjustedPrice: null, deliveredQty: 6, invoicedQty: 6, productId: null },
      ]},
    ],
    notes: "3-day rental period. Holiday concert series at Majestic Theatre.",
    activity: [
      { id: "qa9", date: "2025-11-10", time: "11:00", type: "created", user: "Landry Strickland", message: "Quote created" },
      { id: "qa10", date: "2025-11-15", time: "09:00", type: "sent", user: "Landry Strickland", message: "Quote sent to rachel@cityartsfoundation.org", changes: [{ cat: "Sent To", detail: "rachel@cityartsfoundation.org" }] },
      { id: "qa11", date: "2025-11-20", time: "16:00", type: "status", user: "Landry Strickland", message: "Quote accepted by client", changes: [{ cat: "Status", detail: "sent → accepted" }] },
      { id: "qa12", date: "2025-12-01", time: "10:00", type: "invoiced", user: "Landry Strickland", message: "Invoice created: INV-2025-002 — all items invoiced", changes: [{ cat: "Invoiced", detail: "All items sent to invoice" }] },
    ],
  },
];
