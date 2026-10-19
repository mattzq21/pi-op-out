const database = require('../session-database.cjs');
const { randomUUID } = require('node:crypto');

function stored(entries) { return entries.filter(entry => entry.type !== 'custom'); }

function transaction(file, sessionId, operation) {
  const db = database.open(database.storageRoot(file));
  try {
    db.exec('BEGIN IMMEDIATE');
    database.register(db, sessionId, file);
    const result = operation(db);
    db.exec('COMMIT');
    return result;
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

function save(file, entries) {
  const header = entries[0];
  if (header?.type !== 'session') throw new Error('Session state requires its conversation header');
  transaction(file, header.id, db => {
    let after = null;
    const insert = db.prepare('INSERT INTO session_extension_records (session_id, entry_id, after_id, entry_json) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, entry_id) DO NOTHING');
    const previous = db.prepare('SELECT entry_json FROM session_extension_records WHERE session_id=? AND entry_id=?');
    for (const entry of entries.slice(1)) {
      if (entry.type !== 'custom') { after = entry.id; continue; }
      const json = JSON.stringify(entry);
      const saved = previous.get(header.id, entry.id);
      if (saved && saved.entry_json !== json) throw new Error('Session state record identity was reused');
      insert.run(header.id, entry.id, after, json);
    }
  });
}

function append(file, sessionId, after, entry) {
  if (entry.type !== 'custom' || !entry.customType?.trim()) throw new Error('Invalid session state record');
  transaction(file, sessionId, db => {
    db.prepare('INSERT INTO session_extension_records (session_id, entry_id, after_id, entry_json) VALUES (?, ?, ?, ?)').run(sessionId, entry.id, after, JSON.stringify(entry));
  });
}

function records(file, sessionId, connection) {
  const db = connection ?? database.open(database.storageRoot(file));
  try {
    return db.prepare('SELECT after_id, entry_json FROM session_extension_records WHERE session_id=? ORDER BY sequence').all(sessionId)
      .map(row => ({ after: row.after_id, entry: JSON.parse(row.entry_json) }));
  } finally { if (!connection) db.close(); }
}

function merge(file, entries, connection) {
  const header = entries[0];
  if (header?.type !== 'session') throw new Error('Session state requires its conversation header');
  const known = new Set(entries.map(entry => entry.id));
  const groups = new Map();
  for (const record of records(file, header.id, connection)) {
    if (known.has(record.entry.id)) continue;
    if (record.after !== null && !known.has(record.after)) continue;
    const group = groups.get(record.after) ?? [];
    group.push(record.entry);
    groups.set(record.after, group);
  }
  return [header, ...(groups.get(null) ?? []), ...entries.slice(1).flatMap(entry => [entry, ...(groups.get(entry.id) ?? [])])];
}

function create(type, data, parentId) {
  return { type: 'custom', customType: type, data: structuredClone(data), id: randomUUID(), parentId, timestamp: new Date().toISOString() };
}

module.exports = { stored, save, append, records, merge, create };
