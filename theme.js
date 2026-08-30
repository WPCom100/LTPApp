// LTP Brand Theme — the slate + brand-orange system shared with the
// customer-facing surfaces (modules/client-view.js, modules/crew-view.js,
// backend/email_compose.py), with the masthead orange as the single accent.
//
// ── LOOKING FOR A BUSINESS FUNCTION? IT MOVED. ──────────────────────────────
// This file used to be 2,739 lines, 96% of which was not theme. Every
// window.LTP_* function that is not a colour now lives in components/domain-*.js,
// loaded immediately after this file in index.html's theme slot:
//
//   domain-util.js     dates, times, ids, share tokens, urls, addresses, notes
//   domain-labor.js    the labor pricing engine (calcLaborDay, mealFixBreaks)
//   domain-rates.js    per-client service rates, product variants
//   domain-crew.js     schedule shaping, sign-off, crew notifications
//   domain-payouts.js  payout rows and pay-period arithmetic
//   domain-email.js    signature, header and body rendering (incl. PARA_STYLE)
//   domain-docs.js     quote/invoice totals, refs, terms, expiry, doc-projects
//
// Comments elsewhere in the repo — including several in backend/ — still say
// "mirrors theme.js::LTP_X". Read those as "mirrors the domain layer"; the
// table above says which file.
//
// NOTE: accent/success/warn/danger/info (and text*) MUST stay 6-digit hexes —
// several call sites build translucent fills by appending alpha ("18"/"44").
window.LTP_THEME = {
  // Slate surface ramp: page field → card/panel → control fill, hairline
  // border. A step DARKER than the public client pages' field — the app is
  // lived-in all day, so surfaces recede and the content carries the light.
  // Keep in sync with the hardcoded slate hexes in index.html (body,
  // scrollbars, select options, .ltp-list hairlines).
  bg: "#131C21", surface: "#19242B", raised: "#22303A", border: "#2E3E48",
  // Brand orange family (sampled from the masthead artwork)
  accent: "#EF5822", accentHover: "#FF6B35", accentMuted: "#4A2313", accentSoft: "#F9B998",
  text: "#EDF3F2", textSec: "#93A3AB", textMut: "#6E7E86",
  // Feedback hues — soft-on-slate; *Bg/*Bd are the translucent badge fills
  success: "#5FD08A", successBg: "rgba(95,208,138,0.10)", successBd: "rgba(95,208,138,0.32)",
  warn: "#F5B83D", warnBg: "rgba(245,184,61,0.10)", warnBd: "rgba(245,184,61,0.32)",
  danger: "#F0857A", dangerBg: "rgba(240,133,122,0.10)", dangerBd: "rgba(240,133,122,0.32)",
  info: "#6FA8F5", infoBg: "rgba(111,168,245,0.10)", infoBd: "rgba(111,168,245,0.32)",
  // Shared brand strokes — identical values to the client/crew views
  gradBtn: "linear-gradient(135deg,#FF921E,#EF5822)",
  gradRule: "linear-gradient(90deg,#FF921E 0%,#EF5822 50%,#64260F 100%)",
  btnInk: "#1B130D",   // near-black ink on orange/colored fills
  mono: "'SFMono-Regular',ui-monospace,'Roboto Mono','DM Mono',Menlo,monospace",
};
// Generate badge colors from a single hex: { bg, text, bd }
window.LTP_badgeFromHex = function(hex) {
  if (!hex) hex = "#666666";
  // Parse hex to RGB
  var r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
  return {
    bg: "rgba(" + r + "," + g + "," + b + ",0.12)",
    text: hex,
    bd: "rgba(" + r + "," + g + "," + b + ",0.35)"
  };
};

// Get department tag color (reads from settings tagColors)
window.LTP_deptColor = function(dept) {
  var tc = (window.LTP_TAG_COLORS || {});
  return tc[dept] || "#6FA8F5";
};

// Status badges — every entry is the soft translucent treatment the customer
// views use (12% fill / 35% border via LTP_badgeFromHex), keyed by semantic hue.
(function() {
  var b = window.LTP_badgeFromHex;
  var GREEN = "#5FD08A", RED = "#F0857A", BLUE = "#6FA8F5",
      AMBER = "#F5B83D", ORANGE = "#FF8A50", GREY = "#8A99A0";
  window.LTP_STATUS_COLORS = {
    active: b(GREEN),
    inactive: b(GREY),
    "one-time": b(BLUE),
    prospect: b(AMBER),
    client: b(GREEN),
    vendor: b(BLUE),
    available: b(GREEN),
    partial: b(AMBER),
    rented: b(ORANGE),
    accepted: b(GREEN),
    pending: b(AMBER),
    draft: b("#6E7E86"),
    sent: b(BLUE),
    paid: b(GREEN),
    overdue: b(RED),
    declined: b(RED),
    converted: b(GREEN),
    invoiced: b(ORANGE),
    requesting: b(ORANGE),
    completed: b(GREEN),
    cancelled: b(GREY),
    booked: b(AMBER),
    rental: b(BLUE),
    labor: b(AMBER),
    service: b(GREEN),
    "full-production": b(ORANGE),
    "in-progress": b(AMBER),
    upcoming: b(BLUE),
  };
})();
window.LTP_PROJECT_CATS = ["Rental", "Labor", "Service", "Full Production"];
window.LTP_CAT_KEYS = { "Rental": "rental", "Labor": "labor", "Service": "service", "Full Production": "full-production" };
window.LTP_CAT_COLORS = { "Rental": "#6FA8F5", "Labor": "#F5B83D", "Service": "#5FD08A", "Full Production": "#FF8A50" };
window.LTP_MODULES = [
  { id: "dashboard", label: "Dashboard"  },
  { id: "crm",       label: "CRM"        },
  { id: "projects",  label: "Projects"   },
  { id: "calendar",  label: "Calendar"   },
  { id: "rentals",   label: "Rentals"    },
  { id: "quotes",    label: "Quotes"     },
  { id: "invoices",  label: "Invoicing"  },
  { id: "labor",     label: "Labor"      },
  { id: "settings",  label: "Settings"   },
];
