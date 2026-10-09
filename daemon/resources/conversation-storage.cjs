const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');

function location(file) {
  if (path.basename(path.dirname(file)) !== 'conversation-ownership' || !/^[a-f0-9]{40}\.json$/.test(path.basename(file))) throw new Error('Invalid conversation ownership location');

  return { root: path.dirname(path.dirname(file)), key: path.basename(file, '.json') };
}

function withDatabase(file, operation) {
  const { root, key } = location(file);
  const db = database.open(root);

  try {
    db.exec('CREATE TABLE IF NOT EXISTS conversation_ownership (record_id TEXT PRIMARY KEY, record_json TEXT)');

    return operation(db, key);
  } finally { db.close(); }
}

function read(file) {
  return withDatabase(file, (db, key) => {
    db.exec('BEGIN IMMEDIATE');

    try {
      const row = db.prepare('SELECT record_json FROM conversation_ownership WHERE record_id=?').get(key);
      let body = row?.record_json ?? null;

      if (!row) {
        try { body = fs.readFileSync(file, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }

        db.prepare('INSERT INTO conversation_ownership VALUES (?, ?)').run(key, body);
      }

      db.exec('COMMIT');

      return body;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
}

function required(file) {
  const body = read(file);

  if (body === null) throw new Error(`Conversation ownership is unavailable: ${file}`);

  return body;
}

function write(file, body) {
  JSON.parse(body);
  withDatabase(file, (db, key) => db.prepare('INSERT INTO conversation_ownership VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET record_json=excluded.record_json').run(key, body));
}

module.exports = { read, required, write };
