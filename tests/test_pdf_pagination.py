"""How a quote/invoice PDF behaves at the bottom of a page.

The bug this file pins down: a section's peach frame was drawn ONCE, from a
`box_top` captured before the first row to a `box_bottom` captured after the
last one. When the rows crossed a page break those two cursors lived on
different pages, so reportlab got a rectangle with NEGATIVE height on the page
the section ended on. In the reported quote (Q-2026-038) that drew a 556pt box
from the continued row all the way down past the terms — boxing in the Fees
table, the totals and the terms & conditions — while the rows it was supposed
to frame, back on page 1, got no frame at all. The continued row also landed
on the new page with no section title and no ITEM / QTY / UNIT PRICE / TOTAL
header above it: a bare line of numbers under nothing.

What's covered:
  - A section frame is drawn per page, always with positive height, never
    taller than a page.
  - Every page carrying a section's rows frames those rows: the frame opens
    above the first one and closes below the last.
  - Continuation pages repeat the section title (with "(CONT.)") and the
    column header row, equipment rental period included.
  - A section short enough to keep whole moves to the next page instead of
    splitting — the Transportation case from the report.
  - A split never strands the final row of a table alone on the next page.
  - Nothing — rows, subtotals, totals, terms — is ever drawn below the floor
    that keeps the footer clear.
"""
import io
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.pdf_generator import _DocPDF, _register_fonts  # noqa: E402


# ── Canvas spy ─────────────────────────────────────────────────────────────

FOOTER_MARK = "  |  "     # "<company>  |  <website>" — the footer's left text


def _page():
    return {"strings": [], "frames": []}


def _render(entity, project=None, settings=None, kind="quote"):
    """Render a document with the canvas instrumented, bucketing every draw
    call by the page it landed on. Returns (doc, pages) where each page is
    {"strings": [(x, y, text)], "frames": [(x, y, w, h)]} — frames being the
    stroked rects, which in this renderer are only ever section frames."""
    _register_fonts()
    doc = _DocPDF(io.BytesIO(), kind, entity, {"name": "Avant Chamber Ballet"}, None,
                  project or {"name": "Nutcracker"}, settings or {}, "Tester")
    pages = [_page()]
    real_rect, real_show = doc.c.rect, doc.c.showPage
    real_str, real_rstr = doc.c.drawString, doc.c.drawRightString

    def spy_str(real):
        def fn(x, y, text, *a, **k):
            pages[-1]["strings"].append((round(x, 2), round(y, 2), text))
            return real(x, y, text, *a, **k)
        return fn

    def spy_rect(x, y, w, h, *a, **k):
        if k.get("stroke"):
            pages[-1]["frames"].append((round(x, 2), round(y, 2), round(w, 2), round(h, 2)))
        return real_rect(x, y, w, h, *a, **k)

    def spy_show(*a, **k):
        out = real_show(*a, **k)
        pages.append(_page())
        return out

    doc.c.drawString = spy_str(real_str)
    doc.c.drawRightString = spy_str(real_rstr)
    doc.c.rect = spy_rect
    doc.c.showPage = spy_show
    doc.render()
    # canvas.save() flushes a final showPage; drop the empty bucket it opens.
    while pages and not pages[-1]["strings"] and not pages[-1]["frames"]:
        pages.pop()
    return doc, pages


def _texts(page):
    return [t for _, _, t in page["strings"]]


def _ys(page, needle):
    """Every y a string containing `needle` was drawn at, on this page."""
    return [y for _, y, t in page["strings"] if needle in t]


def _ys_exact(page, text):
    """Every y a string EXACTLY equal to `text` was drawn at — "Subtotal:" the
    grand total, not "Labor Subtotal:" the section's."""
    return [y for _, y, t in page["strings"] if t == text]


def _body_strings(page):
    """Everything on the page except the two footer strings."""
    return [(x, y, t) for x, y, t in page["strings"]
            if not (t.startswith("Page ") or FOOTER_MARK in t)]


# ── Fixtures ───────────────────────────────────────────────────────────────

def _svc(name, rate, qty, price, adjusted=None):
    return {"type": "service", "name": name, "rateType": rate, "qty": qty,
            "unitPrice": price, "adjustedPrice": adjusted}


def _rows(n, prefix="Item", adjusted_every=0):
    return [_svc(f"{prefix} {i:02d}", "day", i, 100,
                 90 if adjusted_every and i % adjusted_every == 0 else None)
            for i in range(1, n + 1)]


def _doc(sections, **extra):
    ent = {"id": 38, "status": "draft", "createdDate": "2026-09-18",
           "expiryDate": "2026-10-18", "globalDiscount": None,
           "payments": [], "activity": [], "sections": sections}
    ent.update(extra)
    return ent


# The reported quote's shape: a long Labor table that fills page 1, then the
# four-row Transportation table that used to be sliced 3/1 across the break.
def _q_2026_038():
    return _doc([
        {"id": "s1", "label": "Labor", "items": _rows(19, "Crew")},
        {"id": "s2", "label": "Transportation", "items": _rows(4, "Truck")},
        {"id": "s3", "label": "Fees", "items": _rows(3, "Fee")},
    ])


# ── Frames ─────────────────────────────────────────────────────────────────

def test_no_frame_spans_a_page_break():
    """THE regression. Every frame has positive height and fits on its page —
    the broken renderer emitted one 556pt-tall box from a top cursor left
    behind on the previous page."""
    doc, pages = _render(_doc([{"id": "s1", "label": "Equipment",
                                "items": _rows(70, "LED Par Wash")}]))
    frames = [f for p in pages for f in p["frames"]]
    assert frames, "a section should draw at least one frame"
    for x, y, w, h in frames:
        assert h > 0, f"frame drawn with non-positive height: {(x, y, w, h)}"
        assert h <= doc._fresh_page_h(), f"frame taller than a page: {h}"
        assert y >= doc._floor - 0.5, f"frame bottom below the footer floor: {y}"


def test_every_page_of_a_split_section_frames_its_own_rows():
    """Each page that carries rows of a split section frames exactly those
    rows: the frame opens above the first and closes below the last."""
    _, pages = _render(_doc([{"id": "s1", "label": "Equipment",
                              "items": _rows(70, "LED Par Wash")}]))
    carrying = [p for p in pages if _ys(p, "LED Par Wash")]
    assert len(carrying) >= 3, "70 rows should need at least three pages"
    for p in carrying:
        assert len(p["frames"]) == 1, "one frame per page of one section"
        _, y, _, h = p["frames"][0]
        row_ys = _ys(p, "LED Par Wash")
        assert y + h > max(row_ys), "frame should open above the first row"
        assert y < min(row_ys), "frame should close below the last row"


def test_rows_on_the_first_page_of_a_split_section_are_framed():
    """The broken renderer drew the whole frame on the LAST page of a split
    section, leaving the rows on the page before it with no frame at all."""
    _, pages = _render(_doc([{"id": "s1", "label": "Equipment",
                              "items": _rows(70, "LED Par Wash")}]))
    first = next(p for p in pages if _ys(p, "LED Par Wash"))
    assert first["frames"], "the section's first page must frame its rows"


# ── Continuation headers ───────────────────────────────────────────────────

def test_continuation_pages_repeat_the_title_and_column_headers():
    _, pages = _render(_doc([{"id": "s1", "label": "Equipment",
                              "items": _rows(70, "LED Par Wash")}]))
    carrying = [p for p in pages if _ys(p, "LED Par Wash")]
    assert "EQUIPMENT" in _texts(carrying[0])
    for p in carrying[1:]:
        assert "EQUIPMENT (CONT.)" in _texts(p), "continued rows need their title"
        for head in ("ITEM", "QTY", "UNIT PRICE", "TOTAL"):
            assert head in _texts(p), f"continued rows need the {head} header"


def test_continuation_repeats_the_rental_period_for_equipment():
    items = [{"type": "equipment", "name": f"LED Par Wash {i}", "rentalLabel": "3-Day",
              "qty": i, "unitPrice": 45, "adjustedPrice": None} for i in range(1, 71)]
    _, pages = _render(_doc([{"id": "s1", "label": "Equipment", "items": items}]),
                       project={"name": "Nutcracker", "startDate": "2026-12-10",
                                "endDate": "2026-12-14"})
    carrying = [p for p in pages if _ys(p, "LED Par Wash")]
    for p in carrying[1:]:
        assert any(t.startswith("Rental Period:") for t in _texts(p))


def test_a_continuation_header_never_opens_a_page_with_no_rows_under_it():
    """The repeated header is drawn from inside the page break, so it must
    never be the last thing on a page."""
    for n in range(20, 80, 7):
        _, pages = _render(_doc([{"id": "s1", "label": "Equipment",
                                  "items": _rows(n, "LED Par Wash")}]))
        for p in pages:
            if "EQUIPMENT (CONT.)" in _texts(p):
                assert _ys(p, "LED Par Wash"), f"{n} rows: stranded header"


# ── Keeping a section whole ────────────────────────────────────────────────

def test_a_short_section_moves_whole_rather_than_splitting():
    """Transportation in the report: four rows, three of which fit under the
    Labor table. All four should travel to the next page together."""
    _, pages = _render(_q_2026_038())
    carrying = [i for i, p in enumerate(pages) if _ys(p, "Truck ")]
    assert len(carrying) == 1, "a four-row section should not be split"
    page = pages[carrying[0]]
    assert len(_ys(page, "Truck ")) == 4
    assert "TRANSPORTATION" in _texts(page)
    assert "TRANSPORTATION (CONT.)" not in _texts(page)


def test_a_section_subtotal_stays_with_its_table():
    _, pages = _render(_q_2026_038())
    for label, prefix in (("Labor", "Crew "), ("Transportation", "Truck "), ("Fees", "Fee ")):
        rows_on = {i for i, p in enumerate(pages) if _ys(p, prefix)}
        sub_on = {i for i, p in enumerate(pages) if _ys(p, f"{label} Subtotal:")}
        assert sub_on, f"{label} subtotal missing"
        assert sub_on <= rows_on, f"{label} subtotal drifted off its table's page"


def test_a_section_too_tall_for_one_page_still_splits():
    """Keeping sections whole must not push a 70-row table onto a fresh page
    only to split it anyway — that wastes a page."""
    _, pages = _render(_doc([
        {"id": "s1", "label": "Labor", "items": _rows(6, "Crew")},
        {"id": "s2", "label": "Equipment", "items": _rows(70, "LED Par Wash")},
    ]))
    assert _ys(pages[0], "LED Par Wash"), "the long table should start on page 1"


# ── Widows ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("n", range(24, 46))
def test_a_split_never_strands_a_single_last_row(n):
    """Row counts that land the break one row from the end used to leave a
    lone row under a full table header on the next page."""
    _, pages = _render(_doc([{"id": "s1", "label": "Equipment",
                              "items": _rows(n, "LED Par Wash", adjusted_every=4)}]))
    carrying = [p for p in pages if _ys(p, "LED Par Wash")]
    if len(carrying) > 1:
        assert len(_ys(carrying[-1], "LED Par Wash")) >= 2, "widow row"


# ── The floor ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("n", [1, 5, 22, 23, 24, 25, 26, 40, 70])
def test_nothing_is_drawn_below_the_footer_floor(n):
    """Rows, subtotals, the totals block and the terms all have to clear the
    footer, whatever row count pushes them up against it."""
    doc, pages = _render(_doc(
        [{"id": "s1", "label": "Labor", "items": _rows(n, "Crew", adjusted_every=3)},
         {"id": "s2", "label": "Fees", "items": _rows(3, "Fee")}],
        globalDiscount={"type": "percent", "value": 10}, qbTaxTotal=412.5,
        terms="\n".join(f"Term number {i} of the agreement." for i in range(1, 9)),
    ))
    for i, p in enumerate(pages):
        for x, y, t in _body_strings(p):
            assert y >= doc._floor - 0.5, f"page {i + 1}: {t!r} drawn at y={y}"


def test_the_totals_block_is_never_split_across_pages():
    """The reserve was 110pt for a block that needs 112 before a single
    optional row — a discount, adjustment or tax line pushed TOTAL: over the
    edge."""
    for n in range(18, 30):
        _, pages = _render(_doc(
            [{"id": "s1", "label": "Labor", "items": _rows(n, "Crew", adjusted_every=3)}],
            globalDiscount={"type": "percent", "value": 10}, qbTaxTotal=412.5,
        ))
        on = {i for i, p in enumerate(pages)
              for label in ("Subtotal:", "TOTAL:") if _ys_exact(p, label)}
        assert len(on) == 1, f"{n} rows: totals block split across pages {on}"


def test_terms_keep_their_heading_and_flow_onto_a_new_page():
    """A terms list longer than the page it starts on breaks per bullet
    instead of running off the bottom — and never leaves its heading alone."""
    doc, pages = _render(_doc(
        [{"id": "s1", "label": "Labor", "items": _rows(22, "Crew")}],
        terms="\n".join(f"Term number {i} of the agreement." for i in range(1, 41)),
    ))
    heading = [i for i, p in enumerate(pages) if "TERMS & CONDITIONS" in _texts(p)]
    assert len(heading) == 1
    assert _ys(pages[heading[0]], "Term number 1 "), "heading stranded from its list"
    drawn = sum(len(_ys(p, "Term number ")) for p in pages)
    assert drawn == 40, f"{drawn} of 40 terms drawn"
