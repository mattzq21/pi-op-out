const { collectRetention, cleanupRegistry } = require('./deletion-retention.cjs');
const { pendingRetentions, cleanupStages, matches, removeCandidate, finishRecord } = require('./retention-candidates.cjs');

function collectDeferredRetention(root) {
  const { records, errors } = pendingRetentions(root);
  const ready = [];

  for (const record of records) {
    try { cleanupStages(record); ready.push(record); }
    catch (error) { errors.push(error.message); finishRecord(record, false); }
  }

  if (ready.length) collectRecords(root, ready, errors);

  if (errors.length) throw new Error(errors.join('; '));
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
