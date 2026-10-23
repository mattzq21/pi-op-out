import { test, expect } from 'bun:test';

/** The first n hex digits of the chat ID: the worktree folder and branch name Piop tries first. */
const short = (chatId: string, n = 4) => chatId.replaceAll('-', '').slice(0, n);
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentDaemon, text } from './agent-chats';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

test('branch copies selected history and committed files, archive restores last commit without opening the chat', async () => {
  const agents = await agentDaemon();
  try {
    const cwd = join(agents.daemon.home, 'project');
    mkdirSync(cwd);
    git(cwd, 'init');
    git(cwd, 'config', 'user.email', 'test@piop.local');
    git(cwd, 'config', 'user.name', 'Piop test');
    writeFileSync(join(cwd, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(cwd, 'tracked.txt'), 'initial');
    git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'Initial');
    agents.scripts.set('First branch question', messages => ({ text: 'Answer: ' + text(messages.at(-1)) }));
    const runtimeId = 'branch-' + randomUUID();
    await agents.daemon.invoke('start_pi', { runtimeId, clientId: 'laptop', cwd });
    const command = (command: any) => agents.daemon.invoke('pi_command', { runtimeId, command });
    await command({ type: 'set_model', provider: 'scripted', modelId: 'scripted-model' });
    const settled = async (after: number) => {
      const seen = new Set(agents.daemon.events.slice(0, after).map(e => e.payload));
      return agents.daemon.waitEvent('pi://event', p => !seen.has(p) && p.runtimeId === runtimeId && p.event?.type === 'agent_settled', 60000);
    };
    let after = agents.daemon.events.length;
    await command({ type: 'prompt', message: 'First branch question' });
    await settled(after);
    const original = await command({ type: 'get_state' });
    const first = (await command({ type: 'get_entries' })).entries.find((e: any) => e.message?.role === 'assistant');
    after = agents.daemon.events.length;
    await command({ type: 'prompt', message: 'Second question' });
    await settled(after);
    writeFileSync(join(cwd, 'tracked.txt'), 'current dirty files');
    writeFileSync(join(cwd, 'untracked.txt'), 'omit me');
    writeFileSync(join(cwd, 'staged.txt'), 'omit me');
    git(cwd, 'add', 'staged.txt');
    writeFileSync(join(cwd, 'ignored.txt'), 'omit me');
    await command({ type: 'fork_after', entryId: first.id });
    const branch = await command({ type: 'get_state' });
    expect(branch.sessionId).not.toBe(original.sessionId);
    expect(branch.cwd).toBe(join(agents.daemon.home, '.local/share/piop/worktrees', short(branch.sessionId)));
    expect(branch.forkSource).toMatchObject({ sessionId: original.sessionId, entryId: first.id });
    expect(git(branch.cwd, 'branch', '--show-current')).toBe('piop/' + short(branch.sessionId));
    // The branch has only the committed files.
    expect(readFileSync(join(branch.cwd, 'tracked.txt'), 'utf8')).toBe('initial');
    expect(existsSync(join(branch.cwd, 'untracked.txt'))).toBe(false);
    expect(existsSync(join(branch.cwd, 'staged.txt'))).toBe(false);
    expect(git(branch.cwd, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(cwd, 'untracked.txt'), 'utf8')).toBe('omit me');
    expect(existsSync(join(branch.cwd, 'ignored.txt'))).toBe(false);
    expect(git(cwd, 'status', '--porcelain')).toContain('tracked.txt');
    const history = (await command({ type: 'get_entries' })).entries.filter((e: any) => e.type === 'message' && ['user', 'assistant'].includes(e.message.role)).map((e: any) => text(e.message));
    expect(history).toEqual(['First branch question', 'Answer: First branch question']);
    after = agents.daemon.events.length;
    writeFileSync(join(branch.cwd, 'tracked.txt'), 'branch work');
    await command({ type: 'prompt', message: 'Save branch files' });
    await settled(after);
    expect(git(branch.cwd, 'log', '-1', '--format=%s')).toBe('Piop saving progress');
    const saved = git(branch.cwd, 'rev-parse', 'HEAD');
    writeFileSync(join(branch.cwd, 'tracked.txt'), 'discard after commit');
    await agents.daemon.invoke('archive_session', { sessionPath: branch.sessionFile, hostId: 'local', clientId: 'laptop', terminalIds: [] });
    expect(existsSync(branch.cwd)).toBe(false);
    expect(existsSync(cwd)).toBe(true);
    expect(git(cwd, 'rev-parse', 'refs/piop/archives/' + branch.sessionId)).toBe(saved);
    expect(git(cwd, 'branch', '--list', 'piop/' + short(branch.sessionId))).toBe('');
    const report = await agents.daemon.invoke('storage_report');
    const archived = report.hosts.flatMap((h: any) => h.archives).find((a: any) => a.sessionId === branch.sessionId || a.id === branch.sessionId);
    expect(archived).toBeTruthy();
    await agents.daemon.invoke('restore_archived_session', { sessionPath: archived.sessionPath ?? archived.path, hostId: 'local', clientId: 'laptop' });
    const restored = (await agents.daemon.invoke('list_sessions')).find((s: any) => s.id === branch.sessionId);
    expect(restored).toBeTruthy();
    expect(readFileSync(join(restored.cwd, 'tracked.txt'), 'utf8')).toBe('branch work');
    expect(git(restored.cwd, 'branch', '--show-current')).toBe('piop/' + short(branch.sessionId));
  } finally { await agents.close(); }
}, 120000);

test('non-repository chat cannot create a worktree branch', async () => {
  const agents = await agentDaemon();
  try {
    agents.scripts.set('No repository', () => ({ text: 'Finished answer' }));
    const chat = await agents.rootChat();
    await chat.command({ type: 'prompt', message: 'No repository' });
    await chat.until(messages => text(messages.at(-1)) === 'Finished answer');
    const state = await chat.command({ type: 'get_state' });
    expect(state.repository).toBeNull();
    const reply = (await chat.command({ type: 'get_entries' })).entries.find((e: any) => e.message?.role === 'assistant');
    await expect(chat.command({ type: 'fork_after', entryId: reply.id })).rejects.toThrow('not a Git repository');
    expect((await chat.command({ type: 'get_state' })).sessionId).toBe(state.sessionId);
    expect(existsSync(join(agents.daemon.home, '.local/share/piop/worktrees'))).toBe(false);
  } finally { await agents.close(); }
}, 60000);
