import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { agentFixture, profile, configured, encoded } from '../defined-agent-fixture.mjs';

const remoteMcp = { id: 'remote', name: 'Remote', transport: 'stdio', command: 'mcp-server', args: '', enabled: true };

test('restoring general preserves explicitly enabled question tools', async t => {
  const f = await agentFixture(t, { tools: ['read', 'request_user_input'], config: configured([profile('general', { tools: ['read', 'request_user_input'] })]) });
  await f.load(); await f.start();
  assert.ok(f.pi.getActiveTools().includes('request_user_input'));
  await f.start();
  assert.ok(f.pi.getActiveTools().includes('request_user_input'));
});

test('selections stay drafts until input and preserve immutable prompt files', async t => {
  const f = await agentFixture(t, { config: configured([profile(), profile('reviewer', { model: 'test/review/model', effort: 'low', path_agentprompt: 'agent.md' })]), files: { 'agent.md': 'Review instructions' } });
  await f.load(); await f.start();
  assert.equal(process.env.PI_DEFINE_AGENTS_ACTIVE, '1');
  assert.deepEqual(f.entries, []);
  assert.equal(f.state().snapshot.version, 2);
  assert.equal(await readFile(f.state().snapshot.definition.path_systemprompt, 'utf8'), 'System instructions');
  await f.select(` ${encoded('reviewer')} `);
  assert.deepEqual(f.entries, []);
  const draft = structuredClone(f.state());
  assert.equal(draft.active, 'reviewer');
  assert.equal(draft.modelOverride, undefined); assert.equal(draft.effortOverride, undefined);
  assert.equal(draft.snapshot.definition.model, 'test/review/model'); assert.equal(draft.snapshot.definition.effort, 'low');
  assert.equal(await readFile(draft.snapshot.definition.path_agentprompt, 'utf8'), 'Review instructions');
  assert.deepEqual(f.modelSelections, [{ provider: 'test', id: 'review/model' }]);
  assert.equal(f.pi.getThinkingLevel(), 'low');
  assert.deepEqual(await f.input('hello'), { action: 'continue' });
  assert.equal(f.entries.length, 1); assert.deepEqual(f.entries[0].data, draft);
  const saved = structuredClone(f.entries);
  await f.file('prompt.md', 'Changed on disk'); await f.file('agent.md', 'Changed agent prompt');
  await f.configure(configured([profile(), profile('reviewer', { path_systemprompt: 'new.md' })]));
  await f.start();
  assert.deepEqual(f.entries, saved);
  const prompt = await f.prompt();
  assert.equal(prompt.customPrompt, 'System instructions'); assert.equal(prompt.sections.instructions, 'Review instructions');
  assert.equal(f.capability().saved, true); assert.equal(f.capability().unavailable, false);
  await f.input('again'); assert.equal(f.entries.length, 1);
});

test('skill switches save before reload and failed activation restores overrides without history writes', async t => {
  const f = await agentFixture(t, { config: configured([profile(), profile('reviewer', { skills: ['/skills/review'], model: 'test/review/model', effort: 'low' }), profile('broken', { skills: ['/skills/broken'], tools: ['missing'] })]) });
  await f.load(); await f.start();
  let reloads = 0;
  f.ctx.reload = async () => { reloads++; assert.equal(f.state().active, 'reviewer'); assert.equal(f.capability().active, 'reviewer'); };

  await f.select('reviewer'); assert.equal(reloads, 1); assert.equal(f.entries.length, 0);
  await f.pi.setModel({ provider: 'test', id: 'default' }); f.pi.setThinkingLevel('medium');
  const before = structuredClone(f.entries);
  await assert.rejects(f.select('broken'), /cannot run because Pi does not allow its configured tool: missing/);
  assert.deepEqual(f.entries, before); assert.equal(reloads, 1); assert.equal(f.capability().active, 'reviewer');
  assert.deepEqual(f.pi.getActiveTools(), ['read']); assert.deepEqual(f.ctx.model, { provider: 'test', id: 'default' }); assert.equal(f.pi.getThinkingLevel(), 'medium');
  assert.deepEqual(await f.emit('resources_discover'), { skillPaths: ['/skills/review'] });
  f.ctx.reload = async () => { await f.emit('session_shutdown'); assert.ok(f.statuses.get('pi-define-agents')); throw new Error('reload failed'); };

  await assert.rejects(f.select('general'), /reload failed/);
  await f.emit('session_shutdown'); assert.equal(f.statuses.get('pi-define-agents'), undefined); assert.equal(process.env.PI_DEFINE_AGENTS_ACTIVE, undefined);
});

test('manual model and effort overrides persist and become defaults for later agents and sessions', async t => {
  const f = await agentFixture(t); await f.load(); await f.start();
  await f.pi.setModel({ provider: 'test', id: 'review/model' }); f.pi.setThinkingLevel('low');
  assert.equal(f.state().modelOverride, 'test/review/model'); assert.equal(f.state().effortOverride, 'low');
  assert.deepEqual(JSON.parse(process.env.PI_DEFINE_AGENTS_RUNTIME_DEFAULTS), { model: 'test/review/model', effort: 'low', session: join(f.dir, 'session') });
  await f.select('reviewer'); assert.equal(f.state().modelOverride, undefined); assert.equal(f.state().effortOverride, undefined);
  assert.equal(f.state().snapshot.definition.model, 'test/review/model'); assert.equal(f.state().snapshot.definition.effort, 'low');
  f.ctx.sessionManager.getSessionFile = () => join(f.dir, 'second-session'); f.entries.length = 0;
  f.ctx.model = { provider: 'test', id: 'default' }; f.pi.getThinkingLevel = () => 'medium';
  await f.start(); assert.equal(f.state().snapshot.definition.model, 'test/default'); assert.equal(f.state().snapshot.definition.effort, 'medium');
});

for (const mode of ['missing', 'rejected', 'throw-error', 'throw-string']) test(`model selection ${mode} blocks input and preserves the selected agent on failure`, async t => {
  const f = await agentFixture(t, { config: configured([profile(), profile('reviewer', { model: 'test/review/model' })]) });
  await f.load(); await f.start(); const before = structuredClone(f.entries);
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
  const f = await agentFixture(t, { config: configured([profile(), profile('reviewer', { path_systemprompt: 'absent-system.md' }), profile('writer', { path_agentprompt: 'absent-agent.md' })]) });
  await f.load(); await f.start();

  for (const [name, kind, file] of [['reviewer', 'system', 'absent-system.md'], ['writer', 'agent', 'absent-agent.md']]) {
    await assert.rejects(f.select(name), error => error.message.startsWith(`Agent "${name}" cannot read ${kind} prompt ${join(f.dir, file)}: ENOENT`));
    assert.equal(f.capability().active, 'general'); assert.deepEqual(f.pi.getActiveTools(), ['read']);
  }

  await f.file('absent-agent.md', 'Now available'); await f.select('writer'); assert.match((await f.prompt()).sections.instructions, /Now available/);
});

test('fast mode validates configured and override models and applies supported selections', async t => {
  const f = await agentFixture(t, { config: configured([profile(), profile('fast', { fastMode: true }), profile('unsupported', { fastMode: true, model: 'test/no-fast' })]), fastModels: ['test/default'] });
  await f.load(); await f.start(); await f.select('fast');
  assert.deepEqual(f.fastSelections.at(-1), { enabled: true, ctx: f.ctx }); assert.deepEqual(f.capability().config.fastModeModels, ['test/default']);
  const before = structuredClone(f.entries);
  await assert.rejects(f.select('unsupported'), { message: 'Agent "unsupported" cannot run because model test/no-fast does not support fast mode' }); assert.deepEqual(f.entries, before);
  await f.pi.setModel({ provider: 'test', id: 'review/model' });
  assert.deepEqual(await f.input('hello'), { action: 'handled' }); assert.match(f.notices.at(-1).message, /model test\/review\/model does not support fast mode/);
});

for (const enabled of [false, true]) test(`restoring an agent delegates the saved fast-mode choice ${enabled}`, async t => {
  const f = await agentFixture(t, { config: configured([profile('general', { fastMode: !enabled })]), fastModels: ['test/default'] });
  await f.load(); await f.start();
  f.entries.push({ type: 'custom', customType: 'piop-fast-mode-state', data: { enabled } });
  const requests = [];
  f.pi.events.on('piop:fast-mode', request => { if (request.apply) requests.push(request); });
  await f.start();
  assert.deepEqual(requests, [{ apply: true, enabled, restore: true, ctx: f.ctx }]);
});

test('MCP selections wait for readiness, deduplicate tools, and report unavailable or rejected bridges', async t => {
  const f = await agentFixture(t, { config: configured([profile('general', { mcpServers: [remoteMcp] })]) });
  await f.load(); await f.start();
  assert.deepEqual(await f.input('no bridge'), { action: 'handled' }); assert.match(f.notices.at(-1).message, /MCP bridge is unavailable/);
  const gate = Promise.withResolvers(), started = Promise.withResolvers(); let selection;
  const remove = f.pi.events.on('piop:mcp:select', request => { selection = request; request.ready = gate.promise; started.resolve(); });
  const pending = f.input('connect');
  let timer;

  try { await Promise.race([started.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP selection was not requested')), 1000); })]); }
  finally { clearTimeout(timer); }

  assert.deepEqual({ ...selection, ready: undefined }, { servers: [{ ...remoteMcp, url: undefined, headers: undefined, startupTimeoutSec: undefined, injectAgentId: undefined }], agentName: 'general', sessionId: 'session-id', ready: undefined });
  assert.deepEqual(f.pi.getActiveTools(), []);
  gate.resolve(['mcp_remote_read', 'read', 'mcp_remote_read']); assert.deepEqual(await pending, { action: 'continue' }); assert.deepEqual(f.pi.getActiveTools(), ['read', 'mcp_remote_read']); remove();

  for (const reason of [new Error('network lost'), 'network lost']) {
    const stop = f.pi.events.on('piop:mcp:select', request => { request.ready = Promise.reject(reason); });
    assert.deepEqual(await f.input('retry'), { action: 'handled' }); assert.equal(f.notices.at(-1).message, 'Agent "general" could not connect its MCP servers:\nnetwork lost'); assert.deepEqual(f.pi.getActiveTools(), []); stop();
  }
});

test('agent MCP tools come from bridge selections and refresh respects global tool availability', async t => {
  const runtime = { tools: ['read'], skills: [] };
  const f = await agentFixture(t, { runtime, tools: ['read', 'mcp_my_server_query', 'mcp_other_query', 'mcp_tool_query'], config: configured([profile('general', { mcpServers: [remoteMcp] })]) });
  f.pi.events.on('piop:mcp:select', request => { request.ready = Promise.resolve(['mcp_my_server_query', 'mcp_tool_query']); });
  await f.load(); await f.start(); await f.input('go');
  assert.deepEqual(f.pi.getActiveTools(), ['read', 'mcp_my_server_query', 'mcp_tool_query']);
  const stopTools = f.pi.events.on('piop:mcp:tools', request => { request.tools = ['mcp_my_server_query', 'mcp_tool_query']; });
  let request = { ctx: f.ctx }; f.pi.events.emit('piop:agents:refresh', request); await request.ready;
  assert.deepEqual(f.pi.getActiveTools(), ['read', 'mcp_my_server_query', 'mcp_tool_query']);
  runtime.tools = []; request = { ctx: f.ctx }; f.pi.events.emit('piop:agents:refresh', request); await request.ready; assert.deepEqual(f.pi.getActiveTools(), []);
  stopTools(); runtime.tools = ['read']; request = { ctx: f.ctx }; f.pi.events.emit('piop:agents:refresh', request); await request.ready; assert.deepEqual(f.pi.getActiveTools(), ['read']);
  await f.emit('session_shutdown'); request = { ctx: f.ctx }; f.pi.events.emit('piop:agents:refresh', request); assert.equal(request.ready, undefined);
});

test('skills are intersected by normalized path and prompts preserve append instructions and tool choice', async t => {
  const runtime = { tools: ['read', 'bash'], skills: [] };
  const f = await agentFixture(t, { runtime, config: configured([profile('general', { skills: ['~/allowed', '/blocked'], path_agentprompt: 'agent.md' })]), files: { 'agent.md': 'Agent instructions' } });
  runtime.skills = [join(f.home, 'allowed')];
  await f.load(); await f.start(); assert.deepEqual(await f.emit('resources_discover'), { skillPaths: ['~/allowed'] });
  f.ctx.cwd = 'C:\\project\\folder';
  const skills = [{ filePath: '/skills/one', baseDir: '/skills' }, { filePath: '/skills/two', baseDir: '/skills' }];
  assert.deepEqual(await f.prompt({ appendSystemPrompt: 'Appended', skills }), { customPrompt: 'System instructions', sections: { instructions: 'Appended\n\nAgent instructions' }, contextFiles: [], appendSystemPrompt: '', skills });
  assert.deepEqual((await f.prompt({ skills, selectedTools: ['bash'] })).selectedTools, ['bash']);
  assert.deepEqual((await f.prompt({ skills, selectedTools: [] })).selectedTools, []);
  runtime.skills = []; assert.equal(await f.emit('resources_discover'), undefined);
});

test('configuration edits normalize resources and persist atomically without modifying the running snapshot', async t => {
  const f = await agentFixture(t); await f.load(); await f.start();
  await f.configure({ agents: [profile('reviewer', { model: 42, effort: null, tools: ['read', 7], skills: [false, '/skill'], mcpServers: [remoteMcp], path_agentprompt: '  agent.md  ' }), profile('reviewer', { tools: ['bash'] }), profile('default')] });
  const saved = await f.config(); assert.deepEqual(saved.agents.map(a => a.name), ['reviewer', 'general']);
  assert.equal(saved.agents[0].model, ''); assert.equal(saved.agents[0].effort, 'high'); assert.deepEqual(saved.agents[0].tools, ['read']); assert.deepEqual(saved.agents[0].skills, ['/skill']); assert.deepEqual(saved.agents[0].mcpServers, [remoteMcp]); assert.equal(saved.agents[0].path_agentprompt, 'agent.md');
  assert.equal(saved.webSearchDefaultApplied, true); assert.equal(saved.sessionToolsDefaultApplied, true);
  assert.equal(f.capability().active, 'general'); assert.deepEqual(f.state().snapshot.definition.tools, ['read']);
  assert.equal((await stat(join(f.dir, 'config.json'))).mode & 0o777, 0o600);
  assert.equal((await readdir(f.dir)).some(name => name.endsWith('.tmp')), false);
  const before = await readFile(join(f.dir, 'config.json'), 'utf8');

  for (const change of [{ fastMode: 'yes' }, { path_systemprompt: '' }, { path_systemprompt: 7 }, { systemPrompt: 'inline' }, { developerPrompt: 'inline' }]) {
    await assert.rejects(f.configure(configured([profile('reviewer', change)])));
    assert.equal(await readFile(join(f.dir, 'config.json'), 'utf8'), before);
  }

  await assert.rejects(f.select('unknown'), { message: 'Unknown defined agent: unknown' });
});

for (const development of [false, true]) test(`first run creates private defaults and preserves existing prompts (${development ? 'development' : 'production'})`, async t => {
  const env = development ? { PIOP_STORAGE_DIRECTORY: '.piop-dev' } : {};
  const allTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'web_search', 'fork_session', 'create_worktree', 'remove_worktree', 'subagent'];
  const f = await agentFixture(t, { config: null, env, runtime: { tools: allTools, skills: [] }, tools: allTools, files: { 'home/.agents/AGENTS.md': 'Personal instructions' } });
  await f.load(); const config = await f.config();
  assert.deepEqual(config.agents[0], { name: 'general', model: development ? 'openai-codex/gpt-6-luna' : '', effort: development ? 'medium' : 'high', ...(development ? { fastMode: false } : {}), extensions: [], path_systemprompt: 'sysprompt/default.md', path_agentprompt: `~/${development ? '.piop-dev' : '.piop'}/agents/default.md`, tools: allTools, skills: [], mcpServers: [] });
  assert.equal(config.webSearchDefaultApplied, true); assert.equal(config.sessionToolsDefaultApplied, true);
  const system = join(f.dir, 'sysprompt/default.md'), agent = join(f.home, development ? '.piop-dev' : '.piop', 'agents/default.md');
  assert.match(await readFile(system, 'utf8'), /^You are an expert coding assistant/); assert.equal(await readFile(agent, 'utf8'), 'Personal instructions');
  assert.equal((await stat(system)).mode & 0o777, 0o600); assert.equal((await stat(join(f.dir, 'sysprompt'))).mode & 0o777, 0o700);
  await f.file('sysprompt/default.md', 'Custom system'); await f.file(`home/${development ? '.piop-dev' : '.piop'}/agents/default.md`, 'Custom agent');
  await f.load(); assert.equal(await readFile(system, 'utf8'), 'Custom system'); assert.equal(await readFile(agent, 'utf8'), 'Custom agent');
});

test('legacy prompt and tool migrations preserve content, remove inline fields and run only once', async t => {
  const legacy = { name: 'default', description: 'obsolete', systemPrompt: 'System', developerPrompt: 'Developer', agentsMd: 'Agent notes', tools: ['exec_command', 'apply_patch', 'read', 'web_search'], skills: [], mcpServers: [] };
  const f = await agentFixture(t, { config: { agents: [legacy, { ...legacy, name: ' Reviewer!! ', systemPrompt: '' }] }, runtime: { tools: ['web_search', 'fork_session'], skills: [] } });
  await f.load(); const config = await f.config();
  assert.deepEqual(config.agents.map(a => a.name), ['general', ' Reviewer!! ', 'diagramist']);
  const hash = createHash('sha256').update('default').update('\0').update('System\n\nDeveloper').digest('hex');
  assert.equal(config.agents[0].path_systemprompt, `sysprompt/default-${hash}.md`);
  assert.equal(await readFile(join(f.dir, config.agents[0].path_systemprompt), 'utf8'), 'System\n\nDeveloper');
  assert.match(await readFile(join(f.dir, config.agents[1].path_systemprompt), 'utf8'), /^You are an expert coding assistant[\s\S]*\n\nDeveloper$/);

  for (const agent of config.agents.slice(0, 2)) {
    assert.equal(await readFile(join(f.dir, agent.path_agentprompt), 'utf8'), 'Agent notes');
    assert.deepEqual(agent.tools, ['read', 'bash', 'grep', 'find', 'ls', 'edit', 'write', 'web_search', 'fork_session']);

    for (const field of ['description', 'systemPrompt', 'developerPrompt', 'agentsMd']) assert.equal(field in agent, false);
  }

  config.agents[0].tools = ['read']; await f.file('config.json', JSON.stringify(config)); await f.load(); assert.deepEqual((await f.config()).agents[0].tools, ['read']);
  assert.equal((await readdir(join(f.dir, 'sysprompt'))).some(name => name.endsWith('.tmp')), false);
});

test('invalid configuration and filesystem failures surface instead of silently resetting user settings', async t => {
  const f = await agentFixture(t); await f.file('config.json', '{bad'); await assert.rejects(f.load(), SyntaxError);
  assert.equal(await readFile(join(f.dir, 'config.json'), 'utf8'), '{bad');
  await rm(join(f.dir, 'config.json')); await mkdir(join(f.dir, 'config.json')); await assert.rejects(f.load(), /EISDIR/);
  await rm(join(f.dir, 'config.json'), { recursive: true }); await f.file('config.json', JSON.stringify(configured([profile()])));
  await rm(join(f.home, '.piop/agents/default.md')); await mkdir(join(f.home, '.piop/agents/default.md')); await assert.rejects(f.load(), /EISDIR/);
});

test('legacy migration skips null entries and empty names while retaining a general profile', async t => {
  const f = await agentFixture(t, { config: { agents: [{ name: 'default', tools: [] }, null, { name: '' }, { name: 7 }] } });
  await f.load(); const config = await f.config();
  assert.deepEqual(config.agents.map(agent => agent.name), ['general', 'diagramist']);
  assert.equal(config.agents[0].path_systemprompt, 'sysprompt/default.md');
  assert.equal(config.agents[0].path_agentprompt, '~/.piop/agents/default.md');
});

test('prompt migration preserves intentional emptiness and distinguishes names and contents', async t => {
  const f = await agentFixture(t, { config: { agents: [
    { name: 'general', systemPrompt: '', agentsMd: '   ', tools: [] },
    { name: 'one', systemPrompt: 'Same', developerPrompt: '   ', tools: [] },
    { name: 'two', systemPrompt: 'Same', developerPrompt: 7, agentsMd: 'Notes', tools: [] },
    { name: '!!!', developerPrompt: 'Additional', tools: [] },
    { name: 'explicit', path_systemprompt: 'prompt.md', path_agentprompt: '', systemPrompt: 'Ignore this', agentsMd: 'Ignore this too', tools: [] },
  ] } });

  await f.load(); const agents = (await f.config()).agents;
  assert.equal(await readFile(join(f.dir, agents[0].path_systemprompt), 'utf8'), '');
  assert.equal(agents[0].path_agentprompt, '~/.piop/agents/default.md');
  assert.notEqual(agents[1].path_systemprompt, agents[2].path_systemprompt);
  assert.equal(await readFile(join(f.dir, agents[1].path_systemprompt), 'utf8'), 'Same');
  assert.equal(await readFile(join(f.dir, agents[2].path_systemprompt), 'utf8'), 'Same');
  assert.equal(agents[1].path_agentprompt, ''); assert.equal(await readFile(join(f.dir, agents[2].path_agentprompt), 'utf8'), 'Notes');
  assert.match(agents[3].path_systemprompt, /^sysprompt\/tool-/);
  assert.match(await readFile(join(f.dir, agents[3].path_systemprompt), 'utf8'), /\n\nAdditional$/);
  assert.equal(agents[4].path_systemprompt, 'prompt.md'); assert.equal(agents[4].path_agentprompt, '');
});

test('normalization supplies defaults for absent arrays and filters malformed profiles without dropping valid fields', async t => {
  const f = await agentFixture(t); await f.load(); await f.start();
  const full = profile('reviewer', { model: ' test/review/model ', effort: ' low ', fastMode: false, extensions: [], tools: null, skills: null, mcpServers: undefined, path_agentprompt: 7 });
  await f.configure({ agents: [null, false, {}, { name: '' }, { name: 7 }, full, profile('default')] });
  const config = await f.config(), reviewer = config.agents[0];
  assert.deepEqual(config.agents.map(agent => agent.name), ['reviewer', 'general']);
  assert.equal(reviewer.model, full.model); assert.equal(reviewer.effort, full.effort); assert.equal(reviewer.fastMode, false);
  assert.deepEqual(reviewer.tools, ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']); assert.deepEqual(reviewer.skills, []); assert.deepEqual(reviewer.mcpServers, []); assert.equal(reviewer.path_agentprompt, '');
  await f.select('reviewer'); assert.equal(f.ctx.model.id, 'review/model'); assert.equal(f.pi.getThinkingLevel(), 'low');
  assert.equal(f.state().snapshot.definition.model, 'test/review/model'); assert.equal(f.state().snapshot.definition.effort, 'low');
  await f.configure({ agents: [profile('default'), profile('general')] }); assert.deepEqual((await f.config()).agents.map(agent => agent.name), ['default', 'general']);
  await f.configure({ agents: 'invalid' }); assert.deepEqual((await f.config()).agents.map(agent => agent.name), ['general']);
  await assert.rejects(f.configure(configured([profile('bad', { path_systemprompt: '  ' })])), /requires a nonempty path_systemprompt/);
});

for (const state of [undefined, 'not JSON', { session: 'wrong', model: 'test/review/model', effort: 'low' }, { model: 7, effort: 'low' }, { model: 'test/review/model', effort: 7 }]) test(`runtime defaults reject stale or malformed cache ${JSON.stringify(state)}`, async t => {
  const f = await agentFixture(t);

  if (state !== undefined) process.env.PI_DEFINE_AGENTS_RUNTIME_DEFAULTS = typeof state === 'string' ? state : JSON.stringify({ session: join(f.dir, 'session'), ...state });
  await f.load(); await f.start();
  assert.equal(f.state().snapshot.definition.model, 'test/default'); assert.equal(f.state().snapshot.definition.effort, 'high');
  assert.deepEqual(JSON.parse(process.env.PI_DEFINE_AGENTS_RUNTIME_DEFAULTS), { model: 'test/default', effort: 'high', session: join(f.dir, 'session') });
});

test('matching cached defaults survive a process reload and explicit choices replace them', async t => {
  const f = await agentFixture(t);
  process.env.PI_DEFINE_AGENTS_RUNTIME_DEFAULTS = JSON.stringify({ session: join(f.dir, 'session'), model: 'test/review/model', effort: 'low' });
  await f.load(); await f.start();
  assert.deepEqual(f.ctx.model, { provider: 'test', id: 'review/model' }); assert.equal(f.pi.getThinkingLevel(), 'low'); assert.equal(f.entries.length, 0);
  await f.pi.setModel({ provider: 'test', id: 'default' }); f.pi.setThinkingLevel('medium');
  assert.equal(f.entries.length, 0); assert.equal(f.state().modelOverride, 'test/default'); assert.equal(f.state().effortOverride, 'medium');
  const count = f.modelSelections.length; await f.input('reuse'); assert.equal(f.modelSelections.length, count);
});

test('session restore uses the latest state, ignores unrelated custom records, and handles version changes', async t => {
  const f = await agentFixture(t, { entries: [
    { type: 'custom', customType: 'pi-define-agents-state', data: { active: 'missing', locked: true } },
    { type: 'custom', customType: 'pi-define-agents-state', data: { active: 'default', snapshot: { version: 2, definition: { name: 'missing' } } } },
    { type: 'custom', customType: 'other', data: { active: 'missing' } },
    { type: 'message', message: { role: 'assistant' } },
  ] });

  await f.load(); await f.start(); assert.equal(f.capability().active, 'general'); assert.equal(f.capability().locked, true);
  assert.deepEqual(await f.input('hello'), { action: 'continue' });
  f.entries.length = 0; f.entries.push({ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'missing' } });
  await f.start(); assert.equal(f.capability().unavailable, true); assert.equal(f.capability().saved, false); assert.deepEqual(await f.prompt(), {}); assert.equal(await f.emit('resources_discover'), undefined);
  const request = { ctx: f.ctx }; f.pi.events.emit('piop:agents:refresh', request); await request.ready; assert.deepEqual(f.pi.getActiveTools(), []);
  assert.deepEqual(f.notices.at(-1), { message: 'Agent unavailable: "missing". Select a replacement or general to continue.', level: 'warning' });
});

test('tool validation combines global restrictions and actual availability with deduplicated diagnostics', async t => {
  const f = await agentFixture(t, { tools: ['read', 'bash'], runtime: { tools: ['read', 'unknown'], skills: [] }, config: configured([profile('general', { tools: ['bash', 'unknown', 'bash'] })]) });
  await f.load(); await f.start();
  assert.deepEqual(f.pi.getActiveTools(), []);
  assert.equal(f.notices.at(-1).message, 'Agent "general" cannot run because Pi does not allow its configured tools: bash, unknown');
  assert.deepEqual(await f.input('blocked'), { action: 'handled' });
});

test('extension tools bypass the global builtin allow-list and remain available after refresh', async t => {
  const f = await agentFixture(t, { runtime: { tools: ['read'], skills: [] }, config: configured([profile('general', { extensions: ['extra.mjs'], tools: ['read', 'extra'] })]), files: { 'extra.mjs': 'export default pi => pi.registerTool({ name: "extra", execute: async () => "ok" });' } });
  await f.load(); await f.start(); assert.deepEqual(f.pi.getActiveTools(), ['read', 'extra']);
  const request = { ctx: f.ctx }; f.pi.events.emit('piop:agents:refresh', request); await request.ready; assert.deepEqual(f.pi.getActiveTools(), ['read', 'extra']);
});

test('config publication failures preserve the previous in-memory definitions and remove temporary files', async t => {
  const f = await agentFixture(t); await f.load(); await f.start(); const before = f.capability();
  await rm(join(f.dir, 'config.json')); await mkdir(join(f.dir, 'config.json'));
  await assert.rejects(f.configure(configured([profile('replacement')])), /EISDIR/);
  assert.deepEqual(f.capability(), before); assert.equal((await readdir(f.dir)).some(name => name.endsWith('.tmp')), false);
});

test('each legacy field triggers persistence even when prompt paths already exist', async t => {
  for (const field of ['description', 'systemPrompt', 'developerPrompt', 'agentsMd']) await t.test(field, async t => {
    const f = await agentFixture(t, { config: configured([profile('general', { [field]: 'old value' })]) });
    await f.load(); const saved = await f.config();
    assert.equal(field in saved.agents[0], false);
    assert.equal(saved.agents[0].path_systemprompt, 'prompt.md'); assert.equal(saved.agents[0].path_agentprompt, '');
  });
});

test('absent prompt paths migrate independently while explicit general and default profiles remain distinct', async t => {
  for (const field of ['path_systemprompt', 'path_agentprompt']) await t.test(field, async t => {
    const agent = profile(); delete agent[field];
    const f = await agentFixture(t, { config: configured([agent]) }); await f.load(); const saved = await f.config();
    assert.equal(saved.agents[0][field], field === 'path_systemprompt' ? 'sysprompt/default.md' : '~/.piop/agents/default.md');
  });
  await t.test('distinct profiles', async t => {
    const f = await agentFixture(t, { config: configured([profile('default'), profile('general')]), entries: [{ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'default' } }] });
    await f.load(); await f.start(); assert.equal(f.capability().active, 'default');
    assert.deepEqual(f.capability().config.agents.map(agent => agent.name), ['default', 'general']);
  });
});

test('equivalent skill sets avoid unnecessary reloads after normalization and sorting', async t => {
  const f = await agentFixture(t, { config: configured([profile('general', { skills: ['/skills/b', '~/skills/a', '/skills/b'] }), profile('reviewer', { skills: ['~/skills/a', '/skills/b'] })]) });
  await f.load(); await f.start(); await f.select('reviewer');
  assert.equal(f.capability().active, 'reviewer'); assert.equal(f.state().active, 'reviewer');
});

test('initial startup without a model or persistent session still records stable empty defaults', async t => {
  const f = await agentFixture(t, { model: undefined, effort: '' }); f.ctx.sessionManager.getSessionFile = () => undefined;
  await f.load(); await f.start();
  assert.deepEqual(JSON.parse(process.env.PI_DEFINE_AGENTS_RUNTIME_DEFAULTS), { session: '', model: '', effort: '' });
  assert.equal(f.state().snapshot.definition.model, ''); assert.equal(f.state().snapshot.definition.effort, ''); assert.deepEqual(f.modelSelections, []);
  await f.configure(configured([profile('general', { fastMode: true })]));
  await assert.rejects(f.select('general'), { message: 'Agent "general" cannot run because model (unset) does not support fast mode' });
});

test('fresh sessions recognize conversational history but ignore tool messages and unrelated custom entries', async t => {
  for (const [entry, locked] of [[{ type: 'message', message: { role: 'user' } }, true], [{ type: 'message', message: { role: 'assistant' } }, true], [{ type: 'compaction' }, true], [{ type: 'message', message: { role: 'toolResult' } }, false], [{ type: 'custom', customType: 'unrelated', data: { locked: true } }, false]]) await t.test(JSON.stringify(entry), async t => {
    const f = await agentFixture(t, { entries: [entry] }); await f.load(); await f.start(); assert.equal(f.capability().locked, locked);
    const count = f.entries.length; await f.input('hello'); assert.equal(f.entries.length, count + 1);
    await f.input('again'); assert.equal(f.entries.length, count + 1);
  });
});

test('tool migration adds missing defaults only once and never removes explicit builtin choices', async t => {
  const runtime = { tools: ['web_search', 'fork_session'], skills: [] };
  const f = await agentFixture(t, { runtime, config: { agents: [profile('general', { tools: ['read'] }), profile('reviewer', { tools: ['web_search'] })] } });
  await f.load(); const saved = await f.config();
  assert.deepEqual(saved.agents[0].tools, ['read', 'fork_session', 'web_search']); assert.deepEqual(saved.agents[1].tools, ['web_search', 'fork_session']);
  saved.agents[0].tools = []; await f.file('config.json', JSON.stringify(saved)); await f.load(); assert.deepEqual((await f.config()).agents[0].tools, []);
});

test('an unreadable inherited agent prompt does not silently become an empty prompt', async t => {
  const f = await agentFixture(t, { config: null }); await mkdir(join(f.home, '.agents/AGENTS.md'), { recursive: true });
  await assert.rejects(f.load(), /EISDIR/);
  await assert.rejects(readFile(join(f.home, '.piop/agents/default.md')), /ENOENT/);
});

test('absolute and home-relative prompt paths retain whitespace content and canonical cwd separators', async t => {
  const f = await agentFixture(t, { config: configured([profile('general', { path_systemprompt: '~/system.md', path_agentprompt: '~/agent.md' })]), files: { 'home/system.md': '  System\n', 'home/agent.md': '   ' } });
  await f.load(); await f.start(); assert.deepEqual(await f.prompt(), { customPrompt: '  System\n', sections: { instructions: '' }, contextFiles: [], appendSystemPrompt: '', skills: undefined });
  await f.configure(configured([profile('general', { path_systemprompt: join(f.home, 'system.md'), path_agentprompt: '' })]));
  await f.select('general'); assert.deepEqual(await f.prompt({ selectedTools: [], appendSystemPrompt: '' }), { selectedTools: [], customPrompt: '  System\n', sections: { instructions: '' }, contextFiles: [], appendSystemPrompt: '', skills: undefined });
});

test('current configurations are read without rewriting their contents or replacing their inode', async t => {
  const f = await agentFixture(t); const content = `\n${JSON.stringify(configured([profile(), profile('default')]))}\n`;
  await f.file('config.json', content); const before = await stat(join(f.dir, 'config.json'));
  await f.load(); await f.start();
  assert.equal(await readFile(join(f.dir, 'config.json'), 'utf8'), content); assert.equal((await stat(join(f.dir, 'config.json'))).ino, before.ino);
});

test('tool alias migrations persist even when resource defaults were already applied', async t => {
  for (const [alias, expected] of [['exec_command', ['read', 'bash', 'grep', 'find', 'ls']], ['apply_patch', ['edit', 'write']]]) await t.test(alias, async t => {
    const f = await agentFixture(t, { config: configured([profile('general', { tools: [alias] }), profile('reviewer', { tools: ['read'] })]) });
    await f.load(); const agents = (await f.config()).agents;
    assert.deepEqual(agents[0].tools, expected); assert.deepEqual(agents[1].tools, ['read']);
  });
});

test('concurrent config creation preserves the fully written winning configuration', async t => {
  const winner = configured([profile('general', { effort: 'medium' })]);

  const adapter = `export { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
    import { link as actualLink, writeFile } from 'node:fs/promises';
    let injected = false;
    export async function link(from, to) {
      if (to.endsWith('/config.json') && !injected) { injected = true; await writeFile(to, ${JSON.stringify(JSON.stringify(winner))}); }
      return actualLink(from, to);
    }`;

  const f = await agentFixture(t, { config: null, files: { 'fs.mjs': adapter } });
  await f.load(); assert.deepEqual(await f.config(), winner); await f.start(); assert.equal(f.pi.getThinkingLevel(), 'medium');
  assert.equal((await readdir(f.dir)).some(name => name.endsWith('.tmp')), false);
});

test('atomic publication reports unexpected link failures and cleans temporary files', async t => {
  for (const target of ['config.json', 'sysprompt/default.md']) await t.test(target, async t => {
    const adapter = `export { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
      import { link as actualLink } from 'node:fs/promises';
      let injected = false;
      export async function link(from, to) {
        if (to.endsWith(${JSON.stringify(`/${target}`)}) && !injected) { injected = true; throw Object.assign(new Error('publication denied'), { code: 'EACCES' }); }
        return actualLink(from, to);
      }`;

    const f = await agentFixture(t, { config: null, files: { 'fs.mjs': adapter } });
    await assert.rejects(f.load(), { message: 'publication denied', code: 'EACCES' });
    assert.equal((await readdir(f.dir)).some(name => name.endsWith('.tmp')), false);
    assert.equal((await readdir(join(f.dir, 'sysprompt'))).some(name => name.endsWith('.tmp')), false);
  });
});

test('agent-specific effort never replaces the runtime default when the user changes model', async t => {
  const f = await agentFixture(t, { config: configured([profile(), profile('reviewer', { effort: 'low' })]) });
  await f.load(); await f.start(); await f.select('reviewer'); assert.equal(f.pi.getThinkingLevel(), 'low');
  await f.pi.setModel({ provider: 'test', id: 'review/model' });
  assert.equal(JSON.parse(process.env.PI_DEFINE_AGENTS_RUNTIME_DEFAULTS).effort, 'high');
  await f.select('general'); assert.equal(f.pi.getThinkingLevel(), 'high');
});

test('model selection failures clear suppression markers before the user retries manually', async t => {
  for (const rejection of [false, new Error('unavailable')]) await t.test(String(rejection), async t => {
    const f = await agentFixture(t, { config: configured([profile(), profile('reviewer', { model: 'test/review/model' })]) }); await f.load(); await f.start();
    const setModel = f.pi.setModel;
    f.pi.setModel = async () => { if (rejection === false) return false; throw rejection; };

    await assert.rejects(f.select('reviewer')); f.pi.setModel = setModel;
    const count = f.entries.length; await f.pi.setModel({ provider: 'test', id: 'review/model' });
    assert.equal(f.entries.length, count); assert.equal(f.state().modelOverride, 'test/review/model');
  });
});

test('startup publishes the selected definition before asynchronous model selection completes', async t => {
  const f = await agentFixture(t, { config: configured([profile('general', { model: 'test/review/model' })]) }); await f.load();
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  f.pi.setModel = async model => { started.resolve(); await gate.promise; f.ctx.model = model; await f.emit('model_select', { model });

  return true; };

  const pending = f.start(); let timer;

  try { await Promise.race([started.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Model was not selected')), 1000); })]); assert.equal(f.capability().active, 'general'); }
  finally { clearTimeout(timer); gate.resolve(); await pending; }

  assert.equal(f.capability().saved, true);
});

test('configuration and refresh publish new capability data and discard stale non-MCP active tools', async t => {
  const fastModels = ['test/default'];
  const f = await agentFixture(t, { fastModels }); await f.load(); await f.start();
  await f.configure(configured([profile(), profile('new-agent')])); assert.deepEqual(f.capability().config.agents.map(agent => agent.name), ['general', 'new-agent']);
  f.pi.events.on('piop:mcp:tools', request => { request.tools = ['mcp_remote_read']; });
  f.pi.setActiveTools(['read', 'stale', 'mcp_remote_read']); fastModels.push('test/review/model');
  const request = { ctx: f.ctx }; f.pi.events.emit('piop:agents:refresh', request); await request.ready;
  assert.deepEqual(f.pi.getActiveTools(), ['read', 'mcp_remote_read']); assert.deepEqual(f.capability().config.fastModeModels, fastModels);
});

test('session restore selects the last matching custom record and preserves its lock without message history', async t => {
  const f = await agentFixture(t, { entries: [
    { type: 'custom', customType: 'pi-define-agents-state', data: { active: 'general' } },
    { type: 'custom', customType: 'pi-define-agents-state', data: { active: 'reviewer', locked: true } },
    { type: 'custom', customType: 'unrelated', data: { active: 'general', locked: false } },
    { type: 'other', customType: 'pi-define-agents-state', data: { active: 'general' } },
  ] });

  await f.load(); await f.start();
  assert.equal(f.capability().active, 'reviewer'); assert.equal(f.capability().locked, true);
  const count = f.entries.length; await f.input('go'); assert.equal(f.entries.length, count + 1);
  await f.input('again'); assert.equal(f.entries.length, count + 1);
});

test('restored fast-mode snapshots validate both configured models and conversation overrides', async t => {
  for (const [model, override] of [['test/no-fast', 'test/default'], ['test/default', 'test/no-fast']]) await t.test(`${model}:${override}`, async t => {
    const definition = profile('general', { model, fastMode: true });
    const f = await agentFixture(t, { fastModels: ['test/default'], entries: [{ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'general', modelOverride: override, snapshot: { version: 1, definition, systemPrompt: 'Saved prompt', agentPrompt: '' } } }] });
    await f.load(); await f.start(); assert.deepEqual(f.pi.getActiveTools(), []);
    assert.equal(f.notices.at(-1).message, 'Agent "general" cannot run because model test/no-fast does not support fast mode');
    assert.deepEqual(await f.input('blocked'), { action: 'handled' });
  });
});

test('plain command names are trimmed, invalid encoded values are rejected, and command descriptions remain useful', async t => {
  const f = await agentFixture(t); await f.load(); await f.start();
  assert.equal(f.commands.get('pi-define-agents-use').description, 'Select a defined agent'); assert.equal(f.commands.get('pi-define-agents-config').description, 'Update agent definitions');
  await f.select(' reviewer '); assert.equal(f.capability().active, 'reviewer');
  await assert.rejects(f.select(encoded({ name: 'general' })), { message: `Unknown defined agent: ${encoded({ name: 'general' })}` });
});

test('new default profiles retain available session tools after one-time migrations are finished', async t => {
  const tools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'web_search', 'fork_session', 'create_worktree', 'remove_worktree'];
  const f = await agentFixture(t, { runtime: { tools, skills: [] }, tools });
  f.pi.events.on('piop:fast-mode', request => { if (!request.apply) delete request.models; });
  await f.load(); await f.start(); await f.configure({ agents: [] });
  assert.deepEqual((await f.config()).agents[0].tools, tools); assert.deepEqual(f.capability().config.fastModeModels, []);
});

test('disabled embedded MCP servers do not enable stale globally registered tools', async t => {
  const f = await agentFixture(t, { config: configured([profile('general', { mcpServers: [{ ...remoteMcp, enabled: false }] })]), tools: ['read', 'mcp_my_server_query', 'mcp_my__server_query', 'mcp__my_server__query'] });
  await f.load(); await f.start(); assert.deepEqual(f.pi.getActiveTools(), ['read']); assert.deepEqual(await f.input('connect'), { action: 'continue' }); assert.deepEqual(f.pi.getActiveTools(), ['read']);
});

test('shutdown removes agent extension listeners and missing-agent refresh clears externally enabled tools', async t => {
  const f = await agentFixture(t, { config: configured([profile('general', { extensions: ['extra.mjs'] })]), files: { 'extra.mjs': 'export default pi => pi.events.on("test:ping", () => pi.appendEntry("ping", {}));' } });
  await f.load(); await f.start(); f.pi.events.emit('test:ping', {}); assert.equal(f.entries.at(-1).customType, 'ping');
  await f.emit('session_shutdown'); const count = f.entries.length; f.pi.events.emit('test:ping', {}); assert.equal(f.entries.length, count);
  await f.load(); f.entries.push({ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'missing' } }); await f.start(); assert.deepEqual(f.pi.getActiveTools(), []);
  f.pi.setActiveTools(['read']); const request = { ctx: f.ctx }; f.pi.events.emit('piop:agents:refresh', request); await request.ready; assert.deepEqual(f.pi.getActiveTools(), []);
});

test('configuration errors identify the invalid field instead of leaking incidental type errors', async t => {
  const f = await agentFixture(t); await f.load();

  for (const path_systemprompt of [null, 7, false, '', '   ']) await assert.rejects(f.configure(configured([profile('bad', { path_systemprompt })])), { message: 'Agent "bad" requires a nonempty path_systemprompt' });

  for (const field of ['systemPrompt', 'developerPrompt']) await assert.rejects(f.configure(configured([profile('bad', { [field]: 'inline' })])), { message: 'Agent "bad" must link a system prompt file using path_systemprompt' });
  await assert.rejects(f.configure(configured([profile('bad', { fastMode: 'yes' })])), { message: 'Agent "bad" fastMode must be a boolean' });
});

test('adding profiles supplies a missing general profile and inherited agent prompt paths', async t => {
  const f = await agentFixture(t); await f.load();
  await f.configure(configured([profile('reviewer')])); assert.deepEqual((await f.config()).agents.map(agent => agent.name), ['general', 'reviewer']);

  for (const name of ['general', 'default']) {
    const agent = profile(name); delete agent.path_agentprompt;
    await f.configure(configured([agent])); assert.equal((await f.config()).agents[0].path_agentprompt, '~/.piop/agents/default.md');
  }
});

test('renaming a legacy default is persisted even when every other field is current', async t => {
  const f = await agentFixture(t, { config: configured([profile('default')]) }); await f.load();
  assert.deepEqual((await f.config()).agents.map(agent => agent.name), ['general']);
});

test('legacy prompt type errors and whitespace fall back to the default system prompt', async t => {
  const f = await agentFixture(t, { config: { agents: [
    { name: 'general', systemPrompt: 7, tools: [] },
    { name: 'reviewer', systemPrompt: '   ', developerPrompt: 'Additional', tools: [] },
  ] } });

  await f.load(); const agents = (await f.config()).agents;
  assert.equal(agents[0].path_systemprompt, 'sysprompt/default.md');
  assert.match(await readFile(join(f.dir, agents[1].path_systemprompt), 'utf8'), /^You are an expert coding assistant[\s\S]*\n\nAdditional$/);
  assert.equal(await readFile(join(f.home, '.piop/agents/default.md'), 'utf8'), '');
});

test('MCP is deferred until input for selection, startup, and rollback', async t => {
  const f = await agentFixture(t, { env: { PI_DESKTOP_MCP_CONFIG: 'fixture' }, config: configured([profile(), profile('reviewer'), profile('broken', { tools: ['missing'] }), profile('broken-skills', { tools: ['missing'], skills: ['/new'] })]) });
  const calls = []; f.pi.events.on('piop:mcp:select', request => { calls.push(request); request.ready = Promise.resolve([]); });
  await f.load(); await f.start(); assert.equal(calls.length, 0);
  await f.select('reviewer'); assert.equal(calls.length, 0);

  for (const name of ['broken', 'broken-skills']) { await assert.rejects(f.select(name), /does not allow/); assert.equal(calls.length, 0); }

  await f.input('hello'); assert.equal(calls.length, 1);
});

test('fast-mode preflight rejects unsupported models before attempting to load extensions', async t => {
  const f = await agentFixture(t, { fastModels: ['test/default'], config: configured([profile(), profile('fast', { fastMode: true }), profile('unsupported', { fastMode: true, model: 'test/unsupported', extensions: ['missing.mjs'] })]) });
  await f.load(); await f.select('fast'); assert.equal(f.capability().active, 'fast');
  await assert.rejects(f.select('unsupported'), { message: 'Agent "unsupported" cannot run because model test/unsupported does not support fast mode' });
});

test('fast-mode model names are trimmed consistently during preflight and activation', async t => {
  const f = await agentFixture(t, { fastModels: ['test/default'], config: configured([profile('general', { model: ' test/default ', fastMode: true })]) });
  await f.load(); await f.start(); assert.deepEqual(f.notices, []); assert.deepEqual(f.pi.getActiveTools(), ['read']);
  await f.select('general'); assert.equal(f.state().snapshot.definition.model, 'test/default');
});

test('implicit default profiles do not trigger a config rewrite without a legacy rename', async t => {
  const config = configured([profile('reviewer')]); const f = await agentFixture(t, { config });
  await f.load(); await f.start(); assert.deepEqual(f.capability().config.agents.map(agent => agent.name), ['general', 'reviewer']); assert.deepEqual(await f.config(), config);
});

test('atomic writes reject colliding temporary files and preserve the original write error', async t => {
  for (const target of ['config.json', 'sysprompt/default.md']) for (const mode of ['collision', 'denied']) await t.test(`${target}:${mode}`, async t => {
    const adapter = `export { mkdir, readFile, rename, rm, link } from 'node:fs/promises';
      import { writeFile as actualWrite } from 'node:fs/promises';
      let injected = false;
      export async function writeFile(path, contents, options) {
        if (path.includes(${JSON.stringify(`/${target}.`)}) && !injected) {
          injected = true;
          if (${JSON.stringify(mode)} === 'denied') throw Object.assign(new Error('write denied'), { code: 'EACCES' });
          await actualWrite(path, 'competing writer');
        }
        return actualWrite(path, contents, options);
      }`;

    const f = await agentFixture(t, { config: null, files: { 'fs.mjs': adapter } });
    await assert.rejects(f.load(), { code: mode === 'collision' ? 'EEXIST' : 'EACCES' });
    assert.equal((await readdir(f.dir)).some(name => name.endsWith('.tmp')), false);
  });
});

test('model and effort events can arrive before session defaults have been captured', async t => {
  for (const kind of ['model', 'effort']) await t.test(kind, async t => {
    const f = await agentFixture(t); await f.load();

    if (kind === 'model') { await f.pi.setModel({ provider: 'test', id: 'review/model' }); assert.deepEqual(JSON.parse(process.env.PI_DEFINE_AGENTS_RUNTIME_DEFAULTS), { session: '', model: 'test/review/model', effort: 'high' }); }
    else { f.pi.setThinkingLevel('low'); assert.deepEqual(JSON.parse(process.env.PI_DEFINE_AGENTS_RUNTIME_DEFAULTS), { session: '', model: '', effort: 'low' }); }
  });
});

test('null historical agent state does not hide the latest valid selection', async t => {
  const f = await agentFixture(t, { entries: [{ type: 'custom', customType: 'pi-define-agents-state', data: null }, { type: 'custom', customType: 'pi-define-agents-state', data: { active: 'reviewer' } }] });
  await f.load(); await f.start(); assert.equal(f.capability().active, 'reviewer'); assert.equal(f.capability().locked, false);
});

test('initial resource discovery exposes the general agents skills before session startup', async t => {
  const f = await agentFixture(t, { config: configured([profile('general', { skills: ['/startup-skill'] })]) });
  await f.load(); assert.deepEqual(await f.emit('resources_discover'), { skillPaths: ['/startup-skill'] });
});

test('migrated agent prompts with ambiguous name/content boundaries never share a file', async t => {
  const f = await agentFixture(t, { config: { agents: [
    { name: 'a', path_systemprompt: 'prompt.md', agentsMd: '!bc', tools: [] },
    { name: 'a!', path_systemprompt: 'prompt.md', agentsMd: 'bc', tools: [] },
  ] } });

  await f.load(); const agents = (await f.config()).agents.filter(agent => agent.name !== 'general');
  assert.notEqual(agents[0].path_agentprompt, agents[1].path_agentprompt);
  assert.equal(await readFile(join(f.dir, agents[0].path_agentprompt), 'utf8'), '!bc'); assert.equal(await readFile(join(f.dir, agents[1].path_agentprompt), 'utf8'), 'bc');
});
