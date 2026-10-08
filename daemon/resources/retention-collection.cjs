const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { collectRetention, cleanupRegistry } = require('./deletion-retention.cjs');
const { collectWorktreeAllocations } = require('./worktree-retention.cjs');
const { pendingRetentions, cleanupStages, matches, removeCandidate, finishRecord, describeCandidates, recordRetention } = require('./retention-candidates.cjs');

function collectDeferredRetention(root) {
  return require('./session-broker/goal-assets.cjs').locked(root, () => collectDeferredLocked(root));
}

function collectDeferredLocked(root) {
  collectWorktreeAllocations(root);
  collectGoalAllocations(root);
  const { records, errors } = pendingRetentions(root);
  const ready = [];

  for (const record of records) {
    try { cleanupStages(record); ready.push(record); }
    catch (error) { errors.push(error.message); finishRecord(record, false); }
  }

  if (ready.length) collectRecords(root, ready, errors);

  if (errors.length) throw new Error(errors.join('; '));
}

function collectGoalAllocations(root) {
  const marker = path.join(root, 'goal-retention.pending');
  let info;

  try { info = fs.lstatSync(marker); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }

  if (!info.isFile()) throw new Error('Invalid goal attachment recovery marker');
  const retention = collectRetention(root, [], [], undefined, true);

  if (retention.uncertain) return;
  recordRetention(root, randomUUID(), describeCandidates(retention.directories, []));

  if (retention.pendingGoals) return;
  fs.unlinkSync(marker);
  const directory = fs.openSync(root, 'r');

  try { fs.fsyncSync(directory); }
  finally { fs.closeSync(directory); }
}

function collectRecords(root, records, errors) {
  const directories = records.flatMap(record => record.pending.directories.filter(candidate => matches(candidate)).map(candidate => candidate.path));
  const sessionIds = [...new Set(records.flatMap(record => record.pending.sessionIds))];
  const retention = collectRetention(root, [], [], { directories, sessionIds });
  const removable = new Set(retention.directories);
  const removedIds = new Set(cleanupRegistry(root, retention.registryIds));

  for (const record of records) {
    try { collectRecord(record, removable, removedIds); }
    catch (error) { errors.push(error.message); finishRecord(record, false); }
  }
}

function collectRecord(record, removable, removedIds) {
  for (const [index, candidate] of record.pending.directories.entries()) {
    if (removable.has(candidate.path)) removeCandidate(record, index);
  }

  const done = record.pending.directories.every(candidate => !matches(candidate))
    && record.pending.sessionIds.every(id => removedIds.has(id));

  finishRecord(record, done);
}

module.exports = { collectDeferredRetention };
