import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import * as endpoint from '../service';
import * as artifacts from './artifacts';
import * as restartStorage from './storage';
import { records } from '../../resources/session-database/index.ts';
import * as daemonLog from '../service';
import { localHost } from '../pi';
import * as peers from '../peers';
import { restartConfiguration, saveConfiguration, validateConfiguration } from '../host';
import { hostOperationsIdle } from '../host_operations';
import { daemonScript } from '../service';
import { RwLock, errorText, logFailure, sleep } from '../util/sync';
import { childLink, parentLink, waitFor, type RestartLink } from './link';
import { lockFile } from '../util/flock';
import type { App } from '../app';

let PREPARING = false;

export class Runtime { gate = new RwLock(); }

type Plan = restartStorage.RestartPlan;

async function write(name: 'status', value: restartStorage.RestartStatus, condition?: () => boolean): Promise<void> {
  const lock = await artifacts.publicationLock();
  try {
    if (!condition || condition()) { restartStorage.write(endpoint.directory(), name, value); endpoint.signal(); }
  } finally { lock.release(); }
}

function readPlan(): Plan {
  const plan = restartStorage.read(endpoint.directory(), 'plan');
  if (!plan) throw new Error('Restart plan is missing');
  return plan;
}

export async function blocking(): Promise<boolean> {
  if (PREPARING) return true;
  try { return await artifacts.activePlan(process.pid) || PREPARING; }
  catch (error) { console.error(error); return true; }
}

export function status(id: string): any {
  const value = restartStorage.read(endpoint.directory(), 'status');
  if (!value) throw new Error('Restart status is missing');
  if (value.restartId !== id) throw new Error('This restart has been superseded by another restart');
  return value;
}

function statusRecord(plan: Plan, phase: restartStorage.RestartStatus['phase'], error?: string, pid?: number): restartStorage.RestartStatus {
  return { restartId: plan.id, phase, error: error ?? null, processId: pid ?? null, expiresAt: Math.floor(Date.now() / 1000) + 180 };
}

async function publish(plan: Plan, phase: restartStorage.RestartStatus['phase'], error?: string, pid?: number, condition?: () => boolean): Promise<void> {
  await write('status', statusRecord(plan, phase, error, pid), condition);
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
    const bytes = records.read(endpoint.directory(), 'debug-mobile');
    const url = bytes ? JSON.parse(bytes.toString('utf8'))?.url : undefined;
    if (typeof url === 'string') bind = url.replace(/^(ws:\/\/)+/, '');
  } catch (error) { logFailure('Ignored the saved debug address of the mobile server')(error); }
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

async function makePlan(app: App, prepared: { enabled: string[]; previous: string[] }): Promise<[Plan, artifacts.Backup]> {
  const id = randomUUID();
  const debugBind = await debugRestartBind();
  const current = endpoint.read();
  const executable = replacementExecutable();
  const { enabled, previous } = prepared;
  const bind = restartBind(current.url);
  await validateRestartBind(bind);
  const backup = await artifacts.Backup.create(id, executable);
  const plan: Plan = { id, owner: process.pid, executable, fallback: backup.path, enabled, previous, bind, debug_bind: debugBind };
  return [plan, backup];
}

const preparations = new Map<string, Promise<void>>();

export async function prepare(app: App, args: { enabled: string[]; revision: string; closeTerminals?: boolean }): Promise<any> {
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
  if (PREPARING) throw new Error('A daemon restart is already being prepared');
  PREPARING = true;
  try {
    app.broker.ensureIdle();
    await peers.ensureRestartSafe(app);
    return await preparePluginHandoff(app, args);
  } finally { PREPARING = false; }
}

async function preparePluginHandoff(app: App, args: { enabled: string[]; revision: string }): Promise<any> {
  const prepared = await localHost(app).host.prepareRestart(args);
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
  if (app.terminals.workingDirectories().length) throw new Error('Close running terminals before restarting the daemon');
  await ensureUnattendedIdle(app);
}

export async function ensureUnattendedIdle(app: App): Promise<void> {
  app.broker.ensureIdle();
  if (!(await hostOperationsIdle(10_000))) throw new Error('Wait for storage operations to finish before restarting the daemon');
  await localHost(app).host.checkIdle();
}

async function prepareHandoff(plan: Plan): Promise<any> {
  try {
    const lock = await artifacts.publicationLock();
    try {
      restartStorage.write(endpoint.directory(), 'plan', plan);
      restartStorage.write(endpoint.directory(), 'status', statusRecord(plan, 'preparing'));
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

// The restart has three processes. This daemon starts the coordinator, which checks the new daemon and waits. When this
// daemon has stopped and let go of the daemon lock, the coordinator starts the new daemon. Only the process that holds the
// daemon lock changes the storage: the coordinator reports to this daemon, and the new daemon records the outcome.
async function arm(plan: Plan): Promise<void> {
  const coordinator = watch(await launch(plan, plan.fallback, '--restart-coordinator', true));
  const link = childLink(coordinator);
  try { await waitArmed(link); }
  catch (error) { coordinator.kill('SIGKILL'); link.close(); throw error; }
  await publish(plan, 'armed');
  coordinator.unref();
  coordinators.set(plan.id, { child: coordinator, link });
  coordinator.once('exit', () => {
    coordinators.delete(plan.id);
    const armed = () => { try { return readPlan().id === plan.id && status(plan.id).phase === 'armed'; } catch { return false; } };
    publish(plan, 'failed', COORDINATOR_STOPPED, undefined, armed).catch(error => console.error('Could not record the failed daemon restart: ' + (error?.message ?? error)));
  });
}

const COORDINATOR_STOPPED = 'The restart coordinator stopped before the restart; the previous daemon is still running';

const coordinators = new Map<string, { child: ChildProcess; link: RestartLink }>();

function waitArmed(link: RestartLink): Promise<true> {
  return waitFor(link, message => {
    if (message?.phase === 'armed') return true;
    if (message?.phase === 'failed') throw new Error(typeof message.error === 'string' ? message.error : 'Restart validation failed');
    return undefined;
  }, () => new Error('Restart coordinator stopped before validation completed'), 40_000, 'Restart validation timed out; the previous daemon is still running');
}

export async function commit(app: App, id: string): Promise<void> {
  const lock = await artifacts.publicationLock();
  try {
    const plan = readPlan();
    if (plan.id !== id || plan.owner !== process.pid) return;
    if (status(id).phase !== 'armed') return;
    const running = coordinators.get(id);
    if (!running || exited(running.child)) {
      restartStorage.write(endpoint.directory(), 'status', statusRecord(plan, 'failed', COORDINATOR_STOPPED));
      throw new Error(COORDINATOR_STOPPED);
    }
    const coordinator = running.child;
    restartStorage.write(endpoint.directory(), 'status', statusRecord(plan, 'restarting'));
    app.emit('pi://daemon-restarting', { hostId: 'local', restartId: id });
    running.link.send({ restart: id });
    setTimeout(() => {
      if (!exited(coordinator)) { app.clients.stop(); return; }
      console.error(COORDINATOR_STOPPED);
      publish(plan, 'failed', COORDINATOR_STOPPED, undefined, () => { try { return status(id).phase === 'restarting'; } catch { return false; } })
        .catch(error => console.error('Could not record the failed daemon restart: ' + (error?.message ?? error)));
    }, 300);
  } finally { lock.release(); }
}

async function launch(plan: Plan, executable: string, mode: string, link = false, env: Record<string, string> = {}): Promise<ChildProcess> {
  const command: daemonLog.DaemonCommand = { program: executable, args: [mode, plan.id], link, env: {
    PIOP_DAEMON_EXECUTABLE: plan.executable, PIOP_MOBILE_BIND: plan.bind,
    PIOP_DEBUG_MOBILE_BIND: plan.debug_bind ?? process.env.PIOP_DEBUG_MOBILE_BIND, ...env,
  } };
  const logger = mode === '--restart-candidate' ? executable : plan.fallback;
  await daemonLog.configure(command, logger);
  return daemonLog.spawnDaemon(command);
}

async function validate(plan: Plan): Promise<void> {
  const child = watch(await launch(plan, plan.executable, '--validate-plugins'));
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Updated plugin validation timed out; the previous daemon is still running')); }, 30_000);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  if (code !== 0) throw new Error('Updated daemon could not load the plugins; the previous daemon is still running. See daemon.log for details.');
}

// Waits until the previous daemon has asked for the restart and then let go of the daemon lock. A restart that is not
// asked for within 45 seconds ends; the previous daemon then records it as failed when this coordinator stops.
async function waitForHandoff(plan: Plan, link: RestartLink): Promise<void> {
  await waitFor(link, message => message?.restart === plan.id ? true : undefined, () => new Error('Restart was cancelled before shutdown'), 45_000, 'Daemon restart handoff timed out');
  const lock = await lockFile(join(endpoint.directory(), 'daemon.lock'), 0o600, false, 120_000);
  if (!lock) throw new Error('Daemon restart handoff timed out');
  lock.release();
}

// Starts the new daemon, or with fallbackError the previous one, and waits until it is ready. The started daemon
// records the outcome of the restart itself, because it holds the daemon lock.
async function startCandidate(plan: Plan, fallbackError?: string): Promise<number> {
  const env: Record<string, string> = fallbackError === undefined ? {} : { PIOP_RESTART_FALLBACK_ERROR: fallbackError };
  const child = watch(await launch(plan, fallbackError === undefined ? plan.executable : plan.fallback, '--restart-candidate', true, env));
  const link = childLink(child);
  try {
    const exit = new Promise<never>((_, reject) => child.once('exit', () => reject(new Error('The replacement daemon stopped during startup'))));
    exit.catch(() => {});
    const ready = waitFor(link, message => message?.ready === plan.id && message.processId === child.pid ? true : undefined,
      () => new Error('The replacement daemon stopped during startup'), 45_000, 'The replacement daemon did not become ready');
    await Promise.race([ready, exit]);
    child.unref();
    link.close();
    return child.pid!;
  } catch (error: any) {
    link.close();
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

// No daemon runs when both daemons failed to start. The coordinator then records the failure, under the daemon lock.
async function recordFailure(plan: Plan, message: string): Promise<void> {
  const claimed = endpoint.claim();
  try { await publish(plan, 'failed', message); } finally { claimed.release(); }
}

async function coordinate(plan: Plan, link: RestartLink): Promise<void> {
  try { await validate(plan); }
  catch (error: any) { link.send({ phase: 'failed', error: error?.message ?? String(error) }); throw error; }
  link.send({ phase: 'armed' });
  await waitForHandoff(plan, link);
  try { await startCandidate(plan); }
  catch (error: any) {
    const message = error?.message ?? String(error);
    try { await startCandidate(plan, message); }
    catch (rollback: any) {
      const failure = message + '. The previous daemon also failed to start: ' + (rollback?.message ?? rollback) + '. See daemon.log for details.';
      try { await recordFailure(plan, failure); } catch (record) { console.error('Could not record the failed daemon restart: ' + errorText(record)); }
      throw new Error(failure);
    }
  }
}

export function specialMode(): Promise<void> | undefined {
  const mode = process.argv[2];
  if (mode !== '--restart-coordinator' && mode !== '--validate-plugins') return undefined;
  return runSpecial(mode);
}

async function runSpecial(mode: string): Promise<void> {
  const plan = readPlan();
  if (process.argv[3] !== plan.id) throw new Error('Invalid daemon restart identifier');
  if (mode === '--validate-plugins') return validateConfiguration(plan.enabled);
  await coordinate(plan, parentLink());
}

// The plugin setup that this new daemon starts with: the planned one, or the previous one when it stands in for a
// failed new daemon. It saves it before the plugins load.
export function adoptCandidatePlan(): void {
  if (process.argv[2] !== '--restart-candidate') return;
  const plan = readPlan();
  if (process.argv[3] !== plan.id) throw new Error('Invalid daemon restart identifier');
  const fallback = process.env.PIOP_RESTART_FALLBACK_ERROR !== undefined;
  saveConfiguration(restartConfiguration(fallback ? plan.previous : plan.enabled, plan.previous));
}

export async function initializeCandidate(app: App): Promise<void> {
  if (process.argv[2] !== '--restart-candidate') return;
  const result = await localHost(app).host.pluginStatus();
  if (typeof result?.error === 'string') throw new Error(result.error);
}

// Records the outcome of the restart and tells the coordinator that this daemon is ready.
export async function ready(): Promise<void> {
  if (process.argv[2] !== '--restart-candidate') return;
  const fallbackError = process.env.PIOP_RESTART_FALLBACK_ERROR;
  delete process.env.PIOP_RESTART_FALLBACK_ERROR;
  const link = parentLink();
  const lock = await artifacts.publicationLock();
  try {
    const plan = readPlan();
    restartStorage.write(endpoint.directory(), 'status', fallbackError === undefined
      ? statusRecord(plan, 'complete', undefined, process.pid)
      : statusRecord(plan, 'rolled_back', fallbackError + '. Restored the previous daemon and plugins.', process.pid));
    link.send({ ready: plan.id, processId: process.pid });
  } finally { lock.release(); }
  link.close();
}
