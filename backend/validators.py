"""Server-side input validation for entity writes.

What this catches:
  - Status / category / state strings that aren't in the known set
    (typo defense + protection against malicious clients sending forged
    enum values that break frontend filters and analytics).
  - Date strings that aren't ISO YYYY-MM-DD.
  - Numeric fields that should be non-negative (prices, qty, weight).
  - String fields that exceed the underlying column's char limit
    (would either truncate or throw a DB error at flush time — we'd
    rather fail with a clear 400 here).
  - The CONTAINER TYPE of every JSON column, derived from the column's own
    declared default so it cannot drift from models.py (see _json_rules_for).
    A column declared `default=list` must receive a list; `default=dict`
    must receive a dict; null is allowed and clears to the default.

What it deliberately does NOT catch:
  - Nested JSON structure validation (Quote.sections[i].items[j].qty
    being non-negative, Project.budget.lighting being numeric, etc.).
    That's a much bigger surface; revisit when needed. Only the top-level
    container type is asserted — the readers that matter already guard
    per-element (backend/payouts.py:213 skips a non-dict schedule entry),
    so the container is the one assumption none of them can defend against.
  - Cross-field consistency (e.g. clientType="company" implies
    companyId != null). Frontend enforces this; defer.
  - Foreign-key validity. Postgres enforces FK constraints at INSERT.
    A bogus companyId surfaces as a 500 IntegrityError, which is good
    enough as a "wrong reference" signal for now.

Enum sets MUST stay in sync with [components/status-enums.js]. If you
add a value there, add it here too (or vice versa). Tests would catch
divergence eventually but a stricter design would generate one from
the other; current scale doesn't justify the build step.
"""
from datetime import datetime
from fastapi import HTTPException


# ── Enum sets (mirror of components/status-enums.js) ───────────────────────

ENUMS = {
    "quote_status":     {"draft", "sent", "accepted", "declined", "converted"},
    "invoice_status":   {"draft", "sent", "partial", "paid", "overdue"},
    "project_status":   {"upcoming", "in-progress", "completed", "cancelled"},
    # Accepts BOTH the lowercase keys (status-enums.js PROJECT_CATEGORY) and the
    # human labels. The project form (theme.js LTP_PROJECT_CATS) stores the LABEL
    # as the category and only converts to a key for Badge styling
    # (LTP_CAT_KEYS), so a normal "create project" sends e.g. "Rental" /
    # "Full Production". Accept both so saves round-trip and existing
    # label-formatted rows stay valid.
    "project_category": {"rental", "labor", "service", "full-production",
                         "Rental", "Labor", "Service", "Full Production"},
    "client_type":      {"company", "contact"},
    "allocation_state": {"reserved", "allocated", "checked-out", "returned", "under-maintenance"},
    "crew_status":      {"active", "inactive"},
    "company_status":   {"active", "inactive", "one-time", "prospect"},
    "equipment_status": {"available", "rented", "under-maintenance"},
}


# ── Validator factories ────────────────────────────────────────────────────
# Every validator follows the same contract: receives a raw value, returns
# silently on success, raises ValueError(<short reason>) on failure. The
# caller (validate()) catches and converts to HTTPException(400).

def _enum(name):
    """Reject anything not in ENUMS[name]. Empty string and None are allowed
    (treat as "unset" — many entities have nullable status during draft)."""
    allowed = ENUMS[name]
    def check(value):
        if value is None or value == "":
            return
        if not isinstance(value, str):
            raise ValueError("must be a string")
        if value not in allowed:
            raise ValueError(f"must be one of: {sorted(allowed)}")
    return check


def _iso_date(value):
    """Reject anything that isn't ISO YYYY-MM-DD or empty. strptime catches
    both format AND value errors (e.g. month 13, day 32) — a regex would let
    those through."""
    if value is None or value == "":
        return
    if not isinstance(value, str):
        raise ValueError("must be a string")
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise ValueError("must be ISO YYYY-MM-DD")


def _nonneg_number(value):
    """Reject negative or non-numeric values. None and empty string pass
    through (some fields are optional)."""
    if value is None or value == "":
        return
    # bool is a subclass of int in Python; reject explicitly to catch
    # frontend mistakes that send True/False where a number is expected.
    if isinstance(value, bool):
        raise ValueError("must be a number, not a boolean")
    if not isinstance(value, (int, float)):
        raise ValueError("must be a number")
    if value < 0:
        raise ValueError("must be non-negative")


def _str_max(maxlen):
    """Reject strings longer than maxlen characters. Length caps match the
    underlying column's declared size; sending more would either truncate or
    error at DB flush. Better to fail with a clear field-level 400."""
    def check(value):
        if value is None:
            return
        if not isinstance(value, str):
            raise ValueError("must be a string")
        if len(value) > maxlen:
            raise ValueError(f"must be at most {maxlen} characters (got {len(value)})")
    return check


# ── Per-entity rules ──────────────────────────────────────────────────────
# Lazy-loaded so we can import models without import cycles. Keyed by the
# model CLASS (not name) — passed directly from the CRUD factory.

_RULES = None


def _json_shape(kind):
    """Require a JSON column to arrive as the container type it was declared
    with. None is allowed — it clears the field to the column default.

    Every JSON column in models.py is declared `default=list` or
    `default=dict`, and every reader assumes that shape. Nothing enforced it:
    `PUT /api/projects/{id}` with `{"schedule": true}` returned 200 and stored
    the bool verbatim, after which backend/payouts.py::derive_payout_drafts
    raised `TypeError: 'bool' object is not iterable` for EVERY project — one
    member's write took the payouts page down for the whole workspace until
    the row was repaired by hand.

    This is a shape check only. Nested contents stay unvalidated (see the
    module docstring): the readers that matter already guard per-element
    (payouts.py:213 skips a non-dict entry), so the container type is the one
    assumption none of them can defend against.
    """
    name = kind.__name__

    def check(v):
        if v is None:
            return
        # bool is an int subclass but never a list/dict, so isinstance is safe.
        if not isinstance(v, kind):
            raise ValueError(f"must be a JSON {name}, got {type(v).__name__}")
    return check


def _snake_to_camel(s):
    parts = s.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def _json_rules_for(model_cls):
    """Derive {field: shape-validator} for a model's JSON columns, from the
    column definitions themselves so this can never drift from models.py.

    Registered under BOTH spellings: _dict_to_row accepts camelCase and
    snake_case alike, so checking only one leaves the other as a bypass.
    """
    from sqlalchemy import JSON
    out = {}
    for col in model_cls.__table__.columns:
        if not isinstance(col.type, JSON):
            continue
        # `Column(JSON, default=list)` stores a CallableColumnDefault wrapping
        # the callable, so `col.default.arg` is a wrapper — not the `list`
        # builtin. Call it (it takes an execution context, unused here) and
        # look at what it actually produces. A column with no declared default
        # (Quote.send_recipients) asserts nothing.
        default_obj = None
        d = col.default
        if d is not None and getattr(d, "is_callable", False):
            try:
                default_obj = d.arg(None)
            except Exception:
                default_obj = None
        elif d is not None:
            default_obj = getattr(d, "arg", None)
        if isinstance(default_obj, list):
            declared = list
        elif isinstance(default_obj, dict):
            declared = dict
        else:
            continue
        check = _json_shape(declared)
        out[col.name] = check
        camel = _snake_to_camel(col.name)
        if camel != col.name:
            out[camel] = check
    return out


def _build_rules():
    """Build the {model_cls: {field: validator}} map. Called once on first
    use of validate() to avoid forcing models to be imported at module load
    time (would create a circular dep with backend/__init__.py).

    Hand-written field rules below, then a derived JSON container-shape rule
    per model (see _json_rules_for). Hand-written entries win on collision.
    """
    from backend import models
    rules = {
        models.Company: {
            "name":    _str_max(255),
            "status":  _enum("company_status"),
            "website": _str_max(255),
            "city":    _str_max(100),
            "state":   _str_max(50),
            "zip":     _str_max(20),
        },
        models.Contact: {
            "firstName":  _str_max(100),
            "lastName":   _str_max(100),
            "email":      _str_max(255),
            "phone":      _str_max(50),
            "role":       _str_max(100),
            "crewStatus": _enum("crew_status"),
            "city":       _str_max(100),
            "state":      _str_max(50),
            "zip":        _str_max(20),
        },
        models.Project: {
            "name":      _str_max(255),
            "category":  _enum("project_category"),
            "status":    _enum("project_status"),
            "startDate": _iso_date,
            "endDate":   _iso_date,
            "venue":     _str_max(255),
        },
        models.Quote: {
            "terms":           _str_max(4000),
            "clientType":      _enum("client_type"),
            "status":          _enum("quote_status"),
            "sentDate":        _iso_date,
            "expiryDate":      _iso_date,
            "customStartDate": _iso_date,
            "customEndDate":   _iso_date,
            "customName":      _str_max(255),
        },
        models.Invoice: {
            "terms":           _str_max(4000),
            "clientType":  _enum("client_type"),
            "status":      _enum("invoice_status"),
            "invoiceDate": _iso_date,
            "dueDate":     _iso_date,
            "sentDate":    _iso_date,
            "paidDate":    _iso_date,
            "customName":  _str_max(255),
        },
        models.Equipment: {
            "name":        _str_max(255),
            "category":    _str_max(100),
            "subcategory": _str_max(100),
            "status":      _enum("equipment_status"),
            "weight":      _nonneg_number,
        },
        models.Product: {
            "name":      _str_max(255),
            "category":  _str_max(100),
            "unit":      _str_max(50),
            "unitPrice": _nonneg_number,
            "cost":      _nonneg_number,
        },
        models.Fee: {
            "name":      _str_max(255),
            "category":  _str_max(100),
            "unit":      _str_max(50),
            "unitPrice": _nonneg_number,
            "cost":      _nonneg_number,
        },
        models.Service: {
            "role":        _str_max(20),
            "description": _str_max(255),
            "department":  _str_max(50),
            "dayRate":     _nonneg_number,
            "halfDay":     _nonneg_number,
            "hourlyRate":  _nonneg_number,
            "otRate":      _nonneg_number,
            "dayCost":     _nonneg_number,
            "halfDayCost": _nonneg_number,
            "hourlyCost":  _nonneg_number,
            "otCost":      _nonneg_number,
        },
        # Every rate/cost field is nullable ("inherit the base Service value"),
        # which _nonneg_number already passes through — it only rejects negative
        # or non-numeric values.
        models.ClientRate: {
            "clientType":   _enum("client_type"),
            "label":        _str_max(100),
            "dayRate":      _nonneg_number,
            "halfDay":      _nonneg_number,
            "hourlyRate":   _nonneg_number,
            "otRate":       _nonneg_number,
            "dayCost":      _nonneg_number,
            "halfDayCost":  _nonneg_number,
            "hourlyCost":   _nonneg_number,
            "otCost":       _nonneg_number,
            "minHours":     _nonneg_number,
            "minCostHours": _nonneg_number,
        },
        models.Allocation: {
            "state":     _enum("allocation_state"),
            "qty":       _nonneg_number,
            "startDate": _iso_date,
            "endDate":   _iso_date,
        },
        models.Container: {
            "name":        _str_max(255),
            "type":        _str_max(100),
            "weightEmpty": _nonneg_number,
            "rentalRate":  _nonneg_number,
        },
        models.Kit: {
            "name":     _str_max(255),
            "category": _str_max(100),
        },
    }
    # Derived JSON container-shape rules, added under any field the
    # hand-written map above does not already claim.
    for model_cls, field_rules in rules.items():
        for field, check in _json_rules_for(model_cls).items():
            field_rules.setdefault(field, check)
    return rules


def validate(model_cls, data: dict) -> None:
    """Apply validators for the given entity to incoming request data.

    Only checks fields present in `data`; missing/unset fields are fine (they
    keep their existing DB value on update, or take the column default on
    insert). Fields not listed in _RULES are passed through (filtering by
    column-name happens later in _dict_to_row).

    Raises HTTPException(400, detail={field, reason}) on the FIRST failure
    — fail-fast keeps error messages actionable. Validate one field at a
    time, fix, retry."""
    global _RULES
    if _RULES is None:
        _RULES = _build_rules()
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="request body must be a JSON object")
    rules = _RULES.get(model_cls, {})
    for field, check in rules.items():
        if field in data:
            try:
                check(data[field])
            except ValueError as e:
                raise HTTPException(
                    status_code=400,
                    detail={"field": field, "reason": str(e)},
                )
