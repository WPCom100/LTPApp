"""Recipient parsing and validation for outbound email.

Threats this guards against
===========================
Email header injection. Without validation, an attacker (a logged-in LTP
user trying to use the app as an open relay, or a malicious admin
crafting templates) could supply a `to` field like:

    alice@biz.com\\r\\nBcc: attacker@evil.com

If we string-concatenate that into a `Bcc:` / `Cc:` header, the recipient
silently grows. The MIME library's `formataddr` would catch some of this,
but defense in depth: we reject anything containing CR, LF, `<`, `>`, or
other characters that have meaning in RFC 2822 headers.

We are NOT trying to be a fully RFC-5321-compliant address parser. We
deliberately use a strict subset:
  - exactly one `@`
  - local part: any non-whitespace, non-special char (letters, digits,
    `.+-_%~` are common; quoted local parts are rejected)
  - domain part: at least one `.`, no whitespace, no specials

This rejects some legal-but-exotic addresses (quoted local parts like
`"hello world"@example.com`, single-label domains, IP-literal domains).
A business-email feature doesn't need them; the safety win is worth it.
"""
import re

# - First char of local: alphanumeric or _ (no leading . or -)
# - Subsequent local chars: alphanumeric + a small set of standard punctuation
# - Domain: dot-separated labels of alphanumerics/hyphens, with a TLD
_EMAIL_RE = re.compile(
    r"^[A-Za-z0-9_]"
    r"[A-Za-z0-9._%+\-]*"
    r"@"
    r"[A-Za-z0-9]"
    r"[A-Za-z0-9.\-]*\.[A-Za-z]{2,}$"
)

# Characters NEVER allowed inside a single recipient address. CR/LF are
# the header-injection vectors; <>"\\ are MIME-mailbox specials. We do NOT
# include `,` or `;` here — those are legal SEPARATORS between addresses
# and the splitter handles them; if one survives inside a single address
# after splitting that means the address itself is malformed and the
# email regex below will reject it.
_BANNED_CHARS = re.compile(r"[\r\n<>\"\\]")


class RecipientError(ValueError):
    """Raised when the recipient string can't be parsed or is unsafe."""


def parse_recipients(raw: str | None, *, allow_empty: bool = True) -> list[str]:
    """Parse a `to` or `cc` field into a list of normalized addresses.

    Accepts comma- and semicolon-separated entries. Trims whitespace
    around each. Lowercases (mailboxes are case-insensitive in practice;
    SMTP delivery normalizes the domain). Deduplicates while preserving
    order so the first occurrence wins.

    Raises RecipientError on any unsafe character or unparseable address.
    Returns [] when allow_empty=True and the input is None or whitespace.
    """
    if raw is None or not raw.strip():
        if allow_empty:
            return []
        raise RecipientError("recipient field is empty")

    # Split on `,` AND `;` — both are common in user input
    parts = [p.strip() for p in re.split(r"[,;]", raw) if p.strip()]
    seen: set[str] = set()
    out: list[str] = []
    for p in parts:
        # Per-address banned-char check: CR/LF would let an attacker inject
        # a Bcc: line via the recipient field; angle brackets / quotes are
        # MIME-mailbox specials we never want in a bare address.
        if _BANNED_CHARS.search(p):
            raise RecipientError(
                f"recipient {p!r} contains forbidden characters "
                "(line breaks, angle brackets, quotes, or backslash)"
            )
        addr = p.lower()
        if not _EMAIL_RE.match(addr):
            raise RecipientError(f"invalid email address: {p!r}")
        if addr in seen:
            continue
        seen.add(addr)
        out.append(addr)
    return out


def validate_subject(raw: str | None) -> str:
    """Subject lines also get header-injection scrubbing. CR/LF in a
    Subject: header lets an attacker inject arbitrary headers below it
    (Bcc:, etc.). Strip them; collapse runs of whitespace to single
    spaces. A subject longer than 998 chars violates RFC 2822 line-
    length limits — we cap at 500 (well under that, well over real
    business subjects)."""
    if raw is None:
        return ""
    # Strip CR/LF entirely. Replace with space so word boundaries survive.
    cleaned = re.sub(r"[\r\n]+", " ", raw).strip()
    if len(cleaned) > 500:
        raise RecipientError("subject is too long (max 500 chars)")
    return cleaned
