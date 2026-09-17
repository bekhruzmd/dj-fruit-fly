"""Hand-built local lesson contracts; no analyzer or media downloads are needed."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
import wave

import numpy as np
from snn_dj.lesson_loader import (load_lesson, ReferenceLesson, PairedActionsLesson,
                                  validate_alignment_and_actions, assert_no_group_leakage)


def write_fixture(folder, paired=False):
    arrays = {"times": np.array([4., 4.5]), "rms": np.array([.1, .2]),
              "chroma": np.zeros((12, 2)), "spectralFlux": np.zeros(2), "bandEnergy": np.zeros((5, 2))}
    annotations = {"notes": "Synthetic fixture"}
    actions = None
    sources = {}
    if paired:
        annotations["reviewedSourceAlignment"] = {"reviewedBy": "fixture author", "reviewedAt": "2026-09-16T00:00:00Z",
            "sourceAOffsetSeconds": 0., "sourceBOffsetSeconds": 2.}
        actions = [{"timestamp": .25, "type": "mixer_rates", "values": [.5, -.1], "source": "authored"}]
        sources = {name: {"file": f"{name}.wav", "kind": "user_supplied_original"} for name in ("source_A", "source_B")}
    data = {"schemaVersion": 1, "_validation_summary": {"validated": True, "schemaVersion": 1},
        "readiness": "paired_actions" if paired else "reference_only", "performance_group_id": "synthetic-performance",
        "segment": {"startSeconds": 4., "endSeconds": 5.}, "sources": sources,
        "humanAnnotations": annotations, "observedControllerActions": actions,
        "featuresManifest": {key: {"shape": list(value.shape)} for key, value in arrays.items()}}
    (folder / "lesson.json").write_text(json.dumps(data))
    (folder / "annotations.json").write_text(json.dumps({"schemaVersion": 1, "revision": 1, "humanAnnotations": annotations}))
    np.savez_compressed(folder / "features.npz", **arrays)
    for name in ["reference", *sources]:
        with wave.open(str(folder / f"{name}.wav"), "wb") as audio:
            audio.setparams((1, 2, 8000, 8, "NONE", "not compressed"))
            audio.writeframes(bytes(16))
    if paired:
        (folder / "actions.json").write_text(json.dumps(actions))
    return data
# Summary: This constructs minimal finite artifacts directly under the NumPy-only runtime.
# Known arrays test loading contracts, not decoder correctness or musical validity.


class LessonLoaderTests(unittest.TestCase):
    def test_reference_is_distinct_and_unsupervised(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            write_fixture(folder)
            lesson = load_lesson(folder)
            self.assertIsInstance(lesson, ReferenceLesson)
            self.assertNotIsInstance(lesson, PairedActionsLesson)
            self.assertIsNone(lesson.actions)
            self.assertEqual(lesson.features["rms"].shape, (2,))
    # Summary: This checks reference loading cannot silently produce no-op action targets; it does not train a policy.

    def test_paired_actions_and_editable_annotations(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            write_fixture(folder, True)
            lesson = load_lesson(folder)
            self.assertIsInstance(lesson, PairedActionsLesson)
            self.assertEqual(validate_alignment_and_actions(lesson), [])
            document = json.loads((folder / "annotations.json").read_text())
            document["revision"] = 2
            document["humanAnnotations"]["notes"] = "Human revised note"
            (folder / "annotations.json").write_text(json.dumps(document))
            self.assertEqual(load_lesson(folder).annotations["notes"], "Human revised note")
    # Summary: This checks valid supervision and separate annotation revisions, not review authenticity.

    def test_unsupported_types_are_named(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            write_fixture(folder, True)
            lesson = load_lesson(folder)
            lesson.actions[0]["type"] = "eq_low"
            self.assertIn("eq_low", " ".join(validate_alignment_and_actions(lesson)))
    # Summary: This checks unsupported controller dimensions are named explicitly rather than dropped.

    def test_invalid_actions_rejected_on_load(self):
        for change, pattern in [({"values": [0, 0, 0]}, "shape"), ({"values": [2, 0]}, "shape"),
                                ({"timestamp": 1.}, "timestamp"), ({"timestamp": -1}, "timestamp"),
                                ({"source": "inferred"}, "source"), ({"type": "jog_wheel"}, "jog_wheel")]:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                data = write_fixture(folder, True)
                data["observedControllerActions"][0].update(change)
                (folder / "lesson.json").write_text(json.dumps(data))
                (folder / "actions.json").write_text(json.dumps(data["observedControllerActions"]))
                with self.assertRaisesRegex(ValueError, pattern):
                    load_lesson(folder)
    # Summary: This exercises loader action provenance, time, and dimensional rejection without importing the builder.

    def test_tampered_readiness_and_missing_alignment_rejected(self):
        for mode in ("reference_only", "paired_sources", "unknown", "missing_review"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                data = write_fixture(folder, True)
                if mode == "missing_review":
                    (folder / "annotations.json").write_text(json.dumps({"schemaVersion": 1, "revision": 2, "humanAnnotations": {}}))
                else:
                    data["readiness"] = mode
                    (folder / "lesson.json").write_text(json.dumps(data))
                with self.assertRaises(ValueError):
                    load_lesson(folder)
    # Summary: This rejects readiness promotion/demotion and removed source reviews; it cannot verify an honest review.

    def test_feature_corruption_and_group_guard(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            write_fixture(folder)
            np.savez(folder / "features.npz", times=np.array([np.nan]))
            with self.assertRaises(ValueError):
                load_lesson(folder)
        assert_no_group_leakage(["show-a", "show-a"], ["show-b"])
        with self.assertRaisesRegex(ValueError, "show-a"):
            assert_no_group_leakage(["show-a", "show-b"], ["show-a"])
    # Summary: This rejects malformed features and known performance overlap, not undiscovered media duplicates.

# Module summary: These fixtures test safe loading and explicit supervision distinctions under .venv-snn.
# No test claims that valid artifacts supply an imitation algorithm or perceptually good lessons.
