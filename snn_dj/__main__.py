"""Run a short, local Brian2/PCM training experiment and frozen evaluation."""

import argparse
import json
from pathlib import Path
import numpy as np
from .brian import BrianBrain, demo_graph, load_graph
from .learning import run_episode
from .mixer import OfflineMixer, synthetic_decks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--episodes', type=int, default=2)
    parser.add_argument('--seconds', type=float, default=8)
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--graph', type=Path, help='Explicit mapped graph NPZ; default is synthetic')
    parser.add_argument('--audio-a', type=Path)
    parser.add_argument('--audio-b', type=Path)
    parser.add_argument('--output', type=Path, default=Path('.cache/snn-dj'))
    args = parser.parse_args()
    if args.episodes < 1 or not 0 < args.seconds <= 120:
        parser.error('Use at least one episode and 0 < seconds <= 120')
    if bool(args.audio_a) != bool(args.audio_b):
        parser.error('Supply both --audio-a and --audio-b')
    import soundfile as sf
    if args.audio_a:
        a, sample_rate = sf.read(args.audio_a, always_2d=True)
        b, rate_b = sf.read(args.audio_b, always_2d=True)
        if sample_rate != rate_b:
            parser.error('Resample source files to the same sample rate first')
    else:
        sample_rate = 22000  # 50 ms is an integer number of samples.
        a, b = synthetic_decks(sample_rate, args.seconds * 1.1 + 1)
    graph = load_graph(args.graph) if args.graph else demo_graph(seed=args.seed)
    if graph.motor_ids.shape[:2] != (2, 2):
        parser.error('The reference PCM mixer expects two opponent actions')
    brain = BrianBrain(graph, seed=args.seed)
    env = OfflineMixer(a, b, sample_rate, args.seconds)
    report = {'graph': graph.label, 'algorithm': 'reward-modulated STDP', 'practice': []}
    # Same held-out initial cue before/after; practice uses different cue seeds.
    evaluation_seed = args.seed + 10000
    report['before'] = run_episode(env, brain, seed=evaluation_seed, training=False,
                                   max_steps=round(args.seconds / 0.05) + 1)
    args.output.mkdir(parents=True, exist_ok=True)
    sf.write(args.output / 'before.wav', np.concatenate(env.recording), sample_rate, subtype='FLOAT')
    for episode in range(args.episodes):
        log = run_episode(env, brain, seed=args.seed + episode,
                          max_steps=round(args.seconds / 0.05) + 1)
        report['practice'].append(log)
        print(f"Episode {episode + 1}: reward={sum(row['reward'] for row in log):.4f}", flush=True)
    brain.save(args.output / 'brain.npz')
    weights = np.asarray(brain.synapses.w[:]).copy()
    report['after'] = run_episode(env, brain, seed=evaluation_seed, training=False,
                                  max_steps=round(args.seconds / 0.05) + 1)
    if not np.array_equal(weights, brain.synapses.w[:]):
        raise RuntimeError('Frozen evaluation changed weights')
    sf.write(args.output / 'after.wav', np.concatenate(env.recording), sample_rate, subtype='FLOAT')
    (args.output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(f"Saved checkpoint, logs, and before/after WAVs to {args.output}")
    print(f"Graph: {graph.label}. Compare audio; reward growth is not a quality guarantee.")
# Summary: This makes the reference experiment runnable from the project root.
# It records practice and frozen comparisons, preserving the sparse graph in an episode checkpoint.
# The default graph is synthetic; source files and held-out track pairs are needed for real DJ evaluation.


if __name__ == '__main__':
    main()

# Module summary: This is the local command-line entry point for the spiking DJ reference.
# It can consume PCM files or original fixtures and writes artifacts without changing the browser app.
# It needs optional Brian2/SoundFile dependencies and makes no claim to load a complete MaleCNS release.
