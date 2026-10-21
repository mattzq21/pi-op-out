const database = require('../session-database.cjs');
const { randomUUID, createHash } = require('node:crypto');

const capSessionName = name => Array.from(name.trim()).slice(0, 30).join('').trimEnd();

const currentTypes = new Set(['pi-desktop-pause-state', 'pi-define-agents-state', 'piop-fast-mode-state', 'piop-context-cap', 'piop-session-cost-limit', 'piop-openai-cache-fork', 'piop-codemode-abilities', 'piop-input-hold']);
const nativeKeys = new Map([['session_info', 'piop-session-name'], ['model_change', 'piop-selected-model'], ['thinking_level_change', 'piop-thinking-level']]);
const stateKey = entry => nativeKeys.get(entry.type) ?? entry.customType;
const isCurrent = entry => nativeKeys.has(entry.type) || entry.type === 'custom' && currentTypes.has(entry.customType);

function validRecord(entry) {
  switch (entry.type) {
    case 'session_info': return typeof entry.name === 'string';
    case 'model_change': return typeof entry.provider === 'string' && typeof entry.modelId === 'string';
    case 'thinking_level_change': return typeof entry.thinkingLevel === 'string';
    default: return entry.type === 'custom' && !!entry.customType?.trim();
  }
}

function history(entries, current = isCurrent) {
  const settings = new Map(entries.filter(entry => current(entry) && typeof entry.id === 'string').map(entry => [entry.id, entry.parentId]));
  return entries.filter(entry => !current(entry)).map(entry => {
    let parentId = entry.parentId;
    const seen = new Set();
    while (settings.has(parentId)) {
      if (seen.has(parentId)) throw new Error('Cycle in session settings');
      seen.add(parentId);
      parentId = settings.get(parentId);
    }
    return parentId === entry.parentId ? entry : { ...entry, parentId };
  });
}

function stored(entries) { return history(entries).filter(entry => entry.type !== 'custom'); }

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

function capture(entries) {
  let after = null;
  const current = new Map(entries.filter(isCurrent).map(entry => [stateKey(entry), { after: null, entry: { ...entry, id: entry.id ?? randomUUID(), parentId: null } }]));
  const records = [...current.values()];
  for (const entry of history(entries).slice(1)) {
    if (entry.type === 'custom') records.push({ after, entry });
    else after = entry.id;
  }
  return records;
}

function seed(file, sessionId, records) {
  transaction(file, sessionId, db => {
    const insert = db.prepare('INSERT INTO session_extension_records (session_id, entry_id, after_id, entry_json) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, entry_id) DO NOTHING');
    const previous = db.prepare('SELECT after_id, entry_json FROM session_extension_records WHERE session_id=? AND entry_id=?');
    for (const { after, entry } of records) {
      if (typeof entry.id !== 'string' || !validRecord(entry)) throw new Error('Invalid session state record');
      if (isCurrent(entry)) { setCurrent(db, sessionId, entry); continue; }
      const json = JSON.stringify(entry);
      const saved = previous.get(sessionId, entry.id);
      if (saved && (saved.entry_json !== json || saved.after_id !== after)) throw new Error('Session state record identity was reused');
      insert.run(sessionId, entry.id, after, json);
    }
  });
}

function save(file, entries) {
  const header = entries[0];
  if (header?.type !== 'session') throw new Error('Session state requires its conversation header');
  seed(file, header.id, capture(entries));
}

function append(file, sessionId, after, entry) {
  if (!validRecord(entry)) throw new Error('Invalid session state record');
  transaction(file, sessionId, db => {
    if (isCurrent(entry)) { setCurrent(db, sessionId, entry); return; }
    db.prepare('INSERT INTO session_extension_records (session_id, entry_id, after_id, entry_json) VALUES (?, ?, ?, ?)').run(sessionId, entry.id, after, JSON.stringify(entry));
  });
}

function records(file, sessionId, connection) {
  const db = connection ?? database.open(database.storageRoot(file));
  try {
    const history = db.prepare('SELECT after_id, entry_json FROM session_extension_records WHERE session_id=? ORDER BY sequence').all(sessionId)
      .map(row => ({ after: row.after_id, entry: JSON.parse(row.entry_json) }));
    const current = db.prepare('SELECT entry_json FROM session_extension_state WHERE session_id=? ORDER BY state_key').all(sessionId)
      .map(row => ({ after: null, entry: JSON.parse(row.entry_json) }));
    return [...current, ...history];
  } finally { if (!connection) db.close(); }
}

function setCurrent(db, sessionId, entry) {
  const saved = { ...entry, parentId: null };
  if (saved.type === 'session_info') saved.name = capSessionName(saved.name);
  db.prepare(`INSERT INTO session_extension_state (session_id, state_key, entry_json) VALUES (?, ?, ?)
    ON CONFLICT(session_id, state_key) DO UPDATE SET entry_json=excluded.entry_json`).run(sessionId, stateKey(entry), JSON.stringify(saved));
}

function merge(file, entries, connection) {
  entries = history(entries, entry => nativeKeys.has(entry.type));
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

function selectBranch(file, sessionId, tipId, leafId) {
  transaction(file, sessionId, db => {
    db.prepare(`INSERT INTO session_branch_selection (session_id, tip_id, leaf_id) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET tip_id=excluded.tip_id, leaf_id=excluded.leaf_id`).run(sessionId, tipId, leafId);
  });
}

function selectedLeaf(file, sessionId, tipId) {
  const db = database.open(database.storageRoot(file));
  try {
    const row = db.prepare('SELECT tip_id, leaf_id FROM session_branch_selection WHERE session_id=?').get(sessionId);
    // A later entry supersedes the saved branch choice, including after an interrupted append.
    return row && row.tip_id === tipId ? row.leaf_id : tipId;
  } finally { db.close(); }
}

function revision(file, sessionId) {
  const db = database.open(database.storageRoot(file));
  try {
    const sequence = db.prepare('SELECT coalesce(max(sequence), 0) AS revision FROM session_extension_records WHERE session_id=?').get(sessionId).revision;
    const current = db.prepare('SELECT state_key, entry_json FROM session_extension_state WHERE session_id=? ORDER BY state_key').all(sessionId);
    const branch = db.prepare('SELECT tip_id, leaf_id FROM session_branch_selection WHERE session_id=?').get(sessionId);
    return sequence + ':' + createHash('sha256').update(JSON.stringify({ current, branch })).digest('hex');
  }
  finally { db.close(); }
}

function initializeSessionName(file, sessionId, name) {
  const entry = { type: 'session_info', id: randomUUID(), parentId: null, timestamp: new Date().toISOString(), name: capSessionName(name) };
  transaction(file, sessionId, db => {
    db.prepare('INSERT INTO session_extension_state (session_id, state_key, entry_json) VALUES (?, ?, ?) ON CONFLICT(session_id, state_key) DO NOTHING')
      .run(sessionId, stateKey(entry), JSON.stringify(entry));
  });
}

function sessionName(file, sessionId, connection) {
  const db = connection ?? database.open(database.storageRoot(file));
  try {
    const row = db.prepare("SELECT entry_json FROM session_extension_state WHERE session_id=? AND state_key='piop-session-name'").get(sessionId);
    return row ? capSessionName(JSON.parse(row.entry_json).name) || undefined : undefined;
  } finally { if (!connection) db.close(); }
}

function create(type, data, parentId) {
  return { type: 'custom', customType: type, data: structuredClone(data), id: randomUUID(), parentId, timestamp: new Date().toISOString() };
}

function isAuxiliary(entries) {
  return entries.some(entry => entry?.type === 'custom' && ['piop-subagent-parent', 'piop-review-parent'].includes(entry.customType));
}

function canFork(entries) { return !isAuxiliary(entries); }

module.exports = { capSessionName, isAuxiliary, canFork, selectBranch, selectedLeaf, stateKey, initializeSessionName, sessionName, isCurrent, history, stored, save, seed, capture, append, records, merge, revision, create };
