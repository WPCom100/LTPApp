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
    active: "#4CAF50", inactive: "#888888", "one-time": "#3B82F6", client: "#4CAF50", vendor: "#3B82F6", prospect: "#F5A623",
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
  emailSignatureTemplate: '<table style="padding:0;margin:18px 0 0 0;border:none;border-collapse:collapse"><tr><td style="padding:0 10px 0 0;vertical-align:top"><img alt="{{userName}}" height="120" src="{{userPhoto}}" width="120" style="display:block;border-radius:50%;object-fit:cover"></td><td style="border-left:3px solid #dddddd;padding:6px 0 0 14px;font-family:\'verdana\',\'geneva\',sans-serif;font-size:12px;line-height:14px;color:#233038"><div style="margin-bottom:10px"><strong><span style="font-size:16px;color:#ef5822">{{userName}}</span></strong><br>{{userTitle}}</div><div style="margin-bottom:10px"><a href="mailto:{{userEmail}}" style="color:#233038;text-decoration:none" target="_blank">{{userEmail}}</a><br>M:&nbsp;<a href="tel:{{userPhone}}" style="color:#233038;text-decoration:none" target="_blank">{{userPhone}}</a></div><div style="margin-bottom:10px"><span style="font-size:15px;color:#ef5822"><strong>Luminary Technology &amp; Productions</strong></span><br>3786 Arapaho Rd.<br>Addison, TX 75001<br><a href="https://LuminaryTechnology.Productions" style="color:#233038;text-decoration:none" target="_blank">LuminaryTechnology.Productions</a></div><div><a href="https://www.facebook.com/profile.php?id=61563798680454" style="color:rgb(255,146,30);text-decoration:none;margin-right:6px" target="_blank"><img alt="facebook" height="18" src="https://storage.googleapis.com/signaturesatori/icons/cf/16/ff6633/facebook.png" width="18" style="vertical-align:middle"></a><a href="https://www.instagram.com/luminarytechnologyproductions/" style="color:rgb(255,146,30);text-decoration:none" target="_blank"><img alt="instagram" height="18" src="https://storage.googleapis.com/signaturesatori/icons/cf/16/ff6633/instagram.png" width="18" style="vertical-align:middle"></a></div></td></tr></table>',

  // Customer-facing email header block. Renders ONLY when a body uses
  // the {{header}} placeholder (all customer templates below do; crew
  // templates do not). Treated as a non-editable block in the WYSIWYG
  // editor (analog of emailSignatureTemplate / .ltp-sig-block).
  //
  // Substitution split: the FRONTEND expands {{header}} into this HTML
  // with the per-entity tokens ({{refNumber}}, {{projectName}}, {{total}})
  // baked in by the same vars resolution that handles the rest of the
  // body — runs in executeSendQuote / executeSend / sendReceipt right
  // before POSTing. The BACKEND then substitutes {{viewUrl}} (per-
  // recipient tracking URL) and {{signature}} (per-sender) in the
  // already-expanded HTML. Backend does NOT touch {{header}} on
  // purpose — it has no per-entity vars and would leak literal
  // {{refNumber}}/{{projectName}}/{{total}} into the email.
  //
  // The fallback string MUST match backend/routes/email.py::_FALLBACK_HEADER
  // byte-for-byte so the Send-modal preview shows the same header the
  // recipient gets.
  emailHeaderTemplate: '<div style="padding:0px"><table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin-top:5px"><tbody><tr><td valign="center"><span style="display:inline-block;vertical-align:middle;border-radius:3px;background:#ef5822;margin:0 8px 6px 0"><a style="font-size:12px;color:#ffffff;display:block;padding:8px 12px 11px;text-decoration:none;font-weight:bold" href="{{viewUrl}}">View &amp; Accept or Decline</a></span><span style="display:inline-block;vertical-align:middle;font-size:12px"><span style="font-weight:bold">{{refNumber}} - {{projectName}}</span><br><span>{{total}}</span></span></td></tr><tr><td valign="center"><hr width="100%" style="background-color:rgb(204,204,204);border:medium none;clear:both;display:block;font-size:0px;min-height:1px;line-height:0;margin:10px 0px"></td></tr></tbody></table></div>',

  // Email Templates — generic with {{variable}} placeholders. Users can edit per-template in Settings.
  // Available: {{companyName}}, {{refNumber}}, {{projectName}}, {{clientName}},
  //            {{total}}, {{dueDate}}, {{lineItems}}, {{signature}}, {{header}},
  //            {{crewName}}, {{role}}, {{date}}, {{callTime}}, {{wrapTime}}, {{location}},
  //            {{quoteValidity}}, {{viewUrl}}
  //
  // The branded MASTHEAD (linear logo + color-matched rule) and the surrounding
  // card container are NOT template tokens — every email is wrapped in the shared
  // container at send time (backend/routes/email.py via crew.py::email_shell +
  // render_masthead), the same one the crew emails use, so the masthead is
  // identical everywhere. Template bodies hold just the message content.
  //
  // {{header}} renders an action header block. For customer templates (quotes
  // + invoices + receipts) it's the "View & Accept or Decline" button +
  // refNumber/projectName/total. For crewRequest it's the Accept/Decline
  // buttons (linking to the crew landing page #/crew/{token}) + project +
  // shift-count summary; {{shifts}} renders that request's shift list. Both are
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
