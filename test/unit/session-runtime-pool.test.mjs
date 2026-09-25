import assert from 'node:assert/strict';
import { test, describe, beforeEach, afterEach } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { mockIPC, clearMocks } from '../mock-ipc.mjs';
import { emit } from '@tauri-apps/api/event';
import { SessionRuntimePool } from '../../src/lib/sessionRuntimePool.ts';

describe('session runtime pool', () => {
  let pool, calls, responses, errors;
  beforeEach(() => {
    globalThis.window = Object.assign(new EventTarget(), { crypto: globalThis.crypto });
    globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => true });
    calls = []; errors = [];
    responses = new Map([['start_pi', { attached: false }], ['stop_pi', true], ['load_git_diffs', {}], ['pi_command:get_state', { sessionId: 'session', sessionFile: '/session', messageCount: 0 }]]);
    mockIPC((command, args) => {
      calls.push({ command, args });
      const result = responses.get(command === 'pi_command' ? `pi_command:${args.command.type}` : command);
      if (result instanceof Error) throw result;
      return typeof result === 'function' ? result(args) : result;
    }, { shouldMockEvents: true });
    pool = new SessionRuntimePool();
    pool.setErrorHandler(error => errors.push(error));
  });
  afterEach(async () => {
    await pool.disconnectAll();
    clearMocks(); delete globalThis.window; delete globalThis.document;
  });
  const commands = name => calls.filter(call => call.command === name);
  const connect = async client => { await client.connect(); return commands('start_pi').at(-1).args.runtimeId; };
  const send = (runtimeId, event) => emit('pi://event', { runtimeId, event });
  const settled = async () => { await setImmediate(); };
  const patch = 'diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new';
  const session = { id: 'session', cwd: '/repo', path: '/session', hostId: 'local' };

  test('sessions reuse transports by host and track running, unseen and active state', async () => {
    const client = pool.forSession(session);
    assert.equal(pool.forSession(session), client);
    assert.notEqual(pool.forSession({ ...session, hostId: 'remote' }), client);
    const id = await connect(client);
    let notifications = 0;
    const unsubscribe = pool.subscribe(() => notifications++);
    await send(id, { type: 'agent_start' });
    assert.equal(pool.isRunning(client), true);
    assert.equal(pool.isAnyRunning(), true);
    assert.deepEqual([...pool.runningSessions()], ['local:session']);
    await send(id, { type: 'agent_settled' });
    assert.equal(pool.isAnyRunning(), false);
    assert.deepEqual([...pool.unseenSessions()], ['local:session']);
    pool.activate(client);
    assert.equal(pool.unseenSessions().size, 0);
    await send(id, { type: 'agent_start' });
    await send(id, { type: 'agent_settled' });
    assert.equal(pool.unseenSessions().size, 0);
    await send(id, { type: 'runtime_presence', isStreaming: true });
    assert.equal(pool.isRunning(client), true);
    await send(id, { type: 'runtime_presence', isStreaming: false });
    assert.equal(pool.isRunning(client), false);
    await send(id, { type: 'agent_start' });
    pool.bind('local', 'renamed', client);
    assert.deepEqual([...pool.runningSessions()], ['local:renamed']);
    pool.bind('local', '', client);
    assert.equal(pool.runningSessions().size, 0);
    assert.ok(notifications > 0);
    unsubscribe();
  });

  test('interactive panes remain visible when another transport is activated', async () => {
    const first = pool.create({ cwd: '/one' }); const second = pool.create({ cwd: '/two' });
    const firstId = await connect(first); await connect(second);
    pool.activate(first); pool.setInteractive(first, true); pool.activate(second);
    assert.equal(commands('pi_presence').filter(call => call.args.runtimeId === firstId).at(-1).args.presence.visible, true);
    pool.setInteractive(first, false);
    assert.equal(commands('pi_presence').filter(call => call.args.runtimeId === firstId).at(-1).args.presence.visible, false);
    pool.activate();
    assert.equal(commands('pi_presence').at(-1).args.presence.visible, false);
  });

  test('MCP startup retains a runtime immediately before session state resolves', async () => {
    const pending = Promise.withResolvers();
    responses.set('pi_command:get_state', () => pending.promise);
    const client = pool.create({ cwd: '/repo' });
    const id = await connect(client);
    await send(id, { type: 'extension_ui_request', method: 'setStatus', statusKey: 'pi-desktop-mcp-status', statusText: 'json:[{"status":"starting"}]' });
    assert.equal(pool.isRetained(client), true);
    assert.deepEqual(pool.liveSessionSummaries(), []);
    pending.resolve({ sessionId: 'session', sessionFile: '/session', messageCount: 0 });
    await settled();
    assert.equal(pool.liveSessionSummaries()[0].name, 'New session');
    assert.equal(pool.liveSessionSummaries()[0].project, 'repo');
    assert.equal(pool.forSession(session), client);
    const revision = pool.liveSessionRevision();
    await pool.release(client);
    assert.equal(pool.liveSessionSummaries().length, 0);
    assert.ok(pool.liveSessionRevision() > revision);
    assert.equal(pool.isRetained(client), false);
    const count = commands('stop_pi').length;
    await pool.release(client);
    assert.equal(commands('stop_pi').length, count);
  });

  test('user prompts update retained session summaries while preserving project details', async () => {
    const client = pool.create({ cwd: '/repo' });
    pool.setLiveSession(client, { ...session, projectKind: 'main', projectRoot: '/repo', cwdExists: true, apiCost: 2, messageCount: 4, name: 'Previous' });
    const id = await connect(client);
    const text = 'a'.repeat(80);
    await send(id, { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } });
    await settled();
    const current = pool.liveSessionSummaries()[0];
    assert.equal(current.name, text.slice(0, 60));
    assert.equal(current.preview, text);
    assert.equal(current.projectKind, 'main');
    assert.equal(current.messageCount, 4);
    assert.equal(current.apiCost, 2);
    await pool.remove(session);
    assert.equal(pool.liveSessionSummaries().length, 0);
    await pool.remove(session);
  });

  test('malformed MCP statuses and late state responses cannot resurrect released sessions', async () => {
    const pending = Promise.withResolvers();
    responses.set('pi_command:get_state', () => pending.promise);
    const client = pool.create({ cwd: '/repo' }); const id = await connect(client);
    for (const statusText of ['json:{', 'json:{}', 'json:[{"status":"ready"}]', 'plain']) {
      await send(id, { type: 'extension_ui_request', method: 'setStatus', statusKey: 'pi-desktop-mcp-status', statusText });
    }
    assert.equal(pool.isRetained(client), false);
    await send(id, { type: 'message_start', message: { role: 'user', content: 'hello' } });
    await pool.release(client);
    pending.resolve({ sessionId: 'session', messageCount: 1 });
    await settled();
    assert.deepEqual(pool.liveSessionSummaries(), []);
  });

  test('saved diffs load once per path, reload for matching notifications and report failures', async () => {
    responses.set('load_git_diffs', { answer: patch });
    const client = pool.forSession(session); const id = await connect(client);
    await settled();
    assert.deepEqual(pool.gitDiffs(client), { answer: patch });
    pool.bind('local', 'session', client);
    assert.equal(commands('load_git_diffs').length, 1);
    await send(id, { type: 'diffs_changed', hostId: 'remote', sessionPath: '/session' });
    await send(id, { type: 'diffs_changed', hostId: 'local', sessionPath: '/other' });
    assert.equal(commands('load_git_diffs').length, 1);
    responses.set('load_git_diffs', new Error('unreadable'));
    await send(id, { type: 'diffs_changed', hostId: 'local', sessionPath: '/session' });
    await settled();
    assert.deepEqual(pool.gitDiffs(client), {});
    assert.match(errors[0], /Could not load saved project changes: unreadable/);
    responses.set('load_git_diffs', { newer: patch });
    pool.bind('local', 'session', client);
    await settled();
    assert.deepEqual(pool.gitDiffs(client), { newer: patch });
  });

  test('copied diffs retain only requested message ids and ignore obsolete source loads', async () => {
    const pending = Promise.withResolvers();
    responses.set('load_git_diffs', args => args.sessionPath === '/session' ? pending.promise : { keep: patch, discard: patch });
    const client = pool.forSession(session);
    await pool.copySavedDiffs(client, '/source', '/destination', new Set(['keep']));
    pending.resolve({ stale: patch }); await settled();
    assert.deepEqual(pool.gitDiffs(client), { keep: patch });
    assert.deepEqual(commands('save_git_diffs')[0].args, { sessionPath: '/destination', snapshots: { keep: patch }, hostId: 'local' });
    for (const [source, destination] of [[undefined, '/a'], ['/a', undefined], ['/a', '/a']]) await pool.copySavedDiffs(client, source, destination);
    assert.equal(commands('save_git_diffs').length, 1);
    await pool.copySavedDiffs(client, '/source', '/all');
    assert.deepEqual(pool.gitDiffs(client), { keep: patch, discard: patch });
  });

  test('settings reconnect only transports whose remote connection changed', async () => {
    pool.create({ cwd: '/repo' });
    const remote = pool.create({ cwd: '/repo', hostId: 'remote' });
    const old = { hosts: [{ id: 'remote', target: 'before', piPath: 'pi' }] };
    pool.queueSettingsChange(old, { hosts: [{ ...old.hosts[0], name: 'renamed' }] });
    assert.equal(pool.pendingSettingsCount(), 0);
    pool.queueSettingsChange(old, { hosts: [{ ...old.hosts[0], target: 'after' }] });
    assert.equal(pool.pendingSettingsCount(), 1);
    await remote.command({ type: 'probe' });
    assert.equal(pool.pendingSettingsCount(), 0);
    assert.equal(commands('start_pi').length, 1);
    assert.equal(commands('start_pi')[0].args.hostId, 'remote');
  });

  test('ephemeral turns retain daemon diffs in memory without saving them to the source session', async () => {
    responses.set('load_git_diffs', { previous: patch });
    const client = pool.createEphemeralFork({ cwd: '/repo' }, '/source'); const id = await connect(client);
    responses.set('pi_command:get_state', { sessionId: 'fork', sessionFile: '/fork' });
    await client.command({ type: 'get_state' });
    const snapshot = { patch, repositoryRoot: '/repo' };
    await send(id, { type: 'turn_diff', hostId: 'remote', sessionPath: '/fork', messageId: 'wrong-host', snapshot });
    await send(id, { type: 'turn_diff', hostId: 'local', sessionPath: '/other', messageId: 'wrong-path', snapshot });
    await send(id, { type: 'turn_diff', hostId: 'local', sessionPath: '/fork', messageId: 'answer', snapshot });
    await settled();
    assert.deepEqual(pool.gitDiffs(client), { previous: patch, answer: snapshot });
    assert.deepEqual(await pool.captureMemoryDiffs(client), { previous: patch, answer: snapshot });
    assert.equal(commands('save_git_diffs').length, 0);
    assert.equal(commands('capture_git_tree').length, 0);
  });

  test('late ephemeral diff events cannot restore a released session', async () => {
    const pending = Promise.withResolvers();
    responses.set('load_git_diffs', () => pending.promise);
    const client = pool.createEphemeralFork({ cwd: '/repo' }, '/source'); const id = await connect(client);
    responses.set('pi_command:get_state', { sessionId: 'fork', sessionFile: '/fork' });
    await client.command({ type: 'get_state' });
    await send(id, { type: 'turn_diff', hostId: 'local', sessionPath: '/fork', messageId: 'answer', snapshot: { patch } });
    await pool.release(client);
    pending.resolve({ previous: patch }); await settled();
    assert.equal(pool.isRetained(client), false);
    assert.equal(commands('save_git_diffs').length, 0);
    assert.deepEqual(pool.liveSessionSummaries(), []);
  });
});
