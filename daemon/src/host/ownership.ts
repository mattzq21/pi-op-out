import * as SessionRecords from "../../resources/piop-storage/session-records.cjs";
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, dirname, sep } from 'node:path';
import * as ConversationStorage from '../conversation_storage';
import * as RestoreRecovery from '../restore_recovery';
import * as Registry from '../session_registry';
import { getProjectRepository } from '../project_repositories';
import { ensurePrivateDir } from '../private_fs';
import { FileLock, flockDescriptor } from '../util/flock';
import { flag, text } from './json';
import { readHeaderLine } from './protocol';
import * as ControlState from './control_state';

export function ownershipError(): string { return 'Take ownership of this conversation before changing it'; }

/** Releases a conversation that this process owns, when another client takes it. */
export interface Revocation { revoke(id: string, intent: string): Promise<void> }

export interface SavedConversation { path: string; header: any; lines: string[]; revision: string }

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** True when the path is the root or inside it, compared by whole path parts. */
export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

export class Guard {
  owned = false;
  saved: SavedConversation | null = null;
  archived = false;
  record: any = null;
  id = '';
  workerLock: FileLock | null = null;
  lock: FileLock | null = null;

  static unowned(): Guard { return new Guard(); }

  restored(ownership: ConversationOwnership, path: string): void {
    if (!ownership.locate(this.id, path, false, true)) { this.drop(); throw new Error('Restored conversation is not in active storage'); }
    this.archived = false;
    this.release(ownership, false);
  }

  async restoreFinished(ownership: ConversationOwnership, path: string | null | undefined): Promise<void> {
    try { await RestoreRecovery.recover(ownership.root); } catch (error) { this.drop(); throw error; }
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

  /** Lets go of the file locks without other changes. */
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
  const database = Registry.open(root);
  try {
    const row: any = database.prepare('SELECT session_path FROM sessions WHERE session_id=?').get(id);
    return typeof row?.session_path === 'string' ? row.session_path : null;
  } finally { database.close(); }
}

export class ConversationOwnership {
  readonly directory: string;
  readonly token = randomUUID();
  endpoint = '';
  private server: Server | undefined;
  private shutdownListeners = new Set<() => void>();
  stopped = false;

  private constructor(readonly root: string, private revocation: Revocation) {
    this.directory = join(root, 'conversation-ownership');
  }

  static async create(home: string, storage: string, revocation: Revocation): Promise<ConversationOwnership> {
    await RestoreRecovery.recover(join(home, storage));
    const ownership = new ConversationOwnership(join(home, storage), revocation);
    const server = createServer({ maxHeaderSize: 16384 }, (request, response) => ownership.serve(request, response));
    server.headersTimeout = 30_000;
    server.requestTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not start conversation ownership endpoint');
    ownership.endpoint = 'http://127.0.0.1:' + address.port;
    ownership.server = server;
    server.unref();
    return ownership;
  }

  static key(id: string): string {
    if (id.length !== 36 || !UUID.test(id)) throw new Error('Invalid conversation identity');
    return ConversationStorage.key(id);
  }

  private async lock(id: string, worker: boolean): Promise<FileLock> {
    const directory = worker ? join(this.root, 'session-claims') : this.directory;
    ensurePrivateDir(directory);
    const path = join(directory, (worker ? 'id-' : '') + ConversationOwnership.key(id) + '.lock');
    const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
    const deadline = Date.now() + 180_000;
    try {
      let locked: boolean;
      try { locked = await flockDescriptor(fd, true, false, Math.max(0, deadline - Date.now())); } catch (error: any) { throw new Error('Could not lock conversation: ' + (error?.message ?? error)); }
      if (locked) return new FileLock(fd, path);
      throw new Error('Conversation is busy; try taking ownership again');
    } catch (error) { closeSync(fd); throw error; }
  }

  owns(id: string, client: string, allowReleased: boolean): boolean {
    const record = this.read(id);
    if (!record) return false;
    const released = allowReleased && (typeof record.client !== 'string' || record.client === '')
      && record.previousClient === client && record.endpoint === this.endpoint && record.token === this.token;
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
    const endpoint = record?.endpoint;
    if (typeof endpoint !== 'string') return;
    if (endpoint === this.endpoint && record.token === this.token) return this.revocation.revoke(id, intent);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + text(record, 'token'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, intent }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error: any) {
      if (connectionRefused(error)) return;
      throw new Error('Could not reach the current owner; try taking ownership again');
    }
    if (!response.ok) throw new Error('The previous client could not release the conversation');
  }

  async begin(id: string, client: string, options: any): Promise<Guard> {
    if (!client) throw new Error('Conversation client is missing');
    const lock = await this.lock(id, false);
    let workerLock: FileLock | null = null;
    try {
      await RestoreRecovery.recover(this.root);
      const record = this.read(id);
      const previous = record ?? null;
      const saved = this.savedForClaim(id, previous, options);
      if (claimBlocked(previous, client, options)) { lock.release(); return Guard.unowned(); }
      workerLock = await this.claimWorkerLock(id, record, client, options);
      const next = this.writeClaim(id, client, saved);
      if (!exclusiveMutation(options)) { workerLock?.release(); workerLock = null; }
      const guard = new Guard();
      guard.owned = true;
      guard.saved = saved;
      guard.archived = flag(options, 'archived');
      guard.record = next;
      guard.id = id;
      guard.workerLock = workerLock;
      guard.lock = lock;
      return guard;
    } catch (error) {
      workerLock?.release();
      lock.release();
      throw error;
    }
  }

  private async claimWorkerLock(id: string, previous: any | null, client: string, options: any): Promise<FileLock | null> {
    if (previous) {
      if (!this.needsHandoff(previous, client, options)) return null;
      if (flag(options, 'take') && !flag(options, 'mutation') && previous.endpoint === this.endpoint && previous.token === this.token) {
        await this.revocation.revoke(id, 'transfer-local');
        return null;
      }
      await this.releasePrevious(id, previous, claimIntent(options));
    }
    return this.lock(id, true);
  }

  private writeClaim(id: string, client: string, saved: SavedConversation | null): any {
    const next: any = { client, endpoint: this.endpoint, token: this.token, deleted: false };
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
      && previous.previousClient === client && previous.endpoint === this.endpoint && previous.token === this.token;
    return (!returning && previous.client !== client) || previous.endpoint !== this.endpoint || flag(options, 'mutation');
  }

  async releaseClient(id: string, client: string, unused: () => boolean): Promise<void> {
    const lock = await this.lock(id, false);
    try {
      const record = this.read(id);
      if (!record) return;
      if (!unused() || record.client !== client || record.endpoint !== this.endpoint || record.token !== this.token || flag(record, 'deleted')) return;
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
    const control = ControlState.reduce(entries, leafId);
    const snapshot: any = {
      revision,
      state: { canFork: SessionRecords.canFork(entries), sessionId: id, model: null, thinkingLevel: 'off', isStreaming: false, pendingMessageCount: 0, isPaused: control.isPaused, isPausing: false, needsInput: false, messageCount: entries.filter(entry => entry?.type === 'message').length },
      history: { leafId, entries, ...(damagedLines.length ? { incomplete: true, damagedLines } : {}) }, sequence: 0, epoch: 'readonly:' + id,
      liveTools: [], queue: { type: 'queue_update', steering: [], followUp: [], pendingMessages: [] },
    };
    if (saved) {
      snapshot.state.sessionFile = saved.path;
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
    this.server?.close();
    for (const listener of [...this.shutdownListeners]) listener();
  }

  onShutdown(listener: () => void): () => void {
    if (this.stopped) { listener(); return () => {}; }
    this.shutdownListeners.add(listener);
    return () => this.shutdownListeners.delete(listener);
  }

  removed(id: string): boolean {
    const db = Registry.open(this.root);
    let exists: boolean;
    try { exists = Boolean((db.prepare('SELECT EXISTS(SELECT 1 FROM sessions WHERE session_id=?) AS found').get(id) as any).found); } finally { db.close(); }
    return !exists || flag(this.read(id), 'deleted');
  }

  lookup(id: string): any {
    const found = this.lookupSaved(id, true);
    if (!found) throw new Error('Conversation was not found in active or archived storage');
    const [saved, archived] = found;
    return { sessionId: id, sessionPath: saved.path, cwd: saved.header.cwd ?? null, archived, revision: saved.revision };
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

  private serve(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): void {
    const finish = (status: number) => {
      if (response.headersSent) return;
      response.writeHead(status, { 'Content-Length': '0', Connection: 'close' });
      response.end();
    };
    const timer = setTimeout(() => { finish(409); request.destroy(); }, 30_000);
    const done = (status: number) => { clearTimeout(timer); finish(status); };
    if (request.method !== 'POST' || request.headers.authorization !== 'Bearer ' + this.token) { request.resume(); return done(403); }
    const length = Number(request.headers['content-length']);
    if (request.headers['content-length'] === undefined || !Number.isInteger(length) || length < 0 || length > 8192) { request.resume(); return done(409); }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= length) chunks.push(chunk); });
    request.on('error', () => done(409));
    request.on('end', () => {
      let packet: any;
      try { packet = JSON.parse(Buffer.concat(chunks).subarray(0, length).toString()); } catch { return done(409); }
      const id = text(packet, 'id');
      try { ConversationOwnership.key(id); } catch { return done(409); }
      this.revocation.revoke(id, text(packet, 'intent')).then(() => done(200), () => done(409));
    });
  }
}

function connectionRefused(error: any): boolean {
  for (let current = error; current; current = current.cause) {
    if (current.code === 'ECONNREFUSED') return true;
    if (Array.isArray(current.errors) && current.errors.some((item: any) => item?.code === 'ECONNREFUSED')) return true;
  }
  return false;
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
  try { header = JSON.parse(lines[0]); } catch {}
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
