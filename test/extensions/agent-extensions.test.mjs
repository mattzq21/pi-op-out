import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';

export async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'piop-extensions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['index', 'extension-loader']) {
    let source = await readFile(new URL(`../../extensions/piop-define-agents/${name}.ts`, import.meta.url), 'utf8');
    source = source.replace('./extension-loader.ts', './extension-loader.mjs').replace(/import \{ formatSkillsForPrompt, type BuildSystemPromptOptions \} from "@earendil-works\/pi-coding-agent";/, 'const formatSkillsForPrompt = () => "";');
    await writeFile(join(dir, `${name}.mjs`), (await transform(source, { loader: 'ts', format: 'esm' })).code);
  }
  const handlers = new Map(), commands = new Map(), tools = new Map(), listeners = new Map();
  const entries = [], messages = [], statuses = new Map();
  let activeTools = [];
  const pi = {
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    getAllTools: () => [...tools.values()], getCommands: () => [...commands.keys()].map(name => ({ name })),
    getThinkingLevel: () => 'high', setActiveTools: value => { activeTools = value; }, getActiveTools: () => activeTools,
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendMessage: value => messages.push(value),
    events: {
      on(name, handler) { const set = listeners.get(name) ?? new Set(); set.add(handler); listeners.set(name, set); return () => set.delete(handler); },
      emit(name, value) { for (const handler of listeners.get(name) ?? []) handler(value); },
    },
  };
  const ctx = {
    model: undefined, modelRegistry: { find() {} }, cwd: dir,
    sessionManager: { getSessionFile: () => join(dir, 'session'), getSessionId: () => dir, getBranch: () => entries },
    ui: { setStatus: (key, value) => statuses.set(key, value), notify() {} },
    reload: async () => { throw new Error('Unexpected reload'); },
  };
  const emit = async (name, event = {}) => { let result; for (const handler of [...handlers.get(name) ?? []]) { const next = await handler(event, ctx); if (next !== undefined) result = next; } return result; };
  const file = async (name, source) => { await writeFile(join(dir, name), source); return name; };
  const loader = (await import(pathToFileURL(join(dir, 'extension-loader.mjs')))).agentExtensions(pi, dir);
  return { dir, pi, ctx, loader, file, emit, commands, tools, entries, messages, statuses, activeTools: () => activeTools };
}

test('nested dependencies load once and share the universal context', async t => {
  const f = await fixture(t);
  await f.file('leaf.mjs', `export default pi => { pi.registerTool({ name: 'leaf', execute: async () => 'leaf' }); pi.on('session_start', (_, ctx) => pi.sendMessage(ctx.cwd)); };`);
  await f.file('left.mjs', `export const extensions = ['./leaf.mjs']; export default pi => pi.on('input', (_, ctx) => pi.sendMessage(ctx.cwd));`);
  await f.file('right.mjs', `export const extensions = ['./leaf.mjs']; export default () => {};`);
  await f.file('root.mjs', `export const extensions = ['./left.mjs', './right.mjs']; export default () => {};`);
  await f.loader.activate(await f.loader.prepare(['root.mjs']), f.ctx);
  assert.deepEqual(f.loader.tools(), ['leaf']);
  assert.deepEqual(f.messages, [f.dir]);
  await f.emit('input');
  assert.deepEqual(f.messages, [f.dir, f.dir]);
  await f.loader.activate(await f.loader.prepare([]), f.ctx);
  await f.emit('input');
  assert.equal(f.messages.length, 2);
  assert.throws(() => f.tools.get('leaf').execute(), /inactive/);
});

test('failed dependency or parent publishes no registrations', async t => {
  const f = await fixture(t);
  await f.file('good.mjs', `export default pi => { pi.registerTool({ name: 'partial' }); pi.events.on('test', () => { throw Error('leaked listener'); }); };`);
  await f.file('bad.mjs', `export default () => { throw Error('broken dependency'); };`);
  await f.file('root.mjs', `export const extensions = ['./good.mjs', './bad.mjs']; export default pi => pi.registerCommand('partial', {});`);
  await assert.rejects(f.loader.prepare(['root.mjs']), /root.mjs.*bad.mjs.*broken dependency/);
  assert.equal(f.tools.size, 0); assert.equal(f.commands.size, 0);
  f.pi.events.emit('test', {});
  await f.file('parent.mjs', `export const extensions = ['./good.mjs']; export default () => { throw Error('broken parent'); };`);
  await assert.rejects(f.loader.prepare(['parent.mjs']), /broken parent/);
  assert.equal(f.tools.size, 0);
});

test('missing modules, invalid exports and cyclic dependencies fail with paths', async t => {
  const f = await fixture(t);
  await assert.rejects(f.loader.prepare(['missing.ts']), /missing.ts/);
  await f.file('invalid.mjs', 'export default 1;');
  await assert.rejects(f.loader.prepare(['invalid.mjs']), /Expected a default/);
  await f.file('invalid-list.mjs', 'export const extensions = "x"; export default () => {};');
  await assert.rejects(f.loader.prepare(['invalid-list.mjs']), /array of nonempty/);
  await f.file('a.mjs', `export const extensions = ['./b.mjs']; export default () => {};`);
  await f.file('b.mjs', `export const extensions = ['./a.mjs']; export default () => {};`);
  await assert.rejects(f.loader.prepare(['a.mjs']), /Circular.*a.mjs.*b.mjs.*a.mjs/);
});

test('directory and symlink aliases deduplicate', async t => {
  const f = await fixture(t);
  await mkdir(join(f.dir, 'package'));
  await f.file('package/index.mjs', `export default pi => pi.registerTool({ name: 'once' });`);
  await symlink(join(f.dir, 'package/index.mjs'), join(f.dir, 'alias.mjs'));
  await f.loader.activate(await f.loader.prepare(['package', 'alias.mjs']), f.ctx);
  assert.deepEqual(f.loader.tools(), ['once']);
});

test('startup failure restores previous handlers and bus listeners', async t => {
  const f = await fixture(t);
  await f.file('good.mjs', `export default pi => { pi.events.on('test', () => pi.sendMessage('good')); pi.on('input', () => pi.sendMessage('input')); };`);
  await f.loader.activate(await f.loader.prepare(['good.mjs']), f.ctx);
  await f.file('bad.mjs', `export default pi => { pi.events.on('test', () => pi.sendMessage('bad')); pi.on('session_start', () => { throw Error('startup failed'); }); };`);
  await assert.rejects(f.loader.activate(await f.loader.prepare(['bad.mjs']), f.ctx), /startup failed/);
  f.pi.events.emit('test', {}); await f.emit('input');
  assert.deepEqual(f.messages, ['good', 'input']);
});

test('RPC agent selection rejects broken dependencies and keeps previous selection', async t => {
  const f = await fixture(t);
  await f.file('prompt.md', 'Prompt');
  await f.file('good.mjs', `export default pi => pi.registerTool({ name: 'extra', execute: async () => 'ok' });`);
  await f.file('bad.mjs', `export const extensions = ['./missing.mjs']; export default () => {};`);
  await f.file('startup.mjs', `export default pi => pi.on('session_start', () => { throw Error('startup failure'); });`);
  const agent = (name, extensions = []) => ({ name, extensions, path_systemprompt: 'prompt.md', path_agentprompt: '', model: '', effort: 'high', tools: [], skills: [], mcpServers: [] });
  await f.file('config.json', JSON.stringify({ agents: [agent('general'), agent('good', ['good.mjs']), agent('bad', ['bad.mjs']), agent('startup', ['startup.mjs'])], webSearchDefaultApplied: true }));
  const previous = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  delete process.env.PI_DESKTOP_MCP_CONFIG;
  const define = (await import(pathToFileURL(join(f.dir, 'index.mjs')))).default;
  await define(f.pi); await f.emit('session_start');
  const select = name => f.commands.get('pi-define-agents-use').handler(name, f.ctx);
  await select('good');
  assert.deepEqual(f.activeTools(), ['extra']);
  const entriesBefore = structuredClone(f.entries);
  await assert.rejects(select('bad'), /bad.mjs.*missing.mjs/);
  await assert.rejects(select('startup'), /startup failure/);
  assert.deepEqual(f.entries, entriesBefore);
  assert.deepEqual(f.activeTools(), ['extra']);
  const capability = JSON.parse(Buffer.from(f.statuses.get('pi-define-agents').slice(5), 'base64url'));
  assert.equal(capability.active, 'good');
  assert.deepEqual(await f.emit('input', { text: 'Hello' }), { action: 'continue' });
});

test('failed startup restores tool schemas and cleans up the failed group', async t => {
  const f = await fixture(t);
  await f.file('good.mjs', `export default pi => pi.registerTool({ name: 'shared', description: 'good schema', execute: async () => 'good' });`);
  await f.loader.activate(await f.loader.prepare(['good.mjs']), f.ctx);
  await f.file('bad.mjs', `export default pi => {
    pi.registerTool({ name: 'shared', description: 'bad schema', execute: async () => 'bad' });
    pi.on('session_start', () => { throw Error('startup'); });
    pi.on('session_shutdown', () => pi.sendMessage('cleanup'));
  };`);
  await assert.rejects(f.loader.activate(await f.loader.prepare(['bad.mjs']), f.ctx), /startup/);
  assert.equal(f.tools.get('shared').description, 'good schema');
  assert.equal(await f.tools.get('shared').execute(), 'good');
  assert.deepEqual(f.messages, ['cleanup']);
  await f.loader.activate(await f.loader.prepare([]), f.ctx);
  assert.throws(() => f.tools.get('shared').execute(), /inactive/);
});

test('event bus unsubscription and agent shutdown release active listeners', async t => {
  const f = await fixture(t);
  await f.file('lifecycle.mjs', `export default pi => {
    const off = pi.events.on('test', () => pi.sendMessage('leaked'));
    pi.on('session_start', () => off());
    pi.on('session_shutdown', () => pi.sendMessage('shutdown'));
  };`);
  await f.loader.activate(await f.loader.prepare(['lifecycle.mjs']), f.ctx);
  f.pi.events.emit('test', {});
  assert.deepEqual(f.messages, []);
  await f.loader.activate(await f.loader.prepare([]), f.ctx);
  assert.deepEqual(f.messages, ['shutdown']);
});

test('a failed restored agent blocks input and a failed config save preserves the file', async t => {
  const f = await fixture(t);
  await f.file('prompt.md', 'Prompt');
  const agent = { name: 'general', extensions: ['missing.mjs'], path_systemprompt: 'prompt.md', path_agentprompt: '', model: '', effort: 'high', tools: [], skills: [], mcpServers: [] };
  await f.file('config.json', JSON.stringify({ agents: [agent], webSearchDefaultApplied: true }));
  const previous = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  delete process.env.PI_DESKTOP_MCP_CONFIG;
  await (await import(pathToFileURL(join(f.dir, 'index.mjs')))).default(f.pi);
  await assert.rejects(f.emit('session_start'), /missing.mjs/);
  assert.deepEqual(await f.emit('input', { text: 'Never infer' }), { action: 'handled' });
  assert.deepEqual(f.activeTools(), []);
  const before = await readFile(join(f.dir, 'config.json'), 'utf8');
  const config = Buffer.from(JSON.stringify({ agents: [{ ...agent, extensions: ['other-missing.mjs'] }] })).toString('base64url');
  await assert.rejects(f.commands.get('pi-define-agents-config').handler(config, f.ctx), /other-missing/);
  assert.equal(await readFile(join(f.dir, 'config.json'), 'utf8'), before);
});

const stagedExtension = name => `
  pi.registerTool({ name: '${name}_tool', execute: async () => '${name}' });
  pi.registerCommand('${name}_command', { handler: async () => pi.sendMessage('${name}:command') });
  pi.events.on('invalid-extension-probe', () => pi.sendMessage('${name}:event'));
  pi.on('input', () => pi.sendMessage('${name}:input'));
`;

const invalidExtensionCases = [
  { name: 'syntax error', source: 'export default function ( {', error: /SyntaxError|Unexpected/ },
  { name: 'invalid default export', source: 'export default 42;', error: /Expected a default piop extension factory/ },
  { name: 'factory failure after registration', source: `export default pi => { ${stagedExtension('invalid')} throw Error('invalid factory'); };`, error: /invalid factory/ },
  { name: 'startup failure after registration', source: `export default pi => { ${stagedExtension('invalid')} pi.on('session_start', () => { throw Error('invalid startup'); }); };`, error: /invalid startup/ },
];

async function invalidAgentFixture(t, position, source) {
  const f = await fixture(t);
  await f.file('prompt.md', 'Prompt');
  await f.file('stable.mjs', `export default pi => {
    pi.registerTool({ name: 'stable_tool', execute: async () => 'stable' });
    pi.on('input', () => { pi.sendMessage('stable:input'); });
    pi.events.on('invalid-extension-probe', () => pi.sendMessage('stable:event'));
  };`);
  const valid = name => `export default pi => { ${stagedExtension(name)} };`;
  const invalidPath = position === 'single' ? 'single.mjs' : `${position}.mjs`;
  const rootPath = position === 'single' ? invalidPath : 'parent.mjs';
  await f.file('child.mjs', valid('child'));
  await f.file('parent.mjs', `export const extensions = ['./child.mjs']; ${valid('parent')}`);
  const dependencies = position === 'parent' ? `export const extensions = ['./child.mjs']; ` : '';
  await f.file(invalidPath, dependencies + source);
  const agent = (name, extensions) => ({ name, extensions, path_systemprompt: 'prompt.md', path_agentprompt: '', model: '', effort: 'high', tools: [], skills: [], mcpServers: [] });
  await f.file('config.json', JSON.stringify({ agents: [agent('general', ['stable.mjs']), agent('invalid', [rootPath])], webSearchDefaultApplied: true }));
  const previous = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  delete process.env.PI_DESKTOP_MCP_CONFIG;
  await (await import(pathToFileURL(join(f.dir, 'index.mjs')))).default(f.pi);
  await f.emit('session_start');
  return { ...f, invalidPath, rootPath };
}

async function assertRejectedExtensionGroup(f, scenario) {
  const entries = structuredClone(f.entries);
  const configuration = await readFile(join(f.dir, 'config.json'), 'utf8');
  await assert.rejects(f.commands.get('pi-define-agents-use').handler('invalid', f.ctx), reason => {
    assert.match(reason.message, scenario.error);
    if (scenario.name.startsWith("startup")) {
      assert.match(reason.message, /Agent "invalid" could not load its piop extensions/);
      return true;
    }
    assert.ok(reason.message.includes(join(f.dir, f.invalidPath)), 'error identifies the invalid extension');
    assert.ok(reason.message.includes(join(f.dir, f.rootPath)), 'error identifies the parent that could not load');
    return true;
  });
  assert.deepEqual(f.entries, entries, 'failed selection must not alter conversation history');
  assert.equal(await readFile(join(f.dir, 'config.json'), 'utf8'), configuration);
  const capability = JSON.parse(Buffer.from(f.statuses.get('pi-define-agents').slice(5), 'base64url'));
  assert.equal(capability.active, 'general', 'previous agent remains selected');
  assert.deepEqual(f.activeTools(), ['stable_tool']);
  assert.equal(await f.tools.get('stable_tool').execute(), 'stable');
  for (const name of ['parent', 'child', 'invalid']) {
    const tool = f.tools.get(`${name}_tool`);
    if (tool) assert.throws(() => tool.execute(), /inactive/, `${name} tool must not run`);
    const command = f.commands.get(`${name}_command`);
    if (command) await assert.rejects(async () => command.handler('', f.ctx), /inactive/, `${name} command must not run`);
  }
  f.pi.events.emit('invalid-extension-probe', {});
  assert.deepEqual(await f.emit('input', { text: 'Continue with the previous agent' }), { action: 'continue' });
  assert.deepEqual(f.messages, ['stable:event', 'stable:input'], 'neither failed extension nor its dependency group may handle events');
}

for (const position of ['parent', 'child', 'single']) {
  test(`invalid ${position} extension rejects agent loading`, async t => {
    for (const scenario of invalidExtensionCases) {
      await t.test(scenario.name, async t => {
        const f = await invalidAgentFixture(t, position, scenario.source);
        await assertRejectedExtensionGroup(f, scenario);
      });
    }
  });
}
