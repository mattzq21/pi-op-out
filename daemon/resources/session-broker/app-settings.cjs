const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function open(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'sessions.sqlite');
  fs.closeSync(fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600));
  fs.chmodSync(file, 0o600);
  const db = new DatabaseSync(file);

  try {
    db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS application_settings (name TEXT PRIMARY KEY, body BLOB, legacy_imported INTEGER NOT NULL DEFAULT 0);`);

    return db;
  } catch (error) { db.close(); throw error; }
}

function read(root) {
  const db = open(root);

  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare("SELECT body FROM application_settings WHERE name='settings.json'").get();
    let body = row?.body ?? null;

    if (!row) {
      try { body = fs.readFileSync(path.join(root, 'settings.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }

      db.prepare("INSERT INTO application_settings (name, body) VALUES ('settings.json', ?)").run(body);
    }

    db.exec('COMMIT');

    return body === null ? undefined : JSON.parse(Buffer.from(body).toString('utf8'));
  } finally { db.close(); }
}

module.exports = { read };
