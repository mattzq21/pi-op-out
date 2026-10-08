const path = require('node:path');
const { createHash } = require('node:crypto');
const tables = require('./session-database.cjs');

function location(file) {
  const receipt = path.basename(path.dirname(file)) === 'restore-receipts';

  if (!receipt && path.basename(path.dirname(file)) !== 'restore-transactions') throw new Error('Invalid restore record location');

  if (!(receipt ? /^[a-f0-9]{64}\.json$/ : /^[a-f0-9]{40}\.json$/).test(path.basename(file))) throw new Error('Invalid restore record name');

  return { root: path.dirname(path.dirname(file)), id: path.basename(file, '.json'), table: receipt ? 'session_restore_receipts' : 'session_restorations' };
}

function write(file, body) {
  const { root, id, table } = location(file);
  const db = tables.open(root);

  try {
    db.prepare(`INSERT INTO ${table} VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET record_json=excluded.record_json`).run(id, body);
  } finally { db.close(); }
}

function read(file) {
  const { root, id, table } = location(file);
  const db = tables.open(root);

  try {
    const row = db.prepare(`SELECT record_json FROM ${table} WHERE record_id=?`).get(id);

    if (!row) return null;
    const body = row.record_json;
    let value;

    try { value = JSON.parse(body); } catch { }

    return { file, body, value, fingerprint: createHash('sha256').update(body).digest('hex') };
  } finally { db.close(); }
}

function remove(file) {
  const { root, id, table } = location(file);
  const db = tables.open(root);

  try { db.prepare(`DELETE FROM ${table} WHERE record_id=?`).run(id); }
  finally { db.close(); }
}

function list(root, receipts = false) {
  const table = receipts ? 'session_restore_receipts' : 'session_restorations';
  const directory = receipts ? 'restore-receipts' : 'restore-transactions';
  const db = tables.open(root);

  try { return db.prepare(`SELECT record_id FROM ${table} ORDER BY record_id`).all().map(row => path.join(root, directory, `${row.record_id}.json`)); }
  finally { db.close(); }
}

module.exports = { write, read, remove, list };
