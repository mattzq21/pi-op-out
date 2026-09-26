import { type Accessor } from "solid-js";
import { createSubscription } from "../lib/solid";

import type { AgentState, AppSettings, ExtensionUiRequest, GitDiffSnapshot, GitDiffSnapshots, RpcEvent, SessionSummary } from "../types";
import { textOf } from "./content";
import { NativeTransport, type NativeConnectionTarget } from "./nativeTransport";
import { forgetSession, retainSessionResource } from "./sessionMemory";

const sessionKey = (hostId: string, sessionId: string) => `${hostId}:${sessionId}`;
const EMPTY_DIFFS: GitDiffSnapshots = {};
const startsUserMessage = (event: RpcEvent) => event.type === "message_start" && (event.message as { role?: string })?.role === "user";
type DiffState = { snapshots: GitDiffSnapshots; path?: string; load?: { key: string; promise: Promise<GitDiffSnapshots> }; persistence: "session" | "memory" };

function retainedName(state: AgentState, prompt: string | undefined, previous: SessionSummary | undefined) {
  return state.sessionName || prompt?.slice(0, 60) || previous?.name || "New session";
}

function retainedActivity(state: AgentState, previous: SessionSummary | undefined, prompt?: string, lastMessageAt?: number) {
  return { preview: retainedPreview(prompt, previous), messageCount: Math.max(prompt ? 1 : 0, state.messageCount, previous?.messageCount ?? 0), lastMessageAt: lastMessageAt ?? previous?.lastMessageAt ?? 0, apiCost: previous?.apiCost ?? 0 };
}

function retainedPreview(prompt: string | undefined, previous: SessionSummary | undefined) { return prompt ?? previous?.preview ?? ""; }

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
  private removedPaths = new Set<string>();
  isRemoved(session: SessionSummary) { return this.removedPaths.has(`${session.hostId ?? "local"}:${session.path}`); }
  removeSummary(hostId: string, path: string) {
    this.removedPaths.add(`${hostId}:${path}`);
    for (const [transport, session] of this.liveSessions) if ((session.hostId ?? "local") === hostId && session.path === path) {
      this.liveSessions.delete(transport);
      this.retainedTransports.delete(transport);
    }
    this.liveRevision += 1; this.notify();
  }
  liveSessionSummaries() { return [...this.liveSessions].filter(([transport]) => !transport.isEphemeral()).map(([, session]) => session); }
  setLiveSession(transport: NativeTransport, session: SessionSummary) {
    if (this.isRemoved(session)) return;
    this.liveSessions.set(transport, session);
    this.liveRevision += 1; this.notify();
  }
  private activeTransport?: NativeTransport;
  private errorHandler?: (message: string) => void;

  private notify() { for (const listener of this.listeners) listener(); }

  private retainDiffs(transport: NativeTransport, state: DiffState) {
    retainSessionResource(transport, "diffs", state.snapshots, () => {
      state.snapshots = EMPTY_DIFFS; state.path = undefined; state.load = undefined; this.notify();
    });
  }

  private diffState(transport: NativeTransport) { let state = this.diffStates.get(transport); if (!state) { state = { snapshots: EMPTY_DIFFS, persistence: "session" }; this.diffStates.set(transport, state); } return state; }

  private loadSavedDiffs(transport: NativeTransport, sessionPath: string) {
    const key = `${transport.currentHostId()}:${sessionPath}`;
    const state = this.diffState(transport); if (state.load?.key === key) return state.load.promise;
    state.path = key;
    const promise = transport.loadGitDiffs(sessionPath, transport.currentHostId()).then((snapshots) => {
      if (state.path === key && state.load?.promise === promise) { state.snapshots = snapshots; this.retainDiffs(transport, state); this.notify(); }
      return snapshots;
    }).catch((reason) => {
      if (state.path === key && state.load?.promise === promise) {
        state.snapshots = EMPTY_DIFFS; state.load = undefined; this.notify();
        this.errorHandler?.(`Could not load saved project changes: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
      return EMPTY_DIFFS;
    });
    state.load = { key, promise }; return promise;
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
    this.retainedTransports.add(transport);
    void transport.command<import("../types").AgentState>({ type: "get_state" }).then((state) => {
      if (!state.sessionId || !this.transports.has(transport)) return;
      if (state.sessionFile && this.removedPaths.has(`${transport.currentHostId()}:${state.sessionFile}`)) return;
      this.bind(transport.currentHostId(), state.sessionId, transport);
      const cwd = transport.currentCwd() || "";
      const previous = this.liveSessions.get(transport);
      const projectDetails = this.retainedProjectDetails(previous, cwd, transport.currentHostId());
      this.liveSessions.set(transport, { ...projectDetails, id: state.sessionId, path: state.sessionFile || "", name: retainedName(state, prompt, previous), project: cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Workspace", cwd, ...retainedActivity(state, previous, prompt, lastMessageAt), daemonId: transport.currentDaemonId(), hostId: transport.currentHostId() });
      this.liveRevision += 1; this.notify();
    }).catch((reason) => this.errorHandler?.(`Could not list the retained session: ${reason instanceof Error ? reason.message : String(reason)}`));
  }

  private retainedProjectDetails(previous: SessionSummary | undefined, cwd: string, hostId: string) {
    return previous?.cwd === cwd && previous.hostId === hostId ? { projectKind: previous.projectKind, projectRoot: previous.projectRoot, branch: previous.branch, cwdExists: previous.cwdExists } : {};
  }

  private retainMcpSession(transport: NativeTransport, event: RpcEvent) {
    if (event.type === "extension_ui_request") {
      const request = event as unknown as ExtensionUiRequest;
      if (request.method === "setStatus" && request.statusKey === "pi-desktop-mcp-status" && request.statusText?.startsWith("json:") && !this.retainedTransports.has(transport)) {
        try {
          const statuses: unknown = JSON.parse(request.statusText.slice(5));
          if (Array.isArray(statuses) && statuses.some((value) => value?.status === "starting")) this.retainSession(transport);
        } catch { }
      }
    }
  }

  private retainUserSession(transport: NativeTransport, event: RpcEvent) {
    if (event.type === "message_start" && (event.message as { role?: string })?.role === "user") {
      const message = event.message as { content: import("../types").ChatMessage["content"]; timestamp?: unknown };
      const prompt = textOf(message.content); const timestamp = Number(message.timestamp);
      this.retainSession(transport, prompt, Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now());
    }
  }

  private captureDiffEvent(transport: NativeTransport, event: RpcEvent) {
    const state = this.diffState(transport);
    if (event.hostId !== transport.currentHostId() || event.sessionPath !== transport.currentSessionPath()) return;
    if (state.persistence === "memory" && event.type === "turn_diff" && typeof event.messageId === "string" && event.snapshot) {
      const messageId = event.messageId;
      const snapshot = event.snapshot as GitDiffSnapshot;
      void (state.load?.promise ?? Promise.resolve()).then(() => {
        if (!this.transports.has(transport) || event.sessionPath !== transport.currentSessionPath()) return;
        state.snapshots = { ...state.snapshots, [messageId]: snapshot };
        this.retainDiffs(transport, state); this.notify();
      });
    }
    if (event.type === "diffs_changed") {
      this.diffState(transport).load = undefined;
      void this.loadSavedDiffs(transport, String(event.sessionPath));
    }
  }

  private updateActivity(transport: NativeTransport, event: RpcEvent) {
    if (event.type === "runtime_presence") { if (event.isStreaming) this.runningTransports.add(transport); else this.runningTransports.delete(transport); }
    if (event.type === "agent_start" || startsUserMessage(event)) { this.runningTransports.add(transport); this.unseenTransports.delete(transport); }
    if (event.type === "agent_settled") { this.runningTransports.delete(transport); if (transport !== this.activeTransport && !this.interactiveTransports.has(transport)) this.unseenTransports.add(transport); }
    if (event.type === "disconnected") { this.runningTransports.delete(transport); }
  }

  create(target?: NativeConnectionTarget) {
    const transport = new NativeTransport(target); this.transports.add(transport);
    if (transport.currentSessionPath()) void this.loadSavedDiffs(transport, transport.currentSessionPath()!);
    transport.subscribe((event) => {
      this.retainMcpSession(transport, event);
      this.retainUserSession(transport, event);
      this.captureDiffEvent(transport, event);
      this.updateActivity(transport, event);
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
  setInteractive(transport: NativeTransport, interactive: boolean) { if (interactive) { this.interactiveTransports.add(transport); this.unseenTransports.delete(transport); } else this.interactiveTransports.delete(transport); transport.setVisible(interactive || transport === this.activeTransport); this.publishSessionStates(); }
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

  async captureMemoryDiffs(transport: NativeTransport) {
    const state = this.diffState(transport);
    if (state.persistence !== "memory") return undefined;
    const saved = await state.load?.promise;
    return { ...saved, ...state.snapshots };
  }

  async copySavedDiffs(transport: NativeTransport, sourcePath: string | undefined, destinationPath: string | undefined, retainedMessageIds?: ReadonlySet<string>, sourceSnapshots?: GitDiffSnapshots) {
    if (!sourcePath || !destinationPath || sourcePath === destinationPath) return;
    const state = this.diffState(transport); const hostId = transport.currentHostId(); const key = `${hostId}:${destinationPath}`;
    const source = sourceSnapshots ? Promise.resolve(sourceSnapshots) : state.persistence === "memory" ? this.captureMemoryDiffs(transport).then((snapshots) => snapshots ?? EMPTY_DIFFS) : transport.loadGitDiffs(sourcePath, hostId);
    const operation = source.then(async (source) => {
      const snapshots = retainedMessageIds ? Object.fromEntries(Object.entries(source).filter(([id]) => retainedMessageIds.has(id))) : source;
      await transport.saveGitDiffs(destinationPath, snapshots, hostId);
      return snapshots;
    });
    const promise = operation.then((snapshots) => {
      if (state.path === key && state.load?.promise === promise) { state.snapshots = snapshots; this.retainDiffs(transport, state); this.notify(); }
      return snapshots;
    }).catch(() => {
      if (state.load?.promise === promise) { state.load = undefined; this.notify(); }
      return EMPTY_DIFFS;
    });
    state.persistence = "session"; state.path = key; state.snapshots = EMPTY_DIFFS; state.load = { key, promise }; this.notify();
    await operation; await promise;
  }

  async remove(session: SessionSummary) {
    const key = sessionKey(session.daemonId ?? session.hostId ?? "local", session.id); const transport = this.sessions.get(key); this.sessions.delete(key);
    if (transport) await this.release(transport);
  }

  async release(transport: NativeTransport) { if (!this.transports.has(transport)) return; forgetSession(transport); for (const [key, candidate] of this.sessions) if (candidate === transport) this.sessions.delete(key); this.transports.delete(transport); this.retainedTransports.delete(transport); this.runningTransports.delete(transport); this.unseenTransports.delete(transport); this.interactiveTransports.delete(transport); this.diffStates.delete(transport); if (this.liveSessions.delete(transport)) { this.liveRevision += 1; this.notify(); } this.publishSessionStates(); await transport.dispose(); }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  runningSessions() { return this.runningSessionKeys; }
  unseenSessions() { return this.unseenSessionKeys; }
  gitDiffs(transport: NativeTransport) { return this.diffStates.get(transport)?.snapshots ?? EMPTY_DIFFS; }

  async disconnectAll(strict = false) {
    const results = await Promise.allSettled([...this.transports].map((transport) => transport.dispose()));
    if (strict) { const failed = results.find(result => result.status === "rejected"); if (failed?.status === "rejected") throw failed.reason; }
  }
}

export function useTurnDiffs(pool: Accessor<SessionRuntimePool>, transport: Accessor<NativeTransport>) { return createSubscription(() => (listener) => pool().subscribe(listener), () => () => pool().gitDiffs(transport())); }
