import { afterAll, beforeAll, expect, test } from 'bun:test';
import { agentDaemon, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

const OPEN = '__pi_desktop_auxiliary__';

/** Sends /btw in chat and returns what the side pane receives. */
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

/** A chat that answered once, so /btw has history to copy. */
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
  expect(entries.find((entry: any) => entry.customType === 'piop-auxiliary-note')?.content).toBe('This is a side chat of the main chat. Use send_to_main to send results there.');
  expect((await sideCommand({ type: 'get_state' })).canFork).toBe(false);
  expect(await listed(side.sessionId)).toMatchObject({ auxiliaryParentId: chat.sessionId, auxiliaryKind: 'btw', name: side.name });

  await sideCommand({ type: 'prompt', message: side.task });
  await chat.until(history => text(history.at(-1)) === 'Thanks for the side finding.');
  const sideRequest = agents.model.requests.find(request => text(request.messages.at(-1)) === 'Check the lexer');
  expect(sideRequest.tools.find((tool: any) => tool.function.name === 'send_to_main')?.function.description).toBe('Send results to the main chat.');
  const mainRequest = agents.model.requests.find(request => text(request.messages.at(-1)) === 'Plan the parser');
  expect(mainRequest.tools.some((tool: any) => tool.function.name === 'send_to_main')).toBe(false);

  await sideCommand({ type: 'prompt', message: '/btw Another question' });
  await notice('btw-side', '/btw failed: /btw is not available in a side chat');
}, 60000);

test.concurrent('/btw before the first answer says to wait for it', async () => {
  const chat = await agents.rootChat({ visible: true });
  await chat.command({ type: 'prompt', message: '/btw Too early' });
  await notice(chat.runtimeId, '/btw failed: Wait for the first answer');
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

  await agents.daemon.invoke('restore_archived_session', { hostId: 'local', sessionPath: archived(chat.sessionId).path, clientId: 'btw-test' });
  expect(await listed(chat.sessionId)).toBeDefined();
  expect([await listed(closed.sessionId), await listed(open.sessionId)]).toEqual([undefined, undefined]);
}, 60000);
