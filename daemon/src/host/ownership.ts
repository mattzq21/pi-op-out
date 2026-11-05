import * as SessionRecords from "../../resources/piop-storage/session-records.cjs";
import { sessionName } from "../../resources/session-broker/session-names.cjs";
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, dirname, sep } from 'node:path';
import * as ConversationStorage from '../storage';
import { recoverPending } from '../storage';
import * as SessionTables from '../../resources/session-database.cjs';
import * as ChildIndex from '../../resources/session-broker/session-child-index.cjs';
import { getProjectRepository } from '../projects';
import * as StorageLocks from '../../resources/storage-locks.cjs';
import { flag } from './json';
import { readHeaderLine } from './protocol';
import { errorText } from '../util/sync';

export function ownershipError(): string { return 'Take ownership of this conversation before changing it'; }

export interface Revocation { revoke(id: string, intent: string): Promise<void> }

export interface SavedConversation { path: string; header: any; lines: string[]; revision: string }

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

export interface Held { release(): void }

export class Guard {
  owned = false;
  saved: SavedConversation | null = null;
  archived = false;
  record: any = null;
  id = '';
  workerLock: Held | null = null;
  lock: Held | null = null;

  static unowned(): Guard { return new Guard(); }

  restored(ownership: ConversationOwnership, path: string): void {
    if (!ownership.locate(this.id, path, false, true)) { this.drop(); throw new Error('Restored conversation is not in active storage'); }
    this.archived = false;
    this.release(ownership, false);
  }

  async restoreFinished(ownership: ConversationOwnership, path: string | null | undefined): Promise<void> {
    try { await recoverPending(ownership.root); } catch (error) { this.drop(); throw error; }
    let saved: SavedConversation | null;
    try { saved = ownership.locate(this.id, path, false, true); } catch (error) { this.drop(); throw error; }
    if (saved) return this.restored(ownership, saved.path);
    this.release(ownership, false);
  }

  release(ownership: ConversationOwnership, deleted: boolean): void {
    try {
      if (deleted && this.owned && this.lock) ConversationStorage.remove(ownership.root, ConversationOwnership.key(this.id));
      else if (this.archived && this.owned && this.lock) {
        this.record.deleted = true;
        this.record.client = null;
        ownership.write(this.id, this.record);
      }
    } finally { this.drop(); }
  }

  drop(): void {
    this.workerLock?.release(); this.workerLock = null;
    this.lock?.release(); this.lock = null;
  }
}

function optionalPath(path: string): string | null {
  try { return realpathSync(path); } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function registeredPath(root: string, id: string): string | null {
  return SessionTables.lookup(root, id) ?? null;
}

export class ConversationOwnership {
  // Identifies this daemon run. Ownership records with another token come from an earlier run, whose clients are gone.
  readonly token = randomUUID();
  private shutdownListeners = new Set<() => void>();
  // The daemon is the only process that changes conversations, so their locks are storage locks in memory. One lock
  // serializes the ownership of each conversation; the other keeps runtimes away while it is archived, deleted or moved.
  // Storage recovery in worker threads takes the same locks before it changes a conversation.
  stopped = false;

  private constructor(readonly root: string, private revocation: Revocation) {}

  static async create(home: string, storage: string, revocation: Revocation): Promise<ConversationOwnership> {
    await recoverPending(join(home, storage));
    return new ConversationOwnership(join(home, storage), revocation);
  }

  static key(id: string): string {
    if (id.length !== 36 || !UUID.test(id)) throw new Error('Invalid conversation identity');
    return ConversationStorage.key(id);
  }

  private async lock(id: string, mutation: boolean): Promise<Held> {
    const release = await StorageLocks.lock((mutation ? 'conversation-mutation:' : 'conversation:') + ConversationOwnership.key(id), { timeoutMs: 180_000 });
    if (!release) throw new Error('Conversation is busy; try taking ownership again');
    return { release };
  }

  // Both locks of id, or undefined when someone holds one.
  tryLock(id: string): Held | undefined {
    const key = ConversationOwnership.key(id);
    const conversation = StorageLocks.lockSync('conversation:' + key, { wait: false });
    if (!conversation) return undefined;
    const mutation = StorageLocks.lockSync('conversation-mutation:' + key, { wait: false });
    if (!mutation) { conversation(); return undefined; }
    return { release: () => { mutation(); conversation(); } };
  }

  owns(id: string, client: string, allowReleased: boolean): boolean {
    const record = this.read(id);
    if (!record) return false;
    const released = allowReleased && (typeof record.client !== 'string' || record.client === '')
      && record.previousClient === client && record.token === this.token;
    return client !== '' && !flag(record, 'deleted') && (record.client === client || released);
  }

  read(id: string): any | null {
    const body = ConversationStorage.read(this.root, ConversationOwnership.key(id));
    return body === undefined ? null : JSON.parse(body);
  }

  write(id: string, record: any): void {
    ConversationStorage.write(this.root, ConversationOwnership.key(id), JSON.stringify(record));
  }

  locate(id: string, path: string | null | undefined, archived: boolean, metadataOnly: boolean): SavedConversation | null {
    const root = optionalPath(join(this.root, archived ? 'archived' : 'sessions'));
    if (root === null) return null;
    let candidate: string;
    if (path) candidate = path;
    else {
      const registered = registeredPath(this.root, id);
      if (registered === null || !within(registered, root)) return null;
      candidate = registered;
    }
    return readCandidate(id, candidate, root, metadataOnly);
  }

  private async releasePrevious(id: string, record: any, intent: string): Promise<void> {
    if (record?.token === this.token) await this.revocation.revoke(id, intent);
  }

  async begin(id: string, client: string, options: any): Promise<Guard> {
    if (!client) throw new Error('Conversation client is missing');
    // Taking a chat takes the other chats of its tree too, unless the claim only changes this chat.
    const members = exclusiveMutation(options) ? [] : this.chatTree(id).filter(member => member !== id);
    const locks = new Map<string, Held>();
    let workerLock: Held | null = null;
    const releaseMembers = () => { for (const [member, lock] of locks) if (member !== id) lock.release(); };
    try {
      for (const member of [id, ...members].sort()) locks.set(member, await this.lock(member, false));
      const record = this.read(id);
      const previous = record ?? null;
      const saved = this.savedForClaim(id, previous, options);
      const others = members.map(member => [member, this.read(member)] as const).filter(([, member]) => ownedByOther(member, client) && !flag(member, 'deleted'));
      if (claimBlocked(previous, client, options) || (others.length && !flag(options, 'take'))) { for (const lock of locks.values()) lock.release(); return Guard.unowned(); }
      workerLock = await this.claimWorkerLock(id, record, client, options);
      for (const [member, previousMember] of others) await this.transferMember(member, previousMember);
      for (const [member, previousMember] of others) this.write(member, { client, token: this.token, deleted: false, ...(typeof previousMember.path === 'string' ? { path: previousMember.path } : {}) });
      const next = this.writeClaim(id, client, saved);
      if (!exclusiveMutation(options)) { workerLock?.release(); workerLock = null; }
      releaseMembers();
      const guard = new Guard();
      guard.owned = true;
      guard.saved = saved;
      guard.archived = flag(options, 'archived');
      guard.record = next;
      guard.id = id;
      guard.workerLock = workerLock;
      guard.lock = locks.get(id)!;
      return guard;
    } catch (error) {
      workerLock?.release();
      for (const lock of locks.values()) lock.release();
      throw error;
    }
  }

  chatTree(id: string): string[] {
    return ChildIndex.tree(this.root, id).filter(member => UUID.test(member));
  }

  private async transferMember(id: string, previous: any): Promise<void> {
    if (previous.token === this.token) return this.revocation.revoke(id, 'transfer-local');
    await this.releasePrevious(id, previous, 'transfer');
    (await this.lock(id, true)).release();
  }

  private async claimWorkerLock(id: string, previous: any | null, client: string, options: any): Promise<Held | null> {
    if (previous) {
      if (!this.needsHandoff(previous, client, options)) return null;
      if (flag(options, 'take') && !flag(options, 'mutation') && previous.token === this.token) {
        await this.revocation.revoke(id, 'transfer-local');
        return null;
      }
      await this.releasePrevious(id, previous, claimIntent(options));
    }
    return this.lock(id, true);
  }

  private writeClaim(id: string, client: string, saved: SavedConversation | null): any {
    const next: any = { client, token: this.token, deleted: false };
    if (saved) next.path = saved.path;
    this.write(id, next);
    return next;
  }

  private savedForClaim(id: string, previous: any, options: any): SavedConversation | null {
    const path = typeof options?.path === 'string' && options.path !== '' ? options.path : (typeof previous?.path === 'string' ? previous.path : null);
    const saved = this.locate(id, path, flag(options, 'archived'), false);
    if (!saved && !flag(options, 'create')) throw new Error('This conversation has been deleted or archived');
    return saved;
  }

  private needsHandoff(previous: any, client: string, options: any): boolean {
    const returning = (typeof previous.client !== 'string' || previous.client === '')
      && previous.previousClient === client && previous.token === this.token;
    return (!returning && previous.client !== client) || previous.token !== this.token || flag(options, 'mutation');
  }

  async releaseClient(id: string, client: string, unused: () => boolean): Promise<void> {
    const lock = await this.lock(id, false);
    try {
      const record = this.read(id);
      if (!record) return;
      if (!unused() || record.client !== client || record.token !== this.token || flag(record, 'deleted')) return;
      record.client = null;
      record.previousClient = client;
      this.write(id, record);
    } finally { lock.release(); }
  }

  snapshot(id: string, _path?: string | null): any {
    const saved = this.lookupSaved(id, false)?.[0] ?? null;
    let entries: any[] = [];
    const damagedLines: number[] = [];
    for (let index = 1; saved && index < saved.lines.length; index++) {
      try {
        const entry = JSON.parse(saved.lines[index]);
        if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string') throw new Error('Invalid record');
        entries.push(entry);
      } catch { damagedLines.push(index + 1); }
    }
    if (damagedLines.length) console.error(`Incomplete chat history: ${saved!.path}; damaged record lines: ${damagedLines.join(', ')}`);
    if (saved) entries = SessionRecords.merge(saved.path, [saved.header, ...entries]).slice(1);
    const revision = saved ? saved.revision : 'missing:' + id;
    const leaf = [...entries].reverse().find(entry => entry?.type !== 'session' && !SessionRecords.isCurrent(entry));
    const tipId = typeof leaf?.id === 'string' ? leaf.id : null;
    const leafId = saved ? SessionRecords.selectedLeaf(saved.path, id, tipId) : tipId;
    if (leafId !== null && !entries.some(entry => entry.id === leafId)) throw new Error('The saved branch points to a missing entry');
    const snapshot: any = {
      revision,
      state: { canFork: SessionRecords.canFork(entries), sessionId: id, model: null, thinkingLevel: 'off', isStreaming: false, pendingMessageCount: 0, needsInput: false, messageCount: entries.filter(entry => entry?.type === 'message').length },
      history: { leafId, entries, ...(damagedLines.length ? { incomplete: true, damagedLines } : {}) }, sequence: 0, epoch: 'readonly:' + id,
      liveTools: [], queue: { type: 'queue_update', steering: [], followUp: [], pendingMessages: [] },
    };
    if (saved) {
      snapshot.state.sessionFile = saved.path;
      const name = sessionName(saved.path, saved.header.id);
      if (name !== undefined) snapshot.state.sessionName = name;
      snapshot.state.cwd = saved.header.cwd;
      snapshot.state.repository = typeof saved.header.cwd === 'string' ? getProjectRepository(this.root, saved.header.cwd) : null;
      if (saved.header.piopForkSource) snapshot.state.forkSource = saved.header.piopForkSource;
    }
    return snapshot;
  }

  revision(id: string, _path?: string | null): any {
    const saved = this.lookupSaved(id, true)?.[0];
    return { revision: saved ? saved.revision : 'missing:' + id };
  }

  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const listener of [...this.shutdownListeners]) listener();
  }

  onShutdown(listener: () => void): () => void {
    if (this.stopped) { listener(); return () => {}; }
    this.shutdownListeners.add(listener);
    return () => this.shutdownListeners.delete(listener);
  }

  removed(id: string): boolean {
    return !SessionTables.sessionRowExists(this.root, id) || flag(this.read(id), 'deleted');
  }

  lookup(id: string): any {
    const found = this.lookupSaved(id, true);
    if (!found) throw new Error('Conversation was not found in active or archived storage');
    const [saved, archived] = found;
    return { sessionId: id, sessionPath: saved.path, cwd: saved.header.cwd ?? null, archived, revision: saved.revision };
  }

  location(id: string): any {
    const location = this.lookup(id);
    if (!location.archived) return location;
    const saved = this.lookupSaved(id, false)?.[0];
    if (!saved) throw new Error('Conversation was not found in active or archived storage');
    const entries = saved.lines.slice(1).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    return { ...location, auxiliary: SessionRecords.isAuxiliary([...entries, ...SessionRecords.records(saved.path, id).map((record: any) => record.entry)]) };
  }

  lookupSaved(id: string, metadataOnly: boolean): [SavedConversation, boolean] | null {
    ConversationOwnership.key(id);
    const path = registeredPath(this.root, id);
    if (path === null) return null;
    for (const archived of [false, true]) {
      const root = optionalPath(join(this.root, archived ? 'archived' : 'sessions'));
      if (root === null || !within(path, root)) continue;
      const saved = readCandidate(id, path, root, metadataOnly);
      if (saved && saved.header?.type === 'session' && typeof saved.header?.cwd === 'string') return [saved, archived];
      return null;
    }
    return null;
  }
}

function claimBlocked(previous: any, client: string, options: any): boolean {
  return ownedByOther(previous, client) && !flag(options, 'take') && !flag(options, 'archive') && !(flag(options, 'archived') && flag(previous, 'deleted'));
}

function ownedByOther(previous: any, client: string): boolean {
  return typeof previous?.client === 'string' && previous.client !== '' && previous.client !== client;
}

function claimIntent(options: any): string {
  if (flag(options, 'archive')) return 'archive';
  if (flag(options, 'delete')) return 'delete';
  if (flag(options, 'relocate')) return 'relocate';
  return 'transfer';
}

function exclusiveMutation(options: any): boolean { return flag(options, 'mutation'); }

function validateSavedPath(path: string, root: string): void {
  if (!within(path, root) || path === root || extname(path) !== '.jsonl' || path.endsWith('/.jsonl')) throw new Error('Invalid conversation path');
}

export function savedConversationIn(rootPath: string, id: string): boolean {
  const root = optionalPath(rootPath);
  if (root === null) return false;
  const profile = dirname(root);
  const path = registeredPath(profile, id);
  if (path === null || !within(path, root)) return false;
  return readCandidate(id, path, root, true) !== null;
}

export function readCandidate(id: string, original: string, root: string, metadataOnly: boolean): SavedConversation | null {
  const path = optionalPath(original);
  if (path === null) return null;
  validateSavedPath(path, root);
  const found = readSavedHeader(id, path);
  if (!found) return null;
  const [header, metadata] = found;
  const revision = savedRevision(id, metadata) + ":" + SessionRecords.revision(path, id);
  let lines: string[] = [];
  if (!metadataOnly) {
    const saved = readSavedLines(id, path);
    if (!saved) return null;
    lines = saved;
  }
  return { path, header, lines, revision };
}

function readSavedLines(id: string, path: string): string[] | null {
  let content: string;
  try { content = readFileSync(path, 'utf8'); } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const lines = content.split('\n');
  const tail = lines.pop()!;
  if (tail) console.warn(`${path}: last write was interrupted; ignored ${Buffer.byteLength(tail)} bytes`);
  let header: any = null;
  try { header = JSON.parse(lines[0]); } catch (error) { console.warn(`${path}: invalid session header: ${errorText(error)}`); }
  if (header?.type !== 'session' || header?.id !== id) return null;
  return lines;
}

function readSavedHeader(id: string, path: string): [any, import('node:fs').BigIntStats] | null {
  let metadata: import('node:fs').BigIntStats;
  let line: string;
  try {
    metadata = statSync(path, { bigint: true });
    line = readHeaderLine(path);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let header: any;
  try { header = JSON.parse(line); } catch { return null; }
  if (header?.id !== id) return null;
  return [header, metadata];
}

function savedRevision(id: string, metadata: import('node:fs').BigIntStats): string {
  return id + ':' + metadata.dev + ':' + metadata.ino + ':' + metadata.size + ':' + metadata.mtimeNs + ':' + metadata.ctimeNs;
}
