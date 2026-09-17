"""Versioned lesson contract; no detector can supply human or controller evidence."""
from enum import Enum
import math
import re

SCHEMA_VERSION = 1
ANNOTATIONS_VERSION = 1
ACTION_TYPE = "mixer_rates"
TIMELINE = ("All feature/event times are seconds from the original imported file start. "
            "reference.wav sample zero is audio.referenceStartSeconds. Segment bounds are "
            "half-open original-file seconds; actions[].timestamp is seconds relative to "
            "segment.startSeconds. Source sample zero maps to the reviewed sourceAOffsetSeconds "
            "or sourceBOffsetSeconds on the original reference timeline.")


class Readiness(str, Enum):
    REFERENCE_ONLY = "reference_only"
    PAIRED_SOURCES = "paired_sources"
    PAIRED_ACTIONS = "paired_actions"


def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
# Summary: This excludes booleans and non-finite values from numeric schema fields.
# It validates representation, not measurement accuracy.


def alignment_errors(annotations):
    alignment = annotations.get("reviewedSourceAlignment") if isinstance(annotations, dict) else None
    if not isinstance(alignment, dict):
        return ["Paired sources require humanAnnotations.reviewedSourceAlignment."]
    errors = []
    for field in ("reviewedBy", "reviewedAt"):
        if not isinstance(alignment.get(field), str) or not alignment[field].strip():
            errors.append(f"reviewedSourceAlignment.{field} is required.")
    for field in ("sourceAOffsetSeconds", "sourceBOffsetSeconds"):
        if not finite_number(alignment.get(field)):
            errors.append(f"reviewedSourceAlignment.{field} must be finite original-file seconds.")
    return errors
# Summary: This requires named human review and signed offsets for separately supplied sources.
# A recorded review is a declaration; this function cannot establish that the tracks truly align.


def validate_actions(actions, segment):
    if not isinstance(actions, list) or not actions:
        return ["observedControllerActions must be a nonempty action timeline or null."]
    errors = []
    duration = segment.get("endSeconds", 0) - segment.get("startSeconds", 0)
    previous = -1.0
    for index, event in enumerate(actions):
        label = f"actions[{index}]"
        if not isinstance(event, dict):
            errors.append(f"{label} must be an object.")
            continue
        if event.get("source") not in ("controller_log", "authored"):
            errors.append(f"{label}.source must be controller_log or authored.")
        if event.get("type") != ACTION_TYPE:
            errors.append(f"{label}: UNSUPPORTED action type {event.get('type')!r}; supported: {ACTION_TYPE}.")
        time = event.get("timestamp")
        if not finite_number(time) or not 0 <= time < duration:
            errors.append(f"{label}.timestamp must lie within [0, segment duration).")
        elif time < previous:
            errors.append(f"{label}.timestamp must be ordered.")
        else:
            previous = time
        values = event.get("values")
        if not isinstance(values, list) or len(values) != 2 or any(
                not finite_number(v) or not -1 <= v <= 1 for v in values):
            errors.append(f"{label}.values must have shape (2,) with finite values in [-1, 1] "
                          "(crossfade-rate, speed-rate increments).")
        unsupported = set(event) - {"source", "type", "timestamp", "values"}
        if unsupported:
            errors.append(f"{label}: UNSUPPORTED action fields {', '.join(sorted(unsupported))}.")
    return errors
# Summary: This enforces OfflineMixer's two bounded rate increments and explicit action provenance.
# It neither infers controls from recordings nor converts unsupported EQ/jog/absolute-fader commands.


def compute_readiness(lesson):
    sources = lesson.get("sources", {})
    if not isinstance(sources, dict):
        raise ValueError("sources must be an object.")
    actions = lesson.get("observedControllerActions")
    if not sources:
        if actions is not None:
            raise ValueError("reference_only lessons must have null observedControllerActions.")
        return Readiness.REFERENCE_ONLY.value
    if set(sources) != {"source_A", "source_B"}:
        raise ValueError("Supply both separately provided original tracks source_A and source_B.")
    errors = alignment_errors(lesson.get("humanAnnotations"))
    if errors:
        raise ValueError("; ".join(errors))
    if actions is not None:
        errors = validate_actions(actions, lesson.get("segment", {}))
        if errors:
            raise ValueError("; ".join(errors))
        return Readiness.PAIRED_ACTIONS.value
    return Readiness.PAIRED_SOURCES.value
# Summary: This derives readiness only from paired original sources, human review, and valid action entries.
# Readiness indicates available supervision, not verified teaching quality or an implemented imitation algorithm.


def annotation_document(human_annotations, revision=1):
    return {"schemaVersion": ANNOTATIONS_VERSION, "revision": revision, "humanAnnotations": human_annotations}
# Summary: This versions the editable human namespace separately from detector features.
# A revision number tracks editing; it does not authenticate a reviewer.


def validate_lesson(lesson_dict) -> list[str]:
    if not isinstance(lesson_dict, dict):
        return ["Lesson must be an object."]
    lesson = lesson_dict
    errors = []
    if lesson.get("schemaVersion") != SCHEMA_VERSION:
        errors.append("Unsupported schemaVersion.")
    if not isinstance(lesson.get("lessonId"), str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", lesson["lessonId"]):
        errors.append("lessonId must be a safe 1-100 character folder identifier.")
    if not isinstance(lesson.get("performance_group_id"), str) or not lesson["performance_group_id"].strip():
        errors.append("performance_group_id is required.")
    segment = lesson.get("segment")
    valid_segment = isinstance(segment, dict) and all(finite_number(segment.get(k)) for k in ("startSeconds", "endSeconds"))
    if not valid_segment or not 0 <= segment["startSeconds"] < segment["endSeconds"]:
        errors.append("segment must have finite, increasing, nonnegative original-file bounds.")
        valid_segment = False
    for field in ("measured", "heuristicEstimates", "humanAnnotations", "audio", "provenance", "analysisVersion", "featuresManifest"):
        if not isinstance(lesson.get(field), dict):
            errors.append(f"{field} must be an object.")
    if "observedControllerActions" not in lesson:
        errors.append("observedControllerActions must explicitly be null or an action timeline.")
    if valid_segment:
        try:
            expected = compute_readiness(lesson)
            if lesson.get("readiness") != expected:
                errors.append(f"readiness must be computed as {expected}.")
        except (ValueError, TypeError) as error:
            errors.append(str(error))
    sources = lesson.get("sources", {})
    if isinstance(sources, dict):
        for name, source in sources.items():
            if not isinstance(source, dict) or source.get("kind") != "user_supplied_original":
                errors.append(f"{name} must be a user_supplied_original, never a separated stem.")
                continue
            if source.get("file") != f"{name}.wav" or not re.fullmatch(r"[a-f0-9]{64}", str(source.get("sha256", ""))):
                errors.append(f"{name} requires its fixed WAV filename and original file sha256.")
    audio = lesson.get("audio", {})
    if isinstance(audio, dict):
        for key in ("originalDurationSeconds", "referenceStartSeconds", "referenceDurationSeconds", "referenceSampleRate", "analysisSampleRate"):
            if not finite_number(audio.get(key)):
                errors.append(f"audio.{key} must be finite.")
        if valid_segment and finite_number(audio.get("originalDurationSeconds")) and segment["endSeconds"] > audio["originalDurationSeconds"] + 1e-4:
            errors.append("Segment exceeds original duration.")
        if audio.get("referenceFile") != "reference.wav":
            errors.append("audio.referenceFile must be reference.wav.")
        steps = audio.get("transformations")
        if not isinstance(steps, list) or any(not isinstance(s, dict) or not all(k in s for k in ("step", "tool", "params")) for s in steps):
            errors.append("audio.transformations requires an ordered list of step/tool/params objects.")
    if lesson.get("timeline") != TIMELINE:
        errors.append("timeline must document the supported original-file and segment-relative action convention.")
    manifest = lesson.get("featuresManifest", {})
    expected_arrays = {"times", "rms", "spectralFlux", "bandEnergy", "chroma"}
    if not isinstance(manifest, dict) or set(manifest) != expected_arrays:
        errors.append("featuresManifest must describe times/rms/spectralFlux/bandEnergy/chroma.")
    else:
        for key, entry in manifest.items():
            if not isinstance(entry, dict) or not all(k in entry for k in ("units", "sampleRate", "hopLength", "timestampOrigin", "shape", "namespace")):
                errors.append(f"featuresManifest.{key} lacks units/timing/shape/namespace.")
            elif entry["timestampOrigin"] != "original_file_start" or entry["namespace"] != ("heuristicEstimates" if key == "chroma" else "measured"):
                errors.append(f"featuresManifest.{key} has an invalid timeline or namespace.")
    measured = lesson.get("measured", {})
    if isinstance(measured, dict) and set(measured) != {"times", "rms", "spectralFlux", "bandEnergy"}:
        errors.append("measured must contain only the four measured feature references.")
    estimates = lesson.get("heuristicEstimates", {})
    if isinstance(estimates, dict):
        for region in estimates.get("suggestedTransitionRegions", []):
            if not isinstance(region, dict) or region.get("label") != "suggested":
                errors.append("Transition regions must be explicitly labeled suggested.")
    # Confidence fields throughout the document are bounded scores, not accuracy probabilities.
    def check_confidence(value, path):
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "confidence":
                    score = item.get("score") if isinstance(item, dict) else item
                    if not finite_number(score) or not 0 <= score <= 1:
                        errors.append(f"{path}.confidence must be in [0, 1].")
                check_confidence(item, f"{path}.{key}")
        elif isinstance(value, list):
            for item in value:
                check_confidence(item, path)
    # Summary: This traverses nested confidence declarations without interpreting them as calibrated probabilities.
    check_confidence(lesson, "lesson")
    return errors
# Summary: This validates representation, provenance boundaries, timing, and computed teaching readiness.
# It cannot establish copyright permission, genuine controller capture, or whether human review was careful.


def assert_no_group_leakage(train_group_ids, eval_group_ids):
    overlap = set(train_group_ids) & set(eval_group_ids)
    if overlap:
        raise ValueError("Performance group leakage: " + ", ".join(sorted(overlap)))
# Summary: This rejects train/eval reuse of an explicitly shared performance identifier.
# Undiscovered duplicates with different fallback hashes remain unknown and need curator review.

# Module summary: The schema separates measured signals, heuristic estimates, human annotations, and explicit actions.
# Validation supports reproducible artifacts; it does not recover hidden deck sources or prove a training method works.
