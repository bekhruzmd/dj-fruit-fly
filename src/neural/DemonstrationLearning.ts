import { FlyWireCircuit } from './FlyWireCircuit';

export interface DemoFrame {
  bands: number[];
  targets: number[];
  dt: number;
}
export interface Demonstration {
  id: string;
  source: string;
  frames: DemoFrame[];
}
export interface ImitationResult {
  before: number[];
  after: number[];
  improved: boolean;
  weights: number[];
  upstream: number[];
  initialWeights: number[];
  sparsity: number;
}

export function validateDemonstration(demo: Demonstration): void {
  if (!demo || typeof demo.id !== 'string' || !demo.id || typeof demo.source !== 'string'
    || !Array.isArray(demo.frames) || demo.frames.length < 2 || demo.frames.length > 8000)
    throw new Error('Invalid or oversized demonstration');
  for (const frame of demo.frames) {
    if (!frame || !Array.isArray(frame.bands) || frame.bands.length !== 4
      || frame.bands.some(v => !Number.isFinite(v) || v < 0 || v > 1)
      || !Array.isArray(frame.targets) || frame.targets.length !== 3
      || frame.targets.some(v => !Number.isFinite(v) || v < 0 || v > 1)
      || !Number.isFinite(frame.dt) || frame.dt <= 0 || frame.dt > 0.1)
      throw new Error('Invalid demonstration frame');
  }
}
// Summary: This rejects malformed sensory values before a replay can alter any weights.
// Limits bound memory and exclude timing gaps that would distort the six-frame sensory memory.
// Valid data can still be musically poor; validation does not endorse the teacher.

function replay(circuit: FlyWireCircuit, demo: Demonstration, teach: boolean): number[] {
  circuit.resetPerformance();
  const errors = [0, 0, 0];
  let duration = 0;
  for (const frame of demo.frames) {
    // Standby disables reward bookkeeping, not sensory inference. No authored
    // director or teacher forcing is passed to step, including at evaluation.
    const c = circuit.step(frame.bands, 0, false, 0, 0, frame.dt, true).controls;
    const predictions = [c.rawCrossfader, c.rawFilter, c.rawStutter];
    for (let d = 0; d < 3; d++) errors[d] += (predictions[d] - frame.targets[d]) ** 2 * frame.dt;
    duration += frame.dt;
    // Scale to a 25 Hz reference so a faster display does not multiply training
    // strength. This only approximates continuous-time updates, not exact invariance.
    if (teach) circuit.imitateMotorTargets(frame.targets, 0.02 * frame.dt / 0.04);
  }
  return errors.map(error => error / duration);
}
// Summary: This replays an ordered take and measures duration-weighted command error.
// Preserving order preserves the existing short sensory memory; each take starts with clean state.
// Recorded master audio does not change when the candidate acts, so this is offline imitation, not a listening test.

export async function trainDemonstrations(
  live: FlyWireCircuit, training: Demonstration, evaluation: Demonstration,
  signal?: AbortSignal,
): Promise<ImitationResult> {
  validateDemonstration(training);
  validateDemonstration(evaluation);
  if (training.id === evaluation.id || training === evaluation)
    throw new Error('Record a separate evaluation take');
  const candidate = new FlyWireCircuit(undefined, () => 0.5);
  candidate.W_pn_kc.set(live.W_pn_kc);
  candidate.W_kc_dn.set(live.W_kc_dn);
  candidate.sparsityK = live.sparsityK;
  candidate.learningEnabled = false;
  candidate.guidedSet = false;
  const initialWeights = Array.from(candidate.W_kc_dn);
  const before = replay(candidate, evaluation, false);
  // Fixed 20 epochs avoid selecting the best epoch on the evaluation recording.
  // Yield each epoch to keep the UI cancellable; the candidate never touches live state.
  for (let epoch = 0; epoch < 20; epoch++) {
    signal?.throwIfAborted();
    replay(candidate, training, true);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  const after = replay(candidate, evaluation, false);
  const meanBefore = before.reduce((a, b) => a + b) / 3;
  const meanAfter = after.reduce((a, b) => a + b) / 3;
  return { before, after,
    // A 1% aggregate gain filters numerical noise; no individual command may
    // worsen materially. Neither threshold is calibrated to perceived sound quality.
    improved: meanAfter < meanBefore * 0.99 && after.every((v, i) => v <= before[i] + 0.0001),
    weights: Array.from(candidate.W_kc_dn), upstream: Array.from(candidate.W_pn_kc),
    initialWeights, sparsity: candidate.sparsityK };
}
// Summary: This fits one recording and evaluates on a separate untouched recording.
// The result includes its starting brain so stale candidates cannot overwrite later live learning.
// Two takes of the same material test repeatability, not generalization to new tracks.
// Repeatedly tuning against the same evaluation take can overfit it; collect fresh takes for stronger evidence.

export function applyImitation(live: FlyWireCircuit, result: ImitationResult): void {
  if (!result.improved || result.sparsity !== live.sparsityK
    || result.upstream.length !== live.W_pn_kc.length || result.initialWeights.length !== live.W_kc_dn.length
    || result.upstream.some((v, i) => v !== live.W_pn_kc[i])
    || result.initialWeights.some((v, i) => v !== live.W_kc_dn[i]))
    throw new Error('Brain changed or candidate did not improve. Freeze learning and train again.');
  if (result.weights.length !== live.W_kc_dn.length
    || result.weights.some(v => !Number.isFinite(v) || v < 0.00999 || v > 1.60001))
    throw new Error('Invalid candidate weights');
  live.W_kc_dn.set(result.weights);
  live.resetPerformance();
  live.learningEnabled = false;
  live.guidedSet = false;
}
// Summary: This installs an explicitly selected candidate and freezes it for unassisted listening.
// Exact starting-state checks prevent a training result overwriting newer learning or different wiring.
// Better offline command error can still sound worse in the live feedback loop; retain the baseline for comparison.

// Module summary: Demonstrations add an optional supervised warm start to the small fly readout.
// Only captured features and commands are used, with no external model, video ingestion, or cloud service.
// This does not teach phrase recognition or certify DJ quality, and does not replace dopamine reinforcement.
