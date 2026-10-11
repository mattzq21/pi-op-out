import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { MAX_SESSION_INDEX_BATCH_BYTES, STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { indexSessionsBundle, temporaryChat } from './resources';
import { nodeCommand } from './node_command';
import { localLaunchDirectory, remoteDirectoryPath, remoteHost, remoteLoginCommand, ssh } from './pi_launch';
import { output, runLimited, shellQuote, type CommandSpec } from './process_io';
import { inspectSessionProjectsWith } from './folder_inspection';
import { ProjectMetadataCache } from './project_metadata';
import * as sidebarStorage from './sidebar_storage';
import * as Registry from './session_registry';
import * as restoreRecovery from './restore_recovery';
import { loadAppSettings } from './settings';
import { MAX_REMOTE_HOSTS, type AppSettings, type RemoteHost } from './settings_types';
import { canonicalUuid } from './session_worker';
import { transaction } from './util/db';
import { Mutex } from './util/sync';
import * as peers from './peers';
import { reserveSessionId } from './pi_runtime';
import type { SessionSummary } from './types';
import type { App } from './app';

export interface CachedSession { fingerprint: string; summary: SessionSummary }
type SessionCandidate = [path: string, fingerprint: string, modifiedAt: number, size: number];

export class SessionIndexRuntime {
  local = new Map<string, CachedSession>();
  sidebar: { database?: sidebarStorage.SidebarDatabase } = {};
  projects = new ProjectMetadataCache();
  lock = new Mutex();
}

export interface DirectoryListing { path: string; parent: string | null; directories: string[] }
export interface TemporaryChat { cwd: string; sessionId: string }

async function inspectSessionProjects(index: SessionIndexRuntime, sessions: SessionSummary[], host: RemoteHost | undefined): Promise<void> {
  await index.projects.inspect(sessions, host, pending => inspectSessionProjectsWith(pending, (script, batch) => {
    if (host) return ssh(host, `sh -c ${shellQuote(script)} sh ${batch.map(shellQuote).join(' ')}`);
    return { program: 'sh', args: ['-c', script, 'sh', ...batch] };
  }));
}

export function readSessionSummaries(candidates: SessionCandidate[], host: RemoteHost | undefined): Promise<Map<string, CachedSession>> {
  return readSessionSummariesWith(candidates, host, (script, batch) => {
    if (host) return ssh(host, remoteLoginCommand(`PIOP_STORAGE_DIRECTORY=${STORAGE_DIRECTORY} bun -e ${shellQuote(script)} ${batch.map(item => shellQuote(item[0])).join(' ')}`));
    return nodeCommand(['-e', script, ...batch.map(item => item[0])]);
  });
}

export async function readSessionSummariesWith(candidates: SessionCandidate[], host: RemoteHost | undefined, command: (script: string, batch: SessionCandidate[]) => CommandSpec): Promise<Map<string, CachedSession>> {
  const result = new Map<string, CachedSession>();
  let cursor = 0;
  while (cursor < candidates.length) {
    let end = cursor; let argumentBytes = 0;
    while (end < candidates.length && end - cursor < 128) {
      const size = Buffer.byteLength(shellQuote(candidates[end]![0])) + 1;
      if (end > cursor && argumentBytes + size > 16 * 1024) break;
      argumentBytes += size; end += 1;
    }
    const batch = candidates.slice(cursor, end);
    const out = await runLimited(command(indexSessionsBundle, batch), MAX_SESSION_INDEX_BATCH_BYTES, 'Could not read session summaries');
    if (!out.status.success) throw new Error(out.stderr.toString());
    for (const line of out.stdout.toString('utf8').split('\n')) {
      let value: any;
      try { value = JSON.parse(line); } catch { continue; }
      const path = value?.path;
      if (typeof path !== 'string') continue;
      const item = batch.find(item => item[0] === path);
      if (!item) continue;
      const string = (key: string) => typeof value[key] === 'string' ? value[key] : '';
      const cwd = string('cwd');
      const project = basename(cwd) || 'Workspace';
      const summary: SessionSummary = {
        groupId: null, subagentParentId: typeof value.subagentParentId === 'string' ? value.subagentParentId : undefined,
        id: string('id'), path, name: string('name'), project, cwd, cwdExists: true, modifiedAt: item[2], preview: string('preview'),
        messageCount: Number.isInteger(value.messageCount) && value.messageCount >= 0 ? value.messageCount : 0,
        lastMessageAt: Number.isInteger(value.lastMessageAt) && value.lastMessageAt >= 0 ? value.lastMessageAt : 0,
        apiCost: typeof value.apiCost === 'number' ? value.apiCost : 0,
        hostId: host?.id ?? 'local', hostName: host?.name ?? 'Local',
      };
      result.set(path, { fingerprint: item[1], summary });
    }
    cursor = end;
  }
  return result;
}

export async function listLocalSessions(index: SessionIndexRuntime, root: string): Promise<SessionSummary[]> {
  await restoreRecovery.recover(dirname(root));
  const sessions = await cachedLocalSessions(index, root);
  await inspectSessionProjects(index, sessions, undefined);
  return sessions;
}

async function cachedLocalSessions(index: SessionIndexRuntime, root: string): Promise<SessionSummary[]> {
  return index.lock.run(async () => {
    const cache = index.local;
    const storageRoot = dirname(root);
    let needsSave = sidebarStorage.prepare(index.sidebar, storageRoot, cache);
    needsSave = (await refreshLocalCache(root, cache)) || needsSave;
    if (needsSave) sidebarStorage.persist(index.sidebar, cache);
    return [...cache.values()].map(cached => ({ ...cached.summary }));
  });
}

async function refreshLocalCache(root: string, cache: Map<string, CachedSession>): Promise<boolean> {
  const [seen, changed] = localSessionCandidates(root, cache);
  const summaries = await readSessionSummaries(changed, undefined);
  const needsSave = changed.length > 0 || [...cache.keys()].some(path => !seen.has(path));
  for (const [path] of changed) cache.delete(path);
  for (const [path, summary] of summaries) cache.set(path, summary);
  for (const path of [...cache.keys()]) if (!seen.has(path)) cache.delete(path);
  return needsSave;
}

function localSessionCandidates(root: string, cache: Map<string, CachedSession>): [Set<string>, SessionCandidate[]] {
  const seen = new Set<string>(); const changed: SessionCandidate[] = [];
  const database = Registry.open(dirname(root));
  try {
    const prefix = root.replace(/\/+$/, '') + sep;
    const rows = database.prepare('SELECT s.session_path AS path, m.modified_ns AS modified, m.size AS size FROM sessions s LEFT JOIN session_file_metadata m ON m.session_id=s.session_id AND m.session_path=s.session_path WHERE substr(s.session_path, 1, length(?1))=?1').all(prefix) as any[];
    for (const row of rows) {
      const path: string = row.path;
      const saved = row.modified !== null && row.modified !== undefined && row.size !== null && row.size !== undefined ? [String(row.modified), Number(row.size)] as const : undefined;
      const candidate = saved ? registeredCandidate(path, saved) : captureLocalCandidate(database, path);
      if (!candidate) continue;
      seen.add(path);
      if (cache.get(path)?.fingerprint !== candidate[1]) changed.push(candidate);
    }
  } finally { database.close(); }
  return [seen, changed];
}

function registeredCandidate(path: string, [modified, size]: readonly [string, number]): SessionCandidate {
  if (!/^\d+$/.test(modified)) throw new Error('invalid digit found in string');
  const seconds = Number(BigInt(modified) / 1_000_000_000n);
  return [path, `${modified}:${size}`, seconds, size];
}

function captureLocalCandidate(database: import('./util/db').Database, path: string): SessionCandidate | undefined {
  return transaction(database, 'IMMEDIATE', () => {
    const candidate = localCandidate(path);
    if (candidate) {
      const [file, fingerprint, , size] = candidate;
      const modified = fingerprint.split(':')[0];
      database.prepare(`INSERT INTO session_file_metadata SELECT session_id, session_path, ?, ? FROM sessions WHERE session_path=?
            AND NOT EXISTS (SELECT 1 FROM session_file_writes w WHERE w.session_id=sessions.session_id)
            ON CONFLICT(session_id) DO NOTHING`).run(modified!, size, file);
    }
    return candidate;
  });
}

function localCandidate(path: string): SessionCandidate | undefined {
  let stats;
  try { stats = lstatSync(path, { bigint: true }); } catch (error: any) { if (error?.code === 'ENOENT') return undefined; throw error; }
  if (!stats.isFile()) return undefined;
  const modifiedNs = stats.mtimeNs > 0n ? stats.mtimeNs : 0n;
  const size = Number(stats.size);
  return [path, `${modifiedNs}:${size}`, Number(modifiedNs / 1_000_000_000n), size];
}

export async function homeDirectory(app: App, hostId: string): Promise<string> {
  if (hostId === 'local') { const home = homeDir(); try { return realpathSync(home); } catch { return home; } }
  const settings = await loadAppSettings(app); const host = remoteHost(settings, hostId);
  let result;
  try { result = await output(ssh(host, 'cd "$HOME" && pwd -P')); } catch (error: any) { throw new Error(`Could not resolve home on ${host.name}: ${error.message}`); }
  if (!result.status.success) throw new Error(result.stderr.toString().trim());
  const path = result.stdout.toString().trim();
  if (!path) throw new Error('Remote home directory was unavailable');
  return path;
}

function temporaryChatScript(): string {
  const script = Registry.withDatabase(temporaryChat);
  return `${script}\ntry { main(JSON.parse(process.argv[1])); } catch (error) { console.error(error.message); process.exitCode = 1; }`;
}

async function temporaryChatOutput(command: CommandSpec): Promise<string> {
  let result;
  try { result = await output(command); } catch (error: any) { throw new Error(`Could not update temporary chat directory: ${error.message}`); }
  if (!result.status.success) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString().trim();
}

export function createLocalTemporaryChat(home: string, sessionId: string): Promise<string> {
  const request = JSON.stringify({ action: 'create', id: sessionId, root: join(home, STORAGE_DIRECTORY) });
  return temporaryChatOutput(nodeCommand(['-e', temporaryChatScript(), request]));
}

export function temporaryChatId(path: string): string | undefined {
  const id = basename(path);
  if (!id || canonicalUuid(id) !== id) return undefined;
  const parent = dirname(path);
  if (basename(parent) !== 'tmp' || basename(dirname(parent)) !== STORAGE_DIRECTORY) return undefined;
  return id;
}

export async function removeTemporaryChat(app: App, path: string, hostId: string): Promise<void> {
  if (hostId === 'local') return removeLocalTemporaryChat(homeDir(), path);
  const settings = await loadAppSettings(app); const host = remoteHost(settings, hostId);
  const id = temporaryChatId(path);
  if (!id) throw new Error('Refusing to remove a directory not created as a temporary chat');
  const request = JSON.stringify({ action: 'remove', id, path });
  const remote = `PIOP_STORAGE_DIRECTORY=${STORAGE_DIRECTORY} bun -e ${shellQuote(temporaryChatScript())} ${shellQuote(request)}`;
  try { await temporaryChatOutput(ssh(host, remoteLoginCommand(remote))); }
  catch (error: any) { throw new Error(`Could not remove temporary chat directory on ${host.name}: ${error.message}`); }
}

export async function removeLocalTemporaryChat(home: string, path: string): Promise<void> {
  const id = temporaryChatId(path);
  if (!id) throw new Error('Refusing to remove a directory not created as a temporary chat');
  const request = JSON.stringify({ action: 'remove', id, path, root: join(home, STORAGE_DIRECTORY) });
  await temporaryChatOutput(nodeCommand(['-e', temporaryChatScript(), request]));
}

export async function validateProjectDirectory(app: App, path: string, hostId: string, allowStorage: boolean | undefined): Promise<string> {
  if (!path.trim()) throw new Error("Path can't be empty");
  if (allowStorage === true) {
    await validateSessionWorkingDirectory(await loadAppSettings(app), hostId, path);
    return path;
  }
  if (hostId === 'local') return validateLocalProjectDirectory(path);
  const settings = await loadAppSettings(app); const host = remoteHost(settings, hostId);
  const script = `test -d ${shellQuote(path)} && cd ${shellQuote(path)} || exit 1; candidate=$(pwd -P); for storage in "$HOME/.piop" "$HOME/.piop-dev"; do [ ! -d "$storage" ] || storage=$(cd "$storage" && pwd -P); case "$candidate" in "$storage"|"$storage"/*) echo 'Piop storage directories cannot be selected as projects' >&2; exit 1;; esac; done; printf '%s\\n' "$candidate"`;
  let result;
  try { result = await output(ssh(host, script)); } catch (error: any) { throw new Error(`Could not validate project directory on ${host.name}: ${error.message}`); }
  if (!result.status.success) throw new Error(`Could not open project directory on ${host.name}: ${result.stderr.toString().trim()}`);
  return path;
}

export async function validateSessionWorkingDirectory(settings: AppSettings, hostId: string, cwd: string | undefined | null): Promise<void> {
  if (hostId === 'local') {
    const path = localLaunchDirectory(cwd ?? undefined);
    let stats;
    try { stats = statSync(path); } catch (error: any) { throw new Error(`Cannot start conversation: project directory ${path} is unavailable: ${error.message}`); }
    if (!stats.isDirectory()) throw new Error(`Cannot start conversation: ${path} is not a directory`);
    return;
  }
  const host = remoteHost(settings, hostId);
  const result = await runLimited(ssh(host, `cd ${remoteDirectoryPath(cwd)} && test -d .`), 64 * 1024, 'Could not check conversation directory');
  if (!result.status.success) throw new Error(`Cannot start conversation: project directory ${cwd ?? '~'} is unavailable on ${host.name}`);
}

function startsWithPath(path: string, root: string): boolean {
  const base = root.replace(/\/+$/, '');
  return path === base || path.startsWith(base + sep);
}

export function validateLocalProjectDirectory(path: string): string {
  if (!path.trim()) throw new Error("Path can't be empty");
  let stats;
  try { stats = statSync(path); } catch (error: any) { throw new Error(`Could not open project directory: ${error.message}`); }
  if (!stats.isDirectory()) throw new Error('Project path is not a directory');
  let canonical: string;
  try { canonical = realpathSync(path); } catch (error: any) { throw new Error(`Could not open project directory: ${error.message}`); }
  const home = homeDir();
  for (const name of ['.piop', '.piop-dev']) {
    const storage = join(home, name);
    let resolved = storage;
    try { resolved = realpathSync(storage); } catch {}
    if (startsWithPath(path, storage) || startsWithPath(canonical, resolved)) throw new Error('Piop storage directories cannot be selected as projects');
  }
  return path;
}

export async function createTemporaryChat(app: App, hostId: string): Promise<TemporaryChat> {
  const settings = await loadAppSettings(app);
  const sessionId = await reserveSessionId(settings, hostId);
  let cwd: string;
  if (hostId === 'local') cwd = await createLocalTemporaryChat(homeDir(), sessionId);
  else {
    const host = remoteHost(await loadAppSettings(app), hostId);
    if (!canonicalUuid(sessionId)) throw new Error('Invalid temporary chat session ID');
    const request = JSON.stringify({ action: 'create', id: sessionId });
    const remote = `PIOP_STORAGE_DIRECTORY=${STORAGE_DIRECTORY} bun -e ${shellQuote(temporaryChatScript())} ${shellQuote(request)}`;
    try { cwd = await temporaryChatOutput(ssh(host, remoteLoginCommand(remote))); }
    catch (error: any) { throw new Error(`Could not create temporary chat directory on ${host.name}: ${error.message}`); }
    if (!cwd) throw new Error('Remote temporary chat directory was unavailable');
  }
  return { cwd, sessionId };
}

export async function listDirectories(app: App, hostId: string, path: string | undefined | null): Promise<DirectoryListing> {
  if (hostId === 'local') return listLocalDirectories(homeDir(), path ?? undefined);
  const settings = await loadAppSettings(app); const host = remoteHost(settings, hostId);
  let result;
  try { result = await output(ssh(host, remoteDirectoryListingScript(path ?? undefined))); } catch (error: any) { throw new Error(`Could not browse ${host.name}: ${error.message}`); }
  if (!result.status.success) throw new Error(result.stderr.toString().trim());
  return parseRemoteDirectories(result.stdout);
}

function parentOf(path: string): string | null { const parent = dirname(path); return parent === path ? null : parent; }

function sortLowercase(values: string[]): string[] {
  return values.map(value => [value.toLowerCase(), value] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
}

export function listLocalDirectories(home: string, path: string | undefined): DirectoryListing {
  const requested = path && path.trim() ? path : home;
  let current: string;
  try { current = realpathSync(requested); } catch (error: any) { throw new Error(`Could not browse ${requested}: ${error.message}`); }
  let stats;
  try { stats = statSync(current); } catch { stats = undefined; }
  if (!stats?.isDirectory()) throw new Error(`${current} is not a directory`);
  let entries;
  try { entries = readdirSync(current, { withFileTypes: true }); } catch (error: any) { throw new Error(`Could not browse ${current}: ${error.message}`); }
  const directories = entries.filter(entry => {
    if (!entry.isSymbolicLink()) return entry.isDirectory();
    try { return statSync(join(current, entry.name)).isDirectory(); } catch { return false; }
  }).map(entry => join(current, entry.name));
  return { path: current, parent: parentOf(current), directories: sortLowercase(directories) };
}

export function remoteDirectoryListingScript(path: string | undefined): string {
  return `cd ${remoteDirectoryPath(path)} && printf '%s\\000' "$PWD" && find . -mindepth 1 -maxdepth 1 -type d -printf '%f\\000'`;
}

export function parseRemoteDirectories(bytes: Buffer): DirectoryListing {
  const parts = bytes.toString('utf8').split('\0').filter(part => part.length > 0);
  const first = parts.shift();
  if (first === undefined) throw new Error('Remote directory was unavailable');
  const directories = parts.map(name => join(first, name));
  return { path: first, parent: parentOf(first), directories: sortLowercase(directories) };
}

export function collectSessions(app: App, index: SessionIndexRuntime): Promise<SessionSummary[]> { return peers.allSummaries(app, index); }

export async function collectHostSessions(sessions: SessionSummary[], hosts: RemoteHost[], list: (host: RemoteHost) => Promise<SessionSummary[]>, assign: (sessions: SessionSummary[]) => Promise<void> | void): Promise<SessionSummary[]> {
  const queue = hosts.filter(host => host.enabled);
  const workers = Math.min(MAX_REMOTE_HOSTS, 4, queue.length);
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const host = queue.pop();
      if (!host) return;
      try { sessions.push(...await list(host)); } catch {}
    }
  }));
  await assign(sessions);
  sessions.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return sessions;
}

export function listSessions(app: App, index: SessionIndexRuntime): Promise<SessionSummary[]> { return collectSessions(app, index); }
