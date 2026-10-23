import { afterAll, beforeAll, expect, test } from 'bun:test';
import { agentDaemon, called, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => {
  agents = await agentDaemon();
  const chat = await agents.rootChat();
  const configuration = await chat.command({ type: 'get_agent_configuration' });
  configuration.agents = configuration.agents.map((agent: any) => ({ ...agent, tools: [...new Set([...(agent.tools ?? []), 'spawn_subagents'])] }));
  const general = configuration.agents.find((agent: any) => agent.name === 'general');
  const others = configuration.agents.filter((agent: any) => agent.name !== 'general').map(({ isDefault: _isDefault, ...agent }: any) => agent);
  const { isDefault: _isDefault, ...plain } = general;
  const thinker = { ...plain, name: 'deep-thinker', isDefault: true, model: 'scripted/scripted-thinker', effort: 'low' };
  await chat.command({ type: 'configure_agents', configuration: { revision: configuration.revision, agents: [{ ...plain, model: 'scripted/scripted-model' }, ...others, thinker] } });
}, 60000);
afterAll(async () => { await agents?.close(); });

const callFor = (key: string) => {
  const request = agents.model.requests.findLast(request => text(request.messages.find((message: any) => !['system', 'developer'].includes(message.role) && text(message))).includes(key));
  return request && { model: request.model, effort: request.reasoning_effort };
};

/** The agent that a runtime last reported as active. */
const activeAgent = (runtimeId: string) => {
  const status = agents.daemon.events.filter(event => event.payload?.runtimeId === runtimeId && event.payload.event?.method === 'setStatus' && event.payload.event.statusKey === 'pi-define-agents' && event.payload.event.statusText).at(-1)?.payload.event.statusText;
  return status && JSON.parse(Buffer.from(status.slice(5), 'base64url').toString('utf8')).active;
};

/** A new chat that the client starts without choosing an agent or a model. */
const plainChat = async (runtimeId: string, extra: Record<string, unknown> = {}) => {
  const chat = await agents.daemon.invoke('create_temporary_chat', { hostId: 'local' });
  await agents.daemon.invoke('start_pi', { runtimeId, clientId: 'laptop', cwd: chat.cwd, sessionId: chat.sessionId, ...extra });
  const command = (value: any) => agents.daemon.invoke('pi_command', { runtimeId, command: value });
  for (let tries = 0; !activeAgent(runtimeId) && tries < 100; tries++) await Bun.sleep(100);
  return { ...chat, runtimeId, command };
};

test.concurrent('a new chat starts as the flagged agent and calls its model with its thinking level', async () => {
  agents.scripts.set('Default chat task', () => ({ text: 'Done.' }));
  const chat = await plainChat('default-chat');
  expect(activeAgent('default-chat')).toBe('deep-thinker');
  await chat.command({ type: 'prompt', message: 'Default chat task' });
  for (let tries = 0; !callFor('Default chat task') && tries < 100; tries++) await Bun.sleep(100);
  expect(callFor('Default chat task')).toEqual({ model: 'scripted-thinker', effort: 'low' });
}, 60000);

test.concurrent('the agent list for a chat that is not started yet shows which agent is the default', async () => {
  const catalog = await agents.daemon.invoke('provider_auth', { hostId: 'local', request: { action: 'draft_catalog', reload: true } });
  expect(catalog.config.agents.filter((agent: any) => agent.isDefault).map((agent: any) => agent.name)).toEqual(['deep-thinker']);
  // An agent without its own model runs the model Pi starts with, as the general child below does.
  expect(catalog.initialModel).toBe('scripted/scripted-model');
}, 60000);

test.concurrent('a child asked for the general agent runs general, while its parent runs the default agent', async () => {
  agents.scripts.set('Ask general for help', messages => called(messages, 'spawn_subagents') ? { text: 'Asked.' } : { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Helper', task: 'General child task', agent: 'general' }] } });
  agents.scripts.set('General child task', () => ({ text: 'Child done.' }));
  const chat = await plainChat('default-parent');
  await chat.command({ type: 'prompt', message: 'Ask general for help' });
  for (let tries = 0; !callFor('General child task') && tries < 200; tries++) await Bun.sleep(100);
  expect(callFor('Ask general for help')).toEqual({ model: 'scripted-thinker', effort: 'low' });
  expect(callFor('General child task')).toEqual({ model: 'scripted-model', effort: undefined });
}, 60000);

test.concurrent('a review chat runs the review agent, while its chat runs the default agent', async () => {
  agents.scripts.set('Write the tokenizer', () => ({ text: 'Tokenizer done.' }));
  const chat = await plainChat('default-reviewed', { presence: { visible: true, focused: true } });
  await chat.command({ type: 'prompt', message: 'Write the tokenizer' });
  for (let tries = 0; !callFor('Write the tokenizer') && tries < 100; tries++) await Bun.sleep(100);
  const inputs = () => agents.daemon.events.filter(event => event.payload?.runtimeId === 'default-reviewed' && event.payload.event?.method === 'input' && event.payload.event.title === '__pi_desktop_review__');
  for (let tries = 0; tries < 100 && (await chat.command({ type: 'get_state' })).isStreaming; tries++) await Bun.sleep(100);
  await chat.command({ type: 'follow_up', message: '/review src/tokenizer.ts' });
  for (let tries = 0; !inputs().length && tries < 100; tries++) await Bun.sleep(100);
  const review = JSON.parse(inputs()[0].payload.event.placeholder);
  await agents.daemon.invoke('start_pi', { runtimeId: 'review-chat', clientId: 'laptop', cwd: chat.cwd, sessionId: review.sessionId, sessionPath: review.sessionPath });
  for (let tries = 0; !activeAgent('review-chat') && tries < 100; tries++) await Bun.sleep(100);
  expect(activeAgent('default-reviewed')).toBe('deep-thinker');
  expect(activeAgent('review-chat')).toBe('general');
}, 60000);

