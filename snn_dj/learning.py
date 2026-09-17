"""Musical coherence reward and simulator-independent reward-modulated STDP loop."""

from dataclasses import dataclass
from typing import Protocol
import numpy as np
from .encoding import MusicFrame, SpikeEncoder


def key_evidence(frame):
    # Authored profiles emphasize tonic/third/fifth, then other scale degrees.
    # They are a deliberately small heuristic, not a trained key detector.
    profiles = []
    for minor in (False, True):
        scale = [0, 2, 3, 5, 7, 8, 10] if minor else [0, 2, 4, 5, 7, 9, 11]
        profile = np.zeros(12)
        profile[scale] = 0.2
        profile[[0, 3 if minor else 4, 7]] = [1.0, 0.8, 0.7]
        profile /= np.linalg.norm(profile)
        profiles.extend(np.roll(profile, tonic) for tonic in range(12))
    scores = np.asarray(profiles) @ frame.chroma
    order = np.argsort(scores)
    confidence = np.clip(5 * (scores[order[-1]] - scores[order[-2]]), 0, 1)
    return int(order[-1]), float(confidence * frame.key_confidence)
# Summary: This estimates tonic/mode from trailing pitch-class evidence.
# Major and minor scale templates compete, and ambiguous winners receive little confidence.
# Sparse notes, modal music, or percussion can mislead it; confidence is not a calibrated probability.


def key_compatibility(key_a, key_b):
    tonic_a, tonic_b = key_a % 12, key_b % 12
    minor_a, minor_b = key_a >= 12, key_b >= 12
    if key_a == key_b:
        return 1.0
    if minor_a == minor_b and (tonic_a - tonic_b) % 12 in (5, 7):
        return 0.8
    major, minor = (tonic_b, tonic_a) if minor_a else (tonic_a, tonic_b)
    if minor_a != minor_b and (minor - major) % 12 == 9:
        return 0.9
    return 0.0
# Summary: This defines a small harmonic-mixing preference table.
# Same keys, relative major/minor, and neighboring fifths receive positive scores.
# It is an authored taste rule and does not judge voicing, dissonance, or creative exceptions.


@dataclass
class Observation:
    deck_a: MusicFrame
    deck_b: MusicFrame
    master: MusicFrame
    crossfader: float = 0.0
    tempo_ratio: float = 1.0
    pitch_semitones: float = 0.0
    seconds_remaining: float = 8.0

    def vector(self):
        return np.r_[self.deck_a.vector(), self.deck_b.vector(), self.master.vector(),
                     self.crossfader, (self.tempo_ratio - 0.92) / 0.16,
                     (self.pitch_semitones + 2) / 4,
                     np.clip(self.seconds_remaining / 16, 0, 1)]
    # Summary: This exposes both cue decks, heard output, and transition context to the policy.
    # Control state tells the network whether further movement can still change the mix.
    # The initial scales assume ±8% tempo and ±2 semitones; environments must enforce their bounds.


@dataclass
class MixMeasurements:
    observation: Observation  # features measured AFTER the action was applied
    loudness_jump: float = 0.0
    spectral_jump: float = 0.0
    control_jerk: float = 0.0
    clipping: float = 0.0
    unintended_silence: float = 0.0
    excessive_shift: float = 0.0
    new_success: bool = False
    new_missed_deadline: bool = False
    acoustic_confidence: float = 1.0  # 0 for unrendered MIDI


@dataclass(frozen=True)
class Reward:
    total: float
    rhythm: float
    harmony: float
    smoothness: float
    penalties: float
    completion: float


def musical_reward(measurements, duration):
    m = measurements
    obs = m.observation
    # Validate at the environment boundary: NaN feedback must never corrupt weights.
    vector = obs.vector()
    bounded = [obs.crossfader, m.loudness_jump, m.spectral_jump, m.control_jerk,
               m.clipping, m.unintended_silence, m.excessive_shift, m.acoustic_confidence,
               obs.deck_a.beat_confidence, obs.deck_b.beat_confidence,
               obs.deck_a.key_confidence, obs.deck_b.key_confidence]
    if (not np.isfinite(vector).all() or not np.isfinite(duration) or duration <= 0
            or any(not np.isfinite(v) or not 0 <= v <= 1 for v in bounded)):
        raise ValueError("Invalid musical feedback")
    a, b = obs.deck_a, obs.deck_b
    # Both sources and the master must be audible; silence cannot earn overlap quality.
    audible = min(a.rms, b.rms, obs.master.rms) > 0.005
    overlap = float(np.sin(np.pi * obs.crossfader) ** 2) if audible else 0.0
    rhythm = 0.0
    if a.bpm and b.bpm and a.bpm > 0 and b.bpm > 0 and a.phase is not None and b.phase is not None:
        # Score effective tempo, not the source-file BPM before speed adjustment.
        tempo = np.exp(-(np.log2(a.bpm / b.bpm) / 0.03) ** 2)
        phase = (1 + np.cos(2 * np.pi * (a.phase - b.phase))) / 2
        rhythm = float(tempo * phase * min(a.beat_confidence, b.beat_confidence))
    key_a, confidence_a = key_evidence(a)
    key_b, confidence_b = key_evidence(b)
    harmony = key_compatibility(key_a, key_b) * min(confidence_a, confidence_b)
    smoothness = float(np.exp(-2 * m.loudness_jump - 1.5 * m.spectral_jump
                              - m.control_jerk) * m.acoustic_confidence)
    penalties = (0.8 * m.clipping + 0.8 * m.unintended_silence) * m.acoustic_confidence
    penalties += 0.3 * m.excessive_shift
    completion = float(m.new_success) - float(m.new_missed_deadline)
    # Continuous quality is integrated over seconds; completion is a one-shot event.
    total = duration * (overlap * (0.4 * rhythm + 0.25 * harmony + 0.35 * smoothness)
                        - penalties) + completion
    return Reward(total, overlap * rhythm, overlap * harmony,
                  overlap * smoothness, penalties, completion)
# Summary: This rewards aligned tempo/phase, compatible key, and smooth audible transitions.
# Confidence and audibility gate quality, while independently verified deadlines prevent idle-only success.
# The environment must emit each completion once and measure consequences, never unexecuted commands.


class DJEnvironment(Protocol):
    def reset(self, seed: int) -> Observation: ...
    def step(self, action: np.ndarray, duration: float) -> tuple[Observation, MixMeasurements, bool]: ...


class SpikingBrain(Protocol):
    time: float
    dt: float
    def reset_state(self) -> None: ...
    def act(self, indices: np.ndarray, times: np.ndarray, duration: float,
            exploration: float) -> np.ndarray: ...
    def reinforce(self, dopamine: float) -> None: ...


def run_episode(env: DJEnvironment, brain: SpikingBrain, *, seed=0, training=True,
                duration=0.05, max_steps=2000, exploration=0.2):
    if max_steps < 1:
        raise ValueError("max_steps must be positive")
    observation = env.reset(seed)
    brain.reset_state()  # retain weights, clear voltage, pending spikes and eligibility
    encoder = SpikeEncoder(dt=brain.dt, seed=seed)
    baseline_rate = 0.0
    log = []
    for _ in range(max_steps):
        indices, times = encoder.encode(observation.vector(), brain.time, duration)
        action = brain.act(indices, times, duration, exploration if training else 0.0)
        next_observation, measurements, done = env.step(action, duration)
        reward = musical_reward(measurements, duration)
        # The reward already includes duration. This is a discrete dopamine impulse,
        # so the synaptic update must NOT multiply by duration again.
        dopamine = float(np.clip(reward.total - baseline_rate * duration, -1, 1))
        if training:
            brain.reinforce(dopamine)
            baseline_rate += (reward.total / duration - baseline_rate) * (1 - np.exp(-duration / 4))
        log.append({"time": brain.time, "reward": reward.total, "dopamine": dopamine,
                    "rhythm": reward.rhythm, "harmony": reward.harmony,
                    "smoothness": reward.smoothness, "crossfader": next_observation.crossfader,
                    "done": done})
        observation = next_observation
        if done:
            return log
    raise RuntimeError("Environment did not terminate within max_steps")
# Summary: This links sensory spikes, motor action, heard consequences, and synaptic reinforcement.
# Signed reward above a running baseline modulates eligibility accrued before the consequence.
# This is reward-modulated STDP, not an exact policy gradient; frozen evaluation disables updates and exploration.

# Module summary: This implements the musical replacement for threat/pain feedback.
# Simulator and mixer protocols keep causal reward timing independent of Brian2 or NEST APIs.
# Better surrogate scores do not establish better listening quality or biological validity.
