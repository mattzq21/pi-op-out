import { Database } from "bun:sqlite";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { agentDaemon, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

const uiRequests = (runtimeId: string, method: string, host = agents) => host.daemon.events.filter(event => event.payload?.runtimeId === runtimeId && event.payload.event?.type === 'extension_ui_request' && event.payload.event.method === method).map(event => event.payload.event);

/** Starts a review from chat and returns what the side pane receives. */
async function openReview(chat: Awaited<ReturnType<typeof agents.rootChat>>, command: string, host = agents) {
  const seen = new Set(host.daemon.events.map(event => event.payload));
  await chat.command({ type: 'follow_up', message: command });
  const opened = await host.daemon.waitEvent('pi://event', payload => !seen.has(payload) && payload.runtimeId === chat.runtimeId && payload.event?.method === 'input' && payload.event.title === '__pi_desktop_review__');
  return JSON.parse(opened.event.placeholder);
}

test.concurrent('review findings sent to the main chat start a turn there, and only that chat\'s own reviews may send them', async () => {
  agents.scripts.set('Write the lexer', messages => ({ text: text(messages.at(-1)).includes('Missing EOF token') ? 'Fixed the EOF token.' : 'Lexer done.' }));
  const chat = await agents.rootChat({ visible: true });
  await chat.command({ type: 'prompt', message: 'Write the lexer' });
  await chat.until(history => text(history.at(-1)) === 'Lexer done.');
  const review = await openReview(chat, '/review src/lexer.ts');

  const failure = (command: any) => chat.command(command).then(() => 'sent', (error: Error) => error.message);
  expect(await failure({ type: 'review_feedback', sessionId: crypto.randomUUID(), message: 'Missing EOF token' })).toBe('Feedback requires a review belonging to this conversation');
  expect(await failure({ type: 'review_feedback', sessionId: review.sessionId, message: '  ' })).toContain('Feedback requires a review');
  await chat.command({ type: 'review_feedback', sessionId: review.sessionId, message: 'Missing EOF token' });
  await chat.until(history => text(history.at(-1)) === 'Fixed the EOF token.');
  const feedback = (await chat.command({ type: 'get_entries' })).entries.filter((entry: any) => entry.customType === 'piop-review-feedback');
  expect(feedback.map((entry: any) => [entry.content, entry.details.sessionId])).toEqual([['Missing EOF token', review.sessionId]]);
}, 60000);

test.concurrent('/rs takes an optional subagent count, then an optional scope; a count that is not positive only shows how to use it', async () => {
  const chat = await agents.rootChat({ visible: true });
  for (const command of ['/rs 0', '/rs -1 src']) await chat.command({ type: 'follow_up', message: command });
  const notices = () => agents.daemon.events.filter(event => event.payload?.runtimeId === chat.runtimeId && event.payload.event?.method === 'notify').map(event => event.payload.event.message);
  for (let tries = 0; notices().length < 2 && tries < 100; tries++) await Bun.sleep(100);
  expect(notices()).toEqual(Array(2).fill('Usage: /rs [n] [scope] — n is a positive number of review subagents'));
  expect(uiRequests(chat.runtimeId, 'input').filter(request => request.title === '__pi_desktop_review__')).toEqual([]);
  const counted = await openReview(chat, '/rs 2 src/parser.ts');
  expect(counted.task).toContain('Spawn 2 review subagents.');
  expect(counted.task).toContain('src/parser.ts');
  const scoped = await openReview(chat, '/rs the lexer');
  expect(scoped.task).toContain('Spawn a proportionate number of review subagents.');
  expect(scoped.task).toContain('the lexer');
  expect((await openReview(chat, '/rs')).task).toContain('Spawn a proportionate number of review subagents.');
}, 60000);

test.concurrent('a review opens a separate code review chat in the side pane, linked to the conversation and kept out of the chat list', async () => {
  agents.scripts.set('Implement the parser', () => ({ text: 'Parser done.' }));
  const chat = await agents.rootChat({ visible: true });
  await chat.command({ type: 'prompt', message: 'Implement the parser' });
  await chat.until(history => text(history.at(-1)) === 'Parser done.');
  await chat.command({ type: 'follow_up', message: '/review src/parser.ts' });
  let open: any;
  for (let tries = 0; !open && tries < 100; tries++, await Bun.sleep(100)) open = uiRequests(chat.runtimeId, 'input').find(request => request.title === '__pi_desktop_review__');
  const review = JSON.parse(open.placeholder);
  expect(review).toMatchObject({ parentSessionId: chat.sessionId, readOnly: false });
  expect(review.task).toContain('src/parser.ts');
  await agents.daemon.invoke('start_pi', { runtimeId: 'review-fork-check', clientId: 'laptop', cwd: chat.cwd, sessionPath: review.sessionPath });
  const childCommand = (command: any) => agents.daemon.invoke('pi_command', { runtimeId: 'review-fork-check', command });
  expect((await childCommand({ type: 'get_state' })).canFork).toBe(false);
  expect((await childCommand({ type: 'get_snapshot' })).state.canFork).toBe(false);
  for (const type of ['copy_after', 'fork_after', 'fork', 'clone', 'fork_and_forget']) {
    await expect(childCommand({ type, entryId: 'any-response' })).rejects.toThrow('Only main chats can be forked');
  }

  const saved = readFileSync(review.sessionPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(saved[0]).toMatchObject({ type: 'session', id: review.sessionId });
  expect(saved.some(entry => entry.type === 'custom')).toBe(false);
  const db = new Database(join(agents.daemon.home, '.piop', 'sessions.sqlite'), { readonly: true });
  try {
    const name = db.query("SELECT entry_json FROM session_extension_state WHERE session_id=? AND state_key='piop-session-name'").get(review.sessionId) as { entry_json: string };
    expect(JSON.parse(name.entry_json).name).toBe('Code review');
    const records = db.query('SELECT entry_json FROM session_extension_records WHERE session_id=?').all(review.sessionId) as { entry_json: string }[];
    expect(records.map(row => JSON.parse(row.entry_json)).find(entry => entry.customType === 'piop-review-parent')?.data).toMatchObject({ parentSessionId: chat.sessionId, sessionId: review.sessionId });
  } finally { db.close(); }
  expect(saved.some(entry => entry.type === 'session_info')).toBe(false);
  expect((await agents.daemon.invoke('list_sessions')).some((session: any) => session.id === review.sessionId)).toBe(false);
  const entries = (await chat.command({ type: 'get_entries' })).entries;
  // The chat view opens the review from sessionId and hides it in forks by comparing parentSessionId.
  expect(entries.find((entry: any) => entry.customType === 'piop-review-link')?.details).toMatchObject({ sessionId: review.sessionId, parentSessionId: chat.sessionId });
}, 60000);

test.concurrent('a dialog waits until a window shows the chat, then goes to that window', async () => {
  agents.scripts.set('Write the hidden lexer', () => ({ text: 'Lexer done.' }));
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Write the hidden lexer' });
  await chat.until(history => text(history.at(-1)) === 'Lexer done.');
  await chat.command({ type: 'follow_up', message: '/review' });
  const dialog = () => uiRequests(chat.runtimeId, 'input').find(request => request.title === '__pi_desktop_review__');
  const linked = async () => (await chat.command({ type: 'get_entries' })).entries.some((entry: any) => entry.customType === 'piop-review-link');
  for (let tries = 0; !(await linked()) && tries < 100; tries++) await Bun.sleep(100);
  await Bun.sleep(1000);
  expect(dialog()).toBeUndefined();
  await agents.daemon.invoke('pi_presence', { runtimeId: chat.runtimeId, presence: { visible: true, focused: true } });
  for (let tries = 0; !dialog() && tries < 50; tries++) await Bun.sleep(100);
  expect(JSON.parse(dialog().placeholder).parentSessionId).toBe(chat.sessionId);
}, 60000);

test.concurrent('a review uses the built-in review prompt and the agent from Settings → Agents, and says what is wrong when the agent is missing', async () => {
  const isolated = await agentDaemon();
  const original = await isolated.daemon.invoke('load_app_settings');
  /** Saves on top of the latest settings, as the settings view does after each save. */
  const save = async (patch: any) => isolated.daemon.invoke('save_app_settings', { settings: { ...await isolated.daemon.invoke('load_app_settings'), reviewAgent: original.reviewAgent, ...patch } });
  try {
    const chat = await isolated.rootChat({ visible: true });
    const review = await openReview(chat, '/review README.md', isolated);
    expect(review.task).toMatch(/^You are the dedicated code review agent[\s\S]*\n\nReview README\.md$/);

    await save({ reviewAgent: 'no-such-agent' });
    const missing = await isolated.rootChat({ visible: true });
    const failure = (chat: any) => chat.command({ type: 'follow_up', message: '/review' }).then(() => 'sent', (error: Error) => error.message);
    expect(await failure(missing)).toContain('no-such-agent');
    expect(uiRequests(missing.runtimeId, 'input', isolated).filter(request => request.title === '__pi_desktop_review__')).toEqual([]);
  } finally { await isolated.close(); }
}, 60000);

test.concurrent('a review submitted during a reply waits for that reply and is not sent to the model', async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<{ text: string }>();
  agents.scripts.set('Prepare queued review', () => { started.resolve(); return finish.promise; });
  const chat = await agents.rootChat({ visible: true });
  await chat.command({ type: 'prompt', message: 'Prepare queued review' });
  await started.promise;
  try {
    await chat.command({ type: 'steer', message: '/review queued.ts' });
    expect(uiRequests(chat.runtimeId, 'input').some(request => request.title === '__pi_desktop_review__')).toBe(false);
  } finally { finish.resolve({ text: 'Ready for review.' }); }
  const opened = await agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === chat.runtimeId && payload.event?.title === '__pi_desktop_review__', 30000);
  expect(JSON.parse(opened.event.placeholder).task).toContain('queued.ts');
  const requests = agents.model.requests.filter(request => request.messages.some((message: any) => text(message).includes('Prepare queued review')));
  expect(requests).toHaveLength(1);
  expect(requests.some(request => request.messages.some((message: any) => text(message).includes('/review queued.ts')))).toBe(false);
}, 60000);

test.concurrent('review commands held by pause keep their follow-up behavior and run after resume', async () => {
  agents.scripts.set('Continue the previous task', () => ({ text: 'Ready for review.' }));
  const chat = await agents.rootChat({ visible: true });
  await chat.command({ type: 'pause' });
  await chat.command({ type: 'follow_up', message: '/review paused.ts' });
  const queued = await agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === chat.runtimeId && payload.event?.type === 'queue_update' && payload.event.pendingMessages?.some((item: any) => item.message === '/review paused.ts'));
  const item = queued.event.pendingMessages.find((item: any) => item.message === '/review paused.ts');
  expect(item.behavior).toBe('followUp');
  await expect(chat.command({ type: 'change_pending', id: item.id, action: 'steer' })).rejects.toThrow('only be queued as a follow-up');
  expect(uiRequests(chat.runtimeId, 'input').some(request => request.title === '__pi_desktop_review__')).toBe(false);
  await chat.command({ type: 'resume' });
  const opened = await agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === chat.runtimeId && payload.event?.title === '__pi_desktop_review__', 30000);
  expect(JSON.parse(opened.event.placeholder).task).toContain('paused.ts');
  expect(agents.model.requests.filter(request => request.messages.some((message: any) => text(message).startsWith('Continue the previous task')))).toHaveLength(1);
}, 60000);
