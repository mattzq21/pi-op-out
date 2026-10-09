const fs = require('node:fs');
const path = require('node:path');
const tables = require('./session-database.cjs');

function importRecords(db, root) {
  if (db.prepare("SELECT 1 FROM storage_migrations WHERE name='archive-resources-v1'").get()) return;
  const directory = path.join(root, 'archive-resources');
  let entries;

  try {
    if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Invalid shared archive storage');
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }

  for (const entry of entries.filter(entry => entry.name.endsWith('.json'))) {
    if (!entry.isFile() || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(entry.name)) throw new Error('Invalid shared archive record');
    const descriptor = fs.openSync(path.join(directory, entry.name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);

    try {
      if (!fs.fstatSync(descriptor).isFile()) throw new Error('Invalid shared archive record');
      db.prepare('INSERT INTO archive_resources VALUES (?, ?) ON CONFLICT DO NOTHING').run(entry.name.slice(0, -5), fs.readFileSync(descriptor, 'utf8'));
    } finally { fs.closeSync(descriptor); }
  }

  db.prepare("INSERT INTO storage_migrations VALUES ('archive-resources-v1')").run();
}

function open(root) {
  const db = tables.open(root);

  try {
    db.exec('CREATE TABLE IF NOT EXISTS archive_resources (resource_id TEXT PRIMARY KEY, record_json TEXT NOT NULL); BEGIN IMMEDIATE');
    importRecords(db, root);
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
