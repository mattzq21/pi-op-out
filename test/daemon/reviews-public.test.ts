import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { agentDaemon, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

const uiRequests = (runtimeId: string, method: string) => agents.daemon.events.filter(event => event.payload?.runtimeId === runtimeId && event.payload.event?.type === 'extension_ui_request' && event.payload.event.method === method).map(event => event.payload.event);

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
