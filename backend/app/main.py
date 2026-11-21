import mimetypes
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from . import __version__
from .config import settings
from .routers import align, beats, health, transcribe

# Windows can map these to the wrong type; browsers refuse module scripts / streamed wasm with a wrong MIME type.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/wasm", ".wasm")

# The compatibility export (ffmpeg.wasm) needs a cross-origin isolated page.
ISOLATION_HEADERS = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
}


def create_app() -> FastAPI:
    app = FastAPI(title="Cutir backend", version=__version__)

    # Only pages served from this machine may call the API (the Vite dev server on :5173, or this server itself).
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$",
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def isolation_headers(request, call_next):
        response = await call_next(request)
        for k, v in ISOLATION_HEADERS.items():
            response.headers.setdefault(k, v)
        return response

    app.include_router(health.router)
    app.include_router(align.router)
    app.include_router(beats.router)
    app.include_router(transcribe.router)
    _serve_frontend(app)
    return app


def _serve_frontend(app: FastAPI) -> None:
    """If the web app has been built (npm run build), serve it so one process runs everything."""
    dist = settings.dist
    index = dist / "index.html"
    if not index.is_file():
        return

    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def spa(path: str):
        if path == "api" or path.startswith("api/"):
            raise HTTPException(404, "Unknown API route")
        target = (dist / path).resolve()
        # serve real files from dist only (no path traversal); anything else is the single-page app
        if path and target.is_file() and dist.resolve() in target.parents:
            return FileResponse(target)
        return FileResponse(index)


app = create_app()
