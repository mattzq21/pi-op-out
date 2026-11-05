const stateRecords = require('./piop-storage/session-records.cjs');
const fs = require('node:fs');
const database = require('./session-database.cjs');
const { onMainThread } = require('./main-thread.cjs');

// The last saved summary of each transcript that this process saved, by path.
const cache = new Map();

function fingerprint(info) {
  if (!info.isFile()) throw new Error('Transcript reference source is not a regular file');

  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

// The summary of a transcript is its header.
function summarize(entries) {
  return JSON.parse(JSON.stringify(entries.slice(0, 1)));
}

function save(db, file, stamp, entries) {
  db.prepare('INSERT INTO transcript_references VALUES (?, ?, ?, ?, 2) ON CONFLICT(session_path) DO UPDATE SET session_id=excluded.session_id, fingerprint=excluded.fingerprint, entries_json=excluded.entries_json, format_version=2')
    .run(file, entries[0]?.id?.constructor === String ? entries[0].id.toLowerCase() : null, stamp, JSON.stringify(entries));
}

function appendSaved(db, file, previous, stamp) {
  if (!previous) return false;

  return Boolean(db.prepare('UPDATE transcript_references SET fingerprint=? WHERE session_path=? AND fingerprint=? AND format_version=2').run(stamp, file, previous).changes);
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

function publishReceipts(db, file, stamp, previous, id, entries, entry) {
  const fingerprint = receiptFingerprint(stamp);
  const addition = delivery(entry, id);

  if (previous && appendReceipts(db, file, id, receiptFingerprint(previous), fingerprint, addition)) return;
  const saved = new Map();

  for (const current of entries()) {
    const receipt = delivery(current, id);

    if (receipt) saved.set(...receipt);
  }

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

function savedEntries(db, file) {
  return stateRecords.merge(file, fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line)), db);
}

// Saves the summary of the whole transcript, which has just been saved.
const publish = onMainThread('transcript-references.publish', (root, file, entries) => {
  root = fs.realpathSync(root);
  const record = summarize(entries);
  const stamp = fingerprint(fs.lstatSync(file, { bigint: true }));
  const db = database.connection(root);

  database.transaction(db, 'IMMEDIATE', () => {
    save(db, file, stamp, record);
    publishReceipts(db, file, stamp, undefined, entries[0]?.id, () => entries);
  });

  cache.set(file, { root, record, stamp });
});

// Adds one entry that has just been saved. `before` is the transcript file as it was before that.
const append = onMainThread('transcript-references.append', (root, file, entry, before) => {
  root = fs.realpathSync(root);
  const previous = cache.get(file);
  const stamp = fingerprint(fs.lstatSync(file, { bigint: true }));
  const db = database.connection(root);

  if (previous?.root !== root || previous.stamp !== fingerprint(before)) {
    const entries = savedEntries(db, file);
    const record = summarize(entries);

    database.transaction(db, 'IMMEDIATE', () => {
      save(db, file, stamp, record);
      publishReceipts(db, file, stamp, undefined, entries[0]?.id, () => entries);
    });
    cache.set(file, { root, record, stamp });

    return;
  }
  const record = previous.record;
  const id = previous.record[0]?.id;

  database.transaction(db, 'IMMEDIATE', () => {
    if (!appendSaved(db, file, previous.stamp, stamp)) save(db, file, stamp, record);
    publishReceipts(db, file, stamp, previous.stamp, id, () => savedEntries(db, file), entry);
  });

  cache.set(file, { root, record, stamp });
});

function read(root, file, connection) {
  root = fs.realpathSync(root);

  if (fs.realpathSync(file) !== file) throw new Error('Transcript reference source has ambiguous ownership');
  const before = fingerprint(fs.lstatSync(file, { bigint: true }));
  const db = connection ?? database.connection(root);
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
  const saved = summarize(stateRecords.merge(file, entries, db));
  saveSummary(root, file, before, saved);

  return saved;
}

const saveSummary = onMainThread('transcript-references.saveSummary', (root, file, stamp, entries) => save(database.connection(root), file, stamp, entries));

function removeDirectory(db, directory) {
  const prefix = directory + require('node:path').sep;

  for (const table of ['transcript_references', 'storage_transcript_summaries']) {
    db.prepare(`DELETE FROM ${table} WHERE substr(session_path, 1, length(?))=?`).run(prefix, prefix);
  }
}

module.exports = { read, publish, append, removeDirectory };
