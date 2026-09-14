import { MusicalDirector } from './MusicalDirector';
import type { MusicalTiming } from '../audio/MusicalTiming';
import { DescendingOutputLayer, type DJControlSignals } from './DescendingOutputLayer';
import { DJRewardEngine, type RewardBreakdown, type RewardWeights } from './DJRewardEngine';

export interface PassTelemetry {
  passNumber: number;
  cumulativeReward: number;
  avgSynchrony: number;
  avgWeight: number;
}

export interface CircuitTelemetry {
  stage: 'naive' | 'training' | 'master';
  activeKCs: number;
  sparsityPercent: number;
  dopamine: number;
  rewardBreakdown: RewardBreakdown;
  rewardHistory: number[];
  cumulativeRewardCurrentPass: number;
  passHistory: PassTelemetry[];
  crossfaderTrajectory: number[]; // Last ~100 ticks of crossfader position
  controls: DJControlSignals;
  avgSynapticWeight: number;
  totalPlasticityEvents: number;
  currentPass: number;
  passProgress: number; // 0 to 1
}

export class FlyWireCircuit {
  // Upstream Fixed Connectome Architecture
  public readonly numPN: number = 8;  // 4 instant audio bands + 4 delayed sensory memory channels
  public readonly numKC: number = 64; // 64 Kenyon Cells
  public readonly numDN: number = 3;  // 3 Descending Neurons: 0=Crossfader, 1=Filter, 2=Stutter FX

  // Upstream Synapses (FIXED/RANDOM - strictly non-plastic, matching fly calyx anatomy)
  public W_pn_kc: Float32Array;

  // The ONLY Plastic Synaptic Layer: KC -> Descending Neurons
  public W_kc_dn: Float32Array; // [64 * 3]
  private eligibility: Float32Array; // [64 * 3]

  // Neural Activations
  public r_kc: Float32Array;
  private rawDN: Float32Array;

  // Output Layer & Reward Engine Subsystems
  public outputLayer: DescendingOutputLayer;
  public rewardEngine: DJRewardEngine;

  // Sensory Delay-Line Buffer (AMMC / Central Complex temporal memory)
  private historyBuffer: Float32Array[] = [];
  private readonly maxHistorySteps: number = 6;

  // 3-Factor Plasticity Hyperparameters
  public learningRate: number = 0.04;
  public learningEnabled: boolean = true;
  public sparsityK: number = 4; // 4/64 = 6.25% APL sparse population coding
  public guidedSet = true;
  private director = new MusicalDirector();
  private random: () => number;
  private postMean = new Float32Array(3);
  private rewardMean = 0;
  private transitioningSeconds = 0;
  private onBeatSeconds = 0;
  private lastControls: DJControlSignals | null = null;
  private lastTiming: MusicalTiming | undefined;
  private traceDecay: number = 0.85;
  private weightDecay: number = 0.0003;
  private baselineWeight: number = 0.20;

  // Telemetry across repeated passes
  public rewardHistory: number[] = [];
  public crossfaderHistory: number[] = [];
  public passHistory: PassTelemetry[] = [];
  public cumulativeRewardCurrentPass: number = 0;
  public currentPass: number = 1;
  public passTicks: number = 0;
  public readonly ticksPerPass: number = 400; // ~16-20 seconds per pass
  public totalPlasticityEvents: number = 0;
  public stage: 'naive' | 'training' | 'master' = 'naive';

  public get avgSynapticWeight(): number {
    let sum = 0;
    for (let i = 0; i < this.W_kc_dn.length; i++) sum += this.W_kc_dn[i];
    return sum / this.W_kc_dn.length;
  }

  // Last breakdown
  private lastBreakdown: RewardBreakdown = {
    totalReward: 0,
    beatTransitionBonus: 0,
    rmsStabilityBonus: 0,
    trainwreckPenalty: 0,
    discontinuityPenalty: 0,
    phraseBonus: 0,
    bassSwapBonus: 0,
    tensionBonus: 0
  };

  constructor(customRewardWeights?: Partial<RewardWeights>, random: () => number = Math.random) {
    this.random = random;
    this.W_pn_kc = new Float32Array(this.numKC * this.numPN);
    this.W_kc_dn = new Float32Array(this.numKC * this.numDN);
    this.eligibility = new Float32Array(this.numKC * this.numDN);
    this.r_kc = new Float32Array(this.numKC);
    this.rawDN = new Float32Array(this.numDN);

    this.outputLayer = new DescendingOutputLayer();
    this.rewardEngine = new DJRewardEngine(customRewardWeights);

    this.initUpstreamWiring();
    this.resetWeights();
  }

  // 1. Upstream Fixed Claw Wiring: Never modified by learning
  private initUpstreamWiring(): void {
    for (let k = 0; k < this.numKC; k++) {
      for (let p = 0; p < this.numPN; p++) {
        this.W_pn_kc[k * this.numPN + p] = 0;
      }
      const numClaws = 2 + (k % 2);
      for (let c = 0; c < numClaws; c++) {
        const pnIdx = (k * 5 + c * 3) % this.numPN;
        this.W_pn_kc[k * this.numPN + pnIdx] = 0.8 + this.random() * 0.4;
      }
    }
  }

  // Reset KC -> DN plastic weights to naive untrained baseline
  public resetWeights(): void {
    this.stage = 'naive';
    this.currentPass = 1;
    this.passTicks = 0;
    this.cumulativeRewardCurrentPass = 0;
    this.passHistory = [];
    this.rewardHistory = [];
    this.crossfaderHistory = [];
    this.totalPlasticityEvents = 0;
    this.resetPerformance();
    this.rewardEngine.reset();

    for (let k = 0; k < this.numKC; k++) {
      // DN 0 (Crossfader): Starts at near-zero with random exploratory noise
      this.W_kc_dn[k * this.numDN + 0] = this.baselineWeight + (this.random() - 0.5) * 0.1;
      // DN 1 (Filter): Starts at neutral 0.5 baseline
      this.W_kc_dn[k * this.numDN + 1] = 0.45 + (this.random() - 0.5) * 0.1;
      // DN 2 (Stutter FX): Low baseline
      this.W_kc_dn[k * this.numDN + 2] = 0.05 + this.random() * 0.05;

      this.eligibility[k * this.numDN + 0] = 0;
      this.eligibility[k * this.numDN + 1] = 0;
      this.eligibility[k * this.numDN + 2] = 0;
    }
  }

  // Handcrafted starting weights, not an empirically trained checkpoint
  public loadExpertWeights(): void {
    this.resetPerformance();
    this.stage = 'master';
    for (let k = 0; k < this.numKC; k++) {
      const connectsToBass = this.W_pn_kc[k * this.numPN + 0] > 0.5 || this.W_pn_kc[k * this.numPN + 4] > 0.5;
      const connectsToTension = this.W_pn_kc[k * this.numPN + 2] > 0.5 || this.W_pn_kc[k * this.numPN + 6] > 0.5;
      const isDropKC = (k % 4 === 0);

      if (isDropKC) {
        // Fundamental 1: Smooth phrase-aligned crossfade transition on the drop
        this.W_kc_dn[k * this.numDN + 0] = 0.85 + (k % 2) * 0.12;
        this.W_kc_dn[k * this.numDN + 1] = 0.49; // Flat neutral filter on drop
        this.W_kc_dn[k * this.numDN + 2] = 0.01; // Cut stutter roll
      } else if (connectsToTension) {
        // Fundamental 3: Tension Buildup (HPF Bass Cut & 1/16th Stutter Roll)
        this.W_kc_dn[k * this.numDN + 0] = 0.50; // Mid-blend
        this.W_kc_dn[k * this.numDN + 1] = 0.84; // High-pass filter sweep!
        this.W_kc_dn[k * this.numDN + 2] = 0.76; // Rhythmic loop roll!
      } else if (connectsToBass) {
        // Fundamental 2: The Bass Swap (Carve low frequencies during blend)
        this.W_kc_dn[k * this.numDN + 0] = 0.35 + (k % 3) * 0.15;
        this.W_kc_dn[k * this.numDN + 1] = 0.68; // HPF Bass Carve to avoid kick clash!
        this.W_kc_dn[k * this.numDN + 2] = 0.02;
      } else {
        this.W_kc_dn[k * this.numDN + 0] = 0.18;
        this.W_kc_dn[k * this.numDN + 1] = 0.50;
        this.W_kc_dn[k * this.numDN + 2] = 0.02;
      }
    }
  }

  // Main simulation tick: Connectome computation + Consequential controls + Dopamine + Plasticity
  public step(
    sensoryInputs: number[],
    audioOnset: number,
    isBeat: boolean,
    currentRMS: number,
    deltaRMS: number,
    dt: number,
    isStandby: boolean = false,
    manualControl?: { crossfader?: number; filter?: number },
    timing?: MusicalTiming
  ): CircuitTelemetry {
    // -------------------------------------------------------------
    // Step 0: Maintain Delay-Line Memory (Temporal Context)
    // -------------------------------------------------------------
    const current4 = new Float32Array(sensoryInputs);
    this.historyBuffer.unshift(current4);
    if (this.historyBuffer.length > this.maxHistorySteps) {
      this.historyBuffer.pop();
    }
    const delayed4 = this.historyBuffer[this.historyBuffer.length - 1] || current4;

    const fullSensory = new Float32Array(this.numPN);
    for (let i = 0; i < 4; i++) {
      fullSensory[i] = current4[i];
      fullSensory[i + 4] = delayed4[i];
    }

    // -------------------------------------------------------------
    // Step 1: Fixed Sensory Projection -> 64 Kenyon Cells
    // -------------------------------------------------------------
    const rawKC = new Float32Array(this.numKC);
    for (let k = 0; k < this.numKC; k++) {
      let excitation = 0;
      for (let p = 0; p < this.numPN; p++) {
        excitation += fullSensory[p] * this.W_pn_kc[k * this.numPN + p];
      }
      rawKC[k] = excitation;
    }

    // -------------------------------------------------------------
    // Step 2: APL Feedback Normalization (Strict ~6.25% Sparsity)
    // -------------------------------------------------------------
    const indexed = Array.from(rawKC).map((val, idx) => ({ val, idx }));
    indexed.sort((a, b) => b.val - a.val);

    this.r_kc.fill(0);
    let activeKCs = 0;
    const effectiveK = Math.max(1, Math.min(16, this.sparsityK));

    for (let i = 0; i < effectiveK; i++) {
      const top = indexed[i];
      if (top.val > 0.05) {
        this.r_kc[top.idx] = Math.min(1.5, top.val);
        activeKCs++;
      }
    }

    // -------------------------------------------------------------
    // Step 3: Kenyon Cells -> Descending Neurons Integration
    // -------------------------------------------------------------
    for (let d = 0; d < this.numDN; d++) {
      let sum = 0;
      for (let k = 0; k < this.numKC; k++) {
        sum += this.r_kc[k] * this.W_kc_dn[k * this.numDN + d];
      }

      // Exploration noise in naive stage to discover DJ actions
      if (this.stage === 'naive' && this.learningEnabled && !isStandby) {
        sum += (this.random() - 0.5) * 0.12;
      }

      // Transfer to firing rate [0, 1]
      this.rawDN[d] = 1.0 / (1.0 + Math.exp(-6.0 * (sum - 0.40)));
    }

    // -------------------------------------------------------------
    // Step 4: Map Firing Rates to Smoothed Consequential Controls
    // -------------------------------------------------------------
    let controls = this.outputLayer.update(this.rawDN, dt);
    if (this.guidedSet && timing) controls = this.director.update(controls, timing);

    // Teacher Forcing: User manual demonstration overrides motor readout
    if (manualControl?.crossfader !== undefined) {
      controls.crossfader = manualControl.crossfader;
      this.rawDN[0] = manualControl.crossfader;
    }
    if (manualControl?.filter !== undefined) {
      controls.filterCutoff = manualControl.filter;
      this.rawDN[1] = manualControl.filter;
    }

    if (!isStandby && this.lastControls && Math.abs(controls.crossfader - this.lastControls.crossfader) / Math.max(dt, 0.001) > 0.08) {
      this.transitioningSeconds += dt;
      if (isBeat || audioOnset > 0.45) this.onBeatSeconds += dt;
    }

    // Track crossfader position trajectory
    this.crossfaderHistory.push(controls.crossfader);
    if (this.crossfaderHistory.length > 120) this.crossfaderHistory.shift();

    // -------------------------------------------------------------
    // Step 5: Compute 4-Factor Scalar Dopamine Reward R(t)
    // -------------------------------------------------------------
    let dopamine = 0;
    if (!isStandby) {
      // The analyser contains the consequences of the PREVIOUS applied action.
      const heardControls = this.lastControls ?? controls;
      this.lastBreakdown = this.rewardEngine.computeReward(
        heardControls.crossfader,
        heardControls.filterCutoff,
        heardControls.stutterTrigger,
        audioOnset,
        isBeat,
        currentRMS,
        deltaRMS,
        dt,
        false,
        this.lastTiming
      );
      dopamine = this.lastBreakdown.totalReward;

      // Track reward
      this.rewardHistory.push(dopamine);
      if (this.rewardHistory.length > 80) this.rewardHistory.shift();
      this.cumulativeRewardCurrentPass += dopamine * dt;

      // -------------------------------------------------------------
      // Step 6: 3-Factor Plasticity Rule on W_KC_DN (Pre * Post * Dopamine)
      // -------------------------------------------------------------
      if (this.learningEnabled) {
        this.applyPlasticity(dopamine - this.rewardMean, dt);
        this.rewardMean += (dopamine - this.rewardMean) * (1 - Math.exp(-dt / 4));
      }

      // -------------------------------------------------------------
      // Step 7: Pass Management & Long-term Telemetry
      // -------------------------------------------------------------
      this.passTicks += dt / 0.04;
      if (this.passTicks >= this.ticksPerPass) {
        this.finalizePass();
      }
    } else {
      this.lastBreakdown = {
        totalReward: 0,
        beatTransitionBonus: 0,
        rmsStabilityBonus: 0,
        trainwreckPenalty: 0,
        discontinuityPenalty: 0,
        phraseBonus: 0,
        bassSwapBonus: 0,
        tensionBonus: 0
      };
    }

    if (!isStandby) {
      this.lastControls = { ...controls };
      this.lastTiming = timing;
    }
    // Compute average synaptic weight
    let weightSum = 0;
    for (let i = 0; i < this.W_kc_dn.length; i++) {
      weightSum += this.W_kc_dn[i];
    }
    const avgSynapticWeight = weightSum / this.W_kc_dn.length;

    return {
      stage: this.stage,
      activeKCs,
      sparsityPercent: (activeKCs / this.numKC) * 100,
      dopamine,
      rewardBreakdown: this.lastBreakdown,
      rewardHistory: this.rewardHistory,
      cumulativeRewardCurrentPass: Math.round(this.cumulativeRewardCurrentPass * 10) / 10,
      passHistory: this.passHistory,
      crossfaderTrajectory: this.crossfaderHistory,
      controls,
      avgSynapticWeight,
      totalPlasticityEvents: this.totalPlasticityEvents,
      currentPass: this.currentPass,
      passProgress: this.passTicks / this.ticksPerPass
    };
  }

  // Reward modulates the preceding eligibility trace. Centering postsynaptic
  // activity allows rewarding both increases AND decreases in a motor command.
  private applyPlasticity(dopamineSignal: number, dt: number = 0.04, traceOnly = false): void {
    const decay = Math.pow(this.traceDecay, dt / 0.04);
    for (let k = 0; k < this.numKC; k++) {
      for (let d = 0; d < this.numDN; d++) {
        const idx = k * this.numDN + d;
        if (!traceOnly && Math.abs(dopamineSignal * this.eligibility[idx]) > 0.00001) {
          const delta = this.learningRate * this.eligibility[idx] * dopamineSignal * dt;
          const homeostatic = this.weightDecay * (this.W_kc_dn[idx] - this.baselineWeight) * dt;
          this.W_kc_dn[idx] = Math.max(0.01, Math.min(1.6, this.W_kc_dn[idx] + delta - homeostatic));
          this.totalPlasticityEvents++;
        }
        this.eligibility[idx] = this.eligibility[idx] * decay
          + this.r_kc[k] * (this.rawDN[d] - this.postMean[d]) * (1 - decay);
      }
    }
    for (let d = 0; d < this.numDN; d++) {
      this.postMean[d] += (this.rawDN[d] - this.postMean[d]) * (1 - Math.exp(-dt / 2));
    }
  }

  public resetPerformance(): void {
    this.outputLayer.reset();
    this.director.reset();
    this.rewardEngine.reset();
    this.historyBuffer = [];
    this.eligibility.fill(0);
    this.postMean.fill(0);
    this.rewardMean = 0;
    this.transitioningSeconds = 0;
    this.onBeatSeconds = 0;
    this.lastControls = null;
    this.lastTiming = undefined;
  }

  /** Optional supervised warm start, separate from biological dopamine plasticity. */
  public imitateMotorTargets(targets: readonly number[], rate = 0.02): void {
    if (targets.length !== 3 || targets.some(v => !Number.isFinite(v) || v < 0 || v > 1)
      || !Number.isFinite(rate) || rate <= 0 || rate > 0.1) throw new Error('Invalid imitation target or rate');
    // Only a frozen, unassisted replay may use the teacher: mixing imitation with
    // the reward update would make it impossible to attribute any improvement.
    if (this.learningEnabled || this.guidedSet) throw new Error('Imitation requires frozen, unassisted replay');
    for (let d = 0; d < this.numDN; d++) {
      const prediction = this.rawDN[d];
      // Chain rule through the existing slope-6 sigmoid. This minimizes squared
      // command error; it is not an eligibility-times-dopamine learning rule.
      const gradient = (prediction - targets[d]) * 6 * prediction * (1 - prediction);
      for (let k = 0; k < this.numKC; k++) {
        const index = k * this.numDN + d;
        this.W_kc_dn[index] = Math.max(0.01, Math.min(1.6,
          this.W_kc_dn[index] - rate * gradient * this.r_kc[k]));
      }
    }
  }
  // Summary: This teaches the current sensory pattern to predict demonstrated motor commands.
  // It adjusts only the existing KC→DN readout, preserving fixed projections and sparse activity.
  // Positive bounded weights and limited sensory context can prevent fitting a demonstration.
  // Call after a replay step; this optional supervised mode does not establish biological learning.

  // Conclude track pass and store trajectory summary
  private finalizePass(): void {
    let weightSum = 0;
    for (let i = 0; i < this.W_kc_dn.length; i++) weightSum += this.W_kc_dn[i];
    const avgWeight = weightSum / this.W_kc_dn.length;

    this.passHistory.push({
      passNumber: this.currentPass,
      cumulativeReward: Math.round(this.cumulativeRewardCurrentPass * 10) / 10,
      avgSynchrony: this.transitioningSeconds > 0 ? Math.round(100 * this.onBeatSeconds / this.transitioningSeconds) : 0,
      avgWeight: Math.round(avgWeight * 100) / 100
    });

    if (this.passHistory.length > 20) this.passHistory.shift();

    // Check if learning stage should advance
    if (this.currentPass >= 2 && this.stage !== 'master') {
      this.stage = 'training';
    }

    this.transitioningSeconds = 0;
    this.onBeatSeconds = 0;
    this.currentPass++;
    this.passTicks = 0;
    this.cumulativeRewardCurrentPass = 0;
  }

  // Interactive Trainer Coaching: Injects dopamine burst directly into Mushroom Body
  public injectManualDopamine(amount: number): void {
    if (!this.learningEnabled || !this.lastControls) return;
    this.applyPlasticity(amount, 0.25);
    this.cumulativeRewardCurrentPass += amount;
    this.rewardHistory.push(amount);
    if (this.rewardHistory.length > 80) this.rewardHistory.shift();
  }

  // Save brain weights & training history to JSON / LocalStorage
  public saveBrain(): string {
    const payload = {
      version: 2,
      W_pn_kc: Array.from(this.W_pn_kc),
      W_kc_dn: Array.from(this.W_kc_dn),
      stage: this.stage,
      currentPass: this.currentPass,
      passHistory: this.passHistory,
      totalPlasticityEvents: this.totalPlasticityEvents
    };
    const json = JSON.stringify(payload);
    try {
      localStorage.setItem('neuro_dj_brain_checkpoint', json);
    } catch { /* ignore */ }
    return json;
  }

  // Load brain weights & training history
  public loadBrain(json?: string): boolean {
    try {
      const dataStr = json || localStorage.getItem('neuro_dj_brain_checkpoint');
      if (!dataStr) return false;
      const data = JSON.parse(dataStr);
      const valid = (values: unknown, length: number, min: number, max: number): values is number[] =>
        Array.isArray(values) && values.length === length && values.every(v => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max);
      if (data.version !== 2 || !valid(data.W_pn_kc, this.W_pn_kc.length, 0, 1.201)) return false;
      if (valid(data.W_kc_dn, this.W_kc_dn.length, 0.00999, 1.60001)) {
        this.W_pn_kc.set(data.W_pn_kc);
        this.resetPerformance();
        for (let i = 0; i < this.W_kc_dn.length; i++) {
          this.W_kc_dn[i] = data.W_kc_dn[i];
        }
        if (['naive', 'training', 'master'].includes(data.stage)) this.stage = data.stage;
        if (Number.isInteger(data.currentPass) && data.currentPass > 0) this.currentPass = data.currentPass;
        this.passHistory = Array.isArray(data.passHistory) ? data.passHistory.filter((p: PassTelemetry) =>
          p && [p.passNumber, p.cumulativeReward, p.avgSynchrony, p.avgWeight].every(Number.isFinite)).slice(-20) : [];
        this.passTicks = 0;
        this.cumulativeRewardCurrentPass = 0;
        if (Number.isInteger(data.totalPlasticityEvents) && data.totalPlasticityEvents >= 0) this.totalPlasticityEvents = data.totalPlasticityEvents;
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }
}
// Module summary: This small sparse circuit maps current and delayed acoustic bands into three motor outputs.
// Live learning uses reward-modulated eligibility traces, while optional demonstration replay fits only the same readout with supervision.
// Fixed random projections and limited sensory context constrain what it can learn; neither mode implies a full biological connectome or musical understanding.
