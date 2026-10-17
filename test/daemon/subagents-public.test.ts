import { afterAll, beforeAll, expect, test } from 'bun:test';
import { agentDaemon, called, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

test('a child agent\'s final answer reaches its parent, which continues with it', async () => {
  agents.scripts.set('Read the README for me', messages => {
    const last = messages.at(-1);
    if (last.role === 'user' && text(last).includes('Read the README for me')) return { tool: 'spawn_agent', arguments: { task_name: 'reader', message: 'Summarize the README' } };
    const delivered = text(last).match(/README is about \w+/);
    return { text: delivered ? 'The reader says: ' + delivered[0] : 'Waiting for the reader.' };
  });
  agents.scripts.set('Summarize the README', () => ({ text: 'The README is about cats.' }));
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Read the README for me' });
  const messages = await root.until(history => history.some(message => message.role === 'assistant' && text(message).startsWith('The reader says')));
  expect(text(messages.findLast(message => message.role === 'assistant'))).toBe('The reader says: README is about cats');
  const sessions = await agents.daemon.invoke('list_sessions');
  const child = sessions.find((session: any) => session.subagentParentId === root.sessionId);
  expect(child).toMatchObject({ name: 'Subagent: reader' });
}, 120000);

/** An agent that delegates task to a child named name, then answers with what the child delivered. */
const delegating = (name: string, task: string) => (messages: any[]) => {
  const last = messages.at(-1);
  if (!called(messages, 'spawn_agent')) return { tool: 'spawn_agent', arguments: { task_name: name, message: task } };
  const delivered = text(last).match(/Relay: [^"\\]*/);
  return { text: delivered ? delivered[0] : 'Waiting for ' + name + '.' };
};

test('a grandchild cannot start its own child, and its parents hear why', async () => {
  agents.scripts.set('Start a chain', delegating('child', 'Delegate further'));
  agents.scripts.set('Delegate further', delegating('grandchild', 'Delegate once more'));
  agents.scripts.set('Delegate once more', messages => {
    const last = messages.at(-1);
    if (!called(messages, 'spawn_agent')) return { tool: 'spawn_agent', arguments: { task_name: 'too_deep', message: 'Unreachable task' } };
    return { text: 'Relay: ' + text(last) };
  });
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Start a chain' });
  const messages = await root.until(history => text(history.at(-1)).startsWith('Relay: '));
  expect(text(messages.at(-1))).toBe('Relay: Delegation is limited to two levels: root → child → grandchild. Return your findings to the parent.');
  expect(agents.model.requests.some(request => JSON.stringify(request.messages).includes('Unreachable task') && !JSON.stringify(request.messages).includes('Delegate once more'))).toBe(false);
}, 120000);

test('a follow-up task goes to the same child, which still remembers its earlier work', async () => {
  agents.scripts.set('Use a memory helper', messages => {
    const last = text(messages.at(-1));
    if (!called(messages, 'spawn_agent')) return { tool: 'spawn_agent', arguments: { task_name: 'memory', message: 'Remember the word apple' } };
    if (last.includes('Relay: remembered') && !called(messages, 'followup_task')) return { tool: 'followup_task', arguments: { target: 'memory', message: 'Which word did I give you?' } };
    const answer = last.match(/Relay: word is \w+/);
    return { text: answer ? answer[0] : 'Waiting.' };
  });
  agents.scripts.set('Remember the word apple', messages => {
    const asked = text(messages.at(-1)).includes('Which word did I give you?');
    const remembered = JSON.stringify(messages).match(/Remember the word (\w+)/)?.[1];
    return { text: asked ? 'Relay: word is ' + remembered : 'Relay: remembered' };
  });
  const root = await agents.rootChat();
  await root.command({ type: 'prompt', message: 'Use a memory helper' });
  const messages = await root.until(history => text(history.at(-1)).startsWith('Relay: word is'));
  expect(text(messages.at(-1))).toBe('Relay: word is apple');
  const children = (await agents.daemon.invoke('list_sessions')).filter((session: any) => session.subagentParentId === root.sessionId);
  expect(children.map((child: any) => child.name)).toEqual(['Subagent: memory']);
}, 120000);

test('a child paused by a model failure is reported to its parent at once and can still take a follow-up', async () => {
  agents.scripts.set('Ask a flaky helper', messages => {
    const last = text(messages.at(-1));
    if (!called(messages, 'spawn_agent')) return { tool: 'spawn_agent', arguments: { task_name: 'flaky', message: 'Flaky task' } };
    if (last.includes('model overloaded') && !called(messages, 'followup_task')) return { tool: 'followup_task', arguments: { target: 'flaky', message: 'Try again' } };
    const answer = last.match(/Relay: \w+/);
    return { text: answer ? answer[0] : 'Waiting.' };
  });
  agents.scripts.set('Flaky task', messages => {
    if (!JSON.stringify(messages).includes('Try again')) throw new Error('model overloaded');
    return { text: 'Relay: recovered' };
  });
  const root = await agents.rootChat();
  const started = Date.now();
  await root.command({ type: 'prompt', message: 'Ask a flaky helper' });
  await root.until(history => history.some(message => message.role === 'assistant' && message.content?.some((part: any) => part.name === 'followup_task')));
  expect(Date.now() - started).toBeLessThan(30000);
  await root.until(history => text(history.at(-1)) === 'Relay: recovered');
  const rootRequests = agents.model.requests.filter(request => JSON.stringify(request.messages).includes('Ask a flaky helper'));
  expect(rootRequests.some(request => /failed[\s\S]*model overloaded/.test(JSON.stringify(request.messages.at(-1))))).toBe(true);
}, 120000);
