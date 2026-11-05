import { connection, rows } from './core.ts';

export type StorageJournalRow = { id: string; kind: string; state: string; journal_json: string };

export type TemporaryChatAllocation = { session_id: string; original_path: string };


// Storage transaction journals.
function insertStorageJournal(root: string, id: string, kind: string, state: string, body: string): void {
  connection(root).prepare('INSERT INTO storage_transactions VALUES (?, ?, ?, ?)').run(id, kind, state, body);
}

// True when the journal id was there and is now changed.
function updateStorageJournal(root: string, id: string, state: string, body: string): boolean {
  return connection(root).prepare('UPDATE storage_transactions SET state=?, journal_json=? WHERE id=?').run(state, body, id).changes === 1;
}

function deleteStorageJournal(root: string, id: string): void {
  connection(root).prepare('DELETE FROM storage_transactions WHERE id=?').run(id);
}

function storageJournalRows(root: string): StorageJournalRow[] {
  return rows(root, 'SELECT id, kind, state, journal_json FROM storage_transactions ORDER BY id');
}

// Restore receipts.
function restoreReceiptBody(root: string, id: string): string | undefined {
  return (connection(root).prepare('SELECT record_json FROM session_restore_receipts WHERE record_id=?').get(id) as { record_json: string } | undefined)?.record_json;
}

function restoreReceiptIds(root: string): string[] {
  return rows<{ record_id: string }>(root, 'SELECT record_id FROM session_restore_receipts ORDER BY record_id').map(row => row.record_id);
}

// True when the receipt id had the body and is now removed.
function removeRestoreReceipt(root: string, id: string, body: string): boolean {
  return connection(root).prepare('DELETE FROM session_restore_receipts WHERE record_id=? AND record_json=?').run(id, body).changes === 1;
}

function saveRestoreReceipt(root: string, id: string, body: string): void {
  connection(root).prepare('INSERT INTO session_restore_receipts VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET record_json=excluded.record_json').run(id, body);
}

// Temporary chat folders.
function temporaryChatFolder(root: string, id: string): string | undefined {
  return (connection(root).prepare('SELECT original_path FROM temporary_chat_allocations WHERE session_id=?').get(id) as { original_path: string } | undefined)?.original_path;
}

function temporaryChatOwner(root: string, directory: string): string | undefined {
  return (connection(root).prepare('SELECT session_id FROM temporary_chat_allocations WHERE original_path=?').get(directory) as { session_id: string } | undefined)?.session_id;
}

function insertTemporaryChatFolder(root: string, id: string, directory: string): void {
  connection(root).prepare('INSERT INTO temporary_chat_allocations (session_id, original_path) VALUES (?, ?)').run(id, directory);
}

function temporaryChatAllocations(root: string): TemporaryChatAllocation[] {
  return rows(root, 'SELECT session_id, original_path FROM temporary_chat_allocations ORDER BY session_id');
}

// The temporary chat folders whose session ID is no longer in the storage database.
function orphanTemporaryChatAllocations(root: string): TemporaryChatAllocation[] {
  return rows(root, 'SELECT a.session_id, a.original_path FROM temporary_chat_allocations a WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id=a.session_id)');
}

function removeTemporaryChatAllocation(root: string, id: string, directory: string): void {
  connection(root).prepare('DELETE FROM temporary_chat_allocations WHERE session_id=? AND original_path=?').run(id, directory);
}

// Removes the session ID when it is only reserved and has no transcript path.
function removeReservedSessionId(root: string, id: string): void {
  connection(root).prepare('DELETE FROM sessions WHERE session_id=? AND session_path IS NULL').run(id);
}

function temporaryChatSessionExists(root: string, id: string): boolean {
  return Boolean(connection(root).prepare('SELECT 1 FROM sessions WHERE session_id=?').get(id));
}

function temporaryChatSessionRows(root: string): { session_id: string; session_path: string }[] {
  return rows(root, 'SELECT session_id, session_path FROM sessions WHERE session_path IS NOT NULL ORDER BY session_id');
}

// The text of each queued input, with the session ID it belongs to.
function temporaryChatQueuedTexts(root: string): { session_id: string; text: string }[] {
  return rows(root, `SELECT session_id, cwd || COALESCE(session_path, '') AS text FROM queue_origins UNION ALL SELECT session_id, message || details_json AS text FROM queue_items UNION ALL SELECT q.session_id, a.details_json AS text FROM queue_attachments a JOIN queue_items q USING(queue_item_id)`);
}

// Subagent runs copied with a fork.
function forkSourceSubagentRuns(root: string, sessionId: string): any[] {
  return rows<{ run_json: string }>(root, 'SELECT run_json FROM session_subagent_runs WHERE session_id=? ORDER BY started_at, run_id', sessionId).map(row => JSON.parse(row.run_json));
}

function markForkSubagentState(root: string, sessionId: string): void {
  connection(root).prepare('INSERT INTO session_subagent_state VALUES (?) ON CONFLICT(session_id) DO NOTHING').run(sessionId);
}

function saveForkSubagentRun(root: string, sessionId: string, runId: string, startedAt: number, run: unknown): void {
  connection(root).prepare('INSERT INTO session_subagent_runs VALUES (?, ?, ?, ?) ON CONFLICT(session_id, run_id) DO UPDATE SET run_json=excluded.run_json')
    .run(sessionId, runId, startedAt, JSON.stringify(run));
}

// Deferred retention candidates.
function retentionCandidateBody(root: string, id: string): string | undefined {
  return (connection(root).prepare('SELECT record_json FROM retention_candidates WHERE record_id=?').get(id) as { record_json: string } | undefined)?.record_json;
}

function insertRetentionCandidate(root: string, id: string, body: string): void {
  connection(root).prepare('INSERT INTO retention_candidates VALUES (?, ?, ?)').run(id, body, Date.now());
}

function delayRetentionCandidate(root: string, id: string): void {
  connection(root).prepare('UPDATE retention_candidates SET retry_at=? WHERE record_id=?').run(Date.now(), id);
}

function dueRetentionCandidates(root: string, limit: number): { record_id: string; record_json: string }[] {
  return rows(root, 'SELECT record_id, record_json FROM retention_candidates ORDER BY retry_at, record_id LIMIT ?', limit);
}

function removeRetentionCandidate(root: string, id: string): void {
  connection(root).prepare('DELETE FROM retention_candidates WHERE record_id=?').run(id);
}

// The IDs in sessionIds that have no row in the session registry. IDs compare without case.
function unregisteredSessionIds(root: string, sessionIds: string[]): string[] {
  const read = connection(root).prepare('SELECT 1 FROM sessions WHERE lower(session_id) = ?');

  return sessionIds.filter(id => !read.get(id.toLowerCase()));
}

// The working folder of each session that has one, for the storage inventory.
function inventorySessionDirectories(root: string): { session_id: string; session_path: string | null; cwd: string }[] {
  return rows(root, 'SELECT r.session_id, s.session_path, r.cwd FROM session_directories r JOIN sessions s USING(session_id)');
}

export { insertStorageJournal, updateStorageJournal, deleteStorageJournal, storageJournalRows, restoreReceiptBody, restoreReceiptIds, removeRestoreReceipt, saveRestoreReceipt, temporaryChatFolder, temporaryChatOwner, insertTemporaryChatFolder, temporaryChatAllocations, orphanTemporaryChatAllocations, removeTemporaryChatAllocation, removeReservedSessionId, temporaryChatSessionExists, temporaryChatSessionRows, temporaryChatQueuedTexts, forkSourceSubagentRuns, markForkSubagentState, saveForkSubagentRun, retentionCandidateBody, insertRetentionCandidate, delayRetentionCandidate, dueRetentionCandidates, removeRetentionCandidate, unregisteredSessionIds, inventorySessionDirectories };
