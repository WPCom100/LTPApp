from sqlalchemy import Column, Integer, String, Boolean, Float, Text, DateTime, JSON, ForeignKey, LargeBinary, UniqueConstraint
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
    status = Column(String(20), default="draft")        # {draft, sent, accepted, declined, converted}
    sent_date = Column(String(10), default="")          # ISO YYYY-MM-DD
    custom_start_date = Column(String(10), default="") # overrides project's startDate on the printed quote
    custom_end_date = Column(String(10), default="")   # overrides project's endDate on the printed quote
    custom_name = Column(String(255), default="")      # overrides project.name on the printed quote
    global_discount = Column(JSON, default=dict)        # {type: "none"|"percent"|"flat", value: float}
    sections = Column(JSON, default=list)               # list[{id: str, label: str, items: list[QuoteLineItem]}]
                                                        # QuoteLineItem = {
                                                        #   id: str, type: "equipment"|"service"|"product"|"note",
                                                        #   name: str, qty: float, unitPrice: float, adjustedPrice: float|null,
                                                        #   rateType: "day"|"halfDay"|"hourly"|"ot"  (services only),
                                                        #   productVariantId: str|null  (products only — chosen pricing variant),
                                                        #   deliveredQty: float, invoicedQty: float,
                                                        #   equipmentId|serviceId|productId: int|null }
    notes = Column(Text, default="")                    # free-form text shown on the printed quote
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
    quote_id = Column(Integer, ForeignKey("quotes.id", ondelete="SET NULL"), nullable=True, index=True)
    status = Column(String(20), default="draft")        # {draft, sent, partial, paid, overdue}
    invoice_date = Column(String(10), default="")       # ISO YYYY-MM-DD
    due_date = Column(String(10), default="")           # ISO YYYY-MM-DD
    sent_date = Column(String(10), default="")          # ISO YYYY-MM-DD
    custom_name = Column(String(255), default="")       # names a project-less invoice; falls back to project.name on the printed doc (mirrors Quote.custom_name)
    paid_date = Column(String(10), default="")          # ISO YYYY-MM-DD, set when fully paid
    global_discount = Column(JSON, default=dict)        # {type: "none"|"percent"|"flat", value: float}
    sections = Column(JSON, default=list)               # list[{id, label, items: list[InvoiceLineItem]}]
                                                        # InvoiceLineItem = {id, type, name, qty, unitPrice, adjustedPrice,
                                                        #                    rateType, productVariantId,
                                                        #                    serviceId|equipmentId|productId,
                                                        #                    sourceItemId: str}  (source = quote line id)
    notes = Column(Text, default="")
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
    picture_url = Column(Text, default="")
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
