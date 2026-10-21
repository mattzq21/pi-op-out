import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import * as endpoint from './daemon_endpoint';
import * as artifacts from './restart_artifacts';
import * as restartStorage from './restart_storage';
import * as records from './settings_records';
import * as daemonLog from './daemon_log';
import * as plugins from './plugins';
import * as peers from './peers';
import { validateConfiguration } from './host/index';
import { piExecutable } from './environment';
import { hostOperationsBusy } from './host_operations';
import { daemonScript } from './session_worker';
import { RwLock, sleep } from './util/sync';
import type { Daemon } from './daemon';
import type { App } from './app';

let PREPARING = false;

/** The restart gate. Requests hold a read lock; a restart or idle shutdown holds the write lock. */
export class Runtime { gate = new RwLock(); }

interface Plan {
  id: string;
  owner: number;
  executable: string;
  fallback: string;
  enabled: string[];
  previous: string[];
  bind: string;
  debug_bind: string | null;
  automatic: boolean;
}

function path(name: string): string { return join(endpoint.directory(), name); }

async function write(name: string, value: any, condition?: () => boolean): Promise<void> {
  const lock = await artifacts.publicationLock();
  try { if (!condition || condition()) restartStorage.write(path(name), value); } finally { lock.release(); }
}

function readPlan(): Plan {
  const plan = restartStorage.read(path('restart-plan.json'));
  if (!plan) throw new Error('Restart plan is missing');
  if (typeof plan.id !== 'string' || typeof plan.owner !== 'number' || typeof plan.executable !== 'string' || typeof plan.fallback !== 'string'
    || !Array.isArray(plan.enabled) || !Array.isArray(plan.previous) || typeof plan.bind !== 'string' || typeof plan.automatic !== 'boolean') throw new Error('Invalid restart plan');
  return plan;
}

/** True while this daemon prepares or owns an active restart. */
export async function blocking(): Promise<boolean> {
  if (PREPARING) return true;
  try { return await artifacts.activePlan(process.pid) || PREPARING; }
  catch (error) { console.error(error); return true; }
}

export function status(id: string): any {
  const value = restartStorage.read(path('restart-status.json'));
  if (!value) throw new Error('Restart status is missing');
  if (value.restartId !== id) throw new Error('This restart has been superseded by another restart');
  return value;
}

function statusRecord(plan: Plan, phase: string, error?: string, pid?: number): any {
  return { restartId: plan.id, phase, error: error ?? null, processId: pid ?? null, expiresAt: Math.floor(Date.now() / 1000) + 180 };
}

async function publish(plan: Plan, phase: string, error?: string, pid?: number, condition?: () => boolean): Promise<void> {
  await write('restart-status.json', statusRecord(plan, phase, error, pid), condition);
}

function currentExecutable(): string {
  const current = daemonScript();
  return current.endsWith(' (deleted)') ? current.slice(0, -' (deleted)'.length) : current;
}

function replacementExecutable(): string {
  const source = process.env.PIOP_DAEMON_EXECUTABLE || currentExecutable();
  let executable: string;
  try { executable = realpathSync(source); } catch (error: any) { throw new Error('Updated daemon is unavailable: ' + error.message); }
  const metadata = statSync(executable);
  if (!metadata.isFile()) throw new Error('Updated daemon is missing: ' + executable);
  if ((metadata.mode & 0o111) === 0) throw new Error('Updated daemon is not executable');
  return executable;
}

async function validateRestartBind(bind: string): Promise<void> {
  const index = bind.lastIndexOf(':');
  const port = Number(bind.slice(index + 1));
  let host = index < 0 ? '' : bind.slice(0, index);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (index < 0 || !host || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid restart bind address: ' + bind);
  try { await lookup(host); } catch (error: any) { throw new Error('Invalid restart bind address: ' + error.message); }
}

async function debugRestartBind(): Promise<string | null> {
  let bind: string | null = null;
  try {
    const bytes = records.read(path('debug-mobile.json'));
    const url = bytes ? JSON.parse(bytes.toString('utf8'))?.url : undefined;
    if (typeof url === 'string') bind = url.replace(/^(ws:\/\/)+/, '');
  } catch {}
  if (bind !== null) await validateRestartBind(bind);
  return bind;
}

function restartBind(url: string): string {
  const address = url.replace(/^(ws:\/\/)+/, '');
  const bind = process.env.PIOP_MOBILE_BIND;
  if (bind === undefined) return address;
  const index = address.lastIndexOf(':');
  if (bind.endsWith(':0') && index >= 0) return bind.slice(0, -2) + ':' + address.slice(index + 1);
  return bind;
}

function strings(value: any): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('invalid type: expected a sequence of strings');
  return value;
}

async function makePlan(app: App, prepared: any): Promise<[Plan, artifacts.Backup]> {
  const id = randomUUID();
  const debugBind = await debugRestartBind();
  const current = endpoint.read();
  const executable = replacementExecutable();
  const enabled = strings(prepared?.enabled);
  const previous = strings(prepared?.previous);
  const bind = restartBind(current.url);
  await validateRestartBind(bind);
  const backup = await artifacts.Backup.create(id, executable);
  const plan: Plan = { id, owner: process.pid, executable, fallback: backup.path, enabled, previous, bind, debug_bind: debugBind, automatic: app.clients.automatic() };
  return [plan, backup];
}

const preparations = new Map<string, Promise<void>>();

export async function prepare(app: App, args: any): Promise<any> {
  const key = endpoint.directory();
  const previous = preparations.get(key);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  preparations.set(key, pending);
  await previous;
  try { return await prepareOnce(app, args); }
  finally {
    if (preparations.get(key) === pending) preparations.delete(key);
    finish();
  }
}

async function prepareOnce(app: App, args: any): Promise<any> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Restart arguments must be an object');
  try { await artifacts.reconcile(); } catch (error: any) { console.error('Restart artifact cleanup remains pending: ' + (error?.message ?? error)); }
  if (await artifacts.activePlan()) throw new Error('A daemon restart is already in progress');
  const terminals = app.terminals.runningCount();
  if (terminals > 0 && args.closeTerminals !== true) return { confirmationRequired: 'terminals', terminalCount: terminals };
  const daemon = await plugins.connection(app);
  if (PREPARING) throw new Error('A daemon restart is already being prepared');
  PREPARING = true;
  try {
    app.broker.ensureIdle();
    await peers.ensureRestartSafe(app);
    return await preparePluginHandoff(app, daemon, { ...args, type: 'prepare_daemon_restart' });
  } finally { PREPARING = false; }
}

async function preparePluginHandoff(app: App, daemon: Daemon, args: any): Promise<any> {
  const prepared = await daemon.request(args);
  let backup: artifacts.Backup | undefined;
  try {
    const [plan, created] = await makePlan(app, prepared);
    backup = created;
    const result = await prepareHandoff(plan);
    backup.handOff();
    return result;
  } catch (error) {
    await backup?.drop();
    throw error;
  }
}

export async function ensureLocalIdle(app: App): Promise<void> {
  app.broker.ensureIdle();
  if (app.terminals.workingDirectories('local').length) throw new Error('Close running terminals before restarting the daemon');
  if (hostOperationsBusy()) throw new Error('Wait for storage operations to finish before restarting the daemon');
  if ((await (await plugins.connection(app)).request({ type: 'check_daemon_idle' })) !== true) throw new Error('Wait for active plugins to finish before restarting the daemon');
}

async function prepareHandoff(plan: Plan): Promise<any> {
  try {
    const lock = await artifacts.publicationLock();
    try {
      restartStorage.write(path('restart-plan.json'), plan);
      restartStorage.write(path('restart-status.json'), statusRecord(plan, 'preparing'));
    } finally { lock.release(); }
    await arm(plan);
  } catch (error: any) {
    try { await publish(plan, 'failed', error?.message ?? String(error), undefined, () => readPlan().id === plan.id); } catch (failure) { console.error(failure); }
    throw error;
  }
  return { restartId: plan.id };
}

function exited(child: ChildProcess): boolean { return child.exitCode !== null || child.signalCode !== null; }

function watch(child: ChildProcess): ChildProcess {
  child.ref();
  child.once('exit', () => child.unref());
  return child;
}

async function arm(plan: Plan): Promise<void> {
  const coordinator = watch(await launch(plan, plan.fallback, '--restart-coordinator'));
  try { await waitArmed(plan, coordinator); }
  catch (error) { coordinator.kill('SIGKILL'); throw error; }
  coordinator.unref();
  coordinators.set(plan.id, coordinator);
  // Only the coordinator starts the replacement daemon. When it dies before the restart, the restart cannot go on.
  coordinator.once('exit', () => {
    coordinators.delete(plan.id);
    const armed = () => { try { return readPlan().id === plan.id && status(plan.id).phase === 'armed'; } catch { return false; } };
    publish(plan, 'failed', COORDINATOR_STOPPED, undefined, armed).catch(error => console.error('Could not record the failed daemon restart: ' + (error?.message ?? error)));
  });
}

const COORDINATOR_STOPPED = 'The restart coordinator stopped before the restart; the previous daemon is still running';

/** The coordinator of each restart that this daemon armed. */
const coordinators = new Map<string, ChildProcess>();

async function waitArmed(plan: Plan, coordinator: ChildProcess): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const value = status(plan.id);
    if (value.phase === 'armed') return;
    if (value.phase === 'failed') throw new Error(typeof value.error === 'string' ? value.error : 'Restart validation failed');
    if (exited(coordinator)) throw new Error('Restart coordinator stopped before validation completed');
    await sleep(100);
  }
  throw new Error('Restart validation timed out; the previous daemon is still running');
}

export async function commit(app: App, id: string): Promise<void> {
  const lock = await artifacts.publicationLock();
  try {
    const plan = readPlan();
    if (plan.id !== id || plan.owner !== process.pid) return;
    if (status(id).phase !== 'armed') return;
    const coordinator = coordinators.get(id);
    if (!coordinator || exited(coordinator)) {
      restartStorage.write(path('restart-status.json'), statusRecord(plan, 'failed', COORDINATOR_STOPPED));
      throw new Error(COORDINATOR_STOPPED);
    }
    restartStorage.write(path('restart-status.json'), statusRecord(plan, 'restarting'));
    app.emit('pi://daemon-restarting', { hostId: 'local', restartId: id });
    setTimeout(() => {
      // Check again just before the stop, because nothing would start a replacement after it.
      if (!exited(coordinator)) { app.clients.stop(); return; }
      console.error(COORDINATOR_STOPPED);
      publish(plan, 'failed', COORDINATOR_STOPPED, undefined, () => { try { return status(id).phase === 'restarting'; } catch { return false; } })
        .catch(error => console.error('Could not record the failed daemon restart: ' + (error?.message ?? error)));
    }, 300);
  } finally { lock.release(); }
}

async function launch(plan: Plan, executable: string, mode: string): Promise<ChildProcess> {
  const command: daemonLog.DaemonCommand = { program: executable, args: [mode, plan.id], env: {
    PIOP_DAEMON_EXECUTABLE: plan.executable, PIOP_MOBILE_BIND: plan.bind,
    PIOP_DEBUG_MOBILE_BIND: plan.debug_bind ?? process.env.PIOP_DEBUG_MOBILE_BIND,
    PIOP_RESTART_AUTOMATIC: plan.automatic ? '1' : undefined,
  } };
  const logger = mode === '--restart-candidate' ? executable : plan.fallback;
  await daemonLog.configure(command, logger);
  return daemonLog.spawnDaemon(command);
}

async function validate(plan: Plan): Promise<void> {
  const child = watch(await launch(plan, plan.executable, '--validate-plugins'));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited(child)) {
      if (child.exitCode === 0) return;
      throw new Error('Updated daemon could not load the plugins; the previous daemon is still running. See daemon.log for details.');
    }
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error('Updated plugin validation timed out; the previous daemon is still running');
}

function claimed(): boolean {
  try { endpoint.claim().release(); return true; } catch { return false; }
}

async function waitForHandoff(plan: Plan): Promise<void> {
  let deadline = Date.now() + 45_000;
  const hardDeadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const value = status(plan.id);
    if (value.phase === 'failed') throw new Error('Restart was cancelled before shutdown');
    if (value.phase === 'restarting') {
      if (claimed()) return;
      let alive = true;
      try { process.kill(plan.owner, 0); }
      catch (error: any) {
        if (error?.code === 'ESRCH') alive = false;
        else if (error?.code !== 'EPERM') throw error;
      }
      if (alive) deadline = Math.min(hardDeadline, Date.now() + 45_000);
    }
    await sleep(100);
  }
  throw new Error('Daemon restart handoff timed out');
}

async function startCandidate(plan: Plan, fallback: boolean): Promise<number> {
  const lock = await artifacts.publicationLock();
  try {
    restartStorage.write(path('plugins.json'), { enabled: fallback ? plan.previous : plan.enabled, previous: plan.previous });
    restartStorage.remove(path('restart-ready.json'));
  } finally { lock.release(); }
  const child = watch(await launch(plan, fallback ? plan.fallback : plan.executable, '--restart-candidate'));
  try { return await waitReady(plan, child); }
  catch (error: any) {
    // The fallback claims the daemon lock without waiting, so the failed candidate must have exited and released it.
    try { await killAndWait(child); }
    catch (failure: any) { throw new Error((error?.message ?? String(error)) + '. ' + (failure?.message ?? String(failure))); }
    throw error;
  }
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (exited(child)) return;
  const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await Promise.race([stopped, sleep(10_000)]);
  if (!exited(child)) throw new Error('The replacement daemon ' + child.pid + ' did not stop within 10 seconds of SIGKILL');
}

async function waitReady(plan: Plan, child: ChildProcess): Promise<number> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (exited(child)) throw new Error('The replacement daemon stopped during startup');
    let ready: any = null;
    try { ready = restartStorage.read(path('restart-ready.json')); } catch {}
    if (ready && ready.restartId === plan.id && ready.processId === child.pid) { child.unref(); return child.pid!; }
    await sleep(100);
  }
  throw new Error('The replacement daemon did not become ready');
}

async function coordinate(plan: Plan): Promise<void> {
  await validate(plan);
  await publish(plan, 'armed');
  await waitForHandoff(plan);
  let pid: number;
  try {
    // Each start attempt renews the status so it stays unexpired while this coordinator runs.
    await publish(plan, 'restarting');
    pid = await startCandidate(plan, false);
  }
  catch (error: any) {
    const message = error?.message ?? String(error);
    try {
      await publish(plan, 'restarting');
      pid = await startCandidate(plan, true);
    }
    catch (rollback: any) { throw new Error(message + '. The previous daemon also failed to start: ' + (rollback?.message ?? rollback) + '. See daemon.log for details.'); }
    await publish(plan, 'rolled_back', message + '. Restored the previous daemon and plugins.', pid);
    return;
  }
  await publish(plan, 'complete', undefined, pid);
}

/** Runs --restart-coordinator or --validate-plugins. Returns undefined for other modes. */
export function specialMode(): Promise<void> | undefined {
  const mode = process.argv[2];
  if (mode !== '--restart-coordinator' && mode !== '--validate-plugins') return undefined;
  return runSpecial(mode);
}

async function runSpecial(mode: string): Promise<void> {
  const plan = readPlan();
  if (process.argv[3] !== plan.id) throw new Error('Invalid daemon restart identifier');
  if (mode === '--validate-plugins') return validateConfiguration(piExecutable(), plan.enabled);
  try { await coordinate(plan); }
  catch (error: any) { try { await publish(plan, 'failed', error?.message ?? String(error)); } catch (failure) { console.error(failure); } throw error; }
  finally { try { await artifacts.reconcile(); } catch (error: any) { console.error('Restart artifact cleanup remains pending: ' + (error?.message ?? error)); } }
}

export async function initializeCandidate(app: App): Promise<void> {
  if (process.argv[2] !== '--restart-candidate') return;
  const plan = readPlan();
  if (process.argv[3] !== plan.id) throw new Error('Invalid daemon restart identifier');
  const result = await plugins.dispatch(app, 'plugin_status', {});
  if (typeof result?.error === 'string') throw new Error(result.error);
}

export async function ready(): Promise<void> {
  if (process.argv[2] !== '--restart-candidate') return;
  const lock = await artifacts.publicationLock();
  try {
    const plan = readPlan();
    restartStorage.write(path('restart-ready.json'), { restartId: plan.id, processId: process.pid });
  } finally { lock.release(); }
}
