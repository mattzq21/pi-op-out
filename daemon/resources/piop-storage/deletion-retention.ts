import * as storageLocks from '../storage-locks.ts';
import fs from 'node:fs';
import path from 'node:path';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { validSessionHeader } from '../session-header.ts';
import { describeCandidates } from './retention-candidates.ts';
import * as transcriptRecords from '../transcript-references.ts';
import * as GoalOwnership from './goal-ownership.ts';
import * as SessionDatabase from '../session-database.ts';
import * as GoalPreparations from './goal-preparations.ts';
import * as GoalDependencies from './goal-dependencies.ts';
import * as ExternalTranscripts from '../external-transcripts.ts';
import * as GoalCleanupReferences from './goal-cleanup-references.ts';
import * as StorageTransaction from '../storage-transaction.ts';
import * as SessionPublication from './session-publication.ts';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function metadata(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function registeredGoals(root, inventory) {
  for (const directory of GoalOwnership.directories(root)) {
    const area = path.relative(root, directory).split(path.sep)[0];

    if (!['sessions', 'archived'].includes(area)
      || path.basename(path.dirname(directory)) !== 'attachments' || !/^goal-(?:[a-f0-9]{64}|[A-Za-z0-9]{6})$/.test(path.basename(directory))) continue;
    const info = metadata(directory);

    if (!info) continue;

    if (!info.isDirectory() || fs.realpathSync(directory) !== directory) { inventory.uncertain = true; continue; }

    inventory.goals.add(directory);
  }
}

function registeredTranscripts(root, inventory) {
  for (const file of SessionDatabase.paths(root)) {
    const info = metadata(file);

    if (!info?.isFile() || fs.realpathSync(file) !== file) { inventory.uncertain = true; continue; }

    inventory.transcripts.push(file);
  }
}

// True while the daemon prepares the goal attachments of directory.
function activeGoalAllocation(directory) {
  const release = storageLocks.lockSync('goal-allocation:' + directory, { wait: false });

  release?.();

  return !release;
}

function retainActiveGoals(root, goals, retained) {
  let pending = false;

  for (const directory of goals) {
    const managed = GoalOwnership.read(root, directory) !== undefined
      || GoalPreparations.read(root, directory) !== undefined
      || GoalDependencies.read(root, directory) !== undefined;

    if (retained.has(directory)) continue;

    if (managed) { retained.add(directory); continue; }

    if (!activeGoalAllocation(directory)) continue;
    retained.add(directory);
    pending = true;
  }

  return pending;
}

function externalTranscripts(root, inventory) {
  const records = ExternalTranscripts;

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

function storedTranscriptReferences(root, file, candidates, found, inventory) {
  try {
    const entries = transcriptRecords.read(root, file);

    if (validSessionHeader(entries[0])) inventory.sessionIds.add(entries[0].id.toLowerCase());
    else inventory.uncertain = true;
    references(entries, candidates, found);
    retainGoalReferences(GoalCleanupReferences.collect(root, entries), candidates, found, inventory);
  } catch (error) {
    inventory.uncertain = true;
    const warning = `Deferred cleanup blocked by transcript ${file}: ${error.message ?? error}`;
    inventory.warnings.push(warning);
    console.error(warning);
  }
}

function survivingReferences(root, inventory, candidates, excluded) {
  const found = new Set();

  for (const file of inventory.transcripts) {
    if (excluded.has(file)) continue;
    storedTranscriptReferences(root, file, candidates, found, inventory);
  }

  return found;
}

function goalReferences(root, found, goals, candidates, inventory) {
  const directories = [...found].filter(directory => goals.has(directory));
  const result = GoalCleanupReferences.collectDirectories(root, directories);
  retainGoalReferences(result, candidates, found, inventory);
}

function retainGoalReferences(result, candidates, found, inventory) {
  inventory.uncertain ||= result.incomplete;

  for (const directory of result.directories) if (candidates.has(directory)) found.add(directory);
  references(result.texts, candidates, found);
}

function queuedReferences(root, excluded, candidates, found, inventory) {
  for (const row of SessionDatabase.queuedInputs(root)) {
    const file = path.join(root, 'queued-input', `${row.session_id}.json`);

    if (excluded.has(file)) continue;
    let value;

    try { value = JSON.parse(row.record_json); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; inventory.uncertain = true; continue; }

    references(value, candidates, found);
    retainGoalReferences(GoalCleanupReferences.collect(root, [value]), candidates, found, inventory);
  }
}

function survivingSession(root: string, file: string, id: string, excluded: Set<string>): boolean {
  if (excluded.has(file)) return false;
  let info;

  try { info = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }

  if (!info.isFile()) return false;
  let header;

  try { header = transcriptRecords.read(root, file)[0]; }
  catch (error) { if (error instanceof SyntaxError) return false; throw error; }

  return validSessionHeader(header) && header.id === id;
}

function collectRetention(root, sources, savedFiles, deferred: { directories: string[]; sessionIds: string[] } = { directories: [], sessionIds: [] }, unpublishedGoals = false) {
  const inventory = { warnings: [] as string[], goals: new Set<string>(), transcripts: [] as string[], sessionIds: new Set<string>(), uncertain: StorageTransaction.pending(root) };

  registeredGoals(root, inventory);
  registeredTranscripts(root, inventory);
  externalTranscripts(root, inventory);
  const candidates = new Set(inventory.goals);
  const owned = new Set(deferred.directories.filter(file => candidates.has(file)));

  if (unpublishedGoals) for (const directory of inventory.goals) owned.add(directory);
  const ignored = { sessionIds: new Set(), uncertain: false, warnings: inventory.warnings };
  const deleted = savedFiles.filter(saved => saved.sessionId);

  for (const saved of deleted) storedTranscriptReferences(root, saved.file, candidates, owned, ignored);
  goalReferences(root, owned, inventory.goals, candidates, ignored);
  const excluded = new Set([...sources, ...savedFiles.map(saved => saved.file)]);
  const retained = survivingReferences(root, inventory, candidates, excluded);
  retainPublications(root, candidates, retained, inventory);
  queuedReferences(root, excluded, candidates, retained, inventory);
  const pendingGoals = retainActiveGoals(root, inventory.goals, retained);
  goalReferences(root, retained, inventory.goals, candidates, inventory);
  const requestedIds = [...new Set([...deleted.map(saved => saved.sessionId), ...deferred.sessionIds])].filter(id => uuidPattern.test(id));

  if (!sources.length && !savedFiles.length && inventory.warnings.length) throw new Error(inventory.warnings.join('; '));

  return {
    warnings: inventory.warnings,
    uncertain: inventory.uncertain,
    pendingGoals,
    directories: inventory.uncertain ? [] : [...owned].filter(file => !retained.has(file)),
    registryIds: inventory.uncertain ? [] : requestedIds.filter(id => !inventory.sessionIds.has(id.toLowerCase())),
    deferred: describeCandidates([...owned], requestedIds),
  };
}

function retainPublications(root, candidates, retained, inventory) {
  const publications = SessionPublication.retainedDependencies(root);

  for (const publication of publications) {
    references(publication.dependencies, candidates, retained);

    if (publication.dependencies) retainGoalReferences(GoalCleanupReferences.collect(root, [publication.dependencies]), candidates, retained, inventory);

    for (const file of publication.transcriptPaths) storedTranscriptReferences(root, file, candidates, retained, inventory);
  }
}

function cleanupRegistry(root, sessionIds) {
  if (!sessionIds.length) return [];
  const tables = SessionDatabase;

  if (!tables.databaseExists(root)) return [...sessionIds];

  return tables.unregisteredSessionIds(root, sessionIds);
}

export { collectRetention, cleanupRegistry, survivingSession };
