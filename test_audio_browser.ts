import { DJAudioEngine } from './src/audio/DJAudioEngine';
import { AudioFeatureExtractor } from './src/audio/AudioFeatureExtractor';
import { FlyWireCircuit } from './src/neural/FlyWireCircuit';

function seeded(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

// Runs the real DSP and FFT in a browser. This is an engineering evaluation,
// not a claim that a reward score measures artistic quality.
export async function renderSet(learning: boolean, checkpoint?: string) {
  const duration = 62;
  const ctx = new OfflineAudioContext(2, 24000 * duration, 24000);
  (globalThis as unknown as { testAudioContext: OfflineAudioContext }).testAudioContext = ctx;
  const engine = new DJAudioEngine(ctx, seeded(123));
  const extractor = new AudioFeatureExtractor(ctx as unknown as AudioContext);
  engine.outputNode.connect(ctx.destination);
  extractor.connectSource(engine.outputNode);
  const circuit = new FlyWireCircuit(undefined, seeded(456));
  if (checkpoint && !circuit.loadBrain(checkpoint)) throw new Error('Invalid checkpoint');
  circuit.learningEnabled = learning;
  engine.start();
  let reward = 0;
  let maxJump = 0;
  let previous = 0;
  const steps: Promise<void>[] = [];
  for (let t = 0.04; t < duration - 0.04; t += 0.04) {
    steps.push(ctx.suspend(t).then(() => {
      const f = extractor.update();
      const rms = engine.updateAcoustics();
      const telemetry = circuit.step([f.subBass, f.lowMids, f.highMids, f.highs],
        f.onset, f.isBeat, rms.currentRMS, rms.deltaRMS, 0.04, false, undefined, engine.getPlaybackTiming());
      const c = telemetry.controls;
      maxJump = Math.max(maxJump, Math.abs(c.crossfader - previous));
      previous = c.crossfader;
      engine.setCrossfader(c.crossfader);
      engine.setFilter(c.filterCutoff, c.filterDeck);
      engine.setStutter(c.stutterTrigger);
      reward += telemetry.dopamine * 0.04;
      void ctx.resume();
    }));
  }
  const audio = await ctx.startRendering();
  await Promise.all(steps);
  let peak = 0;
  let sum = 0;
  let quietWindows = 0;
  let minimumWindowRMS = Infinity;
  const samples = audio.getChannelData(0);
  for (let start = 24000; start < samples.length - 6000; start += 6000) {
    let power = 0;
    for (let i = start; i < start + 6000; i++) {
      if (!Number.isFinite(samples[i])) throw new Error('Non-finite audio');
      peak = Math.max(peak, Math.abs(samples[i]));
      power += samples[i] ** 2;
      sum += samples[i] ** 2;
    }
    const rms = Math.sqrt(power / 6000);
    minimumWindowRMS = Math.min(minimumWindowRMS, rms);
    if (rms < 0.015) quietWindows++;
  }
  if (peak >= 1) throw new Error(`Clipped audio: ${peak}`);
  if (quietWindows) throw new Error(`${quietWindows} unintended quiet windows`);
  if (maxJump > 0.01) throw new Error(`Crossfader jump: ${maxJump}`);
  return { reward, peak, rms: Math.sqrt(sum / samples.length), minimumWindowRMS,
    quietWindows, maxJump, checkpoint: circuit.saveBrain() };
}

export async function evaluateLearning() {
  const before = await renderSet(false);
  const practice = await renderSet(true);
  const after = await renderSet(false, practice.checkpoint);
  const report = (result: Awaited<ReturnType<typeof renderSet>>) => {
    const { checkpoint: _, ...metrics } = result;
    return metrics;
  };
  return { before: report(before), practice: report(practice), after: report(after),
    rewardChange: after.reward - before.reward };
}
