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
  await assert.rejects(f.configure({ agents: [...current.agents, profile('tester')] }), /used by the project/);
  await assert.rejects(save(project, { revision: saved.revision, agents: [] }), /project's default agent/);
  await assert.rejects(save(project, { revision: 'missing', defaultAgent: null }), /changed in another window/);

  f.ctx.cwd = linked; await f.start();
  assert.equal(f.capability().active, 'tester');
});
