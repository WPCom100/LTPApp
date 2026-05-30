import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.responses import FileResponse, Response
from starlette.middleware.sessions import SessionMiddleware
from authlib.integrations.starlette_client import OAuth

from backend.database import init_db
from backend.routes.api import router as api_router
from backend.routes.auth import router as auth_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="LTP Business Suite", version="2.0.0", lifespan=lifespan)


# ── Starlette SessionMiddleware ─────────────────────────────────────────────
# This is NOT our app session — it's a separate signed cookie that Authlib
# uses to round-trip the OAuth state/nonce while the user is at Google. Our
# real app session lives in the `ltp_session` cookie + `sessions` DB table.
# `LTP_SESSION_SECRET` should be a long random hex string — generate with
# `python -c "import secrets; print(secrets.token_hex(32))"`.
_session_secret = os.environ.get("LTP_SESSION_SECRET", "")
if not _session_secret:
    # Last-resort fallback for local dev; production MUST set this.
    print("[LTP] WARNING: LTP_SESSION_SECRET not set — using ephemeral dev key. Sessions will break across restarts.", flush=True)
    import secrets as _secrets
    _session_secret = _secrets.token_hex(32)

app.add_middleware(
    SessionMiddleware,
    secret_key=_session_secret,
    same_site="lax",
    https_only=os.environ.get("LTP_OAUTH_REDIRECT_URI", "").startswith("https://"),
)


# ── Authlib OAuth client ────────────────────────────────────────────────────
# Stashed on app.state so routes/auth.py can pull it via the Request.
oauth = OAuth()
oauth.register(
    name="google",
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_id=os.environ.get("GOOGLE_CLIENT_ID", ""),
    client_secret=os.environ.get("GOOGLE_CLIENT_SECRET", ""),
    client_kwargs={"scope": "openid email profile"},
)
app.state.oauth = oauth


# ── Routers ─────────────────────────────────────────────────────────────────
# IMPORTANT: register API + auth routers BEFORE the static catch-all below.
# FastAPI dispatches in registration order; if the `/{full_path}` route is
# registered first it would swallow `/auth/login` etc.
app.include_router(auth_router)
app.include_router(api_router)


# ── Static frontend serving ─────────────────────────────────────────────────
# Files live at the project root (one level up from backend/).
frontend_dir = os.path.realpath(os.path.dirname(os.path.dirname(__file__)))

# Strict allowlist — deny by default. The project root contains things we do
# NOT want exposed (requirements.txt, railway.json, .env files, the entire
# backend/ tree, etc.). Only the explicit set below is reachable; everything
# else falls through to index.html so the SPA can still handle unknown client routes.
_ALLOWED_TOP_LEVEL_FILES = {"index.html", "app.js", "router.js", "theme.js", "favicon.ico"}
_ALLOWED_TREES = {
    "components/": (".js",),
    "data/":       (".js",),
    "modules/":    (".js",),
    "assets/":     (".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp", ".ico",
                    ".woff", ".woff2", ".ttf", ".eot", ".otf", ".css"),
}


def _resolve_static(full_path):
    """Resolve a request path to an absolute file inside frontend_dir.
    Returns None unless the request matches the explicit allowlist. Defends
    against ../ traversal, percent-encoded escapes, symlinks, cross-drive
    paths, AND access to in-repo files that aren't part of the frontend."""
    if not full_path:
        return None
    candidate = os.path.realpath(os.path.join(frontend_dir, full_path))
    try:
        common = os.path.commonpath([frontend_dir, candidate])
    except ValueError:
        return None
    if common != frontend_dir:
        return None
    if not os.path.isfile(candidate):
        return None
    rel = os.path.relpath(candidate, frontend_dir).replace(os.sep, "/")
    if rel in _ALLOWED_TOP_LEVEL_FILES:
        return candidate
    for prefix, exts in _ALLOWED_TREES.items():
        if rel.startswith(prefix) and rel.endswith(exts):
            return candidate
    return None


@app.get("/{full_path:path}")
async def serve_frontend(full_path: str):
    # Anything under api/ or auth/ that didn't match the routers above is a
    # genuinely unknown endpoint — 404 instead of returning index.html, which
    # would otherwise mask typos.
    if full_path.startswith("api/") or full_path.startswith("auth/"):
        return Response(status_code=404)

    static = _resolve_static(full_path)
    if static:
        return FileResponse(static)

    # SPA fallback for any unknown path
    return FileResponse(os.path.join(frontend_dir, "index.html"))
