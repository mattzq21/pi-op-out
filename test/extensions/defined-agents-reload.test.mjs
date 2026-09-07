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
    process.env.PI_DESKTOP_MCP_CONFIG = 'fixture';
    delete process.env.PI_DESKTOP_ALLOWED_TOOLS;
    const agent = name => ({ name, model: '', effort: 'high', tools: [], skills: [], mcpServers: name === 'tester' ? ['cua-vm'] : [] });
    await writeFile(join(dir, 'config.json'), JSON.stringify({ agents: [agent('default'), agent('tester')], webSearchDefaultApplied: true }));
    const source = (await readFile(new URL('../../extensions/pi-define-agents/index.ts', import.meta.url), 'utf8')).replace(/import \{ formatSkillsForPrompt, type BuildSystemPromptOptions \} from "@earendil-works\/pi-coding-agent";/, 'const formatSkillsForPrompt = () => "";');
    await writeFile(join(dir, 'index.mjs'), (await transform(source, { loader: 'ts', format: 'esm' })).code);
    const define = (await import(pathToFileURL(join(dir, 'index.mjs')).href)).default;
    let handlers, commands, status, activeTools, finishMcp, startup;
    const entries = [];
    const statuses = [];
    const ctx = {
      model: undefined, modelRegistry: { find() {} },
      sessionManager: { getSessionFile: () => '/fixture/session', getSessionId: () => 'fixture', getBranch: () => entries },
      ui: { setStatus(key, text) { status = text; statuses.push(text); } },
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
        events: { emit(_name, selection) { selection.ready = selection.serverIds.length ? new Promise(resolve => { finishMcp = resolve; }) : Promise.resolve([]); } },
      });
    }
    await load(); await handlers.session_start({}, ctx);
    statuses.length = 0;
    await commands['pi-define-agents-use']('tester', ctx);
    assert.ok(statuses.every(Boolean), 'reload cleared already-loaded agent definitions');
    const capability = JSON.parse(Buffer.from(status.slice(5), 'base64url').toString());
    assert.equal(capability.active, 'tester');
    assert.deepEqual(capability.config.agents.map(a => a.name), ['default', 'tester']);
    assert.deepEqual(activeTools, [], 'MCP tools must remain unavailable until ready');
    finishMcp(['mcp_cua_vm_example']); await startup;
    assert.deepEqual(activeTools, ['mcp_cua_vm_example']);
    await handlers.session_shutdown({}, ctx);
    assert.equal(status, undefined, 'actual shutdown still clears definitions');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(dir, { recursive: true, force: true });
  }
});
