#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Sets up a Python virtualenv with the backend (FastAPI) dependencies and pytest
# so the test suite runs in a fresh web session, then runs a fast,
# dependency-free smoke test of the schedule labor-rate engine so a broken
# calculation is caught at session start. Node is preinstalled; the labor-rate
# test (tests/test_labor_rates.js) needs no extra dependencies.
#
# Sync mode: the session waits until this finishes (deps are guaranteed ready
# before Claude runs anything). Idempotent and non-interactive. A Python
# dependency hiccup is a warning, not a hard failure — the smoke test still runs.
set -uo pipefail

# Web/remote sessions only — local runs are left untouched.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# A fresh venv gets a modern pip/setuptools/wheel (the system Python's are too
# old to build a couple of the sdists). Reused across sessions once cached.
echo "[session-start] setting up Python venv + dependencies..."
VENV="$CLAUDE_PROJECT_DIR/.venv"
if python -m venv "$VENV" \
  && "$VENV/bin/pip" install --quiet --upgrade pip setuptools wheel \
  && "$VENV/bin/pip" install --quiet -r requirements.txt \
  && "$VENV/bin/pip" install --quiet pytest pytest-asyncio; then
  echo "export PATH=\"$VENV/bin:\$PATH\"" >> "${CLAUDE_ENV_FILE:-/dev/null}"
  echo "[session-start] Python deps ready (.venv)."
else
  echo "[session-start] WARNING: Python dependency install failed; backend pytest may be unavailable."
fi

# Fast smoke test of the rate/labor calculations (pure Node, no deps).
if command -v node >/dev/null 2>&1; then
  echo "[session-start] verifying frontend JS suites..."
  for f in tests/test_*.js; do
    node "$f" || echo "[session-start] WARNING: $f FAILED (see output above)"
  done
fi

echo "[session-start] ready."
