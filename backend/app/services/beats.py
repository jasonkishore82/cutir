"""
Beat detection: tempo, beat times with downbeats and onset strength, and the RMS loudness (energy) curve of a song.
librosa does the onset envelope and beat tracking; madmom, when installed, finds beats and downbeats with its neural
network instead (better downbeats). Pure logic, no HTTP: the API layer lives in app/routers/beats.py.
The browser fallback (src/lib/energy.ts) follows the same steps.
"""

import importlib.util
from pathlib import Path
from typing import Callable, Optional

from fastapi import HTTPException

SR = 22050
HOP = 512
FINE_HOP = 128  # 5.8 ms, for exact beat times and strengths
ENERGY_RATE = 20
BEATS_PER_BAR = 4
# the fine onset peak lands this long before the hit itself (seconds, measured on click tracks)
LEAD = -0.009


def available() -> dict:
    """Which engines are installed (reported by /api/health)."""
    return {
        "librosa": importlib.util.find_spec("librosa") is not None,
        "madmom": importlib.util.find_spec("madmom") is not None,
    }


def _librosa():
    try:
        import librosa  # imported lazily: the server starts without it
    except ImportError as e:
        raise HTTPException(501, f"Beat detection needs librosa ({e}). Run: pip install librosa")
    return librosa


def _normalise(values, pct: float = 95.0):
    """Scale to 0..1 by a high percentile, so one huge hit does not flatten the rest."""
    import numpy as np

    v = np.asarray(values, dtype=float)
    if v.size == 0:
        return v
    ref = float(np.percentile(v, pct)) or float(v.max()) or 1.0
    return np.clip(v / ref, 0.0, 1.0)


def _downbeat_phase(strengths, lows, beats_per_bar: int) -> int:
    """The beat of the bar (0..beats_per_bar-1) whose beats carry the most onset strength, kick / bass counted twice."""
    best, best_score = 0, float("-inf")
    for k in range(beats_per_bar):
        idx = range(k, len(strengths), beats_per_bar)
        vals = [strengths[i] + 2 * lows[i] for i in idx]
        score = sum(vals) / len(vals) if vals else 0.0
        if score > best_score + 1e-9:
            best, best_score = k, score
    return best


def _fine_onset(librosa, y, sr: int):
    return librosa.onset.onset_strength(y=y, sr=sr, hop_length=FINE_HOP, n_fft=512, n_mels=40)


def _refine(env, sr: int, times):
    """Move each beat to the sharpest onset within 60 ms on a fine (5.8 ms) onset envelope: librosa's tracker works
    on 23 ms frames and tends to land a frame or two late."""
    import numpy as np

    fine_hop = FINE_HOP
    if env.size == 0:
        return times
    win = int(round(0.06 * sr / fine_hop))
    out = []
    for t in times:
        f = int(round(t * sr / fine_hop))
        a, b = max(0, f - win), min(len(env), f + win + 1)
        if b - a < 3:
            out.append(float(t))
            continue
        seg = env[a:b]
        k = int(np.argmax(seg))
        # keep the tracker's time when nothing stands out (a beat over a held note)
        out.append(float(t) if seg[k] < 1.5 * float(np.median(seg)) + 1e-9 else (a + k) * fine_hop / sr + LEAD)
    return np.asarray(out)


def _madmom_downbeats(path: Path):
    """[(time, is_downbeat)] from madmom, or None when it is missing or fails."""
    if importlib.util.find_spec("madmom") is None:
        return None
    try:
        from madmom.features.downbeats import DBNDownBeatTrackingProcessor, RNNDownBeatProcessor

        act = RNNDownBeatProcessor()(str(path))
        rows = DBNDownBeatTrackingProcessor(beats_per_bar=[3, 4], fps=100)(act)
        return [(float(t), int(pos) == 1) for t, pos in rows]
    except Exception:  # noqa: BLE001 - madmom is optional; fall back to librosa
        return None


def analyze(path: Path, on_progress: Optional[Callable[[float], None]] = None) -> dict:
    """Analyse a song file. Times are in seconds from the start of the file."""
    librosa = _librosa()
    import numpy as np

    progress = on_progress or (lambda p: None)
    try:
        y, sr = librosa.load(str(path), sr=SR, mono=True)
    except Exception as e:  # noqa: BLE001 - unreadable or unsupported file
        raise HTTPException(400, f"Could not read the audio ({type(e).__name__}: {e}). Is ffmpeg on PATH?")
    progress(0.2)
    if y.size == 0:
        raise HTTPException(400, "The audio is empty")

    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    # low band (below ~200 Hz: kick and bass) for picking downbeats
    mel = librosa.feature.melspectrogram(y=y, sr=sr, hop_length=HOP, n_mels=64, fmax=sr / 2)
    mel_freqs = librosa.mel_frequencies(n_mels=64, fmax=sr / 2)
    low = librosa.onset.onset_strength(S=librosa.power_to_db(mel[mel_freqs < 200]), sr=sr) if (mel_freqs < 200).any() else onset
    progress(0.4)

    rows = _madmom_downbeats(path)
    progress(0.7)
    if rows:
        times = np.array([t for t, _ in rows])
        downs = [d for _, d in rows]
        bpb = BEATS_PER_BAR
        if downs.count(True) >= 2:
            first = downs.index(True)
            nxt = downs.index(True, first + 1)
            bpb = max(2, nxt - first)
    else:
        _, frames = librosa.beat.beat_track(onset_envelope=onset, sr=sr, hop_length=HOP, units="frames")
        times = librosa.frames_to_time(frames, sr=sr, hop_length=HOP)
        downs = None
        bpb = BEATS_PER_BAR

    fine = _fine_onset(librosa, y, sr)
    times = _refine(fine, sr, np.asarray(times, dtype=float))
    frames = np.clip(librosa.time_to_frames(times, sr=sr, hop_length=HOP), 0, len(onset) - 1)

    def around(env, f):
        return float(env[max(0, f - 1) : f + 2].max()) if len(env) else 0.0

    fine_frames = np.clip(np.round(times * sr / FINE_HOP).astype(int), 0, max(0, len(fine) - 1))
    strengths = _normalise([float(fine[max(0, f - 2) : f + 3].max()) if len(fine) else 0.0 for f in fine_frames])
    lows = _normalise([around(low, min(f, len(low) - 1)) for f in frames])
    if downs is None:
        phase = _downbeat_phase(list(strengths), list(lows), bpb)
        downs = [(i - phase) % bpb == 0 for i in range(len(times))]
    progress(0.85)

    beats = [{"time": round(float(t), 3), "downbeat": bool(d), "strength": round(float(s), 3)} for t, d, s in zip(times, downs, strengths)]
    if len(times) >= 2:
        idx = np.arange(len(times))
        slope = float(np.polyfit(idx, times, 1)[0])  # average seconds per beat
        tempo = 60.0 / slope if slope > 0 else 0.0
    else:
        tempo = 0.0

    step = sr // ENERGY_RATE
    rms = librosa.feature.rms(y=y, frame_length=2 * step, hop_length=step, center=True)[0]
    energy = [round(float(v), 3) for v in _normalise(rms, 99.0)]
    progress(1.0)

    first_down = next((b["time"] for b in beats if b["downbeat"]), 0.0)
    return {
        "tempo": round(tempo, 2),
        "firstDownbeat": first_down,
        "beatsPerBar": int(bpb),
        "beats": beats,
        "energy": {"rate": ENERGY_RATE, "values": energy},
        "engine": "madmom" if rows else "librosa",
    }
