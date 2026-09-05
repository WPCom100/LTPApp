from sqlalchemy import Column, Integer, String, Boolean, Float, Text, DateTime, JSON, ForeignKey, LargeBinary, UniqueConstraint, false
from sqlalchemy.orm import deferred
from sqlalchemy.sql import func
from backend.database import Base


# ── Conventions for everything below ────────────────────────────────────────
# - Column names are snake_case. backend/routes/api.py converts to camelCase
#   on the way out and back on the way in, so the frontend keeps its
#   camelCase keys. Only top-level keys are converted — anything stored in a
#   JSON column is passed through verbatim, so its inner keys stay in
#   whatever case the frontend writes them in (typically camelCase).
# - String date columns are ISO YYYY-MM-DD ("2026-04-20"); empty string ""
#   means "unset" (we don't use NULL for these because the frontend always
#   sends a string).
# - Status / category / state strings: see components/status-enums.js for
#   the canonical set of valid values per field.
# - Foreign keys:
#     • SET NULL on parent delete (the row stays, the link breaks)
#       — used everywhere except allocations.
#     • CASCADE on parent delete (the row is destroyed with its parent)
#       — used by Allocation, where an allocation has no meaning without its
#       equipment or project.
# - JSON column comments below describe the shape stored. If you add a new
#   field to one of these structures on the frontend, update the comment.


class Company(Base):
    """A business entity in the CRM — could be a client we sell to, a vendor
    we rent from, or both. `is_client` and `is_vendor` are independent flags
    (a company can be both). `status` ∈ {active, inactive, prospect}."""
    __tablename__ = "companies"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    is_client = Column(Boolean, default=False)
    is_vendor = Column(Boolean, default=False)
    status = Column(String(50), default="active")        # {active, inactive, prospect}
    address = Column(Text, default="")                   # street address (Line1/Line2); city/state/zip below
    city = Column(String(100), default="")               # billing city — feeds QuickBooks BillAddr for sales-tax geocoding
    state = Column(String(50), default="")               # billing state/province code, e.g. "TX"
    zip = Column(String(20), default="")                 # billing postal code
    website = Column(String(255), default="")
    logo = Column(Text, default="")                      # URL or data:image base64
    notes = Column(Text, default="")
    # QuickBooks Online sync. `taxable` is the master switch deciding whether
    # this client's invoice lines get the TAX vs NON tax code when pushed to QB
    # (most LTP clients are tax-exempt → default False; per-line overrides live
    # in the invoice line JSON). `qb_customer_id` caches the QB Customer.Id after
    # the first find-or-create so we never create duplicate QB customers. It is
    # server-authoritative — see _READONLY_COLS in backend/routes/api.py.
    taxable = Column(Boolean, default=False)
    qb_customer_id = Column(String(32), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Contact(Base):
    """A person. Two distinct uses, sometimes overlapping:
       1. Company contact (sales/client point-of-contact) — `company_ids` lists
          the companies they represent.
       2. Crew member (hireable for shifts) — `is_crew=True` enables the
          crew-side fields below. `company_ids` is typically [] for crew.
    A single contact can be both (rare but supported)."""
    __tablename__ = "contacts"

    id = Column(Integer, primary_key=True, index=True)
    first_name = Column(String(100), nullable=False, default="")
    last_name = Column(String(100), nullable=False, default="")
    email = Column(String(255), default="")
    phone = Column(String(50), default="")
    role = Column(String(100), default="")               # job title shown in CRM, e.g. "Production Director"
    # Billing address — used when a Contact is billed directly (client_type="contact").
    # Feeds the QuickBooks customer BillAddr so Automated Sales Tax can geocode it.
    address = Column(Text, default="")                   # billing street (Line1/Line2)
    city = Column(String(100), default="")               # billing city
    state = Column(String(50), default="")               # billing state/province code, e.g. "TX"
    zip = Column(String(20), default="")                 # billing postal code
    company_ids = Column(JSON, default=list)             # list[int] — company.id references
    is_crew = Column(Boolean, default=False)
    crew_roles = Column(JSON, default=list)              # list[str] — role tags: Settings crewRoleOptions codes, labor rate-card roles, or free-text customs, e.g. ["L1","RIG","A1 FUMC"]
    crew_departments = Column(JSON, default=list)        # list[str] — dept names, e.g. ["Lighting","Rigging"]
    crew_notes = Column(Text, default="")
    crew_status = Column(String(20), default="active")   # {active, inactive}
    # Negotiated payout floor: this crew member is paid at least this day rate,
    # even when the role they fill costs less. Cost/payout side ONLY — never
    # billed to the client (the Service rate card still drives what the client
    # pays). Treated like a normal day rate (half-day, meal-penalty, and OT scale
    # the same way). 0/null = no minimum. See theme.js::LTP_calcDayLabor.
    min_day_cost = Column(Float, default=0)
    # QuickBooks Online customer link — used when a Contact is billed directly
    # (client_type="contact"). Taxability is a company-level concept, so there is
    # deliberately no `taxable` flag here; directly-billed contacts are treated
    # as tax-exempt (see backend/qbo_sync.py).
    qb_customer_id = Column(String(32), nullable=True, index=True)
    # QuickBooks Online VENDOR link — the accounts-PAYABLE mirror of
    # qb_customer_id, used when this crew member is paid via a payout vendor bill
    # (backend/qbo_payouts.py). Distinct id because QuickBooks models a person you
    # pay (Vendor) separately from one you bill (Customer). Server-owned: written
    # only by the vendor find-or-create path and stripped from client PUTs
    # (backend/routes/api.py::_READONLY_COLS).
    qb_vendor_id = Column(String(32), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Project(Base):
    """A job for a client — a wedding, gala, corporate event, etc. Hangs
    quotes/invoices/allocations off it. `status` ∈ {upcoming, in-progress,
    completed, cancelled}. `category` ∈ {rental, labor, service,
    full-production} (drives badge color and dashboard grouping)."""
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    company_id = Column(Integer, ForeignKey("companies.id", ondelete="SET NULL"), nullable=True, index=True)
    category = Column(String(100), default="")           # {rental, labor, service, full-production}
    status = Column(String(50), default="upcoming")      # {upcoming, in-progress, completed, cancelled}
    # Manual/one-off shift marker. An "internal" project is a lightweight
    # container for labor that doesn't belong to a client job — warehouse
    # load-outs, prep days, etc. It carries no company and is created through the
    # Labor module's one-off "Manual Shift" adder (a single dated schedule day
    # with positions), NOT the schedule editor. It deliberately reuses the
    # Project+schedule shape so a manual shift flows through the crew-request and
    # payout pipelines unchanged (both iterate every project's schedule). The
    # flag exists purely so client-facing surfaces (Projects list, dashboard,
    # calendar, quote/invoice pickers, global search) can hide it while every
    # Labor surface keeps showing it. USER-WRITABLE (flows through normal CRUD).
    internal = Column(Boolean, default=False)
    start_date = Column(String(10), default="")          # ISO YYYY-MM-DD
    end_date = Column(String(10), default="")            # ISO YYYY-MM-DD
    venue = Column(String(255), default="")
    # Job-site address for crew-facing surfaces (request emails, the public
    # crew page). Either typed directly, or derived live from the client
    # company's billing address when site_use_company_address is set — derived
    # so a company address edit flows to future sends without re-saving the
    # project. See backend/routes/crew.py::_resolve_site_address.
    site_address = Column(Text, default="")
    site_use_company_address = Column(Boolean, default=False)
    # budget is a category breakdown, NOT a single number. The form in
    # modules/crm-projects.js (search for budL/budLb/budR/budM) saves the
    # object literal directly.
    budget = Column(JSON, default=dict)                  # {lighting: float, labor: float, rentals: float, misc: float}
    contact_ids = Column(JSON, default=list)             # list[int] — contact.id references (project team)
    # notes is an array of dated entries, NOT free-form text. Free-form
    # commentary lives inside each entry's `text` field.
    notes = Column(JSON, default=list)                   # list[{id: int, date: str, author: str, text: str, linkedMeetingId: int|null}]
    meetings = Column(JSON, default=list)                # list[{id: int, title: str, date: str, time: str, attendees: list[int], notes: str, calSynced: bool}]
    schedule = Column(JSON, default=list)                # list[{id: str, title: str, date: str, time: str, endTime: str, addToCalendar: bool,
                                                         #       breaks: list[{id, startTime, endTime, type:"paid"|"unpaid"}],
                                                         #       positions: list[{id, role, serviceId, crewId, status, fullMargin: bool, slot?: int, breaks?: list}]}]
                                                         #       (position.breaks: individual meal breaks for THAT person only —
                                                         #        distinct from item.breaks which apply to the whole crew on the shift)
                                                         #       (fullMargin: bill the rate but $0 company cost, e.g. owner working;
                                                         #        slot: person-identity within a role/day — positions sharing role+slot
                                                         #        are one person, different slots are different people for OT tracking)
    schedule_notes = Column(Text, default="")            # free-text notes shown in the schedule builder
    schedule_activity = Column(JSON, default=list)       # list[{id, date, time, type, message, user, userId, changes}] — schedule save log
    # Flat-rate ("fixed cost") positions — people hired for the WHOLE project at
    # a negotiated flat fee with no contracted shift times (a lighting designer,
    # a stage manager …). They make their own hours against the project's dates,
    # so they deliberately do NOT live on a schedule row: every schedule consumer
    # keys money and crew asks on a dated, timed shift, and a flat engagement
    # has neither. They share the position id namespace with
    # schedule[].positions[] (crew_requests.position_ids may reference either),
    # the same open → requested → accepted/declined → confirmed lifecycle, and
    # the same frozen `pay` / `work` / `adj` snapshot shape, so crew_integrity
    # and payouts treat the two alike.
    #   list[{id, serviceId, role, crewId, status, fee, bill, fullMargin,
    #         note, pay?, work?, adj?}]
    #   serviceId  rate-card role (required) — drives crew-picker matching and
    #              the QuickBooks expense account, never the amount
    #   fee        what we pay the person (cost side). Deliberately shown on the
    #              crew request email/page — it IS the offer being accepted
    #   bill       what the client is charged (rate side); margin = bill − fee
    #   fullMargin bill the client, $0 cost (the owner filling the role)
    #   note       crew-facing scope line (what the engagement covers)
    #   (timing)   no per-position pay date, deliberately: the fee lands in the
    #              payroll period the project's end_date falls into and is paid
    #              on that period's pay day with every other payout
    #              (backend/payouts.py::fixed_pay_date)
    #   pay        {total, lockedAt} stamped at confirm, like a shift's `pay`
    #   work       {state:"completed", pay:{total, tier:"flat", units:[…]},
    #              signedAt, signedBy} — written by "Mark complete" on the
    #              Payouts tab; work.pay.total is billed verbatim to the vendor bill
    #   adj        pay adjustments, same shape as a shift's
    fixed_positions = Column(JSON, default=list)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Quote(Base):
    """A proposal sent to a client before the work happens. Lifecycle:
       draft → sent → accepted/declined → converted (to invoice).
    `client_type` ∈ {company, contact} — picks which FK is the billing party
    (some clients are individuals without a company). The `sections` JSON
    holds the line items; totals are computed on the frontend (see
    LTP_QUOTE_TOTALS in modules/quotes-list.js)."""
    __tablename__ = "quotes"

    id = Column(Integer, primary_key=True, index=True)
    client_type = Column(String(20), default="company") # {company, contact}
    company_id = Column(Integer, ForeignKey("companies.id", ondelete="SET NULL"), nullable=True, index=True)
    client_contact_id = Column(Integer, ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True)
    # Every project this quote bills work for, primary first. A schedule can be
    # sent into any of the client's draft quotes regardless of which project that
    # quote started on, so one document may cover several jobs. `project_id`
    # above stays the PRIMARY — it still names the document on the PDF and in
    # notifications — and this list is what the "Includes" line renders from.
    # Legacy rows have NULL/[]; readers must fall back to [project_id].
    # See window.LTP_docProjectIds in theme.js (the frontend mirror).
    project_ids = Column(JSON, default=list)            # list[int]
    status = Column(String(20), default="draft")        # {draft, sent, accepted, declined, converted}
    sent_date = Column(String(10), default="")          # ISO YYYY-MM-DD
    # The date this quote's pricing stops being good for. "" means "not set" —
    # every reader then falls back to the workspace default (Settings →
    # defaultQuoteValidity, 30 days) counted from the sent date, which is the
    # only rule that existed before this column. The builder stamps a concrete
    # date on send so a quote's terms can't silently move afterwards, and a
    # producer can override it per quote for a client who needs longer.
    # Shown in the builder, the printed PDF's terms, and the client's view.
    expiry_date = Column(String(10), default="")        # ISO YYYY-MM-DD
    custom_start_date = Column(String(10), default="") # overrides project's startDate on the printed quote
    custom_end_date = Column(String(10), default="")   # overrides project's endDate on the printed quote
    custom_name = Column(String(255), default="")      # overrides project.name on the printed quote
    global_discount = Column(JSON, default=dict)        # {type: "none"|"percent"|"amount"|"target", value: float}
                                                        # "amount" = fixed dollars off, "target" = discount TO this
                                                        # total. "flat" is a legacy alias for "amount", still read
                                                        # by every consumer but no longer written by any UI.
    sections = Column(JSON, default=list)               # list[{id: str, label: str, customDates: bool,
                                                        #       startDate: str, endDate: str,
                                                        #       projectId: int|null,   (set on sections appended from
                                                        #         another project; the label also names it, because
                                                        #         label is what survives the public-view scrub —
                                                        #         see routes/_shared.py::public_section_items)
                                                        #       items: list[QuoteLineItem]}]
                                                        # QuoteLineItem = {
                                                        #   id: str, type: "equipment"|"service"|"product"|"fee"|"note",
                                                        #   name: str, qty: float, unitPrice: float, adjustedPrice: float|null,
                                                        #   rateType: "day"|"halfDay"|"hourly"|"ot"  (services only),
                                                        #   productVariantId: str|null  (products only — chosen pricing variant),
                                                        #   feeId: int|null  (fees only — catalog row, null = custom/ad-hoc fee),
                                                        #   deliveredQty: float, invoicedQty: float,
                                                        #   equipmentId|serviceId|productId: int|null }
                                                        # Fees ("fee") are misc billable lines (Lodging, Meals, Travel,
                                                        # Consultation, Project Prep). Their price varies per project, so a
                                                        # fee line edits `unitPrice` DIRECTLY and never sets `adjustedPrice`
                                                        # — a fee is never counted as a line-item price adjustment.
    notes = Column(Text, default="")                    # internal free-form text; never rendered client-side
    # Client-facing terms & conditions, printed at the foot of the document —
    # one line per bullet, may carry {{token}} placeholders resolved at render
    # time (see doc_terms in backend/pdf_generator.py and its twin
    # window.LTP_docTerms in theme.js). "" = never edited on this document, so
    # readers fall back to the workspace default and then to the built-in list.
    # NOT `notes`, which is internal and never leaves the app.
    terms = Column(Text, default="")
    activity = Column(JSON, default=list)               # list[{id: str, date: str, time: str, type: str, user: str, message: str, changes: list[{cat, detail}]|null}]
    # Remembered email recipients for the send modal: {"to": [email...], "cc":
    # [email...]}. null = not customized yet → derive from the project's contacts
    # (primary → To, the rest → Cc). User-set; flows through the normal CRUD.
    send_recipients = Column(JSON, nullable=True)
    # Opaque public-view credential. Minted server-side on POST (entity
    # creation); see backend/routes/api.py create(). Same security model as
    # PdfArchive.token — anyone with the token can hit /api/view/{token}.
    # Used for client preview, accept/decline, and the live PDF download.
    # NOT NULL because every Quote has one — the create() handler mints it
    # unconditionally if the client didn't supply one.
    share_token = Column(String(64), nullable=False, unique=True, index=True)
    # ── QuickBooks-computed sales tax ───────────────────────────────────────
    # Quotes never become QB documents (the business doesn't use QB estimates),
    # but we still want QB-authoritative tax. The estimate-tax flow
    # (backend/qbo_sync.py::get_quote_estimate_tax) creates a TEMPORARY QB
    # Estimate, reads its computed tax, and deletes it — storing the result
    # here. SERVER-AUTHORITATIVE: written by the sync engine, stripped from
    # inbound client writes by _READONLY_COLS in backend/routes/api.py, and
    # surfaced read-only on GET as qbTaxTotal / qbTaxSignature.
    qb_tax_total = Column(Float, nullable=True)
    # Opaque change-signature captured by the frontend at the last tax calc.
    # The stored tax is "fresh" iff the frontend's live signature matches this;
    # otherwise the builder shows "Recalculate — out of date". Mirrors
    # Invoice.qb_synced_signature.
    qb_tax_signature = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Invoice(Base):
    """A bill sent to a client. Usually derived from a Quote (`quote_id` set)
    but can be free-standing. Lifecycle: draft → sent → partial → paid; or →
    overdue if past due date. The `sections` shape mirrors Quote.sections but
    items have a `sourceItemId` linking back to the quote line they billed."""
    __tablename__ = "invoices"

    id = Column(Integer, primary_key=True, index=True)
    client_type = Column(String(20), default="company") # {company, contact}
    company_id = Column(Integer, ForeignKey("companies.id", ondelete="SET NULL"), nullable=True, index=True)
    client_contact_id = Column(Integer, ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True)
    # Every project this invoice bills work for, primary first — same contract as
    # Quote.project_ids above. Populated when a schedule sends labor into an
    # existing draft invoice, or when a quote for another project converts into
    # one. `project_id` remains the primary.
    project_ids = Column(JSON, default=list)            # list[int]
    # The quote this invoice was FIRST converted from. An invoice may now draw
    # lines from several quotes (the send-to-invoice picker offers any of the
    # client's draft invoices), so this is a convenience back-pointer, not the
    # authority: each line carries its own `sourceQuoteId` and the frontend's
    # invoicedQty rollback keys on that. See modules/invoices.js::save().
    quote_id = Column(Integer, ForeignKey("quotes.id", ondelete="SET NULL"), nullable=True, index=True)
    status = Column(String(20), default="draft")        # {draft, sent, partial, paid, overdue}
    invoice_date = Column(String(10), default="")       # ISO YYYY-MM-DD
    due_date = Column(String(10), default="")           # ISO YYYY-MM-DD
    sent_date = Column(String(10), default="")          # ISO YYYY-MM-DD
    custom_name = Column(String(255), default="")       # names a project-less invoice; falls back to project.name on the printed doc (mirrors Quote.custom_name)
    paid_date = Column(String(10), default="")          # ISO YYYY-MM-DD, set when fully paid
    global_discount = Column(JSON, default=dict)        # {type: "none"|"percent"|"amount"|"target", value: float}
                                                        # "amount" = fixed dollars off, "target" = discount TO this
                                                        # total. "flat" is a legacy alias for "amount", still read
                                                        # by every consumer but no longer written by any UI.
    sections = Column(JSON, default=list)               # list[{id, label, items: list[InvoiceLineItem]}]
                                                        # InvoiceLineItem = {id, type, name, qty, unitPrice, adjustedPrice,
                                                        #                    rateType, productVariantId, feeId,
                                                        #                    serviceId|equipmentId|productId,
                                                        #                    sourceItemId: str,      (source = quote line id)
                                                        #                    sourceQuoteId: int,     (which quote that line is on)
                                                        #                    linkedQty: float}       (how much draws against it)
                                                        # sourceItemId/sourceQuoteId/linkedQty are set only on lines
                                                        # converted from a quote; a directly-billed line (added by
                                                        # hand, or generated from a project schedule) has none and is
                                                        # skipped by the invoicedQty rollback. Sections appended from
                                                        # another project carry `projectId` (see Quote.sections).
                                                        # See Quote.sections for the "fee" line type (edits unitPrice
                                                        # directly, never adjustedPrice).
    notes = Column(Text, default="")                    # internal free-form text; never rendered client-side
    # Client-facing terms & conditions. Same contract as Quote.terms.
    terms = Column(Text, default="")
    payments = Column(JSON, default=list)               # list[{id: str, date: str, amount: float, method: str, reference: str, notes: str}]
    activity = Column(JSON, default=list)               # same shape as Quote.activity
    # Remembered send recipients: {"to": [email...], "cc": [email...]}. null =
    # derive from the project's contacts. Same as Quote.send_recipients.
    send_recipients = Column(JSON, nullable=True)
    # Public-view credential. View-only (no accept/decline on invoices).
    # Same shape + security model as Quote.share_token; minted on POST.
    # NOT NULL because every Invoice has one (see create() in api.py).
    share_token = Column(String(64), nullable=False, unique=True, index=True)
    # ── QuickBooks Online two-way sync ──────────────────────────────────────
    # All qb_* columns are SERVER-AUTHORITATIVE: the sync engine
    # (backend/qbo_sync.py) writes them directly on the ORM row, and
    # _READONLY_COLS in backend/routes/api.py strips them from inbound client
    # writes so the frontend's debounced diff-sync PUTs can't clobber them.
    # They still surface (read-only) on GET as qbInvoiceId, etc.
    qb_invoice_id = Column(String(32), nullable=True, index=True)  # QB Invoice.Id once pushed
    qb_sync_token = Column(String(16), nullable=True)              # QB SyncToken (optimistic concurrency)
    qb_sync_status = Column(String(20), nullable=True)            # {null/not-synced, synced, error}
    qb_synced_at = Column(DateTime(timezone=True), nullable=True) # last successful push
    qb_last_error = Column(Text, nullable=True)                   # sanitized last failure message
    # Tax is computed by QuickBooks and pulled back here read-only so the app
    # total always matches QB. qb_total_amt is the QB tax-inclusive grand total.
    qb_tax_total = Column(Float, nullable=True)
    qb_total_amt = Column(Float, nullable=True)
    # Opaque change-signature captured by the frontend at the last successful
    # push. The invoice is "in sync" iff the frontend's live signature matches
    # this. Lets the UI surface "Update QuickBooks" only when something
    # QB-relevant actually changed (lines, dates, discount, customer info,
    # project name). Stored verbatim — server-authoritative (see _READONLY_COLS).
    qb_synced_signature = Column(Text, nullable=True)
    # ── Auto-receipt (QuickBooks-driven) ────────────────────────────────────
    # The background poller (backend/qbo_receipts.py) watches linked invoices
    # for the QuickBooks-side Balance reaching 0 (paid in full) and emails the
    # client a payment receipt — exactly once. These three columns are
    # SERVER-AUTHORITATIVE too (see _READONLY_COLS in routes/api.py).
    #   qb_balance           — last QB Balance the poller observed (0 = paid).
    #   receipt_email_status — idempotency + cache-and-retry state machine:
    #       null     no receipt warranted yet (invoice not paid in QB)
    #       pending  paid + queued, but the sender's Gmail was unavailable;
    #                retried every poll cycle until it sends (the owner's
    #                "cache the task until the connection is reestablished")
    #       sent     receipt emailed — set by BOTH the poller and the manual
    #                "Send Receipt" flow, so the two paths never double-send
    #       failed   a non-recoverable send error; retried next cycle too
    #   receipt_email_sent_at — when the receipt actually went out.
    qb_balance = Column(Float, nullable=True)
    receipt_email_status = Column(String(20), nullable=True)
    receipt_email_sent_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Equipment(Base):
    """A rentable inventory item. Two qty models in one row:
       1. Serialized inventory (`serialized=True`) — each physical unit tracked
          individually in `units`, `qty` is ignored and treated as len(units).
       2. Bulk inventory (`serialized=False`) — `units` is empty, `qty` is the
          stock count.
    `status` is the item-type's nominal status. Per-unit statuses live inside
    `units[i].status` and override the parent for serialized items."""
    __tablename__ = "equipment"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    category = Column(String(100), default="")           # top-level grouping, e.g. "Lighting"
    subcategory = Column(String(100), default="")        # e.g. "Moving Profile"
    manufacturer = Column(String(100), default="")
    model = Column(String(100), default="")
    serialized = Column(Boolean, default=False)          # True → use units[]; False → use qty
    qty = Column(Integer, default=0)                     # bulk count when not serialized
    vendor_company_id = Column(Integer, nullable=True)   # company.id — not a real FK (intentional: vendor links survive company deletes silently)
    rates = Column(JSON, default=dict)                   # {threeDay: float, week: float, month: float}
    status = Column(String(50), default="available")     # {available, rented, under-maintenance}
    location = Column(String(100), default="")           # warehouse / shelf
    weight = Column(Float, default=0)                    # pounds
    notes = Column(Text, default="")
    accessories = Column(JSON, default=list)             # list[{name: str, qty: int}] — bundled items (cables, mounts)
    default_container_id = Column(Integer, nullable=True) # container.id this ships in by default (not FK; nullable link)
    units = Column(JSON, default=list)                   # list[{id: int, serial: str, barcode: str,
                                                         #       purchaseDate: str, purchaseVendorId: int, purchaseCost: float,
                                                         #       status: "available"|"rented"|"under-maintenance",
                                                         #       maintenanceLogs: list[{id, date, issue, status, resolvedDate}]}]
    maintenance_logs = Column(JSON, default=list)        # list[{id, date, issue, status, resolvedDate}] —
                                                         # parent-level logs for NON-serialized equipment. For serialized
                                                         # items the per-unit logs live inside units[i].maintenanceLogs.
                                                         # Same shape either way; same status-roll-up semantics.
    # QuickBooks Online item id. Equipment lines are pushed against a single
    # generic "Equipment Rental" QB item (see backend/qbo_sync.py), so this is
    # usually unset for equipment — it exists for parity/future per-item sync.
    qb_item_id = Column(String(32), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Product(Base):
    """A sale-only catalog item (consumables, expendables — gel sheets, gaff
    tape, fog fluid). Differs from Equipment in that it isn't tracked through
    return cycles. Used as quote line items via `type: "product"`."""
    __tablename__ = "products"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    category = Column(String(100), default="")           # e.g. "Consumables", "Expendables", "Gel"
    unit = Column(String(50), default="ea")              # selling unit: "roll", "jug", "sheet", etc.
    unit_price = Column(Float, default=0)                # price per unit (what we charge)
    cost = Column(Float, default=0)                      # our cost per unit (for margin)
    # Pricing variants — alternative pricing structures for the same product
    # (e.g. Transportation: Local Delivery flat / Per Mile / Client Goods).
    # When non-empty, the quote/invoice pickers offer one row per variant and
    # unit_price/cost above are used only as the "Base price" fallback. Lines
    # snapshot the chosen variant's price and carry `productVariantId`; every
    # variant shares this product's single QB item (label rides in the line
    # name), so the QuickBooks sync engine is unaffected. Normalization/lookup
    # live in theme.js (LTP_productVariants / LTP_findProductVariant).
    variants = Column(JSON, default=list)                # list[{id: str, label: str, unitPrice: float, cost: float}]
    notes = Column(Text, default="")
    qb_item_id = Column(String(32), nullable=True, index=True)  # QB Item.Id (find-or-create cache)
    # Income account override for the QB item backing this product. null = use
    # the mapped default (settings.qboProductIncomeAccountId, falling back to
    # settings.qboIncomeAccountId). USER-EDITABLE — flows through the normal
    # CRUD, unlike the *_synced cache below.
    qb_income_account_id = Column(String(32), nullable=True)
    # Income account the QB item was last confirmed to carry. SERVER-AUTHORITATIVE
    # (see _READONLY_COLS in backend/routes/api.py) — written by the sync engine
    # when it creates or re-points the QB item; a mismatch with the resolved
    # desired account triggers a re-point on the next push (backend/qbo_sync.py).
    qb_income_account_synced = Column(String(32), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Fee(Base):
    """A miscellaneous billable line that is NOT equipment, a service, or a
    product — e.g. Lodging, Meal Expenses, Travel (air / ground / mileage),
    Consultation, Project Prep. Used as quote/invoice line items via
    `type: "fee"` (carrying `feeId` = this row's id).

    Unlike Product/Service catalog lines, `unit_price` here is only a DEFAULT
    amount. Fee prices vary per project, so the quote/invoice line edits its own
    `unitPrice` directly and NEVER sets `adjustedPrice` — a fee is therefore
    never counted as a line-item price adjustment (subtotal == adjusted for the
    fee). The catalog row still supplies the default amount, category, unit, and
    QuickBooks item/income-account mapping. A `feeId: null` line is a one-off
    "custom" fee typed straight into the builder with no catalog row."""
    __tablename__ = "fees"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    category = Column(String(100), default="")           # e.g. "Travel", "Lodging", "Production"
    unit = Column(String(50), default="flat")            # billing unit: "flat", "night", "day", "mile", "trip", "hour"
    unit_price = Column(Float, default=0)                # DEFAULT amount (per-project price is edited on the line)
    cost = Column(Float, default=0)                      # our cost when the fee is a pass-through (for margin)
    notes = Column(Text, default="")
    qb_item_id = Column(String(32), nullable=True, index=True)  # QB Item.Id (find-or-create cache)
    # Income account override for the QB item backing this fee. null = use the
    # mapped default (settings.qboFeeIncomeAccountId, falling back to
    # settings.qboIncomeAccountId). USER-EDITABLE (same semantics as Product).
    qb_income_account_id = Column(String(32), nullable=True)
    # Last-confirmed income account of the backing QB item. SERVER-AUTHORITATIVE
    # (see _READONLY_COLS in backend/routes/api.py) — written by the sync engine.
    qb_income_account_synced = Column(String(32), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Service(Base):
    """A labor rate card entry — e.g. "L1 — Lead Lighting Tech". Each role has
    four billing tiers (`day_rate`, `half_day`, `hourly_rate`, `ot_rate`) with
    paired cost values for margin calculation. Standard formula:
        hourly = day_rate / 10, ot = hourly * 1.5, half_day = day_rate / 2
    but any field can be overridden for non-standard rates."""
    __tablename__ = "services"

    id = Column(Integer, primary_key=True, index=True)
    role = Column(String(20), nullable=False, default="") # short code, e.g. "L1", "A1", "RIG", "PM"
    description = Column(String(255), default="")
    department = Column(String(50), default="")          # {Lighting, Audio, Video, Stage, Rigging, Production}
    day_rate = Column(Float, default=0)                  # billing: full day (5–10h)
    half_day = Column(Float, default=0)                  # billing: half day (0–5h)
    hourly_rate = Column(Float, default=0)               # billing: per hour
    ot_rate = Column(Float, default=0)                   # billing: overtime per hour (typically hourly_rate * 1.5)
    day_cost = Column(Float, default=0)                  # what we pay the crew member, per day
    half_day_cost = Column(Float, default=0)
    hourly_cost = Column(Float, default=0)
    ot_cost = Column(Float, default=0)
    notes = Column(Text, default="")
    qb_item_id = Column(String(32), nullable=True, index=True)  # QB Item.Id (find-or-create cache)
    # Income account override / synced cache for the QB item backing this
    # service — same semantics as the identically-named Product columns.
    qb_income_account_id = Column(String(32), nullable=True)      # user-editable override; null = mapped default
    qb_income_account_synced = Column(String(32), nullable=True)  # server-authoritative last-confirmed account
    # Which QuickBooks EXPENSE account a crew payout for this role posts to on a
    # vendor bill (backend/qbo_payouts.py). User-editable per-service override
    # (like qb_income_account_id), null = fall back to settings.qboPayoutExpenseAccountId.
    # No "_synced" sibling: a bill line references the account directly, so there
    # is no backing QB Item whose account we'd have to keep re-pointed.
    qb_expense_account_id = Column(String(32), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ClientRate(Base):
    """ONE client's negotiated override of ONE Service's rate card — e.g. "A1
    for FUMC is a reduced day rate, but carries a full 10-hour day minimum".

    Deliberately per-SERVICE, not per-client: a client with no row for a role
    bills the base Service card exactly as before. You add the roles that were
    actually negotiated, one at a time; nothing is toggled on catalog-wide.

    `client_type` mirrors Quote/Invoice — {company, contact} picks which FK is
    the billing party (some clients are individuals without a company). A
    project's client is always its company, so schedule/payout surfaces resolve
    with client_type="company".

    ── Rate columns (nullable = inherit) ───────────────────────────────────
    Every rate/cost column is NULLABLE and means "inherit the Service's value"
    when null, so a contract can restate just the day rate and let the half /
    hourly / OT tiers derive off it the same way the base card does. 0 is a REAL
    value (a genuinely free tier), never "inherit". When the day rate IS
    restated but a derived tier is not, the tier derives from the NEW day rate
    rather than inheriting the base card's absolute value — see
    theme.js::LTP_applyClientRate, which owns that resolution.

    The rate_* columns (what the CLIENT pays) and the *_cost columns (what WE
    pay the crew) are independent, so a discounted contract rate can carry its
    own custom payout — that's the margin column in the editor. Crew-level
    floors (Contact.min_day_cost) still apply on top of the resolved cost.

    ── Minimum charges ────────────────────────────────────────────────────
    `min_hours` / `min_cost_hours` are the minimum-CHARGE half of the feature: a
    day bills (or pays) as if at least that many hours were worked, so a 4-hour
    call against a 10-hour minimum bills the full adjusted day rate instead of
    the half-day rate. Hours worked beyond the minimum bill normally, and
    meal-penalty hours stack ON TOP of the minimum (the minimum floors the
    non-penalty hours only). 0 = no minimum. Bill and pay minimums are separate
    numbers so a 10-hour client minimum doesn't silently become a 10-hour payout.
    Engine: theme.js::LTP_calcDayLabor.

    ── Foreign keys ───────────────────────────────────────────────────────
    All three FKs CASCADE (the exception to the app-wide SET NULL, shared with
    Allocation): an override has no meaning without both its client and its
    service — an orphan row would silently match nobody forever."""
    __tablename__ = "client_rates"

    id = Column(Integer, primary_key=True, index=True)
    client_type = Column(String(20), default="company")  # {company, contact}
    company_id = Column(Integer, ForeignKey("companies.id", ondelete="CASCADE"), nullable=True, index=True)
    client_contact_id = Column(Integer, ForeignKey("contacts.id", ondelete="CASCADE"), nullable=True, index=True)
    service_id = Column(Integer, ForeignKey("services.id", ondelete="CASCADE"), nullable=True, index=True)
    label = Column(String(100), default="")              # optional contract name, e.g. "FUMC A1 agreement"
    # Billing overrides — null = inherit the Service's value (see class docstring).
    day_rate = Column(Float, nullable=True)
    half_day = Column(Float, nullable=True)
    hourly_rate = Column(Float, nullable=True)
    ot_rate = Column(Float, nullable=True)
    # Payout overrides — the margin side of the same contract line.
    day_cost = Column(Float, nullable=True)
    half_day_cost = Column(Float, nullable=True)
    hourly_cost = Column(Float, nullable=True)
    ot_cost = Column(Float, nullable=True)
    # Minimum billable / payable hours per day. 0 = no minimum.
    min_hours = Column(Float, default=0)
    min_cost_hours = Column(Float, default=0)
    # False parks a negotiated rate without deleting it (history stays legible);
    # inactive rows are ignored by every resolver.
    active = Column(Boolean, default=True)
    notes = Column(Text, default="")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Allocation(Base):
    """A booking of equipment to a project for a date range. The lifecycle is:
       reserved → allocated → checked-out → returned.
    `under-maintenance` is a sideband state for fixing things mid-booking.
    Cascade-deletes with both parents because an orphan allocation has no
    meaning."""
    __tablename__ = "allocations"

    id = Column(Integer, primary_key=True, index=True)
    equipment_id = Column(Integer, ForeignKey("equipment.id", ondelete="CASCADE"), nullable=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True)
    qty = Column(Integer, default=1)                     # how many units of the equipment are allocated
    start_date = Column(String(10), default="")          # ISO YYYY-MM-DD
    end_date = Column(String(10), default="")            # ISO YYYY-MM-DD
    state = Column(String(30), default="reserved")       # {reserved, allocated, checked-out, returned, under-maintenance}
    notes = Column(Text, default="")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Container(Base):
    """A road case, pelican, soft bag, or crate that ships equipment. May or
    may not have its own rental rate (some are bundled into the equipment they
    carry — `rental_rate=None`). `default_for_equipment` makes a container
    auto-attach when its equipment is allocated."""
    __tablename__ = "containers"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    type = Column(String(100), default="")               # "Road Case", "Pelican", "Soft Bag", "Crate", etc.
    manufacturer = Column(String(100), default="")
    model = Column(String(100), default="")
    serialized = Column(Boolean, default=False)
    qty = Column(Integer, default=1)
    dimensions = Column(JSON, default=dict)              # {l: float, w: float, h: float} — inches
    weight_empty = Column(Float, default=0)              # pounds, unloaded
    color = Column(String(50), default="")
    notes = Column(Text, default="")
    default_for_equipment = Column(JSON, default=list)   # list[int] — equipment.id list this container ships with
    can_nest_ids = Column(JSON, default=list)            # list[int] — other container ids that physically fit inside this one
    optional = Column(Boolean, default=False)            # True = bring only when explicitly added; False = always included
    rates = Column(JSON, default=dict)                   # {threeDay, week, month} — same shape as Equipment.rates
    rental_rate = Column(Float, nullable=True)           # legacy: single threeDay rate; None = bundled into the equipment rate
    status = Column(String(50), default="available")     # {available, in-use, under-maintenance}
    maintenance_logs = Column(JSON, default=list)        # parent-level logs for NON-serialized containers.
                                                         # list[{id, date, issue, status, resolvedDate}] — same shape as Equipment.maintenance_logs.
    units = Column(JSON, default=list)                   # list[{id, serial, barcode, purchaseDate, purchaseVendorId,
                                                         #       purchaseCost, status, maintenanceLogs: [...]}] —
                                                         # per-unit records for SERIALIZED containers, mirroring
                                                         # Equipment.units. Each unit holds its own maintenanceLogs.
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Kit(Base):
    """A pre-built rental package — a named combo of equipment + containers
    that can be allocated as a single unit. If `auto_rate=True`, the rate is
    computed from item sums at render time and `rates` is ignored."""
    __tablename__ = "kits"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    category = Column(String(100), default="")           # grouping for the kit picker, e.g. "Lighting", "Audio"
    description = Column(Text, default="")
    items = Column(JSON, default=list)                   # list[{equipmentId: int, qty: int}]
    containers = Column(JSON, default=list)              # list[{containerId: int, qty: int}] — explicit overrides; otherwise container defaults apply
    rates = Column(JSON, default=dict)                   # {threeDay, week, month} — ignored when auto_rate=True
    auto_rate = Column(Boolean, default=True)            # True → compute from items each render; False → use `rates` literally
    notes = Column(Text, default="")
    status = Column(String(50), default="active")        # {active, inactive}
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Settings(Base):
    """Singleton row (id=1). `data` is the entire settings blob from the
    frontend (company info, tagColors, email templates, defaults, etc.).
    PUT /api/settings shallow-merges incoming top-level keys into existing
    data so partial writes don't clobber unrelated settings — see
    backend/routes/api.py:update_settings."""
    __tablename__ = "settings"

    id = Column(Integer, primary_key=True, default=1)
    data = Column(JSON, nullable=False, default=dict)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class User(Base):
    """An app user. Identity (`name`, `email`, `picture_url`) is sourced from
    Google and refreshed on every login — never edited inside the app. The
    `google_sub` column is Google's stable subject identifier; we key off it
    instead of email so a user changing their primary email keeps the same
    row. `role` ∈ {member, admin}. The first user ever created gets admin;
    everyone after gets member.

    Gmail send (columns below) is per-user via OAuth scope
    `https://www.googleapis.com/auth/gmail.send`. Refresh + access tokens
    are stored as Fernet ciphertext (see backend/crypto.py). All four gmail_*
    columns are nullable because a user may exist (have signed in) BEFORE
    the scope was granted — null = user hasn't connected Gmail yet, banner
    in the UI prompts them to.

    `title` and `phone` are admin-edited per user; they feed the workspace
    email signature template via `{{userTitle}}` / `{{userPhone}}`."""
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    google_sub = Column(String(100), unique=True, nullable=False, index=True)  # Google's `sub` claim
    email = Column(String(255), unique=True, nullable=False, index=True)
    name = Column(String(255), nullable=False, default="")
    # `picture_url` is Google's lh*.googleusercontent.com URL, refreshed each
    # login. Those URLs rot / rate-limit when hotlinked, so we ALSO cache the
    # image bytes in the columns below and serve our own stable copy (see
    # cached_photo_path + GET /api/users/photo/{token}). picture_url is kept as
    # the fetch source + a fallback until the first cache succeeds.
    picture_url = Column(Text, default="")
    # Cached avatar. photo_data is deferred() so the (potentially tens-of-KB)
    # bytes are NOT loaded by the many ordinary `select(User)` queries — only the
    # photo-serve route explicitly undefers it. photo_token is the opaque public
    # id in the serve URL (so avatars aren't enumerable by user id, and emails
    # don't embed internal ids). photo_updated_at doubles as the `?v=` cache-
    # buster so a re-pull invalidates client/email caches. photo_refresh_requested
    # is the admin "re-pull on next sign-in" flag (Team Members settings).
    photo_token = Column(String(64), unique=True, index=True, nullable=True)
    photo_data = deferred(Column(LargeBinary, nullable=True))
    photo_content_type = Column(String(64), nullable=True)
    photo_updated_at = Column(DateTime(timezone=True), nullable=True)
    photo_refresh_requested = Column(Boolean, nullable=False, server_default=false(), default=False)
    role = Column(String(20), default="member", nullable=False)                # {member, admin}
    last_login = Column(DateTime(timezone=True), nullable=True)
    # Gmail OAuth token cache (Fernet ciphertext for the two token columns)
    gmail_refresh_token = Column(Text, nullable=True)
    gmail_access_token = Column(Text, nullable=True)
    gmail_token_expires_at = Column(DateTime(timezone=True), nullable=True)
    # Space-separated scope list as granted by Google on the last token exchange.
    # Used to detect whether the user has gmail.send (for the Send button gate)
    # and to drive re-consent when we add new scopes in the future.
    gmail_granted_scopes = Column(Text, nullable=True)
    # Admin-edited per-user profile fields used by the email signature template.
    title = Column(String(255), nullable=True)
    phone = Column(String(50), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    def cached_photo_path(self) -> str | None:
        """Relative URL for this user's app-served cached avatar, or None when
        nothing is cached yet (caller falls back to picture_url). The
        photo_updated_at timestamp is folded in as `?v=` so a re-pull busts any
        client/email image cache. Reads only light columns — never touches the
        deferred photo_data blob."""
        if self.photo_token and self.photo_updated_at:
            return f"/api/users/photo/{self.photo_token}?v={int(self.photo_updated_at.timestamp())}"
        return None


class EmailRecipient(Base):
    """One row per (send, recipient_email, role) — created when an email is
    sent through /api/email/send. Each row carries a per-recipient
    `tracking_token` embedded in that recipient's copy of the view URL.
    When the recipient opens the URL, the backend resolves the token and
    bumps `open_count` / timestamps here AND writes a `recipient_opened`
    activity entry on the parent entity.

    Used for: knowing WHO read the quote/invoice vs anonymous link
    sharing. The bare `share_token` URL still works for anonymous reads
    (Preview button, copy-link sharing) — those produce `client_viewed`
    entries with no recipient attribution.

    Why a separate table and not JSON-on-activity:
      - `tracking_token` needs a unique index for O(1) lookup at view time
      - `open_count`/`last_opened_at` mutate over time; activity entries
        are immutable audit records
      - "all recipients of this quote, with status" is naturally a query
        against this table

    `share_token` is denormalized from the parent quote/invoice for
    audit — if the parent's share_token is ever rotated (out of scope for
    v1), historical recipient rows remember the token the recipient
    actually got."""
    __tablename__ = "email_recipients"

    id = Column(Integer, primary_key=True, index=True)
    entity_type = Column(String(20), nullable=False)              # {"quote", "invoice"}
    entity_id = Column(Integer, nullable=False, index=True)
    share_token = Column(String(64), nullable=False, index=True)  # parent's share_token at send time
    recipient_email = Column(String(255), nullable=False)
    recipient_role = Column(String(4), nullable=False)            # {"to", "cc"}
    tracking_token = Column(String(64), nullable=False, unique=True, index=True)
    sent_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    sent_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    # Gmail's message id from the send response (~16 hex chars). Lets ops
    # debug delivery questions against the sender's Gmail Sent folder.
    gmail_message_id = Column(String(64), nullable=True)
    # Open tracking — populated by /api/view/{token}?r=<tracking_token>
    first_opened_at = Column(DateTime(timezone=True), nullable=True)
    last_opened_at = Column(DateTime(timezone=True), nullable=True)
    open_count = Column(Integer, nullable=False, default=0)
    # PDF download via the recipient-tagged URL (separate from view).
    pdf_downloaded_at = Column(DateTime(timezone=True), nullable=True)


class CrewRequest(Base):
    """A request sent to a crew member asking them to accept or decline a set
    of shift positions on a project. The crew member responds from a tokenized
    PUBLIC landing page (#/crew/{token}) with no login — `token` IS the
    credential, exactly like Quote.share_token / PdfArchive.token. Anyone with
    the token can hit /api/crew/{token} and accept/decline.

    One row per (crew member × request group). By default a request covers
    EVERY position the crew member is penciled into on the project, but the
    producer can split a project into multiple requests — each covering a
    subset of `position_ids` — so one person can have several requests for the
    same project (accept some shifts, decline others). Accept/decline is
    per-REQUEST; finer granularity comes from how the producer groups
    positions into requests at send time.

    Positions themselves live in Project.schedule[].positions[] (JSON). This
    table references them by their string `id`; the backend updates each
    referenced position's `status` on the project row when the request is
    sent / answered / withdrawn. The state machine (mirrors the POSITION enum
    in components/status-enums.js):

        send     → positions open      → requested ; status pending
        accept   → positions requested → accepted  ; status accepted
        decline  → positions requested → declined  ; status declined
        withdraw → positions requested → open      ; status withdrawn

    Accept lands the position at `accepted`, NOT `confirmed`: the producer
    still confirms accepted → confirmed manually in the Labor module, so the
    existing two-step hire flow is preserved. Decline leaves the crew member
    attached to the (now `declined`) position for the producer to handle —
    nothing reopens automatically.

    One row can also record a booking that never used any of that: a DIRECT
    BOOK (`silent=True`), for the crew member already agreed with by phone or
    text. It skips the whole ask — no email, no landing page, no crew action —
    and lands as `status='accepted'` with its positions straight at
    `confirmed`:

        book direct → positions open → confirmed  ; status accepted, silent

    `silent` is what separates the two on read: everything downstream
    (integrity reconcile, the producer list, the Payouts pay snapshot) treats a
    direct book exactly like an accepted-then-confirmed request, but the Labor
    UI badges it "Booked directly" so a booking the crew member was never
    emailed about is never mistaken for one they answered.
    """
    __tablename__ = "crew_requests"

    id = Column(Integer, primary_key=True, index=True)
    # Opaque public credential — minted server-side on send (see
    # backend/routes/crew.py), never accepted from client input. ~256 bits via
    # secrets.token_urlsafe(32). Same security model as Quote.share_token: it
    # is NEVER echoed on the public /api/crew/{token} payload (the holder
    # already has it in their URL) and is read-only on every producer write.
    token = Column(String(64), nullable=False, unique=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True)
    contact_id = Column(Integer, ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True, index=True)
    position_ids = Column(JSON, default=list)            # list[str] — schedule position ids this request covers
    status = Column(String(20), default="pending")       # {pending, accepted, declined, withdrawn}
    # Direct book — recorded by the producer, never sent to the crew member.
    # Server-set only (routes/crew.py send with {"silent": true}); the crew
    # member has no way to reach it, since the whole point is that no token
    # ever left the building.
    silent = Column(Boolean, nullable=False, server_default=false(), default=False)
    comment = Column(Text, default="")                   # optional note the crew member leaves on response
    sent_at = Column(DateTime(timezone=True), server_default=func.now())
    responded_at = Column(DateTime(timezone=True), nullable=True)  # set when the crew member accepts/declines
    sent_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    # Non-repudiation audit for the crew member's response. Internal-only —
    # never surfaced on the public payload (mirrors the IP/UA capture on the
    # quote accept/decline activity entries, SECURITY_REVIEW.md H12).
    respondent_ip = Column(String(64), nullable=True)
    respondent_ua = Column(String(300), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class PdfArchive(Base):
    """A snapshot of a generated Quote/Invoice PDF. Each generation creates
    one row — historical iterations stay downloadable from the entity's
    activity feed until the row is deleted.

    The `token` column IS the download URL credential — clients hit
    GET /pdf/{token} (unauthenticated) and get the bytes. ~256 bits of
    entropy via `secrets.token_urlsafe(32)`. Treat as a non-guessable URL,
    not a long-lived auth token: anyone with the link can download.

    `entity_type` is "quote" or "invoice". We intentionally do NOT use a
    FK to quotes/invoices because we want the archive to outlive the
    entity (audit/recall). `entity_id` is just a denormalized lookup hint."""
    __tablename__ = "pdf_archives"

    token = Column(String(64), primary_key=True)
    entity_type = Column(String(20), nullable=False)             # {"quote", "invoice"}
    entity_id = Column(Integer, nullable=False, index=True)
    filename = Column(String(255), nullable=False)               # e.g. "Q-2026-001.pdf"
    pdf_bytes = Column(LargeBinary, nullable=False)              # the rendered PDF
    bytes_size = Column(Integer, nullable=False)                 # cached len(pdf_bytes) for quick reporting
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    created_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class Session(Base):
    """An active login session. The primary key IS the opaque cookie value —
    a 64-char URL-safe token. Each request looks up the cookie value here to
    find the User. Sessions live ~30 days; expired rows are filtered out at
    read time (a sweeper job can purge them later). Deleting a row revokes
    the session immediately (used for logout and future admin actions)."""
    __tablename__ = "sessions"

    id = Column(String(64), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    expires_at = Column(DateTime(timezone=True), nullable=False, index=True)
    # Last request that used this session — drives the idle timeout in
    # auth_deps (SECURITY_REVIEW.md L2). Nullable for rows created before the
    # column existed; populated on next use.
    last_used_at = Column(DateTime(timezone=True), nullable=True)


class PushSubscription(Base):
    """A browser Web Push subscription for one internal user's device (iOS
    home-screen PWA, Android, or desktop). One row per device endpoint — a user
    with two phones has two rows. Created from the Settings "Notifications"
    toggle (POST /api/push/subscribe) and pruned automatically when the push
    service reports the endpoint dead (404/410) at send time — see
    backend/webpush.py. Nothing secret at rest: endpoint + p256dh + auth are the
    public halves the Web Push protocol needs to send TO this device; they grant
    no read access to anything. CASCADE on user_id mirrors Session so deleting a
    user cleans up their subscriptions."""
    __tablename__ = "push_subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    # Push endpoints are long provider URLs (Apple / FCM) and unique per device.
    endpoint = Column(Text, nullable=False, unique=True, index=True)
    p256dh = Column(Text, nullable=False)     # client public key (base64url)
    auth = Column(Text, nullable=False)       # client auth secret (base64url)
    ua = Column(String(300), nullable=True)   # user-agent at subscribe time (debugging only)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class QboConnection(Base):
    """The single company-wide QuickBooks Online connection (singleton row,
    id=1). Unlike Gmail tokens — which are PER-USER because the email is sent
    "from" the signed-in person — there is exactly ONE QuickBooks company
    (one realm_id) for this business, and every admin pushing an invoice must
    hit that same company with the same connection. So the tokens live here,
    once, not on `users`.

    Both token columns are Fernet ciphertext (see backend/crypto.py), same
    at-rest protection as the Gmail tokens. The refresh token is the high-value
    secret (~100-day life, full accounting access). This table is NEVER exposed
    through the CRUD factory and no endpoint returns the token columns — the
    only client-facing surface is GET /api/qbo/status (booleans + masked
    metadata only).

    `environment` selects the API host: "sandbox" → sandbox-quickbooks.api...,
    "production" → quickbooks.api... A sandbox connection physically cannot
    write to a production company (different host AND different realm)."""
    __tablename__ = "qbo_connection"

    id = Column(Integer, primary_key=True, default=1)        # singleton: always 1
    realm_id = Column(String(64), nullable=False)            # QB company id; scopes every API URL
    access_token_enc = Column(Text, nullable=False)          # Fernet ciphertext
    refresh_token_enc = Column(Text, nullable=False)         # Fernet ciphertext
    access_token_expires_at = Column(DateTime(timezone=True), nullable=False)
    refresh_token_expires_at = Column(DateTime(timezone=True), nullable=True)  # ~100 days; for proactive warn
    environment = Column(String(10), nullable=False, default="sandbox")        # {sandbox, production}
    connected_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    # Cached list of the QB company's active Income accounts, refreshed ONLY by
    # an explicit admin action (POST /api/qbo/accounts/refresh) — the list is
    # near-static, so no background sync. Shape: list[{id: str, name: str}].
    # Lives on the connection row (not in settings.data) so a stale Settings-page
    # draft save can never clobber a fresh refresh, and disconnect drops it.
    # Surfaced via GET /api/qbo/status as incomeAccounts / incomeAccountsUpdatedAt.
    income_accounts = Column(JSON, nullable=True)
    income_accounts_updated_at = Column(DateTime(timezone=True), nullable=True)
    # Cached active Expense/COGS accounts and Accounts-Payable accounts for the
    # payout vendor-bill mapping — same admin-refresh-only contract and shape
    # (list[{id, name, type}]) as income_accounts. Surfaced via GET /api/qbo/status
    # as expenseAccounts / apAccounts, populated by POST /api/qbo/accounts/refresh.
    expense_accounts = Column(JSON, nullable=True)
    ap_accounts = Column(JSON, nullable=True)
    expense_accounts_updated_at = Column(DateTime(timezone=True), nullable=True)
    # Last connection-level QuickBooks error (auth/reconnect/API) captured from a
    # background context that has no entity to stamp — chiefly the auto-receipt
    # poller (backend/qbo_receipts.py) aborting a cycle. Surfaced via
    # GET /api/qbo/status and shown in Settings → Error Log; cleared on the next
    # clean poll cycle or a successful reconnect. Per-invoice sync failures are
    # NOT recorded here — those stamp `qbo_sync_failed` on the invoice itself.
    last_error = Column(Text, nullable=True)
    last_error_at = Column(DateTime(timezone=True), nullable=True)
    connected_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class PayoutBill(Base):
    """One crew payout exported to QuickBooks as a Vendor Bill — the accounts-
    PAYABLE mirror of an Invoice, keyed on (crew member, pay period). This is the
    idempotency anchor for the fan-in export (many payout days -> one Bill): the
    unique (contact_id, period_start, period_end) constraint plus the deterministic
    DocNumber `PAY-{contactId}-{periodIndex}` guarantee re-running the export
    updates the same Bill instead of duplicating it.

    SERVER-AUTHORITATIVE, like QboConnection: never exposed through the CRUD
    factory, never client-writable. Written only by backend/qbo_payouts.py, whose
    money comes from re-deriving Project.schedule snapshots (backend/payouts.py) —
    never a client-submitted amount.

    The qb_* columns mirror Invoice's sync block (id/token/status/error) so the
    push path reuses the invoice create-or-update + SyncToken/DocNumber recovery.
    `line_signature` is a hash of the billed lines; an unchanged signature on a
    re-push short-circuits to a no-op instead of round-tripping to QuickBooks."""
    __tablename__ = "payout_bills"
    __table_args__ = (UniqueConstraint("contact_id", "period_start", "period_end",
                                       name="uq_payout_bill_contact_period"),)

    id = Column(Integer, primary_key=True, index=True)
    contact_id = Column(Integer, ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True, index=True)
    period_start = Column(String(10), nullable=False)   # ISO YYYY-MM-DD, inclusive
    period_end = Column(String(10), nullable=False)     # ISO YYYY-MM-DD, inclusive
    period_index = Column(Integer, nullable=True)       # pay-period index (DocNumber convenience only)
    doc_number = Column(String(21), nullable=True)      # PAY-{yy}-{n} QB DocNumber (<=21)
    amount = Column(Float, nullable=True)               # total billed (sum of lines), for display/reconciliation
    line_signature = Column(Text, nullable=True)        # hash of billed lines -> re-push no-op detection
    qb_bill_id = Column(String(32), nullable=True, index=True)  # QB Bill.Id
    qb_sync_token = Column(String(16), nullable=True)   # QB SyncToken (optimistic concurrency)
    qb_sync_status = Column(String(20), nullable=True)  # {null, synced, error}
    qb_synced_at = Column(DateTime(timezone=True), nullable=True)
    qb_last_error = Column(Text, nullable=True)
    # Payment state, tracked by the bill-payment poller (backend/qbo_bill_poll.py)
    # exactly like Invoice: qb_total_amt is QuickBooks' returned Bill total (also
    # cross-checked against `amount` at push time — a mismatch is stamped);
    # qb_balance is the last observed outstanding balance (0 = paid); qb_paid_at
    # is set once Balance hits 0 — non-null means the bill is PAID (polling stops,
    # and its days are protected from silent re-pricing).
    qb_total_amt = Column(Float, nullable=True)
    qb_balance = Column(Float, nullable=True)
    qb_paid_at = Column(DateTime(timezone=True), nullable=True)
    # When the bill-payment poller last GOT this bill from QuickBooks. The poller
    # checks least-recently-checked first (NULLs — never checked — win), so a large
    # persistent unpaid backlog can never starve a newer bill behind it.
    qb_last_checked_at = Column(DateTime(timezone=True), nullable=True)
    activity = Column(JSON, nullable=True)              # append-only stamps (created/updated/failed/paid)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class PayoutBillLine(Base):
    """Ledger of every crew payout day that has been billed — the physical
    double-pay guard. The unique (contact_id, project_id, date) constraint makes
    it IMPOSSIBLE to bill the same person's project-day on two different pay
    periods, even if the pay-period anchor/length is reconfigured after bills
    exist. Rows are replaced wholesale each time a bill is (re)pushed.

    project_id is a plain int (not an enforced FK) so a line survives the deletion
    of its project — the historical bill must remain a faithful record."""
    __tablename__ = "payout_bill_lines"
    __table_args__ = (UniqueConstraint("contact_id", "project_id", "date",
                                       name="uq_payout_bill_line_day"),)

    id = Column(Integer, primary_key=True, index=True)
    payout_bill_id = Column(Integer, ForeignKey("payout_bills.id", ondelete="CASCADE"), nullable=False, index=True)
    contact_id = Column(Integer, nullable=False, index=True)
    project_id = Column(Integer, nullable=True)
    date = Column(String(10), nullable=False)           # ISO YYYY-MM-DD
    amount = Column(Float, nullable=True)
    tier = Column(String(20), nullable=True)
