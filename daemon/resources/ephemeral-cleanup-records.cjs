const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');

function importRecords(db, root) {
  if (db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get('ephemeral-cleanup-records-v1')) return;
  const directory = path.join(root, 'ephemeral-cleanup', 'manifests');
  let entries;

  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const body = fs.readFileSync(path.join(directory, entry.name), 'utf8');
    db.prepare('INSERT INTO ephemeral_cleanup_records VALUES (?, ?)').run(entry.name.slice(0, -5), body);
  }

  db.prepare('INSERT INTO storage_migrations VALUES (?)').run('ephemeral-cleanup-records-v1');
}

function open(root) {
  const db = database.open(root);

  try {
    db.exec('BEGIN IMMEDIATE');
    importRecords(db, root);
    db.exec('COMMIT');

    return db;
  } catch (error) { db.close(); throw error; }
}

function read(root, token) {
  const db = open(root);

  try {
    const row = db.prepare('SELECT record_json FROM ephemeral_cleanup_records WHERE token=?').get(token);

    return row ? JSON.parse(row.record_json) : undefined;
  } finally { db.close(); }
}

function write(root, record) {
  const db = open(root);

  try {
    db.exec('BEGIN IMMEDIATE');

    if (record.phase === 'complete') {
      for (const table of ['session_diff_state', 'session_diff_transfers']) {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.prepare(`DELETE FROM ${table} WHERE session_id=lower(?)`).run(record.sessionId);
      }

      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcript_references'").get()) db.prepare('DELETE FROM transcript_references WHERE session_id=lower(?) AND session_path=?').run(record.sessionId, record.path);
      db.prepare('DELETE FROM sessions WHERE session_id=lower(?) AND session_path=?').run(record.sessionId, record.path);
    }

    db.prepare('INSERT INTO ephemeral_cleanup_records VALUES (?, ?) ON CONFLICT(token) DO UPDATE SET record_json=excluded.record_json')
      .run(record.token, JSON.stringify(record));
    db.exec('COMMIT');
  } finally { db.close(); }
}

function list(root) {
  const db = open(root);

  try { return db.prepare('SELECT token, record_json FROM ephemeral_cleanup_records ORDER BY token').all(); }
  finally { db.close(); }
}

module.exports = { read, write, list };
