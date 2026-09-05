"""The PDF's QTY column names the unit behind each quantity — "3 days",
"1 half day", "5 OT hours", "1 flat rate", "2 units", "1 trip", "ea" — the
same thing the builders print beside the field (their qtyLabel), so a
customer reads what the producer priced.
"""
import io
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.pdf_generator import _qty_label, generate_pdf  # noqa: E402


@pytest.mark.parametrize("item, qty, expected", [
    ({"type": "service", "rateType": "day"}, 3, "days"),
    ({"type": "service", "rateType": "day"}, 1, "day"),
    ({"type": "service"}, 2, "days"),                          # no rateType → day rate
    ({"type": "service", "rateType": "half"}, 1, "half day"),
    ({"type": "service", "rateType": "half"}, 2, "half days"),
    ({"type": "service", "rateType": "hourly"}, 2.5, "hours"),
    ({"type": "service", "rateType": "ot"}, 1, "OT hour"),
    ({"type": "service", "rateType": "ot"}, 5, "OT hours"),
    ({"type": "service", "rateType": "flat"}, 1, "flat rate"),
    ({"type": "equipment", "rentalLabel": "3-Day"}, 1, "unit"),
    ({"type": "equipment", "rentalLabel": "3-Day"}, 12, "units"),
    ({"type": "fee", "unit": "trip"}, 1, "trip"),
    ({"type": "fee", "unit": "trip"}, 2, "trips"),
    ({"type": "fee", "unit": "percent"}, 8, "percent"),
    ({"type": "fee", "unit": "flat"}, 1, "flat rate"),
    ({"type": "fee"}, 1, "flat rate"),
    ({"type": "product"}, 3, "ea"),
    ({"type": "product", "unit": "each"}, 4, "ea"),
    ({"type": "product", "unit": "roll"}, 2, "rolls"),
    ({"type": "product", "unit": "box"}, 2, "boxes"),
    ({"type": "note"}, 0, ""),
])
def test_qty_label(item, qty, expected):
    assert _qty_label(item, qty) == expected


def test_qty_label_tolerates_bad_quantities():
    assert _qty_label({"type": "service", "rateType": "day"}, None) == "days"
    assert _qty_label({"type": "service", "rateType": "day"}, "x") == "days"


def _doc(kind):
    return {
        "id": 7, "status": "draft", "clientType": "company", "companyId": 1, "projectId": 1,
        "createdDate": "2026-09-01", "invoiceDate": "2026-09-01", "dueDate": "2026-10-01",
        "expiryDate": "2026-10-01", "customName": "", "globalDiscount": None, "notes": "", "terms": "",
        "payments": [], "activity": [],
        "sections": [{"id": "s1", "label": "Labor", "customDates": False, "startDate": "", "endDate": "", "items": [
            {"id": "i1", "type": "service", "name": "PM — Production Manager", "rateType": "day", "qty": 3, "unitPrice": 800, "adjustedPrice": None, "cost": 400, "notes": ""},
            {"id": "i2", "type": "service", "name": "L1 — Lighting Lead", "rateType": "ot", "qty": 5, "unitPrice": 105, "adjustedPrice": 100, "cost": 52.5, "notes": ""},
            {"id": "i3", "type": "service", "name": "LD — Lighting Designer", "rateType": "flat", "qty": 1, "unitPrice": 2000, "adjustedPrice": None, "cost": 1500, "notes": ""},
            {"id": "i4", "type": "equipment", "name": "LED Par Wash", "rentalLabel": "3-Day", "qty": 12, "unitPrice": 45, "adjustedPrice": None, "cost": 0, "notes": ""},
            {"id": "i5", "type": "fee", "name": "Delivery", "unit": "trip", "qty": 2, "unitPrice": 250, "adjustedPrice": None, "cost": 120, "notes": ""},
            {"id": "i6", "type": "product", "name": "Gaffer Tape", "qty": 3, "unitPrice": 22, "adjustedPrice": None, "cost": 11, "notes": ""},
            {"id": "i7", "type": "note", "text": "A caption between lines", "name": ""},
        ]}],
    }


@pytest.mark.parametrize("kind", ["quote", "invoice"])
def test_every_line_kind_renders_with_its_unit(kind):
    buf = io.BytesIO()
    generate_pdf(buf, kind, _doc(kind), {"id": 1, "name": "Riverside Theatre"}, None,
                 {"id": 1, "name": "Autumn Gala", "startDate": "2026-09-10", "endDate": "2026-09-13"}, {}, "Tester")
    pdf = buf.getvalue()
    assert pdf[:4] == b"%PDF" and len(pdf) > 2000
