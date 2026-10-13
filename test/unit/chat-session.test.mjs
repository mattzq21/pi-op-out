import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { installDom, renderHook, act } from '../dom.mjs';
import { useChatSession } from '../../clients/ui/lib/useChatSession.ts';
import { promptContext } from '../prompt-context-fixture.mjs';

describe('chat session hook', () => {
  let dom, hook, transport, responses, calls;
  const initialState = { model: null, thinkingLevel: 'off', isStreaming: false, sessionId: 'session', messageCount: 0, pendingMessageCount: 0 };
  const snapshot = (extra = {}) => ({ revision: 'snapshot', state: initialState, history: { entries: [], leafId: null }, sequence: 10, epoch: 'epoch', liveTools: [], queue: { type: 'queue_state', pendingMessages: [] }, ...extra });
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









  test('refresh loads model capabilities and filters internal commands', async () => {
    responses.set('get_commands', { commands: [{ name: 'visible', source: 'extension' }, { name: 'inline', source: 'extension', sourceInfo: { source: 'inline' } }] });
    await act(() => hook.current.refresh());
    assert.deepEqual(hook.current.models, [{ id: 'model' }]);
    assert.deepEqual(hook.current.thinkingLevels, ['off', 'high']);
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







  test('snapshot restoration retains live tools, streaming identity and resume markers', async () => {
    const entries = [{ type: 'custom', id: 'marker', parentId: null, customType: 'pi-desktop-resume', data: { message: 'resume' } }, { type: 'message', id: 'assistant', parentId: 'marker', message: { role: 'assistant', content: 'partial', streaming: true, timestamp: 100 } }];
    responses.set('get_snapshot', snapshot({ history: { entries, leafId: 'assistant' }, liveTools: [{ type: 'tool_execution_start', toolCallId: 'call', toolName: 'read', partialResult: { content: 'live output' } }] }));
    await act(async () => hook.current.refresh()); await dom.flushFrames();
    assert.equal(hook.current.messages[1].content, ''); assert.equal(hook.current.messages[1].deferredToolPayload, 'call');
    await send(message('message_start', 'user', 'resume'), message('message_end', 'assistant', 'done'));
    assert.equal(hook.current.messages.length, 2); assert.equal(hook.current.messages[0].id, 'assistant'); assert.equal(hook.current.messages[0].content, 'done');
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
