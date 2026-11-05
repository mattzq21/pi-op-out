const { createHash } = require('node:crypto');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const database = require('./session-database.cjs');
const { onMainThread } = require('./main-thread.cjs');

// The ownership record of each active conversation: the client that owns it (null when none does), the daemon run
// that wrote it, and the client that owned it last.
const recordSchema = Type.Object({
  client: Type.Union([Type.String(), Type.Null()]), token: Type.String(), previousClient: Type.Optional(Type.String()),
}, { additionalProperties: false });

function key(sessionId) { return createHash('sha256').update(sessionId.toLowerCase()).digest('hex').slice(0, 40); }

function validKey(value) {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('Invalid conversation ownership key');

  return value;
}

function checked(body) {
  if (!Check(recordSchema, JSON.parse(body))) throw new Error('Invalid conversation ownership record');

  return body;
}

function readRecord(root, recordKey) {
  validKey(recordKey);
  const body = database.connection(root).prepare('SELECT record_json FROM conversation_ownership WHERE record_id=?').get(recordKey)?.record_json;

  return body === undefined ? null : checked(body);
}

const writeRecord = onMainThread('conversation-storage.writeRecord', (root, recordKey, body) => {
  validKey(recordKey);
  database.connection(root).prepare('INSERT INTO conversation_ownership VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET record_json=excluded.record_json').run(recordKey, checked(body));
});

function forgetKey(db, recordKey) { db.prepare('DELETE FROM conversation_ownership WHERE record_id=?').run(recordKey); }

const removeRecord = onMainThread('conversation-storage.removeRecord', (root, recordKey) => {
  validKey(recordKey);
  forgetKey(database.connection(root), recordKey);
});

function forget(db, sessionId) { forgetKey(db, key(sessionId)); }

// The ownership record of the conversation sessionId, or null.
function read(root, sessionId) { return readRecord(root, key(sessionId)); }

function write(root, sessionId, body) { writeRecord(root, key(sessionId), body); }

module.exports = { key, readRecord, writeRecord, removeRecord, forget, read, write };
