import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { agentDaemon, called, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => {
  agents = await agentDaemon();
  await agents.saveAgents(saved => {
    const withTools = saved.map((agent: any) => ({ ...agent, tools: [...new Set([...(agent.tools ?? []), 'spawn_subagents'])] }));
    const { isDefault: _isDefault, ...general } = withTools.find((agent: any) => agent.name === 'general');
    const thinker = { ...general, name: 'deep-thinker', model: 'scripted/scripted-thinker', effort: 'low' };
    const reader = { ...general, name: 'reader', model: 'scripted/scripted-model', tools: ['read'] };
    const delegator = { ...general, name: 'delegator', allowed_subagents: ['deep-thinker'] };
    return [...withTools, thinker, reader, delegator];
  });
}, 60000);
afterAll(async () => { await agents?.close(); });

const callFor = (key: string) => {
  const request = agents.model.requests.findLast(request => text(request.messages.find((message: any) => !['system', 'developer'].includes(message.role) && text(message))).includes(key));
  return request && { model: request.model, effort: request.reasoning_effort };
};

const profileChat = async (agent: string) => {
  const chat = await agents.daemon.invoke('create_temporary_chat', { hostId: 'local' });
  const runtimeId = 'profile-' + agent + '-' + crypto.randomUUID();
  await agents.daemon.invoke('start_pi', { runtimeId, clientId: 'laptop', cwd: chat.cwd, sessionId: chat.sessionId });
  const command = (value: any) => agents.daemon.invoke('pi_command', { runtimeId, command: value });
  await command({ type: 'select_agent', agent });
  return { cwd: chat.cwd as string, command };
};

test.concurrent('an agent limited to reading cannot run commands, directly or from code mode, and is told why', async () => {
  const tries: Record<string, any> = {
    direct: { tool: 'bash', arguments: { command: 'touch direct.txt' } },
    'code mode': { tool: 'codemode', arguments: { code: 'try { await tools.bash({ command: "touch code.txt" }); return "ran"; } catch (error) { return "refused: " + error.message; }' } },
  };
  for (const [way, call] of Object.entries(tries)) {
    const key = 'Write a file ' + way;
    agents.scripts.set(key, messages => messages.some((message: any) => message.role === 'tool') ? { text: 'Done.' } : call);
    const chat = await profileChat('reader');
    await chat.command({ type: 'prompt', message: key });
    const answered = () => agents.model.requests.find(request => text(request.messages[1]) === key && request.messages.some((message: any) => message.role === 'tool'));
    for (let tries = 0; !answered() && tries < 100; tries++) await Bun.sleep(100);
    const request = answered();
    expect(request.tools.map((tool: any) => tool.function.name).sort()).toEqual(['codemode', 'read']);
    expect(text(request.messages.at(-1))).toMatch(way === 'direct' ? /Tool bash not found/ : /refused: tools\.bash does not exist/);
    expect(existsSync(join(chat.cwd, 'direct.txt')) || existsSync(join(chat.cwd, 'code.txt'))).toBe(false);
  }
}, 60000);

test.concurrent('a chat on an agent profile calls the profile\'s model with the profile\'s thinking level', async () => {
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

test.concurrent('a child started with an agent profile uses that profile\'s model and thinking level', async () => {
  agents.scripts.set('Ask a deep thinker', messages => called(messages, 'spawn_subagents') ? { text: 'Asked.' } : { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Thinker', task: 'Deep child task', agent: 'deep-thinker' }] } });
  agents.scripts.set('Deep child task', () => ({ text: 'Child done.' }));
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Ask a deep thinker' });
  for (let tries = 0; !callFor('Deep child task') && tries < 200; tries++) await Bun.sleep(100);
  expect(callFor('Deep child task')).toEqual({ model: 'scripted-thinker', effort: 'low' });
  expect(callFor('Ask a deep thinker')).toEqual({ model: 'scripted-model', effort: undefined });
}, 60000);

test.concurrent('a child started without a profile keeps the model and thinking level its parent chose by hand', async () => {
  agents.scripts.set('Ask a copy of me', messages => called(messages, 'spawn_subagents') ? { text: 'Asked.' } : { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Copy', task: 'Copy child task' }] } });
  agents.scripts.set('Copy child task', () => ({ text: 'Child done.' }));
  const root = await agents.rootChat();
  await root.command({ type: 'set_model', provider: 'scripted', modelId: 'scripted-thinker' });
  await root.command({ type: 'set_thinking_level', level: 'minimal' });
  await root.command({ type: 'prompt', message: 'Ask a copy of me' });
  for (let tries = 0; !callFor('Copy child task') && tries < 200; tries++) await Bun.sleep(100);
  expect(callFor('Ask a copy of me')).toEqual({ model: 'scripted-thinker', effort: 'minimal' });
  expect(callFor('Copy child task')).toEqual({ model: 'scripted-thinker', effort: 'minimal' });
}, 60000);

test.concurrent('an agent that can start only one subagent profile gets no agent field and starts that profile', async () => {
  agents.scripts.set('Delegate it', messages => called(messages, 'spawn_subagents') ? { text: 'Asked.' } : { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Solo', task: 'Solo child task' }] } });
  agents.scripts.set('Solo child task', () => ({ text: 'Child done.' }));
  const chat = await profileChat('delegator');
  await chat.command({ type: 'prompt', message: 'Delegate it' });
  for (let tries = 0; !callFor('Solo child task') && tries < 200; tries++) await Bun.sleep(100);
  expect(callFor('Solo child task')).toEqual({ model: 'scripted-thinker', effort: 'low' });
  const request = agents.model.requests.find(request => text(request.messages[1]) === 'Delegate it');
  const spawn = request.tools.find((tool: any) => tool.function.name === 'spawn_subagents');
  expect(Object.keys(spawn.function.parameters.properties.tasks.items.properties).sort()).toEqual(['nickname', 'task']);
}, 60000);
