"""The unit behind a document line's quantity.

"3 days", "1 half day", "5 OT hours", "1 flat rate"; "2 units" of equipment
(the rental period already sits in the name); a fee's own unit ("1 trip",
"8 percent"); "ea" for a product. One vocabulary for every customer-facing
surface: the PDF's QTY column (pdf_generator) and the online view, whose
payload carries it as `qtyLabel` (routes/_shared derives it here) so the
client page never needs the internal rateType/unit fields. Mirrors the
qtyLabel the builders print beside the field, so each names the same thing
the producer priced.
"""

SERVICE_UNITS = {
    "day": ("day", "days"), "half": ("half day", "half days"), "hourly": ("hour", "hours"),
    "ot": ("OT hour", "OT hours"), "flat": ("flat rate", "flat rate"),
}
NO_PLURAL = {"each", "ea", "percent", "%", "hrs", "hr"}


def plural(unit):
    if unit.endswith(("s", "x", "z", "ch", "sh")):
        return unit + "es"
    if unit.endswith("y") and len(unit) > 1 and unit[-2] not in "aeiou":
        return unit[:-1] + "ies"
    return unit + "s"


def qty_label(it, qty):
    """Unit label for line `it` (a quote/invoice item dict) at quantity `qty`;
    "" for a note row or an unknown type."""
    kind = (it.get("type") or "").strip().lower()
    try:
        one = float(qty or 0) == 1
    except (TypeError, ValueError):
        one = False
    if kind == "service":
        single, many = SERVICE_UNITS.get((it.get("rateType") or "day").strip().lower(), SERVICE_UNITS["day"])
        return single if one else many
    if kind == "equipment":
        return "unit" if one else "units"
    unit = (it.get("unit") or "").strip().lower()
    if kind == "fee":
        if not unit or unit == "flat":
            return "flat rate"
        return unit if (one or unit in NO_PLURAL) else plural(unit)
    if kind == "product":
        if not unit or unit in NO_PLURAL:
            return "ea"
        return unit if one else plural(unit)
    return ""
