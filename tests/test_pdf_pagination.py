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
  - Either way a section crosses a break, the page it leaves says so at its
    foot, and the page it finishes on doesn't.
"""
import io
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.pdf_generator import _DocPDF, _register_fonts  # noqa: E402


# ── Canvas spy ─────────────────────────────────────────────────────────────

FOOTER_MARK = "  |  "     # "<company>  |  <website>" — the footer's left text
CONTINUES = "continues on the next page"


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
    """Everything on the page except what lives in the footer gutter by
    design: the two footer strings and the continues-on-the-next-page note."""
    return [(x, y, t) for x, y, t in page["strings"]
            if not (t.startswith("Page ") or FOOTER_MARK in t or CONTINUES in t)]


def _note(page):
    """The continues-on-the-next-page note on this page, or None."""
    hits = [(y, t) for _, y, t in page["strings"] if CONTINUES in t]
    assert len(hits) <= 1, f"more than one continuation note: {hits}"
    return hits[0] if hits else None


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


@pytest.mark.parametrize("n", [24, 27, 43, 62])
def test_a_continuation_header_never_opens_a_page_with_no_rows_under_it(n):
    """The repeated header is drawn from inside the page break, so it must
    never be the last thing on a page."""
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

@pytest.mark.parametrize("n", [23, 24, 25, 26, 27, 43])
def test_a_split_never_strands_a_single_last_row(n):
    """Row counts that land the break one row from the end used to leave a
    lone row under a full table header on the next page."""
    _, pages = _render(_doc([{"id": "s1", "label": "Equipment",
                              "items": _rows(n, "LED Par Wash", adjusted_every=4)}]))
    carrying = [p for p in pages if _ys(p, "LED Par Wash")]
    if len(carrying) > 1:
        assert len(_ys(carrying[-1], "LED Par Wash")) >= 2, "widow row"


# ── The floor ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("n", [1, 5, 23, 24, 26, 70])
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


@pytest.mark.parametrize("n", [14, 15, 16, 17])
def test_the_totals_block_clears_the_footer_when_it_lands_tight(n):
    """The reserve was 110pt for a block that needs 112 before a single
    optional row — and this one carries all three (line adjustments, a
    discount and sales tax), so it needs 166. At these row counts the block
    starts low enough that the difference decides whether TOTAL: lands on the
    page or in the footer."""
    doc, pages = _render(_doc(
        [{"id": "s1", "label": "Labor", "items": _rows(n, "Crew", adjusted_every=3)}],
        globalDiscount={"type": "percent", "value": 10}, qbTaxTotal=412.5,
    ))
    lines = ("Subtotal:", "Line Adjustments:", "Discount (10%)", "Sales Tax:", "TOTAL:")
    on = {i for i, p in enumerate(pages) for t in lines if _ys_exact(p, t)}
    assert len(on) == 1, f"totals block split across pages {on}"
    block = pages[on.pop()]
    for t in lines:
        ys = _ys_exact(block, t)
        assert ys, f"{t!r} missing from the totals block"
        assert ys[0] >= doc._floor, f"{t!r} drawn at y={ys[0]}, under the footer"


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


# ── "continues on the next page" ───────────────────────────────────────────

def test_a_pushed_section_says_so_on_the_page_it_left():
    """Transportation moving whole to page 2 leaves page 1 ending in blank
    space. Without a note at the foot, that blank space reads as the end of
    the document."""
    _, pages = _render(_q_2026_038())
    leaving = next(i for i, p in enumerate(pages) if _ys(p, "Crew "))
    note = _note(pages[leaving])
    assert note, "the page a section was pushed off needs the note"
    assert note[1] == f"Transportation {CONTINUES}"
    assert _ys(pages[leaving + 1], "Truck "), "and the rows land on the next one"


def test_a_split_section_says_so_on_every_page_it_crosses():
    _, pages = _render(_doc([{"id": "s1", "label": "Equipment",
                              "items": _rows(70, "LED Par Wash")}]))
    carrying = [p for p in pages if _ys(p, "LED Par Wash")]
    for p in carrying[:-1]:
        assert _note(p) and _note(p)[1] == f"Equipment {CONTINUES}"


@pytest.mark.parametrize("n", [3, 20, 25, 40, 70])
def test_the_note_never_appears_where_a_section_ends(n):
    _, pages = _render(_doc([{"id": "s1", "label": "Equipment",
                              "items": _rows(n, "LED Par Wash", adjusted_every=4)}]))
    ends_on = max(i for i, p in enumerate(pages) if _ys(p, "LED Par Wash"))
    assert _note(pages[ends_on]) is None, "the last page of a table promises more"
    for p in pages[ends_on + 1:]:
        assert _note(p) is None


def test_the_note_sits_in_the_gutter_between_the_content_and_the_footer():
    """It is drawn from inside a page break, after the page's content is laid
    out, so it has to live in space that no row can reach."""
    doc, pages = _render(_q_2026_038())
    noted = [p for p in pages if _note(p)]
    assert noted
    for p in noted:
        y = _note(p)[0]
        assert y < doc._floor, "the note belongs below the content floor"
        assert y > 25, "...and clear of the footer line at y=14"
        assert min(sy for _, sy, _ in _body_strings(p)) > y


def test_each_note_names_the_section_that_lands_on_the_next_page():
    """The note is never a bare "continued": it names its section, and the
    section it names is the one whose rows are actually overleaf. Covers both
    ways a section crosses — Transportation pushed whole, Equipment split."""
    prefix = {"Labor": "Crew ", "Transportation": "Truck ", "Equipment": "LED Par Wash"}
    _, pages = _render(_doc([
        {"id": "s1", "label": "Labor", "items": _rows(19, "Crew")},
        {"id": "s2", "label": "Transportation", "items": _rows(4, "Truck")},
        {"id": "s3", "label": "Equipment", "items": _rows(70, "LED Par Wash")},
    ]))
    noted = [(i, _note(p)[1]) for i, p in enumerate(pages) if _note(p)]
    assert len({t for _, t in noted}) >= 2, f"a push and a split should both be noted: {noted}"
    for i, text in noted:
        label = text[: -(len(CONTINUES) + 1)]
        assert label in prefix, f"note names no section: {text!r}"
        assert _ys(pages[i + 1], prefix[label]), f"page {i + 2} carries no {label} rows"


# ── The subtotal that makes the note honest ────────────────────────────────

@pytest.mark.parametrize("n", [23, 24, 26, 30, 43])
def test_a_subtotal_never_lands_on_a_page_without_its_table(n):
    """A subtotal breaking away on its own would arrive under no table, no
    repeated header and no note — the one break the note can't describe."""
    _, pages = _render(_doc([{"id": "s1", "label": "Equipment",
                              "items": _rows(n, "LED Par Wash", adjusted_every=4)}]))
    rows_on = {i for i, p in enumerate(pages) if _ys(p, "LED Par Wash")}
    sub_on = {i for i, p in enumerate(pages) if _ys(p, "Equipment Subtotal:")}
    assert sub_on and sub_on <= rows_on


@pytest.mark.parametrize("pad", [22, 23, 24, 25])
def test_a_subtotal_stays_with_a_table_that_ends_on_a_note(pad):
    """Same guarantee when the last line of a section is a note, which breaks
    per wrapped line rather than as a block."""
    items = _rows(pad, "Crew") + [
        {"type": "note", "text": "Crew calls are subject to the venue's load-in "
                                 "window and may shift by an hour either way "
                                 "once the schedule is locked.", "name": ""}]
    _, pages = _render(_doc([{"id": "s1", "label": "Labor", "items": items}]))
    rows_on = {i for i, p in enumerate(pages) if _ys(p, "Crew ")}
    sub_on = {i for i, p in enumerate(pages) if _ys(p, "Labor Subtotal:")}
    assert sub_on <= rows_on, "subtotal left its table"
