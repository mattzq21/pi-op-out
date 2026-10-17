import { afterAll, beforeAll, expect, test } from 'bun:test';
import { agentDaemon, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

/** A promise that the test settles later, to keep the agent busy. */
const held = <T>() => { let release!: (value: T) => void; const promise = new Promise<T>(resolve => { release = resolve; }); return { promise, release }; };

/** The queued messages the app shows for this chat, from its latest queue update. */
const pending = (runtimeId: string): Array<{ id: string; message: string; behavior: string }> =>
  agents.daemon.events.filter(event => event.payload?.runtimeId === runtimeId && event.payload.event?.type === 'queue_update').at(-1)?.payload.event.pendingMessages ?? [];

const userTexts = (messages: any[]) => messages.filter(message => message.role === 'user').map(text);

test('messages sent while the agent works wait their turn, and a removed one never reaches the agent', async () => {
  const busy = held<{ text: string }>();
  agents.scripts.set('Long build', messages => {
    const last = text(messages.at(-1));
    if (last === 'Long build') return busy.promise;
    return { text: 'Handled: ' + last };
  });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Long build' });
  await chat.until(() => agents.model.requests.some(request => text(request.messages.at(-1)) === 'Long build'));
  await chat.command({ type: 'follow_up', message: 'Also run lint' });
  await chat.command({ type: 'follow_up', message: 'Then deploy' });
  for (let tries = 0; pending(chat.runtimeId).length < 2 && tries < 50; tries++) await Bun.sleep(100);
  expect(pending(chat.runtimeId).map(item => [item.message, item.behavior])).toEqual([['Also run lint', 'followUp'], ['Then deploy', 'followUp']]);
  await chat.command({ type: 'change_pending', id: pending(chat.runtimeId)[0].id, action: 'remove' });
  for (let tries = 0; pending(chat.runtimeId).length !== 1 && tries < 50; tries++) await Bun.sleep(100);
  expect(pending(chat.runtimeId).map(item => item.message)).toEqual(['Then deploy']);
  busy.release({ text: 'Build done.' });
  const messages = await chat.until(history => text(history.at(-1)) === 'Handled: Then deploy');
  expect(userTexts(messages)).toEqual(['Long build', 'Then deploy']);
  expect(messages.filter(message => message.role === 'assistant').map(text)).toEqual(['Build done.', 'Handled: Then deploy']);
}, 60000);

test('a steering message reaches the agent within its running turn, before waiting follow-ups', async () => {
  const busy = held<{ tool: string; arguments: Record<string, unknown> }>();
  agents.scripts.set('Install packages', messages => {
    const last = messages.at(-1);
    if (text(last) === 'Install packages') return busy.promise;
    if (last.role === 'user' && text(last) === 'Afterwards, update the README') return { text: 'README updated.' };
    const steered = messages.some((message: any) => message.role === 'user' && text(message) === 'Use pnpm instead');
    return { text: steered ? 'Switched to pnpm.' : 'Used npm.' };
  });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Install packages' });
  await chat.until(() => agents.model.requests.some(request => text(request.messages.at(-1)) === 'Install packages'));
  await chat.command({ type: 'follow_up', message: 'Afterwards, update the README' });
  await chat.command({ type: 'steer', message: 'Use pnpm instead' });
  for (let tries = 0; pending(chat.runtimeId).length < 2 && tries < 50; tries++) await Bun.sleep(100);
  busy.release({ tool: 'ls', arguments: { path: '.' } });
  const messages = await chat.until(history => text(history.at(-1)) === 'README updated.');
  expect(messages.filter(message => message.role === 'assistant').map(text).filter(Boolean)).toEqual(['Switched to pnpm.', 'README updated.']);
  expect(userTexts(messages)).toEqual(['Install packages', 'Use pnpm instead', 'Afterwards, update the README']);
}, 60000);

test('pausing stops the running response and holds waiting messages until the chat is resumed', async () => {
  const busy = held<{ text: string }>();
  agents.scripts.set('Paused job', messages => {
    const last = messages.at(-1);
    if (last.role === 'user' && text(last) === 'Paused job' && !messages.some((message: any) => message.role === 'assistant')) return busy.promise;
    if (last.role === 'user' && text(last) === 'Next task') return { text: 'Next task done.' };
    return { text: 'Resumed work.' };
  });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Paused job' });
  await chat.until(() => agents.model.requests.some(request => text(request.messages.at(-1)) === 'Paused job'));
  await chat.command({ type: 'pause' });
  busy.release({ text: 'too late' });
  await chat.command({ type: 'follow_up', message: 'Next task' });
  const paused = await chat.until(history => history.some(message => message.role === 'assistant' && message.errorMessage === 'Response paused'));
  expect(paused.findLast(message => message.role === 'assistant')).toMatchObject({ stopReason: 'aborted', errorMessage: 'Response paused' });
  await Bun.sleep(1500);
  expect((await chat.command({ type: 'get_state' })).isPaused).toBe(true);
  expect(userTexts(await chat.history())).toEqual(['Paused job']);
  await chat.command({ type: 'resume' });
  const messages = await chat.until(history => text(history.at(-1)) === 'Next task done.');
  expect(messages.filter(message => message.role === 'assistant').map(text).filter(Boolean)).toEqual(['Resumed work.', 'Next task done.']);
}, 60000);
