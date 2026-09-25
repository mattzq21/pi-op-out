import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';

test('agent definitions survive reload while selected MCP tools are pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'piop-agent-reload-'));
  const previous = { ...process.env };
  try {
    delete process.env.PI_DESKTOP_ALLOWED_TOOLS;
    const agent = name => ({ name, model: '', effort: 'high', tools: [], skills: name === 'tester' ? ['/fixture/skill'] : [], mcpServers: name === 'tester' ? [{ id: 'cua-vm', name: 'CUA', command: 'cua', args: '', enabled: true }] : [] });
    await writeFile(join(dir, 'config.json'), JSON.stringify({ agents: [agent('default'), agent('tester')], webSearchDefaultApplied: true }));
    const source = (await readFile(new URL('../../extensions/piop-define-agents/index.ts', import.meta.url), 'utf8')).replace(/import \{ formatSkillsForPrompt, type BuildSystemPromptOptions \} from "@earendil-works\/pi-coding-agent";/, 'const formatSkillsForPrompt = () => "";');
    await writeFile(join(dir, 'mcp-config.mjs'), (await transform(await readFile(new URL('../../extensions/piop-define-agents/mcp-config.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' })).code);
    const loader = await readFile(new URL('../../extensions/piop-define-agents/extension-loader.ts', import.meta.url), 'utf8');
    await writeFile(join(dir, 'extension-loader.mjs'), (await transform(loader, { loader: 'ts', format: 'esm' })).code);
    await writeFile(join(dir, 'index.mjs'), (await transform(source.replace('./extension-loader.ts', './extension-loader.mjs').replace('./mcp-config.ts', './mcp-config.mjs'), { loader: 'ts', format: 'esm' })).code);
    const define = (await import(pathToFileURL(join(dir, 'index.mjs')).href)).default;
    let handlers, commands, status, activeTools, finishMcp, startup;
    let mcpStarted;
    const mcpReady = new Promise(resolve => { mcpStarted = resolve; });
    const entries = [];
    const statuses = [];
    const ctx = {
      isIdle: () => true,
      model: undefined, modelRegistry: { find() {} },
      sessionManager: { getSessionFile: () => '/fixture/session', getSessionId: () => 'fixture', getBranch: () => entries },
      ui: { setStatus(_key, text) { status = text; statuses.push(text); } },
      reload: async () => {
        await handlers.session_shutdown({}, ctx);
        await load();
        startup = handlers.session_start({}, ctx);
      },
    };
    async function load() {
      handlers = {}; commands = {};
      await define({
        on: (event, handler) => { handlers[event] = handler; },
        registerCommand: (name, command) => { commands[name] = command.handler; },
        getAllTools: () => [], getThinkingLevel: () => 'high', setActiveTools: tools => { activeTools = tools; },
        appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
        events: { on() { return () => {}; }, emit(_name, selection) { if (!selection.servers) return; selection.ready = selection.servers.length ? new Promise(resolve => { finishMcp = resolve; mcpStarted(); }) : Promise.resolve([]); } },
      });
    }
    await load(); await handlers.session_start({}, ctx);
    statuses.length = 0;
    await commands['pi-define-agents-use']('tester', ctx);
    assert.ok(statuses.every(Boolean), 'reload cleared already-loaded agent definitions');
    const capability = JSON.parse(Buffer.from(status.slice(5), 'base64url').toString());
    assert.equal(capability.active, 'tester');
    assert.deepEqual(capability.config.agents.map(a => a.name), ['general', 'tester']);
    await startup;
    assert.equal(finishMcp, undefined, 'selecting an agent must not start MCP');
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
  const names = ['fork_session', 'create_worktree', 'remove_worktree'];
  const source = (await readFile(new URL('../../extensions/piop-define-agents/index.ts', import.meta.url), 'utf8'))
    .replace(/import \{ formatSkillsForPrompt, type BuildSystemPromptOptions \} from "@earendil-works\/pi-coding-agent";/, 'const formatSkillsForPrompt = () => "";')
    .replace('./extension-loader.ts', './extension-loader.mjs').replace('./mcp-config.ts', './mcp-config.mjs');
  await writeFile(join(dir, 'index.mjs'), (await transform(source, { loader: 'ts', format: 'esm' })).code);
  await writeFile(join(dir, 'mcp-config.mjs'), (await transform(await readFile(new URL('../../extensions/piop-define-agents/mcp-config.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' })).code);
    const loader = await readFile(new URL('../../extensions/piop-define-agents/extension-loader.ts', import.meta.url), 'utf8');
  await writeFile(join(dir, 'extension-loader.mjs'), (await transform(loader, { loader: 'ts', format: 'esm' })).code);
  await writeFile(join(dir, 'config.json'), JSON.stringify({ agents: [{ name: 'general', model: '', effort: 'high', tools: [], skills: [], mcpServers: [] }] }));
  const define = (await import(pathToFileURL(join(dir, 'index.mjs')))).default;
  const pi = {
    on() {}, registerCommand() {},
    events: { on() { return () => {}; }, emit(name, request) { if (name === 'piop:runtime-settings') request.settings = { tools: names, skills: [] }; } },
  };
  await define(pi);
  const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(config.agents[0].tools, names);
  assert.equal(config.sessionToolsDefaultApplied, true);
  config.agents[0].tools = ['fork_session'];
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  await define(pi);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).agents[0].tools, ['fork_session']);
});
