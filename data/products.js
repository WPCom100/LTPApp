// Products — sale items not tracked in rental equipment inventory.
// Used by quote builder (type: "product" line items). Each product has
// a sale price (charged to client) and a cost (our expense) for margin tracking.
window.LTP_DATA_PRODUCTS = [
  // ── Consumables ─────────────────────────────────────────────────────────────
  { id: 1,  name: "Froggy's Fog Haze Fluid — Swamp Juice (4L)",   category: "Consumables", unit: "jug",    unitPrice: 85,  cost: 52, notes: "Low-residue water-based haze fluid." },
  { id: 2,  name: "Froggy's Fog Fog Fluid — Stage (4L)",          category: "Consumables", unit: "jug",    unitPrice: 75,  cost: 42, notes: "For Le Maitre / stage foggers." },
  { id: 3,  name: "Le Maitre Pyro Flash — Red (10pk)",            category: "Consumables", unit: "pack",   unitPrice: 220, cost: 145, notes: "Single-use pyro cartridges." },
  { id: 4,  name: "CO2 Tank Refill (20lb)",                       category: "Consumables", unit: "tank",   unitPrice: 95,  cost: 45, notes: "For CO2 jets and cryo." },
  { id: 5,  name: "Confetti Refill — Biodegradable (1lb bag)",    category: "Consumables", unit: "bag",    unitPrice: 45,  cost: 22, notes: "Venue-safe." },

  // ── Expendables ─────────────────────────────────────────────────────────────
  { id: 6,  name: "Gaff Tape — Black 2\" (60yd)",                 category: "Expendables", unit: "roll",   unitPrice: 32,  cost: 18, notes: "Pro Gaff / Permacel equivalent." },
  { id: 7,  name: "Gaff Tape — White 2\" (60yd)",                 category: "Expendables", unit: "roll",   unitPrice: 32,  cost: 18, notes: "" },
  { id: 8,  name: "Glow Tape — Green 1\" (30yd)",                 category: "Expendables", unit: "roll",   unitPrice: 28,  cost: 15, notes: "Photoluminescent safety tape." },
  { id: 9,  name: "Spike Tape — Assorted Colors (½\" × 20yd)",    category: "Expendables", unit: "roll",   unitPrice: 10,  cost: 5,  notes: "Per roll, any color." },
  { id: 10, name: "Tie Line — 3/32\" Black (1lb tube)",           category: "Expendables", unit: "tube",   unitPrice: 28,  cost: 14, notes: "Unglazed. For cable management and bundling." },
  { id: 11, name: "Zip Ties — 8\" Black (100pk)",                 category: "Expendables", unit: "pack",   unitPrice: 12,  cost: 5,  notes: "" },
  { id: 12, name: "Velcro Cable Straps — 6\" (10pk)",             category: "Expendables", unit: "pack",   unitPrice: 15,  cost: 7,  notes: "Reusable." },

  // ── Gel & Filter ────────────────────────────────────────────────────────────
  { id: 13, name: "Rosco Gel Sheet — Any Color (20\" × 24\")",    category: "Gel",         unit: "sheet",  unitPrice: 12,  cost: 6,  notes: "Rosco, Lee, Apollo equivalent." },
  { id: 14, name: "Rosco Diffusion — 216 Full Frost (roll)",      category: "Gel",         unit: "roll",   unitPrice: 95,  cost: 58, notes: "48\" × 25' roll." },

  // ── Hardware ────────────────────────────────────────────────────────────────
  { id: 15, name: "Safety Cable — 30\"",                          category: "Hardware",    unit: "each",   unitPrice: 14,  cost: 7,  notes: "ETCP-compliant, stamped." },
  { id: 16, name: "C-Clamp — Mega Clamp",                         category: "Hardware",    unit: "each",   unitPrice: 22,  cost: 12, notes: "" },
  { id: 17, name: "Pipe & Base — 12\" Round Base w/ 10' Pipe",    category: "Hardware",    unit: "set",    unitPrice: 85,  cost: 48, notes: "Sold as complete assembly." },

  // ── Adapters & Jumpers (consumable-ish) ─────────────────────────────────────
  { id: 18, name: "Edison to Stagepin Adapter — 6\"",             category: "Adapters",    unit: "each",   unitPrice: 18,  cost: 9,  notes: "" },
  { id: 19, name: "Edison to Twist-Lock Adapter — 6\"",           category: "Adapters",    unit: "each",   unitPrice: 20,  cost: 10, notes: "" },
];
