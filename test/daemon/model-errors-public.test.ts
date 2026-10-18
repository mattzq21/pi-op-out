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

test('with automatic retry turned off in Settings, also for a chat already open, a model outage is not tried again and the chat is paused', async () => {
  let calls = 0;
  agents.scripts.set('Answer without retries', () => { calls++; throw new Error('503 Service Unavailable'); });
  const chat = await agents.rootChat();
  const settings = await agents.daemon.invoke('load_app_settings');
  await agents.daemon.invoke('save_app_settings', { settings: { ...settings, autoRetry: false } });
  try {
    await chat.command({ type: 'prompt', message: 'Answer without retries' });
    await chat.until(history => history.at(-1)?.stopReason === 'error');
    await Bun.sleep(3000);
    expect(calls).toBe(1);
    expect((await chat.command({ type: 'get_state' })).isPaused).toBe(true);
  } finally { await agents.daemon.invoke('save_app_settings', { settings: { ...(await agents.daemon.invoke('load_app_settings')), autoRetry: true } }); }
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

test('a tool call cut off by a dropped connection never runs, and the new try does not see it', async () => {
  let calls = 0;
  agents.scripts.set('Run a command over a weak network', () => ++calls === 1 ? { text: 'Running it', stall: 'bash', drop: true } : { text: 'Done without it.' });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Run a command over a weak network' });
  const history = await chat.until(messages => text(messages.at(-1)) === 'Done without it.');
  expect(calls).toBe(2);
  expect(history.some(message => message.role === 'toolResult')).toBe(false);
  const retry = agents.model.requests.at(-1).messages.slice(1).map((message: any) => [message.role, text(message), message.tool_calls]);
  expect(retry).toEqual([['user', 'Run a command over a weak network', undefined]]);
}, 60000);
