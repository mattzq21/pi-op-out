import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installConnectionEvents } from '../../daemon/resources/mcp-connections.cjs';

class Connection { constructor(name) { this.name = name; this.state = 'connected'; } changed() {} }
installConnectionEvents(Connection);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@earendil-works/pi-coding-agent' && context.parentURL?.endsWith('/resources/mcp-bridge.ts')) {
      return { url: 'data:text/javascript,export const CONFIG_DIR_NAME = ".pi"; export const getAgentDir = () => "/nonexistent"; export const createMcpExtension = () => pi => globalThis.__PIOP_MCP_SDK__(pi);', shortCircuit: true };
    }

    return nextResolve(specifier, context);
  },
});

const { default: mcpBridge } = await import('../../daemon/resources/mcp-bridge.ts');

hooks.deregister();

async function fixture(run) {
  const bus = new EventEmitter(), tools = new Map(), handlers = new Map(), servers = new Map(), registrations = [], removed = [], starts = [], executions = [];
  let active = ['read', 'codemode'], startFailure, registrationFailure, adapter, change;
  globalThis.__PIOP_MCP_SDK__ = pi => {
    adapter = pi; pi.registerCommand('mcp', {});
    pi.on('session_start', async (event, ctx) => { starts.push({ event, ctx });

      if (startFailure) throw startFailure;
    });
    pi.registerTool({ name: 'codemode', parameters: {} });
    pi.on('mcp_servers_change', async () => { await change?.(); });
  };

  const pi = {
    events: { on(name, handler) { bus.on(name, handler);

      return () => bus.off(name, handler);
    } },
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list);

      return () => handlers.set(name, list.filter(value => value !== handler));
    },
    registerCommand() { throw new Error('SDK slash commands must stay private'); },
    registerTool(tool) { tools.set(tool.name, tool); },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); },
    getAllTools: () => [...tools.values()], getActiveTools: () => active, setActiveTools(value) { active = value; },
    registerMcpServer(name, config) {
      if (registrationFailure) throw registrationFailure;
      registrations.push({ name, config }); servers.set(name, config);
      new Connection(name).changed();
      void dispatch('mcp_servers_change');
    },
    unregisterMcpServer(name) { removed.push(name); servers.delete(name); },
    getMcpServers: () => [...servers].map(([name, config]) => ({ name, config, extensionPath: 'bridge' })),
  };

  const entries = [];
  const ctx = { cwd: process.cwd(), isProjectTrusted: () => false, sessionManager: { getSessionId: () => 'session', getBranch: () => entries }, ui: { setStatus() {}, notify() {} }, abort() {} };
  const dispatch = async (name, event = {}) => { let result; for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx) ?? result; return result; };

  const select = async (definitions, sessionId = 'session', codemode) => {
    const request = { servers: definitions, sessionId, codemode }; bus.emit('piop:mcp:select', request);

    return request.registered;
  };

  const addTool = (name, properties = { query: { type: 'string' }, agent_id: { type: 'string' } }) => {
    const tool = { name, namespace: { name: 'mcp__search' }, parameters: { type: 'object', properties, required: Object.keys(properties) }, execute: async (...args) => { executions.push(args);

      return { content: [{ type: 'text', text: 'result' }] };
    } };

    adapter.registerTool(tool);

    return tool;
  };

  try {
    mcpBridge(pi); await dispatch('session_start', { type: 'session_start', reason: 'startup' });
    await run({ bus, ctx, adapter, tools, servers, registrations, removed, starts, executions, dispatch, select, addTool,
      setStartFailure(value) { startFailure = value; }, setRegistrationFailure(value) { registrationFailure = value; },
      onChange(value) { change = value; },
      setActive(value) { active = value; }, getActive: () => active,
      available() { const request = {}; bus.emit('piop:mcp:tools', request);

        return request;
      },
    });
  } finally { await dispatch('session_shutdown'); delete globalThis.__PIOP_MCP_SDK__; }
}

test('reading a skill through the bridge waits for SDK tools and retains them across agent selection', async () => fixture(async f => {
  const dir = mkdtempSync(join(tmpdir(), 'piop-skill-bridge-'));
  try {
    const path = join(dir, 'SKILL.md'); writeFileSync(path, 'Use this skill.');
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { app: { command: 'server', exposure: 'direct' } } }));
    let release; const gate = new Promise(resolve => { release = resolve; });
    f.onChange(() => gate); let completed = false;
    const pending = f.dispatch('tool_result', { toolName: 'read', input: { path }, content: [], isError: false }).then(result => { completed = true; return result; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(completed, false);
    assert.equal(f.starts.length, 1); assert.equal(f.servers.size, 1);
    release(); assert.match((await pending).content[0].text, /Skill MCP tools/);
    const name = f.registrations[0].name;
    await f.select({ configured: { command: 'other' } }, 'session', 'off');
    assert.equal(f.servers.get(name).exposure, 'direct');
    await f.dispatch('session_shutdown'); assert.equal(f.servers.has(name), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));

test('MCP connections start once on input and restart for a switched session', async () => fixture(async f => {
  assert.equal(f.starts.length, 0); await f.select({ search: { command: 'server', args: ['two words'] } }); assert.equal(f.starts.length, 0);
  await f.dispatch('input'); await f.dispatch('before_agent_start'); assert.equal(f.starts.length, 1); assert.equal(f.starts[0].ctx, f.ctx);
  await f.dispatch('session_start', { type: 'session_start', reason: 'switch' }); await f.dispatch('before_agent_start');
  assert.equal(f.starts.length, 2); assert.equal(f.starts[1].event.reason, 'switch');
}));

test('a failed MCP startup remains retryable on the next input', async () => fixture(async f => {
  f.setStartFailure(new Error('offline')); await assert.rejects(f.dispatch('input'), /offline/);
  f.setStartFailure(); await f.dispatch('input'); await f.dispatch('input'); assert.equal(f.starts.length, 2);
}));

test('MCP registrations preserve native stdio and HTTP configuration without mutating callers', async () => fixture(async f => {
  const definitions = { search: { command: '/server', args: ['two words'], env: { CUSTOM: 'value' }, timeout: 23000, piopInjectAgentId: true }, remote: { url: 'https://example.invalid/mcp', headers: { 'X-Test': 'value' } } };
  const original = structuredClone(definitions); await f.select(definitions);
  assert.deepEqual(definitions, original); assert.deepEqual(f.servers.get('remote'), { ...definitions.remote, exposure: 'codemode' });
  assert.deepEqual(f.servers.get('search').args, ['two words']); assert.equal(f.servers.get('search').timeout, 23000); assert.equal(f.servers.get('search').env.CUSTOM, 'value');
  const identity = f.servers.get('search').env.PIOP_AGENT_ID;
  assert.equal(typeof identity, 'string');
  assert.notEqual(identity.trim(), '');
  assert.equal('piopInjectAgentId' in f.servers.get('search'), false);
}));

test('the agent codemode switch sets how MCP tools are reached and replaces per-server exposure', async () => fixture(async f => {
  await f.select({ search: { command: 'server', exposure: 'hidden', toolExposure: { find: 'direct' } } });
  assert.equal(f.servers.get('search').exposure, 'codemode'); assert.equal('toolExposure' in f.servers.get('search'), false);
  await f.select({ search: { command: 'server' } }, 'session', 'off');
  assert.equal(f.servers.get('search').exposure, 'direct');
}));

test('unchanged MCP definitions retain registrations and replacements remove only affected servers', async () => fixture(async f => {
  const definitions = { search: { command: 'server' }, other: { command: 'other' } };
  await f.select(definitions); await f.select(structuredClone(definitions)); assert.equal(f.registrations.length, 2); assert.deepEqual(f.removed, []);
  await f.select({ search: { command: 'replacement' } }); assert.deepEqual(f.removed.toSorted(), ['other', 'search']); assert.equal(f.registrations.length, 3);
  assert.equal(f.servers.get('search').command, 'replacement'); assert.equal(f.servers.has('other'), false);
}));

test('MCP identities use the session ID directly across servers', async () => fixture(async f => {
  const definitions = { search: { command: 'server' }, other: { command: 'server' } };
  await f.select(definitions);
  assert.equal(f.servers.get('search').env.PIOP_AGENT_ID, 'session');
  assert.equal(f.servers.get('other').env.PIOP_AGENT_ID, 'session');
  await f.select(definitions); assert.equal(f.registrations.length, 2);
  await f.select(definitions, 'other-session');
  assert.equal(f.servers.get('search').env.PIOP_AGENT_ID, 'other-session');
  assert.equal(f.servers.get('other').env.PIOP_AGENT_ID, 'other-session');
}));

test('opted-in MCP tools hide private identity fields and override spoofed call arguments', async () => fixture(async f => {
  await f.select({ search: { command: 'server', piopInjectAgentId: true } });
  const original = f.addTool('mcp__search__lookup'), tool = f.tools.get(original.name);
  assert.deepEqual(tool.parameters.required, ['query']); assert.equal('agent_id' in tool.parameters.properties, false); assert.deepEqual(original.parameters.required, ['query', 'agent_id']);
  const signal = new AbortController().signal, update = () => {};

  await tool.execute('call', { query: 'q', agent_id: 'spoofed' }, signal, update, f.ctx);
  assert.deepEqual(f.executions[0], ['call', { query: 'q', agent_id: 'session' }, signal, update, f.ctx]);
}));

test('ordinary MCP tools retain their schemas and supplied arguments', async () => fixture(async f => {
  await f.select({ search: { command: 'server' } });
  f.addTool('mcp__search__lookup');
  const tool = f.tools.get('mcp__search__lookup');
  assert.deepEqual(tool.parameters, { type: 'object', properties: { query: { type: 'string' }, agent_id: { type: 'string' } }, required: ['query', 'agent_id'] });
  assert.deepEqual(await tool.execute('call', { query: 'q', agent_id: 'public' }), { content: [{ type: 'text', text: 'result' }] });
  assert.deepEqual(f.executions[0][1], { query: 'q', agent_id: 'public' });
}));

test('MCP tool listings respect exposure, active selection and codemode settings', async () => fixture(async f => {
  f.addTool('mcp__search__lookup'); f.tools.set('hidden', { name: 'hidden', exposure: 'hidden', sourceInfo: { path: 'builtin:mcp' } });
  f.tools.set('tool-search', { name: 'tool-search', sourceInfo: { path: 'builtin:tool-search' } }); f.tools.set('read', { name: 'read' });
  f.setActive(['read', 'mcp__search__lookup', 'tool-search', 'codemode']);
  assert.deepEqual(f.available(), { tools: ['codemode', 'mcp__search__lookup', 'tool-search'], availableTools: ['codemode', 'mcp__search__lookup', 'tool-search'] });
  await f.select({}, 'session', 'off'); assert.equal(f.getActive().includes('codemode'), false); assert.equal(f.available().tools.includes('codemode'), false);
}));

test('failed MCP registration rejects readiness and succeeds on retry', async () => fixture(async f => {
  f.setRegistrationFailure(new Error('invalid server'));
  await assert.rejects(f.select({ search: { command: 'server' } }), /invalid server/);
  assert.equal(f.servers.has('search'), false);
  f.setRegistrationFailure();
  await f.select({ search: { command: 'server' } });
  assert.equal(f.servers.get('search').command, 'server');
}));

test('numeric MCP agent identifiers retain their schema and supplied value', async () => fixture(async f => {
  await f.select({ search: { command: 'server', piopInjectAgentId: true } });
  f.addTool('mcp__search__numeric', { agent_id: { type: 'number' } });
  const tool = f.tools.get('mcp__search__numeric');
  assert.deepEqual(tool.parameters, { type: 'object', properties: { agent_id: { type: 'number' } }, required: ['agent_id'] });
  assert.deepEqual(await tool.execute('call', { agent_id: 7 }), { content: [{ type: 'text', text: 'result' }] });
  assert.deepEqual(f.executions[0][1], { agent_id: 7 });
}));

test('the MCP SDK cannot reactivate disabled codemode', async () => fixture(async f => {
  await f.select({}, 'session', 'off');
  f.adapter.setActiveTools(['read', 'codemode']);
  assert.deepEqual(f.getActive(), ['read']);
}));

test('MCP selection and tool listing services stop responding after shutdown', async () => fixture(async f => {
  await f.select({ search: { command: 'server' } });
  assert.deepEqual(f.available().tools, ['codemode']);
  await f.dispatch('session_shutdown');
  const request = { servers: { other: { command: 'other' } }, sessionId: 'session' };
  f.bus.emit('piop:mcp:select', request);
  assert.equal(request.registered, undefined);
  assert.equal(f.servers.has('other'), false);
  assert.deepEqual(f.available(), {});
}));
