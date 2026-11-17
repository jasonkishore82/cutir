"""
Cutir aligner: a tiny local HTTP helper that forced-aligns lyrics to a song.

    pip install -r requirements.txt
    python server.py                # http://127.0.0.1:8765

Cutir sends the audio plus your lyrics (one line per row) and gets back start/end times for every
line and every word. It uses stable-ts (Whisper) as the aligner.

Endpoints
    GET  /health        status
    POST /align         one-shot: returns the result as JSON when finished
    POST /align_stream  same job, but streams progress as NDJSON lines:
                          {"type":"stage","stage":"separating|loading|aligning"}
                          {"type":"progress","stage":"separating","pct":0..1}
                          {"type":"result","lines":[...],"matched":true,"expected":N}
                          {"type":"error","message":"..."}

Environment variables
    CUTIR_ALIGNER_PORT     port to listen on                (default 8765)
    CUTIR_ALIGNER_MODEL    default Whisper model            (default "base"; "small"/"medium" are more accurate)
    CUTIR_ALIGNER_BACKEND  "whisper" (needs torch) or "faster" (faster-whisper / CTranslate2, no torch)
    CUTIR_ALIGNER_DEVICE   "cpu", "cuda" ... (default: auto)
"""

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Callable, Optional

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

PORT = int(os.environ.get("CUTIR_ALIGNER_PORT", "8765"))
DEFAULT_MODEL = os.environ.get("CUTIR_ALIGNER_MODEL", "base")
BACKEND = os.environ.get("CUTIR_ALIGNER_BACKEND", "whisper").lower()
DEVICE = os.environ.get("CUTIR_ALIGNER_DEVICE") or None

app = FastAPI(title="Cutir aligner")
# Only pages served from this machine may call the helper.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)

TAG_LINE = re.compile(r"^\[[^\]]*\]$")

_models: dict = {}
_lock = threading.Lock()  # one alignment at a time; Whisper models are not thread-safe


def get_model(name: str):
    """Load (and cache) a model. Imported lazily so /health works even if the engine is missing."""
    with _lock:
        if name not in _models:
            try:
                import stable_whisper
            except ImportError as e:  # pragma: no cover - environment specific
                raise HTTPException(500, f"stable-ts is not installed ({e}). Run: pip install -r requirements.txt")
            except OSError as e:  # e.g. a blocked/unloadable torch DLL
                raise HTTPException(500, f"Could not load the Whisper engine: {e}")
            if BACKEND == "faster":
                _models[name] = stable_whisper.load_faster_whisper(name, device=DEVICE or "auto")
            else:
                kwargs = {"device": DEVICE} if DEVICE else {}
                _models[name] = stable_whisper.load_model(name, **kwargs)
        return _models[name]


def separate_vocals(src: Path, workdir: Path, on_progress: Optional[Callable[[float], None]] = None) -> Path:
    """Optional: strip the backing track with Demucs so alignment only hears the voice.
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


def do_align(path: Path, lines: list[str], language: Optional[str], model_name: str) -> list[dict]:
    model = get_model(model_name)
    # original_split keeps one segment per lyric line, in order
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


def prepare(lyrics: str, language: str):
    # Skip section tags such as "[Verse 1]" / "[Chorus]" (Suno and others add them; they are not sung)
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


@app.get("/health")
def health():
    return {"ok": True, "backend": BACKEND, "model": DEFAULT_MODEL, "device": DEVICE or "auto", "ffmpeg": shutil.which("ffmpeg") is not None}


@app.post("/align")
async def align(
    audio: UploadFile = File(...),
    lyrics: str = Form(...),
    language: str = Form("en"),
    model: str = Form(DEFAULT_MODEL),
    separate: bool = Form(False),
):
    lines, lang = prepare(lyrics, language)
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        src = save_upload(audio, work)
        if separate:
            src = await run_in_threadpool(separate_vocals, src, work)
        segments = await run_in_threadpool(do_align, src, lines, lang, model)
    return {"lines": segments, "matched": len(segments) == len(lines), "expected": len(lines)}


@app.post("/align_stream")
async def align_stream(
    audio: UploadFile = File(...),
    lyrics: str = Form(...),
    language: str = Form("en"),
    model: str = Form(DEFAULT_MODEL),
    separate: bool = Form(False),
):
    lines, lang = prepare(lyrics, language)
    tmp = Path(tempfile.mkdtemp(prefix="cutir-align-"))
    try:
        src = save_upload(audio, tmp)  # copy now: the upload is closed once this handler returns
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise

    events: "queue.Queue[Optional[dict]]" = queue.Queue()

    def worker():
        try:
            path = src
            if separate:
                events.put({"type": "stage", "stage": "separating"})
                path = separate_vocals(src, tmp, lambda p: events.put({"type": "progress", "stage": "separating", "pct": p}))
            events.put({"type": "stage", "stage": "loading"})
            get_model(model)  # first use may download the model
            events.put({"type": "stage", "stage": "aligning"})
            segments = do_align(path, lines, lang, model)
            events.put({"type": "result", "lines": segments, "matched": len(segments) == len(lines), "expected": len(lines)})
        except HTTPException as e:
            events.put({"type": "error", "message": str(e.detail)})
        except Exception as e:  # noqa: BLE001 - report anything to the UI
            events.put({"type": "error", "message": f"{type(e).__name__}: {e}"})
        finally:
            events.put(None)

    threading.Thread(target=worker, daemon=True).start()

    def stream():
        try:
            while True:
                item = events.get()
                if item is None:
                    break
                yield json.dumps(item) + "\n"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    return StreamingResponse(stream(), media_type="application/x-ndjson")


if __name__ == "__main__":
    print(f"Cutir aligner on http://127.0.0.1:{PORT}  (backend={BACKEND}, model={DEFAULT_MODEL})")
    uvicorn.run(app, host="127.0.0.1", port=PORT)
