window.LTP_DATA_PROJECTS = [
  // PROJECT 1: Spring Gala — in-progress, full production, complex schedule
  { id: 1, name: "Spring Gala 2026", companyId: 1, category: "Full Production", status: "in-progress",
    startDate: "2026-04-20", endDate: "2026-04-22", venue: "Moody Performance Hall", budget: 15000,
    contactIds: [1, 2],
    notes: [
      { id: 1, date: "2026-03-15", author: "Landry", text: "Initial meeting with Sarah. 3-night run at Moody. Need SolaFrame 3000s and ColorSource Vs. Full rig + programming.", linkedMeetingId: 1 },
      { id: 2, date: "2026-03-28", author: "Landry", text: "Confirmed 42-fixture plot. Sarah approved the design. Moving to quote phase." },
    ],
    meetings: [
      { id: 1, title: "Initial Design Meeting", date: "2026-03-15", time: "10:00", attendees: [1, 2], notes: "Discussed concept, budget, timeline.", calSynced: true },
      { id: 2, title: "Tech Specs Review", date: "2026-04-01", time: "14:00", attendees: [1], notes: "Finalized fixture list and rigging plan.", calSynced: false },
    ],
    schedule: [
      // Day 1: April 20 — Load In + Focus + Programming
      { id: "s1", title: "Load In", date: "2026-04-20", time: "06:00", endTime: "10:00", addToCalendar: true,
        breaks: [],
        positions: [
          { id: "p1", role: "L1", serviceId: 1, crewId: 11, status: "confirmed" },
          { id: "p2", role: "L3", serviceId: 3, crewId: 14, status: "accepted" },
          { id: "p3", role: "L3", serviceId: 3, crewId: 17, status: "requested" },
          { id: "p4", role: "RIG", serviceId: 14, crewId: 12, status: "requested" },
          { id: "p5", role: "PM", serviceId: 15, crewId: 13, status: "confirmed" },
        ] },
      { id: "s2", title: "Focus", date: "2026-04-20", time: "10:00", endTime: "12:00", addToCalendar: true,
        breaks: [],
        positions: [
          { id: "p6", role: "L1", serviceId: 1, crewId: 11, status: "confirmed" },
          { id: "p7", role: "L3", serviceId: 3, crewId: 14, status: "accepted" },
          { id: "p8", role: "RIG", serviceId: 14, crewId: 12, status: "requested" },
        ] },
      { id: "s3", title: "Programming", date: "2026-04-20", time: "13:00", endTime: "17:00", addToCalendar: true,
        breaks: [{ id: "b1", startTime: "15:00", endTime: "15:30", type: "paid" }],
        positions: [
          { id: "p9", role: "L1", serviceId: 1, crewId: 11, status: "confirmed" },
          { id: "p10", role: "L3", serviceId: 3, crewId: 14, status: "accepted" },
          { id: "p11", role: "PM", serviceId: 15, crewId: 13, status: "confirmed" },
        ] },
      // Day 2: April 21 — Tech + Show
      { id: "s4", title: "Tech / Dress", date: "2026-04-21", time: "09:00", endTime: "15:00", addToCalendar: true,
        breaks: [{ id: "b2", startTime: "12:00", endTime: "13:00", type: "unpaid" }],
        positions: [
          { id: "p12", role: "L1", serviceId: 1, crewId: 11, status: "confirmed" },
          { id: "p13", role: "L3", serviceId: 3, crewId: 14, status: "confirmed" },
          { id: "p14", role: "A1", serviceId: 5, crewId: 15, status: "requested" },
          { id: "p15", role: "PM", serviceId: 15, crewId: 13, status: "confirmed" },
        ] },
      { id: "s5", title: "Show", date: "2026-04-21", time: "19:00", endTime: "23:00", addToCalendar: true,
        breaks: [],
        positions: [
          { id: "p16", role: "L1", serviceId: 1, crewId: 11, status: "confirmed" },
          { id: "p17", role: "L3", serviceId: 3, crewId: 14, status: "confirmed" },
          { id: "p18", role: "A1", serviceId: 5, crewId: 15, status: "requested" },
          { id: "p19", role: "PM", serviceId: 15, crewId: 13, status: "confirmed" },
        ] },
      // Day 3: April 22 — Strike
      { id: "s6", title: "Strike", date: "2026-04-22", time: "08:00", endTime: "12:00", addToCalendar: true,
        breaks: [],
        positions: [
          { id: "p20", role: "L3", serviceId: 3, crewId: 14, status: "open" },
          { id: "p21", role: "L3", serviceId: 3, crewId: null, status: "open" },
          { id: "p22", role: "RIG", serviceId: 14, crewId: 12, status: "open" },
        ] },
    ],
    scheduleNotes: "Moody dock access: 5:30 AM. Security contact: Jake (214-555-9999). No fly system — all ground support.",
    scheduleActivity: [
      { id: "sa1", date: "2026-04-01", time: "14:00", type: "created", user: "Landry Strickland", message: "Schedule created", changes: [] },
      { id: "sa2", date: "2026-04-05", time: "10:30", type: "saved", user: "Landry Strickland", message: "Schedule saved (8 changes)", changes: [{ cat: "Positions", detail: "5 crew assigned" }] },
    ],
  },
  // PROJECT 2: Corporate Awards — upcoming, service, some crew overlap
  { id: 2, name: "Corporate Awards Night", companyId: 2, category: "Service", status: "upcoming",
    startDate: "2026-04-20", endDate: "2026-04-21", venue: "Hilton Anatole Grand Ballroom", budget: 8000,
    contactIds: [3, 4],
    notes: [
      { id: 3, date: "2026-03-20", author: "Landry", text: "Jessica wants a modern LED-wall look. 16x9 upstage, confidence monitors, walk-up lighting for award recipients." },
    ],
    meetings: [
      { id: 3, title: "Site Visit", date: "2026-04-05", time: "11:00", attendees: [3], notes: "Walked the ballroom. Power is on stage left. Load in through kitchen corridor.", calSynced: false },
    ],
    schedule: [
      { id: "s7", title: "Setup", date: "2026-04-20", time: "08:00", endTime: "14:00", addToCalendar: true,
        breaks: [{ id: "b3", startTime: "12:00", endTime: "12:30", type: "paid" }],
        positions: [
          { id: "p23", role: "L1", serviceId: 1, crewId: 11, status: "requested" },
          { id: "p24", role: "A1", serviceId: 5, crewId: 15, status: "open" },
          { id: "p25", role: "V1", serviceId: 8, crewId: 16, status: "open" },
        ] },
      { id: "s8", title: "Event", date: "2026-04-21", time: "14:00", endTime: "23:00", addToCalendar: true,
        breaks: [{ id: "b4", startTime: "17:00", endTime: "18:00", type: "unpaid" }],
        positions: [
          { id: "p26", role: "L1", serviceId: 1, crewId: null, status: "open" },
          { id: "p27", role: "A1", serviceId: 5, crewId: 15, status: "requested" },
          { id: "p28", role: "V1", serviceId: 8, crewId: 16, status: "requested" },
          { id: "p29", role: "PM", serviceId: 15, crewId: 13, status: "requested" },
        ] },
      { id: "s9", title: "Strike", date: "2026-04-21", time: "23:00", endTime: "02:00", addToCalendar: false,
        breaks: [],
        positions: [
          { id: "p30", role: "L3", serviceId: 3, crewId: null, status: "open" },
          { id: "p31", role: "L3", serviceId: 3, crewId: null, status: "open" },
        ] },
    ],
    scheduleNotes: "Hotel union rules: no power tools after 11pm. Must use their AV patch panel for house sound.",
    scheduleActivity: [],
  },
  // PROJECT 3: Holiday Concert — completed, rental, all done
  { id: 3, name: "Holiday Concert Series", companyId: 3, category: "Rental", status: "completed",
    startDate: "2025-12-15", endDate: "2025-12-17", venue: "Majestic Theatre", budget: 6000,
    contactIds: [5],
    notes: [
      { id: 4, date: "2025-11-01", author: "Landry", text: "Rachel wants warm holiday look. Amber/gold color palette. Simple rig — 24 PARs + 12 Lekos." },
      { id: 5, date: "2025-12-18", author: "Landry", text: "Show went great. Rachel very happy. Wants to book again for next year's series." },
    ],
    meetings: [],
    schedule: [
      { id: "s10", title: "Load In & Focus", date: "2025-12-15", time: "08:00", endTime: "16:00", addToCalendar: false,
        breaks: [{ id: "b5", startTime: "12:00", endTime: "13:00", type: "unpaid" }],
        positions: [
          { id: "p32", role: "L1", serviceId: 1, crewId: 11, status: "confirmed" },
          { id: "p33", role: "L3", serviceId: 3, crewId: 14, status: "confirmed" },
        ] },
      { id: "s11", title: "Shows (3 performances)", date: "2025-12-16", time: "10:00", endTime: "22:00", addToCalendar: false,
        breaks: [{ id: "b6", startTime: "13:00", endTime: "14:00", type: "unpaid" }, { id: "b7", startTime: "18:00", endTime: "19:00", type: "unpaid" }],
        positions: [
          { id: "p34", role: "L1", serviceId: 1, crewId: 11, status: "confirmed" },
        ] },
      { id: "s12", title: "Final Show & Strike", date: "2025-12-17", time: "14:00", endTime: "23:00", addToCalendar: false,
        breaks: [{ id: "b8", startTime: "17:00", endTime: "18:00", type: "unpaid" }],
        positions: [
          { id: "p35", role: "L1", serviceId: 1, crewId: 11, status: "confirmed" },
          { id: "p36", role: "L3", serviceId: 3, crewId: 14, status: "confirmed" },
        ] },
    ],
    scheduleNotes: "Completed successfully. All gear returned in good condition.",
    scheduleActivity: [
      { id: "sa3", date: "2025-12-14", time: "09:00", type: "saved", user: "Landry Strickland", message: "Schedule finalized", changes: [{ cat: "Crew", detail: "All positions confirmed" }] },
    ],
  },
];
