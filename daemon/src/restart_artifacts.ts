import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, chmodSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, constants } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { ensurePrivateDir, setPrivateFilePermissions } from './private_fs';
import * as endpoint from './daemon_endpoint';
import * as restartStorage from './restart_storage';
import { daemonScript } from './session_worker';
import { lockPathSync, type FileLock } from './util/flock';

const SERVE_MODES = ['--serve', '--exit-on-disconnect', '--restart-candidate', '--restart-coordinator'];

function mode(): string | undefined { return process.argv[2]; }

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

function openLock(path: string, options: { shared?: boolean; blocking?: boolean }): FileLock | undefined {
  const lock = lockPathSync(path, { shared: options.shared, blocking: (options.blocking ?? true) as false });
  if (lock) setPrivateFilePermissions(path);
  return lock;
}

function gate(root: string): FileLock { return openLock(join(root, 'restart-artifacts.lock'), {})!; }

function withGate<T>(root: string, operation: () => T): T {
  const lock = gate(root);
  try { return operation(); } finally { lock.release(); }
}

/** Holds the lock that keeps restart files from removal. Call release() when done. */
export function publicationLock(): FileLock { return gate(directory()); }

function leaseAt(root: string, id: string): FileLock {
  identity(id);
  return openLock(join(root, 'restart-' + id + '.lock'), { shared: true })!;
}

function recordPath(root: string, id: string): string { return join(root, 'restart-' + id + '.artifact.json'); }

function hash(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

/** A copy of the running daemon script, kept so a failed restart can roll back. */
export class Backup {
  private handedOff = false;
  private constructor(readonly path: string, private id: string, private lease: FileLock | undefined, private references: FileLock[]) {}

  static create(id: string, executable: string): Backup {
    identity(id);
    const root = directory();
    const references: FileLock[] = [];
    const reference = referenceLease(executable);
    if (reference) references.push(reference);
    let reserved: [string, FileLock];
    try { reserved = reserve(root, id); } catch (error) { for (const lock of references) lock.release(); throw error; }
    const backup = new Backup(reserved[0], id, reserved[1], references);
    try { backup.copy(root); } catch (error) { backup.drop(); throw error; }
    return backup;
  }

  private copy(root: string): void {
    copyFileSync(daemonScript(), this.path);
    chmodSync(this.path, 0o700);
    const fd = openSync(this.path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    restartStorage.saveBackup(root, this.id, { id: this.id, digest: hash(this.path) });
  }

  handOff(): void { this.handedOff = true; this.drop(); }

  drop(): void {
    this.lease?.release();
    this.lease = undefined;
    for (const lock of this.references.splice(0)) lock.release();
    if (this.handedOff) return;
    this.handedOff = true;
    try { cleanupFailed(this.id); } catch (error: any) { console.error('Restart preparation cleanup remains pending for ' + this.path + ': ' + (error?.message ?? error)); }
  }
}

function reserve(root: string, id: string): [string, FileLock] {
  return withGate(root, () => {
    const lease = leaseAt(root, id);
    const target = join(root, name(id));
    try {
      closeSync(openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o700));
      try { restartStorage.saveBackup(root, id, { id, digest: null }); }
      catch (error) { try { unlinkSync(target); } catch {} throw error; }
    } catch (error) { lease.release(); throw error; }
    return [target, lease];
  });
}

function activePhase(status: any): boolean {
  return status === null || status === undefined || !['failed', 'complete', 'rolled_back'].includes(status.phase);
}

function tryExclusive(root: string, id: string): FileLock | undefined {
  return openLock(join(root, 'restart-' + id + '.lock'), { blocking: false });
}

export function activePlan(): boolean {
  const root = directory();
  return withGate(root, () => {
    const plan = restartStorage.read(join(root, 'restart-plan.json'));
    if (!plan) return false;
    return activePlanAt(root, plan);
  });
}

function activePlanAt(root: string, plan: any): boolean {
  const id = identity(plan?.id);
  if (!planPhaseActive(root, id)) return false;
  const lease = tryExclusive(root, id);
  if (!lease) return true;
  lease.release();
  if (recordMatches(join(root, name(id)), id) === true) return false;
  return ownerAlive(plan);
}

function planPhaseActive(root: string, id: string): boolean {
  const status = restartStorage.read(join(root, 'restart-status.json'));
  return activePhase(status?.restartId === id ? status : null);
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

function currentLeases(root: string): FileLock[] {
  return withGate(root, () => {
    const leases: FileLock[] = [];
    try {
      const reference = referenceLease(daemonScript());
      if (reference) leases.push(reference);
      const plan = operationPlan(root);
      if (plan) {
        leases.push(leaseAt(root, identity(plan.id)));
        leases.push(...planReferences(plan));
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

function referenceLease(path: string): FileLock | undefined {
  const id = backupId(path);
  if (id === undefined) return undefined;
  const root = realpathSync(dirname(path));
  const profile = realpathSync(join(homeDir(), STORAGE_DIRECTORY));
  if (root !== profile && !root.startsWith(profile + sep)) return undefined;
  return leaseAt(root, id);
}

function planReferences(plan: any): FileLock[] {
  const leases: FileLock[] = [];
  for (const field of ['executable', 'fallback']) {
    if (typeof plan[field] !== 'string') { for (const lease of leases) lease.release(); throw new Error('Invalid restart executable path'); }
    const lease = referenceLease(plan[field]);
    if (lease) leases.push(lease);
  }
  return leases;
}

let leases: FileLock[] | undefined;
let started = false;

export function initialize(): void {
  if (!needsLease()) return;
  if (!leases) leases = currentLeases(directory());
  if (!SERVE_MODES.includes(mode() ?? '')) return;
  if (started) return;
  started = true;
  setInterval(() => {
    try { reconcile(); } catch (error: any) { console.error('Restart artifact cleanup remains pending: ' + (error?.message ?? error)); }
  }, 30_000).unref();
  setImmediate(() => { try { reconcile(); } catch (error: any) { console.error('Restart artifact cleanup remains pending: ' + (error?.message ?? error)); } });
}

function needsLease(): boolean {
  if ([...SERVE_MODES, '--validate-plugins'].includes(mode() ?? '')) return true;
  return backupId(daemonScript()) !== undefined;
}

function cleanupFailed(id: string): void {
  const root = directory();
  withGate(root, () => {
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
  for (const path of [join(root, name(id)), recordPath(root, id)]) {
    try { unlinkSync(path); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  }
  restartStorage.removeBackup(root, id);
}

export function reconcile(): void {
  const root = directory();
  withGate(root, () => {
    const plan = restartStorage.read(join(root, 'restart-plan.json'));
    const status = restartStorage.read(join(root, 'restart-status.json'));
    for (const id of restartStorage.backups(root)) {
      identity(id);
      reconcileBackup(root, join(root, name(id)), id, plan, status);
    }
  });
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
  if (process.platform !== 'linux') return false;
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
