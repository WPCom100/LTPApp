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
  accentColor: "#E8731A",
  logoUrl: "",

  // Tag & Badge Colors — single hex per tag, app auto-generates bg/border.
  // Removing these would leave every status/tag pill in the UI with no color.
  tagColors: {
    // Departments
    Lighting: "#F5A623", Audio: "#3B82F6", Video: "#E74C3C", Stage: "#9B59B6", Rigging: "#E8731A", Production: "#4CAF50",
    // Document status
    draft: "#666666", sent: "#3B82F6", accepted: "#4CAF50", declined: "#E74C3C", converted: "#4CAF50",
    paid: "#4CAF50", partial: "#F5A623", overdue: "#E74C3C",
    // Crew status
    open: "#666666", requested: "#F5A623", confirmed: "#3B82F6",
    // CRM
    active: "#4CAF50", inactive: "#888888", client: "#4CAF50", vendor: "#3B82F6", prospect: "#F5A623",
    // Project categories
    rental: "#3B82F6", labor: "#F5A623", service: "#4CAF50", "full-production": "#E8731A",
    // Other
    "in-progress": "#F5A623", completed: "#4CAF50", upcoming: "#3B82F6",
    invoiced: "#E8731A", booked: "#F5A623", cancelled: "#888888",
  },

  // Crew Options — drive role/department dropdowns
  crewRoleOptions: ["L1", "L2", "L3", "LD", "A1", "A2", "A3", "V1", "V2", "SH", "SM", "F1", "F2", "RIG", "PM", "TD", "PA"],
  crewDepartmentOptions: ["Lighting", "Audio", "Video", "Stage", "Rigging", "Production"],

  // Business Defaults
  defaultPaymentTerms: 30,        // Net 30
  taxRate: 0,                     // percentage
  defaultQuoteValidity: 30,       // days
  defaultQuoteNotes: "This quote is valid for 30 days from the date of issue.",
  defaultInvoiceNotes: "Payment is due upon receipt unless otherwise noted.",

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
  emailSignatureTemplate: '<table style="padding:0;margin:18px 0 0 0;border:none;border-collapse:collapse"><tr><td style="padding:0 10px 0 0;vertical-align:top"><img alt="Luminary Technology and Productions" height="135" src="https://www.luminarytechnology.productions/wp-content/uploads/2024/07/LTP-Logo-Stacked.png" style="display:block"></td><td style="border-left:3px solid #dddddd;padding:6px 0 0 14px;font-family:\'verdana\',\'geneva\',sans-serif;font-size:12px;line-height:14px;color:#233038"><div style="margin-bottom:10px"><strong><span style="font-size:16px;color:#ef5822">{{userName}}</span></strong><br>{{userTitle}}</div><div style="margin-bottom:10px"><a href="mailto:{{userEmail}}" style="color:#233038;text-decoration:none" target="_blank">{{userEmail}}</a><br>M:&nbsp;<a href="tel:{{userPhone}}" style="color:#233038;text-decoration:none" target="_blank">{{userPhone}}</a></div><div style="margin-bottom:10px"><span style="font-size:15px;color:#ef5822"><strong>Luminary Technology &amp; Productions</strong></span><br>3786 Arapaho Rd.<br>Addison, TX 75001<br><a href="https://LuminaryTechnology.Productions" style="color:#233038;text-decoration:none" target="_blank">LuminaryTechnology.Productions</a></div><div><a href="https://www.facebook.com/profile.php?id=61563798680454" style="color:rgb(255,146,30);text-decoration:none;margin-right:6px" target="_blank"><img alt="facebook" height="18" src="https://storage.googleapis.com/signaturesatori/icons/cf/16/ff6633/facebook.png" width="18" style="vertical-align:middle"></a><a href="https://www.instagram.com/luminarytechnologyproductions/" style="color:rgb(255,146,30);text-decoration:none" target="_blank"><img alt="instagram" height="18" src="https://storage.googleapis.com/signaturesatori/icons/cf/16/ff6633/instagram.png" width="18" style="vertical-align:middle"></a></div></td></tr></table>',

  // Email Templates — generic with {{variable}} placeholders. Users can edit per-template in Settings.
  // Available: {{companyName}}, {{refNumber}}, {{projectName}}, {{clientName}},
  //            {{total}}, {{dueDate}}, {{lineItems}}, {{signature}},
  //            {{crewName}}, {{role}}, {{date}}, {{callTime}}, {{wrapTime}}, {{location}},
  //            {{quoteValidity}}, {{viewUrl}}
  emailTemplates: {
    quoteSent: {
      label: "Quote Sent",
      cc: "",
      subject: "{{refNumber}} — {{projectName}} from {{companyName}}",
      body: "Hi {{clientName}},\n\nPlease find the attached quote {{refNumber}} for {{projectName}}.\n\nQuote Total: {{total}}\n\n<a href=\"{{viewUrl}}\">View, Accept, or Decline Online</a>\n\nThis quote is valid for {{quoteValidity}} days from the date of issue. Please review and let us know if you have any questions or would like to proceed.\n\n{{signature}}"
    },
    quoteFollowUp: {
      label: "Quote Follow-Up",
      cc: "",
      subject: "Following up: {{refNumber}} — {{projectName}}",
      body: "Hi {{clientName}},\n\nI wanted to follow up on quote {{refNumber}} for {{projectName}} that we sent over recently.\n\nQuote Total: {{total}}\n\n<a href=\"{{viewUrl}}\">View, Accept, or Decline Online</a>\n\nPlease let us know if you have any questions or if you'd like to discuss any adjustments.\n\n{{signature}}"
    },
    invoiceSent: {
      label: "Invoice Sent",
      cc: "",
      subject: "{{refNumber}} — {{projectName}} from {{companyName}}",
      body: "Hi {{clientName}},\n\nPlease find attached invoice {{refNumber}} for {{projectName}}.\n\nInvoice Total: {{total}}\nDue Date: {{dueDate}}\n\n<a href=\"{{viewUrl}}\">View Invoice Online</a>\n\nPayment can be made via check or ACH transfer. Please reference {{refNumber}} with your payment.\n\n{{signature}}"
    },
    invoiceReminder: {
      label: "Payment Reminder",
      cc: "",
      subject: "Payment Reminder: {{refNumber}} — {{projectName}}",
      body: "Hi {{clientName}},\n\nThis is a friendly reminder that invoice {{refNumber}} for {{projectName}} is due on {{dueDate}}.\n\nAmount Due: {{total}}\n\n<a href=\"{{viewUrl}}\">View Invoice Online</a>\n\nIf payment has already been sent, please disregard this message.\n\n{{signature}}"
    },
    paymentReceipt: {
      label: "Payment Receipt",
      cc: "",
      subject: "{{refNumber}} — Payment Received — Thank You",
      body: "Hi {{clientName}},\n\nThank you! We have received your payment for {{refNumber}} ({{projectName}}).\n\nInvoice Total: {{total}}\n\n{{lineItems}}\n\nBalance: $0.00 — Paid in Full\n\nThis email serves as your receipt. Please keep it for your records.\n\n{{signature}}"
    },
    crewRequest: {
      label: "Crew Availability Request",
      cc: "",
      subject: "Availability Check: {{projectName}} — {{date}}",
      body: "Hi {{crewName}},\n\nWe have an upcoming project and would like to check your availability.\n\nProject: {{projectName}}\nRole: {{role}}\nDate: {{date}}\nCall: {{callTime}}\nWrap: {{wrapTime}}\nLocation: {{location}}\n\nPlease let us know if you're available and interested.\n\n{{signature}}"
    },
    crewConfirmed: {
      label: "Crew Position Confirmed",
      cc: "",
      subject: "Confirmed: {{projectName}} — {{date}}",
      body: "Hi {{crewName}},\n\nYou are confirmed for the following:\n\nProject: {{projectName}}\nRole: {{role}}\nDate: {{date}}\nCall: {{callTime}}\nWrap: {{wrapTime}}\nLocation: {{location}}\n\nPlease reach out if you have any questions. We look forward to working with you.\n\n{{signature}}"
    },
    crewCancelled: {
      label: "Position Cancellation",
      cc: "",
      subject: "Schedule Update: {{projectName}} — {{date}}",
      body: "Hi {{crewName}},\n\nWe're writing to let you know that your position on the following has been cancelled:\n\nProject: {{projectName}}\nRole: {{role}}\nDate: {{date}}\n\nWe apologize for any inconvenience and hope to work with you on future projects.\n\n{{signature}}"
    },
    crewNotSelected: {
      label: "Not Selected for Position",
      cc: "",
      subject: "Update: {{projectName}} — {{date}}",
      body: "Hi {{crewName}},\n\nThank you for your interest and availability for {{projectName}} on {{date}}.\n\nUnfortunately, we've gone in a different direction for the {{role}} position and won't be needing your services for this particular project.\n\nWe appreciate your willingness to work with us and will absolutely keep you in mind for upcoming opportunities.\n\n{{signature}}"
    },
  },
};
