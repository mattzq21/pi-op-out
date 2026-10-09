const database = require('../session-database.cjs');

function access(transfer, hooks, operation) {
  const db = database.open(hooks.profile());

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS session_diff_transfers (
      session_id TEXT NOT NULL, message_id TEXT NOT NULL, transfer_id TEXT NOT NULL, body BLOB,
      PRIMARY KEY(session_id, message_id, transfer_id)); BEGIN IMMEDIATE;`);

    if (db.prepare('SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?)').get(transfer.owner)) throw new Error('Diff transfer session was deleted');
    const key = [transfer.owner.toLowerCase(), transfer.messageId, transfer.transferId];
    const result = operation(db, key);
    db.exec('COMMIT');

    return result;
  } finally { db.close(); }
}

function status(transfer, hooks) {
  return access(transfer, hooks, (db, key) => db.prepare('SELECT length(body) AS size FROM session_diff_transfers WHERE session_id=? AND message_id=? AND transfer_id=?').get(...key));
}

function write(transfer, hooks, body) {
  if (body !== null && body.length > hooks.maxBytes) throw new Error('Permanent diff limit: staged snapshot is too large; contents preserved');
  access(transfer, hooks, (db, key) => {
    db.prepare(`INSERT INTO session_diff_transfers (session_id, message_id, transfer_id, body) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, message_id, transfer_id) DO UPDATE SET body=excluded.body`).run(...key, body);
  });
}

module.exports = { exists, read, write, status };

function exists(transfer, hooks) {
  return access(transfer, hooks, (db, key) => Boolean(db.prepare('SELECT 1 FROM session_diff_transfers WHERE session_id=? AND message_id=? AND transfer_id=?').get(...key)));
}

function read(transfer, hooks) {
  return access(transfer, hooks, (db, key) => {
    const row = db.prepare('SELECT body FROM session_diff_transfers WHERE session_id=? AND message_id=? AND transfer_id=?').get(...key);

    return row?.body == null ? null : Buffer.from(row.body);
  });
}
