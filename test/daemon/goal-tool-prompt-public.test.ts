import { expect, test } from 'bun:test';
import { agentDaemon, text } from './agent-chats';
import { startDaemon } from './harness';

type Agents = Awaited<ReturnType<typeof agentDaemon>>;
type Daemon = Agents['daemon'] | Awaited<ReturnType<typeof startDaemon>>;
type Chat = { runtimeId: string; command: (value: any) => Promise<any> };

/** A daemon for goal chats. Each chat follows its script; compaction summaries name the script, so it goes on after them. */
async function goalAgents(script: string, reply: (last: string, messages: any[]) => any) {
  const agents = await agentDaemon();
  // The summary of the part of a turn that a compaction cuts off.
  agents.scripts.set('[User]: Filler: ', () => ({ text: 'Summary: filler.' }));
  agents.scripts.set(script, async messages => {
    if (/context summarization assistant/.test(text(messages[0]))) return { text: 'Summary of ' + script + '.' };
    await Bun.sleep(100);
    return reply(text(messages.at(-1)), messages) ?? { text: 'Reply to ' + text(messages.at(-1)) };
  });
  return agents;
}

/** True when the last model request that ends with message declares update_goal_status. */
const declared = (agents: Agents, message: string) => {
  const request = agents.model.requests.findLast(request => text(request.messages.at(-1)) === message);
  if (!request) throw new Error('No request ended with ' + message);
  return (request.tools ?? []).some((tool: any) => tool.function?.name === 'update_goal_status');
};

const lastText = async (chat: Chat) => text((await chat.command({ type: 'get_entries' })).entries.filter((entry: any) => entry.type === 'message').at(-1)?.message);

const until = async (chat: Chat, check: (last: string) => boolean) => {
  for (let tries = 0; tries < 300; tries++, await Bun.sleep(100)) if (check(await lastText(chat))) return;
  throw new Error('Chat never reached the expected state; last message: ' + (await lastText(chat)).slice(0, 200));
};

/** Sends message and waits for its reply. */
const ask = async (chat: Chat, message: string) => { await chat.command({ type: 'prompt', message }); await until(chat, last => last === 'Reply to ' + message); };

/** Compacts the chat. A prompt of filler first gives the compaction enough history to summarize. */
const compact = async (daemon: Daemon, chat: Chat) => {
  const compactions = () => daemon.events.filter(event => event.payload?.runtimeId === chat.runtimeId && event.payload.event?.type === 'compaction_end' && !event.payload.event.errorMessage).length;
  await chat.command({ type: 'prompt', message: 'Filler: ' + 'filler words '.repeat(12000) });
  await until(chat, last => last.startsWith('Reply to Filler'));
  const before = compactions();
  await chat.command({ type: 'compact' });
  for (let tries = 0; compactions() === before && tries < 100; tries++) await Bun.sleep(100);
  expect(compactions()).toBe(before + 1);
};

const goal = (chat: Chat, message: string) => chat.command({ type: 'follow_up', message: '/goal ' + message, goalSubmissionId: crypto.randomUUID() });

test.concurrent('update_goal_status is in the prompt only from goal creation until the first message after a compaction without a goal', async () => {
  const agents = await goalAgents('Hello there', last => last.includes('Tidy the notes') ? { tool: 'update_goal_status', arguments: { status: 'complete' } } : undefined);
  try {
    const chat = await agents.rootChat();
    await ask(chat, 'Hello there');
    expect(declared(agents, 'Hello there')).toBe(false);

    await goal(chat, 'Tidy the notes');
    await until(chat, last => last.startsWith('Reply to') && agents.model.requests.some(request => request.messages.some((message: any) => message.role === 'tool')));
    expect(agents.model.requests.some(request => text(request.messages.at(-1)).includes('Tidy the notes') && declared(agents, text(request.messages.at(-1))))).toBe(true);

    // The goal is complete, but the tool stays until a compaction, so the prompt does not change.
    await ask(chat, 'Still there');
    expect(declared(agents, 'Still there')).toBe(true);

    await compact(agents.daemon, chat);
    await ask(chat, 'After compaction');
    expect(declared(agents, 'After compaction')).toBe(false);
  } finally { await agents.close(); }
}, 120000);

test.concurrent('a goal in a held queue keeps update_goal_status in the prompt after a compaction', async () => {
  const agents = await goalAgents('Held work', () => undefined);
  try {
    const chat = await agents.rootChat();
    await goal(chat, 'Held work');
    await until(chat, last => last.startsWith('Reply to'));
    // Steering goes before the goal's next turn.
    await chat.command({ type: 'steer', message: 'Filler: ' + 'filler words '.repeat(12000) });
    await until(chat, last => last.startsWith('Reply to Filler'));
    // A stop holds the queue, so no goal turn runs during the compaction.
    await chat.command({ type: 'abort' });
    for (let tries = 0; (await chat.command({ type: 'get_state' })).isStreaming && tries < 100; tries++) await Bun.sleep(100);
    expect((await chat.command({ type: 'get_state' })).queueHeld).toBe(true);
    const compactions = () => agents.daemon.events.filter(event => event.payload?.runtimeId === chat.runtimeId && event.payload.event?.type === 'compaction_end' && !event.payload.event.errorMessage).length;
    const before = compactions();
    await chat.command({ type: 'compact' });
    for (let tries = 0; compactions() === before && tries < 100; tries++) await Bun.sleep(100);
    expect(compactions()).toBe(before + 1);
    const sent = agents.model.requests.length;
    await chat.command({ type: 'hold_queue', held: false });
    for (let tries = 0; !agents.model.requests.slice(sent).some(request => text(request.messages.at(-1)) === 'Held work') && tries < 100; tries++) await Bun.sleep(100);
    expect(declared(agents, 'Held work')).toBe(true);
    await chat.command({ type: 'abort' });
  } finally { await agents.close(); }
}, 120000);

test.concurrent('after a restart, a chat keeps update_goal_status in the prompt until a compaction', async () => {
  const agents = await goalAgents('Quick goal', last => last.includes('Quick goal') ? { tool: 'update_goal_status', arguments: { status: 'complete' } } : undefined);
  let second: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const chat = await agents.rootChat();
    await goal(chat, 'Quick goal');
    await until(chat, last => last.startsWith('Reply to') && agents.model.requests.some(request => request.messages.some((message: any) => message.role === 'tool')));
    await agents.daemon.stop();
    second = await startDaemon({ home: agents.daemon.home });
    const path = (await second.invoke('list_sessions')).find((session: any) => session.id === chat.sessionId).path;
    await second.invoke('start_pi', { runtimeId: 'reopened', clientId: 'laptop', cwd: chat.cwd, sessionPath: path });
    const reopened: Chat = { runtimeId: 'reopened', command: value => second!.invoke('pi_command', { runtimeId: 'reopened', command: value }) };
    await ask(reopened, 'Reopened');
    await ask(reopened, 'Reopened again');
    expect(declared(agents, 'Reopened again')).toBe(true);

    await compact(second, reopened);
    await ask(reopened, 'After compaction');
    expect(declared(agents, 'After compaction')).toBe(false);
  } finally { await second?.stop(); await agents.daemon.stop(); await agents.model.close(); }
}, 120000);
