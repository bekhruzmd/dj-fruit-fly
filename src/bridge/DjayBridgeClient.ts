import { BridgeStateStore, parseMessage, type BridgeAction, type BridgeDisplayState } from './protocol';
export interface BridgeControlPayload { crossfader: number; filterCutoff: number; stutter: boolean }
export type ConnectionStatusListener = (connected: boolean) => void;

export class DjayBridgeClient {
  private ws: WebSocket | null = null;
  private running = false;
  public lastError: string | null = null;
  private connected = false;
  private statusListeners = new Set<ConnectionStatusListener>();
  private actionListeners = new Set<(action: BridgeAction) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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
        this.setConnected(true);
      };
      socket.onmessage = event => {
        if (this.ws !== socket || !this.running || typeof event.data !== 'string') return;
        const action = this.store.receive(event.data, performance.now());
        const message = parseMessage(event.data);
        if (message?.action?.status === 'rejected') this.lastError = message.action.reason;
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

  transitionCommand(operation: 'prepare' | 'start' | 'stop' | 'heartbeat' | 'press', options: {
    liveAudio?: boolean; source?: number; bpm?: number; confirmed?: boolean; field?: string;
  } = {}): boolean {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 4096) {
      if (operation !== 'heartbeat') this.lastError = 'Bridge unavailable. Start npm run bridge.';
      return false;
    }
    if (operation !== 'heartbeat') this.lastError = null;
    try {
      socket.send(JSON.stringify({ version: 1, kind: 'transition', operation,
        commandId: `${this.clientId}:${++this.commandSequence}`, ...options }));
      return true;
    } catch {
      this.lastError = 'Could not send the command. Check the bridge connection.';
      return false;
    }
  }

  getTransitionState(now = performance.now()) { return this.store.transition(now); }

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
