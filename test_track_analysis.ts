import assert from 'node:assert/strict';
import { gridTimes, validateGrid, isTrackAnalysis, initialGrid, type TrackAnalysis } from './src/audio/TrackAnalysis';
import { MusicalDirector } from './src/neural/MusicalDirector';
import { musicalTiming } from './src/audio/MusicalTiming';

const analysis: TrackAnalysis = {
  schemaVersion: 1, trackId: 'a'.repeat(64), durationSeconds: 24,
  source: { bytes: 2048, sampleRate: 44100, channels: 2 },
  provenance: { algorithm: 'fixture', configVersion: '1', config: {}, rhythmChannel: 0 },
  bpm: 120, gridOffsetSeconds: .25, beatTimes: [.25, .75, 1.25], onsetTimes: [.25, .75, 1.25],
  confidence: { kind: 'heuristic', score: .5, regularity: .8, onsetSupport: .7 },
  tempoAlternatives: [60, 240], energyCurve: [{ time: 0, rms: .1, dbfs: -20 }],
  downbeatTimes: null, phrases: null, key: null, vocalRegions: null, warnings: [],
};
assert.ok(isTrackAnalysis(analysis));
assert.equal(isTrackAnalysis({ ...analysis, beatTimes: [2, 1] }), false);
assert.equal(isTrackAnalysis({ ...analysis, beatTimes: [1, NaN] }), false);
assert.equal(isTrackAnalysis({ ...analysis, downbeatTimes: [] }), false);
assert.equal(isTrackAnalysis({ ...analysis, energyCurve: [{ time: 0, rms: NaN, dbfs: 0 }] }), false);
assert.equal(validateGrid({ bpm: 0, offsetSeconds: 0, reviewed: false }, 24), false);
assert.equal(validateGrid({ bpm: 120, offsetSeconds: 25, reviewed: true }, 24), false);
assert.deepEqual(gridTimes({ bpm: 120, offsetSeconds: .25, reviewed: true }, 2, 4), [2.25, 2.75, 3.25, 3.75]);
assert.deepEqual(gridTimes({ bpm: 60, offsetSeconds: .25, reviewed: true }, 2, 4), [2.25, 3.25]);
assert.deepEqual(gridTimes({ bpm: Infinity, offsetSeconds: 0, reviewed: false }, 0, 12), []);
assert.equal(initialGrid({ ...analysis, bpm: null, gridOffsetSeconds: null }).reviewed, false);
const controls = { crossfader: .4, filterCutoff: .5, stutterTrigger: false, rawCrossfader: .9, rawFilter: .5, rawStutter: .2 };
assert.deepEqual(new MusicalDirector().update(controls, { ...musicalTiming(20, 120), hasPhraseGrid: false }), controls);
console.log('PASS analysis schema, invalid metadata, grid phase, tempo correction, and unknown-phrase bypass');
// Module summary: These regressions check the metadata boundary and the distinction between pulses and phrases.
// They ensure grid arithmetic preserves phase across preview positions and unsafe values never become scheduled events.
// They cannot judge whether a numerically valid beat grid is musically correct.
