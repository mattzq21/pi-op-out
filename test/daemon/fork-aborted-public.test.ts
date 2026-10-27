import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { stoppedJob } from './stopped-job';
import { agentDaemon, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

const jobs: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of jobs.splice(0)) await close(); });

const stoppedEntry = async (chat: any) => (await chat.command({ type: 'get_entries' })).entries.findLast((entry: any) => entry.message?.role === 'assistant');
/** The scripted model answers "Continued." once the last message asks it to go on. */
const goingOn = (messages: any[]) => text(messages.at(-1)).startsWith('Go on');

/** Sends a prompt in the chat and returns the history the model got for it. */
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
  // The stopped response is empty. The tool call is in the response before it.
  expect(stopped.message.content).toEqual([]);
  const source = await chat.command({ type: 'get_state' });
  await chat.command({ type: 'copy_after', entryId: stopped.id });
  expect((await chat.command({ type: 'get_state' })).forkSource).toMatchObject({ sessionId: source.sessionId, entryId: stopped.id });
  const seen = await continueIn(chat, 'Go on after the command');
  expect(seen[0]).toEqual(['user', 'Stop the command']);
  expect(seen.at(-1)).toEqual(['user', 'Go on after the command']);
}, 60000);
