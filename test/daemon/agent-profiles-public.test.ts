import { afterAll, beforeAll, expect, test } from 'bun:test';
import { agentDaemon, called, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => {
  agents = await agentDaemon();
  const chat = await agents.rootChat();
  const configuration = await chat.command({ type: 'get_agent_configuration' });
  const general = configuration.agents.find((agent: any) => agent.name === 'general');
  const thinker = { ...general, name: 'deep-thinker', model: 'scripted/scripted-thinker', effort: 'low' };
  await chat.command({ type: 'configure_agents', configuration: { revision: configuration.revision, agents: [...configuration.agents, thinker] } });
}, 60000);
afterAll(async () => { await agents?.close(); });

/** The model and thinking level of the model call that started with key. */
const callFor = (key: string) => {
  const request = agents.model.requests.findLast(request => text(request.messages.find((message: any) => !['system', 'developer'].includes(message.role) && text(message))).includes(key));
  return request && { model: request.model, effort: request.reasoning_effort };
};

test('a chat on an agent profile calls the profile\'s model with the profile\'s thinking level', async () => {
  agents.scripts.set('Think it over', () => ({ text: 'Thought it over.' }));
  const chat = await agents.daemon.invoke('create_temporary_chat', { hostId: 'local' });
  const runtimeId = 'profile-chat';
  await agents.daemon.invoke('start_pi', { runtimeId, clientId: 'laptop', cwd: chat.cwd, sessionId: chat.sessionId });
  const command = (value: any) => agents.daemon.invoke('pi_command', { runtimeId, command: value });
  await command({ type: 'select_agent', agent: 'deep-thinker' });
  await command({ type: 'prompt', message: 'Think it over' });
  for (let tries = 0; !callFor('Think it over') && tries < 100; tries++) await Bun.sleep(100);
  expect(callFor('Think it over')).toEqual({ model: 'scripted-thinker', effort: 'low' });
}, 60000);

test('a child started with an agent profile uses that profile\'s model and thinking level', async () => {
  agents.scripts.set('Ask a deep thinker', messages => called(messages, 'spawn_agent') ? { text: 'Asked.' } : { tool: 'spawn_agent', arguments: { task_name: 'thinker', message: 'Deep child task', agent: 'deep-thinker' } });
  agents.scripts.set('Deep child task', () => ({ text: 'Child done.' }));
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Ask a deep thinker' });
  for (let tries = 0; !callFor('Deep child task') && tries < 200; tries++) await Bun.sleep(100);
  expect(callFor('Deep child task')).toEqual({ model: 'scripted-thinker', effort: 'low' });
  expect(callFor('Ask a deep thinker')).toEqual({ model: 'scripted-model', effort: undefined });
}, 60000);

test('a child started without a profile keeps the model and thinking level its parent chose by hand', async () => {
  agents.scripts.set('Ask a copy of me', messages => called(messages, 'spawn_agent') ? { text: 'Asked.' } : { tool: 'spawn_agent', arguments: { task_name: 'copy', message: 'Copy child task' } });
  agents.scripts.set('Copy child task', () => ({ text: 'Child done.' }));
  const root = await agents.rootChat();
  await root.command({ type: 'set_model', provider: 'scripted', modelId: 'scripted-thinker' });
  await root.command({ type: 'set_thinking_level', level: 'minimal' });
  await root.command({ type: 'prompt', message: 'Ask a copy of me' });
  for (let tries = 0; !callFor('Copy child task') && tries < 200; tries++) await Bun.sleep(100);
  expect(callFor('Ask a copy of me')).toEqual({ model: 'scripted-thinker', effort: 'minimal' });
  expect(callFor('Copy child task')).toEqual({ model: 'scripted-thinker', effort: 'minimal' });
}, 60000);
