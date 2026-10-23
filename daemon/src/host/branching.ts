import { basename, isAbsolute, join } from 'node:path';
import { getProjectRepository, rememberProjectRepository } from '../project_repositories';
import * as Worktrees from '../chat_worktree_records';
import { publishBranchHistory } from '../chat_branch_operations';
import * as Registry from '../session_registry';
import { kind, text } from './json';
import { Guard, ownershipError } from './ownership';
import { argument, expandHome, readHeaderLine, sessionSpec, specIdentity, type LaunchSpec } from './protocol';
import type { Host } from './controller';
import { lockGate } from './lock_gate';
import type { Session } from './session';

const UUID = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;

interface Destination { key: string; spec: LaunchSpec; path: string; existing: boolean; cwd: string | null }

export async function switchSession(host: Host, session: Session, runtime: string, command: any): Promise<any> {
  if (!['fork', 'fork_after', 'copy_after'].includes(kind(command)) && (session.working() || !session.queue.isEmpty())) {
    throw new Error('Stop or pause the response and finish queued messages before switching');
  }
  const state = await session.execute({ type: 'get_state' });
  assertCurrent(host, session, runtime);
  if (['fork', 'fork_after', 'copy_after', 'clone'].includes(kind(command))) {
    const snapshot = await session.execute({ type: 'get_snapshot' });
    if (snapshot.state?.canFork !== true) throw new Error('Only main chats can be forked');
    assertCurrent(host, session, runtime);
    const path = typeof state?.sessionFile === 'string' && state.sessionFile ? state.sessionFile : undefined;
    if (path === undefined) throw new Error('The conversation has no session file');
    return fork(host, session, runtime, command, state, path);
  }
  const target = destination(host, session, command);
  const guard = await host.ownership().begin(target.key, session.clientId(), { path: target.existing ? target.path : null, create: !target.existing });
  try { resolveCwd(target, host, guard); } catch (error) { guard.drop(); throw error; }
  if (!guard.owned) return attachReadonly(host, session, runtime, target);
  let result: any;
  let failure: unknown;
  try { result = await openDestination(host, session, runtime, target); } catch (error) { failure = error ?? new Error('Switch failed'); }
  guard.release(host.ownership(), false);
  if (failure !== undefined) throw failure;
  return result;
}

function destination(host: Host, session: Session, command: any): Destination {
  const existing = kind(command) === 'switch_session';
  let flagName: string;
  let value: string;
  if (existing) { flagName = '--session'; value = text(command, 'sessionPath'); }
  else if (kind(command) === 'new_session') { flagName = '--session-id'; value = Registry.reserve(host.storageRoot()); }
  else throw new Error('Unknown session destination');
  if (!value) throw new Error('The conversation has no session file');
  const spec = sessionSpec(session.spec, flagName, value);
  const key = existing ? specIdentity(spec, '') : value;
  return { key, spec, path: value, existing, cwd: session.cwd };
}

function resolveCwd(target: Destination, host: Host, guard: Guard): void {
  if (!target.existing) return;
  const header = guard.saved ? guard.saved.header : JSON.parse(readHeaderLine(target.path));
  if (header?.id !== target.key) throw new Error('The destination conversation changed while switching');
  const raw = typeof header?.cwd === 'string' && header.cwd.trim() ? header.cwd : undefined;
  if (raw === undefined) throw new Error('The destination conversation has no working directory');
  const cwd = expandHome(raw, host.home);
  if (target.spec.env.PIOP_REMOTE_SESSION_CLAIMS !== undefined) target.spec.env.PIOP_SESSION_CWD = cwd;
  else target.spec.cwd = cwd;
  target.cwd = cwd;
}

async function attachReadonly(host: Host, session: Session, runtime: string, target: Destination): Promise<any> {
  const packet = structuredClone(host.attachments.get(runtime) ?? {});
  packet.spec = { program: target.spec.program, args: target.spec.args, env: target.spec.env, cwd: target.spec.cwd };
  packet.sessionKey = target.key;
  packet.cwd = target.cwd;
  host.attachments.set(runtime, packet);
  host.readonlyMap.set(runtime, { id: target.key, path: target.path });
  session.publish({ type: 'ownership_lost' }, runtime);
  host.subscriptions.delete(runtime);
  session.detachView(runtime);
  await session.finishDetach(false, false);
  await host.releaseUnused(session);
  return {};
}

async function openDestination(host: Host, session: Session, runtime: string, target: Destination): Promise<any> {
  const release = await lockGate(host.sessionGates, target.key);
  try {
    const found = host.findSession(target.key);
    if (found?.transient()) throw new Error('This conversation branch is still being prepared');
    const created = found === undefined;
    const next = found ?? await host.spawnSession({ key: target.key, spec: target.spec, timeout: session.timeout, transient: false, clientId: session.clientId(), cwd: target.cwd });
    try { return await transfer(host, session, next, runtime); }
    catch (error) {
      if (created && !next.views().length && !next.submitted() && !next.working()) await next.stop();
      throw error;
    }
  } finally { release(); }
}

function assertCurrent(host: Host, session: Session, runtime: string): void {
  if (!host.current(runtime, session)) throw new Error('The conversation changed while preparing its destination');
}

async function transfer(host: Host, session: Session, next: Session, runtime: string): Promise<any> {
  await next.execute({ type: 'get_state' });
  assertCurrent(host, session, runtime);
  if (next.closed() || next.stopping()) throw new Error('The destination conversation has stopped');
  if (session !== next) {
    const presence = session.views().find(([id]) => id === runtime)?.[1] ?? {};
    session.detachView(runtime);
    host.attachView(runtime, next, presence);
    await host.releaseUnused(session);
  }
  host.reconcile(next);
  host.remember(runtime, next);
  if (host.current(runtime, next)) next.publish({ type: 'session_switched' }, runtime);
  return {};
}

async function fork(host: Host, session: Session, runtime: string, command: any, state: any, path: string): Promise<any> {
  const pending = pendingBranches.get(session) ?? new Map<string, Promise<any>>();
  pendingBranches.set(session, pending);
  const key = JSON.stringify([runtime, kind(command), text(command, 'entryId')]);
  const existing = pending.get(key);
  if (existing) return existing;
  const operation = runFork(host, session, runtime, command, state, path);
  pending.set(key, operation);
  try { return await operation; } finally { pending.delete(key); }
}

const pendingBranches = new WeakMap<Session, Map<string, Promise<any>>>();

async function runFork(host: Host, session: Session, runtime: string, command: any, state: any, path: string): Promise<any> {
  const branch = new Branch(host, session, runtime, state, path);
  let result: any;
  let failure: unknown;
  try { result = await branch.create(command); } catch (error) { failure = error ?? new Error('Fork failed'); }
  try { await branch.cleanup(); } catch (error) { failure = new Error([failure && String(failure), 'Branch cleanup failed: ' + String(error)].filter(Boolean).join('\n')); }
  if (failure !== undefined) throw failure;
  return result;
}

class Branch {
  next: Session | null = null;
  guard: Guard | null = null;
  committed = false;
  managedId: string | null = null;
  managedPath: string | null = null;

  constructor(private host: Host, private session: Session, private runtime: string, private state: any, private path: string) {}

  async create(command: any): Promise<any> {
    const request: any = { type: 'prepare_fork', mode: kind(command) === 'copy_after' ? 'fork_after' : kind(command) };
    if (command?.entryId !== undefined) request.entryId = command.entryId;
    const branch = kind(command) === 'fork_after' ? await this.prepareManaged(text(command, 'entryId')) : await this.session.raw(request);
    const destination = validatePrepared(this.host, branch, this.state, this.path);
    const retained = (error: unknown): Error => new Error('Conversation branch was saved at ' + destination + '; its history and dependencies were retained: ' + ((error as any)?.message ?? String(error)));
    let opened: Session;
    try { opened = await this.open(branch, destination); } catch (error) { throw this.managedId ? error : retained(error); }
    try { await this.commit(opened); } catch (error) { throw this.managedId ? error : retained(error); }
    return { cancelled: false, text: branch?.text ?? null, state: { sessionId: branch?.sessionId ?? null, sessionFile: destination, cwd: branch?.cwd ?? null } };
  }

  private async prepareManaged(entryId: string): Promise<any> {
    const cwd = this.session.cwd;
    const savedRepository = cwd ? getProjectRepository(this.host.storageRoot(), cwd) : null;
    if (!cwd || !savedRepository) throw new Error('This folder is not a Git repository');
    const snapshot = await this.session.execute({ type: 'get_snapshot' });
    const entries = snapshot.history.entries;
    const selected = entries.find((entry: any) => entry.id === entryId);
    if (selected?.type !== 'message' || selected.message?.role !== 'assistant' || selected.message.stopReason !== 'stop' || selected.message.content.some((part: any) => part.type === 'toolCall')) throw new Error('Select a finished final assistant response');
    const repository = { repository: savedRepository.root, gitCommonDir: savedRepository.gitDir };
    const sessionId = Registry.reserve(this.host.storageRoot());
    this.managedId = sessionId;
    const created = await Worktrees.create({ sourceCwd: cwd, chatId: sessionId, home: this.host.home, repository }, this.host.storageRoot());
    rememberProjectRepository(this.host.storageRoot(), created.worktree, { root: created.worktree, gitDir: created.gitCommonDir });
    const result = await publishBranchHistory({ root: this.host.storageRoot(), sourcePath: this.path, sessionId, cwd: created.worktree, entries, leafId: snapshot.history.leafId, entryId, name: this.state.sessionName ? this.state.sessionName + ' (branch)' : undefined });
    this.managedPath = result.sessionPath;
    return { sessionId, sessionPath: result.sessionPath, cwd: created.worktree };
  }

  private async open(branch: any, destination: string): Promise<Session> {
    const branchId = text(branch, 'sessionId');
    const ownership = await this.host.ownership().begin(branchId, this.session.clientId(), { path: destination });
    this.guard = ownership;
    if (!ownership.owned) throw new Error(ownershipError());
    const cwd = text(branch, 'cwd') || this.session.cwd;
    const spec = sessionSpec(this.session.spec, '--session', destination);
    if (cwd) { spec.cwd = cwd; if (spec.env.PIOP_SESSION_CWD !== undefined) spec.env.PIOP_SESSION_CWD = cwd; }
    const opened = await this.host.spawnSession({ key: branchId, spec, timeout: this.session.timeout, transient: true, clientId: this.session.clientId(), cwd });
    opened.setReservedPath(destination);
    this.next = opened;
    const actual = await opened.execute({ type: 'get_state' });
    if (actual?.sessionId !== branchId || actual?.sessionFile !== destination) throw new Error('Pi did not open the prepared branch');
    return opened;
  }

  private async commit(opened: Session): Promise<void> {
    if (!this.host.current(this.runtime, this.session)) throw new Error('The conversation changed while preparing its branch');
    if (this.managedId) Worktrees.activate(this.managedId, this.host.storageRoot());
    const presence = this.session.views().find(([id]) => id === this.runtime)?.[1] ?? {};
    this.session.detachView(this.runtime);
    opened.setReservedPath(null);
    opened.makeVisible();
    this.host.attachView(this.runtime, opened, presence);
    this.committed = true;
    this.host.remember(this.runtime, opened);
    try {
      await this.session.finishDetach(false, true);
      await this.host.releaseUnused(this.session);
    } catch (error) {
      this.host.output({ type: 'diagnostic', line: 'Branch created, but source chat release failed: ' + String(error) });
    }
    this.host.reconcile(opened);
    if (this.host.current(this.runtime, opened)) opened.publish({ type: 'session_switched' }, this.runtime);
  }

  async cleanup(): Promise<void> {
    const failures: string[] = [];
    const attempt = async (operation: () => unknown | Promise<unknown>) => {
      try { await operation(); } catch (error) { failures.push(String(error)); }
    };
    if (!this.committed && this.next) {
      await attempt(() => this.next!.stop());
      this.host.forgetWorker(this.next);
    }
    const guard = this.guard;
    this.guard = null;
    await attempt(() => guard?.release(this.host.ownership(), false));
    if (!this.committed && this.managedId) {
      const id = this.managedId;
      await attempt(() => Worktrees.abandonCreation(id, this.managedPath, this.host.storageRoot()));
    }
    if (failures.length) throw new Error(failures.join('\n'));
  }

}

function validatePrepared(host: Host, branch: any, state: any, parent: string): string {
  const id = text(branch, 'sessionId');
  const path = text(branch, 'sessionPath');
  if (!UUID.test(id)) throw new Error('The prepared branch has no stable session identity');
  if (state?.sessionId === id || host.sessions.has(id)) throw new Error('The prepared branch identity is already in use');
  if (!isAbsolute(path) || !basename(path).endsWith('_' + id + '.jsonl')) throw new Error('The prepared branch path does not bind its session identity');
  const header = JSON.parse(readHeaderLine(path));
  if (header?.type !== 'session' || header?.id !== id || header?.parentSession !== parent) throw new Error('The prepared branch does not belong to its original conversation');
  if (!UUID.test(text(header, 'piopPublicationId'))) throw new Error('The prepared branch has no durable publication identity');
  return path;
}

export { argument };
