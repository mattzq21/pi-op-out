import type { GitDiffSnapshots, SessionSummary } from "../types";
import { NativeTransport, type NativeConnectionTarget } from "./nativeTransport";
import { branchMessages, type PiEntry } from "./messages";
import { textOf } from "./content";

const sessionKey = (hostId: string, sessionId: string) => `${hostId}:${sessionId}`;
const EMPTY_DIFFS: GitDiffSnapshots = {};
type DiffState = { snapshots: GitDiffSnapshots; path?: string; load?: { key: string; promise: Promise<GitDiffSnapshots> }; baseline?: { cwd: string; hostId: string; tree: Promise<string | null> }; revision: number; timer?: ReturnType<typeof setTimeout> };

function latestAssistantEntry(entries: PiEntry[], leafId: string | null) {
  return [...branchMessages(entries, leafId)].reverse().find((message) => message.role === "assistant" && (textOf(message.content).trim() || message.stopReason === "aborted" || message.stopReason === "error"));
}

export class SessionRuntimePool {
  private readonly transports = new Set<NativeTransport>();
  private readonly sessions = new Map<string, NativeTransport>();
  private readonly runningTransports = new Set<NativeTransport>();
  private readonly unseenTransports = new Set<NativeTransport>();
  private readonly diffStates = new Map<NativeTransport, DiffState>();
  private readonly listeners = new Set<() => void>();
  private runningSessionKeys: ReadonlySet<string> = new Set();
  private unseenSessionKeys: ReadonlySet<string> = new Set();
  private activeTransport?: NativeTransport;

  private notify() { for (const listener of this.listeners) listener(); }

  private diffState(transport: NativeTransport) { let state = this.diffStates.get(transport); if (!state) { state = { snapshots: EMPTY_DIFFS, revision: 0 }; this.diffStates.set(transport, state); } return state; }

  private loadSavedDiffs(transport: NativeTransport, sessionPath: string) {
    const key = `${transport.currentHostId()}:${sessionPath}`;
    const state = this.diffState(transport); if (state.load?.key === key) return state.load.promise;
    state.path = key;
    const promise = transport.loadGitDiffs(sessionPath, transport.currentHostId()).then((snapshots) => {
      if (state.path === key) { state.snapshots = snapshots; this.notify(); }
      return snapshots;
    }).catch(() => {
      if (state.path === key) { state.snapshots = EMPTY_DIFFS; this.notify(); }
      return EMPTY_DIFFS;
    });
    state.load = { key, promise }; return promise;
  }

  private captureTurnStart(transport: NativeTransport) {
    const cwd = transport.currentCwd(); if (!cwd) return;
    const state = this.diffState(transport); state.revision += 1;
    if (state.timer) clearTimeout(state.timer);
    state.baseline = { cwd, hostId: transport.currentHostId(), tree: transport.captureGitTree(cwd, transport.currentHostId()).catch(() => null) };
  }

  private captureTurnEnd(transport: NativeTransport) {
    const diffState = this.diffState(transport); const baseline = diffState.baseline; if (!baseline) return;
    const revision = ++diffState.revision;
    if (diffState.timer) clearTimeout(diffState.timer);
    diffState.timer = setTimeout(() => {
      diffState.timer = undefined;
      void Promise.all([
        baseline.tree,
        transport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" }),
        transport.command<{ sessionFile?: string }>({ type: "get_state" }),
      ]).then(async ([baseTree, history, state]) => {
        if (revision !== diffState.revision || !baseTree || !state.sessionFile) return;
        const [snapshot, saved] = await Promise.all([
          transport.loadGitDiff(baseline.cwd, baseTree, baseline.hostId),
          this.loadSavedDiffs(transport, state.sessionFile),
        ]);
        if (revision !== diffState.revision || !snapshot) return;
        const message = latestAssistantEntry(history.entries, history.leafId); if (!message) return;
        const snapshots = { ...saved, [message.id]: snapshot };
        const key = `${baseline.hostId}:${state.sessionFile}`;
        diffState.snapshots = snapshots; diffState.path = key; diffState.load = { key, promise: Promise.resolve(snapshots) }; this.notify();
        await transport.saveGitDiffs(state.sessionFile, snapshots, baseline.hostId);
      }).catch(() => undefined);
    }, 35);
  }

  private publishSessionStates() {
    const running = new Set([...this.sessions].filter(([, transport]) => this.runningTransports.has(transport)).map(([key]) => key));
    const unseen = new Set([...this.sessions].filter(([, transport]) => this.unseenTransports.has(transport)).map(([key]) => key));
    const runningChanged = running.size !== this.runningSessionKeys.size || [...running].some((key) => !this.runningSessionKeys.has(key));
    const unseenChanged = unseen.size !== this.unseenSessionKeys.size || [...unseen].some((key) => !this.unseenSessionKeys.has(key));
    if (!runningChanged && !unseenChanged) return;
    this.runningSessionKeys = running; this.unseenSessionKeys = unseen; this.notify();
  }

  create(target?: NativeConnectionTarget) {
    const transport = new NativeTransport(target); this.transports.add(transport);
    if (transport.currentSessionPath()) void this.loadSavedDiffs(transport, transport.currentSessionPath()!);
    transport.subscribe((event) => {
      if (event.type === "agent_start") this.captureTurnStart(transport);
      if (event.type === "agent_end" || event.type === "agent_settled") this.captureTurnEnd(transport);
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
    this.sessions.set(sessionKey(hostId, sessionId), transport);
    const sessionPath = transport.currentSessionPath(); if (sessionPath) void this.loadSavedDiffs(transport, sessionPath);
    this.publishSessionStates();
  }

  activate(transport?: NativeTransport) { this.activeTransport = transport; if (transport) this.unseenTransports.delete(transport); this.publishSessionStates(); }

  async remove(session: SessionSummary) {
    const key = sessionKey(session.hostId ?? "local", session.id); const transport = this.sessions.get(key); this.sessions.delete(key);
    if (transport) {
      const diffState = this.diffStates.get(transport); if (diffState?.timer) clearTimeout(diffState.timer);
      this.transports.delete(transport); this.runningTransports.delete(transport); this.unseenTransports.delete(transport);
      this.diffStates.delete(transport);
      this.publishSessionStates(); await transport.disconnect();
    }
  }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  runningSessions() { return this.runningSessionKeys; }
  unseenSessions() { return this.unseenSessionKeys; }
  gitDiffs(transport: NativeTransport) { return this.diffStates.get(transport)?.snapshots ?? EMPTY_DIFFS; }

  async disconnectAll() { await Promise.allSettled([...this.transports].map((transport) => transport.disconnect())); }
}
