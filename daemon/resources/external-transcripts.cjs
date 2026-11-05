const path = require('node:path');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { createHash } = require('node:crypto');
const database = require('./session-database.cjs');
const { onMainThread } = require('./main-thread.cjs');

function list(root) {
  return database.externalTranscriptRows(root);
}

function transcript(row) {
  const record = JSON.parse(row.record_json);

  if (!Check(Type.Object({ path: Type.String() }), record) || !path.isAbsolute(record.path) || row.record_id !== createHash('sha256').update(record.path).digest('hex')) throw new Error('Invalid external transcript record');

  return record.path;
}

const remove = onMainThread('external-transcripts.remove', (root, row) => {
  database.removeExternalTranscriptRow(root, row.record_id, row.record_json);
});

module.exports = { list, transcript, remove };
