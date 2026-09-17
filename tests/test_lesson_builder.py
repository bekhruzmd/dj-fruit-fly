"""Synthetic local media tests for the lesson contract and actual ffmpeg boundary."""
from copy import deepcopy
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import soundfile as sf

from lesson_builder.audio_prep import (extract_reference, make_analysis_copy, trim_analysis,
                                      detect_silence, detect_clipping)
from lesson_builder.export import prepare_lesson, export_lesson
from lesson_builder.importer import (import_local_file, import_url, SetupError, MediaError,
                                    URLImportError, require_tool)
from lesson_builder.schema import validate_lesson, assert_no_group_leakage, compute_readiness
from snn_dj.lesson_loader import load_lesson, ReferenceLesson, PairedActionsLesson


def synthetic_audio(path, sr=32000, seconds=3):
    t = np.arange(round(sr * seconds)) / sr
    audio = .12 * np.sin(2 * np.pi * 220 * t) + .08 * np.sin(2 * np.pi * 330 * t)
    for start in np.arange(.32, seconds, .5):
        local = t - start
        audio += .4 * np.sin(2 * np.pi * 85 * local) * np.exp(-np.maximum(local, 0) * 65) * (local >= 0)
    sf.write(path, np.column_stack([audio, -audio]), sr, subtype="PCM_24")
    return sf.read(path, always_2d=True)[0]
# Summary: This creates short anti-phase original PCM with known attacks and no downloaded music.
# A few seconds deliberately cannot establish a stable tempo or realistic mixing behavior.


def paired_inputs(raw):
    return {"source_imports": {"source_A": raw, "source_B": raw},
            "human_annotations": {"reviewedSourceAlignment": {"reviewedBy": "test author",
                "reviewedAt": "2026-09-16T00:00:00Z", "sourceAOffsetSeconds": 0, "sourceBOffsetSeconds": .1}},
            "actions": [{"timestamp": .2, "source": "authored", "type": "mixer_rates", "values": [.5, -.1]}]}
# Summary: This explicitly authors a teaching target and review record for two supplied synthetic originals.
# Reusing one fixture as both originals tests storage contracts, not a realistic two-track mix.


class LessonBuilderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.audio = self.root / "source.wav"
        self.pcm = synthetic_audio(self.audio)
        self.raw = import_local_file(self.audio, True)
    # Summary: This gives each test an isolated, real-probed synthetic audio file; no network is involved.

    def test_permission_enforced_before_io(self):
        for permission in (False, 1, "true", None):
            with self.subTest(permission=permission), self.assertRaisesRegex(ValueError, "permission"):
                import_local_file(self.root / "missing", permission)
            with self.assertRaisesRegex(ValueError, "permission"):
                import_url("https://example.invalid/clip", permission)
    # Summary: This verifies explicit boolean permission gates both import routes before any download or decode.

    def test_reference_exact_pcm_and_trim_timing(self):
        reference = extract_reference(self.raw, self.root / "decode")
        pcm, sr = sf.read(reference, always_2d=True)
        self.assertEqual(sr, 32000)
        np.testing.assert_array_equal(pcm, self.pcm)
        steps = []
        samples, analysis_sr = make_analysis_copy(reference, transformations=steps)
        cut, start, end = trim_analysis(samples, analysis_sr, .731, 2.111, transformations=steps)
        self.assertLessEqual(abs(start - .731), 1 / analysis_sr)
        self.assertLessEqual(abs(end - 2.111), 1 / analysis_sr)
        self.assertAlmostEqual(len(cut) / analysis_sr, end - start)
        self.assertIn("resample", [step["step"] for step in steps])
        np.testing.assert_array_equal(sf.read(reference, always_2d=True)[0], self.pcm)
    # Summary: This exercises real ffmpeg decoding, exact 24-bit PCM preservation, and one-analysis-sample trim tolerance.

    def test_real_video_and_original_timestamps(self):
        video = self.root / "synthetic.mkv"
        subprocess.run([require_tool("ffmpeg"), "-nostdin", "-v", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=size=32x32:rate=10:duration=2",
            "-itsoffset", "0.25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=32000:duration=1.5",
            "-map", "0:v", "-map", "1:a", "-c:v", "ffv1", "-c:a", "pcm_s16le", str(video)],
            check=True, capture_output=True, timeout=30)
        raw = import_local_file(video, True)
        built = prepare_lesson(raw, self.root / "video-work", start_seconds=.5, end_seconds=1.5)
        self.assertAlmostEqual(built.lesson["audio"]["referenceStartSeconds"], .25, places=3)
        self.assertLessEqual(abs(built.features["times"][0] - .5), 1 / 22050)
        self.assertTrue(all(.5 - 1 / 22050 <= t < 1.5 for t in built.features["times"]))
        self.assertEqual(validate_lesson(built.lesson), [])
    # Summary: This muxes synthetic video with delayed audio and verifies analysis stays on the original container timeline.

    def test_media_failures_are_actionable(self):
        malformed = self.root / "broken.mp4"
        malformed.write_bytes(b"not media")
        with self.assertRaisesRegex(MediaError, "Export"):
            import_local_file(malformed, True)
        video = self.root / "silent-video.mkv"
        subprocess.run([require_tool("ffmpeg"), "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
                        "testsrc=size=32x32:rate=1:duration=1", "-c:v", "ffv1", str(video)],
                       check=True, capture_output=True, timeout=30)
        with self.assertRaisesRegex(MediaError, "no audio"):
            import_local_file(video, True)
        with patch("lesson_builder.importer.subprocess.run", side_effect=subprocess.CalledProcessError(1, ["ffmpeg"])):
            with self.assertRaisesRegex(MediaError, "WAV"):
                extract_reference(self.raw, self.root / "failure")
        with patch("lesson_builder.importer.shutil.which", return_value=None):
            with self.assertRaisesRegex(SetupError, "ffmpeg/ffprobe.*brew install ffmpeg"):
                extract_reference(self.raw, self.root / "missing")
            with self.assertRaisesRegex(SetupError, "yt-dlp is missing"):
                import_url("https://example.invalid/clip", True)
    # Summary: This covers malformed media, missing audio, extraction failure, and distinct setup errors without live URLs.

    def test_url_timeout_and_safe_arguments(self):
        with patch("lesson_builder.importer.shutil.which", side_effect=lambda name: f"/tools/{name}"), patch(
                "lesson_builder.importer.subprocess.run", side_effect=subprocess.TimeoutExpired(["yt-dlp"], 180)) as run:
            with self.assertRaisesRegex(URLImportError, "Download the clip yourself"):
                import_url("https://example.invalid/clip?token=secret", True, self.root)
        args = run.call_args.args[0]
        self.assertIsInstance(args, list)
        self.assertIn("--ignore-config", args)
        self.assertIn("--max-filesize", args)
        self.assertNotIn("secret", " ".join(args))
        self.assertEqual(run.call_args.kwargs["timeout"], 180)
        self.assertNotIn("shell", run.call_args.kwargs)
        self.assertFalse(any("cookie" in arg or arg in ("--username", "--password") for arg in args))
    # Summary: This mocks a URL timeout and checks bounded, auth-free argument construction; no platform is contacted.

    def test_silence_clipping_regions(self):
        audio = np.zeros((22050 * 2, 2))
        audio[22050:] = .2
        audio[30000:30100] = 1
        silence = detect_silence(audio, 22050)
        clipped = detect_clipping(audio, 22050)
        self.assertEqual(silence[0]["startSeconds"], 0)
        self.assertLess(abs(silence[0]["endSeconds"] - 1), .051)
        self.assertTrue(any(r["startSeconds"] <= 30000 / 22050 < r["endSeconds"] for r in clipped))
        self.assertTrue(all(0 <= r["confidence"] <= 1 for r in silence + clipped))
    # Summary: This locates known quiet/full-scale PCM windows; it does not establish detector accuracy on real music.

    def test_round_trip_reference_and_atomic_export(self):
        built = prepare_lesson(self.raw, self.root / "work", start_seconds=.5, end_seconds=2.5)
        folder = export_lesson(built, self.root / "out")
        document = json.loads((folder / "lesson.json").read_text())
        self.assertEqual(validate_lesson(document), [])
        for key, value in built.lesson.items():
            self.assertEqual(document[key], value)
        self.assertEqual(set(p.name for p in folder.iterdir()), {"lesson.json", "annotations.json", "reference.wav", "features.npz", "summary.md"})
        self.assertIsInstance(load_lesson(folder), ReferenceLesson)
        self.assertIsNone(load_lesson(folder).actions)
        with self.assertRaises(FileExistsError):
            export_lesson(built, self.root / "out")
        self.assertFalse(list((self.root / "out").glob(".lesson-stage-*")))
        self.assertIsNone(document["heuristicEstimates"]["rhythm"]["bpm"])
        self.assertEqual(len(document["heuristicEstimates"]["possibleKeys"]), 24)
    # Summary: This checks complete immutable folder publication and exact metadata round-trip, not perceptual estimates.

    def test_paired_sources_and_actions(self):
        inputs = paired_inputs(self.raw)
        built = prepare_lesson(self.raw, self.root / "paired", **inputs)
        self.assertEqual(built.lesson["readiness"], "paired_actions")
        folder = export_lesson(built, self.root / "out")
        self.assertIsInstance(load_lesson(folder), PairedActionsLesson)
        self.assertEqual(load_lesson(folder).actions, inputs["actions"])
        built.lesson["observedControllerActions"] = None
        built.lesson["readiness"] = compute_readiness(built.lesson)
        built.lesson["lessonId"] = "sources-only"
        sources = export_lesson(built, self.root / "out")
        self.assertEqual(load_lesson(sources).metadata["readiness"], "paired_sources")
        self.assertIsNone(load_lesson(sources).actions)
    # Summary: This verifies supplied original sources and reviewed action targets change readiness, never inferred estimates.

    def test_invalid_actions_and_reference_promotion_rejected(self):
        built = prepare_lesson(self.raw, self.root / "paired", **paired_inputs(self.raw))
        for field, value in [("source", "audio_inferred"), ("timestamp", 3), ("timestamp", -.1),
                              ("values", [0]), ("values", [1.1, 0]), ("type", "eq_low")]:
            with self.subTest(field=field, value=value):
                broken = deepcopy(built)
                broken.lesson["observedControllerActions"][0][field] = value
                self.assertTrue(validate_lesson(broken.lesson))
                with self.assertRaises(ValueError):
                    export_lesson(broken, self.root / "out")
        reference = prepare_lesson(self.raw, self.root / "ref")
        reference.lesson["observedControllerActions"] = built.lesson["observedControllerActions"]
        with self.assertRaisesRegex(ValueError, "reference_only"):
            export_lesson(reference, self.root / "out")
        broken = deepcopy(built)
        broken.lesson["humanAnnotations"] = {}
        self.assertTrue(validate_lesson(broken.lesson))
    # Summary: This rejects unsupported or fabricated action provenance, bad dimensions/times, and missing source review.

    def test_multiple_segments_share_group_and_leakage_is_rejected(self):
        a = prepare_lesson(self.raw, self.root / "a", start_seconds=0, end_seconds=1)
        b = prepare_lesson(self.raw, self.root / "b", start_seconds=1, end_seconds=2)
        self.assertNotEqual(a.lesson["lessonId"], b.lesson["lessonId"])
        group = a.lesson["performance_group_id"]
        self.assertEqual(group, b.lesson["performance_group_id"])
        assert_no_group_leakage([group, group], ["another-performance"])
        with self.assertRaisesRegex(ValueError, "leakage"):
            assert_no_group_leakage([group, "third-performance"], [b.lesson["performance_group_id"]])
    # Summary: This groups segments from one raw source and rejects a constructed leaking split; transcodes remain unknown.

# Module summary: Tests exercise local synthetic decoding, timeline retention, schema/export contracts, and supervision separation.
# No live URL is fetched; platform import compatibility and musical usefulness require manual checks.
