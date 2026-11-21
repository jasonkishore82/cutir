"""
POST /api/transcribe_stream   speech to text, streams progress as NDJSON lines:
    {"type":"stage","stage":"separating|loading|transcribing"}
    {"type":"progress","stage":"separating","pct":0..1}
    {"type":"result","language":"en","segments":[{"text","start","end","words":[{"text","start","end"}]}]}
    {"type":"error","message":"..."}
"""

import json
import queue
import shutil
import tempfile
import threading
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from ..config import settings
from ..services import aligner

router = APIRouter(prefix="/api", tags=["transcribe"])


@router.post("/transcribe_stream")
async def transcribe_stream(
    audio: UploadFile = File(...),
    language: str = Form(""),
    model: str = Form(settings.aligner_model),
    vocabulary: str = Form(""),
    separate: bool = Form(False),
):
    if not shutil.which("ffmpeg"):
        raise HTTPException(500, "ffmpeg was not found on PATH (stable-ts needs it to read audio)")
    lang: Optional[str] = None if language in ("", "auto") else language
    tmp = Path(tempfile.mkdtemp(prefix="cutir-transcribe-"))
    try:
        src = aligner.save_upload(audio, tmp)  # copy now: the upload is closed once this handler returns
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise

    events: "queue.Queue[Optional[dict]]" = queue.Queue()

    def worker():
        try:
            path = src
            if separate:
                events.put({"type": "stage", "stage": "separating"})
                path = aligner.separate_vocals(src, tmp, lambda p: events.put({"type": "progress", "stage": "separating", "pct": p}))
            events.put({"type": "stage", "stage": "loading"})
            aligner.get_model(model)  # first use may download the model
            events.put({"type": "stage", "stage": "transcribing"})
            result = aligner.transcribe(path, lang, model, vocabulary)
            events.put({"type": "result", **result})
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
