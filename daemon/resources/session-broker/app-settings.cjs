const fs = require('node:fs');
const path = require('node:path');
const database = require('../session-database.cjs');

function readFile(file) {
  const body = readText(file);

  return body === undefined ? undefined : JSON.parse(body);
}

function read(root) { return readFile(path.join(root, 'settings.json')); }

function write(file, body) {
  JSON.parse(body);
  database.connection(path.dirname(file)).prepare('INSERT INTO application_settings (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body=excluded.body')
    .run(path.basename(file), Buffer.from(body));
}

module.exports = { read, readFile, readText, write };

function readText(file) {
  const storage = path.join(path.dirname(file), 'sessions.sqlite');
  let metadata;

  try { metadata = fs.lstatSync(storage); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }

  if (!metadata.isFile()) throw new Error('Settings database is not a regular file');
  const row = database.connection(path.dirname(file)).prepare('SELECT body FROM application_settings WHERE name=?').get(path.basename(file));

  return row?.body == null ? undefined : Buffer.from(row.body).toString('utf8');
}
