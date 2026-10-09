const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');
const { randomUUID } = require('node:crypto');

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

      CREATE TABLE IF NOT EXISTS snapshot_preparations (
        parent_identity TEXT NOT NULL, name TEXT NOT NULL, identity TEXT, session_id TEXT NOT NULL,
        PRIMARY KEY(parent_identity, name));

      BEGIN IMMEDIATE;`);
    const result = operation(db);
    db.exec('COMMIT');

    return result;
  } finally { db.close(); }
}

function stored(db, directory, sessionId) {
  const key = identity(directory);
  const row = db.prepare('SELECT session_id, record_json FROM snapshot_comparison_records WHERE identity=?').get(key);

  if (!row) return null;

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

function preparationName(name) {
  if (!/^\.preparing-[a-zA-Z0-9-]+$/.test(name)) throw new Error('Invalid snapshot preparation name');

  return name;
}

function prepare(root, parent, sessionId) {
  const key = identity(parent);
  const name = `.preparing-${randomUUID()}`;
  const directory = path.join(parent, name);
  withDatabase(root, db => {
    if (db.prepare('SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?)').get(sessionId)) throw new Error('Cannot prepare a snapshot for a deleted session');
    db.prepare('INSERT INTO snapshot_preparations VALUES (?, ?, NULL, ?)').run(key, name, sessionId);
  });

  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { finishPreparation(root, directory); throw error; }

  const created = identity(directory);

  if (identity(parent) !== key) throw new Error('Snapshot preparation parent changed');
  withDatabase(root, db => db.prepare('UPDATE snapshot_preparations SET identity=? WHERE parent_identity=? AND name=?').run(created, key, name));

  return directory;
}

function preparationDirectory(db, parent, row) {
  const directory = path.join(parent, preparationName(row.name));
  let current;

  try { current = identity(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    db.prepare('DELETE FROM snapshot_preparations WHERE parent_identity=? AND name=?').run(row.parent_identity, row.name);

    return [];
  }

  if (row.identity !== null && row.identity !== current) throw new Error('Snapshot preparation directory was replaced');

  if (row.identity === null) db.prepare('UPDATE snapshot_preparations SET identity=? WHERE parent_identity=? AND name=?').run(current, row.parent_identity, row.name);

  return [directory];
}

function preparations(root, parent, sessionId) {
  const key = identity(parent);

  return withDatabase(root, db => {

    return db.prepare('SELECT * FROM snapshot_preparations WHERE parent_identity=? ORDER BY name').all(key).flatMap(row => {
      if (row.session_id !== sessionId) throw new Error('Snapshot preparation session identity changed');

      return preparationDirectory(db, parent, row);
    });
  });
}

function finishPreparation(root, directory) {
  const key = identity(path.dirname(directory));
  const name = preparationName(path.basename(directory));
  withDatabase(root, db => db.prepare('DELETE FROM snapshot_preparations WHERE parent_identity=? AND name=?').run(key, name));
}

module.exports = { identity, read, write, remove, list, prepare, preparations, finishPreparation };
