import type { DJControlSignals } from './DescendingOutputLayer';
import type { MusicalTiming } from '../audio/MusicalTiming';

/** Explicit musical assistance, not learned connectome behavior.
 * Hold for eight bars, blend for eight, and repeat in the opposite direction.
 * The neural outputs select the blend curve, filter color and final roll.
 */
export class MusicalDirector {
  private cycle = -1;
  private curve = 0;
  private roll = false;
  private latched = false;

  public reset(): void {
    this.cycle = -1;
    this.latched = false;
  }

  public update(controls: DJControlSignals, timing: MusicalTiming): DJControlSignals {
    if (timing.hasPhraseGrid === false) return controls;
    const cycle = Math.floor(timing.totalBeats / 64);
    const beat = timing.totalBeats % 64;
    if (cycle !== this.cycle) {
      this.cycle = cycle;
      this.latched = false;
    }
    if (beat >= 32 && !this.latched) {
      this.curve = (controls.rawCrossfader - 0.5) * 0.7;
      this.roll = controls.rawStutter > 0.75;
      this.latched = true;
    }
    const progress = Math.max(0, Math.min(1, (beat - 32) / 32));
    const shaped = progress + this.curve * Math.sin(progress * Math.PI * 2) / (Math.PI * 2);
    const blend = shaped * shaped * (3 - 2 * shaped);
    const crossfader = cycle % 2 === 0 ? blend : 1 - blend;
    const envelope = Math.sin(progress * Math.PI);
    return {
      ...controls,
      crossfader,
      // Restrained high-pass sweep, returning to neutral on the drop.
      filterDeck: cycle % 2 === 0 ? 'A' : 'B',
      filterCutoff: 0.5 + Math.max(0, controls.rawFilter - 0.5) * 0.35 * envelope,
      stutterTrigger: this.roll && beat >= 63.5 && beat < 64,
    };
  }
  // Summary: This constrains neural expression to an authored phrase plan for the preset pair.
  // Unknown phrase timing bypasses the plan instead of counting arbitrary imported beats into imaginary drops.
  // The unassisted fallback is exploratory; it does not guarantee a clean transition between unrelated tracks.
}
// Module summary: This director supplies musical assistance rather than inferred track structure.
// It now explicitly refuses to apply that structure to imported tracks without phrase annotations.
// Proper phrase detection and a shared transition planner are still needed for autonomous real-track sets.

