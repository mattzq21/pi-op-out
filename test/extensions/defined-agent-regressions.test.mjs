import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentFixture, profile, configured } from '../defined-agent-fixture.mjs';

test('subagent migration adds the available tool once', async t => {
  const config = configured([profile(), profile('reviewer', { tools: ['read', 'spawn_subagents'] })]);
  delete config.subagentsDefaultApplied;
  const f = await agentFixture(t, { config, runtime: { enabledTools: ['read', 'spawn_subagents'] }, tools: ['read', 'spawn_subagents'] });
  await f.load();
  assert.deepEqual((await f.configuration()).agents.map(agent => [agent.name, agent.tools]), [
    ['general', ['read', 'spawn_subagents']], ['reviewer', ['read', 'spawn_subagents']],
  ]);
});


test('obsolete voice agents are removed and restored voice selections fall back to general', async t => {
  const f = await agentFixture(t, { config: configured([profile(), profile('voice-orchestrator')]), entries: [{ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'voice-orchestrator' } }] });
  await f.load(); await f.start();
  assert.deepEqual((await f.configuration()).agents.map(agent => agent.name), ['general']);
  assert.equal(f.capability().active, 'general');
});


test('prompt options clear duplicate project context and mark explicit skills by file or directory', async t => {
  const f = await agentFixture(t, { config: null, runtime: { enabledTools: ['read'], skills: { userInvokedSkills: ['/skills/file/SKILL.md', '/skills/directory/'], agentInvokedSkills: [] } } });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer')]));
  await f.start();

  const skills = [
    { filePath: '/skills/file/SKILL.md', baseDir: '/skills/file' },
    { filePath: '/skills/directory/SKILL.md', baseDir: '/skills/directory' },
    { filePath: '/skills/normal/SKILL.md', baseDir: '/skills/normal' },
  ];

  const result = await f.prompt({ contextFiles: [{ path: 'a&"<>b', content: 'First instructions' }, { path: 'second', content: 'Second instructions' }], skills });
  assert.equal(result.customPrompt, 'System instructions');
  assert.deepEqual(result.contextFiles, []);
  assert.deepEqual(result.skills, [
    { filePath: '/skills/file/SKILL.md', baseDir: '/skills/file', disableModelInvocation: true },
    { filePath: '/skills/directory/SKILL.md', baseDir: '/skills/directory', disableModelInvocation: true },
    { filePath: '/skills/normal/SKILL.md', baseDir: '/skills/normal' },
  ]);
  assert.ok(skills.every(skill => skill.disableModelInvocation === undefined));
});



test('legacy prompt filenames keep interior underscores and strip all boundary separators', async t => {
  const name = '__Review__Me!!Next__';
  const f = await agentFixture(t, { config: { agents: [{ name, systemPrompt: 'Legacy', tools: ['read'] }] } });
  await f.load();
  const agent = (await f.configuration()).agents.find(agent => agent.name === name);
  assert.match(agent.path_systemprompt, /^sysprompt\/review__me_next-[^/]+\.md$/);
  assert.equal(await readFile(join(f.dir, agent.path_systemprompt), 'utf8'), 'Legacy');
});

test('fast mode keeps custom provider identifiers and does not change their requests', async t => {
  const model = { provider: 'custom-openai', id: 'gpt-5.4', api: 'openai-responses' };
  const f = await agentFixture(t, {
    model, models: [model],
    config: null,
    realFastMode: { catalog: [{ slug: 'gpt-5.4', service_tiers: [{ id: 'priority' }] }] },
  });
  await f.load();
  await f.configure(configured([profile('general', { model: 'custom-openai/gpt-5.4', fastMode: true })]));
  await f.start(); await f.select('general');
  assert.deepEqual(f.notices, []);
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
  assert.deepEqual(await f.input('hello'), { action: 'continue' });
  assert.equal(f.ctx.model.provider, 'custom-openai');
  assert.equal(f.ctx.model.id, 'gpt-5.4');
  assert.equal(await f.emit('before_provider_request', { payload: { input: 'hello' } }), undefined);
});

test('explicit agent selection applies fast-mode defaults while input leaves manual choices alone', async t => {
  const model = { provider: 'openai', id: 'gpt-5.4', api: 'openai-responses' };
  const f = await agentFixture(t, {
    model, models: [model],
    config: null,
    realFastMode: { catalog: [{ slug: 'gpt-5.4', service_tiers: [{ id: 'priority' }] }] },
  });
  await f.load();
  await f.configure(configured([profile('general', { fastMode: false }), profile('reviewer', { fastMode: true })]));
  await f.start();
  assert.equal(await f.fastEnabled(), false);
  await f.select('reviewer');
  assert.equal(await f.fastEnabled(), true);
  assert.deepEqual(await f.emit('before_provider_request', { payload: { input: 'hello' } }), { input: 'hello', service_tier: 'priority' });
  await f.commands.get('fast').handler('off', f.ctx);
  assert.deepEqual(await f.input('hello'), { action: 'continue' });
  assert.equal(await f.fastEnabled(), false);
  assert.equal(await f.emit('before_provider_request', { payload: { input: 'hello' } }), undefined);
});

test('session-tree changes keep the selected agent, prompt and lock', async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  await f.configure(configured([profile(), profile('reviewer')]));
  await f.start();
  await f.input('hello');
  f.entries.splice(0, f.entries.length, { type: 'custom', customType: 'pi-define-agents-state', data: { active: 'reviewer', snapshot: { version: 1, definition: profile('reviewer', { tools: ['bash'] }), systemPrompt: 'Branch prompt', agentPrompt: '' } } });
  await f.emit('session_tree');
  assert.equal(f.capability().active, 'general'); assert.deepEqual(f.pi.getActiveTools(), ['read']);
  assert.equal((await f.prompt()).customPrompt, 'System instructions');
  assert.equal(f.capability().locked, true);
  await assert.rejects(f.select('reviewer'), /agent is fixed/);
  f.entries.splice(0);
  await f.emit('session_tree');
  assert.equal(f.capability().locked, true);
  await assert.rejects(f.select('reviewer'), /agent is fixed/);
  f.ctx.sessionManager.getSessionFile = () => join(f.dir, 'new-session');
  f.ctx.sessionManager.getSessionId = () => 'new-session';
  await f.start();
  assert.equal(f.capability().locked, false);
  await f.select('reviewer');
  assert.equal(f.capability().active, 'reviewer');
});

test('input before session startup preserves the selected prompt across reload', async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  await f.configure(configured([profile(), profile('reviewer')]));
  assert.deepEqual(await f.input('early'), { action: 'continue' });
  assert.equal(f.capability().active, 'general');
  assert.equal(f.capability().locked, true);
  // Pi records an accepted user message after extension input handlers finish.
  f.entries.push({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'early' }], timestamp: 1 } });
  await f.file('prompt.md', 'Changed after input');
  await f.reloadExtensions();
  assert.equal(f.capability().active, 'general');
  assert.equal(f.capability().locked, true);
  assert.equal((await f.prompt()).customPrompt, 'System instructions');
});

test('session tool migration persists independently of the other completed migrations', async t => {
  const config = configured([profile()]); config.sessionToolsDefaultApplied = false;
  const f = await agentFixture(t, { config, runtime: { enabledTools: ['read', 'spawn_subagents'] }, tools: ['read', 'spawn_subagents'] });
  await f.load(); await f.start();
  assert.deepEqual(f.pi.getActiveTools(), ['read', 'spawn_subagents']);
  await f.reloadExtensions();
  assert.deepEqual((await f.configuration()).agents[0].tools, ['read', 'spawn_subagents']);
  assert.deepEqual(f.pi.getActiveTools(), ['read', 'spawn_subagents']);
});


test('subagents use model overrides even when they differ from cached runtime defaults', async t => {
  const f = await agentFixture(t, { config: null, entries: [{ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'general', modelOverride: 'test/review/model' } }] });
  await f.load(); await f.start();
  const request = {}; f.pi.events.emit('piop:agents:subagent', request);
  assert.equal(request.state.modelOverride, 'test/review/model');
  assert.equal(request.state.snapshot.definition.model, 'test/default');
});

test('subagent state is available before runtime defaults have been captured', async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  const request = {}; f.pi.events.emit('piop:agents:subagent', request);
  assert.equal(request.state.active, 'general'); assert.equal(request.state.modelOverride, undefined);
  assert.equal(request.state.effortOverride, 'high');
});

test('replacing an unavailable agent with a skill-free profile does not reload resources', async t => {
  const f = await agentFixture(t, { config: null, entries: [{ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'missing' } }] });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer')]));
  await f.start(); assert.equal(f.capability().unavailable, true);
  await f.select('general'); assert.equal(f.capability().active, 'general'); assert.equal(f.capability().unavailable, false);
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
});

test("an inherited subagent receives the selected profile and manual model and effort", async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  await f.configure(configured([profile(), profile('reviewer')]));
  await f.start();
  await f.pi.setModel({ provider: 'test', id: 'review/model' }); f.pi.setThinkingLevel('low');
  const request = {}; f.pi.events.emit('piop:agents:subagent', request);
  assert.equal(request.state.active, 'general');
  assert.equal(request.state.locked, false);
  assert.equal(request.state.modelOverride, 'test/review/model');
  assert.equal(request.state.effortOverride, 'low');
  assert.equal(request.state.snapshot.definition.name, 'general');
  assert.deepEqual(request.state.snapshot.definition.tools, ['read']);
});

test("editing returned subagent tools cannot change the parent or another subagent", async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  await f.configure(configured([profile(), profile('reviewer')]));
  await f.start();
  const first = {}; f.pi.events.emit('piop:agents:subagent', first);
  first.state.snapshot.definition.tools.push('mutated');
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
  const second = {}; f.pi.events.emit('piop:agents:subagent', second);
  assert.deepEqual(second.state.snapshot.definition.tools, ['read']);
});

test("a named subagent uses its own profile defaults and prompt", async t => {
  const f = await agentFixture(t, { config: null });
  await f.load();
  await f.configure(configured([profile(), profile('reviewer', { model: 'test/default', effort: 'high' })]));
  await f.start();
  await f.pi.setModel({ provider: 'test', id: 'review/model' }); f.pi.setThinkingLevel('low');
  const request = { agent: 'reviewer' }; f.pi.events.emit('piop:agents:subagent', request); await request.ready;
  assert.equal(request.state.active, 'reviewer'); assert.equal(request.state.locked, false);
  assert.equal(request.state.snapshot.definition.name, 'reviewer');
  assert.equal(request.state.snapshot.definition.model, 'test/default');
  assert.equal(request.state.snapshot.definition.effort, 'high');
  assert.equal(request.state.snapshot.systemPrompt, 'System instructions');
  assert.deepEqual(request.state.snapshot.definition.tools, ['read']);
});

test("an unknown subagent profile reports the available profiles without returning state", async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  await f.configure(configured([profile(), profile('reviewer')]));
  await f.start();
  const request = { agent: 'missing' }; f.pi.events.emit('piop:agents:subagent', request); await request.ready;
  assert.equal(request.error, 'Unknown agent profile missing. Available profiles: general, reviewer');
  assert.equal(request.state, undefined);
});

test("agent access rules decide which subagents and peers can start", async t => {
  const f = await agentFixture(t, { config: null }); await f.load();
  await f.configure(configured([profile('general', { allowed_subagents: ['helper'], allowed_peers: 'none' }), profile('helper'), profile('private', { allow_as_subagent: false })]));
  await f.start();
  const start = async (agent, purpose) => { const request = { agent, purpose }; f.pi.events.emit('piop:agents:subagent', request); await request.ready; return request; };
  assert.equal((await start('helper', 'subagent')).state.active, 'helper');
  assert.equal((await start('private', 'subagent')).error, 'Agent private cannot be used as a subagent');
  assert.equal((await start(undefined, 'subagent')).error, 'Agent general cannot start agent general as a subagent');
  assert.equal((await start('helper', 'peer')).error, 'Agent general cannot start agent helper as a peer');
  assert.equal((await start('private')).state.active, 'private');
});

test("agent shutdown releases the subagent profile service", async t => {
  const f = await agentFixture(t, { config: null }); await f.load(); await f.start();
  const before = {}; f.pi.events.emit('piop:agents:subagent', before);
  assert.equal(before.state.active, 'general');
  await f.emit('session_shutdown');
  const after = {}; f.pi.events.emit('piop:agents:subagent', after);
  assert.deepEqual(after, {});
});

test('removing the migrated subagent tool remains effective after reload', async t => {
  const config = configured([profile()]); delete config.subagentsDefaultApplied;
  const f = await agentFixture(t, { config, runtime: { enabledTools: ['read', 'spawn_subagents'] }, tools: ['read', 'spawn_subagents'] });
  await f.load(); await f.start();
  assert.deepEqual(f.pi.getActiveTools(), ['read', 'spawn_subagents']);
  await f.configure({ agents: [profile()] });
  await f.reloadExtensions();
  assert.deepEqual((await f.configuration()).agents[0].tools, ['read']);
  await f.select('general');
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
});

test('saving an agent whose prompt file does not exist is rejected and keeps the saved agents', async t => {
  const f = await agentFixture(t, { config: configured([profile()]) });
  await f.load();
  const before = await f.configuration();
  await assert.rejects(f.configure(configured([profile('general', { path_agent_prompt: '~/missing/agent.md' })])), /Agent "general": Agent prompt file ~\/missing\/agent\.md does not exist/);
  await assert.rejects(f.configure(configured([profile('general', { path_systemprompt: 'missing.md' })])), /System prompt file missing\.md does not exist/);
  assert.deepEqual((await f.configuration()).agents, before.agents);
});
