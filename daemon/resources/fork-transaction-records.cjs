const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');

function open(directory) { return database.open(path.dirname(path.dirname(directory))); }

function allocate(directory) {
  const db = open(directory);

  try { db.prepare('INSERT INTO fork_transactions (directory) VALUES (?)').run(directory); }
  finally { db.close(); }
}

function save(directory, record) {
  const db = open(directory);

  try {
    const result = db.prepare('UPDATE fork_transactions SET record_json=? WHERE directory=?').run(JSON.stringify(record), directory);

    if (result.changes !== 1) throw new Error('Fork transaction is not registered');
  }
  finally { db.close(); }
}

function read(directory) {
  const db = open(directory);

  try {
    const row = db.prepare('SELECT record_json FROM fork_transactions WHERE directory=?').get(directory);

    if (!row) throw new Error('Fork transaction is not registered');

    if (row.record_json !== null) return JSON.parse(row.record_json);
    let body;

    try { body = fs.readFileSync(path.join(directory, 'transaction.json'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }

    const record = JSON.parse(body);
    db.prepare('UPDATE fork_transactions SET record_json=? WHERE directory=? AND record_json IS NULL').run(body, directory);

    return record;
  } finally { db.close(); }
}

function remove(directory) {
  const db = open(directory);

  try { db.prepare('DELETE FROM fork_transactions WHERE directory=?').run(directory); }
  finally { db.close(); }
}

function list(root) {
  const db = database.open(root);

  try { return db.prepare('SELECT directory FROM fork_transactions ORDER BY directory').all().map(row => row.directory); }
  finally { db.close(); }
}

module.exports = { allocate, save, read, remove, list };
