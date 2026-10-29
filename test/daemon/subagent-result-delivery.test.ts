import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { agentDaemon, called } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => {
  agents = await agentDaemon();
  // Pi holds messages sent while it settles and runs each as its own turn. A slow settle handler keeps that window open.
  const extensions = join(agents.daemon.home, '.piop/extensions');
  mkdirSync(extensions, { recursive: true });
  writeFileSync(join(extensions, 'slow-settle.ts'), "import { writeFileSync } from 'node:fs';\nexport default (pi: any) => { writeFileSync(" + JSON.stringify(join(agents.daemon.home, 'slow-settle-loaded')) + ", ''); pi.on('agent_settled', () => new Promise(resolve => setTimeout(resolve, 300))); };\n");
  await agents.enableAgentTools('spawn_subagents');
}, 60000);
afterAll(async () => { await agents?.close(); });

test('results of subagents that finish while their parent is busy reach the parent once each', async () => {
  const busy = Promise.withResolvers<any>();
  const names = ['Ann', 'Bob', 'Cal', 'Dee'];
  agents.scripts.set('Fan out the work', messages => {
    if (!called(messages, 'spawn_subagents')) return { tool: 'spawn_subagents', arguments: { tasks: names.map(name => ({ nickname: name, task: 'Report ' + name })) } };
    if (messages.at(-1).role === 'tool') return busy.promise;
    return { text: 'Noted.' };
  });
  for (const name of names) agents.scripts.set('Report ' + name, () => ({ text: 'Report from ' + name }));
  const root = await agents.rootChat();
  expect(existsSync(join(agents.daemon.home, 'slow-settle-loaded'))).toBe(true);
  await root.command({ type: 'prompt', message: 'Fan out the work' });
  await root.until(() => names.every(name => agents.model.requests.some(request => JSON.stringify(request.messages).includes('Report ' + name))));
  await Bun.sleep(1500);
  busy.resolve({ text: 'Waiting for reports.' });
  const results = async () => (await root.command({ type: 'get_entries' })).entries.filter((entry: any) => entry.customType === 'piop-subagent-result').map((entry: any) => entry.details.notificationId);
  for (const deadline = Date.now() + 30000; (await results()).length < names.length && Date.now() < deadline;) await Bun.sleep(100);
  await Bun.sleep(4000);
  const delivered = await results();
  expect(delivered.length).toBe(new Set(delivered).size);
  expect(new Set(delivered).size).toBe(names.length);
}, 120000);
