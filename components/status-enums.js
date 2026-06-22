// LTP Status Enums — single source of truth for status strings.
//
// Status values are strings stored in the database. Using bare strings in
// code (`q.status === "draft"`) means a typo is a runtime bug AND renaming
// a status requires grepping across ~20 files. Reference these constants
// instead: `q.status === LTP_STATUS.QUOTE.DRAFT`.
//
// When introducing a new status value: add it here FIRST, then to the
// `tagColors` map in data/settings.js (so the badge has a color), then use
// the constant at call sites. theme.js's LTP_STATUS_COLORS also keys off
// these strings — keep names in sync.
(function() {
  var S = {};

  S.QUOTE = {
    DRAFT:     "draft",
    SENT:      "sent",
    ACCEPTED:  "accepted",
    DECLINED:  "declined",
    CONVERTED: "converted",
  };

  S.INVOICE = {
    DRAFT:   "draft",
    SENT:    "sent",
    PARTIAL: "partial",
    PAID:    "paid",
    OVERDUE: "overdue",
  };

  S.PROJECT = {
    UPCOMING:    "upcoming",
    IN_PROGRESS: "in-progress",
    COMPLETED:   "completed",
    CANCELLED:   "cancelled",
  };

  S.PROJECT_CATEGORY = {
    RENTAL:          "rental",
    LABOR:           "labor",
    SERVICE:         "service",
    FULL_PRODUCTION: "full-production",
  };

  // Position lifecycle (per-shift labor slot)
  //   open → requested → accepted/declined → confirmed
  S.POSITION = {
    OPEN:      "open",
    REQUESTED: "requested",
    ACCEPTED:  "accepted",
    DECLINED:  "declined",
    CONFIRMED: "confirmed",
  };

  // Assignment lifecycle (a whole shift)
  //   draft → requesting → confirmed → completed → cancelled
  S.ASSIGNMENT = {
    DRAFT:      "draft",
    REQUESTING: "requesting",
    CONFIRMED:  "confirmed",
    COMPLETED:  "completed",
    CANCELLED:  "cancelled",
  };

  S.CREW = {
    ACTIVE:   "active",
    INACTIVE: "inactive",
  };

  S.COMPANY = {
    ACTIVE:   "active",
    INACTIVE: "inactive",
    ONE_TIME: "one-time",
    PROSPECT: "prospect",
  };

  S.EQUIPMENT = {
    AVAILABLE:         "available",
    RENTED:            "rented",
    UNDER_MAINTENANCE: "under-maintenance",
  };

  // Allocation lifecycle (an equipment booking)
  //   reserved → allocated → checked-out → returned
  S.ALLOCATION = {
    RESERVED:          "reserved",
    ALLOCATED:         "allocated",
    CHECKED_OUT:       "checked-out",
    RETURNED:          "returned",
    UNDER_MAINTENANCE: "under-maintenance",
  };

  window.LTP_STATUS = S;
})();
