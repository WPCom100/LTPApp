"""CI guard: every root-level script index.html loads must be servable.

backend/main.py serves the project root through a deny-by-default allowlist
(_ALLOWED_TOP_LEVEL_FILES). A root-level file that index.html references but
that is NOT in the set does not 404 — it falls through to the SPA catch-all,
which answers with index.html as text/html. The browser then refuses to
execute it (Content-Security-Policy + X-Content-Type-Options: nosniff) and the
app white-screens on EVERY route, because the boot chain is a sequence of
plain <script> tags with no module system to report the gap.

That is exactly how /nav-registry.js shipped broken: it was added to
index.html and to the service worker's precache list, but not here. Nothing in
the JS suites could see it, because they load the files off disk.
"""
import os
import re

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


def _index_root_scripts():
    """Root-level <script src> values in index.html (no "/" in the path)."""
    html = _read("index.html")
    srcs = re.findall(r'<script[^>]+src="([^"]+)"', html)
    return {
        s for s in srcs
        if not s.startswith(("http://", "https://", "//")) and "/" not in s.lstrip("./")
    }


def _allowlist():
    main = _read("backend/main.py")
    block = re.search(r"_ALLOWED_TOP_LEVEL_FILES\s*=\s*\{(.*?)\}", main, re.S)
    assert block, "could not find _ALLOWED_TOP_LEVEL_FILES in backend/main.py"
    return set(re.findall(r'"([^"]+)"', block.group(1)))


def test_every_root_script_in_index_is_servable():
    missing = sorted(_index_root_scripts() - _allowlist())
    assert not missing, (
        "index.html loads these root-level files but backend/main.py's "
        "_ALLOWED_TOP_LEVEL_FILES does not list them, so they are served as "
        "index.html (text/html) and the app white-screens: " + ", ".join(missing)
    )


def test_allowlist_has_no_entries_that_do_not_exist():
    ghosts = sorted(f for f in _allowlist() if not os.path.exists(os.path.join(ROOT, f)))
    assert not ghosts, "allowlisted but absent from the repo: " + ", ".join(ghosts)


@pytest.mark.parametrize("name", sorted(_index_root_scripts()))
def test_root_script_is_precached_by_the_service_worker(name):
    """A boot-chain file left out of the precache list breaks offline launch."""
    sw = _read("sw.js")
    assert "'/%s'" % name in sw, (
        "%s is in index.html's boot chain but not in sw.js's precache list, so "
        "an installed PWA would launch offline without it" % name
    )
