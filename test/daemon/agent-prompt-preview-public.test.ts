import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDaemon, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => {
  agents = await agentDaemon();
  const systemPrompt = join(agents.daemon.home, 'reader-system.md');
  const agentPrompt = join(agents.daemon.home, 'reader-agent.md');
  writeFileSync(systemPrompt, 'You are the reader agent.');
  writeFileSync(agentPrompt, 'Only read files.');
  const models = join(agents.daemon.home, '.piop', 'models.json');
  const providers = JSON.parse(readFileSync(models, 'utf8')).providers;
  const compat = { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true };
  providers.inline = { ...providers.scripted, api: 'openai-responses', models: [{ id: 'inline-tools', reasoning: true, contextWindow: 200000, maxTokens: 8192, compat }] };
  writeFileSync(models, JSON.stringify({ providers }));
  await agents.saveAgents(saved => {
    const { isDefault: _isDefault, ...general } = saved.find((agent: any) => agent.name === 'general');
    const reader = { ...general, name: 'reader', model: 'scripted/scripted-model', tools: ['read'], path_systemprompt: systemPrompt, path_agent_prompt: agentPrompt };
    return [...saved, reader, { ...reader, name: 'inline-reader', model: 'inline/inline-tools' }];
  });
}, 60000);
afterAll(async () => { await agents?.close(); });

test('a prompt preview shows what the first request sends before the user message, without calling the model', async () => {
  const before = agents.model.requests.length;
  const sessions = () => readdirSync(join(agents.daemon.home, '.piop', 'sessions'), { recursive: true }).sort();
  const saved = sessions();
  const preview = await agents.daemon.invoke('agent_prompt_preview', { hostId: 'local', agent: 'reader' });
  expect(agents.model.requests.length).toBe(before);
  expect(sessions()).toEqual(saved);
  expect(preview.notices).toBeUndefined();
  expect(preview.model).toBe('scripted/scripted-model');
  const system = preview.messages[0];
  expect(system.role).toBe('system');
  expect(system.text).toContain('You are the reader agent.');
  expect(system.text).toContain('Only read files.');
  expect(preview.tools.map((tools: any) => tools.place)).toEqual(['tools']);
  expect(JSON.parse(preview.tools[0].json).map((tool: any) => tool.function.name).sort()).toEqual(['codemode', 'read']);

  agents.scripts.set('First message', () => ({ text: 'Hello.' }));
  const chat = await agents.daemon.invoke('create_temporary_chat', { hostId: 'local' });
  const runtimeId = 'preview-compare';
  await agents.daemon.invoke('start_pi', { runtimeId, clientId: 'laptop', cwd: agents.daemon.home, sessionId: chat.sessionId });
  const command = (value: any) => agents.daemon.invoke('pi_command', { runtimeId, command: value });
  await command({ type: 'select_agent', agent: 'reader' });
  await command({ type: 'prompt', message: 'First message' });
  for (let tries = 0; !agents.model.requests.some(request => text(request.messages.at(-1)) === 'First message') && tries < 100; tries++) await Bun.sleep(100);
  const request = agents.model.requests.find(request => text(request.messages.at(-1)) === 'First message');
  const sent = request.messages.slice(0, -1);
  expect(sent.map((message: any) => message.role)).toEqual(preview.messages.map((message: any) => message.role));
  expect(text(sent[0])).toBe(system.text);
  expect(preview.tools[0].json).toBe(JSON.stringify(request.tools, null, 2));
}, 60000);

test('a prompt preview shows tools that the request declares inside its input', async () => {
  const preview = await agents.daemon.invoke('agent_prompt_preview', { hostId: 'local', agent: 'inline-reader' });
  expect(preview.notices).toBeUndefined();
  expect(preview.tools.map((tools: any) => tools.place)).toEqual(['input[0]']);
  const item = JSON.parse(preview.tools[0].json);
  expect(item.type).toBe('additional_tools');
  expect(item.tools.map((tool: any) => tool.name).sort()).toEqual(['codemode', 'read']);
}, 60000);

test('a prompt preview of an unknown agent says why it failed', async () => {
  await expect(agents.daemon.invoke('agent_prompt_preview', { hostId: 'local', agent: 'nobody' })).rejects.toThrow(/Unknown defined agent: nobody/);
}, 60000);
