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
  const move = (agent, revision = global.config.revision) => loader.moveAgentToProject({ settings, global, cwd: project, agent, revision });

  await assert.rejects(move('general'), /must stay global/);
  await assert.rejects(move('reviewer', 'stale'), /changed in another window/);
  const moved = await move('reviewer');

  assert.deepEqual((await f.configuration()).agents.map(agent => agent.name), ['general']);
  assert.equal(moved.revision, (await f.configuration()).revision);
  const inside = (await loader.loadAgentDefinitions({ settings, initial: false, project: { cwd: project, global: moved.definitions } })).config;
  assert.deepEqual(inside.agents.map(agent => [agent.name, agent.project === true]), [['general', false], ['reviewer', true]]);
  await assert.rejects(loader.moveAgentToProject({ settings, global: moved.definitions, cwd: project, agent: 'reviewer', revision: moved.revision }), /Unknown global agent/);
});
