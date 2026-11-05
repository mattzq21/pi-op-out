import { createTranscript, removeTemporary } from '../../resources/piop-storage/recovery.cjs';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import * as Registry from '../session_registry';
import { ensurePrivateDir } from '../private_fs';
import { errorText } from '../util/sync';
import { readHeaderLine } from './protocol';
import { ConversationOwnership, within } from './ownership';
import { QueueStorage } from './queue_storage';

export interface Recovery { errors: string[]; recovered: boolean }

function empty(): Recovery { return { errors: [], recovered: false }; }

export function recoverMissingTranscripts(root: string, ownership: ConversationOwnership): Recovery {
  try { return recoverStorage(root, ownership); } catch (error) { return { ...empty(), errors: [errorText(error)] }; }
}

function recoverStorage(root: string, ownership: ConversationOwnership): Recovery {
  const entries = (Registry.connection(root).prepare('SELECT DISTINCT session_id FROM queue_items').all() as any[]).map(row => String(row.session_id));
  const recovery = empty();
  for (const entry of entries) {
    try { recovery.recovered = recoverJournal(root, ownership, join(root, 'queued-input', entry + '.json')) || recovery.recovered; }
    catch (error) { recovery.errors.push(errorText(error)); }
  }
  return recovery;
}

function recoverJournal(root: string, ownership: ConversationOwnership, path: string): boolean {
  if (extname(path) !== '.json') return false;
  const id = basename(path, '.json');
  // A conversation that a client holds is not left over from an earlier run; the client's runtime takes its queue.
  const lock = ownership.tryLock(id);
  if (!lock) return false;
  try {
    removeTemporary(join(root, 'sessions', '.queued-input-recovery-' + id));
    if (ownership.removed(id) || transcriptExists(root, id)) return false;
    const recovered = recoverContents(root, id);
    if (recovered) console.error('Queued input recovered for session ' + id);
    return recovered;
  } finally { lock.release(); }
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
  const db = Registry.connection(root);
  const row: any = db.prepare('SELECT session_path FROM sessions WHERE session_id=?').get(id);
  return typeof row?.session_path === 'string' ? row.session_path : null;
}

function transcriptExists(root: string, id: string): boolean {
  const path = registeredSessionPath(root, id);
  if (path === null) return false;
  if (!within(path, join(root, 'sessions'))) throw new Error('Saved session path is outside session storage');
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
  const db = Registry.connection(root);
  const bound = db.prepare('UPDATE sessions SET session_path=?1, revision=revision+1 WHERE session_id=?2 AND (session_path IS NULL OR session_path=?1)').run(target, id);
  if (Number(bound.changes) !== 1) throw new Error('Queued input no longer belongs to this session path');
  return createTranscript(target, id, cwd, name);
}
