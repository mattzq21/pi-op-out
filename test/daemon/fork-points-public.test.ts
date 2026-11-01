import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { stoppedJob } from './stopped-job';
import { agentDaemon, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

const jobs: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of jobs.splice(0)) await close(); });

const stoppedEntry = async (chat: any) => (await chat.command({ type: 'get_entries' })).entries.findLast((entry: any) => entry.message?.role === 'assistant');
const goingOn = (messages: any[]) => text(messages.at(-1)).startsWith('Go on');

async function continueIn(chat: any, prompt: string) {
  await chat.command({ type: 'prompt', message: prompt });
  await chat.until((history: any[]) => text(history.at(-1)) === 'Continued.');
  return agents.model.requests.findLast(request => text(request.messages.at(-1)) === prompt).messages.slice(1).map((message: any) => [message.role, text(message)]);
}

test('fork and branch off start from a response stopped while it wrote text', async () => {
  agents.scripts.set('Stop while writing', messages => goingOn(messages) ? { text: 'Continued.' } : { text: 'First part.', stall: 'bash' });
  const chat = await agents.rootChat({ repository: true });
  await chat.command({ type: 'prompt', message: 'Stop while writing' });
  await agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === chat.runtimeId
    && payload.event?.type === 'message_update' && payload.event.assistantMessageEvent?.type === 'toolcall_delta');
  await chat.command({ type: 'abort' });
  await chat.until(history => history.some(message => message.role === 'assistant' && message.stopReason === 'aborted'));
  const stopped = await stoppedEntry(chat);
  expect(stopped.message.content.some((part: any) => part.type === 'toolCall')).toBe(false);
  const source = await chat.command({ type: 'get_state' });

  await chat.command({ type: 'copy_after', entryId: stopped.id });
  const fork = await chat.command({ type: 'get_state' });
  expect(fork.sessionId).not.toBe(source.sessionId);
  expect(fork.forkSource).toMatchObject({ sessionId: source.sessionId, entryId: stopped.id });
  const stoppedNote = 'First part.[Response stopped by the user. Only completed content blocks are retained. Any tool calls in this response were not executed.]';
  expect(await continueIn(chat, 'Go on in the fork')).toEqual([['user', 'Stop while writing'], ['assistant', stoppedNote], ['user', 'Go on in the fork']]);

  await chat.command({ type: 'fork_after', entryId: stopped.id });
  const branch = await chat.command({ type: 'get_state' });
  expect(branch.cwd).not.toBe(fork.cwd);
  expect(await continueIn(chat, 'Go on in the branch')).toEqual([['user', 'Stop while writing'], ['assistant', stoppedNote], ['user', 'Go on in the branch']]);
}, 60000);

test('fork starts from a response stopped while its command ran', async () => {
  const job = await stoppedJob('late.txt', jobs);
  agents.scripts.set('Stop the command', messages => goingOn(messages) ? { text: 'Continued.' } : { tool: 'bash', arguments: { command: job.command } });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Stop the command' });
  await job.started();
  await chat.command({ type: 'abort' });
  await job.stopped();
  await chat.until(messages => messages.at(-1)?.role === 'assistant' && messages.at(-1).stopReason === 'aborted');
  const stopped = await stoppedEntry(chat);
  expect(stopped.message.content).toEqual([]);
  const source = await chat.command({ type: 'get_state' });
  await chat.command({ type: 'copy_after', entryId: stopped.id });
  expect((await chat.command({ type: 'get_state' })).forkSource).toMatchObject({ sessionId: source.sessionId, entryId: stopped.id });
  const seen = await continueIn(chat, 'Go on after the command');
  expect(seen[0]).toEqual(['user', 'Stop the command']);
  expect(seen.at(-1)).toEqual(['user', 'Go on after the command']);
}, 60000);

test('fork and branch off start from a compaction, with its summary and without the later turns', async () => {
  const summary = 'Summary of Remember the otter: the user likes otters.';
  agents.scripts.set('Remember the otter', messages => /context summarization assistant/.test(text(messages[0])) ? { text: summary }
    : goingOn(messages) ? { text: 'Continued.' } : { text: 'Noted: ' + text(messages.at(-1)).slice(0, 20) });
  const chat = await agents.rootChat({ repository: true });
  for (const prompt of ['Remember the otter', ...[1, 2, 3].map(fact => `Fact ${fact}: ` + 'filler words '.repeat(3000)), 'After the compaction']) {
    if (prompt === 'After the compaction') await chat.command({ type: 'compact' });
    await chat.command({ type: 'prompt', message: prompt });
    await chat.until(history => text(history.at(-1)).startsWith('Noted: ' + prompt.slice(0, 12)));
  }
  const compaction = (await chat.command({ type: 'get_entries' })).entries.find((entry: any) => entry.type === 'compaction');
  const source = await chat.command({ type: 'get_state' });
  const expectFromCompaction = (seen: string[][], prompt: string) => {
    expect(seen[0][1]).toContain(summary);
    expect(seen.some(([, content]) => content === 'Remember the otter' || content === 'After the compaction')).toBe(false);
    expect(seen.at(-1)).toEqual(['user', prompt]);
  };

  await chat.command({ type: 'copy_after', entryId: compaction.id });
  expect((await chat.command({ type: 'get_state' })).forkSource).toMatchObject({ sessionId: source.sessionId, entryId: compaction.id });
  expectFromCompaction(await continueIn(chat, 'Go on in the fork'), 'Go on in the fork');

  await chat.command({ type: 'fork_after', entryId: compaction.id });
  expectFromCompaction(await continueIn(chat, 'Go on in the branch'), 'Go on in the branch');
}, 120000);
