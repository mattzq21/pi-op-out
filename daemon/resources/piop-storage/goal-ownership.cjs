const fs = require('node:fs');
const path = require('node:path');
const database = require('../session-database.cjs');
const { randomBytes } = require('node:crypto');

function withDatabase(root, operation) {
  const db = database.open(root);

  try {
    db.exec('CREATE TABLE IF NOT EXISTS goal_ownership (directory TEXT NOT NULL, identity TEXT NOT NULL, record_json TEXT, PRIMARY KEY(directory, identity))');

    return operation(db);
  } finally { db.close(); }
}

function identity(directory) {
  const info = fs.lstatSync(directory, { bigint: true });

  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Goal ownership directory changed');

  return `${info.dev}:${info.ino}`;
}

function read(root, directory) {
  let expected;

  try { expected = identity(directory); }
  catch (error) { if (error.code === 'ENOENT') return missingDirectoryRecord(root, directory); throw error; }

  return withDatabase(root, db => {
    const query = db.prepare('SELECT record_json FROM goal_ownership WHERE directory=? AND identity=?');
    const row = query.get(directory, expected);

    if (!row) {
      assertSavedIdentity(db, directory, expected);

      return undefined;
    }

    return row.record_json === null ? undefined : JSON.parse(row.record_json);
  });
}

function assertSavedIdentity(db, directory, expected) {
  if (db.prepare('SELECT 1 FROM goal_ownership WHERE directory=? AND identity<>? AND record_json IS NOT NULL').get(directory, expected)) throw new Error('Saved goal ownership directory was replaced');
}

function missingDirectoryRecord(root, directory) {
  const row = missingDirectoryRow(root, directory);

  return row ? JSON.parse(row.record_json) : undefined;
}

function savedIdentity(root, directory) { return missingDirectoryRow(root, directory)?.identity; }

function missingDirectoryRow(root, directory) {
  return withDatabase(root, db => {
    const rows = db.prepare('SELECT identity, record_json FROM goal_ownership WHERE directory=? AND record_json IS NOT NULL').all(directory);

    if (rows.length > 1) throw new Error('More than one saved goal owner record refers to the missing directory');

    return rows[0];
  });
}

function save(root, directory, record, destination = directory) {
  const expected = identity(directory);
  withDatabase(root, db => db.prepare('INSERT INTO goal_ownership VALUES (?, ?, ?) ON CONFLICT(directory, identity) DO UPDATE SET record_json=excluded.record_json')
    .run(destination, expected, record === undefined ? null : JSON.stringify(record)));

  return expected;
}

function retained(root, directory, expected) {
  return withDatabase(root, db => Boolean(db.prepare('SELECT 1 FROM goal_ownership WHERE directory=? AND identity=? AND record_json IS NOT NULL').get(directory, expected)));
}

function remove(root, directory, expected) {
  withDatabase(root, db => db.prepare('DELETE FROM goal_ownership WHERE directory=? AND identity=?').run(directory, expected));
}

function allocate(root, parent) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const directory = path.join(parent, `goal-${randomBytes(3).toString('hex')}`);
    const reserved = withDatabase(root, db => db.prepare('INSERT INTO goal_ownership VALUES (?, ?, NULL) ON CONFLICT DO NOTHING').run(directory, '').changes);

    if (!reserved) continue;

    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) {
      remove(root, directory, '');

      if (error.code === 'EEXIST') continue;
      throw error;
    }

    const expected = publishAllocation(root, directory);

    return { directory, identity: expected };
  }

  throw new Error('Could not allocate goal attachment storage');
}

function publishAllocation(root, directory) {
  const expected = identity(directory);
  withDatabase(root, db => {
    db.exec(`CREATE TABLE IF NOT EXISTS goal_text_files (directory TEXT NOT NULL, identity TEXT NOT NULL, names_json TEXT NOT NULL, PRIMARY KEY(directory, identity));
      CREATE TABLE IF NOT EXISTS goal_text_contents (directory TEXT NOT NULL, identity TEXT NOT NULL, contents_json TEXT NOT NULL, PRIMARY KEY(directory, identity)); BEGIN IMMEDIATE;`);
    db.prepare('INSERT INTO goal_ownership VALUES (?, ?, NULL)').run(directory, expected);
    db.prepare("INSERT INTO goal_text_files VALUES (?, ?, '[]')").run(directory, expected);
    db.prepare("INSERT INTO goal_text_contents VALUES (?, ?, '[]')").run(directory, expected);
    db.prepare("DELETE FROM goal_ownership WHERE directory=? AND identity=''").run(directory);
    db.exec('COMMIT');
  });

  return expected;
}

function directories(root, sessionId) {
  return withDatabase(root, db => {
    db.exec('BEGIN IMMEDIATE');

    try {
      const rows = sessionId === undefined
        ? db.prepare('SELECT DISTINCT directory FROM goal_ownership').all()
        : db.prepare(`SELECT DISTINCT directory FROM goal_ownership
          WHERE EXISTS (SELECT 1 FROM json_each(record_json, '$.owners') AS owner
            WHERE json_extract(owner.value, '$.sessionId')=?)`).all(sessionId);

      const result = rows.map(row => row.directory);
      db.exec('COMMIT');

      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
}

module.exports = { read, save, retained, remove, directories, allocate, savedIdentity };
