import * as database from '../session-database.ts';
import { onMainThread } from '../main-thread.ts';
import * as names from '../session-broker/session-names.ts';
import { randomUUID, createHash } from 'node:crypto';

interface StateRecord { after: string | null; entry: { type: string; id: string; customType?: string; [key: string]: unknown } }

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
  const root = database.storageRoot(file);
  return database.transaction(root, 'IMMEDIATE', () => {
    database.register(root, sessionId, file);
    return operation(root);
  });
}

function capture(entries): StateRecord[] {
  let after = null;
  const current = new Map<string, StateRecord>(entries.filter(isCurrent).map(entry => [stateKey(entry), { after: null, entry: { ...entry, id: entry.id ?? randomUUID(), parentId: null } }]));
  const records = [...current.values()];
  for (const entry of history(entries).slice(1)) {
    if (entry.type === 'custom') records.push({ after, entry });
    else after = entry.id;
  }
  return records;
}

const seed = onMainThread('session-records.seed', (file: string, sessionId: string, records: StateRecord[]): void => {
  transaction(file, sessionId, root => {
    for (const { after, entry } of records) {
      if (typeof entry.id !== 'string' || !validRecord(entry)) throw new Error('Invalid session state record');
      if (isCurrent(entry)) { setCurrent(root, sessionId, entry); continue; }
      const json = JSON.stringify(entry);
      const saved = database.sessionStateRecord(root, sessionId, entry.id);
      if (saved && (saved.entry_json !== json || saved.after_id !== after)) throw new Error('Session state record identity was reused');
      database.seedSessionStateRecord(root, sessionId, entry.id, after, json);
    }
  });
});

function save(file, entries) {
  const header = entries[0];
  if (header?.type !== 'session') throw new Error('Session state requires its conversation header');
  seed(file, header.id, capture(entries));
}

const append = onMainThread('session-records.append', (file: string, sessionId: string, after: string | null, entry: StateRecord['entry']) => {
  if (!validRecord(entry)) throw new Error('Invalid session state record');
  transaction(file, sessionId, root => {
    if (isCurrent(entry)) { setCurrent(root, sessionId, entry); return; }
    database.appendSessionStateRecord(root, sessionId, entry.id, after, JSON.stringify(entry));
  });
});

function records(file, sessionId) {
  const root = database.storageRoot(file);
  const history = database.sessionStateRecords(root, sessionId).map(row => ({ after: row.after_id, entry: JSON.parse(row.entry_json) }));
  const current = database.currentSessionStates(root, sessionId).map(row => ({ after: null, entry: JSON.parse(row.entry_json) }));
  return [...current, ...history];
}

function setCurrent(root, sessionId, entry) {
  database.saveCurrentSessionState(root, sessionId, stateKey(entry), JSON.stringify({ ...entry, parentId: null }));
}

function merge(file, entries) {
  entries = history(entries, entry => nativeKeys.has(entry.type) || isName(entry));
  const header = entries[0];
  if (header?.type !== 'session') throw new Error('Session state requires its conversation header');
  const known = new Set(entries.map(entry => entry.id));
  const groups = new Map();
  for (const record of records(file, header.id)) {
    if (known.has(record.entry.id)) continue;
    if (record.after !== null && !known.has(record.after)) continue;
    const group = groups.get(record.after) ?? [];
    group.push(record.entry);
    groups.set(record.after, group);
  }
  return [header, ...(groups.get(null) ?? []), ...entries.slice(1).flatMap(entry => [entry, ...(groups.get(entry.id) ?? [])])];
}

const selectBranch = onMainThread('session-records.selectBranch', (file: string, sessionId: string, tipId: string | null, leafId: string | null): void => {
  transaction(file, sessionId, root => database.saveBranchSelection(root, sessionId, tipId, leafId));
});

function selectedLeaf(file, sessionId, tipId) {
  const row = database.branchSelection(database.storageRoot(file), sessionId);
  return row && row.tip_id === tipId ? row.leaf_id : tipId;
}

function revision(file, sessionId) {
  const root = database.storageRoot(file);
  const sequence = database.sessionStateSequence(root, sessionId);
  const current = database.currentSessionStates(root, sessionId);
  const branch = database.branchSelection(root, sessionId);
  const name = names.sessionName(file, sessionId);
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

export { AUXILIARY_PARENT, AUXILIARY_LINK, isAuxiliaryParent, auxiliaryParent, isAuxiliary, canFork, forkPoint, selectBranch, selectedLeaf, stateKey, isCurrent, isName, history, stored, save, seed, capture, append, records, merge, revision, create };
