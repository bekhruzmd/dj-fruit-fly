export interface RewardWeights {
  wBeat: number;          // Bonus weight for crossfading near a detected beat/onset
  wRMS: number;           // Bonus weight for maintaining stable RMS energy within range
  wTrainwreck: number;    // Penalty weight for large frame-to-frame jumps in crossfader/filter
  wDiscontinuity: number; // Penalty weight for abrupt acoustic energy dropouts / hard cuts
  wPhrase: number;        // DJ Fundamental 1: Bonus for phrasing alignment on 8-bar drops
  wBassSwap: number;      // DJ Fundamental 2: Bonus for carving bass (avoiding kick clash)
  wTension: number;       // DJ Fundamental 3: Bonus for tension buildup on Bar 8 into drop
}

export interface RewardBreakdown {
  totalReward: number;          // Net scalar dopamine signal R(t)
  beatTransitionBonus: number;  // (a) Crossfade near beat bonus
  rmsStabilityBonus: number;    // (b) Stable energy bonus
  trainwreckPenalty: number;    // (c) Twitchy control jump penalty
  discontinuityPenalty: number; // (d) Energy collapse / cut penalty
  phraseBonus: number;          // (e) Phrase drop alignment bonus
  bassSwapBonus: number;        // (f) Clean bass frequency carve bonus
  tensionBonus: number;         // (g) Tension buildup into drop bonus
}

export class DJRewardEngine {
  // Configurable weights
  public weights: RewardWeights = {
    wBeat: 1.2,
    wRMS: 0.8,
    wTrainwreck: 1.5,
    wDiscontinuity: 1.4,
    wPhrase: 1.8,
    wBassSwap: 1.5,
    wTension: 1.4
  };

  // State memory across ticks
  private prevCrossfader: number = 0.0;
  private prevFilter: number = 0.5;
  private targetRMSMin: number = 0.10;
  private targetRMSMax: number = 0.40;

  constructor(customWeights?: Partial<RewardWeights>) {
    if (customWeights) {
      this.weights = { ...this.weights, ...customWeights };
    }
  }

  // Pure, clearly separated reward evaluation function called each tick
  public computeReward(
    crossfader: number,
    filterCutoff: number,
    stutterActive: boolean,
    audioOnset: number,
    isBeat: boolean,
    currentRMS: number,
    deltaRMS: number,
    dt: number,
    isStandby: boolean = false,
    timing?: {
      beat: number;
      bar: number;
      isDownbeat: boolean;
      isPhraseDrop: boolean;
      isBuildup: boolean;
    }
  ): RewardBreakdown {
    if (isStandby) {
      return {
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
    // ------------------------------------------------------------------
    // (a) Bonus for crossfading near a detected beat / onset
    // ------------------------------------------------------------------
    const crossfadeVelocity = Math.abs(crossfader - this.prevCrossfader) / Math.max(0.001, dt);
    const filterVelocity = Math.abs(filterCutoff - this.prevFilter) / Math.max(0.001, dt);
    const isTransitioning = crossfadeVelocity > 0.08 || filterVelocity > 0.15;

    let beatTransitionBonus = 0;
    if (isTransitioning) {
      // If moving controls while a strong beat or onset occurs -> high praise
      if (isBeat || audioOnset > 0.45) {
        beatTransitionBonus = 1.0 * (isBeat ? 1.0 : audioOnset);
      } else {
        // Penalty if actively transitioning during an off-beat dead zone
        beatTransitionBonus = -0.35;
      }
    }

    // ------------------------------------------------------------------
    // (b) Bonus for keeping RMS energy stable / within musical range
    // ------------------------------------------------------------------
    let rmsStabilityBonus = 0;
    if (currentRMS >= this.targetRMSMin && currentRMS <= this.targetRMSMax) {
      // Optimal listening range
      const mid = (this.targetRMSMin + this.targetRMSMax) / 2;
      const deviation = Math.abs(currentRMS - mid) / (mid - this.targetRMSMin);
      rmsStabilityBonus = Math.max(0.0, 1.0 - deviation);
    } else if (currentRMS < this.targetRMSMin) {
      // Dead silence / music choked out
      rmsStabilityBonus = -0.8;
    } else {
      // Clashing / clipping overdrive
      rmsStabilityBonus = -0.6;
    }

    // ------------------------------------------------------------------
    // (c) Penalty for large frame-to-frame jumps ("Trainwreck" penalty)
    // ------------------------------------------------------------------
    // A sudden jump of > 0.15 across 20ms sounds twitchy and amateur
    let trainwreckPenalty = 0;
    const deltaCross = Math.abs(crossfader - this.prevCrossfader);
    const deltaFilt = Math.abs(filterCutoff - this.prevFilter);

    if (deltaCross > 0.08) {
      trainwreckPenalty += Math.pow((deltaCross - 0.08) * 12.0, 1.8);
    }
    if (deltaFilt > 0.12) {
      trainwreckPenalty += Math.pow((deltaFilt - 0.12) * 10.0, 1.8);
    }
    trainwreckPenalty = Math.min(2.0, trainwreckPenalty);

    // ------------------------------------------------------------------
    // (d) Penalty for abrupt energy discontinuities (hard cuts / dropouts)
    // ------------------------------------------------------------------
    let discontinuityPenalty = 0;
    if (deltaRMS > 0.15) {
      discontinuityPenalty = Math.min(2.0, Math.pow((deltaRMS - 0.15) * 8.0, 1.5));
    }

    // ------------------------------------------------------------------
    // (e) DJ Fundamental 1: Phrasing Alignment & Drop Transitioning
    // ------------------------------------------------------------------
    let phraseBonus = 0;
    if (isTransitioning) {
      if (timing?.isPhraseDrop) {
        phraseBonus = 1.8; // Perfect drop synchronization on Bar 1!
      } else if (timing?.isDownbeat) {
        phraseBonus = 0.8; // On-measure bar downbeat transition
      } else if (timing?.isBuildup) {
        phraseBonus = 0.5; // Anticipatory pre-drop movement
      } else {
        phraseBonus = -0.3; // Clumsy transition during an off-beat dead zone
      }
    }

    // ------------------------------------------------------------------
    // (f) DJ Fundamental 2: The "Bass Swap" & Frequency Carving
    // ------------------------------------------------------------------
    // When both tracks are audible (crossfader 0.22 - 0.78), a pro DJ
    // cuts bass on one deck (HPF filterCutoff > 0.58) so kicks never clash.
    let bassSwapBonus = 0;
    const isMidCrossfade = crossfader > 0.22 && crossfader < 0.78;
    if (isMidCrossfade) {
      // The mixer now applies independent -24 dB bass shelves to the
      // non-owning deck. Reward an overlap only while audible energy survives.
      bassSwapBonus = currentRMS >= this.targetRMSMin ? 0.5 : -0.5;
    }

    // ------------------------------------------------------------------
    // (g) DJ Fundamental 3: Tension Building into the Drop
    // ------------------------------------------------------------------
    // In Bar 8 right before the drop, pro DJs build tension with stutter/HPF roll.
    // When the drop hits (Bar 1), tension must be instantly released!
    let tensionBonus = 0;
    if (timing?.isBuildup) {
      if (stutterActive || filterCutoff > 0.65) {
        tensionBonus = 1.5; // Pro tension buildup into drop!
      }
    } else if (timing?.isPhraseDrop && stutterActive) {
      tensionBonus = -0.9; // Choking the drop with stutter
    }

    // Update state memory for next tick
    this.prevCrossfader = crossfader;
    this.prevFilter = filterCutoff;

    // Total weighted scalar dopamine signal R(t)
    const netReward =
      this.weights.wBeat * beatTransitionBonus +
      this.weights.wRMS * rmsStabilityBonus -
      this.weights.wTrainwreck * trainwreckPenalty -
      this.weights.wDiscontinuity * discontinuityPenalty +
      this.weights.wPhrase * phraseBonus +
      this.weights.wBassSwap * bassSwapBonus +
      this.weights.wTension * tensionBonus;

    return {
      totalReward: Math.max(-2.0, Math.min(2.0, netReward)),
      beatTransitionBonus,
      rmsStabilityBonus,
      trainwreckPenalty,
      discontinuityPenalty,
      phraseBonus,
      bassSwapBonus,
      tensionBonus
    };
  }

  public reset(): void {
    this.prevCrossfader = 0.0;
    this.prevFilter = 0.5;
  }
}
