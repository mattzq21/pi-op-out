import { connection, transaction } from './core.ts';

export type QueueRow = { id: number; message: string; behavior: "steer" | "followUp"; details: string; images: Array<{ mimeType: string | null; data: Buffer; details: string }> };

export type SubmissionState = "received" | "accepted" | "rejected";


// Queued input, submission outcomes, agent mail and subagent runs.

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

// The saved queue of a chat, in order.
function savedQueue(root: string, sessionId: string): any[] {
  return transaction(root, 'DEFERRED', () => queueItems(root, sessionId.toLowerCase()));
}

function hasQueuedInput(root: string, sessionId: string): boolean {
  return connection(root).prepare('SELECT 1 FROM queue_items WHERE session_id=?').get(sessionId.toLowerCase()) !== undefined;
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
}

// Replaces the saved queue of a chat with items. Only a chat with a saved transcript keeps queued input, so that each
// saved queue has a chat that shows it. Run it in a transaction.
function writeQueue(root: string, sessionId: string, items: QueueRow[]): void {
  const db = connection(root);

  if (!db.prepare('SELECT 1 FROM sessions WHERE session_id=? AND session_path IS NOT NULL').get(sessionId)) throw new Error('Queued input needs a saved chat');
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

// The delivery IDs of the agent mail that the transcript of a chat holds.
function mailboxReceipts(root: string, sessionId: string): string[] {
  return connection(root).prepare('SELECT delivery_id FROM session_mailbox_receipts WHERE session_id=?').all(sessionId).map(row => String(row.delivery_id));
}

function addMailboxReceipt(root: string, sessionId: string, deliveryId: string): void {
  connection(root).prepare('INSERT OR IGNORE INTO session_mailbox_receipts VALUES (?, ?)').run(sessionId, deliveryId);
}

function replaceMailboxReceipts(root: string, sessionId: string, receipts: string[]): void {
  const db = connection(root);

  db.prepare('DELETE FROM session_mailbox_receipts WHERE session_id=?').run(sessionId);
  for (const deliveryId of receipts) addMailboxReceipt(root, sessionId, deliveryId);
}

function mailboxDeliveries(root: string, sessionId: string): unknown[] {
  return connection(root).prepare('SELECT * FROM session_mailbox WHERE session_id=? ORDER BY sequence, delivery_id').all(sessionId);
}

function mailboxDelivery(root: string, sessionId: string, deliveryId: string): unknown {
  return connection(root).prepare('SELECT * FROM session_mailbox WHERE session_id=? AND delivery_id=?').get(sessionId, deliveryId);
}

function nextMailboxSequence(root: string, sessionId: string): unknown {
  return connection(root).prepare('SELECT max(coalesce(max(sequence)+1, 0), ?) AS sequence FROM session_mailbox WHERE session_id=?').get(Date.now(), sessionId)?.sequence;
}

function addMailboxDelivery(root: string, sessionId: string, deliveryId: string, sequence: number, messageJson: string): void {
  connection(root).prepare('INSERT INTO session_mailbox VALUES (?, ?, ?, ?)').run(sessionId, deliveryId, sequence, messageJson);
}

function removeMailboxDelivery(root: string, sessionId: string, deliveryId: string): void {
  connection(root).prepare('DELETE FROM session_mailbox WHERE session_id=? AND delivery_id=?').run(sessionId, deliveryId);
}

// ---- Subagent runs ----

const selectSubagentRuns = `SELECT r.run_id, r.run_json, s.session_path AS child_path FROM session_subagent_runs r
  LEFT JOIN sessions s ON s.session_id=json_extract(r.run_json, '$.sessionId')`;

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

export { savedQueue, hasQueuedInput, nextQueueItemId, isQueueHeld, setQueueHeld, clearQueue, writeQueue, pruneSubmissionOutcomes, receivedSubmissions, submissionOutcome, saveSubmissionOutcome, isGoalSubmissionQueued, mailboxReceipts, addMailboxReceipt, replaceMailboxReceipts, mailboxDeliveries, mailboxDelivery, nextMailboxSequence, addMailboxDelivery, removeMailboxDelivery, subagentRun, subagentRuns, saveSubagentRun };
