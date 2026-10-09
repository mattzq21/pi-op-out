const fs = require('node:fs');
const path = require('node:path');
const database = require('../session-database.cjs');

function withDatabase(root, operation) {
  const db = database.open(root);

  try {
    db.exec('CREATE TABLE IF NOT EXISTS goal_preparations (directory TEXT NOT NULL, identity TEXT NOT NULL, record_json TEXT, PRIMARY KEY(directory, identity))');

    return operation(db);
  } finally { db.close(); }
}

function identity(directory) {
  const info = fs.lstatSync(directory, { bigint: true });

  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Goal preparation directory changed');

  return `${info.dev}:${info.ino}`;
}

function legacy(directory) {
  let descriptor;

  try { descriptor = fs.openSync(path.join(directory, 'prepared.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }

  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Invalid saved goal preparation');

    return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(descriptor));
  } finally { fs.closeSync(descriptor); }
}

function read(root, directory) {
  let expected;

  try { expected = identity(directory); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }

  return withDatabase(root, db => {
    const query = db.prepare('SELECT record_json FROM goal_preparations WHERE directory=? AND identity=?');
    let row = query.get(directory, expected);

    if (!row) {
      const body = legacy(directory);

      if (identity(directory) !== expected) throw new Error('Goal preparation changed during import');
      db.prepare('INSERT INTO goal_preparations VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(directory, expected, body);
      row = query.get(directory, expected);
    }

    return row.record_json === null ? undefined : JSON.parse(row.record_json);
  });
}

function save(root, directory, record, destination = directory) {
  const expected = identity(directory);
  withDatabase(root, db => db.prepare('INSERT INTO goal_preparations VALUES (?, ?, ?) ON CONFLICT(directory, identity) DO UPDATE SET record_json=excluded.record_json')
    .run(destination, expected, JSON.stringify(record)));

  return expected;
}

function retained(root, directory, expected) {
  return withDatabase(root, db => Boolean(db.prepare('SELECT 1 FROM goal_preparations WHERE directory=? AND identity=? AND record_json IS NOT NULL').get(directory, expected)));
}

function remove(root, directory, expected) {
  withDatabase(root, db => db.prepare('DELETE FROM goal_preparations WHERE directory=? AND identity=?').run(directory, expected));
}

module.exports = { read, save, retained, remove };
