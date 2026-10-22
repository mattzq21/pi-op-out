import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { agentDaemon, called, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

const jobs: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of jobs.splice(0)) await close(); });

async function stoppedJob(file: string) {
  const started = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('data', () => started.resolve());
    socket.once('end', () => ended.resolve());
    socket.on('error', error => { started.reject(error); ended.reject(error); });
  });
  // Both promises can fail before the test starts waiting for them.
  void started.promise.catch(() => {}); void ended.promise.catch(() => {});
  jobs.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as { port: number };
  const within = async (promise: Promise<void>, description: string) => {
    let timer: ReturnType<typeof setTimeout>;
    try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(description)), 5000); })]); }
    finally { clearTimeout(timer!); }
  };
  return {
    // The shell and sleep both hold the connection. It ends only after both release it.
    command: `exec 3<>/dev/tcp/127.0.0.1/${port}; sleep 300 & child=$!; printf ready >&3; wait "$child"; echo done > ${file}`,
    started: () => within(started.promise, 'The shell command did not start'),
    stopped: () => within(ended.promise, 'The shell or its child is still running'),
  };
}

test('stopping a response keeps its finished text, never runs its unfinished tool call, and the next turn knows it was stopped', async () => {
  agents.scripts.set('Write and then run', messages => messages.some((message: any) => message.role === 'user' && text(message) === 'Go on')
    ? { text: 'Continued.' } : { text: 'Here is the first part.', stall: 'bash' });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Write and then run' });
  await agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === chat.runtimeId
    && payload.event?.type === 'message_update' && payload.event.assistantMessageEvent?.type === 'toolcall_delta');
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
  const job = await stoppedJob('finished.txt');
  agents.scripts.set('Run the slow job', messages => called(messages, 'bash') ? { text: 'Checked the job.' } : { tool: 'bash', arguments: { command: job.command } });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Run the slow job' });
  await job.started();
  await chat.command({ type: 'pause' });
  await chat.until(history => history.at(-1)?.role === 'assistant' && history.at(-1).stopReason === 'aborted');
  await job.stopped();
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
  const job = await stoppedJob('late.txt');
  agents.scripts.set('Archived job', messages => called(messages, 'bash')
    ? { text: 'Seen: ' + JSON.stringify(messages.slice(1).map((message: any) => [message.role, text(message)])) }
    : { tool: 'bash', arguments: { command: job.command } });
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Archived job' });
  await job.started();
  const { sessionFile } = await chat.command({ type: 'get_state' });
  await agents.daemon.invoke('archive_session', { hostId: 'local', sessionPath: sessionFile, terminalIds: [], clientId: 'laptop' });
  await job.stopped();
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

test('moving a running chat stops its worker before changing the saved directory', async () => {
  const job = await stoppedJob('moved-late.txt');
  agents.scripts.set('Busy before the move', () => ({ tool: 'bash', arguments: { command: job.command } }));
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Busy before the move' });
  await job.started();
  const { sessionFile } = await chat.command({ type: 'get_state' });
  const target = join(agents.daemon.home, 'move-target');
  mkdirSync(target);
  await agents.daemon.invoke('relocate_session', { hostId: 'local', sessionPath: sessionFile, cwd: target, clientId: 'laptop' });
  await job.stopped();
  expect(existsSync(join(chat.cwd, 'moved-late.txt'))).toBe(false);
  const moved = (await agents.daemon.invoke('list_sessions')).find((session: any) => session.id === chat.sessionId);
  expect(moved.cwd).toBe(target);
}, 60000);

test('deleting a running chat stops its worker before removing its saved data', async () => {
  const job = await stoppedJob('deleted-late.txt');
  agents.scripts.set('Busy before deletion', () => ({ tool: 'bash', arguments: { command: job.command } }));
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Busy before deletion' });
  await job.started();
  const { sessionFile } = await chat.command({ type: 'get_state' });
  await agents.daemon.invoke('delete_session', { hostId: 'local', sessionPath: sessionFile, clientId: 'laptop' });
  await job.stopped();
  expect(existsSync(join(chat.cwd, 'deleted-late.txt'))).toBe(false);
  expect(existsSync(sessionFile)).toBe(false);
  expect((await agents.daemon.invoke('list_sessions')).some((session: any) => session.id === chat.sessionId)).toBe(false);
}, 60000);
