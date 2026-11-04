import { detectRepository } from './chat_worktrees';
import * as ChatWorktrees from './chat_worktree_records';
import { rememberProjectRepository } from './project_repositories';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir, isDirectory } from './environment';
import { claimAgent, type BrokerRuntime, type BusyAgent } from './broker';
import { localHost, spec, type LocalHost } from './local_host';
import { locateSessionFile } from './archives';
import { buildPiCommand, sessionIdentity } from './pi_launch';
import { validateSessionWorkingDirectory } from './session_index';
import { loadAppSettings } from './settings';
import * as storageTransactions from './storage_transactions';
import * as Registry from './session_registry';
import { Mutex, observedElsewhere } from './util/sync';
import type { AgentAddress, BlankSessionCleanup } from './types';
import type { AppSettings } from './settings_types';
import type { AttachRequest } from './host/index';
import type { App } from './app';

export interface StartPiOptions { runtimeId: string; baseBranch?: string; cwd?: string | null; sessionPath?: string | null; sessionId?: string | null; forkPath?: string | null; presence?: any; clientId: string }

interface PiProcess { connection: LocalHost; windowLabel: string; blankCleanup: BlankSessionCleanup; attached: Promise<void> }

interface PendingStart { owner: string; cancelled: boolean }

export class PiRuntime {
  host: LocalHost | undefined;
  processes = new Map<string, PiProcess>();
  pendingStarts = new Map<string, Set<PendingStart>>();
  lifecycle = new Mutex();
  activeAgents = new Map<string, AgentAddress>();
  settingsPendingSessions = new Set<string>();

  containsProcess(id: string): boolean { return this.processes.has(id); }

  disconnectHost(host: LocalHost): string[] {
    const ids = [...this.processes].filter(([, process]) => process.connection === host).map(([id]) => id);
    for (const id of ids) this.processes.delete(id);
    return ids;
  }

  cancelPendingStarts(match: { runtimeId?: string; owner?: string }): void {
    for (const [id, starts] of this.pendingStarts) {
      if (match.runtimeId !== undefined && id !== match.runtimeId) continue;
      for (const start of starts) if (match.owner === undefined || start.owner === match.owner) start.cancelled = true;
    }
  }

  disconnectProcess(id: string, host: LocalHost): boolean {
    if (this.processes.get(id)?.connection !== host) return false;
    this.processes.delete(id);
    return true;
  }
}

export function reserveSessionId(): string {
  return Registry.reserve(join(homeDir(), STORAGE_DIRECTORY));
}

export async function cleanupBlankSession(target: BlankSessionCleanup): Promise<void> {
  if (target.submitted) return;
  try {
    await storageTransactions.deleteBlank({ path: target.path, id: target.id });
  } catch (error: any) { console.error('Could not clean up blank session: ' + (error?.message ?? error)); }
  if (target.id !== undefined) {
    try {
      const root = join(homeDir(), STORAGE_DIRECTORY);
      Registry.releaseReservation(root, target.id);
      if (ChatWorktrees.read(target.id, root) && !Registry.ids(root).includes(target.id)) await ChatWorktrees.abandonCreation(target.id, null, root);
    }
    catch (error: any) { console.error('Could not release reserved session ID ' + target.id + ': ' + (error?.message ?? error)); }
  }
}

export function ensureRuntimeOwner(runtime: PiRuntime, runtimeId: string, owner: string): void {
  const process = runtime.processes.get(runtimeId);
  if (process && process.windowLabel !== owner) throw new Error('Runtime belongs to another connection');
}

async function sessionLaunchSettings(app: App, cwd: string | null | undefined, readOnly: boolean): Promise<AppSettings> {
  const settings = await loadAppSettings(app);
  if (!settings.localEnabled) throw new Error('Local host is disabled. Enable it in Settings → Hosts.');
  if (!readOnly) validateSessionWorkingDirectory(cwd);
  return settings;
}

interface PreparedStart { connection: LocalHost; process: PiProcess; settle: { resolve(): void; reject(error: unknown): void }; request: AttachRequest; claim: BusyAgent | undefined; sessionId: string | undefined; sessionPath: string | undefined; reserved: boolean }

async function preparePiStart(app: App, owner: string, runtime: PiRuntime, broker: BrokerRuntime, options: StartPiOptions, pending: PendingStart): Promise<PreparedStart | { existing: Promise<void> }> {
  const assertNotCancelled = () => { if (pending.cancelled) throw new Error('Pi start was cancelled'); };
  assertNotCancelled();
  ensureRuntimeOwner(runtime, options.runtimeId, owner);
  const readOnly = options.presence?.readOnly === true;
  const settings = await sessionLaunchSettings(app, options.cwd, readOnly);
  assertNotCancelled();
  const existing = runtime.processes.get(options.runtimeId);
  if (existing && existing.connection.alive) return { existing: existing.attached };
  const reserved = options.sessionId == null && options.sessionPath == null;
  const sessionId = reserved ? reserveSessionId() : options.sessionId ?? undefined;
  const blankCleanup: BlankSessionCleanup = { id: sessionId, submitted: false };
  let claim: BusyAgent | undefined;
  try {
    if (options.baseBranch !== undefined) {
      if (!reserved || readOnly || !options.cwd || typeof options.baseBranch !== 'string') throw new Error('A new worktree requires a new chat and a starting branch');
      const repository = await detectRepository(options.cwd);
      if (!repository) throw new Error('This folder is not a Git repository');
      const root = join(homeDir(), STORAGE_DIRECTORY);
      const created = await ChatWorktrees.create({ sourceCwd: repository.repository, chatId: sessionId!, home: homeDir(), repository, baseBranch: options.baseBranch }, root);
      rememberProjectRepository(root, created.worktree, { root: created.worktree, gitDir: created.gitCommonDir });
      options = { ...options, cwd: created.worktree };
      assertNotCancelled();
    }
    const archived = readOnly && options.presence?.archived === true;
    const sessionPath = options.sessionPath == null ? undefined
      : await locateSessionFile(options.sessionPath, archived);
    const forkPath = options.forkPath == null ? undefined : await locateSessionFile(options.forkPath, false);
    const claimId = sessionId ?? (sessionPath !== undefined ? await sessionIdentity(sessionPath) : undefined);
    if (readOnly) {
      if (sessionPath === undefined || forkPath !== undefined) throw new Error('A read-only view requires a saved conversation');
    } else if (claimId !== undefined) claim = claimAgent(broker, claimId);
    const connection = localHost(app);
    const command = buildPiCommand(settings, { kind: 'rpc', cwd: options.cwd, sessionPath, sessionId, forkPath });
    blankCleanup.path = sessionPath;
    let settle!: PreparedStart['settle'];
    const attached = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    observedElsewhere(attached);
    const process: PiProcess = { connection, windowLabel: owner, blankCleanup, attached };
    runtime.processes.set(options.runtimeId, process);
    const request: AttachRequest = { clientId: options.clientId, runtimeId: options.runtimeId, sessionKey: claimId ?? options.runtimeId, spec: spec(command), timeout: 630_000, cwd: options.cwd ?? null, presence: options.presence ?? {} };
    return { connection, process, settle, request, claim, sessionId, sessionPath, reserved };
  } catch (error) {
    claim?.release();
    if (reserved) {
      if (sessionId && ChatWorktrees.read(sessionId, join(homeDir(), STORAGE_DIRECTORY))) await ChatWorktrees.abandonCreation(sessionId, null, join(homeDir(), STORAGE_DIRECTORY));
      else await cleanupBlankSession(blankCleanup);
    }
    throw error;
  }
}

export async function startPiForOwner(app: App, owner: string, runtime: PiRuntime, broker: BrokerRuntime, options: StartPiOptions): Promise<any> {
  if (typeof options?.runtimeId !== 'string' || typeof options?.clientId !== 'string') throw new Error('Invalid start options');
  const pending: PendingStart = { owner, cancelled: false };
  let starts = runtime.pendingStarts.get(options.runtimeId);
  if (!starts) { starts = new Set(); runtime.pendingStarts.set(options.runtimeId, starts); }
  starts.add(pending);
  let prepared: Awaited<ReturnType<typeof preparePiStart>>;
  try { prepared = await runtime.lifecycle.run(() => preparePiStart(app, owner, runtime, broker, options, pending)); }
  finally {
    starts.delete(pending);
    if (!starts.size && runtime.pendingStarts.get(options.runtimeId) === starts) runtime.pendingStarts.delete(options.runtimeId);
  }
  if ('existing' in prepared) {
    await prepared.existing;
    const agent = runtime.activeAgents.get(options.runtimeId);
    if (!agent) throw new Error('Pi runtime was detached while it started');
    return { attached: true, owned: !agent.messageable };
  }
  const { connection, process, settle, request, claim, sessionId, sessionPath, reserved } = prepared;
  try {
    const result = await connection.host.attach(request);
    if (runtime.processes.get(options.runtimeId) !== process) throw new Error('Pi runtime was detached while it started');
    runtime.activeAgents.set(options.runtimeId, { hostId: 'local', sessionId, sessionPath, working: false, messageable: result?.owned === false });
    if (options.baseBranch !== undefined && sessionId) ChatWorktrees.activate(sessionId, join(homeDir(), STORAGE_DIRECTORY));
    settle.resolve();
    return { ...result, cwd: request.cwd };
  } catch (error) {
    settle.reject(error);
    if (runtime.processes.get(options.runtimeId) === process) {
      try { await detachPiWith(runtime, options.runtimeId, false, false); }
      catch (detachError: any) { console.error('Could not cancel the failed start of Pi runtime ' + options.runtimeId + ': ' + (detachError?.message ?? detachError)); }
    }
    if (reserved && runtime.processes.get(options.runtimeId) !== process) {
      if (sessionId && ChatWorktrees.read(sessionId, join(homeDir(), STORAGE_DIRECTORY))) await ChatWorktrees.abandonCreation(sessionId, process.blankCleanup.path ?? null, join(homeDir(), STORAGE_DIRECTORY));
      else await cleanupBlankSession(process.blankCleanup);
    }
    throw error;
  } finally { claim?.release(); }
}

export function detachPi(runtime: PiRuntime, runtimeId: string, discardBlank: boolean): Promise<boolean> {
  return detachPiWith(runtime, runtimeId, discardBlank, false);
}

export async function detachPiWith(runtime: PiRuntime, runtimeId: string, discardBlank: boolean, preserveRunning: boolean): Promise<boolean> {
  let stopped = false;
  const process = runtime.processes.get(runtimeId);
  if (!process) { runtime.cancelPendingStarts({ runtimeId }); runtime.activeAgents.delete(runtimeId); return false; }
  let result: any;
  try { result = await process.connection.host.detachRuntime(runtimeId, discardBlank, preserveRunning); }
  catch (error) {
    if (!process.connection.alive && runtime.processes.get(runtimeId) === process) { runtime.processes.delete(runtimeId); runtime.activeAgents.delete(runtimeId); }
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
  const process = runtime.processes.get(runtimeId);
  if (process) await process.connection.host.presence(runtimeId, presence);
}

function executePiCommand(runtime: PiRuntime, runtimeId: string, command: any): Promise<any> {
  const process = runtime.processes.get(runtimeId);
  if (!process) return Promise.reject(new Error('Pi is not running'));
  return process.connection.host.command(runtimeId, command);
}

async function prepareSessionSwitch(app: App, runtime: PiRuntime, broker: BrokerRuntime, runtimeId: string, command: any): Promise<BusyAgent> {
  const path = command.sessionPath;
  if (typeof path !== 'string') throw new Error('Session path is required');
  if (!runtime.activeAgents.has(runtimeId)) throw new Error('Unknown Pi runtime');
  const resolved = await locateSessionFile(path, false);
  const claim = claimAgent(broker, await sessionIdentity(resolved));
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
    const state = ['get_snapshot', 'fork', 'fork_after', 'copy_after', 'clone'].includes(commandType) ? result?.state : commandType === 'get_state' ? result : undefined;
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

export async function openProjectDirectory(cwd: string): Promise<void> {
  if (!isDirectory(cwd)) throw new Error('Project directory does not exist: ' + cwd);
  await openSystemResource(cwd);
}

export async function detachOwner(runtime: PiRuntime, owner: string, discardBlank: boolean): Promise<void> {
  runtime.cancelPendingStarts({ owner });
  const ids = [...runtime.processes].filter(([, process]) => process.windowLabel === owner).map(([id]) => id);
  const results = await Promise.allSettled(ids.map(id => detachPiWith(runtime, id, discardBlank, !discardBlank)));
  results.forEach((result, index) => {
    if (result.status !== 'rejected') return;
    const id = ids[index]!;
    console.error('Could not detach Pi runtime ' + id + ' of ' + owner + ': ' + (result.reason?.message ?? result.reason));
    if (runtime.processes.get(id)?.windowLabel === owner) runtime.processes.delete(id);
    runtime.activeAgents.delete(id);
  });
}

