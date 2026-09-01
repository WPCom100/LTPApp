"""Defensive environment-variable parsing.

Lives in its own module because the two modules that need it cannot share
otherwise: backend/main.py imports backend/rate_limit.py, so rate_limit
cannot import back from main. This was originally `_env_int` in main.py and
rate_limit.py had a bare `int()` instead — see below for why that mattered.
"""
import os


def env_int(name: str, default: int, *, minimum: int | None = None) -> int:
    """Read an integer env var, falling back to `default` (with a warning) on a
    missing, blank, non-numeric, or out-of-range value.

    A bare `int(os.environ[...])` at import time turns a typo like `2h` into a
    ValueError that crash-loops the container on every boot — before the app
    object exists, so there is no traceback route and no health surface, just a
    restart loop. backend/rate_limit.py did exactly that with
    LTP_TRUST_PROXY_HOPS.

    `minimum` guards the other direction: LTP_SESSION_SWEEP_INTERVAL_SECONDS=0
    parses fine and turns a background poller into a hot loop that pins the
    single event loop this app runs on.
    """
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        print(f"[LTP] config: {name}={raw!r} is not an integer; using default {default}",
              flush=True)
        return default
    if minimum is not None and value < minimum:
        print(f"[LTP] config: {name}={value} is below the minimum {minimum}; "
              f"using default {default}", flush=True)
        return default
    return value


def env_flag(name: str) -> bool:
    """True for the usual affirmative spellings; False for anything else."""
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def looks_like_production() -> bool:
    """Whether this process is configured as a real deployment rather than a
    developer's laptop.

    Two independent signals, matching what backend/main.py already uses to
    decide Secure cookies, HSTS and whether a missing LTP_SESSION_SECRET is
    fatal (SECURITY_REVIEW.md H7): an explicit LTP_FORCE_HTTPS switch, or an
    https:// OAuth redirect URI. Keeping the definition in one place means the
    "is this prod?" question cannot answer differently in different modules.
    """
    return env_flag("LTP_FORCE_HTTPS") or \
        os.environ.get("LTP_OAUTH_REDIRECT_URI", "").startswith("https://")
