"""Local measurements and explicitly uncertain musical estimates for one segment."""
import librosa
import numpy as np

from analysis.analyzer import ALGORITHM, CACHE_VERSION, CONFIG, estimate_rhythm
from .audio_prep import SAMPLE_RATE

HOP = CONFIG["hopLength"]
FFT_SIZE = 2048
# Half-open Hz bands; the last includes Nyquist. These broad divisions are engineering choices.
BAND_EDGES = [0, 60, 250, 1000, 4000, SAMPLE_RATE / 2]
KEY_PROFILES = {
    "major": [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    "minor": [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
}


def possible_keys(chroma):
    """Rank whole-segment profiles; a mixed recording can contain simultaneous keys/tempos."""
    average = np.mean(chroma, axis=1)
    centered = average - average.mean()
    norm = np.linalg.norm(centered)
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    candidates = []
    for mode, values in KEY_PROFILES.items():
        profile = np.asarray(values) - np.mean(values)
        for tonic, name in enumerate(names):
            correlation = float(centered @ np.roll(profile, tonic) / max(norm * np.linalg.norm(profile), 1e-12))
            candidates.append({"key": f"{name} {mode}", "correlation": correlation,
                               "confidence": min(.85, max(0, correlation)) if norm > 1e-8 else 0.0})
    return sorted(candidates, key=lambda item: item["confidence"], reverse=True)
# Summary: This ranks all 24 major/minor Krumhansl-Schmuckler profile correlations rather than forcing one key.
# Correlation-derived confidence is uncalibrated; modal music, percussion, overlaps, and modulation can mislead it.


def suggest_transition_regions(times, rms, *, end_seconds):
    if len(times) < 3 or np.max(rms) < .001:
        return []
    trend = abs(np.diff(rms, prepend=rms[0]))
    threshold = max(.02, float(np.percentile(trend, 95)))
    candidates = []
    for i in np.argsort(trend)[::-1]:
        if trend[i] < threshold or any(abs(float(times[i]) - r["startSeconds"]) < 1 for r in candidates):
            continue
        start = max(float(times[0]), float(times[i]) - .25)
        end = min(end_seconds, float(times[i]) + .5)
        candidates.append({"startSeconds": start, "endSeconds": end,
                           "confidence": min(.65, float(trend[i] / max(np.max(rms), .001))), "label": "suggested"})
        if len(candidates) == 6:
            break
    return sorted(candidates, key=lambda region: region["startSeconds"])
# Summary: This suggests up to six energy-change neighborhoods for human audition.
# Loud attacks can dominate; these are suggested mix points, never confirmed transitions or phrases.


def analyze_segment(samples, sr, *, start_seconds=0.0):
    if sr != SAMPLE_RATE:
        raise ValueError("Musical analysis expects the documented 22050 Hz copy.")
    samples = np.asarray(samples, dtype=float)
    if samples.ndim != 2 or samples.shape[1] != 2 or not samples.size or not np.isfinite(samples).all():
        raise ValueError("Analysis requires finite nonempty stereo PCM.")
    duration = len(samples) / sr
    # Select the most energetic channel only for pitch/rhythm, preserving anti-phase material.
    channel = int(np.argmax(np.mean(samples ** 2, axis=0)))
    rhythm = estimate_rhythm(samples[:, channel], sr, duration)
    for key in ("beatTimes", "onsetTimes"):
        rhythm[key] = [t + start_seconds for t in rhythm[key]]
    if rhythm["gridOffsetSeconds"] is not None:
        rhythm["gridOffsetSeconds"] += start_seconds
    count = (len(samples) - 1) // HOP + 1
    times = start_seconds + np.arange(count) * HOP / sr
    spectra = np.stack([librosa.stft(samples[:, c], n_fft=FFT_SIZE, hop_length=HOP,
                                    center=True, pad_mode="constant")[:, :count] for c in range(2)])
    # A one-sided periodogram normalized by window energy measures mean-square full-scale energy.
    power = np.mean(abs(spectra) ** 2, axis=0) / (FFT_SIZE * np.sum(np.hanning(FFT_SIZE + 1)[:-1] ** 2))
    power[1:-1] *= 2
    hz = np.fft.rfftfreq(FFT_SIZE, 1 / sr)
    bands = np.stack([power[(hz >= lo) & ((hz < hi) if hi < sr / 2 else (hz <= hi))].sum(axis=0)
                      for lo, hi in zip(BAND_EDGES, BAND_EDGES[1:])])
    magnitude = np.sqrt(power)
    flux = np.maximum(np.diff(magnitude, axis=1, prepend=magnitude[:, :1]), 0).sum(axis=0)
    padded = np.pad(samples, ((FFT_SIZE // 2, FFT_SIZE // 2), (0, 0)))
    rms = np.array([np.sqrt(np.mean(padded[i * HOP:i * HOP + FFT_SIZE] ** 2)) for i in range(count)])
    chroma = librosa.feature.chroma_stft(S=abs(spectra[channel]) ** 2, sr=sr, n_fft=FFT_SIZE, hop_length=HOP)
    arrays = {"times": times, "rms": rms, "spectralFlux": flux, "bandEnergy": bands, "chroma": chroma}
    units = {"times": "seconds", "rms": "full_scale_amplitude", "spectralFlux": "full_scale_amplitude_per_hop",
             "bandEnergy": "full_scale_squared", "chroma": "relative_pitch_class_strength"}
    manifest = {key: {"units": units[key], "sampleRate": sr, "hopLength": HOP,
                      "timestampOrigin": "original_file_start", "frameConvention": "centered_zero_padded",
                      "fftSize": FFT_SIZE, "shape": list(value.shape),
                      "namespace": "heuristicEstimates" if key == "chroma" else "measured"}
                for key, value in arrays.items()}
    manifest["bandEnergy"]["bandEdgesHz"] = BAND_EDGES
    estimates = {"rhythm": rhythm, "chroma": {"npzKey": "chroma"}, "possibleKeys": possible_keys(chroma),
                 "suggestedTransitionRegions": suggest_transition_regions(times, rms, end_seconds=start_seconds + duration),
                 "warnings": ["Suggested mix points and key candidates require human audition. "
                              "The whole segment may contain simultaneous keys or tempos; no controller actions are inferred."]}
    return {"features": arrays, "featuresManifest": manifest,
            "measured": {key: {"npzKey": key} for key in arrays if key != "chroma"},
            "heuristicEstimates": estimates, "rhythmChannel": channel}
# Summary: This measures stereo energy and spectral changes while reusing the repository's sole offline beat tracker.
# Chroma, keys, and rhythmic events remain heuristic; hop timestamps and edge padding limit temporal precision.

# Module summary: This supplies traceable arrays and whole-segment musical suggestions without ASR, vision, or separation.
# It cannot establish ground-truth keys, controller actions, downbeats, or transition quality.
