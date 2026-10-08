const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { validSessionHeader } = require('./checkpoint-schemas.cjs');
const { describeCandidates } = require('./retention-candidates.cjs');
const { containerContents } = require('./worktree-container.cjs');

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const restoredSessionSchema = Type.Object({ sessionId: Type.String(), sessionPath: Type.String() });

const receiptSchema = Type.Object({
  trace: Type.Object({ source: Type.String(), destination: Type.String(), identity: Type.String({ pattern: '^\\d+:\\d+$' }) }),
  result: Type.Object({ sessionId: Type.String(), sessions: Type.Optional(Type.Array(restoredSessionSchema)) }),
});

function metadata(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function entries(directory) {
  const info = metadata(directory);

  if (!info) return [];

  if (!info.isDirectory()) throw new Error(`Cannot inspect deletion references in ${directory}`);

  return fs.readdirSync(directory, { withFileTypes: true });
}

function goalDirectories(directory, goals) {
  for (const entry of entries(directory)) {
    if (entry.isDirectory() && /^goal-[A-Za-z0-9]{6}$/.test(entry.name)) goals.add(path.join(directory, entry.name));
  }
}

function activeGoalAllocation(directory) {
  const lock = path.join(directory, 'allocation.lock');

  if (!metadata(lock)) return false;
  const descriptor = fs.openSync(lock, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);

  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Invalid goal attachment ownership lock');
    const child = spawnSync('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'], { stdio: ['ignore', 'pipe', 'pipe', descriptor] });

    if (child.error) throw child.error;

    if (child.status === 75) return true;

    if (child.status !== 0) throw new Error(child.stderr.toString().trim() || 'Could not inspect goal attachment ownership');

    return false;
  } finally { fs.closeSync(descriptor); }
}

function retainActiveGoals(goals, retained) {
  let pending = false;

  for (const directory of goals) {
    const managed = ['owners.json', 'prepared.json', 'dependencies.json'].some(name => metadata(path.join(directory, name)));

    if (retained.has(directory)) continue;

    if (managed) { retained.add(directory); continue; }

    if (!activeGoalAllocation(directory)) continue;
    retained.add(directory);
    pending = true;
  }

  return pending;
}

function sessionFiles(directory, inventory) {
  for (const entry of entries(directory)) {
    const file = path.join(directory, entry.name);

    if (entry.isSymbolicLink()) { inventory.uncertain = true; continue; }

    if (entry.isDirectory()) {
      if (entry.name.endsWith('.snapshots') || entry.name.startsWith('.delete-')) continue;

      if (entry.name === 'attachments') goalDirectories(file, inventory.goals);
      else sessionFiles(file, inventory);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) inventory.transcripts.push(file);
  }
}

function externalTranscripts(root, inventory) {
  const directory = path.join(root, 'external-transcripts');

  for (const entry of entries(directory)) {
    if (!entry.name.endsWith('.json')) continue;
    const record = path.join(directory, entry.name);

    if (!entry.isFile()) { inventory.uncertain = true; continue; }

    const file = externalTranscript(record, inventory);

    if (!file) continue;
    const info = metadata(file);

    if (!info) { discardReceipt(record); continue; }

    if (!info.isFile()) { inventory.uncertain = true; continue; }

    inventory.transcripts.push(file);
  }
}

function externalTranscript(record, inventory) {
  let value;

  try { value = JSON.parse(fs.readFileSync(record, 'utf8')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    inventory.uncertain = true;

    return;
  }

  if (!Check(Type.Object({ path: Type.String() }), value) || !path.isAbsolute(value.path)
    || path.basename(record) !== createHash('sha256').update(value.path).digest('hex') + '.json') {
    inventory.uncertain = true;

    return;
  }

  return value.path;
}

function worktreeContainers(root) {
  return entries(path.join(root, 'worktrees')).flatMap(entry => {
    if (!entry.isDirectory() || !/^[a-f0-9]{4}$/.test(entry.name)) return [];
    const directory = path.join(root, 'worktrees', entry.name);

    return containerContents(directory) ? [directory] : [];
  });
}

function references(value, candidates, found) {
  const pending = [value];

  while (pending.length) {
    const current = pending.pop();

    if (Check(Type.String(), current)) {
      for (const candidate of candidates) if (current.includes(candidate)) found.add(candidate);
    } else if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
    }
    else if (Check(Type.Object({}), current)) {
      for (const [key, item] of Object.entries(current)) pending.push(key, item);
    }
  }
}

function transcriptReferences(content, candidates, found, inventory) {
  let header;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let value;

    try { value = JSON.parse(line); }
    catch { inventory.uncertain = true; continue; }

    if (!header) {
      header = value;

      if (validSessionHeader(header)) inventory.sessionIds.add(header.id.toLowerCase());
      else inventory.uncertain = true;
    }

    references(value, candidates, found);
  }

  if (!header) inventory.uncertain = true;
}

function survivingReferences(inventory, candidates, excluded) {
  const found = new Set();

  for (const file of inventory.transcripts) {
    if (excluded.has(file)) continue;
    const before = fs.lstatSync(file);
    transcriptReferences(fs.readFileSync(file, 'utf8'), candidates, found, inventory);
    const after = fs.lstatSync(file);

    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) inventory.uncertain = true;
  }

  return found;
}

function goalReferences(found, goals, candidates, inventory) {
  const visited = new Set();

  for (const directory of found) {
    if (!goals.has(directory) || visited.has(directory)) continue;
    visited.add(directory);

    for (const entry of entries(directory)) {
      if (!/\.(md|txt)$/.test(entry.name)) continue;

      if (!entry.isFile()) { inventory.uncertain = true; continue; }

      references(fs.readFileSync(path.join(directory, entry.name), 'utf8'), candidates, found);
    }
  }
}

function queuedReferences(root, excluded, candidates, found, inventory) {
  const directory = path.join(root, 'queued-input');

  for (const entry of entries(directory)) {
    const file = path.join(directory, entry.name);

    if (!entry.name.endsWith('.json') || excluded.has(file)) continue;

    if (!entry.isFile()) { inventory.uncertain = true; continue; }

    let value;

    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; inventory.uncertain = true; continue; }

    references(value, candidates, found);
  }
}

function survivingSession(file, id, excluded) {
  if (excluded.has(file)) return false;
  let info;

  try { info = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }

  if (!info.isFile()) return false;
  let header;

  try { header = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]); }
  catch (error) { if (error instanceof SyntaxError) return false; throw error; }

  return validSessionHeader(header) && header.id === id;
}

function validReceipt(file, excluded) {
  let receipt;

  try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) return false; throw error; }

  if (!Check(receiptSchema, receipt)) return false;
  const { trace, result } = receipt;

  if (path.basename(file) !== `${createHash('sha256').update(trace.source).digest('hex')}.json`) return false;

  if (!survivingSession(trace.destination, result.sessionId, excluded)) return false;
  const info = fs.lstatSync(trace.destination, { bigint: true });

  if (`${info.dev}:${info.ino}` !== trace.identity) return false;

  return (result.sessions ?? []).every(session => survivingSession(session.sessionPath, session.sessionId, excluded));
}

function invalidReceipts(root, excluded) {
  return entries(path.join(root, 'restore-receipts')).flatMap(entry => {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) return [];
    const file = path.join(root, 'restore-receipts', entry.name);

    return validReceipt(file, excluded) ? [] : [file];
  });
}

function discardReceipt(file) {
  fs.unlinkSync(file);
  const directory = fs.openSync(path.dirname(file), 'r');

  try { fs.fsyncSync(directory); }
  finally { fs.closeSync(directory); }
}

function pruneReceipts(root) {
  for (const file of invalidReceipts(root, new Set())) discardReceipt(file);
}

function recoveryPending(root) {
  return entries(root).some(entry => entry.isDirectory() && entry.name.startsWith('archive-transaction-'))
    || ['restore-transactions', 'deleted-sessions'].some(name => entries(path.join(root, name)).length);
}

function collectRetention(root, sources, savedFiles, deferred = { directories: [], sessionIds: [] }, unpublishedGoals = false) {
  const inventory = { goals: new Set(), transcripts: [], sessionIds: new Set(), uncertain: recoveryPending(root) };

  for (const area of ['sessions', 'archived', 'fork-transactions', 'fork-preparations']) sessionFiles(path.join(root, area), inventory);
  externalTranscripts(root, inventory);
  const candidates = new Set([...inventory.goals, ...worktreeContainers(root)]);
  const owned = new Set(deferred.directories.filter(file => candidates.has(file)));

  if (unpublishedGoals) for (const directory of inventory.goals) owned.add(directory);
  const ignored = { sessionIds: new Set(), uncertain: false };
  const deleted = savedFiles.filter(saved => saved.sessionId);

  for (const saved of deleted) transcriptReferences(saved.body.toString('utf8'), candidates, owned, ignored);
  goalReferences(owned, inventory.goals, candidates, inventory);
  const excluded = new Set([...sources, ...savedFiles.map(saved => saved.file)]);
  const retained = survivingReferences(inventory, candidates, excluded);
  retainPublications(root, candidates, retained, inventory);
  queuedReferences(root, excluded, candidates, retained, inventory);
  const pendingGoals = retainActiveGoals(inventory.goals, retained);
  goalReferences(retained, inventory.goals, candidates, inventory);
  const requestedIds = [...new Set([...deleted.map(saved => saved.sessionId), ...deferred.sessionIds])].filter(id => uuidPattern.test(id));

  return {
    uncertain: inventory.uncertain,
    pendingGoals,
    directories: inventory.uncertain ? [] : [...owned].filter(file => !retained.has(file)),
    files: invalidReceipts(root, excluded),
    registryIds: inventory.uncertain ? [] : requestedIds.filter(id => !inventory.sessionIds.has(id.toLowerCase())),
    deferred: describeCandidates([...owned], requestedIds),
  };
}

function retainPublications(root, candidates, retained, inventory) {
  const publications = require('./session-broker/session-publication.cjs').retainedDependencies(root);

  for (const publication of publications) {
    references(publication.dependencies, candidates, retained);

    for (const file of publication.transcriptPaths) transcriptReferences(fs.readFileSync(file, 'utf8'), candidates, retained, inventory);
  }
}

function cleanupRegistry(root, sessionIds) {
  if (!sessionIds.length) return [];
  const database = path.join(root, 'sessions.sqlite');
  const info = metadata(database);

  if (!info) return [...sessionIds];

  if (!info.isFile()) throw new Error('Invalid session repository registry');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(database);

  try {
    db.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');
    const completed = removeRegistryRows(db, sessionIds);
    db.exec('COMMIT');

    return completed;
  } finally { db.close(); }
}

function removeRegistryRows(db, sessionIds) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_repositories'").get()) return [...sessionIds];
  const remove = db.prepare('DELETE FROM session_repositories WHERE lower(session_id) = ?');
  const read = db.prepare('SELECT session_id, session_path FROM session_repositories WHERE lower(session_id) = ?');
  const completed = [];

  for (const id of sessionIds) {
    const record = read.get(id.toLowerCase());

    if (record?.session_path && survivingSession(record.session_path, record.session_id, new Set())) continue;
    remove.run(id.toLowerCase());
    completed.push(id);
  }

  return completed;
}

module.exports = { collectRetention, cleanupRegistry, validReceipt, discardReceipt, pruneReceipts };
