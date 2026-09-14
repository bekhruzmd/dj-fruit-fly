/* Stereo PCM capture, capped at two minutes to bound browser memory. */
class NeuroDJRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(8192);
    this.length = 0;
    this.frames = 0;
    this.done = false;
    this.port.onmessage = ({ data }) => { if (data === 'stop') this.finish(); };
  }
  flush() {
    if (!this.length) return;
    const chunk = this.buffer.slice(0, this.length);
    this.port.postMessage({ chunk: chunk.buffer }, [chunk.buffer]);
    this.length = 0;
  }
  finish() {
    if (this.done) return;
    this.done = true;
    this.flush();
    this.port.postMessage({ done: true });
  }
  process(inputs) {
    if (this.done) return false;
    const left = inputs[0]?.[0];
    const right = inputs[0]?.[1] || left;
    if (left) {
      for (let i = 0; i < left.length; i++) {
        this.buffer[this.length++] = left[i];
        this.buffer[this.length++] = right[i];
        if (this.length === this.buffer.length) this.flush();
        if (++this.frames >= sampleRate * 120) { this.finish(); break; }
      }
    }
    return !this.done;
  }
}
registerProcessor('neuro-dj-recorder', NeuroDJRecorder);
