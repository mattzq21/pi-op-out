import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { link, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const sessions = new Map();
const subscriptions = new Map();
const retryMessages = new Map();
let desiredConfiguration;
const interactiveMethods = new Set(['input', 'editor', 'select', 'confirm']);
const stateChanges = new Set(['session_info_changed', 'session_switched', 'model_select', 'thinking_level_changed', 'agent_start', 'agent_end', 'agent_settled', 'message_start', 'message_end', 'entry_appended', 'pause_state', 'compaction_start', 'compaction_end', 'auto_compaction_start', 'auto_compaction_end']);
const output = (packet) => process.stdout.write(JSON.stringify(packet) + '\n');
const errorText = (error) => error instanceof Error ? error.message : String(error);
let providerAuthRevision = 0;
const providerAuth = typeof ProviderAuthService === 'undefined' ? undefined : new ProviderAuthService(piAuthExecutable, () => {
  providerAuthRevision++;
  for (const session of sessions.values()) session.publish({ type: 'session_info_changed' });
});
const canonicalSettings = (value) => Array.isArray(value) ? value.map(canonicalSettings) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalSettings(value[key])])) : value;

function applyAssistantMessageDelta(message, event) {
  const index = event?.contentIndex;
  if (!Number.isInteger(index) || index < 0) return message;
  // Snapshots retain these objects at their sequence; later deltas must not mutate them.
  const content = Array.isArray(message.content) ? [...message.content] : message.content ? [{ type: 'text', text: message.content }] : [];
  while (content.length <= index) content.push({ type: 'text', text: '' });
  const current = content[index];
  const tool = current?.type === 'toolCall' ? current : { type: 'toolCall', id: event.id || `tool-${index}`, name: event.toolName || 'tool', arguments: {}, partialArgs: '' };
  switch (event.type) {
    case 'text_start': content[index] = { type: 'text', text: '' }; break;
    case 'text_delta': content[index] = { ...current, type: 'text', text: `${current?.type === 'text' ? current.text : ''}${event.delta ?? ''}` }; break;
    case 'text_end': content[index] = { ...current, type: 'text', text: event.content ?? '' }; break;
    case 'thinking_start': content[index] = { type: 'thinking', thinking: '' }; break;
    case 'thinking_delta': content[index] = { ...current, type: 'thinking', thinking: `${current?.type === 'thinking' ? current.thinking : ''}${event.delta ?? ''}` }; break;
    case 'thinking_end': content[index] = { ...current, type: 'thinking', thinking: event.content ?? '' }; break;
    case 'toolcall_start': content[index] = { type: 'toolCall', id: event.id || tool.id, name: event.toolName || tool.name, arguments: {}, partialArgs: '' }; break;
    case 'toolcall_delta': content[index] = { ...tool, partialArgs: `${tool.partialArgs ?? ''}${event.delta ?? ''}` }; break;
    case 'toolcall_end':
      if (!event.toolCall) return message;
      content[index] = { ...event.toolCall, type: 'toolCall' };
      break;
    default: return message;
  }
  return { ...message, content };
}

class Session {
  constructor(key, spec, timeout, ephemeral, transient = false) {
    this.key = key;
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
    this.epoch = randomUUID();
    this.commandErrors = new Map();
    this.working = false;
    this.compacting = false;
    this.agentRevision = desiredConfiguration?.agentRevision ?? 0;
    this.submitted = false;
    this.queue = new SessionQueue((command) => this.execute(command), (event) => this.publish(event));
    this.queue.pendingMessages = retryMessages.get(key) ?? [];
    retryMessages.delete(key);
    this.child = spawn(spec.program, spec.args, { cwd: spec.cwd || undefined, env: { ...process.env, ...spec.env, PI_DESKTOP_GIT_CAPTURE_SCRIPT: ephemeral ? '' : gitCaptureScript }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.ready = new Promise((resolve, reject) => { this.child.once('spawn', resolve); this.child.once('error', reject); });
    this.ready.catch(() => undefined);
    this.child.stdin.on('error', () => {});
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try { this.receive(JSON.parse(line)); } catch (error) { output({ type: 'diagnostic', line: errorText(error) }); }
    });
    createInterface({ input: this.child.stderr }).on('line', (line) => {
      for (const runtimeId of this.views.keys()) output({ type: 'stderr', runtimeId, line });
    });
    this.child.once('error', (error) => this.finish(errorText(error)));
    this.child.once('close', () => this.finish('Pi disconnected before responding'));
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
    if (stateChanges.has(event.type)) this.stateRevision++;
    if (this.transient) return;
    const envelope = { ...event, sequence: ++this.sequence, epoch: this.epoch };
    for (const runtimeId of target ? [target] : this.views.keys()) output({ type: 'event', runtimeId, event: envelope });
    if (event.type === 'queue_update' || event.type === 'settings_pending') this.publishState();
    if (['agent_settled', 'compaction_end', 'auto_compaction_end', 'queue_update'].includes(event.type)) void this.reconcileConfiguration();
  }

  settingsPending() {
    return Boolean(desiredConfiguration && this.appliedConfiguration !== desiredConfiguration);
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
    this.stopPromise ??= new Promise((resolve) => { this.child.once('close', resolve); this.child.kill(); });
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

  async detach(runtimeId, discardBlank = false) {
    this.views.delete(runtimeId);
    subscriptions.delete(runtimeId);
    this.routeDialogs();
    this.publishPresence();
    const stopped = !this.views.size && (this.ephemeral || (discardBlank && !this.submitted && !this.working));
    if (stopped) await this.stop();
    return { stopped, submitted: this.submitted };
  }

  receive(event) {
    if (event.type === 'extension_ui_request' && event.method === 'setStatus' && ['pi-desktop-control-response', 'pi-desktop-pause-state'].includes(event.statusKey)) {
      if (!event.statusText?.startsWith('json:')) return;
      event = JSON.parse(event.statusText.slice(5));
    }
    if (event.type === 'response') {
      const control = event.id?.endsWith(':desktop-control');
      if (control && event.success) return;
      const id = control ? event.id.slice(0, -16) : event.id;
      const request = this.pending.get(id);
      if (request) {
        this.pending.delete(id); clearTimeout(request.timer);
        if (request.type === 'prompt') {
          const error = this.commandErrors.get(String(request.command.message).match(/^\/(\S+)/)?.[1] ?? '') ?? this.commandErrors.get('');
          const rejection = this.inputRejection?.text === request.command.message ? this.inputRejection.error : undefined;
          if (error || rejection) { request.reject(new Error(error || rejection)); return; }
        }
        if (event.success && ['get_entries', 'get_snapshot_entries'].includes(request.type)) {
          for (const entry of event.data.entries) if (entry.message?.role === 'user' && this.queue.steeringTimestamps.has(entry.message.timestamp)) entry.message.deliveryBehavior = 'steer';
        }
        if (request.type === 'get_state' && event.success) {
          this.state = event.data;
          if (this.state.sessionId && !this.ephemeral && !this.transient && this.key !== this.state.sessionId) {
            if (sessions.get(this.key) === this) sessions.delete(this.key);
            this.key = this.state.sessionId; sessions.set(this.key, this);
          }
          this.publishState();
        }
        if (request.type === 'get_snapshot_entries' && event.success) {
          const history = event.data;
          for (const message of this.liveMessages.values()) {
            if (!history.entries.some((entry) => entry.message?.role === message.role && entry.message?.timestamp === message.timestamp)) {
              const id = `live-${message.role}-${message.timestamp}`;
              history.entries.push({ type: 'message', id, parentId: history.leafId, message: { ...message, streaming: message.role === 'assistant' } }); history.leafId = id;
            }
          }
          const queue = this.queue.queueView();
          request.resolve({ history, sequence: this.sequence, stateRevision: this.stateRevision, epoch: this.epoch, liveTools: [...this.tools.values()], queue, state: { ...request.snapshotState, isStreaming: this.working, viewers: [...this.views.values()].filter((view) => view.visible).length, pendingMessageCount: queue.steering.length + queue.followUp.length } });
        } else if (event.success) request.resolve(event.data ?? null);
        else request.reject(new Error(event.error || 'Pi command failed'));
      }
      return;
    }
    if (event.type === 'agent_start') { this.working = true; this.submitted = true; this.publishState(); }
    if (event.type === 'agent_settled') { this.working = false; this.liveMessages.clear(); this.tools.clear(); this.publishState(); }
    if (event.type === 'compaction_start' || event.type === 'auto_compaction_start') this.compacting = true;
    if (event.type === 'compaction_end' || event.type === 'auto_compaction_end') this.compacting = false;
    if (event.type === 'pause_state') this.pauseState = { isPaused: event.isPaused, isPausing: event.isPausing };
    if (['compaction_start', 'compaction_end', 'auto_compaction_start', 'auto_compaction_end', 'pause_state'].includes(event.type)) this.publishState();
    if (event.type === 'message_start') this.liveMessages.set(event.message.role, event.message);
    if (event.type === 'message_update') {
      const previous = this.liveMessages.get('assistant');
      const message = event.assistantMessageEvent?.partial ?? event.message ?? (previous && applyAssistantMessageDelta(previous, event.assistantMessageEvent));
      if (message) this.liveMessages.set(message.role ?? 'assistant', event.usage ? { ...message, usage: event.usage } : message);
    }
    if (event.type === 'message_end') this.liveMessages.delete(event.message.role);
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_update') {
      const previous = this.tools.get(event.toolCallId);
      this.tools.set(event.toolCallId, { ...previous, ...event, type: 'tool_execution_start' });
    }
    if (event.type === 'tool_execution_end') this.tools.delete(event.toolCallId);
    if (event.type === 'extension_ui_request') {
      if (event.method === 'setStatus' && event.statusKey === 'pi-desktop-turn-capture') {
        const capture = JSON.parse(event.statusText);
        output({ ...capture, type: 'turn_capture', sessionKey: this.key });
        return;
      }
      if (event.method === 'setStatus' && event.statusKey === 'pi-desktop-worktree-presence') {
        try { const presence = JSON.parse(event.statusText); this.worktree = presence.worktree; this.presenceId = presence.id; this.publishState(); } catch { /* Ignore incomplete presence. */ }
        return;
      }
      if (event.method === 'setStatus' && event.statusKey === 'piop-input-rejected') {
        try { this.inputRejection = JSON.parse(event.statusText); } catch { /* Ignore malformed rejections. */ }
        return;
      }
      if (event.method === 'notify' && event.notifyType === 'error' && event.message === this.inputRejection?.error) event = { ...event, inputRejected: true };
      if (event.method === 'setStatus' || event.method === 'setWidget' || event.method === 'setTitle') this.statuses.set(`${event.method}:${event.statusKey ?? event.widgetKey ?? ''}`, event);
      if (interactiveMethods.has(event.method)) {
        this.dialogs.set(event.id, { event }); this.routeDialogs(); return;
      }
    }
    if (event.type === 'extension_error' && event.event === 'command') this.commandErrors.set(event.extensionPath?.startsWith('command:') ? event.extensionPath.slice(8) : '', event.error || 'Extension command failed');
    this.queue.receive(event);
  }

  raw(command, requestType = command.type, snapshotState) {
    if (this.closed) return Promise.reject(new Error('Pi is not running'));
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

  async execute(command) {
    if (command.type === 'force_stop') return this.stop();
    if (command.type === 'get_available_models' && this.providerAuthRevision !== providerAuthRevision && providerAuthRevision > 0) {
      const revision = providerAuthRevision;
      await this.raw({ type: 'provider_auth_refresh' });
      this.providerAuthRevision = revision;
    }
    if (command.type === 'get_snapshot') {
      const deadline = Date.now() + this.timeout;
      for (;;) {
        const revision = this.stateRevision;
        const state = await this.raw({ type: 'get_state' });
        const pause = await this.raw({ type: 'get_pause_state' });
        const { stateRevision, ...snapshot } = await this.raw({ type: 'get_entries' }, 'get_snapshot_entries', { ...state, ...pause });
        if (revision === stateRevision) return snapshot;
        if (Date.now() >= deadline) throw new Error('Session kept changing while collecting its snapshot');
      }
    }
    if (command.type === 'get_state') {
      const state = await this.raw(command); const pause = await this.raw({ type: 'get_pause_state' });
      return { ...state, ...pause, pendingMessages: this.queue.queueView().pendingMessages, pendingMessageCount: state.pendingMessageCount + (this.queue.heldMessages?.length ?? 0) };
    }
    if (command.type === 'voice_history' || command.type === 'prompt' && !String(command.message).startsWith('/')) this.submitted = true;
    const runtimeSettingsKey = command.type === 'runtime_settings' ? JSON.stringify(canonicalSettings({ settings: command.settings, agentRevision: command.agentRevision ?? this.agentRevision })) : undefined;
    if (runtimeSettingsKey !== undefined && this.appliedRuntimeSettings?.key === runtimeSettingsKey) return this.appliedRuntimeSettings.result;
    const result = await this.raw(command);
    if (runtimeSettingsKey !== undefined) this.appliedRuntimeSettings = { key: runtimeSettingsKey, result };
    if (command.type === 'set_auto_compaction') this.autoCompaction = command.enabled;
    if (command.type === 'set_auto_retry') this.autoRetry = command.enabled;
    if (command.type === 'resume' && result?.resumeMessage) await this.raw({ type: 'prompt', message: result.resumeMessage });
    if (['set_model', 'set_thinking_level', 'set_session_name', 'fork_and_forget', 'runtime_settings'].includes(command.type)) this.publish({ type: 'session_info_changed' });
    return result;
  }
}

function sessionSpec(spec, flag, value) {
  const args = [];
  for (let index = 0; index < spec.args.length; index++) {
    if (['--session', '--session-id', '--fork'].includes(spec.args[index])) { index++; continue; }
    if (spec.args[index] === '--no-session') continue;
    args.push(spec.args[index]);
  }
  return { ...spec, args: [...args, flag, value] };
}

async function forkSession(session, runtimeId, command, state) {
  const directory = await mkdtemp(join(tmpdir(), 'piop-branch-'));
  let worker, next, publishedPath, pendingPath;
  let pendingCreated = false;
  let committed = false;
  try {
    const spec = sessionSpec(session.spec, '--fork', state.sessionFile);
    spec.args.push('--session-dir', directory);
    worker = new Session(randomUUID(), spec, session.timeout, session.ephemeral, true);
    worker.cwd = session.cwd; sessions.set(worker.key, worker);
    const initial = await worker.execute({ type: 'get_state' });
    const result = await worker.raw(command);
    if (result?.cancelled) return result;
    const branch = await worker.execute({ type: 'get_state' });
    await worker.stop();
    if (!branch.sessionFile || dirname(resolve(branch.sessionFile)) !== resolve(directory) || branch.sessionFile === initial.sessionFile || !branch.sessionId || branch.sessionId === state.sessionId || sessions.has(branch.sessionId)) throw new Error('Pi did not create the requested branch');
    const content = await readFile(branch.sessionFile);
    const newline = content.indexOf(10);
    if (newline < 0) throw new Error('The branch has no session header');
    const header = JSON.parse(content.subarray(0, newline).toString());
    if (header.type !== 'session' || header.id !== branch.sessionId) throw new Error('The branch has an invalid session identity');
    const destination = join(dirname(state.sessionFile), basename(branch.sessionFile));
    pendingPath = join(dirname(state.sessionFile), `.piop-branch-${randomUUID()}.pending`);
    const output = await open(pendingPath, 'wx', 0o600); pendingCreated = true;
    try {
      await output.writeFile(JSON.stringify({ ...header, parentSession: state.sessionFile }) + '\n');
      await output.writeFile(content.subarray(newline + 1));
    } finally { await output.close(); }
    await link(pendingPath, destination); publishedPath = destination;
    next = new Session(branch.sessionId, sessionSpec(session.spec, '--session', destination), session.timeout, session.ephemeral, true);
    next.cwd = session.cwd; next.reservedPath = destination; sessions.set(next.key, next);
    const opened = await next.execute({ type: 'get_state' });
    if (opened.sessionId !== branch.sessionId || opened.sessionFile !== destination) throw new Error('Pi did not open the prepared branch');
    if (subscriptions.get(runtimeId) !== session) throw new Error('The conversation changed while preparing its branch');
    const presence = session.views.get(runtimeId);
    const detached = session.detach(runtimeId);
    next.reservedPath = undefined; next.transient = false; next.attach(runtimeId, presence); committed = true;
    await detached;
    void next.reconcileConfiguration(true);
    if (subscriptions.get(runtimeId) === next) next.publish({ type: 'session_switched' }, runtimeId);
    return result;
  } finally {
    try {
      if (worker) await worker.stop();
      if (!committed && next) await next.stop();
      if (!committed && publishedPath) await rm(publishedPath, { force: true });
    } finally {
      try { if (pendingCreated) await rm(pendingPath, { force: true }); }
      finally {
        try { await rm(directory, { recursive: true, force: true }); }
        finally {
          if (worker && sessions.get(worker.key) === worker) sessions.delete(worker.key);
          if (!committed && next && sessions.get(next.key) === next) sessions.delete(next.key);
        }
      }
    }
  }
}

async function handle(packet) {
  const { runtimeId, type } = packet;
  if (type === 'provider_auth') {
    if (!providerAuth) throw new Error('Provider authentication is unavailable. Restart Piop.');
    return providerAuth.handle(packet.owner, packet.request);
  }
  if (type === 'provider_auth_cancel_owner') { providerAuth?.cancelOwner(packet.owner); return; }
  if (type === 'configure') {
    const configuration = packet.configuration;
    if (!configuration || !Number.isSafeInteger(configuration.agentRevision) || configuration.agentRevision < 0 || !configuration.settings || typeof configuration.autoCompaction !== 'boolean' || typeof configuration.autoRetry !== 'boolean') throw new Error('Invalid daemon configuration');
    if (JSON.stringify(canonicalSettings(configuration)) !== JSON.stringify(canonicalSettings(desiredConfiguration))) desiredConfiguration = configuration;
    for (const session of sessions.values()) {
      session.publish({ type: 'settings_pending', pending: session.settingsPending() });
      void session.reconcileConfiguration(true);
    }
    return;
  }
  if (type === 'attach') {
    if (subscriptions.has(runtimeId)) return { attached: true };
    let session = sessions.get(packet.sessionKey);
    if (session?.transient) throw new Error('This conversation branch is still being prepared');
    if (session?.stopPromise) { await session.stopPromise; session = sessions.get(packet.sessionKey); }
    if (!session || session.closed) {
      session = new Session(packet.sessionKey, packet.spec, packet.timeout, packet.ephemeral);
      session.cwd = packet.cwd;
      sessions.set(packet.sessionKey, session);
    }
    await session.ready;
    session.attach(runtimeId, packet.presence);
    void session.reconcileConfiguration(true);
    return { attached: session.views.size > 1 || session.submitted };
  }
  if (type === 'shutdown') { providerAuth?.shutdown(); await Promise.all([...sessions.values()].map((session) => session.stop())); process.exit(0); }
  if (type === 'retire') {
    const session = sessions.get(packet.sessionKey) ?? [...sessions.values()].find((session) => session.state?.sessionFile === packet.sessionPath || session.reservedPath === packet.sessionPath);
    if (!session) return;
    await session.retire(); return;
  }
  if (type === 'session_command') {
    const session = sessions.get(packet.sessionKey);
    if (!session) throw new Error('Conversation is no longer running');
    return session.execute(packet.command);
  }
  const session = subscriptions.get(runtimeId);
  if (!session) { if (type === 'detach') return { stopped: false }; throw new Error('Pi is not running'); }
  if (type === 'detach') return session.detach(runtimeId, packet.discardBlank);
  if (type === 'presence') { session.views.set(runtimeId, packet.presence); session.routeDialogs(); session.publishPresence(); return; }
  const command = packet.command;
  if (command.type === 'extension_ui_response') {
    const dialog = session.dialogs.get(command.id);
    if (!dialog || dialog.owner !== runtimeId) return;
    session.dialogs.delete(command.id);
    session.child.stdin.write(JSON.stringify(command) + '\n');
    session.publish({ type: 'extension_ui_resolved', id: command.id });
    session.publishState();
    return;
  }
  if (!command.type.startsWith('get_') || command.type === 'get_snapshot') await session.reconcileConfiguration();
  if (!command.type.startsWith('get_') && session.configurationFailed && session.settingsPending()) throw new Error(session.configurationError);
  if (['fork', 'clone', 'new_session', 'switch_session'].includes(command.type)) {
    if (session.working || session.queue.pendingMessages.length) throw new Error('Stop or pause the response and finish queued messages before branching or switching');
    const state = await session.execute({ type: 'get_state' });
    if (subscriptions.get(runtimeId) !== session) throw new Error('The conversation changed while preparing its destination');
    if (command.type === 'fork') {
      if (!state.sessionFile) throw new Error('The conversation has no session file');
      return forkSession(session, runtimeId, command, state);
    }
    let key = randomUUID();
    const flag = command.type === 'new_session' ? '--session-id' : command.type === 'switch_session' ? '--session' : '--fork';
    const value = command.type === 'new_session' ? key : command.type === 'switch_session' ? command.sessionPath : state.sessionFile;
    if (!value) throw new Error('The conversation has no session file');
    let next = command.type === 'switch_session' ? [...sessions.values()].find((candidate) => candidate.state?.sessionFile === value || candidate.reservedPath === value) : undefined;
    if (next?.transient) throw new Error('This conversation branch is still being prepared');
    const created = !next;
    if (!next) { next = new Session(key, sessionSpec(session.spec, flag, value), session.timeout, session.ephemeral); next.cwd = session.cwd; sessions.set(key, next); }
    try {
      const result = {};
      await next.execute({ type: 'get_state' });
      if (subscriptions.get(runtimeId) !== session) throw new Error('The conversation changed while preparing its destination');
      if (next.closed || next.stopPromise) throw new Error('The destination conversation has stopped');
      if (next !== session) {
        const presence = session.views.get(runtimeId);
        // Transfer synchronously so a close cannot land between detach and attach.
        const detached = session.detach(runtimeId); next.attach(runtimeId, presence);
        await detached;
      }
      void next.reconcileConfiguration(true);
      if (subscriptions.get(runtimeId) === next) next.publish({ type: 'session_switched' }, runtimeId);
      return result;
    } catch (error) { if (created && !next.views.size && !next.submitted && !next.working) await next.stop(); throw error; }
  }
  if (command.type === 'change_pending') return session.queue.changePendingMessage(command.id, command.action);
  if (command.type === 'prompt' && !String(command.message).startsWith('/') && !session.queue.heldMessages) return session.queue.command({ ...command, type: command.streamingBehavior === 'steer' ? 'steer' : 'follow_up' });
  return session.queue.command(command);
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
input.on('close', () => { providerAuth?.shutdown(); for (const session of sessions.values()) session.child.kill(); });
process.on('SIGTERM', () => { providerAuth?.shutdown(); for (const session of sessions.values()) session.child.kill(); });
process.on('exit', () => { for (const session of sessions.values()) session.child.kill(); });
