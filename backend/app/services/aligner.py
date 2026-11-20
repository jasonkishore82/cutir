"""
Lyrics aligner: forced alignment of lyrics to a song with stable-ts (Whisper), optional vocal separation with Demucs.
Pure logic, no HTTP: the API layer lives in app/routers/align.py.
"""

import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Callable, Optional

from fastapi import HTTPException, UploadFile

from ..config import settings

# Section tags such as "[Verse 1]" / "[Chorus]" (Suno and others add them); they are not sung.
TAG_LINE = re.compile(r"^\[[^\]]*\]$")

_models: dict = {}
_lock = threading.Lock()  # one alignment at a time; Whisper models are not thread-safe


def get_model(name: str):
    """Load (and cache) a model. Imported lazily so the server starts even if the engine is missing."""
    with _lock:
        if name not in _models:
            try:
                import stable_whisper
            except ImportError as e:
                raise HTTPException(500, f"stable-ts is not installed ({e}). Run: pip install -r requirements.txt")
            except OSError as e:  # e.g. a blocked/unloadable torch DLL
                raise HTTPException(500, f"Could not load the Whisper engine: {e}")
            if settings.aligner_backend == "faster":
                _models[name] = stable_whisper.load_faster_whisper(name, device=settings.aligner_device or "auto")
            else:
                kwargs = {"device": settings.aligner_device} if settings.aligner_device else {}
                _models[name] = stable_whisper.load_model(name, **kwargs)
        return _models[name]


def prepare(lyrics: str, language: str) -> tuple[list[str], Optional[str]]:
    """Clean the lyrics (one line per row, tags removed) and normalise the language ('auto' -> None)."""
    lines = [l.strip() for l in lyrics.splitlines() if l.strip() and not TAG_LINE.match(l.strip())]
    if not lines:
        raise HTTPException(400, "No lyrics were sent")
    if not shutil.which("ffmpeg"):
        raise HTTPException(500, "ffmpeg was not found on PATH (stable-ts needs it to read audio)")
    return lines, (None if language in ("", "auto") else language)


def save_upload(audio: UploadFile, workdir: Path) -> Path:
    src = workdir / f"song{Path(audio.filename or 'song.mp3').suffix or '.mp3'}"
    with open(src, "wb") as f:
        shutil.copyfileobj(audio.file, f)
    return src


def separate_vocals(src: Path, workdir: Path, on_progress: Optional[Callable[[float], None]] = None) -> Path:
    """Strip the backing track with Demucs so alignment only hears the voice.
    Demucs prints tqdm progress bars on stderr; those percentages are forwarded to on_progress (0..1)."""
    out = workdir / "demucs"
    cmd = [sys.executable, "-m", "demucs", "--two-stems=vocals", "-o", str(out), str(src)]
    try:
        proc = subprocess.Popen(cmd, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL)
    except FileNotFoundError as e:
        raise HTTPException(400, f"Vocal separation failed to start: {e}")

    tail = b""
    assert proc.stderr is not None
    while True:
        chunk = proc.stderr.read1(512)  # returns as soon as some output is available
        if not chunk:
            break
        tail = (tail + chunk)[-600:]
        if on_progress:
            for m in re.finditer(rb"(\d{1,3})%\|", chunk):
                on_progress(min(int(m.group(1)), 100) / 100)
    if proc.wait() != 0:
        raise HTTPException(
            400, f"Vocal separation failed (is demucs installed? pip install demucs): {tail.decode(errors='ignore')[-300:]}"
        )
    found = list(out.rglob("vocals.*"))
    if not found:
        raise HTTPException(500, "Demucs finished but produced no vocals file")
    return found[0]


def align(path: Path, lines: list[str], language: Optional[str], model_name: str) -> list[dict]:
    """Time every lyric line (and word) to the audio. Returns one segment per input line, in order."""
    model = get_model(model_name)
    # original_split keeps one segment per lyric line
    result = model.align(str(path), "\n".join(lines), language=language, original_split=True)
    out = []
    for seg in result.segments:
        words = [
            {"text": w.word.strip(), "start": round(float(w.start), 2), "end": round(float(w.end), 2)}
            for w in seg.words
            if w.word.strip()
        ]
        out.append(
            {
                "text": seg.text.strip(),
                "start": round(float(seg.start), 2),
                "end": round(float(seg.end), 2),
                "words": words,
            }
        )
    return out
