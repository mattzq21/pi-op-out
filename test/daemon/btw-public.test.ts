import { afterAll, beforeAll, expect, test } from 'bun:test';
import { agentDaemon, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

const OPEN = '__pi_desktop_auxiliary__';

async function sideChat(chat: Awaited<ReturnType<typeof agents.rootChat>>, message: string) {
  const seen = new Set(agents.daemon.events.map(event => event.payload));
  await chat.command({ type: 'prompt', message });
  const opened = await agents.daemon.waitEvent('pi://event', payload => !seen.has(payload) && payload.runtimeId === chat.runtimeId && payload.event?.method === 'input' && payload.event.title === OPEN, 30000);
  return JSON.parse(opened.event.placeholder);
}

const notices = (runtimeId: string) => agents.daemon.events.filter(event => event.payload?.runtimeId === runtimeId && event.payload.event?.method === 'notify').map(event => event.payload.event.message);

async function notice(runtimeId: string, expected: string) {
  for (let tries = 0; !notices(runtimeId).includes(expected) && tries < 100; tries++) await Bun.sleep(100);
  expect(notices(runtimeId)).toContain(expected);
}

async function answeredChat(prompt: string) {
  agents.scripts.set(prompt, messages => {
    const last = text(messages.at(-1));
    if (last.includes('Side finding')) return { text: 'Thanks for the side finding.' };
    if (last.includes('Check the lexer')) return { tool: 'send_to_main', arguments: { message: 'Side finding: the lexer is fine' } };
    if (messages.at(-1)?.role === 'tool') return { text: 'Sent to main.' };
    return { text: 'Plan ready.' };
  });
  const chat = await agents.rootChat({ visible: true });
  await chat.command({ type: 'prompt', message: prompt });
  await chat.until(history => text(history.at(-1)) === 'Plan ready.');
  return chat;
}

const listed = async (sessionId: string) => (await agents.daemon.invoke('list_sessions')).find((session: any) => session.id === sessionId);

test.concurrent('/btw opens a side chat with the main chat history, which sends its results to the main chat with send_to_main', async () => {
  const chat = await answeredChat('Plan the parser');
  const side = await sideChat(chat, '/btw Check the lexer');
  expect(side).toMatchObject({ kind: 'btw', task: 'Check the lexer', parentSessionId: chat.sessionId, hostId: 'local' });
  expect(side.name).toStartWith('btw ');
  await agents.daemon.invoke('start_pi', { runtimeId: 'btw-side', clientId: 'laptop', cwd: side.cwd, sessionPath: side.sessionPath });
  const sideCommand = (command: any) => agents.daemon.invoke('pi_command', { runtimeId: 'btw-side', command });
  const entries = (await sideCommand({ type: 'get_entries' })).entries;
  expect(entries.filter((entry: any) => entry.type === 'message' && entry.message.role !== 'system').map((entry: any) => [entry.message.role, text(entry.message)])).toEqual([['user', 'Plan the parser'], ['assistant', 'Plan ready.']]);
  expect(entries.some((entry: any) => entry.customType === 'piop-auxiliary-note')).toBe(false);
  expect((await sideCommand({ type: 'get_state' })).canFork).toBe(false);
  expect(await listed(side.sessionId)).toMatchObject({ auxiliaryParentId: chat.sessionId, auxiliaryKind: 'btw', name: side.name });

  await sideCommand({ type: 'prompt', message: side.task });
  await chat.until(history => text(history.at(-1)) === 'Thanks for the side finding.');
  const sideRequest = agents.model.requests.find(request => text(request.messages.at(-1)) === 'Check the lexer');
  expect(sideRequest.tools.find((tool: any) => tool.function.name === 'send_to_main')?.function.description).toBe('Send results to the main chat. Use only when user explicitly asks to communicate with the other chat');
  const mainRequest = agents.model.requests.find(request => text(request.messages.at(-1)) === 'Plan the parser');
  expect(mainRequest.tools.some((tool: any) => tool.function.name === 'send_to_main')).toBe(false);

  await sideCommand({ type: 'prompt', message: '/btw Another question' });
  await notice('btw-side', '/btw failed: /btw is not available in a side chat');
}, 60000);

test.concurrent('/btw after a stopped response copies the history through the stopped response', async () => {
  agents.scripts.set('Draft the lexer', messages => text(messages.at(-1)) === 'Draft the lexer' ? { text: 'First answer.' } : { text: 'Partial draft.', stall: 'bash' });
  const chat = await agents.rootChat({ visible: true });
  await chat.command({ type: 'prompt', message: 'Draft the lexer' });
  await chat.until(history => text(history.at(-1)) === 'First answer.');
  await chat.command({ type: 'prompt', message: 'Keep drafting' });
  await agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === chat.runtimeId
    && payload.event?.type === 'message_update' && payload.event.assistantMessageEvent?.type === 'toolcall_delta');
  await chat.command({ type: 'abort' });
  await chat.until(history => history.at(-1)?.role === 'assistant' && history.at(-1).stopReason === 'aborted');
  const side = await sideChat(chat, '/btw');
  await agents.daemon.invoke('start_pi', { runtimeId: 'btw-stopped', clientId: 'laptop', cwd: side.cwd, sessionPath: side.sessionPath });
  const entries = (await agents.daemon.invoke('pi_command', { runtimeId: 'btw-stopped', command: { type: 'get_entries' } })).entries;
  expect(entries.filter((entry: any) => entry.type === 'message' && entry.message.role !== 'system').map((entry: any) => [entry.message.role, text(entry.message)]))
    .toEqual([['user', 'Draft the lexer'], ['assistant', 'First answer.'], ['user', 'Keep drafting'], ['assistant', 'Partial draft.']]);
}, 60000);

test.concurrent('/btw during a goal run copies the history through the last finished agent turn, without the goal', async () => {
  agents.scripts.set('Audit the tokens', messages => messages.some((message: any) => message.role === 'tool') ? { text: 'Checking more.', stall: 'bash' } : { tool: 'bash', arguments: { command: 'echo tokens checked' } });
  const chat = await agents.rootChat({ visible: true });
  await chat.command({ type: 'follow_up', message: '/goal Audit the tokens', goalSubmissionId: crypto.randomUUID() });
  const stalled = () => agents.model.requests.some(request => text(request.messages.find((message: any) => message.role === 'user')).includes('Audit the tokens') && request.messages.some((message: any) => message.role === 'tool'));
  for (let tries = 0; !stalled() && tries < 100; tries++) await Bun.sleep(100);
  expect(stalled()).toBe(true);
  const mainGoal = agents.daemon.events.filter(event => event.payload?.runtimeId === chat.runtimeId && event.payload.event?.method === 'setStatus' && event.payload.event.statusKey === 'piop-goal' && event.payload.event.statusText).at(-1);
  expect(JSON.parse(mainGoal.payload.event.statusText)).toMatchObject({ objective: 'Audit the tokens', status: 'active' });
  const side = await sideChat(chat, '/btw');
  const goalStatus = (payload: any) => payload.runtimeId === 'btw-goal' && payload.event?.method === 'setStatus' && payload.event.statusKey === 'piop-goal';
  await agents.daemon.invoke('start_pi', { runtimeId: 'btw-goal', clientId: 'laptop', cwd: side.cwd, sessionPath: side.sessionPath });
  expect((await agents.daemon.waitEvent('pi://event', goalStatus, 30000)).event.statusText).toBeFalsy();
  const entries = (await agents.daemon.invoke('pi_command', { runtimeId: 'btw-goal', command: { type: 'get_entries' } })).entries;
  const messages = entries.filter((entry: any) => entry.type === 'message').map((entry: any) => entry.message);
  expect(messages.slice(-2).map((message: any) => message.role)).toEqual(['assistant', 'toolResult']);
  expect(messages.at(-2).content.some((part: any) => part.type === 'toolCall' && part.name === 'bash')).toBe(true);
  expect(messages.some((message: any) => text(message) === 'Checking more.')).toBe(false);
}, 60000);

test.concurrent('/btw in a forked chat does not show the fork source of its main chat', async () => {
  const chat = await answeredChat('Plan the fork');
  const answer = (await chat.command({ type: 'get_entries' })).entries.findLast((entry: any) => entry.type === 'message' && entry.message.role === 'assistant');
  await chat.command({ type: 'copy_after', entryId: answer.id });
  expect((await chat.command({ type: 'get_state' })).forkSource).toBeDefined();
  const side = await sideChat(chat, '/btw');
  await agents.daemon.invoke('start_pi', { runtimeId: 'btw-forked', clientId: 'laptop', cwd: side.cwd, sessionPath: side.sessionPath });
  expect((await agents.daemon.invoke('pi_command', { runtimeId: 'btw-forked', command: { type: 'get_state' } })).forkSource).toBeUndefined();
}, 60000);

test.concurrent('/btw before the first answer says to wait for it', async () => {
  const chat = await agents.rootChat({ visible: true });
  await chat.command({ type: 'prompt', message: '/btw Too early' });
  await notice(chat.runtimeId, '/btw failed: Wait for the first agent turn to finish');
  expect(agents.daemon.events.some(event => event.payload?.runtimeId === chat.runtimeId && event.payload.event?.title === OPEN)).toBe(false);
}, 60000);

test.concurrent('a side chat archived alone, and one archived with its main chat, both stay archived when the main chat is restored', async () => {
  const chat = await answeredChat('Plan the archive');
  const closed = await sideChat(chat, '/btw First side question');
  const open = await sideChat(chat, '/btw Second side question');
  const archive = (sessionPath: string) => agents.daemon.invoke('archive_session', { hostId: 'local', sessionPath, terminalIds: [], clientId: 'btw-test' });
  await archive(closed.sessionPath);
  expect(await listed(closed.sessionId)).toBeUndefined();
  expect(await listed(open.sessionId)).toMatchObject({ auxiliaryParentId: chat.sessionId });

  await archive((await listed(chat.sessionId)).path);
  const archives = (await agents.daemon.invoke('storage_report')).hosts.find((host: any) => host.hostId === 'local').archives;
  const archived = (id: string) => archives.find((item: any) => item.id === id);
  expect([archived(chat.sessionId)?.restorable, archived(closed.sessionId)?.restorable, archived(open.sessionId)?.restorable]).toEqual([true, false, false]);
  const locate = (sessionId: string) => agents.daemon.invoke('broker_request', { hostId: 'local', path: '/orchestration', body: { action: 'locate', sessionId, hostId: 'local' } });
  expect([(await locate(chat.sessionId)).auxiliary, (await locate(closed.sessionId)).auxiliary, (await locate(open.sessionId)).auxiliary]).toEqual([false, true, true]);

  await agents.daemon.invoke('restore_archived_session', { hostId: 'local', sessionPath: archived(chat.sessionId).path, clientId: 'btw-test' });
  expect(await listed(chat.sessionId)).toBeDefined();
  expect([await listed(closed.sessionId), await listed(open.sessionId)]).toEqual([undefined, undefined]);
}, 60000);

test.concurrent('control of the main chat is control of its side chats, and taking either takes both with the views of that client', async () => {
  const chat = await answeredChat('Plan the control');
  const side = await sideChat(chat, '/btw');
  const start = (runtimeId: string, clientId: string, target: any) => agents.daemon.invoke('start_pi', { runtimeId, clientId, cwd: side.cwd, ...target });
  const event = (runtimeId: string, type: string, after: number) => agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === runtimeId && payload.event?.type === type && agents.daemon.events.findIndex(item => item.payload === payload) >= after, 10000);
  expect((await start('control-laptop-side', 'laptop', { sessionPath: side.sessionPath })).owned).toBe(true);
  expect((await start('control-phone-root', 'phone', { sessionId: chat.sessionId })).owned).toBe(false);
  expect((await start('control-phone-side', 'phone', { sessionPath: side.sessionPath })).owned).toBe(false);

  let mark = agents.daemon.events.length;
  await agents.daemon.invoke('pi_command', { runtimeId: 'control-phone-root', command: { type: 'take_ownership' } });
  await event('control-laptop-side', 'ownership_lost', mark);
  await event(chat.runtimeId, 'ownership_lost', mark);
  await event('control-phone-side', 'ownership_acquired', mark);
  await expect(agents.daemon.invoke('pi_command', { runtimeId: 'control-laptop-side', command: { type: 'prompt', message: 'Still mine?' } })).rejects.toThrow();
  expect((await agents.daemon.invoke('pi_command', { runtimeId: 'control-phone-side', command: { type: 'get_state' } })).sessionId).toBe(side.sessionId);
  await agents.daemon.invoke('pi_command', { runtimeId: 'control-phone-side', command: { type: 'hold_queue', held: false } });

  mark = agents.daemon.events.length;
  await agents.daemon.invoke('pi_command', { runtimeId: 'control-laptop-side', command: { type: 'take_ownership' } });
  await event('control-phone-root', 'ownership_lost', mark);
  await event('control-phone-side', 'ownership_lost', mark);
  await event(chat.runtimeId, 'ownership_acquired', mark);
  await agents.daemon.invoke('pi_command', { runtimeId: chat.runtimeId, command: { type: 'hold_queue', held: false } });
}, 60000);

test.concurrent('/btw opens at once during a turn, with or without a question', async () => {
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  agents.scripts.set('Plan the queue', async messages => {
    if (text(messages.at(-1)) !== 'Keep working') return { text: 'First answer.' };
    await finished;
    return { text: 'Done working.' };
  });
  const chat = await agents.rootChat({ visible: true });
  await chat.command({ type: 'prompt', message: 'Plan the queue' });
  await chat.until(history => text(history.at(-1)) === 'First answer.');
  await chat.command({ type: 'prompt', message: 'Keep working' });
  for (let tries = 0; !agents.model.requests.some(request => text(request.messages.at(-1)) === 'Keep working') && tries < 100; tries++) await Bun.sleep(100);

  const bare = await sideChat(chat, '/btw');
  expect(bare.task).toBeUndefined();
  const asked = await sideChat(chat, '/btw Side question');
  expect(asked).toMatchObject({ kind: 'btw', task: 'Side question' });
  expect((await chat.command({ type: 'get_state' })).pendingMessageCount).toBe(0);
  finish();
  await chat.until(history => text(history.at(-1)) === 'Done working.');
  expect((await chat.history()).map(text)).not.toContain('/btw Side question');
}, 60000);

test.concurrent('a pane that once took control by click does not take it back when another client takes control during a linked update', async () => {
  const chat = await answeredChat('Plan the race');
  const opened = async (message: string) => {
    const side = await sideChat(chat, message);
    const opening = agents.daemon.events.findLast(event => event.payload?.runtimeId === chat.runtimeId && event.payload.event?.title === OPEN);
    await chat.command({ type: 'extension_ui_response', id: opening.payload.event.id, value: 'opened' });
    return side;
  };
  const clicked = await opened('/btw');
  const unopened = await opened('/btw');
  const start = (runtimeId: string, clientId: string, side: any) => agents.daemon.invoke('start_pi', { runtimeId, clientId, cwd: side.cwd, sessionPath: side.sessionPath });
  const take = (runtimeId: string) => agents.daemon.invoke('pi_command', { runtimeId, command: { type: 'take_ownership' } });
  const controls = (runtimeId: string) => agents.daemon.invoke('pi_command', { runtimeId, command: { type: 'hold_queue', held: false } }).then(() => true, () => false);
  expect((await start('race-laptop', 'laptop', clicked)).owned).toBe(true);
  expect((await start('race-phone-clicked', 'phone', clicked)).owned).toBe(false);
  await take('race-phone-clicked');
  await take('race-laptop');
  expect(await controls('race-phone-clicked')).toBe(false);
  expect((await start('race-phone-unopened', 'phone', unopened)).owned).toBe(false);

  const phone = take('race-phone-unopened');
  await Bun.sleep(300);
  await take('race-laptop');
  await phone;
  expect(await controls('race-laptop')).toBe(true);
  expect(await controls('race-phone-clicked')).toBe(false);
  expect(await controls('race-phone-unopened')).toBe(false);
}, 60000);

test.concurrent('a held queue does not hold /btw', async () => {
  const chat = await answeredChat('Plan the hold');
  await chat.command({ type: 'hold_queue', held: true });
  const asked = await sideChat(chat, '/btw Held question');
  expect(asked.task).toBe('Held question');
  expect((await chat.command({ type: 'get_state' })).pendingMessageCount).toBe(0);
  expect((await chat.history()).map(text)).not.toContain('/btw Held question');
}, 60000);
