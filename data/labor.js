// ═══════════════════════════════════════════════════════════════════════════
//   LABOR ASSIGNMENTS — shifts, positions, crew scheduling
// ═══════════════════════════════════════════════════════════════════════════
//
// An Assignment is a single shift (one call on one date) with positions to fill.
// Positions link to service roles and can be assigned to crew members.
//
// Status flow:
//   Position: open → requested → accepted/declined → confirmed
//   Assignment: draft → requesting → confirmed → completed → cancelled
//
window.LTP_DATA_ASSIGNMENTS = [
  {
    id: 1,
    projectId: 1,       // Spring Gala 2026
    quoteId: null,
    name: "Load-In & Focus",
    date: "2026-04-20",
    callTime: "08:00",
    endTime: "18:00",
    department: "Lighting",
    location: "Mainstage",
    notes: "Full lighting load-in. 42 fixtures, 6 truss lines.",
    status: "confirmed",
    createdDate: "2026-04-01",
    positions: [
      { id: "pos-1", role: "L1", serviceId: 1, crewId: 11, status: "accepted", dayRate: 450, dayCost: 340, requestedDate: "2026-04-02", respondedDate: "2026-04-02" },
      { id: "pos-2", role: "L3", serviceId: 3, crewId: 16, status: "accepted", dayRate: 350, dayCost: 260, requestedDate: "2026-04-02", respondedDate: "2026-04-03" },
      { id: "pos-3", role: "L3", serviceId: 3, crewId: 13, status: "accepted", dayRate: 350, dayCost: 260, requestedDate: "2026-04-02", respondedDate: "2026-04-02" },
    ],
  },
  {
    id: 2,
    projectId: 1,       // Spring Gala 2026
    quoteId: null,
    name: "Tech Rehearsal",
    date: "2026-04-21",
    callTime: "10:00",
    endTime: "22:00",
    department: "Lighting",
    location: "Mainstage",
    notes: "Full tech with cast. Dinner break 17:00-18:00.",
    status: "confirmed",
    createdDate: "2026-04-01",
    positions: [
      { id: "pos-4", role: "L1", serviceId: 1, crewId: 11, status: "accepted", dayRate: 450, dayCost: 340, requestedDate: "2026-04-02", respondedDate: "2026-04-02" },
      { id: "pos-5", role: "LD", serviceId: 4, crewId: 14, status: "accepted", dayRate: 650, dayCost: 500, requestedDate: "2026-04-02", respondedDate: "2026-04-03" },
    ],
  },
  {
    id: 3,
    projectId: 5,       // Bridging Worlds
    quoteId: null,
    name: "Load-In",
    date: "2026-05-15",
    callTime: "07:00",
    endTime: "17:00",
    department: "Stage",
    location: "Studio Theatre",
    notes: "",
    status: "draft",
    createdDate: "2026-05-01",
    positions: [
      { id: "pos-6", role: "SH", serviceId: 10, crewId: null, status: "open", dayRate: 300, dayCost: 220, requestedDate: null, respondedDate: null },
      { id: "pos-7", role: "SH", serviceId: 10, crewId: null, status: "open", dayRate: 300, dayCost: 220, requestedDate: null, respondedDate: null },
      { id: "pos-8", role: "SM", serviceId: 11, crewId: 15, status: "requested", dayRate: 550, dayCost: 420, requestedDate: "2026-05-02", respondedDate: null },
    ],
  },
];

// Helper: format assignment reference
window.LTP_ASSIGNMENT_REF = function(a) {
  return "ASMT-" + String(a.id).padStart(3, "0");
};
