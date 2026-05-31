from sqlalchemy import Column, Integer, String, Boolean, Float, Text, DateTime, JSON, ForeignKey, LargeBinary
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
    address = Column(Text, default="")                   # multi-line street address
    website = Column(String(255), default="")
    logo = Column(Text, default="")                      # URL or data:image base64
    notes = Column(Text, default="")
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
    company_ids = Column(JSON, default=list)             # list[int] — company.id references
    is_crew = Column(Boolean, default=False)
    crew_roles = Column(JSON, default=list)              # list[str] — role codes from LTP_DATA_SETTINGS.crewRoleOptions, e.g. ["L1","L3","RIG"]
    crew_departments = Column(JSON, default=list)        # list[str] — dept names, e.g. ["Lighting","Rigging"]
    crew_notes = Column(Text, default="")
    crew_status = Column(String(20), default="active")   # {active, inactive}
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
    company_id = Column(Integer, ForeignKey("companies.id", ondelete="SET NULL"), nullable=True)
    category = Column(String(100), default="")           # {rental, labor, service, full-production}
    status = Column(String(50), default="planning")      # {upcoming, in-progress, completed, cancelled}
    start_date = Column(String(10), default="")          # ISO YYYY-MM-DD
    end_date = Column(String(10), default="")            # ISO YYYY-MM-DD
    venue = Column(String(255), default="")
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
                                                         #       positions: list[{id, role, serviceId, crewId, status}]}]
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
    company_id = Column(Integer, ForeignKey("companies.id", ondelete="SET NULL"), nullable=True)
    client_contact_id = Column(Integer, ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
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
                                                        #   deliveredQty: float, invoicedQty: float,
                                                        #   equipmentId|serviceId|productId: int|null }
    notes = Column(Text, default="")                    # free-form text shown on the printed quote
    activity = Column(JSON, default=list)               # list[{id: str, date: str, time: str, type: str, user: str, message: str, changes: list[{cat, detail}]|null}]
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
    company_id = Column(Integer, ForeignKey("companies.id", ondelete="SET NULL"), nullable=True)
    client_contact_id = Column(Integer, ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    quote_id = Column(Integer, ForeignKey("quotes.id", ondelete="SET NULL"), nullable=True)
    status = Column(String(20), default="draft")        # {draft, sent, partial, paid, overdue}
    invoice_date = Column(String(10), default="")       # ISO YYYY-MM-DD
    due_date = Column(String(10), default="")           # ISO YYYY-MM-DD
    sent_date = Column(String(10), default="")          # ISO YYYY-MM-DD
    paid_date = Column(String(10), default="")          # ISO YYYY-MM-DD, set when fully paid
    global_discount = Column(JSON, default=dict)        # {type: "none"|"percent"|"flat", value: float}
    sections = Column(JSON, default=list)               # list[{id, label, items: list[InvoiceLineItem]}]
                                                        # InvoiceLineItem = {id, type, name, qty, unitPrice, adjustedPrice,
                                                        #                    rateType, serviceId|equipmentId|productId,
                                                        #                    sourceItemId: str}  (source = quote line id)
    notes = Column(Text, default="")
    payments = Column(JSON, default=list)               # list[{id: str, date: str, amount: float, method: str, reference: str, notes: str}]
    activity = Column(JSON, default=list)               # same shape as Quote.activity
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
    notes = Column(Text, default="")
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
    equipment_id = Column(Integer, ForeignKey("equipment.id", ondelete="CASCADE"), nullable=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=True)
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
    maintenance_logs = Column(JSON, default=list)        # list[{id, date, issue, status, resolvedDate}] — same shape as Equipment.units[i].maintenanceLogs
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
    everyone after gets member."""
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    google_sub = Column(String(100), unique=True, nullable=False, index=True)  # Google's `sub` claim
    email = Column(String(255), unique=True, nullable=False, index=True)
    name = Column(String(255), nullable=False, default="")
    picture_url = Column(Text, default="")
    role = Column(String(20), default="member", nullable=False)                # {member, admin}
    last_login = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


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
