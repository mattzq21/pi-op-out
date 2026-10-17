import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startDaemon, type TestDaemon } from './harness';
import { scriptedModel, type Reply } from './scripted-model';

let daemon: TestDaemon;
let model: Awaited<ReturnType<typeof scriptedModel>>;
/** Replies by the first message of each agent (a child gets its task as a delivered message), so every agent follows its own script. */
const scripts = new Map<string, (messages: any[]) => Reply>();
beforeAll(async () => {
  daemon = await startDaemon();
  model = await scriptedModel(daemon.home, request => {
    const first = text(request.messages.find((message: any) => message.role !== 'system' && text(message)));
    const script = [...scripts].find(([start]) => first.includes(start))?.[1];
    if (!script) throw new Error('No script for an agent that started with: ' + first.slice(0, 200));
    return script(request.messages);
  });
}, 60000);
afterAll(async () => { await model?.close(); await daemon?.stop(); });

function text(message: any): string {
  if (!message) return '';
  return typeof message.content === 'string' ? message.content : (message.content ?? []).map((part: any) => part.text ?? '').join('');
}

let runtimes = 0;
/** A new root chat that uses the scripted model. */
async function rootChat() {
  const chat = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
  const runtimeId = 'root-' + ++runtimes;
  await daemon.invoke('start_pi', { runtimeId, clientId: 'laptop', cwd: chat.cwd, sessionId: chat.sessionId });
  const command = (value: any) => daemon.invoke('pi_command', { runtimeId, command: value });
  await command({ type: 'set_model', provider: 'scripted', modelId: 'scripted-model' });
  const history = async () => (await command({ type: 'get_entries' })).entries.filter((entry: any) => entry.type === 'message').map((entry: any) => entry.message);
  /** Waits until the chat's history satisfies check. */
  const until = async (check: (messages: any[]) => boolean) => {
    for (const deadline = Date.now() + 60000; Date.now() < deadline; await Bun.sleep(100)) { const messages = await history(); if (check(messages)) return messages; }
    throw new Error('Chat never reached the expected state: ' + JSON.stringify(await history()).slice(-2000));
  };
  return { ...chat, runtimeId, command, history, until };
}

test('a child agent\'s final answer reaches its parent, which continues with it', async () => {
  scripts.set('Read the README for me', messages => {
    const last = messages.at(-1);
    if (last.role === 'user' && text(last).includes('Read the README for me')) return { tool: 'spawn_agent', arguments: { task_name: 'reader', message: 'Summarize the README' } };
    const delivered = text(last).match(/README is about \w+/);
    return { text: delivered ? 'The reader says: ' + delivered[0] : 'Waiting for the reader.' };
  });
  scripts.set('Summarize the README', () => ({ text: 'The README is about cats.' }));
  const root = await rootChat();
  await root.command({ type: 'prompt', message: 'Read the README for me' });
  const messages = await root.until(history => history.some(message => message.role === 'assistant' && text(message).startsWith('The reader says')));
  expect(text(messages.findLast(message => message.role === 'assistant'))).toBe('The reader says: README is about cats');
  const sessions = await daemon.invoke('list_sessions');
  const child = sessions.find((session: any) => session.subagentParentId === root.sessionId);
  expect(child).toMatchObject({ name: 'Subagent: reader' });
}, 120000);

const called = (messages: any[], tool: string) => messages.some(message => message.role === 'assistant' && message.tool_calls?.some((call: any) => call.function.name === tool));

/** An agent that delegates task to a child named name, then answers with what the child delivered. */
const delegating = (name: string, task: string) => (messages: any[]) => {
  const last = messages.at(-1);
  if (!called(messages, 'spawn_agent')) return { tool: 'spawn_agent', arguments: { task_name: name, message: task } };
  const delivered = text(last).match(/Relay: [^"\\]*/);
  return { text: delivered ? delivered[0] : 'Waiting for ' + name + '.' };
};

test('a grandchild cannot start its own child, and its parents hear why', async () => {
  scripts.set('Start a chain', delegating('child', 'Delegate further'));
  scripts.set('Delegate further', delegating('grandchild', 'Delegate once more'));
  scripts.set('Delegate once more', messages => {
    const last = messages.at(-1);
    if (!called(messages, 'spawn_agent')) return { tool: 'spawn_agent', arguments: { task_name: 'too_deep', message: 'Unreachable task' } };
    return { text: 'Relay: ' + text(last) };
  });
  const root = await rootChat();
  await root.command({ type: 'prompt', message: 'Start a chain' });
  const messages = await root.until(history => text(history.at(-1)).startsWith('Relay: '));
  expect(text(messages.at(-1))).toBe('Relay: Delegation is limited to two levels: root → child → grandchild. Return your findings to the parent.');
  expect(model.requests.some(request => JSON.stringify(request.messages).includes('Unreachable task') && !JSON.stringify(request.messages).includes('Delegate once more'))).toBe(false);
}, 120000);

test('a follow-up task goes to the same child, which still remembers its earlier work', async () => {
  scripts.set('Use a memory helper', messages => {
    const last = text(messages.at(-1));
    if (!called(messages, 'spawn_agent')) return { tool: 'spawn_agent', arguments: { task_name: 'memory', message: 'Remember the word apple' } };
    if (last.includes('Relay: remembered') && !called(messages, 'followup_task')) return { tool: 'followup_task', arguments: { target: 'memory', message: 'Which word did I give you?' } };
    const answer = last.match(/Relay: word is \w+/);
    return { text: answer ? answer[0] : 'Waiting.' };
  });
  scripts.set('Remember the word apple', messages => {
    const asked = text(messages.at(-1)).includes('Which word did I give you?');
    const remembered = JSON.stringify(messages).match(/Remember the word (\w+)/)?.[1];
    return { text: asked ? 'Relay: word is ' + remembered : 'Relay: remembered' };
  });
  const root = await rootChat();
  await root.command({ type: 'prompt', message: 'Use a memory helper' });
  const messages = await root.until(history => text(history.at(-1)).startsWith('Relay: word is'));
  expect(text(messages.at(-1))).toBe('Relay: word is apple');
  const children = (await daemon.invoke('list_sessions')).filter((session: any) => session.subagentParentId === root.sessionId);
  expect(children.map((child: any) => child.name)).toEqual(['Subagent: memory']);
}, 120000);

test('a child paused by a model failure is reported to its parent at once and can still take a follow-up', async () => {
  scripts.set('Ask a flaky helper', messages => {
    const last = text(messages.at(-1));
    if (!called(messages, 'spawn_agent')) return { tool: 'spawn_agent', arguments: { task_name: 'flaky', message: 'Flaky task' } };
    if (last.includes('model overloaded') && !called(messages, 'followup_task')) return { tool: 'followup_task', arguments: { target: 'flaky', message: 'Try again' } };
    const answer = last.match(/Relay: \w+/);
    return { text: answer ? answer[0] : 'Waiting.' };
  });
  scripts.set('Flaky task', messages => {
    if (!JSON.stringify(messages).includes('Try again')) throw new Error('model overloaded');
    return { text: 'Relay: recovered' };
  });
  const root = await rootChat();
  const started = Date.now();
  await root.command({ type: 'prompt', message: 'Ask a flaky helper' });
  await root.until(history => history.some(message => message.role === 'assistant' && message.content?.some((part: any) => part.name === 'followup_task')));
  expect(Date.now() - started).toBeLessThan(30000);
  await root.until(history => text(history.at(-1)) === 'Relay: recovered');
  const rootRequests = model.requests.filter(request => JSON.stringify(request.messages).includes('Ask a flaky helper'));
  expect(rootRequests.some(request => /failed[\s\S]*model overloaded/.test(JSON.stringify(request.messages.at(-1))))).toBe(true);
}, 120000);
