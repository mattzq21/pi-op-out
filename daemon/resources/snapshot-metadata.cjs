const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');

function identity(directory) {
  const info = fs.lstatSync(directory, { bigint: true });

  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Snapshot directory changed');

  return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
}

function root(directory) {
  let current = directory;

  while (path.dirname(current) !== current) {
    if (['sessions', 'archived', 'git-snapshots'].includes(path.basename(current))) return path.dirname(current);
    current = path.dirname(current);
  }

  throw new Error('Snapshot is outside Piop storage');
}

function withDatabase(directory, operation) {
  const db = database.open(root(directory));

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS snapshot_metadata (
      identity TEXT PRIMARY KEY, session_id TEXT, record_json TEXT);
      CREATE TABLE IF NOT EXISTS snapshot_metadata_directories (identity TEXT PRIMARY KEY, parent_identity TEXT);
      CREATE INDEX IF NOT EXISTS snapshot_metadata_parent ON snapshot_metadata_directories(parent_identity);
      CREATE TABLE IF NOT EXISTS snapshot_metadata_removals (directory TEXT PRIMARY KEY, identity TEXT NOT NULL, identities_json TEXT NOT NULL);
      BEGIN IMMEDIATE;`);
    finishMissing(db);
    const result = operation(db);
    db.exec('COMMIT');

    return result;
  } finally { db.close(); }
}

function legacy(directory) {
  try { return fs.readFileSync(path.join(directory, 'snapshot.json'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  return null;
}

function read(directory) {
  let key;

  try { key = identity(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }

  return withDatabase(directory, db => {
    let row = db.prepare('SELECT record_json FROM snapshot_metadata WHERE identity=?').get(key);

    if (!row) {
      const body = legacy(directory);

      if (identity(directory) !== key) throw new Error('Snapshot directory changed during import');
      const sessionId = body === null ? null : JSON.parse(body).sessionId ?? null;
      db.prepare('INSERT INTO snapshot_metadata VALUES (?, ?, ?)').run(key, sessionId, body);
      row = { record_json: body };
    }

    linkDirectory(db, directory);

    return row.record_json === null ? undefined : JSON.parse(row.record_json);
  });
}

function write(directory, record) {
  const key = identity(directory);
  withDatabase(directory, db => {
    if (record.sessionId && db.prepare('SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(?)').get(record.sessionId)) throw new Error('Cannot save a snapshot for a deleted session');
    db.prepare('INSERT INTO snapshot_metadata VALUES (?, ?, ?) ON CONFLICT(identity) DO UPDATE SET session_id=excluded.session_id, record_json=excluded.record_json')
      .run(key, record.sessionId ?? null, JSON.stringify(record));
    linkDirectory(db, directory);
  });
}

function copy(source, destination) {
  const saved = read(source);

  if (saved !== undefined) write(destination, saved);
}

function identities(profile) {
  const db = database.open(profile);

  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='snapshot_metadata'").get()) return [];

    return db.prepare('SELECT identity FROM snapshot_metadata WHERE record_json IS NOT NULL').all().map(row => row.identity);
  } finally { db.close(); }
}

function linkDirectory(db, directory) {
  const profile = root(directory);
  let current = directory;
  let key = identity(current);

  while (current !== profile) {
    const parent = path.dirname(current);
    const parentKey = identity(parent);
    db.prepare('INSERT INTO snapshot_metadata_directories VALUES (?, ?) ON CONFLICT(identity) DO UPDATE SET parent_identity=excluded.parent_identity').run(key, parentKey);
    current = parent;
    key = parentKey;
  }
}

function retire(db, record) {
  const keys = JSON.parse(record.identities_json);

  if (!Array.isArray(keys) || keys.some(key => String(key) !== key)) throw new Error('Invalid snapshot metadata removal');

  for (const key of keys) {
    db.prepare('DELETE FROM snapshot_metadata WHERE identity=?').run(key);
    db.prepare('DELETE FROM snapshot_metadata_directories WHERE identity=?').run(key);
  }

  db.prepare('DELETE FROM snapshot_metadata_removals WHERE directory=?').run(record.directory);
}

function finishMissing(db) {
  for (const record of db.prepare('SELECT * FROM snapshot_metadata_removals').all()) {
    try { fs.lstatSync(record.directory); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      syncParent(record.directory);
      retire(db, record);
    }
  }
}

function removal(db, directory) {
  const previous = db.prepare('SELECT * FROM snapshot_metadata_removals WHERE directory=?').get(directory);
  let key;

  try { key = identity(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }

  if (previous) {
    if (previous.identity !== key) throw new Error('Snapshot removal directory was replaced');

    return previous;
  }

  linkKnownChildren(db, directory);

  const keys = db.prepare(`WITH RECURSIVE descendants(identity) AS (
    SELECT ? UNION SELECT directories.identity FROM snapshot_metadata_directories directories
    JOIN descendants ON directories.parent_identity=descendants.identity) SELECT identity FROM descendants`).all(key).map(row => row.identity);

  const record = { directory, identity: key, identities_json: JSON.stringify(keys) };
  db.prepare('INSERT INTO snapshot_metadata_removals VALUES (?, ?, ?)').run(directory, key, record.identities_json);

  return record;
}

function remove(directory) {
  const record = withDatabase(directory, db => removal(db, directory));

  if (!record) return;

  if (identity(directory) !== record.identity) throw new Error('Snapshot removal directory changed');
  fs.rmSync(directory, { recursive: true });
  syncParent(directory);
  withDatabase(directory, db => retire(db, record));
}

function syncParent(directory) {
  let parent = path.dirname(directory);

  for (;;) {
    let descriptor;

    try { descriptor = fs.openSync(parent, 'r'); }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(parent) === parent) throw error;
      parent = path.dirname(parent);
      continue;
    }

    try { fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }

    return;
  }
}

function linkKnownChildren(db, directory) {
  for (const name of ['before', 'after', 'retry-before']) {
    const child = path.join(directory, name);

    try { linkDirectory(db, child); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function moved(directory) {
  withDatabase(directory, db => { linkDirectory(db, directory); linkKnownChildren(db, directory); });
}

module.exports = { identity, read, write, copy, identities, remove, moved };
