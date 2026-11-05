import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compileAgentFixture } from '../compile-defined-agent-fixture.mjs';
import { agentDefinitions, agentFixture, profile, configured, readStoredConfig, writeStoredConfig, piRoot } from '../defined-agent-fixture.mjs';

export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'piop-extensions-'));
  const dir = join(root, 'piop-define-agents'); await mkdir(dir);
  const home = process.env.HOME; process.env.HOME = dir;
  const resources = process.env.PIOP_AGENT_RESOURCES, storageRoot = process.env.PIOP_STORAGE_ROOT, testRoot = process.env.PIOP_TEST_STORAGE_ROOT, piFolder = process.env.PIOP_PI_ROOT;
  process.env.PIOP_STORAGE_ROOT = root; process.env.PIOP_TEST_STORAGE_ROOT = root; process.env.PIOP_PI_ROOT = piRoot;
  t.after(() => {
    if (storageRoot === undefined) delete process.env.PIOP_STORAGE_ROOT; else process.env.PIOP_STORAGE_ROOT = storageRoot;
    if (testRoot === undefined) delete process.env.PIOP_TEST_STORAGE_ROOT; else process.env.PIOP_TEST_STORAGE_ROOT = testRoot;
    if (piFolder === undefined) delete process.env.PIOP_PI_ROOT; else process.env.PIOP_PI_ROOT = piFolder;
  });
  process.env.PIOP_AGENT_RESOURCES = JSON.stringify({ tools: { enabledTools: [], registeredTools: [] }, skills: { userInvokedSkills: [], agentInvokedSkills: [] }, pluginAgentTools: [] });
  t.after(() => { if (resources === undefined) delete process.env.PIOP_AGENT_RESOURCES; else process.env.PIOP_AGENT_RESOURCES = resources; });
  t.after(() => { process.env.HOME = home; return rm(root, { recursive: true, force: true }); });

  await compileAgentFixture(dir);
  const definitions = await agentDefinitions(dir);
  await definitions.initialize();

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
      on(name, handler) { const set = listeners.get(name) ?? new Set(); set.add(handler); listeners.set(name, set);

      return () => set.delete(handler); },
      emit(name, value) { for (const handler of listeners.get(name) ?? []) handler(value); },
    },
  };

  const ctx = {
    isIdle: () => true,
    model: undefined, modelRegistry: { find() {} }, cwd: dir,
    sessionManager: { getSessionFile: () => join(dir, 'session'), getSessionId: () => dir, getBranch: () => entries },
    ui: { setStatus: (key, value) => statuses.set(key, value), notify() {} },
    reload: async () => { throw new Error('Unexpected reload'); },
  };

  const emit = async (name, event = {}) => { let result;

  for (const handler of [...handlers.get(name) ?? []]) { const next = await handler(event, ctx);

  if (next !== undefined) result = next; }

  return result; };

  const file = async (name, source) => { await writeFile(join(dir, name), source);

  return name; };

  const rpc = (command, payload) => { const request = { command, payload, ctx }; pi.events.emit('piop:rpc', request);

    return request.ready;
  };

  return { dir, pi, ctx, file, emit, rpc, configure: definitions.configure, store: async value => writeStoredConfig(dir, JSON.stringify(value)), configuration: async () => readStoredConfig(dir), commands, tools, entries, messages, statuses, activeTools: () => activeTools };
}

test('nested dependencies load once and share the universal context', async t => {
  const f = await agentFixture(t, { config: null });
  await f.file('leaf.mjs', `export default pi => { pi.registerTool({ name: 'leaf', execute: async () => 'leaf' }); pi.on('session_start', (_, ctx) => pi.sendMessage(ctx.cwd)); };`);
  await f.file('left.mjs', `export const extensions = ['./leaf.mjs']; export default pi => pi.on('input', (_, ctx) => pi.sendMessage(ctx.cwd));`);
  await f.file('right.mjs', `export const extensions = ['./leaf.mjs']; export default () => {};`);
  await f.file('root.mjs', `export const extensions = ['./left.mjs', './right.mjs']; export default () => {};`);
  await f.load();
  await f.store(configured([profile('general', { tools: [] }), profile('nested', { tools: [], extensions: ['root.mjs'] })]));
  await f.start(); await f.select('nested');
  assert.deepEqual(f.pi.getActiveTools(), ['leaf']);
  assert.deepEqual(f.messages, [f.dir]);
  await f.input('hello');
  assert.deepEqual(f.messages, [f.dir, f.dir]);
  f.ctx.sessionManager.getSessionFile = () => join(f.dir, 'new-session');
  f.ctx.sessionManager.getSessionId = () => 'new-session';
  f.entries.length = 0;
  await f.start();
  await f.select('general');
  await f.input('hello');
  assert.equal(f.messages.length, 2);
  await assert.rejects(async () => f.tools.get('leaf').execute(), /inactive/);
});

test('failed dependency or parent publishes no registrations', async t => {
  const f = await agentFixture(t, { tools: [], config: null });
  await f.file('good.mjs', `export default pi => { pi.registerTool({ name: 'partial' }); pi.events.on('test', () => { throw Error('leaked listener'); }); };`);
  await f.file('bad.mjs', `export default () => { throw Error('broken dependency'); };`);
  await f.file('root.mjs', `export const extensions = ['./good.mjs', './bad.mjs']; export default pi => pi.registerCommand('partial', {});`);
  await f.load();
  await f.store(configured([profile('general', { tools: [] }), profile('dependency', { tools: [], extensions: ['root.mjs'] }), profile('parent', { tools: [], extensions: ['parent.mjs'] })]));
  await f.start();
  await assert.rejects(f.select('dependency'), /root.mjs.*bad.mjs.*broken dependency/);
  assert.equal(f.pi.getAllTools().some(tool => tool.name === 'partial'), false);
  assert.equal(f.pi.getCommands().some(command => command.name === 'partial'), false);
  f.pi.events.emit('test', {});
  await f.file('parent.mjs', `export const extensions = ['./good.mjs']; export default () => { throw Error('broken parent'); };`);
  await assert.rejects(f.select('parent'), /broken parent/);
  assert.equal(f.pi.getAllTools().some(tool => tool.name === 'partial'), false);
});

test('missing modules, invalid exports and cyclic dependencies fail with paths', async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  await f.store(configured([profile('general', { tools: [] }), ...[['missing', 'missing.ts'], ['invalid', 'invalid.mjs'], ['invalid-list', 'invalid-list.mjs'], ['cycle', 'a.mjs']].map(([name, file]) => profile(name, { tools: [], extensions: [file] }))]));
  await f.start();
  await assert.rejects(f.select('missing'), /missing.ts/);
  await f.file('invalid.mjs', 'export default 1;');
  await assert.rejects(f.select('invalid'), /invalid.mjs.*Expected a default/);
  await f.file('invalid-list.mjs', 'export const extensions = "x"; export default () => {};');
  await assert.rejects(f.select('invalid-list'), /invalid-list.mjs.*array of nonempty/);
  await f.file('a.mjs', `export const extensions = ['./b.mjs']; export default () => {};`);
  await f.file('b.mjs', `export const extensions = ['./a.mjs']; export default () => {};`);
  await assert.rejects(f.select('cycle'), /Circular.*a.mjs.*b.mjs.*a.mjs/);
});

test('directory and symlink aliases deduplicate', async t => {
  const f = await agentFixture(t, { config: null });
  await mkdir(join(f.dir, 'package'));
  await f.file('package/index.mjs', `export default pi => { pi.registerTool({ name: 'once', execute: async () => 'ready' }); pi.on('session_start', () => pi.sendMessage('package loaded')); };`);
  await symlink(join(f.dir, 'package/index.mjs'), join(f.dir, 'alias.mjs'));
  await f.load();
  await f.store(configured([profile('general', { tools: [] }), profile('aliases', { tools: [], extensions: ['package', 'alias.mjs'] })]));
  await f.start(); await f.select('aliases');
  assert.deepEqual(f.pi.getActiveTools(), ['once']);
  assert.deepEqual(f.messages, ['package loaded']);
  assert.equal(await f.tools.get('once').execute(), 'ready');
});

test('startup failure restores previous handlers and bus listeners', async t => {
  const f = await agentFixture(t, { config: null });
  await f.file('good.mjs', `export default pi => { pi.events.on('test', () => pi.sendMessage('good')); pi.on('input', () => pi.sendMessage('input')); };`);
  await f.load();
  await f.store(configured([profile('general', { tools: [] }), profile('good', { tools: [], extensions: ['good.mjs'] }), profile('bad', { tools: [], extensions: ['bad.mjs'] })]));
  await f.start(); await f.select('good');
  await f.file('bad.mjs', `export default pi => { pi.events.on('test', () => pi.sendMessage('bad')); pi.on('session_start', () => { throw Error('startup failed'); }); };`);
  await assert.rejects(f.select('bad'), /startup failed/);
  f.pi.events.emit('test', {}); await f.input('hello');
  assert.deepEqual(f.messages, ['good', 'input']);
});

test('RPC agent selection rejects broken dependencies and keeps previous selection', async t => {
  const f = await fixture(t);
  await f.file('prompt.md', 'Prompt');
  await f.file('good.mjs', `export default pi => pi.registerTool({ name: 'extra', execute: async () => 'ok' });`);
  await f.file('bad.mjs', `export const extensions = ['./missing.mjs']; export default () => {};`);
  await f.file('startup.mjs', `export default pi => pi.on('session_start', () => { throw Error('startup failure'); });`);
  const agent = (name, extensions = []) => ({ name, extensions, path_systemprompt: 'prompt.md', path_agent_prompt: '', model: '', effort: 'high', tools: [], skills: [], mcpServers: {} });
  const previous = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  const define = (await import(pathToFileURL(join(f.dir, 'index.mjs')))).default;
  await define(f.pi);
  await f.store(configured([agent('general'), agent('good', ['good.mjs']), agent('bad', ['bad.mjs']), agent('startup', ['startup.mjs'])]));
  await f.emit('session_start');
  const select = name => f.rpc('select_agent', { agent: name });
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
  const f = await agentFixture(t, { config: null });
  await f.file('good.mjs', `export default pi => pi.registerTool({ name: 'shared', description: 'good schema', execute: async () => 'good' });`);
  await f.load();
  await f.store(configured([profile('general', { tools: [] }), profile('good', { tools: [], extensions: ['good.mjs'] }), profile('bad', { tools: [], extensions: ['bad.mjs'] })]));
  await f.start(); await f.select('good');
  await f.file('bad.mjs', `export default pi => {
    pi.registerTool({ name: 'shared', description: 'bad schema', execute: async () => 'bad' });
    pi.on('session_start', () => { throw Error('startup'); });
    pi.on('session_shutdown', () => pi.sendMessage('cleanup'));
  };`);
  await assert.rejects(f.select('bad'), /startup/);
  assert.equal(f.tools.get('shared').description, 'good schema');
  assert.equal(await f.tools.get('shared').execute(), 'good');
  assert.deepEqual(f.messages, ['cleanup']);
  await f.select('general');
  await assert.rejects(async () => f.tools.get('shared').execute(), /inactive/);
});

test('event bus unsubscription and agent shutdown release active listeners', async t => {
  const f = await agentFixture(t, { config: null });
  await f.file('lifecycle.mjs', `export default pi => {
    const off = pi.events.on('test', () => pi.sendMessage('leaked'));
    pi.on('session_start', () => off());
    pi.on('session_shutdown', () => pi.sendMessage('shutdown'));
  };`);
  await f.load();
  await f.store(configured([profile('general', { tools: [] }), profile('lifecycle', { tools: [], extensions: ['lifecycle.mjs'] })]));
  await f.start(); await f.select('lifecycle');
  f.pi.events.emit('test', {});
  assert.deepEqual(f.messages, []);
  await f.select('general');
  assert.deepEqual(f.messages, ['shutdown']);
});

test('a failed restored agent blocks input while global config edits preserve the session snapshot', async t => {
  const f = await fixture(t);
  await f.file('prompt.md', 'Prompt');
  const agent = { name: 'general', extensions: ['missing.mjs'], path_systemprompt: 'prompt.md', path_agent_prompt: '', model: '', effort: 'high', tools: [], skills: [], mcpServers: {} };
  const previous = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  await (await import(pathToFileURL(join(f.dir, 'index.mjs')))).default(f.pi);
  await f.store(configured([agent]));
  await f.emit('session_start');
  assert.deepEqual(await f.emit('input', { text: 'Never infer' }), { action: 'handled' });
  assert.deepEqual(f.activeTools(), []);
  const config = { agents: [{ ...agent, extensions: ['other-missing.mjs'] }] };
  await f.store(config);
  assert.deepEqual((await f.configuration()).agents[0].extensions, ['other-missing.mjs']);
  assert.deepEqual(await f.emit('input', { text: 'Still unavailable' }), { action: 'handled' });
  const error = JSON.parse(f.statuses.get('piop-input-rejected')).error;
  assert.ok(error.includes(join(f.dir, 'missing.mjs')), error);
  assert.equal(error.includes(join(f.dir, 'other-missing.mjs')), false);
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
  const agent = (name, extensions) => ({ name, extensions, path_systemprompt: 'prompt.md', path_agent_prompt: '', model: '', effort: 'high', tools: [], skills: [], mcpServers: {} });
  const previous = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  await (await import(pathToFileURL(join(f.dir, 'index.mjs')))).default(f.pi);
  await f.store(configured([agent('general', ['stable.mjs']), agent('invalid', [rootPath])]));
  await f.emit('session_start');

  return { ...f, invalidPath, rootPath };
}

async function assertRejectedExtensionGroup(f, scenario) {
  const entries = structuredClone(f.entries);
  const configuration = await f.configuration();
  await assert.rejects(f.rpc('select_agent', { agent: 'invalid' }), reason => {
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
  assert.deepEqual(await f.configuration(), configuration);
  const capability = JSON.parse(Buffer.from(f.statuses.get('pi-define-agents').slice(5), 'base64url'));
  assert.equal(capability.active, 'general', 'previous agent remains selected');
  assert.deepEqual(f.activeTools(), ['stable_tool']);
  assert.equal(await f.tools.get('stable_tool').execute(), 'stable');

  for (const name of ['parent', 'child', 'invalid']) {
    const tool = f.tools.get(`${name}_tool`);

    if (tool) await assert.rejects(async () => tool.execute(), /inactive/, `${name} tool must not run`);
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

async function sessionAgentFixture(t) {
  const f = await fixture(t);
  const previous = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  await f.file('prompt.md', 'Prompt');
  const agent = name => ({ name, path_systemprompt: 'prompt.md', path_agent_prompt: '', model: '', effort: 'high', tools: [], skills: [], mcpServers: {} });
  let effort = 'high';
  f.pi.getThinkingLevel = () => effort;
  f.pi.setThinkingLevel = level => { effort = level; };

  f.ctx.modelRegistry.find = (provider, id) => ({ provider, id });
  f.pi.setModel = async model => { f.ctx.model = model; await f.emit('model_select', { model });

  return true; };

  await (await import(pathToFileURL(join(f.dir, 'index.mjs')))).default(f.pi);
  await f.store(configured([agent('general'), agent('reviewer')]));
  f.select = name => f.rpc('select_agent', { agent: name });
  f.capability = () => JSON.parse(Buffer.from(f.statuses.get('pi-define-agents').slice(5), 'base64url'));

  return f;
}

test('a started conversation keeps manual model and effort choices after restore and can change agent', async t => {
  const f = await sessionAgentFixture(t);
  await f.emit('session_start');
  assert.equal(f.capability().locked, false);
  await f.select('reviewer');
  await f.select('general');
  await f.select('reviewer');
  assert.deepEqual(await f.emit('input', { text: 'Review this' }), { action: 'continue' });
  assert.equal(f.capability().locked, true);
  f.entries.push({ type: 'message', message: { role: 'user', content: 'Review this' } });
  await f.pi.setModel({ provider: 'test', id: 'another-model' });
  f.pi.setThinkingLevel('low');
  await f.emit('thinking_level_select', { level: 'low' });
  await f.emit('input', { text: 'Continue' });
  assert.equal(f.ctx.model.id, 'another-model');
  assert.equal(f.pi.getThinkingLevel(), 'low');

  const restored = await sessionAgentFixture(t);
  restored.entries.push(...structuredClone(f.entries));
  await restored.emit('session_start');
  assert.equal(restored.capability().active, 'reviewer');
  assert.equal(restored.capability().locked, true);
  assert.equal(restored.ctx.model.id, 'another-model');
  assert.equal(restored.pi.getThinkingLevel(), 'low');
  await restored.select('general');
  assert.equal(restored.capability().active, 'general');
  assert.equal(restored.entries.findLast(entry => entry.customType === 'pi-define-agents-state').data.snapshot.definition.name, 'general');
});

test('legacy conversations keep their saved agent when global definitions change', async t => {
  const f = await sessionAgentFixture(t);
  f.entries.push(
    { type: 'message', message: { role: 'user', content: 'Existing conversation' } },
    { type: 'custom', customType: 'pi-define-agents-state', data: { active: 'reviewer' } },
  );
  await f.emit('session_start');
  assert.equal(f.capability().active, 'reviewer');
  assert.equal(f.capability().locked, true);
  const config = await f.configuration();
  config.agents = config.agents.filter(agent => agent.name !== 'reviewer');
  await f.store(config);
  assert.equal(f.capability().active, 'reviewer');
  assert.equal(f.capability().saved, true);
  await f.select('general');
  assert.equal(f.capability().active, 'general');
});

test('a missing restored agent blocks input until another agent is chosen', async t => {
  const f = await sessionAgentFixture(t);
  f.entries.push({ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'removed', locked: true } });
  await f.emit('session_start');
  assert.equal(f.capability().active, 'removed');
  assert.equal(f.capability().unavailable, true);
  assert.deepEqual(await f.emit('input', { text: 'Blocked' }), { action: 'handled' });
  assert.match(JSON.parse(f.statuses.get('piop-input-rejected')).error, /Agent "removed" is unavailable/);
  assert.deepEqual(await f.emit('input', { text: 'Again' }), { action: 'handled' });
  await f.select('general');
  assert.equal(f.capability().unavailable, false);
  assert.deepEqual(await f.emit('input', { text: 'Continue' }), { action: 'continue' });
});


test('after an agent change, each request starts with the new agent prompt and tools', async t => {
  let root = dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()));
  while (!existsSync(join(root, 'node_modules/@earendil-works/pi-ai/package.json'))) { const parent = dirname(root); if (parent === root) throw new Error('Could not locate the installed Pi AI package'); root = parent; }
  const { getCurrentSystemMessage } = await import(pathToFileURL(join(root, 'node_modules/@earendil-works/pi-ai/dist/index.js')));
  const f = await sessionAgentFixture(t);
  await f.emit('session_start');
  const tool = name => ({ name, description: name, parameters: { type: 'object' } });
  const head = { role: 'system', content: '', sections: { preamble: 'Old prompt', instructions: '<instructions>\nOld\n</instructions>', cwd: '<cwd>\n/w\n</cwd>' }, toolsAdded: [tool('read'), tool('bash')], timestamp: 1 };
  const user = { role: 'user', content: 'First', timestamp: 2 };
  const reply = { role: 'assistant', content: [{ type: 'text', text: 'Done' }], timestamp: 3 };
  const tools = { role: 'system', content: '', toolsAdded: [tool('grep')], timestamp: 4 };
  const change = { role: 'system', content: '', sections: { preamble: 'New prompt', instructions: null }, toolsAdded: [tool('write')], toolsRemoved: [{ name: 'bash' }], timestamp: 5 };
  const next = { role: 'user', content: 'Second', timestamp: 6 };
  const later = { role: 'system', content: '', toolsAdded: [tool('find')], timestamp: 7 };
  const messages = [head, user, reply, tools, change, next, later];
  const { messages: sent } = await f.emit('context_with_system', { messages: structuredClone(messages) });
  assert.deepEqual(sent, [getCurrentSystemMessage(messages.slice(0, 5)), user, reply, next, later]);
  assert.deepEqual(sent[0].sections, { preamble: 'New prompt', cwd: '<cwd>\n/w\n</cwd>' });
  assert.deepEqual(sent[0].toolsAdded.map(tool => tool.name), ['read', 'grep', 'write']);
  assert.equal(await f.emit('context_with_system', { messages: [head, user, reply, tools, next] }), undefined);
});

test('/agent edits the agent of this conversation only, and the edit survives a restore', async t => {
  const f = await sessionAgentFixture(t);
  await f.emit('session_start');
  const opened = [];
  f.ctx.ui.input = async title => { opened.push(title); return 'opened'; };
  await f.commands.get('agent').handler('', f.ctx);
  assert.deepEqual(opened, ['__piop_chat_agent__']);
  await f.select('reviewer');
  assert.deepEqual(await f.emit('input', { text: 'Start' }), { action: 'continue' });
  f.entries.push({ type: 'message', message: { role: 'user', content: 'Start' } });
  const chat = await f.rpc('chat_agent');
  assert.equal(chat.agent.name, 'reviewer'); assert.equal(chat.systemPrompt, 'Prompt'); assert.equal(chat.agentPrompt, '');
  assert.equal(chat.agent.path_systemprompt, undefined);
  const prompt = async target => { const options = { sections: {}, skills: [] }; await target.emit('before_agent_start', { systemPromptOptions: options }); return [options.customPrompt, options.sections.instructions]; };

  await assert.rejects(f.rpc('set_chat_agent', { ...chat, systemPrompt: ' ' }), /system prompt cannot be empty/);
  await assert.rejects(f.rpc('set_chat_agent', { ...chat, agent: { ...chat.agent, name: 'bad name' } }), /agent name/);
  await assert.rejects(f.rpc('set_chat_agent', { ...chat, agent: { ...chat.agent, tools: 'read' } }), /Invalid agent settings: \/agent\/tools/);
  f.ctx.isIdle = () => false;
  await assert.rejects(f.rpc('set_chat_agent', chat), /Wait for the current response/);
  f.ctx.isIdle = () => true;
  assert.deepEqual(await prompt(f), ['Prompt', '']);

  await f.rpc('set_chat_agent', { agent: { ...chat.agent, name: 'editor', description: 'Edits text' }, systemPrompt: 'Edited prompt', agentPrompt: 'Be brief.' });
  assert.equal(f.capability().active, 'editor');
  assert.deepEqual(await prompt(f), ['Edited prompt', 'Be brief.']);
  assert.deepEqual((await f.rpc('chat_agent')).systemPrompt, 'Edited prompt');
  assert.equal(f.entries.findLast(entry => entry.customType === 'pi-define-agents-state').data.snapshot.definition.name, 'editor');
  assert.deepEqual((await f.configuration()).agents.map(agent => agent.name), ['general', 'reviewer']);

  await f.rpc('set_chat_agent', { agent: { ...chat.agent, name: 'editor', description: 'Edits text' }, systemPrompt: 'Edited again', agentPrompt: 'Be brief.' });
  assert.equal(f.entries.filter(entry => entry.customType === 'pi-define-agents-state').at(-1).data.snapshot.definition.name, 'editor');

  const restored = await sessionAgentFixture(t);
  restored.entries.push(...structuredClone(f.entries));
  await restored.emit('session_start');
  assert.equal(restored.capability().active, 'editor');
  assert.deepEqual(await prompt(restored), ['Edited again', 'Be brief.']);
  assert.equal((await restored.rpc('chat_agent')).agent.description, 'Edits text');
});

test('/agent shows the model and effort picked in the composer, and Apply makes the pane values the only choice', async t => {
  const f = await sessionAgentFixture(t);
  await f.emit('session_start');
  const published = () => f.statuses.get('pi-define-agents');
  f.statuses.delete('pi-define-agents');
  await f.pi.setModel({ provider: 'test', id: 'picked' });
  assert.ok(published(), 'a composer model change tells open agent panes');
  f.statuses.delete('pi-define-agents');
  f.pi.setThinkingLevel('low');
  await f.emit('thinking_level_select', { level: 'low' });
  assert.ok(published(), 'a composer effort change tells open agent panes');
  const chat = await f.rpc('chat_agent');
  assert.equal(chat.agent.model, 'test/picked'); assert.equal(chat.agent.effort, 'low');

  await f.rpc('set_chat_agent', { ...chat, systemPrompt: 'Edited' });
  assert.equal(f.ctx.model.id, 'picked'); assert.equal(f.pi.getThinkingLevel(), 'low');
  const edited = await f.rpc('chat_agent');
  await f.rpc('set_chat_agent', { ...edited, agent: { ...edited.agent, model: 'test/chosen', effort: 'medium' } });
  assert.equal(f.ctx.model.id, 'chosen'); assert.equal(f.pi.getThinkingLevel(), 'medium');
  await f.emit('input', { text: 'Go' });
  assert.equal(f.ctx.model.id, 'chosen'); assert.equal(f.pi.getThinkingLevel(), 'medium');
  const shown = (await f.rpc('chat_agent')).agent;
  assert.equal(shown.model, 'test/chosen'); assert.equal(shown.effort, 'medium');
});

test('compacted history allows agent selection', async t => {
  const f = await sessionAgentFixture(t);
  f.entries.push({ type: 'compaction' });
  await f.emit('session_start');
  assert.equal(f.capability().locked, true);
  await f.select('reviewer');
  assert.equal(f.capability().active, 'reviewer');
  await f.select('general');
  f.entries.length = 0;
  f.ctx.sessionManager.getSessionFile = () => join(f.dir, 'new-session');
  await f.emit('session_start');
  assert.equal(f.capability().locked, false);
  await f.select('reviewer');
  assert.equal(f.capability().active, 'reviewer');
});

test('changing agent during a response is rejected without changing history', async t => {
  const f = await sessionAgentFixture(t);
  await f.emit('session_start'); await f.select('reviewer');
  await f.emit('input', { text: 'Review this' });
  f.entries.push({ type: 'message', message: { role: 'user', content: 'Review this' } });
  const entries = structuredClone(f.entries);
  f.ctx.isIdle = () => false;
  await assert.rejects(f.select('general'), /Wait for the current response/);
  assert.deepEqual(f.entries, entries);
  assert.equal(f.capability().active, 'reviewer');
});
