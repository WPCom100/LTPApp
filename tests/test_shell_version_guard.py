"""Unit coverage for the CACHE_VERSION guard (tests/check_shell_version.py).

The guard's job is to fail a change that touches something the browser caches
without bumping sw.js's CACHE_VERSION. What it must NOT do is fail open: a guard
that quietly stops guarding — because backend/main.py's allowlist was renamed,
or sw.js's version line moved — is worse than no guard, because nobody notices.
So most of what is pinned here is the refusal behaviour.

The git plumbing is not exercised (CI drives that); these cover the pure
classification and parsing, including the two real regressions that motivated
the guard: theme.js and app.js are cached but were assumed not to be, because
index.html hadn't changed.

Runs both as pytest and as a plain script:
    python tests/test_shell_version_guard.py
"""
import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _here not in sys.path:
    sys.path.insert(0, _here)
if _root not in sys.path:
    sys.path.insert(0, _root)

import pytest  # noqa: E402

from check_shell_version import (  # noqa: E402
    GuardError,
    cache_version,
    is_shell_asset,
    served_allowlist,
    shell_assets,
)


def _real_allowlist():
    with open(os.path.join(_root, "backend", "main.py"), encoding="utf-8") as fh:
        return served_allowlist(fh.read())


# ── Reading the live sources ────────────────────────────────────────────────

def test_reads_the_real_allowlist_out_of_main():
    files, trees = _real_allowlist()
    # The boot chain the worker precaches — the files the two misses were about.
    for name in ("index.html", "app.js", "theme.js", "router.js", "mount.js"):
        assert name in files, name
    # Dedicated-route files the allowlist itself doesn't carry.
    assert "manifest.webmanifest" in files
    for prefix in ("components/", "modules/", "data/", "assets/"):
        assert prefix in trees, prefix


def test_reads_the_real_cache_version():
    with open(os.path.join(_root, "sw.js"), encoding="utf-8") as fh:
        version = cache_version(fh.read())
    assert version.startswith("ltp-shell-v"), version


# ── Classification ──────────────────────────────────────────────────────────

def test_cached_frontend_files_are_shell_assets():
    files, trees = _real_allowlist()
    # theme.js and app.js are precached: this is exactly the pair that shipped
    # unbumped because index.html hadn't changed.
    for path in (
        "theme.js",
        "app.js",
        "index.html",
        "manifest.webmanifest",
        "components/ui.js",
        "components/search-select.js",
        "modules/quotes-builder.js",
        "data/settings.js",
        "assets/fonts.css",
        "assets/icons/icon-192.png",
    ):
        assert is_shell_asset(path, files, trees), path


def test_server_side_and_tooling_files_are_not():
    files, trees = _real_allowlist()
    for path in (
        "backend/main.py",
        "backend/routes/api.py",
        "alembic/versions/2026_08_25_1200-e4f5a6b7c8d9_quote_expiry_date.py",
        # tests/*.js would match a naive "root-level .js" rule but is never served.
        "tests/test_utils.py",
        "tests/test_utils.js",
        "docs/SECURITY_REVIEW.md",
        ".github/workflows/tests.yml",
        "requirements.txt",
        "README.md",
    ):
        assert not is_shell_asset(path, files, trees), path


def test_sw_itself_is_never_the_trigger():
    # Otherwise the bump commit would demand a bump of its own, forever.
    files, trees = _real_allowlist()
    assert not is_shell_asset("sw.js", files, trees)


def test_shell_assets_filters_and_sorts():
    files, trees = _real_allowlist()
    got = shell_assets(
        ["backend/main.py", "theme.js", "README.md", "components/ui.js", "sw.js"],
        files,
        trees,
    )
    assert got == ["components/ui.js", "theme.js"]


# ── Failing closed ──────────────────────────────────────────────────────────
# Each of these is a way the guard could silently stop guarding. They must raise
# (the caller turns that into exit 2), never return something falsy that reads
# as "nothing to check here".

def test_missing_cache_version_raises():
    with pytest.raises(GuardError):
        cache_version("'use strict';\nvar SOMETHING_ELSE = 'x';\n")


def test_renamed_allowlist_raises():
    with pytest.raises(GuardError):
        served_allowlist('_SOMETHING_ELSE = {"index.html"}\n')


def test_partially_present_allowlist_raises():
    # One constant found, the other renamed — still unanswerable.
    with pytest.raises(GuardError):
        served_allowlist('_ALLOWED_TOP_LEVEL_FILES = {"index.html"}\n')


def test_non_literal_allowlist_raises():
    # Computed rather than spelled out: literal_eval can't read it, and guessing
    # would be worse than stopping.
    src = (
        '_ALLOWED_TOP_LEVEL_FILES = set(["index.html"])\n'
        '_ALLOWED_TREES = {"components/": (".js",)}\n'
    )
    with pytest.raises(GuardError):
        served_allowlist(src)


def test_empty_allowlist_raises():
    src = "_ALLOWED_TOP_LEVEL_FILES = set()\n_ALLOWED_TREES = {}\n"
    with pytest.raises(GuardError):
        served_allowlist(src)


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  [PASS] {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  [FAIL] {t.__name__}: {e}")
    print(f"\n== {len(tests) - failed}/{len(tests)} tests passed ==")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
