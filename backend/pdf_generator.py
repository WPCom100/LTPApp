"""LTP Quote/Invoice PDF Generator (library form).

Adapted from the original CLI script at assets/generate_quote_pdf.py.
Two material differences from the CLI version:

  1. Pure library — no __main__, no argparse, no file I/O. Caller passes a
     BytesIO buffer and pre-loaded entity/related-entity/settings dicts.
     The CLI is gone; the same renderer now powers two API endpoints.

  2. No /usr/share/fonts/ dependency. Both font families load from
     <project_root>/assets/fonts/ which we bundle:
       Saira ExtraCondensed (headings, large numbers)
       Roboto                (body text, line items)

The same template is used for both quotes and invoices. Pass kind="quote"
or kind="invoice"; only the reference label, date source, and terms-block
copy differ. Layout, colors, fonts, totals math, and section rendering are
identical between the two so the brand stays consistent.

Entry point:
    generate_pdf(buf, kind, entity, company, contact, project, settings, user_name)

All inputs are plain dicts (camelCase keys matching the frontend's shape).
None values are tolerated — every field has a sensible fallback so a
half-populated quote still renders.
"""
import os
import re
from datetime import datetime
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor, white
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader


# ── Brand palette (light theme) ─────────────────────────────────────────────
# The document renders on a WHITE page (see _bg), so every color below is
# chosen for legibility on white. Brand orange carries the headings/accents; a
# dark blue-gray "ink" (the brand's deep color) carries the body text. Contrast
# ratios on white are noted: all body/label text clears WCAG AA (≥4.5:1) and
# every orange heading is large enough (≥14pt bold / ≥18pt) to clear AA large
# text (≥3:1). Small orange figures use DEEP_ORANGE so they clear 4.5:1 too.
PAGE_BG        = white                 # the page itself
INK            = HexColor('#233038')   # primary text — ~12:1 on white
INK_SOFT       = HexColor('#52616B')   # secondary text / labels — ~6.4:1
MUTED          = HexColor('#6B7980')   # tertiary text (notes, email, struck) — ~4.5:1
LUMIN_ORANGE   = HexColor('#EF5822')   # brand orange — large headings & accents
DEEP_ORANGE    = HexColor('#C2410C')   # deeper orange — small emphasis text — ~5.2:1
SOFT_ORANGE    = HexColor('#F4C9AD')   # soft peach — section frame / light rule
ROW_STRIPE     = HexColor('#F6F3F0')   # faint warm zebra stripe for table rows
HAIRLINE       = HexColor('#E2E6E8')   # light separators / table rules

# ── Asset paths ─────────────────────────────────────────────────────────────
# Project root = two levels up from this file (backend/pdf_generator.py).
PROJECT_ROOT = os.path.realpath(os.path.dirname(os.path.dirname(__file__)))
ASSETS_DIR = os.path.join(PROJECT_ROOT, "assets")
FONTS_DIR = os.path.join(ASSETS_DIR, "fonts")
LOGOS_DIR = os.path.join(ASSETS_DIR, "logos")

# Font registration is global to reportlab — register once per process. The
# routes call generate_pdf many times; we use a module-level flag to avoid
# re-registering on every call (cheap but unnecessary).
_FONTS_REGISTERED = False


def _register_fonts():
    """Register Saira + Roboto fonts with reportlab. Idempotent: subsequent
    calls are no-ops. If a TTF is missing on disk (asset wasn't bundled),
    falls back to Helvetica so the renderer at least doesn't crash."""
    global _FONTS_REGISTERED
    if _FONTS_REGISTERED:
        return
    saira_map = {
        'SairaBlack':     'SairaExtraCondensed-Black.ttf',
        'SairaExtraBold': 'SairaExtraCondensed-ExtraBold.ttf',
        'SairaBold':      'SairaExtraCondensed-Bold.ttf',
        'SairaSemiBold':  'SairaExtraCondensed-SemiBold.ttf',
        'SairaMedium':    'SairaExtraCondensed-Medium.ttf',
        'SairaRegular':   'SairaExtraCondensed-Regular.ttf',
        'SairaLight':     'SairaExtraCondensed-Light.ttf',
    }
    roboto_map = {
        'Roboto':        'Roboto-Regular.ttf',
        'Roboto-Bold':   'Roboto-Bold.ttf',
        'Roboto-Light':  'Roboto-Light.ttf',
        'Roboto-Medium': 'Roboto-Medium.ttf',
    }
    for name, fname in {**saira_map, **roboto_map}.items():
        path = os.path.join(FONTS_DIR, fname)
        if os.path.isfile(path):
            try:
                pdfmetrics.registerFont(TTFont(name, path))
            except Exception:
                # Already registered (rare race) — ignore.
                pass
        # If the font file is missing, reportlab will fall back to the
        # built-in Helvetica when we drawString with the unregistered name
        # — it'll log to stderr but not crash. Acceptable degradation.
    _FONTS_REGISTERED = True


# Convenience alias table — the renderer references these short keys, the
# registered TTFs handle the heavy lifting.
FONTS = {
    'heading':    'SairaBlack',
    'subheading': 'SairaExtraBold',
    'body':       'SairaMedium',
    'body_light': 'SairaRegular',
    'bold':       'SairaBold',
    'semibold':   'SairaSemiBold',
}


# ── Helpers ────────────────────────────────────────────────────────────────

def _fmt_money(val):
    try:
        return f"${float(val):,.2f}"
    except (TypeError, ValueError):
        return "$0.00"


def _fmt_qty(val):
    """Render a quantity for display: whole numbers stay clean ('2'), genuine
    decimals keep their fractional part with trailing zeros trimmed ('2.5',
    '1.25'). Services can be billed in fractional units (e.g. 2.5 hours)."""
    try:
        f = float(val)
        if f == int(f):
            return str(int(f))
        # Up to 5 dp (QuickBooks' quantity precision), trailing zeros trimmed.
        return f"{f:.5f}".rstrip("0").rstrip(".")
    except (TypeError, ValueError, OverflowError):
        # Non-finite or non-numeric (NaN/Infinity/None) — fall back to str so a
        # pathological value never aborts PDF generation.
        return str(val)


def _fmt_date(iso_str):
    """ISO YYYY-MM-DD → 'May 30th, 2026'. Returns the original string on
    parse failure so we don't drop info."""
    if not iso_str:
        return ""
    try:
        d = datetime.strptime(iso_str, "%Y-%m-%d")
        day = d.day
        sfx = "th" if 11 <= day <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")
        return d.strftime(f"%B {day}{sfx}, %Y")
    except (ValueError, TypeError):
        return str(iso_str)


def _doc_ref(kind, entity):
    """Quote → 'Q-YYYY-NNN'. Invoice → 'INV-YYYY-NNN'. Year comes from the
    creation date when available, otherwise the current year."""
    if kind == "invoice":
        prefix = "INV"
        date_field = entity.get("invoiceDate") or entity.get("createdDate") or ""
    else:
        prefix = "Q"
        date_field = entity.get("createdDate") or entity.get("sentDate") or ""
    year = date_field[:4] if (isinstance(date_field, str) and len(date_field) >= 4) else str(datetime.now().year)
    eid = entity.get("id") or 0
    return f"{prefix}-{year}-{eid:03d}"


def _calc_totals(entity):
    """Compute subtotal / adjusted / discounted total / cost from sections.
    Mirrors the frontend's window.LTP_QUOTE_TOTALS implementation."""
    sub = adj = cost = 0
    for sec in entity.get("sections", []) or []:
        for it in sec.get("items", []) or []:
            if it.get("type") == "note":
                continue
            qty = it.get("qty", 0) or 0
            orig = (it.get("unitPrice", 0) or 0) * qty
            ap = it.get("adjustedPrice")
            a = (ap * qty) if ap is not None else orig
            sub += orig
            adj += a
            cost += (it.get("cost", 0) or 0) * qty
    after = adj
    gd = entity.get("globalDiscount", {}) or {}
    gt = gd.get("type", "none")
    gv = gd.get("value", 0) or 0
    if gt == "percent":
        after = adj * (1 - gv / 100)
    elif gt in ("amount", "flat"):   # "amount" is current; "flat" a legacy alias
        after = adj - gv
    elif gt == "target":
        after = gv
    after = max(after, 0)
    # QuickBooks-computed sales tax (invoices only; quotes carry none). The grand
    # total is tax-inclusive so the PDF matches the app + client view.
    tax_val = entity.get("qbTaxTotal")
    try:
        tax = float(tax_val) if tax_val is not None else 0.0
    except (TypeError, ValueError):
        tax = 0.0
    return {"subtotal": sub, "adjusted": adj, "preTax": after, "tax": tax,
            "total": after + tax, "cost": cost}


def _wrap_plain(text, font_name, font_size, max_w):
    """Wrap authored plain text into drawable lines, preserving its shape.

    Note line items are typed into a textarea, so blank lines, indentation and
    runs of spaces are part of what the author wrote. reportlab's `simpleSplit`
    collapses every whitespace run to a single space and ignores hard newlines,
    which flattens a bulleted/indented note into one paragraph — so we wrap by
    hand instead:

      * hard newlines always break; a blank line stays a blank line
      * leading indentation is preserved AND re-applied to continuation lines
        (hanging indent) so a wrapped bullet stays visually under its bullet
      * interior runs of spaces survive; the space at a wrap point does not
      * tabs expand to 4 columns
      * a single token wider than `max_w` is hard-broken by character rather
        than overflowing the column

    Returns a list of strings (possibly empty ones) ready for `drawString`.
    """
    src = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    out = []
    for raw in src.split("\n"):
        raw = raw.expandtabs(4)
        if not raw.strip():
            out.append("")
            continue
        stripped = raw.lstrip(" ")
        indent = " " * (len(raw) - len(stripped))
        cur = indent
        for tok in re.split(r"( +)", stripped):
            if not tok:
                continue
            if _sw(cur + tok, font_name, font_size) <= max_w:
                cur += tok
                continue
            if tok.strip() == "":
                # Wrapping AT a space run: the run is consumed by the break.
                out.append(cur.rstrip())
                cur = indent
                continue
            if cur.strip():
                out.append(cur.rstrip())
                cur = indent
            # Still too wide on a line of its own → break by character.
            while _sw(cur + tok, font_name, font_size) > max_w and len(tok) > 1:
                k = 1
                while k < len(tok) and _sw(cur + tok[:k + 1], font_name, font_size) <= max_w:
                    k += 1
                out.append(cur + tok[:k])
                tok = tok[k:]
                cur = indent
            cur += tok
        out.append(cur.rstrip())
    return out


def _sw(text, font_name, font_size):
    """stringWidth that tolerates a font that failed to register (the bundled
    TTFs are optional at import time — see _register_fonts)."""
    try:
        return pdfmetrics.stringWidth(text, font_name, font_size)
    except Exception:
        return len(text) * font_size * 0.5


def _draw_gradient(c, x, y, w, h):
    """Horizontal gradient: FF921E → EF5822 → 64260F (light orange to deep)."""
    cols = [(0xFF, 0x92, 0x1E), (0xEF, 0x58, 0x22), (0x64, 0x26, 0x0F)]
    steps = 80
    sw = w / steps
    for i in range(steps):
        t = i / (steps - 1)
        if t < 0.5:
            t2 = t * 2
            r = int(cols[0][0] + (cols[1][0] - cols[0][0]) * t2)
            g = int(cols[0][1] + (cols[1][1] - cols[0][1]) * t2)
            b = int(cols[0][2] + (cols[1][2] - cols[0][2]) * t2)
        else:
            t2 = (t - 0.5) * 2
            r = int(cols[1][0] + (cols[2][0] - cols[1][0]) * t2)
            g = int(cols[1][1] + (cols[2][1] - cols[1][1]) * t2)
            b = int(cols[1][2] + (cols[2][2] - cols[1][2]) * t2)
        c.setFillColor(HexColor(f"#{r:02x}{g:02x}{b:02x}"))
        c.rect(x + i * sw, y, sw + 1, h, fill=1, stroke=0)


def _contact_full_name(contact):
    if not contact:
        return ""
    fn = (contact.get("firstName") or contact.get("first_name") or "").strip()
    ln = (contact.get("lastName") or contact.get("last_name") or "").strip()
    return f"{fn} {ln}".strip()


def _company_address_line(settings):
    """Format settings street/suite/city/state/zip into a single address line.
    Empty fields are skipped so '3786 Arapaho Rd. Addison, TX 75001' renders
    cleanly even if Suite is unset."""
    if not settings:
        return ""
    parts = []
    street = (settings.get("street") or "").strip()
    suite = (settings.get("suite") or "").strip()
    city = (settings.get("city") or "").strip()
    state = (settings.get("state") or "").strip()
    zip_ = (settings.get("zip") or "").strip()
    if street:
        parts.append(street + (f", {suite}" if suite else ""))
    csz = ", ".join(p for p in [city, " ".join(p for p in [state, zip_] if p).strip()] if p)
    if csz:
        parts.append(csz)
    return ". ".join(parts)


def _client_address_line(party):
    """Single-line client billing address: '<street>  City, ST ZIP'. `party` is
    a company_dict or contact_dict — both carry address/city/state/zip. Empty
    fields are skipped so partial addresses still render cleanly."""
    if not party:
        return ""
    street = (party.get("address") or "").replace("\n", "  ").strip()
    city = (party.get("city") or "").strip()
    state = (party.get("state") or "").strip()
    zip_ = (party.get("zip") or "").strip()
    sz = " ".join(p for p in (state, zip_) if p)
    city_line = f"{city}, {sz}" if (city and sz) else (city or sz)
    return "  ".join(p for p in (street, city_line) if p)


# ── PDF Builder ────────────────────────────────────────────────────────────
class _DocPDF:
    """Renderer for one PDF. Single-use; instantiate per document. Holds the
    canvas, current y-cursor, and the bundle of related entity dicts. `kind`
    is "quote" or "invoice" — affects ref label, date source, and the
    terms-and-conditions block."""

    def __init__(self, buf, kind, entity, company, contact, project, settings, user_name):
        self.c = canvas.Canvas(buf, pagesize=letter)
        self.W, self.H = letter
        self.kind = kind if kind in ("quote", "invoice") else "quote"
        self.entity = entity or {}
        self.company = company or {}
        self.contact = contact or {}
        self.project = project or {}
        self.settings = settings or {}
        self.user_name = user_name or "Generated"
        self.M = 0.55 * inch
        self.y = self.H - self.M
        self.pg = 1
        self.content_w = self.W - 2 * self.M

    # ── Page chrome ────────────────────────────────────────────────────────
    def _bg(self):
        self.c.setFillColor(PAGE_BG)
        self.c.rect(0, 0, self.W, self.H, fill=1, stroke=0)

    def _footer(self):
        _draw_gradient(self.c, 0, 0, self.W, 5)
        self.c.setFont("Roboto-Light", 8)
        self.c.setFillColor(INK_SOFT)
        # Footer text from settings — falls back to LTP defaults so the
        # PDF still renders cleanly before someone fills in Settings.
        cname = self.settings.get("companyName") or "Luminary Technology & Productions"
        website = self.settings.get("website") or "luminarytechnology.productions"
        self.c.drawString(self.M, 14, f"{cname}  |  {website}")
        self.c.drawRightString(self.W - self.M, 14, f"Page {self.pg}")

    def _new_page(self):
        self.c.showPage()
        self.pg += 1
        self._bg()
        self._footer()
        self.y = self.H - self.M - 10

    def _need(self, h):
        """Page break if `h` more units of vertical space won't fit."""
        if self.y - h < self.M + 30:
            self._new_page()

    # ── Header ─────────────────────────────────────────────────────────────
    def _draw_header(self):
        c = self.c
        self._bg()
        self._footer()

        # Top gradient bar
        _draw_gradient(c, 0, self.H - 6, self.W, 6)

        # Logo + company name on same line
        logo_path = os.path.join(LOGOS_DIR, "primary.png")
        logo_top = self.H - 14
        text_offset = 16
        if os.path.isfile(logo_path):
            logo = ImageReader(logo_path)
            iw, ih = logo.getSize()
            target_h = 1.2 * inch
            scale = target_h / ih
            lw, lh = iw * scale, ih * scale
            logo_bottom = logo_top - lh
            c.drawImage(logo, self.M, logo_bottom, lw, lh, mask="auto")
            text_x = self.M + lw + 14
        else:
            text_x = self.M
            lh = 70
            logo_bottom = logo_top - lh

        cname = (self.settings.get("companyName") or "LUMINARY TECHNOLOGY & PRODUCTIONS").upper()
        name_y = logo_top - 20 - text_offset
        c.setFont(FONTS["heading"], 24)
        c.setFillColor(LUMIN_ORANGE)
        c.drawString(text_x, name_y, cname)

        # Address + phone + email under company name
        info_y = name_y - 16
        c.setFont("Roboto-Light", 9)
        c.setFillColor(INK_SOFT)
        addr = _company_address_line(self.settings)
        if addr:
            c.drawString(text_x, info_y, addr)
        phone = self.settings.get("phone") or ""
        email = self.settings.get("emailFrom") or ""
        contact_bits = [b for b in [phone, email] if b]
        if contact_bits:
            c.drawString(text_x, info_y - 12, "  |  ".join(contact_bits))

        self.y = logo_bottom - 24

        # Project name + doc ref on same line
        display = (
            self.project.get("name")
            or self.entity.get("customName")
            or ("Quote" if self.kind == "quote" else "Invoice")
        )
        ref_prefix = "Quote " if self.kind == "quote" else "Invoice "
        ref = ref_prefix + _doc_ref(self.kind, self.entity)

        c.setFont(FONTS["heading"], 22)
        c.setFillColor(INK)
        c.drawString(self.M, self.y, display.upper())
        c.setFillColor(LUMIN_ORANGE)
        c.drawRightString(self.W - self.M, self.y, ref)
        self.y -= 18

        # "Includes" line — a document can bill work for several projects (a
        # schedule sends its labor into any of the client's draft quotes /
        # invoices, whatever project that document started on). The title above
        # stays the PRIMARY project; this names every job covered, so the client
        # isn't reading line items for a job the header never mentions. Absent
        # for the single-project case, which is the overwhelming majority.
        # Names are resolved by the caller — routes/pdf.py, routes/view.py.
        project_names = [n for n in (self.entity.get("projectNames") or []) if n]
        if len(project_names) > 1:
            c.setFont("Roboto", 9)
            c.setFillColor(INK_SOFT)
            for line in _wrap_plain("Includes: " + ", ".join(project_names),
                                    "Roboto", 9, self.W - 2 * self.M):
                c.drawString(self.M, self.y, line)
                self.y -= 11
            self.y -= 3

        # Prepared for / Date generated
        company_name = self.company.get("name") or ""
        contact_name = _contact_full_name(self.contact)
        prepared_for = company_name or contact_name
        if prepared_for:
            c.setFont("Roboto-Bold", 11)
            c.setFillColor(INK)
            c.drawString(self.M, self.y, f"Prepared for: {prepared_for}")
        # Date label differs slightly between kinds
        date_label = "Invoice Date" if self.kind == "invoice" else "Date Generated"
        date_value = (
            self.entity.get("invoiceDate") if self.kind == "invoice"
            else (self.entity.get("createdDate") or self.entity.get("sentDate") or "")
        )
        c.setFont("Roboto", 10)
        c.setFillColor(INK_SOFT)
        c.drawRightString(self.W - self.M, self.y, f"{date_label}: {_fmt_date(date_value)}")
        self.y -= 14

        # Client address / Generated by. Use the billing party — company when
        # present, else the contact — so contact-billed invoices show an address
        # too, and the structured city/state/zip render alongside the street.
        client_addr = _client_address_line(self.company if company_name else self.contact)
        if client_addr:
            c.setFont("Roboto-Light", 10)
            c.setFillColor(INK_SOFT)
            c.drawString(self.M, self.y, client_addr.replace("\n", "  "))
        c.setFont("Roboto-Light", 10)
        c.setFillColor(INK_SOFT)
        gen_label = "Issued by" if self.kind == "invoice" else "Quoted by"
        c.drawRightString(self.W - self.M, self.y, f"{gen_label}: {self.user_name}")
        self.y -= 14

        # Contact name + title
        if contact_name and company_name:
            c.setFont("Roboto", 10)
            c.setFillColor(INK_SOFT)
            title = (self.contact.get("role") or "").strip()
            line = contact_name + (f"  —  {title}" if title else "")
            c.drawString(self.M, self.y, line)
            self.y -= 14
        # Contact email
        contact_email = (self.contact.get("email") or "").strip()
        if contact_email:
            c.setFont("Roboto-Light", 9)
            c.setFillColor(MUTED)
            c.drawString(self.M, self.y, contact_email)
            self.y -= 14

        self.y -= 10

    # ── Note line item ─────────────────────────────────────────────────────
    NOTE_FONT = "Roboto-Light"
    NOTE_SIZE = 9
    NOTE_LEADING = 12

    def _draw_note(self, txt, x):
        """Draw a note line item as a full-width caption, honoring the spacing
        and newlines the author typed in the builder's textarea.

        The body is laid out as a hanging indent: the "Note:" label sits in the
        gutter and every wrapped line — including the first — starts at the same
        x, so a multi-line note reads as one block. Each line gets its own page-
        break check, so a long note flows onto the next page instead of running
        off the bottom (the old renderer truncated at 110 characters)."""
        c = self.c
        label = "Note: "
        label_w = _sw(label, self.NOTE_FONT, self.NOTE_SIZE)
        body_x = x + label_w
        max_w = (self.W - self.M - 10) - body_x
        lines = _wrap_plain(txt, self.NOTE_FONT, self.NOTE_SIZE, max_w) or [""]
        for i, ln in enumerate(lines):
            self._need(self.NOTE_LEADING + 4)
            c.setFont(self.NOTE_FONT, self.NOTE_SIZE)
            c.setFillColor(MUTED)
            if i == 0:
                c.drawString(x, self.y - 10, label)
            if ln:
                c.drawString(body_x, self.y - 10, ln)
            self.y -= self.NOTE_LEADING
        self.y -= 4   # breathing room before the next row / next note

    # ── Section ────────────────────────────────────────────────────────────
    def _draw_section(self, sec):
        c = self.c
        label = sec.get("label", "Section")
        all_items = sec.get("items", []) or []

        col = {
            "item": self.M + 10,
            "qty":  self.W - self.M - 230,
            "unit": self.W - self.M - 150,
            "total": self.W - self.M - 10,
        }

        # Section subtotal comes from priced lines only (notes carry no amount).
        sec_total = 0
        for it in all_items:
            if it.get("type") == "note":
                continue
            qty = it.get("qty", 0) or 0
            up = it.get("unitPrice", 0) or 0
            ap = it.get("adjustedPrice")
            eff = ap if ap is not None else up
            sec_total += eff * qty

        self._need(60)

        c.setFont(FONTS["heading"], 15)
        c.setFillColor(LUMIN_ORANGE)
        c.drawString(self.M, self.y - 12, label.upper())

        # Rental period for equipment sections
        has_equipment = any(it.get("type") == "equipment" for it in all_items)
        if has_equipment:
            sec_start = (sec.get("startDate") if sec.get("customDates") else None) \
                        or self.entity.get("customStartDate") or self.project.get("startDate", "")
            sec_end = (sec.get("endDate") if sec.get("customDates") else None) \
                      or self.entity.get("customEndDate") or self.project.get("endDate", "")
            if sec_start and sec_end:
                title_w = c.stringWidth(label.upper(), FONTS["heading"], 15)
                c.setFont("Roboto-Light", 9)
                c.setFillColor(INK_SOFT)
                c.drawString(self.M + title_w + 12, self.y - 12,
                             f"Rental Period: {_fmt_date(sec_start)} — {_fmt_date(sec_end)}")

        self.y -= 16
        box_top = self.y
        self.y -= 4

        # Column headers
        c.setFont("Roboto-Bold", 9)
        c.setFillColor(INK_SOFT)
        c.drawString(col["item"], self.y - 12, "ITEM")
        qty_center = col["qty"] + 15
        c.drawCentredString(qty_center, self.y - 12, "QTY")
        c.drawRightString(col["unit"] + 55, self.y - 12, "UNIT PRICE")
        c.drawRightString(col["total"], self.y - 12, "TOTAL")
        self.y -= 18

        # Header separator
        c.setStrokeColor(HAIRLINE)
        c.setLineWidth(0.5)
        c.line(self.M + 4, self.y, self.W - self.M - 4, self.y)
        self.y -= 3

        # Item + note rows, drawn in authored order so notes stay exactly where
        # they were placed in the builder (instead of collapsing to the bottom).
        # A separate stripe index keeps the zebra striping consistent across
        # priced rows; notes are full-width captions and don't take a stripe.
        stripe_i = 0
        for it in all_items:
            if it.get("type") == "note":
                self._draw_note(it.get("text", "") or it.get("name", "") or "",
                                col["item"])
                continue

            qty = it.get("qty", 0) or 0
            up = it.get("unitPrice", 0) or 0
            ap = it.get("adjustedPrice")
            eff = ap if ap is not None else up
            lt = eff * qty
            has_adj = ap is not None and ap != up
            row_h = 23 if has_adj else 19

            self._need(row_h + 4)
            row_bot = self.y - row_h

            if stripe_i % 2 == 0:
                c.setFillColor(ROW_STRIPE)
                c.rect(self.M + 1, row_bot, self.content_w - 2, row_h, fill=1, stroke=0)
            stripe_i += 1

            fs = 9
            vc = row_bot + (row_h - fs) / 2 + 1

            name = it.get("name", "") or ""
            rl = it.get("rentalLabel", "") or ""
            if rl and it.get("type") == "equipment":
                name = f"{name}  ({rl})"
            max_w = col["qty"] - col["item"] - 10
            c.setFont("Roboto", fs)
            while c.stringWidth(name, "Roboto", fs) > max_w and len(name) > 20:
                name = name[:-4] + "..."

            c.setFillColor(INK)
            c.drawString(col["item"], vc, name)

            c.setFont("Roboto", fs)
            c.setFillColor(INK)
            c.drawCentredString(qty_center, vc, _fmt_qty(qty))

            if has_adj:
                # Original price — muted strikethrough, upper part of row
                c.setFillColor(MUTED)
                c.setFont("Roboto-Light", 8)
                orig_str = _fmt_money(up)
                ow = c.stringWidth(orig_str, "Roboto-Light", 8)
                ox = col["unit"] + 55 - ow
                orig_y = row_bot + row_h * 0.62
                c.drawString(ox, orig_y, orig_str)
                c.setStrokeColor(MUTED)
                c.setLineWidth(0.5)
                c.line(ox, orig_y + 3, ox + ow, orig_y + 3)
                # Adjusted price — deep orange (small bold text → keep ≥4.5:1)
                c.setFont("Roboto-Bold", fs)
                c.setFillColor(DEEP_ORANGE)
                adj_y = row_bot + row_h * 0.22
                c.drawRightString(col["unit"] + 55, adj_y, _fmt_money(eff))
            else:
                c.setFillColor(INK)
                c.setFont("Roboto", fs)
                c.drawRightString(col["unit"] + 55, vc, _fmt_money(eff))

            c.setFont("Roboto-Bold", fs)
            c.setFillColor(INK)
            c.drawRightString(col["total"], vc, _fmt_money(lt))
            self.y -= row_h

        box_bottom = self.y

        # Section border
        c.setStrokeColor(SOFT_ORANGE)
        c.setLineWidth(0.75)
        c.rect(self.M, box_bottom, self.content_w, box_top - box_bottom, fill=0, stroke=1)

        # Section subtotal below
        self.y -= 4
        c.setFont("Roboto", 11)
        c.setFillColor(INK_SOFT)
        c.drawRightString(col["total"] - 80, self.y - 10, f"{label} Subtotal:")
        c.setFont("Roboto-Bold", 12)
        c.setFillColor(LUMIN_ORANGE)
        c.drawRightString(col["total"], self.y - 10, _fmt_money(sec_total))
        self.y -= 22

    # ── Totals ─────────────────────────────────────────────────────────────
    def _draw_totals(self):
        t = _calc_totals(self.entity)
        c = self.c
        self._need(110)

        xl = self.W - self.M - 220
        xv = self.W - self.M - 10

        self.y -= 12
        c.setStrokeColor(SOFT_ORANGE)
        c.setLineWidth(2)
        c.line(xl - 10, self.y, self.W - self.M, self.y)
        self.y -= 22

        c.setFont("Roboto", 12)
        c.setFillColor(INK_SOFT)
        c.drawString(xl, self.y, "Subtotal:")
        c.setFont("Roboto-Bold", 12)
        c.setFillColor(INK)
        c.drawRightString(xv, self.y, _fmt_money(t["subtotal"]))
        self.y -= 20

        diff = t["subtotal"] - t["adjusted"]
        if abs(diff) > 0.01:
            c.setFont("Roboto", 10)
            c.setFillColor(MUTED)
            c.drawString(xl, self.y, "Line Adjustments:")
            sign = "-" if diff > 0 else "+"
            c.drawRightString(xv, self.y, f"{sign}{_fmt_money(abs(diff))}")
            self.y -= 18

        gd = self.entity.get("globalDiscount", {}) or {}
        gt = gd.get("type", "none")
        disc = t["adjusted"] - t["preTax"]
        if gt != "none" and abs(disc) > 0.01:
            c.setFont("Roboto", 10)
            c.setFillColor(MUTED)
            lbl = f"Discount ({gd.get('value',0)}%)" if gt == "percent" else "Discount:"
            c.drawString(xl, self.y, lbl)
            c.drawRightString(xv, self.y, f"-{_fmt_money(disc)}")
            self.y -= 18

        # Sales tax (QuickBooks-computed; invoices only)
        if t["tax"] > 0.005:
            c.setFont("Roboto", 10)
            c.setFillColor(MUTED)
            c.drawString(xl, self.y, "Sales Tax:")
            c.drawRightString(xv, self.y, _fmt_money(t["tax"]))
            self.y -= 18

        # Grand total
        self.y -= 8
        c.setStrokeColor(LUMIN_ORANGE)
        c.setLineWidth(2)
        c.line(xl - 10, self.y, self.W - self.M, self.y)
        self.y -= 22
        c.setFont(FONTS["heading"], 20)
        c.setFillColor(LUMIN_ORANGE)
        c.drawString(xl, self.y, "TOTAL:")
        c.setFillColor(INK)
        c.drawRightString(xv, self.y, _fmt_money(t["total"]))
        self.y -= 28

    # ── Terms ──────────────────────────────────────────────────────────────
    def _draw_terms(self):
        self._need(70)
        c = self.c
        self.y -= 16

        c.setStrokeColor(HAIRLINE)
        c.setLineWidth(0.5)
        c.line(self.M, self.y + 6, self.W - self.M, self.y + 6)

        c.setFont(FONTS["subheading"], 11)
        c.setFillColor(LUMIN_ORANGE)
        c.drawString(self.M, self.y - 8, "TERMS & CONDITIONS")
        self.y -= 22

        if self.kind == "invoice":
            lines = [
                "Payment is due within 30 days of the invoice date unless otherwise specified.",
                "Late payments are subject to a 1.5% monthly finance charge.",
                "Please include the invoice reference number with your payment.",
            ]
        else:
            lines = [
                "This quote is valid for 30 days from the date of issue.",
                "Prices are subject to equipment availability at time of booking.",
                "All equipment rentals are subject to a damage waiver fee.",
                "Payment terms: 50% deposit upon acceptance, balance due prior to load-in.",
                "Cancellation within 72 hours of event may incur a 25% restocking fee.",
            ]
        c.setFont("Roboto-Light", 9)
        c.setFillColor(MUTED)
        for line in lines:
            c.drawString(self.M + 8, self.y, f"•  {line}")
            self.y -= 14

    # ── Generate ───────────────────────────────────────────────────────────
    def render(self):
        self._draw_header()
        for sec in self.entity.get("sections", []) or []:
            self._draw_section(sec)
        self._draw_totals()
        self._draw_terms()
        self.c.save()


# ── Public entry point ─────────────────────────────────────────────────────

def generate_pdf(buf, kind, entity, company=None, contact=None,
                 project=None, settings=None, user_name=""):
    """Render a PDF into `buf` (a BytesIO or any file-like).

    Args:
        buf:        Open binary buffer to write to.
        kind:       "quote" or "invoice". Default falls back to "quote".
        entity:     Quote or Invoice dict (camelCase keys from the API).
        company:    Company dict, or None.
        contact:    Contact dict (client contact), or None.
        project:    Project dict, or None.
        settings:   Settings dict (singleton), or None. Used for company
                    name / address / phone / website / emailFrom in the
                    header and footer.
        user_name:  Authenticated user's display name — appears as
                    "Quoted by:" or "Issued by:" in the header.

    Returns nothing; buf is positioned at end-of-PDF on return."""
    _register_fonts()
    doc = _DocPDF(buf, kind, entity, company, contact, project, settings, user_name)
    doc.render()


def doc_ref(kind, entity):
    """Exposed helper so routes can compute the filename without instantiating
    the renderer: e.g. `Q-2026-001.pdf` or `INV-2026-001.pdf`."""
    return _doc_ref(kind, entity)
