import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, chmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync, constants } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { ensurePrivateDir, setPrivateFilePermissions } from './private_fs';
import * as endpoint from './daemon_endpoint';
import * as restartStorage from './restart_storage';
import { daemonScript } from './session_worker';
import { lockPath, lockPathSync, type FileLock } from './util/flock';

const SERVE_MODES = ['--serve', '--exit-on-disconnect', '--restart-candidate', '--restart-coordinator'];
const RUNNING_EXECUTABLE = Bun.isStandaloneExecutable ? '/proc/self/exe' : undefined;
let runningBytes: Buffer | undefined;
let runningBytesError: string | undefined;

function mode(): string | undefined { return process.argv[2]; }

/**
 * Checks script bytes against the running daemon's build ID.
 */
function isRunningBuild(bytes: Buffer, id: string): boolean {
  return id === 'piop-build-' + createHash('sha256').update(bytes.toString('utf8').replaceAll(id, '')).digest('hex');
}

function directory(): string {
  const root = endpoint.directory();
  ensurePrivateDir(root);
  return realpathSync(root);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function identity(id: unknown): string {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Invalid restart artifact identity');
  return id;
}

function name(id: string): string { return 'restart-' + id; }

/** True when the locked descriptor is still the file at its path. A lease file can be removed while a waiter holds an old descriptor. */
function lockedCurrentFile(lock: FileLock): boolean {
  let current;
  try { current = statSync(lock.path); } catch (error: any) { if (error?.code === 'ENOENT') return false; throw error; }
  const locked = fstatSync(lock.fd);
  return current.dev === locked.dev && current.ino === locked.ino;
}

async function openLock(path: string, options: { shared?: boolean }): Promise<FileLock> {
  for (;;) {
    const lock = await lockPath(path, { ...options, blocking: true });
    if (!lock) throw new Error('Could not lock ' + path);
    try {
      if (!lockedCurrentFile(lock)) { lock.release(); continue; }
      setPrivateFilePermissions(path);
    } catch (error) { lock.release(); throw error; }
    return lock;
  }
}

const gates = new Map<string, Promise<void>>();

async function gate(root: string): Promise<FileLock> {
  const previous = gates.get(root);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  gates.set(root, pending);
  const done = () => {
    if (gates.get(root) === pending) gates.delete(root);
    finish();
  };
  await previous;
  try {
    const lock = await openLock(join(root, 'restart-artifacts.lock'), {});
    const release = lock.release.bind(lock);
    lock.release = () => { try { release(); } finally { done(); } };
    return lock;
  } catch (error) { done(); throw error; }
}

async function withGate<T>(root: string, operation: () => T | Promise<T>): Promise<T> {
  const lock = await gate(root);
  try {
    const result = operation();
    return result instanceof Promise ? await result : result;
  } finally { lock.release(); }
}

/** Holds the lock that keeps restart files from removal. Call release() when done. */
export function publicationLock(): Promise<FileLock> { return gate(directory()); }

function leaseAt(root: string, id: string): Promise<FileLock> {
  identity(id);
  return openLock(join(root, 'restart-' + id + '.lock'), { shared: true });
}

function recordPath(root: string, id: string): string { return join(root, 'restart-' + id + '.artifact.json'); }

function hash(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

/** Copies /proc/self/exe or saved script bytes so a failed restart can roll back. */
export class Backup {
  private handedOff = false;
  private constructor(readonly path: string, private id: string, private lease: FileLock | undefined, private references: FileLock[]) {}

  static async create(id: string, executable: string): Promise<Backup> {
    identity(id);
    const root = directory();
    const references: FileLock[] = [];
    const reference = await referenceLease(executable);
    if (reference) references.push(reference);
    let reserved: [string, FileLock];
    try { reserved = await reserve(root, id); } catch (error) { for (const lock of references) lock.release(); throw error; }
    const backup = new Backup(reserved[0], id, reserved[1], references);
    try { backup.copy(root); } catch (error) { await backup.drop(); throw error; }
    return backup;
  }

  private copy(root: string): void {
    if (RUNNING_EXECUTABLE) copyFileSync(RUNNING_EXECUTABLE, this.path);
    else {
      if (!runningBytes) throw new Error(runningBytesError ?? 'Running daemon backup is unavailable');
      writeFileSync(this.path, runningBytes);
    }
    chmodSync(this.path, 0o700);
    const fd = openSync(this.path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    restartStorage.saveBackup(root, this.id, { id: this.id, digest: hash(this.path) });
  }

  handOff(): void { this.handedOff = true; this.releaseLeases(); }

  private releaseLeases(): void {
    this.lease?.release();
    this.lease = undefined;
    for (const lock of this.references.splice(0)) lock.release();
  }

  async drop(): Promise<void> {
    this.releaseLeases();
    if (this.handedOff) return;
    this.handedOff = true;
    try { await cleanupFailed(this.id); } catch (error: any) { console.error('Restart preparation cleanup remains pending for ' + this.path + ': ' + (error?.message ?? error)); }
  }
}

function reserve(root: string, id: string): Promise<[string, FileLock]> {
  return withGate(root, async () => {
    const lease = await leaseAt(root, id);
    const target = join(root, name(id));
    try {
      closeSync(openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o700));
      try { restartStorage.saveBackup(root, id, { id, digest: null }); }
      catch (error) { try { unlinkSync(target); } catch (failure) { console.error(failure); } throw error; }
    } catch (error) { lease.release(); throw error; }
    return [target, lease];
  });
}

function activePhase(status: any): boolean {
  return status === null || status === undefined || !['failed', 'complete', 'rolled_back'].includes(status.phase);
}

function tryExclusive(root: string, id: string): FileLock | undefined {
  const path = join(root, 'restart-' + id + '.lock');
  for (;;) {
    const lock = lockPathSync(path, { blocking: false });
    if (!lock) return undefined;
    try {
      if (!lockedCurrentFile(lock)) { lock.release(); continue; }
      setPrivateFilePermissions(path);
    } catch (error) { lock.release(); throw error; }
    return lock;
  }
}

export function activePlan(owner?: number): Promise<boolean> {
  const root = directory();
  return withGate(root, () => {
    const plan = restartStorage.read(join(root, 'restart-plan.json'));
    if (!plan || (owner !== undefined && plan.owner !== owner)) return false;
    return activePlanAt(root, plan);
  });
}

function activePlanAt(root: string, plan: any): boolean {
  const id = identity(plan?.id);
  const status = planStatus(root, id);
  if (!activePhase(status)) return false;
  const lease = tryExclusive(root, id);
  // A running replacement daemon holds the lease for its lifetime. Once the status expires, the coordinator is gone.
  if (!lease) return !expired(status);
  lease.release();
  if (recordMatches(join(root, name(id)), id) === true) return false;
  return ownerAlive(plan);
}

function planStatus(root: string, id: string): any {
  const status = restartStorage.read(join(root, 'restart-status.json'));
  return status?.restartId === id ? status : null;
}

function expired(status: any): boolean {
  return status !== null && Number(status.expiresAt ?? 0) <= Math.floor(Date.now() / 1000);
}

function ownerAlive(plan: any): boolean {
  const pid = plan?.owner;
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return true;
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code !== 'ESRCH'; }
}

function backupId(path: string): string | undefined {
  let file = basename(path);
  if (file.endsWith(' (deleted)')) file = file.slice(0, -' (deleted)'.length);
  if (!file.startsWith('restart-')) return undefined;
  try { return identity(file.slice('restart-'.length)); } catch { return undefined; }
}

function currentLeases(root: string): Promise<FileLock[]> {
  return withGate(root, async () => {
    const leases: FileLock[] = [];
    try {
      const reference = await referenceLease(daemonScript());
      if (reference) leases.push(reference);
      const plan = operationPlan(root);
      if (plan) {
        leases.push(await leaseAt(root, identity(plan.id)));
        leases.push(...await planReferences(plan));
      }
    } catch (error) { for (const lease of leases) lease.release(); throw error; }
    return leases;
  });
}

function operationPlan(root: string): any {
  if (!['--restart-coordinator', '--validate-plugins', '--restart-candidate'].includes(mode() ?? '')) return undefined;
  const argument = process.argv[3];
  if (argument === undefined) throw new Error('Missing restart identity');
  const id = identity(argument);
  const plan = restartStorage.read(join(root, 'restart-plan.json'));
  if (!plan) throw new Error('Restart plan is missing');
  if (plan.id !== id) throw new Error('The restart plan has changed');
  return plan;
}

async function referenceLease(path: string): Promise<FileLock | undefined> {
  const id = backupId(path);
  if (id === undefined) return undefined;
  const root = realpathSync(dirname(path));
  const profile = realpathSync(join(homeDir(), STORAGE_DIRECTORY));
  if (root !== profile && !root.startsWith(profile + sep)) return undefined;
  return leaseAt(root, id);
}

async function planReferences(plan: any): Promise<FileLock[]> {
  const leases: FileLock[] = [];
  try {
    for (const field of ['executable', 'fallback']) {
      if (typeof plan[field] !== 'string') throw new Error('Invalid restart executable path');
      const lease = await referenceLease(plan[field]);
      if (lease) leases.push(lease);
    }
    return leases;
  } catch (error) { for (const lease of leases) lease.release(); throw error; }
}

let leases: FileLock[] | undefined;
let started = false;

let initializing: Promise<void> | undefined;

export function initialize(): Promise<void> {
  return initializing ??= initializeOnce().finally(() => { initializing = undefined; });
}

async function initializeOnce(): Promise<void> {
  if (!RUNNING_EXECUTABLE && SERVE_MODES.includes(mode() ?? '') && !runningBytes && !runningBytesError) {
    if (typeof __PIOP_BUILD_ID__ !== 'string' || !__PIOP_BUILD_ID__) runningBytesError = 'The daemon build ID is unavailable. Restart Piop manually.';
    else {
      try {
        const bytes = readFileSync(daemonScript());
        if (isRunningBuild(bytes, __PIOP_BUILD_ID__)) runningBytes = bytes;
        else runningBytesError = 'The daemon file changed after this daemon started. Restart Piop manually.';
      } catch (error: any) { runningBytesError = (error?.message ?? 'Could not save the running daemon for restart.') + ' Restart Piop manually.'; }
    }
  }
  if (!needsLease()) return;
  if (!leases) leases = await currentLeases(directory());
  if (!SERVE_MODES.includes(mode() ?? '')) return;
  if (started) return;
  started = true;
  const cleanup = async () => {
    try { await reconcile(); } catch (error: any) { console.error('Restart artifact cleanup remains pending: ' + (error?.message ?? error)); }
    finally { setTimeout(cleanup, 30_000).unref(); }
  };
  setImmediate(cleanup);
}

function needsLease(): boolean {
  if ([...SERVE_MODES, '--validate-plugins'].includes(mode() ?? '')) return true;
  return backupId(daemonScript()) !== undefined;
}

function cleanupFailed(id: string): Promise<void> {
  const root = directory();
  return withGate(root, () => {
    const lease = tryExclusive(root, id);
    if (!lease) return;
    try {
      if (!unusedExecutable(join(root, name(id)))) return;
      removePlan(root, id);
      removeBackup(root, id);
    } finally { lease.release(); }
  });
}

function removePlan(root: string, id: string): void {
  const planPath = join(root, 'restart-plan.json');
  if (restartStorage.read(planPath)?.id === id) restartStorage.remove(planPath);
  const statusPath = join(root, 'restart-status.json');
  const status = restartStorage.read(statusPath);
  if (status && status.restartId === id && activePhase(status)) restartStorage.remove(statusPath);
}

function removeBackup(root: string, id: string): void {
  // The caller holds the exclusive lease, so the lease file goes too. Waiters on the old file see it is gone and retry.
  for (const path of [join(root, name(id)), recordPath(root, id), join(root, name(id) + '.lock')]) {
    try { unlinkSync(path); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  }
  restartStorage.removeBackup(root, id);
}

const reconciliations = new Map<string, Promise<void>>();

export function reconcile(): Promise<void> {
  const root = directory();
  const current = reconciliations.get(root);
  if (current) return current;
  const pending = withGate(root, () => {
    const plan = restartStorage.read(join(root, 'restart-plan.json'));
    const status = restartStorage.read(join(root, 'restart-status.json'));
    const recorded = restartStorage.backups(root);
    for (const id of recorded) {
      identity(id);
      reconcileBackup(root, join(root, name(id)), id, plan, status);
    }
    removeOrphanLeases(root, new Set(recorded), plan);
  }).finally(() => { reconciliations.delete(root); });
  reconciliations.set(root, pending);
  return pending;
}

function reconcileBackup(root: string, path: string, id: string, plan: any, status: any): void {
  const lease = tryExclusive(root, id);
  if (!lease) return;
  try {
    const recorded = removableBackup(path, id);
    if (recorded === undefined) return;
    if (!recorded && plan?.id === id && activePhase(status?.restartId === id ? status : null) && ownerAlive(plan)) return;
    if (referencedByActivePlan(root, path, id, plan)) return;
    removePlan(root, id);
    removeBackup(root, id);
  } finally { lease.release(); }
}

function removableBackup(path: string, id: string): boolean | undefined {
  let metadata;
  try { metadata = lstatSync(path); } catch (error: any) { if (error?.code === 'ENOENT') return true; throw error; }
  if (!metadata.isFile()) return undefined;
  const record = recordMatches(path, id);
  if (record === false) return undefined;
  if (!unusedExecutable(path)) return undefined;
  return record !== undefined;
}

const LEASE_FILE = /^restart-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/;

/** Removes lease files that no backup record or plan uses and that no process holds. The caller holds the gate. */
function removeOrphanLeases(root: string, recorded: Set<string>, plan: any): void {
  for (const entry of readdirSync(root)) {
    const id = LEASE_FILE.exec(entry)?.[1];
    if (id === undefined || recorded.has(id) || plan?.id === id) continue;
    const lease = tryExclusive(root, id);
    if (!lease) continue;
    try {
      try { unlinkSync(join(root, entry)); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    } finally { lease.release(); }
  }
}

function referencedByActivePlan(root: string, path: string, id: string, plan: any): boolean {
  if (!plan || plan.id === id) return false;
  const referenced = ['executable', 'fallback'].some(field => {
    const target = plan[field];
    if (typeof target !== 'string') return false;
    if (target === path) return true;
    try { return realpathSync(target) === path; } catch { return false; }
  });
  if (!referenced) return false;
  return activePlanAt(root, plan);
}

function recordMatches(path: string, id: string): boolean | undefined {
  const record = restartStorage.readBackup(dirname(path), id);
  if (!record) return undefined;
  if (record.id !== id) return false;
  if (record.digest === null || record.digest === undefined) return true;
  try { return hash(path) === record.digest; } catch { return false; }
}

function unusedExecutable(path: string): boolean {
  let artifact;
  try { artifact = statSync(path); } catch (error: any) { if (error?.code === 'ENOENT') return true; throw error; }
  const id = backupId(path);
  for (const entry of readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const processPath = join('/proc', entry);
    try {
      if (statSync(processPath).uid !== artifact.uid) continue;
      try {
        const executable = statSync(join(processPath, 'exe'));
        if (executable.dev === artifact.dev && executable.ino === artifact.ino) return false;
      } catch (error: any) { if (error?.code !== 'ENOENT' && error?.code !== 'EACCES') throw error; }
      const argumentsList = readFileSync(join(processPath, 'cmdline')).toString('utf8').split('\u0000');
      if (argumentsList.some(argument => argument === path || (id !== undefined && argument === id))) return false;
    } catch (error: any) { if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') throw error; }
  }
  return true;
}
