import { afterAll, beforeAll, expect, test } from 'bun:test';
import { agentDaemon, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

test('a short model outage is retried on its own, and the chat answers and is not paused', async () => {
  let calls = 0;
  agents.scripts.set('Answer after an outage', () => { if (++calls === 1) throw new Error('503 Service Unavailable'); return { text: 'Answered after a retry.' }; });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Answer after an outage' });
  await chat.until(history => text(history.at(-1)) === 'Answered after a retry.');
  expect(calls).toBe(2);
  expect((await chat.command({ type: 'get_state' })).isPaused).toBe(false);
}, 60000);
