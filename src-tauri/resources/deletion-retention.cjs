const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { validSessionHeader } = require('./checkpoint-schemas.cjs');

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

function worktreeContainers(root) {
  return entries(path.join(root, 'worktrees')).flatMap(entry => {
    if (!entry.isDirectory() || !/^[a-f0-9]{4}$/.test(entry.name)) return [];
    const directory = path.join(root, 'worktrees', entry.name);
    const children = entries(directory);

    return children.every(child => child.name === 'parent.json' && child.isFile()) ? [directory] : [];
  });
}

function references(value, candidates, found) {
  const pending = [value];

  while (pending.length) {
    const current = pending.pop();

    if (Check(Type.String(), current)) {
      for (const candidate of candidates) if (current.includes(candidate)) found.add(candidate);
    } else if (Array.isArray(current)) pending.push(...current);
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

function recoveryPending(root) {
  return ['archive-transactions', 'restore-transactions', 'deleted-sessions'].some(name => entries(path.join(root, name)).length);
}

function collectRetention(root, sources, deleted) {
  const inventory = { goals: new Set(), transcripts: [], sessionIds: new Set(), uncertain: recoveryPending(root) };

  for (const area of ['sessions', 'archived', 'fork-transactions']) sessionFiles(path.join(root, area), inventory);
  const candidates = new Set([...inventory.goals, ...worktreeContainers(root)]);
  const owned = new Set();
  const ignored = { sessionIds: new Set(), uncertain: false };

  for (const saved of deleted) transcriptReferences(saved.body.toString('utf8'), candidates, owned, ignored);
  goalReferences(owned, inventory.goals, candidates, inventory);
  const excluded = new Set(sources);
  const retained = survivingReferences(inventory, candidates, excluded);
  goalReferences(retained, inventory.goals, candidates, inventory);

  return {
    directories: inventory.uncertain ? [] : [...owned].filter(file => !retained.has(file)),
    files: invalidReceipts(root, excluded),
    registryIds: inventory.uncertain ? [] : deleted.map(saved => saved.sessionId).filter(id => uuidPattern.test(id) && !inventory.sessionIds.has(id.toLowerCase())),
  };
}

function cleanupRegistry(root, sessionIds) {
  if (!sessionIds.length) return;
  const database = path.join(root, 'sessions.sqlite');
  const info = metadata(database);

  if (!info) return;

  if (!info.isFile()) throw new Error('Invalid session repository registry');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(database);

  try {
    db.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');

    if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_repositories'").get()) {
      const remove = db.prepare('DELETE FROM session_repositories WHERE lower(session_id) = ?');

      for (const id of sessionIds) remove.run(id.toLowerCase());
    }

    db.exec('COMMIT');
  } finally { db.close(); }
}

module.exports = { collectRetention, cleanupRegistry };
