import assert from 'node:assert/strict';
import { test, describe, beforeEach, afterEach } from 'node:test';
import { installDom } from '../dom.mjs';
import { mockIPC, clearMocks } from '../mock-ipc.mjs';
import { emit } from '@tauri-apps/api/event';
import * as native from '../../clients/ui/lib/nativeTransport.ts';
import { appSettings } from '../settings-fixture.mjs';
import { clearDraftCatalogs } from '../../clients/ui/lib/draftRuntime.ts';

describe('native transport', () => {
let calls, responses, transports, dom;
beforeEach(() => {
  dom = installDom();
  calls = []; transports = [];
  responses = new Map([
    ['start_pi', { attached: false }], ['stop_pi', true],
    ['create_temporary_chat', { cwd: '/tmp/chat', sessionId: 'temporary' }],
    ['provider_auth', { config: { agents: [] }, models: [], initialModel: null, initialThinking: 'off', commands: [], commandDetails: [], skills: [] }],
    ['load_client_settings', { settings: {}, revision: '1' }],
  ]);
  mockIPC((command, args) => {
    calls.push({ command, args });
    const key = command === 'pi_command' ? `pi_command:${args.command.type}` : command;
    const result = responses.get(key);

    if (result instanceof Error) throw result;

    return result instanceof Function ? result(args) : result;
  }, { shouldMockEvents: true });
});
afterEach(async () => {
  for (const transport of transports) await transport.disconnect();
  clearMocks();
  clearDraftCatalogs();
  dom.restore();
});

const transport = (target = { cwd: '/repo' }) => { const value = new native.NativeTransport(target); transports.push(value);

return value; };

const commands = name => calls.filter(call => call.command === name);
const rpc = type => commands('pi_command').filter(call => call.args.command.type === type);

test('a draft agent reload that finishes after the first message does not replace the session agent list', { timeout: 5000 }, async () => {
  const client = transport({});
  await client.connect();
  let finishReload;
  const requested = Promise.withResolvers();
  responses.set('provider_auth', args => args.request.reload ? new Promise(resolve => { requested.resolve(); finishReload = () => resolve({ config: { agents: [{ name: 'general', model: '', effort: 'high', path_systemprompt: 'p.md', path_agent_prompt: '', tools: [], skills: [], mcpServers: {} }] }, models: [], initialModel: null, initialThinking: 'off', commands: [], commandDetails: [], skills: [] }); }) : { config: { agents: [] }, models: [], initialModel: null, initialThinking: 'off', commands: [], commandDetails: [], skills: [] });
  responses.set('pi_command:get_state', { sessionId: 'temporary', sessionFile: '/tmp/chat/session.jsonl' });
  responses.set('pi_command:set_fast_mode', {});
  const statuses = [];
  client.subscribe(event => { if (event.statusKey === 'pi-define-agents') statuses.push(event); });
  const reload = client.reloadAgentDefinitions('');
  await requested.promise;
  assert.ok(finishReload, 'the reload request must be pending');
  await client.startDraft();
  assert.equal(commands('start_pi').length, 1);
  finishReload();
  await assert.rejects(reload, /conversation started before agent definitions finished reloading/);
  assert.deepEqual(statuses, []);
});

test('starting a draft applies its displayed model and effort after selecting the agent', async () => {
  clearDraftCatalogs();
  responses.set('provider_auth', {
    config: { agents: [{ name: 'general', isDefault: true, model: 'p/shown', effort: 'high', path_systemprompt: 'p.md', path_agent_prompt: '', tools: [], skills: [], mcpServers: {} }] },
    models: [{ provider: 'p', id: 'shown', reasoning: true }], initialModel: null, initialThinking: 'low', commands: [], commandDetails: [], skills: [],
  });
  const state = { isStreaming: false, messageCount: 0, pendingMessageCount: 0, sessionId: 'temporary', sessionFile: '/tmp/chat/session.jsonl', model: { provider: 'p', id: 'fallback' }, thinkingLevel: 'low' };
  responses.set('pi_command:get_state', () => ({ ...state }));
  responses.set('pi_command:select_agent', () => { state.model = { provider: 'p', id: 'fallback' }; state.thinkingLevel = 'low'; return {}; });
  responses.set('pi_command:set_model', ({ command }) => { state.model = { provider: command.provider, id: command.modelId }; return {}; });
  responses.set('pi_command:set_thinking_level', ({ command }) => { state.thinkingLevel = command.level; return {}; });
  responses.set('pi_command:set_fast_mode', {});
  const client = transport({});
  await client.connect();
  await client.applyNewChatDefaults('', false);
  await client.startDraft();
  assert.deepEqual(state.model, { provider: 'p', id: 'shown' });
  assert.equal(state.thinkingLevel, 'high');
  assert.deepEqual(commands('pi_command').map(call => call.args.command).filter(command => ['select_agent', 'set_model', 'set_thinking_level'].includes(command.type)), [
    { type: 'select_agent', agent: 'general' },
    { type: 'set_model', provider: 'p', modelId: 'shown' },
    { type: 'set_thinking_level', level: 'high' },
  ]);
});

test('a new worktree draft sends its branch choice once and uses the returned folder', async () => {
  const client = transport({ cwd: '/repo', draftKey: 'draft' });
  client.setNewChatBranch('feature');
  responses.set('broker_request', { sessionId: 'created', sessionPath: '/sessions/created.jsonl', cwd: '/worktrees/chat', archived: false, revision: '1' });
  responses.set('start_pi', { attached: true, cwd: '/worktrees/chat' });
  responses.set('pi_command:get_state', { sessionId: 'created', sessionFile: '/sessions/created.jsonl' });
  responses.set('pi_command:set_fast_mode', {});
  await client.startDraft();
  assert.equal(commands('start_pi')[0].args.baseBranch, 'feature');
  assert.equal(client.currentCwd(), '/worktrees/chat');
  await client.disconnect();
  await client.connect();
  assert.equal(commands('start_pi')[1].args.baseBranch, undefined);
  assert.equal(commands('start_pi')[1].args.cwd, '/worktrees/chat');
});

test('a rejected stop can reconnect and receive conversation events', async t => {
  const warn = t.mock.method(console, 'warn');
  const client = transport();
  await client.connect();
  responses.set('stop_pi', new Error('Disconnected from the Piop daemon (connection closed); the command may have completed.'));
  await assert.rejects(client.disconnect(), /Disconnected from the Piop daemon/);
  responses.set('stop_pi', true);
  await client.connect();
  assert.equal(commands('start_pi').length, 2);
  const events = [];
  client.subscribe(event => events.push(event));
  await emit('pi://event', { runtimeId: commands('start_pi').at(-1).args.runtimeId, event: { type: 'agent_start' } });
  assert.ok(events.some(event => event.type === 'agent_start'));
  assert.equal(warn.mock.callCount(), 0, 'reconnecting must not call removed event handlers');
});



test('existing-session attachment and explicit restore retain the correct connection target', async () => {
  const client = transport({ sessionId: 'id', cwd: '/repo', hostId: 'remote' });
  responses.set('start_pi', { attached: true });
  await client.connect();
  assert.equal(client.needsDefaults(), false);
  assert.equal(commands('start_pi')[0].args.sessionId, 'id');
  await client.restoreConnection({ sessionPath: '/sessions/other', cwd: '/other' });
  assert.deepEqual(client.connectionTarget(), { cwd: '/other', sessionPath: '/sessions/other', sessionId: undefined, hostId: 'local' });
  assert.equal(commands('start_pi').at(-1).args.sessionPath, '/sessions/other');
  assert.equal(client.currentSessionPath(), '/sessions/other');
});

test('unused temporary chats are removed on disposal while used chats survive', async () => {
  responses.set('pi_command:get_commands', { commands: [{ name: 'fast', source: 'extension', sourceInfo: { path: '/extensions/piop-openai-fast-mode/index.ts' } }] });
  const unused = transport({});
  await unused.connect();
  assert.equal(unused.isTemporaryChat(), true);
  assert.equal(commands('create_temporary_chat').length, 0);
  await unused.startDraft();
  await Promise.all([unused.dispose(), unused.dispose()]);
  assert.equal(commands('stop_pi').length, 1, 'concurrent disposal stops the session once');
  assert.equal(commands('remove_temporary_chat').length, 1, 'concurrent disposal removes the folder once');
  assert.deepEqual(commands('remove_temporary_chat').at(-1).args, { path: '/tmp/chat', hostId: 'local' });
  const used = transport({});
  await used.connect();
  await used.startDraft();
  await used.command({ type: 'prompt', message: 'hello' });
  await emit('pi://event', { runtimeId: commands('start_pi').at(-1).args.runtimeId, event: { type: 'message_start', message: { role: 'user', content: 'hello' } } });
  await used.dispose();
  assert.equal(commands('remove_temporary_chat').length, 1);
  const retained = transport({});
  await retained.connect();
  await retained.startDraft();
  responses.set('stop_pi', false);
  await retained.dispose();
  assert.equal(commands('remove_temporary_chat').length, 1);
});

test('subscriptions replay queue, pins, statuses and unresolved dialogs, and filter other runtimes', async () => {
  const client = transport();
  await client.connect();
  const runtimeId = commands('start_pi')[0].args.runtimeId;
  const send = event => emit('pi://event', { runtimeId, event });
  const seen = [];
  const unsubscribe = client.subscribe(event => seen.push(event));
  assert.equal(seen[0].type, 'queue_update');
  assert.deepEqual(seen[1], { type: 'pinned_messages', pins: [] });
  await emit('pi://event', { runtimeId: 'another', event: { type: 'agent_start' } });
  assert.equal(seen.length, 2);
  const status = { type: 'extension_ui_request', method: 'setStatus', statusKey: 'key', statusText: 'ready' };
  const dialog = { type: 'extension_ui_request', method: 'confirm', id: 'dialog' };
  const queue = { type: 'queue_update', steering: ['hello'], followUp: [] };
  const pins = { type: 'pinned_messages', pins: [{ entryId: 'entry', role: 'prompt', text: 'Pinned', timestamp: 1 }] };
  await send(status); await send(dialog); await send(queue); await send(pins);
  const replay = [];
  const stopReplay = client.subscribe(event => replay.push(event));
  stopReplay();
  const clearedStatus = { ...status, statusText: '' };
  await send(clearedStatus);
  assert.deepEqual(replay, [queue, pins, status, dialog]);
  assert.deepEqual(seen.at(-1), clearedStatus);
  unsubscribe();
  await send({ type: 'extension_ui_resolved', id: 'dialog' });
  const cleared = [];
  client.subscribe(event => cleared.push(event));
  assert.deepEqual(cleared, [queue, pins]);
  await send({ type: 'settings_pending', pending: true });
  assert.equal(client.hasPendingSettings(), true);
  await send({ type: 'disconnected' });
  assert.equal(client.hasPendingSettings(), false);
});

test('returning subscribers recover widgets and removed widgets stay removed', async () => {
  const client = transport(); await client.connect();
  const runtimeId = commands('start_pi')[0].args.runtimeId;
  const widget = { type: 'extension_ui_request', method: 'setWidget', widgetKey: 'progress', widgetLines: ['Working'] };
  await emit('pi://event', { runtimeId, event: widget });
  const replay = []; const unsubscribe = client.subscribe(event => replay.push(event)); unsubscribe();
  assert.ok(replay.some(event => event.method === 'setWidget' && event.widgetLines[0] === 'Working'));
  await emit('pi://event', { runtimeId, event: { ...widget, widgetLines: undefined } });
  const cleared = []; client.subscribe(event => cleared.push(event));
  assert.equal(cleared.some(event => event.method === 'setWidget'), false);
});

test('history refresh uses daemon entries without retaining a second live assistant copy', async () => {
  const client = transport();
  await client.connect();
  const send = event => emit('pi://event', event);
  responses.set('pi_command:get_entries', () => ({ entries: [], leafId: 'parent' }));
  await send({ type: 'message_start', message: { role: 'assistant', timestamp: 123, content: '' } });
  await send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' } });
  const history = await client.command({ type: 'get_entries' });
  assert.deepEqual(history, { entries: [], leafId: 'parent' });
  responses.set('pi_command:get_entries', () => ({ entries: [{ message: { role: 'assistant', timestamp: 123 } }], leafId: 'persisted' }));
  assert.equal((await client.command({ type: 'get_entries' })).entries.length, 1);
  responses.set('pi_command:get_entries', () => ({ entries: [], leafId: null }));
  await send({ type: 'message_end', message: { role: 'assistant', timestamp: 123, content: 'done' } });
  assert.equal((await client.command({ type: 'get_entries' })).entries.length, 0);
  await send({ type: 'message_start', message: { role: 'assistant', timestamp: 124, content: '' } });
  await send({ type: 'session_switched' });
  assert.equal((await client.command({ type: 'get_entries' })).entries.length, 0);
});

test('compact prompts go to the queue as messages while state updates retain their semantics', async () => {
  const client = transport();
  await client.command({ type: 'prompt', message: '/compact   keep the decisions  ' });
  await client.command({ type: 'follow_up', message: '/compact' });
  assert.deepEqual(rpc('compact'), []);
  assert.equal(rpc('prompt')[0].args.command.message, '/compact   keep the decisions  ');
  assert.equal(rpc('follow_up')[0].args.command.message, '/compact');
  responses.set('pi_command:get_state', { sessionFile: '/session', sessionId: 'id' });
  await client.command({ type: 'get_state' });
  assert.equal(client.currentSessionPath(), '/session');
  responses.set('pi_command:get_snapshot', { state: { sessionFile: '/other', sessionId: 'other' } });
  await client.command({ type: 'get_snapshot' });
  assert.equal(client.connectionTarget().sessionId, 'other');
  responses.set('pi_command:fork', { cancelled: true });
  await client.command({ type: 'fork' });
  assert.equal(client.connectionTarget().sessionId, 'other');
  responses.set('pi_command:fork', {});
  await client.command({ type: 'fork' });
  assert.equal(client.connectionTarget().sessionId, undefined);
  await client.changePendingMessage('pending', { type: 'remove' });
  assert.deepEqual(rpc('change_pending')[0].args.command, { type: 'change_pending', id: 'pending', action: { type: 'remove' } });
});

test('diagnostics retain the last five matching stderr lines and augment connection failures only', async () => {
  const client = transport();
  await client.connect();
  const runtimeId = commands('start_pi')[0].args.runtimeId;
  for (let i = 0; i < 6; i++) await emit('pi://stderr', { runtimeId, line: ` line ${i} ` });
  await emit('pi://stderr', ' final ');
  await emit('pi://stderr', { runtimeId: 'other', line: 'ignore' });
  await emit('pi://stderr', { runtimeId, line: ' ' });
  assert.equal(client.lastDiagnostic(), 'line 2\nline 3\nline 4\nline 5\nfinal');
  responses.set('pi_command:prompt', new Error('Disconnected'));
  await assert.rejects(client.command({ type: 'prompt' }), { message: 'Disconnected\nline 2\nline 3\nline 4\nline 5\nfinal' });
  responses.set('pi_command:prompt', new Error('Bad input'));
  await assert.rejects(client.command({ type: 'prompt' }), { message: 'Bad input' });
});

test('fast-mode changes send the session command without command discovery', async () => {
  const client = transport();
  responses.set('pi_command:set_fast_mode', {});
  await client.setFastMode(true);
  await client.setFastMode(false);
  assert.deepEqual(rpc('set_fast_mode').map(call => call.args.command.enabled), [true, false]);
  assert.equal(rpc('get_commands').length, 0);
});

test('fast-mode command failures are reported to the caller', async () => {
  const client = transport();
  responses.set('pi_command:set_fast_mode', new Error('save failed'));
  await assert.rejects(client.setFastMode(true), { message: 'save failed' });
});
});
