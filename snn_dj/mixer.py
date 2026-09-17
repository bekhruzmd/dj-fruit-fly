"""Offline PCM two-deck environment for testing closed-loop musical rewards."""

import numpy as np
from .encoding import AudioFrontend, MusicFrame
from .learning import Observation, MixMeasurements, musical_reward


class OfflineMixer:
    def __init__(self, deck_a, deck_b, sample_rate, episode_seconds=8.0):
        self.sources = [np.asarray(deck, dtype=float) for deck in (deck_a, deck_b)]
        self.sources = [a[:, None] if a.ndim == 1 else a for a in self.sources]
        if any(a.ndim != 2 or not a.size or not np.isfinite(a).all() for a in self.sources):
            raise ValueError("Decks must contain finite PCM")
        if self.sources[0].shape[1] != self.sources[1].shape[1]:
            raise ValueError("Deck channel counts must agree")
        if not np.isfinite(episode_seconds) or episode_seconds <= 0:
            raise ValueError("Episode duration must be positive")
        self.sample_rate = sample_rate
        self.episode_seconds = episode_seconds
        self.reset(0)
    # Summary: This provides a real rendered consequence for each neural mixer command.
    # Input decks share sample rate and channel layout; exhausted sources become silent.
    # This is an offline reference, not a real-time Web Audio bridge or high-quality DJ renderer.

    def reset(self, seed):
        self.frontends = [AudioFrontend(self.sample_rate) for _ in range(3)]
        self.position = [0.0, 0.0]
        self.time = self.crossfader = 0.0
        self.ratio = 1.0
        self.previous_action = np.zeros(2)
        self.previous_rms = None
        self.previous_bands = None
        self.recording = []
        self.quality_sum = self.overlap_seconds = 0.0
        self.finished = False
        # Seed controls the initial B cue, providing variation across practice episodes.
        self.position[1] = np.random.default_rng(seed).uniform(0, 0.25) * self.sample_rate
        # Before playback there is no heard audio. The first action receives
        # unknown/silent frames instead of previewing its own future consequence.
        self.observation = Observation(MusicFrame(), MusicFrame(), MusicFrame(),
                                       seconds_remaining=self.episode_seconds)
        return self.observation
    # Summary: This starts a new transition with fresh acoustic and reward history.
    # Initially unknown audio prevents lookahead while a seeded offset varies deck alignment.
    # No weights are reset here; the training loop manages neural state separately.

    def _sample(self, deck, count, rate):
        source = self.sources[deck]
        positions = self.position[deck] + np.arange(count) * rate
        # Linear interpolation is a minimal varispeed reference: speed changes pitch too.
        # It is not pitch-preserving time stretch and can alias at higher speeds.
        left = np.floor(positions).astype(int)
        right = left + 1
        fraction = (positions - left)[:, None]
        padded = np.vstack([source, np.zeros((1, source.shape[1]))])
        return (padded[np.clip(left, 0, len(source))] * (1 - fraction)
                + padded[np.clip(right, 0, len(source))] * fraction)
    # Summary: This samples one source at its current transport rate.
    # Adjacent PCM samples are interpolated and out-of-range reads produce silence.
    # Linear varispeed couples tempo and key and is unsuitable as a production stretching algorithm.

    def step(self, action, duration):
        action = np.asarray(action, dtype=float)
        if self.finished:
            raise RuntimeError("Episode finished; reset before stepping again")
        if action.shape != (2,) or not np.isfinite(action).all() or np.any(abs(action) > 1):
            raise ValueError("Expected crossfade and tempo increments in [-1, 1]")
        if not np.isfinite(duration) or duration <= 0:
            raise ValueError("Control duration must be positive")
        # Round the cumulative clock, not each block, so 50 ms at 22050 Hz
        # alternates 1102/1103 samples instead of drifting or requiring resampling.
        count = round((self.time + duration) * self.sample_rate) - round(self.time * self.sample_rate)
        if count < 1:
            raise ValueError("Control duration must span at least one audio sample")
        previous_crossfader, previous_ratio = self.crossfader, self.ratio
        self.crossfader = float(np.clip(self.crossfader + action[0] * duration * 0.5, 0, 1))
        self.ratio = float(np.clip(self.ratio + action[1] * duration * 0.02, 0.92, 1.08))
        a = self._sample(0, count, 1)
        # Integrate a samplewise rate ramp to avoid transport jumps at command boundaries.
        rates = np.linspace(previous_ratio, self.ratio, count, endpoint=False)
        source = self.sources[1]
        positions = self.position[1] + np.r_[0, np.cumsum(rates[:-1])]
        b = np.column_stack([np.interp(positions, np.arange(len(source)), source[:, channel],
                                       left=0, right=0) for channel in range(source.shape[1])])
        self.position[0] += count
        self.position[1] += rates.sum()
        fader = np.linspace(previous_crossfader, self.crossfader, count, endpoint=False)[:, None]
        master = np.cos(fader * np.pi / 2) * a + np.sin(fader * np.pi / 2) * b
        self.recording.append(master.astype(np.float32))
        self.time += duration
        frames = [f.process(x) for f, x in zip(self.frontends, [a, b, master])]
        obs = Observation(*frames, self.crossfader, self.ratio, 12 * np.log2(self.ratio),
                          max(0, self.episode_seconds - self.time))
        rms = frames[2].rms
        loudness_jump = 0 if self.previous_rms is None else min(1, abs(
            20 * np.log10(max(rms, 1e-5) / max(self.previous_rms, 1e-5))) / 12)
        spectral_jump = 0 if self.previous_bands is None else min(1, float(
            np.linalg.norm(frames[2].bands - self.previous_bands)))
        measurements = MixMeasurements(obs, loudness_jump, spectral_jump,
            float(np.clip(np.linalg.norm(action - self.previous_action) / 2, 0, 1)),
            float(np.mean(abs(master) >= 1)), float(rms < 0.005))
        quality = musical_reward(measurements, duration)
        if 0.1 < self.crossfader < 0.9:
            self.overlap_seconds += duration
            self.quality_sum += duration * (quality.rhythm + quality.harmony + quality.smoothness) / 3
        self.finished = self.time + 1e-9 >= self.episode_seconds
        if self.finished:
            # One terminal event: require reaching B, spending time in overlap,
            # and measurable musical quality. Holding A or parking at midpoint fails.
            success = (self.crossfader >= 0.95 and self.overlap_seconds >= 1
                       and self.quality_sum / self.overlap_seconds >= 0.25
                       and rms > 0.005 and measurements.clipping < 0.01)
            measurements.new_success = success
            measurements.new_missed_deadline = not success
        self.previous_rms, self.previous_bands = rms, frames[2].bands.copy()
        self.previous_action = action.copy()
        self.observation = obs
        return obs, measurements, self.finished
    # Summary: This applies bounded commands, renders audio, and measures their consequences.
    # Samplewise ramps smooth controls and a one-shot deadline requires an audible completed transition.
    # Natural musical attacks can inflate discontinuity scores; threshold choices still need listening validation.


def synthetic_decks(sample_rate=22000, seconds=12):
    time = np.arange(round(seconds * sample_rate)) / sample_rate
    decks = []
    for bpm, notes in [(120, [48, 52, 55]), (123, [48, 52, 55])]:
        phase = (time * bpm / 60) % 1
        kick = 0.3 * np.sin(2 * np.pi * 55 * time) * np.exp(-phase * 25)
        chord = sum(0.06 * np.sin(2 * np.pi * 440 * 2**((note - 69) / 12) * time)
                    for note in notes)
        decks.append((kick + chord).astype(np.float32))
    return decks
# Summary: This generates original tempo-controlled PCM fixtures for repeatable local experiments.
# Simple kicks and major chords exercise audio features without requiring downloaded music.
# These fixtures cannot substitute for held-out recordings or perceptual evaluation.

# Module summary: This supplies an executable PCM environment for the Python SNN training loop.
# The controller changes crossfader and deck-B speed; the reward hears the actual resulting audio.
# Tempo changes also shift pitch, and smoothness thresholds are illustrative rather than production DSP guarantees.
