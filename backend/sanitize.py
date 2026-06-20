"""HTML allowlist sanitization for outbound email bodies.

Where this fits in the trust chain
==================================
Email templates are admin-authored. The Send modal also lets the sender
override the subject/body per send. Both surfaces can carry HTML now
(commit 2 of the email feature). That means three places where stored
HTML could XSS or otherwise misbehave if rendered without scrubbing:

  1. The Send modal preview in the LTP app, where another LTP user
     viewing a template could be attacked by a malicious admin who
     authored it. Mitigated by the frontend's LTP_SANITIZE.emailHtml
     wrapper (DOMPurify) on every preview render.

  2. The Gmail message sent to the client. Gmail itself sanitizes
     received HTML, but we should still ship clean content — anything
     Gmail strips silently degrades the email for the recipient, and
     "ship hostile HTML to a client's inbox" is bad in its own right.

  3. The PUT /api/settings payload that persists the template. We
     sanitize before storage so that anything outside the allowlist is
     dropped at write time, not just at render time.

This module is the SERVER-SIDE authoritative layer — runs at both
template-save (PUT /api/settings) and send-time (POST /api/email/send).
The frontend's DOMPurify is a defense-in-depth UX safeguard; the server
never trusts client-supplied HTML.

Allowlist rationale
===================
The tag/attribute list below matches what a real-world business email
(quote follow-up, invoice receipt) actually uses — typography (h1-h4,
strong, em), structure (p, div, br, hr, ul/ol/li, table), and the
viewUrl anchor. We deliberately do NOT allow <script>, <iframe>,
<object>, <embed>, <form>, or anything that pulls execution. The
`style` attribute is allowed because business-email templates pasted
from Mailchimp/Stripo rely heavily on inline CSS, but bleach's CSS
sanitizer (via `tinycss2`) strips dangerous declarations like
`expression()`, `javascript:` URLs, `position: fixed`, etc.

`data:` URLs are NOT allowed on `<img src>`. Embedded base64 images
bloat the message and are usually a sign of an export from a graphical
editor; recommend hosting on the company's own server and using `https:`
URLs instead. Easy to revisit if business need arises.
"""
import bleach
from bleach.css_sanitizer import CSSSanitizer


ALLOWED_TAGS = frozenset({
    # Inline typography
    "b", "i", "u", "strong", "em", "span", "br", "small", "sub", "sup",
    # Block typography
    "p", "div", "h1", "h2", "h3", "h4", "blockquote", "hr",
    # Lists
    "ul", "ol", "li",
    # Tables (commonly used by marketing-tool exports for layout)
    "table", "thead", "tbody", "tfoot", "tr", "th", "td",
    # Links + images
    "a", "img",
})


# `*` keys apply to every tag. Per-tag entries layer on top of `*`.
ALLOWED_ATTRIBUTES = {
    "*": ["class", "style", "title", "align"],
    "a": ["href", "target", "rel"],
    "img": ["src", "alt", "width", "height"],
    "td": ["colspan", "rowspan", "valign"],
    "th": ["colspan", "rowspan", "valign", "scope"],
    "table": ["width", "border", "cellpadding", "cellspacing"],
}


# Anchor protocols. `mailto:` is included so signatures can hyperlink the
# sender's email; `tel:` for phone numbers. No `javascript:`, `data:`, or
# `vbscript:` — those are the classic XSS vectors.
ALLOWED_PROTOCOLS = frozenset({"http", "https", "mailto", "tel"})


# CSS properties bleach will let through inside style="" attributes. Bleach's
# css_sanitizer strips everything not on this list AND strips any property
# value containing `expression(`, `url(javascript:...)`, or other classic
# CSS-based XSS vectors regardless of property name.
_ALLOWED_CSS_PROPERTIES = (
    # Box / layout (but NOT `position` — keeps emails from overlapping app UI)
    "margin", "margin-top", "margin-bottom", "margin-left", "margin-right",
    "padding", "padding-top", "padding-bottom", "padding-left", "padding-right",
    "width", "height", "max-width", "min-width", "max-height", "min-height",
    "display", "vertical-align", "text-align", "float", "clear",
    "border", "border-top", "border-bottom", "border-left", "border-right",
    "border-color", "border-width", "border-style", "border-collapse",
    "border-spacing", "border-radius",
    # Typography
    "color", "background", "background-color", "background-image",
    "font", "font-family", "font-size", "font-weight", "font-style",
    "line-height", "letter-spacing", "text-decoration", "text-transform",
    "white-space",
)


_css_sanitizer = CSSSanitizer(allowed_css_properties=_ALLOWED_CSS_PROPERTIES)


def email_html(html: str) -> str:
    """Sanitize HTML for outbound email or stored email templates.

    Returns clean HTML. Drops disallowed tags entirely (their text content
    is preserved), strips disallowed attributes, rejects anchors with
    unsafe protocols, and runs `style=""` values through CSS allowlist
    sanitization. Idempotent — running the output through this function
    again is a no-op.

    Empty / whitespace input is preserved as-is; callers decide whether to
    treat that as an error or as "skip the HTML alternative."
    """
    if not html:
        return html
    return bleach.clean(
        html,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRIBUTES,
        protocols=ALLOWED_PROTOCOLS,
        css_sanitizer=_css_sanitizer,
        strip=True,  # drop disallowed tags rather than HTML-escape them
    )
