import { afterAll, beforeAll, expect, test } from 'bun:test';
import { agentDaemon, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

test('stopping a response keeps its finished text, never runs its unfinished tool call, and the next turn knows it was stopped', async () => {
  agents.scripts.set('Write and then run', messages => messages.some((message: any) => message.role === 'user' && text(message) === 'Go on')
    ? { text: 'Continued.' } : { text: 'Here is the first part.', stall: 'bash' });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Write and then run' });
  for (let tries = 0; agents.model.requests.length === 0 && tries < 100; tries++) await Bun.sleep(100);
  await Bun.sleep(1000);
  await chat.command({ type: 'abort' });
  const stopped = await chat.until(history => history.some(message => message.role === 'assistant' && message.stopReason === 'aborted'));
  const answer = stopped.findLast(message => message.role === 'assistant');
  expect(answer.content.map((part: any) => part.type)).toEqual(['text']);
  expect(text(answer)).toBe('Here is the first part.');
  expect(stopped.some(message => message.role === 'toolResult')).toBe(false);
  expect((await chat.command({ type: 'get_state' })).isPaused).toBe(false);
  await chat.command({ type: 'prompt', message: 'Go on' });
  await chat.until(history => text(history.at(-1)) === 'Continued.');
  const next = agents.model.requests.at(-1).messages.filter((message: any) => message.role === 'assistant');
  expect(next.map(text)).toEqual(['Here is the first part.[Response stopped by the user. Only completed content blocks are retained. Any tool calls in this response were not executed.]']);
}, 60000);
