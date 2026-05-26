// Rental allocations — every lifecycle state represented
// States: reserved | allocated | checked-out | returned | under-maintenance
// Equipment IDs: 1-23 per equipment.js
// Project IDs: 1-6 per projects.js
window.LTP_DATA_ALLOCATIONS = [

  // ── PROJECT 1: Spring Gala 2026 (April 19–22) — CHECKED OUT / IN PROGRESS ─
  // Full production package currently out on the show
  { id: 1,  equipmentId: 1,  projectId: 1, qty: 2, startDate: "2026-04-19", endDate: "2026-04-22", state: "checked-out", notes: "SolaFrames for front lighting positions." },
  { id: 2,  equipmentId: 4,  projectId: 1, qty: 8, startDate: "2026-04-19", endDate: "2026-04-22", state: "checked-out", notes: "Full ColorSource V package." },
  { id: 3,  equipmentId: 9,  projectId: 1, qty: 1, startDate: "2026-04-19", endDate: "2026-04-22", state: "checked-out", notes: "Titan hazer LTP-HAZ-001 for Act 2 ballad." },
  { id: 4,  equipmentId: 11, projectId: 1, qty: 1, startDate: "2026-04-19", endDate: "2026-04-22", state: "checked-out", notes: "EOS Wing with laptop — Landry programming." },
  { id: 5,  equipmentId: 13, projectId: 1, qty: 1, startDate: "2026-04-19", endDate: "2026-04-22", state: "checked-out", notes: null },
  { id: 6,  equipmentId: 19, projectId: 1, qty: 2, startDate: "2026-04-19", endDate: "2026-04-22", state: "checked-out", notes: "2x Soco distros at dimmer rack." },
  { id: 7,  equipmentId: 23, projectId: 1, qty: 8, startDate: "2026-04-19", endDate: "2026-04-22", state: "checked-out", notes: null },

  // ── PROJECT 2: Summer Rep — El Otro (June 9–29) — RESERVED ────────────────
  // Quote accepted, items reserved for long run
  { id: 8,  equipmentId: 2,  projectId: 2, qty: 4, startDate: "2026-06-09", endDate: "2026-06-29", state: "reserved",    notes: "Confirm final qty with David — may need 6." },
  { id: 9,  equipmentId: 3,  projectId: 2, qty: 4, startDate: "2026-06-09", endDate: "2026-06-29", state: "reserved",    notes: null },
  { id: 10, equipmentId: 7,  projectId: 2, qty: 4, startDate: "2026-06-09", endDate: "2026-06-29", state: "reserved",    notes: null },
  { id: 11, equipmentId: 4,  projectId: 2, qty: 6, startDate: "2026-06-09", endDate: "2026-06-29", state: "reserved",    notes: "Supplemental wash package." },
  { id: 12, equipmentId: 16, projectId: 2, qty: 1, startDate: "2026-06-09", endDate: "2026-06-29", state: "reserved",    notes: "QL5 for full run — 3-week rental rate." },
  { id: 13, equipmentId: 17, projectId: 2, qty: 4, startDate: "2026-06-09", endDate: "2026-06-29", state: "reserved",    notes: "All 4 QSC K12.2 speakers for the run." },

  // ── PROJECT 3: Spring Musical (May 7–10) — ALLOCATED ─────────────────────
  // Quote confirmed, items allocated — not yet checked out
  { id: 14, equipmentId: 4,  projectId: 3, qty: 4, startDate: "2026-05-07", endDate: "2026-05-10", state: "allocated",   notes: null },
  { id: 15, equipmentId: 5,  projectId: 3, qty: 8, startDate: "2026-05-07", endDate: "2026-05-10", state: "allocated",   notes: "Full PAR package for sidelight." },
  { id: 16, equipmentId: 8,  projectId: 3, qty: 6, startDate: "2026-05-07", endDate: "2026-05-10", state: "allocated",   notes: null },
  { id: 17, equipmentId: 12, projectId: 3, qty: 1, startDate: "2026-05-07", endDate: "2026-05-10", state: "allocated",   notes: "Nomad for student LD to use." },
  { id: 18, equipmentId: 18, projectId: 3, qty: 2, startDate: "2026-05-07", endDate: "2026-05-10", state: "allocated",   notes: "2x wireless mics for leads." },
  { id: 19, equipmentId: 22, projectId: 3, qty: 15, startDate: "2026-05-07", endDate: "2026-05-10", state: "allocated",  notes: "DMX cable package." },

  // ── PROJECT 4: Easter Concert (March 28–29) — RETURNED (completed) ────────
  // All items returned — historical record
  { id: 20, equipmentId: 5,  projectId: 4, qty: 8, startDate: "2026-03-28", endDate: "2026-03-29", state: "returned",    notes: "Simple delivery/pickup rental. All returned clean." },
  { id: 21, equipmentId: 9,  projectId: 4, qty: 1, startDate: "2026-03-28", endDate: "2026-03-29", state: "returned",    notes: "LTP-HAZ-002 returned with half-empty fluid bottle." },
  { id: 22, equipmentId: 22, projectId: 4, qty: 6, startDate: "2026-03-28", endDate: "2026-03-29", state: "returned",    notes: null },

  // ── PROJECT 5: Bridging Worlds (May 15–17) — RESERVED (labor-focused) ─────
  // Small equipment package alongside labor
  { id: 23, equipmentId: 6,  projectId: 5, qty: 4, startDate: "2026-05-15", endDate: "2026-05-17", state: "reserved",    notes: "Aurora beams for aerial work." },
  { id: 24, equipmentId: 7,  projectId: 5, qty: 2, startDate: "2026-05-15", endDate: "2026-05-17", state: "reserved",    notes: null },
  { id: 25, equipmentId: 18, projectId: 5, qty: 1, startDate: "2026-05-15", endDate: "2026-05-17", state: "reserved",    notes: "1 wireless mic for choreographer comms." },

  // ── PROJECT 6: Summer VBS Event (June 15–19) — ALLOCATED ─────────────────
  { id: 26, equipmentId: 5,  projectId: 6, qty: 4, startDate: "2026-06-15", endDate: "2026-06-19", state: "allocated",   notes: "Uplight package for event." },
  { id: 27, equipmentId: 7,  projectId: 6, qty: 2, startDate: "2026-06-15", endDate: "2026-06-19", state: "allocated",   notes: null },
  { id: 28, equipmentId: 17, projectId: 6, qty: 2, startDate: "2026-06-15", endDate: "2026-06-19", state: "allocated",   notes: "2x K12.2 for main room." },

  // ── ADDITIONAL HISTORICAL RETURNS (prior to current season) ───────────────
  // Pegasus Contemporary Ballet — Winter Showcase (Dec 2025)
  { id: 29, equipmentId: 1,  projectId: 4, qty: 2, startDate: "2025-12-05", endDate: "2025-12-08", state: "returned",    notes: "Pegasus holiday show. SolaFrames used for centerstage." },
  { id: 30, equipmentId: 2,  projectId: 4, qty: 4, startDate: "2025-12-05", endDate: "2025-12-08", state: "returned",    notes: null },
  { id: 31, equipmentId: 10, projectId: 4, qty: 1, startDate: "2025-12-05", endDate: "2025-12-08", state: "returned",    notes: "G300 fogger used for winter scene effect." },

  // ── TIGHT OVERLAP / CONFLICT SCENARIO ─────────────────────────────────────
  // ColorSource V (ID 4): 12 total. Projects 1 (8), 2 (6), 3 (4) all request it.
  // Intentionally shows partial pressure in the availability view.
  // Project 1 checks out 8 units April 19-22.
  // Project 3 needs 4 units May 7-10 (fine — no overlap with Project 1).
  // Project 2 reserves 6 units June 9-29 (fine — no overlap).
  // Shows the system handling sequential booking correctly.

  // ── BORDERLINE SCENARIO: Consecutive dates (no gap) ──────────────────────
  // SolaFrame 750 (ID 2): returned from Cara Mia April 30, next show reserves from May 1
  { id: 32, equipmentId: 2,  projectId: 1, qty: 2, startDate: "2026-04-24", endDate: "2026-04-30", state: "returned",    notes: "Pegasus spring show. Returned April 30 AM." },
  { id: 33, equipmentId: 2,  projectId: 3, qty: 2, startDate: "2026-05-01", endDate: "2026-05-06", state: "allocated",   notes: "Consecutive booking starting May 1 PM load-in." },

  // ── VIDEO PROJECTOR (single unit, scarce resource) ─────────────────────────
  // Shows a single high-value item with clear availability window
  { id: 34, equipmentId: 21, projectId: 2, qty: 1, startDate: "2026-06-15", endDate: "2026-06-28", state: "reserved",    notes: "Barco projector for immersive set projection — El Otro." },

  // ── POWER DISTRO — partial return history ─────────────────────────────────
  { id: 35, equipmentId: 19, projectId: 4, qty: 1, startDate: "2025-12-05", endDate: "2025-12-08", state: "returned",    notes: null },
];
