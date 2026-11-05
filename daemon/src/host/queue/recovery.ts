import { createTranscript, removeTemporary } from '../../../resources/piop-storage/recovery.ts';
import { closeSync, constants, existsSync, openSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { ensurePrivateDir } from '../../private_fs';
import { bindRecoveredQueue, lookup, queuedSessionIds } from '../../../resources/session-database.ts';
import { errorText } from '../../util/sync';
import * as StorageLocks from '../../../resources/storage-locks.ts';
import { readHeaderLine } from '../protocol';
import { ConversationOwnership, within } from '../ownership';
import { QueueStorage } from './storage';

export interface Recovery { errors: string[]; recovered: boolean }

function empty(): Recovery { return { errors: [], recovered: false }; }

export function recoverMissingTranscripts(root: string, ownership: ConversationOwnership): Recovery {
  try { return recoverStorage(root, ownership); } catch (error) { return { ...empty(), errors: [errorText(error)] }; }
}

function recoverStorage(root: string, ownership: ConversationOwnership): Recovery {
  const entries = queuedSessionIds(root);
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
  const path = lookup(root, id);
  return typeof path === 'string' ? path : null;
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
  if (!bindRecoveredQueue(root, id, target)) throw new Error('Queued input no longer belongs to this session path');
  return createTranscript(target, id, cwd, name);
}
