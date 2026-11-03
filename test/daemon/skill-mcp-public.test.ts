import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDaemon, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

test('a user-invoked skill whose MCP fails to load keeps the message unsent and adds a notice to the chat', async () => {
  const directory = join(agents.daemon.home, '.agents/skills', 'broken');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), '---\nname: broken\ndescription: The broken skill\n---\nBody of broken\n');
  writeFileSync(join(directory, 'mcp.json'), JSON.stringify({ mcpServers: { app: { command: process.execPath, args: ['-e', 'process.exit(1)'], exposure: 'direct', timeout: 5 } } }));
  const settings = await agents.daemon.invoke('load_app_settings', { refreshSkills: true });
  for (const item of settings.skills) item.enabled = true;
  await agents.daemon.invoke('save_app_settings', { settings });

  const chat = await agents.rootChat();
  await expect(chat.command({ type: 'prompt', message: '/skill:broken do the work' })).rejects.toThrow("This skill's embedded MCP failed to load");
  const entries = (await chat.command({ type: 'get_entries' })).entries;
  expect(entries.filter((entry: any) => entry.customType === 'piop-skill-mcp-failed').map((entry: any) => entry.data)).toEqual([{ skill: 'broken' }]);
  expect(entries.some((entry: any) => entry.type === 'message')).toBe(false);
  expect(agents.model.requests.some(request => request.messages.some((message: any) => text(message).includes('do the work')))).toBe(false);

  agents.scripts.set('Plain turn after the failure', () => ({ text: 'Done.' }));
  await chat.command({ type: 'prompt', message: 'Plain turn after the failure' });
  await chat.until(messages => text(messages.at(-1)) === 'Done.');
}, 60000);
