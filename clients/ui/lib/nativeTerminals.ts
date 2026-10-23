import { voidResultSchema } from "./responseSchemas";
import { nativeCall, type NativeCall } from "./nativeCall";
import { z } from "zod";
import { captureDaemonTransport, isMobile, listen } from "./platform";
import { whenBranchesSettled } from "./branchActivity";

const terminalEventSchema = z.object({ type: z.string().optional(), hostId: z.string().optional(), sessionId: z.string().optional(), terminalId: z.string().optional(), generation: z.string().optional(), outputEnd: z.number().optional(), data: z.string().optional() }).catch({});

export type TerminalEvent = z.infer<typeof terminalEventSchema>;

const sharedTerminalsSchema = z.array(z.object({ id: z.string(), output: z.string().nullable(), outputEnd: z.number(), inputDraft: z.string().optional(), generation: z.string(), owned: z.boolean(), started: z.boolean(), exited: z.boolean() }));

export type SharedTerminal = z.infer<typeof sharedTerminalsSchema>[number] & { output: string };

type TerminalCommandOptions = { sessionKey?: string; cwd?: string; cols?: number; rows?: number; data?: string; expectedDraft?: string };

export const TRANSCRIPT_BYTE_LIMIT = 32 * 1024 * 1024;

class NativeTerminals {
  /** Per terminal: the end of its command queue, and a draft write that has not started. A newer draft replaces the text of that write. */
  private writes = new Map<string, { tail: Promise<void>; draft?: { args: TerminalCommandOptions; result: Promise<void> } }>();
  private starts = new Map<string, Promise<void>>();
  private hosts = new Map<string, string>();
  private generations = new Map<string, string>();
  private transcripts = new Map<string, { generation: string; outputEnd: number; output: string; sessionKey: string; hostId: string; lastUsed: number }>();
  private activeSession?: { sessionKey: string; hostId: string };
  private transcriptAccess = 0;
  private cacheRevision = 0;
  private reassignments = new Map<string, Promise<void>>();
  private terminalReassignments = new Map<string, Promise<void>>();

  constructor(private call: NativeCall) {}

  invalidateWrites(hostId?: string) {
    if (hostId === undefined) this.writes.clear();
    else for (const terminalId of this.writes.keys()) {
      if ((this.hosts.get(terminalId) ?? "local") === hostId) this.writes.delete(terminalId);
    }
  }

  listen(onEvent: (event: TerminalEvent) => void) {
    return listen("pi://event", event => {
      const { type, terminalId, generation } = event.payload;

      if (terminalId && type?.startsWith("terminal_")) {
        const previous = this.generations.get(terminalId) ?? this.transcripts.get(terminalId)?.generation;

        if (type === "terminal_exit" || generation !== undefined && previous !== undefined && generation !== previous) this.writes.delete(terminalId);
        if (generation !== undefined) this.generations.set(terminalId, generation);
      }

      if (type?.startsWith("terminal_")) onEvent(event.payload);
    }, terminalEventSchema);
  }

  private command(action: string, terminalId: string, args: TerminalCommandOptions = {}) {
    return this.call("shared_terminal", { action, sharedTerminalId: terminalId, hostId: this.hosts.get(terminalId) ?? "local", ...args }, voidResultSchema);
  }

  private trimTranscripts() {
    let bytes = [...this.transcripts.values()].reduce((total, value) => total + value.output.length * 2, 0);

    if (bytes <= TRANSCRIPT_BYTE_LIMIT) return;
    for (const [id, value] of [...this.transcripts].sort(([, left], [, right]) => left.lastUsed - right.lastUsed)) {
      if (bytes <= TRANSCRIPT_BYTE_LIMIT) break;
      if (value.sessionKey === this.activeSession?.sessionKey && value.hostId === this.activeSession.hostId) continue;
      this.transcripts.delete(id);
      bytes -= value.output.length * 2;
    }
  }

  list(sessionKey: string, hostId: string): Promise<SharedTerminal[]> {
    this.activeSession = { sessionKey, hostId };
    const lastUsed = ++this.transcriptAccess;

    for (const value of this.transcripts.values()) {
      if (value.sessionKey === sessionKey && value.hostId === hostId) value.lastUsed = lastUsed;
    }

    this.trimTranscripts();

    return this.loadList(sessionKey, hostId, lastUsed);
  }

  private async loadList(sessionKey: string, hostId: string, lastUsed: number): Promise<SharedTerminal[]> {
    await this.reassignments.get(sessionKey)?.catch(() => undefined);
    const revision = this.cacheRevision;
    const cached = new Map([...this.transcripts].filter(([, value]) => value.sessionKey === sessionKey && value.hostId === hostId));
    const known = Object.fromEntries([...cached].map(([id, value]) => [id, { generation: value.generation, outputEnd: value.outputEnd }]));
    const response = await this.call("shared_terminal", { action: "list", sessionKey, hostId, known }, sharedTerminalsSchema);

    if (revision !== this.cacheRevision) return this.loadList(sessionKey, hostId, lastUsed);
    const terminals = response.map(terminal => ({ ...terminal, output: terminal.output ?? cached.get(terminal.id)?.output ?? "" }));
    const ids = new Set(terminals.map(terminal => terminal.id));

    for (const [id, value] of this.transcripts) {
      if (value.sessionKey === sessionKey && value.hostId === hostId && !ids.has(id)) {
        this.writes.delete(id);
        this.transcripts.delete(id);
        this.hosts.delete(id);
        this.generations.delete(id);
      }
    }

    for (const terminal of terminals) {
      const previous = this.generations.get(terminal.id) ?? this.transcripts.get(terminal.id)?.generation;
      const previousHost = this.hosts.get(terminal.id);

      if (previous !== undefined && previous !== terminal.generation || previousHost !== undefined && previousHost !== hostId) this.writes.delete(terminal.id);
      this.generations.set(terminal.id, terminal.generation);
      this.transcripts.set(terminal.id, { ...terminal, sessionKey, hostId, lastUsed: Math.max(lastUsed, this.transcripts.get(terminal.id)?.lastUsed ?? 0) });
      this.hosts.set(terminal.id, hostId);
    }

    this.trimTranscripts();

    return terminals;
  }

  start(terminalId: string, sessionKey: string, cwd: string, cols: number, rows: number, hostId: string) {
    this.writes.delete(terminalId);
    this.hosts.set(terminalId, hostId);
    const pending = this.command("start", terminalId, { sessionKey, cwd, cols, rows });
    this.starts.set(terminalId, pending);
    const clear = () => { if (this.starts.get(terminalId) === pending) this.starts.delete(terminalId); };

    void pending.then(clear, clear);

    return pending;
  }

  private enqueue(action: string, terminalId: string, args: TerminalCommandOptions) {
    const starting = this.starts.get(terminalId);
    const connection = captureDaemonTransport();
    const queue: { tail: Promise<void>; draft?: { args: TerminalCommandOptions; result: Promise<void> } } = this.writes.get(terminalId) ?? { tail: Promise.resolve() };
    const draft = action === "draft" ? { args } : undefined;

    if (draft && queue.draft) { queue.draft.args = args;

    return queue.draft.result; }

    queue.draft = undefined;

    const next = queue.tail.then(() => starting).then(() => whenBranchesSettled())
      .then(() => this.terminalReassignments.get(terminalId))
      .then(() => {
        if (queue.draft?.result === next) queue.draft = undefined;

        if (this.writes.get(terminalId) !== queue || !connection.active()) throw new Error("Terminal connection changed. Enter the input again.");

        return this.command(action, terminalId, draft?.args ?? args);
      });

    if (draft) queue.draft = Object.assign(draft, { result: next });
    queue.tail = next;
    this.writes.set(terminalId, queue);
    const clear = () => { if (this.writes.get(terminalId) === queue && queue.tail === next) this.writes.delete(terminalId); };

    void next.then(clear, clear);

    return next;
  }

  write(terminalId: string, data: string, action = isMobile ? "write" : "write_with_draft") {
    return this.enqueue(action, terminalId, { data });
  }

  writeAndClearDraft(terminalId: string, data: string, expectedDraft: string) {
    return this.enqueue("write_and_clear_draft", terminalId, { data, expectedDraft });
  }

  /** Sends Ctrl+C at once, before queued input. The draft clears through the queue, so an older draft write cannot restore it. */
  async interrupt(terminalId: string) {
    const connection = captureDaemonTransport();
    const clearing = this.write(terminalId, "", "draft");
    await this.starts.get(terminalId);

    if (!connection.active()) throw new Error("Terminal connection changed. Press Ctrl+C again.");
    await this.command("write", terminalId, { data: "\u0003" });
    await clearing;
  }

  resize(terminalId: string, cols: number, rows: number) {
    return this.enqueue("resize", terminalId, { cols, rows });
  }

  reassign(terminalId: string, sessionKey: string) {
    const pending = Promise.all([
      this.starts.get(terminalId),
      this.reassignments.get(sessionKey)?.catch(() => undefined),
      this.terminalReassignments.get(terminalId)?.catch(() => undefined),
    ])
      .then(() => this.command("reassign", terminalId, { sessionKey }))
      .then(() => {
        this.cacheRevision += 1;
        const cached = this.transcripts.get(terminalId);

        if (cached) this.transcripts.set(terminalId, { ...cached, sessionKey });
        this.trimTranscripts();
      });

    this.reassignments.set(sessionKey, pending);
    this.terminalReassignments.set(terminalId, pending);

    const clear = () => {
      if (this.reassignments.get(sessionKey) === pending) this.reassignments.delete(sessionKey);

      if (this.terminalReassignments.get(terminalId) === pending) this.terminalReassignments.delete(terminalId);
    };

    void pending.then(clear, clear);

    return pending;
  }

  async close(terminalId: string) {
    const pending = this.writes.get(terminalId)?.tail;
    this.writes.delete(terminalId);
    await whenBranchesSettled();
    await this.terminalReassignments.get(terminalId)?.catch(() => undefined);
    await this.starts.get(terminalId)?.catch(() => undefined);
    await pending?.catch(() => undefined);
    this.writes.delete(terminalId);

    await this.command("close", terminalId);
    this.cacheRevision += 1;
    this.transcripts.delete(terminalId);
    this.hosts.delete(terminalId);
    this.generations.delete(terminalId);
  }

  closeUnused(terminalId: string) {
    return this.enqueue("close_unused", terminalId, {});
  }
}

export const nativeTerminals = new NativeTerminals(nativeCall);
