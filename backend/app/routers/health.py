import importlib.util
import shutil

from fastapi import APIRouter

from .. import __version__
from ..config import settings
from ..services import beats

router = APIRouter(prefix="/api", tags=["health"])


def _installed(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


@router.get("/health")
def health():
    """What this backend can do right now. The web app uses it for the 'Test connection' button."""
    return {
        "ok": True,
        "app": "cutir-backend",
        "version": __version__,
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "serving_app": settings.dist.joinpath("index.html").is_file(),
        "aligner": {
            "backend": settings.aligner_backend,
            "model": settings.aligner_model,
            "device": settings.aligner_device or "auto",
            "stable_ts": _installed("stable_whisper"),
            "demucs": _installed("demucs"),
        },
        "beats": beats.available(),
    }
