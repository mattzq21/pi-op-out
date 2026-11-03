import { Database } from "bun:sqlite";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { agentDaemon, called, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

const uiRequests = (runtimeId: string, method: string, host = agents) => host.daemon.events.filter(event => event.payload?.runtimeId === runtimeId && event.payload.event?.type === 'extension_ui_request' && event.payload.event.method === method).map(event => event.payload.event);

async function openReview(chat: Awaited<ReturnType<typeof agents.rootChat>>, command: string, host = agents) {
  const seen = new Set(host.daemon.events.map(event => event.payload));
  await chat.command({ type: 'follow_up', message: command });
  const opened = await host.daemon.waitEvent('pi://event', payload => !seen.has(payload) && payload.runtimeId === chat.runtimeId && payload.event?.method === 'input' && payload.event.title === '__pi_desktop_auxiliary__');
  return JSON.parse(opened.event.placeholder);
}

test.concurrent('a review chat sends its result to the reviewed chat with send_to_main, which starts a turn there', async () => {
  agents.scripts.set('Write the lexer', messages => ({ text: text(messages.at(-1)).includes('Missing EOF token') ? 'Fixed the EOF token.' : 'Lexer done.' }));
  agents.scripts.set('You are the dedicated code review agent', messages => called(messages, 'send_to_main') ? { text: 'Sent.' } : { tool: 'send_to_main', arguments: { message: 'Missing EOF token' } });
  const chat = await agents.rootChat({ visible: true });
  await agents.saveAgents(saved => saved.map((agent: any) => agent.name === 'reviewer' ? { ...agent, model: 'scripted/scripted-model' } : agent));
  await chat.command({ type: 'prompt', message: 'Write the lexer' });
  await chat.until(history => text(history.at(-1)) === 'Lexer done.');
  const review = await openReview(chat, '/review src/lexer.ts');
  await agents.daemon.invoke('start_pi', { runtimeId: 'review-sender', clientId: 'laptop', cwd: chat.cwd, sessionPath: review.sessionPath });
  const reviewCommand = (command: any) => agents.daemon.invoke('pi_command', { runtimeId: 'review-sender', command });
  await reviewCommand({ type: 'prompt', message: review.task });
  await chat.until(history => text(history.at(-1)) === 'Fixed the EOF token.');
  const request = agents.model.requests.find(request => request.messages.some((message: any) => text(message).startsWith('You are the dedicated code review agent')));
  expect(request.tools.find((tool: any) => tool.function.name === 'send_to_main')?.function.description).toBe('Send the review result to agent whose work you reviewed, when user asks');
}, 60000);

test.concurrent('a review is named by its scope; reviews without a scope are numbered', async () => {
  const chat = await agents.rootChat({ visible: true });
  const scoped = await openReview(chat, '/review the lexer');
  expect(scoped.task).toContain('the lexer');
  expect([scoped.name, (await openReview(chat, '/review')).name, (await openReview(chat, '/review')).name]).toEqual(['Review the lexer', 'Review 1', 'Review 2']);
}, 60000);

test.concurrent('a review opens a separate code review chat in the side pane, linked to the conversation and listed as its auxiliary chat', async () => {
  agents.scripts.set('Implement the parser', () => ({ text: 'Parser done.' }));
  const chat = await agents.rootChat({ visible: true });
  await chat.command({ type: 'prompt', message: 'Implement the parser' });
  await chat.until(history => text(history.at(-1)) === 'Parser done.');
  await chat.command({ type: 'follow_up', message: '/review src/parser.ts' });
  let open: any;
  for (let tries = 0; !open && tries < 100; tries++, await Bun.sleep(100)) open = uiRequests(chat.runtimeId, 'input').find(request => request.title === '__pi_desktop_auxiliary__');
  const review = JSON.parse(open.placeholder);
  expect(review).toMatchObject({ kind: 'review', name: 'Review src/parser.ts', parentSessionId: chat.sessionId });
  expect(review.task).toContain('src/parser.ts');
  await agents.daemon.invoke('start_pi', { runtimeId: 'review-fork-check', clientId: 'laptop', cwd: chat.cwd, sessionPath: review.sessionPath });
  const childCommand = (command: any) => agents.daemon.invoke('pi_command', { runtimeId: 'review-fork-check', command });
  expect((await childCommand({ type: 'get_state' })).canFork).toBe(false);
  expect((await childCommand({ type: 'get_snapshot' })).state.canFork).toBe(false);
  for (const type of ['copy_after', 'fork_after', 'fork', 'clone']) {
    await expect(childCommand({ type, entryId: 'any-response' })).rejects.toThrow('Only main chats can be forked');
  }
  await expect(childCommand({ type: 'edit_message', entryId: 'any-message', message: 'Changed' })).rejects.toThrow('Only main chats can be edited');

  const saved = readFileSync(review.sessionPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(saved[0]).toMatchObject({ type: 'session', id: review.sessionId });
  expect(saved.some(entry => entry.type === 'custom')).toBe(false);
  const db = new Database(join(agents.daemon.home, '.piop', 'sessions.sqlite'), { readonly: true });
  try {
    expect(db.query('SELECT name FROM session_names WHERE session_id=?').get(review.sessionId)).toEqual({ name: 'Review src/parser.ts' });
    const records = db.query('SELECT entry_json FROM session_extension_records WHERE session_id=?').all(review.sessionId) as { entry_json: string }[];
    expect(records.map(row => JSON.parse(row.entry_json)).find(entry => entry.customType === 'piop-auxiliary-parent')?.data).toMatchObject({ kind: 'review', parentSessionId: chat.sessionId, sessionId: review.sessionId });
  } finally { db.close(); }
  expect(saved.some(entry => entry.type === 'session_info')).toBe(false);
  expect((await agents.daemon.invoke('list_sessions')).find((session: any) => session.id === review.sessionId)).toMatchObject({ auxiliaryParentId: chat.sessionId, auxiliaryKind: 'review' });
  const entries = (await chat.command({ type: 'get_entries' })).entries;
  expect(entries.find((entry: any) => entry.customType === 'piop-review-link')?.details).toMatchObject({ sessionId: review.sessionId, parentSessionId: chat.sessionId });
}, 60000);

test.concurrent('a dialog waits until a window shows the chat, then goes to that window', async () => {
  agents.scripts.set('Write the hidden lexer', () => ({ text: 'Lexer done.' }));
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Write the hidden lexer' });
  await chat.until(history => text(history.at(-1)) === 'Lexer done.');
  await chat.command({ type: 'follow_up', message: '/review' });
  const dialog = () => uiRequests(chat.runtimeId, 'input').find(request => request.title === '__pi_desktop_auxiliary__');
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
  const save = async (patch: any) => isolated.daemon.invoke('save_app_settings', { settings: { ...await isolated.daemon.invoke('load_app_settings'), reviewAgent: original.reviewAgent, ...patch } });
  try {
    const chat = await isolated.rootChat({ visible: true });
    const review = await openReview(chat, '/review README.md', isolated);
    expect(review.task).toMatch(/^You are the dedicated code review agent[\s\S]*\n\nReview README\.md$/);

    await save({ reviewAgent: 'no-such-agent' });
    const missing = await isolated.rootChat({ visible: true });
    const failure = (chat: any) => chat.command({ type: 'follow_up', message: '/review' }).then(() => 'sent', (error: Error) => error.message);
    expect(await failure(missing)).toContain('no-such-agent');
    expect(uiRequests(missing.runtimeId, 'input', isolated).filter(request => request.title === '__pi_desktop_auxiliary__')).toEqual([]);
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
    expect(uiRequests(chat.runtimeId, 'input').some(request => request.title === '__pi_desktop_auxiliary__')).toBe(false);
  } finally { finish.resolve({ text: 'Ready for review.' }); }
  const opened = await agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === chat.runtimeId && payload.event?.title === '__pi_desktop_auxiliary__', 30000);
  expect(JSON.parse(opened.event.placeholder).task).toContain('queued.ts');
  const requests = agents.model.requests.filter(request => request.messages.some((message: any) => text(message).includes('Prepare queued review')));
  expect(requests).toHaveLength(1);
  expect(requests.some(request => request.messages.some((message: any) => text(message).includes('/review queued.ts')))).toBe(false);
}, 60000);

test.concurrent('a bare /review during a turn opens at once and links the review in the chat after the turn, without a warning', async () => {
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  agents.scripts.set('Plan the scanner', async messages => {
    if (text(messages.at(-1)) !== 'Keep scanning') return { text: 'Scanner planned.' };
    await finished;
    return { text: 'Scanning done.' };
  });
  const chat = await agents.rootChat({ visible: true });
  await chat.command({ type: 'prompt', message: 'Plan the scanner' });
  await chat.until(history => text(history.at(-1)) === 'Scanner planned.');
  await chat.command({ type: 'prompt', message: 'Keep scanning' });
  for (let tries = 0; !agents.model.requests.some(request => text(request.messages.at(-1)) === 'Keep scanning') && tries < 100; tries++) await Bun.sleep(100);

  const review = await openReview(chat, '/review');
  expect(review.name).toBe('Review 1');
  finish();
  const linked = async () => (await chat.command({ type: 'get_entries' })).entries.some((entry: any) => entry.type === 'custom_message' && entry.customType === 'piop-review-link' && entry.details?.sessionId === review.sessionId);
  for (let tries = 0; !(await linked()) && tries < 100; tries++) await Bun.sleep(100);
  expect(await linked()).toBe(true);
  await Bun.sleep(500);
  expect(uiRequests(chat.runtimeId, 'notify').map(request => request.message).filter(message => /Review/.test(message))).toEqual([]);
}, 60000);
