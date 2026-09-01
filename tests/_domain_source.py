"""Read the frontend's theme + domain layer as one source blob.

theme.js used to be a single 2,739-line file, and a dozen Python tests asserted
against its source text — `_read("theme.js")` then grepping for LTP_HEADER_CTA,
BLOCK_DETECT_RE, window.LTP_money and so on. Splitting it into
components/domain-*.js broke every one of those, because the symbols moved.

Rather than repoint each test at whichever fragment happens to hold its symbol
today (which would break again on the next move), they read the whole layer.
The file list comes from index.html, the same source of truth
tests/_load_domain.js uses on the JS side, so it cannot drift from what the
browser loads.
"""
import os
import re

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_HERE)


def domain_files() -> list[str]:
    """theme.js followed by every components/domain-*.js, in index.html order."""
    with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as fh:
        html = fh.read()
    srcs = re.findall(r'<script\s+src="([^"]+)"', html)
    out = [s for s in srcs
           if s == "theme.js" or re.fullmatch(r"components/domain-[\w-]+\.js", s)]
    if not out or out[0] != "theme.js":
        raise AssertionError(
            f"index.html: expected theme.js then components/domain-*.js, got {out!r}")
    return out


def domain_source() -> str:
    """Every domain file concatenated, in load order.

    Joined with newlines so a regex cannot accidentally match across a file
    boundary and so line-oriented assertions keep working."""
    parts = []
    for rel in domain_files():
        with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
            parts.append(fh.read())
    return "\n".join(parts)
