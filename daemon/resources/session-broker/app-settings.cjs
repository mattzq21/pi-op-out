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

function oldBody(file) {
  try { return fs.readFileSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  return null;
}

function accepted(body, accept) {
  if (body === null) return false;

  try { return accept(JSON.parse(Buffer.from(body).toString('utf8'))); }
  catch (error) { if (error instanceof SyntaxError) return false; throw error; }
}

function importLegacy(db, name, body, legacy, accept) {
  if (!accepted(body, accept)) {
    const previous = oldBody(legacy);

    if (accepted(previous, accept)) body = previous;
  }

  db.prepare('UPDATE application_settings SET body=?, legacy_imported=1 WHERE name=?').run(body, name);

  return body;
}

function readText(file, legacy, accept = () => true) {
  const db = open(path.dirname(file));
  const name = path.basename(file);

  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare('SELECT body, legacy_imported FROM application_settings WHERE name=?').get(name);
    let body = row?.body ?? null;

    if (!row) {
      body = oldBody(file);

      db.prepare('INSERT INTO application_settings (name, body) VALUES (?, ?)').run(name, body);
    }

    if (legacy && !row?.legacy_imported) body = importLegacy(db, name, body, legacy, accept);

    db.exec('COMMIT');

    return body === null ? undefined : Buffer.from(body).toString('utf8');
  } finally { db.close(); }
}

function readFile(file) {
  const body = readText(file);

  return body === undefined ? undefined : JSON.parse(body);
}

function importMissing(file, legacy) {
  readText(file);
  const db = open(path.dirname(file));
  const name = path.basename(file);

  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare('SELECT body, legacy_imported FROM application_settings WHERE name=?').get(name);

    if (row.body === null && !row.legacy_imported) {
      const body = oldBody(legacy);

      if (body !== null) JSON.parse(Buffer.from(body).toString('utf8'));
      db.prepare('UPDATE application_settings SET body=?, legacy_imported=1 WHERE name=?').run(body, name);
    }

    db.exec('COMMIT');
  } finally { db.close(); }
}

function read(root) { return readFile(path.join(root, 'settings.json')); }

function write(file, body) {
  JSON.parse(body);
  const db = open(path.dirname(file));

  try {
    db.prepare('INSERT INTO application_settings VALUES (?, ?, 1) ON CONFLICT(name) DO UPDATE SET body=excluded.body, legacy_imported=1')
      .run(path.basename(file), Buffer.from(body));
  } finally { db.close(); }
}

module.exports = { read, readFile, readText, write, importMissing };
