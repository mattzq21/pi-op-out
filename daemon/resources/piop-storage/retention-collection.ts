import * as database from '../session-database.ts';
import { randomUUID } from 'node:crypto';
import { collectRetention, cleanupRegistry } from './deletion-retention.ts';
import { pendingRetentions, cleanupStages, matches, removeCandidate, finishRecord, describeCandidates, recordRetention } from './retention-candidates.ts';
import * as GoalAssets from './goal-assets.ts';

function collectDeferredRetention(root) {
  return GoalAssets.locked(root, () => collectDeferredLocked(root));
}

function collectDeferredLocked(root) {
  collectGoalAllocations(root);
  const { records, errors } = pendingRetentions(root);
  const ready: typeof records = [];

  for (const record of records) {
    try { cleanupStages(record); ready.push(record); }
    catch (error) { errors.push(error.message); finishRecord(record, false); }
  }

  if (ready.length) collectRecords(root, ready, errors);

  if (errors.length) throw new Error(errors.join('; '));
}

function collectGoalAllocations(root) {
  const revision = database.cleanupRequest(root, 'goal');

  if (revision === undefined) return;
  const retention = collectRetention(root, [], [], undefined, true);

  if (retention.uncertain) return;
  recordRetention(root, randomUUID(), describeCandidates(retention.directories, []));

  if (retention.pendingGoals) return;
  database.finishCleanup(root, 'goal', revision);
}

function collectRecords(root, records: ReturnType<typeof pendingRetentions>['records'], errors) {
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

export { collectDeferredRetention };
