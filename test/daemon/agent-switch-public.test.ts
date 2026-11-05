import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDaemon, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => {
  agents = await agentDaemon();
  const file = (name: string, content: string) => { const path = join(agents.daemon.home, name); writeFileSync(path, content); return path; };
  const models = join(agents.daemon.home, '.piop', 'models.json');
  const providers = JSON.parse(readFileSync(models, 'utf8')).providers;
  providers.midconvo = { ...providers.scripted, models: [{ id: 'midconvo-model', contextWindow: 200000, maxTokens: 8192, compat: { supportsMidConvoSystemMessages: true } }] };
  writeFileSync(models, JSON.stringify({ providers }));
  await agents.saveAgents(saved => {
    const { isDefault: _isDefault, ...general } = saved.find((agent: any) => agent.name === 'general');
    const author = { ...general, name: 'author', model: 'midconvo/midconvo-model', codemode: 'off', tools: ['read'], path_systemprompt: file('author-system.md', 'You are the author agent.'), path_agent_prompt: file('author-agent.md', 'Write long prose.') };
    const checker = { ...author, name: 'checker', tools: ['read', 'ls'], path_systemprompt: file('checker-system.md', 'You are the checker agent.'), path_agent_prompt: '' };
    return [...saved, author, checker];
  });
}, 60000);
afterAll(async () => { await agents?.close(); });

const requestEndingWith = async (message: string) => {
  const find = () => agents.model.requests.find(request => text(request.messages.at(-1)) === message);
  for (let tries = 0; !find() && tries < 200; tries++) await Bun.sleep(100);
  return find();
};

test('changing the agent mid-conversation replaces the prompt and tools the model gets, also after reopening', async () => {
  agents.scripts.set('Draft the intro', () => ({ text: 'Done.' }));
  const chat = await agents.daemon.invoke('create_temporary_chat', { hostId: 'local' });
  const start = async (runtimeId: string) => {
    await agents.daemon.invoke('start_pi', { runtimeId, clientId: 'laptop', cwd: chat.cwd, sessionId: chat.sessionId });
    return (value: any) => agents.daemon.invoke('pi_command', { runtimeId, command: value });
  };
  const sent = (request: any) => ({
    prompts: request.messages.filter((message: any) => ['system', 'developer'].includes(message.role)).map(text),
    tools: (request.tools ?? []).map((tool: any) => tool.function.name).sort(),
  });

  let command = await start('switch-first');
  await command({ type: 'select_agent', agent: 'author' });
  await command({ type: 'prompt', message: 'Draft the intro' });
  const first = sent(await requestEndingWith('Draft the intro'));
  expect(first.prompts).toHaveLength(1);
  expect(first.prompts[0]).toContain('You are the author agent.');
  expect(first.prompts[0]).toContain('Write long prose.');
  expect(first.tools).toEqual(['read']);

  await command({ type: 'select_agent', agent: 'checker' });
  await command({ type: 'prompt', message: 'Check the intro' });
  const second = sent(await requestEndingWith('Check the intro'));
  expect(second.prompts).toHaveLength(1);
  expect(second.prompts[0]).toContain('You are the checker agent.');
  expect(second.prompts[0]).not.toContain('author');
  expect(second.prompts[0]).not.toContain('Write long prose.');
  expect(second.tools).toEqual(['ls', 'read']);
  await agents.daemon.invoke('stop_pi', { runtimeId: 'switch-first' });

  command = await start('switch-reopened');
  await command({ type: 'prompt', message: 'Check it again' });
  const reopened = sent(await requestEndingWith('Check it again'));
  expect(reopened).toEqual(second);
  await agents.daemon.invoke('stop_pi', { runtimeId: 'switch-reopened' });
}, 90000);

test('editing the agent of a conversation changes only that conversation, also after reopening', async () => {
  agents.scripts.set('Edit me', () => ({ text: 'Done.' }));
  agents.scripts.set('Untouched', () => ({ text: 'Done.' }));
  const open = async (runtimeId: string, sessionId: string, cwd: string) => {
    await agents.daemon.invoke('start_pi', { runtimeId, clientId: 'laptop', cwd, sessionId });
    return (value: any) => agents.daemon.invoke('pi_command', { runtimeId, command: value });
  };
  const chat = await agents.daemon.invoke('create_temporary_chat', { hostId: 'local' });
  let command = await open('edit-first', chat.sessionId, chat.cwd);
  expect((await command({ type: 'get_commands' })).commands.map((item: any) => item.name)).toContain('agent');
  await command({ type: 'select_agent', agent: 'author' });
  await command({ type: 'prompt', message: 'Edit me' });
  await requestEndingWith('Edit me');

  const current = await command({ type: 'chat_agent' });
  expect(current.systemPrompt).toBe('You are the author agent.');
  expect(current.agentPrompt).toBe('Write long prose.');
  await command({ type: 'set_chat_agent', agent: { ...current.agent, name: 'poet', tools: ['read', 'ls'] }, systemPrompt: 'You are a poet.', agentPrompt: '' });
  await command({ type: 'prompt', message: 'Now rhyme' });
  const edited = await requestEndingWith('Now rhyme');
  const prompts = edited.messages.filter((message: any) => ['system', 'developer'].includes(message.role)).map(text);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('You are a poet.');
  expect(prompts[0]).not.toContain('author');
  expect(edited.tools.map((tool: any) => tool.function.name).sort()).toEqual(['ls', 'read']);
  await agents.daemon.invoke('stop_pi', { runtimeId: 'edit-first' });

  command = await open('edit-reopened', chat.sessionId, chat.cwd);
  expect((await command({ type: 'chat_agent' })).agent.name).toBe('poet');
  await agents.daemon.invoke('stop_pi', { runtimeId: 'edit-reopened' });

  const other = await agents.daemon.invoke('create_temporary_chat', { hostId: 'local' });
  command = await open('edit-other', other.sessionId, other.cwd);
  await command({ type: 'select_agent', agent: 'author' });
  await command({ type: 'prompt', message: 'Untouched' });
  expect(text((await requestEndingWith('Untouched')).messages[0])).toContain('You are the author agent.');
  await agents.daemon.invoke('stop_pi', { runtimeId: 'edit-other' });
}, 90000);
