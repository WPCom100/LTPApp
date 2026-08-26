#!/usr/bin/env python3
"""CI guard: a change to anything the browser caches must bump CACHE_VERSION.

WHY THIS EXISTS
    Frontend filenames are un-versioned (/theme.js, /modules/quotes-builder.js),
    so sw.js's CACHE_VERSION is the sole cache-busting lever — see the header
    comment there. Two things go wrong when a change ships without bumping it:

      1. /sw.js is byte-identical, so no new worker installs and nobody is shown
         the "New version available — Refresh" banner.
      2. Every asset is stale-while-revalidate, so each device serves the whole
         PREVIOUS shell for one more launch and only picks up the new code on
         the launch after that.

    Both have happened. The trap is reading "bump on any shell change" as "did
    index.html change" — it usually hasn't, while theme.js and app.js (both
    precached) have.

WHAT COUNTS AS A SHELL CHANGE
    Anything the server actually serves to the browser, because the worker
    caches all of it: precached on install, or runtime stale-while-revalidate.
    That set is NOT restated here — it is read out of backend/main.py's
    `_ALLOWED_TOP_LEVEL_FILES` / `_ALLOWED_TREES` allowlist with `ast`, so a new
    served tree is covered the day it is added rather than the day someone
    remembers to update this file. Parsing failures are fatal, never a silent
    pass: a guard that quietly stops guarding is worse than no guard.

    sw.js itself is excluded — changing it IS the bump.

USAGE
    python tests/check_shell_version.py [base-ref]      # default: origin/master

    Exit 0 = fine (nothing cached changed, or the version moved with it).
    Exit 1 = cached files changed and CACHE_VERSION did not.
    Exit 2 = the guard could not evaluate the change (bad ref, parse failure).
"""
from __future__ import annotations

import ast
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Served by dedicated FastAPI routes rather than the allowlist, and precached by
# the worker, so they belong to the shell even though the ast parse won't see
# them. sw.js has its own route too but is deliberately absent — it is the file
# carrying the version.
_EXTRA_SERVED_FILES = frozenset({"manifest.webmanifest"})

_VERSION_RE = re.compile(r"""CACHE_VERSION\s*=\s*['"]([^'"]+)['"]""")


class GuardError(RuntimeError):
    """The guard cannot answer the question — always fatal, never a pass."""


# ── Reading the two sources of truth ────────────────────────────────────────

def cache_version(sw_source: str) -> str:
    """The CACHE_VERSION string out of a sw.js source."""
    m = _VERSION_RE.search(sw_source)
    if not m:
        raise GuardError("no CACHE_VERSION assignment found in sw.js")
    return m.group(1)


def served_allowlist(main_source: str) -> tuple[frozenset[str], tuple[str, ...]]:
    """backend/main.py's static allowlist, as (top-level files, tree prefixes).

    Parsed with `ast` rather than imported: importing backend.main builds the
    whole FastAPI app and wants env vars and a database, none of which a lint
    job should need.
    """
    try:
        tree = ast.parse(main_source)
    except SyntaxError as exc:                       # pragma: no cover - CI only
        raise GuardError(f"backend/main.py does not parse: {exc}") from exc

    found: dict[str, object] = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id in (
                "_ALLOWED_TOP_LEVEL_FILES",
                "_ALLOWED_TREES",
            ):
                try:
                    found[target.id] = ast.literal_eval(node.value)
                except ValueError as exc:
                    raise GuardError(
                        f"{target.id} in backend/main.py is no longer a literal "
                        f"this guard can read ({exc}). Teach it the new shape "
                        f"rather than deleting the check."
                    ) from exc

    missing = {"_ALLOWED_TOP_LEVEL_FILES", "_ALLOWED_TREES"} - set(found)
    if missing:
        raise GuardError(
            "could not find " + ", ".join(sorted(missing)) + " in backend/main.py. "
            "If the static allowlist moved or was renamed, point this guard at "
            "its new home — do not drop the check."
        )

    files = frozenset(found["_ALLOWED_TOP_LEVEL_FILES"]) | _EXTRA_SERVED_FILES
    trees = tuple(sorted(found["_ALLOWED_TREES"]))
    if not files or not trees:
        raise GuardError("the parsed static allowlist is empty — refusing to pass")
    return files, trees


# ── Classification ──────────────────────────────────────────────────────────

def is_shell_asset(path: str, files: frozenset[str], trees: tuple[str, ...]) -> bool:
    """True when `path` (repo-relative) is something the browser caches."""
    path = path.lstrip("./")
    if path == "sw.js":
        return False                      # changing it IS the bump
    if path in files:
        return True
    return any(path.startswith(prefix) for prefix in trees)


def shell_assets(paths, files, trees) -> list[str]:
    return sorted(p for p in paths if is_shell_asset(p, files, trees))


# ── Git plumbing ────────────────────────────────────────────────────────────

def _git(*args: str) -> str:
    proc = subprocess.run(
        ("git",) + args, cwd=REPO, capture_output=True, text=True
    )
    if proc.returncode != 0:
        raise GuardError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout


def changed_files(base_ref: str) -> list[str]:
    """Files this branch changed relative to the merge base with `base_ref`."""
    out = _git("diff", "--name-only", f"{base_ref}...HEAD")
    return [line for line in out.splitlines() if line.strip()]


def file_at(ref: str, path: str) -> str:
    return _git("show", f"{ref}:{path}")


# ── Entry point ─────────────────────────────────────────────────────────────

def main(argv: list[str]) -> int:
    base_ref = argv[1] if len(argv) > 1 else "origin/master"
    try:
        with open(os.path.join(REPO, "backend", "main.py"), encoding="utf-8") as fh:
            files, trees = served_allowlist(fh.read())

        changed = changed_files(base_ref)
        touched = shell_assets(changed, files, trees)
        if not touched:
            print(f"No browser-cached files changed against {base_ref} — no bump needed.")
            return 0

        with open(os.path.join(REPO, "sw.js"), encoding="utf-8") as fh:
            head_version = cache_version(fh.read())
        base_version = cache_version(file_at(base_ref, "sw.js"))
    except GuardError as exc:
        print(f"shell-version guard could not run: {exc}", file=sys.stderr)
        return 2

    if head_version != base_version:
        print(
            f"{len(touched)} browser-cached file(s) changed and CACHE_VERSION moved "
            f"{base_version} -> {head_version}."
        )
        return 0

    listed = "\n".join("    " + p for p in touched[:20])
    if len(touched) > 20:
        listed += f"\n    …and {len(touched) - 20} more"
    print(
        f"\nCACHE_VERSION is still {head_version}, but these files the browser "
        f"caches changed:\n\n{listed}\n\n"
        "Without a new version /sw.js is byte-identical, so no worker installs, "
        "nobody sees the\n'New version available' banner, and every device serves "
        "the previous shell for one\nmore launch (all assets are "
        "stale-while-revalidate).\n\n"
        "Fix: bump CACHE_VERSION in sw.js and note what changed, as the comments "
        "above it do.\n",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
