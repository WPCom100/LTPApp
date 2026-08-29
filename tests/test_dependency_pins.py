"""Dependency declarations and pinned CDN assets.

Two failure modes this locks down, both of which are silent until production:

  1. An UNDECLARED direct import. backend/gmail.py, quickbooks.py,
     routes/auth.py and routes/scan.py all `import httpx`, but httpx reached
     the container only because fastapi[standard] happened to pull it in.
     The day that extra's contents change, every Gmail send, QuickBooks call,
     OAuth avatar fetch and receipt scan ImportErrors at boot — and
     requirements.txt gives no hint why, because it never mentioned httpx.

  2. A CDN <script> whose SRI hash stops matching its URL. index.html loads
     React, DOMPurify and signature_pad from cdnjs with `integrity=`. If
     someone bumps the version in the URL and forgets the hash, the browser
     refuses to execute the script — and for DOMPurify that means
     LTP_SANITIZE falls back to text-only rendering (components/sanitize.js),
     so every rich-text note in the app silently renders as escaped markup.
     These tests check shape only; they never reach the network.

Runs under pytest or standalone:
    python tests/test_dependency_pins.py
"""
from __future__ import annotations

import ast
import os
import re
import sys

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)

REQUIREMENTS = os.path.join(_root, "requirements.txt")
INDEX_HTML = os.path.join(_root, "index.html")


# ── requirements.txt ↔ direct imports ──────────────────────────────────────

def _declared_distributions() -> set[str]:
    """Distribution names in requirements.txt, normalised and extras stripped.

    `fastapi[standard]==0.115.12` -> `fastapi`. Comment lines and the
    "Removed (re-add when needed)" block are skipped — a commented-out line
    is documentation, not a declaration."""
    names: set[str] = set()
    with open(REQUIREMENTS, encoding="utf-8") as fh:
        for line in fh:
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            dist = re.split(r"[\[=<>!~;]", line, 1)[0].strip()
            if dist:
                names.add(dist.lower().replace("_", "-"))
    return names


# A distribution's import name is not always its package name. Only mappings
# that actually apply to this repo's imports belong here.
_IMPORT_TO_DIST = {
    "alembic": "alembic",
    "sqlalchemy": "sqlalchemy",
    "authlib": "authlib",
    "reportlab": "reportlab",
    "pywebpush": "pywebpush",
    "py_vapid": "pywebpush",       # installed by pywebpush
    "dateutil": "python-dateutil",
}


def _third_party_imports() -> dict[str, set[str]]:
    """Every top-level module backend/ imports that is neither stdlib nor ours.

    Returns {module: {files that import it}} so a failure names the caller."""
    stdlib = set(sys.stdlib_module_names)
    found: dict[str, set[str]] = {}
    for dirpath, dirnames, filenames in os.walk(os.path.join(_root, "backend")):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for fn in filenames:
            if not fn.endswith(".py"):
                continue
            path = os.path.join(dirpath, fn)
            rel = os.path.relpath(path, _root)
            with open(path, encoding="utf-8") as fh:
                tree = ast.parse(fh.read(), filename=rel)
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    mods = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom):
                    # level > 0 is a relative import — always ours.
                    if node.level or not node.module:
                        continue
                    mods = [node.module]
                else:
                    continue
                for mod in mods:
                    top = mod.split(".", 1)[0]
                    if top in stdlib or top == "backend" or top.startswith("_"):
                        continue
                    found.setdefault(top, set()).add(rel)
    return found


def test_every_direct_backend_import_is_declared():
    declared = _declared_distributions()
    imports = _third_party_imports()
    missing = []
    for mod, files in sorted(imports.items()):
        dist = _IMPORT_TO_DIST.get(mod, mod).lower().replace("_", "-")
        if dist not in declared:
            missing.append(f"{mod} (dist {dist!r}) imported by {', '.join(sorted(files))}")
    assert not missing, (
        "backend imports these but requirements.txt does not declare them — they "
        "are reaching the container only as somebody else's transitive dependency:\n  "
        + "\n  ".join(missing))


def test_httpx_is_declared_not_merely_transitive():
    """The specific regression that motivated the guard above. Kept explicit so
    a change to _IMPORT_TO_DIST or the walk can't quietly stop covering it."""
    assert "httpx" in _declared_distributions(), \
        "httpx is imported directly by four backend modules; it must be pinned"
    users = _third_party_imports().get("httpx", set())
    assert len(users) >= 4, f"expected >=4 direct httpx importers, found {sorted(users)}"


def test_requirements_are_fully_pinned():
    """Every declaration is `==`. A floating range means two deploys of the same
    commit can install different code."""
    unpinned = []
    with open(REQUIREMENTS, encoding="utf-8") as fh:
        for i, line in enumerate(fh, 1):
            stripped = line.split("#", 1)[0].strip()
            if stripped and "==" not in stripped:
                unpinned.append(f"{REQUIREMENTS}:{i}: {stripped}")
    assert not unpinned, "unpinned requirement(s):\n  " + "\n  ".join(unpinned)


# ── CDN <script integrity> pins ────────────────────────────────────────────

_SCRIPT_RE = re.compile(
    r"<script\s+src=\"(?P<src>https://[^\"]+)\"(?P<rest>[^>]*)>", re.I)


def _cdn_scripts() -> list[dict]:
    with open(INDEX_HTML, encoding="utf-8") as fh:
        html = fh.read()
    out = []
    for m in _SCRIPT_RE.finditer(html):
        rest = m.group("rest")
        integrity = re.search(r'integrity="([^"]+)"', rest)
        out.append({
            "src": m.group("src"),
            "integrity": integrity.group(1) if integrity else None,
            "crossorigin": 'crossorigin="anonymous"' in rest,
            "line": html[: m.start()].count("\n") + 1,
        })
    return out


def test_every_cdn_script_has_sri_and_crossorigin():
    """SRI without crossorigin=anonymous is inert: the browser can't check the
    hash of an opaque response, so it just runs the script."""
    problems = []
    for s in _cdn_scripts():
        if not s["integrity"]:
            problems.append(f"index.html:{s['line']} {s['src']} has no integrity=")
        elif not s["integrity"].startswith(("sha256-", "sha384-", "sha512-")):
            problems.append(f"index.html:{s['line']} {s['src']} bad hash prefix: {s['integrity']}")
        if not s["crossorigin"]:
            problems.append(f"index.html:{s['line']} {s['src']} missing crossorigin=\"anonymous\"")
    assert not problems, "\n  ".join([""] + problems)
    assert _cdn_scripts(), "no CDN scripts found — the regex stopped matching"


def test_cdn_scripts_come_from_the_csp_allowed_host():
    """A script-src the CSP doesn't allow is blocked at runtime, and for
    DOMPurify that silently degrades every note to text-only rendering."""
    from backend.main import _CSP  # noqa: PLC0415
    for s in _cdn_scripts():
        host = s["src"].split("/")[2]
        assert host in _CSP, f"index.html:{s['line']} loads from {host}, absent from the CSP"


def test_dompurify_is_past_the_known_advisory_range():
    """DOMPurify < 3.3.2 is in the affected range for the 3.2.x mXSS advisory.
    components/sanitize.js is the only thing standing between a member-authored
    note and an admin's DOM, so the pin must stay ahead of it."""
    srcs = [s for s in _cdn_scripts() if "dompurify" in s["src"].lower()]
    assert len(srcs) == 1, f"expected exactly one DOMPurify tag, got {len(srcs)}"
    m = re.search(r"/dompurify/(\d+)\.(\d+)\.(\d+)/", srcs[0]["src"])
    assert m, f"cannot read a version out of {srcs[0]['src']}"
    version = tuple(int(g) for g in m.groups())
    assert version >= (3, 3, 2), (
        f"DOMPurify {'.'.join(map(str, version))} is at or below the advisory "
        "range; bump the URL and recompute the SRI hash")


def test_sri_hashes_are_distinct_per_script():
    """A copy-pasted tag that kept the previous file's hash fails closed in the
    browser (script blocked) — cheap to catch here instead."""
    seen: dict[str, str] = {}
    for s in _cdn_scripts():
        if not s["integrity"]:
            continue
        prev = seen.get(s["integrity"])
        assert prev is None, f"{s['src']} reuses the SRI hash of {prev}"
        seen[s["integrity"]] = s["src"]


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failures = 0
    for fn in tests:
        try:
            fn()
            print(f"  [PASS] {fn.__name__}")
        except AssertionError as e:
            failures += 1
            print(f"  [FAIL] {fn.__name__}: {e}")
    print(f"\n== {len(tests) - failures}/{len(tests)} checks passed ==")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.path.insert(0, _root)
    sys.exit(main())
