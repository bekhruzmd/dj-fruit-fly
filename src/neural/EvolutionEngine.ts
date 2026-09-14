import { musicalTiming } from '../audio/MusicalTiming';

const NUM_PN = 8;
const NUM_KC = 64;
const NUM_DN = 3;

// Pre-computed EMA alphas at fixed dt = 0.04 s (matching the main render loop)
const ALPHA_CROSS = 1 - Math.exp(-0.04 / 0.12);  // ≈ 0.283
const ALPHA_FILT  = 1 - Math.exp(-0.04 / 0.08);   // ≈ 0.393
const ALPHA_STUTT = 1 - Math.exp(-0.04 / 0.04);   // ≈ 0.632

export interface BrainGenome {
  id: number;
  W_kc_dn: Float32Array;  // [NUM_KC * NUM_DN] = 192 values
  fitness: number;
}

export interface EvolutionConfig {
  populationSize: number;  // N brains (default 50)
  eliteRatio: number;      // Top fraction to keep (default 0.20)
  mutationSigma: number;   // Gaussian std dev (default 0.05)
  evalTicks: number;       // Simulation steps per evaluation (default 200 ≈ 8 s)
  bpm: number;             // Synthetic beat BPM (default 125)
  sparsityK: number;       // APL top-K active KCs (default 4)
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  populationSize: 50,
  eliteRatio: 0.20,
  mutationSigma: 0.05,
  evalTicks: 200,
  bpm: 125,
  sparsityK: 4,
};

export interface GenFitnessSummary {
  generation: number;
  bestFitness: number;
  avgFitness: number;
  worstFitness: number;
}

export interface EvolutionTelemetry {
  generation: number;
  bestFitness: number;
  avgFitness: number;
  worstFitness: number;
  history: GenFitnessSummary[];
  populationSize: number;
}

// Per-tick data pre-computed from synthetic audio; shared across all genomes in one generation
interface SensoryTick {
  r_kc: Float32Array;
  audioOnset: number;
  isBeat: boolean;
  currentRMS: number;
  deltaRMS: number;
  isPhraseDrop: boolean;
  isDownbeat: boolean;
  isBuildup: boolean;
}

function sampleGaussian(sigma: number, random: () => number): number {
  let u: number;
  do { u = random(); } while (u === 0);
  return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

// Build a synthetic house-beat sensory stream and project it through the fixed upstream wiring.
// The resulting r_kc arrays are shared across all genome evaluations in that generation.
function buildSensoryStream(W_pn_kc: Float32Array, config: EvolutionConfig): SensoryTick[] {
  const { evalTicks, bpm, sparsityK } = config;
  const dt = 0.04;
  const beatsPerSec = bpm / 60;
  const ticks: SensoryTick[] = [];

  // 6-step delay ring buffer (matches FlyWireCircuit.historyBuffer depth)
  const delayRing: Float32Array[] = [];
  let prevRMS = 0.20;

  for (let t = 0; t < evalTicks; t++) {
    const elapsed = t * dt;
    const totalBeats = elapsed * beatsPerSec;
    const beatFrac = totalBeats % 1;
    const beatInBar = Math.floor(totalBeats) % 4;

    // House drum synthesis
    const kickEnv  = beatFrac < 0.12 ? (1 - beatFrac / 0.12) : 0;
    const isSnare  = beatInBar === 1 || beatInBar === 3;
    const snareEnv = isSnare && beatFrac < 0.10 ? (1 - beatFrac / 0.10) : 0;
    const hatEnv   = 0.12 + 0.14 * Math.abs(Math.sin(totalBeats * Math.PI * 2));

    const subBass  = Math.min(1.0, 0.85 * kickEnv + 0.05);
    const lowMids  = Math.min(1.0, 0.50 * snareEnv + 0.15 * kickEnv + 0.08);
    const highMids = Math.min(1.0, 0.65 * snareEnv + 0.10);
    const highs    = Math.min(1.0, hatEnv);

    const currentRMS = 0.13 + 0.10 * kickEnv + 0.04 * snareEnv + 0.02 * hatEnv;
    const deltaRMS   = Math.abs(currentRMS - prevRMS);
    prevRMS = currentRMS;

    const isBeat    = beatFrac < 0.08;
    const audioOnset = isBeat ? 0.75 + 0.25 * kickEnv : Math.min(0.35, snareEnv * 0.4 + 0.05);

    // 8-channel sensory = current 4 + 6-step delayed 4
    const cur = new Float32Array([subBass, lowMids, highMids, highs]);
    delayRing.unshift(cur);
    if (delayRing.length > 6) delayRing.pop();
    const delayed = delayRing[delayRing.length - 1] ?? cur;

    const fullSensory = new Float32Array(NUM_PN);
    for (let i = 0; i < 4; i++) {
      fullSensory[i]     = cur[i];
      fullSensory[i + 4] = delayed[i];
    }

    // Fixed projection PN → raw KC
    const rawKC = new Float32Array(NUM_KC);
    for (let k = 0; k < NUM_KC; k++) {
      let exc = 0;
      for (let p = 0; p < NUM_PN; p++) {
        exc += fullSensory[p] * W_pn_kc[k * NUM_PN + p];
      }
      rawKC[k] = exc;
    }

    // APL: top-K sparsity (matches FlyWireCircuit step 2)
    const indexed = Array.from(rawKC).map((val, idx) => ({ val, idx }));
    indexed.sort((a, b) => b.val - a.val);
    const r_kc = new Float32Array(NUM_KC);
    for (let i = 0; i < Math.min(sparsityK, NUM_KC); i++) {
      if (indexed[i].val > 0.05) r_kc[indexed[i].idx] = Math.min(1.5, indexed[i].val);
    }

    const timing = musicalTiming(elapsed, bpm);
    ticks.push({
      r_kc,
      audioOnset,
      isBeat,
      currentRMS,
      deltaRMS,
      isPhraseDrop: timing.isPhraseDrop,
      isDownbeat: timing.isDownbeat,
      isBuildup: timing.isBuildup,
    });
  }

  return ticks;
}

// Headless evaluation of one genome. Inlines the KC→DN readout, EMA smoothing,
// and reward function (mirrors DJRewardEngine weights exactly).
function evaluateGenome(genome: BrainGenome, stream: SensoryTick[]): number {
  const W = genome.W_kc_dn;
  let fitness = 0;
  const dt = 0.04;

  // Per-genome smoothed state
  let sCross = 0.0;
  let sFilt  = 0.5;
  let sStutt = 0.0;
  let prevCross = 0.0;
  let prevFilt  = 0.5;

  // DJRewardEngine default weights
  const wBeat = 1.2, wRMS = 0.8, wTW = 1.5, wDisc = 1.4;
  const wPhrase = 1.8, wBass = 1.5, wTens = 1.4;

  const rawDN = new Float32Array(NUM_DN);

  for (const tick of stream) {
    const { r_kc, audioOnset, isBeat, currentRMS, deltaRMS,
            isPhraseDrop, isDownbeat, isBuildup } = tick;

    // KC → DN with slope-6 sigmoid centred at 0.40 (matches FlyWireCircuit step 3)
    for (let d = 0; d < NUM_DN; d++) {
      let s = 0;
      for (let k = 0; k < NUM_KC; k++) s += r_kc[k] * W[k * NUM_DN + d];
      rawDN[d] = 1.0 / (1.0 + Math.exp(-6.0 * (s - 0.40)));
    }

    // EMA smoothing (matches DescendingOutputLayer)
    sCross = sCross + (Math.max(0, Math.min(1, rawDN[0])) - sCross) * ALPHA_CROSS;
    sFilt  = sFilt  + (Math.max(0, Math.min(1, rawDN[1])) - sFilt)  * ALPHA_FILT;
    sStutt = sStutt + (Math.max(0, Math.min(1, rawDN[2])) - sStutt) * ALPHA_STUTT;
    const stutter = sStutt > 0.65;

    // ----- Reward (DJRewardEngine.computeReward inlined) -----
    const crossVel = Math.abs(sCross - prevCross) / dt;
    const filtVel  = Math.abs(sFilt  - prevFilt)  / dt;
    const isTransitioning = crossVel > 0.08 || filtVel > 0.15;

    // (a) Beat transition
    let beatBonus = 0;
    if (isTransitioning) {
      beatBonus = (isBeat || audioOnset > 0.45)
        ? 1.0 * (isBeat ? 1.0 : audioOnset)
        : -0.35;
    }

    // (b) RMS stability
    let rmsBonus: number;
    if (currentRMS >= 0.10 && currentRMS <= 0.40) {
      const mid = 0.25;
      rmsBonus = Math.max(0, 1.0 - Math.abs(currentRMS - mid) / 0.15);
    } else if (currentRMS < 0.10) {
      rmsBonus = -0.8;
    } else {
      rmsBonus = -0.6;
    }

    // (c) Trainwreck
    const dCross = Math.abs(sCross - prevCross);
    const dFilt  = Math.abs(sFilt  - prevFilt);
    let twPenalty = 0;
    if (dCross > 0.08) twPenalty += Math.pow((dCross - 0.08) * 12.0, 1.8);
    if (dFilt  > 0.12) twPenalty += Math.pow((dFilt  - 0.12) * 10.0, 1.8);
    twPenalty = Math.min(2.0, twPenalty);

    // (d) Discontinuity
    const discPenalty = deltaRMS > 0.15
      ? Math.min(2.0, Math.pow((deltaRMS - 0.15) * 8.0, 1.5))
      : 0;

    // (e) Phrase
    let phraseBonus = 0;
    if (isTransitioning) {
      if (isPhraseDrop) phraseBonus = 1.8;
      else if (isDownbeat) phraseBonus = 0.8;
      else if (isBuildup)  phraseBonus = 0.5;
      else                 phraseBonus = -0.3;
    }

    // (f) Bass swap
    const isMidCF = sCross > 0.22 && sCross < 0.78;
    const bassBonus = isMidCF ? (currentRMS >= 0.10 ? 0.5 : -0.5) : 0;

    // (g) Tension
    let tensionBonus = 0;
    if (isBuildup) {
      if (stutter || sFilt > 0.65) tensionBonus = 1.5;
    } else if (isPhraseDrop && stutter) {
      tensionBonus = -0.9;
    }

    const reward = Math.max(-2.0, Math.min(2.0,
      wBeat * beatBonus + wRMS * rmsBonus - wTW * twPenalty
      - wDisc * discPenalty + wPhrase * phraseBonus
      + wBass * bassBonus + wTens * tensionBonus
    ));

    fitness += reward * dt;
    prevCross = sCross;
    prevFilt  = sFilt;
  }

  return fitness;
}

export class EvolutionEngine {
  public population: BrainGenome[] = [];
  public generation: number = 0;
  public history: GenFitnessSummary[] = [];
  private nextId = 0;

  // Seed the population from the current brain's W_kc_dn. The first genome is an
  // exact copy; all others are mutated with 2× sigma for diverse initial coverage.
  public initPopulation(
    baseWeights: Float32Array,
    W_pn_kc: Float32Array,
    config: EvolutionConfig,
    random: () => number = Math.random
  ): void {
    this.population = [];
    this.generation = 0;
    this.history = [];
    const { populationSize, mutationSigma } = config;

    for (let i = 0; i < populationSize; i++) {
      const W = new Float32Array(NUM_KC * NUM_DN);
      for (let j = 0; j < W.length; j++) {
        const noise = i === 0 ? 0 : sampleGaussian(mutationSigma * 2, random);
        W[j] = Math.max(0.01, Math.min(1.6, baseWeights[j] + noise));
      }
      this.population.push({ id: this.nextId++, W_kc_dn: W, fitness: 0 });
    }

    const stream = buildSensoryStream(W_pn_kc, config);
    for (const genome of this.population) {
      genome.fitness = evaluateGenome(genome, stream);
    }
    this.population.sort((a, b) => b.fitness - a.fitness);
  }

  // Full evolutionary cycle: evaluate → sort → select elites → breed offspring.
  public runGeneration(
    W_pn_kc: Float32Array,
    config: EvolutionConfig,
    random: () => number = Math.random
  ): GenFitnessSummary {
    const stream = buildSensoryStream(W_pn_kc, config);

    for (const genome of this.population) {
      genome.fitness = evaluateGenome(genome, stream);
    }
    this.population.sort((a, b) => b.fitness - a.fitness);

    const fitnesses = this.population.map(g => g.fitness);
    const bestFitness  = fitnesses[0];
    const avgFitness   = fitnesses.reduce((s, v) => s + v, 0) / fitnesses.length;
    const worstFitness = fitnesses[fitnesses.length - 1];

    const eliteCount = Math.max(1, Math.round(config.populationSize * config.eliteRatio));
    const elites = this.population.slice(0, eliteCount);

    const next: BrainGenome[] = [];
    // Elites pass through unchanged
    for (const e of elites) {
      next.push({ id: e.id, W_kc_dn: new Float32Array(e.W_kc_dn), fitness: e.fitness });
    }
    // Offspring: randomly pick an elite parent, apply Gaussian mutation
    while (next.length < config.populationSize) {
      const parent = elites[Math.floor(random() * elites.length)];
      const child = new Float32Array(NUM_KC * NUM_DN);
      for (let j = 0; j < child.length; j++) {
        child[j] = Math.max(0.01, Math.min(1.6,
          parent.W_kc_dn[j] + sampleGaussian(config.mutationSigma, random)
        ));
      }
      next.push({ id: this.nextId++, W_kc_dn: child, fitness: 0 });
    }

    this.population = next;
    this.generation++;

    const summary: GenFitnessSummary = { generation: this.generation, bestFitness, avgFitness, worstFitness };
    this.history.push(summary);
    if (this.history.length > 50) this.history.shift();
    return summary;
  }

  public getBestGenome(): BrainGenome | null {
    if (!this.population.length) return null;
    return this.population.reduce((best, g) => g.fitness > best.fitness ? g : best);
  }

  public getTelemetry(): EvolutionTelemetry {
    const sorted = [...this.population].sort((a, b) => b.fitness - a.fitness);
    const f = sorted.map(g => g.fitness);
    return {
      generation: this.generation,
      bestFitness:  f[0] ?? 0,
      avgFitness:   f.length ? f.reduce((s, v) => s + v, 0) / f.length : 0,
      worstFitness: f[f.length - 1] ?? 0,
      history: this.history,
      populationSize: this.population.length,
    };
  }
}
