"""Settings, read once from environment variables."""

import os
from dataclasses import dataclass
from pathlib import Path


def _port() -> int:
    # CUTIR_ALIGNER_PORT is the name the standalone aligner used; still honoured
    return int(os.environ.get("CUTIR_PORT") or os.environ.get("CUTIR_ALIGNER_PORT") or "8765")


@dataclass(frozen=True)
class Settings:
    host: str = os.environ.get("CUTIR_HOST", "127.0.0.1")  # local only by default
    port: int = _port()

    # aligner
    aligner_model: str = os.environ.get("CUTIR_ALIGNER_MODEL", "base")  # "small"/"medium" are more accurate
    aligner_backend: str = os.environ.get("CUTIR_ALIGNER_BACKEND", "whisper").lower()  # "whisper" | "faster"
    aligner_device: str | None = os.environ.get("CUTIR_ALIGNER_DEVICE") or None  # "cpu", "cuda", ... (default: auto)

    # where the built web app lives (npm run build -> dist/); served at / when present
    root: Path = Path(__file__).resolve().parents[2]

    @property
    def dist(self) -> Path:
        return self.root / "dist"


settings = Settings()
