import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homeDir, isDirectory } from './environment';
import { ensureDesktopSessionsDir } from './process_io';
import * as Registry from './session_registry';
import * as peers from './peers';
import { profileRoot } from './host_operations';
import { Mutex } from './util/sync';
import { transaction, type Database } from './util/db';
import type { SessionSummary } from './types';
import type { App } from './app';

const STORAGE_LOCK = new Mutex();
const DIRLESS_KEY = '__pi-desktop-dirless__';

export interface SessionGroup { id: string; name: string; cwd: string | null; hostId: string | null; hostName: string | null }

export interface SessionGroups {
  groups: SessionGroup[];
  parents: Map<string, string>;
  assignments: Map<string, string | null>;
  removedProjects: Set<string>;
}

/** A chat the client lists. parentKey names the chat it was branched from; the branch then takes that chat's group. */
export interface SessionSeed { sessionKey: string; project: SessionGroup; parentKey?: string }

export type GroupChange =
  | { type: 'create'; name: string }
  | { type: 'project'; project: SessionGroup; key?: string | null }
  | { type: 'relocate'; project: SessionGroup; key: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'remove'; id: string }
  | { type: 'assign'; key: string; group?: string | null }
  | { type: 'move'; id: string; parent?: string | null };

function emptyGroups(): SessionGroups { return { groups: [], parents: new Map(), assignments: new Map(), removedProjects: new Set() }; }

export function serializeGroups(state: SessionGroups): any {
  return { groups: state.groups.map(group => ({ id: group.id, name: group.name, cwd: group.cwd, hostId: group.hostId, hostName: group.hostName })),
    parents: Object.fromEntries(state.parents), assignments: Object.fromEntries(state.assignments), removedProjects: [...state.removedProjects] };
}

function optionalText(value: any, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`invalid type for ${field}: expected a string`);
  return value;
}

export function parseGroup(value: any): SessionGroup {
  if (!value || typeof value !== 'object') throw new Error('invalid type: expected struct SessionGroup');
  if (typeof value.id !== 'string') throw new Error('missing field `id`');
  if (typeof value.name !== 'string') throw new Error('missing field `name`');
  return { id: value.id, name: value.name, cwd: optionalText(value.cwd, 'cwd'), hostId: optionalText(value.hostId, 'hostId'), hostName: optionalText(value.hostName, 'hostName') };
}

export function parseSeed(value: any): SessionSeed {
  if (typeof value?.sessionKey !== 'string') throw new Error('missing field `sessionKey`');
  const parentKey = optionalText(value.parentKey, 'parentKey');
  if (parentKey === value.sessionKey) throw new Error('A chat cannot be branched from itself');
  return { sessionKey: value.sessionKey, project: parseGroup(value.project), ...(parentKey ? { parentKey } : {}) };
}

export function parseChange(value: any): GroupChange {
  const text = (key: string) => { if (typeof value?.[key] !== 'string') throw new Error(`missing field \`${key}\``); return value[key] as string; };
  switch (value?.type) {
    case 'create': return { type: 'create', name: text('name') };
    case 'project': return { type: 'project', project: parseGroup(value.project), key: optionalText(value.key, 'key') };
    case 'relocate': return { type: 'relocate', project: parseGroup(value.project), key: text('key') };
    case 'rename': return { type: 'rename', id: text('id'), name: text('name') };
    case 'remove': return { type: 'remove', id: text('id') };
    case 'assign': return { type: 'assign', key: text('key'), group: optionalText(value.group, 'group') };
    case 'move': return { type: 'move', id: text('id'), parent: optionalText(value.parent, 'parent') };
    default: throw new Error(`unknown variant \`${value?.type}\``);
  }
}

function storagePath(): string { return join(ensureDesktopSessionsDir(homeDir()), 'groups.json'); }

function database(path: string): Database {
  const parent = join(path, '..');
  const root = parent.endsWith('/sessions') ? join(parent, '..') : parent;
  const connection = Registry.open(root);
  try {
    connection.exec('CREATE TABLE IF NOT EXISTS session_group_parents (group_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL)');
    connection.exec('INSERT INTO session_group_state VALUES (1, 0) ON CONFLICT DO NOTHING');
  } catch (error) { connection.close(); throw error; }
  return connection;
}

function read(path: string): SessionGroups | undefined {
  const connection = database(path);
  try { return transaction(connection, 'DEFERRED', () => readWith(connection)); }
  finally { connection.close(); }
}

/**
 * Reads the groups, lets change edit them, and saves what change returns as save, in one database transaction.
 * The transaction keeps other writers out, so no lock file is needed.
 */
function update<T>(path: string, change: (stored: SessionGroups | undefined) => { save?: SessionGroups; value: T }): T {
  const connection = database(path);
  try {
    return transaction(connection, 'IMMEDIATE', () => {
      const { save, value } = change(readWith(connection));
      if (save) writeWith(connection, save);
      return value;
    });
  } finally { connection.close(); }
}

function readWith(connection: Database): SessionGroups | undefined {
      const state = connection.prepare('SELECT initialized FROM session_group_state WHERE id=1').get() as { initialized: number };
      if (!state.initialized) return undefined;
      const groups = (connection.prepare('SELECT group_id, name, cwd, host_id, host_name FROM session_groups ORDER BY position, group_id').all() as any[])
        .map(row => ({ id: row.group_id, name: row.name, cwd: row.cwd ?? null, hostId: row.host_id ?? null, hostName: row.host_name ?? null }));
      const assignments = new Map((connection.prepare('SELECT session_key, group_id FROM session_group_assignments').all() as any[]).map(row => [row.session_key as string, (row.group_id ?? null) as string | null]));
      const removedProjects = new Set((connection.prepare('SELECT project_id FROM session_group_removed_projects').all() as any[]).map(row => row.project_id as string));
      const parents = new Map((connection.prepare('SELECT group_id, parent_id FROM session_group_parents').all() as any[]).map(row => [row.group_id as string, row.parent_id as string]));
      return { groups, parents, assignments, removedProjects };
}

function writeWith(connection: Database, groups: SessionGroups): void {
      connection.exec('DELETE FROM session_groups; DELETE FROM session_group_parents; DELETE FROM session_group_assignments; DELETE FROM session_group_removed_projects;');
      const insertGroup = connection.prepare('INSERT INTO session_groups (group_id, position, name, cwd, host_id, host_name) VALUES (?, ?, ?, ?, ?, ?)');
      groups.groups.forEach((group, position) => insertGroup.run(group.id, position, group.name, group.cwd, group.hostId, group.hostName));
      const assign = connection.prepare('INSERT INTO session_group_assignments VALUES (?, ?)');
      for (const [key, group] of groups.assignments) assign.run(key, group);
      const parent = connection.prepare('INSERT INTO session_group_parents VALUES (?, ?)');
      for (const [id, value] of groups.parents) parent.run(id, value);
      const removed = connection.prepare('INSERT INTO session_group_removed_projects VALUES (?)');
      for (const project of groups.removedProjects) removed.run(project);
      connection.exec('UPDATE session_group_state SET initialized=1 WHERE id=1');
}

/** Returns the session IDs registered on the machine. Other machines answer through their Piop daemon. */
async function discover(app: App, hostId: string): Promise<string[]> {
  try {
    if (hostId === 'local') return Registry.ids(profileRoot());
    const value = await (await peers.connect(app, hostId)).invoke('session_ids', {});
    if (!Array.isArray(value) || !value.every(id => typeof id === 'string' && id)) throw new Error('Invalid session ID list');
    return value;
  }
  catch (error: any) { throw new Error(`Could not read current session IDs: ${error?.message ?? error}`); }
}

function hostOf(key: string): string | undefined { const index = key.lastIndexOf(':'); return index >= 0 ? key.slice(0, index) : undefined; }

/**
 * Removes assignments of sessions that no longer exist. Hosts are asked in parallel and without any lock held,
 * so a slow machine does not block other group and session reads. Only assignments that existed before the
 * hosts were asked can be removed, so a session created during the check keeps its assignment.
 */
async function refreshDeletionsAt(path: string, app: App, seeds: SessionSeed[], key: string | undefined): Promise<void> {
  const snapshot = read(path) ?? emptyGroups();
  const hosts = new Set<string>(['local']);
  for (const item of [...snapshot.assignments.keys(), ...seeds.map(seed => seed.sessionKey)]) { const host = hostOf(item); if (host !== undefined) hosts.add(host); }
  if (key !== undefined) { const host = hostOf(key); if (host !== undefined) hosts.add(host); }
  const live = new Map<string, Set<string>>();
  await Promise.all([...hosts].map(async host => {
    try { live.set(host, new Set(await discover(app, host))); }
    catch (error: any) { console.error(`Session group cleanup for ${host} will retry: ${error.message ?? error}`); }
  }));
  const stale: string[] = [];
  for (const assignment of snapshot.assignments.keys()) {
    const host = hostOf(assignment);
    const ids = host === undefined ? undefined : live.get(host);
    if (ids && !ids.has(assignment.slice(host!.length + 1))) stale.push(assignment);
  }
  if (stale.length === 0) return;
  update(path, state => {
    if (!state) return { value: undefined };
    let removed = false;
    for (const assignment of stale) removed = state.assignments.delete(assignment) || removed;
    return { save: removed ? state : undefined, value: undefined };
  });
}

function changeKey(change: GroupChange): string | undefined {
  if (change.type === 'project') return change.key ?? undefined;
  if (change.type === 'relocate' || change.type === 'assign') return change.key;
  return undefined;
}

/**
 * The folder of the registered project named name on this machine, for a new peer of the chat sessionKey in folder cwd.
 * Fails when no such project is registered or when it is the chat's own project.
 */
export async function peerProjectFolder(name: string, sessionKey: string, cwd: string): Promise<string> {
  const state = await STORAGE_LOCK.run(() => read(storagePath()));
  const projects = (state?.groups ?? []).filter(group => group.cwd !== null && group.hostId === 'local');
  const wanted = name.trim().toLowerCase();
  const project = projects.find(group => group.name.trim().toLowerCase() === wanted);
  if (!project) throw new Error('Piop has no project named ' + name);
  const assigned = state?.assignments.get(sessionKey);
  const own = projects.find(group => group.id === assigned) ?? projects.find(group => group.cwd === cwd);
  if (own?.id === project.id) throw new Error(name + ' is your own project; omit project to use it');
  if (!isDirectory(project.cwd!)) throw new Error('The folder of project ' + name + ' no longer exists: ' + project.cwd);
  return project.cwd!;
}

export async function attachAssignments(sessions: SessionSummary[]): Promise<void> {
  await STORAGE_LOCK.run(() => {
    const state = read(storagePath());
    if (!state) return;
    for (const session of sessions) session.groupId = state.assignments.get(`${session.hostId}:${session.id}`) ?? null;
  });
}

export async function loadSessionGroups(app: App, seeds: SessionSeed[]): Promise<SessionGroups> {
  const path = storagePath();
  await refreshDeletionsAt(path, app, seeds, undefined);
  return STORAGE_LOCK.run(async () => (await loadAt(path, seeds)).state);
}

/** Temporary chat folders are named with a random (version 4) UUID. */
const TEMPORARY_CHAT_CWD = /(?:^|\/)\.piop(?:-dev)?\/tmp\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/?$/i;

/**
 * A listed chat in an existing project folder. Temporary chat folders and chats with no message are not projects.
 * A branch takes its source's group; a branch whose source is not listed is a chat of its own.
 */
function projectSeed(session: SessionSummary, listed: Set<string>): SessionSeed | undefined {
  if (session.messageCount === 0 || !session.cwdExists || !session.cwd || TEMPORARY_CHAT_CWD.test(session.cwd)) return undefined;
  const parentKey = session.forkSourceId ? `${session.hostId}:${session.forkSourceId}` : undefined;
  return {
    sessionKey: `${session.hostId}:${session.id}`,
    project: { id: `${session.hostId}:${session.cwd}`, name: session.project, cwd: session.cwd, hostId: session.hostId, hostName: session.hostName },
    ...(parentKey && listed.has(parentKey) ? { parentKey } : {}),
  };
}

/**
 * Registers the project of each listed chat that has no assignment yet, and reports a change to clients.
 * The groups are written only when such a chat shows up. A removed project stays removed.
 */
export async function registerProjects(app: App, sessions: SessionSummary[]): Promise<void> {
  const listed = new Set(sessions.map(session => `${session.hostId}:${session.id}`));
  const known = await STORAGE_LOCK.run(() => read(storagePath())?.assignments);
  const seeds = sessions.filter(session => !known?.has(`${session.hostId}:${session.id}`))
    .map(session => projectSeed(session, listed)).filter((seed): seed is SessionSeed => seed !== undefined);
  if (!seeds.length) return;
  const result = await STORAGE_LOCK.run(() => loadAt(storagePath(), seeds));
  if (result.dirty) app.emit('pi://groups-changed', serializeGroups(result.state));
}

function updateSeedMetadata(state: SessionGroups, seed: SessionSeed): boolean {
  let dirty = false;
  for (const group of state.groups.filter(group => group.hostId === seed.project.hostId)) {
    if (group.hostName !== seed.project.hostName) { group.hostName = seed.project.hostName; dirty = true; }
  }
  return dirty;
}

function assignSeed(state: SessionGroups, seed: SessionSeed): boolean {
  if (state.assignments.has(seed.sessionKey)) return false;
  if (state.removedProjects.has(seed.project.id)) { state.assignments.set(seed.sessionKey, null); return true; }
  if (!state.groups.some(group => group.id === seed.project.id)) state.groups.unshift({ ...seed.project });
  state.assignments.set(seed.sessionKey, seed.project.id);
  return true;
}

/**
 * Gives each new branch the group its source chat has: a project group, a custom group or no group. The branch's own
 * folder never makes a group. A branch whose source has no assignment yet waits for a later load.
 */
function inheritSeeds(state: SessionGroups, branches: SessionSeed[]): boolean {
  let dirty = false;
  let waiting = branches.filter(seed => !state.assignments.has(seed.sessionKey));
  while (waiting.length) {
    const next = waiting.filter(seed => !state.assignments.has(seed.parentKey!));
    for (const seed of waiting) {
      if (!state.assignments.has(seed.parentKey!)) continue;
      state.assignments.set(seed.sessionKey, state.assignments.get(seed.parentKey!) ?? null);
      dirty = true;
    }
    if (next.length === waiting.length) break;
    waiting = next;
  }
  return dirty;
}

function hasMissingLocalFolder(seed: SessionSeed): boolean {
  return seed.project.hostId === 'local' && typeof seed.project.cwd === 'string' && !isDirectory(seed.project.cwd);
}

function loadAt(path: string, allSeeds: SessionSeed[]): { state: SessionGroups; dirty: boolean } {
  const seeds = allSeeds.filter(seed => !hasMissingLocalFolder(seed));
  return update(path, stored => {
    let dirty = stored === undefined;
    const state = stored ?? emptyGroups();
    for (const seed of seeds) {
      dirty = updateSeedMetadata(state, seed) || dirty;
      if (seed.parentKey === undefined) dirty = assignSeed(state, seed) || dirty;
    }
    dirty = inheritSeeds(state, seeds.filter(seed => seed.parentKey !== undefined)) || dirty;
    const ids = new Set(state.groups.map(group => group.id));
    for (const [key, destination] of state.assignments) {
      if (destination !== null && (destination === DIRLESS_KEY || !ids.has(destination))) { state.assignments.set(key, null); dirty = true; }
    }
    return { save: dirty ? state : undefined, value: { state, dirty } };
  });
}

export async function changeSessionGroups(app: App, change: GroupChange): Promise<SessionGroups> {
  const path = storagePath();
  await refreshDeletionsAt(path, app, [], changeKey(change));
  return STORAGE_LOCK.run(async () => {
    const state = await changeAt(storagePath(), change);
    app.emit('pi://groups-changed', serializeGroups(state));
    return state;
  });
}

export async function refreshDeletions(app: App, hostId: string): Promise<void> {
  const path = storagePath();
  await refreshDeletionsAt(path, app, [], `${hostId}:`);
  await STORAGE_LOCK.run(async () => {
    const state = read(path);
    if (state) app.emit('pi://groups-changed', serializeGroups(state));
  });
}

function changeAt(path: string, change: GroupChange): SessionGroups {
  return update(path, state => {
    if (!state) throw new Error('Session groups have not loaded yet');
    applyGroupChange(state, change);
    validateNesting(state);
    return { save: state, value: state };
  });
}

function applyGroupChange(state: SessionGroups, change: GroupChange): void {
  switch (change.type) {
    case 'relocate': relocateGroup(state, change.project, change.key); break;
    case 'project': projectGroup(state, change.project, change.key ?? undefined); break;
    case 'create': createGroup(state, change.name); break;
    case 'rename': renameGroup(state, change.id, change.name); break;
    case 'remove': removeGroup(state, change.id); break;
    case 'assign': assignGroup(state, change.key, change.group ?? null); break;
    case 'move': moveGroup(state, change.id, change.parent ?? null); break;
  }
}

function relocateGroup(state: SessionGroups, project: SessionGroup, key: string): void {
  if (!project.cwd) throw new Error('Enter a project directory');
  const hasPrevious = state.assignments.has(key);
  const oldId = state.assignments.get(key) ?? null;
  const automatic = oldId !== null && state.groups.some(group => group.id === oldId && group.cwd !== null);
  if (!hasPrevious || automatic) {
    state.removedProjects.delete(project.id);
    state.assignments.set(key, project.id);
    if (!state.groups.some(group => group.id === project.id)) state.groups.unshift({ ...project });
    if (oldId !== null && ![...state.assignments.values()].some(id => id === oldId)) {
      state.groups = state.groups.filter(group => group.id !== oldId);
      for (const [id, parent] of [...state.parents]) if (id === oldId || parent === oldId) state.parents.delete(id);
    }
  }
}

function projectGroup(state: SessionGroups, project: SessionGroup, key: string | undefined): void {
  if (!project.cwd?.trim()) throw new Error('Enter a project directory');
  state.removedProjects.delete(project.id);
  if (key !== undefined) state.assignments.set(key, project.id);
  if (!state.groups.some(group => group.id === project.id)) state.groups.unshift({ ...project });
}

function createGroup(state: SessionGroups, raw: string): void {
  const name = raw.trim();
  if (!name) throw new Error('Enter a group name');
  if (state.groups.some(group => group.name.toLowerCase() === name.toLowerCase())) throw new Error('A group already uses that name');
  state.groups.unshift({ id: `__pi-desktop-custom-group__:${randomUUID()}`, name, cwd: null, hostId: null, hostName: null });
}

function renameGroup(state: SessionGroups, id: string, raw: string): void {
  const name = raw.trim();
  if (!name) throw new Error('Enter a group name');
  if (state.groups.some(group => group.id !== id && group.name.toLowerCase() === name.toLowerCase())) throw new Error('A group already uses that name');
  const group = state.groups.find(group => group.id === id);
  if (!group) throw new Error('Group no longer exists');
  group.name = name;
}

/** Removing a project group keeps it removed: chats listed later in its folder get no group until the user adds the project again. */
function removeGroup(state: SessionGroups, id: string): void {
  const removed = state.groups.find(group => group.id === id);
  if (!removed) throw new Error('Group no longer exists');
  if (removed.cwd) state.removedProjects.add(id);
  state.groups = state.groups.filter(group => group.id !== id);
  for (const [child, parent] of [...state.parents]) if (child === id || parent === id) state.parents.delete(child);
  for (const [key, destination] of state.assignments) if (destination === id) state.assignments.set(key, null);
}

function assignGroup(state: SessionGroups, key: string, group: string | null): void {
  if (group === DIRLESS_KEY) throw new Error("Dirless is assigned automatically when a chat's working directory is missing");
  if (group !== null && !state.groups.some(item => item.id === group)) throw new Error('Group no longer exists');
  state.assignments.set(key, group);
}

function moveGroup(state: SessionGroups, id: string, parent: string | null): void {
  if (!state.groups.some(group => group.id === id)) throw new Error('Group no longer exists');
  if (parent !== null) state.parents.set(id, parent); else state.parents.delete(id);
}

function validateNesting(state: SessionGroups): void {
  const groups = new Map(state.groups.map(group => [group.id, group]));
  for (const [id, parent] of state.parents) {
    if (!groups.has(id)) throw new Error('Group no longer exists');
    if (groups.get(parent)?.cwd !== null || !groups.has(parent)) throw new Error('Groups can only nest inside custom groups');
    let cursor: string | undefined = id;
    const seen = new Set<string>();
    let depth = 0;
    while (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error('A group cannot be moved inside itself or its children');
      seen.add(cursor);
      if (groups.has(cursor) && groups.get(cursor)!.cwd === null) depth += 1;
      if (depth > 3) throw new Error('Groups cannot exceed three levels');
      cursor = state.parents.get(cursor);
    }
  }
}
