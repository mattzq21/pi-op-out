const fs = require('node:fs');
const database = require('./session-database.cjs');

const cache = new WeakMap();

function open(root) {
  const db = database.open(root);

  try {
    db.exec('CREATE TABLE IF NOT EXISTS transcript_references (session_path TEXT PRIMARY KEY, session_id TEXT, fingerprint TEXT NOT NULL, entries_json TEXT NOT NULL)');

    return db;
  } catch (error) { db.close(); throw error; }
}

function fingerprint(info) {
  if (!info.isFile()) throw new Error('Transcript reference source is not a regular file');

  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

function relevant(entry, root) {
  return entry?.goalAssets !== undefined || JSON.stringify(entry)?.includes(JSON.stringify(root).slice(1, -1));
}

function summarize(entries, root) {
  return JSON.parse(JSON.stringify([entries[0], ...entries.slice(1).filter(entry => relevant(entry, root))]));
}

function save(db, file, stamp, entries) {
  db.prepare('INSERT INTO transcript_references VALUES (?, ?, ?, ?) ON CONFLICT(session_path) DO UPDATE SET session_id=excluded.session_id, fingerprint=excluded.fingerprint, entries_json=excluded.entries_json')
    .run(file, entries[0]?.id?.constructor === String ? entries[0].id.toLowerCase() : null, stamp, JSON.stringify(entries));
}

function publish(root, file, entries, entry) {
  root = fs.realpathSync(root);
  const previous = cache.get(entries);
  const record = entry && previous?.root === root && previous.file === file && previous.count === entries.length ? previous.record : summarize(entries, root);

  if (entry && relevant(entry, root)) record.push(JSON.parse(JSON.stringify(entry)));
  const db = open(root);

  try { save(db, file, fingerprint(fs.lstatSync(file, { bigint: true })), record); }
  finally { db.close(); }

  cache.set(entries, { root, file, count: entries.length + (entry ? 1 : 0), record });
}

function read(root, file) {
  root = fs.realpathSync(root);

  if (fs.realpathSync(file) !== file) throw new Error('Transcript reference source has ambiguous ownership');
  const before = fingerprint(fs.lstatSync(file, { bigint: true }));
  const db = open(root);

  try {
    const row = db.prepare('SELECT entries_json FROM transcript_references WHERE session_path=? AND fingerprint=?').get(file, before);

    if (row) {
      if (fingerprint(fs.lstatSync(file, { bigint: true })) !== before) throw new Error('Transcript changed while reading saved references');

      return JSON.parse(row.entries_json);
    }

    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let entries;

    try {
      if (fingerprint(fs.fstatSync(descriptor, { bigint: true })) !== before) throw new Error('Transcript changed during reference import');
      entries = fs.readFileSync(descriptor, 'utf8').split('\n').filter(line => line.trim()).map(JSON.parse);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }

    if (fingerprint(fs.lstatSync(file, { bigint: true })) !== before) throw new Error('Transcript changed during reference import');
    const saved = summarize(entries, root);
    save(db, file, before, saved);

    return saved;
  } finally { db.close(); }
}

module.exports = { read, publish };
