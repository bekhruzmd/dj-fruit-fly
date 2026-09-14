import { initialGrid, isTrackAnalysis, validateGrid, type BeatGrid, type TrackAnalysis } from './TrackAnalysis';
import { musicalTiming, bassGains, type MusicalTiming } from './MusicalTiming';
export interface DeckState {
  isPlaying: boolean;
  bpm: number;
  duration: number;
  currentTime: number;
  trackName: string;
}

export class DJAudioEngine {
  public ctx: BaseAudioContext;
  private random: () => number;

  // Deck Audio Nodes
  private deckAGain: GainNode;
  private deckBGain: GainNode;
  private deckAFilter: BiquadFilterNode;
  private deckBFilter: BiquadFilterNode;
  private deckABass: BiquadFilterNode;
  private deckBBass: BiquadFilterNode;
  private stutterInputGain: GainNode;
  private masterGain: GainNode;
  private masterCompressor: DynamicsCompressorNode;

  // DJ FX Nodes
  public djFilter: BiquadFilterNode;
  private stutterDryGain: GainNode;
  private stutterWetGain: GainNode;
  private stutterDelay: DelayNode;
  private stutterFeedback: GainNode;

  // Analysis Node for acoustic feedback loop (Johnston's Organ)
  public outputNode: AudioNode;

  // Deck Audio Buffers & Sources
  private bufferA: AudioBuffer | null = null;
  private bufferB: AudioBuffer | null = null;
  private sourceA: AudioBufferSourceNode | null = null;
  private sourceB: AudioBufferSourceNode | null = null;
  private loadGeneration = { A: 0, B: 0 };
  private imported = { A: false, B: false };
  private analyses: Record<'A' | 'B', TrackAnalysis | null> = { A: null, B: null };
  private grids: Record<'A' | 'B', BeatGrid | null> = { A: null, B: null };

  // Real-time Consequential Control Variables (Driven by Descending Neurons)
  public crossfader: number = 0.0; // 0.0 = 100% Deck A, 1.0 = 100% Deck B
  public filterCutoff: number = 0.5; // 0.0 = Deep LPF, 0.5 = Flat/Neutral, 1.0 = HPF (Bass Cut)
  public fxStutterActive: boolean = false;

  // Playback States
  public isPlaying: boolean = false;
  public masterBpm: number = 125;
  private trackAName: string = 'Neuro-DJ - Chicago Afterhours (Deck A)';
  private trackBName: string = 'Neuro-DJ - Terrace Tools (Deck B)';

  // Real-time acoustic measurement for Dopamine scoring
  public lastRMS: number = 0;
  public prevRMS: number = 0;
  private rmsSampleBuffer: Float32Array<ArrayBuffer>;
  private rmsAnalyser: AnalyserNode;
  private rmsTime = 0;
  private rmsPower = 0;
  private previousInstantRMS = 0;

  constructor(audioContext: BaseAudioContext, random: () => number = Math.random) {
    this.random = random;
    this.ctx = audioContext;

    // 1. Deck Gains for Crossfader
    this.deckAGain = this.ctx.createGain();
    this.deckBGain = this.ctx.createGain();
    this.deckAFilter = this.ctx.createBiquadFilter();
    this.deckBFilter = this.ctx.createBiquadFilter();
    this.deckAFilter.type = 'allpass';
    this.deckBFilter.type = 'allpass';
    this.deckABass = this.ctx.createBiquadFilter();
    this.deckBBass = this.ctx.createBiquadFilter();
    for (const shelf of [this.deckABass, this.deckBBass]) {
      shelf.type = 'lowshelf';
      shelf.frequency.value = 180;
    }
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.9;

    // 2. DJ Resonant Filter (Isolator / Low-Pass / High-Pass)
    this.djFilter = this.ctx.createBiquadFilter();
    this.djFilter.type = 'lowpass';
    this.djFilter.frequency.value = Math.min(20000, this.ctx.sampleRate / 2);
    this.djFilter.Q.value = 2.0;

    // 3. Stutter / Beat-Roll Loop FX
    this.stutterDelay = this.ctx.createDelay(1.0);
    this.stutterDelay.delayTime.value = (60.0 / this.masterBpm) / 4.0; // 1/16th note stutter
    this.stutterInputGain = this.ctx.createGain();
    this.stutterFeedback = this.ctx.createGain();
    this.stutterFeedback.gain.value = 0.0;
    this.stutterDryGain = this.ctx.createGain();
    this.stutterDryGain.gain.value = 1.0;
    this.stutterWetGain = this.ctx.createGain();
    this.stutterWetGain.gain.value = 0.0; // Muted by default: ZERO DELAY BLEED OR ECHO!

    this.stutterDelay.connect(this.stutterFeedback);
    this.stutterFeedback.connect(this.stutterDelay);

    // 4. Dynamics Compressor / Limiter on Master Output to prevent any clipping distortion
    this.masterCompressor = this.ctx.createDynamicsCompressor();
    this.masterCompressor.threshold.value = -12.0;
    this.masterCompressor.knee.value = 6.0;
    this.masterCompressor.ratio.value = 5.0;
    this.masterCompressor.attack.value = 0.003;
    this.masterCompressor.release.value = 0.15;
    this.masterCompressor.connect(this.masterGain);

    // 5. Connect Web Audio DSP Graph
    // Deck A -> Deck A Gain ┐
    //                        ├─► DJ Filter ─┬─► Stutter Dry Gain ───┬─► Master Compressor ─► Master Gain
    // Deck B -> Deck B Gain ┘              └─► Stutter Delay ─► Stutter Wet Gain ─┘
    this.deckAGain.connect(this.deckAFilter);
    this.deckBGain.connect(this.deckBFilter);
    this.deckAFilter.connect(this.deckABass);
    this.deckBFilter.connect(this.deckBBass);
    this.deckABass.connect(this.djFilter);
    this.deckBBass.connect(this.djFilter);

    // Clean Dry Path
    this.djFilter.connect(this.stutterDryGain);
    this.stutterDryGain.connect(this.masterCompressor);

    // Wet FX Path (strictly muted until stutter is explicitly active)
    this.djFilter.connect(this.stutterInputGain);
    this.stutterInputGain.connect(this.stutterDelay);
    this.stutterDelay.connect(this.stutterWetGain);
    this.stutterWetGain.connect(this.masterCompressor);

    // RMS Analyser for real-time loudness & discontinuity tracking
    this.rmsAnalyser = this.ctx.createAnalyser();
    this.rmsAnalyser.fftSize = 2048;
    this.rmsSampleBuffer = new Float32Array(new ArrayBuffer(this.rmsAnalyser.fftSize * 4));
    this.masterGain.connect(this.rmsAnalyser);

    this.outputNode = this.masterGain;

    // Set initial crossfader (100% Deck A)
    this.setCrossfader(0.0);

    // Synthesize original house loops by default
    this.initDefaultStems();
  }

  // Set equal-power crossfader: 0.0 (Deck A) to 1.0 (Deck B)
  public setCrossfader(val: number): void {
    this.crossfader = Math.max(0.0, Math.min(1.0, val));
    const [bassA, bassB] = bassGains(this.crossfader);
    this.deckABass.gain.setTargetAtTime(bassA, this.ctx.currentTime, 0.025);
    this.deckBBass.gain.setTargetAtTime(bassB, this.ctx.currentTime, 0.025);
    const angle = this.crossfader * (Math.PI / 2);
    const gainA = Math.cos(angle);
    const gainB = Math.sin(angle);

    const now = this.ctx.currentTime;
    this.deckAGain.gain.setTargetAtTime(gainA, now, 0.015);
    this.deckBGain.gain.setTargetAtTime(gainB, now, 0.015);
  }

  // Set DJ Filter: 0.0 = LowPass (150Hz), 0.5 = Flat, 1.0 = HighPass (2500Hz Bass Kill)
  public setFilter(val: number, deck?: 'A' | 'B'): void {
    const filter = deck === 'A' ? this.deckAFilter : deck === 'B' ? this.deckBFilter : this.djFilter;
    for (const node of [this.deckAFilter, this.deckBFilter, this.djFilter]) {
      if (node !== filter) node.type = 'allpass';
    }
    this.filterCutoff = Math.max(0.0, Math.min(1.0, val));
    const now = this.ctx.currentTime;

    if (this.filterCutoff < 0.48) {
      // Low-pass sweep (removing highs and mids)
      filter.type = 'lowpass';
      const freq = 150 + Math.pow(this.filterCutoff / 0.48, 2.5) * 19850;
      filter.frequency.setTargetAtTime(Math.min(freq, this.ctx.sampleRate / 2), now, 0.02);
      filter.Q.setTargetAtTime(2.5, now, 0.02);
    } else if (this.filterCutoff > 0.52) {
      // High-pass sweep (classic DJ bass kill)
      filter.type = 'highpass';
      const norm = (this.filterCutoff - 0.52) / 0.48;
      const freq = 20 + Math.pow(norm, 2.0) * 3200;
      filter.frequency.setTargetAtTime(Math.min(freq, this.ctx.sampleRate / 2), now, 0.02);
      filter.Q.setTargetAtTime(2.0, now, 0.02);
    } else {
      // Flat / Neutral pass
      filter.type = 'allpass';
      filter.frequency.setTargetAtTime(Math.min(20000, this.ctx.sampleRate / 2), now, 0.02);
      filter.Q.setTargetAtTime(0.7, now, 0.02);
    }
  }

  // Trigger DJ Stutter / Loop Roll FX
  public setStutter(active: boolean): void {
    if (this.fxStutterActive === active) return;
    this.fxStutterActive = active;
    const now = this.ctx.currentTime;

    if (active) {
      // Catch loop in delay buffer
      const stutterTime = (60.0 / this.masterBpm) / 4.0; // 1/16th beat slice
      this.stutterDelay.delayTime.setValueAtTime(stutterTime, now);
      // Freeze the previous sixteenth; do not keep adding live input to the loop.
      this.stutterInputGain.gain.setValueAtTime(0, now);
      this.stutterFeedback.gain.setValueAtTime(1, now);
      this.stutterWetGain.gain.setTargetAtTime(1.0, now, 0.005);
      this.stutterDryGain.gain.setTargetAtTime(0.0, now, 0.005);
    } else {
      // Release loop - return to clean dry audio immediately
      this.stutterInputGain.gain.setValueAtTime(1, now);
      this.stutterFeedback.gain.setValueAtTime(0, now);
      this.stutterWetGain.gain.setTargetAtTime(0.0, now, 0.008);
      this.stutterDryGain.gain.setTargetAtTime(1.0, now, 0.005);
    }
  }

  // Load custom user audio file into Deck A or B (e.g. real Drake MP3)
  public async loadAudioFile(deck: 'A' | 'B', file: File): Promise<string> {
    const generation = ++this.loadGeneration[deck];
    const arrayBuffer = await file.arrayBuffer();
    const decodedBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    if (generation !== this.loadGeneration[deck]) throw new DOMException('Superseded track load', 'AbortError');
    this.imported[deck] = true;
    this.analyses[deck] = null;
    this.grids[deck] = null;

    if (deck === 'A') {
      this.bufferA = decodedBuffer;
      this.trackAName = file.name.replace(/\.[^/.]+$/, '');
    } else {
      this.bufferB = decodedBuffer;
      this.trackBName = file.name.replace(/\.[^/.]+$/, '');
    }

    if (this.isPlaying) {
      this.restartPlayback();
    }
    return deck === 'A' ? this.trackAName : this.trackBName;
  }

  // Summary: Loading replaces a deck only after decoding succeeds and it is still the latest request.
  // Clearing old metadata prevents the previous track's grid from being attached to new audio.
  // Unsupported codecs fail without replacing the deck, and later uploads or presets supersede pending loads.

  public getDeckBuffer(deck: 'A' | 'B'): AudioBuffer | null {
    return deck === 'A' ? this.bufferA : this.bufferB;
  }
  // Summary: This exposes the current decoded deck for a separate analysis audition.
  // Reusing the existing buffer avoids another decode and keeps preview timing tied to playback samples.
  // Callers must not mutate its channel data, and a deck may be unavailable before loading completes.

  public setDeckAnalysis(deck: 'A' | 'B', analysis: TrackAnalysis, grid = initialGrid(analysis)): void {
    const buffer = this.getDeckBuffer(deck);
    if (!this.imported[deck] || !buffer || !isTrackAnalysis(analysis)
      || Math.abs(buffer.duration - analysis.durationSeconds) > 0.1) throw new Error('Analysis does not match the decoded deck duration.');
    this.analyses[deck] = analysis;
    this.grids[deck] = (analysis.bpm !== null || grid.reviewed) && validateGrid(grid, buffer.duration) ? { ...grid } : null;
  }
  // Summary: This attaches validated metadata and an optional reviewed correction to a loaded deck.
  // Duration checking catches decoder disagreements while the upload generation guard in the UI protects track identity.
  // Small codec offsets can still differ between decoders; audition is necessary before trusting phase.

  public getDeckGrid(deck: 'A' | 'B'): BeatGrid | null {
    const grid = this.grids[deck];
    return grid ? { ...grid } : null;
  }
  // Summary: This returns the current constant-tempo interpretation without exposing mutable engine state.
  // Its reviewed flag distinguishes a human correction from an initial detector estimate.
  // A non-null grid does not mean the track has reliable downbeats or a constant tempo throughout.

  public hasImportedTracks(): boolean {
    return this.imported.A || this.imported.B;
  }
  // Summary: This tells consumers whether preset-only timing assumptions remain valid.
  // Any imported deck invalidates the authored pair's shared phrase grid until richer analysis exists.
  // It does not claim that imported tracks are incompatible; it only withholds unsupported phrase labels.

  public loadGenrePreset(preset: 'deep_tech_house' | 'acid_house' | 'french_touch' | 'melodic_afro' | 'rnb_house' | 'funk_disco' | 'afro_amapiano' | 'dnb_jungle'): { trackA: string; trackB: string } {
    this.loadGeneration.A++;
    this.loadGeneration.B++;
    this.imported = { A: false, B: false };
    this.analyses = { A: null, B: null };
    this.grids = { A: null, B: null };
    const sampleRate = this.ctx.sampleRate;

    if (preset === 'acid_house' || preset === 'dnb_jungle') {
      this.masterBpm = 126;
      this.trackAName = 'Neuro-DJ - Acid Garden (Deck A)';
      this.trackBName = 'Neuro-DJ - Warehouse Wings (Deck B)';
    } else if (preset === 'french_touch' || preset === 'funk_disco') {
      this.masterBpm = 124;
      this.trackAName = 'Neuro-DJ - Filter Boulevard (Deck A)';
      this.trackBName = 'Neuro-DJ - Midnight Disco (Deck B)';
    } else if (preset === 'melodic_afro' || preset === 'afro_amapiano') {
      this.masterBpm = 122;
      this.trackAName = 'Neuro-DJ - Sunset Circuit (Deck A)';
      this.trackBName = 'Neuro-DJ - Dusk Rhythm (Deck B)';
    } else {
      this.masterBpm = 125;
      this.trackAName = 'Neuro-DJ - Chicago Afterhours (Deck A)';
      this.trackBName = 'Neuro-DJ - Terrace Tools (Deck B)';
    }

    // Exact musical grid: 256 sixteenth-note steps (16 complete 4/4 bars)
    const spb = 60.0 / this.masterBpm;
    const totalSteps = 256;
    const exactDuration = totalSteps * (spb / 4.0);
    const numSamples = Math.floor(sampleRate * exactDuration);

    this.bufferA = this.ctx.createBuffer(2, numSamples, sampleRate);
    this.bufferB = this.ctx.createBuffer(2, numSamples, sampleRate);
    const AL = this.bufferA.getChannelData(0);
    const AR = this.bufferA.getChannelData(1);
    const BL = this.bufferB.getChannelData(0);
    const BR = this.bufferB.getChannelData(1);

    if (preset === 'acid_house' || preset === 'dnb_jungle') {
      const acidNotes = [65.41, 77.78, 87.31, 98.00, 110.0, 130.81, 98.00, 87.31];
      for (let s = 0; s < totalSteps; s++) {
        const start = Math.floor(s * (spb / 4.0) * sampleRate);
        if (s % 4 === 0) this.synthesize909Kick(AL, AR, start, sampleRate, 0.95);
        if (s % 4 === 2) this.synthesize909OpenHat(AL, AR, start, sampleRate, 0.6);
        if (s % 2 === 1) this.synthesizeHiHat(AL, AR, start, sampleRate, 0.05, 0.35);
        const note = acidNotes[s % 8];
        const sweepCutoff = (s % 4 === 0 || s % 8 === 7) ? 3600 : 1200;
        this.synthesizeAcid303(AL, AR, start, sampleRate, note, sweepCutoff, 0.16, 0.7);

        if (s % 4 === 0) this.synthesize909Kick(BL, BR, start, sampleRate, 0.98);
        if (s % 8 === 4) this.synthesize909Clap(BL, BR, start, sampleRate, 0.85);
        if (s % 4 === 2) this.synthesize909OpenHat(BL, BR, start, sampleRate, 0.55);
        if (s % 8 === 2 || s % 8 === 6) {
          this.synthesizeHousePianoChords(BL, BR, start, sampleRate, [261.63, 311.13, 392.00, 466.16], 0.22, 0.65);
        }
      }
    } else if (preset === 'french_touch' || preset === 'funk_disco') {
      for (let s = 0; s < totalSteps; s++) {
        const start = Math.floor(s * (spb / 4.0) * sampleRate);
        if (s % 4 === 0) this.synthesize909Kick(AL, AR, start, sampleRate, 0.95);
        if (s % 4 === 2) this.synthesize909OpenHat(AL, AR, start, sampleRate, 0.55);
        if (s % 8 === 4) this.synthesize909Clap(AL, AR, start, sampleRate, 0.75);
        if (s % 8 === 0 || s % 8 === 3 || s % 8 === 6) {
          this.synthesizeOrganBass(AL, AR, start, sampleRate, 73.42, 0.22, 0.75);
        }
        if (s % 4 === 2 || s % 8 === 7) {
          this.synthesizeHousePianoChords(AL, AR, start, sampleRate, [293.66, 349.23, 440.0, 523.25], 0.28, 0.6);
        }

        if (s % 4 === 0) this.synthesize909Kick(BL, BR, start, sampleRate, 0.9);
        if (s % 2 === 1) this.synthesizeHiHat(BL, BR, start, sampleRate, 0.06, 0.4);
        if (s % 8 === 4) this.synthesize909Clap(BL, BR, start, sampleRate, 0.8);
        if (s % 8 === 2 || s % 8 === 6) {
          this.synthesizeHousePianoChords(BL, BR, start, sampleRate, [349.23, 440.0, 523.25, 659.25], 0.24, 0.55);
        }
      }
    } else if (preset === 'melodic_afro' || preset === 'afro_amapiano') {
      for (let s = 0; s < totalSteps; s++) {
        const start = Math.floor(s * (spb / 4.0) * sampleRate);
        if (s % 4 === 0) this.synthesize909Kick(AL, AR, start, sampleRate, 0.9);
        if (s % 4 === 2) this.synthesize909OpenHat(AL, AR, start, sampleRate, 0.45);
        if (s % 16 === 4 || s % 16 === 12) this.synthesize909Clap(AL, AR, start, sampleRate, 0.7);
        if (s % 16 === 3 || s % 16 === 7 || s % 16 === 10 || s % 16 === 14) {
          this.synthesizeHiHat(AL, AR, start, sampleRate, 0.08, 0.45);
        }
        if (s % 16 === 2 || s % 16 === 10) {
          this.synthesizeHousePianoChords(AL, AR, start, sampleRate, [220.0, 261.63, 329.63, 392.00], 0.45, 0.5);
        }

        if (s % 4 === 0) this.synthesize909Kick(BL, BR, start, sampleRate, 0.92);
        if (s % 4 === 2) this.synthesize909OpenHat(BL, BR, start, sampleRate, 0.5);
        if (s % 16 === 2 || s % 16 === 6 || s % 16 === 11) {
          this.synthesizeOrganBass(BL, BR, start, sampleRate, 55.0, 0.28, 0.8);
        }
        if (s % 16 === 6 || s % 16 === 14) {
          this.synthesizeHousePianoChords(BL, BR, start, sampleRate, [174.61, 220.0, 261.63, 329.63], 0.5, 0.5);
        }
      }
    } else {
      // 125 BPM - The Ultimate Deep House vs Tech House (DEFAULT!)
      const bassNotes = [43.65, 87.31, 87.31, 51.91, 58.27, 65.41, 58.27, 77.78];

      for (let s = 0; s < totalSteps; s++) {
        const start = Math.floor(s * (spb / 4.0) * sampleRate);

        // --- DECK A: Deep Chicago House Groove ---
        if (s % 4 === 0) this.synthesize909Kick(AL, AR, start, sampleRate, 0.95);
        if (s % 4 === 2) this.synthesize909OpenHat(AL, AR, start, sampleRate, 0.6);
        if (s % 2 === 1) this.synthesizeHiHat(AL, AR, start, sampleRate, 0.05, 0.35);
        if (s % 8 === 4) this.synthesize909Clap(AL, AR, start, sampleRate, 0.8);
        const bassFreq = bassNotes[(s % 16) >> 1];
        if (s % 16 === 0 || s % 16 === 2 || s % 16 === 3 || s % 16 === 6 || s % 16 === 8 || s % 16 === 10 || s % 16 === 11 || s % 16 === 14) {
          this.synthesizeOrganBass(AL, AR, start, sampleRate, bassFreq, 0.18, 0.85);
        }
        if (s % 8 === 2 || s % 8 === 6) {
          const chord = s % 64 < 32
            ? [174.61, 207.65, 261.63, 311.13, 392.00] // Fm9
            : [233.08, 277.18, 349.23, 415.30, 466.16]; // Bbm9
          this.synthesizeHousePianoChords(AL, AR, start, sampleRate, chord, 0.25, 0.55);
        }

        // --- DECK B: Chris Lake & Fisher Tech House Groove ---
        if (s % 4 === 0) this.synthesize909Kick(BL, BR, start, sampleRate, 0.98);
        if (s % 4 === 2) this.synthesize909OpenHat(BL, BR, start, sampleRate, 0.55);
        // Synchronized on-beat claps on 2 and 4 (matching Deck A with zero flam/echo!)
        if (s % 8 === 4) this.synthesize909Clap(BL, BR, start, sampleRate, 0.78);
        if (s % 4 !== 0) {
          const subFreq = (s % 8 === 1 || s % 8 === 2) ? 43.65 : 65.41;
          this.synthesizeOrganBass(BL, BR, start, sampleRate, subFreq, 0.13, 0.9);
        }
        if (s % 16 === 2 || s % 16 === 10) {
          this.synthesizeHousePianoChords(BL, BR, start, sampleRate, [174.61, 207.65, 261.63, 349.23], 0.2, 0.6);
        }
      }
    }

    // Small phrase-end fills give the loop punctuation without covering the kick.
    for (let step = 124; step < totalSteps; step += 128) {
      for (let fill = 0; fill < 4; fill++) {
        const start = Math.floor((step + fill) * spb / 4 * sampleRate);
        this.synthesizeHiHat(AL, AR, start, sampleRate, 0.04, 0.12 + fill * 0.035);
        this.synthesize909Clap(BL, BR, start, sampleRate, 0.08 + fill * 0.025);
      }
    }
    this.finalizeBuffer(this.bufferA);
    this.finalizeBuffer(this.bufferB);

    this.stutterDelay.delayTime.setValueAtTime(60 / this.masterBpm / 4, this.ctx.currentTime);
    if (this.isPlaying) this.restartPlayback();
    return { trackA: this.trackAName, trackB: this.trackBName };
  }

  // Summary: A preset replaces both decks with a tempo-aligned synthesized pair.
  // It invalidates pending imports and their analysis so an old upload cannot overwrite a newly selected preset.
  // Its known phrase clock describes authored loops, not detected structure in arbitrary recordings.

  // Default high-quality procedural stems
  private initDefaultStems(): void {
    this.loadGenrePreset('deep_tech_house');
  }

  // Tape-style soft limiter & normalizer to guarantee zero clipping
  private finalizeBuffer(buffer: AudioBuffer): void {
    const L = buffer.getChannelData(0);
    const R = buffer.getChannelData(1);
    let maxPeak = 0.001;
    for (let i = 0; i < L.length; i++) {
      const p = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (p > maxPeak) maxPeak = p;
    }
    const normGain = 0.85 / Math.max(0.85, maxPeak);
    for (let i = 0; i < L.length; i++) {
      L[i] = Math.tanh(L[i] * normGain);
      R[i] = Math.tanh(R[i] * normGain);
    }
  }

  // Crisp High-Pass Filtered Hi-Hat Sizzle
  private synthesizeHiHat(L: Float32Array, R: Float32Array, start: number, sr: number, dur: number, gain: number): void {
    const len = Math.floor(dur * sr);
    let lastNoise = 0;
    for (let i = 0; i < len && start + i < L.length; i++) {
      const t = i / sr;
      const white = this.random() * 2 - 1;
      const highPassed = white - lastNoise * 0.75;
      lastNoise = white;
      const env = Math.exp(-t * 50);
      const sample = highPassed * env * gain * 0.65;
      L[start + i] += sample;
      R[start + i] += sample * 0.85;
    }
  }

  // Authentic Roland TR-909 Punchy 4-on-the-Floor Kick Drum
  private synthesize909Kick(L: Float32Array, R: Float32Array, start: number, sr: number, gain: number = 0.95): void {
    const dur = 0.28;
    const len = Math.floor(dur * sr);
    let phase = 0;
    for (let i = 0; i < len && start + i < L.length; i++) {
      const t = i / sr;
      // 909 pitch envelope: fast drop from 220Hz down to 50Hz sub body
      const freq = 48 + 172 * Math.exp(-t * 34);
      phase += (2 * Math.PI * freq) / sr;
      let s = Math.sin(phase) + 0.16 * Math.sin(2 * phase);
      // Snappy beater transient click
      if (t < 0.005) s += (1.0 - t / 0.005) * 0.45;
      const env = Math.exp(-t * 11.0);
      const sample = Math.tanh(s * 1.35) * env * gain;
      L[start + i] += sample;
      R[start + i] += sample;
    }
  }

  // Classic Roland TR-909 Open Hi-Hat with 6-Oscillator Metallic Cluster
  private synthesize909OpenHat(L: Float32Array, R: Float32Array, start: number, sr: number, gain: number = 0.55): void {
    const dur = 0.24;
    const len = Math.floor(dur * sr);
    const f = [263, 400, 421, 474, 587, 845];
    let lastNoise = 0;
    for (let i = 0; i < len && start + i < L.length; i++) {
      const t = i / sr;
      let metal = 0;
      for (let k = 0; k < 6; k++) {
        metal += (Math.sin(2 * Math.PI * f[k] * t) > 0 ? 0.5 : -0.5);
      }
      const white = (this.random() * 2 - 1) * 0.45;
      const mixed = (metal / 6) * 0.6 + white;
      // High-pass filter above 7kHz
      const hp = mixed - lastNoise * 0.82;
      lastNoise = mixed;
      // Open hat envelope: snappy attack and smooth natural decay (~200ms)
      const env = (1.0 - Math.exp(-t * 220)) * Math.exp(-t * 12.5);
      const sample = hp * env * gain;
      L[start + i] += sample * 0.95;
      R[start + i] += sample * 1.05;
    }
  }

  // Authentic Roland TR-909 Handclap with Triple Micro-Flams
  private synthesize909Clap(L: Float32Array, R: Float32Array, start: number, sr: number, gain: number = 0.75): void {
    const dur = 0.22;
    const len = Math.floor(dur * sr);
    const w0 = (2 * Math.PI * 1150) / sr;
    const alpha = Math.sin(w0) / (2 * 1.5);
    const b0 = alpha, b1 = 0, b2 = -alpha;
    const a0 = 1 + alpha, a1 = -2 * Math.cos(w0), a2 = 1 - alpha;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;

    for (let i = 0; i < len && start + i < L.length; i++) {
      const t = i / sr;
      const raw = this.random() * 2 - 1;
      const bp = (b0 * raw + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1; x1 = raw;
      y2 = y1; y1 = bp;

      // 3 signature pre-flams (10ms apart) before main reverb burst
      let env = 0;
      if (t < 0.010) env = Math.exp(-t * 120);
      else if (t < 0.020) env = Math.exp(-(t - 0.010) * 120);
      else if (t < 0.030) env = Math.exp(-(t - 0.020) * 120);
      else env = Math.exp(-(t - 0.030) * 22);

      const sample = Math.tanh(bp * 2.2 * env) * gain;
      L[start + i] += sample;
      R[start + i] += sample * 0.92;
    }
  }

  // Classic Korg M1 Organ 2 / FM Donk Bass
  private synthesizeOrganBass(L: Float32Array, R: Float32Array, start: number, sr: number, freq: number, dur: number, gain: number = 0.8): void {
    const len = Math.floor(dur * sr);
    let phase = 0;
    let modPhase = 0;
    for (let i = 0; i < len && start + i < L.length; i++) {
      const t = i / sr;
      const modEnv = Math.exp(-t * 32);
      const modIndex = 2.5 * modEnv;
      modPhase += (2 * Math.PI * (freq * 2)) / sr;
      const mod = Math.sin(modPhase) * modIndex;
      phase += (2 * Math.PI * freq) / sr;
      const s = Math.sin(phase + mod) + 0.42 * Math.sin(2 * phase + mod * 0.5) + 0.16 * Math.sin(3 * phase);
      const env = Math.exp(-t * (4.2 / dur));
      const sample = Math.tanh(s * 1.25) * env * gain;
      L[start + i] += sample;
      R[start + i] += sample;
    }
  }

  // Resonant Roland TB-303 Acid Squelch
  private synthesizeAcid303(L: Float32Array, R: Float32Array, start: number, sr: number, freq: number, cutoffStart: number, dur: number, gain: number = 0.7): void {
    const len = Math.floor(dur * sr);
    let phase = 0;
    let y1 = 0, y2 = 0;
    for (let i = 0; i < len && start + i < L.length; i++) {
      const t = i / sr;
      phase += (2 * Math.PI * freq) / sr;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      const saw = (phase / Math.PI) - 1.0;
      const cutoff = 200 + cutoffStart * Math.exp(-t * 15);
      const rc = 1.0 / (2 * Math.PI * Math.min(sr * 0.45, cutoff));
      const dt = 1.0 / sr;
      const a = dt / (rc + dt);
      const res = 1.65;
      y1 += a * (saw - y1 - res * y2);
      y2 += a * (y1 - y2);
      const env = Math.exp(-t * (3.0 / dur));
      const sample = Math.tanh(y2 * 1.9) * env * gain;
      L[start + i] += sample;
      R[start + i] += sample;
    }
  }

  // Lush House Minor 9th Piano Stabs with Stereo Spread
  private synthesizeHousePianoChords(L: Float32Array, R: Float32Array, start: number, sr: number, freqs: number[], dur: number, gain: number = 0.5): void {
    const len = Math.floor(dur * sr);
    for (let i = 0; i < len && start + i < L.length; i++) {
      const t = i / sr;
      let sumL = 0, sumR = 0;
      for (let k = 0; k < freqs.length; k++) {
        const f = freqs[k];
        const phase = 2 * Math.PI * f * t;
        const strike = Math.sin(phase) + 0.35 * Math.sin(phase * 2) + 0.2 * Math.sin(phase * 3) + 0.08 * Math.sin(phase * 4);
        const pan = (k / Math.max(1, freqs.length - 1)) * 0.4 - 0.2;
        sumL += strike * (1 - pan);
        sumR += strike * (1 + pan);
      }
      const env = Math.min(1.0, t / 0.004) * Math.exp(-t * (3.8 / dur));
      const sL = Math.tanh((sumL / freqs.length) * env * 1.4) * gain;
      const sR = Math.tanh((sumR / freqs.length) * env * 1.4) * gain;
      L[start + i] += sL;
      R[start + i] += sR;
    }
  }

  public playbackStartTime: number = 0;

  public start(): void {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.playbackStartTime = this.ctx.currentTime;
    this.playDeckBuffers();
  }

  public stop(): void {
    this.isPlaying = false;
    this.stopDeckBuffers();
    this.setStutter(false);
  }

  public toggle(): boolean {
    if (this.isPlaying) {
      this.stop();
    } else {
      this.start();
    }
    return this.isPlaying;
  }

  // DJ Fundamental: Real-time phrase, bar, and downbeat tracker
  public getPlaybackTiming(): MusicalTiming {
    const elapsed = this.isPlaying ? Math.max(0, this.ctx.currentTime - this.playbackStartTime) : 0;
    if (!this.hasImportedTracks()) return musicalTiming(elapsed, this.masterBpm);
    const grid = this.grids.A;
    const position = this.bufferA ? elapsed % this.bufferA.duration : elapsed;
    const timing = musicalTiming(grid ? Math.max(0, position - grid.offsetSeconds) : elapsed, grid?.bpm ?? this.masterBpm);
    // A beat grid is NOT a bar/phrase annotation. Never reward an invented drop
    // or run the preset musical director against unannotated imported material.
    return { ...timing, beat: 0, bar: 0, phraseStep: 0, hasPhraseGrid: false,
      isDownbeat: false, isPhraseDrop: false, isBuildup: false };
  }

  // Summary: This supplies authored phrase timing only while the original preset pair is active.
  // Imported Deck A metadata can supply a beat clock, but all bar/drop flags remain explicitly unavailable.
  // Beat grids do not align or stretch the audio; independent tracks can still drift against each other.

  private playDeckBuffers(): void {
    this.stopDeckBuffers();
    if (!this.bufferA || !this.bufferB) return;

    this.sourceA = this.ctx.createBufferSource();
    this.sourceA.buffer = this.bufferA;
    this.sourceA.loop = true;
    this.sourceA.connect(this.deckAGain);
    const startAt = this.ctx.currentTime + 0.03;
    this.playbackStartTime = startAt;
    this.sourceA.start(startAt);

    this.sourceB = this.ctx.createBufferSource();
    this.sourceB.buffer = this.bufferB;
    this.sourceB.loop = true;
    this.sourceB.connect(this.deckBGain);
    this.sourceB.start(startAt);
  }

  private stopDeckBuffers(): void {
    if (this.sourceA) {
      try { this.sourceA.stop(); this.sourceA.disconnect(); } catch { /* ignore */ }
      this.sourceA = null;
    }
    if (this.sourceB) {
      try { this.sourceB.stop(); this.sourceB.disconnect(); } catch { /* ignore */ }
      this.sourceB = null;
    }
  }

  private restartPlayback(): void {
    if (this.isPlaying) {
      this.setStutter(false);
      this.playDeckBuffers();
    }
  }

  // Measure actual RMS energy from the mixed audio stream
  public updateAcoustics(): { currentRMS: number; deltaRMS: number } {
    this.rmsAnalyser.getFloatTimeDomainData(this.rmsSampleBuffer);
    let sumSquares = 0;
    for (let i = 0; i < this.rmsSampleBuffer.length; i++) {
      sumSquares += this.rmsSampleBuffer[i] * this.rmsSampleBuffer[i];
    }
    this.prevRMS = this.lastRMS;
    // Follow musical loudness, not individual zero crossings or kick decay.
    const dt = Math.max(0, this.ctx.currentTime - this.rmsTime);
    this.rmsTime = this.ctx.currentTime;
    this.rmsPower += (sumSquares / this.rmsSampleBuffer.length - this.rmsPower) * (1 - Math.exp(-dt / 0.2));
    this.lastRMS = Math.sqrt(Math.max(0, this.rmsPower));
    const instantRMS = Math.sqrt(sumSquares / this.rmsSampleBuffer.length);
    const deltaRMS = Math.max(0, this.previousInstantRMS - instantRMS);
    this.previousInstantRMS = instantRMS;

    return { currentRMS: this.lastRMS, deltaRMS };
  }

  public getTrackNames(): { trackA: string; trackB: string } {
    return { trackA: this.trackAName, trackB: this.trackBName };
  }
}

// Module summary: The mixer plays two decoded decks and routes their audio through neural controls and effects.
// Imported metadata now travels with each deck, while authored phrase timing is restricted to known presets.
// Analysis and reviewed grids do not supply source separation, time stretching, or automatically aligned imported tracks.
