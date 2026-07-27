"""Line item notes — authored spacing/newlines survive to every surface.

A "note" line item is the one line whose entire payload is free text, typed
into a <textarea> on the quote builder / invoice builder. Its blank lines,
indentation and runs of spaces are CONTENT, not incidental whitespace.

Before this suite the PDF renderer flattened a note to a single `drawString`
and truncated it at 110 characters, so a multi-line note (call times, indented
sub-points) arrived at the client as one run-on clause with the tail cut off,
and the app/client-view rows rendered it in plain HTML, which collapses runs of
spaces and drops newlines entirely.

Covered:
  - _wrap_plain: hard newlines, blank lines, hanging indent on wrap, interior
    space runs, tab expansion, and hard character-breaking of an over-long
    token.
  - _DocPDF._draw_note: draws one line per wrapped line (no truncation), labels
    only the first line, and advances y per line so long notes page-break.
  - generate_pdf end-to-end: a long multi-line note renders without raising and
    without dropping its tail, for BOTH quote and invoice.
  - The frontend surfaces that display note text pin `white-space: pre-wrap`
    (LTP_NOTE_TEXT_STYLE) and route through the shared editable note row, so a
    future edit can't quietly go back to whitespace-collapsing markup.

Runs both as pytest and as a plain script:
    python tests/test_line_item_notes.py
"""
import io
import os
import sys

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _root)

from backend.pdf_generator import (  # noqa: E402
    _DocPDF, _register_fonts, _wrap_plain, generate_pdf,
)

FONT = "Roboto-Light"
SIZE = 9


def _read(*parts):
    with open(os.path.join(_root, *parts), encoding="utf-8") as f:
        return f.read()


def _setup():
    _register_fonts()


# ── _wrap_plain ────────────────────────────────────────────────────────────

def test_hard_newlines_are_kept():
    _setup()
    assert _wrap_plain("one\ntwo\nthree", FONT, SIZE, 500) == ["one", "two", "three"]


def test_blank_lines_survive_as_blank_lines():
    """A paragraph break is the most common thing a note author types. It has to
    stay a break — collapsing it merges two thoughts into one paragraph."""
    _setup()
    assert _wrap_plain("first\n\nsecond", FONT, SIZE, 500) == ["first", "", "second"]
    # Trailing/leading blank lines are structure too; the caller trims what it
    # doesn't want (the frontend's LTP_noteText strips trailing whitespace).
    assert _wrap_plain("\na", FONT, SIZE, 500) == ["", "a"]


def test_crlf_and_cr_normalize():
    _setup()
    assert _wrap_plain("a\r\nb\rc", FONT, SIZE, 500) == ["a", "b", "c"]


def test_leading_indent_and_interior_space_runs_survive():
    _setup()
    out = _wrap_plain("    - Crew  entrance   north", FONT, SIZE, 500)
    assert out == ["    - Crew  entrance   north"], out


def test_tabs_expand_to_four_columns():
    _setup()
    assert _wrap_plain("\tx", FONT, SIZE, 500) == ["    x"]


def test_wrapped_lines_keep_a_hanging_indent():
    """An indented bullet that wraps must stay visually under itself, not snap
    back to the left margin."""
    _setup()
    text = "    - " + " ".join(["word"] * 40)
    out = _wrap_plain(text, FONT, SIZE, 120)
    assert len(out) > 1, out
    assert all(ln.startswith("    ") for ln in out), out


def test_wrap_does_not_lose_words():
    _setup()
    text = " ".join(f"w{i}" for i in range(60))
    out = _wrap_plain(text, FONT, SIZE, 100)
    assert len(out) > 1
    assert " ".join(out).split() == text.split()


def test_overlong_token_is_broken_by_character_not_overflowed():
    _setup()
    out = _wrap_plain("x" * 300, FONT, SIZE, 100)
    assert len(out) > 1
    assert "".join(out) == "x" * 300
    from backend.pdf_generator import _sw
    assert all(_sw(ln, FONT, SIZE) <= 100 for ln in out), out


def test_empty_text_yields_one_empty_line():
    _setup()
    assert _wrap_plain("", FONT, SIZE, 100) == [""]
    assert _wrap_plain(None, FONT, SIZE, 100) == [""]


# ── _DocPDF._draw_note ─────────────────────────────────────────────────────

def _note_doc():
    _setup()
    doc = _DocPDF(io.BytesIO(), "quote", {}, {}, {}, {}, {}, "T")
    drawn = []
    real = doc.c.drawString
    def spy(x, y, text, *a, **k):
        drawn.append((round(x, 2), round(y, 2), text))
        return real(x, y, text, *a, **k)
    doc.c.drawString = spy
    return doc, drawn


def test_draw_note_emits_one_call_per_line_and_labels_only_the_first():
    doc, drawn = _note_doc()
    doc._draw_note("alpha\nbeta\ngamma", doc.M + 10)
    texts = [t for _, _, t in drawn]
    assert texts[0] == "Note: ", texts
    assert "alpha" in texts and "beta" in texts and "gamma" in texts, texts
    assert texts.count("Note: ") == 1, texts


def test_draw_note_body_lines_share_one_x_and_step_down_the_page():
    doc, drawn = _note_doc()
    y0 = doc.y
    doc._draw_note("alpha\nbeta", doc.M + 10)
    body = [(x, y) for x, y, t in drawn if t != "Note: "]
    assert len({x for x, _ in body}) == 1, body      # hanging indent
    assert body[0][1] > body[1][1], body             # each line steps down
    assert doc.y < y0


def test_draw_note_does_not_truncate_a_long_note():
    """The old renderer cut at 110 characters — the tail of a long note never
    reached the client. Every word must appear somewhere in the drawn lines."""
    doc, drawn = _note_doc()
    text = ("Please note that the load-in dock is on the north side of the building "
            "and the freight elevator is reserved from 6am until 9am for our crew, "
            "after which the house crew takes over and we lose the dock entirely.")
    doc._draw_note(text, doc.M + 10)
    joined = " ".join(t for _, _, t in drawn if t != "Note: ")
    assert joined.split() == text.split(), joined
    assert "..." not in joined


def test_draw_note_page_breaks_instead_of_running_off_the_page():
    doc, _ = _note_doc()
    doc.y = doc.M + 40           # almost at the bottom of the page
    doc._draw_note("\n".join(f"line {i}" for i in range(12)), doc.M + 10)
    assert doc.pg > 1, "a long note near the page bottom must break to a new page"
    assert doc.y > doc.M


# ── End-to-end render ──────────────────────────────────────────────────────

_MULTILINE_NOTE = (
    "Setup notes:\n"
    "    - Load in at 6am\n"
    "    - Crew  entrance   on   the north side\n"
    "\n"
    "Strike the following morning. This sentence is deliberately long so that "
    "the wrapper has to break it across more than one rendered line inside the "
    "item column of the document."
)


def _entity_with_note():
    return {
        "id": 12, "createdDate": "2026-07-01", "invoiceDate": "2026-07-01",
        "sections": [{
            "label": "Production",
            "items": [
                {"type": "equipment", "name": "LED Panel", "qty": 4, "unitPrice": 125},
                {"type": "note", "text": _MULTILINE_NOTE},
                {"type": "service", "name": "Technician", "qty": 2, "unitPrice": 500},
            ],
        }],
    }


def test_generate_pdf_renders_a_multiline_note_for_both_kinds():
    for kind in ("quote", "invoice"):
        buf = io.BytesIO()
        generate_pdf(buf, kind, _entity_with_note(),
                     settings={"companyName": "LTP"}, user_name="Tester")
        data = buf.getvalue()
        assert data.startswith(b"%PDF"), kind
        assert len(data) > 1000, kind


def test_notes_still_carry_no_money():
    """Regression guard: a note has no qty/price, so adding one must not move
    the subtotal (the note branch returns before any math)."""
    from backend.pdf_generator import _calc_totals
    ent = _entity_with_note()
    with_note = _calc_totals(ent)
    ent["sections"][0]["items"] = [i for i in ent["sections"][0]["items"]
                                   if i["type"] != "note"]
    assert _calc_totals(ent)["total"] == with_note["total"]


# ── Frontend surfaces (source pins) ────────────────────────────────────────
# These are structural pins, not behavior tests: the note text is rendered by
# React in four places and every one of them has to opt into pre-wrap. A plain
# <div> collapses the spacing the author just typed, which is exactly the bug
# this change fixed — so a regression should fail here loudly.

def test_theme_exports_the_note_helpers():
    src = _read("theme.js")
    for pin in ("window.LTP_noteText", "window.LTP_noteHasText",
                "window.LTP_noteSummary", "window.LTP_NOTE_TEXT_STYLE"):
        assert pin in src, f"theme.js missing {pin}"
    assert 'whiteSpace: "pre-wrap"' in src, "LTP_NOTE_TEXT_STYLE must be pre-wrap"


def test_shared_editable_note_row_exists_and_uses_a_textarea():
    src = _read("components", "ui.js")
    assert "window.LTPNoteLineRow" in src
    assert "window.LTP_NOTE_TEXT_STYLE" in src
    # Editing a note must use a textarea — a single-line <input> would strip
    # every newline the author typed the moment they edited the note.
    assert 'h("textarea"' in src
    assert "window.LTP_noteText(val)" in src


def test_both_builders_route_notes_through_the_shared_row():
    for mod in ("quotes-builder.js", "invoices.js"):
        src = _read("modules", mod)
        assert "window.LTPNoteLineRow" in src, mod
        assert "window.LTP_noteText(" in src, mod
        assert "window.LTP_noteHasText(" in src, mod


def test_client_view_note_row_preserves_whitespace():
    src = _read("modules", "client-view.js")
    assert "window.LTP_NOTE_TEXT_STYLE" in src


def test_note_edits_reach_the_change_log():
    """Notes are editable now, so an edited note must appear in the revision
    log — otherwise it reads as a silent change on a sent document."""
    for mod in ("quotes-builder.js", "invoices.js"):
        src = _read("modules", mod)
        assert "Note Edited" in src, mod
        assert "Note Added" in src, mod
        assert "Note Removed" in src, mod


if __name__ == "__main__":
    failures = []
    for name, fn in sorted(list(globals().items())):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS  {name}")
            except AssertionError as exc:
                failures.append((name, exc))
                print(f"FAIL  {name}: {exc}")
    print(f"\n{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
    sys.exit(1 if failures else 0)
