import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentDaemon, called, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

test('stopping a response keeps its finished text, never runs its unfinished tool call, and the next turn knows it was stopped', async () => {
  agents.scripts.set('Write and then run', messages => messages.some((message: any) => message.role === 'user' && text(message) === 'Go on')
    ? { text: 'Continued.' } : { text: 'Here is the first part.', stall: 'bash' });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Write and then run' });
  for (let tries = 0; agents.model.requests.length === 0 && tries < 100; tries++) await Bun.sleep(100);
  await Bun.sleep(1000);
  await chat.command({ type: 'abort' });
  const stopped = await chat.until(history => history.some(message => message.role === 'assistant' && message.stopReason === 'aborted'));
  const answer = stopped.findLast(message => message.role === 'assistant');
  expect(answer.content.map((part: any) => part.type)).toEqual(['text']);
  expect(text(answer)).toBe('Here is the first part.');
  expect(stopped.some(message => message.role === 'toolResult')).toBe(false);
  expect((await chat.command({ type: 'get_state' })).isPaused).toBe(false);
  await chat.command({ type: 'prompt', message: 'Go on' });
  await chat.until(history => text(history.at(-1)) === 'Continued.');
  const next = agents.model.requests.at(-1).messages.filter((message: any) => message.role === 'assistant');
  expect(next.map(text)).toEqual(['Here is the first part.[Response stopped by the user. Only completed content blocks are retained. Any tool calls in this response were not executed.]']);
}, 60000);

test('pausing while a command runs ends the command, and resuming tells the agent the command was cut off and the run was paused', async () => {
  agents.scripts.set('Run the slow job', messages => called(messages, 'bash') ? { text: 'Checked the job.' } : { tool: 'bash', arguments: { command: 'sleep 3; echo done > finished.txt' } });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Run the slow job' });
  await chat.until(history => history.some(message => message.role === 'assistant' && message.stopReason === 'toolUse'));
  await chat.command({ type: 'pause' });
  await chat.until(history => history.at(-1)?.role === 'assistant' && history.at(-1).stopReason === 'aborted');
  await Bun.sleep(4000);
  expect(existsSync(join(chat.cwd, 'finished.txt'))).toBe(false);
  expect((await chat.command({ type: 'get_state' })).isPaused).toBe(true);
  await chat.command({ type: 'resume' });
  await chat.until(history => text(history.at(-1)) === 'Checked the job.');
  const context = agents.model.requests.at(-1).messages.slice(1).map((message: any) => [message.role, text(message)]);
  expect(context).toEqual([
    ['user', 'Run the slow job'], ['assistant', ''], ['tool', 'Command aborted'],
    ['user', 'Continue the previous task using the completed turns and tool results already in context. The last run was paused by the user. Check the current state of any interrupted work before continuing, and finish the remaining task without repeating completed work.'],
  ]);
}, 60000);

test('archiving a chat while its agent runs a command ends the command, and the restored chat goes on from where it stopped', async () => {
  agents.scripts.set('Archived job', messages => called(messages, 'bash')
    ? { text: 'Seen: ' + JSON.stringify(messages.slice(1).map((message: any) => [message.role, text(message)])) }
    : { tool: 'bash', arguments: { command: 'sleep 3; echo done > late.txt' } });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Archived job' });
  await chat.until(history => history.some(message => message.stopReason === 'toolUse'));
  const { sessionFile } = await chat.command({ type: 'get_state' });
  await agents.daemon.invoke('archive_session', { hostId: 'local', sessionPath: sessionFile, terminalIds: [], clientId: 'laptop' });
  await Bun.sleep(4000);
  expect(existsSync(join(chat.cwd, 'late.txt'))).toBe(false);
  expect(agents.model.requests.filter(request => text(request.messages[1]) === 'Archived job')).toHaveLength(1);
  const archive = (await agents.daemon.invoke('storage_report')).hosts[0].archives.find((item: any) => item.id === chat.sessionId);
  await agents.daemon.invoke('restore_archived_session', { hostId: 'local', sessionPath: archive.path, clientId: 'laptop' });
  const restored = (await agents.daemon.invoke('list_sessions')).find((session: any) => session.id === chat.sessionId);
  await agents.daemon.invoke('start_pi', { runtimeId: 'restored-job', clientId: 'laptop', cwd: restored.cwd, sessionPath: restored.path });
  await agents.daemon.invoke('pi_command', { runtimeId: 'restored-job', command: { type: 'prompt', message: 'Carry on after the restore' } });
  for (let tries = 0; !agents.model.requests.some(request => text(request.messages.at(-1)) === 'Carry on after the restore') && tries < 100; tries++) await Bun.sleep(100);
  const seen = agents.model.requests.find(request => text(request.messages.at(-1)) === 'Carry on after the restore').messages.slice(1).map((message: any) => [message.role, text(message)]);
  expect(seen).toEqual([['user', 'Archived job'], ['assistant', ''], ['tool', 'No result provided'], ['user', 'Carry on after the restore']]);
}, 60000);

test('moving a chat to another folder while its agent works is refused with what to do, and the response goes on', async () => {
  let release!: (reply: { text: string }) => void;
  const busy = new Promise<{ text: string }>(resolve => { release = resolve; });
  agents.scripts.set('Busy before the move', () => busy);
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Busy before the move' });
  await chat.until(() => agents.model.requests.some(request => text(request.messages.at(-1)) === 'Busy before the move'));
  const { sessionFile } = await chat.command({ type: 'get_state' });
  const target = join(agents.daemon.home, 'move-target');
  mkdirSync(target);
  const refusal = await agents.daemon.invoke('relocate_session', { hostId: 'local', sessionPath: sessionFile, cwd: target, clientId: 'laptop' }).then(() => 'moved', (error: Error) => error.message);
  expect(refusal).toBe('Stop the response before moving this chat to another folder.');
  release({ text: 'Finished where it was.' });
  const history = await chat.until(messages => text(messages.at(-1)) === 'Finished where it was.');
  expect(history.some(message => message.stopReason === 'aborted')).toBe(false);
}, 60000);
