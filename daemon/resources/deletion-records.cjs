const path = require('node:path');
const database = require('./session-database.cjs');

function save(record) {
  const db = database.open(record.root);

  try {
    const result = db.prepare('UPDATE deletion_records SET record_json=? WHERE directory=?').run(JSON.stringify(record), record.container);

    if (result.changes !== 1) throw new Error('Deletion is not registered');
  } finally { db.close(); }
}

function remove(root, directory) {
  const db = database.open(root);

  try {
    db.exec('BEGIN IMMEDIATE');
    require('./transcript-references.cjs').removeDirectory(db, directory);
    require('./transcript-references.cjs').removeDirectory(db, path.join(root, 'deleted-sessions', path.basename(directory)));
    db.prepare('DELETE FROM deletion_records WHERE directory=?').run(directory);
    db.exec('COMMIT');
  }
  finally { db.close(); }
}

function list(root) {
  const db = database.open(root);
  db.exec('BEGIN IMMEDIATE');

  try {
    const entries = db.prepare('SELECT directory, record_json FROM deletion_records ORDER BY directory').all().map(row =>
      ({ directory: row.directory, record: row.record_json === null ? undefined : JSON.parse(row.record_json) }));

    db.exec('COMMIT');

    return entries;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

module.exports = { save, remove, list };
