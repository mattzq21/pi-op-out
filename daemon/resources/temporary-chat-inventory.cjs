const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function importDirectories(db, root) {
  const marker = 'temporary-chat-allocations-v1';

  if (db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get(marker)) return;
  const directory = path.join(root, 'tmp');
  let entries;

  try {
    const info = fs.lstatSync(directory);

    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Temporary chat storage must be a directory, not a link');
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    entries = [];
  }

  const insert = db.prepare('INSERT INTO temporary_chat_allocations (session_id, original_path) VALUES (?, ?) ON CONFLICT(session_id) DO NOTHING');

  for (const entry of entries) {
    if (entry.isDirectory() && uuid.test(entry.name)) insert.run(entry.name, path.join(directory, entry.name));
  }

  db.prepare('INSERT INTO storage_migrations VALUES (?)').run(marker);
}

function list(root) {
  const db = database.open(root);

  try {
    db.exec('CREATE TABLE IF NOT EXISTS temporary_chat_allocations (session_id TEXT PRIMARY KEY, original_path TEXT NOT NULL UNIQUE); BEGIN IMMEDIATE');
    importDirectories(db, root);
    const rows = db.prepare('SELECT session_id, original_path FROM temporary_chat_allocations ORDER BY session_id').all();

    for (const row of rows) {
      if (!uuid.test(row.session_id) || row.original_path !== path.join(root, 'tmp', row.session_id)) throw new Error('Invalid saved temporary chat directory');
    }

    db.exec('COMMIT');

    return rows;
  } finally { db.close(); }
}

module.exports = { list };
