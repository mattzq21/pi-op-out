const database = require('../session-database.cjs');
const { onMainThread } = require('../main-thread.cjs');
const names = require('../session-broker/session-names.cjs');
const { randomUUID, createHash } = require('node:crypto');

const coreTypes = ['pi-define-agents-state', 'piop-fast-mode-state', 'piop-context-cap', 'piop-openai-cache-fork', 'piop-codemode-abilities', 'piop-input-hold', 'piop-fork-retries', 'piop-skill-mcp'];
// The daemon adds the state records of its plugins to the environment of each process.
let pluginTypes;
let currentTypes = new Set(coreTypes);
function isCurrentType(type) {
  const listed = process.env.PIOP_PLUGIN_STATE_RECORDS;
  if (listed !== pluginTypes) {
    currentTypes = new Set([...coreTypes, ...(listed ? JSON.parse(listed) : [])]);
    pluginTypes = listed;
  }
  return currentTypes.has(type);
}
const nativeKeys = new Map([['model_change', 'piop-selected-model'], ['thinking_level_change', 'piop-thinking-level']]);
const stateKey = entry => nativeKeys.get(entry.type) ?? entry.customType;
const isCurrent = entry => nativeKeys.has(entry.type) || entry.type === 'custom' && isCurrentType(entry.customType);
const isName = entry => entry?.type === 'session_info';
const isSetting = entry => isCurrent(entry) || isName(entry);

function validRecord(entry) {
  switch (entry.type) {
    case 'model_change': return typeof entry.provider === 'string' && typeof entry.modelId === 'string';
    case 'thinking_level_change': return typeof entry.thinkingLevel === 'string';
    default: return entry.type === 'custom' && !!entry.customType?.trim();
  }
}

function history(entries, current = isSetting) {
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
  const db = database.connection(database.storageRoot(file));
  return database.transaction(db, 'IMMEDIATE', () => {
    database.register(db, sessionId, file);
    return operation(db);
  });
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

const seed = onMainThread('session-records.seed', (file, sessionId, records) => {
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
});

function save(file, entries) {
  const header = entries[0];
  if (header?.type !== 'session') throw new Error('Session state requires its conversation header');
  seed(file, header.id, capture(entries));
}

const append = onMainThread('session-records.append', (file, sessionId, after, entry) => {
  if (!validRecord(entry)) throw new Error('Invalid session state record');
  transaction(file, sessionId, db => {
    if (isCurrent(entry)) { setCurrent(db, sessionId, entry); return; }
    db.prepare('INSERT INTO session_extension_records (session_id, entry_id, after_id, entry_json) VALUES (?, ?, ?, ?)').run(sessionId, entry.id, after, JSON.stringify(entry));
  });
});

function records(file, sessionId, connection) {
  const db = connection ?? database.connection(database.storageRoot(file));
  const history = db.prepare('SELECT after_id, entry_json FROM session_extension_records WHERE session_id=? ORDER BY sequence').all(sessionId)
    .map(row => ({ after: row.after_id, entry: JSON.parse(row.entry_json) }));
  const current = db.prepare('SELECT entry_json FROM session_extension_state WHERE session_id=? ORDER BY state_key').all(sessionId)
    .map(row => ({ after: null, entry: JSON.parse(row.entry_json) }));
  return [...current, ...history];
}

function setCurrent(db, sessionId, entry) {
  const saved = { ...entry, parentId: null };
  db.prepare(`INSERT INTO session_extension_state (session_id, state_key, entry_json) VALUES (?, ?, ?)
    ON CONFLICT(session_id, state_key) DO UPDATE SET entry_json=excluded.entry_json`).run(sessionId, stateKey(entry), JSON.stringify(saved));
}

function merge(file, entries, connection) {
  entries = history(entries, entry => nativeKeys.has(entry.type) || isName(entry));
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

const selectBranch = onMainThread('session-records.selectBranch', (file, sessionId, tipId, leafId) => {
  transaction(file, sessionId, db => {
    db.prepare(`INSERT INTO session_branch_selection (session_id, tip_id, leaf_id) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET tip_id=excluded.tip_id, leaf_id=excluded.leaf_id`).run(sessionId, tipId, leafId);
  });
});

function selectedLeaf(file, sessionId, tipId) {
  const row = database.connection(database.storageRoot(file)).prepare('SELECT tip_id, leaf_id FROM session_branch_selection WHERE session_id=?').get(sessionId);
  return row && row.tip_id === tipId ? row.leaf_id : tipId;
}

function revision(file, sessionId) {
  const db = database.connection(database.storageRoot(file));
  const sequence = db.prepare('SELECT coalesce(max(sequence), 0) AS revision FROM session_extension_records WHERE session_id=?').get(sessionId).revision;
  const current = db.prepare('SELECT state_key, entry_json FROM session_extension_state WHERE session_id=? ORDER BY state_key').all(sessionId);
  const branch = db.prepare('SELECT tip_id, leaf_id FROM session_branch_selection WHERE session_id=?').get(sessionId);
  const name = names.nameOf(db, sessionId);
  return sequence + ':' + createHash('sha256').update(JSON.stringify({ current, branch, name })).digest('hex');
}

function create(type, data, parentId) {
  return { type: 'custom', customType: type, data: structuredClone(data), id: randomUUID(), parentId, timestamp: new Date().toISOString() };
}

const AUXILIARY_PARENT = 'piop-auxiliary-parent';

// In a parent transcript: where one of its auxiliary chats is saved.
const AUXILIARY_LINK = 'piop-auxiliary-link';

const isAuxiliaryParent = entry => entry?.type === 'custom' && entry.customType === AUXILIARY_PARENT && typeof entry.data?.kind === 'string' && typeof entry.data?.parentSessionId === 'string';

function isAuxiliary(entries) {
  return entries.some(isAuxiliaryParent);
}

function auxiliaryParent(entries, sessionId) {
  return entries.findLast(entry => isAuxiliaryParent(entry) && (sessionId === undefined || entry.data.sessionId === sessionId))?.data;
}

function canFork(entries) { return !isAuxiliary(entries); }

function forkPoint(entry) {
  if (entry?.type === 'compaction') return true;
  return entry?.type === 'message' && entry.message?.role === 'assistant' && ['stop', 'aborted'].includes(entry.message.stopReason)
    && Array.isArray(entry.message.content) && !entry.message.content.some(part => part?.type === 'toolCall');
}

module.exports = { AUXILIARY_PARENT, AUXILIARY_LINK, isAuxiliaryParent, auxiliaryParent, isAuxiliary, canFork, forkPoint, selectBranch, selectedLeaf, stateKey, isCurrent, isName, history, stored, save, seed, capture, append, records, merge, revision, create };
