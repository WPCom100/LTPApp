from sqlalchemy import Column, Integer, String, Boolean, Float, Text, DateTime, JSON, ForeignKey
from sqlalchemy.sql import func
from backend.database import Base


# Column names are snake_case; backend/routes/api.py converts to camelCase
# on the way out and back on the way in, so frontend keeps its camelCase keys.
# Anything nested (rates, sections, schedule, units, payments, notes-arrays, etc.)
# goes in a JSON column verbatim — the converter only touches top-level keys.


class Company(Base):
    __tablename__ = "companies"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    is_client = Column(Boolean, default=False)
    is_vendor = Column(Boolean, default=False)
    status = Column(String(50), default="active")
    address = Column(Text, default="")
    website = Column(String(255), default="")
    logo = Column(Text, default="")
    notes = Column(Text, default="")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Contact(Base):
    __tablename__ = "contacts"

    id = Column(Integer, primary_key=True, index=True)
    first_name = Column(String(100), nullable=False, default="")
    last_name = Column(String(100), nullable=False, default="")
    email = Column(String(255), default="")
    phone = Column(String(50), default="")
    role = Column(String(100), default="")
    company_ids = Column(JSON, default=list)
    is_crew = Column(Boolean, default=False)
    crew_roles = Column(JSON, default=list)
    crew_departments = Column(JSON, default=list)
    crew_notes = Column(Text, default="")
    crew_status = Column(String(20), default="active")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Project(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    company_id = Column(Integer, ForeignKey("companies.id", ondelete="SET NULL"), nullable=True)
    category = Column(String(100), default="")
    status = Column(String(50), default="planning")
    start_date = Column(String(10), default="")
    end_date = Column(String(10), default="")
    venue = Column(String(255), default="")
    # budget is a category breakdown: {lighting, labor, rentals, misc} — not a scalar.
    # See modules/crm-projects.js:270 where the form saves the object literal.
    budget = Column(JSON, default=dict)
    contact_ids = Column(JSON, default=list)
    notes = Column(JSON, default=list)        # array of {id, date, author, text, linkedMeetingId}
    meetings = Column(JSON, default=list)
    schedule = Column(JSON, default=list)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Quote(Base):
    __tablename__ = "quotes"

    id = Column(Integer, primary_key=True, index=True)
    client_type = Column(String(20), default="company")
    company_id = Column(Integer, ForeignKey("companies.id", ondelete="SET NULL"), nullable=True)
    client_contact_id = Column(Integer, ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    status = Column(String(20), default="draft")
    sent_date = Column(String(10), default="")
    custom_start_date = Column(String(10), default="")
    custom_end_date = Column(String(10), default="")
    custom_name = Column(String(255), default="")
    global_discount = Column(JSON, default=dict)
    sections = Column(JSON, default=list)
    notes = Column(Text, default="")
    activity = Column(JSON, default=list)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Invoice(Base):
    __tablename__ = "invoices"

    id = Column(Integer, primary_key=True, index=True)
    client_type = Column(String(20), default="company")
    company_id = Column(Integer, ForeignKey("companies.id", ondelete="SET NULL"), nullable=True)
    client_contact_id = Column(Integer, ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    quote_id = Column(Integer, ForeignKey("quotes.id", ondelete="SET NULL"), nullable=True)
    status = Column(String(20), default="draft")
    invoice_date = Column(String(10), default="")
    due_date = Column(String(10), default="")
    sent_date = Column(String(10), default="")
    paid_date = Column(String(10), default="")
    global_discount = Column(JSON, default=dict)
    sections = Column(JSON, default=list)
    notes = Column(Text, default="")
    payments = Column(JSON, default=list)
    activity = Column(JSON, default=list)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Equipment(Base):
    __tablename__ = "equipment"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    category = Column(String(100), default="")
    subcategory = Column(String(100), default="")
    manufacturer = Column(String(100), default="")
    model = Column(String(100), default="")
    serialized = Column(Boolean, default=False)
    qty = Column(Integer, default=0)
    vendor_company_id = Column(Integer, nullable=True)
    rates = Column(JSON, default=dict)        # {threeDay, week, month}
    status = Column(String(50), default="available")
    location = Column(String(100), default="")
    weight = Column(Float, default=0)
    notes = Column(Text, default="")
    accessories = Column(JSON, default=list)
    default_container_id = Column(Integer, nullable=True)
    units = Column(JSON, default=list)        # serialized units array
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Product(Base):
    __tablename__ = "products"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    category = Column(String(100), default="")
    unit = Column(String(50), default="ea")
    unit_price = Column(Float, default=0)
    cost = Column(Float, default=0)
    notes = Column(Text, default="")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Service(Base):
    __tablename__ = "services"

    id = Column(Integer, primary_key=True, index=True)
    role = Column(String(20), nullable=False, default="")
    description = Column(String(255), default="")
    department = Column(String(50), default="")
    day_rate = Column(Float, default=0)
    half_day = Column(Float, default=0)
    hourly_rate = Column(Float, default=0)
    ot_rate = Column(Float, default=0)
    day_cost = Column(Float, default=0)
    half_day_cost = Column(Float, default=0)
    hourly_cost = Column(Float, default=0)
    ot_cost = Column(Float, default=0)
    notes = Column(Text, default="")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Allocation(Base):
    __tablename__ = "allocations"

    id = Column(Integer, primary_key=True, index=True)
    equipment_id = Column(Integer, ForeignKey("equipment.id", ondelete="CASCADE"), nullable=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=True)
    qty = Column(Integer, default=1)
    start_date = Column(String(10), default="")
    end_date = Column(String(10), default="")
    state = Column(String(30), default="reserved")
    notes = Column(Text, default="")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Container(Base):
    __tablename__ = "containers"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    type = Column(String(100), default="")
    manufacturer = Column(String(100), default="")
    model = Column(String(100), default="")
    serialized = Column(Boolean, default=False)
    qty = Column(Integer, default=1)
    dimensions = Column(JSON, default=dict)       # {l, w, h}
    weight_empty = Column(Float, default=0)
    color = Column(String(50), default="")
    notes = Column(Text, default="")
    default_for_equipment = Column(JSON, default=list)
    can_nest_ids = Column(JSON, default=list)
    optional = Column(Boolean, default=False)
    rates = Column(JSON, default=dict)
    rental_rate = Column(Float, nullable=True)
    status = Column(String(50), default="available")
    maintenance_logs = Column(JSON, default=list)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Kit(Base):
    __tablename__ = "kits"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    category = Column(String(100), default="")
    description = Column(Text, default="")
    items = Column(JSON, default=list)
    containers = Column(JSON, default=list)
    rates = Column(JSON, default=dict)
    auto_rate = Column(Boolean, default=True)
    notes = Column(Text, default="")
    status = Column(String(50), default="active")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Settings(Base):
    __tablename__ = "settings"

    id = Column(Integer, primary_key=True, default=1)
    data = Column(JSON, nullable=False, default=dict)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
