import * as stateRecords from './session-records.ts';
import { acquireReferencePublicationLock } from './reference-publication-lock.ts';
import fs from 'node:fs';
import * as assets from './goal-assets.ts';
import * as removal from './goal-asset-cleanup.ts';
import * as retention from './deletion-retention.ts';
import * as candidates from './retention-candidates.ts';

function entries(file, id) {
  const saved = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  if (saved[0]?.type !== 'session' || saved[0].id !== id) throw new Error(`Session identity changed: ${file}`);
  return saved;
}

function inspectSession(root, file, id) {
  return assets.historyContract(root, stateRecords.merge(file, entries(file, id)), id);
}

function archiveContent(file, id, header, contract) {
  const saved = entries(file, id);
  saved[0] = { ...saved[0], ...header, goalAssets: contract };
  return saved.map(entry => JSON.stringify(entry)).join('\n') + '\n';
}

function planRemoval(root, targets, files) {
  return {
    goals: removal.plan(root, targets),
    retention: retention.collectRetention(root, targets.map(target => target.path), files).deferred,
  };
}

function finishRemoval(journal, save) {
  const operation = { ...journal, goalAssets: journal.storage.goals };
  removal.finish(operation, () => {
    journal.storage.goals = operation.goalAssets;
    save(journal);
  });
  candidates.recordRetention(journal.root, journal.id, journal.storage.retention);
}

async function withStorage(root, operation, nonblocking = false) {
  const release = acquireReferencePublicationLock(root, false, nonblocking);
  if (!release) return;
  try { return await operation(); }
  finally { release(); }
}

export { withStorage, inspectSession, archiveContent, planRemoval, finishRemoval };
export { survivingSession } from './deletion-retention.ts';
export { collectDeferredRetention as collectUnused } from './retention-collection.ts';
