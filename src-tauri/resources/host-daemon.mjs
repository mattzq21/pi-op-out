import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { link, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const sessions = new Map();
const subscriptions = new Map();
const attachments = new Map();
const readonlyViews = new Map();
const ownershipDrains = new Map();
const ownershipReleases = new Map();
const ownershipCaptureKeys = new Map();
const retryMessages = new Map();
let desiredConfiguration;
const interactiveMethods = new Set(['input', 'editor', 'select', 'confirm']);
const stateChanges = new Set(['session_info_changed', 'session_switched', 'model_select', 'thinking_level_changed', 'agent_start', 'agent_end', 'agent_settled', 'message_start', 'message_end', 'entry_appended', 'pause_state', 'compaction_start', 'compaction_end', 'auto_compaction_start', 'auto_compaction_end']);
function clientPayload(_key, value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value.entries) && Object.hasOwn(value, 'leafId')) return clientHistory(value);
  if (value.role === 'toolResult') return { ...value, content: '', details: undefined, toolInput: undefined, deferredToolPayload: value.toolCallId };
  return clientToolPayload(value);
}

function clientToolPayload(value) {
  if (value.type === 'toolCall') return { type: 'toolCall', id: value.id, name: value.name };
  if (value.type === 'toolcall_delta') return { ...value, delta: undefined };
  if (value.type === 'toolcall_end' && value.toolCall) return { ...value, toolCall: { id: value.toolCall.id, name: value.toolCall.name } };
  if (typeof value.type === 'string' && value.type.startsWith('tool_execution_')) {
    const deferred = { content: '', deferredToolPayload: value.toolCallId };
    return { ...value, args: undefined, ...(value.result ? { result: deferred } : {}), ...(value.partialResult ? { partialResult: deferred } : {}) };
  }
  return value;
}

function clientHistory(history) {
  // Bound initial transfers too, after removing tool bodies. Allow headroom for
  // the decoded history and normalized messages to coexist during installation.
  const limit = 256 * 1024 * 1024;
  const entries = [];
  let size = 0;
  for (let index = history.entries.length - 1; index >= 0; index--) {
    const entry = history.entries[index];
    const cost = JSON.stringify(entry, clientPayload).length * 4 + 256;
    if (size + cost > limit) break;
    size += cost; entries.push(entry);
  }
  return { ...history, entries: entries.reverse(), omittedEntries: history.entries.length - entries.length };
}
const output = (packet) => process.stdout.write(JSON.stringify(packet, clientPayload) + '\n');

function savedToolCall(message, id) {
  if (!Array.isArray(message?.content)) return undefined;
  return message.content.find((part) => part.type === 'toolCall' && part.id === id);
}

function savedToolPayload(entries, id) {
  let toolInput;
  let result;
  for (const entry of entries) {
    const message = entry.message;
    if (message?.role === 'toolResult' && message.toolCallId === id) result = message;
    const call = savedToolCall(message, id);
    if (call) toolInput = call.arguments;
  }
  if (!result && toolInput === undefined) return undefined;
  return { ...(result ?? { content: '' }), toolInput };
}

function toolPayloadPage(message, command) {
  if (!message) throw new Error('Tool input and output are not available yet');
  const serialized = JSON.stringify({ content: message.content ?? '', details: message.details, toolInput: message.toolInput });
  const revision = createHash('sha256').update(serialized).digest('hex');
  if (command.revision && command.revision !== revision) throw new Error('Tool payload changed; reopen it to reload');
  const offset = Number(command.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > serialized.length) throw new Error('Invalid output offset');
  return { revision, length: serialized.length, chunk: serialized.slice(offset, offset + 524288) };
}
const errorText = (error) => error instanceof Error ? error.message : String(error);
async function releaseConversation(id, intent) {
  if (ownershipReleases.has(id)) return ownershipReleases.get(id);
  const pending = (async () => {
    const keys = ownershipCaptureKeys.get(id) ?? new Set();
    ownershipCaptureKeys.set(id, keys);
    for (const session of [...sessions.values()].filter((item) => item.identity === id)) {
      if (intent === 'message') await session.retire();
      await hostVoice.release(session);
      for (const runtimeId of session.views.keys()) readonlyViews.set(runtimeId, { id, path: session.state?.sessionFile });
      session.publish({ type: 'ownership_lost' });
      if (session.working || session.compacting) { try { await session.raw({ type: 'abort' }); } catch { /* Stopping the worker below still fences all writes. */ } }
      await session.stop();
      keys.add(session.key);
    }
    for (const key of keys) {
      const requestId = randomUUID();
      await new Promise((resolve, reject) => {
        ownershipDrains.set(requestId, { resolve, reject });
        output({ type: 'ownership_drain', id: requestId, sessionKey: key });
      });
      keys.delete(key);
    }
    ownershipCaptureKeys.delete(id);
  })();
  ownershipReleases.set(id, pending);
  void pending.then(() => { ownershipReleases.delete(id); }, () => { ownershipReleases.delete(id); });
  return pending;
}
const ownership = new ConversationOwnership(piStorageDirectory, releaseConversation);
const hostVoice = new HostVoiceService();
let providerAuthRevision = 0;
const providerAuth = typeof ProviderAuthService === 'undefined' ? undefined : new ProviderAuthService(piAuthExecutable, () => {
  providerAuthRevision++;
  for (const session of sessions.values()) session.publish({ type: 'session_info_changed' });
  output({ type: 'provider_auth_changed' });
});
const canonicalSettings = (value) => Array.isArray(value) ? value.map(canonicalSettings) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalSettings(value[key])])) : value;

function applyAssistantMessageDelta(message, event) {
  const index = event?.contentIndex;
  if (!Number.isInteger(index) || index < 0) return message;
  // Snapshots retain these objects at their sequence; later deltas must not mutate them.
  const content = Array.isArray(message.content) ? [...message.content] : message.content ? [{ type: 'text', text: message.content }] : [];
  while (content.length <= index) content.push({ type: 'text', text: '' });
  const current = content[index];
  const tool = retainedToolCall(current, event, index);
  const handlers = {
    'text_start': () => {
      return { type: 'text', text: '' };
    },
    'text_delta': () => {
      return { ...current, type: 'text', text: `${current?.type === 'text' ? current.text : ''}${event.delta ?? ''}` };
    },
    'text_end': () => {
      return { ...current, type: 'text', text: event.content ?? '' };
    },
    'thinking_start': () => {
      return { type: 'thinking', thinking: '' };
    },
    'thinking_delta': () => {
      return { ...current, type: 'thinking', thinking: `${current?.type === 'thinking' ? current.thinking : ''}${event.delta ?? ''}` };
    },
    'thinking_end': () => {
      return { ...current, type: 'thinking', thinking: event.content ?? '' };
    },
    'toolcall_start': () => {
      return { type: 'toolCall', id: event.id || tool.id, name: event.toolName || tool.name, arguments: {}, partialArgs: '' };
    },
    'toolcall_delta': () => {
      return { ...tool, partialArgs: `${tool.partialArgs ?? ''}${event.delta ?? ''}` };
    },
    'toolcall_end': () => {
      if (!event.toolCall) return undefined;
      return { ...event.toolCall, type: 'toolCall' };
    }
  };
  if (!Object.hasOwn(handlers, event.type)) return message;
  const next = handlers[event.type]();
  if (!next) return message;
  content[index] = next;
  return { ...message, content };
}

function retainedToolCall(current, event, index) {
  return current?.type === 'toolCall' ? current : { type: 'toolCall', id: event.id || `tool-${index}`, name: event.toolName || 'tool', arguments: {}, partialArgs: '' };
}

class Session {
  constructor(key, spec, timeout, ephemeral, transient = false, clientId) {
    spec = this.prepareSpec(key, spec, clientId);
    this.key = key;
    this.identity = spec.args.includes('--session') ? key : spec.args[spec.args.lastIndexOf('--session-id') + 1];
    this.spec = spec;
    this.timeout = timeout;
    this.ephemeral = ephemeral;
    this.transient = transient;
    this.views = new Map();
    this.pending = new Map();
    this.statuses = new Map();
    this.dialogs = new Map();
    this.liveMessages = new Map();
    this.tools = new Map();
    this.sequence = 0;
    this.stateRevision = 0;
    this.contentRevision = 0;
    this.epoch = randomUUID();
    this.commandErrors = new Map();
    this.working = false;
    this.compacting = false;
    this.agentRevision = desiredConfiguration?.agentRevision ?? 0;
    this.submitted = false;
    this.queue = new SessionQueue((command) => this.execute(command), (event) => this.publish(event));
    this.queue.pendingMessages = retryMessages.get(key) ?? [];
    retryMessages.delete(key);
    const launch = workerLaunch(spec, this.identity);
    this.child = spawn(launch.program, launch.args, { cwd: spec.cwd || undefined, env: { ...process.env, ...spec.env, PI_DESKTOP_GIT_CAPTURE_SCRIPT: ephemeral ? '' : gitCaptureScript }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.ready = new Promise((resolve, reject) => { this.child.once('spawn', resolve); this.child.once('error', reject); });
    this.ready.catch(() => undefined);
    this.child.stdin.on('error', () => { });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try { this.receive(JSON.parse(line)); } catch (error) { output({ type: 'diagnostic', line: errorText(error) }); }
    });
    createInterface({ input: this.child.stderr }).on('line', (line) => {
      if (!this.state) this.startupError = line;
      for (const runtimeId of this.views.keys()) output({ type: 'stderr', runtimeId, line });
    });
    this.child.once('error', (error) => this.finish(errorText(error)));
    this.child.once('close', () => this.finish(this.startupError || 'Pi disconnected before responding'));
  }

  finish(error) {
    if (this.closed) return;
    this.closed = true;
    if (!this.transient && sessions.get(this.key) === this) sessions.delete(this.key);
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(error)); }
    this.pending.clear();
    this.queue.receive({ type: 'disconnected' });
    if (this.queue.pendingMessages.length && !this.ephemeral) retryMessages.set(this.key, this.queue.pendingMessages);
    for (const runtimeId of this.views.keys()) subscriptions.delete(runtimeId);
    if (!this.transient) output({ type: 'session_closed', sessionKey: this.key, state: this.state, submitted: this.submitted });
  }

  publish(event, target) {
    if (!target) hostVoice.agentEvent(this, event);
    const previousRevision = this.clientRevision();
    if (stateChanges.has(event.type)) this.stateRevision++;
    this.advanceContentRevision(event);
    if (this.transient) return;
    const envelope = { ...event, previousRevision, revision: this.clientRevision(), sequence: ++this.sequence, epoch: this.epoch };
    const viewers = target ? [target] : [...this.views.keys(), ...[...readonlyViews].filter(([runtimeId, view]) => view.id === this.identity && !this.views.has(runtimeId)).map(([runtimeId]) => runtimeId)];
    for (const runtimeId of viewers) {
      if (this.hideInteractiveEvent(runtimeId, event)) continue;
      output({ type: 'event', runtimeId, event: envelope });
    }
    if (event.type === 'queue_update' || event.type === 'settings_pending') this.publishState();
    if (['agent_settled', 'compaction_end', 'auto_compaction_end', 'queue_update'].includes(event.type)) void this.reconcileConfiguration();
  }

  settingsPending() {
    return Boolean(desiredConfiguration && this.appliedConfiguration !== desiredConfiguration);
  }

  clientRevision() { return `${this.epoch}:${this.contentRevision}`; }

  advanceContentRevision(event) {
    if (stateChanges.has(event.type) || ['message_update', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'queue_update', 'settings_applied', 'extension_ui_request'].includes(event.type)) this.contentRevision++;
  }

  configurationBusy(state = {}) {
    const queue = this.queue.queueView();
    return this.working || this.compacting || state.isStreaming || state.isCompacting || state.pendingMessageCount > 0 || queue.steering.length || queue.followUp.length || this.queue.pendingMessages.length;
  }

  reconcileConfiguration(retry = false) {
    if (retry) { this.configurationFailed = false; this.configurationError = undefined; }
    if (this.transient || this.closed || this.stopPromise || !this.settingsPending()) return Promise.resolve();
    if (this.configurationPromise) { this.configurationRequested = true; return this.configurationPromise; }
    if (this.configurationFailed || this.configurationBusy()) return Promise.resolve();
    this.configurationPromise = this.queue.serializeQueue(async () => {
      while (!this.closed && !this.stopPromise && this.settingsPending()) {
        const state = await this.raw({ type: 'get_state' });
        if (this.configurationBusy(state)) return;
        const configuration = desiredConfiguration;
        await this.execute({ type: 'runtime_settings', settings: configuration.settings, agentRevision: configuration.agentRevision, reloadAgents: this.agentRevision < configuration.agentRevision });
        if (this.autoCompaction !== configuration.autoCompaction) await this.execute({ type: 'set_auto_compaction', enabled: configuration.autoCompaction });
        if (this.autoRetry !== configuration.autoRetry) await this.execute({ type: 'set_auto_retry', enabled: configuration.autoRetry });
        this.agentRevision = configuration.agentRevision;
        this.appliedConfiguration = configuration;
        this.publish({ type: 'settings_applied' });
      }
    }).catch((error) => {
      if (this.closed || this.stopPromise) return;
      if (this.configurationBusy()) return;
      this.configurationFailed = true;
      this.configurationError = `Saved settings could not be applied: ${errorText(error)}. Save again or reopen the conversation to retry.`;
      this.publish({ type: 'extension_error', error: this.configurationError });
      if (!this.views.size) output({ type: 'diagnostic', line: `Could not apply settings to ${this.key}: ${errorText(error)}` });
    }).finally(() => {
      this.configurationPromise = undefined;
      this.publish({ type: 'settings_pending', pending: this.settingsPending() });
      const requested = this.configurationRequested; this.configurationRequested = false;
      if (requested && !this.configurationFailed) void this.reconcileConfiguration();
    });
    return this.configurationPromise;
  }

  publishState() {
    if (this.transient) return;
    output({ type: 'session_state', sessionKey: this.key, state: this.state, working: this.working, worktree: this.worktree, presenceId: this.presenceId, messageable: !this.views.size && !this.configurationBusy() && !this.configurationPromise && !this.dialogs.size && !this.pauseState?.isPausing });
  }

  publishPresence() {
    this.publish({ type: 'runtime_presence', viewers: [...this.views.values()].filter((view) => view.visible).length, isStreaming: this.working });
    this.publishState();
  }

  async stop() {
    if (this.closed) return;
    this.stopPromise ??= new Promise((resolve) => {
      const force = setTimeout(() => this.child.kill('SIGKILL'), 5000); force.unref();
      this.child.once('close', () => { clearTimeout(force); resolve(); }); this.child.kill();
    });
    await this.stopPromise;
  }

  async retire() {
    if (this.transient) throw new Error('This conversation branch is still being prepared');
    const assertIdle = (state) => {
      if (this.views.size) throw new Error('Close this conversation in all windows before messaging or archiving it');
      if (this.configurationBusy(state) || this.configurationPromise || state?.isPausing || this.pauseState?.isPausing || this.dialogs.size) throw new Error('Finish the response, queued messages, and settings changes before messaging or archiving this conversation');
    };
    if (this.closed) return;
    assertIdle();
    await this.queue.serializeQueue(async () => {
      if (this.closed) return;
      assertIdle();
      const state = await this.execute({ type: 'get_state' });
      assertIdle(state);
      await this.stop();
    });
  }

  routeDialogs() {
    for (const [id, dialog] of this.dialogs) {
      if (dialog.owner && this.views.get(dialog.owner)?.visible) continue;
      if (dialog.owner) this.publish({ type: 'extension_ui_resolved', id }, dialog.owner);
      dialog.owner = [...this.views].filter(([, view]) => view.visible).sort((a, b) => Number(b[1].focused) - Number(a[1].focused))[0]?.[0];
      if (dialog.owner) this.publish(dialog.event, dialog.owner);
    }
    this.publishState();
  }

  attach(runtimeId, presence = {}) {
    this.views.set(runtimeId, presence);
    subscriptions.set(runtimeId, this);
    for (const event of this.statuses.values()) this.publish(event, runtimeId);
    this.publish(this.queue.queueView(), runtimeId);
    this.publish({ type: 'settings_pending', pending: this.settingsPending() }, runtimeId);
    if (this.configurationError) this.publish({ type: 'extension_error', error: this.configurationError }, runtimeId);
    this.routeDialogs();
    this.publishPresence();
  }

  async detach(runtimeId, discardBlank = false, preserveRunning = false) {
    const voiceClosed = hostVoice.detach(runtimeId);
    this.views.delete(runtimeId);
    subscriptions.delete(runtimeId);
    this.routeDialogs();
    this.publishPresence();
    await voiceClosed;
    const stopped = !preserveRunning && !this.views.size && (this.ephemeral || (discardBlank && !this.submitted && !this.working));
    if (stopped) await this.stop();
    await this.releaseUnusedOwnership();
    return { stopped, submitted: this.submitted };
  }

  async releaseUnusedOwnership() {
    if (!this.ephemeral && !this.views.size && !this.configurationBusy()) await ownership.releaseClient(this.identity, this.clientId, () => !this.views.size && !this.configurationBusy());
  }

  receive(event) {
    if (event.type === 'extension_ui_request' && event.method === 'setStatus' && ['pi-desktop-control-response', 'pi-desktop-pause-state'].includes(event.statusKey)) {
      if (!event.statusText?.startsWith('json:')) return;
      event = JSON.parse(event.statusText.slice(5));
    }
    if (event.type === 'response') {
      this.receiveResponse(event);
      return;
    }
    this.retainLiveEvent(event);
    if (event.type === 'extension_ui_request') {
      event = this.receiveExtension(event);
      if (!event) return;
    }
    this.retainCommandError(event);
    this.queue.receive(event);
  }

  receiveResponse(event) {
    const control = event.id?.endsWith(':desktop-control');
    if (control && event.success) return;
    const id = control ? event.id.slice(0, -16) : event.id;
    const request = this.pending.get(id);
    if (request) {
      this.pending.delete(id); clearTimeout(request.timer);
      if (this.rejectPrompt(request)) return;
      this.tagSteeringEntries(event, request);
      this.resolveResponse(event, request);
    }
  }

  rejectPrompt(request) {
    if (request.type === 'prompt') {
      const error = this.commandErrors.get(String(request.command.message).match(/^\/(\S+)/)?.[1] ?? '') ?? this.commandErrors.get('');
      const rejection = this.inputRejection?.text === request.command.message ? this.inputRejection.error : undefined;
      if (error || rejection) { request.reject(new Error(error || rejection)); return true; }
    }
  }

  resolveSnapshot(event, request) {
    const history = event.data;
    for (const message of this.liveMessages.values()) {
      if (!history.entries.some((entry) => entry.message?.role === message.role && entry.message?.timestamp === message.timestamp)) {
        const id = `live-${message.role}-${message.timestamp}`;
        history.entries.push({ type: 'message', id, parentId: history.leafId, message: { ...message, streaming: message.role === 'assistant' } }); history.leafId = id;
      }
    }
    const queue = this.queue.queueView();
    request.resolve({ history, revision: this.clientRevision(), sequence: this.sequence, stateRevision: this.stateRevision, epoch: this.epoch, liveTools: [...this.tools.values()], queue, state: { ...request.snapshotState, isStreaming: this.working, viewers: [...this.views.values()].filter((view) => view.visible).length, pendingMessageCount: queue.steering.length + queue.followUp.length } });
  }

  retainState(event) {
    this.state = event.data;
    if (this.state.sessionId && !this.ephemeral && !this.transient && this.key !== this.state.sessionId) {
      if (sessions.get(this.key) === this) sessions.delete(this.key);
      this.key = this.state.sessionId; sessions.set(this.key, this);
    }
    this.publishState();
  }

  retainLiveEvent(event) {
    if (event.type === 'agent_start') { this.working = true; this.submitted = true; this.publishState(); }
    if (event.type === 'agent_settled') { this.working = false; this.liveMessages.clear(); this.tools.clear(); this.publishState(); }
    if (event.type === 'compaction_start' || event.type === 'auto_compaction_start') this.compacting = true;
    if (event.type === 'compaction_end' || event.type === 'auto_compaction_end') this.compacting = false;
    if (event.type === 'pause_state') this.pauseState = { isPaused: event.isPaused, isPausing: event.isPausing };
    if (['compaction_start', 'compaction_end', 'auto_compaction_start', 'auto_compaction_end', 'pause_state'].includes(event.type)) this.publishState();
    this.retainMessageEvent(event);
  }

  retainMessageEvent(event) {
    if (event.type === 'message_start') this.liveMessages.set(event.message.role, event.message);
    if (event.type === 'message_update') {
      this.retainAssistantMessage(event);
    }
    if (event.type === 'message_end') this.liveMessages.delete(event.message.role);
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_update') {
      const previous = this.tools.get(event.toolCallId);
      this.tools.set(event.toolCallId, { ...previous, ...event, type: 'tool_execution_start' });
    }
    if (event.type === 'tool_execution_end') this.tools.delete(event.toolCallId);
  }

  receiveExtension(event) {
    if (this.receiveExtensionStatus(event)) return;
    if (event.method === 'notify' && event.notifyType === 'error' && event.message === this.inputRejection?.error) event = { ...event, inputRejected: true };
    this.retainExtensionStatus(event);
    if (interactiveMethods.has(event.method)) {
      this.dialogs.set(event.id, { event }); this.routeDialogs(); return;
    }
    return event;
  }

  receiveExtensionStatus(event) {
    if (event.method === 'setStatus' && event.statusKey === 'pi-desktop-turn-capture') {
      const capture = JSON.parse(event.statusText);
      output({ ...capture, type: 'turn_capture', sessionKey: this.key });
      return true;
    }
    if (event.method === 'setStatus' && event.statusKey === 'pi-desktop-worktree-presence') {
      try { const presence = JSON.parse(event.statusText); this.worktree = presence.worktree; this.presenceId = presence.id; this.publishState(); } catch { /* Ignore incomplete presence. */ }
      return true;
    }
    if (event.method === 'setStatus' && event.statusKey === 'piop-input-rejected') {
      try { this.inputRejection = JSON.parse(event.statusText); } catch { /* Ignore malformed rejections. */ }
      return true;
    }
  }

  async collectSnapshot() {
    const deadline = Date.now() + this.timeout;
    for (; ;) {
      const revision = this.stateRevision;
      const state = await this.raw({ type: 'get_state' });
      const pause = await this.raw({ type: 'get_pause_state' });
      const { stateRevision, ...snapshot } = await this.raw({ type: 'get_entries' }, 'get_snapshot_entries', { ...state, ...pause });
      if (revision === stateRevision) return snapshot;
      if (Date.now() >= deadline) throw new Error('Session kept changing while collecting its snapshot');
    }
  }

  async collectState(command) {
    const state = await this.raw(command); const pause = await this.raw({ type: 'get_pause_state' });
    return { ...state, ...pause, pendingMessages: this.queue.queueView().pendingMessages, pendingMessageCount: state.pendingMessageCount + (this.queue.heldMessages?.length ?? 0) };
  }

  async retainCommandResult(command, result) {
    if (command.type === 'set_auto_compaction') this.autoCompaction = command.enabled;
    if (command.type === 'set_auto_retry') this.autoRetry = command.enabled;
    if (command.type === 'resume' && result?.resumeMessage) await this.raw({ type: 'prompt', message: result.resumeMessage });
    if (['set_model', 'set_thinking_level', 'set_session_name', 'fork_and_forget', 'runtime_settings'].includes(command.type)) this.publish({ type: 'session_info_changed' });
  }

  submitsMessage(command) { return command.type === 'voice_history' || command.type === 'prompt' && !String(command.message).startsWith('/'); }

  prepareSpec(key, spec, clientId) {
    spec = { ...spec, env: { ...spec.env, PIOP_CONVERSATION_CLIENT: clientId || '' } };
    if (spec.env.PIOP_SESSION_CWD?.startsWith('~')) spec.env.PIOP_SESSION_CWD = spec.env.PIOP_SESSION_CWD.replace(/^~(?=\/|$)/, homedir());
    this.clientId = clientId;
    const identityIndex = spec.args.lastIndexOf('--session-id');
    if (!spec.args.includes('--session') && identityIndex < 0) spec = { ...spec, args: [...spec.args, '--session-id', key] };
    return spec;
  }

  hideInteractiveEvent(runtimeId, event) { return readonlyViews.has(runtimeId) && event.type === 'extension_ui_request' && interactiveMethods.has(event.method); }

  retainCommandError(event) {
    if (event.type === 'extension_error' && event.event === 'command') this.commandErrors.set(event.extensionPath?.startsWith('command:') ? event.extensionPath.slice(8) : '', event.error || 'Extension command failed');
  }

  tagSteeringEntries(event, request) {
    if (event.success && ['get_entries', 'get_snapshot_entries'].includes(request.type)) {
      for (const entry of event.data.entries) if (entry.message?.role === 'user' && this.queue.steeringTimestamps.has(entry.message.timestamp)) entry.message.deliveryBehavior = 'steer';
    }
  }

  resolveResponse(event, request) {
    if (request.type === 'get_state' && event.success) {
      this.retainState(event);
    }
    if (request.type === 'get_snapshot_entries' && event.success) {
      this.resolveSnapshot(event, request);
    } else if (event.success) request.resolve(event.data ?? null);
    else request.reject(new Error(event.error || 'Pi command failed'));
  }

  retainAssistantMessage(event) {
    const previous = this.liveMessages.get('assistant');
    const message = event.assistantMessageEvent?.partial ?? event.message ?? (previous && applyAssistantMessageDelta(previous, event.assistantMessageEvent));
    if (message) this.liveMessages.set(message.role ?? 'assistant', event.usage ? { ...message, usage: event.usage } : message);
  }

  retainExtensionStatus(event) {
    if (event.method === 'setStatus' || event.method === 'setWidget' || event.method === 'setTitle') this.statuses.set(`${event.method}:${event.statusKey ?? event.widgetKey ?? ''}`, event);
  }

  runtimeSettingsKey(command) { return command.type === 'runtime_settings' ? JSON.stringify(canonicalSettings({ settings: command.settings, agentRevision: command.agentRevision ?? this.agentRevision })) : undefined; }
  raw(command, requestType = command.type, snapshotState) {
    if (this.closed) return Promise.reject(new Error(this.startupError || 'Pi is not running'));
    const id = randomUUID();
    if (requestType === 'prompt') { this.inputRejection = undefined; this.commandErrors.clear(); }
    let wire = { ...command, id };
    const action = { pause: 'pause', resume: 'resume', abort: 'stop', get_pause_state: 'state' }[command.type];
    const extension = { provider_auth_refresh: 'piop-provider-auth-refresh', runtime_settings: 'piop-runtime-settings', branch_checkpoint: 'pi-desktop-branch-checkpoint', fork_and_forget: 'pi-desktop-fork-and-forget', voice_history: 'pi-desktop-voice-history' }[command.type];
    if (action || extension) wire = { type: 'prompt', id: `${id}:desktop-control`, message: `/${extension ?? 'pi-desktop-control'} ${JSON.stringify(action ? { id, action } : { ...command, id })}` };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error('Pi command timed out'));
        // Only an explicit stop may terminate a shared runtime on timeout.
        if (command.type === 'abort') this.child.kill();
      }, command.type === 'abort' ? 5000 : this.timeout);
      this.pending.set(id, { resolve, reject, timer, type: requestType, command, snapshotState });
      this.child.stdin.write(JSON.stringify(wire) + '\n', (error) => {
        if (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
      });
    });
  }

  async refreshProviderModels() {
    let force = false;
    try { await providerAuth?.checkForChanges(); }
    catch { force = true; }
    if (!force && (providerAuthRevision === 0 || this.providerAuthRevision === providerAuthRevision)) return;
    const revision = providerAuthRevision;
    await this.raw({ type: 'provider_auth_refresh' });
    this.providerAuthRevision = revision;
  }

  async collectToolPayload(command) {
    const live = this.tools.get(command.toolCallId);
    if (live) return toolPayloadPage({ ...live.partialResult, toolInput: live.args }, command);
    const history = await this.raw({ type: 'get_entries' });
    return toolPayloadPage(savedToolPayload(history.entries, command.toolCallId), command);
  }

  async executeWorkerCommand(command) {
    if (this.submitsMessage(command)) this.submitted = true;
    const runtimeSettingsKey = this.runtimeSettingsKey(command);
    if (runtimeSettingsKey !== undefined && this.appliedRuntimeSettings?.key === runtimeSettingsKey) return this.appliedRuntimeSettings.result;
    const result = await this.raw(command);
    if (runtimeSettingsKey !== undefined) this.appliedRuntimeSettings = { key: runtimeSettingsKey, result };
    await this.retainCommandResult(command, result);
    return result;
  }

  async execute(command) {
    const readers = {
      get_session_revision: () => ({ revision: this.clientRevision() }),
      get_tool_payload: () => this.collectToolPayload(command),
      get_snapshot: () => this.collectSnapshot(),
      get_entries: async () => (await this.collectSnapshot()).history,
      get_state: () => this.collectState(command),
      force_stop: () => this.stop(),
    };
    if (Object.hasOwn(readers, command.type)) return readers[command.type]();
    if (command.type === 'get_available_models') await this.refreshProviderModels();
    return this.executeWorkerCommand(command);
  }
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  let packet;
  try { packet = JSON.parse(line); } catch { return; }
  Promise.resolve().then(() => handle(packet)).then(
    (data) => output({ type: 'response', id: packet.id, data: data ?? null }),
    (error) => output({ type: 'response', id: packet.id, error: errorText(error) }),
  );
});
input.on('close', () => { hostVoice.shutdown(); providerAuth?.shutdown(); ownership.shutdown(); for (const session of sessions.values()) session.child.kill(); });
process.on('SIGTERM', () => { hostVoice.shutdown(); providerAuth?.shutdown(); ownership.shutdown(); for (const session of sessions.values()) session.child.kill(); });
process.on('exit', () => { ownership.shutdown(); for (const session of sessions.values()) session.child.kill(); });
