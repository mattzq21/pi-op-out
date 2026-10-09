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
      CREATE TABLE IF NOT EXISTS application_settings (name TEXT PRIMARY KEY, body BLOB);`);

    return db;
  } catch (error) { db.close(); throw error; }
}

function readFile(file) {
  const body = readText(file);

  return body === undefined ? undefined : JSON.parse(body);
}

function read(root) { return readFile(path.join(root, 'settings.json')); }

function write(file, body) {
  JSON.parse(body);
  const db = open(path.dirname(file));

  try {
    db.prepare('INSERT INTO application_settings (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body=excluded.body')
      .run(path.basename(file), Buffer.from(body));
  } finally { db.close(); }
}

module.exports = { read, readFile, readText, write };

function readText(file) {
  const db = open(path.dirname(file));

  try {
    const row = db.prepare("SELECT body FROM application_settings WHERE name=?").get(path.basename(file));

    return row?.body == null ? undefined : Buffer.from(row.body).toString("utf8");
  } finally { db.close(); }
}
