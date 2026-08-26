// App-wide defaults. Personal identity (name, email, phone, picture) is
// sourced from Google via /auth/me and stored on the User row — NOT here.
// What stays in this blob is COMPANY-level config (name, tagline, address,
// branding, business defaults) plus app-rendering needs (tag colors, crew
// dropdowns, email templates). All admin-edited, shared across all users.
window.LTP_DATA_SETTINGS = {
  // Company Info — admin-edited via Settings UI
  companyName: "",
  companyShort: "",
  tagline: "",
  phone: "",     // company main line, not personal
  website: "",

  // Address (company HQ)
  street: "",
  suite: "",
  city: "",
  state: "",
  zip: "",

  // Branding — orange is just a starter accent; admins can change in Settings
  accentColor: "#EF5822",
  logoUrl: "",

  // Tag & Badge Colors — single hex per tag, app auto-generates bg/border.
  // Removing these would leave every status/tag pill in the UI with no color.
  // Hues are the soft-on-slate family from theme.js (green/red/blue/amber/
  // orange/grey) so pills sit comfortably on the slate surfaces.
  tagColors: {
    // Departments
    Lighting: "#F5B83D", Audio: "#6FA8F5", Video: "#F0857A", Stage: "#B98AF0", Rigging: "#FF8A50", Production: "#5FD08A",
    // Document status
    draft: "#6E7E86", sent: "#6FA8F5", accepted: "#5FD08A", declined: "#F0857A", converted: "#5FD08A",
    paid: "#5FD08A", partial: "#F5B83D", overdue: "#F0857A",
    // Crew status
    open: "#6E7E86", requested: "#F5B83D", confirmed: "#6FA8F5",
    // CRM
    active: "#5FD08A", inactive: "#8A99A0", "one-time": "#6FA8F5", client: "#5FD08A", vendor: "#6FA8F5", prospect: "#F5B83D",
    // Project categories
    rental: "#6FA8F5", labor: "#F5B83D", service: "#5FD08A", "full-production": "#FF8A50",
    // Other
    "in-progress": "#F5B83D", completed: "#5FD08A", upcoming: "#6FA8F5",
    invoiced: "#FF8A50", booked: "#F5B83D", cancelled: "#8A99A0",
  },

  // Crew Options — department dropdown seed.
  // Role abbreviations are intentionally NOT seeded here. Every role code the
  // app offers or displays comes from the labor rate card (Quotes → Services),
  // so a role can never appear that isn't backed by a real service — plus any
  // one-off role a user has already saved on a specific crew member. Kept as an
  // empty list (rather than removed) so any legacy reader sees [] not undefined;
  // it is no longer read by the crew form or the Settings editor.
  crewRoleOptions: [],
  crewDepartmentOptions: ["Lighting", "Audio", "Video", "Stage", "Rigging", "Production"],

  // Fee quick-picks — one-tap names that pre-fill a CUSTOM fee's description in
  // the quote/invoice Add-Item → Fees tab. Editable from Quotes → Fees.
  feeQuickNames: ["Lodging", "Meal Expenses", "Travel", "Consultation", "Project Prep"],

  // Business Defaults
  defaultPaymentTerms: 30,        // Net 30
  // No taxRate: sales tax is QuickBooks-authoritative (backend/qbo_sync.py).
  // Fallback shelf life for a quote that carries no expiry date of its own.
  // A quote's OWN expiryDate wins wherever it's set (the builder stamps one on
  // send); this is what the terms block, the PDF and {{quoteValidity}} resolve
  // to when it isn't. See window.LTP_quoteExpiry in theme.js.
  defaultQuoteValidity: 30,       // days
  defaultQuoteNotes: "This quote is valid for 30 days from the date of issue.",
  defaultInvoiceNotes: "Payment is due upon receipt unless otherwise noted.",

  // Pay periods (crew payroll cycle) — drives the Payouts tab's pay-period
  // presets and the QuickBooks vendor-bill dates. `payPeriodAnchor` is the
  // start date of any known cycle; periods tile the calendar from there in
  // fixed `payPeriodLengthDays`-day windows. The pay (bill due) date is the
  // period end plus `payPeriodPayDayOffsetDays`. Default: the two-week cycle
  // Mon 2026-07-06 → Sun 2026-07-19, paid the following Friday (end + 5).
  payPeriodAnchor: "2026-07-06",
  payPeriodLengthDays: 14,
  payPeriodPayDayOffsetDays: 5,

  // Email — company-level outbound config (admin-edited).
  emailFrom: "",
  emailReplyTo: "",

  // Workspace-wide signature template. Renders per-user when a body uses
  // the {{signature}} placeholder: backend substitutes {{userName}},
  // {{userEmail}}, {{userTitle}}, {{userPhone}} against the sender's User
  // row.
  //
  // This default is a rich Gmail-export-style signature: two-column
  // table with the company logo on the left + an accent-bordered
  // contact block on the right (name + title + email + phone), then
  // a company block (name + address + website), then social icons.
  // All inline-styled — no <style> blocks, since Gmail/Outlook strip
  // them. Image URLs point at the public site directly (not the Gmail
  // image-proxy wrappers, which break in non-Gmail clients).
  emailSignatureTemplate: '<table style="padding:0;margin:18px 0 0 0;border:none;border-collapse:collapse;max-width:100%"><tr><td style="padding:0 10px 0 0;vertical-align:top"><img alt="{{userName}}" height="120" src="{{userPhoto}}" width="120" style="display:block;border-radius:50%;object-fit:cover"></td><td style="border-left:3px solid #dddddd;padding:6px 0 0 14px;word-break:break-word;font-family:\'verdana\',\'geneva\',sans-serif;font-size:12px;line-height:14px;color:#233038"><div style="margin-bottom:10px"><strong><span style="font-size:16px;color:#ef5822">{{userName}}</span></strong><br>{{userTitle}}</div><div style="margin-bottom:10px"><a href="mailto:{{userEmail}}" style="color:#233038;text-decoration:none" target="_blank">{{userEmail}}</a><br>M:&nbsp;<a href="tel:{{userPhone}}" style="color:#233038;text-decoration:none" target="_blank">{{userPhone}}</a></div><div style="margin-bottom:10px"><span style="font-size:15px;color:#ef5822"><strong>Luminary Technology &amp; Productions</strong></span><br>3786 Arapaho Rd.<br>Addison, TX 75001<br><a href="https://LuminaryTechnology.Productions" style="color:#233038;text-decoration:none" target="_blank">LuminaryTechnology.Productions</a></div><div><a href="https://www.facebook.com/profile.php?id=61563798680454" style="color:rgb(255,146,30);text-decoration:none;margin-right:6px" target="_blank"><img alt="facebook" height="18" src="https://storage.googleapis.com/signaturesatori/icons/cf/16/ff6633/facebook.png" width="18" style="vertical-align:middle"></a><a href="https://www.instagram.com/luminarytechnologyproductions/" style="color:rgb(255,146,30);text-decoration:none" target="_blank"><img alt="instagram" height="18" src="https://storage.googleapis.com/signaturesatori/icons/cf/16/ff6633/instagram.png" width="18" style="vertical-align:middle"></a></div></td></tr></table>',

  // NOTE: there is no editable email-header template. The {{header}} action
  // box (refNumber + project + total + a centered CTA button) is generated
  // per email type by theme.js::LTP_renderHeader — quotes, invoices, and
  // receipts each get their own button wording, so there's no single shared
  // string to store here. The box matches the crew-availability card so the
  // masthead + container read identically across every email.

  // Email Templates — generic with {{variable}} placeholders. Users can edit per-template in Settings.
  // Available (UNION across all templates — the EXACT set each template supports
  // is in LTP_TEMPLATE_VARIABLES below, and shown per-template in the Settings UI):
  // Available: {{companyName}}, {{refNumber}}, {{projectName}}, {{clientName}},
  //            {{total}}, {{dueDate}}, {{lineItems}}, {{signature}}, {{header}},
  //            {{shifts}}, {{crewName}}, {{role}}, {{date}}, {{callTime}},
  //            {{wrapTime}}, {{location}}, {{quoteValidity}}, {{viewUrl}}
  //
  // The branded MASTHEAD (linear logo + color-matched rule) and the surrounding
  // card container are NOT template tokens — every email is wrapped in the shared
  // container at send time (backend/routes/email.py via crew.py::email_shell +
  // render_masthead), the same one the crew emails use, so the masthead is
  // identical everywhere. Template bodies hold just the message content.
  //
  // {{header}} renders an action header block. For customer templates it's a
  // box with refNumber/projectName/total + one centered CTA button, generated
  // per type by theme.js::LTP_renderHeader and expanded client-side just
  // before send: quotes -> "View & Accept or Decline", invoices -> "View &
  // Download", receipts -> "View Receipt". For crewRequest it's the Accept/Decline
  // buttons (linking to the crew landing page #/crew/{token}) + project +
  // shift-count summary; {{shifts}} renders that request's shift list — both
  // substituted server-side (backend/routes/crew.py) at send time.
  emailTemplates: {
    quoteSent: {
      label: "Quote Sent",
      cc: "",
      subject: "{{refNumber}} — {{projectName}} from {{companyName}}",
      body: "{{header}}\n\nHi {{clientName}},\n\nPlease find the attached quote {{refNumber}} for {{projectName}}.\n\nThis quote is valid for {{quoteValidity}} days from the date of issue. Please review and let us know if you have any questions or would like to proceed.\n\n{{signature}}"
    },
    quoteFollowUp: {
      label: "Quote Follow-Up",
      cc: "",
      subject: "Following up: {{refNumber}} — {{projectName}}",
      body: "{{header}}\n\nHi {{clientName}},\n\nI wanted to follow up on quote {{refNumber}} for {{projectName}} that we sent over recently.\n\nPlease let us know if you have any questions or if you'd like to discuss any adjustments.\n\n{{signature}}"
    },
    invoiceSent: {
      label: "Invoice Sent",
      cc: "",
      subject: "{{refNumber}} — {{projectName}} from {{companyName}}",
      body: "{{header}}\n\nHi {{clientName}},\n\nPlease find attached invoice {{refNumber}} for {{projectName}}.\n\nDue Date: {{dueDate}}\n\nPayment can be made via check or ACH transfer. Please reference {{refNumber}} with your payment.\n\n{{signature}}"
    },
    invoiceReminder: {
      label: "Payment Reminder",
      cc: "",
      subject: "Payment Reminder: {{refNumber}} — {{projectName}}",
      body: "{{header}}\n\nHi {{clientName}},\n\nThis is a friendly reminder that invoice {{refNumber}} for {{projectName}} is due on {{dueDate}}.\n\nIf payment has already been sent, please disregard this message.\n\n{{signature}}"
    },
    paymentReceipt: {
      label: "Payment Receipt",
      cc: "",
      subject: "{{refNumber}} — Payment Received — Thank You",
      body: "{{header}}\n\nHi {{clientName}},\n\nThank you! We have received your payment for {{refNumber}} ({{projectName}}).\n\n{{lineItems}}\n\nBalance: $0.00 — Paid in Full\n\nThis email serves as your receipt. Please keep it for your records.\n\n{{signature}}"
    },
    crewRequest: {
      label: "Crew Request",
      cc: "",
      // Multi-shift tokenized request. {{header}} renders the Accept/Decline
      // buttons (linking to the crew landing page) + project summary; {{shifts}}
      // renders the shift list. Both, plus {{signature}}, are substituted
      // server-side by backend/routes/crew.py at send time.
      subject: "Crew request: {{projectName}} — {{companyName}}",
      body: "Hi {{crewName}},\n\nWe'd like to book you for an upcoming project. Please review the details below and let us know if you can take it.\n\n{{header}}\n\n{{shifts}}\n\nQuestions? Just reply to this email and we'll be glad to help.\n\n{{signature}}"
    },
    crewConfirmed: {
      label: "Crew Position Confirmed",
      cc: "",
      // Sent when a producer CONFIRMS an accepted crew member. {{addToCalendar}}
      // renders one-tap "Add to Calendar" button(s) for the confirmed shift(s);
      // the backend injects it above the signature even for a saved body that
      // predates the token. The routes/crew.py::_NOTIFY_FALLBACKS entry must
      // match this body byte-for-byte.
      subject: "Confirmed: {{projectName}} — {{date}}",
      body: "Hi {{crewName}},\n\nYou are confirmed for the following:\n\nProject: {{projectName}}\nRole: {{role}}\nDate: {{date}}\nCall: {{callTime}}\nWrap: {{wrapTime}}\nLocation: {{location}}\n\nPlease reach out if you have any questions. We look forward to working with you.\n\n{{addToCalendar}}\n\n{{signature}}"
    },
    crewCancelled: {
      label: "Position Cancellation",
      cc: "",
      // Sent when a CONFIRMED booking is cancelled. Project-level + {{shifts}} so
      // one notice can cover several cancelled shifts (the notify tray groups per
      // person). The backend fallback in routes/crew.py::_NOTIFY_FALLBACKS must
      // match this body byte-for-byte.
      subject: "Schedule Update: {{projectName}} — position cancelled",
      body: "Hi {{crewName}},\n\nWe're writing to let you know that your confirmed position on {{projectName}} has been cancelled. The following shifts are affected:\n\n{{shifts}}\n\nWe apologize for any inconvenience and hope to work with you on future projects.\n\n{{signature}}"
    },
    crewNotSelected: {
      label: "Not Selected for Position",
      cc: "",
      // Sent when an ACCEPTED crew member is released. Project-level + {{shifts}}
      // (the notify tray groups per person). The backend fallback in
      // routes/crew.py::_NOTIFY_FALLBACKS must match this body byte-for-byte.
      subject: "Update: {{projectName}}",
      body: "Hi {{crewName}},\n\nThank you for your interest and availability for {{projectName}}. Unfortunately, we've gone in a different direction and won't be needing your services for the following shifts:\n\n{{shifts}}\n\nWe appreciate your willingness to work with us and will absolutely keep you in mind for upcoming opportunities.\n\n{{signature}}"
    },
    crewWithdrawn: {
      label: "Request Withdrawn",
      cc: "",
      // Sent (optionally) when a producer WITHDRAWS a pending crew request — the
      // person was asked, but the ask is now retracted. Project-level (a request
      // can span several shifts), so no {{role}}/{{date}}. The backend fallback in
      // routes/crew.py::_NOTIFY_FALLBACKS must match this body byte-for-byte.
      subject: "Update: {{projectName}} — crew request withdrawn",
      body: "Hi {{crewName}},\n\nWe've withdrawn our crew request for {{projectName}} — no response is needed on the following shifts:\n\n{{shifts}}\n\nThank you for your time, and we'll keep you in mind for future projects.\n\n{{signature}}"
    },
    crewScheduleChanged: {
      label: "Schedule Change",
      cc: "",
      // Sent when a shift a crew member is committed to (requested / accepted /
      // confirmed) has its call/wrap time or date MOVED. Project-level +
      // {{shifts}} (the notify tray groups per person), and each shift card
      // spells out the change — the new details with an "Updated from …" line
      // showing the prior time/date. The backend fallback in
      // routes/crew.py::_NOTIFY_FALLBACKS must match this body byte-for-byte.
      subject: "Schedule Update: {{projectName}} — shift times changed",
      body: "Hi {{crewName}},\n\nThe schedule for {{projectName}} has been updated. Please review your revised shift details below — the previous time is noted on each shift that moved:\n\n{{shifts}}\n\nIf the new schedule doesn't work for you, just reply to this email and let us know.\n\n{{signature}}"
    },
    crewShiftNote: {
      label: "Shift Note Added",
      cc: "",
      // Sent when a producer adds/updates a note on a shift a crew member is
      // CONFIRMED on (from Labor → Assignments). Project-level + {{shifts}} — the
      // note rides inside each shift card. The routes/crew.py::_NOTIFY_FALLBACKS
      // entry must match this body byte-for-byte.
      subject: "Note added: {{projectName}}",
      body: "Hi {{crewName}},\n\nThere's a new note for your confirmed call on {{projectName}} — please review it below:\n\n{{shifts}}\n\nAny questions, just reply to this email.\n\n{{signature}}"
    },
  },
};

// Variables available PER email template — drives the per-template chip rows in
// Settings. Each list is exactly what that template's send path resolves, so an
// admin editing a body knows precisely what they can use (an unlisted token
// would leak as literal text). Customer templates are composed client-side
// (modules/quotes-builder.js openQuoteSendModal, modules/invoices.js
// openSendModal / openReceiptModal); crew templates are composed server-side
// (backend/routes/crew.py). header / signature / shifts are block placeholders
// that expand to HTML; viewUrl is resolved per-recipient by the backend.
// Kept OUTSIDE LTP_DATA_SETTINGS so it never enters the persisted settings blob.
window.LTP_TEMPLATE_VARIABLES = {
  // quoteValidity is the shelf life in DAYS, quoteExpiry the same deadline as a
  // date — both resolved from the quote's own expiry date, falling back to
  // defaultQuoteValidity below when it doesn't carry one.
  quoteSent:       ["companyName", "refNumber", "projectName", "clientName", "total", "quoteValidity", "quoteExpiry", "header", "signature", "viewUrl"],
  quoteFollowUp:   ["companyName", "refNumber", "projectName", "clientName", "total", "quoteValidity", "quoteExpiry", "header", "signature", "viewUrl"],
  invoiceSent:     ["companyName", "refNumber", "projectName", "clientName", "total", "dueDate", "header", "signature", "viewUrl"],
  invoiceReminder: ["companyName", "refNumber", "projectName", "clientName", "total", "dueDate", "header", "signature", "viewUrl"],
  paymentReceipt:  ["companyName", "refNumber", "projectName", "clientName", "total", "lineItems", "header", "signature", "viewUrl"],
  crewRequest:     ["companyName", "crewName", "projectName", "location", "header", "shifts", "signature"],
  crewConfirmed:   ["companyName", "crewName", "projectName", "role", "date", "callTime", "wrapTime", "location", "addToCalendar", "signature"],
  crewCancelled:   ["companyName", "crewName", "projectName", "shifts", "signature"],
  crewNotSelected: ["companyName", "crewName", "projectName", "shifts", "signature"],
  crewWithdrawn:   ["companyName", "crewName", "projectName", "shifts", "signature"],
  crewScheduleChanged: ["companyName", "crewName", "projectName", "shifts", "signature"],
  crewShiftNote:   ["companyName", "crewName", "projectName", "shifts", "signature"],
};
