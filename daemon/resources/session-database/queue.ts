import { connection, transaction } from './core.ts';

export type SavedQueue = { version: 1; origin: { cwd: string; sessionPath: string | null }; items: any[] };

export type QueueRow = { id: number; message: string; behavior: "steer" | "followUp"; details: string; images: Array<{ mimeType: string | null; data: Buffer; details: string }> };

export type SubmissionState = "received" | "accepted" | "rejected";


// Queued input, submission outcomes, agent mail, subagent runs and the per-chat state records.

// ---- Queued input ----

interface QueueImageRow { media_type: string | null; data: Uint8Array; details_json: string }

interface QueueItemRow { queue_item_id: number; message: string; behavior: string; details_json: string }

function queueImages(root: string, itemId: number): any[] {
  return (connection(root).prepare('SELECT media_type, data, details_json FROM queue_attachments WHERE queue_item_id=? ORDER BY attachment_position').all(itemId) as unknown as QueueImageRow[])
    .map(row => ({ ...JSON.parse(row.details_json), mimeType: row.media_type, data: Buffer.from(row.data).toString('base64') }));
}

function queueItems(root: string, sessionId: string): any[] {
  return (connection(root).prepare('SELECT queue_item_id, message, behavior, details_json FROM queue_items WHERE session_id=? ORDER BY queue_position').all(sessionId) as unknown as QueueItemRow[]).map(row => {
    const item = { ...JSON.parse(row.details_json), id: String(row.queue_item_id), message: row.message, behavior: row.behavior };
    const images = queueImages(root, row.queue_item_id);

    if (images.length) item.images = images;

    return item;
  });
}

// The saved queue of a chat, also when it has no items; null when the chat has no saved queue.
function savedQueue(root: string, sessionId: string): SavedQueue | null {
  return transaction(root, 'DEFERRED', () => {
    const origin = connection(root).prepare('SELECT cwd, session_path FROM queue_origins WHERE session_id=?').get(sessionId) as { cwd: string; session_path: string | null } | undefined;

    if (!origin) return null;

    return { version: 1 as const, origin: { cwd: origin.cwd, sessionPath: origin.session_path ?? null }, items: queueItems(root, sessionId) };
  });
}

function queuedInputs(root: string): Array<{ session_id: string; record_json: string }> {
  return transaction(root, 'DEFERRED', () => (connection(root).prepare('SELECT session_id FROM queue_origins').all() as Array<{ session_id: string }>).flatMap(row => {
    const record = savedQueue(root, row.session_id);

    return record?.items.length ? [{ session_id: row.session_id, record_json: JSON.stringify(record) }] : [];
  }));
}

function queuedInput(root: string, id: string): SavedQueue | undefined {
  const record = savedQueue(root, id.toLowerCase());

  return record?.items.length ? record : undefined;
}

function queuedSessionIds(root: string): string[] {
  return connection(root).prepare('SELECT DISTINCT session_id FROM queue_items').all().map(row => String(row.session_id));
}

function nextQueueItemId(root: string): string {
  const row = connection(root).prepare('UPDATE queue_item_sequence SET last_id=last_id+1 WHERE id=1 AND last_id<9007199254740991 RETURNING last_id').get();

  if (!row) throw new Error('Query returned no rows');

  return String(row.last_id);
}

function isQueueHeld(root: string, sessionId: string): boolean {
  return connection(root).prepare('SELECT 1 FROM session_queue_holds WHERE session_id=?').get(sessionId) !== undefined;
}

function setQueueHeld(root: string, sessionId: string, held: boolean): void {
  if (held) connection(root).prepare('INSERT OR IGNORE INTO session_queue_holds VALUES (?)').run(sessionId);
  else connection(root).prepare('DELETE FROM session_queue_holds WHERE session_id=?').run(sessionId);
}

function clearQueue(root: string, sessionId: string): void {
  const db = connection(root);

  db.prepare('DELETE FROM queue_items WHERE session_id=?').run(sessionId);
  db.prepare('DELETE FROM queue_origins WHERE session_id=?').run(sessionId);
}

// Replaces the saved queue of a chat with items. Run it in a transaction.
function writeQueue(root: string, sessionId: string, origin: { cwd: string | null; sessionPath: string | null }, items: QueueRow[]): void {
  const db = connection(root);

  db.prepare('INSERT INTO queue_origins VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET cwd=excluded.cwd, session_path=excluded.session_path')
    .run(sessionId, origin.cwd, origin.sessionPath);
  db.prepare('DELETE FROM queue_items WHERE session_id=? AND queue_item_id NOT IN (SELECT value FROM json_each(?))').run(sessionId, JSON.stringify(items.map(item => item.id)));

  const saveItem = db.prepare('INSERT INTO queue_items VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(queue_item_id) DO UPDATE SET queue_position=excluded.queue_position, message=excluded.message, behavior=excluded.behavior, details_json=excluded.details_json WHERE queue_items.session_id=excluded.session_id');
  const dropImages = db.prepare('DELETE FROM queue_attachments WHERE queue_item_id=? AND attachment_position>?');
  const saveImage = db.prepare('INSERT INTO queue_attachments (queue_item_id, attachment_position, media_type, data, details_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(queue_item_id, attachment_position) DO UPDATE SET media_type=excluded.media_type, data=excluded.data, details_json=excluded.details_json');

  items.forEach((item, index) => {
    if (Number(saveItem.run(item.id, sessionId, index + 1, item.message, item.behavior, item.details).changes) !== 1) throw new Error('Queue item belongs to another session');
    dropImages.run(item.id, item.images.length);
    item.images.forEach((image, position) => saveImage.run(item.id, position + 1, image.mimeType, image.data, image.details));
  });
}

// Gives a chat with queued input its recovered transcript path. False when the chat has another path.
function bindRecoveredQueue(root: string, sessionId: string, sessionPath: string): boolean {
  return Number(connection(root).prepare('UPDATE sessions SET session_path=?1 WHERE session_id=?2 AND (session_path IS NULL OR session_path=?1)').run(sessionPath, sessionId).changes) === 1;
}

function saveRecoveredFileMetadata(root: string, sessionId: string, sessionPath: string, modified: string, size: number): void {
  const db = connection(root);

  db.prepare('INSERT INTO session_file_metadata VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET session_path=excluded.session_path, modified_ns=excluded.modified_ns, size=excluded.size').run(sessionId, sessionPath, modified, size);
  db.prepare('DELETE FROM session_file_writes WHERE session_id=?').run(sessionId);
}

// ---- Submission outcomes ----

function pruneSubmissionOutcomes(root: string, before: number): void {
  connection(root).prepare('DELETE FROM submission_outcomes WHERE updated_at<?').run(before);
}

function receivedSubmissions(root: string): Array<{ submission_id: string; session_id: string }> {
  return connection(root).prepare("SELECT submission_id, session_id FROM submission_outcomes WHERE outcome='received'").all() as Array<{ submission_id: string; session_id: string }>;
}

function submissionOutcome(root: string, id: string): { session_id: string; outcome: SubmissionState; error: string | null } | undefined {
  return connection(root).prepare('SELECT session_id, outcome, error FROM submission_outcomes WHERE submission_id=?').get(id) as { session_id: string; outcome: SubmissionState; error: string | null } | undefined;
}

function saveSubmissionOutcome(root: string, id: string, sessionId: string, outcome: SubmissionState, error: string | null): void {
  connection(root).prepare('INSERT INTO submission_outcomes VALUES (?, ?, ?, ?, ?) ON CONFLICT(submission_id) DO UPDATE SET session_id=excluded.session_id, outcome=excluded.outcome, error=excluded.error, updated_at=excluded.updated_at')
    .run(id, sessionId, outcome, error, Date.now());
}

function isGoalSubmissionQueued(root: string, id: string): boolean {
  return connection(root).prepare("SELECT 1 FROM queue_items WHERE json_extract(details_json, '$.goalSubmissionId')=?").get(id) !== undefined;
}

// ---- Agent mail ----

function mailboxReceiptCache(root: string, sessionId: string, sessionPath: string, fingerprint: string): string | undefined {
  return (connection(root).prepare('SELECT deliveries_json FROM session_mailbox_receipt_cache WHERE session_id=? AND session_path=? AND fingerprint=?').get(sessionId, sessionPath, fingerprint) as { deliveries_json: string } | undefined)?.deliveries_json;
}

function saveMailboxReceiptCache(root: string, sessionId: string, sessionPath: string, fingerprint: string, deliveriesJson: string): void {
  connection(root).prepare(`INSERT INTO session_mailbox_receipt_cache SELECT session_id, session_path, ?, ? FROM sessions WHERE session_id=? AND session_path=?
    ON CONFLICT(session_id) DO UPDATE SET session_path=excluded.session_path, fingerprint=excluded.fingerprint, deliveries_json=excluded.deliveries_json`)
    .run(fingerprint, deliveriesJson, sessionId, sessionPath);
}

// The saved size and change time of a transcript that no write changes now.
function mailboxTranscriptFingerprint(root: string, sessionId: string, sessionPath: string): string | undefined {
  const row = connection(root).prepare(`SELECT modified_ns, size FROM session_file_metadata WHERE session_id=? AND session_path=?
    AND NOT EXISTS (SELECT 1 FROM session_file_writes WHERE session_id=?)`).get(sessionId, sessionPath, sessionId);

  return row ? `${row.modified_ns}:${row.size}` : undefined;
}

function hasMailbox(root: string, sessionId: string): boolean {
  return connection(root).prepare('SELECT 1 FROM session_mailbox_state WHERE session_id=?').get(sessionId) !== undefined;
}

function addMailbox(root: string, sessionId: string): void { connection(root).prepare('INSERT INTO session_mailbox_state VALUES (?)').run(sessionId); }

function mailboxDeliveries(root: string, sessionId: string): unknown[] {
  return connection(root).prepare('SELECT * FROM session_mailbox WHERE session_id=? ORDER BY sequence, delivery_id').all(sessionId);
}

function mailboxDelivery(root: string, sessionId: string, deliveryId: string): unknown {
  return connection(root).prepare('SELECT * FROM session_mailbox WHERE session_id=? AND delivery_id=?').get(sessionId, deliveryId);
}

function nextMailboxSequence(root: string, sessionId: string): unknown {
  return connection(root).prepare('SELECT max(coalesce(max(sequence)+1, 0), ?) AS sequence FROM session_mailbox WHERE session_id=?').get(Date.now(), sessionId)?.sequence;
}

function addMailboxDelivery(root: string, sessionId: string, deliveryId: string, sequence: number, fingerprint: string, messageJson: string): void {
  connection(root).prepare('INSERT INTO session_mailbox VALUES (?, ?, ?, ?, ?)').run(sessionId, deliveryId, sequence, fingerprint, messageJson);
}

function removeMailboxDelivery(root: string, sessionId: string, deliveryId: string, fingerprint: string): void {
  connection(root).prepare('DELETE FROM session_mailbox WHERE session_id=? AND delivery_id=? AND fingerprint=?').run(sessionId, deliveryId, fingerprint);
}

// ---- Subagent runs ----

const selectSubagentRuns = `SELECT r.run_id, r.run_json, s.session_path AS child_path FROM session_subagent_runs r
  LEFT JOIN sessions s ON s.session_id=json_extract(r.run_json, '$.sessionId')`;

function hasSubagentRuns(root: string, sessionId: string): boolean {
  return connection(root).prepare('SELECT 1 FROM session_subagent_state WHERE session_id=?').get(sessionId) !== undefined;
}

function addSubagentRuns(root: string, sessionId: string): void { connection(root).prepare('INSERT INTO session_subagent_state VALUES (?)').run(sessionId); }

function subagentRun(root: string, sessionId: string, runId: string): unknown {
  return connection(root).prepare(`${selectSubagentRuns} WHERE r.session_id=? AND r.run_id=?`).get(sessionId, runId);
}

function subagentRuns(root: string, sessionId: string): unknown[] {
  return connection(root).prepare(`${selectSubagentRuns} WHERE r.session_id=? ORDER BY r.started_at, r.run_id`).all(sessionId);
}

function saveSubagentRun(root: string, sessionId: string, runId: string, startedAt: number, runJson: string): void {
  connection(root).prepare(`INSERT INTO session_subagent_runs VALUES (?, ?, ?, ?) ON CONFLICT(session_id, run_id)
    DO UPDATE SET started_at=excluded.started_at, run_json=excluded.run_json`).run(sessionId, runId, startedAt, runJson);
}

// ---- Chat state records ----

function sessionStateRecord(root: string, sessionId: string, entryId: string): { after_id: string | null; entry_json: string } | undefined {
  return connection(root).prepare('SELECT after_id, entry_json FROM session_extension_records WHERE session_id=? AND entry_id=?').get(sessionId, entryId) as { after_id: string | null; entry_json: string } | undefined;
}

// Adds a state record; does nothing when the chat has a record with its ID.
function seedSessionStateRecord(root: string, sessionId: string, entryId: string, after: string | null, entryJson: string): void {
  connection(root).prepare('INSERT INTO session_extension_records (session_id, entry_id, after_id, entry_json) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, entry_id) DO NOTHING')
    .run(sessionId, entryId, after, entryJson);
}

function appendSessionStateRecord(root: string, sessionId: string, entryId: string, after: string | null, entryJson: string): void {
  connection(root).prepare('INSERT INTO session_extension_records (session_id, entry_id, after_id, entry_json) VALUES (?, ?, ?, ?)').run(sessionId, entryId, after, entryJson);
}

function sessionStateRecords(root: string, sessionId: string): Array<{ after_id: string | null; entry_json: string }> {
  return connection(root).prepare('SELECT after_id, entry_json FROM session_extension_records WHERE session_id=? ORDER BY sequence').all(sessionId) as Array<{ after_id: string | null; entry_json: string }>;
}

function sessionStateSequence(root: string, sessionId: string): number {
  return (connection(root).prepare('SELECT coalesce(max(sequence), 0) AS revision FROM session_extension_records WHERE session_id=?').get(sessionId) as { revision: number }).revision;
}

function currentSessionStates(root: string, sessionId: string): Array<{ state_key: string; entry_json: string }> {
  return connection(root).prepare('SELECT state_key, entry_json FROM session_extension_state WHERE session_id=? ORDER BY state_key').all(sessionId) as Array<{ state_key: string; entry_json: string }>;
}

function saveCurrentSessionState(root: string, sessionId: string, key: string, entryJson: string): void {
  connection(root).prepare(`INSERT INTO session_extension_state (session_id, state_key, entry_json) VALUES (?, ?, ?)
    ON CONFLICT(session_id, state_key) DO UPDATE SET entry_json=excluded.entry_json`).run(sessionId, key, entryJson);
}

function branchSelection(root: string, sessionId: string): { tip_id: string | null; leaf_id: string | null } | undefined {
  return connection(root).prepare('SELECT tip_id, leaf_id FROM session_branch_selection WHERE session_id=?').get(sessionId) as { tip_id: string | null; leaf_id: string | null } | undefined;
}

function saveBranchSelection(root: string, sessionId: string, tipId: string | null, leafId: string | null): void {
  connection(root).prepare(`INSERT INTO session_branch_selection (session_id, tip_id, leaf_id) VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET tip_id=excluded.tip_id, leaf_id=excluded.leaf_id`).run(sessionId, tipId, leafId);
}

export { savedQueue, queuedInputs, queuedInput, queuedSessionIds, nextQueueItemId, isQueueHeld, setQueueHeld, clearQueue, writeQueue, bindRecoveredQueue, saveRecoveredFileMetadata, pruneSubmissionOutcomes, receivedSubmissions, submissionOutcome, saveSubmissionOutcome, isGoalSubmissionQueued, mailboxReceiptCache, saveMailboxReceiptCache, mailboxTranscriptFingerprint, hasMailbox, addMailbox, mailboxDeliveries, mailboxDelivery, nextMailboxSequence, addMailboxDelivery, removeMailboxDelivery, hasSubagentRuns, addSubagentRuns, subagentRun, subagentRuns, saveSubagentRun, sessionStateRecord, seedSessionStateRecord, appendSessionStateRecord, sessionStateRecords, sessionStateSequence, currentSessionStates, saveCurrentSessionState, branchSelection, saveBranchSelection };
