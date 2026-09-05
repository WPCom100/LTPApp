"""The online quote/invoice view shows the unit behind each quantity — "3 days",
"1 half day", "5 OT hours" — the same words the PDF prints. The public payload
(GET /api/view/{token}) carries it as a derived `qtyLabel` on every priced
line, so the client page never needs the internal rateType/unit fields.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.doc_units import qty_label  # noqa: E402
from backend.pdf_generator import _qty_label  # noqa: E402
from backend.routes._shared import public_section_items  # noqa: E402

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ITEMS = [
    {"id": "a", "type": "service", "name": "LD", "rateType": "flat", "qty": 1, "unitPrice": 2000, "adjustedPrice": None, "cost": 1500, "serviceId": 3},
    {"id": "b", "type": "service", "name": "PM", "rateType": "day", "qty": 3, "unitPrice": 800, "adjustedPrice": None, "cost": 400},
    {"id": "c", "type": "service", "name": "PM", "rateType": "half", "qty": 1, "unitPrice": 400, "adjustedPrice": None, "cost": 200},
    {"id": "d", "type": "service", "name": "L1", "rateType": "hourly", "qty": 2.5, "unitPrice": 65, "adjustedPrice": None, "cost": 30},
    {"id": "e", "type": "service", "name": "SPOT", "rateType": "ot", "qty": 5, "unitPrice": 60, "adjustedPrice": None, "cost": 30},
    {"id": "f", "type": "service", "name": "legacy (no rateType)", "qty": 2, "unitPrice": 500, "adjustedPrice": None, "cost": 250},
    {"id": "g", "type": "equipment", "name": "LED Par Wash", "rentalLabel": "3-Day", "qty": 12, "unitPrice": 45, "adjustedPrice": None, "cost": 0},
    {"id": "h", "type": "fee", "name": "Delivery", "unit": "trip", "qty": 2, "unitPrice": 250, "adjustedPrice": None, "cost": 120},
    {"id": "i", "type": "fee", "name": "Consultation", "unit": "flat", "qty": 1, "unitPrice": 300, "adjustedPrice": 250, "cost": 0},
    {"id": "j", "type": "product", "name": "Gaffer Tape", "qty": 3, "unitPrice": 22, "adjustedPrice": None, "cost": 11, "productVariantId": "v9"},
    {"id": "k", "type": "note", "text": "A caption between lines", "name": ""},
]
EXPECTED = {
    "a": "flat rate", "b": "days", "c": "half day", "d": "hours", "e": "OT hours",
    "f": "days", "g": "units", "h": "trips", "i": "flat rate", "j": "ea",
}


def _public_items():
    out = public_section_items([{"id": "s1", "label": "Labor", "items": ITEMS}])
    return {it["id"]: it for it in out[0]["items"]}


def test_every_priced_line_carries_the_pdf_vocabulary():
    pub = _public_items()
    for it in ITEMS:
        if it["type"] == "note":
            continue
        assert pub[it["id"]]["qtyLabel"] == EXPECTED[it["id"]], it["id"]
        # One helper behind both surfaces.
        assert pub[it["id"]]["qtyLabel"] == _qty_label(it, it["qty"]) == qty_label(it, it["qty"])


def test_note_rows_get_no_label():
    assert "qtyLabel" not in _public_items()["k"]


def test_label_is_derived_and_the_raw_fields_stay_internal():
    pub = _public_items()
    for it in pub.values():
        for internal in ("rateType", "unit", "cost", "serviceId", "productVariantId"):
            assert internal not in it, (it["id"], internal)


def test_client_view_reads_the_derived_label():
    """The allow-list comment in routes/_shared.py names qtyLabel as something
    modules/client-view.js reads; keep the two ends tied."""
    with open(os.path.join(_root, "modules", "client-view.js"), encoding="utf-8") as f:
        src = f.read()
    assert "it.qtyLabel" in src
    assert "qtyLabel" in open(os.path.join(_root, "backend", "routes", "_shared.py"), encoding="utf-8").read()


def test_public_payload_does_not_mutate_its_input():
    before = [dict(it) for it in ITEMS]
    public_section_items([{"id": "s1", "label": "Labor", "items": ITEMS}])
    assert ITEMS == before
