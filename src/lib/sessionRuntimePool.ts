import { useSyncExternalStore } from "react";
import type { AppSettings, ExtensionUiRequest, GitDiffSnapshots, SessionSummary } from "../types";
import { NativeTransport, type NativeConnectionTarget } from "./nativeTransport";
import { branchMessages, type PiEntry } from "./messages";
import { textOf } from "./content";
import { mergeDiffSnapshots } from "./turnDiff";

const sessionKey = (hostId: string, sessionId: string) => `${hostId}:${sessionId}`;
const EMPTY_DIFFS: GitDiffSnapshots = {};
type DiffBaseline = { cwd: string; hostId: string; tree: Promise<string | null> };
type DiffState = { snapshots: GitDiffSnapshots; path?: string; load?: { key: string; promise: Promise<GitDiffSnapshots> }; baselines: DiffBaseline[]; captureQueue: Promise<void>; persistence: "session" | "memory" };

function latestAssistantEntry(entries: PiEntry[], leafId: string | null) {
  return [...branchMessages(entries, leafId)].reverse().find((message) => message.role === "assistant" && (textOf(message.content).trim() || message.stopReason === "aborted" || message.stopReason === "error"));
}

export class SessionRuntimePool {
  private readonly transports = new Set<NativeTransport>();
  private readonly sessions = new Map<string, NativeTransport>();
  private readonly runningTransports = new Set<NativeTransport>();
  private readonly unseenTransports = new Set<NativeTransport>();
  private readonly interactiveTransports = new Set<NativeTransport>();
  private readonly retainedTransports = new Set<NativeTransport>();
  private readonly diffStates = new Map<NativeTransport, DiffState>();
  private readonly listeners = new Set<() => void>();
  private runningSessionKeys: ReadonlySet<string> = new Set();
  private unseenSessionKeys: ReadonlySet<string> = new Set();
  private liveRevision = 0;
  liveSessionRevision() { return this.liveRevision; }
  private liveSessions = new Map<NativeTransport, SessionSummary>();
  liveSessionSummaries() { return [...this.liveSessions.values()]; }
  setLiveSession(transport: NativeTransport, session: SessionSummary) {
    this.liveSessions.set(transport, session);
    this.liveRevision += 1; this.notify();
  }
  private activeTransport?: NativeTransport;
  private errorHandler?: (message: string) => void;

  private notify() { for (const listener of this.listeners) listener(); }

  private diffState(transport: NativeTransport) { let state = this.diffStates.get(transport); if (!state) { state = { snapshots: EMPTY_DIFFS, baselines: [], captureQueue: Promise.resolve(), persistence: "session" }; this.diffStates.set(transport, state); } return state; }

  private loadSavedDiffs(transport: NativeTransport, sessionPath: string) {
    const key = `${transport.currentHostId()}:${sessionPath}`;
    const state = this.diffState(transport); if (state.load?.key === key) return state.load.promise;
    state.path = key;
    const promise = transport.loadGitDiffs(sessionPath, transport.currentHostId()).then((snapshots) => {
      if (state.path === key) { state.snapshots = snapshots; this.notify(); }
      return snapshots;
    }).catch((reason) => {
      if (state.path === key) { state.snapshots = EMPTY_DIFFS; this.notify(); }
      state.load = undefined;
      this.errorHandler?.(`Could not load saved project changes: ${reason instanceof Error ? reason.message : String(reason)}`);
      return EMPTY_DIFFS;
    });
    state.load = { key, promise }; return promise;
  }

  private discardBaselines(transport: NativeTransport, state: DiffState) {
    const baselines = state.baselines.splice(0);
    for (const baseline of baselines) void baseline.tree.then((snapshot) => snapshot ? transport.discardGitTree(snapshot, baseline.hostId) : undefined).catch(() => undefined);
  }

  private captureTurnStart(transport: NativeTransport) {
    const cwd = transport.currentCwd(); if (!cwd) return;
    const state = this.diffState(transport); const hostId = transport.currentHostId();
    state.baselines.push({ cwd, hostId, tree: transport.captureGitTree(cwd, hostId).catch(() => null) });
  }

  private captureTurnEnd(transport: NativeTransport) {
    const diffState = this.diffState(transport); const baseline = diffState.baselines.shift(); if (!baseline) return;
    const capture = Promise.all([
      baseline.tree,
      transport.command<{ entries: PiEntry[]; leafId: string | null }>({ type: "get_entries" }),
      transport.command<{ sessionFile?: string }>({ type: "get_state" }),
    ]).then(async ([baseTree, history, state]) => {
      if (!state.sessionFile) { if (baseTree) await transport.discardGitTree(baseTree, baseline.hostId).catch(() => undefined); return undefined; }
      const gitPatch = baseTree ? await transport.loadGitDiff(baseline.cwd, baseTree, baseline.hostId).catch(async () => { await transport.discardGitTree(baseTree, baseline.hostId).catch(() => undefined); return null; }) : null;
      const messages = branchMessages(history.entries, history.leafId);
      const turnStart = messages.map((message) => message.role).lastIndexOf("user");
      const snapshot = mergeDiffSnapshots(gitPatch, messages.slice(Math.max(0, turnStart)).flatMap((message) => message.fileChanges ?? []), baseline.cwd);
      const message = latestAssistantEntry(history.entries, history.leafId);
      return snapshot && message ? { snapshot, messageId: message.id, sessionFile: state.sessionFile } : undefined;
    });
    diffState.captureQueue = diffState.captureQueue.then(async () => {
      const result = await capture; if (!result) return;
      const key = `${baseline.hostId}:${result.sessionFile}`;
      const saved = diffState.persistence === "memory"
        ? await (diffState.load?.promise ?? Promise.resolve(diffState.snapshots))
        : diffState.path === key ? diffState.snapshots : await this.loadSavedDiffs(transport, result.sessionFile);
      const previous = saved; const snapshots = { ...saved, [result.messageId]: result.snapshot };
      diffState.snapshots = snapshots; diffState.path = key; diffState.load = { key, promise: Promise.resolve(snapshots) }; this.notify();
      if (diffState.persistence === "memory") return;
      try { await transport.saveGitDiffs(result.sessionFile, snapshots, baseline.hostId); }
      catch (reason) { diffState.snapshots = previous; diffState.load = { key, promise: Promise.resolve(previous) }; this.notify(); this.errorHandler?.(`Could not save project changes: ${reason instanceof Error ? reason.message : String(reason)}`); }
    }).catch(async () => { const snapshot = await baseline.tree.catch(() => null); if (snapshot) await transport.discardGitTree(snapshot, baseline.hostId).catch(() => undefined); });
  }

  private publishSessionStates() {
    const running = new Set([...this.sessions].filter(([, transport]) => this.runningTransports.has(transport)).map(([key]) => key));
    const unseen = new Set([...this.sessions].filter(([, transport]) => this.unseenTransports.has(transport)).map(([key]) => key));
    const runningChanged = running.size !== this.runningSessionKeys.size || [...running].some((key) => !this.runningSessionKeys.has(key));
    const unseenChanged = unseen.size !== this.unseenSessionKeys.size || [...unseen].some((key) => !this.unseenSessionKeys.has(key));
    if (!runningChanged && !unseenChanged) return;
    this.runningSessionKeys = running; this.unseenSessionKeys = unseen; this.notify();
  }

  private retainSession(transport: NativeTransport, prompt?: string, lastMessageAt?: number) {
    // MCP setup precedes message_start. Protect the runtime synchronously so a
    // switch cannot dispose it while get_state is still in flight.
    this.retainedTransports.add(transport);
    void transport.command<import("../types").AgentState>({ type: "get_state" }).then((state) => {
      if (!state.sessionId || !this.transports.has(transport)) return;
      this.bind(transport.currentHostId(), state.sessionId, transport);
      const cwd = transport.currentCwd() || "";
      const previous = this.liveSessions.get(transport);
      const projectDetails = previous?.cwd === cwd && previous.hostId === transport.currentHostId() ? { projectKind: previous.projectKind, projectRoot: previous.projectRoot, cwdExists: previous.cwdExists } : {};
      this.liveSessions.set(transport, { ...projectDetails, id: state.sessionId, path: state.sessionFile || "", name: state.sessionName || prompt?.slice(0, 60) || previous?.name || "New session", project: cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Workspace", cwd, preview: prompt ?? previous?.preview ?? "", messageCount: Math.max(prompt ? 1 : 0, state.messageCount, previous?.messageCount ?? 0), lastMessageAt: lastMessageAt ?? previous?.lastMessageAt ?? 0, apiCost: previous?.apiCost ?? 0, daemonId: transport.currentDaemonId(), hostId: transport.currentHostId() });
      this.liveRevision += 1; this.notify();
    }).catch((reason) => this.errorHandler?.(`Could not list the retained session: ${reason instanceof Error ? reason.message : String(reason)}`));
  }

  create(target?: NativeConnectionTarget) {
    const transport = new NativeTransport(target); this.transports.add(transport);
    if (transport.currentSessionPath()) void this.loadSavedDiffs(transport, transport.currentSessionPath()!);
    transport.subscribe((event) => {
      if (event.type === "extension_ui_request") {
        const request = event as unknown as ExtensionUiRequest;
        if (request.method === "setStatus" && request.statusKey === "pi-desktop-mcp-status" && request.statusText?.startsWith("json:") && !this.retainedTransports.has(transport)) {
          try {
            const statuses: unknown = JSON.parse(request.statusText.slice(5));
            if (Array.isArray(statuses) && statuses.some((value) => value?.status === "starting")) this.retainSession(transport);
          } catch { /* Ignore malformed extension status payloads. */ }
        }
      }
      if (event.type === "runtime_presence") { if (event.isStreaming) this.runningTransports.add(transport); else this.runningTransports.delete(transport); }
      if (event.type === "message_start" && (event.message as { role?: string })?.role === "user") {
        const message = event.message as { content: import("../types").ChatMessage["content"]; timestamp?: unknown };
        const prompt = textOf(message.content); const timestamp = Number(message.timestamp);
        this.retainSession(transport, prompt, Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now());
      }
      if (this.diffState(transport).persistence === "memory") {
        if (event.type === "agent_start") this.captureTurnStart(transport);
        if (event.type === "agent_end" || event.type === "agent_settled") this.captureTurnEnd(transport);
      }
      if (event.type === "diffs_changed" && event.hostId === transport.currentHostId() && event.sessionPath === transport.currentSessionPath()) {
        this.diffState(transport).load = undefined;
        void this.loadSavedDiffs(transport, String(event.sessionPath));
      }
      if (event.type === "agent_start" || event.type === "message_start") { this.runningTransports.add(transport); this.unseenTransports.delete(transport); }
      if (event.type === "agent_settled") { this.runningTransports.delete(transport); if (transport !== this.activeTransport) this.unseenTransports.add(transport); }
      if (event.type === "disconnected") { this.runningTransports.delete(transport); this.discardBaselines(transport, this.diffState(transport)); }
      this.publishSessionStates();
      if (event.type === "settings_pending" || event.type === "settings_applied") this.notify();
    });
    return transport;
  }

  createEphemeralFork(target: NativeConnectionTarget, sourceSessionPath: string) {
    const transport = this.create(target); const state = this.diffState(transport);
    state.persistence = "memory";
    if (sourceSessionPath) void this.loadSavedDiffs(transport, sourceSessionPath);
    return transport;
  }

  forSession(session: SessionSummary) {
    const hostId = session.hostId ?? "local"; const key = sessionKey(session.daemonId ?? hostId, session.id);
    const existing = this.sessions.get(key) ?? this.sessions.get(sessionKey(hostId, session.id)); if (existing) return existing;
    const transport = this.create({ cwd: session.cwd, sessionPath: session.path, hostId }); this.sessions.set(key, transport); return transport;
  }

  bind(hostId: string, sessionId: string, transport: NativeTransport) {
    for (const [key, candidate] of this.sessions) if (candidate === transport) this.sessions.delete(key);
    if (!sessionId) { this.publishSessionStates(); return; }
    this.sessions.set(sessionKey(transport.currentDaemonId() ?? hostId, sessionId), transport);
    this.sessions.set(sessionKey(hostId, sessionId), transport);
    const state = this.diffState(transport); const sessionPath = transport.currentSessionPath();
    if (state.persistence === "session" && sessionPath) void this.loadSavedDiffs(transport, sessionPath);
    this.publishSessionStates();
  }

  activate(transport?: NativeTransport) { const previous = this.activeTransport; this.activeTransport = transport; if (previous && previous !== transport) previous.setVisible(this.interactiveTransports.has(previous)); if (transport) { transport.setVisible(true); this.unseenTransports.delete(transport); } this.publishSessionStates(); }

  setErrorHandler(handler?: (message: string) => void) { this.errorHandler = handler; }
  setInteractive(transport: NativeTransport, interactive: boolean) { if (interactive) this.interactiveTransports.add(transport); else this.interactiveTransports.delete(transport); transport.setVisible(interactive || transport === this.activeTransport); }
  isRunning(transport: NativeTransport) { return this.runningTransports.has(transport); }
  isRetained(transport: NativeTransport) { return this.retainedTransports.has(transport); }
  isAnyRunning() { return this.runningTransports.size > 0; }

  queueSettingsChange(previous: AppSettings, settings: AppSettings) {
    const changed = (before: unknown, after: unknown) => JSON.stringify(before) !== JSON.stringify(after);
    const hostConnection = (value: AppSettings, hostId: string) => {
      const host = value.hosts.find((host) => host.id === hostId);
      return host ? { target: host.target, piPath: host.piPath } : undefined;
    };
    for (const transport of this.transports) {
      const hostId = transport.currentHostId();
      transport.queueSettings(settings, {
        reconnect: hostId !== "local" && changed(hostConnection(previous, hostId), hostConnection(settings, hostId)),
      });
    }
  }
  pendingSettingsCount() { return [...this.transports].filter((transport) => transport.hasPendingSettings()).length; }

  async copySavedDiffs(transport: NativeTransport, sourcePath: string | undefined, destinationPath: string | undefined, retainedMessageIds?: ReadonlySet<string>) {
    if (!sourcePath || !destinationPath || sourcePath === destinationPath) return;
    const state = this.diffState(transport); const key = `${transport.currentHostId()}:${destinationPath}`;
    state.path = key; state.snapshots = EMPTY_DIFFS; state.load = undefined; this.notify();
    const source = await transport.loadGitDiffs(sourcePath, transport.currentHostId());
    const snapshots = retainedMessageIds ? Object.fromEntries(Object.entries(source).filter(([id]) => retainedMessageIds.has(id))) : source;
    await transport.saveGitDiffs(destinationPath, snapshots, transport.currentHostId());
    state.path = key; state.snapshots = snapshots; state.load = { key, promise: Promise.resolve(snapshots) }; this.notify();
  }

  async remove(session: SessionSummary) {
    const key = sessionKey(session.daemonId ?? session.hostId ?? "local", session.id); const transport = this.sessions.get(key); this.sessions.delete(key);
    if (transport) await this.release(transport);
  }

  async release(transport: NativeTransport) { if (!this.transports.has(transport)) return; for (const [key, candidate] of this.sessions) if (candidate === transport) this.sessions.delete(key); const diffState = this.diffStates.get(transport); if (diffState) this.discardBaselines(transport, diffState); this.transports.delete(transport); this.retainedTransports.delete(transport); this.runningTransports.delete(transport); this.unseenTransports.delete(transport); this.interactiveTransports.delete(transport); this.diffStates.delete(transport); if (this.liveSessions.delete(transport)) { this.liveRevision += 1; this.notify(); } this.publishSessionStates(); await transport.dispose(); }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  runningSessions() { return this.runningSessionKeys; }
  unseenSessions() { return this.unseenSessionKeys; }
  gitDiffs(transport: NativeTransport) { return this.diffStates.get(transport)?.snapshots ?? EMPTY_DIFFS; }

  async disconnectAll() { await Promise.allSettled([...this.transports].map((transport) => transport.dispose())); }
}

export function useTurnDiffs(pool: SessionRuntimePool, transport: NativeTransport) { return useSyncExternalStore((listener) => pool.subscribe(listener), () => pool.gitDiffs(transport)); }
