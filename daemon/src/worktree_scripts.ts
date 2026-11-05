import { spawn, type ChildProcess } from 'node:child_process';
import { access, constants, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as Records from '../resources/chat-worktree-records.cjs';
import { newProcessTag, PROCESS_TAG, signalProcessGroup } from './process_cleanup';

// Setup scripts and cleanup scripts of chat worktrees (docs/adr/0009-worktree-setup-and-cleanup-scripts.md).

type Kind = 'setup' | 'cleanup';

const FOLDERS: Record<Kind, string> = { setup: 'wtree-setup', cleanup: 'wtree-cleanup' };
const OUTPUT_LIMIT = 64 * 1024;
const NOTE_LIMIT = 2000;
const STOP_GRACE_MS = 5000;
const OUTPUT_DELAY_MS = 100;
const INHERITED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX', 'GIT_NAMESPACE'];

export const SETUP_MESSAGE = 'piop-worktree-setup';

export type Setup = { state: 'running' | 'succeeded' | 'failed' | 'stopped'; script?: string; reason?: string; output: string };

type Outcome = { ok: true } | { ok: false; script: string; reason: string; stopped: boolean };

type Target = { chatId: string; worktree: string; repository: string };

const children = new Set<ChildProcess>();
process.on('exit', () => { for (const child of children) if (child.pid !== undefined) signalProcessGroup(child.pid, 'SIGKILL'); });

async function folderEntries(folder: string): Promise<Array<[string, string]>> {
  let names: string[];
  try { names = await readdir(folder); }
  catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter(name => !name.startsWith('.')).map(name => [name, join(folder, name)]);
}

// The global folder and the repository folder, merged by file name. A repository file replaces a global file with the same name.
async function scripts(kind: Kind, worktree: string, root: string): Promise<Array<[string, string]>> {
  const merged = new Map([...await folderEntries(join(root, FOLDERS[kind])), ...await folderEntries(join(worktree, '.piop', FOLDERS[kind]))]);
  return [...merged].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

function tail(text: string, limit: number): string { return text.length > limit ? text.slice(text.length - limit) : text; }

class ScriptRun {
  output = '';
  private child: ChildProcess | null = null;
  private stopped = false;
  readonly done: Promise<Outcome>;

  constructor(list: Array<[string, string]>, private target: Target, private changed: () => void) {
    this.done = this.runAll(list);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const pid = this.child?.pid;
    if (pid === undefined) return;
    signalProcessGroup(pid, 'SIGTERM');
    const timer = setTimeout(() => signalProcessGroup(pid, 'SIGKILL'), STOP_GRACE_MS);
    this.child!.once('close', () => clearTimeout(timer));
  }

  private append(text: string): void {
    this.output = tail(this.output + text, OUTPUT_LIMIT);
    this.changed();
  }

  private async runAll(list: Array<[string, string]>): Promise<Outcome> {
    for (const [name, path] of list) {
      if (this.stopped) return { ok: false, script: name, reason: 'stopped by the user', stopped: true };
      const reason = await this.runOne(path);
      if (this.stopped) return { ok: false, script: name, reason: 'stopped by the user', stopped: true };
      if (reason !== null) return { ok: false, script: name, reason, stopped: false };
    }
    return { ok: true };
  }

  private async runOne(path: string): Promise<string | null> {
    try {
      if (!(await stat(path)).isFile()) return 'not a file';
      await access(path, constants.X_OK);
    } catch (error: any) { return error.code === 'EACCES' ? 'not executable' : error.message; }
    const env: Record<string, string | undefined> = { ...process.env, PIOP_REPOSITORY: this.target.repository, [PROCESS_TAG]: newProcessTag() };
    for (const name of INHERITED) delete env[name];
    return new Promise(resolve => {
      const child = spawn(path, [], { cwd: this.target.worktree, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      this.child = child;
      children.add(child);
      let failure: string | null = null;
      child.on('error', error => { failure = error.message; });
      child.stdout!.setEncoding('utf8').on('data', text => this.append(text));
      child.stderr!.setEncoding('utf8').on('data', text => this.append(text));
      child.on('close', (code, signal) => {
        children.delete(child);
        this.child = null;
        resolve(failure ?? (signal ? 'stopped by ' + signal : code === 0 ? null : 'exit code ' + code));
      });
    });
  }
}

async function start(kind: Kind, target: Target, root: string, changed: () => void): Promise<ScriptRun | Outcome> {
  let list: Array<[string, string]>;
  try { list = await scripts(kind, target.worktree, root); }
  catch (error: any) { return { ok: false, script: FOLDERS[kind], reason: error.message, stopped: false }; }
  if (!list.length) return { ok: true };
  return new ScriptRun(list, target, changed);
}

// Setup

const setups = new Map<string, { run: ScriptRun; view: Setup; done: Promise<void> }>();
const watchers = new Map<string, Set<() => void>>();

function notify(chatId: string): void { for (const watcher of [...watchers.get(chatId) ?? []]) watcher(); }

// Saves the setup in the chat worktree record. Read and write run without a break, so no other change comes between them.
function save(chatId: string, root: string, setup: Setup | null): void {
  const record = Records.read(root, chatId);
  if (record === null || (record.state !== 'preparing' && record.state !== 'active')) return;
  const { setup: _old, ...rest } = record;
  Records.replace(root, chatId, record, setup ? { ...rest, setup } : rest);
}

function finished(outcome: Outcome, output: string): Setup {
  if (outcome.ok) return { state: 'succeeded', output };
  return { state: outcome.stopped ? 'stopped' : 'failed', script: outcome.script, reason: outcome.reason, output };
}

// Starts the setup scripts of a new or restored chat worktree. Returns when they run; does nothing when there are none.
export async function startSetup(target: Target, root: string): Promise<void> {
  if (setups.has(target.chatId)) throw new Error('Worktree setup already runs for chat ' + target.chatId);
  let timer: NodeJS.Timeout | undefined;
  const changed = () => { timer ??= setTimeout(() => { timer = undefined; notify(target.chatId); }, OUTPUT_DELAY_MS); };
  const run = await start('setup', target, root, changed);
  if (!(run instanceof ScriptRun)) {
    if (!run.ok) { save(target.chatId, root, finished(run, '')); notify(target.chatId); }
    return;
  }
  const view: Setup = { state: 'running', output: '' };
  const entry = { run, view, done: Promise.resolve() };
  entry.done = run.done.then(outcome => {
    clearTimeout(timer);
    setups.delete(target.chatId);
    try { save(target.chatId, root, finished(outcome, run.output)); }
    catch (error: any) { console.error(`Could not save the worktree setup of chat ${target.chatId}: ${error?.message ?? error}`); }
    notify(target.chatId);
  });
  setups.set(target.chatId, entry);
  save(target.chatId, root, view);
  notify(target.chatId);
}

// The setup that the chat shows: running, or finished and not yet in its transcript.
export function setupView(chatId: string, root: string): Setup | null {
  const running = setups.get(chatId);
  if (running) return { ...running.view, output: running.run.output };
  return Records.read(root, chatId)?.setup ?? null;
}

export function watchSetup(chatId: string, watcher: () => void): () => void {
  let set = watchers.get(chatId);
  if (!set) { set = new Set(); watchers.set(chatId, set); }
  set.add(watcher);
  return () => {
    set.delete(watcher);
    if (!set.size && watchers.get(chatId) === set) watchers.delete(chatId);
  };
}

export async function stopSetup(chatId: string): Promise<void> {
  const running = setups.get(chatId);
  if (!running) return;
  running.run.stop();
  await running.done;
}

// The transcript has the finished setup now, so the record no longer keeps it.
export function setupRecorded(chatId: string, root: string, setup: Setup): void {
  const record = Records.read(root, chatId);
  if (!record?.setup || JSON.stringify(record.setup) !== JSON.stringify(setup)) return;
  save(chatId, root, null);
  notify(chatId);
}

// A daemon stop ended the setups that were running.
export function recoverSetups(root: string): void {
  for (const record of Records.list(root)) {
    if (record.setup?.state !== 'running' || setups.has(record.chatId)) continue;
    save(record.chatId, root, { ...record.setup, state: 'stopped', reason: 'the Piop daemon stopped' });
  }
}

export function setupMessage(setup: Setup): { customType: string; content: string; display: boolean; details: Record<string, unknown> } {
  const output = tail(setup.output, NOTE_LIMIT).trimEnd();
  const content = setup.state === 'succeeded' ? 'Worktree setup finished.'
    : `Worktree setup ${setup.state === 'stopped' ? 'stopped' : 'failed'} in script ${setup.script} (${setup.reason}).${output ? '\nLast output:\n' + output : ''}`;
  return { customType: SETUP_MESSAGE, content, display: true, details: { ...setup, contextRole: setup.state === 'succeeded' ? 'hidden' : 'system' } };
}

// Cleanup

export async function runCleanup(target: Target, root: string): Promise<void> {
  const run = await start('cleanup', target, root, () => {});
  const outcome = run instanceof ScriptRun ? await run.done : run;
  if (outcome.ok) return;
  const output = run instanceof ScriptRun ? tail(run.output, NOTE_LIMIT).trimEnd() : '';
  throw new Error(`Worktree cleanup failed in script ${outcome.script} (${outcome.reason}); worktree ${target.worktree} was kept.${output ? '\n' + output : ''}`);
}
