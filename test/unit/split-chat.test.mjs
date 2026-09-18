import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderComponent, act } from '../dom.mjs';
import { SplitChatPane } from '../../src/components/SplitChatPane.tsx';
import { encodeAgentValue } from '../../src/lib/agentProtocol.ts';

describe('split conversation lifecycle', () => {
  let dom, view, props, calls, listeners, responses, transport, connected, released, dialogs;
  beforeEach(() => {
    dom = installDom(); HTMLElement.prototype.scrollIntoView = () => {};
    calls = []; listeners = new Set(); connected = []; released = []; dialogs = [];
    const state = { model: null, thinkingLevel: 'off', isStreaming: false, sessionId: 'session', messageCount: 0, pendingMessageCount: 0 };
    responses = new Map([['get_snapshot', { state, history: { entries: [], leafId: null }, sequence: 0, epoch: 'epoch', liveTools: [], queue: { pendingMessages: [] } }], ['get_available_models', { models: [] }], ['get_available_thinking_levels', { levels: ['off', 'high'] }], ['get_commands', { commands: [] }]]);
    transport = { connect: async (...args) => connected.push(args), subscribe: handler => { listeners.add(handler); return () => listeners.delete(handler); }, command: async command => { calls.push(command); const result = responses.get(command.type); if (result instanceof Error) throw result; return typeof result === 'function' ? result(command) : result; } };
    const diffs = {};
    props = { runtimePool: { forSession: () => transport, createEphemeralFork: () => transport, subscribe: () => () => {}, gitDiffs: () => diffs, setInteractive: (_, value) => calls.push({ interactive: value }) }, session: { id: 'session', name: 'Conversation', cwd: '/repo', path: '/session.jsonl', project: 'repo', messageCount: 0 }, settings: { autoCompaction: true, autoRetry: true, dictionaries: [], activeDictionaryIds: [], hiddenModels: [] }, draft: '', onDraftChange: () => {}, onOpenTerminal: () => {}, onDialogRequest: (...args) => dialogs.push(args), onDialogResolved: (...args) => dialogs.push(args), onDialogTransportClosed: async () => {}, onReleaseTransport: async value => released.push(value), onSessionChange: () => {}, onClose: () => {} };
  });
  afterEach(async () => { if (view) await view.unmount(); view = undefined; dom.restore(); });
  async function render(extra = {}) { props = { ...props, ...extra }; if (view) await view.rerender(props); else view = await renderComponent(SplitChatPane, props); }
  const control = label => document.querySelector(`[aria-label="${label}"]`);
  const click = async element => act(async () => element.click());
  const event = async value => act(async () => { for (const listener of listeners) listener(value); });
  const extension = async (method, value = {}) => event({ type: 'extension_ui_request', method, ...value });

  test('connects an existing session, applies settings and releases its transport on unmount', async () => {
    let closed = 0; await render({ onClose: () => closed++ });
    assert.deepEqual(connected, [['/repo', '/session.jsonl', undefined, undefined, false]]); assert.equal(control('Message piop').disabled, false);
    assert.ok(calls.some(command => command.type === 'set_auto_compaction' && command.enabled));
    await render({ settings: { ...props.settings, autoRetry: false } }); assert.ok(calls.some(command => command.type === 'set_auto_retry' && command.enabled === false));
    await click(control('Close split pane')); assert.equal(closed, 1);
    await view.unmount(); view = undefined; assert.deepEqual(released, [transport]); assert.equal(listeners.size, 0); assert.deepEqual(calls.at(-1), { interactive: false });
  });

  test('fork startup sends its initial prompt only after refresh and reports connection failure', async () => {
    let ready = 0;
    await render({ forkFrom: 'entry', initialPrompt: 'Explore this', onReady: () => ready++ });
    assert.deepEqual(connected[0], ['/repo', undefined, undefined, 'entry', true]); assert.equal(ready, 1);
    const promptIndex = calls.findIndex(command => command.type === 'prompt');
    assert.deepEqual(calls[promptIndex], { type: 'prompt', message: 'Explore this' }); assert.ok(promptIndex > calls.findIndex(command => command.type === 'get_snapshot'));
    await view.unmount(); view = undefined;
    const failure = new Error('connection refused'); const failures = [];
    transport.connect = async () => { throw failure; };
    await render({ onFailed: reason => failures.push(reason) }); assert.deepEqual(failures, [failure]); assert.equal(document.querySelector('.split-pane-status.error').textContent, 'connection refused'); assert.equal(control('Message piop'), null);
  });

  test('extension status, widgets, notices and dialogs are routed to the split owner', async () => {
    await render();
    await extension('setStatus', { statusKey: 'extension', statusText: 'Running checks' }); assert.equal(document.querySelector('.extension-status').textContent, 'Running checks');
    await extension('setStatus', { statusKey: 'extension' }); assert.equal(document.querySelector('.extension-status'), null);
    await extension('setWidget', { widgetKey: 'progress', widgetLines: ['one', 'two'] }); assert.equal(document.querySelector('.extension-widget').textContent, 'onetwo');
    await extension('setWidget', { widgetKey: 'progress' }); assert.equal(document.querySelector('.extension-widget'), null);
    await extension('notify', { notifyType: 'error', message: 'Problem', inputRejected: true }); assert.equal(document.querySelector('.split-notices'), null);
    await extension('notify', { notifyType: 'warning', message: 'Careful' }); assert.match(document.querySelector('.split-notices').textContent, /Extension warningCareful/); await click(control('Dismiss Extension warning'));
    await event({ type: 'extension_error', error: 'Failed hook' }); assert.match(document.querySelector('.split-notices').textContent, /Failed hook/); await click(control('Dismiss Extension error'));
    await extension('setTitle', { title: 'Working' }); assert.equal(document.title, 'Working');
    await extension('confirm', { id: 'dialog', title: 'Proceed?' }); assert.equal(dialogs[0][1], transport); assert.equal(dialogs[0][2], 'Split: Conversation');
    await event({ type: 'extension_ui_resolved', id: 'dialog' }); assert.deepEqual(dialogs[1], [transport, 'dialog']);
  });

  test('editor injection preserves existing drafts and focuses the composer', async () => {
    const changes = []; await render({ onDraftChange: value => changes.push(value) });
    await extension('set_editor_text', { text: 'Suggested' }); assert.deepEqual(changes, ['Suggested']); assert.equal(document.activeElement, control('Message piop'));
    await render({ draft: 'User edit' }); await extension('set_editor_text', { text: 'Replace' }); assert.deepEqual(changes, ['Suggested']);
  });

  test('send routes prompts and streaming steering to their respective runtime commands', async () => {
    await render({ draft: 'Question' }); await click(control('Send message')); assert.ok(calls.some(command => command.type === 'prompt' && command.message === 'Question'));
    await event({ type: 'agent_start' }); await render({ draft: 'Direction' });
    await act(async () => control('Message piop').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
    assert.ok(calls.some(command => command.type === 'steer' && command.message === 'Direction'));
    await render({ draft: '/catch-up latest' });
    await act(async () => control('Message piop').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    assert.ok(calls.some(command => command.type === 'prompt' && command.message === '/catch-up latest'));
  });

  test('disconnect clears extension state, retries connection and restores controls', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); const closed = [];
    await render({ onDialogTransportClosed: async value => closed.push(value) });
    await extension('setStatus', { statusKey: 'status', statusText: 'Old status' }); await extension('setTitle', { title: 'Old title' });
    transport.connect = async (...args) => { connected.push(args); throw new Error('offline'); };
    await event({ type: 'disconnected' }); assert.equal(control('Message piop').disabled, true); assert.equal(document.querySelector('.extension-status'), null); assert.equal(document.title, 'piop'); assert.deepEqual(closed, [transport]);
    await act(async () => t.mock.timers.tick(50)); assert.match(document.querySelector('.split-control-error').textContent, /offline/);
    transport.connect = async (...args) => connected.push(args);
    await click(document.querySelector('.split-control-error button')); assert.equal(control('Message piop').disabled, false); assert.equal(document.querySelector('.split-control-error'), null); assert.deepEqual(connected.slice(1), [[], []]);
  });

  test('pause failures restore controls, successful pauses refresh state, and resume and abort reach runtime', async () => {
    await render(); await event({ type: 'agent_start' });
    responses.set('pause', new Error('cannot pause')); await click(control('Pause piop')); assert.match(document.querySelector('.upload-error').textContent, /cannot pause/); assert.equal(control('Pause piop').disabled, false);
    responses.delete('pause'); responses.get('get_snapshot').state = { ...responses.get('get_snapshot').state, isPaused: true };
    await click(control('Pause piop')); assert.ok(control('Resume piop')); await click(control('Resume piop')); await click(control('Stop piop'));
    assert.ok(calls.some(command => command.type === 'resume')); assert.ok(calls.some(command => command.type === 'abort'));
  });

  test('branching forks before the next prompt and copies only the retained history diffs', async () => {
    const entries = [{ type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'Question' } }, { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: 'Answer' } }, { type: 'message', id: 'next', parentId: 'a', message: { role: 'user', content: 'Next question' } }];
    responses.get('get_snapshot').history = { entries, leafId: 'next' };
    let path = '/source.jsonl'; const changes = [], bindings = [], copies = [];
    transport.currentSessionPath = () => path;
    props.runtimePool.bind = (...args) => bindings.push(args); props.runtimePool.copySavedDiffs = async (...args) => copies.push(args);
    responses.set('fork', () => { path = '/fork.jsonl'; const snapshot = responses.get('get_snapshot'); snapshot.state = { ...snapshot.state, sessionId: 'forked', sessionName: 'Fork', sessionFile: path }; snapshot.history = { entries: entries.slice(0, 2), leafId: 'a' }; return {}; });
    responses.set('get_entries', { entries: entries.slice(0, 2), leafId: 'a' });
    await render({ onSessionChange: (...args) => changes.push(args) });
    await click(document.querySelector('[title="Branch from here"]'));
    assert.ok(calls.some(command => command.type === 'fork' && command.entryId === 'next'));
    assert.deepEqual(bindings, [['local', 'forked', transport]]); assert.equal(changes[0][0].path, '/fork.jsonl'); assert.equal(changes[0][0].name, 'Fork'); assert.equal(changes[0][1], transport);
    assert.deepEqual(copies, [[transport, '/source.jsonl', '/fork.jsonl', new Set(['u', 'a'])]]);
  });

  test('branching the latest answer clones, honors cancellation, and exposes runtime errors', async () => {
    responses.get('get_snapshot').history = { entries: [{ type: 'message', id: 'a', parentId: null, message: { role: 'assistant', content: 'Answer' } }], leafId: 'a' };
    transport.currentSessionPath = () => '/source'; const changes = [];
    responses.set('clone', { cancelled: true }); await render({ onSessionChange: value => changes.push(value) });
    await click(document.querySelector('[title="Branch from here"]')); assert.ok(calls.some(command => command.type === 'clone')); assert.deepEqual(changes, []);
    responses.set('clone', new Error('fork failed')); await click(document.querySelector('[title="Branch from here"]')); assert.match(document.querySelector('.split-control-error').textContent, /fork failed/);
    await click(control('Dismiss split pane error')); assert.equal(document.querySelector('.split-control-error'), null);
  });

  test('model controls serialize changes and recover after a rejected command', async () => {
    responses.set('get_available_models', { models: [{ provider: 'p', id: 'one' }, { provider: 'p', id: 'two' }] });
    const pending = Promise.withResolvers(); responses.set('set_model', () => pending.promise);
    await render(); await click(control('Model')); await click(document.querySelector('[role=option][data-value="p/one"]'));
    await click(control('Thinking level')); await click(document.querySelector('[role=option][data-value=high]'));
    assert.equal(calls.some(command => command.type === 'set_thinking_level'), false);
    await act(async () => pending.reject(new Error('model unavailable')));
    assert.ok(calls.some(command => command.type === 'set_thinking_level' && command.level === 'high')); assert.equal(control('Thinking level').dataset.value, 'high'); assert.match(document.querySelector('.split-control-error').textContent, /model unavailable/);
    let toggles = 0; transport.toggleFastMode = async () => toggles++;
    await extension('setStatus', { statusKey: 'pi-desktop-fast-mode', statusText: 'Fast mode off' }); await click(control('Fast mode')); assert.equal(toggles, 1);
  });

  test('agent capability updates populate the picker and selection sends encoded agent names', async () => {
    await render();
    await extension('setStatus', { statusKey: 'pi-define-agents', statusText: `json:${encodeAgentValue({ config: { agents: [{ name: 'general' }, { name: 'review' }] }, active: 'general' })}` });
    await click(control('Agent')); await click(document.querySelector('[role=option][data-value=review]'));
    assert.ok(calls.some(command => command.type === 'prompt' && command.message === `/pi-define-agents-use ${encodeAgentValue('review')}`));
    await extension('setStatus', { statusKey: 'pi-define-agents', statusText: 'json:invalid' }); assert.equal(control('Agent').dataset.options, 'default');
    await extension('setStatus', { statusKey: 'pi-define-agents' }); assert.equal(control('Agent').dataset.options, 'default');
  });
});
