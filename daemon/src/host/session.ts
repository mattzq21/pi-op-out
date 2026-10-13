import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as Registry from '../session_registry';
import { Mutex, errorText } from '../util/sync';
import { array, flag, kind, setEntry, text, jsonEqual } from './json';
import { assistantDelta, savedToolPayload } from './payload';
import { argument, prepareSpec, specIdentity, type LaunchSpec, type SessionLaunch } from './protocol';
import { SessionQueue, type Execution } from './queue';
import { QueueStorage, parseIdentity } from './queue_storage';
import { ToolPayload, type ToolPayloadCache } from './tool_payload';
import { RuntimeWorker, type Request, type WorkerObserver } from './worker';

/** The controller functions that a session calls. */
export interface SessionHost {
  queueRoot(): string | null;
  output(packet: any): void;
  configuration(): any | null;
  readonlyViews(identity: string): string[];
  readonly(runtime: string): boolean;
  rekey(old: string, next: string, epoch: string): void;
  finished(key: string, epoch: string, transient: boolean): void;
  maintenance(key: string): void;
  canStopIdle(session: Session): boolean;
  refreshProviders(): Promise<number>;
}

export interface Dialog {
  event: any;
  owner: string | null;
  generation: string;
  answering: boolean;
  answerQueued: boolean;
  queuedResponse: any | null;
}

export function interactive(event: any): boolean {
  return ['input', 'editor', 'select', 'confirm'].includes(event?.method);
}

const STATE_CHANGES = new Set(['session_info_changed', 'session_switched', 'model_select', 'thinking_level_changed', 'agent_start', 'agent_end', 'agent_settled',
  'message_start', 'message_end', 'entry_appended', 'pause_state', 'compaction_start', 'compaction_end', 'auto_compaction_start', 'auto_compaction_end']);

export function stateChange(name: string): boolean { return STATE_CHANGES.has(name); }

function clone<T>(value: T): T { return value === undefined ? value : structuredClone(value); }
function merge(target: any, source: any): void {
  if (target && typeof target === 'object' && !Array.isArray(target) && source && typeof source === 'object' && !Array.isArray(source)) Object.assign(target, source);
}

function newDialog(event: any): Dialog {
  return { event, owner: null, generation: randomUUID(), answering: false, answerQueued: false, queuedResponse: null };
}

/** Stops other work on the session until the promise settles; it is like an abortable task handle. */
export interface InterruptTask { finished: boolean; promise: Promise<any> }

export class Session {
  readonly identity: string;
  private clientIdValue: string;
  readonly spec: LaunchSpec;
  readonly cwd: string | null;
  readonly timeout: number;
  readonly queue: SessionQueue;
  readonly orchestrationInterrupt = new Mutex();
  orchestrationTask: InterruptTask | null = null;
  readonly epoch = randomUUID();
  private worker: RuntimeWorker | undefined;
  private configurationGate = new Mutex();
  private events: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private dialogTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingRequests = 0;
  private checkingIdle = false;
  private idleRevision = 0;

  key: string;
  state: any = null;
  viewsList: Array<[string, any]> = [];
  statuses: Array<[string, any]> = [];
  dialogs: Array<[string, Dialog]> = [];
  liveMessages: Array<[string, any]> = [];
  tools: Array<[string, any]> = [];
  toolCalls = new Map<string, any>();
  sequence = 0;
  stateRevision = 0;
  contentRevision = 0;
  toolPayloadRevision = 0;
  isWorking = false;
  isCompacting = false;
  isSubmitted = false;
  isClosed = false;
  isStopping = false;
  isTransient: boolean;
  pauseState: any = null;
  reservedPathValue: string | null = null;
  startupError: string | null = null;
  /** Last stderr lines from Pi, kept for error reports. */
  stderrTail: string[] = [];
  inputRejection: any = null;
  commandErrors = new Map<string, string>();
  appliedConfiguration: any | null = null;
  configurationErrorValue: string | null = null;
  configuring = false;
  autoCompaction: boolean | null = null;
  autoRetry: boolean | null = null;
  agentRevision: number;
  providerRevision = 0;

  private constructor(launch: SessionLaunch, identity: string, pending: any[], storage: QueueStorage | null, private host: SessionHost, private toolPayloads: ToolPayloadCache) {
    this.identity = identity;
    this.clientIdValue = launch.clientId;
    this.spec = launch.spec;
    this.cwd = launch.cwd;
    this.timeout = launch.timeout;
    this.key = launch.key;
    this.isTransient = launch.transient;
    const revision = host.configuration()?.agentRevision;
    this.agentRevision = typeof revision === 'number' && Number.isInteger(revision) && revision >= 0 ? revision : 0;
    const executor: Execution = {
      execute: command => this.execute(command),
      publish: event => this.publish(event, null),
      savedUserMessages: () => this.savedUserMessages(),
    };
    this.queue = new SessionQueue(executor, pending, storage);
  }

  static async spawn(launch: SessionLaunch, pending: any[], host: SessionHost, home: string, toolPayloads: ToolPayloadCache, assertRunning: () => void): Promise<Session> {
    prepareSpec(launch.spec, launch.key, launch.clientId, home);
    const storage = queueStorage(host, launch.spec, launch.cwd, home, launch.key);
    const recovered = storage ? await storage.recover(pending) : pending;
    const identity = argument(launch.spec, '--session') !== undefined ? launch.key : (argument(launch.spec, '--session-id') ?? launch.key);
    const session = new Session(launch, identity, recovered, storage, host, toolPayloads);
    await session.reconcileQueue();
    assertRunning();
    session.worker = RuntimeWorker.spawn(session.spec, session.identity, launch.timeout, session.observer(), home);
    return session;
  }

  private observer(): WorkerObserver {
    return {
      // inOrder already reports a failed event; the returned promise only tells the worker when the event is done.
      event: event => this.inOrder(() => this.receive(event)).then(() => {}, () => {}),
      response: (event, request) => this.inOrder(() => this.response(event, request)),
      stderr: line => {
        if (this.stderrTail.push(line) > 20) this.stderrTail.shift();
        for (const [runtime] of [...this.viewsList]) this.host.output({ type: 'stderr', runtimeId: runtime, line });
      },
      diagnostic: line => this.host.output({ type: 'diagnostic', line }),
      finished: () => this.finish(),
      disconnectError: status => this.disconnectError(status),
    };
  }

  private disconnectError(status: string | null): string {
    const base = this.state === null ? 'Pi stopped before it was ready' : 'Pi disconnected before responding';
    const tail = this.stderrTail.join('\n').trim();
    const message = base + (status ? ' (' + status + ')' : '') + (tail ? ':\n' + tail : '');
    if (!this.viewsList.length && !this.isStopping && (this.state === null || status !== 'exit code 0')) this.host.output({ type: 'diagnostic', line: this.key + ': ' + message });
    this.startupError = message;
    return message;
  }

  private inOrder<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.events.then(operation);
    this.events = result.then(() => {}, error => {
      console.error('Session event failed for ' + this.key + ': ' + errorText(error));
      this.host.output({ type: 'diagnostic', line: 'Session event failed for ' + this.key + ': ' + errorText(error) });
    });
    return result;
  }

  private savedUserMessages(): any[] {
    const path = typeof this.state?.sessionFile === 'string' ? this.state.sessionFile : argument(this.spec, '--session');
    if (path === undefined) return [];
    return savedUserMessages(path, specIdentity(this.spec, this.key));
  }

  clientId(): string { return this.clientIdValue; }
  async setClientId(client: string): Promise<void> {
    await this.raw({ type: 'conversation_client', clientId: client });
    this.clientIdValue = client;
    this.spec.env.PIOP_CONVERSATION_CLIENT = client;
  }

  private async reconcileQueue(): Promise<void> {
    try { await this.queue.confirmConsumed(); } catch (error) {
      this.host.output({ type: 'diagnostic', line: 'Queued input retained for review: ' + errorText(error) });
    }
  }

  savedState(): any { return clone(this.state); }
  reservedPath(): string | null { return this.reservedPathValue; }
  setReservedPath(path: string | null): void { this.reservedPathValue = path; }
  transient(): boolean { return this.isTransient; }
  makeVisible(): void { this.isTransient = false; }
  closed(): boolean { return this.isClosed; }
  stopping(): boolean { return this.isStopping; }
  working(): boolean { return this.isWorking; }
  compacting(): boolean { return this.isCompacting; }
  submitted(): boolean { return this.isSubmitted; }
  views(): Array<[string, any]> { return this.viewsList.map(([id, view]) => [id, clone(view)]); }
  dialog(id: string): Dialog | undefined { const found = this.dialogs.find(([key]) => key === id); return found ? { ...found[1] } : undefined; }
  changeDialog(id: string, change: (dialog: Dialog) => void): void { const found = this.dialogs.find(([key]) => key === id); if (found) change(found[1]); }
  revision(): string { return this.epoch + ':' + this.contentRevision; }

  settingsPending(): boolean {
    const configuration = this.host.configuration();
    return configuration !== null && configuration !== undefined && !(this.appliedConfiguration !== null && jsonEqual(this.appliedConfiguration, configuration));
  }

  configurationError(): string | null {
    const error = this.configurationErrorValue;
    return error !== null && this.settingsPending() ? error : null;
  }

  private visibleViewers(): number { return this.viewsList.filter(([, view]) => flag(view, 'visible')).length; }

  busy(observed: any): boolean {
    const queue = this.queue.view();
    const count = observed?.pendingMessageCount;
    return this.isWorking || this.isCompacting || flag(observed, 'isStreaming') || flag(observed, 'isCompacting')
      || (typeof count === 'number' && Number.isInteger(count) && count > 0)
      || array(queue, 'steering').length > 0 || array(queue, 'followUp').length > 0 || array(queue, 'pendingMessages').length > 0;
  }

  unused(): boolean {
    if (this.busy(null)) return false;
    return this.viewsList.length === 0 && !this.configuring && !flag(this.pauseState, 'isPausing')
      && !this.dialogs.some(([, dialog]) => typeof dialog.event?.asyncQuestion !== 'string' || dialog.answering);
  }

  cancelIdleStop(): void {
    this.idleRevision += 1;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  idle(): boolean {
    return !this.closed() && !this.stopping() && !this.transient() && this.unused()
      && this.pendingRequests === 0 && this.dialogs.length === 0 && this.queue.pending().length === 0
      && this.queue.heldCount() === 0 && (!this.orchestrationTask || this.orchestrationTask.finished);
  }

  scheduleIdleStop(): void {
    if (this.checkingIdle) return;
    if (!this.idle()) { this.cancelIdleStop(); return; }
    if (this.idleTimer !== undefined) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.stopIdle().catch(error => {
        this.host.output({ type: 'diagnostic', line: 'Could not stop idle session ' + this.key + ': ' + errorText(error) });
      });
    }, 120_000);
  }

  private async stopIdle(): Promise<void> {
    this.checkingIdle = true;
    const revision = this.idleRevision;
    const release = await this.queue.gate.lock();
    try {
      if (!this.idle() || !this.host.canStopIdle(this)) return;
      const state = await this.execute({ type: 'get_state' });
      if (revision !== this.idleRevision) return;
      if (!this.idle() || this.busy(state) || flag(state, 'isPausing') || !this.host.canStopIdle(this)) return;
      await this.stop();
    } finally {
      this.checkingIdle = false;
      release();
      if (revision !== this.idleRevision) this.scheduleIdleStop();
    }
  }

  private clearDialogTimers(): void {
    for (const timer of this.dialogTimers.values()) clearTimeout(timer);
    this.dialogTimers.clear();
  }

  publish(event: any, target: string | null): void {
    const name = kind(event);
    const stamped = this.stampEvent(event, name, target);
    if (!stamped) return;
    const [key, targets] = stamped;
    if (target === null) for (const id of this.host.readonlyViews(this.identity)) if (!targets.includes(id)) targets.push(id);
    this.sendEvent(event, name, targets);
    if (name === 'queue_update' || name === 'settings_pending') this.publishState();
    if (['agent_settled', 'compaction_end', 'auto_compaction_end', 'queue_update'].includes(name)) this.host.maintenance(key);
  }

  private sendEvent(event: any, name: string, targets: string[]): void {
    for (const runtime of targets) {
      if (this.host.readonly(runtime)) {
        if (name === 'disconnected') {
          const stopped = clone(event);
          stopped.type = 'runtime_presence';
          stopped.isStreaming = false;
          stopped.viewers = this.visibleViewers();
          this.host.output({ type: 'event', runtimeId: runtime, event: stopped });
          continue;
        }
        if (name === 'extension_ui_request' && interactive(event)) continue;
      }
      this.host.output({ type: 'event', runtimeId: runtime, event });
    }
  }

  private stampEvent(event: any, name: string, target: string | null): [string, string[]] | undefined {
    const previous = this.epoch + ':' + this.contentRevision;
    if (name === 'session_info_changed') this.toolPayloadRevision += 1;
    if (stateChange(name)) this.stateRevision += 1;
    if (stateChange(name) || ['message_update', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'queue_update', 'settings_applied', 'extension_ui_request'].includes(name)) this.contentRevision += 1;
    if (this.isTransient) return undefined;
    this.sequence += 1;
    event.previousRevision = previous;
    event.revision = this.epoch + ':' + this.contentRevision;
    event.sequence = this.sequence;
    event.epoch = this.epoch;
    const targets = target !== null ? [target] : this.viewsList.map(([id]) => id);
    return [this.key, targets];
  }

  publishState(): void {
    const messageable = this.unused();
    if (this.isTransient) return;
    this.host.output({ type: 'session_state', sessionKey: this.key, epoch: this.epoch, state: clone(this.state), working: this.isWorking, messageable });
  }

  private publishPresence(): void {
    this.publish({ type: 'runtime_presence', viewers: this.visibleViewers(), isStreaming: this.isWorking }, null);
    this.publishState();
  }

  attach(runtime: string, presence: any): void {
    this.cancelIdleStop();
    setEntry(this.viewsList, runtime, presence);
    for (const [, event] of [...this.statuses]) this.publish(event, runtime);
    this.publish(this.queue.view(), runtime);
    this.publish({ type: 'settings_pending', pending: this.settingsPending() }, runtime);
    const error = this.configurationErrorValue;
    if (error !== null) this.publish({ type: 'extension_error', error }, runtime);
    this.routeDialogs();
    this.publishPresence();
  }

  presence(runtime: string, presence: any): void {
    this.cancelIdleStop();
    setEntry(this.viewsList, runtime, presence);
    this.routeDialogs();
    this.publishPresence();
  }

  detachView(runtime: string): void {
    this.viewsList = this.viewsList.filter(([id]) => id !== runtime);
    this.routeDialogs();
    this.publishPresence();
  }

  async finishDetach(discardBlank: boolean, preserveRunning: boolean): Promise<any> {
    const stopped = !preserveRunning && discardBlank && !this.isSubmitted && this.idle() && this.host.canStopIdle(this);
    const submitted = this.isSubmitted;
    if (stopped) await this.stop();
    this.host.maintenance(this.key);
    return { stopped, submitted };
  }

  async stop(): Promise<void> {
    this.isStopping = true;
    this.cancelIdleStop();
    this.clearDialogTimers();
    if (this.worker) await this.worker.stop();
    await this.events;
    await this.queue.flush();
  }

  async drain(): Promise<void> {
    await this.events;
    await this.queue.drain();
  }

  async activateUsageRecovery(): Promise<void> {
    if (this.spec.env.PIOP_USAGE_RECOVERY === '1') await this.execute({ type: 'activate_usage_recovery' });
  }

  async retire(): Promise<void> {
    if (this.transient()) throw new Error('This conversation branch is still being prepared');
    if (this.closed()) return;
    this.assertIdle(null);
    const release = await this.queue.gate.lock();
    try {
      if (this.closed()) return;
      this.assertIdle(null);
      const state = await this.execute({ type: 'get_state' });
      this.assertIdle(state);
      await this.stop();
    } finally { release(); }
  }

  private assertIdle(observed: any): void {
    if (this.viewsList.length) throw new Error('Close this conversation in all windows before messaging or archiving it');
    if (!this.unused() || this.busy(observed) || flag(observed, 'isPausing')) {
      throw new Error('Finish the response, queued messages, and settings changes before messaging or archiving this conversation');
    }
  }

  private finish(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.cancelIdleStop();
    this.clearDialogTimers();
    this.queue.close();
    void this.inOrder(() => this.finishQueue());
  }

  private async finishQueue(): Promise<void> {
    this.clearDialogTimers();
    this.dialogs = [];
    const key = this.key;
    const transient = this.isTransient;
    try {
      await this.queue.receive({ type: 'disconnected' });
      await this.queue.flush();
    } finally {
      this.host.finished(key, this.epoch, transient);
    }
  }

  raw(command: any): Promise<any> { return this.rawAs(command, kind(command), null); }

  private async rawAs(command: any, requestType: string, snapshot: any): Promise<any> {
    if (this.closed()) throw new Error(this.startupError ?? 'Pi is not running');
    if (requestType === 'prompt' || requestType === 'queue_prompt') {
      this.inputRejection = null;
      this.commandErrors.clear();
    }
    if (!this.worker) throw new Error('Pi is not running');
    if (!this.checkingIdle || !requestType.startsWith('get_')) this.cancelIdleStop();
    this.pendingRequests += 1;
    try { return await this.worker.request(command, requestType, snapshot); }
    finally {
      this.pendingRequests -= 1;
      this.scheduleIdleStop();
    }
  }

  async send(command: any): Promise<void> {
    if (!this.worker) throw new Error('Pi is not running');
    await this.worker.send(command);
  }

  // Settings reconciliation.

  async reconcile(retry: boolean): Promise<void> {
    if (retry) this.configurationErrorValue = null;
    if (this.transient() || this.closed() || this.stopping() || !this.settingsPending()) return;
    const release = await this.configurationGate.lock();
    try {
      if (this.configurationErrorValue !== null || this.busy(null) || !this.settingsPending()) return;
      this.configuring = true;
      try { await this.applyConfiguration(); } catch (error) { this.configurationFailed(errorText(error)); }
      this.configuring = false;
      this.publish({ type: 'settings_pending', pending: this.settingsPending() }, null);
    } finally { release(); }
  }

  private configurationFailed(error: string): void {
    if (this.closed() || this.stopping() || this.busy(null)) return;
    const message = 'Saved settings could not be applied: ' + error + '. Save again or reopen the conversation to retry.';
    this.configurationErrorValue = message;
    const revision = this.host.configuration()?.agentRevision;
    this.publish({ type: 'extension_error', error: message, agentRevision: typeof revision === 'number' ? revision : 0 }, null);
    if (!this.viewsList.length) this.host.output({ type: 'diagnostic', line: 'Could not apply settings to ' + this.key + ': ' + error });
  }

  private async applyConfiguration(): Promise<void> {
    const release = await this.queue.gate.lock();
    try {
      while (!this.closed() && !this.stopping() && this.settingsPending()) {
        const observed = await this.raw({ type: 'get_state' });
        if (this.busy(observed)) return;
        const configuration = clone(this.host.configuration());
        if (configuration === null || configuration === undefined) return;
        const revision = typeof configuration.agentRevision === 'number' ? configuration.agentRevision : 0;
        if (this.agentRevision < revision) await this.executeWorker({ type: 'refresh_agent_definitions' });
        await this.executeWorker({ type: 'context_cap_settings', settings: configuration.contextCapSettings });
        await this.applyAutomaticOptions(configuration);
        this.agentRevision = revision;
        this.appliedConfiguration = configuration;
        this.publish({ type: 'settings_applied', agentRevision: revision }, null);
      }
    } finally { release(); }
  }

  private async applyAutomaticOptions(configuration: any): Promise<void> {
    const compaction = typeof configuration.autoCompaction === 'boolean' ? configuration.autoCompaction : null;
    const retry = typeof configuration.autoRetry === 'boolean' ? configuration.autoRetry : null;
    if (this.autoCompaction !== compaction) await this.executeWorker({ type: 'set_auto_compaction', enabled: configuration.autoCompaction ?? null });
    if (this.autoRetry !== retry) await this.executeWorker({ type: 'set_auto_retry', enabled: configuration.autoRetry ?? null });
  }

  // Events from Pi.

  private async receive(event: any): Promise<void> {
    this.cancelIdleStop();
    try { await this.receiveEvent(event); }
    finally { this.scheduleIdleStop(); }
  }

  private async receiveEvent(event: any): Promise<void> {
    if (kind(event) === 'queue_consumed') {
      if (event.sessionId === this.identity) await this.queue.consumed(text(event, 'queueId'));
      return;
    }
    if (kind(event) === 'agent_settled' || (kind(event) === 'message_end' && event.message?.role === 'assistant')) Registry.record(this.state, this.cwd);
    this.retainLive(event);
    if (kind(event) === 'extension_ui_request') {
      const next = await this.receiveExtension(event);
      if (next === undefined) return;
      event = next;
    }
    if (kind(event) === 'extension_error' && event.event === 'command') {
      const path = typeof event.extensionPath === 'string' ? event.extensionPath : '';
      const command = path.startsWith('command:') ? path.slice(8) : '';
      this.commandErrors.set(command, typeof event.error === 'string' ? event.error : 'Extension command failed');
    }
    await this.queue.receive(event);
  }

  private retainLive(event: any): void {
    const name = kind(event);
    if (stateChange(name) || name.startsWith('tool_execution_')) this.toolPayloadRevision += 1;
    switch (name) {
      case 'agent_start': this.isWorking = true; this.isSubmitted = true; break;
      case 'agent_settled': this.isWorking = false; this.liveMessages = []; this.tools = []; this.toolCalls.clear(); break;
      case 'compaction_start': case 'auto_compaction_start': this.isCompacting = true; break;
      case 'compaction_end': case 'auto_compaction_end': this.isCompacting = false; break;
      case 'pause_state': this.pauseState = { isPaused: event.isPaused ?? null, isPausing: event.isPausing ?? null }; break;
    }
    this.retainMessage(event);
    if (['agent_start', 'agent_settled', 'compaction_start', 'compaction_end', 'auto_compaction_start', 'auto_compaction_end', 'pause_state'].includes(name)) this.publishState();
  }

  private retainMessage(event: any): void {
    switch (kind(event)) {
      case 'message_start': setEntry(this.liveMessages, text(event.message, 'role'), clone(event.message ?? null)); break;
      case 'message_update': {
        const update = event.assistantMessageEvent;
        let next: any;
        if (update?.partial !== undefined && update.partial !== null) next = clone(update.partial);
        else if (event.message !== undefined && event.message !== null) next = clone(event.message);
        else {
          const live = this.liveMessages.find(([role]) => role === 'assistant');
          if (live) { const message = live[1]; live[1] = null; next = assistantDelta(message, update ?? null); }
        }
        if (next !== undefined) {
          if (event.usage !== undefined) next.usage = clone(event.usage);
          const role = typeof next?.role === 'string' ? next.role : 'assistant';
          setEntry(this.liveMessages, role, next);
        }
        break;
      }
      case 'message_end': {
        const message = event.message;
        if (message?.role === 'assistant') {
          for (const call of Array.isArray(message.content) ? message.content : []) if (kind(call) === 'toolCall' && typeof call.id === 'string') this.toolCalls.set(call.id, clone(call));
        } else if (message?.role === 'toolResult' && typeof message.toolCallId === 'string') this.toolCalls.delete(message.toolCallId);
        this.liveMessages = this.liveMessages.filter(([role]) => message?.role !== role);
        break;
      }
      case 'tool_execution_start': case 'tool_execution_update': {
        const id = text(event, 'toolCallId');
        const found = this.tools.find(([key]) => key === id);
        const tool = found ? clone(found[1]) : {};
        merge(tool, clone(event));
        tool.type = 'tool_execution_start';
        setEntry(this.tools, id, tool);
        break;
      }
      case 'tool_execution_end': this.tools = this.tools.filter(([id]) => event.toolCallId !== id); break;
    }
  }

  private async receiveExtension(event: any): Promise<any | undefined> {
    if (event.method === 'setStatus' && await this.receiveStatus(event)) return undefined;
    if (event.method === 'notify' && event.notifyType === 'error' && jsonEqual(event.message, this.inputRejection?.error)) event.inputRejected = true;
    if (['setStatus', 'setWidget', 'setTitle'].includes(event.method)) {
      const key = text(event, 'method') + ':' + (typeof event.statusKey === 'string' ? event.statusKey : typeof event.widgetKey === 'string' ? event.widgetKey : '');
      setEntry(this.statuses, key, clone(event));
    }
    if (!interactive(event)) return event;
    this.receiveDialog(event);
    return undefined;
  }

  private receiveDialog(event: any): void {
    if (this.closed() || this.stopping()) return;
    const id = text(event, 'id');
    clearTimeout(this.dialogTimers.get(id));
    this.dialogTimers.delete(id);
    const dialog = newDialog(clone(event));
    setEntry(this.dialogs, id, dialog);
    const timeout = event.timeout;
    if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0) {
      const generation = dialog.generation;
      this.dialogTimers.set(id, setTimeout(() => {
        if (this.dialog(id)?.generation === generation) this.resolveDialog(id);
      }, Math.min(timeout, 2147483647)));
    }
    this.routeDialogs();
  }

  private async receiveStatus(event: any): Promise<boolean> {
    const parsed = (): { ok: true; value: any } | { ok: false; error: string } => {
      try { return { ok: true, value: JSON.parse(typeof event.statusText === 'string' ? event.statusText : '') }; }
      catch (error) { return { ok: false, error: errorText(error) }; }
    };
    switch (event.statusKey) {
      case 'piop-async-questions': case 'piop-async-question-recovery': {
        const result = parsed();
        if (!result.ok) { this.host.output({ type: 'diagnostic', line: result.error }); return true; }
        if (event.statusKey === 'piop-async-question-recovery') await this.queue.recoverQuestionAnswers(result.value);
        else this.receiveQuestions(result.value);
        return true;
      }
      case 'piop-input-rejected': {
        const result = parsed();
        if (result.ok) this.inputRejection = result.value;
        return true;
      }
      default: return false;
    }
  }

  private receiveQuestions(requests: any): void {
    if (!Array.isArray(requests)) return;
    const ids = requests.map(request => 'question:' + text(request, 'id'));
    const removed = this.dialogs.filter(([id, dialog]) => typeof dialog.event?.asyncQuestion === 'string' && !ids.includes(id)).map(([id]) => id);
    for (const id of removed) this.resolveDialog(id);
    for (const request of requests) {
      const id = 'question:' + text(request, 'id');
      if (this.dialog(id)) continue;
      const questions = array(request, 'questions').map((question, index) => ({
        id: 'question_' + index, header: 'Question', question: question?.title ?? null,
        options: array(question, 'options').map(label => ({ label, description: '' })),
      }));
      const event = { type: 'extension_ui_request', id, method: 'input', title: '__piop_request_user_input__', asyncQuestion: request?.id ?? null, placeholder: JSON.stringify({ questions }) };
      setEntry(this.dialogs, id, newDialog(event));
    }
    this.routeDialogs();
  }

  routeDialogs(): void {
    const views = this.viewsList.filter(([runtime]) => !this.host.readonly(runtime));
    const events: Array<[string, any]> = [];
    const owner = (views.find(([, view]) => flag(view, 'visible') && flag(view, 'focused')) ?? views.find(([, view]) => flag(view, 'visible')))?.[0] ?? null;
    for (const [id, dialog] of this.dialogs) {
      if (dialog.owner !== null && views.some(([view, presence]) => view === dialog.owner && flag(presence, 'visible'))) continue;
      const previous = dialog.owner;
      dialog.owner = null;
      if (previous !== null) events.push([previous, { type: 'extension_ui_resolved', id }]);
      dialog.owner = owner;
      if (owner !== null) events.push([owner, clone(dialog.event)]);
    }
    for (const [runtime, event] of events) this.publish(event, runtime);
    this.publishState();
  }

  resolveDialog(id: string): void {
    clearTimeout(this.dialogTimers.get(id));
    this.dialogTimers.delete(id);
    const count = this.dialogs.length;
    this.dialogs = this.dialogs.filter(([key]) => key !== id);
    if (count === this.dialogs.length) return;
    this.publish({ type: 'extension_ui_resolved', id }, null);
    this.publishState();
    this.host.maintenance(this.key);
  }

  // Requests.

  async execute(command: any): Promise<any> {
    switch (kind(command)) {
      case 'get_session_revision': return { revision: this.revision() };
      case 'get_tool_payload': return this.collectToolPayload(command);
      case 'get_snapshot': return this.collectSnapshot();
      case 'get_entries': { const snapshot = await this.collectSnapshot(); return snapshot?.history ?? null; }
      case 'get_state': return this.collectState(command);
      case 'force_stop': await this.stop(); return null;
      case 'get_available_models': await this.refreshProviders(); break;
    }
    return this.executeWorker(command);
  }

  private async collectState(command: any): Promise<any> {
    const state = await this.raw(command);
    merge(state, await this.raw({ type: 'get_pause_state' }));
    const count = typeof state?.pendingMessageCount === 'number' && Number.isInteger(state.pendingMessageCount) && state.pendingMessageCount >= 0 ? state.pendingMessageCount : 0;
    if (state && typeof state === 'object' && !Array.isArray(state)) {
      state.pendingMessages = this.queue.view().pendingMessages ?? null;
      state.pendingMessageCount = count + this.queue.heldCount();
    }
    return state;
  }

  private async refreshProviders(): Promise<void> {
    let revision: number;
    let force = false;
    try { revision = await this.host.refreshProviders(); } catch { force = true; revision = this.providerRevision; }
    if (force || (revision !== 0 && revision !== this.providerRevision)) {
      await this.raw({ type: 'provider_auth_refresh' });
      this.providerRevision = revision;
    }
  }

  async executeWorker(command: any): Promise<any> {
    if ((kind(command) === 'prompt' || kind(command) === 'queue_prompt') && !text(command, 'message').startsWith('/')) this.isSubmitted = true;
    const result = await this.raw(clone(command));
    this.rememberWorkerResult(command);
    if (kind(command) === 'resume' && typeof result?.resumeMessage === 'string' && result.resumeMessage) await this.raw({ type: 'prompt', message: result.resumeMessage });
    if (['set_model', 'set_thinking_level', 'set_session_name', 'fork_and_forget', 'refresh_agent_definitions'].includes(kind(command))) this.publish({ type: 'session_info_changed' }, null);
    return result;
  }

  private rememberWorkerResult(command: any): void {
    if (kind(command) === 'set_auto_compaction') this.autoCompaction = typeof command.enabled === 'boolean' ? command.enabled : null;
    if (kind(command) === 'set_auto_retry') this.autoRetry = typeof command.enabled === 'boolean' ? command.enabled : null;
  }

  private async collectToolPayload(command: any): Promise<any> {
    const id = text(command, 'toolCallId');
    const revision = String(this.toolPayloadRevision);
    const cached = this.toolPayloads.get(this.epoch, revision, id);
    if (cached) return cached.page(command);
    const payload = new ToolPayload(await this.toolPayloadMessage(id));
    const page = payload.page(command);
    if (String(this.toolPayloadRevision) === revision) this.toolPayloads.insert(this.epoch, revision, id, payload);
    return page;
  }

  private async toolPayloadMessage(id: string): Promise<any> {
    const live = this.tools.find(([key]) => key === id)?.[1];
    if (live !== undefined) {
      const partial = live?.partialResult;
      const result = partial && typeof partial === 'object' && !Array.isArray(partial) ? clone(partial) : {};
      if (live?.args !== undefined) result.toolInput = clone(live.args);
      return result;
    }
    const history = await this.raw({ type: 'get_entries' });
    return savedToolPayload(Array.isArray(history?.entries) ? history.entries : [], id) ?? null;
  }

  private async collectSnapshot(): Promise<any> {
    const deadline = Date.now() + this.timeout;
    for (;;) {
      const revision = this.stateRevision;
      const state = await this.raw({ type: 'get_state' });
      merge(state, await this.raw({ type: 'get_pause_state' }));
      const snapshot = await this.rawAs({ type: 'get_entries' }, 'get_snapshot_entries', state);
      const current = snapshot?.stateRevision;
      if (snapshot && typeof snapshot === 'object') delete snapshot.stateRevision;
      if (current === revision) return snapshot;
      if (Date.now() >= deadline) throw new Error('Session kept changing while collecting its snapshot');
    }
  }

  private async response(event: any, request: Request): Promise<any> {
    const goal = await this.rejectGoalPreparation(event, request);
    if (goal) { if ('error' in goal) throw new Error(goal.error); return goal.value; }
    try { this.responseError(event, request); } catch (error) {
      if (flag(request.command, 'discardOnRejection')) await this.queue.rejected(text(request.command, 'queueId'));
      throw error;
    }
    const data = event?.data === undefined ? null : event.data;
    if (request.requestType === 'get_entries' || request.requestType === 'get_snapshot_entries') this.queue.tagEntries(data);
    if (request.requestType === 'get_state') await this.receiveState(data);
    if (request.requestType === 'get_snapshot_entries') return this.snapshotResponse(data, request);
    return data;
  }

  private responseError(event: any, request: Request): void {
    if (request.requestType === 'prompt' || request.requestType === 'queue_prompt') this.checkPromptError(request.command, event?.data?.submittedText);
    if (!flag(event, 'success')) throw new Error(typeof event?.error === 'string' ? event.error : 'Pi command failed');
  }

  private async rejectGoalPreparation(event: any, request: Request): Promise<{ value: any } | { error: string } | undefined> {
    if (flag(event, 'success') || event?.rejection !== 'goal_preparation') return undefined;
    if (request.requestType === 'queue_prompt' && !flag(request.command, 'discardOnRejection')) {
      return { error: typeof event.error === 'string' ? event.error : 'Goal prompt preparation failed' };
    }
    if (flag(request.command, 'discardOnRejection')) await this.queue.rejected(text(request.command, 'queueId'));
    return { value: false };
  }

  private checkPromptError(command: any, submittedText: any): void {
    const message = text(command, 'message');
    const commandName = message.startsWith('/') ? (message.slice(1).split(/\s+/).find(part => part) ?? '') : '';
    const error = this.commandErrors.get(commandName) ?? this.commandErrors.get('');
    if (error !== undefined) throw new Error(error);
    const rejected = this.inputRejection?.text;
    if (jsonEqual(rejected, message) || (typeof submittedText === 'string' && jsonEqual(rejected, submittedText))) {
      if (typeof this.inputRejection?.error === 'string') throw new Error(this.inputRejection.error);
    }
  }

  private async receiveState(data: any): Promise<void> {
    if (!jsonEqual(this.state?.sessionId, data?.sessionId)) Registry.record(data, this.cwd);
    this.state = clone(data);
    const id = data?.sessionId;
    let rekey: [string, string] | undefined;
    if (typeof id === 'string' && id && !this.isTransient && this.key !== id) {
      rekey = [this.key, id];
      this.key = id;
    }
    if (rekey) this.host.rekey(rekey[0], rekey[1], this.epoch);
    await this.reconcileQueue();
    this.publishState();
  }

  private snapshotResponse(data: any, request: Request): any {
    const queue = this.queue.view();
    for (const [, live] of this.liveMessages) {
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      if (!entries.some((entry: any) => jsonEqual(entry?.message?.role, live?.role) && jsonEqual(entry?.message?.timestamp, live?.timestamp))) {
        const id = 'live-' + text(live, 'role') + '-' + JSON.stringify(live?.timestamp ?? null);
        const message = clone(live);
        if (message && typeof message === 'object') message.streaming = live?.role === 'assistant';
        const entry = { type: 'message', id, parentId: data?.leafId ?? null, message };
        if (Array.isArray(data?.entries)) data.entries.push(entry);
        if (data && typeof data === 'object' && !Array.isArray(data)) data.leafId = id;
      }
    }
    const snapshotState = clone(request.snapshotState) ?? null;
    if (snapshotState && typeof snapshotState === 'object' && !Array.isArray(snapshotState)) {
      snapshotState.isStreaming = this.isWorking;
      snapshotState.viewers = this.visibleViewers();
      snapshotState.needsInput = this.dialogs.some(([, dialog]) => !dialog.answering);
      snapshotState.pendingMessageCount = array(queue, 'steering').length + array(queue, 'followUp').length;
    }
    return {
      history: data, revision: this.epoch + ':' + this.contentRevision, sequence: this.sequence, stateRevision: this.stateRevision,
      epoch: this.epoch, liveTools: this.tools.map(([, value]) => clone(value)), extensionState: this.statuses.map(([, value]) => clone(value)),
      queue, state: snapshotState,
    };
  }
}

function queueStorage(host: SessionHost, spec: LaunchSpec, cwd: string | null, home: string, key: string): QueueStorage | null {
  const root = host.queueRoot();
  if (root === null) return null;
  const directory = cwd ?? spec.cwd ?? spec.env.PIOP_SESSION_CWD ?? home;
  return new QueueStorage(root, specIdentity(spec, key)).withOrigin(directory, argument(spec, '--session'));
}

/** Reads user messages from a saved transcript, so the queue can tell which items Pi already took. */
export function savedUserMessages(path: string, sessionId: string): any[] {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw new Error('Cannot verify saved queued input: ' + (error?.message ?? error));
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Queued-input transcript must be a regular file');
    const content = readFileSync(fd);
    const messages = readUserMessages(content, sessionId);
    if (messages.length) {
      try { fsyncSync(fd); } catch (error) { throw new Error('Cannot sync saved queued input: ' + errorText(error)); }
      try {
        const directory = openSync(dirname(path), 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      } catch (error) { throw new Error('Cannot sync queued-input transcript directory: ' + errorText(error)); }
    }
    return messages;
  } finally { closeSync(fd); }
}

function readUserMessages(content: Buffer, sessionId: string): any[] {
  let offset = 0;
  const next = (): any | undefined => {
    const end = content.indexOf(10, offset);
    if (end < 0) return undefined;
    const line = content.subarray(offset, end + 1).toString('utf8');
    offset = end + 1;
    try { return JSON.parse(line); } catch (error) { throw new Error('Cannot verify queued-input transcript: ' + errorText(error)); }
  };
  const header = next();
  if (header === undefined) return [];
  let expected: string;
  try { expected = parseIdentity(sessionId); } catch { throw new Error('Invalid queued-input session identity'); }
  let identity: string | undefined;
  try { identity = typeof header?.id === 'string' ? parseIdentity(header.id) : undefined; } catch {}
  if (header?.type !== 'session' || identity !== expected) throw new Error('Queued-input transcript belongs to a different conversation');
  const messages: any[] = [];
  for (let entry = next(); entry !== undefined; entry = next()) {
    if (entry?.type === 'message' && entry?.message?.role === 'user') messages.push(entry.message);
  }
  return messages;
}
