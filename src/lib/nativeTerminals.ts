import { voidResultSchema } from "./responseSchemas";
import { nativeCall, type NativeCall } from "./nativeCall";
import { z } from "zod";
import { listen } from "./platform";

const terminalEventSchema = z.object({ type: z.string().optional(), hostId: z.string().optional(), sessionId: z.string().optional(), terminalId: z.string().optional(), generation: z.string().optional(), outputEnd: z.number().optional(), data: z.string().optional() }).catch({});
export type TerminalEvent = z.infer<typeof terminalEventSchema>;

const sharedTerminalsSchema = z.array(z.object({ id: z.string(), output: z.string().nullable(), outputEnd: z.number(), generation: z.string(), owned: z.boolean(), started: z.boolean(), exited: z.boolean() }));
type SharedTerminal = z.infer<typeof sharedTerminalsSchema>[number] & { output: string };

class NativeTerminals {
  private writes = new Map<string, Promise<void>>();
  private starts = new Map<string, Promise<void>>();
  private hosts = new Map<string, string>();
  private transcripts = new Map<string, { generation: string; outputEnd: number; output: string; sessionKey: string; hostId: string }>();
  private cacheRevision = 0;
  private reassignments = new Map<string, Promise<void>>();

  constructor(private call: NativeCall) {}

  listen(onEvent: (event: TerminalEvent) => void) {
    return listen("pi://event", event => { if (event.payload.type?.startsWith("terminal_")) onEvent(event.payload); }, terminalEventSchema);
  }

  private command(action: string, terminalId: string, args: Record<string, unknown> = {}) {
    return this.call("shared_terminal", { action, sharedTerminalId: terminalId, hostId: this.hosts.get(terminalId) ?? "local", ...args }, voidResultSchema);
  }

  async list(sessionKey: string, hostId: string): Promise<SharedTerminal[]> {
    await this.reassignments.get(sessionKey);
    const revision = this.cacheRevision;
    const cached = new Map([...this.transcripts].filter(([, value]) => value.sessionKey === sessionKey && value.hostId === hostId));
    const known = Object.fromEntries([...cached].map(([id, value]) => [id, { generation: value.generation, outputEnd: value.outputEnd }]));
    const response = await this.call("shared_terminal", { action: "list", sessionKey, hostId, known }, sharedTerminalsSchema);
    if (revision !== this.cacheRevision) return this.list(sessionKey, hostId);
    const terminals = response.map(terminal => ({ ...terminal, output: terminal.output ?? cached.get(terminal.id)?.output ?? "" }));
    const ids = new Set(terminals.map(terminal => terminal.id));
    for (const [id, value] of this.transcripts) {
      if (value.sessionKey === sessionKey && value.hostId === hostId && !ids.has(id)) {
        this.transcripts.delete(id);
        this.hosts.delete(id);
      }
    }
    for (const terminal of terminals) {
      this.transcripts.set(terminal.id, { ...terminal, sessionKey, hostId });
      this.hosts.set(terminal.id, hostId);
    }
    return terminals;
  }

  start(terminalId: string, sessionKey: string, cwd: string, cols: number, rows: number, hostId: string) {
    this.hosts.set(terminalId, hostId);
    const pending = this.command("start", terminalId, { sessionKey, cwd, cols, rows });
    this.starts.set(terminalId, pending);
    const clear = () => { if (this.starts.get(terminalId) === pending) this.starts.delete(terminalId); };

    void pending.then(clear, clear);

    return pending;
  }

  write(terminalId: string, data: string) {
    const starting = this.starts.get(terminalId);

    const next = (this.writes.get(terminalId) ?? Promise.resolve()).catch(() => undefined)
      .then(() => starting).then(() => this.command("write", terminalId, { data }));

    this.writes.set(terminalId, next);
    const clear = () => { if (this.writes.get(terminalId) === next) this.writes.delete(terminalId); };

    void next.then(clear, clear);

    return next;
  }

  resize(terminalId: string, cols: number, rows: number) {
    const starting = this.starts.get(terminalId);
    const next = (this.writes.get(terminalId) ?? Promise.resolve()).catch(() => undefined)
      .then(() => starting).then(() => this.command("resize", terminalId, { cols, rows }));
    this.writes.set(terminalId, next);
    const clear = () => { if (this.writes.get(terminalId) === next) this.writes.delete(terminalId); };
    void next.then(clear, clear);

    return next;
  }

  reassign(terminalId: string, sessionKey: string) {
    const pending = Promise.all([this.starts.get(terminalId), this.reassignments.get(sessionKey)])
      .then(() => this.command("reassign", terminalId, { sessionKey }))
      .then(() => {
        this.cacheRevision += 1;
        const cached = this.transcripts.get(terminalId);
        if (cached) this.transcripts.set(terminalId, { ...cached, sessionKey });
      });
    this.reassignments.set(sessionKey, pending);
    const clear = () => { if (this.reassignments.get(sessionKey) === pending) this.reassignments.delete(sessionKey); };
    void pending.then(clear, clear);
    return pending;
  }

  async close(terminalId: string) {
    await this.starts.get(terminalId)?.catch(() => undefined);
    await this.writes.get(terminalId)?.catch(() => undefined);
    this.writes.delete(terminalId);

    await this.command("close", terminalId);
    this.cacheRevision += 1;
    this.transcripts.delete(terminalId);
    this.hosts.delete(terminalId);
  }
}

export const nativeTerminals = new NativeTerminals(nativeCall);
