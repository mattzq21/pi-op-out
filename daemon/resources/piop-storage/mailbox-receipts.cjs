// The agent mail that the transcript of a chat holds: delivery ID and fingerprint pairs. The transcript writes keep it,
// inside their own transactions.

function details(entry) {
  if (entry?.type === 'custom_message') return entry.details;

  return entry?.type === 'message' ? entry.message?.details : undefined;
}

function receipt(entry, sessionId) {
  const value = details(entry);

  if (value?.mailboxSessionId !== sessionId || typeof value.notificationId !== 'string' || typeof value.mailboxFingerprint !== 'string') return;

  return [value.notificationId, value.mailboxFingerprint];
}

// After entry was added to the transcript of sessionId.
function add(db, sessionId, entry) {
  const saved = receipt(entry, sessionId);

  if (saved) db.prepare('INSERT INTO session_mailbox_receipts VALUES (?, ?, ?) ON CONFLICT(session_id, delivery_id) DO UPDATE SET fingerprint=excluded.fingerprint').run(sessionId, ...saved);
}

// After the transcript of sessionId was saved again with entries.
function replace(db, sessionId, entries) {
  db.prepare('DELETE FROM session_mailbox_receipts WHERE session_id=?').run(sessionId);

  for (const entry of entries) add(db, sessionId, entry);
}

function list(db, sessionId) {
  return db.prepare('SELECT delivery_id, fingerprint FROM session_mailbox_receipts WHERE session_id=?').all(sessionId).map(row => [row.delivery_id, row.fingerprint]);
}

module.exports = { add, replace, list };
