const path = require('node:path');
const { createHash } = require('node:crypto');
const tables = require('./session-database.cjs');

function location(file) {
  if (path.basename(path.dirname(file)) !== 'restore-transactions' || !/^[a-f0-9]{40}\.json$/.test(path.basename(file))) throw new Error('Invalid restore record location');

  return { root: path.dirname(path.dirname(file)), id: path.basename(file, '.json') };
}

function write(file, body) {
  const { root, id } = location(file);
  const db = tables.open(root);

  try {
    db.prepare('INSERT INTO session_restorations VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET record_json=excluded.record_json').run(id, body);
  } finally { db.close(); }
}

function read(file) {
  const { root, id } = location(file);
  const db = tables.open(root);

  try {
    const row = db.prepare('SELECT record_json FROM session_restorations WHERE record_id=?').get(id);

    if (!row) return null;
    const body = row.record_json;
    let value;

    try { value = JSON.parse(body); } catch { }

    return { file, body, value, fingerprint: createHash('sha256').update(body).digest('hex') };
  } finally { db.close(); }
}

function remove(file) {
  const { root, id } = location(file);
  const db = tables.open(root);

  try { db.prepare('DELETE FROM session_restorations WHERE record_id=?').run(id); }
  finally { db.close(); }
}

function list(root) {
  const db = tables.open(root);

  try { return db.prepare('SELECT record_id FROM session_restorations ORDER BY record_id').all().map(row => path.join(root, 'restore-transactions', `${row.record_id}.json`)); }
  finally { db.close(); }
}

module.exports = { write, read, remove, list };
