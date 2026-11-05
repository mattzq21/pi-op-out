const fs = require('node:fs');
const path = require('node:path');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const database = require('./session-database.cjs');
const { onMainThread } = require('./main-thread.cjs');

// A transcript stays where it was made for its whole life. A new chat writes its files, and then its rows in one
// transaction. Archive and restore change only its database row; delete removes its rows in one transaction, and its
// files after that. The start sweep removes the files that a stop between the two steps left without rows.

const idsSchema = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 });

function checkedIds(ids) {
  if (!Check(idsSchema, ids) || new Set(ids).size !== ids.length) throw new Error('Invalid session IDs');

  return ids;
}

function row(db, id) {
  const saved = db.prepare('SELECT session_id, session_path, archived FROM sessions WHERE session_id=? AND session_path IS NOT NULL').get(id);

  return saved && { sessionId: saved.session_id, sessionPath: saved.session_path, archived: saved.archived === 1 };
}

// The saved chat of id, or undefined.
function session(root, id) { return row(database.connection(root), id); }

// The ID of the saved chat whose transcript is file, or undefined.
function idOf(root, file) { return database.connection(root).prepare('SELECT session_id FROM sessions WHERE session_path=?').get(file)?.session_id; }

function sessions(db, ids) {
  return checkedIds(ids).map(id => {
    const saved = row(db, id);

    if (!saved) throw new Error('This conversation has been deleted');

    return saved;
  });
}

// The chats under sessionId, each once, parents before children. Only chats of the given kinds and archive state, and
// the chats under them, are included.
function descendants(root, sessionId, filter = {}) {
  const children = database.connection(root).prepare(`SELECT c.child_id AS sessionId, c.kind, s.session_path AS sessionPath, s.archived
    FROM auxiliary_children c JOIN sessions s ON s.session_id=c.child_id WHERE c.parent_id=? AND s.session_path IS NOT NULL`);
  const seen = new Set([sessionId]);
  const result = [];

  for (let queue = [sessionId], cursor = 0; cursor < queue.length; cursor++) {
    for (const child of children.all(queue[cursor])) {
      if (seen.has(child.sessionId) || (filter.kinds && !filter.kinds.includes(child.kind))) continue;
      seen.add(child.sessionId);

      if (filter.archived !== undefined && (child.archived === 1) !== filter.archived) continue;
      result.push({ sessionId: child.sessionId, sessionPath: child.sessionPath, archived: child.archived === 1 });
      queue.push(child.sessionId);
    }
  }

  return result;
}

function setArchived(root, ids, archived) {
  const db = database.connection(root);

  database.transaction(db, 'IMMEDIATE', () => {
    for (const saved of sessions(db, ids)) {
      if (saved.archived === archived) throw new Error(archived ? 'This conversation is already archived' : 'This conversation is not archived');
    }

    const update = db.prepare('UPDATE sessions SET archived=? WHERE session_id=?');

    for (const id of ids) {
      update.run(Number(archived), id);
      // An archived chat has no owner.
      if (archived) require('./conversation-storage.cjs').forget(db, id);
    }
  });
}

const archive = onMainThread('session-lifecycle.archive', (root, ids) => setArchived(root, ids, true));

const restore = onMainThread('session-lifecycle.restore', (root, ids) => setArchived(root, ids, false));

// Removes the rows of the chats ids (the tables that refer to them cascade), and asks for the cleanup of temporary
// folders that only they used.
const forget = onMainThread('session-lifecycle.forget', (root, ids) => {
  const db = database.connection(root);

  database.transaction(db, 'IMMEDIATE', () => {
    sessions(db, ids);
    const remove = db.prepare('DELETE FROM sessions WHERE session_id=?');

    for (const id of ids) {
      require('./conversation-storage.cjs').forget(db, id);
      remove.run(id);
    }

    db.prepare("INSERT INTO cleanup_requests VALUES ('temporary-chat', 1) ON CONFLICT(kind) DO UPDATE SET revision=revision+1").run();
  });
});

function snapshots(file) { return file.replace(/\.jsonl$/, '.snapshots'); }

function removeFiles(file) {
  fs.rmSync(snapshots(file), { recursive: true, force: true });
  fs.rmSync(file, { force: true });
}

// The deletion of the chats ids: their rows in one transaction, and then their files and the goal files that only they used.
function deleteSessions(root, ids) {
  const targets = sessions(database.connection(root), ids).map(saved => saved.sessionPath);

  forget(root, ids);
  const warnings = [];

  for (const target of targets) {
    try { removeFiles(target); }
    catch (error) { warnings.push(`Deleted, but the files of ${target} were kept until the next start: ${error.message}`); }
  }

  try { require('./piop-storage/goal-files.cjs').collect(root); }
  catch (error) { warnings.push(`Deleted, but its goal files were kept until the next start: ${error.message}`); }

  warnings.push(...maintenance(root));

  return warnings;
}

function deleteBlank(root, target) {
  const blank = require('./blank-session-target.cjs');
  const request = { ...target, root: path.join(root, 'sessions') };
  const candidate = blank.prepare(request);

  if (!candidate || candidate.root !== root || session(root, candidate.id)?.sessionPath !== candidate.target.path) return [];

  return deleteSessions(root, [candidate.id]);
}

function cleanupTemporaryChats(root) {
  try {
    const revision = database.cleanupRequest(root, 'temporary-chat');

    if (revision === undefined) return;
    const result = require('./temporary-chat.cjs').cleanupDeleted(root);

    if (result?.pending) return result.warning;
    database.finishCleanup(root, 'temporary-chat', revision);
  } catch (error) { return `Temporary folder cleanup will retry: ${error.message}`; }
}

// Finishes temporary folder cleanup. Returns the warnings.
function maintenance(root) {
  const warnings = [];
  const temporary = cleanupTemporaryChats(root);

  if (temporary) warnings.push(temporary);

  return warnings;
}

// Deletions and maintenance run one at a time.
function locked(root, nonblocking, operation) {
  const release = require('./storage-locks.cjs').lockSync('session-transactions:' + root, { wait: !nonblocking });

  if (!release) return { busy: true };

  try { return operation(); }
  finally { release(); }
}

function answer(warnings, fields = {}) { return warnings.length ? { ...fields, warning: warnings.join('\n') } : fields; }

// The worker side of the storage changes that touch files: delete, delete of a blank chat, and maintenance.
function run(context, request) {
  const root = context.root;

  if (!context.begin()) return { cancelled: true };

  if (request?.action === 'delete') return locked(root, false, () => answer(deleteSessions(root, request.sessionIds)));

  if (request?.action === 'delete-blank') return locked(root, true, () => answer(deleteBlank(root, request.blank)));

  if (request?.action === 'maintain') {
    return locked(root, true, () => {
      const warnings = maintenance(root);

      if (warnings.length) throw new Error(warnings.join('\n'));

      return {};
    });
  }
  throw new Error(`Unknown session storage action: ${request?.action}`);
}

// Removes the transcripts and snapshot folders in the sessions area that no session row has, and the goal files that no
// goal row has. A reserved ID whose path is not saved does not keep its file: Pi saves the path before it writes, and a
// new chat saves it only when it commits. It runs at start, before any Pi. Returns the warnings.
function sweep(root) {
  const db = database.connection(root);
  const registered = db.prepare('SELECT 1 FROM sessions WHERE session_path=?');
  const warnings = [];

  const visit = directory => {
    let entries;

    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }

    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      const snapshot = entry.isDirectory() && entry.name.endsWith('.snapshots');

      if (entry.isDirectory() && !snapshot) {
        // Hidden work folders hold no transcripts of their own.
        if (!entry.name.startsWith('.')) visit(file);
        continue;
      }

      const transcript = snapshot ? file.slice(0, -'.snapshots'.length) + '.jsonl' : entry.isFile() && entry.name.endsWith('.jsonl') ? file : undefined;

      if (!transcript || registered.get(transcript)) continue;

      if (snapshot && fs.existsSync(transcript)) continue;

      try { removeFiles(transcript); }
      catch (error) { warnings.push(`Could not remove the files of deleted conversation ${transcript}: ${error.message}`); }
    }
  };

  visit(path.join(root, 'sessions'));

  try { require('./piop-storage/goal-files.cjs').collect(root, true); }
  catch (error) { warnings.push(`Could not remove the unused goal files: ${error.message}`); }

  return warnings;
}

module.exports = { session, idOf, descendants, archive, restore, forget, run, sweep };
