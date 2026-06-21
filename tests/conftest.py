"""Pytest-wide environment defaults, applied before any test module imports
the app.

backend.main now refuses to boot in a production-style configuration (an
https:// LTP_OAUTH_REDIRECT_URI) unless LTP_SESSION_SECRET is set and strong
(SECURITY_REVIEW.md H6). Several test modules set an https:// redirect URI to
exercise the production cookie/HSTS path but don't set a session secret, so we
provide a strong test default here. conftest.py is imported before the test
modules in this directory, so the value is in place before `backend.main` is
first imported. Real deployments set this in the environment.

Uses setdefault so an explicitly-exported LTP_SESSION_SECRET still wins.
"""
import os

os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
