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

const nextSettlement = (runtimeId: string) => {
  const seen = new Set(agents.daemon.events.map(event => event.payload));
  return () => agents.daemon.waitEvent('pi://event', payload => !seen.has(payload)
    && payload.runtimeId === runtimeId && payload.event?.type === 'agent_settled');
};

test.concurrent('the chat list shows a chat as running while its agent works, and tells clients when it finishes', async () => {
  const agents = await agentDaemon();
  try {
    const busy = held<{ text: string }>();
    agents.scripts.set('Index the repository', () => busy.promise);
    const chat = await agents.rootChat();
    const listed = async () => (await agents.daemon.invoke('list_sessions')).find((session: any) => session.id === chat.sessionId)?.isRunning;
    await chat.command({ type: 'prompt', message: 'Index the repository' });
    await chat.until(() => agents.model.requests.some(request => text(request.messages.at(-1)) === 'Index the repository'));
    let mark = 0;
    try { expect(await listed()).toBe(true); mark = agents.daemon.events.length; } finally { busy.release({ text: 'Indexed.' }); }
    await chat.until(history => text(history.at(-1)) === 'Indexed.');
    for (let tries = 0; !agents.daemon.events.slice(mark).some(event => event.event === 'pi://sessions-changed') && tries < 50; tries++) await Bun.sleep(100);
    expect(agents.daemon.events.slice(mark).some(event => event.event === 'pi://sessions-changed')).toBe(true);
    expect(await listed()).toBe(false);
  } finally { await agents.close(); }
}, 60000);

test.concurrent('messages sent while the agent works wait their turn, and a removed one never reaches the agent', async () => {
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

test.concurrent('a steering message reaches the agent within its running turn, before waiting follow-ups', async () => {
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

test.concurrent('stopping a response holds the queue, the next message the user sends goes first, and all run on resume', async () => {
  const busy = held<{ text: string }>();
  agents.scripts.set('Stopped job', messages => text(messages.at(-1)) === 'Stopped job' ? busy.promise : { text: 'Answer to ' + text(messages.at(-1)) });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Stopped job' });
  await chat.until(() => agents.model.requests.some(request => text(request.messages.at(-1)) === 'Stopped job'));
  await chat.command({ type: 'follow_up', message: 'Waiting task' });
  const settled = nextSettlement(chat.runtimeId);
  await chat.command({ type: 'abort' });
  busy.release({ text: 'too late' });
  await chat.until(history => history.at(-1)?.role === 'assistant' && history.at(-1).stopReason === 'aborted');
  await settled();
  expect(userTexts(await chat.history())).toEqual(['Stopped job']);
  expect((await chat.command({ type: 'get_state' })).pendingMessages.map((item: any) => item.message)).toEqual(['Waiting task']);
  expect((await chat.command({ type: 'get_state' })).queueHeld).toBe(true);
  await chat.command({ type: 'follow_up', message: 'New request' });
  expect((await chat.command({ type: 'get_state' })).pendingMessages.map((item: any) => item.message)).toEqual(['New request', 'Waiting task']);
  await chat.command({ type: 'hold_queue', held: false });
  const messages = await chat.until(history => text(history.at(-1)) === 'Answer to Waiting task');
  expect(userTexts(messages)).toEqual(['Stopped job', 'New request', 'Waiting task']);
  expect((await chat.command({ type: 'get_state' })).pendingMessages).toEqual([]);
}, 60000);
test.concurrent('an edited follow-up keeps its place in the queue and reaches the agent with its new text, and an empty edit is refused', async () => {
  const busy = held<{ text: string }>();
  agents.scripts.set('Long draft', messages => {
    const last = text(messages.at(-1));
    if (last === 'Long draft') return busy.promise;
    return { text: 'Handled: ' + last };
  });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Long draft' });
  await chat.until(() => agents.model.requests.some(request => text(request.messages.at(-1)) === 'Long draft'));
  await chat.command({ type: 'follow_up', message: 'Fix the typo' });
  await chat.command({ type: 'follow_up', message: 'Then publish' });
  for (let tries = 0; pending(chat.runtimeId).length < 2 && tries < 50; tries++) await Bun.sleep(100);
  const first = pending(chat.runtimeId)[0].id;
  await expect(chat.command({ type: 'change_pending', id: first, action: { type: 'edit', message: '   ' } })).rejects.toThrow('cannot be empty');
  await chat.command({ type: 'change_pending', id: first, action: { type: 'edit', message: 'Fix the typo in the title' } });
  for (let tries = 0; pending(chat.runtimeId)[0]?.message !== 'Fix the typo in the title' && tries < 50; tries++) await Bun.sleep(100);
  expect(pending(chat.runtimeId).map(item => [item.message, item.behavior])).toEqual([['Fix the typo in the title', 'followUp'], ['Then publish', 'followUp']]);
  busy.release({ text: 'Draft done.' });
  const messages = await chat.until(history => text(history.at(-1)) === 'Handled: Then publish');
  expect(userTexts(messages)).toEqual(['Long draft', 'Fix the typo in the title', 'Then publish']);
}, 60000);
test.concurrent('a held queue keeps every message, even one sent while the agent is idle, and sends them in order on resume', async () => {
  const busy = held<{ text: string }>();
  agents.scripts.set('Long migration', messages => text(messages.at(-1)) === 'Long migration' ? busy.promise : { text: 'Handled: ' + text(messages.at(-1)) });
  const chat = await agents.rootChat();
  const latest = () => agents.daemon.events.filter(event => event.payload?.runtimeId === chat.runtimeId && event.payload.event?.type === 'queue_update').at(-1)?.payload.event;
  const asked = (message: string) => agents.model.requests.some(request => text(request.messages.at(-1)) === message);
  await chat.command({ type: 'prompt', message: 'Long migration' });
  await chat.until(() => asked('Long migration'));
  await chat.command({ type: 'follow_up', message: 'Check the schema' });
  for (let tries = 0; pending(chat.runtimeId).length < 1 && tries < 50; tries++) await Bun.sleep(100);
  await chat.command({ type: 'hold_queue', held: true });
  expect(latest()).toMatchObject({ held: true, pendingMessages: [{ message: 'Check the schema', behavior: 'followUp' }] });
  await chat.command({ type: 'steer', message: 'Keep the old column' });
  const settled = nextSettlement(chat.runtimeId);
  busy.release({ text: 'Migrated.' });
  await settled();
  await chat.command({ type: 'prompt', message: 'Run the tests' });
  expect(pending(chat.runtimeId).map(item => [item.message, item.behavior])).toEqual([['Check the schema', 'followUp'], ['Keep the old column', 'steer'], ['Run the tests', 'followUp']]);
  expect(['Check the schema', 'Keep the old column', 'Run the tests'].some(asked)).toBe(false);
  await chat.command({ type: 'hold_queue', held: false });
  const messages = await chat.until(history => text(history.at(-1)) === 'Handled: Run the tests');
  expect(userTexts(messages)).toEqual(['Long migration', 'Keep the old column', 'Check the schema', 'Run the tests']);
  expect(latest()).toMatchObject({ held: false, pendingMessages: [] });
}, 60000);
test.concurrent('a queued message sent from the composer can be edited, with its images, and the agent gets the edited text and images; a queued /compact cannot be edited', async () => {
  const png = (data: string) => ({ type: 'image', data, mimeType: 'image/png' });
  const red = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  const black = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const clear = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  agents.scripts.set('Look at this one', () => ({ text: 'Seen.' }));
  const chat = await agents.rootChat();
  await chat.command({ type: 'hold_queue', held: true });
  await chat.command({ type: 'follow_up', message: 'Look at these', images: [png(red), png(black)], goalSubmissionId: crypto.randomUUID() });
  await chat.command({ type: 'follow_up', message: '/compact keep the images', goalSubmissionId: crypto.randomUUID() });
  for (let tries = 0; pending(chat.runtimeId).length < 2 && tries < 50; tries++) await Bun.sleep(100);
  const [message, compaction] = pending(chat.runtimeId);
  await chat.command({ type: 'change_pending', id: message.id, action: { type: 'edit', message: 'Look at this one', images: { keep: [1], add: [png(clear)] } } });
  const edited = pending(chat.runtimeId)[0] as any;
  expect([edited.id, edited.message, edited.images.length]).toEqual([message.id, 'Look at this one', 2]);
  expect(await chat.command({ type: 'change_pending', id: compaction.id, action: { type: 'edit', message: '/compact', images: { keep: [], add: [] } } }).then(() => 'edited', (error: Error) => error.message)).toBe('A queued /compact cannot be edited. Remove it and queue a new one.');
  await chat.command({ type: 'change_pending', id: compaction.id, action: 'remove' });
  await chat.command({ type: 'hold_queue', held: false });
  await chat.until(history => text(history.at(-1)) === 'Seen.');
  const sent = agents.model.requests.find(request => text(request.messages.at(-1)) === 'Look at this one')!.messages.at(-1).content;
  expect(sent.filter((part: any) => part.type === 'image_url').map((part: any) => part.image_url.url)).toEqual(['data:image/png;base64,' + black, 'data:image/png;base64,' + clear]);
}, 60000);
