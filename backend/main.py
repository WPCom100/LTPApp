import os
import json
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.responses import FileResponse, Response
from backend.database import init_db
from backend.routes.api import router as api_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="LTP Business Suite", version="1.0.0", lifespan=lifespan)

# API routes (auth-gated by the router's dependency)
app.include_router(api_router)

# Static frontend files live at the project root (one level up from backend/).
frontend_dir = os.path.realpath(os.path.dirname(os.path.dirname(__file__)))

# Strict allowlist — deny by default. The project root contains things we
# do NOT want exposed (requirements.txt, build.sh, railway.json, .env files,
# the entire backend/ tree, assets/generate_quote_pdf.py, etc.). Only the
# explicit set below is reachable; everything else falls through to
# index.html so the SPA can still handle unknown client routes.
_ALLOWED_TOP_LEVEL_FILES = {"index.html", "app.js", "router.js", "theme.js", "favicon.ico"}
# Whitelisted subdirectories and the extensions permitted inside each.
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
    paths, AND access to in-repo files that aren't part of the frontend
    (deploy configs, backend code, server-side scripts)."""
    if not full_path:
        return None
    candidate = os.path.realpath(os.path.join(frontend_dir, full_path))
    # Containment check — defends against ../, %2e%2e, symlinks
    try:
        common = os.path.commonpath([frontend_dir, candidate])
    except ValueError:
        return None
    if common != frontend_dir:
        return None
    if not os.path.isfile(candidate):
        return None
    # Allowlist check — defends against in-repo files we don't want exposed
    rel = os.path.relpath(candidate, frontend_dir).replace(os.sep, "/")
    if rel in _ALLOWED_TOP_LEVEL_FILES:
        return candidate
    for prefix, exts in _ALLOWED_TREES.items():
        if rel.startswith(prefix) and rel.endswith(exts):
            return candidate
    return None


@app.get("/config.js")
async def config_js():
    """Tiny dynamic JS file that injects runtime config (API key) into the
    page. The key only ends up in this JS — it is never embedded in source.
    Loaded by index.html before data-state.js so the fetch wrapper can read it.
    NOTE: anyone who can load the page can also read this file. This is a
    stopgap; real per-user auth requires Google login + sessions."""
    key = os.environ.get("LTP_API_KEY", "")
    body = "window.LTP_API_KEY = " + json.dumps(key) + ";\n"
    return Response(
        content=body,
        media_type="application/javascript",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/{full_path:path}")
async def serve_frontend(full_path: str):
    # API routes are registered above and take precedence; anything matching
    # this catch-all under api/ is an unknown endpoint, so 404 instead of
    # silently returning index.html (which would mask client-side typos).
    if full_path.startswith("api/"):
        return Response(status_code=404)

    static = _resolve_static(full_path)
    if static:
        return FileResponse(static)

    # SPA fallback for any unknown path
    return FileResponse(os.path.join(frontend_dir, "index.html"))
