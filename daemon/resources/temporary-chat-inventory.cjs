const path = require('node:path');
const database = require('./session-database.cjs');

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function list(root) {
  const db = database.open(root);

  try {
    db.exec('CREATE TABLE IF NOT EXISTS temporary_chat_allocations (session_id TEXT PRIMARY KEY, original_path TEXT NOT NULL UNIQUE); BEGIN IMMEDIATE');
    const rows = db.prepare('SELECT session_id, original_path FROM temporary_chat_allocations ORDER BY session_id').all();

    for (const row of rows) {
      if (!uuid.test(row.session_id) || row.original_path !== path.join(root, 'tmp', row.session_id)) throw new Error('Invalid saved temporary chat directory');
    }

    db.exec('COMMIT');

    return rows;
  } finally { db.close(); }
}

module.exports = { list };
