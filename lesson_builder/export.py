"""Build and atomically publish validated lesson folders without modifying reference PCM."""
from copy import deepcopy
from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

import numpy as np
import soundfile as sf

from analysis.analyzer import ALGORITHM, CACHE_VERSION
from . import __version__
from .audio_prep import (extract_reference, reference_offset, make_analysis_copy, trim_analysis,
                        detect_silence, detect_clipping, detect_abrupt_edits, detect_speech_heavy_regions,
                        REFERENCE_CODEC)
from .musical_analysis import analyze_segment
from .schema import SCHEMA_VERSION, TIMELINE, annotation_document, compute_readiness, validate_lesson


@dataclass
class LessonData:
    lesson: dict
    reference_path: Path
    features: dict
    source_paths: dict = field(default_factory=dict)


def prepare_lesson(raw_import, work_dir, *, start_seconds=None, end_seconds=None,
                   human_annotations=None, source_imports=None, actions=None, title=None):
    reference = extract_reference(raw_import, Path(work_dir) / "reference")
    info = sf.info(reference)
    offset = reference_offset(raw_import)
    transformations = [{"step": "reference_decode", "tool": raw_import.provenance["ffmpegVersion"],
                        "params": {"codec": REFERENCE_CODEC, "resampled": False, "remixed": False,
                                   "audioStream": 0, "referenceStartSeconds": offset}}]
    samples, sr = make_analysis_copy(reference, transformations=transformations)
    start = max(0, offset) if start_seconds is None else start_seconds
    end = min(raw_import.duration, offset + len(samples) / sr) if end_seconds is None else end_seconds
    samples, start, end = trim_analysis(samples, sr, start, end, reference_start=offset, transformations=transformations)
    analysis = analyze_segment(samples, sr, start_seconds=start)
    transformations.append({"step": "rhythm_pitch_channel_selection", "tool": "numpy",
                            "params": {"channel": analysis["rhythmChannel"], "method": "highest_mean_square_energy"}})
    quality = {}
    for name, detector in (("silence", detect_silence), ("clipping", detect_clipping),
                           ("abruptEdits", detect_abrupt_edits), ("speechHeavySuggestions", detect_speech_heavy_regions)):
        # Quality checks use original-rate PCM for peaks; resampling can hide clipping.
        original, original_sr = sf.read(reference, dtype="float64", always_2d=True)
        first, last = round((start - offset) * original_sr), round((end - offset) * original_sr)
        regions = detector(original[first:last], original_sr)
        for region in regions:
            region["startSeconds"] += offset + first / original_sr
            region["endSeconds"] = min(end, region["endSeconds"] + offset + first / original_sr)
        quality[name] = regions
    analysis["heuristicEstimates"]["qualityRegions"] = quality
    sources, source_paths = {}, {}
    for name, raw in (source_imports or {}).items():
        if name not in ("source_A", "source_B"):
            raise ValueError("Only separately supplied source_A and source_B originals are supported.")
        source_paths[name] = extract_reference(raw, Path(work_dir) / name)
        sources[name] = {"kind": "user_supplied_original", "file": f"{name}.wav", "sha256": raw.sha256,
                         "provenance": deepcopy(raw.provenance), "originalAudioStartSeconds": reference_offset(raw)}
    identity = hashlib.sha256(json.dumps({"hash": raw_import.sha256, "start": start, "end": end,
        "annotations": human_annotations or {}, "sources": {k: v["sha256"] for k, v in sources.items()},
        "actions": actions, "version": __version__}, sort_keys=True, allow_nan=False).encode()).hexdigest()[:20]
    lesson = {"schemaVersion": SCHEMA_VERSION, "lessonId": identity,
              "title": title or "Imported lesson", "performance_group_id": raw_import.performance_group_id,
              "segment": {"startSeconds": start, "endSeconds": end}, "timeline": TIMELINE,
              "audio": {"referenceFile": "reference.wav", "referenceStartSeconds": offset,
                        "originalDurationSeconds": raw_import.duration, "referenceDurationSeconds": info.duration,
                        "referenceSampleRate": info.samplerate, "referenceChannels": info.channels,
                        "analysisSampleRate": sr, "trimOffsetSeconds": start,
                        "transformations": transformations},
              "provenance": {**deepcopy(raw_import.provenance), "probe": deepcopy(raw_import.metadata)},
              "analysisVersion": {"lessonBuilder": __version__, "rhythmAlgorithm": ALGORITHM,
                                  "rhythmCacheVersion": CACHE_VERSION},
              "measured": analysis["measured"], "heuristicEstimates": analysis["heuristicEstimates"],
              "featuresManifest": analysis["featuresManifest"],
              "humanAnnotations": deepcopy(human_annotations or {}), "sources": sources,
              "observedControllerActions": deepcopy(actions)}
    lesson["readiness"] = compute_readiness(lesson)
    return LessonData(lesson, reference, analysis["features"], source_paths)
# Summary: This assembles full reference audio, a chosen analysis segment, and independently supplied human/action data.
# Quality flags inspect original-rate PCM; supplied source identity and review declarations cannot be independently proven here.


def write_json(path, value):
    with Path(path).open("w") as handle:
        json.dump(value, handle, indent=2, allow_nan=False)
        handle.write("\n")
# Summary: This serializes finite JSON inside the caller's staging directory.
# Atomic publication is the exporter's responsibility, not a property of an individual write.


def export_lesson(lesson_data, out_root) -> Path:
    if not isinstance(lesson_data, LessonData):
        raise ValueError("export_lesson requires LessonData containing lesson metadata, PCM paths, and feature arrays.")
    lesson = deepcopy(lesson_data.lesson)
    expected = compute_readiness(lesson)
    if lesson.get("readiness", expected) != expected:
        raise ValueError("Readiness disagrees with the available sources, alignment, and actions.")
    lesson["readiness"] = expected
    errors = validate_lesson(lesson)
    if errors:
        raise ValueError("Invalid lesson: " + "; ".join(errors))
    if set(lesson_data.features) != set(lesson["featuresManifest"]):
        raise ValueError("Feature arrays must exactly match the manifest.")
    for key, values in lesson_data.features.items():
        array = np.asarray(values)
        if array.dtype.kind not in "fiu" or not np.isfinite(array).all() or list(array.shape) != lesson["featuresManifest"][key]["shape"]:
            raise ValueError(f"Invalid feature array {key}: check shape, numeric dtype, and finiteness.")
    times = np.asarray(lesson_data.features["times"])
    segment = lesson["segment"]
    if times.ndim != 1 or not times.size or np.any(np.diff(times) <= 0) or not (
            times[0] >= segment["startSeconds"] and times[-1] < segment["endSeconds"]):
        raise ValueError("Feature timestamps must be ordered within the original-file segment bounds.")
    if set(lesson_data.source_paths) != set(lesson["sources"]):
        raise ValueError("Source WAV paths must agree with separately supplied originals in metadata.")
    lesson["_validation_summary"] = {"validated": True, "schemaVersion": SCHEMA_VERSION,
                                      "validatorVersion": __version__}
    out_root = Path(out_root)
    out_root.mkdir(parents=True, exist_ok=True)
    target = out_root / f"{lesson['lessonId']}-v{SCHEMA_VERSION}"
    # Immutable folders prevent concurrent readers from seeing half an update. Exporting an
    # existing ID fails explicitly; editor changes should create a new ID/revision.
    if target.exists():
        raise FileExistsError(f"Lesson already exists: {target.name}; choose a new lessonId for a revised export.")
    with tempfile.TemporaryDirectory(prefix=".lesson-stage-", dir=out_root) as temporary:
        stage = Path(temporary) / "artifact"
        stage.mkdir()
        write_json(stage / "lesson.json", lesson)
        write_json(stage / "annotations.json", annotation_document(lesson["humanAnnotations"]))
        shutil.copyfile(lesson_data.reference_path, stage / "reference.wav")
        np.savez_compressed(stage / "features.npz", **lesson_data.features)
        for name, path in lesson_data.source_paths.items():
            shutil.copyfile(path, stage / f"{name}.wav")
        if lesson["observedControllerActions"] is not None:
            write_json(stage / "actions.json", lesson["observedControllerActions"])
        rhythm = lesson["heuristicEstimates"]["rhythm"]
        title = " ".join(str(lesson.get("title", "Imported lesson")).split())
        (stage / "summary.md").write_text(
            f"{title}: {segment['endSeconds'] - segment['startSeconds']:.3f} seconds analyzed. "
            f"BPM estimate: {rhythm['bpm'] if rhythm['bpm'] is not None else 'unknown'} "
            f"(heuristic confidence {rhythm['confidence']['score']:.3f}). "
            f"Readiness: {lesson['readiness']}.\n\n"
            "Keys, suggested mix points, and quality flags require human review. "
            "No original decks or controller actions were inferred from the recording. "
            "This artifact does not implement imitation training or establish musical teaching quality.\n")
        os.rename(stage, target)
    return target
# Summary: This validates all metadata and finite feature arrays before atomically publishing a complete immutable folder.
# Export validation checks declared contracts, not provenance authenticity or perceptual quality.

# Module summary: Exports contain separate reference, features, human annotations, and optional original sources/actions.
# Atomic directory publication avoids partial cache-like artifacts; no separation or remote AI processing exists.
