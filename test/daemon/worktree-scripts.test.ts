import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, type TestDaemon } from './harness';
import { agentDaemon, gitRepository, text } from './agent-chats';
import * as Git from '../../daemon/src/worktrees';
import * as Records from '../../daemon/src/worktrees/records';
import { setupView, watchSetup } from '../../daemon/src/worktrees';
import { rememberProjectRepository } from '../../daemon/src/projects';

const daemons: TestDaemon[] = [];
afterEach(async () => { for (const daemon of daemons.splice(0)) await daemon.stop(); }, 60000);

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function script(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
}

function publish(home: string, cwd: string): { id: string; path: string } {
  return JSON.parse(execFileSync('node', [fileURLToPath(new URL('../fixtures/publish-chat.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ home, cwd, content: JSON.stringify({ type: 'message', id: 'question', parentId: null, message: { role: 'user', content: 'Worktree chat' } }) + '\n' }),
  }));
}

function finishedSetup(chatId: string, profile: string): Promise<any> {
  return new Promise(resolve => {
    const check = () => { const setup = setupView(chatId, profile); if (setup && setup.state !== 'running') { stop(); resolve(setup); } };
    const stop = watchSetup(chatId, check);
    check();
  });
}

test('setup merges the global and repository folders by name, runs them in name order and stops at the first failure', async () => {
  const daemon = await startDaemon();
  daemons.push(daemon);
  const profile = join(daemon.home, '.piop');
  const repo = realpathSync(gitRepository(join(daemon.home, 'project')));
  const log = join(daemon.home, 'setup.log');
  script(join(profile, 'worktree-setup', '10-global'), `echo global >> ${log}`);
  script(join(profile, 'worktree-setup', '20-shared'), `echo replaced global >> ${log}`);
  script(join(repo, '.piop', 'worktree-setup', '20-shared'), `echo "repository $PIOP_REPOSITORY $(pwd)" >> ${log}`);
  script(join(repo, '.piop', 'worktree-setup', '30-broken'), 'echo missing dependency; exit 3');
  script(join(repo, '.piop', 'worktree-setup', '40-late'), `echo late >> ${log}`);
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'scripts');
  const chat = publish(daemon.home, repo);
  const repository = (await Git.detectRepository(repo))!;
  const { worktree } = await Records.create({ sourceCwd: repo, chatId: chat.id, home: daemon.home, repository }, profile);
  const setup = await finishedSetup(chat.id, profile);
  expect(setup).toMatchObject({ state: 'failed', script: '30-broken', reason: 'exit code 3' });
  expect(setup.output).toContain('missing dependency');
  expect(readFileSync(log, 'utf8')).toBe(`global\nrepository ${repo} ${worktree}\n`);
  expect(Records.read(chat.id, profile)?.setup).toEqual(setup);
}, 120000);

test('archive runs cleanup before its snapshot, a failed cleanup keeps the chat and its worktree, and unarchive runs setup', async () => {
  const daemon = await startDaemon();
  daemons.push(daemon);
  const home = daemon.home;
  const profile = join(home, '.piop');
  const repo = realpathSync(gitRepository(join(home, 'project')));
  const chat = publish(home, repo);
  const repository = (await Git.detectRepository(repo))!;
  const { worktree } = await Records.create({ sourceCwd: repo, chatId: chat.id, home, repository }, profile);
  rememberProjectRepository(profile, worktree, { root: worktree, gitDir: repository.gitCommonDir });
  Records.activate(chat.id, profile);
  await daemon.invoke('relocate_session', { hostId: 'local', sessionPath: chat.path, cwd: worktree, clientId: 'scripts-test' });
  script(join(profile, 'worktree-cleanup', '10-release'), '[ -e block ] && { echo still in use; exit 1; }; rm -f cache.txt');
  script(join(profile, 'worktree-setup', '10-prepare'), 'echo prepared > prepared.txt');
  writeFileSync(join(worktree, 'cache.txt'), 'made by setup');
  writeFileSync(join(worktree, 'notes.txt'), 'user work');
  writeFileSync(join(worktree, 'block'), '');
  const archive = () => daemon.invoke('archive_session', { hostId: 'local', sessionId: chat.id, terminalIds: [], clientId: 'scripts-test' });

  await expect(archive()).rejects.toThrow('Worktree cleanup failed in script 10-release (exit code 1)');
  expect(existsSync(join(worktree, 'cache.txt'))).toBe(true);
  expect(Records.read(chat.id, profile)?.state).toBe('active');
  expect((await daemon.invoke('list_sessions')).some((row: any) => row.id === chat.id)).toBe(true);

  rmSync(join(worktree, 'block'));
  await archive();
  expect(existsSync(worktree)).toBe(false);
  const snapshot = Records.archiveRef(chat.id);
  expect(git(repo, 'show', snapshot + ':notes.txt')).toBe('user work');
  expect(() => git(repo, 'show', snapshot + ':cache.txt')).toThrow();

  await daemon.invoke('restore_session', { hostId: 'local', sessionId: chat.id, clientId: 'scripts-test' });
  for (let tries = 0; !existsSync(join(worktree, 'prepared.txt')) && tries < 100; tries++) await Bun.sleep(100);
  expect(readFileSync(join(worktree, 'prepared.txt'), 'utf8')).toBe('prepared\n');
}, 120000);

test('a new worktree chat holds its first message until setup ends, then tells the agent why setup failed', async () => {
  const agents = await agentDaemon();
  try {
    const repo = realpathSync(gitRepository(join(agents.daemon.home, 'project')));
    script(join(repo, '.piop', 'worktree-setup', '10-wait'), 'while [ ! -e "$PIOP_REPOSITORY/go" ]; do sleep 0.1; done; echo broken dependency; exit 2');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'setup');
    const requests: any[][] = [];
    agents.scripts.set('Build it', messages => { requests.push(messages); return { text: 'Built.' }; });
    const runtimeId = 'setup-chat';
    const started = await agents.daemon.invoke('start_pi', { runtimeId, clientId: 'laptop', cwd: repo, baseBranch: git(repo, 'branch', '--show-current') });
    const command = (value: any) => agents.daemon.invoke('pi_command', { runtimeId, command: value });
    await command({ type: 'set_model', provider: 'scripted', modelId: 'scripted-model' });
    await command({ type: 'prompt', message: 'Build it' });
    await Bun.sleep(1500);
    expect(requests).toEqual([]);
    expect(started.cwd).not.toBe(repo);

    writeFileSync(join(repo, 'go'), '');
    for (let tries = 0; !requests.length && tries < 200; tries++) await Bun.sleep(100);
    const sent = requests[0].map(text);
    const note = sent.findIndex(content => content.includes('Worktree setup failed in script 10-wait (exit code 2)'));
    expect(note).toBeGreaterThanOrEqual(0);
    expect(sent[note]).toContain('broken dependency');
    expect(sent.indexOf('Build it')).toBeGreaterThan(note);
    const entries = (await command({ type: 'get_entries' })).entries;
    expect(entries.some((entry: any) => entry.type === 'custom_message' && entry.customType === 'piop-worktree-setup' && entry.details.state === 'failed')).toBe(true);
  } finally { await agents.close(); }
}, 120000);

test('the user can stop a running setup, and the waiting message is then sent', async () => {
  const agents = await agentDaemon();
  try {
    const repo = realpathSync(gitRepository(join(agents.daemon.home, 'project')));
    script(join(repo, '.piop', 'worktree-setup', '10-hang'), 'echo installing; exec sleep 600');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'setup');
    const requests: any[][] = [];
    agents.scripts.set('Start work', messages => { requests.push(messages); return { text: 'Started.' }; });
    const runtimeId = 'stopped-setup-chat';
    await agents.daemon.invoke('start_pi', { runtimeId, clientId: 'laptop', cwd: repo, baseBranch: git(repo, 'branch', '--show-current') });
    const command = (value: any) => agents.daemon.invoke('pi_command', { runtimeId, command: value });
    await command({ type: 'set_model', provider: 'scripted', modelId: 'scripted-model' });
    await command({ type: 'prompt', message: 'Start work' });
    await agents.daemon.waitEvent('pi://event', packet => packet.runtimeId === runtimeId && packet.event?.statusKey === 'piop-worktree-setup' && packet.event.statusText?.includes('installing'), 20000);
    expect(requests).toEqual([]);
    await command({ type: 'stop_worktree_setup' });
    for (let tries = 0; !requests.length && tries < 200; tries++) await Bun.sleep(100);
    expect(requests[0].map(text).some(content => content.includes('Worktree setup stopped in script 10-hang'))).toBe(true);
  } finally { await agents.close(); }
}, 120000);
