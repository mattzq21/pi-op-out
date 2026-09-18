export interface HostConnection { url: string; token: string }
export type RemoteEvent = { event: string; payload: unknown };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export function validateHost(connection: HostConnection): string {
  const url = new URL(connection.url);
  if (url.protocol !== "wss:") throw new Error("Use a secure wss:// address for your Piop host.");
  if (url.username || url.password || url.search || url.hash) throw new Error("The host address must not contain credentials, a query, or a fragment.");
  const tokenVisible = connection.token.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, "").trim();
  if (tokenVisible.length < 32) throw new Error("Enter the host’s pairing token (at least 32 characters).");
  return url.href;
}

/** A dropped connection rejects calls. Mutations are deliberately never retried. */
export class RemoteClient {
  private socket?: WebSocket;
  private sequence = 0;
  private ready = false;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(event: RemoteEvent) => void>>();
  private heartbeat?: ReturnType<typeof setInterval>;
  onDisconnect?: (message: string) => void;
  async connect(connection: HostConnection): Promise<void> {
    this.close();
    const socket = new WebSocket(validateHost(connection));
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      let settled = false;
      const settleReject = (error: Error) => { if (!settled) { settled = true; reject(error); } };
      const settleResolve = () => { if (!settled) { settled = true; resolve(); } };
      const timer = setTimeout(() => { reject(new Error("Connection timed out. Check the host address and TLS proxy.")); socket.close(); }, 15000);
      socket.onopen = () => socket.send(JSON.stringify({ type: "authenticate", token: connection.token }));
      socket.onmessage = ({ data }) => {
        let message: Record<string, unknown>;
        try { message = JSON.parse(String(data)); } catch { socket.close(); return; }
        if (message.type === "ready" && message.protocol === 1) {
          ready = true; this.ready = true; clearTimeout(timer);
          this.heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" })); }, 20000);
          settleResolve(); return;
        }
        if (ready) this.receive(message);
      };
      socket.onerror = () => { if (!ready) settleReject(new Error("Could not connect. Check the address, trusted TLS certificate, and host availability.")); };
      socket.onclose = () => {
        clearTimeout(timer);
        // Preserve the first specific error: a rejected promise must not be
        // overwritten by the generic disconnect notice.
        if (!ready) settleReject(new Error("Host rejected the connection. Check your pairing token."));
        if (this.socket !== socket) return;
        this.failPending();
        // Only report a generic disconnect for established connections; the
        // specific connect error above already covers the never-connected case.
        if (ready) this.onDisconnect?.("Connection lost. Reconnect to reload saved conversations. A command sent just before disconnection may have completed on the host.");
      };
    });
  }
  private receive(message: Record<string, unknown>) {
    if (typeof message.event === "string") {
      this.listeners.get(message.event)?.forEach((listener) => listener({ event: String(message.event), payload: message.payload }));
      return;
    }
    const request = this.pending.get(Number(message.id));
    if (!request) return;
    clearTimeout(request.timer); this.pending.delete(Number(message.id));
    if (typeof message.error === "string") request.reject(new Error(message.error)); else request.resolve(message.result);
  }
  invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    if (!this.ready || !socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Connect to your Piop host first."));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Host request timed out; it may still complete. Refresh before trying again.")); }, 660000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      socket.send(JSON.stringify({ id, command, args }));
    });
  }
  listen<T>(event: string, handler: (event: { event: string; payload: T; id: number }) => void): Promise<() => void> {
    const listener = (value: RemoteEvent) => handler({ ...value, payload: value.payload as T, id: 0 });
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener); this.listeners.set(event, listeners);
    return Promise.resolve(() => { listeners.delete(listener); });
  }
  private failPending() {
    this.ready = false;
    clearInterval(this.heartbeat);
    this.pending.forEach(({ timer, reject }) => { clearTimeout(timer); reject(new Error("Disconnected from host; the command may have completed.")); });
    this.pending.clear();
  }
  close() {
    const socket = this.socket; this.socket = undefined;
    socket?.close(); this.failPending();
  }
}
export const remoteClient = new RemoteClient();
