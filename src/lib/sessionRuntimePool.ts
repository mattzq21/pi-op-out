import type { SessionSummary } from "../types";
import { NativeTransport, type NativeConnectionTarget } from "./nativeTransport";

const sessionKey = (hostId: string, sessionId: string) => `${hostId}:${sessionId}`;

export class SessionRuntimePool {
  private readonly transports = new Set<NativeTransport>();
  private readonly sessions = new Map<string, NativeTransport>();
  private readonly runningTransports = new Set<NativeTransport>();
  private readonly unseenTransports = new Set<NativeTransport>();
  private readonly listeners = new Set<() => void>();
  private runningSessionKeys: ReadonlySet<string> = new Set();
  private unseenSessionKeys: ReadonlySet<string> = new Set();
  private activeTransport?: NativeTransport;

  private publishSessionStates() {
    const running = new Set([...this.sessions].filter(([, transport]) => this.runningTransports.has(transport)).map(([key]) => key));
    const unseen = new Set([...this.sessions].filter(([, transport]) => this.unseenTransports.has(transport)).map(([key]) => key));
    const runningChanged = running.size !== this.runningSessionKeys.size || [...running].some((key) => !this.runningSessionKeys.has(key));
    const unseenChanged = unseen.size !== this.unseenSessionKeys.size || [...unseen].some((key) => !this.unseenSessionKeys.has(key));
    if (!runningChanged && !unseenChanged) return;
    this.runningSessionKeys = running; this.unseenSessionKeys = unseen; for (const listener of this.listeners) listener();
  }

  create(target?: NativeConnectionTarget) {
    const transport = new NativeTransport(target); this.transports.add(transport);
    transport.subscribe((event) => {
      if (event.type === "agent_start" || event.type === "message_start") { this.runningTransports.add(transport); this.unseenTransports.delete(transport); }
      if (event.type === "agent_end" || event.type === "agent_settled") { this.runningTransports.delete(transport); if (transport !== this.activeTransport) this.unseenTransports.add(transport); }
      if (event.type === "disconnected") this.runningTransports.delete(transport);
      this.publishSessionStates();
    });
    return transport;
  }

  forSession(session: SessionSummary) {
    const hostId = session.hostId ?? "local"; const key = sessionKey(hostId, session.id);
    const existing = this.sessions.get(key); if (existing) return existing;
    const transport = this.create({ cwd: session.cwd, sessionPath: session.path, hostId }); this.sessions.set(key, transport); return transport;
  }

  bind(hostId: string, sessionId: string, transport: NativeTransport) {
    for (const [key, candidate] of this.sessions) if (candidate === transport) this.sessions.delete(key);
    this.sessions.set(sessionKey(hostId, sessionId), transport); this.publishSessionStates();
  }

  activate(transport?: NativeTransport) { this.activeTransport = transport; if (transport) this.unseenTransports.delete(transport); this.publishSessionStates(); }

  async remove(session: SessionSummary) {
    const key = sessionKey(session.hostId ?? "local", session.id); const transport = this.sessions.get(key); this.sessions.delete(key);
    if (transport) { this.transports.delete(transport); this.runningTransports.delete(transport); this.unseenTransports.delete(transport); this.publishSessionStates(); await transport.disconnect(); }
  }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  runningSessions() { return this.runningSessionKeys; }
  unseenSessions() { return this.unseenSessionKeys; }

  async disconnectAll() { await Promise.allSettled([...this.transports].map((transport) => transport.disconnect())); }
}
