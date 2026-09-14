import assert from 'node:assert/strict';
import { FlyWireCircuit } from './src/neural/FlyWireCircuit';
import { DJRewardEngine } from './src/neural/DJRewardEngine';
import { DescendingOutputLayer } from './src/neural/DescendingOutputLayer';
import { MusicalDirector } from './src/neural/MusicalDirector';
import { bassGains, musicalTiming } from './src/audio/MusicalTiming';
import { encodeWav } from './src/audio/WavEncoder';

function random(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}
function check(name: string, test: () => void) { test(); console.log(`PASS ${name}`); }

check('musical clock follows eight-bar boundaries and exact downbeats', () => {
  assert.equal(musicalTiming(32 * 60 / 125, 125).isPhraseDrop, true);
  assert.equal(musicalTiming(31 * 60 / 125, 125).isBuildup, true);
  assert.equal(musicalTiming(4 * 60 / 125, 125).isDownbeat, true);
  assert.equal(musicalTiming(-0.03, 125).totalBeats, 0);
});

check('guided blends complete, reverse, keep midpoint on beat, and release rolls', () => {
  const director = new MusicalDirector();
  const raw = { crossfader: 0.9, filterCutoff: 0.9, stutterTrigger: true,
    rawCrossfader: 0.9, rawFilter: 0.9, rawStutter: 0.9 };
  const at = (beats: number) => director.update(raw, musicalTiming(beats * 0.5, 120));
  assert.equal(at(0).crossfader, 0);
  assert.equal(at(31).crossfader, 0);
  assert.ok(Math.abs(at(48).crossfader - 0.5) < 1e-6);
  assert.equal(at(63.6).stutterTrigger, true);
  assert.equal(at(64).crossfader, 1);
  assert.equal(at(64).stutterTrigger, false);
  assert.equal(at(64).filterCutoff, 0.5);
  assert.equal(at(128).crossfader, 0);
  let previous = 0;
  for (let beat = 0; beat < 64; beat += 0.04) {
    const value = at(beat).crossfader;
    assert.ok(value >= previous - 1e-8);
    assert.ok(Math.abs(value - previous) < 0.005);
    previous = value;
  }
});

check('bass protection preserves one low end throughout the blend', () => {
  for (let x = 0; x <= 1; x += 0.01) {
    const gains = bassGains(x);
    assert.equal(Math.max(...gains), 0);
    assert.equal(Math.min(...gains), -24);
  }
});

check('an audible-to-silent dropout is penalized; standby is neutral', () => {
  const reward = new DJRewardEngine();
  reward.computeReward(0, 0.5, false, 0, false, 0.25, 0, 0.04);
  const dropout = reward.computeReward(0, 0.5, false, 0, false, 0, 0.25, 0.04);
  assert.ok(dropout.totalReward < 0);
  assert.ok(dropout.discontinuityPenalty > 0);
  assert.equal(reward.computeReward(0, 0.5, false, 0, false, 0, 0.25, 0.04, true).totalReward, 0);
});

check('motor smoothing is independent of frame subdivision', () => {
  const a = new DescendingOutputLayer(); const b = new DescendingOutputLayer();
  const input = new Float32Array([0.8, 0.6, 0.9]);
  const first = a.update(input, 0.04);
  b.update(input, 0.02);
  const second = b.update(input, 0.02);
  assert.ok(Math.abs(first.crossfader - second.crossfader) < 1e-8);
  assert.ok(Math.abs(first.filterCutoff - second.filterCutoff) < 1e-8);
});

check('seeded learning changes only KC→DN; frozen and standby brains stay fixed', () => {
  const circuit = new FlyWireCircuit(undefined, random(42));
  const upstream = Array.from(circuit.W_pn_kc);
  const initial = Array.from(circuit.W_kc_dn);
  for (let i = 0; i < 1000; i++) {
    const kick = i % 12 === 0;
    circuit.step([kick ? 0.9 : 0.1, 0.3, 0.2, 0.1], kick ? 1 : 0, kick,
      0.24, 0.01, 0.04, false, undefined, musicalTiming(i * 0.04, 125));
  }
  assert.deepEqual(Array.from(circuit.W_pn_kc), upstream);
  assert.notDeepEqual(Array.from(circuit.W_kc_dn), initial);
  assert.ok(circuit.W_kc_dn.every(w => Number.isFinite(w) && w >= 0.01 && w <= 1.6));
  circuit.learningEnabled = false;
  const frozen = Array.from(circuit.W_kc_dn);
  circuit.step([1, 1, 1, 1], 1, true, 0.3, 0.1, 0.04);
  circuit.injectManualDopamine(1.5);
  assert.deepEqual(Array.from(circuit.W_kc_dn), frozen);
  circuit.learningEnabled = true;
  circuit.step([1, 1, 1, 1], 1, true, 0.3, 0.1, 0.04, true);
  assert.deepEqual(Array.from(circuit.W_kc_dn), frozen);
});

check('checkpoints restore fixed wiring and reject malformed weights atomically', () => {
  const source = new FlyWireCircuit(undefined, random(42));
  const target = new FlyWireCircuit(undefined, random(99));
  const saved = source.saveBrain();
  assert.equal(target.loadBrain(saved), true);
  assert.deepEqual(Array.from(target.W_pn_kc), Array.from(source.W_pn_kc));
  assert.deepEqual(Array.from(target.W_kc_dn), Array.from(source.W_kc_dn));
  const corrupt = JSON.parse(saved); corrupt.W_kc_dn[5] = null;
  assert.equal(target.loadBrain(JSON.stringify(corrupt)), false);
  assert.deepEqual(Array.from(target.W_kc_dn), Array.from(source.W_kc_dn));
});

async function verifyWav() {
  const blob = encodeWav([new Float32Array([-1, 1, 0, 0.5])], 48000);
  const view = new DataView(await blob.arrayBuffer());
  assert.equal(blob.size, 52);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(46, true), 32767);
  assert.equal(view.getUint32(40, true), 8);
  console.log('PASS WAV stereo PCM header and samples');
}
verifyWav().catch(error => { console.error(error); process.exitCode = 1; });
