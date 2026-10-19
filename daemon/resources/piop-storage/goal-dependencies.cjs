const fs = require('node:fs');
const path = require('node:path');
const database = require('../session-database.cjs');

function withDatabase(root, operation) {
  const db = database.open(root);

  try {
    db.exec('CREATE TABLE IF NOT EXISTS goal_text_files (directory TEXT NOT NULL, identity TEXT NOT NULL, names_json TEXT NOT NULL, PRIMARY KEY(directory, identity)); CREATE TABLE IF NOT EXISTS goal_text_contents (directory TEXT NOT NULL, identity TEXT NOT NULL, contents_json TEXT NOT NULL, PRIMARY KEY(directory, identity))');

    return operation(db);
  }
  finally { db.close(); }
}

function identity(directory) {
  const info = fs.lstatSync(directory, { bigint: true });

  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Goal dependency directory changed');

  return `${info.dev}:${info.ino}`;
}

function value(row) { return row && row.record_json !== null ? JSON.parse(row.record_json) : undefined; }

function read(root, directory) {
  const expected = identity(directory);

  return withDatabase(root, db => {
    const query = db.prepare('SELECT record_json FROM goal_asset_dependencies WHERE directory=? AND identity=?');
    const row = query.get(directory, expected);

    if (row) return value(row);

    return undefined;
  });
}

function save(root, directory, record) {
  const expected = identity(directory);

  withDatabase(root, db => db.prepare('INSERT INTO goal_asset_dependencies VALUES (?, ?, ?) ON CONFLICT(directory, identity) DO UPDATE SET record_json=excluded.record_json')
    .run(directory, expected, JSON.stringify(record)));
}

function retained(root, directory, expected) {
  return withDatabase(root, db => Boolean(db.prepare('SELECT 1 FROM goal_asset_dependencies WHERE directory=? AND identity=? AND record_json IS NOT NULL').get(directory, expected)));
}

function remove(root, directory, expected) {
  removeTextFiles(root, directory, expected);
  withDatabase(root, db => db.prepare('DELETE FROM goal_asset_dependencies WHERE directory=? AND identity=?').run(directory, expected));
}

function validNames(names) {
  if (!Array.isArray(names) || names.some(name => !/^[^/\\]+\.(md|txt)$/.test(name) || path.basename(name) !== name)) throw new Error('Invalid goal text file list');

  return names;
}

function unpublished(db, directory, expected) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goal_ownership'").get()) return false;

  return Boolean(db.prepare("SELECT 1 FROM goal_ownership WHERE directory=? AND identity IN (?, '') AND record_json IS NULL").get(directory, expected));
}

function textFiles(root, directory) {
  const expected = identity(directory);

  return withDatabase(root, db => {
    const query = db.prepare('SELECT names_json FROM goal_text_files WHERE directory=? AND identity=?');
    const row = query.get(directory, expected);

    if (!row && unpublished(db, directory, expected)) return [];

    if (!row) throw new Error('Goal text files are not registered');

    return validNames(JSON.parse(row.names_json));
  });
}

function readContents(directory, names) {
  return validNames(names).map(name => {
    const file = path.join(directory, name);
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);

    try {
      const before = fs.fstatSync(descriptor, { bigint: true });

      if (!before.isFile()) throw new Error('Goal text is not a regular file');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(descriptor));
      const after = fs.lstatSync(file, { bigint: true });

      if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) throw new Error('Goal text changed during import');

      return { name, text };
    } finally { fs.closeSync(descriptor); }
  });
}

function textContents(root, directory) {
  const expected = identity(directory);

  return withDatabase(root, db => {
    const query = db.prepare('SELECT contents_json FROM goal_text_contents WHERE directory=? AND identity=?');
    const row = query.get(directory, expected);

    if (!row && unpublished(db, directory, expected)) return [];

    if (!row) throw new Error('Goal text contents are not registered');

    return JSON.parse(row.contents_json);
  });
}

function saveTextFiles(root, directory, names, destination = directory) {
  return publishText(root, directory, names, destination);
}

function savePreparedText(root, directory, names, preparation, destination = directory) {
  const input = JSON.parse(preparation);
  const ownership = { version: 1, kind: "goal-assets", owners: [{ sessionId: input.sessionId, sessionPath: input.sessionPath }] };

  return publishText(root, directory, names, destination, preparation, ownership);
}

function publishText(root, directory, names, destination, preparation, ownership) {
  const expected = identity(directory);
  const contents = readContents(directory, names);

  if (identity(directory) !== expected) throw new Error('Goal text directory changed during publication');
  withDatabase(root, db => {
    db.exec('BEGIN IMMEDIATE');

    if (preparation !== undefined) {
      db.exec('CREATE TABLE IF NOT EXISTS goal_ownership (directory TEXT NOT NULL, identity TEXT NOT NULL, record_json TEXT, PRIMARY KEY(directory, identity))');
      db.prepare('INSERT INTO goal_ownership VALUES (?, ?, ?) ON CONFLICT(directory, identity) DO UPDATE SET record_json=excluded.record_json').run(destination, expected, JSON.stringify(ownership));
      db.exec('CREATE TABLE IF NOT EXISTS goal_preparations (directory TEXT NOT NULL, identity TEXT NOT NULL, record_json TEXT, PRIMARY KEY(directory, identity))');
      db.prepare('INSERT INTO goal_preparations VALUES (?, ?, ?) ON CONFLICT(directory, identity) DO UPDATE SET record_json=excluded.record_json').run(destination, expected, preparation);
    }

    db.prepare('INSERT INTO goal_text_files VALUES (?, ?, ?) ON CONFLICT(directory, identity) DO UPDATE SET names_json=excluded.names_json')
      .run(destination, expected, JSON.stringify(names));
    db.prepare('INSERT INTO goal_text_contents VALUES (?, ?, ?) ON CONFLICT(directory, identity) DO UPDATE SET contents_json=excluded.contents_json')
      .run(destination, expected, JSON.stringify(contents));
    db.exec('COMMIT');
  });

  return expected;
}

function removeTextFiles(root, directory, expected) {
  withDatabase(root, db => {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM goal_text_files WHERE directory=? AND identity=?').run(directory, expected);
    db.prepare('DELETE FROM goal_text_contents WHERE directory=? AND identity=?').run(directory, expected);

    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goal_directory_history'").get()) db.prepare('DELETE FROM goal_directory_history WHERE directory=? AND current_identity=?').run(directory, expected);
    db.exec('COMMIT');
  });
}

function removePreparedText(root, directory, expected) {
  withDatabase(root, db => {
    db.exec('BEGIN IMMEDIATE');

    for (const table of ['goal_preparations', 'goal_text_files', 'goal_text_contents', 'goal_ownership']) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.prepare(`DELETE FROM ${table} WHERE directory=? AND identity=?`).run(directory, expected);
    }

    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goal_directory_history'").get()) db.prepare('DELETE FROM goal_directory_history WHERE directory=? AND current_identity=?').run(directory, expected);
    db.exec('COMMIT');
  });
}

function matchesDirectory(root, directory, previous, current) {
  if (previous === current) return true;

  return withDatabase(root, db => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goal_directory_history'").get()) return false;

    return Boolean(db.prepare('SELECT 1 FROM goal_directory_history WHERE directory=? AND previous_identity=? AND current_identity=?').get(directory, previous, current));
  });
}

module.exports = { read, save, retained, remove, textFiles, textContents, saveTextFiles, savePreparedText, removeTextFiles, removePreparedText, matchesDirectory };
