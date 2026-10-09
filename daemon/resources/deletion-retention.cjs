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

function retainActiveGoals(root, goals, retained) {
  let pending = false;

  for (const directory of goals) {
    const managed = ['owners.json', 'prepared.json'].some(name => metadata(path.join(directory, name)))
      || require('./session-broker/goal-dependencies.cjs').read(root, directory) !== undefined;

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
  const records = require('./external-transcripts.cjs');

  for (const row of records.list(root)) {
    let file;

    try { file = records.transcript(row); }
    catch { inventory.uncertain = true; continue; }

    const info = metadata(file);

    if (!info) { records.remove(root, row); continue; }

    if (!info.isFile()) { inventory.uncertain = true; continue; }

    inventory.transcripts.push(file);
  }
}

function forkReferences(root, inventory) {
  const groups = [
    ['fork-transactions', require('./fork-transaction-records.cjs').list(root)],
    ['fork-preparations', require('./fork-preparation-records.cjs').list(root)],
  ];

  for (const [area, directories] of groups) for (const directory of directories) {
    if (path.dirname(directory) !== path.join(root, area)) throw new Error('Invalid registered fork directory');
    const info = metadata(directory);

    if (!info) continue;

    if (!info.isDirectory() || fs.realpathSync(directory) !== directory) { inventory.uncertain = true; continue; }

    sessionFiles(directory, inventory);
  }
}

function worktreeContainers(root) {
  const storage = path.join(root, 'worktrees');

  return require('./session-database.cjs').worktreeContainers(root).filter(directory => {
    if (path.dirname(directory) !== storage || !/^[a-f0-9]{4}$/.test(path.basename(directory))) throw new Error('Invalid registered worktree directory');
    const info = metadata(directory);

    return Boolean(info?.isDirectory() && containerContents(directory));
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
  for (const row of require('./session-database.cjs').queuedInputs(root)) {
    const file = path.join(root, 'queued-input', `${row.session_id}.json`);

    if (excluded.has(file)) continue;
    let value;

    try { value = JSON.parse(row.record_json); }
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

  try { receipt = require('./restore-records.cjs').read(file)?.value; }
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
  return require('./restore-records.cjs').list(root, true).filter(file => !validReceipt(file, excluded));
}

function discardReceipt(file) {
  if (path.basename(path.dirname(file)) === 'restore-receipts') return require('./restore-records.cjs').remove(file);

  fs.unlinkSync(file);
  const directory = fs.openSync(path.dirname(file), 'r');

  try { fs.fsyncSync(directory); }
  finally { fs.closeSync(directory); }
}

function pruneReceipts(root) {
  for (const file of invalidReceipts(root, new Set())) discardReceipt(file);
}

function recoveryPending(root) {
  return require('./restore-records.cjs').list(root).length > 0
    || require('./legacy-archive-records.cjs').list(root).length > 0
    || require('./deletion-records.cjs').list(root).length > 0
    || require('./legacy-deletion-records.cjs').list(root).length > 0;
}

function collectRetention(root, sources, savedFiles, deferred = { directories: [], sessionIds: [] }, unpublishedGoals = false) {
  const inventory = { goals: new Set(), transcripts: [], sessionIds: new Set(), uncertain: recoveryPending(root) };

  for (const area of ['sessions', 'archived']) sessionFiles(path.join(root, area), inventory);
  forkReferences(root, inventory);
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
  const pendingGoals = retainActiveGoals(root, inventory.goals, retained);
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
    require('./session-database.cjs').initialize(db);
    db.exec('BEGIN IMMEDIATE');
    const completed = removeRegistryRows(db, sessionIds);
    db.exec('COMMIT');

    return completed;
  } finally { db.close(); }
}

function removeRegistryRows(db, sessionIds) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_repositories'").get()) return [...sessionIds];
  const remove = db.prepare('DELETE FROM sessions WHERE lower(session_id) = ?');
  const read = db.prepare('SELECT session_id, session_path FROM sessions WHERE lower(session_id) = ?');
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
