export interface DJControlSignals {
  crossfader: number;    // [0.0 = Deck A, 1.0 = Deck B]
  filterCutoff: number;  // [0.0 = LPF, 0.5 = Flat, 1.0 = HPF/Bass Kill]
  filterDeck?: 'A' | 'B'; // Guided mode colors only the outgoing deck.
  stutterTrigger: boolean; // True when stutter FX active
  rawCrossfader: number;
  rawFilter: number;
  rawStutter: number;
}

export class DescendingOutputLayer {
  public readonly numDN: number = 3; // 0: Crossfader, 1: Filter, 2: Stutter FX

  // Raw firing rates
  public r_dn: Float32Array;

  // Smoothed physical control signals (exponential moving average to prevent zipper noise)
  private smoothedCrossfader: number = 0.0;
  private smoothedFilter: number = 0.5;
  private smoothedStutter: number = 0.0;

  // Smoothing time constants (tau in seconds)
  private readonly tauCrossfade: number = 0.12; // ~120ms glide
  private readonly tauFilter: number = 0.08;    // ~80ms sweep
  private readonly tauStutter: number = 0.04;   // Fast trigger

  constructor() {
    this.r_dn = new Float32Array(this.numDN);
  }

  // Update raw rates from KC projection and apply physiological leaky integration
  public update(rawDNActivations: Float32Array, dt: number): DJControlSignals {
    for (let i = 0; i < this.numDN; i++) {
      this.r_dn[i] = rawDNActivations[i];
    }

    // 1. Crossfader Readout: DN 0 maps from 0.0 (Deck A) to 1.0 (Deck B)
    const targetCrossfader = Math.max(0.0, Math.min(1.0, this.r_dn[0]));
    const alphaCross = 1 - Math.exp(-Math.max(0, dt) / this.tauCrossfade);
    this.smoothedCrossfader += (targetCrossfader - this.smoothedCrossfader) * alphaCross;

    // 2. Filter Cutoff Readout: DN 1 maps from 0.0 (LPF) -> 0.5 (Flat) -> 1.0 (HPF)
    const targetFilter = Math.max(0.0, Math.min(1.0, this.r_dn[1]));
    const alphaFilter = 1 - Math.exp(-Math.max(0, dt) / this.tauFilter);
    this.smoothedFilter += (targetFilter - this.smoothedFilter) * alphaFilter;

    // 3. Stutter FX Readout: DN 2 triggers stutter roll when activation exceeds threshold
    const targetStutter = Math.max(0.0, Math.min(1.0, this.r_dn[2]));
    const alphaStutter = 1 - Math.exp(-Math.max(0, dt) / this.tauStutter);
    this.smoothedStutter += (targetStutter - this.smoothedStutter) * alphaStutter;
    const stutterActive = this.smoothedStutter > 0.65;

    return {
      crossfader: this.smoothedCrossfader,
      filterCutoff: this.smoothedFilter,
      stutterTrigger: stutterActive,
      rawCrossfader: this.r_dn[0],
      rawFilter: this.r_dn[1],
      rawStutter: this.r_dn[2]
    };
  }

  public reset(): void {
    this.r_dn.fill(0);
    this.smoothedCrossfader = 0.0;
    this.smoothedFilter = 0.5;
    this.smoothedStutter = 0.0;
  }
}
