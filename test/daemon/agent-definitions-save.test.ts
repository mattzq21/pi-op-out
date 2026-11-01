import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { agentDefinitions, saveAgentDefinitions } from './agent-chats';
import { startDaemon, type TestDaemon } from './harness';

let daemon: TestDaemon;
beforeAll(async () => { daemon = await startDaemon(); }, 60000);
afterAll(async () => { await daemon?.dispose(); });

const added = (name: string) => (agents: any[]) => {
  const { isDefault: _isDefault, ...general } = agents.find(agent => agent.name === 'general');
  return [...agents, { ...general, name }];
};

test('saving agent definitions starts no Pi session, and new chats see the saved agents at once', async () => {
  await agentDefinitions(daemon);
  const from = daemon.events.length;
  const saved = await saveAgentDefinitions(daemon, added('helper'));
  expect(saved).toEqual({ revision: expect.any(String), warnings: [] });
  const during = daemon.events.slice(from).map(event => event.event);
  expect(during.filter(event => event === 'pi://sessions-changed' || event === 'pi://event')).toEqual([]);
  expect(await daemon.waitEvent('pi://agent-definitions-changed', payload => payload.hostId === 'local')).toMatchObject({ hostId: 'local' });
  const current = await agentDefinitions(daemon);
  expect(current.revision).toBe(saved.revision);
  expect(current.agents.map((agent: any) => agent.name)).toContain('helper');
}, 60000);

test('a save from definitions that another window changed since is refused and changes nothing', async () => {
  const stale = await agentDefinitions(daemon);
  await saveAgentDefinitions(daemon, added('first'));
  const refused = await daemon.failure('save_agent_definitions', { hostId: 'local', configuration: { revision: stale.revision, agents: added('second')(stale.agents) } });
  expect(refused).toContain('Agent definitions changed in another window or client');
  const names = (await agentDefinitions(daemon)).agents.map((agent: any) => agent.name);
  expect(names).toContain('first');
  expect(names).not.toContain('second');
}, 60000);

test('a save that a new agent could not start from is refused and changes nothing', async () => {
  const before = await agentDefinitions(daemon);
  const refused = await daemon.failure('save_agent_definitions', { hostId: 'local', configuration: {
    revision: before.revision, agents: before.agents.map((agent: any) => agent.name === 'general' ? { ...agent, path_systemprompt: 'missing-prompt.md' } : agent),
  } });
  expect(refused).toContain('System prompt file missing-prompt.md does not exist');
  expect((await agentDefinitions(daemon)).revision).toBe(before.revision);
}, 60000);

test('an agent whose model a provider adds later becomes available without a reload', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: request =>
    new URL(request.url).pathname === '/v1/models' ? Response.json({ object: 'list', data: [{ id: 'late-model', object: 'model' }] }) : new Response('not found', { status: 404 }) });
  try {
    await saveAgentDefinitions(daemon, agents => added('waiting')(agents).map(agent => agent.name === 'waiting' ? { ...agent, model: 'late-llm/late-model' } : agent));
    const waiting = async () => (await agentDefinitions(daemon)).agents.find((agent: any) => agent.name === 'waiting');
    expect((await waiting()).unavailableReason).toContain('late-llm/late-model');
    const before = daemon.events.filter(event => event.event === 'pi://agent-definitions-changed').length;
    let count = 0;
    await daemon.invoke('provider_auth', { hostId: 'local', request: { action: 'create', providerId: 'late-llm', name: 'Late LLM', baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', apiKey: 'late-key', noKey: false, sessionAffinity: false } });
    await daemon.waitEvent('pi://agent-definitions-changed', () => ++count > before);
    expect((await waiting()).unavailableReason).toBeUndefined();
  } finally { server.stop(true); }
}, 60000);

test('project agents save for one project folder, and only chats there see them', async () => {
  const project = join(daemon.home, 'project');
  await mkdir(project, { recursive: true });
  const catalog = async (cwd?: string) => (await daemon.invoke('provider_auth', { hostId: 'local', request: { action: 'draft_catalog', ...(cwd ? { cwd } : {}) } })).config;
  const { isDefault: _isDefault, ...general } = (await catalog()).agents.find((agent: any) => agent.name === 'general');
  const before = (await catalog(project)).project;
  const from = daemon.events.filter(event => event.event === 'pi://agent-definitions-changed').length;
  let count = 0;
  await daemon.invoke('save_agent_definitions', { hostId: 'local', cwd: project, configuration: { revision: before.revision, agents: [{ ...general, name: 'local-helper' }], defaultAgent: 'local-helper' } });
  await daemon.waitEvent('pi://agent-definitions-changed', () => ++count > from);
  const inside = await catalog(project);
  expect(inside.agents.filter((agent: any) => agent.project).map((agent: any) => agent.name)).toEqual(['local-helper']);
  expect(inside.agents.find((agent: any) => agent.isDefault).name).toBe('local-helper');
  expect((await catalog()).agents.map((agent: any) => agent.name)).not.toContain('local-helper');
}, 60000);

test('an agent moves from the global agents to a project and back', async () => {
  const project = join(daemon.home, 'moving-project');
  await mkdir(project, { recursive: true });
  await saveAgentDefinitions(daemon, added('mover'));
  const before = await agentDefinitions(daemon);
  await daemon.invoke('move_agent', { hostId: 'local', agent: 'mover', revision: before.revision, to: project });
  expect((await agentDefinitions(daemon)).agents.map((agent: any) => agent.name)).not.toContain('mover');
  const inside = (await daemon.invoke('provider_auth', { hostId: 'local', request: { action: 'draft_catalog', cwd: project } })).config;
  expect(inside.agents.filter((agent: any) => agent.project).map((agent: any) => agent.name)).toEqual(['mover']);
  await daemon.invoke('move_agent', { hostId: 'local', agent: 'mover', revision: inside.project.revision, from: project });
  expect((await agentDefinitions(daemon)).agents.map((agent: any) => agent.name)).toContain('mover');
  const after = (await daemon.invoke('provider_auth', { hostId: 'local', request: { action: 'draft_catalog', cwd: project } })).config;
  expect(after.agents.filter((agent: any) => agent.project)).toEqual([]);
}, 60000);
