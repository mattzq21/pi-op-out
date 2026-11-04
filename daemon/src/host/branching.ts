import { basename, isAbsolute, join } from 'node:path';
import { getProjectRepository, rememberProjectRepository } from '../project_repositories';
import * as Worktrees from '../chat_worktree_records';
import { publishBranchHistory } from '../chat_branch_operations';
import * as Registry from '../session_registry';
import { flag, kind, text } from './json';
import { Guard, ownershipError } from './ownership';
import { argument, expandHome, parseLaunchSpec, readHeaderLine, sessionSpec, specIdentity, type LaunchSpec } from './protocol';
import type { Host } from './controller';
import { readonlyCommand, type ReadonlyView } from './readonly_views';
import type { Session } from './session';
import { forkPoint } from '../../resources/piop-storage/session-records.cjs';

const UUID = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;
const FORKS = ['fork', 'fork_after', 'copy_after', 'clone'];

interface Destination { key: string; spec: LaunchSpec; path: string; existing: boolean; cwd: string | null }

interface BranchSource {
  spec: LaunchSpec;
  timeout: number;
  clientId: string;
  owned?: Session;
  read(): Promise<{ state: any; snapshot: any; cwd: string | null }>;
  current(): boolean;
  detach(): { presence: any; session?: Session };
}

export async function switchSession(host: Host, session: Session, runtime: string, command: any): Promise<any> {
  if (FORKS.includes(kind(command))) return fork(host, runtime, ownedSource(host, session, runtime), command);
  if (session.working() || !session.queue.isEmpty()) {
    throw new Error('Stop the response and finish queued messages before switching');
  }
  await session.execute({ type: 'get_state' });
  assertCurrent(host, session, runtime);
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

export function forkFromView(host: Host, runtime: string, view: ReadonlyView, command: any): Promise<any> {
  const packet = host.views.request(runtime);
  if (packet === undefined) throw new Error('This conversation has been deleted or closed');
  if (flag(packet.presence, 'readOnly')) throw new Error('This view is read-only');
  return fork(host, runtime, viewSource(host, runtime, view, packet), command);
}

function ownedSource(host: Host, session: Session, runtime: string): BranchSource {
  return {
    spec: session.spec, timeout: session.timeout, clientId: session.clientId(), owned: session,
    read: () => readSession(session),
    current: () => host.current(runtime, session),
    detach: () => {
      const presence = session.views().find(([id]) => id === runtime)?.[1] ?? {};
      session.detachView(runtime);
      return { presence, session };
    },
  };
}

function viewSource(host: Host, runtime: string, view: ReadonlyView, packet: any): BranchSource {
  const timeout = packet.timeout;
  return {
    spec: parseLaunchSpec(packet.spec),
    timeout: typeof timeout === 'number' && Number.isInteger(timeout) && timeout >= 0 ? timeout : 630000,
    clientId: text(packet, 'clientId'),
    read: async () => {
      const running = host.findSession(view.id);
      if (running && !running.transient()) return readSession(running);
      const snapshot = await readonlyCommand(host, { type: 'get_snapshot' }, view);
      const cwd = snapshot.state?.cwd;
      return { state: snapshot.state, snapshot, cwd: typeof cwd === 'string' && cwd.trim() ? expandHome(cwd, host.home) : null };
    },
    current: () => host.views.isRequest(runtime, packet) && host.views.readonly(runtime)?.id === view.id,
    detach: () => {
      host.views.clearReadonly(runtime);
      const session = host.views.unsubscribe(runtime);
      session?.detachView(runtime);
      return { presence: structuredClone(packet.presence ?? null), session };
    },
  };
}

async function readSession(session: Session): Promise<{ state: any; snapshot: any; cwd: string | null }> {
  const state = await session.execute({ type: 'get_state' });
  const snapshot = await session.execute({ type: 'get_snapshot' });
  return { state, snapshot, cwd: session.cwd };
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
  const packet = structuredClone(host.views.request(runtime) ?? {});
  packet.spec = { program: target.spec.program, args: target.spec.args, env: target.spec.env, cwd: target.spec.cwd };
  packet.sessionKey = target.key;
  packet.cwd = target.cwd;
  host.views.setRequest(runtime, packet);
  host.views.showReadonly(runtime, { id: target.key, path: target.path });
  session.publish({ type: 'ownership_lost' }, runtime);
  host.views.unsubscribe(runtime);
  session.detachView(runtime);
  await session.finishDetach(false, false);
  await host.releaseUnused(session);
  return {};
}

async function openDestination(host: Host, session: Session, runtime: string, target: Destination): Promise<any> {
  const release = await host.lockSession(target.key);
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

async function fork(host: Host, runtime: string, source: BranchSource, command: any): Promise<any> {
  const pending = pendingBranches.get(host) ?? new Map<string, Promise<any>>();
  pendingBranches.set(host, pending);
  const key = JSON.stringify([runtime, kind(command), text(command, 'entryId')]);
  const existing = pending.get(key);
  if (existing) return existing;
  const operation = runFork(host, runtime, source, command);
  pending.set(key, operation);
  try { return await operation; } finally { pending.delete(key); }
}

const pendingBranches = new WeakMap<Host, Map<string, Promise<any>>>();

async function runFork(host: Host, runtime: string, source: BranchSource, command: any): Promise<any> {
  const read = await source.read();
  if (!source.current()) throw new Error('The conversation changed while preparing its destination');
  if (read.snapshot?.state?.canFork !== true) throw new Error('Only main chats can be forked');
  const path = typeof read.state?.sessionFile === 'string' && read.state.sessionFile ? read.state.sessionFile : undefined;
  if (path === undefined) throw new Error('The conversation has no session file');
  const branch = new Branch(host, runtime, source, read, path);
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
  worktree = false;

  constructor(private host: Host, private runtime: string, private source: BranchSource, private read: { state: any; snapshot: any; cwd: string | null }, private path: string) {}

  async create(command: any): Promise<any> {
    const mode = kind(command);
    const branch = mode === 'fork_after' || mode === 'copy_after' ? await this.publish(text(command, 'entryId'), mode === 'fork_after') : await this.prepareInPi(command);
    const destination = validatePrepared(this.host, branch, this.read.state, this.path);
    const retained = (error: unknown): Error => new Error('Conversation branch was saved at ' + destination + '; its history and dependencies were retained: ' + ((error as any)?.message ?? String(error)));
    let opened: Session;
    try { opened = await this.open(branch, destination); } catch (error) { throw this.managedId ? error : retained(error); }
    try { await this.commit(opened); } catch (error) { throw this.managedId ? error : retained(error); }
    return { cancelled: false, text: branch?.text ?? null, state: { sessionId: branch?.sessionId ?? null, sessionFile: destination, cwd: branch?.cwd ?? null } };
  }

  private prepareInPi(command: any): Promise<any> {
    if (!this.source.owned) throw new Error(ownershipError());
    const request: any = { type: 'prepare_fork', mode: kind(command) };
    if (command?.entryId !== undefined) request.entryId = command.entryId;
    return this.source.owned.raw(request);
  }

  private async publish(entryId: string, worktree: boolean): Promise<any> {
    const cwd = this.read.cwd;
    const savedRepository = worktree && cwd ? getProjectRepository(this.host.storageRoot(), cwd) : null;
    if (worktree && (!cwd || !savedRepository)) throw new Error('This folder is not a Git repository');
    if (!cwd) throw new Error('The conversation has no working directory');
    const snapshot = this.read.snapshot;
    const entries = snapshot.history.entries;
    const selected = entries.find((entry: any) => entry.id === entryId);
    if (!forkPoint(selected)) throw new Error('Select a finished or stopped final response or a compaction to branch from');
    const sessionId = Registry.reserve(this.host.storageRoot());
    this.managedId = sessionId;
    let branchCwd = cwd;
    if (savedRepository) {
      const repository = { repository: savedRepository.root, gitCommonDir: savedRepository.gitDir };
      this.worktree = true;
      const created = await Worktrees.create({ sourceCwd: cwd, chatId: sessionId, home: this.host.home, repository }, this.host.storageRoot());
      rememberProjectRepository(this.host.storageRoot(), created.worktree, { root: created.worktree, gitDir: created.gitCommonDir });
      branchCwd = created.worktree;
    }
    const result = await publishBranchHistory({ root: this.host.storageRoot(), sourcePath: this.path, sessionId, cwd: branchCwd, entries, leafId: snapshot.history.leafId, entryId, keepName: !worktree });
    this.managedPath = result.sessionPath;
    return { sessionId, sessionPath: result.sessionPath, cwd: branchCwd };
  }

  private async open(branch: any, destination: string): Promise<Session> {
    const branchId = text(branch, 'sessionId');
    const ownership = await this.host.ownership().begin(branchId, this.source.clientId, { path: destination });
    this.guard = ownership;
    if (!ownership.owned) throw new Error(ownershipError());
    const cwd = text(branch, 'cwd') || this.read.cwd;
    const spec = sessionSpec(this.source.spec, '--session', destination);
    if (cwd) { spec.cwd = cwd; if (spec.env.PIOP_SESSION_CWD !== undefined) spec.env.PIOP_SESSION_CWD = cwd; }
    const opened = await this.host.spawnSession({ key: branchId, spec, timeout: this.source.timeout, transient: true, clientId: this.source.clientId, cwd });
    opened.setReservedPath(destination);
    this.next = opened;
    const actual = await opened.execute({ type: 'get_state' });
    if (actual?.sessionId !== branchId || actual?.sessionFile !== destination) throw new Error('Pi did not open the prepared branch');
    return opened;
  }

  private async commit(opened: Session): Promise<void> {
    if (!this.source.current()) throw new Error('The conversation changed while preparing its branch');
    if (this.worktree) Worktrees.activate(this.managedId!, this.host.storageRoot());
    const { presence, session: previous } = this.source.detach();
    opened.setReservedPath(null);
    opened.makeVisible();
    this.host.attachView(this.runtime, opened, presence);
    this.committed = true;
    this.host.remember(this.runtime, opened);
    if (previous) try {
      await previous.finishDetach(false, true);
      await this.host.releaseUnused(previous);
    } catch (error) {
      this.host.events.diagnostic('Branch created, but source chat release failed: ' + String(error));
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
  if (state?.sessionId === id || host.hasSession(id)) throw new Error('The prepared branch identity is already in use');
  if (!isAbsolute(path) || !basename(path).endsWith('_' + id + '.jsonl')) throw new Error('The prepared branch path does not bind its session identity');
  const header = JSON.parse(readHeaderLine(path));
  if (header?.type !== 'session' || header?.id !== id || header?.parentSession !== parent) throw new Error('The prepared branch does not belong to its original conversation');
  if (!UUID.test(text(header, 'piopPublicationId'))) throw new Error('The prepared branch has no durable publication identity');
  return path;
}

export { argument };
