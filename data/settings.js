// Company Settings — branding, contact info, defaults
window.LTP_DATA_SETTINGS = {
  // Company Info
  companyName: "Luminary Technology & Productions",
  companyShort: "LTP",
  tagline: "Technical Production & Lighting Design",
  userName: "Landry Strickland",
  phone: "(214) 555-0100",
  email: "info@luminarytp.com",
  website: "www.luminarytp.com",

  // Address
  street: "1234 Main Street",
  suite: "Suite 200",
  city: "Dallas",
  state: "TX",
  zip: "75201",

  // Branding
  accentColor: "#E8731A",
  logoUrl: "",

  // Tag & Badge Colors — single hex per tag, app auto-generates bg/border
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

  // Crew Options
  crewRoleOptions: ["L1", "L2", "L3", "LD", "A1", "A2", "A3", "V1", "V2", "SH", "SM", "F1", "F2", "RIG", "PM", "TD", "PA"],
  crewDepartmentOptions: ["Lighting", "Audio", "Video", "Stage", "Rigging", "Production"],

  // Defaults
  defaultPaymentTerms: 30, // Net 30
  taxRate: 0, // percentage, 0 = no tax
  defaultQuoteNotes: "This quote is valid for 30 days from the date of issue.",
  defaultInvoiceNotes: "Payment is due upon receipt unless otherwise noted.",
  defaultQuoteValidity: 30, // days

  // Email
  emailFrom: "info@luminarytp.com",
  emailReplyTo: "info@luminarytp.com",
  emailSignature: "Thank you for your business.\n\nLuminary Technology & Productions\n(214) 555-0100\nwww.luminarytp.com",

  // Email Templates — use {{variable}} for dynamic content
  // Available: {{companyName}}, {{refNumber}}, {{projectName}}, {{clientName}},
  //            {{total}}, {{dueDate}}, {{lineItems}}, {{signature}},
  //            {{crewName}}, {{role}}, {{date}}, {{callTime}}, {{wrapTime}}, {{location}}
  emailTemplates: {
    quoteSent: {
      label: "Quote Sent",
      subject: "{{refNumber}} — {{projectName}} from {{companyName}}",
      body: "Hi {{clientName}},\n\nPlease find the attached quote {{refNumber}} for {{projectName}}.\n\nQuote Total: {{total}}\n\nThis quote is valid for {{quoteValidity}} days from the date of issue. Please review and let us know if you have any questions or would like to proceed.\n\n{{signature}}"
    },
    quoteFollowUp: {
      label: "Quote Follow-Up",
      subject: "Following up: {{refNumber}} — {{projectName}}",
      body: "Hi {{clientName}},\n\nI wanted to follow up on quote {{refNumber}} for {{projectName}} that we sent over recently.\n\nQuote Total: {{total}}\n\nPlease let us know if you have any questions or if you'd like to discuss any adjustments.\n\n{{signature}}"
    },
    invoiceSent: {
      label: "Invoice Sent",
      subject: "{{refNumber}} — {{projectName}} from {{companyName}}",
      body: "Hi {{clientName}},\n\nPlease find attached invoice {{refNumber}} for {{projectName}}.\n\nInvoice Total: {{total}}\nDue Date: {{dueDate}}\n\nPayment can be made via check or ACH transfer. Please reference {{refNumber}} with your payment.\n\n{{signature}}"
    },
    invoiceReminder: {
      label: "Payment Reminder",
      subject: "Payment Reminder: {{refNumber}} — {{projectName}}",
      body: "Hi {{clientName}},\n\nThis is a friendly reminder that invoice {{refNumber}} for {{projectName}} is due on {{dueDate}}.\n\nAmount Due: {{total}}\n\nIf payment has already been sent, please disregard this message.\n\n{{signature}}"
    },
    paymentReceipt: {
      label: "Payment Receipt",
      subject: "{{refNumber}} — Payment Received — Thank You",
      body: "Hi {{clientName}},\n\nThank you! We have received your payment for {{refNumber}} ({{projectName}}).\n\nInvoice Total: {{total}}\n\n{{lineItems}}\n\nBalance: $0.00 — Paid in Full\n\nThis email serves as your receipt. Please keep it for your records.\n\n{{signature}}"
    },
    crewRequest: {
      label: "Crew Availability Request",
      subject: "Availability Check: {{projectName}} — {{date}}",
      body: "Hi {{crewName}},\n\nWe have an upcoming project and would like to check your availability.\n\nProject: {{projectName}}\nRole: {{role}}\nDate: {{date}}\nCall: {{callTime}}\nWrap: {{wrapTime}}\nLocation: {{location}}\n\nPlease let us know if you're available and interested.\n\n{{signature}}"
    },
    crewConfirmed: {
      label: "Crew Position Confirmed",
      subject: "Confirmed: {{projectName}} — {{date}}",
      body: "Hi {{crewName}},\n\nYou are confirmed for the following:\n\nProject: {{projectName}}\nRole: {{role}}\nDate: {{date}}\nCall: {{callTime}}\nWrap: {{wrapTime}}\nLocation: {{location}}\n\nPlease reach out if you have any questions. We look forward to working with you.\n\n{{signature}}"
    },
    crewCancelled: {
      label: "Position Cancellation",
      subject: "Schedule Update: {{projectName}} — {{date}}",
      body: "Hi {{crewName}},\n\nWe're writing to let you know that your position on the following has been cancelled:\n\nProject: {{projectName}}\nRole: {{role}}\nDate: {{date}}\n\nWe apologize for any inconvenience and hope to work with you on future projects.\n\n{{signature}}"
    },
    crewNotSelected: {
      label: "Not Selected for Position",
      subject: "Update: {{projectName}} — {{date}}",
      body: "Hi {{crewName}},\n\nThank you for your interest and availability for {{projectName}} on {{date}}.\n\nUnfortunately, we've gone in a different direction for the {{role}} position and won't be needing your services for this particular project.\n\nWe appreciate your willingness to work with us and will absolutely keep you in mind for upcoming opportunities.\n\n{{signature}}"
    },
  },
};
