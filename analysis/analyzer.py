"""Versioned track analysis; all event times refer to the original file timeline."""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import tempfile

import librosa
import numpy as np
import soundfile as sf

SCHEMA_VERSION = 1
# 22.05 kHz retains rhythmic transients while halving work relative to 44.1 kHz.
# A 256-sample hop gives ~11.6 ms timing resolution; 1024 samples resolve broad
# spectral changes without the latency of a large FFT. These are starting tradeoffs,
# not settings calibrated against a DJ annotation dataset.
CONFIG = {"sampleRate": 22050, "hopLength": 256, "fftSize": 1024,
          "startBpm": 120, "tightness": 100, "trim": True,
          "energyWindowSeconds": 0.1, "maxDurationSeconds": 600}
ALGORITHM = f"librosa-{librosa.__version__}-dj-grid-1"
CACHE_VERSION = hashlib.sha256(json.dumps(CONFIG, sort_keys=True).encode()).hexdigest()[:12]


def estimate_rhythm(y: np.ndarray, sr: int, duration: float) -> dict:
    hop = CONFIG["hopLength"]
    # Spectral flux measures new energy across frequency bands, so a sustained
    # loud bass note is not mistaken for repeated attacks. max_size=3 suppresses
    # small frequency shifts (e.g. vibrato) at the cost of some closely spaced detail.
    envelope = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop,
        n_fft=CONFIG["fftSize"], max_size=3)
    onset_frames = librosa.onset.onset_detect(onset_envelope=envelope, sr=sr,
        hop_length=hop, backtrack=False)
    # Backtracking targets preceding energy minima for sample slicing; here we
    # retain attack peaks for metronome audition. These are not guaranteed safe cuts.
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=hop)
    empty = {"bpm": None, "beatTimes": [], "gridOffsetSeconds": None,
             "confidence": {"score": 0.0, "kind": "heuristic", "regularity": 0.0,
                            "onsetSupport": 0.0}, "tempoAlternatives": [],
             "onsetTimes": onset_times[onset_times < duration].tolist(),
             "warnings": []}
    # Eight seconds and eight attacks give the periodicity estimator several
    # opportunities to agree. Sparse intros can fail this deliberately conservative gate.
    if duration < 8 or len(onset_frames) < 8 or float(np.max(envelope)) < 1e-6:
        empty["warnings"] = ["Insufficient rhythmic evidence; enter and audition a manual grid."]
        return empty
    tempo, frames = librosa.beat.beat_track(onset_envelope=envelope, sr=sr,
        hop_length=hop, start_bpm=CONFIG["startBpm"], tightness=CONFIG["tightness"],
        trim=CONFIG["trim"])
    # Dynamic programming balances attack strength against regular spacing.
    # Tightness 100 is librosa's default: suitable for a first fixed-tempo workflow,
    # but not evidence that rubato/live drums have a constant tempo. Trim avoids
    # inventing confident beats over silent file edges.
    beats = librosa.frames_to_time(frames, sr=sr, hop_length=hop)
    beats = beats[(beats >= 0) & (beats < duration)]
    if len(beats) < 8 or float(np.asarray(tempo).item()) <= 0:
        empty["warnings"] = ["No stable beat sequence found."]
        return empty
    intervals = np.diff(beats)
    # Fit a line over all detected beats to reduce hop-size quantization error in
    # BPM. Preserve the original irregular beat times separately: this fitted grid
    # is an audition aid, not a claim that tempo never changes.
    period, intercept = np.polyfit(np.arange(len(beats)), beats, 1)
    bpm = float(60 / period)
    residual = float(np.median(np.abs(beats - (intercept + period * np.arange(len(beats))))))
    regularity = float(np.clip(1 - np.median(np.abs(intervals - np.median(intervals))) / (period * .15), 0, 1))
    alignment = float(np.clip(1 - residual / (period * .15), 0, 1))
    scale = max(float(np.percentile(envelope, 95)), 1e-6)
    support = float(np.mean(np.clip(envelope[frames] / scale, 0, 1)))
    # Consistency is partly imposed by the tracker itself. Cap the score below 1,
    # combine actual attack support with fit, and NEVER interpret this as accuracy probability.
    # A 15% period tolerance is much larger than the ~12 ms analysis hop, so
    # quantization alone should not invalidate a grid. The .5 warning threshold
    # and .85 ceiling are conservative UI heuristics, not benchmark-calibrated values.
    score = min(.85, regularity * alignment * support)
    warnings = ["Half/double tempo and offbeat interpretations remain possible. Downbeats and phrases are unknown."]
    if score < .5:
        warnings.append("Weak or inconsistent rhythmic support; audition before using this grid.")
    if residual > .05:
        warnings.append("A constant grid drifts from detected beats; this track may need a variable-tempo map.")
    return {"bpm": round(bpm, 4), "beatTimes": np.round(beats, 6).tolist(),
            "gridOffsetSeconds": round(float(intercept % period), 6),
            "confidence": {"score": round(score, 3), "kind": "heuristic",
                           "regularity": round(regularity, 3), "onsetSupport": round(support, 3)},
            "tempoAlternatives": [round(bpm / 2, 4), round(bpm * 2, 4)],
            "onsetTimes": np.round(onset_times[onset_times < duration], 6).tolist(),
            "warnings": warnings}
# Summary: This function estimates rhythmic pulses and a separate constant-tempo grid.
# It combines spectral attacks with librosa's dynamic-programming spacing model and reports its evidence.
# Syncopation, silent intros, tempo changes, and half-time ambiguity can still produce a wrong grid.


def analyze_bytes(data: bytes) -> dict:
    with sf.SoundFile(io.BytesIO(data)) as audio:
        duration = len(audio) / audio.samplerate
        if not 0 < duration <= CONFIG["maxDurationSeconds"]:
            raise ValueError("Tracks must be non-empty and no longer than 10 minutes.")
        # Bound decoded memory as well as upload bytes: compressed files can expand greatly.
        if len(audio) * audio.channels > 40_000_000 or audio.channels > 8:
            raise ValueError("Decoded audio is too large; use a shorter mono/stereo excerpt.")
        original_sr, channels = audio.samplerate, audio.channels
        samples = audio.read(dtype="float32", always_2d=True)
    if not np.all(np.isfinite(samples)):
        raise ValueError("Audio contains non-finite samples.")
    # Averaging L/R can cancel anti-phase drums. Pick the channel with most energy
    # for rhythm analysis instead, explicitly accepting that material panned only
    # to another channel can be missed. Energy below still measures ALL channels.
    channel = int(np.argmax(np.mean(samples ** 2, axis=0)))
    y = librosa.resample(samples[:, channel], orig_sr=original_sr, target_sr=CONFIG["sampleRate"])
    width = max(1, round(original_sr * CONFIG["energyWindowSeconds"]))
    energy = []
    for start in range(0, len(samples), width):
        rms = float(np.sqrt(np.mean(samples[start:start + width] ** 2)))
        energy.append({"time": round(start / original_sr, 6), "rms": round(rms, 7),
                       "dbfs": round(20 * np.log10(max(rms, 1e-6)), 3)})
    rhythm = estimate_rhythm(y, CONFIG["sampleRate"], duration)
    return {"schemaVersion": SCHEMA_VERSION,
            "trackId": hashlib.sha256(data).hexdigest(), "durationSeconds": duration,
            "source": {"bytes": len(data), "sampleRate": original_sr, "channels": channels},
            "provenance": {"algorithm": ALGORITHM, "configVersion": CACHE_VERSION,
                           "config": CONFIG, "rhythmChannel": channel},
            **rhythm, "energyCurve": energy,
            "downbeatTimes": None, "phrases": None, "key": None, "vocalRegions": None}
# Summary: This function turns encoded audio into reusable metadata on its original timeline.
# It decodes once, analyzes a rhythm channel at a lower rate, and measures channel-averaged RMS before resampling.
# RMS/dBFS is not perceptual LUFS, and choosing one rhythm channel can miss strongly panned events.


def cached_analysis(data: bytes, directory: Path) -> tuple[dict, bool]:
    identity = hashlib.sha256(data).hexdigest()
    path = directory / f"{identity}-{ALGORITHM}-{CACHE_VERSION}.json"
    try:
        cached = json.loads(path.read_text())
        if (cached["schemaVersion"] == SCHEMA_VERSION and cached["trackId"] == identity
            and cached["provenance"]["algorithm"] == ALGORITHM
            and cached["provenance"]["config"] == CONFIG
            and cached["source"]["bytes"] == len(data)
            and all(key in cached for key in ("bpm", "beatTimes", "onsetTimes", "energyCurve",
                "confidence", "gridOffsetSeconds", "warnings", "tempoAlternatives",
                "downbeatTimes", "phrases", "key", "vocalRegions", "durationSeconds"))):
            return cached, True
    except (OSError, ValueError, KeyError, TypeError):
        pass
    result = analyze_bytes(data)
    # The file hash catches exact duplicates despite renames; algorithm+config
    # versions prevent silently reusing old answers after detector settings change.
    directory.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as handle:
            temporary = handle.name
            json.dump(result, handle, allow_nan=False)
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    return result, False
# Summary: This function avoids rerunning analysis for identical audio and settings.
# Content-addressed filenames and atomic replacement keep renamed files reusable and partial writes invisible.
# It detects exact duplicates only, and disk permission/full-disk errors still need to be shown to the caller.

# Module summary: This module provides the analysis contract behind imported decks.
# It keeps detected events, fitted grids, uncertainty, and currently unknown musical labels distinct.
# It is a fixed-tempo starting point; robust downbeat/structure models and tempo maps belong to later work.
