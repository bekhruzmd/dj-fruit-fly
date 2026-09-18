/** Versioned evidence boundary: motor intent is never native measured state. */
export const STALE_MS = 1500;
export const fields = ['crossfader', 'filter1', 'filter2', 'volume1', 'volume2', 'playing1', 'playing2'] as const;
export type Field = typeof fields[number];
export interface Reading<T> { value: T | null; provenance: 'ax' | 'unknown'; at: number | null }
export interface Estimate { value: number; provenance: 'dispatch-estimate'; at: number }
export interface BridgeAction {
  id: string; commandId: string | null; type: 'crossfader-left' | 'crossfader-right' | 'cut' | 'control';
  at: number; status: 'dispatched' | 'failed' | 'rejected'; provenance: 'native-dispatch' | 'validation'; reason: string | null;
}
export const mixControls = ['crossfader', 'bass1', 'bass2', 'volume1', 'volume2', 'filter1', 'filter2', 'playing1', 'playing2', 'sync1', 'sync2', 'cue1', 'cue2'] as const;
export interface TransitionState {
  phase: 'idle' | 'preparing' | 'ready' | 'running' | 'settling' | 'complete' | 'stopped';
  reason: string; source: number; bpm: number; progress: number; ready: boolean; blocker: string | null;
  bass: [number | null, number | null]; writable: Record<typeof mixControls[number], boolean>;
}
export interface BridgeMessage {
  transition?: TransitionState;
  version: 1; kind: 'snapshot' | 'action'; sessionId: string; sequence: number; sentAt: number;
  state: Record<Field, Reading<number | boolean>>; estimate: Estimate | null;
  availability: { djay: boolean; accessibility: boolean; dispatch: boolean };
  capabilities: { crossfader: boolean; cut: boolean; filter: boolean; read: Record<Field, boolean> };
  action: BridgeAction | null;
}
export interface DisplayValue { value: number; provenance: 'ax' | 'dispatch-estimate' | 'unknown' }
export interface BridgeDisplayState {
  live: boolean; status: 'offline' | 'waiting' | 'stale' | 'unavailable' | 'live'; sessionId: string | null;
  crossfader: DisplayValue; filters: [DisplayValue, DisplayValue]; volumes: [DisplayValue, DisplayValue];
  playing: [boolean | null, boolean | null];
  bass: [DisplayValue, DisplayValue];
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const unit = (v: unknown): v is number => finite(v) && v >= 0 && v <= 1;
// These guards keep external JSON outside the typed domain until its primitive values are checked.
// Unit controls cannot carry NaN or infinity into Three.js. Arrays cannot impersonate records.

export function parseMessage(raw: string): BridgeMessage | null {
  try {
    const m: unknown = JSON.parse(raw);
    if (!record(m) || m.version !== 1 || !['snapshot', 'action'].includes(String(m.kind)) ||
      typeof m.sessionId !== 'string' || !m.sessionId.length || m.sessionId.length > 120 ||
      !Number.isSafeInteger(m.sequence) || Number(m.sequence) < 1 || !finite(m.sentAt) || m.sentAt < 0 ||
      !record(m.state) || !record(m.availability) || !record(m.capabilities) || !record(m.capabilities.read)) return null;
    for (const key of fields) {
      const r = m.state[key];
      if (!record(r)) return null;
      if (r.provenance === 'unknown') {
        if (r.value !== null || r.at !== null) return null;
      } else if (r.provenance !== 'ax' || !finite(r.at) || r.at < 0 || r.at > m.sentAt ||
        (key.startsWith('playing') ? typeof r.value !== 'boolean' : !unit(r.value))) return null;
      if (typeof m.capabilities.read[key] !== 'boolean') return null;
    }
    for (const key of ['djay', 'accessibility', 'dispatch']) if (typeof m.availability[key] !== 'boolean') return null;
    for (const key of ['crossfader', 'cut', 'filter']) if (typeof m.capabilities[key] !== 'boolean') return null;
    if (m.transition !== undefined) {
      const t = m.transition;
      if (!record(t) || !['idle', 'preparing', 'ready', 'running', 'settling', 'complete', 'stopped'].includes(String(t.phase)) ||
        typeof t.reason !== 'string' || !(t.source === 1 || t.source === 2) || !finite(t.bpm) || t.bpm < 60 || t.bpm > 180 ||
        !unit(t.progress) || typeof t.ready !== 'boolean' || !(t.blocker === null || typeof t.blocker === 'string') ||
        !Array.isArray(t.bass) || t.bass.length !== 2 || !t.bass.every(v => v === null || unit(v)) || !record(t.writable) ||
        !mixControls.every(f => typeof (t.writable as Record<string, unknown>)[f] === 'boolean')) return null;
    }
    if (m.estimate !== null && (!record(m.estimate) || !unit(m.estimate.value) || m.estimate.provenance !== 'dispatch-estimate' ||
      !finite(m.estimate.at) || m.estimate.at < 0 || m.estimate.at > m.sentAt)) return null;
    if (m.kind === 'snapshot' && m.action !== null) return null;
    if (m.kind === 'action') {
      const a = m.action;
      if (!record(a) || typeof a.id !== 'string' || !a.id.length || a.id.length > 120 ||
        !(a.commandId === null || typeof a.commandId === 'string') ||
        !['crossfader-left', 'crossfader-right', 'cut', 'control'].includes(String(a.type)) ||
        !['dispatched', 'failed', 'rejected'].includes(String(a.status)) ||
        !['native-dispatch', 'validation'].includes(String(a.provenance)) ||
        !finite(a.at) || a.at < 0 || a.at > m.sentAt || !(a.reason === null || typeof a.reason === 'string') ||
        (a.status === 'dispatched' && (a.provenance !== 'native-dispatch' || a.type === 'control'))) return null;
    }
    return m as unknown as BridgeMessage;
  } catch { return null; }
}
// Parsing enforces version, finite ranges, timestamps and provenance before state can animate.
// A malformed frame is ignored in full. Native schema changes need a versioned adapter here.

export function idleDisplay(status: BridgeDisplayState['status'] = 'offline'): BridgeDisplayState {
  const neutral = (): DisplayValue => ({ value: .5, provenance: 'unknown' });
  return { live: false, status, sessionId: null, crossfader: neutral(), filters: [neutral(), neutral()],
    volumes: [neutral(), neutral()], bass: [neutral(), neutral()], playing: [null, null] };
}
// Neutral geometry is a placeholder and always tagged unknown. It provides a quiet disconnected
// booth without claiming any native control position. Known playback is intentionally discarded.

export class BridgeStateStore {
  private message: BridgeMessage | null = null;
  private receivedAt = -Infinity;
  private connected = false;
  private awaitingSnapshot = true;
  private session: string | null = null;
  private sequence = 0;
  private actionIds = new Set<string>();
  private retiredSessions = new Set<string>();

  setConnected(connected: boolean): void {
    this.connected = connected; this.awaitingSnapshot = true; this.message = null;
  }
  // Socket changes invalidate visual evidence immediately. Sequence history survives reconnects
  // to reject old frames. The new connection must begin with a snapshot, never an action replay.

  receive(raw: string, now: number): BridgeAction | null {
    const m = parseMessage(raw);
    if (!this.connected || !finite(now) || !m || (this.awaitingSnapshot && m.kind !== 'snapshot')) return null;
    const newSession = m.sessionId !== this.session;
    if (newSession) {
      if (m.kind !== 'snapshot' || this.retiredSessions.has(m.sessionId)) return null;
      if (this.session) this.retiredSessions.add(this.session);
      if (this.retiredSessions.size > 16) this.retiredSessions.delete(this.retiredSessions.values().next().value!);
      this.session = m.sessionId; this.sequence = 0; this.actionIds.clear();
    }
    if (m.sequence <= this.sequence) return null;
    const wasIdle = this.awaitingSnapshot || now - this.receivedAt > STALE_MS;
    this.awaitingSnapshot = false; this.sequence = m.sequence; this.message = m; this.receivedAt = now;
    const action = m.action;
    if (!action || this.actionIds.has(action.id)) return null;
    this.actionIds.add(action.id);
    if (this.actionIds.size > 512) this.actionIds.delete(this.actionIds.values().next().value!);
    return !wasIdle && m.availability.djay && action.status === 'dispatched' && m.sentAt - action.at <= 500 ? action : null;
  }
  // Session and sequence ordering reject duplicate, late and retired-session traffic. Action IDs
  // additionally deduplicate retries carried by newer frames. Recovered stale sockets establish
  // a baseline without replaying a gesture, even if their first fresh message contains an action.

  transition(now: number): TransitionState | null {
    return this.connected && finite(now) && now - this.receivedAt <= STALE_MS ? this.message?.transition ?? null : null;
  }

  display(now: number): BridgeDisplayState {
    if (!this.connected) return idleDisplay();
    const m = this.message;
    if (!m) return idleDisplay('waiting');
    const elapsed = Math.max(0, now - this.receivedAt);
    if (!finite(now) || elapsed > STALE_MS) return idleDisplay('stale');
    if (!m.availability.djay) return idleDisplay('unavailable');
    const measured = (field: Field): number | boolean | null => {
      const r = m.state[field];
      return r.provenance === 'ax' && r.at !== null && m.sentAt - r.at + elapsed <= STALE_MS ? r.value : null;
    };
    const value = (field: Field): DisplayValue => {
      const v = measured(field);
      return typeof v === 'number' ? { value: v, provenance: 'ax' } : { value: .5, provenance: 'unknown' };
    };
    const crossfader = value('crossfader');
    if (crossfader.provenance === 'unknown' && m.estimate && m.sentAt - m.estimate.at + elapsed <= STALE_MS) {
      crossfader.value = m.estimate.value; crossfader.provenance = 'dispatch-estimate';
    }
    const bass = (index: number): DisplayValue => {
      const v = m.transition?.bass[index];
      return typeof v === 'number' ? { value: v, provenance: 'ax' } : { value: .5, provenance: 'unknown' };
    };
    return { bass: [bass(0), bass(1)], live: true, status: 'live', sessionId: m.sessionId, crossfader, filters: [value('filter1'), value('filter2')],
      volumes: [value('volume1'), value('volume2')], playing: [measured('playing1') as boolean | null, measured('playing2') as boolean | null] };
  }
  // One display projection supplies both booth geometry and HUD values. Fresh AX measurements
  // outrank dispatch estimates, while each value expires independently. Client monotonic time
  // measures local freshness without comparing unrelated browser and server clock origins.
}

// Module summary: Typed telemetry keeps observations, dispatch estimates and unknowns distinct.
// The store is deterministic and independent of WebSocket or Three.js. Its freshness assumptions
// require a local ordered socket; it cannot prove a posted keyboard shortcut was consumed by djay.
