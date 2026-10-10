import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, openSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import * as Registry from '../session_registry';
import { ensurePrivateDir } from '../private_fs';
import { transaction } from '../util/db';
import { errorText } from '../util/sync';
import { flockDescriptorSync, FileLock } from '../util/flock';
import { readHeaderLine } from './protocol';
import { ConversationOwnership, within } from './ownership';
import { QueueStorage } from './queue_storage';

export interface Recovery { errors: string[]; recovered: boolean; retry: boolean; transactionsPending: boolean }

function empty(): Recovery { return { errors: [], recovered: false, retry: false, transactionsPending: false }; }

export function recoverMissingTranscripts(root: string, ownership: ConversationOwnership): Recovery {
  try { return recoverStorage(root, ownership); } catch (error) { return { ...empty(), errors: [errorText(error)] }; }
}

function recoverStorage(root: string, ownership: ConversationOwnership): Recovery {
  const notes = tryLock(join(root, 'notes', 'ownership.lock'));
  if (!notes) return { ...empty(), retry: true };
  try {
    const restore = tryLock(join(root, 'restore.lock'));
    if (!restore) return { ...empty(), retry: true };
    try {
      if (restorationPending(root)) return { ...empty(), retry: true, transactionsPending: true };
      const db = Registry.open(root);
      let entries: string[];
      try { entries = (db.prepare('SELECT DISTINCT session_id FROM queue_items').all() as any[]).map(row => String(row.session_id)); } finally { db.close(); }
      const recovery = empty();
      for (const entry of entries) {
        try { recovery.recovered = recoverJournal(root, ownership, join(root, 'queued-input', entry + '.json')) || recovery.recovered; }
        catch (error) { recovery.errors.push(errorText(error)); }
      }
      return recovery;
    } finally { restore.release(); }
  } finally { notes.release(); }
}

function restorationPending(root: string): boolean {
  const db = Registry.open(root);
  try {
    const row: any = db.prepare("SELECT (EXISTS(SELECT 1 FROM session_restorations) OR EXISTS(SELECT 1 FROM deletion_records) OR EXISTS(SELECT 1 FROM storage_transactions) OR EXISTS(SELECT 1 FROM archive_records WHERE record_json IS NULL OR (COALESCE(json_extract(record_json, '$.finished'), 0) != 1 AND COALESCE(json_extract(record_json, '$.state'), '') != 'planned'))) AS pending").get();
    return Boolean(row.pending);
  } finally { db.close(); }
}

function recoverJournal(root: string, ownership: ConversationOwnership, path: string): boolean {
  if (extname(path) !== '.json') return false;
  const id = basename(path, '.json');
  const key = ConversationOwnership.key(id);
  const ownershipLock = tryLock(join(root, 'conversation-ownership', key + '.lock'));
  if (!ownershipLock) return false;
  try {
    const workerLock = tryLock(join(root, 'session-claims', 'id-' + key + '.lock'));
    if (!workerLock) return false;
    try {
      removeTemporary(join(root, 'sessions', '.queued-input-recovery-' + id));
      if (ownership.removed(id) || transcriptExists(root, id)) return false;
      return recoverContents(root, id);
    } finally { workerLock.release(); }
  } finally { ownershipLock.release(); }
}

function recoverContents(root: string, id: string): boolean {
  const storage = new QueueStorage(join(root, 'queued-input'), id);
  const pending = storage.load();
  if (!pending.length) return false;
  const journal = storage.record();
  if (!journal) throw new Error('Queued input is no longer available');
  const cwd = journal.origin?.cwd;
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('Queued input retained: recovery working directory is missing');
  const target = recoveryPath(root, id, journal.origin);
  const name = typeof pending[0]?.message === 'string' ? pending[0].message : 'Recovered queued input';
  return recoverTranscript(root, target, id, cwd, name);
}

function registeredSessionPath(root: string, id: string): string | null {
  const db = Registry.open(root);
  try {
    const row: any = db.prepare('SELECT session_path FROM sessions WHERE session_id=?').get(id);
    return typeof row?.session_path === 'string' ? row.session_path : null;
  } finally { db.close(); }
}

function transcriptExists(root: string, id: string): boolean {
  const path = registeredSessionPath(root, id);
  if (path === null) return false;
  if (!within(path, join(root, 'sessions')) && !within(path, join(root, 'archived'))) throw new Error('Saved session path is outside session storage');
  if (!existsSync(path)) return false;
  return matchingHeader(path, id);
}

function matchingHeader(path: string, id: string): boolean {
  const header = readHeaderLine(path);
  let parsed: any;
  try { parsed = JSON.parse(header); } catch { return basename(path, extname(path)).endsWith(id); }
  return parsed?.type === 'session' && typeof parsed?.id === 'string' && parsed.id.toLowerCase() === id.toLowerCase();
}

function recoveryPath(root: string, id: string, origin: any): string {
  const sessions = join(root, 'sessions');
  ensurePrivateDir(sessions);
  const directory = realpathSync(sessions);
  const registered = registeredSessionPath(root, id) ?? (typeof origin?.sessionPath === 'string' ? origin.sessionPath : null);
  if (registered !== null) {
    if (realpathSync(dirname(registered)) !== directory || extname(registered) !== '.jsonl') throw new Error('Queued-input recovery path is outside active session storage');
    return registered;
  }
  return join(directory, 'recovered_' + id + '.jsonl');
}

function recoverTranscript(root: string, target: string, id: string, cwd: string, name: string): boolean {
  const db = Registry.open(root);
  try {
    const bound = db.prepare('UPDATE sessions SET session_path=?1 WHERE session_id=?2 AND (session_path IS NULL OR session_path=?1)').run(target, id);
    if (Number(bound.changes) !== 1) throw new Error('Queued input no longer belongs to this session path');
  } finally { db.close(); }
  const created = createTranscript(target, id, cwd, name);
  registerRecovered(root, target, id);
  return created;
}

function transcript(id: string, cwd: string, name: string): string {
  const timestamp = new Date().toISOString();
  const header = { type: 'session', version: 3, id, timestamp, cwd };
  const info = { type: 'session_info', id: randomUUID().slice(0, 8), parentId: null, timestamp, name: 'Recovered queued input: ' + Array.from(Array.from(name).slice(0, 120).join('').trim()).slice(0, 120).join('') };
  return JSON.stringify(header) + '\n' + JSON.stringify(info) + '\n';
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function createTranscript(path: string, id: string, cwd: string, name: string): boolean {
  const temporary = join(dirname(path), '.queued-input-recovery-' + id);
  let created: boolean;
  try { created = installTranscript(path, temporary, transcript(id, cwd, name)); }
  catch (error) { try { removeTemporary(temporary); } catch {} throw error; }
  removeTemporary(temporary);
  return created;
}

function removeTemporary(path: string): void {
  let metadata;
  try { metadata = lstatSync(path); } catch (error: any) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!metadata.isFile()) throw new Error('Invalid queued-input recovery temporary file');
  unlinkSync(path);
  syncDirectory(dirname(path));
}

function installTranscript(path: string, temporary: string, body: string): boolean {
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { linkSync(temporary, path); } catch (error: any) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
  syncDirectory(dirname(path));
  return true;
}

function registerRecovered(root: string, target: string, id: string): void {
  if (!matchingHeader(target, id)) return;
  const metadata = statSync(target, { bigint: true });
  const modified = String(metadata.mtimeNs);
  const size = Number(metadata.size);
  const db = Registry.open(root);
  try {
    transaction(db, 'IMMEDIATE', () => {
      const row: any = db.prepare('SELECT EXISTS(SELECT 1 FROM sessions WHERE session_id=? AND session_path=?) AS found').get(id, target);
      if (!row.found) throw new Error('Recovered transcript does not own its session ID');
      db.prepare('INSERT INTO session_file_metadata VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET session_path=excluded.session_path, modified_ns=excluded.modified_ns, size=excluded.size').run(id, target, modified, size);
      db.prepare('DELETE FROM session_file_writes WHERE session_id=?').run(id);
    });
  } finally { db.close(); }
}

function tryLock(path: string): FileLock | undefined {
  ensurePrivateDir(dirname(path));
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    if (flockDescriptorSync(fd, false)) return new FileLock(fd, path);
  } catch (error) { closeSync(fd); throw error; }
  closeSync(fd);
  return undefined;
}
