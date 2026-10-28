import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDaemon, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

const skill = (name: string) => {
  const directory = join(agents.daemon.home, '.agents/skills', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill\n---\nBody of ${name}\n`);
  return directory;
};

const request = async (key: string) => {
  for (let tries = 0; tries < 100; tries++) {
    const found = agents.model.requests.findLast(item => item.messages.some((message: any) => message.role === 'user' && text(message).includes(key)));
    if (found) return found;
    await Bun.sleep(100);
  }
  throw new Error('The model never got ' + key);
};
const system = (found: any) => found.messages.filter((message: any) => ['system', 'developer'].includes(message.role)).map(text).join('\n');
/** Waits until the chat finished its turn. */
const idle = async (chat: { command: (value: any) => Promise<any> }) => {
  for (let tries = 0; tries < 100; tries++) { if (!(await chat.command({ type: 'get_state' })).isStreaming) return; await Bun.sleep(100); }
  throw new Error('The chat never finished its turn');
};

test('every chat offers all skills, and the model sees only the skills of its agent', async () => {
  const [alpha, beta] = ['alpha', 'beta', 'off'].map(name => skill(name));
  const settings = await agents.daemon.invoke('load_app_settings', { refreshSkills: true });
  for (const item of settings.skills) item.enabled = item.name !== 'off';
  await agents.daemon.invoke('save_app_settings', { settings });
  const setup = await agents.rootChat();
  const configuration = await setup.command({ type: 'get_agent_configuration' });
  const skills: Record<string, string[]> = { general: [alpha], workhorse: [beta] };
  await setup.command({ type: 'configure_agents', configuration: { revision: configuration.revision, agents: configuration.agents.map((agent: any) => ({ ...agent, skills: skills[agent.name] ?? [], ...(agent.name === 'workhorse' ? { model: 'scripted/scripted-model' } : {}) })) } });

  const all = [{ name: 'alpha', description: 'The alpha skill' }, { name: 'beta', description: 'The beta skill' }];
  const catalog = await agents.daemon.invoke('provider_auth', { hostId: 'local', request: { action: 'draft_catalog', reload: true } });
  expect(catalog.skills).toEqual(all);

  const chat = await agents.rootChat();
  const started = (await chat.command({ type: 'get_commands' })).commands.filter((command: any) => command.source === 'skill').map(({ name, description }: any) => ({ name, description }));
  expect(started).toEqual(all.map(item => ({ name: 'skill:' + item.name, description: item.description })));

  agents.scripts.set('Plain turn', () => ({ text: 'Done.' }));
  await chat.command({ type: 'prompt', message: 'Plain turn' });
  const plain = system(await request('Plain turn'));
  expect(plain).toContain('The alpha skill');
  expect(plain).not.toContain('The beta skill');
  await idle(chat);

  agents.scripts.set('Body of beta', () => ({ text: 'Done.' }));
  await chat.command({ type: 'prompt', message: '/skill:beta' });
  await request('Body of beta');

  const other = await agents.rootChat();
  await other.command({ type: 'select_agent', agent: 'workhorse' });
  agents.scripts.set('Workhorse turn', () => ({ text: 'Done.' }));
  await other.command({ type: 'prompt', message: 'Workhorse turn' });
  const switched = system(await request('Workhorse turn'));
  expect(switched).toContain('The beta skill');
  expect(switched).not.toContain('The alpha skill');
}, 60000);
