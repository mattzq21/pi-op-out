import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { agentDaemon, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

const uiRequests = (runtimeId: string, method: string) => agents.daemon.events.filter(event => event.payload?.runtimeId === runtimeId && event.payload.event?.type === 'extension_ui_request' && event.payload.event.method === method).map(event => event.payload.event);

/** Starts a review from chat and returns what the side pane receives. */
async function openReview(chat: Awaited<ReturnType<typeof agents.rootChat>>, command: string) {
  const before = uiRequests(chat.runtimeId, 'input').length;
  await chat.command({ type: 'follow_up', message: command });
  for (let tries = 0; tries < 100; tries++, await Bun.sleep(100)) {
    const open = uiRequests(chat.runtimeId, 'input').slice(before).find(request => request.title === '__pi_desktop_review__');
    if (open) return JSON.parse(open.placeholder);
  }
  throw new Error('The review never opened');
}

test('review findings sent to the main chat start a turn there, and only that chat\'s own reviews may send them', async () => {
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

test('/rs asks the reviewer for the given number of subagents, or a fitting number; any other count only shows how to use it', async () => {
  const chat = await agents.rootChat({ visible: true });
  for (const command of ['/rs 0', '/rs two', '/rs -1']) await chat.command({ type: 'follow_up', message: command });
  const notices = () => agents.daemon.events.filter(event => event.payload?.runtimeId === chat.runtimeId && event.payload.event?.method === 'notify').map(event => event.payload.event.message);
  for (let tries = 0; notices().length < 3 && tries < 100; tries++) await Bun.sleep(100);
  const warnings = notices();
  expect(warnings).toEqual(Array(3).fill('Usage: /rs [n] — omit n for proportionate delegation, or supply a positive integer'));
  expect(uiRequests(chat.runtimeId, 'input').filter(request => request.title === '__pi_desktop_review__')).toEqual([]);
  const review = await openReview(chat, '/rs 2');
  expect(review.task).toContain('You must spawn exactly 2 review subagents.');
  expect((await openReview(chat, '/rs')).task).toContain('choose a proportionate number of review subagents');
}, 60000);

test('a review opens a separate code review chat in the side pane, linked to the conversation and kept out of the chat list', async () => {
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
  const saved = readFileSync(review.sessionPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(saved[0]).toMatchObject({ type: 'session', id: review.sessionId });
  expect(saved.find(entry => entry.customType === 'piop-review-parent')?.data).toMatchObject({ parentSessionId: chat.sessionId, sessionId: review.sessionId });
  expect(saved.find(entry => entry.type === 'session_info')?.name).toBe('Code review');
  expect((await agents.daemon.invoke('list_sessions')).some((session: any) => session.id === review.sessionId)).toBe(false);
  const entries = (await chat.command({ type: 'get_entries' })).entries;
  expect(entries.some((entry: any) => entry.customType === 'piop-review-link' && entry.details?.sessionId === review.sessionId)).toBe(true);
}, 60000);

test('a dialog waits until a window shows the chat, then goes to that window', async () => {
  agents.scripts.set('Write the lexer', () => ({ text: 'Lexer done.' }));
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Write the lexer' });
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
