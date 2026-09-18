export interface AudioFeatures {
  subBass: number;   // 20 - 150 Hz (transduced by JON-B)
  lowMids: number;   // 150 - 600 Hz (transduced by JON-AB courtship / low vibration)
  highMids: number;  // 600 - 3000 Hz (transduced by JON-A)
  highs: number;     // 3000 - 12000 Hz (transduced by JON-A transients)
  spectralFlux: number; // Raw flux
  onset: number;     // Normalized onset burst [0, 1]
  isBeat: boolean;   // Discrete trigger flag
}

export class AudioFeatureExtractor {
  public ctx: AudioContext;
  public analyser: AnalyserNode;
  private freqData: Uint8Array<ArrayBuffer>;
  private prevSpectrum: Float32Array;
  private sampleRate: number;
  private fftSize: number = 1024;
  private thresholdRunningMean: number = 0.04;
  private lastBeatTime: number = 0;
  private minBeatInterval: number = 0.22; // Max ~270 BPM

  private activeSourceNode: AudioNode | null = null;

  constructor(audioContext?: AudioContext) {
    this.ctx = audioContext || new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = 0.5;
    this.sampleRate = this.ctx.sampleRate;

    const binCount = this.analyser.frequencyBinCount;
    this.freqData = new Uint8Array(new ArrayBuffer(binCount));
    this.prevSpectrum = new Float32Array(binCount);
  }

  public async resumeContext(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  public connectSource(sourceNode: AudioNode): void {
    if (this.activeSourceNode) {
      try {
        this.activeSourceNode.disconnect();
      } catch {
        // Safe to ignore if already disconnected
      }
    }
    this.activeSourceNode = sourceNode;
    this.activeSourceNode.connect(this.analyser);
  }

  public connectStream(stream: MediaStream): MediaStreamAudioSourceNode {
    const streamNode = this.ctx.createMediaStreamSource(stream);
    this.connectSource(streamNode);
    return streamNode;
  }

  public disconnectSource(): void {
    if (this.activeSourceNode) {
      try {
        this.activeSourceNode.disconnect();
      } catch {
        // Ignore
      }
      this.activeSourceNode = null;
    }
  }

  private binForFreq(freq: number): number {
    return Math.min(
      Math.max(0, Math.floor((freq / (this.sampleRate / 2)) * this.analyser.frequencyBinCount)),
      this.analyser.frequencyBinCount - 1
    );
  }

  private getBandEnergy(startFreq: number, endFreq: number): number {
    const startBin = this.binForFreq(startFreq);
    const endBin = this.binForFreq(endFreq);
    if (startBin >= endBin) return this.freqData[startBin] / 255.0;

    let sum = 0;
    for (let i = startBin; i <= endBin; i++) {
      sum += this.freqData[i] / 255.0;
    }
    return sum / (endBin - startBin + 1);
  }

  public update(): AudioFeatures {
    this.analyser.getByteFrequencyData(this.freqData);

    const subBass = this.getBandEnergy(20, 150);
    const lowMids = this.getBandEnergy(150, 600);
    const highMids = this.getBandEnergy(600, 3000);
    const highs = this.getBandEnergy(3000, 12000);

    // Compute half-wave rectified spectral flux
    let flux = 0;
    const n = this.analyser.frequencyBinCount;
    for (let i = 0; i < n; i++) {
      const currentVal = this.freqData[i] / 255.0;
      const diff = currentVal - this.prevSpectrum[i];
      if (diff > 0) {
        flux += diff;
      }
      this.prevSpectrum[i] = currentVal;
    }
    flux /= n;

    // Adaptive thresholding for onset detection
    this.thresholdRunningMean = 0.90 * this.thresholdRunningMean + 0.10 * flux;
    const threshold = this.thresholdRunningMean * 1.5 + 0.008;

    const excess = Math.max(0, flux - threshold);
    const normalizedOnset = Math.min(1.0, excess * 15.0);

    const now = this.ctx.currentTime;
    let isBeat = false;
    if (normalizedOnset > 0.45 && now - this.lastBeatTime > this.minBeatInterval) {
      isBeat = true;
      this.lastBeatTime = now;
    }

    return {
      subBass,
      lowMids,
      highMids,
      highs,
      spectralFlux: flux,
      onset: normalizedOnset,
      isBeat
    };
  }
}
