const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');

function profile(directory) { return path.dirname(path.dirname(directory)); }

function importRecords(db, preparation) {
  const migration = `fork-checkpoints:${preparation}`;

  if (db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get(migration)) return;
  const directory = path.join(preparation, 'checkpoint-owners');
  let entries;

  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    db.prepare('INSERT INTO fork_preparation_checkpoints VALUES (?, ?, ?) ON CONFLICT(preparation, session_id) DO NOTHING')
      .run(preparation, entry.name.slice(0, -5), fs.readFileSync(path.join(directory, entry.name), 'utf8'));
  }

  db.prepare('INSERT INTO storage_migrations VALUES (?)').run(migration);
}

function read(preparation) {
  const db = database.open(profile(preparation));

  try {
    db.exec('BEGIN IMMEDIATE');
    importRecords(db, preparation);
    const rows = db.prepare('SELECT session_id, record_json FROM fork_preparation_checkpoints WHERE preparation=?').all(preparation);
    db.exec('COMMIT');

    return rows;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

function remove(preparation) {
  const db = database.open(profile(preparation));

  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM fork_preparation_checkpoints WHERE preparation=?').run(preparation);
    db.prepare('DELETE FROM fork_preparations WHERE directory=?').run(preparation);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

function list(root) {
  const db = database.open(root);

  try { return db.prepare('SELECT directory FROM fork_preparations ORDER BY directory').all().map(row => row.directory); }
  finally { db.close(); }
}

module.exports = { read, remove, list };
