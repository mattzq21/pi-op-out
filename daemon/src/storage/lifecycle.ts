import fs from 'node:fs';
import path from 'node:path';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { z } from 'zod';
import * as database from '../../resources/session-database/index.ts';
import { onMainThread } from '../../resources/session-database/index.ts';
import * as conversationStorage from './conversation_ownership.ts';
import * as temporaryChat from './temporary_chats.ts';
import { collectGoalFiles } from '../../resources/storage-operations/index.ts';
import { lockSync } from './locks.ts';
import { validSessionHeader } from './session_header.ts';
import { hostOperation, runHostOperation, STORAGE_TIMEOUT, type HostOperation } from '../host_operations';

// A transcript stays where it was made for its whole life. A new chat writes its files, and then its rows in one
// transaction. Archive and restore change only its database row; delete removes its rows in one transaction, and its
// files after that. The start sweep removes the files that a stop between the two steps left without rows.

export interface SavedSession { sessionId: string; sessionPath: string; archived: boolean }

const idsSchema = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 });

function checkedIds(ids: string[]): string[] {
  if (!Check(idsSchema, ids) || new Set(ids).size !== ids.length) throw new Error('Invalid session IDs');

  return ids;
}

// The saved chat of id, or undefined.
function session(root: string, id: string): SavedSession | undefined { return database.savedSessionRow(root, id); }

// The ID of the saved chat whose transcript is file, or undefined.
function idOf(root: string, file: string): string | undefined { return database.sessionIdByPath(root, file); }

function sessions(root: string, ids: string[]): SavedSession[] {
  return checkedIds(ids).map(id => {
    const saved = session(root, id);

    if (!saved) throw new Error('This conversation has been deleted');

    return saved;
  });
}

// The chats under sessionId, each once, parents before children. Only chats of the given kinds and archive state, and
// the chats under them, are included.
function descendants(root: string, sessionId: string, filter: { archived?: boolean; kinds?: string[] } = {}): SavedSession[] {
  const seen = new Set([sessionId]);
  const result: SavedSession[] = [];

  for (let queue = [sessionId], cursor = 0; cursor < queue.length; cursor++) {
    for (const child of database.descendantSessionRows(root, queue[cursor])) {
      if (seen.has(child.sessionId) || (filter.kinds && !filter.kinds.includes(child.kind))) continue;
      seen.add(child.sessionId);

      if (filter.archived !== undefined && child.archived !== filter.archived) continue;
      result.push({ sessionId: child.sessionId, sessionPath: child.sessionPath, archived: child.archived });
      queue.push(child.sessionId);
    }
  }

  return result;
}

function setArchived(root: string, ids: string[], archived: boolean): void {
  database.transaction(root, 'IMMEDIATE', () => {
    for (const saved of sessions(root, ids)) {
      if (saved.archived === archived) throw new Error(archived ? 'This conversation is already archived' : 'This conversation is not archived');
    }

    for (const id of ids) {
      database.setSessionArchived(root, id, archived);
      // An archived chat has no owner.
      if (archived) conversationStorage.forget(root, id);
    }
  });
}

const archive = onMainThread('session-lifecycle.archive', (root: string, ids: string[]) => setArchived(root, ids, true));

const restore = onMainThread('session-lifecycle.restore', (root: string, ids: string[]) => setArchived(root, ids, false));

// Removes the rows of the chats ids (the tables that refer to them cascade).
const forget = onMainThread('session-lifecycle.forget', (root: string, ids: string[]) => {
  database.transaction(root, 'IMMEDIATE', () => {
    sessions(root, ids);

    for (const id of ids) {
      conversationStorage.forget(root, id);
      database.deleteSessionRow(root, id);
    }
  });
});

function snapshots(file: string): string { return file.replace(/\.jsonl$/, '.snapshots'); }

function removeFiles(file: string): void {
  fs.rmSync(snapshots(file), { recursive: true, force: true });
  fs.rmSync(file, { force: true });
}

// The deletion of the chats ids: their rows in one transaction, and then their files and the goal files that only they used.
function removeSessions(root: string, ids: string[]): string[] {
  const targets = sessions(root, ids).map(saved => saved.sessionPath);

  forget(root, ids);
  const warnings: string[] = [];

  for (const target of targets) {
    try { removeFiles(target); }
    catch (error) { warnings.push(`Deleted, but the files of ${target} were kept until the next start: ${(error as Error).message}`); }
  }

  try { collectGoalFiles(root); }
  catch (error) { warnings.push(`Deleted, but its goal files were kept until the next start: ${(error as Error).message}`); }

  const temporary = cleanupTemporaryChats(root);

  if (temporary) warnings.push(temporary);

  return warnings;
}

function removeBlank(root: string, target: any): string[] {
  const request = { ...target, root: path.join(root, 'sessions') };
  const candidate = blankSession(request);

  if (!candidate || candidate.root !== root || session(root, candidate.id)?.sessionPath !== candidate.target.path) return [];

  return removeSessions(root, [candidate.id]);
}

// Removes the temporary folders of deleted chats that no other chat works in. A folder that another chat works in stays
// until that chat is deleted too.
function cleanupTemporaryChats(root: string): string | undefined {
  try { temporaryChat.cleanupDeleted(root); }
  catch (error) { return `Temporary folder cleanup is tried again at the next deletion or start: ${(error as Error).message}`; }
}

// Deletions run one at a time.
function locked<T>(root: string, nonblocking: boolean, operation: () => T): T | { busy: true } {
  const release = lockSync('session-transactions:' + root, { wait: !nonblocking });

  if (!release) return { busy: true };

  try { return operation(); }
  finally { release(); }
}

function answer(warnings: string[], fields: Record<string, unknown> = {}): Record<string, unknown> { return warnings.length ? { ...fields, warning: warnings.join('\n') } : fields; }

// The worker side of the storage changes that touch files: delete, and delete of a blank chat.
function run(context: { root: string; begin: () => boolean }, request: any): any {
  const root = context.root;

  if (!context.begin()) return { cancelled: true };

  if (request?.action === 'delete') return locked(root, false, () => answer(removeSessions(root, request.sessionIds)));

  if (request?.action === 'delete-blank') return locked(root, true, () => answer(removeBlank(root, request.blank)));

  throw new Error(`Unknown session storage action: ${request?.action}`);
}

// Removes the transcripts and snapshot folders in the sessions area that no session row has, and the goal files that no
// goal row has. A reserved ID whose path is not saved does not keep its file: Pi saves the path before it writes, and a
// new chat saves it only when it commits. It runs at start, before any Pi. Returns the warnings.
function sweep(root: string): string[] {
  const warnings: string[] = [];

  const visit = (directory: string): void => {
    let entries: fs.Dirent[];

    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }

    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      const snapshot = entry.isDirectory() && entry.name.endsWith('.snapshots');

      if (entry.isDirectory() && !snapshot) {
        // Hidden work folders hold no transcripts of their own.
        if (!entry.name.startsWith('.')) visit(file);
        continue;
      }

      const transcript = snapshot ? file.slice(0, -'.snapshots'.length) + '.jsonl' : entry.isFile() && entry.name.endsWith('.jsonl') ? file : undefined;

      if (!transcript || database.sessionIdByPath(root, transcript) !== undefined) continue;

      if (snapshot && fs.existsSync(transcript)) continue;

      try { removeFiles(transcript); }
      catch (error) { warnings.push(`Could not remove the files of deleted conversation ${transcript}: ${(error as Error).message}`); }
    }
  };

  visit(path.join(root, 'sessions'));

  try { collectGoalFiles(root, true); }
  catch (error) { warnings.push(`Could not remove the unused goal files: ${(error as Error).message}`); }

  const temporary = cleanupTemporaryChats(root);

  if (temporary) warnings.push(temporary);

  return warnings;
}

// The chat target names when it is a saved chat without a message and without queued input, else undefined.
function blankSession(target: { root: string; path?: string; id?: string }) {
  const directory = target.root;

  if (!fs.existsSync(directory)) return;
  const root = fs.realpathSync(directory);
  const file = target.path || (target.id && database.lookup(path.dirname(root), target.id));

  if (!file || !fs.existsSync(file)) return;
  const source = fs.realpathSync(file);

  if (path.dirname(source) !== root || !source.endsWith('.jsonl')) return;

  return inspectBlank(root, source, target.id);
}

function inspectBlank(directory: string, file: string, expected: string | undefined) {
  let entries;

  try { entries = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line)); }
  catch { return; }

  const header = entries[0];

  if (!validSessionHeader(header) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(header.id)) return;

  if (header.id === '00000000-0000-4000-8000-000000000001' || (expected && header.id !== expected)) return;

  if (entries.some(entry => entry.type === 'message')) return;
  const root = path.dirname(directory);

  if (database.hasQueuedInput(root, header.id)) return;

  return { root, id: header.id, target: { root: directory, path: file, area: 'sessions' } };
}

type Request =
  | { action: 'delete'; sessionIds: string[] }
  | { action: 'delete-blank'; blank: { path?: string | null; id?: string | null } };

const answerSchema = z.object({ warning: z.string().optional(), busy: z.boolean().optional() });

let operation: HostOperation<Request, z.output<typeof answerSchema>> | undefined;

// Runs request on a worker thread (see run).
async function inWorker(request: Request): Promise<boolean> {
  operation ??= hostOperation<Request, z.output<typeof answerSchema>>('session-storage', 'storage', STORAGE_TIMEOUT, answerSchema);
  const answer = await runHostOperation(operation, request);
  if (answer.warning) console.error(answer.warning);
  return answer.busy !== true;
}

// Deletes the chats ids: their rows at once, then their files.
async function deleteSessions(ids: string[]): Promise<void> {
  await inWorker({ action: 'delete', sessionIds: ids });
}

// Deletes a chat that has no message, unless the storage is busy.
async function deleteBlank(blank: { path?: string | null; id?: string | null }): Promise<void> {
  await inWorker({ action: 'delete-blank', blank });
}

export { session, idOf, descendants, archive, restore, forget, run, sweep, deleteSessions, deleteBlank };
