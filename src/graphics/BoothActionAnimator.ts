import type { BridgeAction, BridgeDisplayState } from '../bridge/protocol';
export type Point = [number, number, number];
export type Contact = 'crossfader' | 'filter1' | 'filter2' | 'bass1' | 'bass2' | 'cut';
export interface BoothTargets { crossfader: Point; filter1: Point; filter2: Point; bass1: Point; bass2: Point; cut: Point; leftRest: Point; rightRest: Point }
interface Hand { point: Point; start: Point; contact: Contact | null; age: number; duration: number; returning: boolean }

function easeOut(progress: number): number {
  // Solve the skill's cubic-bezier(0.23, 1, 0.32, 1), independently of frame count.
  const x = Math.max(0, Math.min(1, progress));
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) {
    const t = (lo + hi) / 2;
    const bx = 3 * (1 - t) ** 2 * t * .23 + 3 * (1 - t) * t * t * .32 + t ** 3;
    if (bx < x) lo = t; else hi = t;
  }
  return x === 0 || x === 1 ? x : 1 - (1 - (lo + hi) / 2) ** 3;
}
// The easing solver gives the documented strong ease-out without an animation dependency.
// Absolute elapsed time makes equal timestamps agree across frame rates. Input is clamped.

export function solveElbow(shoulder: Point, tip: Point, side: -1 | 1, length = .68): Point {
  const delta = tip.map((v, i) => v - shoulder[i]) as Point;
  const distance = Math.hypot(...delta);
  const bend = Math.sqrt(Math.max(0, length * length - distance * distance / 4));
  // Perpendicular to the reach vector, with outward elbows for a readable six-legged silhouette.
  let normal: Point = [delta[2], 0, -delta[0]];
  const magnitude = Math.hypot(...normal);
  normal = magnitude > 1e-8 ? normal.map(v => v / magnitude) as Point : [1, 0, 0];
  return shoulder.map((v, i) => (v + tip[i]) / 2 + side * normal[i] * bend) as Point;
}
// This two-segment construction puts the fingertip exactly on the requested local contact.
// Equal segment lengths create a stable outward elbow when the target is reachable. Targets
// beyond the authored reach extend the limbs rather than losing contact; booth placement bounds them.

export class BoothActionAnimator {
  private hands: [Hand, Hand];
  private previous: BridgeDisplayState | null = null;
  private pending: BridgeAction | null = null;
  private seen = new Set<string>();
  private reduced = false;

  constructor(rest: [Point, Point] = [[-.23, .2, .48], [.23, .2, .48]]) {
    this.hands = rest.map(point => ({ point: [...point], start: [...point], contact: null, age: 0, duration: 0, returning: false })) as [Hand, Hand];
  }
  // Hands begin at explicit resting positions in world space. Their current poses survive
  // retargeting. These defaults describe the existing booth rather than native djay geometry.

  action(action: BridgeAction): void {
    if (action.status !== 'dispatched' || action.provenance !== 'native-dispatch' || this.seen.has(action.id)) return;
    this.seen.add(action.id);
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
    this.pending = action;
  }
  // Only actual dispatch events can request a tap or nudge gesture. Repeated IDs are inert.
  // The newest event replaces pending work, so render pauses cannot accumulate stale gestures.

  private reach(index: number, contact: Contact): void {
    const hand = this.hands[index];
    if (hand.contact === contact && !hand.returning) { hand.duration = hand.age + .35; return; }
    hand.start = [...hand.point]; hand.contact = contact; hand.age = 0;
    hand.duration = contact === 'cut' ? .12 : .35; hand.returning = false;
  }
  // Retargeting starts at the current fingertip rather than a fixed animation keyframe.
  // Continuous control changes maintain contact while the target moves. Cut feedback lasts
  // 120ms; continuous sweeps settle before a 180ms return to the current rest target.

  update(dt: number, display: BridgeDisplayState, targets: BoothTargets, reduced = false): { left: Point; right: Point; cut: number } {
    const elapsed = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 1)) : 0;
    const reset = !display.live || !this.previous?.live || this.previous.sessionId !== display.sessionId || reduced !== this.reduced;
    if (reset || reduced) {
      for (const [i, hand] of this.hands.entries()) {
        hand.point = [...(i === 0 ? targets.leftRest : targets.rightRest)];
        hand.contact = null; hand.returning = false; hand.age = 0;
      }
      this.pending = null;
    } else {
      const old = this.previous!;
      const cf = display.crossfader;
      if (cf.provenance !== 'unknown' && old.crossfader.provenance === cf.provenance && Math.abs(cf.value - old.crossfader.value) > .0001) {
        this.reach(cf.value < old.crossfader.value ? 0 : 1, 'crossfader');
      }
      for (const index of [0, 1] as const) {
        if (display.filters[index].provenance === 'ax' && old.filters[index].provenance === 'ax' &&
          Math.abs(display.filters[index].value - old.filters[index].value) > .0001) this.reach(index, index === 0 ? 'filter1' : 'filter2');
        if (display.bass[index].provenance === 'ax' && old.bass[index].provenance === 'ax' &&
          Math.abs(display.bass[index].value - old.bass[index].value) > .0001) this.reach(index, index === 0 ? 'bass1' : 'bass2');
      }
      if (this.pending?.type === 'cut') this.reach(1, 'cut');
      if (this.pending?.type === 'crossfader-left') this.reach(0, 'crossfader');
      if (this.pending?.type === 'crossfader-right') this.reach(1, 'crossfader');
      this.pending = null;
      for (const [i, hand] of this.hands.entries()) {
        const rest = i === 0 ? targets.leftRest : targets.rightRest;
        if (!hand.contact) { hand.point = [...rest]; continue; }
        hand.age += elapsed;
        const target = targets[hand.contact];
        if (!hand.returning && hand.age >= hand.duration) {
          // Evaluate the exact boundary pose, preserving frame-rate independence across exit.
          hand.start = [...target]; hand.age -= hand.duration; hand.returning = true;
        }
        const blend = easeOut(hand.age / (hand.returning ? .18 : hand.contact === 'cut' ? .06 : .12));
        const destination = hand.returning ? rest : target;
        hand.point = hand.start.map((v, axis) => v + (destination[axis] - v) * blend) as Point;
        if (hand.returning && hand.age >= .18) { hand.contact = null; hand.returning = false; hand.point = [...rest]; }
      }
    }
    this.previous = display; this.reduced = reduced;
    const right = this.hands[1];
    return { left: [...this.hands[0].point], right: [...right.point],
      cut: right.contact === 'cut' && !right.returning && right.age >= .06 ? 1 : 0 };
  }
  // Confirmed changes and fresh events drive hand contact in world space, independent of body bob.
  // Initial/reconnected snapshots only establish static controls; they never invent actions.
  // Reduced motion preserves those controls while discarding travel, taps and queued activity.
}
// Module summary: The rig visualizes state indication and dispatch feedback, not autonomous DJing.
// Current-pose interruption and time-based easing share the existing Three.js frame loop.
// Geometry consumers convert these world contacts after flyRoot transforms to maintain contact.
