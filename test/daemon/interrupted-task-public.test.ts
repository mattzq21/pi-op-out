import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { daemonExecutable, startDaemon, type TestDaemon } from './harness';
import { scriptedModel } from './scripted-model';
import { text } from './agent-chats';

const command = (daemon: TestDaemon, runtimeId: string, value: any) => daemon.invoke('pi_command', { runtimeId, command: value });

/** The saved messages of the chat, read from its transcript. */
async function saved(daemon: TestDaemon, sessionId: string): Promise<any[]> {
  const path = (await daemon.invoke('list_sessions')).find((session: any) => session.id === sessionId)?.path;
  if (!path) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.type === 'message' && entry.message.role !== 'system').map(entry => entry.message);
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let tries = 0; ; tries++) {
    const value = await read();
    if (done(value) || tries >= 150) return value;
    await Bun.sleep(100);
  }
}

/** Ends the daemon of home at once, as a crash does: no shutdown runs. */
async function crash(home: string): Promise<void> {
  const executable = await daemonExecutable();
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      if (!readFileSync(join('/proc', pid, 'cmdline'), 'utf8').includes(executable)) continue;
      if (!readFileSync(join('/proc', pid, 'environ'), 'utf8').split('\0').includes('HOME=' + home)) continue;
      process.kill(Number(pid), 'SIGKILL');
    } catch {}
  }
}

test('a task that a daemon stop interrupted starts again by itself after the restart', async () => {
  let started!: () => void;
  const modelStarted = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const first = await startDaemon();
  const model = await scriptedModel(first.home, request => {
    if (text(request.messages.at(-1)) === 'Long job' && ++calls === 1) { started(); return new Promise(() => {}); }
    return { text: 'Handled: ' + text(request.messages.at(-1)) };
  });
  let second: TestDaemon | undefined;
  try {
    const chat = await first.invoke('create_temporary_chat', { hostId: 'local' });
    await first.invoke('start_pi', { runtimeId: 'before', clientId: 'laptop', cwd: chat.cwd, sessionId: chat.sessionId });
    await command(first, 'before', { type: 'set_model', provider: 'scripted', modelId: 'scripted-model' });
    await command(first, 'before', { type: 'prompt', message: 'Long job' });
    await modelStarted;
    await first.stop();

    second = await startDaemon({ home: first.home });
    const messages = await until(() => saved(second!, chat.sessionId), list => text(list.at(-1)) === 'Handled: Long job');
    expect(messages.map(message => [message.role, text(message)])).toEqual([['user', 'Long job'], ['assistant', 'Handled: Long job']]);
  } finally { await second?.stop(); await first.stop(); await model.close(); }
}, 120000);

test('after a daemon crash, a tool call that was running gets an error result and the task goes on', async () => {
  let toolStarted!: () => void;
  const running = new Promise<void>(resolve => { toolStarted = resolve; });
  const first = await startDaemon();
  const model = await scriptedModel(first.home, request => {
    const last = request.messages.at(-1);
    if (last.role === 'tool') return { text: 'Seen: ' + text(last) };
    return { tool: 'bash', arguments: { command: 'sleep 600' } };
  });
  let second: TestDaemon | undefined;
  try {
    const chat = await first.invoke('create_temporary_chat', { hostId: 'local' });
    await first.invoke('start_pi', { runtimeId: 'before', clientId: 'laptop', cwd: chat.cwd, sessionId: chat.sessionId });
    await command(first, 'before', { type: 'set_model', provider: 'scripted', modelId: 'scripted-model' });
    void first.waitEvent('pi://event', payload => payload.runtimeId === 'before' && payload.event?.type === 'tool_execution_start', 30_000).then(() => toolStarted());
    await command(first, 'before', { type: 'prompt', message: 'Run it' });
    await running;
    await crash(first.home);

    second = await startDaemon({ home: first.home });
    const messages = await until(() => saved(second!, chat.sessionId), list => text(list.at(-1)).startsWith('Seen: '));
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
    expect(messages[2].isError).toBe(true);
    expect(text(messages[3])).toContain('The Piop daemon stopped before this tool call finished');
  } finally { await second?.stop(); await model.close(); }
}, 120000);
