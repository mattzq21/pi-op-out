const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');

function identity(directory) {
  const info = fs.lstatSync(directory, { bigint: true });

  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Comparison directory changed');

  return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
}

function withDatabase(root, operation) {
  const db = database.open(root);

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS snapshot_comparison_records (
      identity TEXT PRIMARY KEY, session_id TEXT NOT NULL, record_json TEXT);
      CREATE TABLE IF NOT EXISTS snapshot_comparison_locations (
        identity TEXT PRIMARY KEY REFERENCES snapshot_comparison_records(identity) ON DELETE CASCADE,
        queue_identity TEXT NOT NULL, name TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshot_comparison_queue ON snapshot_comparison_locations(queue_identity);
      CREATE TABLE IF NOT EXISTS snapshot_comparison_imports (queue_identity TEXT PRIMARY KEY);
      BEGIN IMMEDIATE;`);
    const result = operation(db);
    db.exec('COMMIT');

    return result;
  } finally { db.close(); }
}

function legacy(directory) {
  try { return fs.readFileSync(path.join(directory, 'comparison.json'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  return null;
}

function stored(db, directory, sessionId) {
  const key = identity(directory);
  let row = db.prepare('SELECT session_id, record_json FROM snapshot_comparison_records WHERE identity=?').get(key);

  if (!row) {
    const body = legacy(directory);

    if (identity(directory) !== key) throw new Error('Comparison directory changed during import');
    db.prepare('INSERT INTO snapshot_comparison_records VALUES (?, ?, ?)').run(key, sessionId, body);
    row = { session_id: sessionId, record_json: body };
  }

  if (row.session_id !== sessionId) throw new Error('Comparison session identity changed');

  return row.record_json;
}

function read(root, directory, sessionId) {
  return withDatabase(root, db => {
    const body = stored(db, directory, sessionId);

    return body === null ? undefined : JSON.parse(body);
  });
}

function locate(db, directory, queue, name) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) throw new Error('Invalid pending comparison name');
  db.prepare('INSERT INTO snapshot_comparison_locations VALUES (?, ?, ?) ON CONFLICT(identity) DO UPDATE SET queue_identity=excluded.queue_identity, name=excluded.name')
    .run(identity(directory), identity(queue), name);
}

function importQueue(db, queue, sessionId, key) {
  if (db.prepare('SELECT 1 FROM snapshot_comparison_imports WHERE queue_identity=?').get(key)) return;

  for (const entry of fs.readdirSync(queue, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') && !entry.name.startsWith('.acknowledged-')) continue;
    const directory = path.join(queue, entry.name);
    stored(db, directory, sessionId);
    locate(db, directory, queue, entry.name.replace(/^\.acknowledged-/, ''));
  }

  if (identity(queue) !== key) throw new Error('Comparison queue changed during import');
  db.prepare('INSERT INTO snapshot_comparison_imports VALUES (?)').run(key);
}

function present(queue, row) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(row.name)) throw new Error('Invalid saved comparison name');

  for (const name of [row.name, `.acknowledged-${row.name}`]) {
    try {
      if (identity(path.join(queue, name)) !== row.identity) throw new Error('Saved comparison directory was replaced');

      return [name];
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  return [];
}

function list(root, queue, sessionId, retireMissing = false) {
  const key = identity(queue);

  return withDatabase(root, db => {
    importQueue(db, queue, sessionId, key);

    const rows = db.prepare(`SELECT locations.identity, locations.name, records.session_id
      FROM snapshot_comparison_locations locations JOIN snapshot_comparison_records records USING(identity)
      WHERE locations.queue_identity=? ORDER BY locations.name`).all(key);

    return rows.flatMap(row => {
      if (row.session_id !== sessionId) throw new Error('Comparison queue session identity changed');

      const names = present(queue, row);

      if (retireMissing && !names.length) db.prepare('DELETE FROM snapshot_comparison_records WHERE identity=?').run(row.identity);

      return names;
    });
  });
}

function write(root, directory, record) {
  const key = identity(directory);
  withDatabase(root, db => {
    if (db.prepare('SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?)').get(record.sessionId)) throw new Error('Cannot save a comparison for a deleted session');
    db.prepare('INSERT INTO snapshot_comparison_records VALUES (?, ?, ?) ON CONFLICT(identity) DO UPDATE SET session_id=excluded.session_id, record_json=excluded.record_json')
      .run(key, record.sessionId, JSON.stringify(record));
    locate(db, directory, path.dirname(directory), record.turnId);
  });
}

function remove(root, key) {
  withDatabase(root, db => db.prepare('DELETE FROM snapshot_comparison_records WHERE identity=?').run(key));
}

module.exports = { identity, read, write, remove, list };
