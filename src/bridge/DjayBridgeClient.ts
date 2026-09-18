import { BridgeStateStore, type BridgeAction, type BridgeDisplayState } from './protocol';
export interface BridgeControlPayload { crossfader: number; filterCutoff: number; stutter: boolean }
export type ConnectionStatusListener = (connected: boolean) => void;

export class DjayBridgeClient {
  private ws: WebSocket | null = null;
  private running = false;
  private connected = false;
  private statusListeners = new Set<ConnectionStatusListener>();
  private actionListeners = new Set<(action: BridgeAction) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSentTime = -Infinity;
  private lastStutter = false;
  private commandSequence = 0;
  private readonly clientId = globalThis.crypto.randomUUID();
  private readonly store = new BridgeStateStore();
  private readonly url: string;

  constructor(url = 'ws://127.0.0.1:8766') { this.url = url; }
  // Each instance owns a command namespace, preventing collisions between browser tabs.
  // The loopback URL targets the local bridge. No queued commands survive socket replacement.

  connect(): void {
    this.running = true;
    if (this.ws) return;
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try {
      const socket = new WebSocket(this.url);
      this.ws = socket;
      socket.onopen = () => {
        if (this.ws !== socket || !this.running) return;
        this.lastSentTime = -Infinity; this.lastStutter = false;
        this.setConnected(true);
      };
      socket.onmessage = event => {
        if (this.ws !== socket || !this.running || typeof event.data !== 'string') return;
        const action = this.store.receive(event.data, performance.now());
        if (action) this.actionListeners.forEach(listener => listener(action));
      };
      socket.onclose = () => {
        if (this.ws !== socket) return;
        this.detach(socket); this.ws = null; this.setConnected(false); this.scheduleReconnect();
      };
      socket.onerror = () => { if (this.ws === socket) socket.close(); };
    } catch { this.setConnected(false); this.scheduleReconnect(); }
  }
  // All callbacks verify socket identity so an old connection cannot mutate a replacement.
  // Opening establishes only transport availability; a validated snapshot is still required.
  // Exceptions schedule one retry while explicit disconnect disables that retry path.

  disconnect(): void {
    this.running = false;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) { const socket = this.ws; this.ws = null; this.detach(socket); socket.close(); }
    this.setConnected(false);
  }
  // Explicit teardown removes event handlers before closing the socket. This prevents onclose
  // from creating a reconnect timer after unmount. The display becomes idle immediately.

  sendControl(payload: BridgeControlPayload, liveAudio = false): boolean {
    const socket = this.ws;
    const now = performance.now();
    if (!liveAudio || !this.connected || !socket || socket.readyState !== WebSocket.OPEN ||
      !this.store.display(now).live || !Number.isFinite(payload.crossfader) || !Number.isFinite(payload.filterCutoff) ||
      typeof payload.stutter !== 'boolean' || socket.bufferedAmount > 4096) return false;
    if (payload.stutter === this.lastStutter && now - this.lastSentTime < 40) return false;
    try {
      socket.send(JSON.stringify({ version: 1, kind: 'control', commandId: `${this.clientId}:${++this.commandSequence}`,
        liveAudio: true, crossfader: Math.max(0, Math.min(1, payload.crossfader)),
        filterCutoff: Math.max(0, Math.min(1, payload.filterCutoff)), stutter: payload.stutter }));
      this.lastSentTime = now; this.lastStutter = payload.stutter;
      return true;
    } catch { return false; }
  }
  // Live audio and fresh telemetry gate all outgoing intent. Bounded buffered bytes and a 25Hz
  // throttle discard obsolete motor output instead of queueing it. Stutter edges bypass the
  // throttle, but successful sending still does not generate a local action animation.

  getDisplayState(now = performance.now()): BridgeDisplayState { return this.store.display(now); }
  // Rendering polls freshness even when the server is silent. The store owns all provenance.
  // A caller may inject monotonic time for deterministic checks.

  onAction(listener: (action: BridgeAction) => void): () => void {
    this.actionListeners.add(listener); return () => { this.actionListeners.delete(listener); };
  }
  // Only validated, fresh dispatched events reach subscribers. Listener removal is explicit.
  // Subscribers must not treat a dispatch event as a confirmed native control position.

  onStatusChange(listener: ConnectionStatusListener): () => void {
    this.statusListeners.add(listener); listener(this.connected);
    return () => { this.statusListeners.delete(listener); };
  }
  // Transport subscribers receive an initial status and future changes. This is distinct from
  // measured control availability. Cleanup prevents React unmounts retaining stale listeners.

  getConnected(): boolean { return this.connected; }
  // This reports WebSocket transport only. Visual consumers should use getDisplayState instead.
  // A connected but silent server can still have stale control evidence.

  private setConnected(value: boolean): void {
    this.connected = value; this.store.setConnected(value);
    this.statusListeners.forEach(listener => listener(value));
  }
  // Connection transitions reset the snapshot baseline and notify observers together.
  // They never reset deduplication history. Reconnect therefore cannot resurrect an old action.

  private detach(socket: WebSocket): void { socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null; }
  // Removing callbacks severs the obsolete socket's ownership of this client. It also avoids
  // scheduling retries during explicit cleanup. Closing is performed separately by the caller.

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; if (this.running) this.connect(); }, 2500);
  }
  // One cancellable timer backs reconnection without retaining motor commands. The 2.5-second
  // retry is inherited from the existing bridge. Explicit disconnect wins any timer race.
}
// Module summary: This transport feeds a deterministic evidence store and emits fresh actions.
// Socket replacement, teardown and backpressure discard obsolete work. Actual djay acceptance
// remains observable only through AX read-back, not through successful WebSocket sends.
