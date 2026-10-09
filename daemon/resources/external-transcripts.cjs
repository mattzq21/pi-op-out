const path = require('node:path');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { createHash } = require('node:crypto');
const database = require('./session-database.cjs');

function list(root) {
  const db = database.open(root);

  try { return db.prepare('SELECT record_id, record_json FROM external_transcripts ORDER BY record_id').all(); }
  finally { db.close(); }
}

function transcript(row) {
  const record = JSON.parse(row.record_json);

  if (!Check(Type.Object({ path: Type.String() }), record) || !path.isAbsolute(record.path) || row.record_id !== createHash('sha256').update(record.path).digest('hex')) throw new Error('Invalid external transcript record');

  return record.path;
}

function remove(root, row) {
  const db = database.open(root);

  try { db.prepare('DELETE FROM external_transcripts WHERE record_id=? AND record_json=?').run(row.record_id, row.record_json); }
  finally { db.close(); }
}

module.exports = { list, transcript, remove };
