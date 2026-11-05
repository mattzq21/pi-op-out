import { connection } from './core.ts';

export interface IndexedChild { sessionId: string; sessionPath: string; kind: string }

export interface ChildIndexRows { version: 1; sessionId: string; sessionPath: string; complete: boolean; children: IndexedChild[] }


// The session registry: session IDs, their paths, names, folders, running tasks, child indexes, external transcripts,
// chat worktrees and conversation ownership.

function registeredSessionIds(root: string): string[] {
  return connection(root).prepare('SELECT session_id FROM sessions').all().map(row => row.session_id as string);
}

// Removes a reserved session ID that has no transcript path.
function releaseReservedSession(root: string, sessionId: string): void {
  connection(root).prepare('DELETE FROM sessions WHERE session_id=? AND session_path IS NULL').run(sessionId);
}

// True when sessionId is registered, with or without a path.
function sessionRowExists(root: string, sessionId: string): boolean {
  return Boolean((connection(root).prepare('SELECT EXISTS(SELECT 1 FROM sessions WHERE session_id=?) AS found').get(sessionId) as { found: number }).found);
}

// True when sessionId is registered with a transcript path.
function isSavedSession(root: string, sessionId: string): boolean {
  return Boolean(connection(root).prepare('SELECT 1 FROM sessions WHERE session_id=? AND session_path IS NOT NULL').get(sessionId));
}

// The ID registered for the transcript sessionPath.
function sessionIdByPath(root: string, sessionPath: string): string | undefined {
  return (connection(root).prepare('SELECT session_id FROM sessions WHERE session_path=?').get(sessionPath) as { session_id: string } | undefined)?.session_id ?? undefined;
}

// Every registered session with a transcript path, except exceptId.
function savedSessionsExcept(root: string, exceptId: string): Array<{ session_id: string; session_path: string }> {
  return connection(root).prepare('SELECT session_id, session_path FROM sessions WHERE session_path IS NOT NULL AND session_id != ?').all(exceptId) as Array<{ session_id: string; session_path: string }>;
}

// Removes the registry rows of sessionIds: queue origins, transcript references, ownership records and the sessions.
function removeForgottenSessions(root: string, sessionIds: string[], ownershipKeys: string[]): void {
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

function setRunningTask(root: string, sessionId: string, running: boolean): void {
  const db = connection(root);

  if (running) db.prepare('INSERT OR IGNORE INTO running_tasks SELECT session_id FROM sessions WHERE session_id=?').run(sessionId);
  else db.prepare('DELETE FROM running_tasks WHERE session_id=?').run(sessionId);
}

function runningTaskIds(root: string): string[] {
  return connection(root).prepare('SELECT session_id FROM running_tasks').all().map(row => row.session_id as string);
}

// Saves the folder of a session when checkedAt is not older than the saved check.
function saveSessionDirectory(root: string, sessionId: string, cwd: string, checkedAt: number, exists: boolean): void {
  connection(root).prepare(`INSERT INTO session_directories (session_id, cwd, checked_at, directory_exists) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET cwd=excluded.cwd, checked_at=excluded.checked_at, directory_exists=excluded.directory_exists
    WHERE excluded.checked_at >= session_directories.checked_at`).run(sessionId, cwd, checkedAt, Number(exists));
}

// Marks the transcript of sessionId as being written: its saved file metadata is no longer valid.
function markSessionFileWrite(root: string, sessionId: string): void {
  const db = connection(root);

  db.prepare('DELETE FROM session_file_metadata WHERE session_id=?').run(sessionId);
  db.prepare('INSERT INTO session_file_writes VALUES (?) ON CONFLICT DO NOTHING').run(sessionId);
}

function saveRegisteredFileMetadata(root: string, sessionId: string, sessionPath: string, modifiedNs: string, size: number | bigint): void {
  const db = connection(root);

  db.prepare('DELETE FROM session_file_metadata WHERE session_id=?').run(sessionId);
  db.prepare('INSERT INTO session_file_metadata VALUES (?, ?, ?, ?)').run(sessionId, sessionPath, modifiedNs, size);
  db.prepare('DELETE FROM session_file_writes WHERE session_id=?').run(sessionId);
}

function sessionNameOf(root: string, sessionId: string): string | undefined {
  return (connection(root).prepare('SELECT name FROM session_names WHERE session_id=?').get(sessionId) as { name: string } | undefined)?.name;
}

// Saves the name of sessionId. Without replace, an existing name stays.
function saveSessionName(root: string, sessionId: string, name: string, replace: boolean): void {
  connection(root).prepare(`INSERT INTO session_names (session_id, name) VALUES (?, ?) ON CONFLICT(session_id) DO ${replace ? 'UPDATE SET name=excluded.name' : 'NOTHING'}`).run(sessionId, name);
}

// True when sessionId is registered and, when sessionPath is not empty, has that path.
function childIndexIdentity(root: string, sessionId: string, sessionPath: string): boolean {
  return Boolean(connection(root).prepare("SELECT 1 FROM sessions WHERE session_id=? AND (? = '' OR session_path=?)").get(sessionId, sessionPath, sessionPath));
}

// The child index of sessionId, or undefined.
function readChildIndex(root: string, sessionId: string): ChildIndexRows | undefined {
  const db = connection(root);
  const saved = db.prepare(`SELECT s.session_path, c.complete FROM auxiliary_child_state c
    JOIN sessions s USING(session_id) WHERE c.session_id=?`).get(sessionId) as { session_path: string | null; complete: number } | undefined;

  if (!saved) return;

  const children = db.prepare(`SELECT c.child_id AS sessionId, coalesce(s.session_path, '') AS sessionPath, c.kind
    FROM auxiliary_children c JOIN sessions s ON s.session_id=c.child_id WHERE c.parent_id=?`).all(sessionId) as unknown as IndexedChild[];

  return { version: 1, sessionId, sessionPath: saved.session_path ?? '', complete: Boolean(saved.complete), children };
}

// Replaces the child index of value.sessionId. Does nothing when the session is not registered; skips children that are not.
function saveChildIndex(root: string, value: ChildIndexRows): void {
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
function addIndexedChild(root: string, parentId: string, parentPath: string, child: IndexedChild): void {
  if (!childIndexIdentity(root, parentId, parentPath) || !childIndexIdentity(root, child.sessionId, child.sessionPath)) return;
  const db = connection(root);

  db.prepare('INSERT INTO auxiliary_child_state VALUES (?, 0) ON CONFLICT(session_id) DO NOTHING').run(parentId);
  db.prepare(`INSERT INTO auxiliary_children (parent_id, child_id, kind) VALUES (?, ?, ?)
    ON CONFLICT(parent_id, child_id) DO UPDATE SET kind=excluded.kind`).run(parentId, child.sessionId, child.kind);
}

// The chats of the tree of sessionId: its root chat and every side chat under that root. sessionId comes first.
function sessionTreeIds(root: string, sessionId: string): string[] {
  const db = connection(root);
  const parent = db.prepare('SELECT parent_id FROM auxiliary_children WHERE child_id=?');
  const parentOf = (id: string) => parent.get(id) as { parent_id: string } | undefined;
  let top = sessionId;
  const seen = new Set([sessionId]);

  for (let row; (row = parentOf(top)) && !seen.has(row.parent_id);) { top = row.parent_id; seen.add(top); }
  const found = db.prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT c.child_id FROM auxiliary_children c JOIN tree t ON c.parent_id=t.id)
    SELECT id FROM tree`).all(top) as Array<{ id: string }>;

  return [...new Set([sessionId, ...found.map(row => row.id)])];
}

// Every side chat under parentId, at any depth.
function auxiliaryDescendantIds(root: string, parentId: string): string[] {
  return connection(root).prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT child_id FROM auxiliary_children WHERE parent_id=?
      UNION SELECT c.child_id FROM auxiliary_children c JOIN descendants d ON c.parent_id=d.id
    ) SELECT id FROM descendants`).all(parentId).map(row => row.id as string);
}

function externalTranscriptRows(root: string): Array<{ record_id: string; record_json: string }> {
  return connection(root).prepare('SELECT record_id, record_json FROM external_transcripts ORDER BY record_id').all() as Array<{ record_id: string; record_json: string }>;
}

// Adds an external transcript record or merges recordJson into the saved one.
function saveExternalTranscript(root: string, recordId: string, recordJson: string): void {
  connection(root).prepare('INSERT INTO external_transcripts VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET record_json=json_patch(external_transcripts.record_json, excluded.record_json)')
    .run(recordId, recordJson);
}

// Removes the external transcript record when it is still recordJson.
function removeExternalTranscriptRow(root: string, recordId: string, recordJson: string): void {
  connection(root).prepare('DELETE FROM external_transcripts WHERE record_id=? AND record_json=?').run(recordId, recordJson);
}

// The saved session ID of the external transcript sessionPath: undefined when there is no record, null when it has no ID.
function externalTranscriptIdentity(root: string, recordId: string, sessionPath: string): string | null | undefined {
  const row = connection(root).prepare("SELECT json_extract(record_json, '$.sessionId') AS id FROM external_transcripts WHERE record_id=? AND json_extract(record_json, '$.path')=?").get(recordId, sessionPath) as { id: string | null } | undefined;

  return row ? row.id : undefined;
}

function setExternalTranscriptIdentity(root: string, recordId: string, sessionId: string): void {
  connection(root).prepare("UPDATE external_transcripts SET record_json=json_set(record_json, '$.sessionId', ?) WHERE record_id=?").run(sessionId, recordId);
}

function chatWorktreeBody(root: string, chatId: string): string | null {
  return (connection(root).prepare('SELECT record_json FROM chat_worktrees WHERE chat_id=?').get(chatId) as { record_json: string } | undefined)?.record_json ?? null;
}

function chatWorktreeBodies(root: string): string[] {
  return connection(root).prepare('SELECT record_json FROM chat_worktrees ORDER BY chat_id').all().map(row => row.record_json as string);
}

// Writes the chat worktree record body of chatId; previous is the saved body or null, body null removes it.
function writeChatWorktreeBody(root: string, chatId: string, previous: string | null, body: string | null): void {
  const db = connection(root);

  if (body === null) db.prepare('DELETE FROM chat_worktrees WHERE chat_id=?').run(chatId);
  else if (previous === null) db.prepare('INSERT INTO chat_worktrees VALUES (?, ?)').run(chatId, body);
  else db.prepare('UPDATE chat_worktrees SET record_json=? WHERE chat_id=?').run(body, chatId);
}

function conversationOwnershipBody(root: string, recordKey: string): string | undefined {
  return (connection(root).prepare('SELECT record_json FROM conversation_ownership WHERE record_id=?').get(recordKey) as { record_json: string } | undefined)?.record_json;
}

function saveConversationOwnership(root: string, recordKey: string, body: string): void {
  connection(root).prepare('INSERT INTO conversation_ownership VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET record_json=excluded.record_json').run(recordKey, body);
}

function removeConversationOwnership(root: string, recordKey: string): void {
  connection(root).prepare('DELETE FROM conversation_ownership WHERE record_id=?').run(recordKey);
}

function mailboxHasMessages(root: string, sessionId: string): boolean {
  return Boolean(connection(root).prepare('SELECT 1 FROM session_mailbox WHERE session_id=? LIMIT 1').get(sessionId));
}

function mailboxHasDelivery(root: string, sessionId: string, deliveryId: string): boolean {
  return Boolean(connection(root).prepare('SELECT 1 FROM session_mailbox WHERE session_id=? AND delivery_id=?').get(sessionId, deliveryId));
}

function subagentRunBodies(root: string, sessionId: string): string[] {
  return connection(root).prepare('SELECT run_json FROM session_subagent_runs WHERE session_id=?').all(sessionId).map(row => String(row.run_json));
}

export { registeredSessionIds, releaseReservedSession, sessionRowExists, isSavedSession, sessionIdByPath, savedSessionsExcept, removeForgottenSessions, setRunningTask, runningTaskIds, saveSessionDirectory, markSessionFileWrite, saveRegisteredFileMetadata, sessionNameOf, saveSessionName, readChildIndex, saveChildIndex, addIndexedChild, sessionTreeIds, auxiliaryDescendantIds, externalTranscriptRows, saveExternalTranscript, removeExternalTranscriptRow, externalTranscriptIdentity, setExternalTranscriptIdentity, chatWorktreeBody, chatWorktreeBodies, writeChatWorktreeBody, conversationOwnershipBody, saveConversationOwnership, removeConversationOwnership, mailboxHasMessages, mailboxHasDelivery, subagentRunBodies };
