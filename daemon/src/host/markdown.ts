import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { STORAGE_DIRECTORY } from '../config';
import { homeDir } from '../environment';
import { ensurePrivateDir, syncDirectoryAncestors } from '../private_fs';
import * as Registry from '../session_registry';
import * as ConversationStorage from '../conversation_storage';
import { transaction, type Database } from '../util/db';
import { lockPath, type FileLock } from '../util/flock';
import { ConversationOwnership, savedConversationIn } from './ownership';

interface Lease { client: string; editor: string; token: string; expires: number }
interface Editor { client: string; id: string; token: string | undefined }

const UUID = /^(?:urn:uuid:)?\{?([0-9a-fA-F]{8})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{12})\}?$/;
function parseUuid(value: string): string | undefined {
  const match = UUID.exec(value);
  return match ? match.slice(1).join('-').toLowerCase() : undefined;
}

function now(): number { return Math.floor(Date.now() / 1000); }
function storageRoot(): string { return join(homeDir(), STORAGE_DIRECTORY); }
function notesRoot(): string { return join(storageRoot(), 'notes'); }

function validatePath(path: string): string {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('The chat note must be a regular file');
  } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  return path;
}

async function lockNotes(): Promise<FileLock> {
  const root = storageRoot();
  ensurePrivateDir(root);
  const path = validatePath(join(root, 'note-mutations.lock'));
  const lock = await lockPath(path, { blocking: true });
  if (!lock) throw new Error('Could not lock ' + path);
  return lock;
}

let notesPending: Promise<void> = Promise.resolve();

function withNotes<T>(operation: () => T): Promise<T> {
  const result = notesPending.then(async () => {
    const lock = await lockNotes();
    try { return operation(); } finally { lock.release(); }
  });
  notesPending = result.then(() => {}, () => {});
  return result;
}

// Lease records live in the session database; the path only names the session and the storage root.
function pathIdentity(path: string, missing: string, invalid: string): string {
  const name = basename(path).replace(/\.[^.]*$/, '');
  if (!name) throw new Error(missing);
  const id = parseUuid(name);
  if (!id) throw new Error(invalid);
  return id;
}

function pathRoot(path: string): string { return dirname(dirname(dirname(path))); }

function leaseDatabase(root: string): Database {
  const db = Registry.open(root);
  db.exec('CREATE TABLE IF NOT EXISTS note_editor_leases (session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL)');
  return db;
}

function withDb<T>(db: Database, operation: (db: Database) => T): T {
  try { return operation(db); } finally { db.close(); }
}

const Leases = {
  read(path: string): string | undefined {
    const id = pathIdentity(path, 'Missing note session identity', 'Invalid note session identity');
    const row: any = withDb(leaseDatabase(pathRoot(path)), db => db.prepare('SELECT record_json FROM note_editor_leases WHERE session_id=?').get(id));
    return row ? String(row.record_json) : undefined;
  },
  write(path: string, body: string | undefined): void {
    const id = pathIdentity(path, 'Missing note session identity', 'Invalid note session identity');
    withDb(leaseDatabase(pathRoot(path)), db => {
      if (body !== undefined) {
        const result = db.prepare('INSERT INTO note_editor_leases SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM sessions WHERE session_id=?1) ON CONFLICT(session_id) DO UPDATE SET record_json=excluded.record_json').run(id, body);
        if (Number(result.changes) === 0) throw new Error('Cannot assign a note editor to a deleted session');
      } else db.prepare('DELETE FROM note_editor_leases WHERE session_id=?').run(id);
    });
  },
  list(root: string): string[] {
    return withDb(leaseDatabase(root), db => db.prepare('SELECT session_id FROM note_editor_leases ORDER BY session_id').all().map((row: any) => join(root, 'notes', 'leases', row.session_id + '.json')));
  },
};

const MAX_BYTES = 4 * 1024 * 1024;

function noteDatabase(path: string): [Database, string] {
  const id = pathIdentity(path, 'Note has no session identity', 'Invalid note session identity');
  const db = Registry.open(pathRoot(path));
  try { db.exec('CREATE TABLE IF NOT EXISTS chat_notes (session_id TEXT PRIMARY KEY, content TEXT NOT NULL)'); } catch (error) { db.close(); throw error; }
  return [db, id];
}

function deleted(db: Database, id: string): boolean {
  const row: any = db.prepare('SELECT NOT EXISTS(SELECT 1 FROM sessions WHERE session_id=?) AS deleted').get(id);
  return Boolean(row?.deleted);
}

function stored(db: Database, id: string): string {
  const row: any = db.prepare('SELECT content FROM chat_notes WHERE session_id=?').get(id);
  if (row) return String(row.content);
  db.prepare('INSERT INTO chat_notes VALUES (?, ?)').run(id, '');
  return '';
}

const Notes = {
  read(path: string): string {
    const [db, id] = noteDatabase(path);
    return withDb(db, db => transaction(db, 'IMMEDIATE', () => deleted(db, id) ? '' : stored(db, id)));
  },
  write(path: string, body: string, expected: string): void {
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('Notes must be smaller than 4 MB');
    const [db, id] = noteDatabase(path);
    withDb(db, db => transaction(db, 'IMMEDIATE', () => {
      if (deleted(db, id)) throw new Error('Cannot save a note for a deleted session');
      const previous = stored(db, id);
      if (version(previous) !== expected) throw new Error('This chat\u2019s note changed. Load it again before saving.');
      db.prepare('UPDATE chat_notes SET content=? WHERE session_id=?').run(body, id);
    }));
  },
};

function parseLease(body: string): Lease {
  const value = JSON.parse(body);
  if (typeof value?.client !== 'string' || typeof value.editor !== 'string' || typeof value.token !== 'string' || typeof value.expires !== 'number') throw new Error('Invalid note editor lease');
  return { client: value.client, editor: value.editor, token: value.token, expires: value.expires };
}

function leasePath(session: string): string { return join(notesRoot(), 'leases', session + '.json'); }

function readLease(path: string): Lease | undefined {
  const body = Leases.read(path);
  if (body === undefined) return undefined;
  const lease = parseLease(body);
  return lease.expires > now() ? lease : undefined;
}

function writeLease(path: string, lease: Lease | undefined): void {
  Leases.write(path, lease ? JSON.stringify({ client: lease.client, editor: lease.editor, token: lease.token, expires: lease.expires }) : undefined);
}

function sameLease(left: Lease | undefined, right: Lease | undefined): boolean {
  if (!left || !right) return left === right;
  return left.client === right.client && left.editor === right.editor && left.token === right.token && left.expires === right.expires;
}

/** Keeps note editor leases alive during a daemon restart. Call commit() when the restart goes on; otherwise call drop() to undo. */
export class RestartLeases {
  constructor(private preserved: Array<[string, Lease, Lease]> = []) {}
  commit(): void { this.preserved = []; }
  async drop(): Promise<void> {
    if (!this.preserved.length) return;
    const preserved = this.preserved;
    this.preserved = [];
    try {
      await withNotes(() => {
        for (const [path, original, extended] of preserved) if (sameLease(readLease(path), extended)) writeLease(path, original);
      });
    } catch (error: any) {
      console.error('Could not restore note leases after failed restart preparation: ' + (error?.message ?? error));
    }
  }
}

export async function preserveLeasesForRestart(): Promise<RestartLeases> {
  const leases = new RestartLeases();
  try {
    await withNotes(() => {
      for (const path of Leases.list(storageRoot())) {
        if (!path.endsWith('.json')) continue;
        const lease = readLease(path);
        if (!lease) continue;
        const extended = { ...lease, expires: Math.max(lease.expires, now() + 300) };
        (leases as any).preserved.push([path, lease, extended]);
        writeLease(path, extended);
      }
    });
  } catch (error) { await leases.drop(); throw error; }
  return leases;
}

function owns(lease: Lease | undefined, editor: Editor): boolean {
  return !!lease && lease.client === editor.client && lease.editor === editor.id && lease.expires > now();
}

function ownership(lease: Lease | undefined, editor: Editor): any {
  const owned = owns(lease, editor);
  return { owned, available: lease === undefined, token: lease && owned ? lease.token : null };
}

function controls(lease: Lease | undefined, editor: Editor): boolean {
  return owns(lease, editor) && lease!.token === editor.token;
}

function updateLease(lease: Lease | undefined, editor: Editor, action: string): Lease | undefined {
  const controlled = controls(lease, editor);
  if (action === 'release') return controlled ? undefined : lease;
  if (action === 'takeover' || (action === 'claim' && lease === undefined)) return { client: editor.client, editor: editor.id, token: randomUUID(), expires: now() + 30 };
  if (controlled && (action === 'renew' || action === 'save') && lease) return { ...lease, expires: Math.max(lease.expires, now() + 30) };
  return lease;
}

export function initialize(): void {
  const root = join(notesRoot(), 'chats');
  ensurePrivateDir(root);
  syncDirectoryAncestors(root);
}

function field(args: any, name: string): string {
  const value = args?.[name];
  if (typeof value !== 'string') throw new Error('Missing note ' + name);
  return value;
}

function notePath(session: string): string { return join(notesRoot(), 'chats', session + '.md'); }

function isFile(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }

function hasConversation(session: string): boolean {
  const storage = storageRoot();
  const db = Registry.open(storage);
  let gone: boolean;
  try { gone = deleted(db, session); } finally { db.close(); }
  if (gone) return false;
  const key = ConversationOwnership.key(session);
  const body = ConversationStorage.read(storage, key);
  if (body === undefined) return true;
  const record = JSON.parse(body);
  if (typeof record?.path !== 'string') return true;
  if (isFile(record.path)) return true;
  for (const area of ['sessions', 'archived']) if (savedConversationIn(join(storage, area), session)) return true;
  return false;
}

function version(body: string): string { return createHash('sha256').update(body).digest('hex'); }
function documentFor(body: string): any { return { content: body, version: version(body) }; }

function editorFor(args: any): Editor {
  const client = field(args, 'clientId');
  const id = parseUuid(field(args, 'leaseId'));
  if (!id) throw new Error('Invalid note editor identity');
  return { client, id, token: typeof args?.leaseToken === 'string' ? args.leaseToken : undefined };
}

export function dispatch(args: any, enabled: boolean): Promise<any> {
  return withNotes(() => {
    const session = parseUuid(field(args, 'sessionId'));
    if (!session) throw new Error('Choose a chat before writing a note');
    const lease = leasePath(session);
    if (!hasConversation(session)) {
      writeLease(lease, undefined);
      return { content: '', version: version(''), deleted: true, ownership: { owned: false, available: false, token: null } };
    }
    if (!enabled) return disabledNote(args, session, lease);
    return dispatchNote(args, session, lease);
  });
}

function disabledNote(args: any, session: string, path: string): any {
  const result = documentFor(Notes.read(notePath(session)));
  const editor = editorFor(args);
  if (controls(readLease(path), editor)) writeLease(path, undefined);
  result.ownership = { owned: false, available: false, token: null };
  result.disabled = true;
  return result;
}

function dispatchNote(args: any, session: string, path: string): any {
  const note = notePath(session);
  const previous = readLease(path);
  const editor = editorFor(args);
  const action = field(args, 'action');
  const result = perform(note, args, action, controls(previous, editor));
  const lease = updateLease(previous, editor, action);
  if (!sameLease(lease, previous)) writeLease(path, lease);
  result.ownership = ownership(lease, editor);
  return result;
}

function perform(path: string, args: any, action: string, owned: boolean): any {
  switch (action) {
    case 'read': case 'claim': case 'takeover': case 'renew': case 'release': return documentFor(Notes.read(path));
    case 'save': {
      if (!owned) throw new Error('This client no longer controls the note.');
      const body = field(args, 'content');
      Notes.write(path, body, field(args, 'version'));
      return documentFor(body);
    }
    default: throw new Error('Unknown chat note action');
  }
}
