const fs = require('node:fs');
const path = require('node:path');
const database = require('../session-database.cjs');

function withDatabase(root, operation) {
  const db = database.open(root);

  try { return operation(db); }
  finally { db.close(); }
}

function identity(directory) {
  const info = fs.lstatSync(directory, { bigint: true });

  if (!info.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Goal dependency directory changed');

  return `${info.dev}:${info.ino}`;
}

function legacy(directory) {
  const file = path.join(directory, 'dependencies.json');
  let descriptor;

  try { descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }

  try {
    if (!fs.fstatSync(descriptor).isFile() || fs.realpathSync(file) !== file) throw new Error('Invalid goal dependency record');

    return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(descriptor));
  } finally { fs.closeSync(descriptor); }
}

function value(row) { return row && row.record_json !== null ? JSON.parse(row.record_json) : undefined; }

function read(root, directory) {
  const expected = identity(directory);

  return withDatabase(root, db => {
    const query = db.prepare('SELECT record_json FROM goal_asset_dependencies WHERE directory=? AND identity=?');
    const row = query.get(directory, expected);

    if (row) return value(row);
    const body = legacy(directory);

    if (identity(directory) !== expected) throw new Error('Goal dependency directory changed during import');
    db.prepare('INSERT INTO goal_asset_dependencies VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(directory, expected, body);

    return value(query.get(directory, expected));
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
  withDatabase(root, db => db.prepare('DELETE FROM goal_asset_dependencies WHERE directory=? AND identity=?').run(directory, expected));
}

module.exports = { read, save, retained, remove };
