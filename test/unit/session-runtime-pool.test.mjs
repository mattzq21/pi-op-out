import assert from 'node:assert/strict';
import { test, describe, beforeEach, afterEach } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installDom } from '../dom.mjs';
import { mockIPC, clearMocks } from '../mock-ipc.mjs';
import { emit } from '@tauri-apps/api/event';
import { SessionRuntimePool } from '../../clients/ui/lib/sessionRuntimePool.ts';

describe('session runtime pool', () => {
  let pool, calls, responses, errors, dom;
  beforeEach(() => {
    dom = installDom();
    calls = []; errors = [];
    responses = new Map([['start_pi', { attached: false }], ['stop_pi', true], ['pi_command:get_state', { model: null, thinkingLevel: 'off', isStreaming: false, sessionId: 'session', sessionFile: '/session', messageCount: 0, pendingMessageCount: 0 }],
      ['broker_request', ({ body }) => ({ sessionId: body.sessionId, sessionPath: '/session', cwd: '/repo', archived: false, revision: '1' })],
      ['provider_auth', { config: { agents: [] }, models: [], initialModel: null, initialThinking: 'medium', commands: [], commandDetails: [] }],
      ['pi_command:get_commands', { commands: [{ name: 'fast', source: 'extension', sourceInfo: { path: '/extensions/piop-openai-fast-mode/index.ts' } }] }]]);
    mockIPC((command, args) => {
      calls.push({ command, args });
      const result = responses.get(command === 'pi_command' ? `pi_command:${args.command.type}` : command);

      if (result instanceof Error) throw result;

      return result instanceof Function ? result(args) : result;
    }, { shouldMockEvents: true });
    pool = new SessionRuntimePool();
    pool.setErrorHandler(error => errors.push(error));
  });
  afterEach(async () => {
    await pool.disconnectAll();
    clearMocks(); dom.restore();
  });
  const commands = name => calls.filter(call => call.command === name);

  const connect = async client => { await client.connect(); await client.startDraft();

  return commands('start_pi').at(-1).args.runtimeId; };

  const send = (runtimeId, event) => emit('pi://event', { runtimeId, event });
  const settled = async () => { await setImmediate(); };

  const session = { id: 'session', cwd: '/repo', path: '/session', hostId: 'local' };

  test('informational extension messages do not mark an idle conversation running', async () => {
    const client = pool.forSession(session);
    const id = await connect(client);
    const message = { role: 'custom', customType: 'pi-desktop-mcp-status', content: 'No MCP servers loaded' };
    await send(id, { type: 'message_start', message });
    await send(id, { type: 'message_end', message });
    assert.equal(pool.isRunning(client), false);
    assert.equal(pool.runningSessions().size, 0);
  });

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
    await settled();
    assert.equal(commands('pi_presence').filter(call => call.args.runtimeId === firstId).at(-1).args.presence.visible, true);
    pool.setInteractive(first, false);
    await settled();
    assert.equal(commands('pi_presence').filter(call => call.args.runtimeId === firstId).at(-1).args.presence.visible, false);
    pool.activate();
    await settled();
    assert.equal(commands('pi_presence').at(-1).args.presence.visible, false);
  });

  test('standalone status messages do not mark a conversation as running', async () => {
    const client = pool.forSession(session);
    const id = await connect(client);
    await send(id, { type: 'message_start', message: { role: 'custom', customType: 'pi-desktop-mcp-status', content: 'Connected' } });
    await send(id, { type: 'message_end', message: { role: 'custom', customType: 'pi-desktop-mcp-status', content: 'Connected' } });
    assert.equal(pool.isRunning(client), false);
    assert.equal(pool.runningSessions().size, 0);
  });

  test('MCP startup retains a runtime immediately before session state resolves', async () => {
    const pending = Promise.withResolvers();
    const started = Promise.withResolvers();
    responses.set('pi_command:get_state', () => pending.promise);
    responses.set('start_pi', () => { started.resolve();

    return { attached: false }; });
    const client = pool.create({ cwd: '/repo' });
    await client.connect();
    const starting = client.startDraft();
    await started.promise; await settled();
    const id = commands('start_pi').at(-1).args.runtimeId;
    await send(id, { type: 'extension_ui_request', id: 'mcp-status', method: 'setStatus', statusKey: 'pi-desktop-mcp-status', statusText: 'json:[{"status":"starting"}]' });
    assert.equal(pool.isRetained(client), true);
    assert.deepEqual(pool.liveSessionSummaries(), []);
    pending.resolve({ model: null, thinkingLevel: 'off', isStreaming: false, sessionId: 'session', sessionFile: '/session', messageCount: 0, pendingMessageCount: 0 });
    await starting;
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
    pool.setLiveSession(client, { ...session, cwdExists: true, apiCost: 2, messageCount: 4, name: 'Previous' });
    const id = await connect(client);
    const text = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz12345678 omitted from the title';
    await send(id, { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } });
    await settled();
    const current = pool.liveSessionSummaries()[0];
    assert.equal(current.name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcd');
    assert.equal(current.preview, text);
    assert.equal(current.messageCount, 4);
    assert.equal(current.apiCost, 2);
    await pool.remove(session);
    assert.equal(pool.liveSessionSummaries().length, 0);
    await pool.remove(session);
  });

  // The sidebar seeds groups from these summaries before the chat list has a new branch. A summary without its source let
  // the branch's worktree folder become its group, and the daemon keeps that first assignment.
  test('a retained branch summary names its source chat from session state', async () => {
    responses.set('pi_command:get_state', { model: null, thinkingLevel: 'off', isStreaming: false, sessionId: 'branch', sessionFile: '/branch.jsonl', messageCount: 2, pendingMessageCount: 0,
      forkSource: { sessionId: 'source', sessionPath: '/source.jsonl', entryId: 'answer' } });
    const client = pool.create({ cwd: '/worktrees/branch' });
    const id = await connect(client);
    await send(id, { type: 'extension_ui_request', id: 'mcp-status', method: 'setStatus', statusKey: 'pi-desktop-mcp-status', statusText: 'json:[{"status":"starting"}]' });
    await settled(); await settled();
    assert.equal(pool.liveSessionSummaries()[0].id, 'branch');
    assert.equal(pool.liveSessionSummaries()[0].forkSourceId, 'source');
    await send(id, { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'Next step' }] } });
    await settled(); await settled();
    assert.equal(pool.liveSessionSummaries()[0].forkSourceId, 'source');
  });

  test('malformed MCP statuses and late state responses cannot resurrect released sessions', async () => {
    const pending = Promise.withResolvers();
    const started = Promise.withResolvers();
    responses.set('pi_command:get_state', () => pending.promise);
    responses.set('start_pi', () => { started.resolve();

    return { attached: false }; });
    const client = pool.create({ cwd: '/repo' }); await client.connect();
    const starting = client.startDraft();
    await started.promise; await settled();
    const id = commands('start_pi').at(-1).args.runtimeId;

    for (const statusText of ['json:{', 'json:{}', 'json:[{"status":"ready"}]', 'plain']) {
      await send(id, { type: 'extension_ui_request', id: 'mcp-status', method: 'setStatus', statusKey: 'pi-desktop-mcp-status', statusText });
    }

    assert.equal(pool.isRetained(client), false);
    await send(id, { type: 'message_start', message: { role: 'user', content: 'hello' } });
    await pool.release(client);
    pending.resolve({ sessionId: 'session', messageCount: 1 });
    await starting;
    await settled();
    assert.deepEqual(pool.liveSessionSummaries(), []);
  });




});
