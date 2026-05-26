#!/usr/bin/env python3
"""
LTP Quote PDF Generator v2
Full Blue-Out (#233038) background, Saira ExtraCondensed fonts, logo integration.

Usage:
  python3 generate_quote_pdf.py quote.json output.pdf [options]
  --fonts-dir    Directory with SairaExtraCondensed-*.ttf (default: assets/fonts)
  --logos-dir    Directory with primary.png / secondary.png (default: assets/logos)
  --company-name, --project-name, --contact-name, --start-date, --end-date
"""

import json, sys, os, argparse
from datetime import datetime
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor, white, black, Color
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader

# ── Brand Colors ────────────────────────────────────────────────────────────
BLUE_OUT       = HexColor('#233038')
LUMIN_ORANGE   = HexColor('#EF5822')
BACKUP_ORANGE  = HexColor('#F9B998')
FULL_UP_GRAY   = HexColor('#D1DBDA')
DRIFT_ORANGE   = HexColor('#64260F')
WHITE          = white

# ── Font Setup ──────────────────────────────────────────────────────────────
def setup_fonts(fonts_dir):
    mapping = {
        'SairaBlack':     'SairaExtraCondensed-Black.ttf',
        'SairaExtraBold': 'SairaExtraCondensed-ExtraBold.ttf',
        'SairaBold':      'SairaExtraCondensed-Bold.ttf',
        'SairaSemiBold':  'SairaExtraCondensed-SemiBold.ttf',
        'SairaMedium':    'SairaExtraCondensed-Medium.ttf',
        'SairaRegular':   'SairaExtraCondensed-Regular.ttf',
        'SairaLight':     'SairaExtraCondensed-Light.ttf',
    }
    for name, filename in mapping.items():
        path = os.path.join(fonts_dir, filename)
        if os.path.isfile(path):
            pdfmetrics.registerFont(TTFont(name, path))
        else:
            # Fallback
            pdfmetrics.registerFont(TTFont(name, '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf'))
    # Register Roboto for use inside section tables
    roboto_dir = '/usr/share/fonts/truetype/roboto/unhinted/RobotoTTF'
    roboto_map = {
        'Roboto':        'Roboto-Regular.ttf',
        'Roboto-Bold':   'Roboto-Bold.ttf',
        'Roboto-Light':  'Roboto-Light.ttf',
        'Roboto-Medium': 'Roboto-Medium.ttf',
    }
    for rname, rfile in roboto_map.items():
        rpath = os.path.join(roboto_dir, rfile)
        if os.path.isfile(rpath):
            pdfmetrics.registerFont(TTFont(rname, rpath))
    ri_path = '/usr/share/fonts/truetype/roboto/unhinted/Roboto-MediumItalic.ttf'
    if os.path.isfile(os.path.join(roboto_dir, 'Roboto-MediumItalic.ttf')):
        pdfmetrics.registerFont(TTFont('Roboto-Italic', os.path.join(roboto_dir, 'Roboto-MediumItalic.ttf')))

    return {
        'heading':    'SairaBlack',
        'subheading': 'SairaExtraBold',
        'body':       'SairaMedium',
        'body_light': 'SairaRegular',
        'bold':       'SairaBold',
        'semibold':   'SairaSemiBold',
    }

# ── Helpers ─────────────────────────────────────────────────────────────────
def fmt_money(val):
    return f"${val:,.2f}"

def fmt_date(iso_str):
    if not iso_str: return ""
    try:
        d = datetime.strptime(iso_str, "%Y-%m-%d")
        day = d.day
        sfx = "th" if 11 <= day <= 13 else {1:"st",2:"nd",3:"rd"}.get(day%10,"th")
        return d.strftime(f"%B {day}{sfx}, %Y")
    except: return iso_str

def quote_ref(q):
    yr = (q.get('createdDate') or '')[:4] or str(datetime.now().year)
    return f"Q-{yr}-{q['id']:03d}"

def calc_totals(q):
    sub = adj = cost = 0
    for sec in q.get('sections', []):
        for it in sec.get('items', []):
            if it.get('type') == 'note': continue
            qty = it.get('qty', 0)
            orig = (it.get('unitPrice', 0) or 0) * qty
            ap = it.get('adjustedPrice')
            a = (ap * qty) if ap is not None else orig
            sub += orig; adj += a
            cost += (it.get('cost', 0) or 0) * qty
    after = adj
    gd = q.get('globalDiscount', {})
    gt, gv = gd.get('type','none'), gd.get('value',0) or 0
    if gt == 'percent': after = adj * (1 - gv/100)
    elif gt == 'amount': after = adj - gv
    elif gt == 'target': after = gv
    return {'subtotal': sub, 'adjusted': adj, 'total': max(after,0), 'cost': cost}

# ── Gradient Drawing ────────────────────────────────────────────────────────
def draw_gradient(c, x, y, w, h, colors=None):
    """Horizontal gradient: FF921E → EF5822 → 64260F (left to right)"""
    cols = colors or [(0xFF,0x92,0x1E),(0xEF,0x58,0x22),(0x64,0x26,0x0F)]
    steps = 80
    sw = w / steps
    for i in range(steps):
        t = i / (steps - 1)
        if t < 0.5:
            t2 = t * 2
            r = int(cols[0][0] + (cols[1][0]-cols[0][0])*t2)
            g = int(cols[0][1] + (cols[1][1]-cols[0][1])*t2)
            b = int(cols[0][2] + (cols[1][2]-cols[0][2])*t2)
        else:
            t2 = (t-0.5)*2
            r = int(cols[1][0] + (cols[2][0]-cols[1][0])*t2)
            g = int(cols[1][1] + (cols[2][1]-cols[1][1])*t2)
            b = int(cols[1][2] + (cols[2][2]-cols[1][2])*t2)
        c.setFillColor(HexColor(f'#{r:02x}{g:02x}{b:02x}'))
        c.rect(x + i*sw, y, sw+1, h, fill=1, stroke=0)

# ── PDF Builder ─────────────────────────────────────────────────────────────
class QuotePDF:
    def __init__(self, out, quote, fonts, logos_dir, company_name="",
                 project_name="", contact_name="", contact_email="",
                 contact_title="", company_address="", project_dates=None):
        self.c = canvas.Canvas(out, pagesize=letter)
        self.W, self.H = letter
        self.q = quote
        self.f = fonts
        self.logos_dir = logos_dir
        self.company = company_name
        self.project = project_name
        self.contact = contact_name
        self.contact_email = contact_email
        self.contact_title = contact_title
        self.company_address = company_address
        self.dates = project_dates or {}
        self.M = 0.55 * inch  # margin
        self.y = self.H - self.M
        self.pg = 1
        self.content_w = self.W - 2 * self.M

    # ── Page management ─────────────────────────────────────────────────────
    def _bg(self):
        """Full page Blue-Out background"""
        self.c.setFillColor(BLUE_OUT)
        self.c.rect(0, 0, self.W, self.H, fill=1, stroke=0)

    def _footer(self):
        draw_gradient(self.c, 0, 0, self.W, 5)
        self.c.setFont('Roboto-Light', 8)
        self.c.setFillColor(FULL_UP_GRAY)
        self.c.drawString(self.M, 14, "Luminary Technology & Productions  |  luminarytechnology.productions")
        self.c.drawRightString(self.W - self.M, 14, f"Page {self.pg}")

    def new_page(self):
        self.c.showPage()
        self.pg += 1
        self._bg()
        self._footer()
        self.y = self.H - self.M - 10

    def need(self, h):
        if self.y - h < self.M + 30:
            self.new_page()

    # ── Header ──────────────────────────────────────────────────────────────
    def draw_header(self):
        c = self.c
        self._bg()
        self._footer()

        # Gradient bar at very top of page
        draw_gradient(c, 0, self.H - 6, self.W, 6)

        # ── Logo + Company name on the same line ────────────────────────────
        logo_path = os.path.join(self.logos_dir, 'primary.png')
        logo_top = self.H - 14  # logo sits tight to gradient bar
        text_offset = 16        # push text down to center on visible mask art
        if os.path.isfile(logo_path):
            logo = ImageReader(logo_path)
            iw, ih = logo.getSize()
            target_h = 1.2 * inch
            scale = target_h / ih
            lw, lh = iw * scale, ih * scale
            logo_bottom = logo_top - lh
            c.drawImage(logo, self.M, logo_bottom, lw, lh, mask='auto')
            text_x = self.M + lw + 14
        else:
            text_x = self.M
            lh = 70
            logo_bottom = logo_top - lh

        # Company name — pushed down by text_offset so it aligns with visible logo art
        name_y = logo_top - 20 - text_offset
        c.setFont(self.f['heading'], 24)
        c.setFillColor(LUMIN_ORANGE)
        c.drawString(text_x, name_y, "LUMINARY TECHNOLOGY & PRODUCTIONS")

        # Our address + phone + email — below company name
        info_y = name_y - 16
        c.setFont('Roboto-Light', 9)
        c.setFillColor(FULL_UP_GRAY)
        c.drawString(text_x, info_y, "3786 Arapaho Rd. Addison, TX 75001")
        c.drawString(text_x, info_y - 12, "(972) 246-8084  |  LTP@LuminaryTechnology.Productions")

        # Content starts below logo with 10px extra gap
        self.y = logo_bottom - 24

        # ── Project name + Quote ref on the same line ───────────────────────
        display = self.project or self.q.get('customName','') or 'Quote'
        ref = "Quote " + quote_ref(self.q)

        c.setFont(self.f['heading'], 22)
        c.setFillColor(WHITE)
        c.drawString(self.M, self.y, display.upper())

        c.setFont(self.f['heading'], 22)
        c.setFillColor(BACKUP_ORANGE)
        c.drawRightString(self.W - self.M, self.y, ref)
        self.y -= 18

        # ── Client info (left) + Date/Quoted by (right) on same lines ─────
        # Line 1: Prepared for / Date Generated
        if self.company:
            c.setFont('Roboto-Bold', 11)
            c.setFillColor(BACKUP_ORANGE)
            c.drawString(self.M, self.y, f"Prepared for: {self.company}")
        elif self.contact:
            c.setFont('Roboto-Bold', 11)
            c.setFillColor(BACKUP_ORANGE)
            c.drawString(self.M, self.y, f"Prepared for: {self.contact}")
        c.setFont('Roboto', 10)
        c.setFillColor(FULL_UP_GRAY)
        c.drawRightString(self.W - self.M, self.y, f"Date Generated: {fmt_date(self.q.get('createdDate',''))}")
        self.y -= 14

        # Line 2: Client address / Quoted by
        if self.company_address:
            c.setFont('Roboto-Light', 10)
            c.setFillColor(FULL_UP_GRAY)
            c.drawString(self.M, self.y, self.company_address)
        c.setFont('Roboto-Light', 10)
        c.setFillColor(FULL_UP_GRAY)
        c.drawRightString(self.W - self.M, self.y, "Quoted by: Landry Strickland")
        self.y -= 14

        # Line 3+: Contact name + title
        if self.contact and self.company:
            c.setFont('Roboto', 10)
            c.setFillColor(FULL_UP_GRAY)
            contact_line = self.contact
            if self.contact_title:
                contact_line += f"  —  {self.contact_title}"
            c.drawString(self.M, self.y, contact_line)
            self.y -= 14
        # Contact email
        if self.contact_email:
            c.setFont('Roboto-Light', 9)
            c.setFillColor(HexColor('#8899a0'))
            c.drawString(self.M, self.y, self.contact_email)
            self.y -= 14

        self.y -= 10

    # ── Section ─────────────────────────────────────────────────────────────
    def draw_section(self, sec):
        c = self.c
        label = sec.get('label', 'Section')
        items = [it for it in sec.get('items',[]) if it.get('type') != 'note']
        notes = [it for it in sec.get('items',[]) if it.get('type') == 'note']

        # Column positions
        col = {
            'item': self.M + 10,
            'qty':  self.W - self.M - 230,
            'unit': self.W - self.M - 150,
            'total': self.W - self.M - 10,
        }

        # Pre-calculate row data
        row_data = []
        sec_total = 0
        for it in items:
            qty = it.get('qty', 0)
            up = it.get('unitPrice', 0) or 0
            ap = it.get('adjustedPrice')
            eff = ap if ap is not None else up
            lt = eff * qty
            sec_total += lt
            has_adj = ap is not None and ap != up
            row_data.append({'it': it, 'qty': qty, 'up': up, 'eff': eff, 'lt': lt, 'has_adj': has_adj, 'h': 23 if has_adj else 19})

        self.need(60)

        # Section title in Back-Up Orange
        c.setFont(self.f['heading'], 15)
        c.setFillColor(BACKUP_ORANGE)
        c.drawString(self.M, self.y - 12, label.upper())

        # Rental period — only shown if section contains equipment items
        has_equipment = any(it.get('type') == 'equipment' for it in sec.get('items', []))
        if has_equipment:
            sec_start = sec.get('startDate','') if sec.get('customDates') else self.dates.get('start', self.q.get('customStartDate',''))
            sec_end = sec.get('endDate','') if sec.get('customDates') else self.dates.get('end', self.q.get('customEndDate',''))
            if sec_start and sec_end:
                title_w = c.stringWidth(label.upper(), self.f['heading'], 15)
                c.setFont('Roboto-Light', 9)
                c.setFillColor(FULL_UP_GRAY)
                c.drawString(self.M + title_w + 12, self.y - 12, f"Rental Period: {fmt_date(sec_start)} — {fmt_date(sec_end)}")

        self.y -= 16

        # Remember box top for border drawing
        box_top = self.y

        # Column headers inside box — 4px padding from box edge
        self.y -= 4
        c.setFont('Roboto-Bold', 9)
        c.setFillColor(FULL_UP_GRAY)
        c.drawString(col['item'], self.y - 12, 'ITEM')
        qty_center = col['qty'] + 15  # center point of qty column
        c.drawCentredString(qty_center, self.y - 12, 'QTY')
        c.drawRightString(col['unit'] + 55, self.y - 12, 'UNIT PRICE')
        c.drawRightString(col['total'], self.y - 12, 'TOTAL')
        self.y -= 18

        # Thin separator under column headers
        c.setStrokeColor(HexColor('#3a4a52'))
        c.setLineWidth(0.5)
        c.line(self.M + 4, self.y, self.W - self.M - 4, self.y)
        self.y -= 3

        # Item rows — Roboto font, vertically centered
        for i, rd in enumerate(row_data):
            it = rd['it']
            row_h = rd['h']
            self.need(row_h + 4)

            # Row spans from self.y down to self.y - row_h
            row_top = self.y
            row_bot = self.y - row_h

            # Alternating row bg
            if i % 2 == 0:
                c.setFillColor(HexColor('#2a3a42'))
                c.rect(self.M + 1, row_bot, self.content_w - 2, row_h, fill=1, stroke=0)

            # Vertical center baseline: for 9pt text
            fs = 9
            vc = row_bot + (row_h - fs) / 2 + 1

            # Name
            name = it.get('name', '')
            rl = it.get('rentalLabel', '')
            if rl and it.get('type') == 'equipment':
                name = f"{name}  ({rl})"
            max_w = col['qty'] - col['item'] - 10
            c.setFont('Roboto', fs)
            while c.stringWidth(name, 'Roboto', fs) > max_w and len(name) > 20:
                name = name[:-4] + '...'

            c.setFillColor(FULL_UP_GRAY)
            c.drawString(col['item'], vc, name)

            # Qty — centered horizontally and vertically
            c.setFont('Roboto', fs)
            c.setFillColor(WHITE)
            c.drawCentredString(qty_center, vc, str(rd['qty']))

            # Adjusted price rendering
            if rd['has_adj']:
                # Original price — muted strikethrough, upper third of row
                c.setFillColor(HexColor('#667777'))
                c.setFont('Roboto-Light', 8)
                orig_str = fmt_money(rd['up'])
                ow = c.stringWidth(orig_str, 'Roboto-Light', 8)
                ox = col['unit'] + 55 - ow
                orig_y = row_bot + row_h * 0.62
                c.drawString(ox, orig_y, orig_str)
                c.setStrokeColor(HexColor('#667777'))
                c.setLineWidth(0.5)
                c.line(ox, orig_y + 3, ox + ow, orig_y + 3)
                # New price — orange, lower third of row
                c.setFont('Roboto-Bold', fs)
                c.setFillColor(LUMIN_ORANGE)
                adj_y = row_bot + row_h * 0.22
                c.drawRightString(col['unit'] + 55, adj_y, fmt_money(rd['eff']))
            else:
                c.setFillColor(WHITE)
                c.setFont('Roboto', fs)
                c.drawRightString(col['unit'] + 55, vc, fmt_money(rd['eff']))

            c.setFont('Roboto-Bold', fs)
            c.setFillColor(BACKUP_ORANGE)
            c.drawRightString(col['total'], vc, fmt_money(rd['lt']))
            self.y -= row_h

        # Notes inside box
        for n in notes:
            self.need(16)
            c.setFont('Roboto-Light', 9)
            c.setFillColor(HexColor('#8899a0'))
            txt = n.get('text','')
            if len(txt) > 110: txt = txt[:107] + '...'
            c.drawString(col['item'], self.y - 10, f"Note: {txt}")
            self.y -= 14

        # Box ends flush with content (no extra padding)
        box_bottom = self.y

        # Draw thin Back-Up Orange border around the section content
        c.setStrokeColor(BACKUP_ORANGE)
        c.setLineWidth(0.75)
        c.rect(self.M, box_bottom, self.content_w, box_top - box_bottom, fill=0, stroke=1)

        # Section subtotal BELOW the box
        self.y -= 4
        c.setFont('Roboto', 11)
        c.setFillColor(FULL_UP_GRAY)
        c.drawRightString(col['total'] - 80, self.y - 10, f"{label} Subtotal:")
        c.setFont('Roboto-Bold', 12)
        c.setFillColor(LUMIN_ORANGE)
        c.drawRightString(col['total'], self.y - 10, fmt_money(sec_total))
        self.y -= 22

    # ── Totals ──────────────────────────────────────────────────────────────
    def draw_totals(self):
        t = calc_totals(self.q)
        c = self.c
        self.need(110)

        xl = self.W - self.M - 220
        xv = self.W - self.M - 10

        self.y -= 12
        # Double line
        c.setStrokeColor(BACKUP_ORANGE)
        c.setLineWidth(2)
        c.line(xl - 10, self.y, self.W - self.M, self.y)
        self.y -= 22

        # Subtotal
        c.setFont('Roboto', 12)
        c.setFillColor(FULL_UP_GRAY)
        c.drawString(xl, self.y, "Subtotal:")
        c.setFont('Roboto-Bold', 12)
        c.drawRightString(xv, self.y, fmt_money(t['subtotal']))
        self.y -= 20

        # Adjustments
        diff = t['subtotal'] - t['adjusted']
        if abs(diff) > 0.01:
            c.setFont('Roboto', 10)
            c.setFillColor(HexColor('#8899a0'))
            c.drawString(xl, self.y, "Line Adjustments:")
            sign = "-" if diff > 0 else "+"
            c.drawRightString(xv, self.y, f"{sign}{fmt_money(abs(diff))}")
            self.y -= 18

        # Global discount
        gd = self.q.get('globalDiscount', {})
        gt = gd.get('type', 'none')
        disc = t['adjusted'] - t['total']
        if gt != 'none' and abs(disc) > 0.01:
            c.setFont('Roboto', 10)
            c.setFillColor(HexColor('#8899a0'))
            lbl = f"Discount ({gd.get('value',0)}%)" if gt == 'percent' else "Discount:"
            c.drawString(xl, self.y, lbl)
            c.drawRightString(xv, self.y, f"-{fmt_money(disc)}")
            self.y -= 18

        # Grand total — clean line + bold text, no gradient bar
        self.y -= 8
        c.setStrokeColor(LUMIN_ORANGE)
        c.setLineWidth(2)
        c.line(xl - 10, self.y, self.W - self.M, self.y)
        self.y -= 22
        c.setFont(self.f['heading'], 20)
        c.setFillColor(LUMIN_ORANGE)
        c.drawString(xl, self.y, "TOTAL:")
        c.setFillColor(WHITE)
        c.drawRightString(xv, self.y, fmt_money(t['total']))
        self.y -= 28

    # ── Footer notes ────────────────────────────────────────────────────────
    def draw_notes(self):
        self.need(70)
        c = self.c
        self.y -= 16

        c.setStrokeColor(HexColor('#3a4a52'))
        c.setLineWidth(0.5)
        c.line(self.M, self.y + 6, self.W - self.M, self.y + 6)

        c.setFont(self.f['subheading'], 11)
        c.setFillColor(BACKUP_ORANGE)
        c.drawString(self.M, self.y - 8, "TERMS & CONDITIONS")
        self.y -= 22

        lines = [
            "This quote is valid for 30 days from the date of issue.",
            "Prices are subject to equipment availability at time of booking.",
            "All equipment rentals are subject to a damage waiver fee.",
            "Payment terms: 50% deposit upon acceptance, balance due prior to load-in.",
            "Cancellation within 72 hours of event may incur a 25% restocking fee.",
        ]
        c.setFont('Roboto-Light', 9)
        c.setFillColor(HexColor('#8899a0'))
        for line in lines:
            c.drawString(self.M + 8, self.y, f"•  {line}")
            self.y -= 14

    # ── Generate ────────────────────────────────────────────────────────────
    def generate(self):
        self.draw_header()
        for sec in self.q.get('sections', []):
            self.draw_section(sec)
        self.draw_totals()
        self.draw_notes()
        self.c.save()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('quote_json')
    p.add_argument('output_pdf')
    p.add_argument('--fonts-dir', default=None)
    p.add_argument('--logos-dir', default=None)
    p.add_argument('--company-name', default='')
    p.add_argument('--company-address', default='')
    p.add_argument('--project-name', default='')
    p.add_argument('--contact-name', default='')
    p.add_argument('--contact-email', default='')
    p.add_argument('--contact-title', default='')
    p.add_argument('--start-date', default='')
    p.add_argument('--end-date', default='')
    a = p.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    fonts_dir = a.fonts_dir or os.path.join(script_dir, 'fonts')
    logos_dir = a.logos_dir or os.path.join(script_dir, 'logos')

    with open(a.quote_json) as f:
        quote = json.load(f)

    fonts = setup_fonts(fonts_dir)
    dates = {}
    if a.start_date and a.end_date:
        dates = {'start': a.start_date, 'end': a.end_date}

    pdf = QuotePDF(a.output_pdf, quote, fonts, logos_dir,
                   company_name=a.company_name, project_name=a.project_name,
                   contact_name=a.contact_name, contact_email=a.contact_email,
                   contact_title=a.contact_title, company_address=a.company_address,
                   project_dates=dates)
    pdf.generate()
    print(f"PDF generated: {a.output_pdf}")

if __name__ == '__main__':
    main()
