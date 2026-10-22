import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentFixture, profile, configured, encoded } from '../defined-agent-fixture.mjs';
import { installAgentMcp } from '../mcp-agent-fixture.mjs';

const remoteMcp = { command: 'mcp-server', args: [], enabled: true };

test('agent startup reads local definitions even when a broker is configured', async t => {
  const f = await agentFixture(t, {
    config: configured([profile()]),
    env: { PI_DESKTOP_BROKER_URL: 'http://127.0.0.1:1', PI_DESKTOP_BROKER_TOKEN: '' },
  });
  await f.load(); await f.start();
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
  assert.deepEqual(await f.input('Start'), { action: 'continue' });
});


test('skill switches save before reload and failed activation restores overrides without history writes', async t => {
  const f = await agentFixture(t, { runtime: { skills: { userInvokedSkills: [], agentInvokedSkills: ['/skills/review', '/skills/broken'] } }, config: null });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer', { skills: ['/skills/review'], model: 'test/review/model', effort: 'low' }), profile('broken', { skills: ['/skills/broken'], tools: ['missing'] })]));
  await f.start();
  f.ctx.reload = async () => { assert.equal(f.capability().active, 'reviewer'); await f.reloadExtensions(); };

  await f.select('reviewer'); assert.equal(f.capability().active, 'reviewer'); assert.equal(f.entries.length, 0);
  await f.pi.setModel({ provider: 'test', id: 'default' }); f.pi.setThinkingLevel('medium');
  const before = structuredClone(f.entries);
  await assert.rejects(f.select('broken'), /cannot run because Pi does not have its configured tool: missing/);
  assert.deepEqual(f.entries, before); assert.equal(f.capability().active, 'reviewer');
  assert.deepEqual(f.pi.getActiveTools(), ['read']); assert.deepEqual(f.ctx.model, { provider: 'test', id: 'default' }); assert.equal(f.pi.getThinkingLevel(), 'medium');
  assert.deepEqual(await f.emit('resources_discover'), { skillPaths: ['/skills/review'] });
});


for (const mode of ['missing', 'rejected', 'throw-error', 'throw-string']) test(`model selection ${mode} blocks input and preserves the selected agent on failure`, async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer', { model: 'test/review/model' })]));
  await f.start(); const before = structuredClone(f.entries);
  const expected = mode === 'missing' ? 'Agent "reviewer" cannot run because model test/review/model is unavailable' : mode === 'rejected' ? 'Agent "reviewer" cannot authenticate model test/review/model' : 'Agent "reviewer" could not select test/review/model: rejected';

  if (mode === 'missing') f.ctx.modelRegistry.find = () => undefined;
  else f.pi.setModel = async () => { if (mode === 'rejected') return false; throw mode === 'throw-error' ? new Error('rejected') : 'rejected'; };

  await assert.rejects(f.select('reviewer'), { message: expected });
  assert.deepEqual(f.entries, before); assert.equal(f.capability().active, 'general');
  f.entries.push({ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'reviewer' } }); await f.start();
  assert.deepEqual(f.notices.at(-1), { message: expected, level: 'warning' }); assert.deepEqual(f.pi.getActiveTools(), []);
  assert.deepEqual(await f.input('preserve me'), { action: 'handled' });
  assert.deepEqual(JSON.parse(f.statuses.get('piop-input-rejected')), { text: 'preserve me', error: expected });
  assert.deepEqual(f.notices.at(-1), { message: expected, level: 'error' });
});

test('missing prompt files reject input with their resolved path and recover after explicit selection', async t => {
  const f = await agentFixture(t, { config: null });
  await f.load(); await f.start();
  await f.file('absent-system.md', 'Soon gone'); await f.file('absent-agent.md', 'Soon gone');
  await f.configure(configured([profile(), profile('reviewer', { path_systemprompt: 'absent-system.md' }), profile('writer', { path_agent_prompt: 'absent-agent.md' })]));
  await rm(join(f.dir, 'absent-system.md')); await rm(join(f.dir, 'absent-agent.md'));
  await f.select('general');

  for (const [name, kind, file] of [['reviewer', 'system', 'absent-system.md'], ['writer', 'agent', 'absent-agent.md']]) {
    await assert.rejects(f.select(name), error => error.message.startsWith(`Agent "${name}" cannot read ${kind} prompt ${join(f.dir, file)}: ENOENT`));
    assert.equal(f.capability().active, 'general'); assert.deepEqual(f.pi.getActiveTools(), ['read']);
  }

  await f.file('absent-agent.md', 'Now available'); await f.select('writer'); assert.match((await f.prompt()).sections.instructions, /Now available/);
});

test('fast mode validates configured and override models and applies supported selections', async t => {
  const models = ['gpt-5.4', 'no-fast', 'review'].map(id => ({ provider: 'openai', id, api: 'openai-responses' }));
  const f = await agentFixture(t, {
    model: models[0], models,
    config: null,
    realFastMode: { fastModels: { ready: true, providers: { openai: { supportedModelIds: ['gpt-5.4'] } } }, catalog: [
      { slug: 'gpt-5.4', service_tiers: [{ id: 'priority' }] },
      { slug: 'no-fast', service_tiers: [] }, { slug: 'review', service_tiers: [] },
    ] },
  });
  await f.load(); await f.start();
  await f.configure(configured([profile('general', { model: 'openai/gpt-5.4', fastMode: true }), profile('unsupported', { model: 'openai/no-fast', fastMode: true })]));
  await f.select('general');
  assert.deepEqual(await f.emit('before_provider_request', { payload: { input: 'hello' } }), { input: 'hello', service_tier: 'priority' });
  await assert.rejects(f.select('unsupported'), { message: 'Agent "unsupported" cannot enable fast mode because model openai/no-fast does not support it' });
  assert.equal(f.capability().active, 'general');
  assert.equal(f.ctx.model.id, 'gpt-5.4');
  await f.pi.setModel(models[2]);
  assert.deepEqual(await f.input('hello'), { action: 'continue' });
  assert.equal(await f.fastEnabled(), true);
});





test('agent skills include only globally allowed paths after home expansion', async t => {
  const runtime = { enabledTools: ['read', 'bash'] };
  const f = await agentFixture(t, { runtime, config: null });
  runtime.skills = { userInvokedSkills: [], agentInvokedSkills: [join(f.home, 'allowed')] };
  f.ctx.reload = f.reloadExtensions;
  await f.load(); await f.start();
  await f.configure(configured([profile('general', { skills: ['~/allowed', '/blocked'] })]));
  await f.select('general');
  assert.deepEqual(await f.emit('resources_discover'), { skillPaths: ['~/allowed'] });
});

test('configuration edits normalize duplicate profiles and prompt paths', async t => {
  const f = await agentFixture(t, { config: null, files: { 'agent.md': 'Review instructions' } }); await f.load(); await f.start();
  await f.configure({ agents: [profile('reviewer', { model: '', effort: 'high', tools: ['read'], skills: ['/skill'], mcpServers: { remote: remoteMcp }, path_agent_prompt: '  agent.md  ' }), profile('reviewer', { tools: ['bash'] }), profile('default')] });
  const saved = await f.configuration();
  assert.deepEqual(saved.agents.map(agent => agent.name), ['reviewer', 'general']);
  assert.partialDeepStrictEqual(saved.agents[0], {
    name: 'reviewer', model: '', effort: 'high', tools: ['read'], skills: ['/skill'],
    mcpServers: { remote: { command: 'mcp-server', args: [], enabled: true } }, path_agent_prompt: 'agent.md',
  });
});

test('first run creates private defaults and preserves existing prompts (production)', async t => {
  const development = false;
  const env = development ? { PIOP_STORAGE_DIRECTORY: '.piop-dev' } : {};
  const allTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'web_search', 'spawn_subagents'];
  const f = await agentFixture(t, { config: null, env, runtime: { enabledTools: allTools }, tools: allTools, files: { 'home/.agents/AGENTS.md': 'Personal instructions' } });
  await f.load(); const config = await f.configuration();
  const expected = { name: 'general', model: '', effort: development ? 'medium' : 'high', extensions: [], max_subagents: 8, max_sub_subagents: 8, path_systemprompt: '~/.agents/prompts/system/default.md', path_agent_prompt: '~/.agents/AGENTS.md', tools: allTools, skills: [], mcpServers: {} };

  if (development) expected.fastMode = false;
  assert.partialDeepStrictEqual(config.agents[0], expected);
  const system = join(f.home, '.agents/prompts/system/default.md'), agent = join(f.home, '.agents/AGENTS.md');
  assert.match(await readFile(system, 'utf8'), /^You are an expert coding assistant/); assert.equal(await readFile(agent, 'utf8'), 'Personal instructions', 'an existing AGENTS.md is kept');
  assert.equal((await stat(system)).mode & 0o777, 0o600); assert.equal((await stat(join(f.home, '.agents/prompts/system'))).mode & 0o777, 0o700);
  await f.file('home/.agents/prompts/system/default.md', 'Custom system'); await f.file('home/.agents/AGENTS.md', 'Custom agent');
  await f.reloadExtensions(); assert.equal(await readFile(system, 'utf8'), 'Custom system'); assert.equal(await readFile(agent, 'utf8'), 'Custom agent');
});

test('first run creates private defaults and preserves existing prompts (development)', async t => {
  const development = true;
  const env = development ? { PIOP_STORAGE_DIRECTORY: '.piop-dev' } : {};
  const allTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'web_search', 'spawn_subagents'];
  const f = await agentFixture(t, { config: null, env, runtime: { enabledTools: allTools }, tools: allTools, files: { 'home/.agents/AGENTS.md': 'Personal instructions' } });
  await f.load(); const config = await f.configuration();
  const expected = { name: 'general', model: '', effort: development ? 'medium' : 'high', extensions: [], max_subagents: 8, max_sub_subagents: 8, path_systemprompt: '~/.agents/prompts/system/default.md', path_agent_prompt: '~/.agents/AGENTS.md', tools: allTools, skills: [], mcpServers: {} };

  if (development) expected.fastMode = false;
  assert.partialDeepStrictEqual(config.agents[0], expected);
  const system = join(f.home, '.agents/prompts/system/default.md'), agent = join(f.home, '.agents/AGENTS.md');
  assert.match(await readFile(system, 'utf8'), /^You are an expert coding assistant/); assert.equal(await readFile(agent, 'utf8'), 'Personal instructions', 'an existing AGENTS.md is kept');
  assert.equal((await stat(system)).mode & 0o777, 0o600); assert.equal((await stat(join(f.home, '.agents/prompts/system'))).mode & 0o777, 0o700);
  await f.file('home/.agents/prompts/system/default.md', 'Custom system'); await f.file('home/.agents/AGENTS.md', 'Custom agent');
  await f.reloadExtensions(); assert.equal(await readFile(system, 'utf8'), 'Custom system'); assert.equal(await readFile(agent, 'utf8'), 'Custom agent');
});

test('legacy prompts retain their content in editable prompt files', async t => {
  const legacy = { name: 'default', description: 'obsolete', systemPrompt: 'System', developerPrompt: 'Developer', agentsMd: 'Agent notes', tools: [], skills: [], mcpServers: {} };
  const f = await agentFixture(t, { config: { agents: [legacy, { ...legacy, name: ' Reviewer!! ', systemPrompt: '' }] }, runtime: { enabledTools: [] } });
  await f.load();
  const config = await f.configuration();
  assert.deepEqual(config.agents.map(a => a.name), ['general', ' Reviewer!! ', 'workhorse']);
  assert.equal(await readFile(join(f.dir, config.agents[0].path_systemprompt), 'utf8'), 'System\n\nDeveloper');
  assert.match(await readFile(join(f.dir, config.agents[1].path_systemprompt), 'utf8'), /^You are an expert coding assistant[\s\S]*\n\nDeveloper$/);
  for (const agent of config.agents.slice(0, 2)) {
    assert.equal(await readFile(join(f.dir, agent.path_agent_prompt), 'utf8'), 'Agent notes');
    for (const field of ['systemPrompt', 'developerPrompt', 'agentsMd']) assert.equal(field in agent, false);
  }
});

test('invalid configuration and filesystem failures surface instead of silently resetting user settings', async t => {
  const f = await agentFixture(t); f.corruptConfig('{bad'); await assert.rejects(f.load(), SyntaxError);
  assert.equal(f.rawConfig(), '{bad');

  for (const name of ['sessions.sqlite', 'sessions.sqlite-wal', 'sessions.sqlite-shm']) await rm(join(f.dir, name), { force: true });
  await mkdir(join(f.dir, 'sessions.sqlite')); await assert.rejects(f.load(), /Settings database is not a regular file/);
  await rm(join(f.dir, 'sessions.sqlite'), { recursive: true }); await f.file('config.json', JSON.stringify(configured([profile('general', { path_agent_prompt: '~/.agents/AGENTS.md' })])));
  await f.load(); await rm(join(f.home, '.agents/AGENTS.md')); await mkdir(join(f.home, '.agents/AGENTS.md'));
  await f.start(); assert.match(f.notices.at(-1).message, /cannot read agent prompt .*AGENTS\.md: EISDIR/); assert.deepEqual(await f.input('hello'), { action: 'handled' });
});

test('legacy migration skips null entries and empty names while retaining a general profile', async t => {
  const f = await agentFixture(t, { config: { agents: [{ name: 'default', tools: [] }, null, { name: '' }, { name: 7 }] } });
  await f.load(); const config = await f.configuration();
  assert.deepEqual(config.agents.map(agent => agent.name), ['general', 'workhorse']);
  assert.equal(config.agents[0].path_systemprompt, '~/.agents/prompts/system/default.md');
  assert.equal(config.agents[0].path_agent_prompt, '');
});

test('prompt migration preserves intentional emptiness and distinguishes names and contents', async t => {
  const f = await agentFixture(t, { config: { agents: [
    { name: 'general', systemPrompt: '', agentsMd: '   ', tools: [] },
    { name: 'one', systemPrompt: 'Same', developerPrompt: '   ', tools: [] },
    { name: 'two', systemPrompt: 'Same', developerPrompt: 7, agentsMd: 'Notes', tools: [] },
    { name: '!!!', developerPrompt: 'Additional', tools: [] },
    { name: 'explicit', path_systemprompt: 'prompt.md', path_agentprompt: '', systemPrompt: 'Ignore this', agentsMd: 'Ignore this too', tools: [] },
  ] } });

  await f.load(); const agents = (await f.configuration()).agents;
  assert.equal(await readFile(join(f.dir, agents[0].path_systemprompt), 'utf8'), '');
  assert.equal(agents[0].path_agent_prompt, '');
  assert.notEqual(agents[1].path_systemprompt, agents[2].path_systemprompt);
  assert.equal(await readFile(join(f.dir, agents[1].path_systemprompt), 'utf8'), 'Same');
  assert.equal(await readFile(join(f.dir, agents[2].path_systemprompt), 'utf8'), 'Same');
  assert.equal(agents[1].path_agent_prompt, ''); assert.equal(await readFile(join(f.dir, agents[2].path_agent_prompt), 'utf8'), 'Notes');
  assert.match(agents[3].path_systemprompt, /^sysprompt\/tool-/);
  assert.match(await readFile(join(f.dir, agents[3].path_systemprompt), 'utf8'), /\n\nAdditional$/);
  assert.equal(agents[4].path_systemprompt, 'prompt.md'); assert.equal(agents[4].path_agent_prompt, '');
});

test('legacy normalization supplies defaults for absent arrays and filters malformed profiles without dropping valid fields', async t => {
  const f = await agentFixture(t);
  const full = profile('reviewer', { model: ' test/review/model ', effort: ' low ', fastMode: false, extensions: [], tools: null, skills: null, mcpServers: undefined, path_agent_prompt: 7 });
  await f.file('config.json', JSON.stringify({ ...configured([]), agents: [null, false, {}, { name: '' }, { name: 7 }, full, profile('default')] }));
  await f.load(); await f.start();
  const config = await f.configuration(), reviewer = config.agents[0];
  assert.deepEqual(config.agents.map(agent => agent.name), ['reviewer', 'general']);
  assert.equal(reviewer.model, full.model); assert.equal(reviewer.effort, full.effort); assert.equal(reviewer.fastMode, false);
  assert.deepEqual(reviewer.tools, ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']); assert.deepEqual(reviewer.skills, []); assert.deepEqual(reviewer.mcpServers, {}); assert.equal(reviewer.path_agent_prompt, '');
  await f.select('reviewer'); assert.equal(f.ctx.model.id, 'review/model'); assert.equal(f.pi.getThinkingLevel(), 'low');
});

for (const state of ['not JSON', { model: 7, effort: 'low' }, { model: 'test/review/model', effort: 7 }]) test(`runtime defaults reject stale or malformed cache ${JSON.stringify(state)}`, async t => {
  const f = await agentFixture(t, { config: null });

  if (state !== undefined) process.env.PI_DEFINE_AGENTS_RUNTIME_DEFAULTS = state === 'not JSON' ? state : JSON.stringify({ session: join(f.dir, 'session'), ...state });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer', { model: 'test/review/model', effort: 'low' })]));
  await f.start();
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'default' });
  assert.equal(f.pi.getThinkingLevel(), 'high');
  await f.select('reviewer');
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'review/model' });
  assert.equal(f.pi.getThinkingLevel(), 'low');
  await f.select('general');
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'default' });
  assert.equal(f.pi.getThinkingLevel(), 'high');
});

test('a new root session starts as the flagged agent, and a session with a stored agent keeps it', async t => {
  const config = configured([profile(), profile('reviewer', { isDefault: true })]);
  const f = await agentFixture(t, { config });
  await f.load(); await f.start();
  assert.equal(f.capability().active, 'reviewer');

  const g = await agentFixture(t, { config, entries: [{ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'general' } }] });
  await g.load(); await g.start();
  assert.equal(g.capability().active, 'general');
});

test('general becomes the default when no agent has the flag, and two flags are rejected', async t => {
  const f = await agentFixture(t, { config: configured([profile(), profile('reviewer')]) });
  await f.load(); await f.start();
  assert.equal(f.capability().active, 'general');
  assert.deepEqual(f.capability().config.agents.map(agent => agent.isDefault), [true, undefined]);

  const g = await agentFixture(t, { config: configured([profile('general', { isDefault: true }), profile('reviewer', { isDefault: true })]) });
  await assert.rejects(g.load(), /Only one agent can be the default/);
});

const chosenConfig = () => configured([profile('general', { skills: ['/general-skill'] }), profile('chosen', { isDefault: true, skills: ['/chosen-skill'], model: 'openai/gpt-5.4', fastMode: true })]);
const fastModel = { provider: 'openai', id: 'gpt-5.4', api: 'openai-responses' };
const fastCatalog = [{ slug: 'gpt-5.4', service_tiers: [{ id: 'priority' }] }];

for (const agentFirst of [false, true]) {
  test(`a new session loads the default agent's skills and fast mode on its first turn (${agentFirst ? 'agents' : 'fast mode'} loads first)`, async t => {
    const f = await agentFixture(t, { config: chosenConfig(), model: fastModel, models: [fastModel], realFastMode: { agentFirst, catalog: fastCatalog } });
    await f.load();
    assert.deepEqual(await f.emit('resources_discover', {}), { skillPaths: ['/chosen-skill'] });
    await f.start();
    assert.equal(f.capability().active, 'chosen');
    assert.equal(await f.fastEnabled(), true);
    assert.deepEqual(await f.emit('resources_discover', {}), { skillPaths: ['/chosen-skill'] });
    assert.deepEqual(f.notices, []);
  });
}

test('a resumed session keeps its saved agent, skills and fast mode choice instead of the default agent', async t => {
  const f = await agentFixture(t, {
    config: chosenConfig(), model: fastModel, models: [fastModel], realFastMode: { agentFirst: false, catalog: fastCatalog },
    entries: [{ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'chosen', locked: true } }, { type: 'custom', customType: 'piop-fast-mode-state', data: { enabled: false } }],
  });
  await f.load();
  assert.deepEqual(await f.emit('resources_discover', {}), { skillPaths: ['/chosen-skill'] });
  await f.start();
  assert.equal(f.capability().active, 'chosen');
  assert.equal(await f.fastEnabled(), false);

  const g = await agentFixture(t, { config: chosenConfig(), entries: [{ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'general' } }] });
  await g.load();
  assert.deepEqual(await g.emit('resources_discover', {}), { skillPaths: ['/general-skill'] });
  await g.start();
  assert.equal(g.capability().active, 'general');
});

test('a new session whose default agent uses another model than the runtime starts when agents loads before fast mode', async t => {
  const initial = { provider: 'openai', id: 'initial', api: 'openai-responses' };
  const chosen = { provider: 'openai', id: 'chosen', api: 'openai-responses' };
  const f = await agentFixture(t, {
    config: configured([profile(), profile('chosen', { isDefault: true, model: 'openai/chosen', fastMode: true })]), model: initial, models: [initial, chosen],
    realFastMode: { agentFirst: true, catalog: [{ slug: 'initial', service_tiers: [{ id: 'priority' }] }, { slug: 'chosen', service_tiers: [{ id: 'priority' }] }] },
  });
  await f.load();
  let timer;
  const started = await Promise.race([f.start().then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); })]).finally(() => clearTimeout(timer));
  assert.equal(started, true);
  assert.deepEqual(f.modelSelections.map(model => model.id), ['chosen']);
  assert.equal(f.capability().active, 'chosen');
  assert.equal(await f.fastEnabled(), true);
  assert.deepEqual(f.notices, []);
});

test('manual model and effort defaults survive extension reload', async t => {
  const f = await agentFixture(t, { config: null });
  await f.load(); await f.start();
  await f.configure(configured([profile(), profile('reviewer', { model: 'test/default', effort: 'medium' })]));
  await f.select('general');
  await f.pi.setModel({ provider: 'test', id: 'review/model' });
  f.pi.setThinkingLevel('low');
  await f.select('reviewer');
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'default' });
  assert.equal(f.pi.getThinkingLevel(), 'medium');

  await f.reloadExtensions();
  await f.select('general');
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'review/model' });
  assert.equal(f.pi.getThinkingLevel(), 'low');
});

test('session restore uses the latest state, ignores unrelated custom records, and handles version changes', async t => {
  const f = await agentFixture(t, { config: null, entries: [
    { type: 'custom', customType: 'pi-define-agents-state', data: { active: 'missing', locked: true } },
    { type: 'custom', customType: 'pi-define-agents-state', data: { active: 'default', snapshot: { version: 2, definition: { name: 'missing' } } } },
    { type: 'custom', customType: 'other', data: { active: 'missing' } },
    { type: 'message', message: { role: 'assistant' } },
  ] });

  await f.load(); await f.start(); assert.equal(f.capability().active, 'missing'); assert.equal(f.capability().locked, true);
  assert.deepEqual(await f.input('hello'), { action: 'handled' });
  await assert.rejects(f.select('general'), /agent is fixed/);
  assert.equal(f.capability().unavailable, true);
  assert.deepEqual(f.pi.getActiveTools(), []);
  assert.deepEqual(JSON.parse(f.statuses.get('piop-input-rejected')), { text: 'hello', error: 'Agent "missing" is unavailable. This conversation cannot start.' });
  f.entries.length = 0; f.entries.push({ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'missing' } });
  await f.start(); assert.equal(f.capability().unavailable, true); assert.equal(f.capability().saved, false); assert.deepEqual(await f.prompt(), {}); assert.equal(await f.emit('resources_discover'), undefined);
  const request = { ctx: f.ctx }; f.pi.events.emit('piop:agents:refresh', request); await request.ready; assert.deepEqual(f.pi.getActiveTools(), []);
  assert.deepEqual(f.notices.at(-1), { message: 'Agent "missing" is unavailable. This conversation cannot start.', level: 'warning' });
});

test('tool validation reports each configured tool that Pi does not have once', async t => {
  const f = await agentFixture(t, { tools: ['read', 'bash'], runtime: { enabledTools: ['read', 'unknown'] }, config: null });
  await f.load();
  await f.configure(configured([profile('general', { tools: ['bash', 'unknown', 'bash'] })]));
  await f.start();
  assert.deepEqual(f.pi.getActiveTools(), []);
  assert.equal(f.notices.at(-1).message, 'Agent "general" cannot run because Pi does not have its configured tool: unknown');
  assert.deepEqual(await f.input('blocked'), { action: 'handled' });
});

test('extension tools bypass the global builtin allow-list and remain available after refresh', async t => {
  const f = await agentFixture(t, { runtime: { enabledTools: ['read'] }, config: null, files: { 'extra.mjs': 'export default pi => pi.registerTool({ name: "extra", execute: async () => "ok" });' } });
  await f.load();
  await f.configure(configured([profile('general', { extensions: ['extra.mjs'], tools: ['read', 'extra'] })]));
  await f.start(); assert.deepEqual(f.pi.getActiveTools(), ['read', 'extra']);
  assert.equal(await f.tools.get('extra').execute(), 'ok');
  const request = { ctx: f.ctx }; f.pi.events.emit('piop:agents:refresh', request); await request.ready; assert.deepEqual(f.pi.getActiveTools(), ['read', 'extra']);
  assert.equal(await f.tools.get('extra').execute(), 'ok');
});

test('a read-only settings directory rejects edits and preserves saved and running profiles', async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  await f.configure(configured([profile(), profile('reviewer')]));
  await f.start();
  const before = await f.configuration();
  const paths = [f.dir, ...(await readdir(f.dir, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => join(f.dir, entry.name))];
  const permissions = await Promise.all(paths.map(async path => [path, (await stat(path)).mode & 0o777]));
  try {
    for (const [path, mode] of permissions) await chmod(path, mode & ~0o222);
    await assert.rejects(f.configure({ agents: [profile('replacement', { tools: ['bash'] })] }), error => error.code === 'EACCES');
  } finally {
    for (const [path, mode] of permissions) await chmod(path, mode);
  }
  assert.deepEqual(await f.configuration(), before);
  assert.equal(f.capability().active, 'general');
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
  assert.equal((await f.prompt()).customPrompt, 'System instructions');
  await f.configure({ agents: [profile('replacement', { tools: ['bash'] })] });
  await f.select('replacement');
  assert.deepEqual(f.pi.getActiveTools(), ['bash']);
});


test('explicit general and default profiles remain distinct', async t => {
    const f = await agentFixture(t, { config: null, entries: [{ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'default' } }] });
    await f.load();
    await f.configure(configured([profile('default'), profile('general')]));
    await f.start(); assert.equal(f.capability().active, 'default');
    assert.deepEqual(f.capability().config.agents.map(agent => agent.name), ['default', 'general']);
});

test('equivalent skill sets avoid unnecessary reloads after normalization and sorting', async t => {
  const f = await agentFixture(t, { runtime: { skills: { userInvokedSkills: [], agentInvokedSkills: ['/skills/b', '~/skills/a'] } }, config: null });
  await f.load();
  await f.configure(configured([profile('general', { skills: ['/skills/b', '~/skills/a', '/skills/b'] }), profile('reviewer', { skills: ['~/skills/a', '/skills/b'] })]));
  await f.start(); await f.select('reviewer');
  assert.equal(f.capability().active, 'reviewer');
});



test('fresh sessions recognize conversational history but ignore tool messages and unrelated custom entries', async t => {
  for (const [entry, locked] of [[{ type: 'message', message: { role: 'user' } }, true], [{ type: 'message', message: { role: 'assistant' } }, true], [{ type: 'compaction' }, true], [{ type: 'message', message: { role: 'toolResult' } }, false], [{ type: 'custom', customType: 'unrelated', data: { locked: true } }, false]]) await t.test(JSON.stringify(entry), async t => {
    const f = await agentFixture(t, { config: null, entries: [entry] }); await f.load(); await f.start(); assert.equal(f.capability().locked, locked);
    const states = () => f.entries.filter(item => item.customType === 'pi-define-agents-state');
    assert.equal(states().length, locked ? 1 : 0);
    await f.input('hello'); assert.equal(states().length, 1); assert.equal(f.capability().locked, true);
    await f.input('again'); assert.equal(states().length, 1);
  });
});

test('tool migration adds missing defaults without removing explicit builtin choices', async t => {
  const runtime = { enabledTools: ['web_search', 'spawn_subagents'] };
  const f = await agentFixture(t, { runtime, config: { agents: [profile('general', { tools: ['read'] }), profile('reviewer', { tools: ['web_search'] })] } });
  await f.load();
  const saved = await f.configuration();
  assert.deepEqual(saved.agents[0].tools, ['read', 'spawn_subagents', 'web_search']);
  assert.deepEqual(saved.agents[1].tools, ['web_search', 'spawn_subagents']);
});

test('an unreadable inherited agent prompt does not silently become an empty prompt', async t => {
  const f = await agentFixture(t, { config: null }); await mkdir(join(f.home, '.agents/AGENTS.md'), { recursive: true });
  await f.load(); await f.start();
  assert.match(f.notices.at(-1).message, /Agent "general" cannot read agent prompt .*\.agents\/AGENTS\.md: EISDIR/);
  assert.deepEqual(f.pi.getActiveTools(), []); assert.deepEqual(await f.input('hello'), { action: 'handled' });
});

test('absolute and home-relative prompt paths retain system whitespace and omit blank agent instructions', async t => {
  const f = await agentFixture(t, { config: null, files: { 'home/system.md': '  System\n', 'home/agent.md': '   ' } });
  await f.load();
  await f.configure(configured([profile('general', { path_systemprompt: '~/system.md', path_agent_prompt: '~/agent.md' })]));
  await f.start(); assert.deepEqual(await f.prompt(), { customPrompt: '  System\n', sections: { instructions: '' }, contextFiles: [], appendSystemPrompt: '', skills: undefined });
  await f.configure(configured([profile('general', { path_systemprompt: join(f.home, 'system.md'), path_agent_prompt: '' })]));
  await f.select('general'); assert.deepEqual(await f.prompt({ selectedTools: [], appendSystemPrompt: '' }), { selectedTools: [], customPrompt: '  System\n', sections: { instructions: '' }, contextFiles: [], appendSystemPrompt: '', skills: undefined });
});

test('reading current configurations preserves the saved revision', async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  const saved = await f.configure({ agents: [profile(), profile('default')] });
  assert.equal(typeof saved.revision, 'string');
  assert.equal((await f.configuration()).revision, saved.revision);
  await f.reloadExtensions();
  const reloaded = await f.configuration();
  assert.equal(reloaded.revision, saved.revision);
  assert.deepEqual(reloaded.agents.map(agent => agent.name), ['general', 'default']);
});

test('saving with a stale revision is rejected until the latest configuration is reloaded', async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  const stale = (await f.configuration()).revision;
  await f.configure(configured([profile(), profile('writer')]));
  const newer = await f.configuration();

  await assert.rejects(f.configure({ ...configured([profile(), profile('stale-writer')]), revision: stale }), { message: 'Agent definitions changed in another window or client. Reload them before saving.' });
  assert.deepEqual(await f.configuration(), newer);

  const latest = await f.configuration();
  const saved = await f.configure({ ...configured([profile(), profile('writer'), profile('editor')]), revision: latest.revision });
  assert.notEqual(saved.revision, latest.revision);
  assert.deepEqual((await f.configuration()).agents.map(agent => agent.name), ['general', 'writer', 'editor']);
});


test('loading a saved configuration preserves configured choices', async t => {
  const winner = configured([profile('general', { effort: 'medium' })]);
  const f = await agentFixture(t, { config: winner });
  await f.load();
  assert.partialDeepStrictEqual(await f.config(), winner);
  assert.equal((await f.configuration()).agents.length, 1);
  await f.start(); assert.equal(f.pi.getThinkingLevel(), 'medium');
  assert.equal((await readdir(f.dir)).some(name => name.endsWith('.tmp')), false);
});



test('agent-specific effort never replaces the runtime default when the user changes model', async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer', { effort: 'low' })]));
  await f.start(); await f.select('reviewer'); assert.equal(f.pi.getThinkingLevel(), 'low');
  await f.pi.setModel({ provider: 'test', id: 'review/model' });
  await f.select('general'); assert.equal(f.pi.getThinkingLevel(), 'high');
});


test('startup publishes the selected definition before asynchronous model selection completes', async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  await f.configure(configured([profile('general', { model: 'test/review/model' })]));
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  f.pi.setModel = async model => { started.resolve(); await gate.promise; f.ctx.model = model; await f.emit('model_select', { model });

  return true; };

  const pending = f.start(); let timer;

  try { await Promise.race([started.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Model was not selected')), 1000); })]); assert.equal(f.capability().active, 'general'); }
  finally { clearTimeout(timer); gate.resolve(); await pending; }

  assert.equal(f.capability().saved, true);
});



test('session restore selects the last matching custom record and preserves its lock without message history', async t => {
  const f = await agentFixture(t, { config: null, files: { 'reviewer.md': 'Review the proposed change.' }, entries: [
    { type: 'custom', customType: 'pi-define-agents-state', data: { active: 'general' } },
    { type: 'custom', customType: 'pi-define-agents-state', data: { active: 'reviewer', locked: true } },
    { type: 'custom', customType: 'unrelated', data: { active: 'general', locked: false } },
    { type: 'other', customType: 'pi-define-agents-state', data: { active: 'general' } },
  ] });

  await f.load();
  await f.configure(configured([profile(), profile('reviewer', { path_systemprompt: 'reviewer.md' })]));
  await f.start();
  assert.equal(f.capability().active, 'reviewer'); assert.equal(f.capability().locked, true);
  const count = f.entries.length;
  assert.equal((await f.prompt()).customPrompt, 'Review the proposed change.');
  await f.input('go'); await f.input('again'); assert.equal(f.entries.length, count);
});

test('agent RPC uses exact names and rejects encoded or unknown names without exposing internal slash commands', async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  await f.configure(configured([profile(), profile('reviewer')]));
  await f.start();
  assert.equal(f.commands.has('pi-define-agents-use'), false); assert.equal(f.commands.has('pi-define-agents-config'), false);
  await f.select('reviewer'); assert.equal(f.capability().active, 'reviewer');
  await assert.rejects(f.select(' reviewer '), /Unknown defined agent/);
  await assert.rejects(f.select(encoded({ name: 'general' })), { message: `Unknown defined agent: ${encoded({ name: 'general' })}` });
});

test('new default profiles retain available session tools after one-time migrations are finished', async t => {
  const tools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'web_search', 'spawn_subagents'];
  const model = { provider: 'openai', id: 'gpt-5.4', api: 'openai-responses' };
  const f = await agentFixture(t, { config: null, runtime: { enabledTools: tools }, tools, model, models: [model], realFastMode: { catalog: [] } });
  await f.load(); await f.start(); await f.configure({ agents: [] });
  assert.deepEqual((await f.configuration()).agents[0].tools, ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'web_search', 'spawn_subagents']);
});



test('shutdown stops extension event responses', async t => {
  const f = await agentFixture(t, { config: null, files: { 'extra.mjs': 'export default pi => pi.events.on("test:ping", () => pi.appendEntry("ping", {}));' } });
  await f.load();
  await f.configure(configured([profile('general', { extensions: ['extra.mjs'] })]));
  await f.start(); f.pi.events.emit('test:ping', {}); assert.equal(f.entries.at(-1).customType, 'ping');
  await f.emit('session_shutdown'); const count = f.entries.length; f.pi.events.emit('test:ping', {}); assert.equal(f.entries.length, count);
});

test('configuration errors identify the invalid field instead of leaking incidental type errors', async t => {
  const f = await agentFixture(t, { config: null }); await f.load();

  for (const path_systemprompt of [null, 7, false]) await assert.rejects(f.configure(configured([profile('bad', { path_systemprompt })])), /Invalid agent configuration:.*path_systemprompt/);

  for (const path_systemprompt of ['', '   ']) await assert.rejects(f.configure(configured([profile('bad', { path_systemprompt })])), { message: 'Agent "bad" requires a nonempty path_systemprompt' });

  for (const field of ['systemPrompt', 'developerPrompt']) await assert.rejects(f.configure(configured([profile('bad', { [field]: 'inline' })])), { message: 'Agent "bad" must link a system prompt file using path_systemprompt' });
  await assert.rejects(f.configure(configured([profile('bad', { fastMode: 'yes' })])), /Invalid agent configuration:.*fastMode/);
});

test('adding profiles supplies a missing general profile and inherited agent prompt paths', async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  await f.configure(configured([profile('reviewer')])); assert.deepEqual((await f.configuration()).agents.map(agent => agent.name), ['general', 'reviewer']);

  for (const name of ['general', 'default']) {
    const agent = profile(name, { path_agent_prompt: '~/.agents/AGENTS.md' });
    await f.configure(configured([agent])); assert.equal((await f.configuration()).agents[0].path_agent_prompt, '~/.agents/AGENTS.md');
  }
});

test('renaming a legacy default is persisted even when every other field is current', async t => {
  const f = await agentFixture(t, { config: configured([profile('default')]) }); await f.load();
  assert.deepEqual((await f.configuration()).agents.map(agent => agent.name), ['general']);
});

test('legacy prompt type errors and whitespace fall back to the default system prompt', async t => {
  const f = await agentFixture(t, { config: { agents: [
    { name: 'general', systemPrompt: 7, tools: [] },
    { name: 'reviewer', systemPrompt: '   ', developerPrompt: 'Additional', tools: [] },
  ] } });

  await f.load(); const agents = (await f.configuration()).agents;
  assert.equal(agents[0].path_systemprompt, '~/.agents/prompts/system/default.md');
  assert.match(await readFile(join(f.dir, agents[1].path_systemprompt), 'utf8'), /^You are an expert coding assistant[\s\S]*\n\nAdditional$/);
  assert.equal(await readFile(join(f.home, '.agents/AGENTS.md'), 'utf8'), '');
});



test('fast-mode preflight rejects unsupported models before attempting to load extensions', async t => {
  const models = ['gpt-5.4', 'unsupported'].map(id => ({ provider: 'openai', id, api: 'openai-responses' }));
  const f = await agentFixture(t, {
    model: models[0], models,
    config: null,
    realFastMode: { catalog: [{ slug: 'gpt-5.4', service_tiers: [{ id: 'priority' }] }, { slug: 'unsupported', service_tiers: [] }] },
  });
  await f.load();
  await f.configure(configured([profile(), profile('fast', { fastMode: true }), profile('unsupported', { fastMode: true, model: 'openai/unsupported', extensions: ['missing.mjs'] })]));
  await f.start();
  await f.select('fast');
  assert.equal(f.capability().active, 'fast');
  assert.deepEqual(await f.emit('before_provider_request', { payload: { input: 'hello' } }), { input: 'hello', service_tier: 'priority' });
  await assert.rejects(f.select('unsupported'), { message: 'Agent "unsupported" cannot enable fast mode because model openai/unsupported does not support it' });
  assert.equal(f.capability().active, 'fast');
});

test('fast-mode model names are trimmed consistently during preflight and activation', async t => {
  const model = { provider: 'openai', id: 'gpt-5.4', api: 'openai-responses' };
  const f = await agentFixture(t, {
    model, models: [model], config: null,
    realFastMode: { catalog: [{ slug: 'gpt-5.4', service_tiers: [{ id: 'priority' }] }] },
  });
  await f.load();
  await f.configure(configured([profile('general', { model: ' openai/gpt-5.4 ', fastMode: true })]));
  await f.start();
  assert.deepEqual(f.notices, []); assert.deepEqual(f.pi.getActiveTools(), ['read']);
  await f.select('general');
  assert.equal(f.ctx.model.provider, 'openai'); assert.equal(f.ctx.model.id, 'gpt-5.4');
  assert.equal(await f.fastEnabled(), true);
  assert.deepEqual(await f.emit('before_provider_request', { payload: { input: 'hello' } }), { input: 'hello', service_tier: 'priority' });
});

test('an implicit general profile keeps the configuration revision stable across session start and reload', async t => {
  const f = await agentFixture(t, { config: configured([profile('reviewer')]) });
  await f.load();
  const before = await f.configuration();
  assert.equal(typeof before.revision, 'string');
  assert.ok(before.revision.length > 0);
  assert.deepEqual(before.agents.map(agent => agent.name), ['general', 'reviewer']);

  await f.start();
  assert.deepEqual(await f.configuration(), before);
  await f.reloadExtensions();
  assert.deepEqual(await f.configuration(), before);
  assert.deepEqual(f.capability().config.agents.map(agent => agent.name), ['general', 'reviewer']);
});

test('null historical agent state does not hide the latest valid selection', async t => {
  const f = await agentFixture(t, { config: null, entries: [{ type: 'custom', customType: 'pi-define-agents-state', data: null }, { type: 'custom', customType: 'pi-define-agents-state', data: { active: 'reviewer' } }] });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer')]));
  await f.start(); assert.equal(f.capability().active, 'reviewer'); assert.equal(f.capability().locked, false);
});

test('initial resource discovery exposes the general agents skills before session startup', async t => {
  const f = await agentFixture(t, { runtime: { skills: { userInvokedSkills: [], agentInvokedSkills: ['/startup-skill'] } }, config: null });
  await f.load();
  await f.configure(configured([profile('general', { skills: ['/startup-skill'] })]));
  assert.deepEqual(await f.emit('resources_discover'), { skillPaths: ['/startup-skill'] });
});

test('migrated agent prompts with ambiguous name/content boundaries never share a file', async t => {
  const f = await agentFixture(t, { config: { agents: [
    { name: 'a', path_systemprompt: 'prompt.md', agentsMd: '!bc', tools: [] },
    { name: 'a!', path_systemprompt: 'prompt.md', agentsMd: 'bc', tools: [] },
  ] } });

  await f.load(); const agents = (await f.configuration()).agents.filter(agent => agent.name !== 'general');
  assert.notEqual(agents[0].path_agent_prompt, agents[1].path_agent_prompt);
  assert.equal(await readFile(join(f.dir, agents[0].path_agent_prompt), 'utf8'), '!bc'); assert.equal(await readFile(join(f.dir, agents[1].path_agent_prompt), 'utf8'), 'bc');
});

test('first-run exclusive file collision is reported and can be retried', async t => {
  const adapter = `export * from 'node:fs/promises';
    import { open as actualOpen, writeFile, constants } from 'node:fs/promises';
    let injected = false;
    export async function open(path, flags, mode) {
      const exclusive = typeof flags === 'number' ? flags & constants.O_EXCL : flags.includes('x');
      if (!injected && exclusive) {
        injected = true;
        await writeFile(path, 'competing writer');
      }
      return actualOpen(path, flags, mode);
    }`;
  const f = await agentFixture(t, { config: null, files: { 'fs.mjs': adapter } });
  await assert.rejects(f.load(), { code: 'EEXIST' });

  await f.load(); await f.start();
  assert.equal(f.capability().active, 'general');
  assert.equal((await f.configuration()).agents[0].name, 'general');
  assert.match((await f.prompt()).customPrompt, /^You are an expert coding assistant/);
  assert.deepEqual(f.notices, []);
});

test('first-run prompt write denial is reported and loading succeeds after access returns', async t => {
  const adapter = `export * from 'node:fs/promises';
    import { open as actualOpen, constants } from 'node:fs/promises';
    let denied = true;
    export function allowWrites() { denied = false; }
    export async function open(path, flags, mode) {
      const writing = typeof flags === 'number' ? flags & (constants.O_WRONLY | constants.O_RDWR) : /[wa+]/.test(flags);
      if (denied && writing) throw Object.assign(new Error('fixture prompt write denied'), { code: 'EACCES' });
      return actualOpen(path, flags, mode);
    }`;
  const f = await agentFixture(t, { config: null, files: { 'fs.mjs': adapter } });
  await assert.rejects(f.load(), { message: 'fixture prompt write denied', code: 'EACCES' });

  (await import(pathToFileURL(join(f.dir, 'fs.mjs')))).allowWrites();
  await f.load(); await f.start();
  assert.equal(f.capability().active, 'general');
  assert.equal((await f.configuration()).agents[0].name, 'general');
  assert.match((await f.prompt()).customPrompt, /^You are an expert coding assistant/);
  assert.deepEqual(f.notices, []);
});

test('a denied storage write preserves the original error and the saved agent configuration', async t => {
  const fs = (await import('node:fs')).default;
  const f = await agentFixture(t, { config: null }); await f.load(); await f.start();
  const before = await f.configuration();
  const capability = structuredClone(f.capability());
  const actualOpen = fs.openSync;
  const denied = Object.assign(new Error('fixture settings write denied'), { code: 'EACCES' });
  const opening = t.mock.method(fs, 'openSync', (path, flags, ...args) => {
    if (String(path).startsWith(f.dir + '/') && (typeof flags === 'number' ? flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR) : /[wa+]/.test(flags))) throw denied;
    return actualOpen(path, flags, ...args);
  });
  try {
    await assert.rejects(f.configure(configured([profile('general', { effort: 'low' })])), error => error === denied);
  } finally { opening.mock.restore(); }
  assert.deepEqual(await f.configuration(), before);
  assert.deepEqual(f.capability(), capability);
  await f.configure(configured([profile('general', { effort: 'low' })]));
  assert.equal((await f.configuration()).agents[0].effort, 'low');
});

test("an agent description is saved trimmed, and one over 500 characters is rejected", async t => {
  const f = await agentFixture(t, { config: configured([profile('general', { description: '  Finds files.  ' })]) });
  await f.load(); const saved = await f.configuration();
  assert.equal(saved.agents[0].description, 'Finds files.');
  await assert.rejects(f.configure(configured([profile('general', { description: 'x'.repeat(501) })])), /description is 501 characters; the limit is 500/);
  assert.equal((await f.configuration()).agents[0].description, 'Finds files.');
});

test("legacy systemPrompt is removed from the published profile without changing prompt paths", async t => {
  const f = await agentFixture(t, { config: configured([profile('general', { systemPrompt: 'old value' })]) });
  await f.load(); const saved = await f.configuration();
  assert.equal('systemPrompt' in saved.agents[0], false);
  assert.equal(saved.agents[0].path_systemprompt, 'prompt.md');
  assert.equal(saved.agents[0].path_agent_prompt, '');
});

test("legacy developerPrompt is removed from the published profile without changing prompt paths", async t => {
  const f = await agentFixture(t, { config: configured([profile('general', { developerPrompt: 'old value' })]) });
  await f.load(); const saved = await f.configuration();
  assert.equal('developerPrompt' in saved.agents[0], false);
  assert.equal(saved.agents[0].path_systemprompt, 'prompt.md');
  assert.equal(saved.agents[0].path_agent_prompt, '');
});

test("legacy agentsMd is removed from the published profile without changing prompt paths", async t => {
  const f = await agentFixture(t, { config: configured([profile('general', { agentsMd: 'old value' })]) });
  await f.load(); const saved = await f.configuration();
  assert.equal('agentsMd' in saved.agents[0], false);
  assert.equal(saved.agents[0].path_systemprompt, 'prompt.md');
  assert.equal(saved.agents[0].path_agent_prompt, '');
});

test("missing path_systemprompt receives its default independently", async t => {
  const agent = profile(); delete agent.path_systemprompt;
  const f = await agentFixture(t, { config: configured([agent]) });
  await f.load(); const saved = await f.configuration();
  assert.equal(saved.agents[0].path_systemprompt, "~/.agents/prompts/system/default.md");
});

test("missing path_agent_prompt receives its default independently", async t => {
  const agent = profile(); delete agent.path_agent_prompt;
  const f = await agentFixture(t, { config: configured([agent]) });
  await f.load(); const saved = await f.configuration();
  assert.equal(saved.agents[0].path_agent_prompt, "");
});

test("legacy exec_command maps to the supported tools without changing other profiles", async t => {
  const f = await agentFixture(t, { config: configured([profile('general', { tools: ['exec_command'] }), profile('reviewer', { tools: ['read'] })]) });
  await f.load(); const agents = (await f.configuration()).agents;
  assert.deepEqual(agents[0].tools, ["read", "bash", "grep", "find", "ls"]);
  assert.deepEqual(agents[1].tools, ['read']);
});

test("legacy apply_patch maps to the supported tools without changing other profiles", async t => {
  const f = await agentFixture(t, { config: configured([profile('general', { tools: ['apply_patch'] }), profile('reviewer', { tools: ['read'] })]) });
  await f.load(); const agents = (await f.configuration()).agents;
  assert.deepEqual(agents[0].tools, ["edit", "write"]);
  assert.deepEqual(agents[1].tools, ['read']);
});

test("a manual model choice remains the fallback after a denied agent selection", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer', { model: 'test/review/model' })]));
  await f.start();
  const setModel = f.pi.setModel;
  f.pi.setModel = async () => { return false; };
  await assert.rejects(f.select('reviewer'), { message: 'Agent "reviewer" cannot authenticate model test/review/model' });
  f.pi.setModel = setModel;
  const historyLength = f.entries.length;
  await f.pi.setModel({ provider: 'test', id: 'review/model' });
  assert.equal(f.entries.length, historyLength);
  await f.select('general');
  assert.equal(f.capability().active, 'general');
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'review/model' });
});

test("a manual model choice remains the fallback after a failed agent selection", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer', { model: 'test/review/model' })]));
  await f.start();
  const setModel = f.pi.setModel;
  f.pi.setModel = async () => { throw new Error('unavailable'); };
  await assert.rejects(f.select('reviewer'), { message: 'Agent "reviewer" could not select test/review/model: unavailable' });
  f.pi.setModel = setModel;
  const historyLength = f.entries.length;
  await f.pi.setModel({ provider: 'test', id: 'review/model' });
  assert.equal(f.entries.length, historyLength);
  await f.select('general');
  assert.equal(f.capability().active, 'general');
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'review/model' });
});

test("manual model and effort choices become defaults for later agent selections", async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  await f.configure(configured([profile(), profile('reviewer')]));
  await f.start();
  await f.pi.setModel({ provider: 'test', id: 'review/model' });
  f.pi.setThinkingLevel('low');
  await f.select('reviewer');
  assert.equal(f.capability().active, 'reviewer');
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'review/model' });
  assert.equal(f.pi.getThinkingLevel(), 'low');
});

test("a new session uses its own model and effort defaults", async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  await f.configure(configured([profile(), profile('reviewer', { model: 'test/review/model', effort: 'low' })]));
  await f.start();
  await f.pi.setModel({ provider: 'test', id: 'review/model' });
  f.pi.setThinkingLevel('low');
  await f.select('reviewer');
  f.ctx.sessionManager.getSessionFile = () => join(f.dir, 'second-session');
  f.ctx.sessionManager.getSessionId = () => 'second-session';
  f.entries.length = 0;
  f.ctx.model = { provider: 'test', id: 'default' };
  f.pi.setThinkingLevel('medium');
  await f.start();
  await f.select('reviewer');
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'review/model' });
  assert.equal(f.pi.getThinkingLevel(), 'low');
  await f.select('general');
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'default' });
  assert.equal(f.pi.getThinkingLevel(), 'medium');
});

test("an agent selection remains a draft until the first submitted prompt", async t => {
  const f = await agentFixture(t, { config: null, files: { 'agent.md': 'Review instructions' } });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer', { model: 'test/review/model', effort: 'low', path_agent_prompt: 'agent.md' })]));
  await f.start();
  assert.equal(f.capability().active, 'general');
  assert.equal(f.capability().locked, false);
  await f.select('reviewer');
  assert.equal(f.capability().active, 'reviewer');
  assert.equal(f.capability().locked, false);
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'review/model' });
  assert.equal(f.pi.getThinkingLevel(), 'low');
  assert.deepEqual(await f.input('hello'), { action: 'continue' });
  assert.equal(f.capability().locked, true);
});

test("a submitted agent keeps its prompt content after source files and configuration change", async t => {
  const f = await agentFixture(t, { config: null, files: { 'agent.md': 'Review instructions' } });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer', { path_agent_prompt: 'agent.md' })]));
  await f.start(); await f.select('reviewer'); await f.input('hello');
  await f.file('prompt.md', 'Changed on disk');
  await f.file('agent.md', 'Changed agent prompt'); await f.file('new.md', 'New system');
  await f.configure(configured([profile(), profile('reviewer', { path_systemprompt: 'new.md' })]));
  await f.start();
  const prompt = await f.prompt();
  assert.equal(prompt.customPrompt, 'System instructions');
  assert.equal(prompt.sections.instructions, 'Review instructions');
  assert.equal(f.capability().saved, true);
  assert.equal(f.capability().unavailable, false);
  assert.deepEqual(await f.input('again'), { action: 'continue' });
  const nextPrompt = await f.prompt();
  assert.equal(nextPrompt.customPrompt, 'System instructions');
  assert.equal(nextPrompt.sections.instructions, 'Review instructions');
});

test("a model choice made before startup remains the fallback after switching agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer', { model: 'test/default', effort: 'medium' })]));
  await f.pi.setModel({ provider: 'test', id: 'review/model' });
  await f.start(); await f.select('reviewer');
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'default' });
  assert.equal(f.pi.getThinkingLevel(), 'medium');
  await f.select('general');
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'review/model' });
  assert.equal(f.pi.getThinkingLevel(), 'high');
});

test("a effort choice made before startup remains the fallback after switching agents", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer', { model: 'test/default', effort: 'medium' })]));
  f.pi.setThinkingLevel('low');
  await f.start(); await f.select('reviewer');
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'default' });
  assert.equal(f.pi.getThinkingLevel(), 'medium');
  await f.select('general');
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'default' });
  assert.equal(f.pi.getThinkingLevel(), 'low');
});

test("configuration accepts distinct default and general profiles", async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  await f.configure({ agents: [profile('default'), profile('general')] });
  assert.deepEqual((await f.configuration()).agents.map(agent => agent.name), ['default', 'general']);
});

test("configuration rejects a non-list agents value without replacing valid profiles", async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: 'invalid' }), /Invalid agent configuration/);
  assert.deepEqual(await f.configuration(), before);
});

test("configuration rejects a blank system prompt path without replacing valid profiles", async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure(configured([profile('bad', { path_systemprompt: '  ' })])), /requires a nonempty path_systemprompt/);
  assert.deepEqual(await f.configuration(), before);
});

test('restoring an agent retains manually disabled fast mode in provider requests', async t => {
  const model = { provider: 'openai', id: 'gpt-5.4', api: 'openai-responses' };
  const f = await agentFixture(t, {
    model, models: [model],
    config: null,
    realFastMode: { catalog: [{ slug: 'gpt-5.4', service_tiers: [{ id: 'priority' }] }] },
  });
  await f.load();
  await f.configure(configured([profile('general', { model: 'openai/gpt-5.4', fastMode: true })]));
  await f.start(); await f.select('general'); await f.input('save this selection');
  assert.deepEqual(await f.emit('before_provider_request', { payload: { input: 'hello' } }), { input: 'hello', service_tier: 'priority' });
  await f.commands.get('fast').handler('off', f.ctx);
  await f.start();
  assert.equal(await f.fastEnabled(), false);
  assert.equal(await f.emit('before_provider_request', { payload: { input: 'hello' } }), undefined);
  assert.deepEqual(f.notices, []);
});

test('restoring an agent retains manually enabled fast mode in provider requests', async t => {
  const model = { provider: 'openai', id: 'gpt-5.4', api: 'openai-responses' };
  const f = await agentFixture(t, {
    model, models: [model],
    config: null,
    realFastMode: { catalog: [{ slug: 'gpt-5.4', service_tiers: [{ id: 'priority' }] }] },
  });
  await f.load();
  await f.configure(configured([profile('general', { model: 'openai/gpt-5.4', fastMode: false })]));
  await f.start(); await f.select('general'); await f.input('save this selection');
  assert.equal(await f.emit('before_provider_request', { payload: { input: 'hello' } }), undefined);
  await f.commands.get('fast').handler('on', f.ctx);
  await f.start();
  assert.equal(await f.fastEnabled(), true);
  assert.deepEqual(await f.emit('before_provider_request', { payload: { input: 'hello' } }), { input: 'hello', service_tier: 'priority' });
  assert.deepEqual(f.notices, []);
});

test('a supported manual model keeps a restored fast-mode agent usable after its default loses support', async t => {
  const models = ['gpt-5.4', 'no-fast'].map(id => ({ provider: 'openai', id, api: 'openai-responses' }));
  const catalog = models.map(model => ({ slug: model.id, service_tiers: [{ id: 'priority' }] }));
  const f = await agentFixture(t, {
    model: models[1], models,
    config: null,
    realFastMode: { catalog },
  });
  await f.load();
  await f.configure(configured([profile('general', { model: 'openai/no-fast', fastMode: true })]));
  await f.start(); await f.select('general'); await f.input('save this agent');
  await f.pi.setModel(models[0]);
  catalog[1].service_tiers = [];
  await f.reloadExtensions();
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
  assert.deepEqual(await f.input('allowed'), { action: 'continue' });
  assert.deepEqual(await f.emit('before_provider_request', { payload: { input: 'allowed' } }), { input: 'allowed', service_tier: 'priority' });
  assert.deepEqual(f.notices, []);
});

test('a manual model change preserves the saved fast-mode choice after reload', async t => {
  const models = ['gpt-5.4', 'no-fast'].map(id => ({ provider: 'openai', id, api: 'openai-responses' }));
  const f = await agentFixture(t, {
    model: models[0], models,
    config: null,
    realFastMode: { catalog: [{ slug: 'gpt-5.4', service_tiers: [{ id: 'priority' }] }, { slug: 'no-fast', service_tiers: [] }] },
  });
  await f.load();
  await f.configure(configured([profile('general', { model: 'openai/gpt-5.4', fastMode: true })]));
  await f.start(); await f.select('general'); await f.input('save this agent');
  await f.pi.setModel(models[1]);
  await f.reloadExtensions();
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
  assert.equal(await f.fastEnabled(), true);
  assert.deepEqual(await f.input('continue'), { action: 'continue' });
});

test('a saved fast-mode choice survives changed model support', async t => {
  const model = { provider: 'openai', id: 'no-fast', api: 'openai-responses' };
  const catalog = [{ slug: 'no-fast', service_tiers: [{ id: 'priority' }] }];
  const f = await agentFixture(t, {
    model, models: [model],
    config: null,
    realFastMode: { catalog },
  });
  await f.load();
  await f.configure(configured([profile('general', { model: 'openai/no-fast', fastMode: true })]));
  await f.start(); await f.select('general');
  assert.deepEqual(await f.input('save this agent'), { action: 'continue' });
  catalog[0].service_tiers = [];
  await f.reloadExtensions();
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
  assert.equal(await f.fastEnabled(), true);
  assert.deepEqual(await f.input('continue'), { action: 'continue' });
});

test('agents without a model or persistent session can start and switch without selecting a model', async t => {
  const f = await agentFixture(t, { config: null, model: undefined, models: [], effort: '', realFastMode: { catalog: [] } });
  f.ctx.sessionManager.getSessionFile = () => undefined;
  f.pi.setModel = async () => assert.fail('No model is available to select');
  await f.load();
  await f.configure(configured([profile(), profile('reviewer')]));
  await f.start();
  assert.equal(f.capability().active, 'general');
  assert.equal(f.ctx.model, undefined);
  assert.equal(f.pi.getThinkingLevel(), '');
  await f.select('reviewer');
  assert.equal(f.capability().active, 'reviewer');
  assert.equal(f.ctx.model, undefined);
  assert.equal(f.pi.getThinkingLevel(), '');
  assert.deepEqual(f.notices, []);
});

test('fast mode cannot be selected without a model', async t => {
  const f = await agentFixture(t, { config: null, model: undefined, models: [], effort: '', realFastMode: { catalog: [] } });
  f.ctx.sessionManager.getSessionFile = () => undefined;
  await f.load(); await f.start();
  await f.configure(configured([profile('general', { fastMode: true })]));
  await assert.rejects(f.select('general'), { message: 'Agent "general" cannot enable fast mode because it has no model' });
});

test('a failed resource reload still permits final shutdown to clear agent status', async t => {
  const f = await agentFixture(t, { runtime: { skills: { userInvokedSkills: [], agentInvokedSkills: ['/skills/review'] } }, config: null });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer', { skills: ['/skills/review'] })]));
  await f.start();
  f.ctx.reload = async () => {};
  await f.select('reviewer');
  f.ctx.reload = async () => {
    await f.emit('session_shutdown');
    assert.ok(f.statuses.get('pi-define-agents'));
    throw new Error('reload failed');
  };
  await assert.rejects(f.select('general'), /reload failed/);
  await f.emit('session_shutdown');
  assert.equal(f.statuses.get('pi-define-agents'), undefined);
});

test('removed agent refresh leaves externally enabled tools unchanged', async t => {
  const f = await agentFixture(t, { config: null, entries: [{ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'missing' } }] });
  await f.load(); await f.start();
  assert.deepEqual(f.pi.getActiveTools(), []);
  f.pi.setActiveTools(['read']);
  const request = { ctx: f.ctx };
  f.pi.events.emit('piop:agents:refresh', request);
  await request.ready;
  assert.equal(request.ready, undefined);
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
});

test('clearing migrated tools remains effective after reload and selection', async t => {
  const tools = ['read', 'web_search', 'spawn_subagents'];
  const f = await agentFixture(t, { runtime: { enabledTools: tools }, tools, config: { agents: [profile()] } });
  await f.load(); await f.start();
  assert.deepEqual(f.pi.getActiveTools(), ['read', 'spawn_subagents', 'web_search']);
  await f.configure({ agents: [profile('general', { tools: [] })] });
  await f.reloadExtensions(); await f.select('general');
  assert.deepEqual(f.pi.getActiveTools(), []);
  assert.deepEqual((await f.configuration()).agents[0].tools, []);
});

test('legacy command and patch tools migrate to the current builtin tools', async t => {
  const tools = ['read', 'bash', 'grep', 'find', 'ls', 'edit', 'write', 'web_search'];
  const f = await agentFixture(t, {
    config: { agents: [profile('default', { tools: ['exec_command', 'apply_patch', 'read', 'web_search'] })] },
    runtime: { enabledTools: ['web_search', 'fork_session'] }, tools,
  });
  await f.load();
  assert.deepEqual((await f.configuration()).agents[0].tools, ['read', 'bash', 'grep', 'find', 'ls', 'edit', 'write', 'web_search']);
});

test('editing tools after legacy migration survives reload', async t => {
  const f = await agentFixture(t, {
    config: { agents: [profile('default', { tools: ['exec_command', 'apply_patch', 'read', 'web_search'] })] },
    runtime: { enabledTools: ['read', 'web_search', 'fork_session'] },
  });
  await f.load();
  await f.configure({ agents: [profile('general', { tools: ['read'] })] });
  await f.reloadExtensions();
  assert.deepEqual((await f.configuration()).agents[0].tools, ['read']);
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
});

test('started agent keeps skill paths and invocation policy across resource changes and resume', async t => {
  const runtime = { enabledTools: ['read'] };
  const f = await agentFixture(t, { runtime, config: null });
  runtime.skills = { userInvokedSkills: [], agentInvokedSkills: [join(f.home, 'allowed')] };
  await f.load();
  await f.configure(configured([profile('general', { skills: ['~/allowed'] })]));
  await f.start();
  assert.deepEqual(await f.emit('resources_discover'), { skillPaths: ['~/allowed'] });
  await f.input('Start');
  runtime.skills = { userInvokedSkills: [join(f.home, 'allowed')], agentInvokedSkills: [] };
  await f.reloadExtensions();
  assert.deepEqual(await f.emit('resources_discover'), { skillPaths: ['~/allowed'] });
  const prompt = await f.prompt({ skills: [{ filePath: join(f.home, 'allowed/SKILL.md'), baseDir: join(f.home, 'allowed') }] });
  assert.notEqual(prompt.skills[0].disableModelInvocation, true);
  runtime.skills = { userInvokedSkills: [], agentInvokedSkills: [] };
  await f.reloadExtensions();
  assert.deepEqual(await f.emit('resources_discover'), { skillPaths: ['~/allowed'] });

});

test('agent instructions replace appended instructions without changing discovered skills', async t => {
  const f = await agentFixture(t, { config: null, files: { 'agent.md': 'Agent instructions' } });
  await f.load();
  await f.configure(configured([profile('general', { path_agent_prompt: 'agent.md' })]));
  await f.start();
  const skills = [{ filePath: '/skills/one', baseDir: '/skills' }, { filePath: '/skills/two', baseDir: '/skills' }];
  assert.deepEqual(await f.prompt({ appendSystemPrompt: 'Appended', skills }), {
    customPrompt: 'System instructions', sections: { instructions: 'Agent instructions' },
    contextFiles: [], appendSystemPrompt: '',
    skills: [{ filePath: '/skills/one', baseDir: '/skills' }, { filePath: '/skills/two', baseDir: '/skills' }],
  });
});

test('agent prompt assembly preserves a selected tool', async t => {
  const f = await agentFixture(t, { config: null }); await f.load(); await f.start();
  assert.deepEqual((await f.prompt({ selectedTools: ['bash'] })).selectedTools, ['bash']);
});

test('agent prompt assembly preserves an explicitly empty tool selection', async t => {
  const f = await agentFixture(t, { config: null }); await f.load(); await f.start();
  assert.deepEqual((await f.prompt({ selectedTools: [] })).selectedTools, []);
});

test('editing a profile leaves the running agent tools and prompt unchanged', async t => {
  const f = await agentFixture(t, { config: null, files: { 'new.md': 'New instructions' } });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer')]));
  await f.start();
  await f.configure({ agents: [profile('general', { tools: ['bash'], path_systemprompt: 'new.md' })] });
  assert.equal(f.capability().active, 'general');
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
  assert.equal((await f.prompt()).customPrompt, 'System instructions');
});

test('context cap requests use the selected agent definition until another selection', async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  await f.configure(configured([profile('general', { contextWindowCap: 300000 })]));
  await f.start();
  const cap = () => { const request = {}; f.pi.events.emit('piop:agents:context-cap', request); return request.cap; };
  assert.equal(cap(), 300000);
  await f.configure({ agents: [profile('general', { contextWindowCap: null })] });
  assert.equal(cap(), 300000);
  await f.select('general');
  assert.equal(cap(), null);
});

test('saved profile edits remain selectable after extension reload', async t => {
  const f = await agentFixture(t, { config: null, files: { 'new.md': 'New instructions' } });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer')]));
  await f.start();
  await f.configure({ agents: [profile('general', { tools: ['bash'], path_systemprompt: 'new.md' })] });
  await f.reloadExtensions(); await f.select('general');
  assert.deepEqual(f.pi.getActiveTools(), ['bash']);
  assert.equal((await f.prompt()).customPrompt, 'New instructions');
});

test("configuration rejects non-boolean fast mode without changing saved profiles", async t => {
  const f = await agentFixture(t, { config: null }); await f.load(); await f.start();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', {"fastMode": "yes"})] }), /Invalid agent configuration/);
  assert.deepEqual(await f.configuration(), before);
});

test("configuration rejects empty system prompt path without changing saved profiles", async t => {
  const f = await agentFixture(t, { config: null }); await f.load(); await f.start();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', {"path_systemprompt": ""})] }), /requires a nonempty path_systemprompt/);
  assert.deepEqual(await f.configuration(), before);
});

test("configuration rejects non-text system prompt path without changing saved profiles", async t => {
  const f = await agentFixture(t, { config: null }); await f.load(); await f.start();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', {"path_systemprompt": 7})] }), /Invalid agent configuration/);
  assert.deepEqual(await f.configuration(), before);
});

test("configuration rejects inline system prompt without changing saved profiles", async t => {
  const f = await agentFixture(t, { config: null }); await f.load(); await f.start();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', {"systemPrompt": "inline"})] }), /must link a system prompt file using path_systemprompt/);
  assert.deepEqual(await f.configuration(), before);
});

test('configuration rejects inline developer prompts without changing saved profiles', async t => {
  const f = await agentFixture(t, { config: null }); await f.load(); await f.start();
  const before = await f.configuration();
  await assert.rejects(f.configure({ agents: [profile('reviewer', { developerPrompt: 'inline' })] }), /must link a system prompt file using path_systemprompt/);
  assert.deepEqual(await f.configuration(), before);
});

test('selecting an unknown profile keeps the current agent usable', async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  await f.configure(configured([profile(), profile('reviewer')]));
  await f.start();
  await assert.rejects(f.select('unknown'), { message: 'Unknown defined agent: unknown' });
  assert.equal(f.capability().active, 'general');
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
  assert.equal((await f.prompt()).customPrompt, 'System instructions');
});

test('a target with an unreadable agent prompt keeps the selected agent prompts and input usable', async t => {
  const f = await agentFixture(t, { config: null, files: { 'review-system.md': 'Review system', 'review-agent.md': 'Review agent', 'broken-system.md': 'Broken system', 'absent-agent.md': 'Soon gone' } });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer', { path_systemprompt: 'review-system.md', path_agent_prompt: 'review-agent.md' }), profile('broken', { path_systemprompt: 'broken-system.md', path_agent_prompt: 'absent-agent.md' })]));
  await rm(join(f.dir, 'absent-agent.md'));
  await f.start(); await f.select('reviewer');
  await assert.rejects(f.select('broken'), error => error.message.startsWith(`Agent "broken" cannot read agent prompt ${join(f.dir, 'absent-agent.md')}: ENOENT`));
  assert.equal(f.capability().active, 'reviewer');
  const prompt = await f.prompt();
  assert.deepEqual([prompt.customPrompt, prompt.sections.instructions], ['Review system', 'Review agent']);
  assert.deepEqual(await f.input('hello'), { action: 'continue' });
});

test('first run reports a read-only settings directory and succeeds after access is restored', async t => {
  const f = await agentFixture(t, { config: null });
  await f.file('home/.agents/prompts/system/default.md', 'Existing instructions');
  await chmod(f.dir, 0o500);
  try {
    await assert.rejects(f.load(), { code: 'EACCES' });
    assert.deepEqual(f.pi.getActiveTools(), []);
  } finally { await chmod(f.dir, 0o700); }
  await f.load(); await f.start();
  assert.equal(f.capability().active, 'general');
  assert.equal(f.capability().unavailable, false);
  assert.equal((await f.prompt()).customPrompt, 'Existing instructions');
  assert.equal((await f.configuration()).agents[0].name, 'general');
});

test('first run reports an unwritable prompt directory and succeeds after access is restored', async t => {
  const f = await agentFixture(t, { config: null });
  const directory = join(f.home, '.agents/prompts/system');
  await mkdir(join(f.home, '.agents/prompts'), { recursive: true }); await mkdir(directory, { mode: 0o500 });
  try {
    await assert.rejects(f.load(), { code: 'EACCES' });
    assert.deepEqual(f.pi.getActiveTools(), []);
  } finally { await chmod(directory, 0o700); }
  await f.load(); await f.start();
  assert.equal(f.capability().active, 'general');
  assert.equal(f.capability().unavailable, false);
  assert.match((await f.prompt()).customPrompt, /^You are an expert coding assistant/);
});


test('disabled embedded servers do not activate unrelated registered MCP tools', async t => {
  const f = await agentFixture(t, { config: null, tools: ['read', 'mcp_my_server_query', 'mcp_my__server_query', 'mcp__my_server__query'] });
  await installAgentMcp({ dir: f.dir, pi: f.pi, tools: f.tools });
  await f.load();
  await f.configure(configured([profile('general', { mcpServers: { remote: { ...remoteMcp, enabled: false } } })]));
  await f.start();
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
  assert.deepEqual(await f.input('connect'), { action: 'continue' });
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
});


test('an agent with MCP servers reports a missing bridge and blocks input', async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  await f.configure(configured([profile('general', { mcpServers: { remote: remoteMcp } })]));
  await f.start();
  assert.deepEqual(await f.input('no bridge'), { action: 'handled' });
  assert.equal(f.notices.at(-1).message, 'Agent "general" cannot run because the MCP registration adapter is unavailable');
  assert.deepEqual(f.pi.getActiveTools(), []);
});

test('agent input waits for the MCP SDK to become ready', async t => {
  const f = await agentFixture(t, { config: null });
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  await installAgentMcp({ dir: f.dir, pi: f.pi, tools: f.tools, start: async () => { started.resolve(); await gate.promise; }, servers: {
    remote: [{ name: 'mcp_remote_read', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'Remote content' }] }) }],
  } });
  await f.load();
  await f.configure(configured([profile('general', { mcpServers: { remote: remoteMcp } })]));
  await f.start();
  let settled = false;
  const pending = f.input('connect').finally(() => { settled = true; });
  try {
    await started.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
  } finally { gate.resolve(); }
  assert.deepEqual(await pending, { action: 'continue' });
  assert.deepEqual(f.pi.getActiveTools(), ['read', 'mcp_remote_read']);
  assert.deepEqual(await f.tools.get('mcp_remote_read').execute(), { content: [{ type: 'text', text: 'Remote content' }] });
});

test('an MCP SDK registration error blocks input and reports its message', async t => {
  const f = await agentFixture(t, { config: null });
  await installAgentMcp({ dir: f.dir, pi: f.pi, tools: f.tools, registrationError: () => new Error('network lost') });
  await f.load();
  await f.configure(configured([profile('general', { mcpServers: { remote: remoteMcp } })]));
  await f.start();
  assert.deepEqual(await f.input('retry'), { action: 'handled' });
  assert.equal(f.notices.at(-1).message, 'Agent "general" could not register its MCP servers:\nnetwork lost');
  assert.deepEqual(f.pi.getActiveTools(), []);
});

test('an MCP SDK string failure blocks input and reports its message', async t => {
  const f = await agentFixture(t, { config: null });
  await installAgentMcp({ dir: f.dir, pi: f.pi, tools: f.tools, registrationError: () => 'network lost' });
  await f.load();
  await f.configure(configured([profile('general', { mcpServers: { remote: remoteMcp } })]));
  await f.start();
  assert.deepEqual(await f.input('retry'), { action: 'handled' });
  assert.equal(f.notices.at(-1).message, 'Agent "general" could not register its MCP servers:\nnetwork lost');
  assert.deepEqual(f.pi.getActiveTools(), []);
});


test('agent MCP tools remain usable after a normal agent refresh', async t => {
  const f = await agentFixture(t, { runtime: { enabledTools: ['read'] }, tools: ['read', 'mcp_other_query'], config: null });
  await installAgentMcp({ dir: f.dir, pi: f.pi, tools: f.tools, servers: { remote: [
    { name: 'mcp_my_server_query', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'First result' }] }) },
    { name: 'mcp_tool_query', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'Second result' }] }) },
  ] } });
  await f.load();
  await f.configure(configured([profile('general', { mcpServers: { remote: remoteMcp } })]));
  await f.start(); await f.input('go');
  const request = { ctx: f.ctx }; f.pi.events.emit('piop:agents:refresh', request); await request.ready;
  assert.deepEqual(f.pi.getActiveTools(), ['read', 'mcp_my_server_query', 'mcp_tool_query']);
  assert.deepEqual(await f.tools.get('mcp_my_server_query').execute(), { content: [{ type: 'text', text: 'First result' }] });
  assert.deepEqual(await f.tools.get('mcp_tool_query').execute(), { content: [{ type: 'text', text: 'Second result' }] });
});

test('started agent keeps tool lists across catalog changes and resume, and a fresh session uses the tools that Pi has', async t => {
  const runtime = { enabledTools: ['read'] };
  const f = await agentFixture(t, { runtime, config: configured([profile()]) });
  await f.load(); await f.start(); await f.input('Start');
  runtime.enabledTools = [];
  await f.configure(configured([profile('general', { tools: [] })]));
  const request = { command: 'refresh_agent_definitions', payload: {}, ctx: f.ctx };
  f.pi.events.emit('piop:rpc', request);
  assert.equal(request.ready, undefined);
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
  await f.reloadExtensions();
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
  assert.deepEqual(await f.input('Continue'), { action: 'continue' });
  const fresh = await agentFixture(t, { runtime, config: configured([profile()]) });
  await fresh.load(); await fresh.start();
  assert.deepEqual(fresh.pi.getActiveTools(), ['read']);
});

test('agent shutdown releases the MCP tool and agent refresh services', async t => {
  const f = await agentFixture(t, { config: null });
  await installAgentMcp({ dir: f.dir, pi: f.pi, tools: f.tools });
  await f.load(); await f.start();
  const before = {}; f.pi.events.emit('piop:mcp:tools', before);
  assert.deepEqual(before.tools, []);
  await f.emit('session_shutdown');
  const tools = {}; f.pi.events.emit('piop:mcp:tools', tools); assert.deepEqual(tools, {});
  const refresh = { ctx: f.ctx }; f.pi.events.emit('piop:agents:refresh', refresh); assert.equal(refresh.ready, undefined);
});

test('saving agent definitions publishes the new profile choices', async t => {
  const f = await agentFixture(t, { config: null }); await f.load(); await f.start();
  await f.configure({ agents: [profile(), profile('new-agent')] });
  assert.deepEqual(f.capability().config.agents.map(agent => agent.name), ['general', 'new-agent']);
});

test('removed agent refresh preserves extension tool choices', async t => {
  const f = await agentFixture(t, { config: null });
  await installAgentMcp({ dir: f.dir, pi: f.pi, tools: f.tools, servers: { remote: [{ name: 'mcp_remote_read', parameters: {} }] } });
  await f.load();
  await f.configure(configured([profile('general', { mcpServers: { remote: remoteMcp } })]));
  await f.start();
  f.pi.setActiveTools(['read', 'stale', 'mcp_remote_read']);
  const request = { ctx: f.ctx }; f.pi.events.emit('piop:agents:refresh', request); await request.ready;
  assert.equal(request.ready, undefined);
  assert.deepEqual(f.pi.getActiveTools(), ['read', 'stale', 'mcp_remote_read']);
});

test('a newly available model can be selected by a fast-mode agent', async t => {
  const models = [{ provider: 'openai', id: 'gpt-5.4', api: 'openai-responses' }];
  const f = await agentFixture(t, { config: null, model: models[0], models, realFastMode: { catalog: [
    { slug: 'gpt-5.4', service_tiers: [{ id: 'priority' }] },
    { slug: 'review', service_tiers: [{ id: 'priority' }] },
  ] } });
  await f.load(); await f.start();
  models.push({ provider: 'openai', id: 'review', api: 'openai-responses', baseUrl: models[0].baseUrl });
  await f.pi.setModel(models[1]);
  await f.configure(configured([profile('general', { model: 'openai/review', fastMode: true })]));
  await f.select('general');
  assert.equal(f.ctx.model.id, 'review');
  assert.equal(await f.fastEnabled(), true);
});


test('MCP tools remain usable when switching agents and submitting input', async t => {
  const f = await agentFixture(t, { config: null });
  await installAgentMcp({ dir: f.dir, pi: f.pi, tools: f.tools, servers: { remote: [
    { name: 'mcp_remote_read', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'Remote content' }] }) },
  ] } });
  await f.load();
  await f.configure(configured([
    profile('general', { mcpServers: { remote: remoteMcp } }),
    profile('reviewer', { mcpServers: { remote: remoteMcp } }),
  ]));
  await f.start();
  assert.deepEqual(f.pi.getActiveTools(), ['read', 'mcp_remote_read']);
  await f.select('reviewer');
  assert.equal(f.capability().active, 'reviewer');
  assert.deepEqual(await f.input('hello'), { action: 'continue' });
  assert.deepEqual(f.pi.getActiveTools(), ['read', 'mcp_remote_read']);
  assert.deepEqual(await f.tools.get('mcp_remote_read').execute(), { content: [{ type: 'text', text: 'Remote content' }] });
});

test('MCP settings apply on session load and agent selection, not on input', async t => {
  const f = await agentFixture(t, { config: null });
  const bridge = await installAgentMcp({ dir: f.dir, pi: f.pi, tools: f.tools, deferToolsUntilStart: true, servers: {
    remote: [{ name: 'mcp_remote_read', parameters: {} }],
  } });
  const selections = [];
  f.pi.events.on('piop:mcp:select', selection => selections.push(structuredClone({ servers: selection.servers, sessionId: selection.sessionId })));
  await f.load();
  await f.configure(configured([profile(), profile('reviewer', { mcpServers: { remote: remoteMcp } })]));
  await f.start();
  assert.equal(selections.length, 1);
  await f.select('reviewer');
  assert.equal(selections.length, 2);
  assert.equal(bridge.registered.has('remote'), true);
  assert.deepEqual(await f.input('first'), { action: 'continue' });
  assert.deepEqual(await f.input('second'), { action: 'continue' });
  assert.equal(selections.length, 2);
  assert.deepEqual(f.pi.getActiveTools(), ['read', 'mcp_remote_read']);
  await f.start();
  assert.equal(selections.length, 3);
  assert.deepEqual(await f.input('after load'), { action: 'continue' });
  assert.equal(selections.length, 3);
});

test('input preserves an MCP registration failure without reapplying settings', async t => {
  const f = await agentFixture(t, { config: null });
  let attempts = 0;
  await installAgentMcp({ dir: f.dir, pi: f.pi, tools: f.tools, registrationError: () => {
    attempts++;
    return new Error('registration failed');
  } });
  await f.load();
  await f.configure(configured([profile('general', { mcpServers: { remote: remoteMcp } })]));
  await f.start();
  assert.equal(attempts, 1);
  assert.deepEqual(await f.input('first'), { action: 'handled' });
  assert.deepEqual(await f.input('second'), { action: 'handled' });
  assert.equal(attempts, 1);
  assert.match(f.notices.at(-1).message, /registration failed/);
  assert.deepEqual(f.pi.getActiveTools(), []);
});


test("failed agent selection without skill changes preserves usable MCP tools", async t => {
  const f = await agentFixture(t, { config: null });
  await installAgentMcp({ dir: f.dir, pi: f.pi, tools: f.tools, servers: { remote: [
    { name: 'mcp_remote_read', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'Remote content' }] }) },
  ] } });
  await f.load();
  await f.configure(configured([
    profile(), profile('reviewer', { mcpServers: { remote: remoteMcp } }),
    profile('broken', { tools: ['missing'], skills: [] }),
  ]));
  await f.start(); await f.select('reviewer');
  assert.deepEqual(f.pi.getActiveTools(), ['read', 'mcp_remote_read']);
  assert.deepEqual(await f.tools.get('mcp_remote_read').execute(), { content: [{ type: 'text', text: 'Remote content' }] });
  await assert.rejects(f.select('broken'), /does not have its configured tool: missing/);
  assert.equal(f.capability().active, 'reviewer');
  assert.deepEqual(f.pi.getActiveTools(), ['read', 'mcp_remote_read']);
  assert.deepEqual(await f.tools.get('mcp_remote_read').execute(), { content: [{ type: 'text', text: 'Remote content' }] });
});


test("failed agent selection with skill changes preserves usable MCP tools", async t => {
  const f = await agentFixture(t, { config: null });
  await installAgentMcp({ dir: f.dir, pi: f.pi, tools: f.tools, servers: { remote: [
    { name: 'mcp_remote_read', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'Remote content' }] }) },
  ] } });
  await f.load();
  await f.configure(configured([
    profile(), profile('reviewer', { mcpServers: { remote: remoteMcp } }),
    profile('broken', { tools: ['missing'], skills: ["/new"] }),
  ]));
  await f.start(); await f.select('reviewer');
  assert.deepEqual(f.pi.getActiveTools(), ['read', 'mcp_remote_read']);
  assert.deepEqual(await f.tools.get('mcp_remote_read').execute(), { content: [{ type: 'text', text: 'Remote content' }] });
  await assert.rejects(f.select('broken'), /does not have its configured tool: missing/);
  assert.equal(f.capability().active, 'reviewer');
  assert.deepEqual(f.pi.getActiveTools(), ['read', 'mcp_remote_read']);
  assert.deepEqual(await f.tools.get('mcp_remote_read').execute(), { content: [{ type: 'text', text: 'Remote content' }] });
});

test('new manual choices replace defaults restored after extension reload', async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer', { model: 'test/review/model', effort: 'high' })]));
  await f.start();
  await f.pi.setModel({ provider: 'test', id: 'review/model' });
  f.pi.setThinkingLevel('low');
  await f.reloadExtensions();
  await f.pi.setModel({ provider: 'test', id: 'default' });
  f.pi.setThinkingLevel('medium');
  await f.select('reviewer');
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'review/model' });
  assert.equal(f.pi.getThinkingLevel(), 'high');

  await f.select('general');
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'default' });
  assert.equal(f.pi.getThinkingLevel(), 'medium');
});

test('sending input preserves manual choices made after extension reload', async t => {
  const f = await agentFixture(t, { config: null });
  await f.load(); await f.start();
  await f.pi.setModel({ provider: 'test', id: 'review/model' });
  f.pi.setThinkingLevel('low');
  await f.reloadExtensions();
  await f.pi.setModel({ provider: 'test', id: 'default' });
  f.pi.setThinkingLevel('medium');

  assert.deepEqual(await f.input('Use my selected model and effort'), { action: 'continue' });
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'default' });
  assert.equal(f.pi.getThinkingLevel(), 'medium');
});


test('a first session retains its model and effort as agent defaults', async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer', { model: 'test/review/model', effort: 'low' })]));
  await f.start();
  await f.select('reviewer');
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'review/model' });
  assert.equal(f.pi.getThinkingLevel(), 'low');

  await f.select('general');
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'default' });
  assert.equal(f.pi.getThinkingLevel(), 'high');
});
