import { z, type JSONType } from "zod";
import { jsonResultSchema, remotePacketSchema, type NativeArguments, type RemotePacket } from "./transportSchemas";
import { isMobileDebugConnection, mobileDebugToken } from "./mobileDebug";
import { busyRetryDelay, HOST_BUSY } from "./backpressure";

export interface HostConnection { url: string }

export type RemoteEvent = { event: string; payload: JSONType | undefined };

const handshakePacketSchema = remotePacketSchema.extend({ buildId: z.string().optional() });

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
  private logStatuses = new Map<string, RemoteEvent>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private heartbeatCleanup?: () => void;
  onDisconnect?: (message: string) => void;
  connectionIdentity() { return this.destination; }
  /** True while the socket is open and the host accepted it. */
  isConnected() { return this.ready && this.socket?.readyState === WebSocket.OPEN; }
  async connect(connection: HostConnection): Promise<void> {
    const destination = validateHost(connection);
    this.close();
    this.destination = destination;
    const socket = new WebSocket(destination);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      let lastHeartbeat = Date.now();
      let pongs = 0;
      let settled = false;
      /** Why the connection ends, when the host or this client gave a reason. */
      let closeReason: string | undefined;
      const settleReject = (error: Error) => { if (!settled) { settled = true; reject(error); } };

      const settleResolve = () => { if (!settled) { settled = true; resolve(); } };

      const timer = setTimeout(() => { reject(new Error("Connection timed out. Check the host address and Tailscale Serve.")); socket.close(); }, 15000);
      socket.onopen = () => { socket.send(JSON.stringify(isMobileDebugConnection(destination) ? { type: "authenticate", token: mobileDebugToken(destination) } : { type: "authenticate", mode: "tailscale" })); };

      socket.onmessage = ({ data }) => {
        if (this.socket !== socket) return;
        let message: z.infer<typeof handshakePacketSchema>;

        try { message = handshakePacketSchema.parse(JSON.parse(String(data))); } catch (error) {
          closeReason = `The host sent an invalid message: ${error instanceof Error ? error.message : String(error)}`;
          settleReject(new Error(closeReason));
          socket.close();

        return; }

        if (message.type === "pong") { lastHeartbeat = Date.now(); pongs++;

        return; }

        if (message.type === "error" && !ready) {
          settleReject(new Error(message.error || "Host rejected the connection."));
          socket.close();

          return;
        }

        if (ready && message.event === undefined && message.id === undefined && message.error !== undefined) {
          closeReason = `The host closed the connection: ${message.error}`;

          return;
        }

        if (message.type === "ready" && !ready) {
          if (message.protocol !== 1) {
            settleReject(new Error(`Incompatible Piop daemon protocol ${message.protocol ?? "unknown"} (build ${message.buildId || "unknown"}); this phone requires protocol 1. Update the app and daemon.`));
            socket.close();

            return;
          }
          if (message.backend !== "daemon") {
            settleReject(new Error("Connect to a Piop daemon. This address belongs to an older desktop endpoint."));
            socket.close();

            return;
          }

          ready = true; this.ready = true; clearTimeout(timer);
          lastHeartbeat = Date.now();
          let lastTick = lastHeartbeat;
          let resumeCheck: ReturnType<typeof setTimeout> | undefined;
          const drop = () => {
            this.socket = undefined; this.failPending(); socket.close();
            this.onDisconnect?.("Connection stopped responding. Reconnecting…");
          };
          // Android can end the socket while the app is in the background without a close event. After a resume, a missing pong shows this fast.
          const resumeHeartbeat = () => {
            if (document.hidden || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
            const answered = pongs;
            lastTick = lastHeartbeat = Date.now();
            socket.send(JSON.stringify({ type: "ping" }));
            clearTimeout(resumeCheck);
            resumeCheck = setTimeout(() => { if (this.socket === socket && pongs === answered) drop(); }, 10000);
          };
          document.addEventListener("visibilitychange", resumeHeartbeat);
          this.heartbeatCleanup = () => { document.removeEventListener("visibilitychange", resumeHeartbeat); clearTimeout(resumeCheck); };
          this.heartbeat = setInterval(() => {
            if (this.socket !== socket) return;
            const now = Date.now();
            if (now - lastTick > 40000) lastHeartbeat = now;
            lastTick = now;
            if (now - lastHeartbeat > 65000) drop();
            else if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
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

        if (ready) this.onDisconnect?.(`${closeReason ? closeReason + ". " : ""}Connection lost. Reconnect to reload saved conversations. A command sent just before disconnection may have completed on the host.`);
      };
    });
  }
  publishLocalEvent(event: string, payload: JSONType) { this.receive({ event, payload }); }
  private receive(message: RemotePacket) {
    if (message.event !== undefined) {
      if (message.event === "pi://daemon-log-status") {
        const payload = z.object({ hostId: z.string(), failure: z.string().nullable() }).parse(message.payload);
        this.logStatuses.set(payload.hostId, { event: message.event, payload });
      }
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
      request.timer = setTimeout(() => { clearTimeout(request.retryTimer); this.pending.delete(id); reject(new Error("Host request timed out; it may still complete. Refresh before trying again.")); }, 660000);
      this.pending.set(id, request);
      request.retry();
    }).then(value => schema.parse(value));
  }

  private sendRequest(socket: WebSocket, packet: string, id: number, request: Pending) {
    try { socket.send(packet); }
    catch (reason) {
      clearTimeout(request.timer); clearTimeout(request.retryTimer); this.pending.delete(id);
      request.reject(reason instanceof Error ? reason : new Error((reason instanceof Error ? reason.message : String(reason))));
    }
  }

  listen<S extends z.ZodType>(event: string, handler: (event: { event: string; payload: z.output<S>; id: number }) => void, schema: S): Promise<() => void> {
    const listener = (value: RemoteEvent) => handler({ ...value, payload: schema.parse(value.payload), id: 0 });
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener); this.listeners.set(event, listeners);

    if (event === "pi://daemon-log-status") {
      try { for (const status of this.logStatuses.values()) listener(status); }
      catch (error) { listeners.delete(listener); return Promise.reject(error); }
    }
    return Promise.resolve(() => { listeners.delete(listener); });
  }
  private failPending() {
    const wasReady = this.ready;
    this.ready = false;
    for (const hostId of [...this.logStatuses.keys()]) this.receive({ event: "pi://daemon-log-status", payload: { hostId, failure: null } });
    this.logStatuses.clear();

    if (wasReady) this.receive({ event: "pi://event", payload: { type: "disconnected" } });
    clearInterval(this.heartbeat);
    this.heartbeatCleanup?.(); this.heartbeatCleanup = undefined;

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
