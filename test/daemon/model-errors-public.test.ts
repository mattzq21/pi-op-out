import { afterAll, beforeAll, expect, test } from 'bun:test';
import { agentDaemon, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

test.concurrent('a short model outage is retried on its own, and the chat answers and is not paused', async () => {
  let calls = 0;
  agents.scripts.set('Answer after an outage', () => { if (++calls === 1) throw new Error('503 Service Unavailable'); return { text: 'Answered after a retry.' }; });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Answer after an outage' });
  await chat.until(history => text(history.at(-1)) === 'Answered after a retry.');
  expect(calls).toBe(2);
  expect((await chat.command({ type: 'get_state' })).isPaused).toBe(false);
}, 60000);

test.concurrent('a response cut off by a dropped connection is tried again, and the new try does not see the cut-off text', async () => {
  let calls = 0;
  agents.scripts.set('Answer over a weak network', () => ++calls === 1 ? { text: 'Half an ans', drop: true } : { text: 'Whole answer.' });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Answer over a weak network' });
  const history = await chat.until(messages => text(messages.at(-1)) === 'Whole answer.');
  expect(calls).toBe(2);
  expect(history.filter(message => message.role === 'assistant').map(message => [text(message), message.stopReason])).toEqual([['Half an ans', 'error'], ['Whole answer.', 'stop']]);
  const retry = agents.model.requests.findLast(request => request.messages.some((message: any) => message.role === 'user' && text(message) === 'Answer over a weak network')).messages.slice(1).map((message: any) => [message.role, text(message)]);
  expect(retry).toEqual([['user', 'Answer over a weak network']]);
  expect((await chat.command({ type: 'get_state' })).isPaused).toBe(false);
}, 60000);

test.concurrent('a tool call cut off by a dropped connection never runs, and the new try does not see it', async () => {
  let calls = 0;
  agents.scripts.set('Run a command over a weak network', () => ++calls === 1 ? { text: 'Running it', stall: 'bash', drop: true } : { text: 'Done without it.' });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Run a command over a weak network' });
  const history = await chat.until(messages => text(messages.at(-1)) === 'Done without it.');
  expect(calls).toBe(2);
  expect(history.some(message => message.role === 'toolResult')).toBe(false);
  const retry = agents.model.requests.findLast(request => request.messages.some((message: any) => message.role === 'user' && text(message) === 'Run a command over a weak network')).messages.slice(1).map((message: any) => [message.role, text(message), message.tool_calls]);
  expect(retry).toEqual([['user', 'Run a command over a weak network', undefined]]);
}, 60000);

test('with automatic retry turned off in Settings, also for a chat already open, a model outage pauses the chat, and resuming tries again', async () => {
  let calls = 0;
  agents.scripts.set('Answer without retries', () => { if (++calls === 1) throw new Error('503 Service Unavailable'); return { text: 'Recovered.' }; });
  const chat = await agents.rootChat();
  const settings = await agents.daemon.invoke('load_app_settings');
  await agents.daemon.invoke('save_app_settings', { settings: { ...settings, autoRetry: false } });
  try {
    await chat.command({ type: 'prompt', message: 'Answer without retries' });
    await chat.until(history => history.at(-1)?.stopReason === 'error');
    await agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === chat.runtimeId && payload.event?.type === 'agent_settled');
    expect(calls).toBe(1);
    expect((await chat.command({ type: 'get_state' })).isPaused).toBe(true);
    await chat.command({ type: 'resume' });
    await chat.until(history => text(history.at(-1)) === 'Recovered.');
    expect(agents.model.requests.at(-1).messages.slice(1).map((message: any) => message.role)).toEqual(['user', 'user']);
    expect((await chat.command({ type: 'get_state' })).isPaused).toBe(false);
  } finally { await agents.daemon.invoke('save_app_settings', { settings: { ...(await agents.daemon.invoke('load_app_settings')), autoRetry: true } }); }
}, 60000);

test('a chat paused by a model outage takes a new message from the composer at once, which ends the pause', async () => {
  const settings = await agents.daemon.invoke('load_app_settings');
  await agents.daemon.invoke('save_app_settings', { settings: { ...settings, autoRetry: false } });
  try {
    let calls = 0;
    agents.scripts.set('Outage, then a new message', messages => { if (++calls === 1) throw new Error('503 Service Unavailable'); return { text: 'Answer to ' + text(messages.at(-1)) }; });
    const chat = await agents.rootChat();
    await chat.command({ type: 'follow_up', message: 'Outage, then a new message' });
    await chat.until(history => history.at(-1)?.stopReason === 'error');
    for (let tries = 0; !(await chat.command({ type: 'get_state' })).isPaused && tries < 50; tries++) await Bun.sleep(100);
    await chat.command({ type: 'follow_up', message: 'Please try again' });
    await chat.until(history => text(history.at(-1)) === 'Answer to Please try again');
    const state = await chat.command({ type: 'get_state' });
    expect([state.isPaused, state.pendingMessages]).toEqual([false, []]);
  } finally { await agents.daemon.invoke('save_app_settings', { settings: { ...(await agents.daemon.invoke('load_app_settings')), autoRetry: true } }); }
}, 60000);
