import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { createRoot, createComponent } from 'solid-js';
import { ReviewFeedback } from '../../clients/ui/plugins/review/ReviewFeedback.tsx';
import { emit } from '@tauri-apps/api/event';
import { channelsClosed, enterText, installDom, renderComponent, act, untilDom } from '../dom.mjs';
import { SplitChatPane } from '../../clients/ui/components/SplitChatPane.tsx';
import { encodeAgentValue } from '../../clients/ui/lib/agentProtocol.ts';
import { SessionRuntimePool } from '../../clients/ui/lib/sessionRuntimePool.ts';
import { createConversationDrafts } from '../../clients/ui/appDrafts.ts';
import { createHostModelVisibility } from '../../clients/ui/lib/hostModelVisibility.ts';
import { mockIPC } from '../mock-ipc.mjs';
import { appSettings } from '../settings-fixture.mjs';

const SESSION_KEY = 'local:session';
const MODEL = { provider: 'p', id: 'base', reasoning: true };

// The split pane as the app assembles it: a pooled session transport, the app's draft store and model visibility, with only the daemon IPC faked.
describe('split conversation lifecycle', () => {
  let daemonResponses, waiters, dom, view, props, calls, daemon, responses, pool, transport, drafts, released, dialogs, notices, storageErrors, disposeRoot;
  beforeEach(() => {
    dom = installDom(); HTMLElement.prototype.scrollIntoView = () => {};
    calls = []; daemon = []; waiters = new Set(); released = []; dialogs = []; notices = []; storageErrors = [];
    const state = { model: MODEL, thinkingLevel: 'off', isStreaming: false, sessionId: 'session', sessionFile: '/session.jsonl', messageCount: 0, pendingMessageCount: 0 };
    responses = new Map([['get_session_revision', { revision: 'changed' }], ['get_snapshot', { revision: 'snapshot', state, history: { entries: [], leafId: null }, sequence: 0, epoch: 'epoch', liveTools: [], queue: { type: 'queue_state', pendingMessages: [] } }], ['get_state', () => responses.get('get_snapshot').state], ['get_available_models', { models: [MODEL] }], ['get_available_thinking_levels', { levels: ['off', 'high'] }], ['get_commands', { commands: [] }]]);
    const groups = { groups: [], parents: {}, assignments: {}, removedProjects: [] };
    daemonResponses = new Map([['provider_auth', { ready: true, providers: { p: { supportedModelIds: ['base', 'one', 'two'] } } }], ['start_pi', { attached: true }], ['stop_pi', true], ['pi_presence', null], ['load_session_groups', groups], ['change_session_groups', groups],
      ['broker_request', ({ body }) => ({ sessionId: body.sessionId, sessionPath: '/session.jsonl', cwd: '/repo', archived: false, revision: '1' })]]);
    mockIPC((command, args) => {
      if (command === 'pi_command') {
        const rpc = args.command; calls.push(rpc);
        for (const waiter of [...waiters]) waiter(rpc);
        const result = responses.get(rpc.type);

        if (result instanceof Error) throw result;
        const value = result instanceof Function ? result(rpc) : result;

        return value === undefined ? {} : value;
      }

      daemon.push({ command, args });

      if (!daemonResponses.has(command)) throw new Error('Unexpected daemon command: ' + command);
      const result = daemonResponses.get(command);

      if (result instanceof Error) throw result;

      return result instanceof Function ? result(args) : result;
    }, { shouldMockEvents: true });
    pool = new SessionRuntimePool(); pool.setErrorHandler(message => notices.push(message));
    const session = { id: 'session', name: 'Conversation', cwd: '/repo', path: '/session.jsonl', project: 'repo', messageCount: 0 };
    transport = pool.forSession(session);
    const settings = appSettings({ knownModels: ['p/base', 'p/one', 'p/two'] });
    let modelVisibility;
    createRoot(dispose => { disposeRoot = dispose; drafts = createConversationDrafts(message => storageErrors.push(message)); modelVisibility = createHostModelVisibility(() => settings, notice => notices.push(notice)); });
    props = { drafts, modelVisibility, runtimePool: pool, session, settings, uploadsFor: owner => drafts.uploadsByTransport().get(owner) ?? [], onUploadsChange: drafts.setComposerUploads,
      onOpenTerminal: () => {}, onDialogRequest: (...args) => dialogs.push(args), onDialogResolved: (...args) => dialogs.push(args), onDialogTransportClosed: async () => {},
      onReleaseTransport: async value => released.push(value), onArchiveOriginal: async () => {}, onShowArchive: () => {}, onSessionChange: () => {}, onClose: () => {} };
  });
  afterEach(async () => {
    if (view) await view.unmount(); view = undefined;
    disposeRoot();

    try { await channelsClosed('piop-drafts'); await pool.disconnectAll(true); } finally { dom.restore(); }
    assert.deepEqual(storageErrors, []); assert.deepEqual(notices, []);
  });

  const draft = () => drafts.composerDrafts()[SESSION_KEY] ?? '';
  async function render(extra = {}) { props = { ...props, ...extra };
    const live = Object.defineProperty({ ...props }, 'draft', { get: draft, enumerable: true });

  if (view) { await view.rerender(live);

  return; }
  view = await renderComponent(SplitChatPane, live); await untilDom(() => controlsEnabled() || document.querySelector('.split-pane-status.error')); }

  const control = label => document.querySelector('[aria-label="' + label + '"]');
  /** Resolves with the first runtime command matching `matches`, including one already sent. */
  const received = (matches, timeout = 2000) => {
    const sent = calls.find(matches);

    if (sent) return Promise.resolve(sent);

    return new Promise((resolve, reject) => {
      const waiter = command => { if (!matches(command)) return; waiters.delete(waiter); clearTimeout(timer); queueMicrotask(() => resolve(command)); };
      const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error('Runtime never received the command: ' + matches + '; sent ' + JSON.stringify(calls))); }, timeout);
      waiters.add(waiter);
    });
  };
  const sendSettled = () => untilDom(() => !document.querySelector('[aria-label="Preparing message"]'));
  const controlsEnabled = () => control('Open terminal')?.disabled === false;
  const click = async element => act(async () => element.click());
  const type = value => enterText(control('Message piop'), value);
  const runtimeId = () => daemon.filter(call => call.command === 'start_pi').at(-1).args.runtimeId;
  const event = async value => act(async () => emit('pi://event', { runtimeId: runtimeId(), event: value }));
  const extension = async (method, value = {}) => event({ type: 'extension_ui_request', id: crypto.randomUUID(), method, ...value });
  const started = () => daemon.filter(call => call.command === 'start_pi').map(({ args }) => [args.cwd, args.sessionId, args.hostId]);

  test('connects an existing session, applies settings and releases its transport on unmount', async () => {
    let closed = 0; await render({ onClose: () => closed++ });
    assert.deepEqual(started(), [['/repo', 'session', 'local']]); assert.equal(controlsEnabled(), true);
    assert.ok(calls.some(command => command.type === 'set_auto_compaction' && command.enabled));
    await render({ settings: { ...props.settings, autoRetry: false } }); assert.ok(calls.some(command => command.type === 'set_auto_retry' && command.enabled === false));
    await click(control('Close split pane')); assert.equal(closed, 1);
    assert.equal(pool.isInteractive(transport), true);
    await view.unmount(); view = undefined; assert.deepEqual(released, [transport]); assert.equal(pool.isInteractive(transport), false);
    await extension('confirm', { id: 'late', title: 'Proceed?' }); assert.deepEqual(dialogs, []);
  });


  test('extension status, widgets, notices and dialogs are routed to the split owner', async () => {
    await render();
    await extension('setStatus', { statusKey: 'pi-desktop-mcp-loading', statusText: 'Running checks' }); assert.match(document.querySelector('.mcp-loading-list').textContent, /Loading MCPs/);
    await extension('setStatus', { statusKey: 'pi-desktop-mcp-loading' }); assert.equal(document.querySelector('.mcp-loading-list'), null);
    await extension('setWidget', { widgetKey: 'progress', widgetLines: ['one', 'two'] }); assert.equal(document.querySelector('.extension-widget').textContent, 'onetwo');
    await extension('setWidget', { widgetKey: 'progress' }); assert.equal(document.querySelector('.extension-widget'), null);
    await extension('notify', { notifyType: 'error', message: 'Problem', inputRejected: true }); assert.equal(document.querySelector('.split-notices'), null);
    await extension('notify', { notifyType: 'warning', message: 'Careful' }); assert.match(document.querySelector('.split-notices').textContent, /Extension warningCareful/); await click(control('Dismiss Extension warning'));
    await event({ type: 'extension_error', error: 'Failed hook' }); assert.match(document.querySelector('.split-notices').textContent, /Failed hook/); await click(control('Dismiss Extension error'));
    await extension('setTitle', { title: 'Working' }); assert.equal(document.title, 'Working');
    await extension('confirm', { id: 'dialog', title: 'Proceed?' }); assert.equal(dialogs[0][1], transport); assert.equal(dialogs[0][2], 'Split: Conversation');
    await event({ type: 'extension_ui_resolved', id: 'dialog' }); assert.deepEqual(dialogs[1], [transport, 'dialog']);
  });

  test('editor injection replaces existing drafts and focuses the composer', async () => {
    await render();
    await extension('set_editor_text', { text: 'Suggested' }); await dom.flushFrames(); assert.equal(draft(), 'Suggested'); assert.equal(control('Message piop').value, 'Suggested'); assert.equal(document.activeElement, control('Message piop'));
    await type('User edit'); assert.equal(draft(), 'User edit');
    await extension('set_editor_text', { text: 'Replace' }); assert.equal(draft(), 'Replace'); assert.equal(control('Message piop').value, 'Replace');
  });

  test('send routes prompts and streaming steering to their respective runtime commands', async () => {
    await render(); await type('Question'); await click(control('Send message')); await received(command => command.type === 'prompt' && command.message === 'Question'); await sendSettled();
    await event({ type: 'message_start', message: { role: 'user', content: 'Question', timestamp: 1 } });
    await dom.flushFrames();
    await event({ type: 'agent_start' }); await type('Direction');
    await act(async () => control('Message piop').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
    await received(command => command.type === 'steer' && command.message === 'Direction'); await sendSettled();
    await type('/catch-up latest');
    await act(async () => control('Message piop').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await received(command => command.type === 'follow_up' && command.message === '/catch-up latest');
  });

  test('disconnect clears extension state, retries connection and restores controls', async t => {
    const closed = [];
    await render({ onDialogTransportClosed: async value => closed.push(value) });
    await extension('setStatus', { statusKey: 'pi-desktop-mcp-loading', statusText: 'Old status' }); await extension('setWidget', { widgetKey: 'progress', widgetLines: ['Old widget'] }); await extension('setTitle', { title: 'Old title' });
    assert.ok(document.querySelector('.mcp-loading-list')); assert.ok(document.querySelector('.extension-widget'));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    daemonResponses.set('start_pi', new Error('offline'));
    await event({ type: 'disconnected' }); assert.equal(controlsEnabled(), false); assert.equal(document.querySelector('.mcp-loading-list'), null); assert.equal(document.querySelector('.extension-widget'), null); assert.equal(document.title, 'piop'); assert.deepEqual(closed, [transport]);
    await act(async () => t.mock.timers.tick(50)); t.mock.timers.reset();
    await untilDom(() => /offline/.test(document.querySelector('.split-control-error')?.textContent ?? ''));
    daemonResponses.set('start_pi', { attached: true });
    await click(document.querySelector('.split-control-error button')); await untilDom(controlsEnabled);
    assert.equal(document.querySelector('.split-control-error'), null); assert.deepEqual(started(), Array(3).fill(['/repo', 'session', 'local']));
  });

  test('pause failures restore controls, successful pauses refresh state, and resume and abort reach runtime', async () => {
    await render(); await event({ type: 'agent_start' });
    responses.set('pause', new Error('cannot pause')); await click(control('Pause piop')); assert.match(document.querySelector('.upload-error').textContent, /cannot pause/); assert.equal(control('Pause piop').disabled, false);
    responses.delete('pause'); responses.get('get_snapshot').state = { ...responses.get('get_snapshot').state, isPaused: true };
    await click(control('Pause piop')); assert.ok(control('Resume piop')); await click(control('Resume piop')); await click(control('Stop piop'));
    assert.ok(calls.some(command => command.type === 'resume')); assert.ok(calls.some(command => command.type === 'abort'));
  });

  for (const repository of [null, { root: '/repo', gitDir: '/repo/.git' }]) test(`regular fork keeps the folder and original chat (${repository ? 'repository' : 'plain folder'})`, async () => {
    const entries = [{ type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'Question' } }, { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: 'Answer', stopReason: 'stop' } }];
    const snapshot = responses.get('get_snapshot');
    snapshot.history = { entries, leafId: 'a' };
    snapshot.state = { ...snapshot.state, repository };
    const changes = [], archived = [];
    responses.set('copy_after', () => {
      snapshot.state = { ...snapshot.state, sessionId: 'regular-fork', sessionFile: '/regular-fork.jsonl', cwd: '/repo' };
      return { cancelled: false, state: snapshot.state };
    });
    await render({ onSessionChange: value => changes.push(value), onArchiveOriginal: value => archived.push(value) });
    assert.ok(control('Fork'));
    assert.equal(Boolean(control('Branch off')), Boolean(repository));
    await click(control('Fork'));
    await untilDom(() => changes.length === 1);
    assert.ok(calls.some(command => command.type === 'copy_after' && command.entryId === 'a'));
    assert.equal(calls.some(command => command.type === 'fork_after'), false);
    assert.equal(changes[0].cwd, '/repo');
    assert.equal(changes[0].id, 'regular-fork');
    assert.deepEqual(archived, []);
  });

  test('the split source link requests the source chat at its selected response', async () => {
    const source = { sessionId: 'source-chat', sessionPath: '/source.jsonl', entryId: 'source-answer' };
    const snapshot = responses.get('get_snapshot');
    snapshot.state = { ...snapshot.state, forkSource: source };
    snapshot.history = { entries: [
      { type: 'message', id: 'source-question', parentId: null, message: { role: 'user', content: 'Question' } },
      { type: 'message', id: 'source-answer', parentId: 'source-question', message: { role: 'assistant', content: 'Answer', stopReason: 'stop' } },
    ], leafId: 'source-answer' };
    const opened = [];
    await render({ forkSourceName: value => value.sessionId === 'source-chat' ? 'Original chat' : undefined, onOpenForkSource: value => opened.push(value) });
    const link = document.querySelector('button.fork-source-link');
    assert.ok(link);
    assert.equal(link.textContent, 'Branched from “Original chat”');
    await click(link);
    assert.deepEqual(opened, [source]);
  });

  test('branching forks before the next prompt', async () => {
    const entries = [{ type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'Question' } }, { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: 'Answer', stopReason: 'stop' } }, { type: 'message', id: 'next', parentId: 'a', message: { role: 'user', content: 'Next question' } }];
    responses.get('get_snapshot').history = { entries, leafId: 'next' };
    responses.get('get_snapshot').state = { ...responses.get('get_snapshot').state, repository: { root: '/repo', gitDir: '/repo/.git' } };
    const changes = []; const changed = Promise.withResolvers();
    responses.set('fork_after', () => { const snapshot = responses.get('get_snapshot'); snapshot.state = { ...snapshot.state, sessionId: 'forked', sessionName: 'Fork', sessionFile: '/fork.jsonl', cwd: '/worktrees/forked' }; snapshot.history = { entries: entries.slice(0, 2), leafId: 'a' };

    return { cancelled: false, state: { cwd: '/worktrees/forked' } }; });
    responses.set('get_entries', { entries: entries.slice(0, 2), leafId: 'a' });
    await render({ onSessionChange: (...args) => { changes.push(args); changed.resolve(); } });
    assert.ok(control('Branch off'), JSON.stringify({ text: document.body.textContent, calls }));
    await click(control('Branch off'));
    await received(command => command.type === 'fork_after' && command.entryId === 'a');
    await Promise.race([changed.promise, untilDom(() => document.querySelector('.split-control-error')).then(error => assert.fail(error.textContent))]);
    assert.equal(pool.forSession({ id: 'forked', cwd: '/repo', path: '/fork.jsonl', hostId: 'local' }), transport);
    assert.equal(changes[0][0].id, 'forked'); assert.equal(changes[0][0].path, '/fork.jsonl'); assert.equal(changes[0][0].name, 'Fork'); assert.equal(changes[0][1], transport);
    assert.equal(changes[0][0].cwd, '/worktrees/forked'); assert.equal(transport.currentCwd(), '/worktrees/forked');
    // The daemon gives the branch its source's group when it loads groups; the pane writes no group itself.
    assert.equal(changes[0][0].forkSourceId, 'session');
    assert.deepEqual(daemon.filter(({ command }) => command === 'change_session_groups'), []);
  });

  test('branching the latest answer forks after it, honors cancellation, and exposes runtime errors', async () => {
    responses.get('get_snapshot').history = { entries: [{ type: 'message', id: 'a', parentId: null, message: { role: 'assistant', content: 'Answer', stopReason: 'stop' } }], leafId: 'a' };
    responses.get('get_snapshot').state = { ...responses.get('get_snapshot').state, repository: { root: '/repo', gitDir: '/repo/.git' } };
    const changes = [];
    responses.set('fork_after', { cancelled: true }); await render({ onSessionChange: value => changes.push(value) });
    assert.ok(control('Branch off'), JSON.stringify({ text: document.body.textContent, calls }));
    await click(control('Branch off')); await received(command => command.type === 'fork_after' && command.entryId === 'a'); await untilDom(() => control('Branch off') && !control('Branch off').disabled);
    assert.deepEqual(changes, []); assert.equal(document.querySelector('.split-control-error'), null);
    responses.set('fork_after', new Error('fork failed')); await click(control('Branch off')); await untilDom(() => /fork failed/.test(document.querySelector('.split-control-error')?.textContent ?? ''));
    await click(control('Dismiss split pane error')); assert.equal(document.querySelector('.split-control-error'), null); assert.deepEqual(changes, []);
  });
+  test('review feedback waits for the reviewer when asked, sends its finished answer to the main chat once, and can be cancelled', async () => {
    const sent = [];
    await render({ actions: controls => createComponent(ReviewFeedback, { ...controls, messageMain: async message => { sent.push(message); } }) });
    const button = () => document.querySelector('.review-feedback-button');
    const state = () => [button().textContent, button().disabled];
    assert.deepEqual(state(), ['Send feedback', true]);

    await event({ type: 'agent_start' });
    assert.deepEqual(state(), ['Send when done', false]);
    await click(button()); assert.equal(button().textContent, 'Cancel auto-send'); assert.equal(button().getAttribute('aria-pressed'), 'true');
    const answer = { role: 'assistant', content: [{ type: 'text', text: 'Found 2 bugs' }], stopReason: 'stop', timestamp: 2 };
    await event({ type: 'message_start', message: answer }); await event({ type: 'message_end', message: answer }); await event({ type: 'agent_settled' });
    await untilDom(() => button().textContent === 'Feedback sent');
    assert.deepEqual(sent, ['Found 2 bugs']); assert.equal(button().disabled, true);

    await event({ type: 'agent_start' }); await click(button()); await click(button());
    assert.equal(button().textContent, 'Send when done');
    const second = { ...answer, content: [{ type: 'text', text: 'One more bug' }], timestamp: 3 };
    await event({ type: 'message_start', message: second }); await event({ type: 'message_end', message: second }); await event({ type: 'agent_settled' });
    await untilDom(() => button().textContent === 'Send feedback');
    assert.deepEqual(sent, ['Found 2 bugs'], 'a cancelled auto-send sends nothing');
    await click(button()); await untilDom(() => button().textContent === 'Feedback sent');
    assert.deepEqual(sent, ['Found 2 bugs', 'One more bug']);
  });

  test('review feedback queued while the reviewer works reports a review that stops without an answer', async () => {
    const sent = [];
    await render({ actions: controls => createComponent(ReviewFeedback, { ...controls, messageMain: async message => { sent.push(message); } }) });
    const button = () => document.querySelector('.review-feedback-button');
    await event({ type: 'agent_start' }); await click(button());
    const stopped = { role: 'assistant', content: [], stopReason: 'aborted', timestamp: 4 };
    await event({ type: 'message_start', message: stopped }); await event({ type: 'message_end', message: stopped }); await event({ type: 'agent_settled' });
    await untilDom(() => /The review stopped without completed feedback/.test(document.querySelector('.split-control-error')?.textContent ?? ''));
    assert.deepEqual(sent, []);
    await click(control('Dismiss split pane error'));
  });


  test('model controls serialize changes and recover after a rejected command', async () => {
    responses.set('get_available_models', { models: [MODEL, { provider: 'p', id: 'one', reasoning: true }, { provider: 'p', id: 'two', reasoning: true }] });
    responses.set('get_commands', { commands: [{ name: 'fast', source: 'extension', sourceInfo: { path: '/extensions/piop-openai-fast-mode/index.ts' } }] });
    const pending = Promise.withResolvers(); responses.set('set_model', () => pending.promise);
    await render(); await click(control('Model')); await click(document.querySelector('[role=option][data-value="p/one"]'));
    await click(control('Thinking level')); await click(document.querySelector('[role=option][data-value=high]'));
    assert.equal(calls.some(command => command.type === 'set_thinking_level'), false);
    assert.equal(calls.some(command => command.type === 'set_model'), false);
    await type('Question'); await click(control('Send message'));
    await received(command => command.type === 'set_model' && command.modelId === 'one');
    await act(async () => pending.reject(new Error('model unavailable')));
    await untilDom(() => /model unavailable/.test(document.querySelector('.upload-error')?.textContent ?? '')); await sendSettled();
    assert.equal(calls.some(command => command.type === 'set_thinking_level'), false);
    assert.equal(calls.some(command => command.type === 'prompt'), false);
    responses.set('set_model', {});
    await extension('setStatus', { statusKey: 'pi-desktop-fast-mode', statusText: 'Fast mode off' }); await click(control('Fast mode'));
    assert.equal(calls.some(command => command.type === 'prompt'), false);
    await click(control('Send message'));
    await received(command => command.type === 'prompt' && command.message === 'Question');
    assert.ok(calls.some(command => command.type === 'set_thinking_level' && command.level === 'high'));
    assert.ok(calls.some(command => command.type === 'set_fast_mode' && command.enabled === true));
    assert.ok(calls.findIndex(command => command.type === 'set_fast_mode' && command.enabled === true) < calls.findIndex(command => command.message === 'Question'));
  });

  test('agent capability updates populate the picker and selection sends encoded agent names', async () => {
    await render();
    await extension('setStatus', { statusKey: 'pi-define-agents', statusText: `json:${encodeAgentValue({ config: { agents: ['general', 'review'].map(name => ({ name, model: '', effort: '', tools: [], skills: [], mcpServers: {}, path_systemprompt: '', path_agent_prompt: '' })) }, active: 'general' })}` });
    await click(control('Agent')); await click(document.querySelector('[role=option][data-value=review]'));
    await received(command => command.type === 'select_agent' && command.agent === 'review');
    await extension('setStatus', { statusKey: 'pi-define-agents', statusText: 'json:invalid' }); assert.equal(control('Agent').dataset.options, '');
    await extension('setStatus', { statusKey: 'pi-define-agents' }); assert.equal(control('Agent').dataset.options, '');
  });
});
