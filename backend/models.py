from sqlalchemy import Column, Integer, String, Boolean, Float, Text, DateTime, JSON, ForeignKey
from sqlalchemy.sql import func
from backend.database import Base


class Company(Base):
    __tablename__ = "companies"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    phone = Column(String(50), default="")
    email = Column(String(255), default="")
    website = Column(String(255), default="")
    address = Column(Text, default="")
    notes = Column(Text, default="")
    type = Column(String(50), default="client")  # client, vendor, partner
    tags = Column(JSON, default=list)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Contact(Base):
    __tablename__ = "contacts"

    id = Column(Integer, primary_key=True, index=True)
    first_name = Column(String(100), nullable=False)
    last_name = Column(String(100), nullable=False)
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
    venue = Column(String(255), default="")
    status = Column(String(50), default="planning")  # planning, in-progress, completed
    start_date = Column(String(10), default="")
    end_date = Column(String(10), default="")
    notes = Column(Text, default="")
    schedule = Column(JSON, default=list)
    schedule_activity = Column(JSON, default=list)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Quote(Base):
    __tablename__ = "quotes"

    id = Column(Integer, primary_key=True, index=True)
    company_id = Column(Integer, ForeignKey("companies.id", ondelete="SET NULL"), nullable=True)
    client_contact_id = Column(Integer, ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True)
    client_type = Column(String(20), default="company")
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    status = Column(String(20), default="draft")
    created_date = Column(String(10), default="")
    sent_date = Column(String(10), default="")
    sections = Column(JSON, default=list)
    global_discount = Column(JSON, default=dict)
    notes = Column(Text, default="")
    internal_notes = Column(Text, default="")
    custom_name = Column(String(255), default="")
    activity = Column(JSON, default=list)
    version = Column(Integer, default=1)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Invoice(Base):
    __tablename__ = "invoices"

    id = Column(Integer, primary_key=True, index=True)
    company_id = Column(Integer, ForeignKey("companies.id", ondelete="SET NULL"), nullable=True)
    client_contact_id = Column(Integer, ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True)
    client_type = Column(String(20), default="company")
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    quote_id = Column(Integer, ForeignKey("quotes.id", ondelete="SET NULL"), nullable=True)
    status = Column(String(20), default="draft")
    invoice_date = Column(String(10), default="")
    due_date = Column(String(10), default="")
    paid_date = Column(String(10), default="")
    sections = Column(JSON, default=list)
    payments = Column(JSON, default=list)
    global_discount = Column(JSON, default=dict)
    notes = Column(Text, default="")
    internal_notes = Column(Text, default="")
    custom_name = Column(String(255), default="")
    activity = Column(JSON, default=list)
    version = Column(Integer, default=1)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Equipment(Base):
    __tablename__ = "equipment"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    category = Column(String(100), default="")
    brand = Column(String(100), default="")
    model = Column(String(100), default="")
    qty = Column(Integer, default=1)
    day_rate = Column(Float, default=0)
    replacement_cost = Column(Float, default=0)
    weight = Column(Float, default=0)
    power = Column(String(50), default="")
    notes = Column(Text, default="")
    barcode = Column(String(100), default="")
    serial_number = Column(String(100), default="")
    purchase_date = Column(String(10), default="")
    purchase_price = Column(Float, default=0)
    vendor_id = Column(Integer, nullable=True)
    condition = Column(String(50), default="good")
    maintenance_log = Column(JSON, default=list)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Product(Base):
    __tablename__ = "products"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    sku = Column(String(100), default="")
    category = Column(String(100), default="")
    price = Column(Float, default=0)
    cost = Column(Float, default=0)
    unit = Column(String(50), default="ea")
    taxable = Column(Boolean, default=True)
    notes = Column(Text, default="")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Service(Base):
    __tablename__ = "services"

    id = Column(Integer, primary_key=True, index=True)
    role = Column(String(20), nullable=False)
    description = Column(String(255), default="")
    dept = Column(String(50), default="")
    day_rate = Column(Float, default=0)
    day_cost = Column(Float, default=0)
    half_day = Column(Float, default=0)
    half_day_cost = Column(Float, default=0)
    hourly = Column(Float, default=0)
    hourly_cost = Column(Float, default=0)
    ot = Column(Float, default=0)
    ot_cost = Column(Float, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Settings(Base):
    __tablename__ = "settings"

    id = Column(Integer, primary_key=True, default=1)
    data = Column(JSON, nullable=False, default=dict)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
