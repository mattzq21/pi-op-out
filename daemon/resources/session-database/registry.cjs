const { connection } = require('./core.cjs');

// The session registry: session IDs, their paths, names, folders, running tasks, child indexes, external transcripts,
// chat worktrees and conversation ownership.

function registeredSessionIds(root) {
  return connection(root).prepare('SELECT session_id FROM sessions').all().map(row => row.session_id);
}

// Removes a reserved session ID that has no transcript path.
function releaseReservedSession(root, sessionId) {
  connection(root).prepare('DELETE FROM sessions WHERE session_id=? AND session_path IS NULL').run(sessionId);
}

// True when sessionId is registered, with or without a path.
function sessionRowExists(root, sessionId) {
  return Boolean(connection(root).prepare('SELECT EXISTS(SELECT 1 FROM sessions WHERE session_id=?) AS found').get(sessionId).found);
}

// True when sessionId is registered with a transcript path.
function isSavedSession(root, sessionId) {
  return Boolean(connection(root).prepare('SELECT 1 FROM sessions WHERE session_id=? AND session_path IS NOT NULL').get(sessionId));
}

// The ID registered for the transcript sessionPath.
function sessionIdByPath(root, sessionPath) {
  return connection(root).prepare('SELECT session_id FROM sessions WHERE session_path=?').get(sessionPath)?.session_id ?? undefined;
}

// Every registered session with a transcript path, except exceptId.
function savedSessionsExcept(root, exceptId) {
  return connection(root).prepare('SELECT session_id, session_path FROM sessions WHERE session_path IS NOT NULL AND session_id != ?').all(exceptId);
}

// Removes the registry rows of sessionIds: queue origins, transcript references, ownership records and the sessions.
function removeForgottenSessions(root, sessionIds, ownershipKeys) {
  const db = connection(root);
  const origin = db.prepare('DELETE FROM queue_origins WHERE session_id=?');
  const reference = db.prepare('DELETE FROM transcript_references WHERE session_id=lower(?)');
  const ownership = db.prepare('DELETE FROM conversation_ownership WHERE record_id=?');
  const session = db.prepare('DELETE FROM sessions WHERE lower(session_id) = ?');

  for (const id of sessionIds) origin.run(id);
  for (const id of sessionIds) reference.run(id);
  for (const key of ownershipKeys) ownership.run(key);
  for (const id of sessionIds) session.run(id.toLowerCase());
}

function setRunningTask(root, sessionId, running) {
  const db = connection(root);

  if (running) db.prepare('INSERT OR IGNORE INTO running_tasks SELECT session_id FROM sessions WHERE session_id=?').run(sessionId);
  else db.prepare('DELETE FROM running_tasks WHERE session_id=?').run(sessionId);
}

function runningTaskIds(root) {
  return connection(root).prepare('SELECT session_id FROM running_tasks').all().map(row => row.session_id);
}

// Saves the folder of a session when checkedAt is not older than the saved check.
function saveSessionDirectory(root, sessionId, cwd, checkedAt, exists) {
  connection(root).prepare(`INSERT INTO session_directories (session_id, cwd, checked_at, directory_exists) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET cwd=excluded.cwd, checked_at=excluded.checked_at, directory_exists=excluded.directory_exists
    WHERE excluded.checked_at >= session_directories.checked_at`).run(sessionId, cwd, checkedAt, Number(exists));
}

// Marks the transcript of sessionId as being written: its saved file metadata is no longer valid.
function markSessionFileWrite(root, sessionId) {
  const db = connection(root);

  db.prepare('DELETE FROM session_file_metadata WHERE session_id=?').run(sessionId);
  db.prepare('INSERT INTO session_file_writes VALUES (?) ON CONFLICT DO NOTHING').run(sessionId);
}

function saveRegisteredFileMetadata(root, sessionId, sessionPath, modifiedNs, size) {
  const db = connection(root);

  db.prepare('DELETE FROM session_file_metadata WHERE session_id=?').run(sessionId);
  db.prepare('INSERT INTO session_file_metadata VALUES (?, ?, ?, ?)').run(sessionId, sessionPath, modifiedNs, size);
  db.prepare('DELETE FROM session_file_writes WHERE session_id=?').run(sessionId);
}

function sessionNameOf(root, sessionId) {
  return connection(root).prepare('SELECT name FROM session_names WHERE session_id=?').get(sessionId)?.name;
}

// Saves the name of sessionId. Without replace, an existing name stays.
function saveSessionName(root, sessionId, name, replace) {
  connection(root).prepare(`INSERT INTO session_names (session_id, name) VALUES (?, ?) ON CONFLICT(session_id) DO ${replace ? 'UPDATE SET name=excluded.name' : 'NOTHING'}`).run(sessionId, name);
}

// True when sessionId is registered and, when sessionPath is not empty, has that path.
function childIndexIdentity(root, sessionId, sessionPath) {
  return Boolean(connection(root).prepare("SELECT 1 FROM sessions WHERE session_id=? AND (? = '' OR session_path=?)").get(sessionId, sessionPath, sessionPath));
}

// The child index of sessionId, or undefined.
function readChildIndex(root, sessionId) {
  const db = connection(root);
  const saved = db.prepare(`SELECT s.session_path, c.complete FROM auxiliary_child_state c
    JOIN sessions s USING(session_id) WHERE c.session_id=?`).get(sessionId);

  if (!saved) return;

  const children = db.prepare(`SELECT c.child_id AS sessionId, coalesce(s.session_path, '') AS sessionPath, c.kind
    FROM auxiliary_children c JOIN sessions s ON s.session_id=c.child_id WHERE c.parent_id=?`).all(sessionId);

  return { version: 1, sessionId, sessionPath: saved.session_path ?? '', complete: Boolean(saved.complete), children };
}

// Replaces the child index of value.sessionId. Does nothing when the session is not registered; skips children that are not.
function saveChildIndex(root, value) {
  if (!childIndexIdentity(root, value.sessionId, value.sessionPath)) return;
  const db = connection(root);

  db.prepare('INSERT INTO auxiliary_child_state VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET complete=excluded.complete')
    .run(value.sessionId, Number(value.complete));
  db.prepare('DELETE FROM auxiliary_children WHERE parent_id=?').run(value.sessionId);
  const insert = db.prepare('INSERT INTO auxiliary_children (parent_id, child_id, kind) VALUES (?, ?, ?)');

  for (const child of value.children) {
    if (childIndexIdentity(root, child.sessionId, child.sessionPath)) insert.run(value.sessionId, child.sessionId, child.kind);
  }
}

// Adds child to the child index of parentId when both are registered.
function addIndexedChild(root, parentId, parentPath, child) {
  if (!childIndexIdentity(root, parentId, parentPath) || !childIndexIdentity(root, child.sessionId, child.sessionPath)) return;
  const db = connection(root);

  db.prepare('INSERT INTO auxiliary_child_state VALUES (?, 0) ON CONFLICT(session_id) DO NOTHING').run(parentId);
  db.prepare(`INSERT INTO auxiliary_children (parent_id, child_id, kind) VALUES (?, ?, ?)
    ON CONFLICT(parent_id, child_id) DO UPDATE SET kind=excluded.kind`).run(parentId, child.sessionId, child.kind);
}

// The chats of the tree of sessionId: its root chat and every side chat under that root. sessionId comes first.
function sessionTreeIds(root, sessionId) {
  const db = connection(root);
  const parent = db.prepare('SELECT parent_id FROM auxiliary_children WHERE child_id=?');
  let top = sessionId;
  const seen = new Set([sessionId]);

  for (let row; (row = parent.get(top)) && !seen.has(row.parent_id);) { top = row.parent_id; seen.add(top); }
  const found = db.prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT c.child_id FROM auxiliary_children c JOIN tree t ON c.parent_id=t.id)
    SELECT id FROM tree`).all(top);

  return [...new Set([sessionId, ...found.map(row => row.id)])];
}

// Every side chat under parentId, at any depth.
function auxiliaryDescendantIds(root, parentId) {
  return connection(root).prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT child_id FROM auxiliary_children WHERE parent_id=?
      UNION SELECT c.child_id FROM auxiliary_children c JOIN descendants d ON c.parent_id=d.id
    ) SELECT id FROM descendants`).all(parentId).map(row => row.id);
}

function externalTranscriptRows(root) {
  return connection(root).prepare('SELECT record_id, record_json FROM external_transcripts ORDER BY record_id').all();
}

// Adds an external transcript record or merges recordJson into the saved one.
function saveExternalTranscript(root, recordId, recordJson) {
  connection(root).prepare('INSERT INTO external_transcripts VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET record_json=json_patch(external_transcripts.record_json, excluded.record_json)')
    .run(recordId, recordJson);
}

// Removes the external transcript record when it is still recordJson.
function removeExternalTranscriptRow(root, recordId, recordJson) {
  connection(root).prepare('DELETE FROM external_transcripts WHERE record_id=? AND record_json=?').run(recordId, recordJson);
}

// The saved session ID of the external transcript sessionPath: undefined when there is no record, null when it has no ID.
function externalTranscriptIdentity(root, recordId, sessionPath) {
  const row = connection(root).prepare("SELECT json_extract(record_json, '$.sessionId') AS id FROM external_transcripts WHERE record_id=? AND json_extract(record_json, '$.path')=?").get(recordId, sessionPath);

  return row ? row.id : undefined;
}

function setExternalTranscriptIdentity(root, recordId, sessionId) {
  connection(root).prepare("UPDATE external_transcripts SET record_json=json_set(record_json, '$.sessionId', ?) WHERE record_id=?").run(sessionId, recordId);
}

function chatWorktreeBody(root, chatId) {
  return connection(root).prepare('SELECT record_json FROM chat_worktrees WHERE chat_id=?').get(chatId)?.record_json ?? null;
}

function chatWorktreeBodies(root) {
  return connection(root).prepare('SELECT record_json FROM chat_worktrees ORDER BY chat_id').all().map(row => row.record_json);
}

// Writes the chat worktree record body of chatId; previous is the saved body or null, body null removes it.
function writeChatWorktreeBody(root, chatId, previous, body) {
  const db = connection(root);

  if (body === null) db.prepare('DELETE FROM chat_worktrees WHERE chat_id=?').run(chatId);
  else if (previous === null) db.prepare('INSERT INTO chat_worktrees VALUES (?, ?)').run(chatId, body);
  else db.prepare('UPDATE chat_worktrees SET record_json=? WHERE chat_id=?').run(body, chatId);
}

function conversationOwnershipBody(root, recordKey) {
  return connection(root).prepare('SELECT record_json FROM conversation_ownership WHERE record_id=?').get(recordKey)?.record_json;
}

function saveConversationOwnership(root, recordKey, body) {
  connection(root).prepare('INSERT INTO conversation_ownership VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET record_json=excluded.record_json').run(recordKey, body);
}

function removeConversationOwnership(root, recordKey) {
  connection(root).prepare('DELETE FROM conversation_ownership WHERE record_id=?').run(recordKey);
}

function mailboxHasMessages(root, sessionId) {
  return Boolean(connection(root).prepare('SELECT 1 FROM session_mailbox WHERE session_id=? LIMIT 1').get(sessionId));
}

function mailboxHasDelivery(root, sessionId, deliveryId) {
  return Boolean(connection(root).prepare('SELECT 1 FROM session_mailbox WHERE session_id=? AND delivery_id=?').get(sessionId, deliveryId));
}

function subagentRunBodies(root, sessionId) {
  return connection(root).prepare('SELECT run_json FROM session_subagent_runs WHERE session_id=?').all(sessionId).map(row => String(row.run_json));
}

module.exports = { registeredSessionIds, releaseReservedSession, sessionRowExists, isSavedSession, sessionIdByPath, savedSessionsExcept,
  removeForgottenSessions, setRunningTask, runningTaskIds, saveSessionDirectory, markSessionFileWrite, saveRegisteredFileMetadata, sessionNameOf,
  saveSessionName, readChildIndex, saveChildIndex, addIndexedChild, sessionTreeIds, auxiliaryDescendantIds,
  externalTranscriptRows, saveExternalTranscript, removeExternalTranscriptRow, externalTranscriptIdentity, setExternalTranscriptIdentity,
  chatWorktreeBody, chatWorktreeBodies, writeChatWorktreeBody, conversationOwnershipBody, saveConversationOwnership, removeConversationOwnership,
  mailboxHasMessages, mailboxHasDelivery, subagentRunBodies };
