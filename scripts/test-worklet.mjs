import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const messages = [];
let Processor;
class MockProcessor {
  port = { onmessage: null, postMessage: message => messages.push(message) };
}
runInNewContext(readFileSync('public/recorder-worklet.js', 'utf8'), {
  AudioWorkletProcessor: MockProcessor,
  Float32Array,
  sampleRate: 100,
  registerProcessor: (_, value) => { Processor = value; },
});
const recorder = new Processor();
const mono = new Float32Array(128).fill(0.25);
for (let i = 0; i < 100; i++) recorder.process([[mono]]);
assert.equal(messages.filter(m => m.done).length, 1);
const chunks = messages.filter(m => m.chunk).map(m => new Float32Array(m.chunk));
assert.equal(chunks.reduce((n, chunk) => n + chunk.length, 0), 120 * 100 * 2);
assert.ok(chunks.every(chunk => chunk.every(sample => sample === 0.25)));
recorder.port.onmessage({ data: 'stop' });
assert.equal(messages.filter(m => m.done).length, 1);
console.log('PASS worklet duplicates mono into stereo, flushes partial chunks and caps capture once');
