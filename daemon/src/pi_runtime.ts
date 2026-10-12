import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir, isDirectory } from './environment';
import { claimAgent, type BrokerRuntime, type BusyAgent } from './broker';
import * as daemon from './daemon';
import { archivedSessionFile, desktopSessionFile } from './archives';
import { buildPiCommand, remoteHost, sessionIdentity } from './pi_launch';
import { validateSessionWorkingDirectory } from './session_index';
import { loadAppSettings } from './settings';
import * as storageTransactions from './storage_transactions';
import * as Registry from './session_registry';
import { Mutex } from './util/sync';
import type { AgentAddress, BlankSessionCleanup } from './types';
import type { AppSettings } from './settings_types';
import type { App } from './app';

export interface StartPiOptions { runtimeId: string; cwd?: string | null; sessionPath?: string | null; sessionId?: string | null; forkPath?: string | null; hostId?: string | null; presence?: any; clientId: string }

/** attached settles when the start that registered this process finishes attaching. */
interface PiProcess { daemon: daemon.Daemon; windowLabel: string; blankCleanup: BlankSessionCleanup; attached: Promise<void> }

/** State for agent sessions that run through the host daemon. */
export class PiRuntime {
  connections = new daemon.DaemonRegistry();
  processes = new Map<string, PiProcess>();
  /** Serializes session start, switch, archive, and settings changes. */
  lifecycle = new Mutex();
  agentConfigRevision = 0;
  agentConfigRevisions = new Map<string, number>();
  activeAgents = new Map<string, AgentAddress>();

  containsProcess(id: string): boolean { return this.processes.has(id); }

  disconnectDaemon(connection: daemon.Daemon): string[] {
    const ids = [...this.processes].filter(([, process]) => process.daemon === connection).map(([id]) => id);
    for (const id of ids) this.processes.delete(id);
    return ids;
  }

  disconnectProcess(id: string, connection: daemon.Daemon): boolean {
    if (this.processes.get(id)?.daemon !== connection) return false;
    this.processes.delete(id);
    return true;
  }
}

export async function reserveSessionId(settings: AppSettings, hostId: string): Promise<string> {
  if (hostId === 'local') return Registry.reserve(join(homeDir(), STORAGE_DIRECTORY));
  return Registry.reserveOn({ kind: 'remote', host: remoteHost(settings, hostId) });
}

export async function cleanupBlankSession(target: BlankSessionCleanup): Promise<void> {
  if (target.submitted) return;
  try {
    await storageTransactions.deleteBlank(target.host ? { kind: 'remote', host: target.host } : { kind: 'local' }, { path: target.path, id: target.id });
  } catch (error: any) { console.error('Could not clean up blank session: ' + (error?.message ?? error)); }
}

export function ensureRuntimeOwner(runtime: PiRuntime, runtimeId: string, owner: string): void {
  const process = runtime.processes.get(runtimeId);
  if (process && process.windowLabel !== owner) throw new Error('Runtime belongs to another connection');
}

async function sessionLaunchSettings(app: App, hostId: string, cwd: string | null | undefined, readOnly: boolean): Promise<AppSettings> {
  const settings = await loadAppSettings(app);
  if (hostId === 'local' && !settings.localEnabled) throw new Error('Local machine is disabled. Enable it in Settings → Machines.');
  if (!readOnly) await validateSessionWorkingDirectory(settings, hostId, cwd);
  return settings;
}

interface PreparedStart { connection: daemon.Daemon; process: PiProcess; settle: { resolve(): void; reject(error: unknown): void }; packet: any; claim: BusyAgent | undefined; hostId: string; sessionId: string | undefined; sessionPath: string | undefined; reserved: boolean }

/** Checks, reserves and registers a Pi start under the lifecycle lock. Returns the existing attachment when the runtime is already registered. */
async function preparePiStart(app: App, owner: string, runtime: PiRuntime, broker: BrokerRuntime, options: StartPiOptions): Promise<PreparedStart | { existing: Promise<void> }> {
  ensureRuntimeOwner(runtime, options.runtimeId, owner);
  const hostId = options.hostId ?? 'local';
  const readOnly = options.presence?.readOnly === true;
  const settings = await sessionLaunchSettings(app, hostId, options.cwd, readOnly);
  const existing = runtime.processes.get(options.runtimeId);
  if (existing && existing.daemon.alive && existing.daemon.matchesConnection(settings, hostId)) return { existing: existing.attached };
  const reserved = options.sessionId == null && options.sessionPath == null;
  const sessionId = reserved ? await reserveSessionId(settings, hostId) : options.sessionId ?? undefined;
  const blankCleanup: BlankSessionCleanup = { id: sessionId, host: hostId === 'local' ? undefined : remoteHost(settings, hostId), submitted: false };
  let claim: BusyAgent | undefined;
  try {
    const archived = readOnly && options.presence?.archived === true;
    const sessionPath = options.sessionPath == null ? undefined
      : archived ? await archivedSessionFile(settings, hostId, options.sessionPath) : await desktopSessionFile(settings, hostId, options.sessionPath);
    const forkPath = options.forkPath == null ? undefined : await desktopSessionFile(settings, hostId, options.forkPath);
    const claimId = sessionId ?? (sessionPath !== undefined ? await sessionIdentity(settings, hostId, sessionPath) : undefined);
    if (readOnly) {
      if (sessionPath === undefined || forkPath !== undefined) throw new Error('A read-only view requires a saved conversation');
    } else if (claimId !== undefined) claim = claimAgent(broker, hostId, claimId);
    const connection = await daemon.connect(app, runtime, broker, settings, hostId);
    const command = buildPiCommand(broker, settings, hostId, { kind: 'rpc', cwd: options.cwd, sessionPath, sessionId, forkPath }, connection.remotePort);
    blankCleanup.path = sessionPath;
    let settle!: PreparedStart['settle'];
    const attached = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    attached.catch(() => {});
    const process: PiProcess = { daemon: connection, windowLabel: owner, blankCleanup, attached };
    runtime.processes.set(options.runtimeId, process);
    const packet = { type: 'attach', clientId: options.clientId, runtimeId: options.runtimeId, sessionKey: claimId ?? options.runtimeId, spec: daemon.spec(command), timeout: 630_000, cwd: options.cwd ?? null, presence: options.presence ?? {} };
    return { connection, process, settle, packet, claim, hostId, sessionId, sessionPath, reserved };
  } catch (error) {
    claim?.release();
    if (reserved) await cleanupBlankSession(blankCleanup);
    throw error;
  }
}

export async function startPiForOwner(app: App, owner: string, runtime: PiRuntime, broker: BrokerRuntime, options: StartPiOptions): Promise<any> {
  if (typeof options?.runtimeId !== 'string' || typeof options?.clientId !== 'string') throw new Error('Invalid start options');
  // The lifecycle lock covers the checks and registration only. The attach request can take minutes when pi starts slowly,
  // and holding the lock for that long would block every other session start, switch, archive and settings change.
  const prepared = await runtime.lifecycle.run(() => preparePiStart(app, owner, runtime, broker, options));
  // A start that overlaps a pending one for the same runtime reports that start's outcome.
  if ('existing' in prepared) { await prepared.existing; return { attached: true }; }
  const { connection, process, settle, packet, claim, hostId, sessionId, sessionPath, reserved } = prepared;
  try {
    const result = await connection.request(packet);
    if (runtime.processes.get(options.runtimeId) !== process) throw new Error('Pi runtime was detached while it started');
    runtime.activeAgents.set(options.runtimeId, { hostId, sessionId, sessionPath, working: false, messageable: result?.owned === false });
    settle.resolve();
    return result;
  } catch (error) {
    settle.reject(error);
    if (runtime.processes.get(options.runtimeId) === process) runtime.processes.delete(options.runtimeId);
    if (reserved) await cleanupBlankSession(process.blankCleanup);
    throw error;
  } finally { claim?.release(); }
}

export function detachPi(runtime: PiRuntime, runtimeId: string, discardBlank: boolean): Promise<boolean> {
  return detachPiWith(runtime, runtimeId, discardBlank, false);
}

export async function detachPiWith(runtime: PiRuntime, runtimeId: string, discardBlank: boolean, preserveRunning: boolean): Promise<boolean> {
  let stopped = false;
  const process = runtime.processes.get(runtimeId);
  if (!process) { runtime.activeAgents.delete(runtimeId); return false; }
  let result: any;
  try { result = await process.daemon.request({ type: 'detach', runtimeId, discardBlank, preserveRunning }); }
  catch (error) {
    // Keep the runtime registered when the host is still alive so a later detach can try again.
    if (!process.daemon.alive && runtime.processes.get(runtimeId) === process) { runtime.processes.delete(runtimeId); runtime.activeAgents.delete(runtimeId); }
    throw error;
  }
  if (runtime.processes.get(runtimeId) === process) runtime.processes.delete(runtimeId);
  runtime.activeAgents.delete(runtimeId);
  if (result?.stopped === true) {
    stopped = true;
    if (result.submitted === true) process.blankCleanup.submitted = true;
    if (discardBlank) await cleanupBlankSession(process.blankCleanup);
  }
  return stopped;
}

export function stopPi(runtime: PiRuntime, runtimeId: string, discardBlank: boolean | undefined | null): Promise<boolean> {
  return detachPi(runtime, runtimeId, discardBlank ?? false);
}

export async function piPresence(runtime: PiRuntime, runtimeId: string, presence: any): Promise<void> {
  const connection = runtime.processes.get(runtimeId)?.daemon;
  if (connection) await connection.request({ type: 'presence', runtimeId, presence });
}

function executePiCommand(runtime: PiRuntime, runtimeId: string, command: any): Promise<any> {
  const connection = runtime.processes.get(runtimeId)?.daemon;
  if (!connection) return Promise.reject(new Error('Pi is not running'));
  return connection.request({ type: 'command', runtimeId, command });
}

async function prepareSessionSwitch(app: App, runtime: PiRuntime, broker: BrokerRuntime, runtimeId: string, command: any): Promise<BusyAgent> {
  const path = command.sessionPath;
  if (typeof path !== 'string') throw new Error('Session path is required');
  const hostId = runtime.activeAgents.get(runtimeId)?.hostId;
  if (hostId === undefined) throw new Error('Unknown Pi runtime');
  const settings = await loadAppSettings(app);
  const resolved = await desktopSessionFile(settings, hostId, path);
  const claim = claimAgent(broker, hostId, await sessionIdentity(settings, hostId, resolved));
  command.sessionPath = resolved;
  return claim;
}

async function runPiCommand(app: App, runtime: PiRuntime, broker: BrokerRuntime, runtimeId: string, command: any): Promise<any> {
  const commandType = typeof command?.type === 'string' ? command.type : '';
  let claim: BusyAgent | undefined;
  try {
    if (commandType === 'switch_session') claim = await prepareSessionSwitch(app, runtime, broker, runtimeId, command);
    const result = await executePiCommand(runtime, runtimeId, command);
    if (commandType === 'take_ownership') { const agent = runtime.activeAgents.get(runtimeId); if (agent) agent.messageable = false; }
    const state = ['get_snapshot', 'fork', 'fork_after', 'clone'].includes(commandType) ? result?.state : commandType === 'get_state' ? result : undefined;
    if (state !== undefined && state !== null) updateRuntimeSnapshot(runtime, runtimeId, state);
    return result;
  } finally { claim?.release(); }
}

export function piCommand(app: App, runtime: PiRuntime, broker: BrokerRuntime, runtimeId: string, command: any): Promise<any> {
  if (!command || typeof command !== 'object') return Promise.reject(new Error('Invalid Pi command'));
  if (command.type === 'switch_session') return runtime.lifecycle.run(() => runPiCommand(app, runtime, broker, runtimeId, command));
  return runPiCommand(app, runtime, broker, runtimeId, command);
}

export function updateRuntimeSnapshot(runtime: PiRuntime, runtimeId: string, state: any): void {
  const process = runtime.processes.get(runtimeId);
  if (process) {
    if (typeof state.sessionFile === 'string') process.blankCleanup.path = state.sessionFile;
    if (typeof state.sessionId === 'string') process.blankCleanup.id = state.sessionId;
  }
  const agent = runtime.activeAgents.get(runtimeId);
  if (agent) {
    agent.sessionId = typeof state.sessionId === 'string' ? state.sessionId : undefined;
    agent.sessionPath = typeof state.sessionFile === 'string' ? state.sessionFile : undefined;
    agent.working = state.isStreaming === true;
  }
}

async function openSystemResource(target: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('xdg-open', [target], { stdio: 'ignore', detached: false });
      let settled = false;
      const timer = setTimeout(() => { settled = true; child.unref(); resolve(); }, 5000);
      child.once('error', error => {
        clearTimeout(timer);
        if (settled) console.error('Could not open ' + target + ': ' + error.message);
        else { settled = true; reject(error); }
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        const error = code === 0 ? undefined : new Error(signal ? 'xdg-open was killed by ' + signal : 'xdg-open exited with code ' + code);
        if (settled) { if (error) console.error('Could not open ' + target + ': ' + error.message); return; }
        settled = true;
        if (error) reject(error); else resolve();
      });
    });
  } catch (error: any) { throw new Error('Could not open ' + target + ': ' + error.message); }
}

export async function openProjectDirectory(app: App, cwd: string, hostId: string | undefined | null): Promise<void> {
  if ((hostId ?? 'local') !== 'local') {
    const settings = await loadAppSettings(app);
    const host = remoteHost(settings, hostId ?? '');
    throw new Error('Opening project directories on ' + host.name + ' is not supported by the local file manager');
  }
  if (!isDirectory(cwd)) throw new Error('Project directory does not exist: ' + cwd);
  await openSystemResource(cwd);
}

export async function detachOwner(runtime: PiRuntime, owner: string, discardBlank: boolean): Promise<void> {
  const ids = [...runtime.processes].filter(([, process]) => process.windowLabel === owner).map(([id]) => id);
  const results = await Promise.allSettled(ids.map(id => detachPiWith(runtime, id, discardBlank, !discardBlank)));
  results.forEach((result, index) => {
    if (result.status !== 'rejected') return;
    const id = ids[index]!;
    console.error('Could not detach Pi runtime ' + id + ' of ' + owner + ': ' + (result.reason?.message ?? result.reason));
    // The owner is gone, so nothing can retry; forget the runtime instead of keeping a registration nobody owns.
    if (runtime.processes.get(id)?.windowLabel === owner) runtime.processes.delete(id);
    runtime.activeAgents.delete(id);
  });
}

export async function shutdown(runtime: PiRuntime): Promise<void> {
  const daemons = runtime.connections.snapshot();
  for (const connection of daemons) connection.shutdown();
  await Promise.all(daemons.map(connection => connection.waitShutdown()));
}
