import { capSessionName } from "./sessionName";
import { agentStateSchema } from "./responseSchemas";
import { extensionUiSchema } from "./extensionUiSchema";
import { wireMessageSchema } from "./messageSchemas";
import { z } from "zod";

import type { AgentState, AppSettings, RpcEvent, SessionSummary } from "../types";
import { textOf } from "./content";
import { NativeTransport, type NativeConnectionTarget } from "./nativeTransport";
import { forgetSession } from "./sessionMemory";

const sessionKey = (hostId: string, sessionId: string) => `${hostId}:${sessionId}`;

/** The number of detached idle conversations that stay in memory for a fast return. Older ones are released. */
const IDLE_LIMIT = 8;

const startsUserMessage = (event: RpcEvent) => event.type === "message_start" && z.object({ role: z.literal("user") }).safeParse(event.message).success;

function retainedName(state: AgentState, prompt: string | undefined, previous: SessionSummary | undefined) {
  return capSessionName(state.sessionName || prompt || previous?.name || "New session");
}

function retainedActivity(state: AgentState, previous: SessionSummary | undefined, prompt?: string, lastMessageAt?: number) {
  return { isDraft: retainedDraft(state, previous, prompt), preview: retainedPreview(prompt, previous), messageCount: Math.max(prompt !== undefined ? 1 : 0, state.messageCount, previous?.messageCount ?? 0), lastMessageAt: lastMessageAt ?? previous?.lastMessageAt ?? 0, apiCost: previous?.apiCost ?? 0 };
}

function retainedDraft(state: AgentState, previous: SessionSummary | undefined, prompt: string | undefined) {
  return prompt === undefined && (previous?.isDraft ?? state.messageCount === 0);
}

const PREVIEW_LIMIT = 200;

function retainedPreview(prompt: string | undefined, previous: SessionSummary | undefined) { return prompt?.slice(0, PREVIEW_LIMIT) ?? previous?.preview ?? ""; }

export class SessionRuntimePool {
  private readonly transports = new Set<NativeTransport>();
  private readonly detaching = new Map<NativeTransport, Promise<void>>();
  private readonly deferredDetaches = new Map<NativeTransport, () => boolean>();
  private readonly queuedTransports = new Set<NativeTransport>();
  private readonly releasing = new Map<NativeTransport, Promise<void>>();
  private readonly sessions = new Map<string, NativeTransport>();
  private readonly runningTransports = new Set<NativeTransport>();
  private readonly unseenTransports = new Set<NativeTransport>();
  private readonly interactiveTransports = new Set<NativeTransport>();
  private readonly observers = new Map<NativeTransport, number>();
  private readonly deferredReleases = new Set<NativeTransport>();
  private readonly retainedTransports = new Set<NativeTransport>();
  /** Detached idle conversations, oldest first, with the check that they have no unsent work. */
  private readonly idleTransports = new Map<NativeTransport, () => boolean>();
  private readonly listeners = new Set<() => void>();
  private runningSessionKeys: ReadonlySet<string> = new Set();
  private unseenSessionKeys: ReadonlySet<string> = new Set();
  private liveRevision = 0;
  liveSessionRevision() { return this.liveRevision; }
  private liveSessions = new Map<NativeTransport, SessionSummary>();
  private readonly releasedSessions = new Map<string, SessionSummary>();
  private removedPaths = new Set<string>();
  isRemoved(session: SessionSummary) { return this.removedPaths.has(`${session.hostId ?? "local"}:${session.path}`); }
  restoreSummary(hostId: string, path: string) { this.removedPaths.delete(`${hostId}:${path}`); }
  removeSummary(hostId: string, path: string) {
    this.removedPaths.add(`${hostId}:${path}`);

    for (const [transport, session] of this.liveSessions) if ((session.hostId ?? "local") === hostId && session.path === path) {
      this.liveSessions.delete(transport);
      this.retainedTransports.delete(transport);
    }

    for (const [key, session] of this.releasedSessions) if ((session.hostId ?? "local") === hostId && session.path === path) this.releasedSessions.delete(key);

    this.liveRevision += 1; this.notify();
  }
  private pluginPaneTransports = new WeakSet<NativeTransport>();
  liveSessionSummaries() { return [...this.releasedSessions.values(), ...[...this.liveSessions].flatMap(([transport, session]) => !this.pluginPaneTransports.has(transport) ? [session] : [])]; }
  setLiveSession(transport: NativeTransport, session: SessionSummary) {
    if (this.isRemoved(session)) return;
    this.releasedSessions.delete(sessionKey(session.hostId ?? "local", session.id));
    this.liveSessions.set(transport, session);
    this.liveRevision += 1; this.notify();
  }
  private activeTransport?: NativeTransport;
  private errorHandler?: (message: string) => void;

  private notify() { for (const listener of this.listeners) listener(); }

  private publishSessionStates() {
    const running = new Set<string>();
    const unseen = new Set<string>();

    for (const [key, transport] of this.sessions) {
      if (this.runningTransports.has(transport)) running.add(key);

      if (this.unseenTransports.has(transport)) unseen.add(key);
    }

    const runningChanged = running.size !== this.runningSessionKeys.size || [...running].some((key) => !this.runningSessionKeys.has(key));
    const unseenChanged = unseen.size !== this.unseenSessionKeys.size || [...unseen].some((key) => !this.unseenSessionKeys.has(key));

    if (!runningChanged && !unseenChanged) return;
    this.runningSessionKeys = running; this.unseenSessionKeys = unseen; this.notify();
  }

  private retainSession(transport: NativeTransport, prompt?: string, lastMessageAt?: number) {
    this.retainedTransports.add(transport);
    void transport.command({ type: "get_state" }, agentStateSchema).then((state) => {
      if (!state.sessionId || !this.transports.has(transport) || this.releasing.has(transport)) return;

      if (state.sessionFile && this.removedPaths.has(`${transport.currentHostId()}:${state.sessionFile}`)) return;
      this.bind(transport.currentHostId(), state.sessionId, transport);
      const cwd = transport.currentCwd() || "";
      const previous = this.liveSessions.get(transport);
      const projectDetails = this.retainedProjectDetails(previous, cwd, transport.currentHostId());
      this.releasedSessions.delete(sessionKey(transport.currentHostId(), state.sessionId));
      const forkSourceId = state.forkSource?.sessionId;
      this.liveSessions.set(transport, { ...projectDetails, id: state.sessionId, ...(forkSourceId ? { forkSourceId } : {}), path: state.sessionFile || "", name: retainedName(state, prompt, previous), project: cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Workspace", cwd, ...retainedActivity(state, previous, prompt, lastMessageAt), daemonId: transport.currentDaemonId(), hostId: transport.currentHostId() });
      this.liveRevision += 1; this.notify();
    }).catch((reason) => this.errorHandler?.(`Could not list the retained session: ${reason instanceof Error ? reason.message : String(reason)}`));
  }

  private retainedProjectDetails(previous: SessionSummary | undefined, cwd: string, hostId: string) {
    return previous?.cwd === cwd && previous.hostId === hostId ? { cwdExists: previous.cwdExists } : {};
  }

  private retainMcpSession(transport: NativeTransport, event: RpcEvent) {
    if (event.type === "extension_ui_request") {
      const request = extensionUiSchema.parse(event);

      if (request.method === "setStatus" && request.statusKey === "pi-desktop-mcp-status" && request.statusText?.startsWith("json:") && !this.retainedTransports.has(transport)) {
        try {
          const statuses: unknown = JSON.parse(request.statusText.slice(5));

          if (Array.isArray(statuses) && statuses.some((value) => value?.status === "starting")) this.retainSession(transport);
        } catch { }
      }
    }
  }

  private retainUserSession(transport: NativeTransport, event: RpcEvent) {
    const parsed = wireMessageSchema.safeParse(event.message);

    if (event.type === "message_start" && parsed.success && parsed.data.role === "user") {
      const message = parsed.data;
      const prompt = textOf(message.content); const timestamp = Number(message.timestamp);
      this.retainSession(transport, prompt, Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now());
    }
  }

  private updateActivity(transport: NativeTransport, event: RpcEvent) {
    if (event.type === "queue_update") {
      if ([event.steering, event.followUp, event.pendingMessages].some(value => Array.isArray(value) && value.length)) this.queuedTransports.add(transport); else this.queuedTransports.delete(transport);
    }
    const running = this.runningTransports.size;
    const unseen = this.unseenTransports.size;

    if (event.type === "runtime_presence") { if (event.isStreaming) this.runningTransports.add(transport); else this.runningTransports.delete(transport); }

    if (event.type === "agent_start" || startsUserMessage(event)) { this.runningTransports.add(transport); this.unseenTransports.delete(transport); }

    if (event.type === "agent_settled") { this.runningTransports.delete(transport);

    if (transport !== this.activeTransport && !this.interactiveTransports.has(transport)) this.unseenTransports.add(transport); }

    if (event.type === "disconnected") { this.runningTransports.delete(transport); }

    return running !== this.runningTransports.size || unseen !== this.unseenTransports.size;
  }

  create(target?: NativeConnectionTarget) {
    const transport = new NativeTransport({ ...target, draftKey: target?.sessionId || target?.sessionPath ? undefined : target?.draftKey ?? "draft" }); this.transports.add(transport);

    transport.subscribe((event) => {
      this.retainMcpSession(transport, event);
      this.retainUserSession(transport, event);

      if (this.updateActivity(transport, event)) this.publishSessionStates();

      if (event.type === "settings_pending" || event.type === "settings_applied") this.notify();
    });

    return transport;
  }

  forPluginPane(session: SessionSummary) {
    const transport = this.forSession(session);
    this.pluginPaneTransports.add(transport);

    return transport;
  }

  forReadOnly(session: SessionSummary) {
    return this.create({ cwd: session.cwd || undefined, sessionPath: session.path, sessionId: session.id, hostId: session.hostId ?? "local", readOnly: true });
  }

  forSession(session: SessionSummary) {
    const hostId = session.hostId ?? "local"; const key = sessionKey(session.daemonId ?? hostId, session.id);
    const existing = this.sessions.get(key) ?? this.sessions.get(sessionKey(hostId, session.id));

    if (existing && !this.releasing.has(existing)) return existing;
    const transport = this.create({ cwd: session.cwd || undefined, sessionPath: session.path || undefined, sessionId: session.isDraft ? undefined : session.id, hostId, draftKey: session.isDraft ? `${hostId}:${session.id}` : undefined }); this.sessions.set(key, transport);

    return transport;
  }

  bind(hostId: string, sessionId: string, transport: NativeTransport) {
    if (this.releasing.has(transport)) return;

    for (const [key, candidate] of this.sessions) if (candidate === transport) this.sessions.delete(key);

    if (!sessionId) { this.publishSessionStates();

    return; }

    this.sessions.set(sessionKey(transport.currentDaemonId() ?? hostId, sessionId), transport);
    this.sessions.set(sessionKey(hostId, sessionId), transport);

    this.publishSessionStates();
  }

  activate(transport?: NativeTransport) { const previous = this.activeTransport; this.activeTransport = transport;
  if (transport) this.idleTransports.delete(transport);
  this.notify();

  if (previous && previous !== transport) previous.setVisible(this.interactiveTransports.has(previous));

  if (transport) { transport.setVisible(true); this.unseenTransports.delete(transport); }

  this.publishSessionStates(); }

  setErrorHandler(handler?: (message: string) => void) { this.errorHandler = handler; }
  reportError(message: string) { if (this.errorHandler) this.errorHandler(message); else console.error(message); }

  private busy(transport: NativeTransport) {
    return !this.transports.has(transport) || this.releasing.has(transport) || this.isActive(transport) || this.isInteractive(transport) || this.isRunning(transport) || this.queuedTransports.has(transport) || transport.hasTerminalActivity() || transport.hasPendingSettings() || transport.promptControls.hasPending();
  }

  detachIdle(transport: NativeTransport, canDetach: () => boolean) {
    if (this.detaching.has(transport) || this.busy(transport) || !canDetach()) return;

    if (this.observers.has(transport)) { this.deferredDetaches.set(transport, canDetach);

    return; }

    this.deferredDetaches.delete(transport);
    const pending = transport.disconnect().then(() => { this.retainIdle(transport, canDetach); }).catch(reason => this.reportError(`Could not detach conversation: ${(reason instanceof Error ? reason.message : String(reason))}`)).finally(() => this.detaching.delete(transport));
    this.detaching.set(transport, pending);
  }

  private retainIdle(transport: NativeTransport, canDetach: () => boolean) {
    if (this.busy(transport)) return;
    this.idleTransports.delete(transport); this.idleTransports.set(transport, canDetach);

    for (const [candidate, idle] of this.idleTransports) {
      if (this.idleTransports.size <= IDLE_LIMIT) return;

      // A conversation with an unread result or unsent work stays in memory. A released one keeps its list summary.
      if (this.busy(candidate) || this.observers.has(candidate) || this.unseenTransports.has(candidate) || !idle()) continue;
      this.idleTransports.delete(candidate);
      void this.release(candidate, true).catch(reason => this.reportError(`Could not release idle conversation: ${(reason instanceof Error ? reason.message : String(reason))}`));
    }
  }
  setInteractive(transport: NativeTransport, interactive: boolean) {
    if (interactive) { this.interactiveTransports.add(transport); this.unseenTransports.delete(transport); this.idleTransports.delete(transport); } else this.interactiveTransports.delete(transport);
    this.notify();
    transport.setVisible(interactive || transport === this.activeTransport); this.publishSessionStates();
  }
  isRunning(transport: NativeTransport) { return this.runningTransports.has(transport); }
  isRetained(transport: NativeTransport) { return this.retainedTransports.has(transport); }
  isAnyRunning() { return this.runningTransports.size > 0; }

  queueSettingsChange(previous: AppSettings, settings: AppSettings) {
    const hostConnection = (value: AppSettings, hostId: string) => {
      const host = value.hosts.find((host) => host.id === hostId);

      return host ? { target: host.target, piPath: host.piPath, enabled: host.enabled !== false } : undefined;
    };

    for (const transport of this.transports) {
      const hostId = transport.currentHostId();
      transport.queueSettings(settings, {
        reconnect: hostId !== "local" && JSON.stringify(hostConnection(previous, hostId)) !== JSON.stringify(hostConnection(settings, hostId)),
      });
    }
  }
  pendingSettingsCount() { return [...this.transports].filter((transport) => transport.hasPendingSettings()).length; }

  async remove(session: SessionSummary) {
    const key = sessionKey(session.daemonId ?? session.hostId ?? "local", session.id); const transport = this.sessions.get(key);

    if (this.releasedSessions.delete(sessionKey(session.hostId ?? "local", session.id))) { this.liveRevision += 1; this.notify(); }

    if (transport) await this.release(transport);

    if (this.sessions.get(key) === transport) this.sessions.delete(key);
  }

  isInteractive(transport: NativeTransport) { return this.interactiveTransports.has(transport); }
  isActive(transport: NativeTransport) { return transport === this.activeTransport; }

  observe(transport: NativeTransport) {
    this.idleTransports.delete(transport);
    this.observers.set(transport, (this.observers.get(transport) ?? 0) + 1);
    let observing = true;

    return () => {
      if (!observing) return;
      observing = false;
      const remaining = (this.observers.get(transport) ?? 1) - 1;

      if (remaining) { this.observers.set(transport, remaining);

      return; }

      this.observers.delete(transport);
      const canDetach = this.deferredDetaches.get(transport);
      this.deferredDetaches.delete(transport);

      if (canDetach) queueMicrotask(() => this.detachIdle(transport, canDetach));

      if (this.deferredReleases.delete(transport)) queueMicrotask(() => {
        if (transport !== this.activeTransport) void this.release(transport).catch(reason => this.reportError(`Could not release viewed conversation: ${(reason instanceof Error ? reason.message : String(reason))}`));
      });
    };
  }

  async release(transport: NativeTransport, keepSummary = false) {
    const pending = this.releasing.get(transport);

    if (pending) return pending;

    if (!this.transports.has(transport) || this.isInteractive(transport)) return;

    if (this.observers.has(transport)) { this.deferredReleases.add(transport);

    return; }

    const release = Promise.resolve().then(async () => {
      await this.detaching.get(transport);
      await transport.dispose();
      this.deferredDetaches.delete(transport); this.queuedTransports.delete(transport);
      forgetSession(transport);

      for (const [key, candidate] of this.sessions) if (candidate === transport) this.sessions.delete(key);
      this.transports.delete(transport); this.retainedTransports.delete(transport); this.runningTransports.delete(transport); this.unseenTransports.delete(transport); this.interactiveTransports.delete(transport);
      this.idleTransports.delete(transport);

      const summary = this.liveSessions.get(transport);

      if (summary && keepSummary && !this.pluginPaneTransports.has(transport) && !this.isRemoved(summary)) this.releasedSessions.set(sessionKey(summary.hostId ?? "local", summary.id), summary);

      if (this.liveSessions.delete(transport)) { this.liveRevision += 1; this.notify(); }

      this.publishSessionStates();
    }).finally(() => this.releasing.delete(transport));

    this.releasing.set(transport, release);

    return release;
  }

  subscribe(listener: () => void) { this.listeners.add(listener);

  return () => this.listeners.delete(listener); }
  runningSessions() { return this.runningSessionKeys; }
  unseenSessions() { return this.unseenSessionKeys; }

  async disconnectAll(strict = false) {
    const results = await Promise.allSettled([...this.transports].map((transport) => transport.dispose()));

    if (strict) { const failed = results.find(result => result.status === "rejected");

    if (failed?.status === "rejected") throw failed.reason; }
  }
}
