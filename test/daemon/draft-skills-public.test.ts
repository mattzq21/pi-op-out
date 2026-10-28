import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDaemon } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

const skill = (name: string) => {
  const directory = join(agents.daemon.home, '.agents/skills', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill\n---\nBody\n`);
  return directory;
};

test('a chat that is not started offers the same skills as the started chat of the same agent', async () => {
  const [alpha, beta, off] = ['alpha', 'beta', 'off'].map(name => skill(name));
  const settings = await agents.daemon.invoke('load_app_settings', { refreshSkills: true });
  for (const item of settings.skills) item.enabled = item.name !== 'off';
  await agents.daemon.invoke('save_app_settings', { settings });
  const setup = await agents.rootChat();
  const configuration = await setup.command({ type: 'get_agent_configuration' });
  const skills: Record<string, string[]> = { general: [alpha, off], workhorse: [beta] };
  await setup.command({ type: 'configure_agents', configuration: { revision: configuration.revision, agents: configuration.agents.map((agent: any) => ({ ...agent, skills: skills[agent.name] ?? [] })) } });

  const catalog = await agents.daemon.invoke('provider_auth', { hostId: 'local', request: { action: 'draft_catalog', reload: true } });
  expect(catalog.skills.general).toEqual([{ name: 'alpha', description: 'The alpha skill' }]);
  expect(catalog.skills.workhorse).toEqual([{ name: 'beta', description: 'The beta skill' }]);

  const chat = await agents.rootChat();
  const started = (await chat.command({ type: 'get_commands' })).commands.filter((command: any) => command.source === 'skill').map(({ name, description }: any) => ({ name, description }));
  expect(started).toEqual(catalog.skills.general.map((item: any) => ({ name: 'skill:' + item.name, description: item.description })));
}, 60000);
