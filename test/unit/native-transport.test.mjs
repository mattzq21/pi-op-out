import assert from 'node:assert/strict';
import { test, describe, beforeEach, afterEach } from 'node:test';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import * as native from '../../src/lib/nativeTransport.ts';

describe('native transport', () => {
let calls, responses, transports;
beforeEach(() => {
  globalThis.window = Object.assign(new EventTarget(), { crypto: globalThis.crypto, location: { search: '' } });
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => true });
  calls = []; transports = [];
  responses = new Map([
    ['start_pi', { attached: false }], ['stop_pi', true],
    ['create_temporary_chat', { cwd: '/tmp/chat', sessionId: 'temporary' }],
  ]);
  mockIPC((command, args) => {
    calls.push({ command, args });
    const key = command === 'pi_command' ? `pi_command:${args.command.type}` : command;
    const result = responses.get(key);
    if (result instanceof Error) throw result;
    return typeof result === 'function' ? result(args) : result;
  }, { shouldMockEvents: true });
});
afterEach(async () => {
  for (const transport of transports) await transport.disconnect();
  clearMocks();
  delete globalThis.window; delete globalThis.document; delete globalThis.__PIOP_TEST_MODE__;
});
const transport = (target = { cwd: '/repo' }) => { const value = new native.NativeTransport(target); transports.push(value); return value; };
const commands = name => calls.filter(call => call.command === name);
const rpc = type => commands('pi_command').filter(call => call.args.command.type === type);

test('transport shares concurrent connects, publishes presence and cleans up listeners', async () => {
  const client = transport();
  assert.equal(client.needsDefaults(), true);
  await Promise.all([client.connect(), client.connect()]);
  assert.equal(commands('start_pi').length, 1);
  assert.equal(commands('start_pi')[0].args.cwd, '/repo');
  client.setVisible(true);
  assert.deepEqual(commands('pi_presence').at(-1).args.presence, { visible: true, focused: true });
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(commands('pi_presence').at(-1).args.presence.visible, false);
  await client.connect();
  assert.equal(commands('start_pi').length, 1);
  client.defaultsApplied();
  assert.equal(client.needsDefaults(), false);
  await client.disconnect();
  const count = commands('pi_presence').length;
  window.dispatchEvent(new Event('focus'));
  assert.equal(commands('pi_presence').length, count);
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
  const unused = transport({});
  await unused.connect(undefined, undefined, undefined, undefined, true);
  assert.equal(unused.isTemporaryChat(), true);
  assert.equal(commands('start_pi').at(-1).args.noSession, true);
  await unused.dispose();
  assert.deepEqual(commands('remove_temporary_chat').at(-1).args, { path: '/tmp/chat', hostId: 'local' });
  const used = transport({});
  await used.connect();
  await used.command({ type: 'prompt', message: 'hello' });
  await used.dispose();
  assert.equal(commands('remove_temporary_chat').length, 1);
  const retained = transport({});
  await retained.connect();
  responses.set('stop_pi', false);
  await retained.dispose();
  assert.equal(commands('remove_temporary_chat').length, 1);
});

test('disconnect during temporary-chat allocation cleans up without starting a process', async () => {
  const pending = Promise.withResolvers();
  responses.set('create_temporary_chat', () => pending.promise);
  const client = transport({});
  const connecting = client.connect();
  await client.disconnect();
  pending.resolve({ cwd: '/tmp/late', sessionId: 'late' });
  await connecting;
  assert.equal(commands('start_pi').length, 0);
  assert.equal(commands('remove_temporary_chat')[0].args.path, '/tmp/late');
});

test('subscriptions replay queue, statuses and unresolved dialogs, and filter other runtimes', async () => {
  const client = transport();
  await client.connect();
  const runtimeId = commands('start_pi')[0].args.runtimeId;
  const send = event => emit('pi://event', { runtimeId, event });
  const seen = [];
  const unsubscribe = client.subscribe(event => seen.push(event));
  assert.equal(seen[0].type, 'queue_update');
  await emit('pi://event', { runtimeId: 'another', event: { type: 'agent_start' } });
  assert.equal(seen.length, 1);
  const status = { type: 'extension_ui_request', method: 'setStatus', statusKey: 'key', statusText: 'ready' };
  const dialog = { type: 'extension_ui_request', method: 'confirm', id: 'dialog' };
  const queue = { type: 'queue_update', steering: ['hello'], followUp: [] };
  await send(status); await send(dialog); await send(queue);
  const replay = [];
  const stopReplay = client.subscribe(event => replay.push(event));
  assert.deepEqual(replay, [queue, status, dialog]);
  stopReplay(); unsubscribe();
  await send({ ...status, statusText: '' });
  await send({ type: 'extension_ui_resolved', id: 'dialog' });
  const cleared = [];
  client.subscribe(event => cleared.push(event));
  assert.deepEqual(cleared, [queue]);
  await send({ type: 'settings_pending', pending: true });
  assert.equal(client.hasPendingSettings(), true);
  await send({ type: 'disconnected' });
  assert.equal(client.hasPendingSettings(), false);
});

test('live assistant streaming survives history refresh until persisted and resets on session switches', async () => {
  const client = transport();
  await client.connect();
  const send = event => emit('pi://event', event);
  responses.set('pi_command:get_entries', () => ({ entries: [], leafId: 'parent' }));
  await send({ type: 'message_start', message: { role: 'assistant', timestamp: 123, content: '' } });
  await send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' } });
  const history = await client.command({ type: 'get_entries' });
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].parentId, 'parent');
  assert.equal(history.entries[0].message.content[0].text, 'hello');
  assert.equal(history.leafId, history.entries[0].id);
  responses.set('pi_command:get_entries', () => ({ entries: [{ message: { role: 'assistant', timestamp: 123 } }], leafId: 'persisted' }));
  assert.equal((await client.command({ type: 'get_entries' })).entries.length, 1);
  responses.set('pi_command:get_entries', () => ({ entries: [], leafId: null }));
  await send({ type: 'message_end', message: { role: 'assistant', timestamp: 123, content: 'done' } });
  assert.equal((await client.command({ type: 'get_entries' })).entries.length, 0);
  await send({ type: 'message_start', message: { role: 'assistant', timestamp: 124, content: '' } });
  await send({ type: 'session_switched' });
  assert.equal((await client.command({ type: 'get_entries' })).entries.length, 0);
});

test('compact prompts become commands while ordinary prompts and state updates retain their semantics', async () => {
  const client = transport();
  await client.command({ type: 'prompt', message: '/compact   keep the decisions  ' });
  await client.command({ type: 'prompt', message: '/compact' });
  await client.command({ type: 'prompt', message: '/compactly' });
  assert.deepEqual(rpc('compact').map(call => call.args.command), [{ type: 'compact', customInstructions: 'keep the decisions' }, { type: 'compact' }]);
  assert.equal(rpc('prompt')[0].args.command.message, '/compactly');
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
  await emit('pi://stderr', { runtimeId: 'other', line: 'ignore' });
  await emit('pi://stderr', { runtimeId, line: ' ' });
  for (let i = 0; i < 6; i++) await emit('pi://stderr', { runtimeId, line: ` line ${i} ` });
  await emit('pi://stderr', ' final ');
  assert.equal(client.lastDiagnostic(), 'line 2\nline 3\nline 4\nline 5\nfinal');
  responses.set('pi_command:prompt', new Error('Disconnected'));
  await assert.rejects(client.command({ type: 'prompt' }), /Disconnected\nline 2/);
  responses.set('pi_command:prompt', new Error('Bad input'));
  await assert.rejects(client.command({ type: 'prompt' }), { message: 'Bad input' });
});

test('fast-mode discovery uses package provenance and refreshes compatibility status', async () => {
  const client = transport();
  await assert.rejects(client.toggleFastMode(), /unavailable/);
  responses.set('pi_command:get_commands', { commands: [
    { name: 'fast', source: 'extension', sourceInfo: { source: 'npm:unrelated' } },
    { name: 'fast:2', source: 'extension', sourceInfo: { path: 'C:\\node_modules\\pi-openai-fast-mode\\index.ts' } },
    { name: 'pi-desktop-fast-status', source: 'extension' },
  ] });
  await client.setFastMode(true);
  assert.deepEqual(rpc('prompt').map(call => call.args.command.message), ['/pi-desktop-fast-status', '/fast:2 on', '/pi-desktop-fast-status refresh']);
  await client.setFastMode(false);
  assert.ok(rpc('prompt').some(call => call.args.command.message === '/fast:2 off'));
  await client.command({ type: 'prompt', message: '/fast:2 toggle' });
  assert.equal(rpc('prompt').at(-1).args.command.message, '/pi-desktop-fast-status refresh');
  responses.set('pi_command:get_commands', { commands: [{ name: 'fast', source: 'extension', sourceInfo: { source: 'npm:pi-openai-fast-mode-piop' } }] });
  await client.setFastMode(true);
  assert.equal(rpc('prompt').at(-1).args.command.message, '/fast on');
});

test('settings save rolls back persisted values and connection after reconnect failure', async () => {
  const client = transport({ cwd: '/repo', hostId: 'remote', sessionId: 'id' });
  const previous = { hosts: [{ id: 'remote', target: 'before' }] };
  const next = { hosts: [{ id: 'remote', target: 'after' }] };
  responses.set('load_app_settings', previous);
  responses.set('save_app_settings', { reconnect: true });
  let attempts = 0;
  responses.set('start_pi', () => { if (++attempts === 1) throw new Error('cannot connect'); return { attached: true }; });
  await assert.rejects(client.saveSettings(next), /cannot connect/);
  assert.deepEqual(commands('save_app_settings').map(call => call.args.settings), [next, previous]);
  assert.equal(client.currentHostId(), 'remote');
  assert.equal(client.currentCwd(), '/repo');
  assert.equal(attempts, 2);
  await client.saveSettings(next, false, 'remote');
  assert.equal(commands('save_app_settings').at(-1).args.agentHostId, 'remote');
  assert.equal(attempts, 2);
});

test('queued settings wait for an active command and migrate removed hosts to local', async () => {
  const client = transport({ cwd: '/remote', hostId: 'remote' });
  const pending = Promise.withResolvers();
  responses.set('pi_command:prompt', () => pending.promise);
  const request = client.command({ type: 'prompt', message: 'hello' });
  client.queueSettings({ hosts: [] }, { reconnect: true });
  assert.equal(client.hasPendingSettings(), true);
  assert.equal(commands('stop_pi').length, 0);
  pending.resolve();
  await request;
  await client.command({ type: 'get_commands' }).catch(() => {});
  assert.equal(client.currentHostId(), 'local');
  assert.equal(client.currentCwd(), '/tmp/chat');
  assert.equal(client.hasPendingSettings(), false);
  await client.dispose();
  client.queueSettings({ hosts: [] }, { reconnect: true });
  assert.equal(client.hasPendingSettings(), false);
});

test('worktree setup exposes cancellation and always clears the callback on failure', async () => {
  const client = transport();
  responses.set('prepare_worktree_setup', 'setup');
  responses.set('run_worktree_setup', new Error('setup failed'));
  const callbacks = [];
  await assert.rejects(client.runWorktreeSetup('/repo', '/tree', 'remote', cancel => { callbacks.push(cancel); }), /setup failed/);
  assert.equal(typeof callbacks[0], 'function');
  assert.equal(callbacks[1], undefined);
  await callbacks[0]();
  assert.deepEqual(commands('cancel_worktree_setup')[0].args, { setupId: 'setup' });
});

test('native file and directory helpers normalize nullable results and image types', async () => {
  const client = transport({});
  assert.equal(await client.isGitRepository(), false);
  assert.equal(await client.gitBranch(), null);
  await client.prepareTemporaryChat('remote');
  assert.equal(client.currentHostId(), 'remote');
  responses.set('is_git_repository', true);
  assert.equal(await client.isGitRepository(), true);
  responses.set('git_branch', 42);
  assert.equal(await client.gitBranch(), null);
  responses.set('git_branch', 'main');
  assert.equal(await client.gitBranch(), 'main');
  responses.set('plugin:dialog|open', ['/wrong']);
  assert.equal(await client.selectProjectDirectory(), null);
  responses.set('plugin:dialog|open', '/repo');
  assert.equal(await client.selectProjectDirectory('/default'), '/repo');
  for (const [name, type] of [['picture.PNG', 'image/png'], ['a.jpeg', 'image/jpeg'], ['a.txt', '']]) {
    responses.set('read_dropped_file', { name, data: [65, 66] });
    const file = await native.readDroppedFile('/file');
    assert.equal(file.name, name);
    assert.equal(file.type, type);
    assert.equal(await file.text(), 'AB');
  }
});

test('initial window targets tolerate absent or malformed URL data', () => {
  assert.deepEqual(native.initialWindowTarget(), {});
  for (const value of ['{', 'null', '42']) { window.location.search = `?target=${encodeURIComponent(value)}`; assert.deepEqual(native.initialWindowTarget(), {}); }
  window.location.search = `?target=${encodeURIComponent(JSON.stringify({ cwd: '/repo', hostId: 'remote' }))}`;
  assert.deepEqual(native.initialWindowTarget(), { cwd: '/repo', hostId: 'remote' });
});

test('native command adapters send explicit host, path and terminal arguments and return results', async () => {
  const client = transport({ cwd: '/repo', hostId: 'remote' });
  const cases = [
    ['listSessions', [], 'list_sessions', undefined],
    ['captureGitTree', ['/repo'], 'capture_git_tree', { cwd: '/repo', hostId: 'local' }],
    ['discardGitTree', ['tree'], 'discard_git_tree', { snapshot: 'tree', hostId: 'local' }],
    ['loadGitDiff', ['/repo', 'tree'], 'load_git_diff', { cwd: '/repo', baseTree: 'tree', hostId: 'local' }],
    ['loadGitDiffs', ['/session'], 'load_git_diffs', { sessionPath: '/session', hostId: 'local' }],
    ['saveGitDiffs', ['/session', { a: 'patch' }], 'save_git_diffs', { sessionPath: '/session', snapshots: { a: 'patch' }, hostId: 'local' }],
    ['archiveSession', ['/session'], 'archive_session', { sessionPath: '/session', hostId: 'local', terminalIds: [] }],
    ['deleteSession', ['/session'], 'delete_session', { sessionPath: '/session', hostId: 'local' }],
    ['relocateSession', ['/session', '/repo'], 'relocate_session', { sessionPath: '/session', cwd: '/repo', hostId: 'local' }],
    ['openProjectDirectory', ['/repo'], 'open_project_directory', { cwd: '/repo', hostId: 'local' }],
    ['createProjectWorktree', ['/repo', 'feature'], 'create_project_worktree', { cwd: '/repo', name: 'feature', hostId: 'local' }],
    ['createGitWorktree', ['/repo', 'feature'], 'create_git_worktree', { cwd: '/repo', name: 'feature', hostId: 'local' }],
    ['removeGitWorktree', ['/tree'], 'remove_git_worktree', { cwd: '/tree', hostId: 'local', deleteBranch: false }],
    ['loadSettings', [], 'load_app_settings', undefined],
    ['loadCodexUsage', [], 'codex_usage', undefined],
    ['homeDirectory', ['remote'], 'home_directory', { hostId: 'remote' }],
    ['validateProjectDirectory', ['/repo', 'remote'], 'validate_project_directory', { path: '/repo', hostId: 'remote' }],
    ['listDirectories', ['remote'], 'list_directories', { hostId: 'remote', path: undefined }],
    ['startTerminal', ['term', 'session', '/repo', 80, 24], 'start_terminal', { terminalId: 'term', sessionKey: 'session', cwd: '/repo', cols: 80, rows: 24, hostId: 'remote' }],
    ['writeTerminal', ['term', 'input'], 'write_terminal', { terminalId: 'term', data: 'input' }],
    ['resizeTerminal', ['term', 120, 30], 'resize_terminal', { terminalId: 'term', cols: 120, rows: 30 }],
    ['closeTerminal', ['term'], 'close_terminal', { terminalId: 'term' }],
  ];
  for (const [method, args, command, expected] of cases) {
    responses.set(command, { result: command });
    assert.deepEqual(await client[method](...args), { result: command }, method);
    assert.deepEqual(commands(command).at(-1).args, expected ?? {}, method);
  }
  const functions = [
    ['openSessionWindow', [{ sessionId: 'id' }], 'new_window', { target: { sessionId: 'id' } }],
    ['loadSessionGroups', [[], {}], 'load_session_groups', { seeds: [], legacy: {} }],
    ['changeSessionGroups', [{ type: 'create', name: 'group' }], 'change_session_groups', { change: { type: 'create', name: 'group' } }],
    ['openGroupDirectory', ['/repo', 'remote'], 'open_project_directory', { cwd: '/repo', hostId: 'remote' }],
    ['gitProjectKind', ['/repo', 'remote'], 'git_project_kind', { cwd: '/repo', hostId: 'remote' }],
    ['gitWorktreeRoots', [['/repo'], 'remote'], 'git_worktree_roots', { paths: ['/repo'], hostId: 'remote' }],
    ['openExternalUrl', ['https://example.com'], 'open_external_url', { url: 'https://example.com' }],
    ['loadStorageReport', [], 'storage_report', undefined],
    ['deleteArchivedConversation', ['/session'], 'delete_archived_session', { sessionPath: '/session', hostId: 'local' }],
    ['listHooks', ['remote'], 'list_hooks', { hostId: 'remote' }],
    ['openHooksDirectory', ['/hooks'], 'open_project_directory', { cwd: '/hooks', hostId: 'local' }],
  ];
  for (const [method, args, command, expected] of functions) {
    responses.set(command, { result: command });
    assert.deepEqual(await native[method](...args), { result: command }, method);
    assert.deepEqual(commands(command).at(-1).args, expected ?? {}, method);
  }
});

test('e2e response overrides log mocked calls, reject errors and fall through to native IPC', async () => {
  globalThis.__PIOP_TEST_MODE__ = 'e2e';
  const responseField = { value: JSON.stringify({ 'pi_command:prompt': { accepted: true }, storage_report: { error: 'failed' } }) };
  const callField = { value: '[]' };
  document.querySelector = selector => selector === '#pi-e2e-responses' ? responseField : callField;
  const client = transport();
  assert.deepEqual(await client.command({ type: 'prompt', message: 'hello' }), { accepted: true });
  await assert.rejects(native.loadStorageReport(), /failed/);
  responses.set('list_sessions', ['real']);
  assert.deepEqual(await client.listSessions(), ['real']);
  assert.deepEqual(JSON.parse(callField.value).map(call => call.mocked), [true, true, false]);
  assert.equal(rpc('prompt').length, 0);
  responseField.value = ''; callField.value = '';
  assert.deepEqual(await client.listSessions(), ['real']);
});

test('settings failures notify subscribers and can be retried with another save', async () => {
  const client = transport();
  const events = [];
  client.subscribe(event => events.push(event));
  client.queueSettings({ hosts: [] }, { reconnect: false });
  assert.equal(client.hasPendingSettings(), false);
  responses.set('start_pi', new Error('offline'));
  client.queueSettings({ hosts: [] }, { reconnect: true });
  await client.command({ type: 'probe' });
  assert.ok(events.some(event => event.type === 'extension_error' && event.error.includes('offline')));
  assert.equal(client.hasPendingSettings(), true);
  responses.set('start_pi', { attached: false });
  client.queueSettings({ hosts: [] }, { reconnect: true });
  await client.command({ type: 'probe' });
  assert.equal(client.hasPendingSettings(), false);
  assert.ok(events.some(event => event.type === 'settings_applied'));
});

test('legacy fast-status failures become visible status events without failing command discovery', async () => {
  const client = transport();
  const events = [];
  client.subscribe(event => events.push(event));
  responses.set('pi_command:get_commands', { commands: [{ name: 'fast', source: 'extension', sourceInfo: { source: 'npm:pi-openai-fast-mode' } }, { name: 'pi-desktop-fast-status', source: 'extension' }] });
  responses.set('pi_command:prompt', new Error('status failed'));
  await client.command({ type: 'get_commands' });
  assert.ok(events.some(event => event.statusKey === 'pi-desktop-fast-mode' && event.statusText === 'Fast mode status unavailable'));
});
});
