import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileAgentFixture } from '../compile-defined-agent-fixture.mjs';

test('agent definitions survive reload while selected MCP tools are pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'piop-agent-reload-'));
  const previous = { ...process.env };

  try {
    delete process.env.PI_DESKTOP_ALLOWED_TOOLS;
    const agent = name => ({ name, model: '', effort: 'high', tools: [], skills: name === 'tester' ? ['/fixture/skill'] : [], mcpServers: name === 'tester' ? { 'cua-vm': { command: 'cua', args: [], enabled: true } } : {} });
    await writeFile(join(dir, 'config.json'), JSON.stringify({ agents: [agent('default'), agent('tester')], webSearchDefaultApplied: true, excalidrawAgentDefaultApplied: true }));
    await compileAgentFixture(dir);
    const define = (await import(pathToFileURL(join(dir, 'index.mjs')).href)).default;
    let handlers, listeners, status, activeTools, finishMcp, startup;
    let mcpStarted, delayMcp = false;
    const mcpReady = new Promise(resolve => { mcpStarted = resolve; });
    const entries = [];
    const statuses = [];

    const ctx = {
      isIdle: () => true, cwd: dir,
      model: undefined, modelRegistry: { find() {} },
      sessionManager: { getSessionFile: () => '/fixture/session', getSessionId: () => 'fixture', getBranch: () => entries },
      ui: { setStatus(key, text) { if (key === 'pi-define-agents') { status = text; statuses.push(text); } } },
      reload: async () => {
        await handlers.session_shutdown({}, ctx);
        await load();
        startup = handlers.session_start({}, ctx);
      },
    };

    async function load() {
      handlers = {}; listeners = new Map();
      await define({
        on: (event, handler) => { handlers[event] = handler; },
        registerCommand() {},
        getAllTools: () => [], getThinkingLevel: () => 'high', setActiveTools: tools => { activeTools = tools; },
        appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
        events: { on(name, handler) {
          const handlers = listeners.get(name) ?? new Set();
          handlers.add(handler);
          listeners.set(name, handlers);

          return () => handlers.delete(handler);
        }, emit(name, selection) {
          if (name === 'piop:mcp:select') selection.registered = delayMcp && Object.keys(selection.servers).length ? new Promise(resolve => { finishMcp = resolve; mcpStarted(); }) : Promise.resolve([]);

          for (const handler of listeners.get(name) ?? []) handler(selection);
        } },
      });
    }

    await load(); await handlers.session_start({}, ctx);
    statuses.length = 0;
    const selection = { command: 'select_agent', payload: { agent: 'tester' }, ctx };

    for (const handler of listeners.get('piop:rpc')) handler(selection);
    await selection.ready;
    assert.ok(statuses.every(Boolean), 'reload cleared already-loaded agent definitions');
    const capability = JSON.parse(Buffer.from(status.slice(5), 'base64url').toString());
    assert.equal(capability.active, 'tester');
    assert.deepEqual(capability.config.agents.map(a => a.name), ['general', 'tester', 'diagramist']);
    await startup;
    assert.equal(finishMcp, undefined, 'selecting an agent must not wait on MCP connections');
    delayMcp = true;
    const input = handlers.input({ text: 'Check the app' }, ctx);
    assert.deepEqual(activeTools, [], 'MCP tools must remain unavailable until ready');
    await mcpReady;
    finishMcp(['mcp_cua_vm_example']);
    assert.deepEqual(await input, { action: 'continue' });
    assert.deepEqual(activeTools, ['mcp_cua_vm_example']);
    await handlers.session_shutdown({}, ctx);
    assert.equal(status, undefined, 'actual shutdown still clears definitions');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(dir, { recursive: true, force: true });
  }
});

test('session tools migrate once and later per-agent exclusions survive reload', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'piop-agent-session-tools-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const names = ['subagent'];
  await compileAgentFixture(dir);
  await writeFile(join(dir, 'config.json'), JSON.stringify({ agents: [{ name: 'general', model: '', effort: 'high', tools: [], skills: [], mcpServers: {} }], excalidrawAgentDefaultApplied: true }));
  const define = (await import(pathToFileURL(join(dir, 'index.mjs')))).default;

  const pi = {
    on() {}, registerCommand() {},
    events: { on() { return () => {}; }, emit(name, request) { if (name === 'piop:runtime-settings') request.settings = { tools: names, skills: [] }; } },
  };

  await define(pi);
  const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(config.agents[0].tools, names);
  assert.equal(config.sessionToolsDefaultApplied, true);
  config.agents[0].tools = [];
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  await define(pi);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).agents[0].tools, []);
});
