// Kits — pre-built rental packages
// items: equipment + qty  |  containers: explicit container overrides (otherwise defaults auto-apply)
// rates: null = auto-calculated from item sum  |  autoRate: true = always recalculate
window.LTP_DATA_KITS = [

  // ── Lighting Packages ────────────────────────────────────────────────────────
  {
    id: 1,
    name: "Dance Concert — Wash Package",
    category: "Lighting",
    description: "Full wash rig for single-venue dance concerts. ColorSource V overhead wash, deep blue sidelight PAR package, and moving wash for backlight.",
    items: [
      { equipmentId: 4,  qty: 12 },   // ETC ColorSource V w/ Multiverse
      { equipmentId: 5,  qty: 8  },   // ETC ColorSource PAR (Deep Blue)
      { equipmentId: 7,  qty: 4  },   // V-Show Aura Moving Wash
    ],
    containers: [],
    rates: { threeDay: null, week: null, month: null },
    autoRate: true,
    notes: "Standard sidelight boom positions assume 4-leg rig. Confirm boom hardware with client.",
    status: "active",
  },
  {
    id: 2,
    name: "Dance Concert — Full Production",
    category: "Lighting",
    description: "Complete lighting package for mid-scale dance productions. Includes profiles, washes, beams, and haze.",
    items: [
      { equipmentId: 2,  qty: 6  },   // ETC SolaFrame 750 (front/side profiles)
      { equipmentId: 4,  qty: 12 },   // ColorSource V (overhead wash)
      { equipmentId: 5,  qty: 8  },   // ColorSource PAR (sidelight)
      { equipmentId: 6,  qty: 4  },   // LIGHTSKY Aurora (beams)
      { equipmentId: 7,  qty: 4  },   // V-Show Aura (backlight wash)
      { equipmentId: 9,  qty: 1  },   // Froggy's Fog Titan Hazer
      { equipmentId: 11, qty: 1  },   // ETC EOS Wing
      { equipmentId: 13, qty: 1  },   // Laptop (EOS Host)
      { equipmentId: 19, qty: 2  },   // Soco Distro
    ],
    containers: [],
    rates: { threeDay: 3200, week: 5000, month: null },
    autoRate: false,
    notes: "Priced as a bundled rate. Includes programming support from LTP for load-in day.",
    status: "active",
  },
  {
    id: 3,
    name: "Theatre — Rep Lighting Package",
    category: "Lighting",
    description: "Flexible rep plot for black box and small proscenium theatres. Ellipsoidals + wash + nomad control.",
    items: [
      { equipmentId: 8,  qty: 10 },   // Source 4WRD II Tungsten
      { equipmentId: 14, qty: 4  },   // Lens Tubes assorted
      { equipmentId: 4,  qty: 6  },   // ColorSource V
      { equipmentId: 3,  qty: 4  },   // LIGHTSKY Super Scope
      { equipmentId: 12, qty: 1  },   // ETCnomad Gadget II
      { equipmentId: 22, qty: 10 },   // DMX Cable
    ],
    containers: [],
    rates: { threeDay: null, week: null, month: null },
    autoRate: true,
    notes: "Client must provide laptop for Nomad. Gel/accessories billed separately.",
    status: "active",
  },
  {
    id: 4,
    name: "Corporate Event — Stage Lighting",
    category: "Lighting",
    description: "Clean corporate stage look. Moving profiles for key and gobo, washes for audience and stage fill.",
    items: [
      { equipmentId: 1,  qty: 2  },   // ETC SolaFrame 3000 (key light)
      { equipmentId: 4,  qty: 8  },   // ColorSource V (stage wash)
      { equipmentId: 5,  qty: 4  },   // ColorSource PAR (audience blinder)
      { equipmentId: 6,  qty: 2  },   // LIGHTSKY Aurora (aerial beams)
      { equipmentId: 11, qty: 1  },   // EOS Wing
      { equipmentId: 13, qty: 1  },   // Laptop
      { equipmentId: 19, qty: 1  },   // Soco Distro
    ],
    containers: [],
    rates: { threeDay: 2400, week: null, month: null },
    autoRate: false,
    notes: "Rate includes standard LTP operator discount for 3-day corporate bookings.",
    status: "active",
  },

  // ── Audio Packages ───────────────────────────────────────────────────────────
  {
    id: 5,
    name: "Small Venue — PA Package",
    category: "Audio",
    description: "Compact PA for rehearsals, small recitals, and board-op events up to ~300 seats.",
    items: [
      { equipmentId: 17, qty: 4  },   // QSC K12.2 (2x main, 2x side fill)
      { equipmentId: 16, qty: 1  },   // Yamaha QL5
      { equipmentId: 18, qty: 2  },   // Shure ULXD wireless mics
    ],
    containers: [],
    rates: { threeDay: null, week: null, month: null },
    autoRate: true,
    notes: "Additional wireless channels available. Stage monitor mix requires separate quote.",
    status: "active",
  },
  {
    id: 6,
    name: "Wireless Mic — 2-Channel Add-On",
    category: "Audio",
    description: "Add-on wireless mic package. Ideal for solo performers, presenters, or principal dancers.",
    items: [
      { equipmentId: 18, qty: 2  },   // 2x Shure ULXD
    ],
    containers: [],
    rates: { threeDay: null, week: null, month: null },
    autoRate: true,
    notes: "Requires base PA/mixer. Can be combined with any audio or lighting package.",
    status: "active",
  },

  // ── SFX Packages ─────────────────────────────────────────────────────────────
  {
    id: 7,
    name: "Atmospheric Haze Package",
    category: "SFX",
    description: "Continuous haze rig for beam definition and atmosphere. Includes fluid for a 3-day run.",
    items: [
      { equipmentId: 9,  qty: 1  },   // Froggy's Fog Titan HT7
      { equipmentId: 15, qty: 3  },   // HT Fluid 1-gallon x3
    ],
    containers: [],
    rates: { threeDay: null, week: null, month: null },
    autoRate: true,
    notes: "Fluid is non-returnable. Additional fluid billed at cost if usage exceeds 3 gallons.",
    status: "active",
  },

  // ── Full Production Bundles ───────────────────────────────────────────────────
  {
    id: 8,
    name: "Ballet / Contemporary — Full Package",
    category: "Full Production",
    description: "Turnkey lighting and SFX for ballet and contemporary dance. Profiles, washes, beams, haze, and EOS control.",
    items: [
      { equipmentId: 1,  qty: 2  },   // SolaFrame 3000 (front wash profiles)
      { equipmentId: 2,  qty: 4  },   // SolaFrame 750 (side profiles)
      { equipmentId: 4,  qty: 12 },   // ColorSource V (overhead)
      { equipmentId: 5,  qty: 8  },   // ColorSource PAR (sidelight)
      { equipmentId: 6,  qty: 4  },   // Aurora Beams
      { equipmentId: 7,  qty: 4  },   // Aura Wash (backlight)
      { equipmentId: 9,  qty: 1  },   // Titan Hazer
      { equipmentId: 15, qty: 2  },   // HT Fluid
      { equipmentId: 11, qty: 1  },   // EOS Wing
      { equipmentId: 13, qty: 1  },   // Laptop
      { equipmentId: 19, qty: 2  },   // Soco Distro x2
      { equipmentId: 23, qty: 8  },   // Soco Cable 25ft
    ],
    containers: [],
    rates: { threeDay: 5500, week: 8500, month: null },
    autoRate: false,
    notes: "Flagship package for Avant Chamber Ballet, Bruce Wood Dance, and Pegasus. Negotiate 10% loyalty discount for returning clients.",
    status: "active",
  },
];
