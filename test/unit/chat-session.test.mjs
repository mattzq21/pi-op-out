import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderHook, act } from '../dom.mjs';
import { useChatSession } from '../../src/lib/useChatSession.ts';

describe('chat session hook', () => {
  let dom, hook, transport, responses, calls;
  const initialState = { model: null, thinkingLevel: 'off', isStreaming: false, sessionId: 'session', messageCount: 0, pendingMessageCount: 0 };
  const snapshot = (extra = {}) => ({ revision: 'snapshot', state: initialState, history: { entries: [], leafId: null }, sequence: 10, epoch: 'epoch', liveTools: [], queue: { pendingMessages: [] }, ...extra });
  beforeEach(async () => {
    dom = installDom(); calls = [];
    responses = new Map([['get_session_revision', { revision: 'changed' }], ['get_tool_payload', { chunk: JSON.stringify({ content: 'persisted', details: { diff: 'patch' }, toolInput: { path: 'a' } }), length: 0, revision: 'payload' }], ['get_snapshot', snapshot()], ['get_available_models', { models: [{ id: 'model' }] }], ['get_available_thinking_levels', { levels: ['off', 'high'] }], ['get_commands', { commands: [] }], ['get_session_stats', { contextUsage: { tokens: 500, contextWindow: 1000, percent: 50 } }]]);
    transport = { subscribe() { return () => {}; }, async command(command) { calls.push(command.type); const response = responses.get(command.type);

    if (response instanceof Error) throw response;

    return response instanceof Function ? response() : response; } };
    hook = await renderHook(value => useChatSession(value), transport);
  });
  afterEach(async () => { await hook.unmount(); dom.restore(); });
  const send = async (...events) => { await act(async () => { events.forEach(event => hook.current.handleEvent(event)); }); };

  const message = (type, role, content, extra = {}) => ({ type, message: { role, content, timestamp: 100, ...extra } });

  test('streaming batches deltas and finalizes a stable assistant message without duplicates', async () => {
    await send(message('message_start', 'assistant', ''));
    const id = hook.current.messages[0].id;
    await send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' } }, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' world' } });
    assert.equal(hook.current.messages[0].content, ''); assert.equal(dom.frames.size, 1);
    await dom.flushFrames(); assert.equal(hook.current.messages[0].content[0].text, 'hello world');
    await send(message('message_end', 'assistant', 'final'));
    assert.equal(hook.current.messages.length, 1); assert.equal(hook.current.messages[0].id, id);
    assert.equal(hook.current.messages[0].streaming, false); assert.equal(hook.current.messages[0].content, 'final');
    assert.ok(hook.current.messages[0].completedAt > 0);
  });

  test('tool payloads load on demand while snapshot metadata survives final messages', async () => {
    await send({ type: 'tool_execution_start', toolCallId: 'call', toolName: 'edit', args: { path: 'a' } }, { type: 'tool_execution_update', toolCallId: 'call', partialResult: { content: 'partial' } });
    await dom.flushFrames(); assert.equal(hook.current.messages[0].content, ''); assert.equal(hook.current.messages[0].toolInput, undefined);
    await send({ type: 'tool_execution_end', toolCallId: 'call', result: { content: 'done', details: { diff: 'patch' } }, isError: false });
    assert.equal(hook.current.messages[0].toolStatus, 'done');
    await send({ type: 'entry_appended', entry: { type: 'custom', customType: 'piop-file-changes', id: 'snap', data: { cwd: '/repo', patch: 'patch', paths: ['a'], toolCallIds: ['call'] } } });
    await send(message('message_end', 'toolResult', 'persisted', { toolCallId: 'call' }));
    assert.equal(hook.current.messages.length, 1);
    await act(() => hook.current.messages[0].loadToolPayload());
    assert.deepEqual(hook.current.messages[0].toolInput, { path: 'a' });
    assert.deepEqual(hook.current.messages[0].details, { diff: 'patch' });
    assert.equal(hook.current.messages[0].fileChanges[0].id, 'snap');
    await send({ type: 'tool_execution_start', toolCallId: 'call', toolName: 'read' }, { type: 'tool_execution_end', toolCallId: 'call', isError: true });
    assert.equal(hook.current.messages.length, 1); assert.equal(hook.current.messages[0].toolStatus, 'error');
    assert.equal(hook.current.messages[0].content, ''); assert.equal(hook.current.messages[0].toolInput, undefined);
  });

  test('pause checkpoints the latest user, hides synthetic resume input and retains prompt context', async () => {
    await send(message('message_start', 'user', 'question'));
    const context = { userTimestamp: 100, tokens: 42 };
    const status = { type: 'extension_ui_request', method: 'setStatus', statusKey: 'pi-desktop-prompt-context' };
    await send({ ...status, statusText: `json:${JSON.stringify(context)}` }, { ...status, statusText: 'json:{' }, { ...status, statusText: 'json:{}' }, { ...status, statusText: `json:${JSON.stringify({ ...context, tokens: 999 })}` });
    await send(message('message_end', 'user', 'question'));
    assert.deepEqual(hook.current.messages[0].promptContext, context);
    await send({ type: 'agent_start' }, { type: 'pause_state', isPaused: true, isPausing: true });
    assert.equal(hook.current.state.isStreaming, true);
    await send({ type: 'pause_state', isPaused: true, isPausing: false });
    assert.equal(hook.current.state.isStreaming, false); assert.equal(hook.current.messages[0].contextCheckpoint, true);
    await send({ type: 'entry_appended', entry: { type: 'custom', customType: 'pi-desktop-resume', data: { message: 'resume' } } }, message('message_start', 'user', 'resume'), message('message_start', 'custom', 'hidden', { display: false }), message('message_start', 'custom', 'side response', { customType: 'pi-desktop-btw' }));
    assert.equal(hook.current.messages.length, 1);
  });

  test('activity, queue counts, context usage and connection state follow runtime events', async () => {
    await act(async () => hook.current.refresh());
    await send({ type: 'runtime_presence', viewers: '3', isStreaming: true }, { type: 'queue_update', steering: ['a'], followUp: ['b'], pendingMessages: [{ id: 'pending' }] });
    assert.equal(hook.current.state.viewers, 3); assert.equal(hook.current.state.pendingMessageCount, 2);
    assert.deepEqual(hook.current.state.pendingMessages, [{ id: 'pending' }]);
    await send({ type: 'compaction_start' }); assert.equal(hook.current.state.activity, 'Compacting context…');
    responses.set('get_session_stats', { contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 } });
    await send({ type: 'compaction_end', result: { estimatedTokensAfter: 100 } });
    assert.equal(hook.current.state.contextUsage.percent, 10); assert.equal(hook.current.state.activity, undefined);
    await send({ type: 'auto_retry_start', attempt: 2 }); assert.equal(hook.current.state.activity, 'Retrying · attempt 2');
    await send({ type: 'thinking_level_changed', level: 'high' }, { type: 'thinking_level_changed', level: 42 });
    assert.equal(hook.current.state.thinkingLevel, 'high');
    await send({ type: 'disconnected' }); assert.equal(hook.current.state.isStreaming, false); assert.equal(hook.current.state.activity, undefined);
    await send({ type: 'agent_start' }, { type: 'agent_settled' }, { type: 'queue_update' });
    assert.equal(hook.current.state.isStreaming, false); assert.equal(hook.current.state.pendingMessageCount, 0);
  });

  test('refresh coalesces requests, filters internal commands and replays only newer events', async () => {
    const pending = Promise.withResolvers(); responses.set('get_snapshot', () => pending.promise);
    responses.set('get_commands', { commands: [{ name: 'visible' }, { name: 'inline', sourceInfo: { source: 'inline' } }, { name: 'pi-orchestration-tool' }, { name: 'pi-desktop-control' }, { name: 'pi-desktop-fast-status' }, { name: 'pi-desktop-fork-and-forget' }] });
    let first, second;
    await act(async () => { first = hook.current.refresh(); second = hook.current.refresh(); });
    assert.equal(first, second);
    await send({ type: 'thinking_level_changed', level: 'old', sequence: 9, epoch: 'epoch' }, { type: 'thinking_level_changed', level: 'wrong', sequence: 11, epoch: 'other' }, { type: 'thinking_level_changed', level: 'high', sequence: 11, epoch: 'epoch' }, { type: 'runtime_presence', viewers: 2 });
    await act(async () => { pending.resolve(snapshot()); await first; });
    assert.equal(calls.filter(type => type === 'get_snapshot').length, 1);
    assert.equal(hook.current.state.thinkingLevel, 'high'); assert.equal(hook.current.state.viewers, 2);
    assert.deepEqual(hook.current.models, [{ id: 'model' }]); assert.deepEqual(hook.current.thinkingLevels, ['off', 'high']);
    assert.deepEqual(hook.current.commands.map(command => command.name), ['compact', 'visible']);
  });

  test('refresh tolerates unavailable optional capabilities and preserves advertised compact command', async () => {
    for (const type of ['get_available_models', 'get_available_thinking_levels', 'get_session_stats']) responses.set(type, new Error('unsupported'));
    responses.set('get_commands', { commands: [{ name: 'compact', description: 'native' }] });
    await act(async () => hook.current.refresh());
    assert.deepEqual(hook.current.models, []); assert.deepEqual(hook.current.thinkingLevels, ['off']);
    assert.deepEqual(hook.current.commands, [{ name: 'compact', description: 'native' }]);
    responses.set('get_commands', new Error('unsupported'));
    await act(async () => hook.current.refresh());
    assert.equal(hook.current.commands[0].description, 'native');
  });

  test('failed refresh replays buffered live events and allows a later retry', async () => {
    const pending = Promise.withResolvers(); responses.set('get_snapshot', () => pending.promise);
    let operation; await act(async () => { operation = hook.current.refresh(); });
    await send(message('message_start', 'user', 'live'));
    await act(async () => { pending.reject(new Error('offline')); await assert.rejects(operation, /offline/); });
    assert.equal(hook.current.messages[0].content, 'live');
    responses.set('get_snapshot', snapshot()); await act(async () => hook.current.refresh());
    assert.deepEqual(hook.current.messages, []);
  });

  test('changing conversations rejects obsolete refreshes and ignores old event handlers', async () => {
    const pending = Promise.withResolvers(); responses.set('get_snapshot', () => pending.promise);
    const old = { ...hook.current }; let operation; await act(async () => { operation = old.refresh(); });
    const rejected = assert.rejects(operation, /Conversation changed/);
    await hook.rerender({ command: transport.command, subscribe: transport.subscribe });
    await act(async () => { old.handleEvent(message('message_start', 'user', 'stale')); pending.resolve(snapshot()); await rejected; await assert.rejects(old.refresh(), /Conversation changed/); });
    assert.deepEqual(hook.current.messages, []);
  });

  test('a session switch during refresh fetches a fresh snapshot', async () => {
    const pending = Promise.withResolvers(); responses.set('get_snapshot', () => pending.promise);
    let operation; await act(async () => { operation = hook.current.refresh(); });
    await send({ type: 'session_switched', epoch: 'new' });
    responses.set('get_snapshot', snapshot({ epoch: 'new', state: { ...initialState, sessionId: 'new' } }));
    await act(async () => { pending.resolve(snapshot()); await operation; });
    assert.equal(hook.current.state.sessionId, 'new'); assert.equal(calls.filter(type => type === 'get_snapshot').length, 2);
  });

  test('snapshot restoration retains live tools, streaming identity and resume markers', async () => {
    const entries = [{ type: 'custom', id: 'marker', parentId: null, customType: 'pi-desktop-resume', data: { message: 'resume' } }, { type: 'message', id: 'assistant', parentId: 'marker', message: { role: 'assistant', content: 'partial', streaming: true, timestamp: 100 } }];
    responses.set('get_snapshot', snapshot({ history: { entries, leafId: 'assistant' }, liveTools: [{ type: 'tool_execution_start', toolCallId: 'call', toolName: 'read', partialResult: { content: 'live output' } }] }));
    await act(async () => hook.current.refresh()); await dom.flushFrames();
    assert.equal(hook.current.messages[1].content, ''); assert.equal(hook.current.messages[1].deferredToolPayload, 'call');
    await send(message('message_start', 'user', 'resume'), message('message_end', 'assistant', 'done'));
    assert.equal(hook.current.messages.length, 2); assert.equal(hook.current.messages[0].id, 'assistant'); assert.equal(hook.current.messages[0].content, 'done');
  });

  test('full-message updates allocate one identity and pending work can be discarded', async () => {
    await send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'orphan' } }); await dom.flushFrames();
    assert.deepEqual(hook.current.messages, []);
    await send(message('message_update', 'assistant', 'first')); await dom.flushFrames(); const id = hook.current.messages[0].id;
    await send(message('message_update', 'assistant', 'second')); await dom.flushFrames();
    assert.equal(hook.current.messages.length, 1); assert.equal(hook.current.messages[0].id, id); assert.equal(hook.current.messages[0].content, 'second');
    await send(message('message_update', 'assistant', 'discarded'));
    await act(async () => hook.current.discardPendingUpdates()); await dom.flushFrames();
    assert.equal(hook.current.messages[0].content, 'second');
  });

  test('replayed live tool output loads once until a newer update arrives', async () => {
    responses.set('get_snapshot', snapshot({ liveTools: [{ type: 'tool_execution_start', toolCallId: 'call', toolName: 'read', partialResult: { content: 'live output' } }] }));
    await act(() => hook.current.refresh()); await dom.flushFrames();
    await act(() => hook.current.messages[0].loadToolPayload());
    await act(() => hook.current.messages[0].loadToolPayload());
    assert.equal(calls.filter(type => type === 'get_tool_payload').length, 1);
    await send({ type: 'tool_execution_update', toolCallId: 'call', sequence: 11 }); await dom.flushFrames();
    await act(() => hook.current.messages[0].loadToolPayload());
    assert.equal(calls.filter(type => type === 'get_tool_payload').length, 2);
  });
});
