const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');

function allocate(root, directory) {
  const db = database.open(root);

  try { db.prepare('INSERT INTO deletion_records (directory) VALUES (?)').run(directory); }
  finally { db.close(); }
}

function save(record) {
  const db = database.open(record.root);

  try {
    const result = db.prepare('UPDATE deletion_records SET record_json=? WHERE directory=?').run(JSON.stringify(record), record.container);

    if (result.changes !== 1) throw new Error('Deletion is not registered');
  } finally { db.close(); }
}

function remove(root, directory) {
  const db = database.open(root);

  try { db.prepare('DELETE FROM deletion_records WHERE directory=?').run(directory); }
  finally { db.close(); }
}

function legacyBody(directory) {
  let body;

  try { body = fs.readFileSync(path.join(directory, 'recovery.json'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  return body;
}

function importRecord(db, root, row) {
  const body = legacyBody(row.directory);
  const record = body === undefined ? undefined : JSON.parse(body);

  if (path.dirname(row.directory) === path.join(root, 'deleted-sessions') && record?.kind === undefined) {
    db.prepare('DELETE FROM deletion_records WHERE directory=?').run(row.directory);

    return undefined;
  }

  if (!record) return { directory: row.directory, record: undefined };

  if (record.kind !== 'delete' || record.root !== root || record.container !== path.join(root, 'delete-transactions', path.basename(row.directory))) throw new Error('Invalid saved deletion');
  db.prepare('DELETE FROM deletion_records WHERE directory=?').run(row.directory);
  db.prepare('INSERT INTO deletion_records VALUES (?, ?)').run(record.container, body);

  return { directory: record.container, record };
}

function list(root) {
  const db = database.open(root);
  db.exec('BEGIN IMMEDIATE');

  try {
    const entries = db.prepare('SELECT directory, record_json FROM deletion_records ORDER BY directory').all().map(row =>
      row.record_json === null ? importRecord(db, root, row) : { directory: row.directory, record: JSON.parse(row.record_json) }).filter(Boolean);

    db.exec('COMMIT');

    return entries;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

module.exports = { allocate, save, remove, list };
