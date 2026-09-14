import assert from 'node:assert/strict';
import { FlyWireCircuit } from './src/neural/FlyWireCircuit';
import { applyImitation, trainDemonstrations, type Demonstration } from './src/neural/DemonstrationLearning';

function random(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}
// Summary: This makes wiring reproducible across the test's student and teacher.
// Several seeds exercise different sparse projections without introducing flaky random runs.
// Seed coverage cannot establish reliability on real music.

function example(teacher: FlyWireCircuit, id: string, offset: number): Demonstration {
  teacher.resetPerformance();
  const frames = [];
  for (let i = 0; i < 500; i++) {
    const bands = [0, 1, 2, 3].map(b => 0.25 + 0.2 * Math.sin(i * 0.07 + b * 1.2 + offset));
    const c = teacher.step(bands, 0, false, 0, 0, 0.04, true).controls;
    frames.push({ bands, dt: 0.04, targets: [c.rawCrossfader, c.rawFilter, c.rawStutter] });
  }
  return { id, source: 'Synthetic learnable teacher; no audio', frames };
}
// Summary: This constructs a realizable task using another readout on the same fixed wiring.
// Different input trajectories separate training from evaluation rather than duplicating a take.
// It is a test of learning mechanics, not evidence of DJ skill.

async function main() {
  for (const seed of [7, 42, 99]) {
    const live = new FlyWireCircuit(undefined, random(seed));
    const teacher = new FlyWireCircuit(undefined, random(seed));
    teacher.learningEnabled = false;
    teacher.guidedSet = false;
    teacher.W_kc_dn.forEach((w, i) => { teacher.W_kc_dn[i] = w * [0.65, 0.8, 0.5][i % 3]; });
    const train = example(teacher, 'train', 0);
    const test = example(teacher, 'test', 0.8);
    const upstream = Array.from(live.W_pn_kc);
    const original = Array.from(live.W_kc_dn);
    const result = await trainDemonstrations(live, train, test);
    assert.deepEqual(Array.from(live.W_kc_dn), original);
    assert.deepEqual(Array.from(live.W_pn_kc), upstream);
    assert.ok(result.improved, `seed ${seed} should learn: ${JSON.stringify(result.after)}`);
    assert.ok(result.after.reduce((a, b) => a + b) < result.before.reduce((a, b) => a + b) * 0.5);
    assert.ok(result.weights.every(w => Number.isFinite(w) && w >= 0.00999 && w <= 1.60001));
    const alternateTest = structuredClone(test);
    alternateTest.frames.forEach(frame => { frame.targets = [0, 1, 0]; });
    const alternate = await trainDemonstrations(live, train, alternateTest);
    assert.deepEqual(alternate.weights, result.weights, 'evaluation labels must never train or select weights');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(trainDemonstrations(live, train, test, controller.signal));
    assert.deepEqual(Array.from(live.W_kc_dn), original);
    await assert.rejects(trainDemonstrations(live, train, train));
    const malformed = structuredClone(train); malformed.frames[0].bands[0] = NaN;
    await assert.rejects(trainDemonstrations(live, malformed, test));
    live.W_kc_dn[0] += 0.01;
    assert.throws(() => applyImitation(live, result), /Brain changed/);
    live.W_kc_dn.set(original);
    applyImitation(live, result);
    assert.equal(live.learningEnabled, false);
    assert.equal(live.guidedSet, false);
    assert.deepEqual(Array.from(live.W_pn_kc), upstream);
    assert.deepEqual(Array.from(live.W_kc_dn), result.weights);
    console.log(`PASS imitation seed ${seed}: evaluation MSE ${result.before.map(v => v.toFixed(5))} → ${result.after.map(v => v.toFixed(5))}`);
  }
  const frozen = new FlyWireCircuit();
  assert.throws(() => frozen.imitateMotorTargets([0, 0, 0]), /frozen/);
  assert.throws(() => frozen.imitateMotorTargets([NaN, 0, 0]), /Invalid/);
  console.log('PASS isolated training, held-out labels, invalid data, cancellation, stale apply, frozen candidate');
}
// Summary: This requires substantial held-out improvement on three realizable synthetic tasks.
// It also checks that evaluation, failed operations, and cancellation preserve the live circuit.
// Real guided demonstrations can fail because their target behavior requires missing phrase context.

main().catch(error => { console.error(error); process.exitCode = 1; });
// Module summary: These regressions distinguish weight movement from actual predictive improvement.
// They intentionally use no authored director during training or scoring.
// Passing results support imitation mechanics only; acoustic quality requires separate listening comparisons.
