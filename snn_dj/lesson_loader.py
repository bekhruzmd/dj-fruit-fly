"""Load exported lessons using stdlib and NumPy, without the analysis environment.

The existing learning.run_episode reward-modulated STDP loop learns from live
rendered consequences, NOT by imitating a finished recording. Reference-only
lessons support listening comparisons/reference objectives. Using them as action
supervision requires a DIFFERENT training algorithm and actual action targets.
Behavior cloning against observedControllerActions is NOT implemented here.
"""
from dataclasses import dataclass
import json
import math
from pathlib import Path

import numpy as np

SUPPORTED_SCHEMA_VERSION = 1
READINESS = {"reference_only", "paired_sources", "paired_actions"}


@dataclass
class Lesson:
    folder: Path
    metadata: dict
    annotations: dict
    features: dict
    actions: None = None


@dataclass
class ReferenceLesson(Lesson):
    """No action supervision; None must never be expanded into zero/no-op targets."""


@dataclass
class PairedSourcesLesson(Lesson):
    """Reviewed separate sources are available; action supervision remains absent."""


@dataclass
class PairedActionsLesson(Lesson):
    actions: list | None = None


def _finite(value):
    return isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value)
# Summary: This checks finite numeric representation without importing analysis dependencies.
# Finite values are not evidence of authentic controller capture.


def validate_alignment_and_actions(lesson) -> list[str]:
    errors = []
    data = lesson.metadata
    sources = data.get("sources", {})
    status = data.get("readiness")
    if status not in READINESS:
        errors.append("Unsupported readiness.")
    segment = data.get("segment", {})
    if not isinstance(segment, dict) or not all(_finite(segment.get(k)) for k in ("startSeconds", "endSeconds")) or not (
            0 <= segment["startSeconds"] < segment["endSeconds"]):
        return ["Invalid original-file segment bounds."]
    duration = segment["endSeconds"] - segment["startSeconds"]
    if status == "reference_only":
        if sources or lesson.actions is not None or data.get("observedControllerActions") is not None:
            errors.append("reference_only cannot contain sources or action supervision.")
        return errors
    if not isinstance(sources, dict) or set(sources) != {"source_A", "source_B"}:
        errors.append("Paired lessons require separately supplied source_A and source_B.")
    else:
        for name, source in sources.items():
            if not isinstance(source, dict) or source.get("kind") != "user_supplied_original" or source.get("file") != f"{name}.wav":
                errors.append(f"{name} must be a separately supplied original WAV.")
    alignment = lesson.annotations.get("reviewedSourceAlignment") if isinstance(lesson.annotations, dict) else None
    if not isinstance(alignment, dict):
        errors.append("Paired lessons require reviewedSourceAlignment.")
    else:
        for field in ("reviewedBy", "reviewedAt"):
            if not isinstance(alignment.get(field), str) or not alignment[field].strip():
                errors.append(f"reviewedSourceAlignment.{field} is required.")
        for field in ("sourceAOffsetSeconds", "sourceBOffsetSeconds"):
            if not _finite(alignment.get(field)):
                errors.append(f"reviewedSourceAlignment.{field} must be finite.")
    if status == "paired_sources":
        if lesson.actions is not None or data.get("observedControllerActions") is not None:
            errors.append("paired_sources must not carry action supervision.")
        return errors
    actions = lesson.actions
    if not isinstance(actions, list) or not actions:
        errors.append("paired_actions requires a nonempty action timeline.")
        return errors
    previous = -1.0
    for index, event in enumerate(actions):
        name = f"actions[{index}]"
        if not isinstance(event, dict):
            errors.append(f"{name} must be an object.")
            continue
        if event.get("type") != "mixer_rates":
            errors.append(f"{name}: UNSUPPORTED action type {event.get('type')!r}; supported: mixer_rates.")
        if event.get("source") not in ("controller_log", "authored"):
            errors.append(f"{name}.source must be controller_log or authored.")
        time = event.get("timestamp")
        if not _finite(time) or not 0 <= time < duration:
            errors.append(f"{name}.timestamp must lie within [0, segment duration).")
        elif time < previous:
            errors.append(f"{name}.timestamp must be ordered.")
        else:
            previous = time
        values = event.get("values")
        if not isinstance(values, list) or len(values) != 2 or any(not _finite(v) or abs(v) > 1 for v in values):
            errors.append(f"{name}.values must have shape (2,) with finite values in [-1, 1].")
        unsupported = set(event) - {"source", "type", "timestamp", "values"}
        if unsupported:
            errors.append(f"{name}: UNSUPPORTED action fields {', '.join(sorted(unsupported))}.")
    return errors
# Summary: This independently checks reviewed source alignment and OfflineMixer's two-action supervision contract.
# Duplicate minimal validation deliberately avoids librosa and does not convert raw MIDI/unknown actions into supported controls.


def load_lesson(folder_path) -> Lesson:
    folder = Path(folder_path)
    try:
        data = json.loads((folder / "lesson.json").read_text())
        annotations = json.loads((folder / "annotations.json").read_text())
        if not isinstance(data, dict) or data.get("schemaVersion") != SUPPORTED_SCHEMA_VERSION:
            raise ValueError("Unsupported lesson schemaVersion.")
        summary = data.get("_validation_summary", {})
        if not isinstance(summary, dict) or summary.get("validated") is not True or summary.get("schemaVersion") != SUPPORTED_SCHEMA_VERSION:
            raise ValueError("Lesson lacks the supported export validation summary.")
        if data.get("readiness") not in READINESS:
            raise ValueError("Unsupported readiness.")
        if not isinstance(annotations, dict) or annotations.get("schemaVersion") != 1 or not isinstance(annotations.get("humanAnnotations"), dict):
            raise ValueError("Unsupported annotations document.")
        if not isinstance(annotations.get("revision"), int) or annotations["revision"] < 1:
            raise ValueError("Annotations need a positive revision.")
        # The separately versioned editor document is authoritative for human annotations.
        data["humanAnnotations"] = annotations["humanAnnotations"]
        actions = None
        if (folder / "actions.json").exists():
            actions = json.loads((folder / "actions.json").read_text())
        if actions != data.get("observedControllerActions"):
            raise ValueError("actions.json disagrees with observedControllerActions.")
        if data["readiness"] != "paired_actions" and (folder / "actions.json").exists():
            raise ValueError("Only paired_actions lessons can contain actions.json.")
        with np.load(folder / "features.npz", allow_pickle=False) as archive:
            features = {key: archive[key] for key in archive.files}
        manifest = data.get("featuresManifest", {})
        if not isinstance(manifest, dict) or set(features) != set(manifest) or not features:
            raise ValueError("Feature arrays disagree with the manifest.")
        for key, array in features.items():
            if array.dtype.kind not in "fiu" or not np.isfinite(array).all() or not isinstance(manifest[key], dict) or list(array.shape) != manifest[key].get("shape"):
                raise ValueError(f"Invalid feature array {key}.")
        cls = {"reference_only": ReferenceLesson, "paired_sources": PairedSourcesLesson,
               "paired_actions": PairedActionsLesson}[data["readiness"]]
        lesson = cls(folder, data, annotations["humanAnnotations"], features, actions)
        errors = validate_alignment_and_actions(lesson)
        if errors:
            raise ValueError("; ".join(errors))
        if not isinstance(data.get("performance_group_id"), str) or not data["performance_group_id"]:
            raise ValueError("performance_group_id is required for leakage-safe grouping.")
        times = features.get("times")
        segment = data["segment"]
        if times is None or times.ndim != 1 or not times.size or np.any(np.diff(times) <= 0) or times[0] < segment["startSeconds"] or times[-1] >= segment["endSeconds"]:
            raise ValueError("Feature timestamps must lie within original-file segment bounds.")
        for name in data.get("sources", {}):
            if not (folder / f"{name}.wav").is_file():
                raise ValueError(f"Missing {name}.wav.")
        if not (folder / "reference.wav").is_file():
            raise ValueError("Missing reference.wav.")
        return lesson
    except (OSError, KeyError, TypeError, AttributeError) as error:
        raise ValueError("Incomplete lesson folder; re-export it with Lesson Builder.") from error
# Summary: This loads finite exported arrays and independently checks readiness, timelines, and action dimensions.
# The validation-summary flag is a compatibility contract, not a signature; PCM is not decoded or authenticated here.


def assert_no_group_leakage(train_group_ids, eval_group_ids):
    overlap = set(train_group_ids) & set(eval_group_ids)
    if overlap:
        raise ValueError("Performance group leakage: " + ", ".join(sorted(overlap)))
# Summary: This mirrors the schema's pure grouping guard without crossing Python environments.
# It only catches duplicates already assigned the same performance identity.

# Module summary: Reference-only and paired-action lessons load as distinct types with explicitly absent/present targets.
# Loading supports inspection and future algorithms; it does not add imitation learning to the existing STDP loop.
