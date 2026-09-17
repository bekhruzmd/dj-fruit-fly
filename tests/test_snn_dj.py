"""Behavioral regressions for the optional Python spiking DJ experiment."""

from dataclasses import replace
import importlib.util
from pathlib import Path
import tempfile
import unittest
import numpy as np
from snn_dj.encoding import AudioFrontend, MidiEvent, MidiFrontend, MusicFrame, SpikeEncoder, read_midi
from snn_dj.learning import Observation, MixMeasurements, key_compatibility, musical_reward, run_episode
from snn_dj.brian import BrianBrain, demo_graph, load_graph
from snn_dj.mixer import OfflineMixer, synthetic_decks


def tonal_frame(root=0, bpm=120, phase=0):
    chroma = np.zeros(12)
    chroma[(np.array([0, 4, 7]) + root) % 12] = [1, 0.8, 0.7]
    chroma /= np.linalg.norm(chroma)
    return MusicFrame(chroma=chroma, rms=0.2, bpm=bpm, phase=phase,
                      beat_confidence=1, key_confidence=1)
# Summary: This supplies controlled musical evidence for reward comparisons.
# Weighted major triads isolate tempo, phase, and key from uncertain audio detection.
# It tests authored scoring rules rather than real-world estimator accuracy.


class EncodingTests(unittest.TestCase):
    def test_silence_and_opposite_phase_stereo(self):
        silence = AudioFrontend().process(np.zeros(2205))
        self.assertEqual(silence.rms, 0)
        self.assertIsNone(silence.bpm)
        self.assertEqual(silence.key_confidence, 0)
        tone = 0.2 * np.sin(2 * np.pi * 440 * np.arange(2205) / 22050)
        mono = AudioFrontend().process(tone)
        stereo = AudioFrontend().process(np.column_stack([tone, -tone]))
        np.testing.assert_allclose(mono.bands, stereo.bands)
        self.assertAlmostEqual(mono.rms, stereo.rms)
        self.assertEqual(int(np.argmax(mono.chroma)), 9)
        self.assertEqual(mono.vector().shape, (25,))
        with self.assertRaises(ValueError):
            AudioFrontend().process([np.nan])
    # Summary: This checks that waveform encoding neither invents sound nor cancels stereo energy.
    # A known A tone isolates pitch extraction and opposite-phase channel handling.
    # More complex recordings still require separate accuracy and listening evaluation.

    def test_causal_beat_estimate_on_known_pulses(self):
        source, _ = synthetic_decks(seconds=5)
        frontend = AudioFrontend(22000)
        for start in range(0, len(source), 1100):
            frame = frontend.process(source[start:start + 1100])
        self.assertAlmostEqual(frame.bpm, 120, delta=2)
        self.assertGreater(frame.beat_confidence, 0.8)
    # Summary: This verifies tempo estimation from sequential waveform blocks.
    # A regular kick fixture supplies a known 120 BPM target without future samples.
    # It does not cover syncopation or half/double-tempo ambiguity in commercial tracks.

    def test_midi_sustain_channels_and_short_notes(self):
        midi = MidiFrontend()
        held = midi.process([MidiEvent(0, 'tempo', value=120),
                             MidiEvent(0, 'note_on', 60, 127),
                             MidiEvent(0.01, 'sustain', value=127),
                             MidiEvent(0.02, 'note_off', 60)], 0.05)
        self.assertGreater(held.chroma[0], 0)
        sustained = midi.process([], 0.05)
        self.assertGreater(sustained.rms, 0)
        released = midi.process([MidiEvent(0.1, 'sustain', value=0)], 0.05)
        self.assertEqual(released.rms, 0)
        short = MidiFrontend().process([MidiEvent(0.01, 'note_on', 64, 100),
                                         MidiEvent(0.02, 'note_off', 64)], 0.05)
        self.assertGreater(short.chroma[4], 0)
        drums = MidiFrontend().process([MidiEvent(0, 'note_on', 36, 100, 9)], 0.05)
        self.assertGreater(drums.onset, 0)
        self.assertEqual(drums.key_confidence, 0)
        self.assertEqual(drums.chroma.sum(), 0)
    # Summary: This checks symbolic voice persistence and note timing.
    # Sustain, short notes, and percussion exercise distinct feature paths.
    # Acoustic realism remains outside the symbolic frontend's scope.

    def test_midi_tempo_change_and_bad_timeline(self):
        midi = MidiFrontend()
        frame = midi.process([MidiEvent(0, 'tempo', value=120),
                              MidiEvent(0.25, 'tempo', value=60)], 0.5)
        self.assertEqual(frame.bpm, 60)
        self.assertAlmostEqual(frame.phase, 0.75)
        with self.assertRaises(ValueError):
            midi.process([MidiEvent(0.49, 'note_on', 60, 100)], 0.1)
        clock = MidiFrontend()
        frame = clock.process([MidiEvent(i / 48, 'clock') for i in range(25)], 0.55)
        self.assertAlmostEqual(frame.bpm, 120)
    # Summary: This verifies that time and tempo remain consistent across MIDI changes.
    # Known tempo segments and clock pulses provide independent timing references.
    # Real clock jitter and musical downbeat inference are not tested here.

    def test_spikes_are_reproducible_unique_and_half_open(self):
        encoder = SpikeEncoder(seed=1)
        ids, times = encoder.encode(np.ones(100), 2.0, 0.05)
        ids2, times2 = SpikeEncoder(seed=1).encode(np.ones(100), 2.0, 0.05)
        np.testing.assert_array_equal(ids, ids2)
        np.testing.assert_array_equal(times, times2)
        self.assertTrue(np.all((times >= 2) & (times < 2.05)))
        self.assertTrue(np.all(np.diff(times) >= 0))
        self.assertEqual(len(set(zip(ids, times))), len(ids))
        self.assertEqual(len(encoder.encode(np.zeros(4), 0, 0.05)[0]), 0)
        self.assertAlmostEqual(np.min(times), 2.0)
        self.assertAlmostEqual(np.max(times), 2.049)
        with self.assertRaises(ValueError):
            encoder.encode([1], 0, 0.0505)
    # Summary: This protects the simulator's sensory scheduling contract.
    # Identical seeds must reproduce ordered events without duplicate bins or boundary leakage.
    # Statistical firing-rate fidelity needs longer runs than this bounded scheduling regression.

    @unittest.skipUnless(importlib.util.find_spec('mido'), 'Mido optional dependency not installed')
    def test_midi_file_tempo_map(self):
        import mido
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'tempo.mid'
            midi = mido.MidiFile(ticks_per_beat=480)
            track = mido.MidiTrack()
            midi.tracks.append(track)
            track.append(mido.Message('note_on', note=60, velocity=100, time=0))
            track.append(mido.MetaMessage('set_tempo', tempo=1000000, time=480))
            track.append(mido.Message('note_off', note=60, time=480))
            midi.save(path)
            events, duration = read_midi(path)
            self.assertAlmostEqual(duration, 1.5)
            self.assertAlmostEqual(events[-1].time, 1.5)
    # Summary: This checks the actual MIDI file reader across a tempo change.
    # A generated file makes the expected wall-clock duration unambiguous.
    # Unsupported MIDI controllers and asynchronous file types remain outside this fixture.


class RewardTests(unittest.TestCase):
    def test_alignment_key_smoothness_and_confidence(self):
        frame = tonal_frame()
        obs = Observation(frame, frame, frame, crossfader=0.5)
        measurements = MixMeasurements(obs)
        good = musical_reward(measurements, 0.05)
        self.assertGreater(good.total, 0)
        for bad_frame in [tonal_frame(bpm=135), tonal_frame(phase=0.5), tonal_frame(root=1)]:
            bad = musical_reward(replace(measurements, observation=replace(obs, deck_b=bad_frame)), 0.05)
            self.assertLess(bad.total, good.total)
        rough = musical_reward(replace(measurements, loudness_jump=1, spectral_jump=1), 0.05)
        self.assertLess(rough.total, good.total)
        unknown = replace(frame, beat_confidence=0, key_confidence=0)
        unknown_reward = musical_reward(replace(measurements,
            observation=replace(obs, deck_b=unknown)), 0.05)
        self.assertEqual(unknown_reward.rhythm, 0)
        self.assertEqual(unknown_reward.harmony, 0)
        self.assertEqual(key_compatibility(0, 21), 0.9)  # C major / A minor
        self.assertEqual(key_compatibility(0, 7), 0.8)   # C major / G major
    # Summary: This checks that musical coherence ranks above deliberate mismatches.
    # Controlled pitch, tempo, phase, and confidence vary independently.
    # The expected ordering reflects authored reward preferences, not a listening study.

    def test_silence_duration_and_one_shot_event(self):
        frame = tonal_frame()
        obs = Observation(frame, frame, frame, crossfader=0.5)
        m = MixMeasurements(obs)
        self.assertAlmostEqual(musical_reward(m, 0.1).total, 2 * musical_reward(m, 0.05).total)
        silent = replace(m, observation=replace(obs, master=MusicFrame()), unintended_silence=1)
        self.assertLess(musical_reward(silent, 0.05).total, 0)
        muted = musical_reward(replace(m, observation=replace(obs, crossfader=0)), 0.05)
        self.assertEqual(muted.harmony, 0)
        symbolic = musical_reward(replace(m, acoustic_confidence=0), 0.05)
        self.assertEqual(symbolic.smoothness, 0)
        event = musical_reward(replace(m, new_success=True), 0.05)
        self.assertAlmostEqual(event.total - musical_reward(m, 0.05).total, 1)
        with self.assertRaises(ValueError):
            musical_reward(replace(m, clipping=float('nan')), 0.05)
    # Summary: This checks against silence rewards and timestep-dependent continuous bonuses.
    # It also separates one-shot terminal events from acoustic confidence.
    # Environment-level event deduplication is exercised in the mixer deadline test.


class MixerTests(unittest.TestCase):
    def test_deadline_prevents_holding_one_track_forever(self):
        a, b = synthetic_decks(seconds=1)
        env = OfflineMixer(a, b, 22000, episode_seconds=0.1)
        env.step(np.zeros(2), 0.05)
        _, measurements, done = env.step(np.zeros(2), 0.05)
        self.assertTrue(done)
        self.assertTrue(measurements.new_missed_deadline)
        with self.assertRaises(RuntimeError):
            env.step(np.zeros(2), 0.05)
    # Summary: This verifies that inactivity cannot complete the transition assignment.
    # A deadline emits failure once and forbids further steps before reset.
    # This tests assignment enforcement rather than learnability of the assignment.

    def test_no_initial_lookahead_and_fractional_sample_clock(self):
        a, b = synthetic_decks(sample_rate=22050, seconds=1)
        env = OfflineMixer(a, b, 22050, episode_seconds=0.2)
        self.assertEqual(env.observation.master.rms, 0)
        self.assertIsNone(env.observation.deck_a.bpm)
        for _ in range(4):
            env.step(np.zeros(2), 0.05)
        self.assertEqual(sum(len(block) for block in env.recording), 4410)
    # Summary: This prevents future-audio leakage and cumulative sample-clock drift.
    # Initially unknown features and a 22.05 kHz source exercise both boundaries.
    # The neural and PCM clocks may still differ by at most half an audio sample within a block.

    def test_audio_consequences_and_control_bounds(self):
        a, b = synthetic_decks(seconds=1)
        env = OfflineMixer(a, b, 22000, episode_seconds=0.2)
        before = env.observation
        after, measurements, _ = env.step(np.array([1, 1]), 0.05)
        self.assertGreater(after.crossfader, before.crossfader)
        self.assertGreater(after.tempo_ratio, before.tempo_ratio)
        self.assertGreater(after.pitch_semitones, 0)
        self.assertIs(measurements.observation, after)
        self.assertGreater(np.linalg.norm(env.recording[-1]), 0)
    # Summary: This verifies that controls cause rendered and observable changes.
    # Crossfade, tempo, and coupled pitch respond within the same environment step.
    # It does not measure the perceptual quality of the interpolation algorithm.


@unittest.skipUnless(importlib.util.find_spec('brian2'), 'Brian2 optional dependency not installed')
class BrianTests(unittest.TestCase):
    def test_real_spikes_learning_reset_and_frozen_evaluation(self):
        graph = demo_graph(seed=42)
        # Include one fixed inhibitory edge to check polarity and magnitude preservation.
        graph.sign[0] = -1
        brain = BrianBrain(graph, seed=42)
        original = np.asarray(brain.synapses.w[:]).copy()
        encoder = SpikeEncoder(seed=42)
        for _ in range(5):
            ids, times = encoder.encode(np.full(79, 0.8), brain.time, 0.05)
            brain.act(ids, times, 0.05, 0.2)
            brain.reinforce(0.5)
        learned = np.asarray(brain.synapses.w[:]).copy()
        np.testing.assert_array_equal(learned[~graph.plastic], original[~graph.plastic])
        self.assertGreater(np.linalg.norm(learned[graph.plastic] - original[graph.plastic]), 0)
        self.assertTrue(np.all((learned >= 0) & (learned <= 0.5)))
        self.assertGreater(np.sum(brain.monitor.count[:]), 0)
        brain.reset_state()
        self.assertEqual(brain.time, 0)
        self.assertEqual(np.linalg.norm(brain.synapses.eligibility[:]), 0)
        np.testing.assert_array_equal(brain.synapses.w[:], learned)
        np.testing.assert_array_equal(brain.synapses.polarity[:], graph.sign)
        a, b = synthetic_decks(seconds=1)
        env = OfflineMixer(a, b, 22000, 0.1)
        run_episode(env, brain, training=False, max_steps=2)
        np.testing.assert_array_equal(brain.synapses.w[:], learned)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'brain.npz'
            brain.save(path)
            restored = load_graph(path)
            restored.validate(79)
            np.testing.assert_array_equal(restored.weight, learned)
            np.testing.assert_array_equal(restored.pre, graph.pre)
            self.assertEqual(restored.label, graph.label)
    # Summary: This runs actual Brian2 spikes through eligibility and dopamine updates.
    # It checks plastic-only learning, reset boundaries, frozen evaluation, and checkpoint topology.
    # The small synthetic graph does not establish full MaleCNS scaling or musical improvement.


if __name__ == '__main__':
    unittest.main()

# Module summary: These checks cover causal encoding, musical incentives, and actual Brian2 plasticity.
# Known tones and events isolate correctness while a rendered environment exercises the full loop.
# Synthetic regressions cannot establish perceptual improvement or large-connectome performance.
