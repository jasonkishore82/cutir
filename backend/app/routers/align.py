"""
POST /api/align          one-shot: returns the result as JSON when finished
POST /api/align_stream   same job, streams progress as NDJSON lines:
    {"type":"stage","stage":"separating|loading|aligning"}
    {"type":"progress","stage":"separating","pct":0..1}
    {"type":"result","lines":[...],"matched":true,"expected":N}
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
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse

from ..config import settings
from ..services import aligner

router = APIRouter(prefix="/api", tags=["align"])


@router.post("/align")
async def align_once(
    audio: UploadFile = File(...),
    lyrics: str = Form(...),
    language: str = Form("en"),
    model: str = Form(settings.aligner_model),
    separate: bool = Form(False),
):
    lines, lang = aligner.prepare(lyrics, language)
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        src = aligner.save_upload(audio, work)
        if separate:
            src = await run_in_threadpool(aligner.separate_vocals, src, work)
        segments = await run_in_threadpool(aligner.align, src, lines, lang, model)
    return {"lines": segments, "matched": len(segments) == len(lines), "expected": len(lines)}


@router.post("/align_stream")
async def align_stream(
    audio: UploadFile = File(...),
    lyrics: str = Form(...),
    language: str = Form("en"),
    model: str = Form(settings.aligner_model),
    separate: bool = Form(False),
):
    lines, lang = aligner.prepare(lyrics, language)
    tmp = Path(tempfile.mkdtemp(prefix="cutir-align-"))
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
            events.put({"type": "stage", "stage": "aligning"})
            segments = aligner.align(path, lines, lang, model)
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
