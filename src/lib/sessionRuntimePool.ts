import type { SessionSummary } from "../types";
import { NativeTransport, type NativeConnectionTarget } from "./nativeTransport";

const sessionKey = (hostId: string, sessionId: string) => `${hostId}:${sessionId}`;

export class SessionRuntimePool {
  private readonly transports = new Set<NativeTransport>();
  private readonly sessions = new Map<string, NativeTransport>();

  create(target?: NativeConnectionTarget) {
    const transport = new NativeTransport(target); this.transports.add(transport); return transport;
  }

  forSession(session: SessionSummary) {
    const hostId = session.hostId ?? "local"; const key = sessionKey(hostId, session.id);
    const existing = this.sessions.get(key); if (existing) return existing;
    const transport = this.create({ cwd: session.cwd, sessionPath: session.path, hostId }); this.sessions.set(key, transport); return transport;
  }

  bind(hostId: string, sessionId: string, transport: NativeTransport) {
    for (const [key, candidate] of this.sessions) if (candidate === transport) this.sessions.delete(key);
    this.sessions.set(sessionKey(hostId, sessionId), transport);
  }

  async remove(session: SessionSummary) {
    const key = sessionKey(session.hostId ?? "local", session.id); const transport = this.sessions.get(key); this.sessions.delete(key);
    if (transport) { this.transports.delete(transport); await transport.disconnect(); }
  }

  async disconnectAll() { await Promise.allSettled([...this.transports].map((transport) => transport.disconnect())); }
}
