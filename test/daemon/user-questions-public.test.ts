import { afterAll, beforeAll, expect, test } from 'bun:test';
import { agentDaemon, called, text } from './agent-chats';
import { startDaemon } from './harness';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); await agents.enableAgentTools('request_user_input'); }, 60000);
afterAll(async () => { await agents?.close(); });

/** The question dialogs the daemon sent to this chat's window. */
const questions = (runtimeId: string) => agents.daemon.events.filter(event => event.payload?.runtimeId === runtimeId && event.payload.event?.method === 'input' && event.payload.event.title === '__piop_request_user_input__').map(event => event.payload.event);

const askAboutDatabase = (messages: any[]) => {
  const last = text(messages.at(-1));
  if (!called(messages, 'request_user_input')) return { tool: 'request_user_input', arguments: { questions: [{ title: 'Which database?', options: ['Postgres', 'SQLite'] }] } };
  if (messages.at(-1).role === 'tool') return { text: 'Asked; continuing with the schema meanwhile.' };
  return { text: last.includes('SQLite') ? 'Using SQLite.' : 'Unexpected answer: ' + last };
};

async function chatWithQuestion(key: string) {
  agents.scripts.set(key, askAboutDatabase);
  const chat = await agents.rootChat({ visible: true });
  await chat.command({ type: 'prompt', message: key });
  await chat.until(history => text(history.at(-1)).startsWith('Asked;'));
  let dialog: any;
  for (let tries = 0; !dialog && tries < 50; tries++, await Bun.sleep(100)) dialog = questions(chat.runtimeId)[0];
  return { chat, dialog };
}

test('a question from the agent reaches the window, and the answer reaches the agent as a new message', async () => {
  const { chat, dialog } = await chatWithQuestion('Set up storage');
  expect(JSON.parse(dialog.placeholder)).toEqual({ questions: [{ id: 'question_0', header: 'Question', question: 'Which database?', options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }] }] });
  await chat.command({ type: 'extension_ui_response', id: dialog.id, value: JSON.stringify({ answers: { question_0: { answers: ['SQLite'] } } }) });
  const messages = await chat.until(history => text(history.at(-1)) === 'Using SQLite.');
  expect(text(messages.findLast(message => message.role === 'user'))).toContain('SQLite');
}, 60000);

test('cancelling a question sends nothing to the agent', async () => {
  const { chat, dialog } = await chatWithQuestion('Set up caching');
  const before = (await chat.history()).length;
  await chat.command({ type: 'extension_ui_response', id: dialog.id, cancelled: true });
  await Bun.sleep(2000);
  expect((await chat.history()).length).toBe(before);
  expect((await chat.command({ type: 'get_state' })).needsInput).toBeFalsy();
}, 60000);

test('a question still waiting when the daemon restarts comes back when the chat is opened again, and the answer reaches the agent', async () => {
  const { chat } = await chatWithQuestion('Set up search');
  const first = agents.daemon;
  await first.stop();
  const second = await startDaemon({ home: first.home });
  try {
    const path = (await second.invoke('list_sessions')).find((session: any) => session.id === chat.sessionId).path;
    await second.invoke('start_pi', { runtimeId: 'reopened', clientId: 'laptop', cwd: chat.cwd, sessionPath: path, presence: { visible: true, focused: true } });
    const command = (value: any) => second.invoke('pi_command', { runtimeId: 'reopened', command: value });
    await command({ type: 'set_model', provider: 'scripted', modelId: 'scripted-model' });
    let dialog: any;
    for (let tries = 0; !dialog && tries < 100; tries++, await Bun.sleep(100)) {
      dialog = second.events.filter(event => event.payload?.runtimeId === 'reopened' && event.payload.event?.method === 'input' && event.payload.event.title === '__piop_request_user_input__').map(event => event.payload.event)[0];
    }
    expect(JSON.parse(dialog.placeholder).questions[0].question).toBe('Which database?');
    await command({ type: 'extension_ui_response', id: dialog.id, value: JSON.stringify({ answers: { question_0: { answers: ['SQLite'] } } }) });
    let last = '';
    for (let tries = 0; last !== 'Using SQLite.' && tries < 100; tries++, await Bun.sleep(100)) last = text((await command({ type: 'get_entries' })).entries.filter((entry: any) => entry.type === 'message').at(-1)?.message);
    expect(last).toBe('Using SQLite.');
  } finally { await second.stop(); }
}, 60000);
