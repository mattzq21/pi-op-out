import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentFixture, profile } from '../defined-agent-fixture.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { stdio: 'pipe' });

test('project agents join the global agents only in their project, and names stay different', async t => {
  const f = await agentFixture(t); await f.load();
  const project = join(f.root, 'project'); await mkdir(project);
  git(project, 'init', '-q'); git(project, 'commit', '-q', '--allow-empty', '-m', 'init');
  const linked = join(f.root, 'linked'); git(project, 'worktree', 'add', '-q', linked);
  const loader = await import(pathToFileURL(join(f.dir, 'daemon-loader.mjs')));
  const settings = JSON.parse(process.env.PIOP_AGENT_RESOURCES);
  const global = await loader.loadAgentDefinitions({ settings, initial: false });
  const read = async cwd => (await loader.loadAgentDefinitions({ settings, initial: false, project: { cwd, global } })).config;
  const save = (cwd, configuration) => loader.saveAgentDefinitions({ settings, configuration, project: { cwd, global } });

  assert.equal((await read(project)).project.revision, 'missing');
  await assert.rejects(save(project, { revision: 'missing', agents: [profile('reviewer')] }), /already used by a global agent/);
  const saved = await save(project, { revision: 'missing', agents: [profile('tester')], defaultAgent: 'tester' });

  const inWorktree = await read(linked);
  assert.equal(inWorktree.project.directory, await realpath(project));
  assert.deepEqual(inWorktree.agents.map(agent => [agent.name, agent.project === true]), [['general', false], ['reviewer', false], ['tester', true]]);
  assert.equal(inWorktree.agents.find(agent => agent.isDefault).name, 'tester');
  const elsewhere = await read(f.dir);
  assert.deepEqual(elsewhere.agents.filter(agent => agent.project), []);
  assert.equal(elsewhere.agents.find(agent => agent.isDefault).name, 'general');

  const current = await f.configuration();
  await assert.rejects(f.configure({ agents: [...current.agents, profile('tester')] }), /used by a global agent and by the project/);
  await assert.rejects(save(project, { revision: saved.revision, agents: [] }), /as its default agent, but no such agent exists/);
  await assert.rejects(save(project, { revision: 'missing', defaultAgent: null }), /changed in another window/);

  f.ctx.cwd = linked; await f.start();
  assert.equal(f.capability().active, 'tester');
});

test('moving a global agent to a project removes it from the global agents and adds it to the project in one step', async t => {
  const f = await agentFixture(t); await f.load();
  const project = join(f.root, 'project'); await mkdir(project);
  const loader = await import(pathToFileURL(join(f.dir, 'daemon-loader.mjs')));
  const settings = JSON.parse(process.env.PIOP_AGENT_RESOURCES);
  const global = await loader.loadAgentDefinitions({ settings, initial: false });
  const move = (agent, revision = global.config.revision) => loader.moveAgent({ settings, global, agent, revision, from: null, to: project });

  await assert.rejects(move('general'), /must stay global/);
  await assert.rejects(move('reviewer', 'stale'), /changed in another window/);
  const moved = await move('reviewer');

  assert.deepEqual((await f.configuration()).agents.map(agent => agent.name), ['general']);
  assert.equal(moved.revision, (await f.configuration()).revision);
  const inside = (await loader.loadAgentDefinitions({ settings, initial: false, project: { cwd: project, global: moved.definitions } })).config;
  assert.deepEqual(inside.agents.map(agent => [agent.name, agent.project === true]), [['general', false], ['reviewer', true]]);
  await assert.rejects(loader.moveAgent({ settings, global: moved.definitions, agent: 'reviewer', revision: moved.revision, from: null, to: project }), /Unknown global agent/);

  const other = join(f.root, 'other'); await mkdir(other);
  await assert.rejects(loader.moveAgent({ settings, global: moved.definitions, agent: 'reviewer', revision: inside.project.revision, from: project, to: project }), /already in that project/);
  await loader.moveAgent({ settings, global: moved.definitions, agent: 'reviewer', revision: inside.project.revision, from: project, to: other });
  const projectAgentNames = async cwd => (await loader.loadAgentDefinitions({ settings, initial: false, project: { cwd, global: moved.definitions } })).config.agents.filter(agent => agent.project).map(agent => agent.name);
  assert.deepEqual(await projectAgentNames(project), []);
  assert.deepEqual(await projectAgentNames(other), ['reviewer']);
  const projectRevision = (await loader.loadAgentDefinitions({ settings, initial: false, project: { cwd: other, global: moved.definitions } })).config.project.revision;
  await assert.rejects(loader.moveAgent({ settings, global: moved.definitions, agent: 'reviewer', revision: 'stale', from: project, to: null }), /changed in another window/);
  const back = await loader.moveAgent({ settings, global: moved.definitions, agent: 'reviewer', revision: projectRevision, from: other, to: null });
  assert.deepEqual((await f.configuration()).agents.map(agent => agent.name), ['general', 'reviewer']);
  const after = (await loader.loadAgentDefinitions({ settings, initial: false, project: { cwd: other, global: back.definitions } })).config;
  assert.deepEqual(after.agents.filter(agent => agent.project), []);
  assert.equal(after.project.revision, 'missing');
});
