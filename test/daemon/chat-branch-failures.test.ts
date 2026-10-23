import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { agentDaemon, text } from './agent-chats';

/*
 * Failure and race behaviour of "Branch from here" (fork_after) through the daemon's public commands: duplicate requests
 * make one branch, a failed branch removes everything it made, and the source chat and files never change.
 */

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trimEnd();
const worktreesRoot = (home: string) => join(home, '.local/share/piop/worktrees');
const piopBranches = (cwd: string) => git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/heads/piop').split('\n').filter(Boolean);
const worktreeFolders = (home: string) => existsSync(worktreesRoot(home)) ? readdirSync(worktreesRoot(home)) : [];

/** The first n hex digits of the chat ID: the worktree folder and branch name Piop tries first. */
const short = (chatId: string, n = 4) => chatId.replaceAll('-', '').slice(0, n);
/** Folders under the Piop worktrees folder that the project repository cache still knows. */
function cachedWorktrees(home: string): string[] {
  const database = new Database(join(home, '.piop', 'sessions.sqlite'), { readonly: true });
  try { return (database.query('SELECT cwd FROM project_repositories').all() as { cwd: string }[]).map(row => row.cwd).filter(cwd => cwd.startsWith(worktreesRoot(home) + '/')); }
  finally { database.close(); }
}

async function repositoryChat() {
  const agents = await agentDaemon();
  const cwd = join(agents.daemon.home, 'project');
  mkdirSync(cwd);
  git(cwd, 'init', '--quiet', '--initial-branch=main');
  git(cwd, 'config', 'user.email', 'test@piop.local');
  git(cwd, 'config', 'user.name', 'Piop test');
  writeFileSync(join(cwd, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(cwd, 'tracked.txt'), 'initial');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '--quiet', '-m', 'Initial');
  agents.scripts.set('Question', messages => ({ text: 'Answer: ' + text(messages.at(-1)) }));
  const runtimeId = 'branch-' + randomUUID();
  await agents.daemon.invoke('start_pi', { runtimeId, clientId: 'laptop', cwd });
  const command = (value: any) => agents.daemon.invoke('pi_command', { runtimeId, command: value });
  await command({ type: 'set_model', provider: 'scripted', modelId: 'scripted-model' });
  const ask = async (message: string) => {
    const seen = new Set(agents.daemon.events.map(event => event.payload));
    await command({ type: 'prompt', message });
    await agents.daemon.waitEvent('pi://event', p => !seen.has(p) && p.runtimeId === runtimeId && p.event?.type === 'agent_settled', 60000);
    const entries = (await command({ type: 'get_entries' })).entries;
    return entries.filter((entry: any) => entry.message?.role === 'assistant').at(-1);
  };
  return { agents, cwd, runtimeId, command, ask };
}

/** Everything about the source checkout a branch must leave alone, including the index and ignored files. */
function sourceState(cwd: string) {
  return {
    head: git(cwd, 'rev-parse', 'HEAD'),
    branch: git(cwd, 'branch', '--show-current'),
    status: git(cwd, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored'),
    index: git(cwd, 'ls-files', '--stage'),
    files: Object.fromEntries(['tracked.txt', 'untracked.txt', 'ignored.txt', 'staged.txt'].map(name => [name, existsSync(join(cwd, name)) ? readFileSync(join(cwd, name), 'utf8') : null])),
  };
}

function dirty(cwd: string): void {
  writeFileSync(join(cwd, 'tracked.txt'), 'dirty');
  writeFileSync(join(cwd, 'staged.txt'), 'staged');
  git(cwd, 'add', 'staged.txt');
  writeFileSync(join(cwd, 'untracked.txt'), 'untracked');
  writeFileSync(join(cwd, 'ignored.txt'), 'ignored');
}

const history = async (command: (value: any) => Promise<any>) => (await command({ type: 'get_entries' })).entries
  .filter((entry: any) => entry.type === 'message').map((entry: any) => entry.message.role + ':' + text(entry.message));

test('simultaneous duplicate Branch from here requests make one branch and leave the source intact', async () => {
  const { agents, cwd, command, ask } = await repositoryChat();
  try {
    const reply = await ask('Question one');
    const original = await command({ type: 'get_state' });
    const sourceHistory = await history(command);
    dirty(cwd);
    const before = sourceState(cwd);
    const sessionsBefore = (await agents.daemon.invoke('list_sessions')).length;

    const results = await Promise.allSettled([1, 2, 3].map(() => command({ type: 'fork_after', entryId: reply.id })));
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);

    const branch = await command({ type: 'get_state' });
    expect(branch.sessionId).not.toBe(original.sessionId);
    expect(worktreeFolders(agents.daemon.home)).toEqual([short(branch.sessionId)]);
    expect(piopBranches(cwd)).toEqual(['refs/heads/piop/' + short(branch.sessionId)]);
    expect(git(cwd, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length).toBe(2);
    const sessions = await agents.daemon.invoke('list_sessions');
    expect(sessions.length).toBe(sessionsBefore + 1);
    expect(sessions.filter((session: any) => session.cwd === branch.cwd).map((session: any) => session.id)).toEqual([branch.sessionId]);
    expect(sourceState(cwd)).toEqual(before);
    expect(readFileSync(original.sessionFile, 'utf8').split('\n').filter(Boolean).length).toBeGreaterThan(0);
    expect((await agents.daemon.invoke('list_sessions')).find((session: any) => session.id === original.sessionId)).toBeTruthy();
    const branchHistory = await history(command);
    expect(branchHistory).toEqual(sourceHistory);
  } finally { await agents.close(); }
}, 120000);

test('a branch that fails after its worktree exists removes the worktree, branch and chat, and leaves the source intact', async () => {
  const { agents, cwd, command, ask } = await repositoryChat();
  const original = await command({ type: 'get_state' });
  const sessionFolder = () => dirname(original.sessionFile);
  try {
    const reply = await ask('Question one');
    const state = await command({ type: 'get_state' });
    const sourceHistory = await history(command);
    dirty(cwd);
    const before = sourceState(cwd);
    const transcript = readFileSync(state.sessionFile, 'utf8');
    const sessionsBefore = (await agents.daemon.invoke('list_sessions')).map((session: any) => session.id).sort();
    // Publication writes the new transcript next to the source one. A read-only folder makes it fail after the worktree exists.
    chmodSync(dirname(state.sessionFile), 0o555);
    await expect(command({ type: 'fork_after', entryId: reply.id })).rejects.toThrow(/Could not create the branch/);
    chmodSync(dirname(state.sessionFile), 0o755);

    expect(worktreeFolders(agents.daemon.home)).toEqual([]);
    expect(piopBranches(cwd)).toEqual([]);
    expect(cachedWorktrees(agents.daemon.home)).toEqual([]);
    expect(git(cwd, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree '))).toEqual(['worktree ' + cwd]);
    expect(sourceState(cwd)).toEqual(before);
    expect((await command({ type: 'get_state' })).sessionId).toBe(state.sessionId);
    expect(await history(command)).toEqual(sourceHistory);
    expect(readFileSync(state.sessionFile, 'utf8')).toBe(transcript);
    expect((await agents.daemon.invoke('list_sessions')).map((session: any) => session.id).sort()).toEqual(sessionsBefore);
    expect(readdirSync(dirname(state.sessionFile)).filter(name => !name.includes(state.sessionId))).toEqual([]);

    // The failed attempt left nothing behind, so a retry makes a fresh, working branch.
    await command({ type: 'fork_after', entryId: reply.id });
    const branch = await command({ type: 'get_state' });
    expect(branch.sessionId).not.toBe(state.sessionId);
    expect(worktreeFolders(agents.daemon.home)).toEqual([short(branch.sessionId)]);
    expect(readFileSync(join(branch.cwd, 'tracked.txt'), 'utf8')).toBe('initial');
    expect(cachedWorktrees(agents.daemon.home)).toEqual([branch.cwd]);
  } finally {
    chmodSync(sessionFolder(), 0o755);
    await agents.close();
  }
}, 120000);

test('the first branch on a machine that fails before its worktree exists cleans up and leaves no pending work', async () => {
  const agents = await agentDaemon();
  try {
    const cwd = join(agents.daemon.home, 'project');
    mkdirSync(cwd);
    git(cwd, 'init', '--quiet', '--initial-branch=main');
    git(cwd, 'config', 'user.email', 'test@piop.local');
    git(cwd, 'config', 'user.name', 'Piop test');
    writeFileSync(join(cwd, 'tracked.txt'), 'initial');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '--quiet', '-m', 'Initial');
    agents.scripts.set('Question', messages => ({ text: 'Answer: ' + text(messages.at(-1)) }));
    const runtimeId = 'branch-' + randomUUID();
    await agents.daemon.invoke('start_pi', { runtimeId, clientId: 'laptop', cwd });
    const command = (value: any) => agents.daemon.invoke('pi_command', { runtimeId, command: value });
    await command({ type: 'set_model', provider: 'scripted', modelId: 'scripted-model' });
    const seen = new Set(agents.daemon.events.map(event => event.payload));
    await command({ type: 'prompt', message: 'Question one' });
    await agents.daemon.waitEvent('pi://event', p => !seen.has(p) && p.runtimeId === runtimeId && p.event?.type === 'agent_settled', 60000);
    const reply = (await command({ type: 'get_entries' })).entries.filter((entry: any) => entry.message?.role === 'assistant').at(-1);
    const state = await command({ type: 'get_state' });
    // A required Git filter that always fails stops the checkout of this file, so the branch fails before its worktree exists.
    git(cwd, 'config', 'filter.broken.smudge', 'false');
    git(cwd, 'config', 'filter.broken.required', 'true');
    writeFileSync(join(cwd, '.git/info/attributes'), 'tracked.txt filter=broken\n');
    const failure = await command({ type: 'fork_after', entryId: reply.id }).then(() => 'branch was created', error => String(error?.message ?? error));
    expect(failure).toContain('tracked.txt');
    expect(failure).not.toContain('cleanup failed');
    expect(failure).not.toContain('ENOENT');
    expect((await command({ type: 'get_state' })).sessionId).toBe(state.sessionId);
    expect(piopBranches(cwd)).toEqual([]);
    expect(worktreeFolders(agents.daemon.home)).toEqual([]);
    const report = await agents.daemon.invoke('storage_report');
    expect(report.hosts.find((host: any) => host.hostId === 'local').warnings.filter((line: string) => /worktree/i.test(line))).toEqual([]);
  } finally { await agents.close(); }
}, 120000);

test('a branch of a branch survives archiving its parent and restores from shared Git storage', async () => {
  const { agents, cwd, command, ask } = await repositoryChat();
  try {
    const first = await ask('Question one');
    await command({ type: 'fork_after', entryId: first.id });
    const parent = await command({ type: 'get_state' });
    writeFileSync(join(parent.cwd, 'parent.txt'), 'from parent');
    const parentReply = await ask('Question two');
    expect(git(parent.cwd, 'log', '-1', '--format=%s')).toBe('Piop saving progress');

    await command({ type: 'fork_after', entryId: parentReply.id });
    const child = await command({ type: 'get_state' });
    expect(child.cwd).toBe(join(worktreesRoot(agents.daemon.home), short(child.sessionId)));
    expect(readFileSync(join(child.cwd, 'parent.txt'), 'utf8')).toBe('from parent');
    writeFileSync(join(child.cwd, 'child.txt'), 'from child');
    await ask('Question three');
    const saved = git(child.cwd, 'rev-parse', 'HEAD');

    await agents.daemon.invoke('archive_session', { sessionPath: parent.sessionFile, hostId: 'local', clientId: 'laptop', terminalIds: [] });
    expect(existsSync(parent.cwd)).toBe(false);
    await agents.daemon.invoke('archive_session', { sessionPath: child.sessionFile, hostId: 'local', clientId: 'laptop', terminalIds: [] });
    expect(existsSync(child.cwd)).toBe(false);
    expect(git(cwd, 'rev-parse', 'refs/piop/archives/' + child.sessionId)).toBe(saved);

    const report = await agents.daemon.invoke('storage_report');
    const archived = report.hosts.flatMap((host: any) => host.archives).find((archive: any) => archive.sessionId === child.sessionId || archive.id === child.sessionId);
    await agents.daemon.invoke('restore_archived_session', { sessionPath: archived.sessionPath ?? archived.path, hostId: 'local', clientId: 'laptop' });
    const restored = (await agents.daemon.invoke('list_sessions')).find((session: any) => session.id === child.sessionId);
    expect(git(restored.cwd, 'rev-parse', 'HEAD')).toBe(saved);
    expect(readFileSync(join(restored.cwd, 'child.txt'), 'utf8')).toBe('from child');
    expect(readFileSync(join(restored.cwd, 'parent.txt'), 'utf8')).toBe('from parent');
    expect(git(cwd, 'for-each-ref', 'refs/piop/archives/' + child.sessionId)).toBe('');
  } finally { await agents.close(); }
}, 180000);
