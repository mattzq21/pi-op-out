const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');

function open(root) {
  const db = database.open(root);

  try {
    db.exec('CREATE TABLE IF NOT EXISTS legacy_archive_records (directory TEXT PRIMARY KEY, record_json TEXT)');

    return db;
  } catch (error) { db.close(); throw error; }
}

function read(root, directory) {
  const db = open(root);

  try {
    db.exec('BEGIN IMMEDIATE');
    let row = db.prepare('SELECT record_json FROM legacy_archive_records WHERE directory=?').get(directory);

    if (!row) {
      let body = null;

      try { body = fs.readFileSync(path.join(directory, 'recovery.json'), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }

      if (body !== null) JSON.parse(body);
      db.prepare('INSERT INTO legacy_archive_records VALUES (?, ?)').run(directory, body);
      row = { record_json: body };
    }

    db.exec('COMMIT');

    return row.record_json === null ? undefined : JSON.parse(row.record_json);
  } finally { db.close(); }
}

function save(root, directory, record) {
  const db = open(root);

  try {
    db.prepare(`INSERT INTO legacy_archive_records VALUES (?, ?)
      ON CONFLICT(directory) DO UPDATE SET record_json=excluded.record_json`).run(directory, JSON.stringify(record));
  } finally { db.close(); }
}

function list(root) {
  const db = database.open(root);

  try { return db.prepare('SELECT directory FROM legacy_archive_directories ORDER BY directory').all().map(row => row.directory); }
  finally { db.close(); }
}

function exists(directory) {
  try {
    if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Legacy archive directory was replaced');

    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function recover(root, directory, replay) {
  if (path.dirname(directory) !== root || !/^archive-transaction-[a-zA-Z0-9]{6}$/.test(path.basename(directory))) throw new Error('Unsupported legacy archive directory');

  if (exists(directory)) replay(root, directory);

  if (exists(directory)) return;
  const parent = fs.openSync(root, 'r');

  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }

  const db = open(root);

  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM legacy_archive_records WHERE directory=?').run(directory);
    db.prepare('DELETE FROM legacy_archive_directories WHERE directory=?').run(directory);
    db.exec('COMMIT');
  }
  finally { db.close(); }
}

module.exports = { list, recover, read, save };
