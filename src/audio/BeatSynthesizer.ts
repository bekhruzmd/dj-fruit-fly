export type BeatPatternName = 'four_on_floor' | 'breakbeat_funk' | 'neuro_trap' | 'minimal_groove';

export interface BeatPattern {
  name: string;
  bpm: number;
  steps: number; // usually 16
  kick: boolean[];
  snare: boolean[];
  hihat: boolean[];
  openHat: boolean[];
  bass: boolean[];
}

export const PRESET_PATTERNS: Record<BeatPatternName, BeatPattern> = {
  four_on_floor: {
    name: 'House / 4-on-the-Floor',
    bpm: 124,
    steps: 16,
    kick:    [true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false],
    snare:   [false, false, false, false, true, false, false, false, false, false, false, false, true, false, false, false],
    hihat:   [false, false, true, false, false, false, true, false, false, false, true, false, false, false, true, false],
    openHat: [false, false, true, false, false, false, true, false, false, false, true, false, false, false, true, false],
    bass:    [false, false, true, true, false, false, true, false, false, true, true, false, false, false, true, false]
  },
  breakbeat_funk: {
    name: 'Breakbeat Funk',
    bpm: 112,
    steps: 16,
    kick:    [true, false, false, false, false, false, true, false, false, true, false, false, false, false, true, false],
    snare:   [false, false, false, false, true, false, false, false, false, false, false, false, true, false, false, true],
    hihat:   [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true],
    openHat: [false, false, false, false, false, false, false, true, false, false, false, false, false, false, true, false],
    bass:    [true, false, false, true, false, false, true, false, false, true, false, false, true, false, false, false]
  },
  neuro_trap: {
    name: 'Neuro Trap',
    bpm: 135,
    steps: 16,
    kick:    [true, false, false, false, false, false, false, false, false, false, true, false, false, false, false, false],
    snare:   [false, false, false, false, false, false, false, false, true, false, false, false, false, false, false, false],
    hihat:   [true, false, true, true, true, false, true, true, true, true, true, false, true, true, true, true],
    openHat: [false, false, false, false, false, false, false, false, false, false, false, false, false, true, false, false],
    bass:    [true, true, false, false, false, false, false, false, false, false, true, true, false, false, false, false]
  },
  minimal_groove: {
    name: 'Minimal Dub',
    bpm: 118,
    steps: 16,
    kick:    [true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false],
    snare:   [false, false, false, false, false, false, false, false, true, false, false, false, false, false, false, false],
    hihat:   [false, true, false, true, false, true, false, true, false, true, false, true, false, true, false, true],
    openHat: [false, false, false, true, false, false, false, true, false, false, false, true, false, false, false, true],
    bass:    [false, true, false, false, false, false, true, false, false, false, false, true, false, true, false, false]
  }
};

export class BeatSynthesizer {
  private ctx: AudioContext;
  public outputNode: GainNode;
  private isPlaying: boolean = false;
  private currentPattern: BeatPattern;
  public bpm: number;

  private currentStep: number = 0;
  private nextStepTime: number = 0;
  private timerId: number | null = null;
  private lookahead: number = 25.0; // ms
  private scheduleAheadTime: number = 0.1; // seconds

  // Master Synth Gain
  private masterGain: GainNode;

  constructor(audioContext: AudioContext, initialPattern: BeatPatternName = 'four_on_floor') {
    this.ctx = audioContext;
    this.currentPattern = PRESET_PATTERNS[initialPattern];
    this.bpm = this.currentPattern.bpm;

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.85;

    this.outputNode = this.masterGain;
  }

  public setPattern(patternKey: BeatPatternName): void {
    this.currentPattern = PRESET_PATTERNS[patternKey];
    this.bpm = this.currentPattern.bpm;
  }

  public setBPM(newBpm: number): void {
    this.bpm = Math.max(60, Math.min(180, newBpm));
  }

  public setVolume(vol: number): void {
    this.masterGain.gain.setValueAtTime(Math.max(0, Math.min(1, vol)), this.ctx.currentTime);
  }

  public start(): void {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.currentStep = 0;
    this.nextStepTime = this.ctx.currentTime + 0.05;
    this.scheduler();
  }

  public stop(): void {
    this.isPlaying = false;
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  public toggle(): boolean {
    if (this.isPlaying) {
      this.stop();
    } else {
      this.start();
    }
    return this.isPlaying;
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  public getCurrentStep(): number {
    return this.currentStep;
  }

  private nextStep(): void {
    const secondsPerBeat = 60.0 / this.bpm;
    const secondsPer16th = secondsPerBeat / 4.0;
    this.nextStepTime += secondsPer16th;
    this.currentStep = (this.currentStep + 1) % this.currentPattern.steps;
  }

  private scheduleStep(stepIndex: number, time: number): void {
    const p = this.currentPattern;

    if (p.kick[stepIndex]) {
      this.playKick(time);
    }
    if (p.snare[stepIndex]) {
      this.playSnare(time);
    }
    if (p.hihat[stepIndex]) {
      this.playHiHat(time, false);
    }
    if (p.openHat[stepIndex]) {
      this.playHiHat(time, true);
    }
    if (p.bass[stepIndex]) {
      this.playBass(time, stepIndex);
    }
  }

  private scheduler = (): void => {
    while (this.nextStepTime < this.ctx.currentTime + this.scheduleAheadTime) {
      this.scheduleStep(this.currentStep, this.nextStepTime);
      this.nextStep();
    }
    if (this.isPlaying) {
      this.timerId = window.setTimeout(this.scheduler, this.lookahead);
    }
  };

  // Kick Drum: Rapid pitch drop + sub thump
  private playKick(time: number): void {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(38, time + 0.09);

    gain.gain.setValueAtTime(1.0, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.35);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(time);
    osc.stop(time + 0.35);
  }

  // Snare Drum: Noise burst + tone body
  private playSnare(time: number): void {
    // Noise buffer
    const bufferSize = Math.floor(this.ctx.sampleRate * 0.2);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(800, time);

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.7, time);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, time + 0.2);

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(this.masterGain);

    // Body tone
    const osc = this.ctx.createOscillator();
    const oscGain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(190, time);
    osc.frequency.exponentialRampToValueAtTime(80, time + 0.1);

    oscGain.gain.setValueAtTime(0.5, time);
    oscGain.gain.exponentialRampToValueAtTime(0.01, time + 0.12);

    osc.connect(oscGain);
    oscGain.connect(this.masterGain);

    noise.start(time);
    noise.stop(time + 0.2);
    osc.start(time);
    osc.stop(time + 0.12);
  }

  // Hi-Hat: Bandpassed noise click
  private playHiHat(time: number, isOpen: boolean): void {
    const duration = isOpen ? 0.35 : 0.06;
    const bufferSize = Math.floor(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(7500, time);
    filter.Q.setValueAtTime(3.0, time);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(isOpen ? 0.4 : 0.3, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

    noise.start(time);
    noise.stop(time + duration);
  }

  // Sub/Acid Bass Stab
  private playBass(time: number, stepIndex: number): void {
    const notes = [55, 55, 65.41, 73.42, 82.41, 55]; // A1, C2, D2, E2, A1
    const freq = notes[stepIndex % notes.length];

    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, time);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800, time);
    filter.frequency.exponentialRampToValueAtTime(120, time + 0.18);
    filter.Q.setValueAtTime(4, time);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.4, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.2);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

    osc.start(time);
    osc.stop(time + 0.2);
  }
}
