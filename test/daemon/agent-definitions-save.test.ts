import { afterAll, beforeAll, expect, test } from 'bun:test';
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
  // Opening the settings page reads the definitions first.
  await agentDefinitions(daemon);
  const from = daemon.events.length;
  const saved = await saveAgentDefinitions(daemon, added('helper'));
  expect(saved).toEqual({ revision: expect.any(String), warnings: [] });
  // A Pi session reports itself with sessions-changed and its own events.
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
