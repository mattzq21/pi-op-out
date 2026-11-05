const { connection, transaction } = require('./core.cjs');

// Queued input, submission outcomes, agent mail, subagent runs and the per-chat state records.

// ---- Queued input ----

function queueImages(root, itemId) {
  return connection(root).prepare('SELECT media_type, data, details_json FROM queue_attachments WHERE queue_item_id=? ORDER BY attachment_position').all(itemId)
    .map(row => ({ ...JSON.parse(row.details_json), mimeType: row.media_type, data: Buffer.from(row.data).toString('base64') }));
}

function queueItems(root, sessionId) {
  return connection(root).prepare('SELECT queue_item_id, message, behavior, details_json FROM queue_items WHERE session_id=? ORDER BY queue_position').all(sessionId).map(row => {
    const item = { ...JSON.parse(row.details_json), id: String(row.queue_item_id), message: row.message, behavior: row.behavior };
    const images = queueImages(root, row.queue_item_id);

    if (images.length) item.images = images;

    return item;
  });
}

// The saved queue of a chat, also when it has no items; null when the chat has no saved queue.
function savedQueue(root, sessionId) {
  return transaction(root, 'DEFERRED', () => {
    const origin = connection(root).prepare('SELECT cwd, session_path FROM queue_origins WHERE session_id=?').get(sessionId);

    if (!origin) return null;

    return { version: 1, origin: { cwd: origin.cwd, sessionPath: origin.session_path ?? null }, items: queueItems(root, sessionId) };
  });
}

function queuedInputs(root) {
  return transaction(root, 'DEFERRED', () => connection(root).prepare('SELECT session_id FROM queue_origins').all().flatMap(row => {
    const record = savedQueue(root, row.session_id);

    return record?.items.length ? [{ session_id: row.session_id, record_json: JSON.stringify(record) }] : [];
  }));
}

function queuedInput(root, id) {
  const record = savedQueue(root, id.toLowerCase());

  return record?.items.length ? record : undefined;
}

function queuedSessionIds(root) {
  return connection(root).prepare('SELECT DISTINCT session_id FROM queue_items').all().map(row => String(row.session_id));
}

function nextQueueItemId(root) {
  const row = connection(root).prepare('UPDATE queue_item_sequence SET last_id=last_id+1 WHERE id=1 AND last_id<9007199254740991 RETURNING last_id').get();

  if (!row) throw new Error('Query returned no rows');

  return String(row.last_id);
}

function isQueueHeld(root, sessionId) {
  return connection(root).prepare('SELECT 1 FROM session_queue_holds WHERE session_id=?').get(sessionId) !== undefined;
}

function setQueueHeld(root, sessionId, held) {
  if (held) connection(root).prepare('INSERT OR IGNORE INTO session_queue_holds VALUES (?)').run(sessionId);
  else connection(root).prepare('DELETE FROM session_queue_holds WHERE session_id=?').run(sessionId);
}

function clearQueue(root, sessionId) {
  const db = connection(root);

  db.prepare('DELETE FROM queue_items WHERE session_id=?').run(sessionId);
  db.prepare('DELETE FROM queue_origins WHERE session_id=?').run(sessionId);
}

// Replaces the saved queue of a chat with items. Run it in a transaction.
function writeQueue(root, sessionId, origin, items) {
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
function bindRecoveredQueue(root, sessionId, sessionPath) {
  return Number(connection(root).prepare('UPDATE sessions SET session_path=?1 WHERE session_id=?2 AND (session_path IS NULL OR session_path=?1)').run(sessionPath, sessionId).changes) === 1;
}

function saveRecoveredFileMetadata(root, sessionId, sessionPath, modified, size) {
  const db = connection(root);

  db.prepare('INSERT INTO session_file_metadata VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET session_path=excluded.session_path, modified_ns=excluded.modified_ns, size=excluded.size').run(sessionId, sessionPath, modified, size);
  db.prepare('DELETE FROM session_file_writes WHERE session_id=?').run(sessionId);
}

// ---- Submission outcomes ----

function pruneSubmissionOutcomes(root, before) {
  connection(root).prepare('DELETE FROM submission_outcomes WHERE updated_at<?').run(before);
}

function receivedSubmissions(root) {
  return connection(root).prepare("SELECT submission_id, session_id FROM submission_outcomes WHERE outcome='received'").all();
}

function submissionOutcome(root, id) {
  return connection(root).prepare('SELECT session_id, outcome, error FROM submission_outcomes WHERE submission_id=?').get(id);
}

function saveSubmissionOutcome(root, id, sessionId, outcome, error) {
  connection(root).prepare('INSERT INTO submission_outcomes VALUES (?, ?, ?, ?, ?) ON CONFLICT(submission_id) DO UPDATE SET session_id=excluded.session_id, outcome=excluded.outcome, error=excluded.error, updated_at=excluded.updated_at')
    .run(id, sessionId, outcome, error, Date.now());
}

function isGoalSubmissionQueued(root, id) {
  return connection(root).prepare("SELECT 1 FROM queue_items WHERE json_extract(details_json, '$.goalSubmissionId')=?").get(id) !== undefined;
}

// ---- Agent mail ----

function mailboxReceiptCache(root, sessionId, sessionPath, fingerprint) {
  return connection(root).prepare('SELECT deliveries_json FROM session_mailbox_receipt_cache WHERE session_id=? AND session_path=? AND fingerprint=?').get(sessionId, sessionPath, fingerprint)?.deliveries_json;
}

function saveMailboxReceiptCache(root, sessionId, sessionPath, fingerprint, deliveriesJson) {
  connection(root).prepare(`INSERT INTO session_mailbox_receipt_cache SELECT session_id, session_path, ?, ? FROM sessions WHERE session_id=? AND session_path=?
    ON CONFLICT(session_id) DO UPDATE SET session_path=excluded.session_path, fingerprint=excluded.fingerprint, deliveries_json=excluded.deliveries_json`)
    .run(fingerprint, deliveriesJson, sessionId, sessionPath);
}

// The saved size and change time of a transcript that no write changes now.
function mailboxTranscriptFingerprint(root, sessionId, sessionPath) {
  const row = connection(root).prepare(`SELECT modified_ns, size FROM session_file_metadata WHERE session_id=? AND session_path=?
    AND NOT EXISTS (SELECT 1 FROM session_file_writes WHERE session_id=?)`).get(sessionId, sessionPath, sessionId);

  return row ? `${row.modified_ns}:${row.size}` : undefined;
}

function hasMailbox(root, sessionId) {
  return connection(root).prepare('SELECT 1 FROM session_mailbox_state WHERE session_id=?').get(sessionId) !== undefined;
}

function addMailbox(root, sessionId) { connection(root).prepare('INSERT INTO session_mailbox_state VALUES (?)').run(sessionId); }

function mailboxDeliveries(root, sessionId) {
  return connection(root).prepare('SELECT * FROM session_mailbox WHERE session_id=? ORDER BY sequence, delivery_id').all(sessionId);
}

function mailboxDelivery(root, sessionId, deliveryId) {
  return connection(root).prepare('SELECT * FROM session_mailbox WHERE session_id=? AND delivery_id=?').get(sessionId, deliveryId);
}

function nextMailboxSequence(root, sessionId) {
  return connection(root).prepare('SELECT max(coalesce(max(sequence)+1, 0), ?) AS sequence FROM session_mailbox WHERE session_id=?').get(Date.now(), sessionId)?.sequence;
}

function addMailboxDelivery(root, sessionId, deliveryId, sequence, fingerprint, messageJson) {
  connection(root).prepare('INSERT INTO session_mailbox VALUES (?, ?, ?, ?, ?)').run(sessionId, deliveryId, sequence, fingerprint, messageJson);
}

function removeMailboxDelivery(root, sessionId, deliveryId, fingerprint) {
  connection(root).prepare('DELETE FROM session_mailbox WHERE session_id=? AND delivery_id=? AND fingerprint=?').run(sessionId, deliveryId, fingerprint);
}

// ---- Subagent runs ----

const selectSubagentRuns = `SELECT r.run_id, r.run_json, s.session_path AS child_path FROM session_subagent_runs r
  LEFT JOIN sessions s ON s.session_id=json_extract(r.run_json, '$.sessionId')`;

function hasSubagentRuns(root, sessionId) {
  return connection(root).prepare('SELECT 1 FROM session_subagent_state WHERE session_id=?').get(sessionId) !== undefined;
}

function addSubagentRuns(root, sessionId) { connection(root).prepare('INSERT INTO session_subagent_state VALUES (?)').run(sessionId); }

function subagentRun(root, sessionId, runId) {
  return connection(root).prepare(`${selectSubagentRuns} WHERE r.session_id=? AND r.run_id=?`).get(sessionId, runId);
}

function subagentRuns(root, sessionId) {
  return connection(root).prepare(`${selectSubagentRuns} WHERE r.session_id=? ORDER BY r.started_at, r.run_id`).all(sessionId);
}

function saveSubagentRun(root, sessionId, runId, startedAt, runJson) {
  connection(root).prepare(`INSERT INTO session_subagent_runs VALUES (?, ?, ?, ?) ON CONFLICT(session_id, run_id)
    DO UPDATE SET started_at=excluded.started_at, run_json=excluded.run_json`).run(sessionId, runId, startedAt, runJson);
}

// ---- Chat state records ----

function sessionStateRecord(root, sessionId, entryId) {
  return connection(root).prepare('SELECT after_id, entry_json FROM session_extension_records WHERE session_id=? AND entry_id=?').get(sessionId, entryId);
}

// Adds a state record; does nothing when the chat has a record with its ID.
function seedSessionStateRecord(root, sessionId, entryId, after, entryJson) {
  connection(root).prepare('INSERT INTO session_extension_records (session_id, entry_id, after_id, entry_json) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, entry_id) DO NOTHING')
    .run(sessionId, entryId, after, entryJson);
}

function appendSessionStateRecord(root, sessionId, entryId, after, entryJson) {
  connection(root).prepare('INSERT INTO session_extension_records (session_id, entry_id, after_id, entry_json) VALUES (?, ?, ?, ?)').run(sessionId, entryId, after, entryJson);
}

function sessionStateRecords(root, sessionId) {
  return connection(root).prepare('SELECT after_id, entry_json FROM session_extension_records WHERE session_id=? ORDER BY sequence').all(sessionId);
}

function sessionStateSequence(root, sessionId) {
  return connection(root).prepare('SELECT coalesce(max(sequence), 0) AS revision FROM session_extension_records WHERE session_id=?').get(sessionId).revision;
}

function currentSessionStates(root, sessionId) {
  return connection(root).prepare('SELECT state_key, entry_json FROM session_extension_state WHERE session_id=? ORDER BY state_key').all(sessionId);
}

function saveCurrentSessionState(root, sessionId, key, entryJson) {
  connection(root).prepare(`INSERT INTO session_extension_state (session_id, state_key, entry_json) VALUES (?, ?, ?)
    ON CONFLICT(session_id, state_key) DO UPDATE SET entry_json=excluded.entry_json`).run(sessionId, key, entryJson);
}

function branchSelection(root, sessionId) {
  return connection(root).prepare('SELECT tip_id, leaf_id FROM session_branch_selection WHERE session_id=?').get(sessionId);
}

function saveBranchSelection(root, sessionId, tipId, leafId) {
  connection(root).prepare(`INSERT INTO session_branch_selection (session_id, tip_id, leaf_id) VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET tip_id=excluded.tip_id, leaf_id=excluded.leaf_id`).run(sessionId, tipId, leafId);
}

module.exports = { savedQueue, queuedInputs, queuedInput, queuedSessionIds, nextQueueItemId, isQueueHeld, setQueueHeld, clearQueue, writeQueue,
  bindRecoveredQueue, saveRecoveredFileMetadata, pruneSubmissionOutcomes, receivedSubmissions, submissionOutcome, saveSubmissionOutcome,
  isGoalSubmissionQueued, mailboxReceiptCache, saveMailboxReceiptCache, mailboxTranscriptFingerprint, hasMailbox, addMailbox, mailboxDeliveries,
  mailboxDelivery, nextMailboxSequence, addMailboxDelivery, removeMailboxDelivery, hasSubagentRuns, addSubagentRuns, subagentRun, subagentRuns,
  saveSubagentRun, sessionStateRecord, seedSessionStateRecord, appendSessionStateRecord, sessionStateRecords, sessionStateSequence,
  currentSessionStates, saveCurrentSessionState, branchSelection, saveBranchSelection };
