const path = require('node:path');
const { createHash } = require('node:crypto');
const database = require('./session-database.cjs');

function key(sessionId) { return createHash('sha256').update(sessionId.toLowerCase()).digest('hex').slice(0, 40); }

function validKey(value) {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('Invalid conversation ownership key');

  return value;
}

function location(file) {
  if (path.basename(path.dirname(file)) !== 'conversation-ownership' || path.extname(file) !== '.json') throw new Error('Invalid conversation ownership location');

  return { root: path.dirname(path.dirname(file)), key: validKey(path.basename(file, '.json')) };
}

function withDatabase(root, operation) {
  const db = database.open(root);

  try { return operation(db); }
  finally { db.close(); }
}

function readRecord(root, recordKey) {
  validKey(recordKey);

  return withDatabase(root, db => {
    db.exec('BEGIN IMMEDIATE');

    try {
      const body = db.prepare('SELECT record_json FROM conversation_ownership WHERE record_id=?').get(recordKey)?.record_json ?? null;

      db.exec('COMMIT');

      return body;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
}

function writeRecord(root, recordKey, body) {
  validKey(recordKey);
  JSON.parse(body);
  withDatabase(root, db => db.prepare('INSERT INTO conversation_ownership VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET record_json=excluded.record_json').run(recordKey, body));
}

function forgetKey(db, recordKey) { db.prepare('DELETE FROM conversation_ownership WHERE record_id=?').run(recordKey); }

function removeRecord(root, recordKey) {
  validKey(recordKey);
  withDatabase(root, db => forgetKey(db, recordKey));
}

function forget(db, sessionId) { forgetKey(db, key(sessionId)); }

function read(file) {
  const { root, key: recordKey } = location(file);

  return readRecord(root, recordKey);
}

function required(file) {
  const body = read(file);

  if (body === null) throw new Error(`Conversation ownership is unavailable: ${file}`);

  return body;
}

function write(file, body) {
  const { root, key: recordKey } = location(file);

  writeRecord(root, recordKey, body);
}

module.exports = { key, readRecord, writeRecord, removeRecord, forget, read, required, write };
