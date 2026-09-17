# Python spiking DJ experiment

This implements the audio/MIDI-to-spikes, musical reward, and synaptic training design in a local Python package. It is separate from the browser's existing 8-input, 64-KC, 3-output rate model. Neither implementation currently loads a complete MaleCNS v1.0 release. The Python demo explicitly labels its synthetic wiring; a mapped sparse graph can be supplied to the Brian2 adapter.

The inputs are PCM waveforms or timestamped MIDI events. The downstream consumers are a spiking controller and a mixer implementing `DJEnvironment`. The included offline mixer renders PCM after every action, so reward measures a consequence of the action rather than an imagined control target. This covers parts of roadmap layers 1, 7, 8, and 9; it does not add browser MIDI input, independent pitch shifting, source separation, or a deployed Python service.

## Run locally

Use Python 3.12 or newer and a separate environment. Brian2 2.10.1 requires Python 3.12+, while the existing analysis environment uses Python 3.11 and a different dependency set:

```sh
python3.13 -m venv .venv-snn
.venv-snn/bin/python -m pip install -r snn_dj/requirements.txt
npm run test:snn
npm run train:snn -- --episodes 2 --seconds 8
```

The default experiment uses original kick/chord waveforms. Outputs go to `.cache/snn-dj/`: `brain.npz`, `report.json`, `before.wav`, and `after.wav`. Compare the frozen WAVs at the same listening level. Check beat drift, changes in pitch, gaps, and whether a transition finishes; an increased reward is not proof of improved musical taste. The short default run is a smoke experiment, not a convergence claim.

Supply actual audio with the same sample rate and channel layout:

```sh
npm run train:snn -- --audio-a /path/a.wav --audio-b /path/b.wav --episodes 5
```

The renderer controls crossfade velocity and deck-B speed, with ±8% speed bounds. Samplewise ramps smooth parameter changes. This reference uses **varispeed**: changing speed changes both BPM and pitch. It does not claim pitch-preserving time stretching; high-quality stretching and independent pitch control need a different environment implementation. The evaluator listens to rendered deck signals, including those pitch changes. Short sources become silent when exhausted rather than being silently looped.

## Where the implementation lives

| File | Responsibility |
| --- | --- |
| `snn_dj/encoding.py` | Stateful audio/MIDI features, explicit uncertainty, fixed sensory schema, grid-aligned spike trains |
| `snn_dj/learning.py` | Musical coherence reward, environment/brain protocols, reinforcement loop |
| `snn_dj/brian.py` | Sparse graph validation, Brian2 LIF network, STDP eligibility, bounded weight updates, graph checkpoints |
| `snn_dj/mixer.py` | Offline PCM actions, acoustic consequences, terminal transition checks, original fixtures |
| `snn_dj/__main__.py` | Practice and frozen comparison command |
| `tests/test_snn_dj.py` | Encoding, musical incentives, rendered consequences, actual simulator regressions |

## Audio and MIDI inputs

Each deck and the master has its own frontend state. Audio uses a trailing 4096-sample Hann window, averaging stereo **power** before extracting four bands and 12 pitch classes. Positive spectral changes suggest onsets; recent intervals give a provisional tempo and beat phase. Two seconds of trailing pitch evidence reduce transient key changes. No future samples are used. The onset estimator can confuse syncopation and half/double tempo; confidence is heuristic.

The fixed 25-value frame contains four bands, 12 chroma values, onset, energy, BPM, circular phase coordinates, rhythm/key confidence, and BPM/phase availability masks. Three streams plus crossfader, speed, pitch, and time-to-deadline produce 79 sensory channels. These mappings are authored engineering choices. They do not assert a biological mapping of musical key into fruit-fly sensory neurons.

```python
from snn_dj.encoding import AudioFrontend, MidiFrontend, MidiEvent, SpikeEncoder

audio = AudioFrontend(sample_rate=48000)
audio_frame = audio.process(pcm_block)  # (samples,) or (samples, channels)

midi = MidiFrontend()
midi_frame = midi.process([
    MidiEvent(0.0, "tempo", value=120),
    MidiEvent(0.0, "note_on", note=60, value=100),
    MidiEvent(0.02, "note_off", note=60),
], duration=0.05)

encoder = SpikeEncoder(dt=0.001, seed=42)
indices, times_seconds = encoder.encode(midi_frame.vector(), start=0, duration=0.05)
```

`read_midi(path)` uses Mido's tempo-map-aware merged timeline and returns absolute-second `MidiEvent` objects plus file duration. Partition those events into successive half-open windows `[start, end)` before calling `MidiFrontend.process()`. Note-on with zero velocity is note-off; sustain retains released notes until pedal-up. Channel 10 percussion contributes activity but no key evidence. Live MIDI clock can estimate tempo from 24 pulses per quarter note; it does not establish downbeats. Pitch bend and most controllers are not modeled.

A symbolic MIDI environment can implement `DJEnvironment` using these frames. Set `MixMeasurements.acoustic_confidence=0` until MIDI has been synthesized into audio: MIDI velocity is not measured RMS, and symbolic data cannot establish clipping or audible smoothness. The bundled command uses PCM rendering; it does not synthesize arbitrary MIDI files.

## Reward and learning

The continuous quality score combines tempo/phase alignment (0.40), harmonic compatibility (0.25), and smoothness (0.35). Harmonic templates prefer same key, relative major/minor, and neighboring fifths; uncertain key winners receive less credit. Overlap and audibility gate all quality bonuses. Loudness/spectral jumps and control changes reduce smoothness; clipping and unintended silence add penalties. These coefficients and thresholds are initial engineering assumptions, not listening-validated preferences.

Quality is integrated over seconds. A separate terminal success/failure event requires the transition to reach deck B by the deadline, with at least one second of overlap and acceptable measured quality. This prevents completing a training assignment by leaving A playing forever. The environment must emit completion events only once. Longer tasks need explicit phrase/downbeat targets instead of treating every eight bars as a detected musical phrase.

The control sequence is:

1. Encode the preceding observation and run the SNN for 50 ms.
2. Decode opponent motor spike populations and apply bounded mixer commands.
3. Render the next PCM block and measure its consequences.
4. Compute signed reward relative to a running baseline.
5. Apply `Δw = learning_rate × dopamine × eligibility` once.

STDP pairs set eligibility with 20 ms pre/post traces; eligibility decays over four seconds to retain delayed credit. A dopamine burst rewards a better-than-expected outcome, while a dip discourages a worse outcome. The reward already includes elapsed time, so the impulse update does not multiply by time again. Fixed weights and signs remain unchanged; only selected excitatory magnitudes learn. Episode reset clears pending spikes and neural traces while retaining weights. Evaluation disables exploration and updates. This is reward-modulated STDP, not an exact policy-gradient algorithm or a claim about fly dopamine receptor functions.

## Connectome and simulator boundary

`CircuitGraph` requires explicit sparse arrays: `pre`, `post`, scaled nonnegative `weight`, `sign` (±1), and `plastic` (boolean). Supply `neuron_count`, `sensory_source`, `sensory_target`, `motor_ids`, and a provenance `label`. Motor IDs have shape `(actions, 2, population_size)` for disjoint positive/negative populations. The bundled mixer expects two actions. Input indices refer to the 79-channel observation; graph neuron indices refer to your own stable neuron-ID mapping.

```python
import numpy as np
from snn_dj.brian import CircuitGraph, BrianBrain
from snn_dj.learning import run_episode

# All arrays and mappings below come from your connectome preprocessing.
graph = CircuitGraph(neuron_count, pre, post, scaled_weight, sign, plastic,
                     sensory_source, sensory_target, motor_ids, provenance_label)
brain = BrianBrain(graph, inputs=79)
log = run_episode(your_environment, brain, training=True)
brain.save("mapped-brain.npz")
```

Use `--graph mapped-brain.npz` with the CLI for a compatible mapped graph or saved checkpoint. Weights are dimensionless voltage-jump magnitudes bounded to `[0, 0.5]`; measured synapse counts require an explicit scaling/model choice. Unknown transmitter signs must be resolved before constructing this adapter. The LIF neurons and sensory gains are engineering defaults, not fitted MaleCNS physiology. No raw MaleCNS downloader/importer is implemented, no missing edges are invented, and full-connectome speed/memory requirements have not been benchmarked. NPZ checkpoints retain wiring and mapping but not mid-episode simulator or RNG state.

Brian2 uses [`SpikeGeneratorGroup.set_spikes()`](https://brian2.readthedocs.io/en/stable/reference/brian2.input.spikegeneratorgroup.SpikeGeneratorGroup.html) for successive windows and `Synapses` for eligibility, following the general mechanism in its [dopamine-modulated STDP example](https://brian2.readthedocs.io/en/stable/examples/frompapers.Izhikevich_2007.html). It uses the NumPy runtime and an explicit simulator clock. No full spike history is retained, only counts used for motor decoding.

To use NEST, implement the same `SpikingBrain` protocol. Convert event seconds to milliseconds and account for NEST's scheduling/delivery delay without shifting relative input timing. Use spike generators and either a custom discrete eligibility update or [`stdp_dopamine_synapse` with `volume_transmitter`](https://nest-simulator.readthedocs.io/en/stable/models/stdp_dopamine_synapse.html). Native dopamine is a filtered nonnegative spike signal: encode signed modulation as bursts/dips around tonic firing and its baseline `b`, not as negative firing rates. Disable the Python weight update when native dopamine plasticity owns it. NEST support is an interface/porting path, not an installed or tested adapter in this change.

MIDI file parsing follows [Mido's standard MIDI file timeline](https://mido.readthedocs.io/en/stable/files/midi.html). Direct timestamped `MidiEvent` use requires only NumPy.
