import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDaemon, called, text } from './agent-chats';

let agents: Awaited<ReturnType<typeof agentDaemon>>;
beforeAll(async () => { agents = await agentDaemon(); }, 60000);
afterAll(async () => { await agents?.close(); });

const held = <T>() => { let release!: (value: T) => void; const promise = new Promise<T>(resolve => { release = resolve; }); return { promise, release }; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const subjects = (cwd: string) => git(cwd, 'log', '--format=%s').split('\n');
const pending = (runtimeId: string): any[] =>
  agents.daemon.events.filter(event => event.payload?.runtimeId === runtimeId && event.payload.event?.type === 'queue_update').at(-1)?.payload.event.pendingMessages ?? [];
const errors = (runtimeId: string) => agents.daemon.events.filter(event => event.payload?.runtimeId === runtimeId && event.payload.event?.type === 'extension_error').map(event => event.payload.event);

let chats = 0;
/** A new chat whose folder is a Git repository with one commit. */
async function repositoryChat() {
  const runtimeId = 'repository-' + ++chats;
  const repository = join(agents.daemon.home, runtimeId);
  mkdirSync(repository);
  git(repository, 'init', '--quiet');
  git(repository, 'config', 'user.name', 'Piop Test');
  git(repository, 'config', 'user.email', 'piop@example.com');
  writeFileSync(join(repository, 'README.md'), 'start\n');
  writeFileSync(join(repository, '.gitignore'), 'ignored.txt\n');
  git(repository, 'add', '.');
  git(repository, 'commit', '--quiet', '-m', 'initial');
  const chat = await agents.daemon.invoke('create_temporary_chat', { hostId: 'local' });
  await agents.daemon.invoke('start_pi', { runtimeId, clientId: 'laptop', cwd: repository, sessionId: chat.sessionId });
  const command = (value: any) => agents.daemon.invoke('pi_command', { runtimeId, command: value });
  await command({ type: 'set_model', provider: 'scripted', modelId: 'scripted-model' });
  const history = async () => (await command({ type: 'get_entries' })).entries.filter((entry: any) => entry.type === 'message').map((entry: any) => entry.message);
  const until = async (check: (messages: any[]) => boolean) => {
    for (const deadline = Date.now() + 60000; Date.now() < deadline; await Bun.sleep(100)) { const messages = await history(); if (check(messages)) return messages; }
    throw new Error('Chat never reached the expected state: ' + JSON.stringify(await history()).slice(-2000));
  };
  return { repository, runtimeId, command, until };
}

test.concurrent('the final response is committed before a waiting follow-up starts, and tool turns are not committed', async () => {
  const answer = held<{ text: string }>();
  const seen: Record<string, string[]> = {};
  const chat = await repositoryChat();
  agents.scripts.set('Build the feature', messages => {
    const last = text(messages.at(-1));
    if (last === 'Check the commit') {
      seen.followUp = subjects(chat.repository);
      seen.files = git(chat.repository, 'show', '--name-only', '--format=', 'HEAD').split('\n');
      return { text: 'Checked.' };
    }
    if (!called(messages, 'bash')) return { tool: 'bash', arguments: { command: 'echo one > one.txt; echo secret > ignored.txt' } };
    seen.afterTool = subjects(chat.repository);
    return answer.promise;
  });
  await chat.command({ type: 'prompt', message: 'Build the feature' });
  await chat.until(() => seen.afterTool !== undefined);
  await chat.command({ type: 'follow_up', message: 'Check the commit' });
  for (let tries = 0; pending(chat.runtimeId).length < 1 && tries < 50; tries++) await Bun.sleep(100);
  expect(pending(chat.runtimeId).map(item => item.message)).toEqual(['Check the commit']);
  answer.release({ text: 'Built.' });
  await chat.until(messages => text(messages.at(-1)) === 'Checked.');

  expect(seen.afterTool).toEqual(['initial']);
  expect(seen.followUp).toEqual(['Piop saving progress', 'initial']);
  expect(seen.files).toEqual(['one.txt']);
  // The second final response changed nothing, so it adds no commit.
  await agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === chat.runtimeId && payload.event?.type === 'agent_settled');
  expect(subjects(chat.repository)).toEqual(['Piop saving progress', 'initial']);
  expect(git(chat.repository, 'status', '--porcelain', '--ignored')).toBe('!! ignored.txt');
  expect(errors(chat.runtimeId)).toEqual([]);
}, 60000);

test.concurrent('a failed save goes back to Pi as the hook error, shows once in the chat, and the next message still runs', async () => {
  const chat = await repositoryChat();
  agents.scripts.set('Break the save', messages => {
    if (text(messages.at(-1)) === 'Continue anyway') return { text: 'Continued.' };
    if (!called(messages, 'bash')) return { tool: 'bash', arguments: { command: 'echo two > two.txt; touch .git/index.lock' } };
    return { text: 'Wrote it.' };
  });
  await chat.command({ type: 'prompt', message: 'Break the save' });
  await chat.until(messages => text(messages.at(-1)) === 'Wrote it.');
  for (let tries = 0; errors(chat.runtimeId).length === 0 && tries < 100; tries++) await Bun.sleep(100);
  const [failure, ...rest] = errors(chat.runtimeId);
  expect(rest).toEqual([]);
  expect(failure.event).toBe('turn_end');
  // Pi itself reported the error, so the daemon's rejection reached Pi's turn_end hook.
  expect(failure.extensionPath).toContain('hooks-extended');
  expect(failure.error).toContain('index.lock');
  expect(subjects(chat.repository)).toEqual(['initial']);
  await chat.command({ type: 'prompt', message: 'Continue anyway' });
  await chat.until(messages => text(messages.at(-1)) === 'Continued.');
}, 60000);

test.concurrent('a chat outside a Git repository finishes its response without saving', async () => {
  agents.scripts.set('Plain chat', () => ({ text: 'Plain answer.' }));
  const chat = await agents.rootChat();
  await chat.command({ type: 'prompt', message: 'Plain chat' });
  await chat.until(messages => text(messages.at(-1)) === 'Plain answer.');
  await agents.daemon.waitEvent('pi://event', payload => payload.runtimeId === chat.runtimeId && payload.event?.type === 'agent_settled');
  expect(errors(chat.runtimeId)).toEqual([]);
}, 60000);
