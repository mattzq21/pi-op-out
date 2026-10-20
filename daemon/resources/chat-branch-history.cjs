const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const io = require('./piop-storage/session-publication-io.cjs');
const publication = require('./piop-storage/session-publication.cjs');
const stateRecords = require('./piop-storage/session-records.cjs');
const assets = require('./piop-storage/goal-assets.cjs');
const goalOwnership = require('./piop-storage/goal-ownership.cjs');
const database = require('./session-database.cjs');
const { acquireReferencePublicationLock } = require('./piop-storage/reference-publication-lock.cjs');

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function message(error) { return error instanceof Error ? error.message : String(error); }

function requireUuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid ' + label);
}

function requirePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) throw new Error('Invalid ' + label);
}

function storageRoot(root, sessionPath) {
  requirePath(root, 'storage root');
  const canonical = fs.realpathSync(root);
  if (io.rootForTarget(sessionPath) !== canonical) throw new Error('The conversation is outside this storage root');
  return canonical;
}

function finalResponse(entry) {
  return entry?.type === 'message' && entry.message?.role === 'assistant' && entry.message.stopReason === 'stop'
    && Array.isArray(entry.message.content) && !entry.message.content.some(part => part?.type === 'toolCall');
}

/** Entries from the first entry through entryId on the branch that ends at leafId, without current-state entries. */
function selectHistory(entries, leafId, entryId) {
  if (!stateRecords.canFork(entries)) throw new Error("Only main chats can be forked");
  const byId = new Map(entries.filter(entry => entry?.type !== 'session' && typeof entry?.id === 'string').map(entry => [entry.id, entry]));
  const selected = byId.get(entryId);
  if (!selected) throw new Error('The selected response is no longer in this conversation');
  if (!finalResponse(selected)) throw new Error('Select a finished final response to branch from');
  const path = [];
  const seen = new Set();
  for (let id = leafId; id; id = byId.get(id)?.parentId) {
    if (seen.has(id)) throw new Error('The conversation history has a cycle');
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) throw new Error('The conversation history is incomplete');
    path.push(entry);
  }
  path.reverse();
  const end = path.findIndex(entry => entry.id === entryId);
  if (end < 0) throw new Error('The selected response is not on the current branch');
  let parentId = null;
  return path.slice(0, end + 1).filter(entry => !stateRecords.isCurrent(entry)).map(entry => {
    const copy = { ...structuredClone(entry), parentId };
    parentId = entry.id;
    return copy;
  });
}

function currentState(entries) {
  const current = new Map();
  for (const entry of entries) if (entry?.type !== 'session' && stateRecords.isCurrent(entry)) current.set(stateRecords.stateKey(entry), { ...structuredClone(entry), parentId: null });
  return current;
}

function userText(history) {
  const entry = history.find(item => item.type === 'message' && item.message?.role === 'user');
  const content = entry?.message.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join(' ') : '';
  const line = text.trim().split('\n')[0].trim();
  return line ? line.slice(0, 80) : undefined;
}

function branchName(name, current, history) {
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Invalid branch name');
    return name.trim();
  }
  const source = current.get('piop-session-name')?.name?.trim() || userText(history) || 'Chat';
  return source + ' (branch)';
}

function withReferences(root) {
  return async operation => {
    const release = acquireReferencePublicationLock(root, true);
    try { return await operation(); } finally { release(); }
  };
}

/**
 * Publishes a new conversation with the history of sourcePath through the finished final response entryId,
 * the current settings of the source, and a fork source link. On failure it removes everything it created.
 */
async function publishBranchHistory(request) {
  const { sourcePath, sessionId, entries, leafId, entryId } = request ?? {};
  requirePath(sourcePath, 'source conversation path');
  requireUuid(sessionId, 'branch identity');
  requirePath(request.cwd, 'branch folder');
  if (!Array.isArray(entries) || typeof leafId !== 'string' || typeof entryId !== 'string') throw new Error('Invalid branch history request');
  const root = storageRoot(request.root, sourcePath);
  const source = io.header(sourcePath);
  if (!source) throw new Error('The source conversation has no saved identity');
  if (source.id === sessionId) throw new Error('The branch identity is already in use');
  const history = selectHistory(entries, leafId, entryId);
  const current = currentState(entries);
  const timestamp = new Date().toISOString();
  current.set('piop-session-name', { type: 'session_info', id: randomUUID(), parentId: null, timestamp, name: branchName(request.name, current, history) });
  // The branch stays idle until the user sends a message (core input hold).
  current.set('piop-input-hold', { type: 'custom', customType: 'piop-input-hold', data: { held: true }, id: randomUUID(), parentId: null, timestamp });
  const cwd = fs.realpathSync(request.cwd);
  const sessionPath = path.join(path.dirname(sourcePath), timestamp.replace(/[:.]/g, '-') + '_' + sessionId + '.jsonl');
  const forkSource = { sessionId: source.id, sessionPath: sourcePath, entryId };
  const header = { type: 'session', version: source.version, id: sessionId, timestamp, cwd, parentSession: sourcePath, piopForkSource: forkSource };
  const body = [header, ...history, ...current.values()].map(entry => JSON.stringify(entry)).join('\n') + '\n';
  try {
    const published = await publication.publish(sessionPath, body, withReferences(root), { goalSource: sourcePath, dependencies: { workspace: { path: cwd, kind: 'existing' } } });
    // A warning means the transcript exists but saving it did not fully finish. The branch is not usable then.
    if (published.warnings.length) throw new Error(published.warnings.join('; '));
  } catch (error) {
    try { await discardBranchHistory(root, sessionId, sessionPath); }
    catch (cleanup) { throw new Error('Could not create the branch: ' + message(error) + '\nCleanup failed: ' + message(cleanup), { cause: error }); }
    throw new Error('Could not create the branch: ' + message(error), { cause: error });
  }
  return { sessionPath, forkSource };
}

function ownedTranscript(file, sessionId) {
  const header = io.header(file);
  if (!header || header.id !== sessionId || !header.piopForkSource) throw new Error('Refusing to remove a conversation that is not this branch: ' + file);
}

function journals(root, sessionId) {
  return database.publications(root).map(id => database.publication(root, id)).filter(journal => journal?.sessionId === sessionId);
}

function registeredPath(root, sessionId) {
  const db = database.open(root);
  try { return db.prepare('SELECT session_path FROM sessions WHERE session_id=?').get(sessionId); }
  finally { db.close(); }
}

function removeFile(file) {
  fs.unlinkSync(file);
  io.sync(path.dirname(file));
}

function removeJournal(root, journal, target) {
  if (journal.target !== target) throw new Error('Publication of this branch has another path: ' + journal.target);
  const owned = file => journal.temporaryIdentity !== undefined && io.matches(file, journal.temporaryIdentity);
  if (io.exists(journal.temporary)) {
    if (!owned(journal.temporary)) throw new Error('Unowned temporary transcript retained: ' + journal.temporary);
    removeFile(journal.temporary);
  }
  const quarantine = path.join(root, 'session-publication-quarantine', journal.id);
  const part = path.join(quarantine, 'transcript.jsonl.part');
  if (io.exists(part)) {
    if (!owned(part)) throw new Error('Unowned quarantined transcript retained: ' + part);
    removeFile(part);
  }
  if (io.exists(quarantine)) { fs.rmdirSync(quarantine); io.sync(path.dirname(quarantine)); }
  database.removePublication(root, journal.id);
}

function removeWriterLock(root, target) {
  const file = io.lockPath(root, target);
  if (!io.exists(file)) return;
  const lease = io.claim(file);
  if (lease === null) throw new Error('Another writer still owns this branch: ' + file);
  try { removeFile(file); } finally { fs.closeSync(lease); }
}

function releaseClaims(root, sessionId) {
  assets.locked(root, () => {
    for (const directory of assets.ownedDirectories(root, sessionId)) {
      const record = assets.readOwners(root, directory);
      goalOwnership.save(root, directory, { ...record, owners: record.owners.filter(owner => owner.sessionId !== sessionId) });
    }
  });
}

function forget(root, sessionId, target) {
  const row = registeredPath(root, sessionId);
  if (!row) return;
  if (row.session_path === null) {
    const db = database.open(root);
    try { db.prepare('DELETE FROM sessions WHERE session_id=? AND session_path IS NULL').run(sessionId); }
    finally { db.close(); }
    return;
  }
  if (row.session_path !== target) throw new Error('This branch identity belongs to another conversation: ' + row.session_path);
  require('./registry-deletion.cjs').forget(root, [{ sessionId, path: target }]);
}

/**
 * Removes the transcript, publication records, attachment claims and registry entries of the branch sessionId.
 * sessionPath may be null when the caller did not learn it. Things already gone count as removed.
 */
async function discardBranchHistory(root, sessionId, sessionPath) {
  requireUuid(sessionId, 'branch identity');
  if (sessionPath !== null) {
    requirePath(sessionPath, 'branch path');
    if (!path.basename(sessionPath).endsWith('_' + sessionId + '.jsonl')) throw new Error('The branch path does not bind its identity');
  }
  requirePath(root, 'storage root');
  root = fs.realpathSync(root);
  await io.lockedAsync(root, () => {
    const release = acquireReferencePublicationLock(root, true);
    try {
      const pending = journals(root, sessionId);
      const target = sessionPath ?? pending[0]?.target ?? registeredPath(root, sessionId)?.session_path ?? null;
      if (target !== null && !io.inside(path.join(root, 'sessions'), target)) throw new Error('The branch is outside active conversation storage');
      const failures = [];
      const step = operation => { try { operation(); } catch (error) { failures.push(message(error)); } };
      if (target !== null) step(() => { if (io.exists(target)) { ownedTranscript(target, sessionId); removeFile(target); } });
      for (const journal of pending) step(() => removeJournal(root, journal, target));
      if (target !== null) step(() => removeWriterLock(root, target));
      step(() => releaseClaims(root, sessionId));
      if (!failures.length) step(() => forget(root, sessionId, target));
      if (failures.length) throw new Error('Branch cleanup is incomplete: ' + failures.join('; '));
    } finally { release(); }
  });
}

module.exports = { publishBranchHistory, discardBranchHistory };

