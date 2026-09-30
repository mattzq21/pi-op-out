import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';

class FakeClient {
  constructor(info) { this.info = info; this.calls = []; this.closed = 0; globalThis.__MCP_TEST_CLIENTS__.push(this); }
  async connect(transport, options) { this.transport = transport; this.connectOptions = options; }
  async listTools(params, options) { this.calls.push(['list', params, options]); return globalThis.__MCP_TEST_PAGES__[params?.cursor ?? 'first']; }
  async callTool(params, options) { this.calls.push(['call', params, options]); return globalThis.__MCP_TEST_RESULT__; }
  async close() { this.closed++; this.onclose?.(); }
}
class FakeStdio { constructor(options) { this.options = options; this.stderr = new EventEmitter(); } }
class FakeHTTP { constructor(url, options) { this.url = url; this.options = options; } }
globalThis.__MCP_TEST_SDK__ = { Client: FakeClient, Stdio: FakeStdio, HTTP: FakeHTTP };
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/resources/mcp-bridge.ts')) {
      if (specifier === '@modelcontextprotocol/client') return { url: 'data:text/javascript,export const Client = globalThis.__MCP_TEST_SDK__.Client; export const StreamableHTTPClientTransport = globalThis.__MCP_TEST_SDK__.HTTP;', shortCircuit: true };
      if (specifier === '@modelcontextprotocol/client/stdio') return { url: 'data:text/javascript,export const StdioClientTransport = globalThis.__MCP_TEST_SDK__.Stdio;', shortCircuit: true };
      if (specifier === '@earendil-works/pi-ai') return { url: 'data:text/javascript,export const Type = { Unsafe: value => value };', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    return url.endsWith('/resources/mcp-bridge.ts') ? { ...result, source: String(result.source).replaceAll('process.env', 'globalThis.__MCP_TEST_ENV__') } : result;
  },
});
const { default: mcpBridge } = await import('../../src-tauri/resources/mcp-bridge.ts'); hooks.deregister(); delete globalThis.__MCP_TEST_SDK__;

async function fixture(servers, run, env = {}) {
  globalThis.__MCP_TEST_ENV__ = { ...env };
  globalThis.__MCP_TEST_CLIENTS__ = [];
  globalThis.__MCP_TEST_PAGES__ = { first: { tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] } };
  globalThis.__MCP_TEST_RESULT__ = { content: [{ type: 'text', text: 'result' }] };
  const bus = new EventEmitter(), tools = new Map(), handlers = new Map(), commands = new Map(), statuses = [], notices = [], messages = [];
  let active = ['builtin'];
  const pi = { events: { emit: (...args) => bus.emit(...args), on(name, handler) { bus.on(name, handler); return () => bus.off(name, handler); } },
    getAllTools: () => [...tools.values()], registerTool(tool) { tools.set(tool.name, tool); }, getActiveTools: () => active, setActiveTools(value) { active = value; },
    on(name, handler) { handlers.set(name, handler); }, registerCommand(name, command) { commands.set(name, command); }, sendMessage(message, options) { messages.push({ message, options }); } };
  const ctx = { sessionManager: { getSessionId: () => 'session' }, ui: { setStatus(key, value) { statuses.push({ key, value }); }, notify(...args) { notices.push(args); } } };
  const select = (serverIds, agentName = 'agent', sessionId = 'session') => { const request = { servers: serverIds.map(id => servers.find(server => server.id === id)), agentName, sessionId }; bus.emit('piop:mcp:select', request); return request.ready; };
  try {
    await mcpBridge(pi); handlers.get('session_start')?.({}, ctx);
    await run({ tools, handlers, commands, statuses, notices, messages, ctx, select, clients: globalThis.__MCP_TEST_CLIENTS__,
      setActive(value) { active = value; }, getActive: () => active, setSettings(value) { servers = value.mcpServers; },
      update() { return select(servers.filter(server => server.enabled).map(server => server.id)); } });
  } finally {
    await handlers.get('session_shutdown')?.();
    for (const key of ['__MCP_TEST_ENV__', '__MCP_TEST_CLIENTS__', '__MCP_TEST_PAGES__', '__MCP_TEST_RESULT__']) delete globalThis[key];
  }
}
const stdio = { id: 'Server One', name: 'Server', enabled: true, command: '/tool executable', args: `one "two words" '' 'literal\\slash' escaped\\ space tail\\`, startupTimeoutSec: 23 };

test('MCP disconnect reports bounded recent diagnostics and ignores close events from replaced clients', async () => fixture([stdio], async f => {
  const output = [];
  const stderr = mock.method(process.stderr, 'write', chunk => { output.push(String(chunk)); return true; });
  try {
    await f.select([stdio.id]); const first = f.clients[0];
    first.transport.stderr.emit('data', Buffer.from(`old-prefix${'x'.repeat(9000)}recent-tail\n`));
    first.onerror(new Error('protocol failed'));
    first.onclose();
    const statuses = JSON.parse(f.statuses.findLast(status => status.key === 'pi-desktop-mcp-status').value.slice(5));
    assert.equal(statuses[0].status, 'error'); assert.match(statuses[0].error, /recent-tail\nprotocol failed/);
    assert.doesNotMatch(statuses[0].error, /old-prefix/); assert.ok(statuses[0].error.length < 8400);
    assert.match(output.at(-1), /\[mcp:Server\] protocol failed/);
    await f.select([stdio.id]); const count = f.statuses.length;
    first.onclose(); assert.equal(f.statuses.length, count);
  } finally { stderr.mock.restore(); }
}));

test('MCP shutdown during discovery prevents late tool registration and closes the pending client', async () => fixture([stdio], async f => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const discovery = mock.method(FakeClient.prototype, 'listTools', async function () {
    started(); return new Promise(resolve => { release = resolve; });
  });
  const stderr = mock.method(process.stderr, 'write', () => true);
  try {
    const selection = f.select([stdio.id]);
    const rejected = assert.rejects(selection, /MCP bridge has shut down/);
    await entered;
    const shutdown = f.handlers.get('session_shutdown')();
    assert.equal(f.clients[0].connectOptions.signal.aborted, true);
    release({ tools: [{ name: 'late-tool' }] });
    await rejected; await shutdown;
    assert.equal(f.tools.size, 0); assert.ok(f.clients[0].closed >= 1);
    assert.deepEqual(f.statuses.slice(-2), [{ key: 'pi-desktop-mcp-status', value: undefined }, { key: 'pi-desktop-mcp-loading', value: undefined }]);
    assert.equal(f.select([stdio.id]), undefined, 'shutdown must unsubscribe selection requests');
  } finally { discovery.mock.restore(); stderr.mock.restore(); }
}));


test('MCP commands report selected tools and exclude status messages from model context', async () => fixture([stdio], async f => {
  assert.equal(f.handlers.has('input'), false);
  await f.commands.get('mcp-status').handler(); assert.equal(f.messages.at(-1).message.content, 'No MCP servers loaded');
  await f.select([stdio.id]);
  await f.commands.get('mcp-status').handler(); assert.match(f.messages.at(-1).message.content, /Server One: mcp_server_one_lookup/);
  assert.deepEqual(f.messages.at(-1).options, { triggerTurn: false });
  const ordinary = { role: 'user', content: 'hello' }, custom = { role: 'custom', customType: 'other' };
  assert.deepEqual(f.handlers.get('context')({ messages: [ordinary, { role: 'custom', customType: 'pi-desktop-mcp-status' }, custom] }).messages, [ordinary, custom]);
}));

test('same-id MCP definition changes close the old lease and invalidate its tools', async () => {
  const definition = { ...stdio };
  await fixture([definition], async f => {
    const names = await f.select([definition.id]); const oldClient = f.clients[0], oldTool = f.tools.get(names[0]);
    definition.command = 'replacement-server';
    assert.deepEqual(await f.select([definition.id]), names);
    assert.equal(oldClient.closed, 1); assert.equal(f.clients.length, 2);
    assert.equal(f.clients[1].transport.options.command, 'replacement-server');
    await assert.rejects(oldTool.execute('call', {}), /not available for this agent/);
    await f.select([definition.id]); assert.equal(f.clients.length, 2);
  });
});

test('MCP updates retain unchanged connections and remove only tools owned by changed servers', async () => fixture([stdio], async f => {
  const names = await f.select([stdio.id]); const client = f.clients[0]; f.setActive(['builtin', ...names]);
  f.setSettings({ mcpServers: [{ ...stdio }] }); await f.update(); assert.equal(client.closed, 0);
  const replacement = { ...stdio, id: 'replacement' };
  f.setSettings({ mcpServers: [replacement] }); await f.update(); assert.equal(client.closed, 1); assert.deepEqual(f.getActive(), ['builtin']);
  const statuses = JSON.parse(f.statuses.findLast(status => status.key === 'pi-desktop-mcp-status').value.slice(5));
  assert.deepEqual(statuses, [{ id: 'replacement', status: 'connected' }]);
  assert.equal((await f.select(['replacement'])).length, 1);
  globalThis.__MCP_TEST_PAGES__ = { first: { tools: [] } };
  await f.select(['replacement'], 'other'); await f.commands.get('mcp-status').handler();
  assert.equal(f.messages.at(-1).message.content, 'replacement: no tools');
}));

test('MCP tool names remain unique and stable across normalization collisions and reconnects', async () => fixture([stdio], async f => {
  f.tools.set('mcp_server_one_lookup', { name: 'mcp_server_one_lookup' });
  globalThis.__MCP_TEST_PAGES__ = { first: { tools: [{ name: 'lookup' }, { name: 'look-up' }, { name: 'look up' }, { name: '!'.repeat(80) }, { name: 'x'.repeat(100) }] } };
  const names = await f.select([stdio.id]);
  assert.equal(new Set(names).size, 5); assert.ok(names.every(name => name.length <= 64));
  assert.equal(names.includes('mcp_server_one_lookup'), false);
  assert.equal(f.tools.size, 6);
  assert.deepEqual(await f.select([stdio.id], 'new-agent'), names);
  assert.equal(f.tools.size, 6);
}));

test('MCP bridge discovers paginated tools and forwards calls with an opted-in private agent identity', async () => fixture([{ ...stdio, injectAgentId: true }], async f => {
  globalThis.__MCP_TEST_PAGES__ = {
    first: { tools: [{ name: 'Look up', inputSchema: { type: 'object', properties: { agent_id: { type: 'string' }, query: { type: 'string' } }, required: ['agent_id', 'query'] } }], nextCursor: 'next' },
    next: { tools: [{ name: 'other' }] },
  };
  const names = await f.select([stdio.id]); assert.equal(names.length, 2);
  const client = f.clients[0];
  assert.deepEqual(client.transport.options.args, ['one', 'two words', '', 'literal\\slash', 'escaped space', 'tail\\']);
  assert.equal(client.transport.options.command, '/tool executable'); assert.equal(client.transport.options.maxBufferSize, 4 * 1024 * 1024);
  assert.equal(client.connectOptions.timeout, 23000); assert.equal(client.calls[1][1].cursor, 'next');
  const tool = f.tools.get(names[0]); assert.deepEqual(tool.parameters.required, ['query']); assert.equal('agent_id' in tool.parameters.properties, false);
  globalThis.__MCP_TEST_RESULT__ = { content: [{ type: 'text', text: 'hello' }, { type: 'image', data: 'bytes', mimeType: 'image/png' }, { type: 'resource', uri: 'example' }] };
  const result = await tool.execute('call', { query: 'q', agent_id: 'spoofed' });
  assert.equal(result.content[0].text, 'hello'); assert.deepEqual(result.content[1], { type: 'image', data: 'bytes', mimeType: 'image/png' });
  assert.deepEqual(JSON.parse(result.content[2].text), { type: 'resource', uri: 'example' });
  assert.equal(client.calls.at(-1)[1].arguments.agent_id, client.transport.options.env.PIOP_CUA_INSTANCE_ID);
  assert.notEqual(client.calls.at(-1)[1].arguments.agent_id, 'spoofed'); assert.equal(client.calls.at(-1)[2].timeout, 120000);
  assert.deepEqual(await f.select([stdio.id]), names); assert.equal(f.clients.length, 1);
  f.setActive(['builtin', ...names]); await f.select([], 'agent'); assert.deepEqual(f.getActive(), ['builtin']);
  await assert.rejects(tool.execute('call', {}), /not available for this agent/); assert.equal(client.closed, 1);
}));

test('MCP bridge configures HTTP headers and reconnects on agent changes without aliasing tools', async () => fixture([
  { id: 'http', name: 'HTTP', enabled: true, transport: 'http', url: 'https://example.invalid/mcp', headers: '{"X-Test":"value"}' },
], async f => {
  const names = await f.select(['http']); const oldTool = f.tools.get(names[0]); const oldClient = f.clients[0];
  assert.equal(oldClient.transport.url.href, 'https://example.invalid/mcp'); assert.deepEqual(oldClient.transport.options.requestInit.headers, { 'X-Test': 'value' });
  assert.deepEqual(await f.select(['http'], 'different-agent'), names); assert.equal(oldClient.closed, 1);
  await assert.rejects(oldTool.execute('call', {}), /not available for this agent/);
  const tool = f.tools.get(names[0]); const signal = AbortSignal.abort(); await assert.rejects(tool.execute('call', {}, signal), /aborted/);
  globalThis.__MCP_TEST_RESULT__ = { isError: true, content: [{ type: 'text', text: 'remote failure' }] };
  await assert.rejects(tool.execute('call', {}), /remote failure/);
  globalThis.__MCP_TEST_RESULT__ = { structuredContent: { value: 3 } };
  assert.deepEqual(JSON.parse((await tool.execute('call', {})).content[0].text), globalThis.__MCP_TEST_RESULT__.structuredContent);
  f.clients.at(-1).onclose(); await assert.rejects(tool.execute('call', {}), /not available for this agent/);
  await f.select(['http'], 'different-agent'); assert.equal(f.clients.length, 3);
}));

test('MCP bridge rejects invalid transports and skips disabled agent servers while allowing later recovery', async () => {
  for (const config of [
    { command: '' }, { args: "'unterminated" }, { startupTimeoutSec: 0 }, { startupTimeoutSec: 601 },
    { transport: 'http', url: '' }, { transport: 'http', url: 'file:///tmp/file' },
    { transport: 'http', url: 'https://example.invalid', headers: '[]' }, { transport: 'http', url: 'https://example.invalid', headers: { invalid: 3 } },
  ]) await fixture([{ ...stdio, ...config }], async f => {
    await assert.rejects(f.select([stdio.id])); assert.ok(f.clients[0].closed >= 1, 'failed connections must be closed');
    f.setSettings({ mcpServers: [stdio] }); await f.update(); assert.equal((await f.select([stdio.id])).length, 1);
  });
  await fixture([{ ...stdio, enabled: false }], async f => {
    assert.deepEqual(await f.select([stdio.id]), []);
    assert.equal(f.clients.length, 0);
    f.setSettings({ mcpServers: [stdio] });
    assert.equal((await f.update()).length, 1);
  }, { PI_DESKTOP_MCP_ALLOWED_SERVER_IDS: 'other' });
});
