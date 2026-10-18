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

test('a response cut off by a dropped connection is tried again, and the new try does not see the cut-off text', async () => {
  let calls = 0;
  agents.scripts.set('Answer over a weak network', () => ++calls === 1 ? { text: 'Half an ans', drop: true } : { text: 'Whole answer.' });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Answer over a weak network' });
  const history = await chat.until(messages => text(messages.at(-1)) === 'Whole answer.');
  expect(calls).toBe(2);
  expect(history.filter(message => message.role === 'assistant').map(message => [text(message), message.stopReason])).toEqual([['Half an ans', 'error'], ['Whole answer.', 'stop']]);
  const retry = agents.model.requests.at(-1).messages.slice(1).map((message: any) => [message.role, text(message)]);
  expect(retry).toEqual([['user', 'Answer over a weak network']]);
  expect((await chat.command({ type: 'get_state' })).isPaused).toBe(false);
}, 60000);
