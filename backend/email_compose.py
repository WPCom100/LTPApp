"""Shared email-composition primitives.

Brand constants, the masthead/shell HTML layout, body-paragraph rendering,
signature rendering, and view-URL helpers used by EVERY outbound email path:
crew requests/notifications (routes/crew.py), customer quote/invoice emails
(routes/email.py), and QuickBooks receipts (qbo_receipts.py).

Extracted here so all three import from one neutral module instead of the old
crew<->email import cycle (which forced function-body lazy imports). This module
depends on nothing under backend/routes, so there is no cycle to dodge.

The crew email shell and the customer email shell are deliberately the SAME
email_shell/render_masthead — one container, no divergence. tests/test_masthead_block.py
pins that, and render_masthead MUST stay in sync with theme.js (the Send-modal preview).
"""
import os
import re
from html import escape
from urllib.parse import urlparse

from backend import models


# Brand defaults — mirror data/settings.js (accentColor, logoUrl) so a themed
# email still renders before any Settings save. The self-hosted LTP avatar
# (_photo_fallback_url below) doubles as the signature photo fallback (kept in
# sync with theme.js window.LTP_SIGNATURE_PHOTO_FALLBACK).
_DEFAULT_ACCENT = "#EF5822"
# The exact brand orange, sampled from assets/logos — used for the masthead
# rule (so it color-matches the logo and reads as one shape) and the CTA button.
_BRAND_ORANGE = "#f15927"
_CTA_ORANGE = _BRAND_ORANGE
# Email logo: the trimmed linear lockup, served by the app itself at this path
# (no external dependency / dead URL). The absolute URL is built per-send from
# the app origin in _email_brand.
_LOGO_ASSET_PATH = "/assets/logos/luminary-masthead.png"

# Shared body-paragraph style — explicit font-family so template text renders
# identically everywhere (don't rely on inheritance across table boundaries,
# which some mail clients drop).
_BODY_P_STYLE = ("margin:0 0 14px;font-size:14px;line-height:1.6;color:#3d4852;"
                 "font-family:'Helvetica Neue',Helvetica,Arial,sans-serif")


def _fmt_iso_date(iso: str) -> str:
    try:
        from datetime import date
        y, m, d = (int(x) for x in (iso or "").split("-"))
        return date(y, m, d).strftime("%a, %b ") + str(d) + ", " + str(y)
    except Exception:
        return iso or ""


def _fmt_hhmm(t: str) -> str:
    try:
        hh, mm = (t or "").split(":")[:2]
        hh = int(hh)
        return f"{hh % 12 or 12}:{mm} {'AM' if hh < 12 else 'PM'}"
    except Exception:
        return t or ""


def _safe_color(c: str, fallback: str) -> str:
    """Only let a #-hex color into inline styles (defense in depth — the value
    is admin-set in Settings and email_html also sanitizes CSS, but validating
    here keeps a malformed value from quietly breaking the layout)."""
    c = (c or "").strip()
    return c if re.match(r"^#[0-9a-fA-F]{3,8}$", c) else fallback


def _email_brand(settings_data: dict) -> dict:
    """Workspace branding for the themed crew-email masthead.

    The masthead deliberately uses the dedicated linear lockup
    (assets/logos/luminary-masthead.png) — NOT settings.logoUrl. logoUrl is the
    full-size company logo (PDFs, portal, etc.); the crew masthead is its own
    treatment (mask + horizontal rule). Quote/invoice emails share this same
    masthead/container (email.py wraps them in email_shell); their {{header}}
    action box is generated per type by theme.js::LTP_renderHeader.
    """
    return {
        "accent": _safe_color(settings_data.get("accentColor"), _DEFAULT_ACCENT),
        "logo": (_app_origin() or "") + _LOGO_ASSET_PATH,
        "company": (settings_data.get("companyName") or "").strip() or "Luminary Technology & Productions",
        "website": (settings_data.get("website") or "").strip(),
    }


def _paragraphs_to_html(text: str, blocks: dict | None = None) -> str:
    """Plain-text body → HTML. Blank lines split paragraphs; text is escaped.
    A paragraph that is *exactly* a block token (e.g. "{{shifts}}") is emitted
    as that block's HTML — a sibling, NOT wrapped in <p>. That avoids both the
    invalid table-inside-<p> the sanitizer would hoist apart AND the empty
    <p></p> gaps it left behind, which made spacing look inconsistent above vs.
    below the header. Inline tokens (a token mid-sentence) are still substituted."""
    blocks = blocks or {}
    out = []
    for para in (text or "").split("\n\n"):
        p = para.strip()
        if p == "":
            continue
        if p in blocks:
            out.append(blocks[p])
            continue
        html_p = '<p style="' + _BODY_P_STYLE + '">' + escape(p).replace("\n", "<br>") + "</p>"
        for tok, frag in blocks.items():
            if tok in html_p:
                html_p = html_p.replace(tok, frag)
        out.append(html_p)
    return "".join(out)


def render_masthead(brand: dict) -> str:
    """Self-contained branded masthead block: the linear logo butting a 4px
    color-matched rule that begins at the mask's left edge (after a 31px spacer)
    and bleeds to the right edge. Rendered STRUCTURALLY by email_shell at the top
    of every email — the masthead is NOT a body token; a stray {{masthead}} left
    in a template body is stripped by email_shell, never substituted.

    The rule is the logo cell's OWN border-bottom (no separate row to leak a
    seam); border-collapse + font-size/line-height:0 kill the residual gap some
    email clients (Gmail) render below a scaled image; the img's -1px bottom
    margin adds overlap where clients keep it.

    MUST stay in sync with theme.js::window.LTP_renderMasthead (the Send-modal
    preview); tests/test_masthead_block.py pins both via substring checks.
    """
    company = escape(brand["company"])
    if brand["logo"]:
        logo = ('<img src="' + escape(brand["logo"]) + '" alt="' + company + '" width="380" '
                'style="display:block;border:0;width:100%;max-width:380px;height:auto;margin:0 0 -1px 0">')
    else:
        logo = ('<span style="display:inline-block;padding-bottom:6px;font-size:22px;font-weight:bold;'
                'color:' + _BRAND_ORANGE + ';letter-spacing:0.03em">' + company + '</span>')
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%"><tr>'
        '<td width="31" style="width:31px;font-size:0;line-height:0">&nbsp;</td>'
        '<td style="padding:26px 30px 0 0;border-bottom:4px solid ' + _BRAND_ORANGE + ';font-size:0;line-height:0">' + logo + '</td>'
        '</tr></table>'
    )


def email_shell(inner_html: str, brand: dict) -> str:
    """Wrap composed crew-email content in the themed, branded responsive
    layout (light canvas, centered 580px card, masthead, footer).

    The masthead is part of THIS layout (render_masthead below), NOT a body
    token — so any stray {{masthead}} in the content is dead. Strip it here so it
    can never render literally; this is the single door the crew + crew-notify
    paths go through (the customer path in routes/email.py strips it too)."""
    inner_html = (inner_html or "").replace("{{masthead}}", "")
    company = escape(brand["company"])
    footer = company + (('&nbsp;&nbsp;·&nbsp;&nbsp;' + escape(brand["website"])) if brand["website"] else "")
    # width:100% + max-width (NOT a fixed width:600px) so the card fills a phone
    # screen and stays centered — a hard 600px overflows and looks off-center.
    return (
        '<div style="background-color:#f1f3f5;padding:24px 10px;'
        "font-family:'Helvetica Neue',Helvetica,Arial,sans-serif\">"
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f1f3f5">'
        '<tr><td align="center">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        'style="width:100%;max-width:580px;background-color:#ffffff;border:1px solid #e6e8eb;border-radius:14px">'
        '<tr><td style="padding:0">' + render_masthead(brand) + '</td></tr>'
        '<tr><td style="padding:22px 30px 26px">' + inner_html + '</td></tr>'
        '</table>'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:580px">'
        '<tr><td style="padding:16px 28px 4px;text-align:center;font-size:11px;line-height:1.6;color:#9aa3ab">' + footer + '</td></tr>'
        '</table>'
        '</td></tr></table></div>'
    )


def _app_origin() -> str:
    """Public-facing origin (scheme + host) for view URLs in outbound mail.
    Pulled from LTP_OAUTH_REDIRECT_URI so we use the same canonical host
    Google was given for the OAuth callback. Falls back to empty string in
    local dev where the redirect URI isn't set — the frontend will handle
    a relative URL fine, but the email body shouldn't have one (clients
    can't follow `#/view/...` without a host)."""
    redirect = os.environ.get("LTP_OAUTH_REDIRECT_URI", "")
    if not redirect:
        return ""
    parsed = urlparse(redirect)
    return f"{parsed.scheme}://{parsed.netloc}"


def _build_view_url(entity_type: str, share_token: str, tracking_token: str) -> str:
    """Per-recipient client view URL. The `?r=` query param is what the
    backend's view route uses to attribute opens to a specific recipient."""
    origin = _app_origin()
    return f"{origin}/#/view/{entity_type}/{share_token}?r={tracking_token}"


def _render_signature(
    user: models.User,
    settings_data: dict,
) -> str:
    """Apply the workspace signature template against the sender's profile.
    Returns the rendered HTML (or empty string if no template configured).
    Substitutes {{userName}}, {{userEmail}}, {{userTitle}}, {{userPhone}},
    {{userPhoto}}.
    User fields are HTML-escaped BEFORE substitution as defense in depth
    — the email body goes through bleach sanitization downstream too,
    but escaping here ensures a future refactor that drops one of those
    layers doesn't open an XSS hole.

    Falls back to _FALLBACK_SIGNATURE when the workspace hasn't
    customized a template. Reason: data/settings.js ships a rich default
    that lives only in the frontend's merged config — it's not in the DB
    until an admin clicks Save in Settings. Without this fallback, the
    first send from a fresh deploy would substitute {{signature}} with
    "" and the recipient would see the body abruptly end.

    The fallback string MUST match data/settings.js::emailSignatureTemplate
    byte-for-byte so the Send-modal preview (which reads the frontend
    config) shows the same signature the recipient gets. Any change to
    one MUST be mirrored in the other; tests/test_polish_pass_signature_html.py
    pins both via substring checks."""
    template = (settings_data.get("emailSignatureTemplate") or "").strip()
    if not template:
        template = _FALLBACK_SIGNATURE
    # {{userPhoto}} resolves to the user's Google profile picture, with
    # the LTP logo as a fallback when picture_url is empty (rare —
    # Google OAuth users almost always have one, but a User row that
    # pre-dates the OAuth scope grant could be photo-less). We escape
    # picture_url too even though it's controlled by Google; an attacker
    # who managed to inject HTML there would still be neutered.
    photo_url = (user.picture_url or "").strip() or _photo_fallback_url()
    return (
        template
        .replace("{{userPhoto}}", escape(photo_url))
        .replace("{{userName}}", escape(user.name or ""))
        .replace("{{userEmail}}", escape(user.email or ""))
        .replace("{{userTitle}}", escape(user.title or ""))
        .replace("{{userPhone}}", escape(user.phone or ""))
    )


# Signature avatar shown when the signed-in user has no Google profile picture
# (rare). Served by the app itself (like the masthead logo), NOT the marketing
# site: the old marketing-site URL (…/wp-content/uploads/…/LTP-Logo-Stacked.png)
# started returning 404, so every fallback signature carried a broken image —
# which looks unprofessional AND is a deliverability penalty (mail-tester flags
# broken links; broken images read as spammy to filters). Self-hosting it means
# it can't break when the marketing site reorganizes.
#
# Absolute URL (built from the app origin) because email clients can't resolve a
# relative src; empty origin in local dev degrades exactly like the masthead.
# MUST stay in sync with theme.js (window.LTP_SIGNATURE_PHOTO_FALLBACK) so the
# Send-modal preview renders the same image the recipient gets.
_AVATAR_ASSET_PATH = "/assets/logos/ltp-avatar.png"


def _photo_fallback_url() -> str:
    return (_app_origin() or "") + _AVATAR_ASSET_PATH


# Server-side fallback signature — must stay byte-identical to the
# data/settings.js default. When the DB has no emailSignatureTemplate
# value (fresh deploy, settings never saved, admin set it to ""), the
# Send pipeline renders this. Storing it here too means the recipient
# always sees a rich signature, never the truncated "...if you have any
# questions or would like to proceed." that motivated this fallback.
_FALLBACK_SIGNATURE = (
    '<table style="padding:0;margin:18px 0 0 0;border:none;border-collapse:collapse;max-width:100%">'
    '<tr><td style="padding:0 10px 0 0;vertical-align:top">'
    '<img alt="{{userName}}" height="120" '
    'src="{{userPhoto}}" width="120" '
    'style="display:block;border-radius:50%;object-fit:cover">'
    '</td><td style="border-left:3px solid #dddddd;padding:6px 0 0 14px;word-break:break-word;'
    "font-family:'verdana','geneva',sans-serif;font-size:12px;line-height:14px;color:#233038\">"
    '<div style="margin-bottom:10px"><strong>'
    '<span style="font-size:16px;color:#ef5822">{{userName}}</span>'
    '</strong><br>{{userTitle}}</div>'
    '<div style="margin-bottom:10px">'
    '<a href="mailto:{{userEmail}}" style="color:#233038;text-decoration:none" target="_blank">{{userEmail}}</a>'
    '<br>M:&nbsp;<a href="tel:{{userPhone}}" style="color:#233038;text-decoration:none" target="_blank">{{userPhone}}</a>'
    '</div>'
    '<div style="margin-bottom:10px">'
    '<span style="font-size:15px;color:#ef5822"><strong>Luminary Technology &amp; Productions</strong></span>'
    '<br>3786 Arapaho Rd.<br>Addison, TX 75001<br>'
    '<a href="https://LuminaryTechnology.Productions" style="color:#233038;text-decoration:none" target="_blank">LuminaryTechnology.Productions</a>'
    '</div>'
    '<div>'
    '<a href="https://www.facebook.com/profile.php?id=61563798680454" style="color:rgb(255,146,30);text-decoration:none;margin-right:6px" target="_blank">'
    '<img alt="facebook" height="18" src="https://storage.googleapis.com/signaturesatori/icons/cf/16/ff6633/facebook.png" width="18" style="vertical-align:middle">'
    '</a>'
    '<a href="https://www.instagram.com/luminarytechnologyproductions/" style="color:rgb(255,146,30);text-decoration:none" target="_blank">'
    '<img alt="instagram" height="18" src="https://storage.googleapis.com/signaturesatori/icons/cf/16/ff6633/instagram.png" width="18" style="vertical-align:middle">'
    '</a></div></td></tr></table>'
)
