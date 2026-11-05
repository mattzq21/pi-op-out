import { z } from 'zod';
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { STORAGE_DIRECTORY } from './config';
import { homeDir } from './environment';
import { DEFAULT_TIMEOUT, hostOperation, runHostOperation, STORAGE_TIMEOUT } from './host_operations';
import { localLaunchDirectory, remoteDirectoryPath, remoteHost, ssh } from './pi_launch';
import { output, shellQuote } from './process_io';
import { inspectSessionProjectsWith } from './folder_inspection';
import { ProjectMetadataCache } from './project_metadata';
import { refreshProjectRepository } from './project_repositories';
import * as sidebarStorage from './sidebar_storage';
import * as Registry from './session_registry';
import * as WorktreeRecords from '../resources/chat-worktree-records.cjs';
import { loadAppSettings } from './settings';
import type { RemoteHost } from './settings_types';
import { Mutex, isMissing } from './util/sync';
import * as peers from './peers';
import { reserveSessionId } from './pi_runtime';
import type { SessionSummary } from './types';
import type { App } from './app';

// A summary of a saved chat, made from the given revision of it.
export interface CachedSession { revision: number; summary: SessionSummary; blank?: boolean }
type SessionCandidate = [path: string, revision: number, size: number];

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
  explicitlyNamed: z.boolean(), hasUserMessage: z.boolean(), bytes: z.number().int().nonnegative(), modifiedAt: z.number().nonnegative(),
  auxiliaryParentId: z.string().min(1).optional(),
  auxiliaryKind: z.string().min(1).optional(),
  forkSourceId: z.string().min(1).optional(),
  forkEntryId: z.string().min(1).optional(),
});
const indexSessions = hostOperation<{ paths: string[] }, { summaries: z.infer<typeof sessionSummarySchema>[]; warnings: string[] }>('index-sessions', 'general', STORAGE_TIMEOUT,
  z.object({ summaries: z.array(sessionSummarySchema), warnings: z.array(z.string()) }));

const INDEX_BATCH_BYTES = 128 * 1024 * 1024;
const INDEX_BATCH_FILES = 500;

function indexBatches(candidates: SessionCandidate[]): SessionCandidate[][] {
  const batches: SessionCandidate[][] = [];
  let batch: SessionCandidate[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    if (batch.length && (batch.length >= INDEX_BATCH_FILES || bytes + candidate[2] > INDEX_BATCH_BYTES)) { batches.push(batch); batch = []; bytes = 0; }
    batch.push(candidate);
    bytes += candidate[2];
  }
  if (batch.length) batches.push(batch);
  return batches;
}

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
      groupId: null, auxiliaryParentId: value.auxiliaryParentId, auxiliaryKind: value.auxiliaryKind, forkSourceId: value.forkSourceId, forkEntryId: value.forkEntryId,
      id: value.id, path: value.path, name: value.name, project: basename(value.cwd) || 'Workspace', cwd: value.cwd, cwdExists: true,
      modifiedAt: value.modifiedAt, preview: value.preview, messageCount: value.messageCount, lastMessageAt: value.lastMessageAt, apiCost: value.apiCost,
      hostId: 'local', hostName: 'Local',
    };
    result.set(value.path, { revision: item[1], summary, blank: !value.hasUserMessage && !value.explicitlyNamed });
  }
  return result;
}

export async function listLocalSessions(index: SessionIndexRuntime, root: string): Promise<SessionSummary[]> {
  const sessions = await cachedLocalSessions(index, root);
  await inspectSessionProjects(index, sessions, undefined);
  attachWorktreeRepositories(sessions, dirname(root));
  return sessions;
}

function attachWorktreeRepositories(sessions: SessionSummary[], profile: string): void {
  const records = WorktreeRecords.list(profile).sort((a, b) => Number(a.state === 'archived') - Number(b.state === 'archived'));
  for (const session of sessions) {
    const record = records.find(item => session.cwd === item.worktree || session.cwd.startsWith(item.worktree + '/'));
    if (record) session.worktreeRepository = record.repository;
  }
}

async function cachedLocalSessions(index: SessionIndexRuntime, root: string): Promise<SessionSummary[]> {
  return index.lock.run(async () => {
    const cache = index.local;
    const storageRoot = dirname(root);
    let needsSave = sidebarStorage.prepare(index.sidebar, storageRoot, cache);
    try { needsSave = (await refreshLocalCache(root, cache)) || needsSave; }
    catch (error) {
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

// The saved chats under root, and those of them whose summary is missing or older than their revision.
function localSessionCandidates(root: string, cache: Map<string, CachedSession>): [Set<string>, SessionCandidate[]] {
  const seen = new Set<string>(); const changed: SessionCandidate[] = [];
  const database = Registry.connection(dirname(root));
  const prefix = root.replace(/\/+$/, '') + sep;
  let resolved = prefix;
  try { resolved = realpathSync(root) + sep; } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  const rows = database.prepare('SELECT session_path AS path, revision FROM sessions WHERE archived=0 AND (substr(session_path, 1, length(?1))=?1 OR substr(session_path, 1, length(?2))=?2)').all(prefix, resolved) as Array<{ path: string; revision: number }>;
  for (const { path, revision } of rows) {
    if (cache.get(path)?.revision === revision) { seen.add(path); continue; }
    const size = fileSize(path);
    if (size === undefined) continue;
    seen.add(path);
    changed.push([path, revision, size]);
  }
  return [seen, changed];
}

function fileSize(path: string): number | undefined {
  let stats;
  try { stats = lstatSync(path); } catch (error: any) { if (error?.code === 'ENOENT') return undefined; throw error; }
  return stats.isFile() ? stats.size : undefined;
}

export function homeDirectory(): string {
  const home = homeDir();
  try { return realpathSync(home); } catch { return home; }
}

type TemporaryChatRequest = { action: 'create'; id: string; root: string } | { action: 'remove'; path: string; root: string };

const temporaryChatOperation = hostOperation<TemporaryChatRequest, string | null>('temporary-chat', 'general', DEFAULT_TIMEOUT, z.string().nullable());

export async function createLocalTemporaryChat(home: string, sessionId: string): Promise<string> {
  let directory: string | null;
  try { directory = await runHostOperation(temporaryChatOperation, { action: 'create', id: sessionId, root: join(home, STORAGE_DIRECTORY) }); }
  catch (error: any) { throw new Error(`Could not create temporary chat directory: ${error?.message ?? error}`); }
  if (!directory) throw new Error('Could not create temporary chat directory: it was unavailable');
  return directory;
}

export function isTemporaryChatPath(path: string): boolean {
  const parent = dirname(path);

  return /^[0-9a-f]{4,32}$/.test(basename(path)) && basename(parent) === 'tmp' && basename(dirname(parent)) === STORAGE_DIRECTORY;
}

export async function removeTemporaryChat(path: string): Promise<void> {
  return removeLocalTemporaryChat(homeDir(), path);
}

export async function removeLocalTemporaryChat(home: string, path: string): Promise<void> {
  if (!isTemporaryChatPath(path)) throw new Error('Refusing to remove a directory not created as a temporary chat');
  try { await runHostOperation(temporaryChatOperation, { action: 'remove', path, root: join(home, STORAGE_DIRECTORY) }); }
  catch (error: any) { throw new Error(`Could not remove temporary chat directory: ${error?.message ?? error}`); }
}

export async function validateProjectDirectory(path: string, allowStorage: boolean | undefined, newChat = false): Promise<string> {
  if (!path.trim()) throw new Error("Path can't be empty");
  if (allowStorage === true) {
    validateSessionWorkingDirectory(path);
    if (newChat) await refreshProjectRepository(join(homeDir(), STORAGE_DIRECTORY), path);
    return path;
  }
  const cwd = validateLocalProjectDirectory(path);
  await refreshProjectRepository(join(homeDir(), STORAGE_DIRECTORY), cwd);
  return cwd;
}

export function validateSessionWorkingDirectory(cwd: string | undefined | null): void {
  const path = localLaunchDirectory(cwd ?? undefined);
  let stats;
  try { stats = statSync(path); } catch (error: any) { throw new Error(`Cannot start conversation: project directory ${path} is unavailable: ${error.message}`); }
  if (!stats.isDirectory()) throw new Error(`Cannot start conversation: ${path} is not a directory`);
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
    try { resolved = realpathSync(storage); } catch (error) { if (!isMissing(error)) throw error; }
    if (startsWithPath(path, storage) || startsWithPath(canonical, resolved)) throw new Error('Piop storage directories cannot be selected as projects');
  }
  return path;
}

export async function createTemporaryChat(): Promise<TemporaryChat> {
  const sessionId = reserveSessionId();
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
