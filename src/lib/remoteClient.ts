import { z, type JSONType } from "zod";
import { jsonResultSchema, remotePacketSchema, type NativeArguments, type RemotePacket } from "./transportSchemas";
import { isMobileDebugConnection } from "./mobileDebug";
import { busyRetryDelay, HOST_BUSY } from "./backpressure";

export interface HostConnection { url: string }

export type RemoteEvent = { event: string; payload: JSONType | undefined };

type Pending = { resolve: (value: JSONType | undefined) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout>; retryTimer?: ReturnType<typeof setTimeout>; retries: number; retry: () => void };

export function validateHost(connection: HostConnection): string {
  const url = new URL(connection.url);

  if (url.protocol !== "wss:" && !isMobileDebugConnection(url.href)) throw new Error("Use a secure wss:// address for your Piop host.");

  if (url.username || url.password || url.search || url.hash) throw new Error("The host address must not contain credentials, a query, or a fragment.");

  return url.href;
}

export class RemoteClient {
  private socket?: WebSocket;
  private destination?: string;
  private sequence = 0;
  private ready = false;
  private pending = new Map<number, Pending>();
  private terminals = new Set<string>();
  private listeners = new Map<string, Set<(event: RemoteEvent) => void>>();
  private heartbeat?: ReturnType<typeof setInterval>;
  onDisconnect?: (message: string) => void;
  connectionIdentity() { return this.destination; }
  async connect(connection: HostConnection): Promise<void> {
    const destination = validateHost(connection);
    this.close();
    this.destination = destination;
    const socket = new WebSocket(destination);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      let lastHeartbeat = Date.now();
      let settled = false;
      const settleReject = (error: Error) => { if (!settled) { settled = true; reject(error); } };

      const settleResolve = () => { if (!settled) { settled = true; resolve(); } };

      const timer = setTimeout(() => { reject(new Error("Connection timed out. Check the host address and Tailscale Serve.")); socket.close(); }, 15000);
      socket.onopen = () => { if (!isMobileDebugConnection(validateHost(connection))) socket.send(JSON.stringify({ type: "authenticate", mode: "tailscale" })); };

      socket.onmessage = ({ data }) => {
        if (this.socket !== socket) return;
        let message: RemotePacket;

        try { message = remotePacketSchema.parse(JSON.parse(String(data))); } catch { socket.close();

        return; }

        if (message.type === "pong") { lastHeartbeat = Date.now();

        return; }

        if (message.type === "ready" && message.protocol === 1) {
          if (message.backend !== "daemon") {
            settleReject(new Error("Connect to a Piop daemon. This address belongs to an older desktop endpoint."));
            socket.close();

            return;
          }

          ready = true; this.ready = true; clearTimeout(timer);
          lastHeartbeat = Date.now();
          this.heartbeat = setInterval(() => {
            if (Date.now() - lastHeartbeat > 65000) {
              this.socket = undefined; this.failPending(); socket.close();
              this.onDisconnect?.("Connection stopped responding. Reconnecting…");
            } else if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
          }, 20000);
          settleResolve();
          this.receive({ event: "pi://event", payload: { type: "connection_restored" } });

          return;
        }

        if (ready) this.receive(message);
      };

      socket.onerror = () => { if (!ready) settleReject(new Error("Could not connect. Check the address, trusted TLS certificate, and host availability.")); };

      socket.onclose = () => {
        clearTimeout(timer);

        if (!ready) settleReject(new Error("Host rejected the connection. Check Tailscale Serve and sign both devices into the same Tailscale account."));

        if (this.socket !== socket) return;
        this.failPending();

        if (ready) this.onDisconnect?.("Connection lost. Reconnect to reload saved conversations. A command sent just before disconnection may have completed on the host.");
      };
    });
  }
  publishLocalEvent(event: string, payload: JSONType) { this.receive({ event, payload }); }
  private receive(message: RemotePacket) {
    if (message.event !== undefined) {
      const event = z.object({ type: z.string().optional(), terminalId: z.string().optional() }).catch({}).parse(message.payload);

      if (message.event === "pi://event" && event?.type === "terminal_exit" && event.terminalId) this.terminals.delete(event.terminalId);
      this.listeners.get(message.event)?.forEach((listener) => listener({ event: String(message.event), payload: message.payload }));

      return;
    }

    const request = this.pending.get(Number(message.id));

    if (!request) return;

    if (this.retryBusy(request, message.error)) return;

    clearTimeout(request.timer); this.pending.delete(Number(message.id));
    clearTimeout(request.retryTimer);

    if (message.error !== undefined) request.reject(new Error(message.error)); else request.resolve(message.result);
  }

  private retryBusy(request: Pending, error?: string) {
    const delay = error === HOST_BUSY ? busyRetryDelay(request.retries) : undefined;

    if (delay === undefined) return false;
    request.retries += 1;
    request.retryTimer = setTimeout(() => { request.retryTimer = undefined; request.retry(); }, delay);

    return true;
  }

  invoke<S extends z.ZodType>(command: string, args: NativeArguments | undefined, schema: S): Promise<z.output<S>>;
  invoke(command: string, args?: NativeArguments): Promise<JSONType | undefined>;
  invoke(command: string, args: NativeArguments = {}, schema: z.ZodType = jsonResultSchema) {
    const socket = this.socket;

    if (!this.ready || !socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Connect to your Piop host first."));
    const id = ++this.sequence;
    const packet = JSON.stringify({ id, command, args });

    if (new TextEncoder().encode(packet).byteLength > 32 * 1024 * 1024) return Promise.reject(new Error("This message exceeds the host's 32 MiB request limit. Remove an attachment or shorten the message."));

    if (command === "start_terminal" && args.terminalId !== undefined) this.terminals.add(args.terminalId);

    return new Promise<JSONType | undefined>((resolve, reject) => {
      const request: Pending = { resolve, reject, retries: 0, retry: () => { if (this.pending.get(id) === request) this.sendRequest(socket, packet, id, request); } };
      request.timer = command === "run_worktree_setup" ? undefined : setTimeout(() => { clearTimeout(request.retryTimer); this.pending.delete(id); reject(new Error("Host request timed out; it may still complete. Refresh before trying again.")); }, 660000);
      this.pending.set(id, request);
      request.retry();
    }).then(value => schema.parse(value));
  }

  private sendRequest(socket: WebSocket, packet: string, id: number, request: Pending) {
    try { socket.send(packet); }
    catch (reason) {
      clearTimeout(request.timer); clearTimeout(request.retryTimer); this.pending.delete(id);
      request.reject(reason instanceof Error ? reason : new Error(String(reason)));
    }
  }

  listen<S extends z.ZodType>(event: string, handler: (event: { event: string; payload: z.output<S>; id: number }) => void, schema: S): Promise<() => void> {
    const listener = (value: RemoteEvent) => handler({ ...value, payload: schema.parse(value.payload), id: 0 });
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener); this.listeners.set(event, listeners);

    return Promise.resolve(() => { listeners.delete(listener); });
  }
  private failPending() {
    const wasReady = this.ready;
    this.ready = false;

    if (wasReady) this.receive({ event: "pi://event", payload: { type: "disconnected" } });
    clearInterval(this.heartbeat);

    for (const terminalId of this.terminals) this.receive({ event: "pi://event", payload: { type: "terminal_exit", terminalId } });
    this.terminals.clear();
    this.pending.forEach(({ timer, retryTimer, reject }) => { clearTimeout(timer); clearTimeout(retryTimer); reject(new Error("Disconnected from host; the command may have completed.")); });
    this.pending.clear();
  }
  close() {
    const socket = this.socket; this.socket = undefined;
    socket?.close(); this.failPending();
  }
}

export const remoteClient = new RemoteClient();
