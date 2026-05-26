import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from backend.database import init_db
from backend.routes.api import router as api_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="LTP Business Suite", version="1.0.0", lifespan=lifespan)

# API routes
app.include_router(api_router)

# Static frontend files live at the project root (one level up from backend/).
frontend_dir = os.path.dirname(os.path.dirname(__file__))


@app.get("/{full_path:path}")
async def serve_frontend(full_path: str):
    # Block API paths from the catch-all (defensive — they're already routed above)
    if full_path.startswith("api/"):
        return FileResponse(os.path.join(frontend_dir, "index.html"))

    # Serve the exact file if it exists (app.js, router.js, components/*, data/*, etc.)
    if full_path:
        candidate = os.path.join(frontend_dir, full_path)
        if os.path.isfile(candidate):
            return FileResponse(candidate)

    # Fall back to index.html (SPA root + unknown paths)
    return FileResponse(os.path.join(frontend_dir, "index.html"))
