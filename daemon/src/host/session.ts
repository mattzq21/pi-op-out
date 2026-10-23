import { canFork } from '../../resources/piop-storage/session-records.cjs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { getProjectRepository } from '../project_repositories';
import * as Registry from '../session_registry';
import { Mutex, errorText } from '../util/sync';
import { array, clone, flag, kind, merge, setEntry, text, jsonEqual } from './json';
import { olderHistory, recentHistory, turnWork } from './history_window';
import { savedToolPayload } from './payload';
import { readHeaderLine, argument, prepareSpec, specIdentity, type LaunchSpec, type SessionLaunch } from './protocol';
import { SessionQueue } from './queue';
import type { Execution } from './queue_delivery';
import { QueueStorage } from './queue_storage';
import { savedUserMessages } from './queue_transcript';
import { SessionDialogs, interactive } from './session_dialogs';
import { IdleStop } from './session_idle';
import { LiveOutput } from './session_live';
import { SessionSettings } from './session_settings';
import { PromptErrors } from './prompt_errors';
import { CommandRefusedError } from '../pi_rejection';
import { ToolPayload, type ToolPayloadCache } from './tool_payload';
import type { RuntimeEvent, RuntimeEventSource } from './runtime_events';
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
  /** Called when the state of the conversation identity changes, starts or stops. */
  stateChanged(identity: string): void;
  /** Handles an event that Pi waits on. Pi continues when the promise settles; a rejection is reported to the chat. */
  runtimeEvent(source: RuntimeEventSource, event: RuntimeEvent): Promise<void>;
}

const STATE_CHANGES = new Set(['session_info_changed', 'session_switched', 'model_select', 'thinking_level_changed', 'agent_start', 'agent_end', 'agent_settled',
  'message_start', 'message_end', 'entry_appended', 'pause_state', 'compaction_start', 'compaction_end', 'auto_compaction_start', 'auto_compaction_end']);

function stateChange(name: string): boolean { return STATE_CHANGES.has(name); }

/** Stops other work on the session until the promise settles; it is like an abortable task handle. */
export interface InterruptTask { finished: boolean; promise: Promise<any> }

export class Session {
  private forkAllowed?: boolean;
  readonly identity: string;
  private clientIdValue: string;
  readonly spec: LaunchSpec;
  readonly cwd: string | null;
  readonly timeout: number;
  readonly queue: SessionQueue;
  readonly dialogs: SessionDialogs;
  readonly settings: SessionSettings;
  readonly idleStop: IdleStop;
  readonly orchestrationInterrupt = new Mutex();
  orchestrationTask: InterruptTask | null = null;
  readonly epoch = randomUUID();
  private worker: RuntimeWorker | undefined;
  private events: Promise<void> = Promise.resolve();
  private pendingRequests = 0;
  private live = new LiveOutput();
  private promptErrors = new PromptErrors();

  key: string;
  state: any = null;
  viewsList: Array<[string, any]> = [];
  statuses: Array<[string, any]> = [];
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
  providerRevision = 0;

  private constructor(launch: SessionLaunch, identity: string, pending: any[], storage: QueueStorage | null, private host: SessionHost, private toolPayloads: ToolPayloadCache) {
    this.identity = identity;
    this.clientIdValue = launch.clientId;
    this.spec = launch.spec;
    this.cwd = launch.cwd;
    this.timeout = launch.timeout;
    this.key = launch.key;
    this.isTransient = launch.transient;
    const executor: Execution = {
      execute: command => this.execute(command),
      publish: event => this.publish(event, null),
      savedUserMessages: () => this.savedUserMessages(),
    };
    this.queue = new SessionQueue(executor, pending, storage);
    this.dialogs = new SessionDialogs({
      views: () => this.viewsList,
      readonly: runtime => this.host.readonly(runtime),
      accepting: () => !this.closed() && !this.stopping(),
      publish: (event, target) => this.publish(event, target),
      publishState: () => this.publishState(),
      resolved: () => this.host.maintenance(this.key),
    });
    this.settings = new SessionSettings(this, host);
    this.idleStop = new IdleStop(this, host);
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
      runtimeEvent: event => this.inOrder(() => this.receiveRuntimeEvent(event)),
      // The requester receives a failed response, so it is not also reported as a diagnostic.
      response: (event, request) => this.inOrder(() => this.response(event, request), false),
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

  private inOrder<T>(operation: () => Promise<T>, report = true): Promise<T> {
    const result = this.events.then(operation);
    this.events = result.then(() => {}, error => {
      if (!report) return;
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
  revision(): string { return this.epoch + ':' + this.contentRevision; }
  /** Changes with each state change, and with each start of Pi. */
  stateKey(): string { return this.epoch + ':' + this.stateRevision; }

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
    return this.viewsList.length === 0 && !this.settings.applying() && !flag(this.pauseState, 'isPausing') && this.dialogs.empty();
  }

  idle(): boolean {
    return !this.closed() && !this.stopping() && !this.transient() && this.unused()
      && this.pendingRequests === 0 && this.dialogs.empty() && this.queue.pending().length === 0
      && this.queue.heldCount() === 0 && (!this.orchestrationTask || this.orchestrationTask.finished);
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
    if (stateChange(name)) { this.stateRevision += 1; this.host.stateChanged(this.identity); }
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
    this.idleStop.cancel();
    setEntry(this.viewsList, runtime, presence);
    for (const [, event] of [...this.statuses]) this.publish(event, runtime);
    this.publish(this.queue.view(), runtime);
    this.publish({ type: 'settings_pending', pending: this.settings.pending() }, runtime);
    const error = this.settings.lastError();
    if (error !== null) this.publish({ type: 'extension_error', error }, runtime);
    this.dialogs.route();
    this.publishPresence();
  }

  presence(runtime: string, presence: any): void {
    this.idleStop.cancel();
    setEntry(this.viewsList, runtime, presence);
    this.dialogs.route();
    this.publishPresence();
  }

  detachView(runtime: string): void {
    this.viewsList = this.viewsList.filter(([id]) => id !== runtime);
    this.dialogs.route();
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
    this.idleStop.cancel();
    this.dialogs.stopTimers();
    if (this.worker) await this.worker.stop();
    await this.events;
    await this.queue.flush();
  }

  async drain(): Promise<void> {
    await this.events;
    await this.queue.drain();
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
    this.host.stateChanged(this.identity);
    this.idleStop.cancel();
    this.dialogs.stopTimers();
    this.queue.close();
    void this.inOrder(() => this.finishQueue());
  }

  private async finishQueue(): Promise<void> {
    this.dialogs.clear();
    const key = this.key;
    const transient = this.isTransient;
    try {
      await this.queue.receive({ type: 'disconnected' });
      await this.queue.flush();
    } finally {
      this.host.finished(key, this.epoch, transient);
    }
  }

  async raw(command: any): Promise<any> {
    if (kind(command) === 'get_state' && this.forkAllowed === undefined) {
      const history = await this.rawAs({ type: 'get_entries' }, 'get_entries', null);
      this.forkAllowed = canFork(history.entries);
    }
    return this.rawAs(command, kind(command), null);
  }

  private async rawAs(command: any, requestType: string, snapshot: any): Promise<any> {
    if (this.closed()) throw new CommandRefusedError(this.startupError ?? 'Pi is not running', 'daemon');
    if (requestType === 'prompt' || requestType === 'queue_prompt') this.promptErrors.reset();
    if (!this.worker) throw new CommandRefusedError('Pi is not running', 'daemon');
    if (!this.idleStop.checking() || !requestType.startsWith('get_')) this.idleStop.cancel();
    this.pendingRequests += 1;
    try { return await this.worker.request(command, requestType, snapshot); }
    finally {
      this.pendingRequests -= 1;
      this.idleStop.schedule();
    }
  }

  async send(command: any): Promise<void> {
    if (!this.worker) throw new Error('Pi is not running');
    await this.worker.send(command);
  }

  // Events from Pi.

  private async receive(event: any): Promise<void> {
    this.idleStop.cancel();
    try { await this.receiveEvent(event); }
    finally { this.idleStop.schedule(); }
  }

  private async receiveRuntimeEvent(event: RuntimeEvent): Promise<void> {
    this.idleStop.cancel();
    try { await this.host.runtimeEvent({ sessionKey: this.key, identity: this.identity, cwd: this.cwd }, event); }
    catch (error) {
      this.host.output({ type: 'diagnostic', line: this.key + ': ' + event.name + ' failed: ' + errorText(error) });
      throw error;
    } finally { this.idleStop.schedule(); }
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
    if (kind(event) === 'extension_error' && event.event === 'command') this.promptErrors.commandFailed(event);
    await this.queue.receive(event);
  }

  private retainLive(event: any): void {
    const name = kind(event);
    if (stateChange(name) || name.startsWith('tool_execution_')) this.toolPayloadRevision += 1;
    switch (name) {
      case 'agent_start': this.isWorking = true; this.isSubmitted = true; break;
      case 'agent_settled': this.isWorking = false; this.live.clear(); break;
      case 'compaction_start': case 'auto_compaction_start': this.isCompacting = true; break;
      case 'compaction_end': case 'auto_compaction_end': this.isCompacting = false; break;
      case 'pause_state': this.pauseState = { isPaused: event.isPaused ?? null, isPausing: event.isPausing ?? null }; break;
    }
    this.live.receive(event);
    if (['agent_start', 'agent_settled', 'compaction_start', 'compaction_end', 'auto_compaction_start', 'auto_compaction_end', 'pause_state'].includes(name)) this.publishState();
  }

  private async receiveExtension(event: any): Promise<any | undefined> {
    if (event.method === 'setStatus' && await this.receiveStatus(event)) return undefined;
    this.promptErrors.markNotice(event);
    if (['setStatus', 'setWidget', 'setTitle'].includes(event.method)) {
      const key = text(event, 'method') + ':' + (typeof event.statusKey === 'string' ? event.statusKey : typeof event.widgetKey === 'string' ? event.widgetKey : '');
      setEntry(this.statuses, key, clone(event));
    }
    if (!interactive(event)) return event;
    this.dialogs.receive(event);
    return undefined;
  }

  private async receiveStatus(event: any): Promise<boolean> {
    const parsed = (): { ok: true; value: any } | { ok: false; error: string } => {
      try { return { ok: true, value: JSON.parse(typeof event.statusText === 'string' ? event.statusText : '') }; }
      catch (error) { return { ok: false, error: errorText(error) }; }
    };
    switch (event.statusKey) {
      case 'piop-input-rejected': {
        const result = parsed();
        if (result.ok) this.promptErrors.rejectInput(result.value);
        return true;
      }
      default: return false;
    }
  }

  // Requests.

  async execute(command: any): Promise<any> {
    switch (kind(command)) {
      case 'get_session_revision': return { revision: this.revision() };
      case 'get_tool_payload': return this.collectToolPayload(command);
      case 'get_queued_image': return this.queuedImage(command);
      case 'get_snapshot': { const snapshot = await this.collectSnapshot(); if (flag(command, 'recent') && snapshot?.history) recentHistory(snapshot.history, this.isWorking); return snapshot; }
      case 'get_entries': { const snapshot = await this.collectSnapshot(); return snapshot?.history ?? null; }
      case 'get_older_history': return olderHistory(await this.raw({ type: 'get_entries' }), command.before);
      case 'get_turn_work': return turnWork(await this.raw({ type: 'get_entries' }), command.entryId);
      case 'get_state': return this.collectState(command);
      case 'force_stop': await this.stop(); return null;
      case 'get_available_models': await this.refreshProviders(); break;
      // Pi stops the running response before it compacts, even when there is nothing to compact.
      case 'compact': if (this.working()) throw new CommandRefusedError('Stop or pause piop before running /compact.', 'daemon'); break;
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
    this.settings.remember(command);
    if (kind(command) === 'resume' && typeof result?.resumeMessage === 'string' && result.resumeMessage) await this.raw({ type: 'prompt', message: result.resumeMessage });
    if (['set_model', 'set_thinking_level', 'set_session_name', 'fork_and_forget'].includes(kind(command))) this.publish({ type: 'session_info_changed' }, null);
    // The chat list shows the name, so every client reloads it.
    if (['set_session_name', 'fork_and_forget'].includes(kind(command))) this.host.output({ type: 'sessions_changed' });
    return result;
  }

  /** The data of one image of a queued message. The queue view leaves image data out, so clients ask for it when they show the image. */
  private queuedImage(command: any): { data: string; mimeType: string } {
    const item = this.queue.pending().find(entry => entry?.id === text(command, 'id'));
    const image = Array.isArray(item?.images) ? item.images[Number(command.index)] : undefined;
    if (typeof image?.data !== 'string' || typeof image?.mimeType !== 'string') throw new Error('The image of this queued message is no longer available');
    return { data: image.data, mimeType: image.mimeType };
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
    const live = this.live.toolPayload(id);
    if (live !== undefined) return live;
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
      // stateKey lets a reader wait for the next state change after this snapshot.
      if (current === revision) { if (snapshot && typeof snapshot === 'object') snapshot.stateKey = this.stateKey(); return snapshot; }
      if (Date.now() >= deadline) throw new Error('Session kept changing while collecting its snapshot');
    }
  }

  // Responses from Pi.

  private async response(event: any, request: Request): Promise<any> {
    const goal = await this.rejectGoalPreparation(event, request);
    if (goal) { if ('error' in goal) throw new CommandRefusedError(goal.error); return goal.value; }
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
    if (request.requestType === 'prompt' || request.requestType === 'queue_prompt') this.promptErrors.check(request.command, event?.data?.submittedText);
    if (!flag(event, 'success')) throw new CommandRefusedError(typeof event?.error === 'string' ? event.error : 'Pi command failed');
  }

  private async rejectGoalPreparation(event: any, request: Request): Promise<{ value: any } | { error: string } | undefined> {
    if (flag(event, 'success') || event?.rejection !== 'goal_preparation') return undefined;
    if (request.requestType === 'queue_prompt' && !flag(request.command, 'discardOnRejection')) {
      return { error: typeof event.error === 'string' ? event.error : 'Goal prompt preparation failed' };
    }
    if (flag(request.command, 'discardOnRejection')) await this.queue.rejected(text(request.command, 'queueId'));
    return { value: false };
  }

  private async receiveState(data: any): Promise<void> {
    const queueRoot = this.host.queueRoot();
    if (data && typeof data === 'object') {
      data.canFork = this.forkAllowed === true;
      data.cwd = this.cwd ?? undefined;
      data.repository = queueRoot && this.cwd ? getProjectRepository(dirname(queueRoot), this.cwd) : null;
      if (typeof data.sessionFile === 'string') {
        const header = JSON.parse(readHeaderLine(data.sessionFile));
        if (header.piopForkSource) data.forkSource = header.piopForkSource;
      }
    }
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
    this.live.addTo(data);
    const snapshotState = clone(request.snapshotState) ?? null;
    if (snapshotState && typeof snapshotState === 'object' && !Array.isArray(snapshotState)) {
      snapshotState.canFork = canFork(data.entries);
      this.forkAllowed = snapshotState.canFork;
      snapshotState.isStreaming = this.isWorking;
      snapshotState.viewers = this.visibleViewers();
      snapshotState.needsInput = !this.dialogs.empty();
      snapshotState.pendingMessageCount = array(queue, 'steering').length + array(queue, 'followUp').length;
    }
    return {
      history: data, revision: this.epoch + ':' + this.contentRevision, sequence: this.sequence, stateRevision: this.stateRevision,
      epoch: this.epoch, liveTools: this.live.runningTools(), extensionState: this.statuses.map(([, value]) => clone(value)),
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
