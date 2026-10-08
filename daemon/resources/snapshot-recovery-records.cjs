const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');

function root(directory) {
  const parent = path.dirname(directory);

  if (path.basename(parent) !== 'git-snapshots') throw new Error('Invalid snapshot recovery directory');

  return path.dirname(parent);
}

function identity(directory) {
  const info = fs.lstatSync(directory, { bigint: true });

  if (!info.isDirectory()) throw new Error('Snapshot recovery requires a regular directory');

  return `${info.dev}:${info.ino}`;
}

function read(directory) {
  const db = database.open(root(directory));

  try {
    const current = identity(directory);
    const row = db.prepare('SELECT identity, record_json FROM snapshot_recovery WHERE directory=?').get(directory);

    if (row?.identity === current) return JSON.parse(row.record_json);
    let body;

    try { body = fs.readFileSync(path.join(directory, 'recovery.json'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }

    const record = JSON.parse(body);
    save(db, directory, current, record);

    return record;
  } finally { db.close(); }
}

function save(db, directory, current, record) {
  db.prepare('INSERT INTO snapshot_recovery VALUES (?, ?, ?) ON CONFLICT(directory) DO UPDATE SET identity=excluded.identity, record_json=excluded.record_json')
    .run(directory, current, JSON.stringify(record));
}

function write(directory, record) {
  const db = database.open(root(directory));

  try { save(db, directory, identity(directory), record); }
  finally { db.close(); }
}

function remove(directory) {
  const db = database.open(root(directory));

  try { db.prepare('DELETE FROM snapshot_recovery WHERE directory=?').run(directory); }
  finally { db.close(); }
}

module.exports = { read, write, remove };
