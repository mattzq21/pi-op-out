const database = require('./session-database.cjs');
const fs = require('node:fs');
const path = require('node:path');

function open(root) {
  const db = database.open(root);

  try {
    db.exec('CREATE TABLE IF NOT EXISTS legacy_deletion_journals (directory TEXT PRIMARY KEY, identity TEXT NOT NULL, record_json TEXT)');

    return db;
  } catch (error) { db.close(); throw error; }
}

function read(root, directory) {
  const info = fs.lstatSync(directory, { bigint: true });

  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Legacy deletion directory changed');
  const identity = `${info.dev}:${info.ino}`;
  const db = open(root);

  try {
    db.exec('BEGIN IMMEDIATE');
    let row = db.prepare('SELECT identity, record_json FROM legacy_deletion_journals WHERE directory=?').get(directory);

    if (!row) {
      let body = null;

      try { body = fs.readFileSync(path.join(directory, 'recovery.json'), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }

      if (body !== null) JSON.parse(body);
      db.prepare('INSERT INTO legacy_deletion_journals VALUES (?, ?, ?)').run(directory, identity, body);
      row = { identity, record_json: body };
    }

    if (row.identity !== identity) throw new Error('Saved deletion directory was replaced');
    db.exec('COMMIT');

    return row.record_json === null ? undefined : JSON.parse(row.record_json);
  } finally { db.close(); }
}

function list(root) {
  const db = database.open(root);

  try { return db.prepare('SELECT directory FROM legacy_committed_deletions ORDER BY directory').all().map(row => row.directory); }
  finally { db.close(); }
}

function remove(root, directory) {
  const db = open(root);

  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM legacy_committed_deletions WHERE directory=?').run(directory);
    db.prepare('DELETE FROM legacy_deletion_journals WHERE directory=?').run(directory);
    db.exec('COMMIT');
  }
  finally { db.close(); }
}

module.exports = { list, read, remove };
