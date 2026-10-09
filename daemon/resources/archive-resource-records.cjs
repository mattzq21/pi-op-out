const path = require('node:path');
const tables = require('./session-database.cjs');

function open(root) {
  const db = tables.open(root);

  try {
    db.exec('CREATE TABLE IF NOT EXISTS archive_resources (resource_id TEXT PRIMARY KEY, record_json TEXT NOT NULL); BEGIN IMMEDIATE');
    db.exec('COMMIT');

    return db;
  } catch (error) { db.close(); throw error; }
}

function location(file) {
  if (path.basename(path.dirname(file)) !== 'archive-resources' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(path.basename(file))) throw new Error('Invalid shared archive record location');

  return { root: path.dirname(path.dirname(file)), id: path.basename(file, '.json') };
}

function read(file) {
  const { root, id } = location(file);
  const db = open(root);

  try { return db.prepare('SELECT record_json FROM archive_resources WHERE resource_id=?').get(id)?.record_json ?? null; }
  finally { db.close(); }
}

function list(root) {
  const db = open(root);

  try { return db.prepare('SELECT resource_id FROM archive_resources ORDER BY resource_id').all().map(row => row.resource_id); }
  finally { db.close(); }
}

function change(file, before, after) {
  const { root, id } = location(file);
  const db = open(root);

  try {
    db.exec('BEGIN IMMEDIATE');
    const current = db.prepare('SELECT record_json FROM archive_resources WHERE resource_id=?').get(id)?.record_json ?? null;

    if (current !== after) {
      if (current !== before) throw new Error('Shared archive record changed; retained for reconciliation');

      if (after === null) db.prepare('DELETE FROM archive_resources WHERE resource_id=?').run(id);
      else db.prepare('INSERT INTO archive_resources VALUES (?, ?) ON CONFLICT(resource_id) DO UPDATE SET record_json=excluded.record_json').run(id, after);
    }

    db.exec('COMMIT');
  } finally { db.close(); }
}

module.exports = { read, list, change };
