import { afterAll, beforeAll, expect, test } from 'bun:test';
import { agentDaemon, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); await agents.enableAgentTools('spawn_subagents'); }, 60000);
afterAll(async () => { await agents?.close(); });

const OPEN = '__pi_desktop_auxiliary__';

type Chat = Awaited<ReturnType<typeof agents.rootChat>>;

/** Sends a /btw or /review command in chat and returns what the side pane receives. */
async function sideChat(chat: Chat, type: 'prompt' | 'follow_up', message: string) {
  const seen = new Set(agents.daemon.events.map(event => event.payload));
  await chat.command({ type, message });
  const opened = await agents.daemon.waitEvent('pi://event', payload => !seen.has(payload) && payload.runtimeId === chat.runtimeId && payload.event?.method === 'input' && payload.event.title === OPEN, 30000)
    .catch(error => { throw new Error(error.message + '; notices: ' + JSON.stringify(agents.daemon.events.filter(event => event.payload?.runtimeId === chat.runtimeId && event.payload.event?.method === 'notify').map(event => event.payload.event.message))); });
  return JSON.parse(opened.event.placeholder);
}

const sessions = () => agents.daemon.invoke('list_sessions');
const answer = async (chat: Chat, reply: string) => (await chat.command({ type: 'get_entries' })).entries.find((entry: any) => entry.type === 'message' && text(entry.message) === reply);

for (const mode of ['copy_after', 'fork_after'] as const) test.concurrent(`${mode} copies the side chats, reviews and subagents made through the fork point, but not archived or later ones`, async () => {
  const prompt = 'Fork copies ' + mode;
  agents.scripts.set(prompt, messages => {
    const last = text(messages.at(-1));
    if (last === prompt) return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Helper', task: 'Help with ' + mode }] } };
    if (last === 'Nested help ' + mode) return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Nested', task: 'Nested task ' + mode }] } };
    if (messages.at(-1)?.role === 'tool' && text(messages.findLast((message: any) => message.role === 'user')) === 'Nested help ' + mode) return { text: 'Nested started.' };
    if (last.includes('Second task')) return { text: 'Second answer.' };
    return { text: 'First answer.' };
  });
  agents.scripts.set('Help with ' + mode, () => ({ text: 'Helped.' }));
  agents.scripts.set('Nested task ' + mode, () => ({ text: 'Nested done.' }));
  const chat = await agents.rootChat({ visible: true, repository: true });
  await chat.command({ type: 'prompt', message: prompt });
  await chat.until(history => history.filter(message => text(message) === 'First answer.').length >= 2);
  const kept = await sideChat(chat, 'prompt', '/btw');
  const archived = await sideChat(chat, 'prompt', '/btw');
  await agents.daemon.invoke('archive_session', { hostId: 'local', sessionPath: archived.sessionPath, terminalIds: [], clientId: 'fork-test' });
  const review = await sideChat(chat, 'follow_up', '/review the lexer');
  await chat.command({ type: 'prompt', message: 'Second task' });
  await chat.until(history => text(history.at(-1)) === 'Second answer.');
  const forkPoint = await answer(chat, 'Second answer.');
  await Bun.sleep(5);
  const late = await sideChat(chat, 'prompt', '/btw');
  // A subagent of an earlier side chat, made after the fork point, stays out of the fork too.
  await agents.daemon.invoke('start_pi', { runtimeId: 'nested-' + mode, clientId: 'laptop', cwd: kept.cwd, sessionPath: kept.sessionPath });
  await agents.daemon.invoke('pi_command', { runtimeId: 'nested-' + mode, command: { type: 'prompt', message: 'Nested help ' + mode } });
  let nested: any;
  for (let tries = 0; !nested && tries < 300; tries++, await Bun.sleep(100)) nested = (await sessions()).find((session: any) => session.auxiliaryParentId === kept.sessionId);
  expect(nested).toMatchObject({ auxiliaryKind: 'subagent' });

  const forked = await chat.command({ type: mode, entryId: forkPoint.id });
  const forkId = forked.state.sessionId;
  const listed = await sessions();
  const copies = listed.filter((session: any) => session.auxiliaryParentId === forkId);
  expect(copies.map((session: any) => [session.auxiliaryKind, session.name]).sort()).toEqual([['btw', kept.name], ['review', 'Review the lexer'], ['subagent', 'Subagent: Helper']]);
  const original = (sessionId: string) => listed.find((session: any) => session.id === sessionId);
  for (const source of [kept, review, late]) expect(original(source.sessionId)).toMatchObject({ auxiliaryParentId: chat.sessionId });
  expect(copies.some((session: any) => [kept.sessionId, review.sessionId, late.sessionId, archived.sessionId].includes(session.id))).toBe(false);
  if (mode === 'fork_after') for (const copy of copies) expect(copy.cwd).toBe(forked.state.cwd);
  const btwCopy = copies.find((session: any) => session.auxiliaryKind === 'btw');
  expect(listed.filter((session: any) => session.auxiliaryParentId === btwCopy.id)).toEqual([]);

  // The fork's review row names the copy, owned by the fork.
  const reviewCopy = copies.find((session: any) => session.auxiliaryKind === 'review');
  const link = (await chat.command({ type: 'get_entries' })).entries.find((entry: any) => entry.customType === 'piop-review-link');
  expect(link.details).toMatchObject({ sessionId: reviewCopy.id, parentSessionId: forkId });

  // A fork of the fork at the same answer copies the copies, which keep their creation time.
  const again = await chat.command({ type: mode, entryId: forkPoint.id });
  const second = (await sessions()).filter((session: any) => session.auxiliaryParentId === again.state.sessionId);
  expect(second.map((session: any) => session.auxiliaryKind).sort()).toEqual(['btw', 'review', 'subagent']);

  // Archiving the fork archives its copies, which needs each copy linked to the fork's saved transcript.
  await agents.daemon.invoke('archive_session', { hostId: 'local', sessionPath: listed.find((session: any) => session.id === forkId).path, terminalIds: [], clientId: 'fork-test' });
  const left = (await sessions()).map((session: any) => session.id);
  expect(copies.filter((copy: any) => left.includes(copy.id))).toEqual([]);
}, 120000);

test.concurrent('a working subagent of an idle side chat gets its task again from the fork, and its answer reaches the copied side chat', async () => {
  let nestedRequests = 0;
  const stalled = Promise.withResolvers<{ text: string }>();
  agents.scripts.set('Plan the nested retry', messages => {
    const last = text(messages.at(-1));
    if (last === 'Delegate nested') return { tool: 'spawn_subagents', arguments: { tasks: [{ nickname: 'Worker', task: 'Slow nested task' }] } };
    if (messages.at(-1)?.role === 'tool') return { text: 'Delegated.' };
    if (last.includes('Nested result.')) return { text: 'Got the nested result.' };
    return { text: last === 'Next nested step' ? 'Second nested answer.' : 'Nested main answer.' };
  });
  agents.scripts.set('Slow nested task', () => ++nestedRequests === 1 ? stalled.promise : { text: 'Nested result.' });
  const chat = await agents.rootChat({ visible: true });
  await chat.command({ type: 'prompt', message: 'Plan the nested retry' });
  await chat.until(history => text(history.at(-1)) === 'Nested main answer.');
  const side = await sideChat(chat, 'prompt', '/btw');
  await agents.daemon.invoke('start_pi', { runtimeId: 'nested-retry-side', clientId: 'laptop', cwd: side.cwd, sessionPath: side.sessionPath });
  const sideCommand = (command: any) => agents.daemon.invoke('pi_command', { runtimeId: 'nested-retry-side', command });
  await sideCommand({ type: 'prompt', message: 'Delegate nested' });
  for (let tries = 0; nestedRequests < 1 && tries < 300; tries++) await Bun.sleep(100);
  for (let tries = 0; tries < 300 && !(await sideCommand({ type: 'get_entries' })).entries.some((entry: any) => entry.type === 'message' && text(entry.message) === 'Delegated.'); tries++) await Bun.sleep(100);
  await agents.daemon.invoke('stop_pi', { runtimeId: 'nested-retry-side' }).catch(() => undefined);
  await chat.command({ type: 'prompt', message: 'Next nested step' });
  await chat.until(history => text(history.at(-1)) === 'Second nested answer.');

  try {
    const forked = await chat.command({ type: 'copy_after', entryId: (await answer(chat, 'Second nested answer.')).id });
    const sideCopy = (await sessions()).find((session: any) => session.auxiliaryParentId === forked.state.sessionId && session.auxiliaryKind === 'btw');
    expect((await sessions()).find((session: any) => session.auxiliaryParentId === sideCopy.id)).toMatchObject({ auxiliaryKind: 'subagent', name: 'Subagent: Worker' });
    // Only the fork runs; the copied side chat stays closed while its subagent works again.
    for (let tries = 0; nestedRequests < 2 && tries < 300; tries++) await Bun.sleep(100);
    expect(nestedRequests).toBe(2);
    await agents.daemon.invoke('start_pi', { runtimeId: 'nested-retry-copy', clientId: 'laptop', cwd: sideCopy.cwd, sessionPath: sideCopy.path });
    const copyResult = async () => (await agents.daemon.invoke('pi_command', { runtimeId: 'nested-retry-copy', command: { type: 'get_entries' } })).entries.some((entry: any) => entry.customType === 'piop-subagent-result' && JSON.stringify(entry).includes('Nested result.'));
    for (let tries = 0; !(await copyResult()) && tries < 300; tries++) await Bun.sleep(100);
    expect(await copyResult()).toBe(true);
  } finally { stalled.resolve({ text: 'Late nested answer.' }); }
}, 120000);

test.concurrent('a side chat that was working when its main chat was forked gets a fork error, and its copy retries the prompt', async () => {
  let sideRequests = 0;
  const stalled = Promise.withResolvers<{ text: string }>();
  agents.scripts.set('Plan the retry', messages => {
    const last = text(messages.at(-1));
    if (last === 'Long side task') return ++sideRequests === 1 ? stalled.promise : { text: 'Side done.' };
    return { text: last === 'Next main step' ? 'Second main answer.' : 'Main answer.' };
  });
  const chat = await agents.rootChat({ visible: true });
  await chat.command({ type: 'prompt', message: 'Plan the retry' });
  await chat.until(history => text(history.at(-1)) === 'Main answer.');
  const side = await sideChat(chat, 'prompt', '/btw');
  await agents.daemon.invoke('start_pi', { runtimeId: 'retry-side', clientId: 'laptop', cwd: side.cwd, sessionPath: side.sessionPath });
  await agents.daemon.invoke('pi_command', { runtimeId: 'retry-side', command: { type: 'prompt', message: 'Long side task' } });
  for (let tries = 0; sideRequests < 1 && tries < 100; tries++) await Bun.sleep(100);
  await chat.command({ type: 'prompt', message: 'Next main step' });
  await chat.until(history => text(history.at(-1)) === 'Second main answer.');

  try {
    const forked = await chat.command({ type: 'copy_after', entryId: (await answer(chat, 'Second main answer.')).id });
    const copy = (await sessions()).find((session: any) => session.auxiliaryParentId === forked.state.sessionId);
    expect(copy).toMatchObject({ auxiliaryKind: 'btw' });
    for (let tries = 0; sideRequests < 2 && tries < 300; tries++) await Bun.sleep(100);
    await agents.daemon.invoke('start_pi', { runtimeId: 'retry-copy', clientId: 'laptop', cwd: copy.cwd, sessionPath: copy.path });
    const copyHistory = async () => (await agents.daemon.invoke('pi_command', { runtimeId: 'retry-copy', command: { type: 'get_entries' } })).entries.filter((entry: any) => entry.type === 'message').map((entry: any) => entry.message);
    for (let tries = 0; !(await copyHistory()).some(message => text(message) === 'Side done.') && tries < 300; tries++) await Bun.sleep(100);
    const history = await copyHistory();
    expect(history.find(message => message.stopReason === 'error')?.errorMessage).toBe('Fork error: this chat was working when its main chat was forked. Its last prompt is sent again.');
    expect(text(history.at(-1))).toBe('Side done.');
  } finally { stalled.resolve({ text: 'Late original answer.' }); }
}, 120000);
