const path = require('node:path');
const database = require('./session-database.cjs');

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function folderNames(id) {
  const hex = id.replaceAll('-', '');

  return Array.from({ length: hex.length - 3 }, (_, index) => hex.slice(0, index + 4));
}

function ownsFolder(root, id, directory) {
  return uuid.test(id) && path.dirname(directory) === path.join(root, 'tmp') && folderNames(id).includes(path.basename(directory));
}

function list(root) {
  const db = database.open(root);

  try {
    db.exec('CREATE TABLE IF NOT EXISTS temporary_chat_allocations (session_id TEXT PRIMARY KEY, original_path TEXT NOT NULL UNIQUE); BEGIN IMMEDIATE');
    const rows = db.prepare('SELECT session_id, original_path FROM temporary_chat_allocations ORDER BY session_id').all();

    for (const row of rows) {
      if (!ownsFolder(root, row.session_id, row.original_path)) throw new Error('Invalid saved temporary chat directory');
    }

    db.exec('COMMIT');

    return rows;
  } finally { db.close(); }
}

module.exports = { list, folderNames, ownsFolder, uuid };
