import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from backend.database import init_db
from backend.routes.api import router as api_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create tables on startup
    await init_db()
    yield


app = FastAPI(title="LTP Business Suite", version="1.0.0", lifespan=lifespan)

# API routes
app.include_router(api_router)

# Static frontend files
frontend_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")
if os.path.isdir(frontend_dir):
    # Serve JS/CSS/assets from /static
    app.mount("/static", StaticFiles(directory=frontend_dir), name="static")

    # Catch-all: serve index.html for any non-API, non-static route (SPA support)
    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        # Try to serve the exact file first
        file_path = os.path.join(frontend_dir, full_path)
        if os.path.isfile(file_path):
            return FileResponse(file_path)
        # Fall back to index.html
        return FileResponse(os.path.join(frontend_dir, "index.html"))
