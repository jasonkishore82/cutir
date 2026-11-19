"""
POST /api/beats   analyse a song: returns
    {"tempo", "firstDownbeat", "beatsPerBar", "beats": [{"time", "downbeat", "strength"}], "energy": {"rate", "values"}}
Times are in seconds from the start of the file; strength and energy are 0..1.
"""

import tempfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

from ..services import aligner, beats

router = APIRouter(prefix="/api", tags=["beats"])


@router.post("/beats")
async def detect_beats(audio: UploadFile = File(...)):
    if not beats.available()["librosa"]:
        raise HTTPException(501, "Beat detection needs librosa on the backend. Run: pip install librosa")
    with tempfile.TemporaryDirectory() as tmp:
        src = aligner.save_upload(audio, Path(tmp))
        return await run_in_threadpool(beats.analyze, src)
