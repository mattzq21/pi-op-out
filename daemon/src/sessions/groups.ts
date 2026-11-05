import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { homeDir, isDirectory } from '../environment';
import { ensureDesktopSessionsDir } from '../process';
import * as Registry from './registry';
import * as peers from '../peers';
import { profileRoot } from '../host_operations';
import { Mutex } from '../util/sync';
import { replaceSessionGroupRows, sessionGroupRows, transaction } from '../../resources/session-database/index.ts';
import type { SessionSummary } from './summary';
import { listDirectories } from './listing';
import type { App } from '../app';

const STORAGE_LOCK = new Mutex();
const DIRLESS_KEY = '__pi-desktop-dirless__';
const RECENT_KEY = '__pi-desktop-ungrouped__';
const FIXED_KEYS = new Set([RECENT_KEY, DIRLESS_KEY]);
import { ORDER_SCOPES, type GroupChange, type OrderScope, type SessionGroup, type SessionSeed, type SingleGroupChange } from '../../../protocol/session-groups';

export type { GroupChange, OrderScope, SessionGroup, SessionSeed };

/** Sidebar orders. `sidebar` has one list (owner ''), `sessions` and `children` have one list per group. */
export type SessionGroupOrders = Record<OrderScope, Map<string, string[]>>;

export interface SessionGroups {
  groups: SessionGroup[];
  parents: Map<string, string>;
  assignments: Map<string, string | null>;
  removedProjects: Set<string>;
  orders: SessionGroupOrders;
}

function emptyOrders(): SessionGroupOrders { return { sidebar: new Map(), sessions: new Map(), children: new Map() }; }

function emptyGroups(): SessionGroups { return { groups: [], parents: new Map(), assignments: new Map(), removedProjects: new Set(), orders: emptyOrders() }; }

export function serializeGroups(state: SessionGroups): any {
  return { groups: state.groups.map(group => ({ id: group.id, name: group.name, cwd: group.cwd, hostId: group.hostId, hostName: group.hostName })),
    parents: Object.fromEntries(state.parents), assignments: Object.fromEntries(state.assignments), removedProjects: [...state.removedProjects],
    orders: { sidebar: state.orders.sidebar.get('') ?? [], sessions: Object.fromEntries(state.orders.sessions), children: Object.fromEntries(state.orders.children) } };
}

function storagePath(): string { return join(ensureDesktopSessionsDir(homeDir()), 'groups.json'); }

// The storage root of the groups file path.
function storageRootOf(path: string): string {
  const parent = join(path, '..');
  return parent.endsWith('/sessions') ? join(parent, '..') : parent;
}

function read(path: string): SessionGroups | undefined {
  const root = storageRootOf(path);
  return transaction(root, 'DEFERRED', () => readFrom(root));
}

function update<T>(path: string, change: (stored: SessionGroups | undefined) => { save?: SessionGroups; value: T }): T {
  const root = storageRootOf(path);
  return transaction(root, 'IMMEDIATE', () => {
    const { save, value } = change(readFrom(root));
    if (save) writeTo(root, save);
    return value;
  });
}

function readFrom(root: string): SessionGroups | undefined {
  const saved = sessionGroupRows(root);
  if (!saved) return undefined;
  const orders = emptyOrders();
  for (const row of saved.orders) {
    const lists = orders[row.scope as OrderScope];
    if (!lists) throw new Error(`Unknown sidebar order scope ${row.scope}`);
    const list = lists.get(row.owner) ?? [];
    list.push(row.token);
    lists.set(row.owner, list);
  }
  return { groups: saved.groups, parents: new Map(saved.parents), assignments: new Map(saved.assignments), removedProjects: new Set(saved.removedProjects), orders };
}

function writeTo(root: string, groups: SessionGroups): void {
  normalizeOrders(groups);
  const orders = ORDER_SCOPES.flatMap(scope => [...groups.orders[scope]].flatMap(([owner, tokens]) => tokens.map((token, position) => ({ scope, owner, position, token }))));
  replaceSessionGroupRows(root, { groups: groups.groups, assignments: groups.assignments, removedProjects: groups.removedProjects, parents: groups.parents, orders });
}

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

function orderedSessionKeys(state: SessionGroups): Set<string> {
  const keys = new Set([...state.orders.sessions.values()].flat());
  for (const tokens of state.orders.children.values()) for (const token of tokens) if (token.startsWith('session:')) keys.add(token.slice('session:'.length));
  return keys;
}

async function refreshDeletionsAt(path: string, app: App, seeds: SessionSeed[], keys: string[]): Promise<void> {
  const snapshot = read(path) ?? emptyGroups();
  const known = new Set([...snapshot.assignments.keys(), ...orderedSessionKeys(snapshot)]);
  const hosts = new Set<string>(['local']);
  for (const item of [...known, ...seeds.map(seed => seed.sessionKey), ...keys]) { const host = hostOf(item); if (host !== undefined) hosts.add(host); }
  const live = new Map<string, Set<string>>();
  await Promise.all([...hosts].map(async host => {
    try { live.set(host, new Set(await discover(app, host))); }
    catch (error: any) { console.error(`Session group cleanup for ${host} will retry: ${error.message ?? error}`); }
  }));
  const stale = new Set<string>();
  for (const key of known) {
    const host = hostOf(key);
    const ids = host === undefined ? undefined : live.get(host);
    if (ids && !ids.has(key.slice(host!.length + 1))) stale.add(key);
  }
  if (stale.size === 0) return;
  update(path, state => {
    if (!state) return { value: undefined };
    const before = JSON.stringify(serializeGroups(state));
    for (const key of stale) state.assignments.delete(key);
    for (const [owner, tokens] of state.orders.sessions) state.orders.sessions.set(owner, tokens.filter(key => !stale.has(key)));
    for (const [owner, tokens] of state.orders.children) state.orders.children.set(owner, tokens.filter(token => !token.startsWith('session:') || !stale.has(token.slice('session:'.length))));
    return { save: JSON.stringify(serializeGroups(state)) !== before ? state : undefined, value: undefined };
  });
}

function changeKeys(change: GroupChange): string[] {
  if (change.type === 'batch') return change.changes.flatMap(changeKeys);
  if (change.type === 'project') return change.key ? [change.key] : [];
  if (change.type === 'relocate' || change.type === 'assign') return [change.key];
  return [];
}

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
  await refreshDeletionsAt(path, app, seeds, []);
  return STORAGE_LOCK.run(async () => (await loadAt(path, seeds)).state);
}

const TEMPORARY_CHAT_CWD = /(?:^|\/)\.piop(?:-dev)?\/tmp\/[0-9a-f]{4,32}\/?$/i;

function projectSeed(session: SessionSummary, listed: Set<string>): SessionSeed | undefined {
  if (session.messageCount === 0 || !session.cwdExists || !session.cwd || TEMPORARY_CHAT_CWD.test(session.cwd)) return undefined;
  const parentKey = session.forkSourceId ? `${session.hostId}:${session.forkSourceId}` : undefined;
  const cwd = session.worktreeRepository ?? session.cwd;
  const name = session.worktreeRepository ? basename(cwd) || 'Workspace' : session.project;
  return {
    sessionKey: `${session.hostId}:${session.id}`,
    project: { id: `${session.hostId}:${cwd}`, name, cwd, hostId: session.hostId, hostName: session.hostName },
    ...(parentKey && listed.has(parentKey) ? { parentKey } : {}),
  };
}

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
  const existing = state.groups.find(group => group.id === seed.project.id)
    ?? state.groups.find(group => group.cwd === seed.project.cwd && group.hostId === seed.project.hostId);
  if (!existing) state.groups.unshift({ ...seed.project });
  state.assignments.set(seed.sessionKey, existing?.id ?? seed.project.id);
  return true;
}

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

async function resolveEditFolder(app: App, change: GroupChange): Promise<GroupChange> {
  if (change.type === 'batch') return { type: 'batch', changes: await Promise.all(change.changes.map(item => resolveEditFolderOf(app, item))) };
  return resolveEditFolderOf(app, change);
}

async function resolveEditFolderOf(app: App, change: SingleGroupChange): Promise<SingleGroupChange> {
  if (change.type !== 'edit') return change;
  if (!change.cwd.trim()) throw new Error('Enter a project directory');
  const group = (await STORAGE_LOCK.run(() => read(storagePath())))?.groups.find(group => group.id === change.id);
  if (!group?.cwd) throw new Error('Project no longer exists');
  return { ...change, cwd: (await listDirectories(app, group.hostId ?? 'local', change.cwd)).path };
}

export async function changeSessionGroups(app: App, requested: GroupChange): Promise<SessionGroups> {
  const path = storagePath();
  const change = await resolveEditFolder(app, requested);
  await refreshDeletionsAt(path, app, [], changeKeys(change));
  return STORAGE_LOCK.run(async () => {
    const { state, changed } = changeAt(storagePath(), change);
    if (changed) app.emit('pi://groups-changed', serializeGroups(state));
    return state;
  });
}

export async function refreshDeletions(app: App): Promise<void> {
  const path = storagePath();
  await refreshDeletionsAt(path, app, [], ['local:']);
  await STORAGE_LOCK.run(async () => {
    const state = read(path);
    if (state) app.emit('pi://groups-changed', serializeGroups(state));
  });
}

function changeAt(path: string, change: GroupChange): { state: SessionGroups; changed: boolean } {
  return update(path, state => {
    if (!state) throw new Error('Session groups have not loaded yet');
    const before = JSON.stringify(serializeGroups(state));
    applyGroupChange(state, change);
    validateNesting(state);
    normalizeOrders(state);
    const changed = JSON.stringify(serializeGroups(state)) !== before;
    return { save: changed ? state : undefined, value: { state, changed } };
  });
}

function applyGroupChange(state: SessionGroups, change: GroupChange): void {
  switch (change.type) {
    case 'batch': for (const item of change.changes) applyGroupChange(state, item); break;
    case 'order': placeOrderToken(state, change); break;
    case 'relocate': relocateGroup(state, change.project, change.key); break;
    case 'project': projectGroup(state, change.project, change.key ?? undefined); break;
    case 'create': createGroup(state, change.name); break;
    case 'rename': renameGroup(state, change.id, change.name); break;
    case 'edit': editProject(state, change.id, change.name, change.cwd); break;
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

function editProject(state: SessionGroups, id: string, name: string, cwd: string): void {
  const project = state.groups.find(group => group.id === id);
  if (!project?.cwd) throw new Error('Project no longer exists');
  if (state.groups.some(group => group.id !== id && group.cwd === cwd && group.hostId === project.hostId)) throw new Error('Another project already uses that directory');
  renameGroup(state, id, name);
  project.cwd = cwd;
  state.removedProjects.delete(`${project.hostId}:${cwd}`);
}

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
    if (!groups.has(parent)) throw new Error('Group no longer exists');
    let cursor: string | undefined = id;
    const seen = new Set<string>();
    let depth = 0;
    let projects = 0;
    while (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error('A group cannot be moved inside itself or its children');
      seen.add(cursor);
      if (groups.get(cursor)?.cwd === null) depth += 1; else projects += 1;
      if (depth > 3) throw new Error('Groups cannot exceed three levels');
      if (projects > 1) throw new Error('Project groups cannot nest inside project groups');
      cursor = state.parents.get(cursor);
    }
  }
}

function placeOrderToken(state: SessionGroups, change: Extract<GroupChange, { type: 'order' }>): void {
  const exists = state.groups.some(group => group.id === change.owner);
  if (change.scope === 'sidebar' ? change.owner !== '' : !exists && !(change.scope === 'sessions' && FIXED_KEYS.has(change.owner))) throw new Error('Group no longer exists');
  const lists = state.orders[change.scope];
  const order = mergeOrder(lists.get(change.owner) ?? [], change.visible);
  if (change.token !== null) {
    const entries = order.filter(token => token !== change.token);
    const index = change.before === null ? -1 : entries.indexOf(change.before);
    entries.splice(index < 0 ? entries.length : index, 0, change.token);
    lists.set(change.owner, entries);
  } else lists.set(change.owner, order);
}

/** Adds the `visible` tokens that `saved` does not have, each in front of the next visible token that `saved` has. */
function mergeOrder(saved: string[], visible: string[]): string[] {
  const result = [...new Set(saved)];
  const known = new Set(result);
  let pending: string[] = [];
  for (const token of new Set(visible)) {
    if (!known.has(token)) { pending.push(token); continue; }
    if (pending.length) { result.splice(result.indexOf(token), 0, ...pending); pending = []; }
  }
  return [...result, ...pending];
}

/** Drops orders of removed groups and puts groups that have no sidebar position at the top. */
function normalizeOrders(state: SessionGroups): void {
  const ids = new Set(state.groups.map(group => group.id));
  const live = (token: string) => !token.startsWith('group:') || ids.has(token.slice('group:'.length)) || FIXED_KEYS.has(token.slice('group:'.length));
  const sidebar = (state.orders.sidebar.get('') ?? []).filter(live);
  const placed = new Set(sidebar);
  state.orders.sidebar = new Map([['', [...state.groups.map(group => `group:${group.id}`).filter(token => !placed.has(token)), ...sidebar]]]);
  for (const owner of [...state.orders.sessions.keys()]) if (!ids.has(owner) && !FIXED_KEYS.has(owner)) state.orders.sessions.delete(owner);
  for (const [owner, tokens] of [...state.orders.children]) {
    if (ids.has(owner)) state.orders.children.set(owner, tokens.filter(live));
    else state.orders.children.delete(owner);
  }
}
