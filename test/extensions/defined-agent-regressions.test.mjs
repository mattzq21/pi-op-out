import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { agentFixture, profile, configured } from '../defined-agent-fixture.mjs';

test('subagent migration adds the available tool once and preserves later user removals', async t => {
  const config = configured([profile(), profile('reviewer', { tools: ['read', 'subagent'] })]);
  delete config.subagentsDefaultApplied;
  const f = await agentFixture(t, { config, runtime: { tools: ['read', 'subagent'], skills: [] } });
  await f.load();
  const saved = await f.config();
  assert.equal(saved.subagentsDefaultApplied, true);
  assert.deepEqual(saved.agents.map(agent => agent.tools), [['read', 'subagent'], ['read', 'subagent']]);
  saved.agents[0].tools = ['read']; await f.file('config.json', JSON.stringify(saved));
  await f.load(); assert.deepEqual(await f.config(), saved);
});

test('question migration creates an asker and removes questions only from general', async t => {
  const config = configured([profile('general', { tools: ['read', 'request_user_input_async', 'request_user_input'] }), profile('reviewer', { tools: ['request_user_input_async', 'read', 'request_user_input'] })]);
  delete config.askerAgentDefaultApplied;
  const f = await agentFixture(t, { config, runtime: { tools: ['read', 'request_user_input'], skills: [] } });
  await f.load();
  const saved = await f.config();
  assert.equal(saved.askerAgentDefaultApplied, true);
  assert.deepEqual(saved.agents.map(agent => [agent.name, agent.tools]), [['general', ['read']], ['reviewer', ['request_user_input', 'read']], ['asker-agent', ['read', 'request_user_input']]]);
  saved.agents = saved.agents.filter(agent => agent.name !== 'asker-agent');
  await f.file('config.json', JSON.stringify(saved)); await f.load(); assert.deepEqual(await f.config(), saved);
});

test('terminal migration isolates lookup tools and preserves an existing terminal profile', async t => {
  const config = configured([profile('general', { tools: ['read', 'lookup_terminals'] }), profile('reviewer', { tools: ['lookup_terminals', 'read'] })]);
  delete config.terminalAgentDefaultApplied;
  const f = await agentFixture(t, { config, runtime: { tools: ['read', 'lookup_terminals'], skills: [] } });
  await f.load();
  const saved = await f.config();
  assert.equal(saved.terminalAgentDefaultApplied, true);
  assert.deepEqual(saved.agents.map(agent => [agent.name, agent.tools]), [['general', ['read']], ['reviewer', ['read']], ['terminal-agent', ['read', 'lookup_terminals']]]);
  saved.agents[2].tools = ['lookup_terminals']; saved.terminalAgentDefaultApplied = false;
  await f.file('config.json', JSON.stringify(saved)); await f.load();
  const again = await f.config();
  assert.deepEqual(again.agents, saved.agents); assert.equal(again.terminalAgentDefaultApplied, true);
  again.agents = again.agents.filter(agent => agent.name !== 'terminal-agent');
  await f.file('config.json', JSON.stringify(again)); await f.load(); assert.deepEqual(await f.config(), again);
});

test('diagramist migration writes its instructions and preserves an existing custom profile', async t => {
  const config = configured([profile()]); delete config.diagramistDefaultApplied;
  const f = await agentFixture(t, { config }); await f.load();
  const saved = await f.config();
  assert.equal(saved.diagramistDefaultApplied, true);
  const diagramist = saved.agents.find(agent => agent.name === 'diagramist');
  assert.deepEqual(diagramist.extensions, ['../piop-diagrams.ts']);
  assert.match(await readFile(join(f.dir, diagramist.path_systemprompt), 'utf8'), /You are diagramist\. Explain systems, code, and data/);
  diagramist.tools = ['read']; diagramist.path_systemprompt = 'prompt.md';
  saved.diagramistDefaultApplied = false;
  await f.file('config.json', JSON.stringify(saved)); await f.load();
  assert.deepEqual((await f.config()).agents, saved.agents);
  assert.equal((await f.config()).diagramistDefaultApplied, true);
});

test('obsolete voice agents are removed and restored voice selections fall back to general', async t => {
  const f = await agentFixture(t, { config: configured([profile(), profile('voice-orchestrator')]), entries: [{ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'voice-orchestrator' } }] });
  await f.load(); await f.start();
  assert.deepEqual((await f.config()).agents.map(agent => agent.name), ['general']);
  assert.equal(f.capability().active, 'general');
});

test('saved question tools migrate without changing the historical snapshot', async t => {
  const snapshot = { version: 1, definition: profile('general', { tools: ['read', 'request_user_input_async', 'request_user_input'] }), systemPrompt: 'Saved', agentPrompt: '' };
  const f = await agentFixture(t, { tools: ['read', 'request_user_input'], entries: [{ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'general', snapshot } }] });
  await f.load(); await f.start();
  assert.deepEqual(f.pi.getActiveTools(), ['read', 'request_user_input']);
  assert.deepEqual(f.entries[0].data.snapshot, snapshot);
});

test('prompt options clear duplicate project context and mark explicit skills by file or directory', async t => {
  const f = await agentFixture(t, { runtime: { tools: ['read'], skills: [], explicitOnlySkills: ['/skills/file/SKILL.md', '/skills/directory/'] } });
  await f.load(); await f.start();

  const skills = [
    { filePath: '/skills/file/SKILL.md', baseDir: '/skills/file' },
    { filePath: '/skills/directory/SKILL.md', baseDir: '/skills/directory' },
    { filePath: '/skills/normal/SKILL.md', baseDir: '/skills/normal' },
  ];

  const result = await f.prompt({ contextFiles: [{ path: 'a&"<>b', content: 'First instructions' }, { path: 'second', content: 'Second instructions' }], skills });
  assert.equal(result.customPrompt, 'System instructions');
  assert.deepEqual(result.contextFiles, []);
  assert.deepEqual(result.skills, skills.map((skill, index) => index < 2 ? { ...skill, disableModelInvocation: true } : skill));
  assert.ok(skills.every(skill => skill.disableModelInvocation === undefined));
});

test('subagents inherit the active snapshot and overrides, while named profiles use their own defaults', async t => {
  const f = await agentFixture(t); await f.load(); await f.start();
  await f.pi.setModel({ provider: 'test', id: 'review/model' }); f.pi.setThinkingLevel('low');
  const current = {}; f.pi.events.emit('piop:agents:subagent', current);
  assert.deepEqual(JSON.parse(JSON.stringify(current.state)), { active: 'general', locked: false, snapshot: f.state().snapshot, modelOverride: 'test/review/model', effortOverride: 'low' });
  current.state.snapshot.definition.tools.push('mutated');
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
  const next = {}; f.pi.events.emit('piop:agents:subagent', next); assert.deepEqual(next.state.snapshot.definition.tools, ['read']);
  const named = { agent: 'reviewer' }; f.pi.events.emit('piop:agents:subagent', named); assert.deepEqual(named.state, { active: 'reviewer', locked: false });
  const missing = { agent: 'missing' }; f.pi.events.emit('piop:agents:subagent', missing); assert.equal(missing.error, 'Choose a configured agent profile'); assert.equal(missing.state, undefined);
  await f.emit('session_shutdown');
  const stopped = {}; f.pi.events.emit('piop:agents:subagent', stopped); assert.deepEqual(stopped, {});
});

test('legacy prompt filenames keep interior underscores and strip all boundary separators', async t => {
  const name = '__Review__Me!!Next__';
  const f = await agentFixture(t, { config: { agents: [{ name, systemPrompt: 'Legacy', tools: ['read'] }] } });
  await f.load();
  const agent = (await f.config()).agents.find(agent => agent.name === name);
  const hash = createHash('sha256').update(name).update('\0').update('Legacy').digest('hex');
  assert.equal(agent.path_systemprompt, `sysprompt/review__me_next-${hash}.md`);
});

test('fast-mode support recognizes numbered provider accounts without rewriting model IDs', async t => {
  const model = { provider: 'test--piop-account-12', id: 'default' };
  const f = await agentFixture(t, { model, models: [model], fastModels: ['test/default'], config: configured([profile('general', { model: `${model.provider}/${model.id}`, fastMode: true })]) });
  await f.load(); await f.start();
  assert.deepEqual(f.notices, []); assert.deepEqual(f.pi.getActiveTools(), ['read']);
  assert.deepEqual(await f.input('hello'), { action: 'continue' });
  assert.equal(f.state().snapshot.definition.model, 'test--piop-account-12/default');
});

test('terminal lookup remains restricted to the terminal agent even in saved definitions', async t => {
  const f = await agentFixture(t, { tools: ['read', 'lookup_terminals'], config: configured([profile('general', { tools: ['read', 'lookup_terminals'] }), profile('terminal-agent', { tools: ['read', 'lookup_terminals'] })]) });
  await f.load(); await f.start(); assert.deepEqual(f.pi.getActiveTools(), ['read']);
  await f.select('terminal-agent'); assert.deepEqual(f.pi.getActiveTools(), ['read', 'lookup_terminals']);
  await f.select('general'); assert.deepEqual(f.pi.getActiveTools(), ['read']);
});

test('explicit agent selection applies fast-mode defaults while input leaves manual choices alone', async t => {
  const f = await agentFixture(t); await f.load(); await f.start();
  const requests = []; f.pi.events.on('piop:fast-mode', request => { if (request.apply) requests.push(request); });
  await f.select('reviewer');
  assert.deepEqual(requests, [{ apply: true, enabled: undefined, restore: false, ctx: f.ctx }]);
  await f.input('hello'); assert.equal(requests.length, 1);
});

test('session-tree changes restore the selected branch profile and its prompt', async t => {
  const f = await agentFixture(t); await f.load(); await f.start();
  f.entries.splice(0, f.entries.length, { type: 'custom', customType: 'pi-define-agents-state', data: { active: 'reviewer', snapshot: { version: 1, definition: profile('reviewer', { tools: ['bash'] }), systemPrompt: 'Branch prompt', agentPrompt: '' } } });
  await f.emit('session_tree');
  assert.equal(f.capability().active, 'reviewer'); assert.deepEqual(f.pi.getActiveTools(), ['bash']);
  assert.equal((await f.prompt()).customPrompt, 'Branch prompt');
});

test('input before session startup persists the newly captured agent snapshot', async t => {
  const f = await agentFixture(t); await f.load();
  assert.deepEqual(await f.input('early'), { action: 'continue' });
  assert.equal(f.state().snapshot.version, 2);
  assert.equal(await readFile(f.state().snapshot.definition.path_systemprompt, 'utf8'), 'System instructions');
  assert.equal(f.state().snapshot.definition.name, 'general');
  assert.equal(f.capability().locked, true);
});

test('session tool migration persists independently of the other completed migrations', async t => {
  const config = configured([profile()]); config.sessionToolsDefaultApplied = false;
  const f = await agentFixture(t, { config, runtime: { tools: ['read', 'subagent'], skills: [] } });
  await f.load();
  const saved = await f.config();
  assert.equal(saved.sessionToolsDefaultApplied, true); assert.deepEqual(saved.agents[0].tools, ['read', 'subagent']);
});

test('helper profiles inherit general regardless of ordering and never replace an existing asker', async t => {
  const config = configured([profile('reviewer', { tools: ['bash'] }), profile('general', { tools: ['read'] })]);
  config.askerAgentDefaultApplied = false; config.terminalAgentDefaultApplied = false;
  const f = await agentFixture(t, { config, runtime: { tools: ['read', 'bash', 'request_user_input', 'lookup_terminals'], skills: [] } });
  await f.load();
  const saved = await f.config();
  assert.deepEqual(saved.agents.find(agent => agent.name === 'asker-agent').tools, ['read', 'request_user_input']);
  assert.deepEqual(saved.agents.find(agent => agent.name === 'terminal-agent').tools, ['read', 'lookup_terminals']);
  saved.agents.find(agent => agent.name === 'asker-agent').tools = ['bash', 'request_user_input'];
  saved.askerAgentDefaultApplied = false;
  await f.file('config.json', JSON.stringify(saved)); await f.load();
  assert.deepEqual((await f.config()).agents, saved.agents);
});

test('subagents use model overrides even when they differ from cached runtime defaults', async t => {
  const f = await agentFixture(t, { entries: [{ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'general', modelOverride: 'test/review/model' } }] });
  await f.load(); await f.start();
  const request = {}; f.pi.events.emit('piop:agents:subagent', request);
  assert.equal(request.state.modelOverride, 'test/review/model');
  assert.equal(request.state.snapshot.definition.model, 'test/default');
});

test('subagent state is available before runtime defaults have been captured', async t => {
  const f = await agentFixture(t); await f.load();
  const request = {}; f.pi.events.emit('piop:agents:subagent', request);
  assert.equal(request.state.active, 'general'); assert.equal(request.state.modelOverride, undefined);
  assert.equal(request.state.effortOverride, 'high');
});

test('replacing an unavailable agent with a skill-free profile does not reload resources', async t => {
  const f = await agentFixture(t, { entries: [{ type: 'custom', customType: 'pi-define-agents-state', data: { active: 'missing' } }] });
  await f.load(); await f.start(); assert.equal(f.capability().unavailable, true);
  await f.select('general'); assert.equal(f.capability().active, 'general'); assert.equal(f.capability().unavailable, false);
  assert.deepEqual(f.pi.getActiveTools(), ['read']);
});
