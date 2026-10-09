const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');

function kind(entry) {
  if (entry.isDirectory() && /^piop-(?:session|recovery)-[a-zA-Z0-9]{6}$/.test(entry.name)) return 'recovery';

  if (/^pi-desktop-btw-[a-f0-9-]{36}(?:\.jsonl(?:\.loop-detection\.json)?|\.diffs(?:\.json)?|\.snapshots)$/.test(entry.name)) return 'ephemeral';
}

function importDirectory(db, directory) {
  const migration = `temporary-storage-inventory:${directory}`;

  if (db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get(migration)) return;
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const insert = db.prepare('INSERT INTO legacy_temporary_storage VALUES (?, ?, ?) ON CONFLICT(directory, path) DO NOTHING');

  for (const entry of entries) {
    const category = kind(entry);

    if (category) insert.run(directory, path.join(directory, entry.name), category);
  }

  db.prepare('INSERT INTO storage_migrations VALUES (?)').run(migration);
}

function list(root, directory) {
  const db = database.open(root);

  try {
    db.exec('CREATE TABLE IF NOT EXISTS legacy_temporary_storage (directory TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(directory, path))');
    db.exec('BEGIN IMMEDIATE');
    importDirectory(db, directory);
    const rows = db.prepare('SELECT path, kind FROM legacy_temporary_storage WHERE directory=? ORDER BY path').all(directory);
    db.exec('COMMIT');

    return rows;
  } finally { db.close(); }
}

module.exports = { list };
