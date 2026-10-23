import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { installDom, renderHook, act, whenReactive } from '../dom.mjs';
import { daemonClient } from '../daemon-client.mjs';
import { NativeTransport } from '../../clients/ui/lib/nativeTransport.ts';
import { useChatSession } from '../../clients/ui/lib/useChatSession.ts';
import { promptContext } from '../prompt-context-fixture.mjs';

async function sessionView(t, entries, { afterReply = async () => {} } = {}) {
  const dom = installDom();
  let client, hook;
  const clients = [];
  t.after(async () => {
    try { await hook?.unmount(); for (const value of clients) await value.dispose(); }
    finally { clearMocks(); dom.restore(); }
  });
  const daemon = await daemonClient(t);
  mockWindows('main');
  mockIPC(async (command, args) => {
    assert.equal(command, 'daemon_invoke');
    const result = await daemon.invoke(args.command, args.args);
    await afterReply(args.command, args.args, result);
    return result;
  }, { shouldMockEvents: true });
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = (command, args, options) => invoke(command,
    command === 'plugin:event|unlisten' ? { ...args, id: args.eventId } : args, options);
  const publishChat = async entries => {
    const home = await daemon.invoke('home_directory', { hostId: 'local' });
    const chat = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ home, cwd: home, content: entries.map(entry => JSON.stringify(entry) + '\n').join('') }),
    }));
    return { cwd: home, sessionPath: chat.path };
  };
  const target = entries ? { ...await publishChat(entries), readOnly: true } : {};
  client = new NativeTransport(target);
  clients.push(client);
  await client.connect();
  hook = await renderHook(value => useChatSession(value, undefined, { poll: !entries }), client);
  const send = async (...events) => act(() => { for (const event of events) hook.current.handleEvent(event); });
  return { dom, hook, send, client, daemon, publishChat, async createDraft() {
    const next = new NativeTransport({});
    clients.push(next);
    await next.connect();
    return next;
  } };
}

test('streaming batches deltas and finalizes a stable assistant message without duplicates', async t => {
  const { dom, hook, send } = await sessionView(t);
  await send({ type: 'message_start', message: { role: 'assistant', content: '', timestamp: 100 } });
  const id = hook.current.messages[0].id;
  await send(
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' world' } },
  );
  assert.equal(hook.current.messages[0].content, '');
  await dom.flushFrames();
  assert.equal(hook.current.messages[0].content[0].text, 'hello world');
  await send({ type: 'message_end', message: { role: 'assistant', content: 'final', timestamp: 100 } });
  assert.equal(hook.current.messages.length, 1);
  assert.equal(hook.current.messages[0].id, id);
  assert.equal(hook.current.messages[0].streaming, false);
  assert.equal(hook.current.messages[0].content, 'final');
  assert.ok(hook.current.messages[0].completedAt > 0);
});

  test('pause checkpoints the latest user, hides synthetic resume input and retains prompt context', async t => {
    const { hook, send } = await sessionView(t);
    const message = (type, role, content, extra = {}) => ({ type, message: { role, content, timestamp: 100, ...extra } });
    await send(message('message_start', 'user', 'question'));
    const context = promptContext({ system: 42 }, { userTimestamp: 100 });
    const status = { type: 'extension_ui_request', method: 'setStatus', statusKey: 'pi-desktop-prompt-context' };
    await send({ ...status, statusText: `json:${JSON.stringify(context)}` }, { ...status, statusText: 'json:{' }, { ...status, statusText: 'json:{}' }, { ...status, statusText: `json:${JSON.stringify({ ...context, tokens: 999 })}` });
    await send(message('message_end', 'user', 'question'));
    assert.deepEqual(hook.current.messages[0].promptContext, context);
    await send({ type: 'agent_start' }, { type: 'pause_state', isPaused: true, isPausing: true });
    assert.equal(hook.current.state.isStreaming, true);
    await send({ type: 'pause_state', isPaused: true, isPausing: false });
    assert.equal(hook.current.state.isStreaming, false); assert.equal(hook.current.messages[0].contextCheckpoint, true);
    await send({ type: 'entry_appended', entry: { id: 'resume-marker', type: 'custom', customType: 'pi-desktop-resume', data: { message: 'resume' } } }, message('message_start', 'user', 'resume'), message('message_start', 'custom', 'hidden', { display: false, customType: 'piop-session-operation' }));
    assert.equal(hook.current.messages.length, 1);
  });

  test('a live prompt context attaches to the agent message that started the turn', async t => {
    const { hook, send } = await sessionView(t);
    const delivery = { role: 'custom', customType: 'piop-agent-message', display: true, details: { notificationId: 'n1' }, content: 'Draw a smile', timestamp: 100 };
    await send({ type: 'message_start', message: delivery }, { type: 'message_end', message: delivery });
    const context = promptContext({ system: 42 }, { agentNotificationId: 'n1' });
    await send({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'pi-desktop-prompt-context', statusText: 'json:' + JSON.stringify(context) });
    assert.deepEqual(hook.current.messages[0].promptContext, context);
  });

  test('full-message updates allocate one identity and pending work can be discarded', async t => {
    const { dom, hook, send } = await sessionView(t);
    const message = (type, role, content, extra = {}) => ({ type, message: { role, content, timestamp: 100, ...extra } });
    await send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'orphan' } }); await dom.flushFrames();
    assert.deepEqual(hook.current.messages, []);
    await send(message('message_update', 'assistant', 'first')); await dom.flushFrames(); const id = hook.current.messages[0].id;
    await send(message('message_update', 'assistant', 'second')); await dom.flushFrames();
    assert.equal(hook.current.messages.length, 1); assert.equal(hook.current.messages[0].id, id); assert.equal(hook.current.messages[0].content, 'second');
    await send(message('message_update', 'assistant', 'discarded'));
    await act(async () => hook.current.discardPendingUpdates()); await dom.flushFrames();
    assert.equal(hook.current.messages[0].content, 'second');
  });

  test('activity, queue counts, context usage and connection state follow runtime events', async t => {
    const { hook, send } = await sessionView(t);
    await act(() => hook.current.setState(current => ({ ...current, contextUsage: { tokens: 500, contextWindow: 1000, percent: 50 } })));
    const pendingMessage = { id: 'pending', message: 'a', behavior: 'steer' };
    await send({ type: 'runtime_presence', viewers: 3, isStreaming: true }, { type: 'queue_update', steering: ['a'], followUp: ['b'], pendingMessages: [pendingMessage] });
    assert.equal(hook.current.state.viewers, 3); assert.equal(hook.current.state.pendingMessageCount, 2);
    assert.deepEqual(hook.current.state.pendingMessages, [pendingMessage]);
    await send({ type: 'compaction_start' }); assert.equal(hook.current.state.activity, 'Compacting context…');
    await send({ type: 'compaction_end', result: { estimatedTokensAfter: 100 } });
    assert.equal(hook.current.state.contextUsage.percent, 10); assert.equal(hook.current.state.activity, undefined);
    await send({ type: 'auto_retry_start', attempt: 2 }); assert.equal(hook.current.state.activity, 'Retrying · attempt 2');
    await send({ type: 'thinking_level_changed', level: 'high' }, { type: 'thinking_level_changed', level: 42 });
    assert.equal(hook.current.state.thinkingLevel, 'high');
    await send({ type: 'disconnected' }); assert.equal(hook.current.state.isStreaming, false); assert.equal(hook.current.state.activity, undefined);
    await send({ type: 'agent_start' }, { type: 'agent_settled' }, { type: 'queue_update' });
    assert.equal(hook.current.state.isStreaming, false); assert.equal(hook.current.state.pendingMessageCount, 0);
  });

  test('tool payloads load on demand and survive final messages', async t => {
    const { dom, hook, send } = await sessionView(t, [
      { type: 'message', id: 'request', parentId: null, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'edit', arguments: { path: 'a' } }], timestamp: 99 } },
      { type: 'message', id: 'result', parentId: 'request', message: { role: 'toolResult', toolCallId: 'call', toolName: 'edit', content: 'persisted', details: { diff: 'patch' }, isError: false, timestamp: 100 } },
    ]);
    const message = (type, role, content, extra = {}) => ({ type, message: { role, content, timestamp: 100, ...extra } });
    await send({ type: 'tool_execution_start', toolCallId: 'call', toolName: 'edit', args: { path: 'a' } }, { type: 'tool_execution_update', toolCallId: 'call', partialResult: { content: 'partial' } });
    await dom.flushFrames(); assert.equal(hook.current.messages[0].content, ''); assert.equal(hook.current.messages[0].toolInput, undefined);
    await send({ type: 'tool_execution_end', toolCallId: 'call', result: { content: 'done', details: { diff: 'patch' } }, isError: false });
    assert.equal(hook.current.messages[0].toolStatus, 'done');
    await send(message('message_end', 'toolResult', 'persisted', { toolCallId: 'call' }));
    assert.equal(hook.current.messages.length, 1);
    await act(() => hook.current.messages[0].loadToolPayload());
    assert.deepEqual(hook.current.messages[0].toolInput, { path: 'a' });
    assert.deepEqual(hook.current.messages[0].details, { diff: 'patch' });
    await send({ type: 'tool_execution_start', toolCallId: 'call', toolName: 'read' }, { type: 'tool_execution_end', toolCallId: 'call', isError: true });
    assert.equal(hook.current.messages.length, 1); assert.equal(hook.current.messages[0].toolStatus, 'error');
    assert.equal(hook.current.messages[0].content, ''); assert.equal(hook.current.messages[0].toolInput, undefined);
  });

test('a tool payload read from the previous conversation never fills the current conversation', { timeout: 30000 }, async t => {
  const held = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  let reads = 0;
  const toolChat = (path, diff) => [
    { type: 'message', id: 'request', parentId: null, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'edit', arguments: { path } }], timestamp: 99 } },
    { type: 'message', id: 'result', parentId: 'request', message: { role: 'toolResult', toolCallId: 'call', toolName: 'edit', content: diff, details: { diff }, isError: false, timestamp: 100 } },
  ];
  const { hook, client, publishChat } = await sessionView(t, toolChat('old', 'old patch'), {
    async afterReply(command, args) {
      if (command !== 'pi_command' || args.command.type !== 'get_tool_payload' || ++reads !== 1) return;
      held.resolve();
      await release.promise;
    },
  });
  const tool = () => hook.current.messages.find(message => message.role === 'tool');
  await act(() => hook.current.refresh());
  let oldRead;
  await act(() => { oldRead = tool().loadToolPayload(); });
  await held.promise;
  await client.restoreConnection(await publishChat(toolChat('new', 'new patch')));
  await act(() => hook.current.refresh());
  await act(async () => { release.resolve(); await oldRead; });
  assert.equal(tool().toolPayloadLoaded, false, 'the old payload must not load into the current conversation');
  await act(() => tool().loadToolPayload());
  assert.deepEqual(tool().toolInput, { path: 'new' });
  assert.deepEqual(tool().details, { diff: 'new patch' });
});

test('a failed tool payload read leaves the tool unloaded and a retry loads the saved payload', { timeout: 30000 }, async t => {
  let reads = 0;
  const { hook } = await sessionView(t, [
    { type: 'message', id: 'request', parentId: null, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'edit', arguments: { path: 'a' } }], timestamp: 99 } },
    { type: 'message', id: 'result', parentId: 'request', message: { role: 'toolResult', toolCallId: 'call', toolName: 'edit', content: 'persisted', details: { diff: 'patch' }, isError: false, timestamp: 100 } },
  ], {
    async afterReply(command, args) {
      if (command === 'pi_command' && args.command.type === 'get_tool_payload' && ++reads === 1) throw new Error('connection lost');
    },
  });
  const tool = () => hook.current.messages.find(message => message.role === 'tool');
  await act(() => hook.current.refresh());
  let failed;
  await act(async () => { failed = tool().loadToolPayload(); await assert.rejects(failed, /connection lost/); });
  assert.equal(tool().toolPayloadLoaded, false);
  assert.equal(tool().toolInput, undefined);
  await act(() => tool().loadToolPayload());
  assert.equal(tool().toolPayloadLoaded, true);
  assert.deepEqual(tool().toolInput, { path: 'a' });
  assert.deepEqual(tool().details, { diff: 'patch' });
  assert.equal(tool().content, 'persisted');
});

test('a read-only view does not ask for the chat choices, so it shows no errors for them', { timeout: 30000 }, async t => {
  const asked = [];
  const { hook, client } = await sessionView(t, [
    { type: 'message', id: 'question', parentId: null, message: { role: 'user', content: 'hello', timestamp: 99 } },
  ], { async afterReply(command, args) { if (command === 'pi_command') asked.push(args.command.type); } });
  assert.equal(client.ownsConversation(), false);
  await act(() => hook.current.refresh());
  assert.equal(hook.current.capabilitiesLoading, false);
  assert.deepEqual(hook.current.capabilityErrors, []);
  assert.deepEqual(asked.filter(type => ['get_available_models', 'get_available_thinking_levels', 'get_commands'].includes(type)), []);
});

test('failed refresh replays buffered live events and allows a later retry', async t => {
  const received = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  let fail = true;
  const { hook, send } = await sessionView(t, [], {
    async afterReply(command, args) {
      if (command !== 'pi_command' || args.command.type !== 'get_snapshot' || !fail) return;
      received.resolve();
      await release.promise;
      throw new Error('offline');
    },
  });
  let operation, rejected;
  await act(() => {
    operation = hook.current.refresh();
    rejected = assert.rejects(operation, /offline/);
  });
  await received.promise;
  await send({ type: 'message_start', message: { role: 'user', content: 'live', timestamp: 100 } });
  fail = false;
  await act(async () => { release.resolve(); await rejected; });
  assert.equal(hook.current.messages[0].content, 'live');
  await act(() => hook.current.refresh());
  assert.deepEqual(hook.current.messages, []);
});

test('changing conversations rejects obsolete refreshes and ignores old event handlers', async t => {
  const received = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const { hook, createDraft } = await sessionView(t, [], {
    async afterReply(command, args) {
      if (command !== 'pi_command' || args.command.type !== 'get_snapshot') return;
      received.resolve();
      await release.promise;
    },
  });
  const old = { ...hook.current };
  let operation, rejected;
  await act(() => {
    operation = old.refresh();
    rejected = assert.rejects(operation, /Conversation changed/);
  });
  await received.promise;
  await hook.rerender(await createDraft());
  await act(async () => {
    old.handleEvent({ type: 'message_start', message: { role: 'user', content: 'stale', timestamp: 100 } });
    release.resolve();
    await rejected;
    await assert.rejects(old.refresh(), /Conversation changed/);
  });
  assert.deepEqual(hook.current.messages, []);
});

test('a session switch during refresh fetches a fresh snapshot', async t => {
  const received = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  let snapshots = 0, runtimeId;
  const { hook, send, client, daemon } = await sessionView(t, [], {
    async afterReply(command, args) {
      if (command !== 'pi_command' || args.command.type !== 'get_snapshot') return;
      snapshots++;
      if (snapshots !== 1) return;
      runtimeId = args.runtimeId;
      received.resolve();
      await release.promise;
    },
  });
  const home = await daemon.invoke('home_directory', { hostId: 'local' });
  const next = JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30_000,
    input: JSON.stringify({ home, cwd: home, content: '' }),
  }));
  let operation;
  await act(() => { operation = hook.current.refresh(); });
  await received.promise;
  await client.restoreConnection({ cwd: home, sessionPath: next.path });
  const current = await daemon.invoke('pi_command', { runtimeId, command: { type: 'get_snapshot' } });
  assert.equal(current.state.sessionId, next.id);
  await send({ type: 'session_switched', epoch: current.epoch });
  await act(async () => { release.resolve(); await operation; });
  assert.equal(hook.current.state.sessionId, next.id);
  assert.equal(snapshots, 2);
});

test('refresh coalesces requests and replays only newer events', async t => {
  const received = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  let snapshots = 0;
  const { hook, send } = await sessionView(t, [], {
    async afterReply(command, args, result) {
      if (command !== 'pi_command' || args.command.type !== 'get_snapshot') return;
      snapshots++;
      received.resolve({ sequence: result.sequence, epoch: result.epoch });
      await release.promise;
    },
  });
  let first, second;
  await act(() => { first = hook.current.refresh(); second = hook.current.refresh(); });
  assert.equal(first, second);
  const { sequence, epoch } = await received.promise;
  await send(
    { type: 'thinking_level_changed', level: 'low', sequence, epoch },
    { type: 'thinking_level_changed', level: 'off', sequence: sequence + 1, epoch: 'other-' + epoch },
    { type: 'thinking_level_changed', level: 'high', sequence: sequence + 1, epoch },
    { type: 'runtime_presence', viewers: 2 },
  );
  await act(async () => { release.resolve(); await first; });
  assert.equal(snapshots, 1);
  assert.equal(hook.current.state.thinkingLevel, 'high');
  assert.equal(hook.current.state.viewers, 2);
});

test('a chat refresh failure does not report a choices failure after lists load', async t => {
  const { hook, client } = await sessionView(t);
  await act(() => hook.current.refresh());
  await whenReactive(() => !hook.current.capabilitiesLoading);
  assert.deepEqual(hook.current.capabilityErrors, []);
  const command = client.command.bind(client);
  client.command = (request, schema) => request.type === 'get_session_revision'
    ? Promise.reject(new Error('offline')) : command(request, schema);
  await act(() => hook.current.retryCapabilities());
  await whenReactive(() => hook.current.error);
  assert.match(hook.current.error, /offline/);
  assert.deepEqual(hook.current.capabilityErrors, [], 'successful choices must not show the choices retry button');
});
