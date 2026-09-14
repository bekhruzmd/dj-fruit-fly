import { encodeWav } from './WavEncoder';

/** A separate post-master tap; never replaces the audible or sensory paths. */
export class SetRecorder {
  private node: AudioWorkletNode | null = null;
  private source: AudioNode | null = null;
  private chunks: Float32Array[] = [];
  private initialized = false;
  private disposed = false;
  private starting = false;

  constructor(
    privateContext: AudioContext,
    onComplete: (blob: Blob) => void,
    onError: (message: string) => void,
  ) { this.ctx = privateContext; this.onComplete = onComplete; this.onError = onError; }
  private onComplete: (blob: Blob) => void;
  private onError: (message: string) => void;
  private ctx: AudioContext;

  public async start(source: AudioNode): Promise<void> {
    if (this.node || this.starting || this.disposed) return;
    this.starting = true;
    try {
      if (!this.initialized) {
        await this.ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}recorder-worklet.js`);
        this.initialized = true;
      }
      if (this.disposed) return;
      this.chunks = [];
      const node = new AudioWorkletNode(this.ctx, 'neuro-dj-recorder', { outputChannelCount: [2] });
      this.node = node;
      this.source = source;
      node.port.onmessage = ({ data }) => {
        if (data.chunk) this.chunks.push(new Float32Array(data.chunk));
        if (data.done) {
          const blob = encodeWav(this.chunks, this.ctx.sampleRate);
          this.disconnect();
          this.onComplete(blob);
        }
      };
      node.onprocessorerror = () => {
        this.disconnect();
        this.onError('Recording interrupted. Please try a new clip.');
      };
      source.connect(node);
      // Worklet output is silence, keeping capture out of the audible mix.
      node.connect(this.ctx.destination);
    } finally { this.starting = false; }
  }

  public stop(): void { this.node?.port.postMessage('stop'); }

  private disconnect(): void {
    if (this.node) {
      this.source?.disconnect(this.node);
      this.node.disconnect();
      this.node.port.close();
    }
    this.node = null;
    this.source = null;
    this.chunks = [];
  }

  public dispose(): void { this.disposed = true; this.disconnect(); }
}
