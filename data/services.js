// Services — labor rate card with tiered billing rates.
// Each role has day/hourly/OT rates for both billing (what we charge) and cost (what we pay).
//   dayRate    = full day (5-10h)     | dayCost
//   halfDay    = half day (0-5h)      | halfDayCost
//   hourlyRate = per hour base        | hourlyCost
//   otRate     = overtime per hour    | otCost
//
// Standard formula: hourly = day/10, OT = hourly × 1.5, half = day × 0.5
// Override any field for non-standard rates.
window.LTP_DATA_SERVICES = [
  // ── Lighting ────────────────────────────────────────────────────────────────
  { id: 1,  role: "L1",  description: "Lead Lighting Tech / Board Op",  department: "Lighting",
    dayRate: 450, halfDay: 225, hourlyRate: 45,  otRate: 67.50,
    dayCost: 340, halfDayCost: 170, hourlyCost: 34,  otCost: 51,
    notes: "Runs the show. Boards: EOS, Hog, MA." },
  { id: 2,  role: "L2",  description: "Lighting Tech / Programmer",     department: "Lighting",
    dayRate: 400, halfDay: 200, hourlyRate: 40,  otRate: 60,
    dayCost: 300, halfDayCost: 150, hourlyCost: 30,  otCost: 45,
    notes: "Focus, patch, programming assist." },
  { id: 3,  role: "L3",  description: "Lighting Electrician",           department: "Lighting",
    dayRate: 350, halfDay: 175, hourlyRate: 35,  otRate: 52.50,
    dayCost: 260, halfDayCost: 130, hourlyCost: 26,  otCost: 39,
    notes: "Hang, cable, power." },
  { id: 4,  role: "LD",  description: "Lighting Designer",              department: "Lighting",
    dayRate: 650, halfDay: 325, hourlyRate: 65,  otRate: 97.50,
    dayCost: 500, halfDayCost: 250, hourlyCost: 50,  otCost: 75,
    notes: "Creative design lead. Usually booked in advance." },

  // ── Audio ───────────────────────────────────────────────────────────────────
  { id: 5,  role: "A1",  description: "Lead Audio Engineer / FOH",      department: "Audio",
    dayRate: 500, halfDay: 250, hourlyRate: 50,  otRate: 75,
    dayCost: 380, halfDayCost: 190, hourlyCost: 38,  otCost: 57,
    notes: "Front of House mixing, system tuning." },
  { id: 6,  role: "A2",  description: "Monitor Engineer / RF Tech",     department: "Audio",
    dayRate: 450, halfDay: 225, hourlyRate: 45,  otRate: 67.50,
    dayCost: 340, halfDayCost: 170, hourlyCost: 34,  otCost: 51,
    notes: "Monitors, IEMs, wireless mic coord." },
  { id: 7,  role: "A3",  description: "Audio Technician",               department: "Audio",
    dayRate: 375, halfDay: 187.50, hourlyRate: 37.50,  otRate: 56.25,
    dayCost: 285, halfDayCost: 142.50, hourlyCost: 28.50,  otCost: 42.75,
    notes: "Setup, cabling, troubleshooting." },

  // ── Video ───────────────────────────────────────────────────────────────────
  { id: 8,  role: "V1",  description: "Lead Video Engineer",            department: "Video",
    dayRate: 500, halfDay: 250, hourlyRate: 50,  otRate: 75,
    dayCost: 380, halfDayCost: 190, hourlyCost: 38,  otCost: 57,
    notes: "Screen management, projection mapping." },
  { id: 9,  role: "V2",  description: "Video Technician",               department: "Video",
    dayRate: 400, halfDay: 200, hourlyRate: 40,  otRate: 60,
    dayCost: 300, halfDayCost: 150, hourlyCost: 30,  otCost: 45,
    notes: "Cable runs, signal routing, projector setup." },

  // ── Stage / Rigging ─────────────────────────────────────────────────────────
  { id: 10, role: "SH",  description: "Stagehand",                      department: "Stage",
    dayRate: 300, halfDay: 150, hourlyRate: 30,  otRate: 45,
    dayCost: 220, halfDayCost: 110, hourlyCost: 22,  otCost: 33,
    notes: "General labor. Load-in, load-out, scene changes." },
  { id: 11, role: "SM",  description: "Stage Manager",                  department: "Stage",
    dayRate: 550, halfDay: 275, hourlyRate: 55,  otRate: 82.50,
    dayCost: 420, halfDayCost: 210, hourlyCost: 42,  otCost: 63,
    notes: "Calls the show. Paperwork, blocking, cues." },
  { id: 12, role: "F1",  description: "Fly Rail Operator (Head)",       department: "Rigging",
    dayRate: 475, halfDay: 237.50, hourlyRate: 47.50,  otRate: 71.25,
    dayCost: 360, halfDayCost: 180, hourlyCost: 36,  otCost: 54,
    notes: "Lead fly operator, counterweight system." },
  { id: 13, role: "F2",  description: "Fly Rail Operator",              department: "Rigging",
    dayRate: 400, halfDay: 200, hourlyRate: 40,  otRate: 60,
    dayCost: 305, halfDayCost: 152.50, hourlyCost: 30.50,  otCost: 45.75,
    notes: "Assistant flyperson." },
  { id: 14, role: "RIG", description: "Rigger (ETCP Certified)",        department: "Rigging",
    dayRate: 650, halfDay: 325, hourlyRate: 65,  otRate: 97.50,
    dayCost: 500, halfDayCost: 250, hourlyCost: 50,  otCost: 75,
    notes: "Required for arena truss work. Certified only." },

  // ── Production ──────────────────────────────────────────────────────────────
  { id: 15, role: "PM",  description: "Production Manager",             department: "Production",
    dayRate: 700, halfDay: 350, hourlyRate: 70,  otRate: 105,
    dayCost: 550, halfDayCost: 275, hourlyCost: 55,  otCost: 82.50,
    notes: "On-site production oversight, client liaison." },
  { id: 16, role: "TD",  description: "Technical Director",             department: "Production",
    dayRate: 650, halfDay: 325, hourlyRate: 65,  otRate: 97.50,
    dayCost: 500, halfDayCost: 250, hourlyCost: 50,  otCost: 75,
    notes: "Technical coordination across departments." },
  { id: 17, role: "PA",  description: "Production Assistant",           department: "Production",
    dayRate: 250, halfDay: 125, hourlyRate: 25,  otRate: 37.50,
    dayCost: 180, halfDayCost: 90,  hourlyCost: 18,  otCost: 27,
    notes: "Runner, gopher, paperwork support." },
];
