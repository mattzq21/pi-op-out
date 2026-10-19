const stateRecords = require('./piop-storage/session-records.cjs');
const fs = require('node:fs');
const database = require('./session-database.cjs');

const cache = new WeakMap();

function open(root) {
  const db = database.open(root);

  try {
    db.exec('BEGIN IMMEDIATE');
    initialize(db);
    db.exec('COMMIT');

    return db;
  } catch (error) { db.close(); throw error; }
}

function initialize(db) {
  db.exec('CREATE TABLE IF NOT EXISTS transcript_references (session_path TEXT PRIMARY KEY, session_id TEXT, fingerprint TEXT NOT NULL, entries_json TEXT NOT NULL, format_version INTEGER NOT NULL)');

  db.exec(`CREATE TRIGGER IF NOT EXISTS transcript_references_moved AFTER UPDATE OF session_path ON sessions
    WHEN OLD.session_path IS NOT NEW.session_path BEGIN
      DELETE FROM transcript_references WHERE session_path=OLD.session_path AND session_id=lower(OLD.session_id);
    END;
    CREATE TRIGGER IF NOT EXISTS transcript_references_deleted AFTER DELETE ON sessions BEGIN
      DELETE FROM transcript_references WHERE session_path=OLD.session_path AND session_id=lower(OLD.session_id);
    END;`);
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
  db.prepare('INSERT INTO transcript_references VALUES (?, ?, ?, ?, 2) ON CONFLICT(session_path) DO UPDATE SET session_id=excluded.session_id, fingerprint=excluded.fingerprint, entries_json=excluded.entries_json, format_version=2')
    .run(file, entries[0]?.id?.constructor === String ? entries[0].id.toLowerCase() : null, stamp, JSON.stringify(entries));
}

function appendSaved(db, file, previous, stamp, entry) {
  if (!previous) return false;

  if (entry) return Boolean(db.prepare("UPDATE transcript_references SET fingerprint=?, entries_json=json_insert(entries_json, '$[#]', json(?)) WHERE session_path=? AND fingerprint=? AND format_version=2")
    .run(stamp, JSON.stringify(entry), file, previous).changes);

  return Boolean(db.prepare('UPDATE transcript_references SET fingerprint=? WHERE session_path=? AND fingerprint=? AND format_version=2').run(stamp, file, previous).changes);
}

function previousAppend(root, file, entries, entry) {
  const previous = entry && cache.get(entries);

  return previous?.root === root && previous.file === file && previous.count === entries.length ? previous : undefined;
}

function messageDetails(entry) {
  if (entry?.type === 'custom_message') return entry.details;

  return entry?.type === 'message' ? entry.message?.details : undefined;
}

function delivery(entry, sessionId) {
  const details = messageDetails(entry);

  if (!details || details.mailboxSessionId !== sessionId) return;

  if (![details.notificationId, details.mailboxFingerprint].every(value => value?.constructor === String)) return;

  return [details.notificationId, details.mailboxFingerprint];
}

function receiptFingerprint(stamp) {
  const parts = stamp.split(':');

  return `${parts[3]}:${parts[2]}`;
}

function publishReceipts(db, file, stamp, previous, entries, entry) {
  db.exec(`CREATE TABLE IF NOT EXISTS session_mailbox_receipt_cache (
    session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
    session_path TEXT NOT NULL, fingerprint TEXT NOT NULL, deliveries_json TEXT NOT NULL)`);
  const id = entries[0]?.id;
  const fingerprint = receiptFingerprint(stamp);
  const addition = delivery(entry, id);

  if (previous && appendReceipts(db, file, id, receiptFingerprint(previous), fingerprint, addition)) return;
  const saved = new Map();

  for (const current of entries) {
    const receipt = delivery(current, id);

    if (receipt) saved.set(...receipt);
  }

  if (addition) saved.set(...addition);
  db.prepare(`INSERT INTO session_mailbox_receipt_cache
    SELECT session_id, session_path, ?, ? FROM sessions WHERE session_id=? AND session_path=?
    ON CONFLICT(session_id) DO UPDATE SET session_path=excluded.session_path,
      fingerprint=excluded.fingerprint, deliveries_json=excluded.deliveries_json`)
    .run(fingerprint, JSON.stringify([...saved]), id, file);
}

function appendReceipts(db, file, id, previous, fingerprint, addition) {
  const update = addition ? "json_insert(deliveries_json, '$[#]', json(?))" : 'deliveries_json';
  const values = addition ? [fingerprint, JSON.stringify(addition)] : [fingerprint];

  return Boolean(db.prepare(`UPDATE session_mailbox_receipt_cache SET fingerprint=?, deliveries_json=${update}
    WHERE session_id=? AND session_path=? AND fingerprint=?`).run(...values, id, file, previous).changes);
}

function publish(root, file, entries, entry) {
  root = fs.realpathSync(root);
  const previous = previousAppend(root, file, entries, entry);
  const record = previous?.record ?? summarize(entries, root);
  const addition = entry && relevant(entry, root) ? JSON.parse(JSON.stringify(entry)) : undefined;

  if (addition) record.push(addition);
  const stamp = fingerprint(fs.lstatSync(file, { bigint: true }));
  const db = open(root);

  try {
    db.exec('BEGIN IMMEDIATE');

    if (!appendSaved(db, file, previous?.stamp, stamp, addition)) save(db, file, stamp, record);
    publishReceipts(db, file, stamp, previous?.stamp, entries, entry);
    db.exec('COMMIT');
  } finally { db.close(); }

  cache.set(entries, { root, file, count: entries.length + (entry ? 1 : 0), record, stamp });
}

function read(root, file, connection) {
  root = fs.realpathSync(root);

  if (fs.realpathSync(file) !== file) throw new Error('Transcript reference source has ambiguous ownership');
  const before = fingerprint(fs.lstatSync(file, { bigint: true }));
  const db = connection ?? open(root);

  try {
    if (connection) initialize(db);
    const row = db.prepare('SELECT entries_json FROM transcript_references WHERE session_path=? AND fingerprint=? AND format_version=2').get(file, before);

    if (row) {
      if (fingerprint(fs.lstatSync(file, { bigint: true })) !== before) throw new Error('Transcript changed while reading saved references');

      return stateRecords.merge(file, JSON.parse(row.entries_json), db);
    }

    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let entries;

    try {
      if (fingerprint(fs.fstatSync(descriptor, { bigint: true })) !== before) throw new Error('Transcript changed during reference import');
      entries = fs.readFileSync(descriptor, 'utf8').split('\n').filter(line => line.trim()).map(JSON.parse);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }

    if (fingerprint(fs.lstatSync(file, { bigint: true })) !== before) throw new Error('Transcript changed during reference import');
    const saved = summarize(stateRecords.merge(file, entries, db), root);
    save(db, file, before, saved);

    return saved;
  } finally { if (!connection) db.close(); }
}

function removeDirectory(db, directory) {
  const prefix = directory + require('node:path').sep;

  for (const table of ['transcript_references', 'storage_transcript_summaries']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    db.prepare(`DELETE FROM ${table} WHERE substr(session_path, 1, length(?))=?`).run(prefix, prefix);
  }
}

module.exports = { read, publish, removeDirectory };
