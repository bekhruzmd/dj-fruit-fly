"""Known-tempo fixtures test contracts and timing, not artistic DJ quality."""
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf
from analysis.analyzer import analyze_bytes, cached_analysis


def pulse_audio(bpm=125, duration=24, sr=22050, stereo=False):
    y = np.zeros(int(sr * duration), dtype=np.float32)
    for time in np.arange(.32, duration, 60 / bpm):
        start = int(time * sr)
        n = min(1000, len(y) - start)
        t = np.arange(n) / sr
        y[start:start+n] += .7 * np.sin(2 * np.pi * 85 * t) * np.exp(-t * 65)
    if stereo:
        y = np.stack([y, -y], axis=1)
    stream = io.BytesIO()
    sf.write(stream, y, sr, format='WAV')
    return stream.getvalue()
# Summary: This produces a known-tempo pulse recording with a known phase offset.
# Decaying low-frequency bursts provide repeatable transients without downloading reference recordings.
# Its simplicity cannot establish performance on syncopated, vocal-heavy, or variable-tempo music.


class AnalysisTests(unittest.TestCase):
    def test_known_tempos_and_original_timeline(self):
        for bpm in (90, 125, 172):
            with self.subTest(bpm=bpm):
                result = analyze_bytes(pulse_audio(bpm))
                self.assertLess(abs(result['bpm'] - bpm), .5)
                self.assertLess(abs(result['gridOffsetSeconds'] - .32), .06)
                self.assertGreater(len(result['beatTimes']), 20)
                self.assertTrue(all(0 <= t < 24 for t in result['beatTimes']))
                self.assertEqual(result['beatTimes'], sorted(set(result['beatTimes'])))
                self.assertIsNone(result['downbeatTimes'])
                self.assertIsNone(result['phrases'])
                self.assertEqual(result['confidence']['kind'], 'heuristic')
                self.assertLessEqual(result['confidence']['score'], .85)
    # Summary: This checks tempo and phase against known pulses at three distinct speeds.
    # It allows modest onset latency while requiring sub-BPM tempo accuracy and ordered original-time events.
    # Passing these fixtures does not resolve half-time ambiguity in real arrangements.

    def test_antiphase_stereo_survives_analysis(self):
        result = analyze_bytes(pulse_audio(stereo=True))
        self.assertLess(abs(result['bpm'] - 125), .5)
        self.assertGreater(max(p['rms'] for p in result['energyCurve']), .01)
        self.assertEqual(result['source']['channels'], 2)
    # Summary: This ensures opposing stereo channels do not cancel the rhythm detector.
    # The fixture would become silence under naive stereo averaging, so it exercises channel selection.
    # Real recordings may split useful rhythms across channels rather than merely invert phase.

    def test_silence_and_short_audio_have_no_invented_tempo(self):
        for y in (np.zeros(22050 * 10), np.zeros(20)):
            stream = io.BytesIO(); sf.write(stream, y, 22050, format='WAV')
            result = analyze_bytes(stream.getvalue())
            self.assertIsNone(result['bpm'])
            self.assertEqual(result['beatTimes'], [])
            self.assertEqual(result['confidence']['score'], 0)
            self.assertTrue(result['warnings'])
    # Summary: This tests the absence-of-evidence path for silence and tiny clips.
    # Unknown tempo and explicit warnings are preferable to assigning the 120 BPM prior as fact.
    # Quiet but rhythmic recordings should be tested separately because silence is an easier case.

    def test_cache_avoids_reanalysis_and_recovers_corruption(self):
        data = pulse_audio(duration=10)
        with tempfile.TemporaryDirectory() as directory:
            result, hit = cached_analysis(data, Path(directory))
            self.assertFalse(hit)
            with patch('analysis.analyzer.analyze_bytes', side_effect=AssertionError('Cache missed')):
                same, hit = cached_analysis(data, Path(directory))
            self.assertTrue(hit)
            self.assertEqual(same, result)
            next(Path(directory).glob('*.json')).write_text('{invalid')
            recovered, hit = cached_analysis(data, Path(directory))
            self.assertFalse(hit)
            self.assertEqual(recovered['trackId'], result['trackId'])
    # Summary: This verifies that identical bytes reuse analysis and partial cache corruption is recoverable.
    # Mocking the analyzer proves a cache hit actually avoids computation rather than only reporting one.
    # It does not test near-duplicates, which deliberately have different content hashes.

    def test_invalid_audio_is_rejected(self):
        with self.assertRaises((ValueError, RuntimeError)):
            analyze_bytes(b'not an audio recording')
    # Summary: This checks that malformed uploads fail before producing metadata.
    # Decoder failures remain explicit instead of creating an empty but apparently successful analysis.
    # Codec support depends on the installed SoundFile/libsndfile build.

# Module summary: These tests exercise the new analyzer's deterministic contracts and edge cases.
# They cover timing, phase-safe stereo analysis, missing rhythm, and actual cache reuse.
# Additional real recordings and listener-reviewed annotations are needed to assess musical robustness.
