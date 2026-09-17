"""Preserve decoded reference PCM; prepare explicit, reversible analysis transforms."""
from pathlib import Path
import os
import tempfile

import librosa
import numpy as np
import soundfile as sf

from .importer import MediaError, require_tool, run_media

SAMPLE_RATE = 22050
REFERENCE_CODEC = "pcm_s24le"


def extract_reference(raw_import, out_dir) -> Path:
    directory = Path(out_dir)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "reference.wav"
    executable = require_tool("ffmpeg")
    require_tool("ffprobe")
    with tempfile.TemporaryDirectory(dir=directory) as temporary:
        output = Path(temporary) / "reference.wav"
        # 24-bit PCM losslessly covers any real-world 8/16/24-bit integer source (virtually
        # all DJ video/audio material) and is the professional-audio bit-depth ceiling; unlike
        # a 64-bit float target it also decodes in every mainstream browser's <audio> element
        # and Web Audio decodeAudioData, which reject float64 WAV outright (confirmed: Chrome
        # returns EncodingError for pcm_f64le, aborting both playback and client-side analysis).
        # It cannot undo losses already present in MP3/AAC/etc., and a >24-bit float source
        # (rare in practice) is quantized to 24-bit here rather than kept at full precision.
        args = [executable, "-nostdin", "-v", "error", "-y", "-i", str(raw_import.path),
                "-map", "0:a:0", "-vn", "-map_metadata", "-1", "-c:a", REFERENCE_CODEC, str(output)]
        run_media(args, message="Audio extraction failed. Export the original audio as WAV and import it locally.")
        try:
            info = sf.info(output)
            if info.frames <= 0:
                raise ValueError("empty")
        except (OSError, RuntimeError, ValueError):
            raise MediaError("Audio extraction produced no readable audio. Try a local WAV export.") from None
        os.replace(output, target)
    raw_import.provenance["extractionCommand"] = ["ffmpeg", *args[1:6], "<imported-media>", *args[7:-1], "reference.wav"]
    return target
# Summary: This atomically decodes the first original audio track without trimming, remixing, or resampling.
# PCM values are preserved at decoder precision, not compressed source bytes; stream timing lives in lesson metadata.


def reference_offset(raw_import):
    audio_start = float(raw_import.metadata["audio"].get("start_time") or 0)
    file_start = float(raw_import.metadata["format"].get("start_time") or 0)
    return audio_start - file_start
# Summary: This maps decoded sample zero to seconds from the original container's start.
# It uses probe timestamps; damaged timestamps or discontinuous streams still need human review.


def make_analysis_copy(reference_wav_path, *, transformations=None):
    steps = transformations if transformations is not None else []
    try:
        samples, original_sr = sf.read(reference_wav_path, dtype="float64", always_2d=True)
    except (OSError, RuntimeError):
        raise MediaError("Cannot read reference WAV. Re-import the original file to extract it again.") from None
    if not samples.size or not np.isfinite(samples).all():
        raise MediaError("Reference PCM is empty or non-finite. Use a valid local WAV export.")
    steps.append({"step": "decode_for_analysis", "tool": f"soundfile-{sf.__version__}",
                  "params": {"dtype": "float64", "inputSampleRate": original_sr,
                             "inputChannels": samples.shape[1]}})
    if samples.shape[1] == 1:
        samples = np.repeat(samples, 2, axis=1)
        steps.append({"step": "channel_remix", "tool": "numpy", "params": {"method": "duplicate_mono", "outputChannels": 2}})
    elif samples.shape[1] > 2:
        samples = samples[:, :2]
        steps.append({"step": "channel_remix", "tool": "numpy", "params": {"method": "first_two_channels", "outputChannels": 2}})
    if original_sr != SAMPLE_RATE:
        samples = librosa.resample(samples, orig_sr=original_sr, target_sr=SAMPLE_RATE, axis=0)
        steps.append({"step": "resample", "tool": f"librosa-{librosa.__version__}",
                      "params": {"fromHz": original_sr, "toHz": SAMPLE_RATE, "resType": "soxr_hq"}})
    return samples, SAMPLE_RATE
# Summary: This makes stereo 22050 Hz PCM and appends every actual transformation to the caller's ordered log.
# Channels beyond the first two are explicitly excluded from analysis; the full reference remains intact.


def trim_analysis(samples, sr, start_seconds, end_seconds, *, reference_start=0.0, transformations=None):
    duration = len(samples) / sr
    if not np.isfinite([start_seconds, end_seconds, reference_start]).all() or not (
            reference_start <= start_seconds < end_seconds <= reference_start + duration + 1 / sr):
        raise ValueError("Segment must lie within the decoded reference audio timeline.")
    first = round((start_seconds - reference_start) * sr)
    last = min(len(samples), round((end_seconds - reference_start) * sr))
    if last <= first:
        raise ValueError("Segment must contain at least one analysis sample.")
    actual_start, actual_end = reference_start + first / sr, reference_start + last / sr
    if transformations is not None:
        transformations.append({"step": "analysis_segment", "tool": "numpy", "params": {
            "requestedStartSeconds": start_seconds, "requestedEndSeconds": end_seconds,
            "startSample": first, "endSampleExclusive": last, "actualStartSeconds": actual_start,
            "actualEndSeconds": actual_end, "toleranceSeconds": 1 / sr}})
    return samples[first:last], actual_start, actual_end
# Summary: This slices only the analysis copy with nearest-sample boundaries, within one 22050 Hz sample.
# Returned times retain the original-file origin; a user-selected segment is not a detected phrase.


def _windows(samples, sr, seconds=.05):
    values = np.asarray(samples, dtype=float)
    if values.ndim == 1:
        values = values[:, None]
    if values.ndim != 2 or not values.size or not np.isfinite(values).all() or sr <= 0:
        raise ValueError("Use nonempty finite PCM and a positive sample rate.")
    width = max(1, round(sr * seconds))
    return values, width, [values[i:i + width] for i in range(0, len(values), width)]
# Summary: This provides bounded local windows while retaining all supplied channels.
# Window boundaries limit region timing accuracy and can split individual transients.


def _regions(scores, width, sr, length):
    regions = []
    for i, score in enumerate(scores):
        if score <= 0:
            continue
        start, end = i * width / sr, min((i + 1) * width, length) / sr
        if regions and abs(regions[-1]["endSeconds"] - start) < 1e-9:
            regions[-1]["endSeconds"] = end
            regions[-1]["confidence"] = min(regions[-1]["confidence"], float(score))
        else:
            regions.append({"startSeconds": start, "endSeconds": end, "confidence": float(score)})
    return regions
# Summary: This merges contiguous flagged windows and retains their weakest heuristic score.
# Confidence is an engineering score, not a probability of a verified event.


def detect_silence(samples, sr):
    values, width, windows = _windows(samples, sr)
    scores = [.9 if np.sqrt(np.mean(w ** 2)) < .001 else 0 for w in windows]
    return _regions(scores, width, sr, len(values))
# Summary: This flags 50 ms windows below -60 dBFS RMS without deleting them.
# Quiet intentional passages and recording noise can disagree with perceived silence.


def detect_clipping(samples, sr):
    values, width, windows = _windows(samples, sr)
    scores = [min(.95, .5 + np.mean(abs(w) >= .999)) if np.any(abs(w) >= .999) else 0 for w in windows]
    return _regions(scores, width, sr, len(values))
# Summary: This flags near-full-scale samples as possible clipping on the supplied PCM.
# Peaks alone do not prove distortion, and prior limiting below full scale can escape this test.


def detect_abrupt_edits(samples, sr):
    values, width, _ = _windows(samples, sr)
    jumps = np.max(abs(np.diff(values, axis=0, prepend=values[:1])), axis=1)
    scores = [.6 if np.max(jumps[i:i + width]) > .5 else 0 for i in range(0, len(values), width)]
    return _regions(scores, width, sr, len(values))
# Summary: This flags sample jumps above 0.5 full-scale as possible abrupt edits.
# Percussion and high-frequency tones can also trigger it; edit intent is unknown.


def detect_speech_heavy_regions(samples, sr):
    values, width, windows = _windows(samples, sr, .25)
    scores = []
    for window in windows:
        power = np.mean(abs(np.fft.rfft(window * np.hanning(len(window))[:, None], axis=0)) ** 2, axis=1)
        hz = np.fft.rfftfreq(len(window), 1 / sr)
        ratio = float(power[(hz >= 300) & (hz < 3400)].sum() / max(power.sum(), 1e-12))
        scores.append(min(.6, ratio * .6) if ratio > .75 and np.sqrt(np.mean(window ** 2)) > .01 else 0)
    return _regions(scores, width, sr, len(values))
# Summary: This flags voice-band-dominant windows for review using no ASR or external service.
# Many instruments meet the same criterion; these are weak speech-heavy suggestions, not identified speech.

# Module summary: Reference decoding and analysis transformations are separate and traceable.
# Quality regions are heuristic review aids; no audio is silently trimmed or treated as controller evidence.
