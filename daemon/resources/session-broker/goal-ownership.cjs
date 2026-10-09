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

function legacy(directory) {
  let descriptor;

  try { descriptor = fs.openSync(path.join(directory, 'owners.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }

  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Invalid saved goal ownership');

    return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(descriptor));
  } finally { fs.closeSync(descriptor); }
}

function read(root, directory) {
  let expected;

  try { expected = identity(directory); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }

  return withDatabase(root, db => {
    const query = db.prepare('SELECT record_json FROM goal_ownership WHERE directory=? AND identity=?');
    let row = query.get(directory, expected);

    if (!row) {
      const body = legacy(directory);

      if (identity(directory) !== expected) throw new Error('Goal ownership changed during import');
      db.prepare('INSERT INTO goal_ownership VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(directory, expected, body);
      row = query.get(directory, expected);
    }

    return row.record_json === null ? undefined : JSON.parse(row.record_json);
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

    const expected = save(root, directory, undefined);
    remove(root, directory, '');

    return { directory, identity: expected };
  }

  throw new Error('Could not allocate goal attachment storage');
}

function importDirectory(db, directory) {
  const expected = identity(directory);
  const body = legacy(directory);

  if (identity(directory) !== expected) throw new Error('Goal ownership changed during import');
  db.prepare('INSERT INTO goal_ownership VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(directory, expected, body);
}

function importTree(db, directory) {
  let entries;

  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.endsWith('.snapshots')) continue;
    const child = path.join(directory, entry.name);

    if (path.basename(directory) === 'attachments') {
      if (/^goal-[a-zA-Z0-9_-]+$/.test(entry.name) && !/-pending-[a-zA-Z0-9]+$/.test(entry.name)) importDirectory(db, child);
    } else importTree(db, child);
  }
}

function directories(root, sessionId) {
  return withDatabase(root, db => {
    db.exec('BEGIN IMMEDIATE');

    try {
      if (!db.prepare("SELECT 1 FROM storage_migrations WHERE name='goal-ownership-v1'").get()) {
        importTree(db, path.join(root, 'sessions'));
        importTree(db, path.join(root, 'attachments'));
        db.prepare("INSERT INTO storage_migrations VALUES ('goal-ownership-v1')").run();
      }

      if (!db.prepare("SELECT 1 FROM storage_migrations WHERE name='goal-ownership-all-areas-v1'").get()) {
        for (const area of ['archived', 'fork-transactions', 'fork-preparations']) importTree(db, path.join(root, area));
        db.prepare("INSERT INTO storage_migrations VALUES ('goal-ownership-all-areas-v1')").run();
      }

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

module.exports = { read, save, retained, remove, directories, allocate };
