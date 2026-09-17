"""Causal PCM/MIDI features and simulator-grid spike encoding (seconds, Hz)."""

from dataclasses import dataclass, field
from collections import deque
import numpy as np


@dataclass
class MusicFrame:
    bands: np.ndarray = field(default_factory=lambda: np.zeros(4))
    chroma: np.ndarray = field(default_factory=lambda: np.zeros(12))
    onset: float = 0.0
    rms: float = 0.0
    bpm: float | None = None
    phase: float | None = None  # cycles, not radians
    beat_confidence: float = 0.0
    key_confidence: float = 0.0

    def vector(self):
        phase = 2 * np.pi * (self.phase or 0)
        values = np.r_[self.bands, self.chroma, self.onset, self.rms,
                       (self.bpm or 0) / 300,
                       [(1 + np.sin(phase)) / 2, (1 + np.cos(phase)) / 2]
                       if self.phase is not None else [0, 0],
                       self.beat_confidence, self.key_confidence,
                       self.bpm is not None, self.phase is not None]
        if values.shape != (25,) or not np.isfinite(values).all():
            raise ValueError("Expected 25 finite sensory features")
        return np.clip(values, 0, 1)
    # Summary: This gives audio and MIDI the same fixed sensory layout.
    # Phase uses circular coordinates and missing rhythm has explicit masks.
    # Fixed scaling preserves silence and relative energy, but needs tuning for other levels.


def normalized_chroma(energy):
    return energy / max(float(np.linalg.norm(energy)), 1e-12)
# Summary: This separates pitch-class composition from signal loudness.
# Unit-length vectors make harmonic comparisons insensitive to gain.
# Silence remains all zeros and must never receive a harmonic reward.


class AudioFrontend:
    def __init__(self, sample_rate=22050, fft_size=4096):
        if sample_rate < 8000 or fft_size < 256:
            raise ValueError("Use sample_rate >= 8000 and fft_size >= 256")
        self.sample_rate, self.fft_size = sample_rate, fft_size
        self.history = None
        self.previous = np.zeros(fft_size // 2 + 1)
        self.chroma_history = np.zeros(12)
        self.time = 0.0
        self.onsets = deque(maxlen=12)
        self.window = np.hanning(fft_size)
        self.frequencies = np.fft.rfftfreq(fft_size, 1 / sample_rate)
    # Summary: This allocates independent causal state for one audio stream.
    # A trailing Hann window trades about 186 ms of context at 22.05 kHz for pitch resolution.
    # Construct a new frontend on source changes; changing channel counts midstream is rejected.

    def process(self, samples):
        audio = np.asarray(samples, dtype=float)
        if audio.ndim == 1:
            audio = audio[:, None]
        if (audio.ndim != 2 or not audio.shape[0] or not audio.shape[1]
                or not np.isfinite(audio).all()):
            raise ValueError("PCM must be finite, nonempty, shaped (samples, channels)")
        if self.history is None:
            self.history = np.zeros((self.fft_size, audio.shape[1]))
        if audio.shape[1] != self.history.shape[1]:
            raise ValueError("Channel count changed; reset the frontend")
        dt = len(audio) / self.sample_rate
        self.time += dt
        self.history = np.concatenate([self.history, audio])[-self.fft_size:]
        # Average POWER, not waveforms: opposite-phase stereo must remain audible.
        spectrum = np.fft.rfft(self.history * self.window[:, None], axis=0)
        power = np.mean(abs(spectrum) ** 2, axis=1) / np.sum(self.window) ** 2
        magnitude = np.sqrt(power)
        bands = np.array([np.sqrt(power[(self.frequencies >= lo)
                                        & (self.frequencies < hi)].sum())
                          for lo, hi in [(20, 150), (150, 600), (600, 3000), (3000, 12000)]])
        # Gain 4 and flux gain 8 are initial engineering scales, not calibrated physiology.
        onset = float(np.clip(8 * np.maximum(magnitude - self.previous, 0).sum(), 0, 1))
        self.previous = magnitude
        if onset > 0.35 and (not self.onsets or self.time - self.onsets[-1] > 0.22):
            self.onsets.append(self.time)
        bpm = phase = None
        confidence = 0.0
        if len(self.onsets) >= 4 and self.time - self.onsets[-1] < 2:
            intervals = np.diff(self.onsets)
            period = float(np.median(intervals))
            if 0.22 < period < 1.5:
                bpm = 60 / period
                phase = ((self.time - self.onsets[-1]) / period) % 1
                confidence = float(np.clip(1 - np.std(intervals) / period, 0, 1))
        pitch_bins = (self.frequencies >= 65) & (self.frequencies <= 4000)
        notes = np.rint(69 + 12 * np.log2(self.frequencies[pitch_bins] / 440)).astype(int)
        chroma = np.bincount(notes % 12, weights=power[pitch_bins], minlength=12)
        # Two seconds of trailing pitch context reduces transient key switching.
        self.chroma_history += (chroma - self.chroma_history) * (1 - np.exp(-dt / 2))
        rms = float(np.sqrt(np.mean(audio ** 2)))
        tonal = normalized_chroma(self.chroma_history)
        pitch_confidence = float(np.clip((np.max(tonal) - 1 / np.sqrt(12)) * 2, 0, 1))
        return MusicFrame(np.clip(4 * bands, 0, 1), tonal, onset, rms,
                          bpm, phase, confidence, pitch_confidence if rms > 0.005 else 0)
    # Summary: This turns the current PCM block and past samples into sensory features.
    # FFT power supplies bands/chroma and recent onset intervals supply a provisional beat clock.
    # Syncopation, percussion harmonics, silence, and short context can invalidate tempo or key estimates.


@dataclass(frozen=True)
class MidiEvent:
    time: float  # absolute seconds from stream start
    kind: str   # note_on, note_off, sustain, tempo (BPM), clock, stop
    note: int = 0
    value: float = 0
    channel: int = 0


class MidiFrontend:
    def __init__(self):
        self.time = 0.0
        self.held = {}
        self.sounding = {}
        self.pedal = set()
        self.bpm = None
        self.beats = 0.0
        self.clocks = deque(maxlen=49)
    # Summary: This retains MIDI voices and transport state between blocks.
    # Held and sounding notes differ so sustain can outlive a note-off.
    # A fresh frontend is required when seeking or starting an unrelated file.

    def process(self, events, duration):
        events = list(events)
        end = self.time + duration
        if not np.isfinite(duration) or duration <= 0:
            raise ValueError("Duration must be positive seconds")
        if any(not np.isfinite(e.time) or not self.time <= e.time < end for e in events):
            raise ValueError("Events must be in the current half-open block")
        if any(a.time > b.time for a, b in zip(events, events[1:])):
            raise ValueError("Events must be sorted")
        if any(e.kind not in {'note_on', 'note_off', 'sustain', 'tempo', 'clock', 'stop'}
               or not 0 <= e.channel < 16 or not 0 <= e.note <= 127
               or not np.isfinite(e.value) or e.value < 0
               or (e.kind != 'tempo' and e.value > 127)
               or (e.kind == 'tempo' and not 0 < e.value <= 1000) for e in events):
            raise ValueError("Unsupported or invalid MIDI event")
        chroma = np.zeros(12)
        activity = onset = 0.0
        cursor = self.time
        # Integrate voice occupancy between events, including very short notes.
        for event in [*events, MidiEvent(end, 'end')]:
            elapsed = event.time - cursor
            for (channel, note), velocity in self.sounding.items():
                activity += velocity * elapsed
                if channel != 9:  # General MIDI drums have no pitched key evidence.
                    chroma[note % 12] += velocity * elapsed
            if self.bpm is not None:
                self.beats += elapsed * self.bpm / 60
            cursor = event.time
            key = (event.channel, event.note)
            if event.kind == 'note_on' and event.value > 0:
                self.held[key] = self.sounding[key] = event.value / 127
                onset = max(onset, event.value / 127)
            elif event.kind in ('note_on', 'note_off'):
                self.held.pop(key, None)
                if event.channel not in self.pedal:
                    self.sounding.pop(key, None)
            elif event.kind == 'sustain':
                if event.value >= 64:
                    self.pedal.add(event.channel)
                else:
                    self.pedal.discard(event.channel)
                    self.sounding = {k: v for k, v in self.sounding.items()
                                     if k[0] != event.channel or k in self.held}
            elif event.kind == 'tempo':
                self.bpm = event.value
            elif event.kind == 'clock':
                self.clocks.append(event.time)
                if len(self.clocks) >= 25:
                    period = (self.clocks[-1] - self.clocks[0]) / (len(self.clocks) - 1)
                    if period > 0:
                        self.bpm = 60 / (24 * period)
            elif event.kind == 'stop':
                self.held.clear()
                self.sounding.clear()
                self.pedal.clear()
                self.clocks.clear()
                self.bpm = None
                self.beats = 0
        self.time = end
        # MIDI velocity is a symbolic energy proxy, never an acoustic RMS measurement.
        energy = min(1.0, activity / duration / 4)
        return MusicFrame(np.array([0, energy, energy, 0]), normalized_chroma(chroma),
                          onset, energy, self.bpm, self.beats % 1 if self.bpm else None,
                          1.0 if self.bpm else 0.0, 1.0 if chroma.sum() > 0 else 0.0)
    # Summary: This converts timestamped MIDI into the same features as audio.
    # Duration-weighted voices preserve note timing, sustain, channels, and tempo-map changes.
    # Live clock infers tempo but not a bar downbeat; timbre, pitch bend, and audible artifacts are unavailable.


def read_midi(path):
    import mido  # Optional file reader; direct MidiEvent input needs only NumPy.
    midi = mido.MidiFile(path)
    if midi.type == 2:
        raise ValueError("Asynchronous type-2 MIDI needs an explicit track timeline")
    time = 0.0
    events = [MidiEvent(0, 'tempo', value=120)]  # Standard MIDI file default tempo.
    for message in midi:  # Mido merges tracks and converts delta ticks with the tempo map.
        time += message.time
        if message.type in ('note_on', 'note_off'):
            events.append(MidiEvent(time, message.type, message.note, message.velocity, message.channel))
        elif message.type == 'set_tempo':
            events.append(MidiEvent(time, 'tempo', value=60_000_000 / message.tempo))
        elif message.type == 'control_change' and message.control == 64:
            events.append(MidiEvent(time, 'sustain', value=message.value, channel=message.channel))
    return events, time
# Summary: This supplies absolute-second events from standard MIDI files.
# Mido handles tempo-map tick conversion instead of assuming one BPM for the whole file.
# Type-2 files are rejected and controllers other than sustain are intentionally not modeled.


class SpikeEncoder:
    def __init__(self, dt=0.001, max_rate=150.0, seed=0):
        if not np.isfinite([dt, max_rate]).all() or dt <= 0 or max_rate <= 0:
            raise ValueError("Positive finite timestep and maximum rate required")
        self.dt, self.max_rate = dt, max_rate
        self.rng = np.random.default_rng(seed)
    # Summary: This establishes the sensory event clock and reproducible sampling.
    # The initial 150 Hz ceiling is a tunable population-code scale.
    # Its timestep must equal the simulator resolution to avoid duplicate-bin events.

    def encode(self, features, start, duration):
        features = np.asarray(features, dtype=float)
        if features.ndim != 1 or not np.isfinite(features).all():
            raise ValueError("Features must be a finite vector")
        if not np.isfinite([start, duration]).all() or start < 0 or duration <= 0:
            raise ValueError("Invalid simulation interval")
        if not np.isclose(start / self.dt, round(start / self.dt), atol=1e-7, rtol=0):
            raise ValueError("Start must lie on the simulator grid")
        steps = round(duration / self.dt)
        if steps < 1 or not np.isclose(steps * self.dt, duration, atol=1e-10, rtol=0):
            raise ValueError("Duration must be an integer number of timesteps")
        rates = np.clip(features, 0, 1) * self.max_rate
        probability = -np.expm1(-rates * self.dt)
        bins, ids = np.where(self.rng.random((steps, len(rates))) < probability)
        # [start, end): no lost final bin and no spike accidentally scheduled into next block.
        return ids.astype(np.int32), start + bins * self.dt
    # Summary: This produces ordered, grid-aligned sensory spike trains.
    # Independent Bernoulli events approximate Poisson rates with at most one event per neuron/bin.
    # Silence generates no spikes; very high rates saturate at the grid's maximum firing rate.

# Module summary: This replaces pixel observations with causal acoustic or symbolic music features.
# Both modalities feed the same bounded rate-to-spike code without per-block gain normalization.
# Audio rhythm/key estimates are heuristics, and MIDI energy cannot establish audible mix quality.
