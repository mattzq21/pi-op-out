import { z } from 'zod';
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { DEFAULT_TIMEOUT, hostOperation, runHostOperation, STORAGE_TIMEOUT } from './host_operations';
import { requireLocal } from './host_connection';
import { localLaunchDirectory, remoteDirectoryPath, remoteHost, ssh } from './pi_launch';
import { output, runLimited, shellQuote } from './process_io';
import { inspectSessionProjectsWith } from './folder_inspection';
import { ProjectMetadataCache } from './project_metadata';
import { refreshProjectRepository } from './project_repositories';
import * as sidebarStorage from './sidebar_storage';
import * as Registry from './session_registry';
import * as restoreRecovery from './restore_recovery';
import { loadAppSettings } from './settings';
import { type AppSettings, type RemoteHost } from './settings_types';
import { canonicalUuid } from './session_worker';
import { transaction } from './util/db';
import { Mutex } from './util/sync';
import * as peers from './peers';
import { reserveSessionId } from './pi_runtime';
import type { SessionSummary } from './types';
import type { App } from './app';

/** blank: the transcript has no user message and no name yet, as when Pi runs for a draft. The sidebar leaves it out. */
export interface CachedSession { fingerprint: string; summary: SessionSummary; blank?: boolean }
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

const sessionSummarySchema = z.object({
  path: z.string().min(1), id: z.string().min(1), cwd: z.string(), name: z.string(), preview: z.string(),
  messageCount: z.number().int().nonnegative(), lastMessageAt: z.number().nonnegative(), apiCost: z.number().nonnegative(),
  explicitlyNamed: z.boolean(), hasUserMessage: z.boolean(), bytes: z.number().int().nonnegative(),
  subagentParentId: z.string().min(1).optional(),
  forkSourceId: z.string().min(1).optional(),
});
const indexSessions = hostOperation<{ paths: string[] }, { summaries: z.infer<typeof sessionSummarySchema>[]; warnings: string[] }>('index-sessions', 'general', STORAGE_TIMEOUT,
  value => z.object({ summaries: z.array(sessionSummarySchema), warnings: z.array(z.string()) }).parse(value));

/** Transcript bytes and files read by one index operation, so each operation ends well inside its time limit. */
const INDEX_BATCH_BYTES = 128 * 1024 * 1024;
const INDEX_BATCH_FILES = 500;

function indexBatches(candidates: SessionCandidate[]): SessionCandidate[][] {
  const batches: SessionCandidate[][] = [];
  let batch: SessionCandidate[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    if (batch.length && (batch.length >= INDEX_BATCH_FILES || bytes + candidate[3] > INDEX_BATCH_BYTES)) { batches.push(batch); batch = []; bytes = 0; }
    batch.push(candidate);
    bytes += candidate[3];
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** Reads summaries in batches. onBatch receives each batch as it finishes, so a later failure keeps the earlier results. */
export async function readSessionSummaries(candidates: SessionCandidate[], onBatch?: (paths: string[], summaries: Map<string, CachedSession>) => void): Promise<Map<string, CachedSession>> {
  const result = new Map<string, CachedSession>();
  for (const batch of indexBatches(candidates)) {
    const summaries = await readSummaryBatch(batch);
    onBatch?.(batch.map(item => item[0]), summaries);
    for (const [path, summary] of summaries) result.set(path, summary);
  }
  return result;
}

async function readSummaryBatch(candidates: SessionCandidate[]): Promise<Map<string, CachedSession>> {
  const result = new Map<string, CachedSession>();
  const items = new Map(candidates.map(item => [item[0], item]));
  const paths = [...items.keys()];
  if (!paths.length) return result;
  const { summaries, warnings } = await runHostOperation(indexSessions, { paths });
  for (const warning of warnings) console.error(`Session index: ${warning}`);
  for (const value of summaries) {
    const item = items.get(value.path);
    if (!item) throw new Error(`Unexpected session summary path: ${value.path}`);
    const summary: SessionSummary = {
      groupId: null, subagentParentId: value.subagentParentId, forkSourceId: value.forkSourceId,
      id: value.id, path: value.path, name: value.name, project: basename(value.cwd) || 'Workspace', cwd: value.cwd, cwdExists: true,
      modifiedAt: item[2], preview: value.preview, messageCount: value.messageCount, lastMessageAt: value.lastMessageAt, apiCost: value.apiCost,
      hostId: 'local', hostName: 'Local',
    };
    result.set(value.path, { fingerprint: item[1], summary, blank: !value.hasUserMessage && !value.explicitlyNamed });
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
    try { needsSave = (await refreshLocalCache(root, cache)) || needsSave; }
    catch (error) {
      // Keep the batches that finished, so the next listing continues from them.
      sidebarStorage.persist(index.sidebar, cache);
      throw error;
    }
    if (needsSave) sidebarStorage.persist(index.sidebar, cache);
    return [...cache.values()].filter(cached => !cached.blank).map(cached => ({ ...cached.summary }));
  });
}

async function refreshLocalCache(root: string, cache: Map<string, CachedSession>): Promise<boolean> {
  const [seen, changed] = localSessionCandidates(root, cache);
  const needsSave = changed.length > 0 || [...cache.keys()].some(path => !seen.has(path));
  await readSessionSummaries(changed, (paths, summaries) => {
    for (const path of paths) cache.delete(path);
    for (const [path, summary] of summaries) cache.set(path, summary);
  });
  for (const path of [...cache.keys()]) if (!seen.has(path)) cache.delete(path);
  return needsSave;
}

function localSessionCandidates(root: string, cache: Map<string, CachedSession>): [Set<string>, SessionCandidate[]] {
  const seen = new Set<string>(); const changed: SessionCandidate[] = [];
  const database = Registry.open(dirname(root));
  try {
    // Pi records paths under the configured root, while archive and restore record resolved paths. Both name the same folder when it contains a symbolic link.
    const prefix = root.replace(/\/+$/, '') + sep;
    let resolved = prefix;
    try { resolved = realpathSync(root) + sep; } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    const rows = database.prepare(`SELECT s.session_path AS path, m.modified_ns AS modified, m.size AS size, n.entry_json AS name, b.session_id AS branch_session, b.tip_id AS branch_tip, b.leaf_id AS branch_leaf FROM sessions s LEFT JOIN session_branch_selection b ON b.session_id=s.session_id LEFT JOIN session_extension_state n ON n.session_id=s.session_id AND n.state_key='piop-session-name' LEFT JOIN session_file_metadata m ON m.session_id=s.session_id AND m.session_path=s.session_path WHERE substr(s.session_path, 1, length(?1))=?1 OR substr(s.session_path, 1, length(?2))=?2`).all(prefix, resolved) as any[];
    for (const row of rows) {
      const path: string = row.path;
      const saved = row.modified !== null && row.modified !== undefined && row.size !== null && row.size !== undefined ? [String(row.modified), Number(row.size)] as const : undefined;
      const candidate = saved ? registeredCandidate(path, saved) : captureLocalCandidate(database, path);
      if (!candidate) continue;
      candidate[1] += ':' + (row.name ?? '') + ':' + JSON.stringify([row.branch_session, row.branch_tip, row.branch_leaf]);
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

type TemporaryChatRequest = { action: 'create' | 'remove'; id: string; path?: string; root: string };

const temporaryChatOperation = hostOperation<TemporaryChatRequest, string | null>('temporary-chat', 'general', DEFAULT_TIMEOUT, value => {
  if (value !== null && typeof value !== 'string') throw new Error('expected a directory');
  return value;
});

export async function createLocalTemporaryChat(home: string, sessionId: string): Promise<string> {
  let directory: string | null;
  try { directory = await runHostOperation(temporaryChatOperation, { action: 'create', id: sessionId, root: join(home, STORAGE_DIRECTORY) }); }
  catch (error: any) { throw new Error(`Could not create temporary chat directory: ${error?.message ?? error}`); }
  if (!directory) throw new Error('Could not create temporary chat directory: it was unavailable');
  return directory;
}

export function temporaryChatId(path: string): string | undefined {
  const id = basename(path);
  if (!id || canonicalUuid(id) !== id) return undefined;
  const parent = dirname(path);
  if (basename(parent) !== 'tmp' || basename(dirname(parent)) !== STORAGE_DIRECTORY) return undefined;
  return id;
}

export async function removeTemporaryChat(app: App, path: string, hostId: string): Promise<void> {
  requireLocal(hostId);
  return removeLocalTemporaryChat(homeDir(), path);
}

export async function removeLocalTemporaryChat(home: string, path: string): Promise<void> {
  const id = temporaryChatId(path);
  if (!id) throw new Error('Refusing to remove a directory not created as a temporary chat');
  try { await runHostOperation(temporaryChatOperation, { action: 'remove', id, path, root: join(home, STORAGE_DIRECTORY) }); }
  catch (error: any) { throw new Error(`Could not remove temporary chat directory: ${error?.message ?? error}`); }
}

export async function validateProjectDirectory(app: App, path: string, hostId: string, allowStorage: boolean | undefined, newChat = false): Promise<string> {
  if (!path.trim()) throw new Error("Path can't be empty");
  if (allowStorage === true) {
    await validateSessionWorkingDirectory(await loadAppSettings(app), hostId, path);
    if (newChat && hostId === 'local') await refreshProjectRepository(join(homeDir(), STORAGE_DIRECTORY), path);
    return path;
  }
  if (hostId === 'local') {
    const cwd = validateLocalProjectDirectory(path);
    await refreshProjectRepository(join(homeDir(), STORAGE_DIRECTORY), cwd);
    return cwd;
  }
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
  requireLocal(hostId);
  const settings = await loadAppSettings(app);
  const sessionId = await reserveSessionId(settings, hostId);
  const cwd = await createLocalTemporaryChat(homeDir(), sessionId);
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

export function collectSessions(app: App, index: SessionIndexRuntime, waitForRemote = false): Promise<SessionSummary[]> { return peers.allSummaries(app, index, waitForRemote); }

export function listSessions(app: App, index: SessionIndexRuntime): Promise<SessionSummary[]> { return collectSessions(app, index); }
