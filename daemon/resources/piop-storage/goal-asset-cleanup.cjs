const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const assets = require('./goal-assets.cjs');
const { retainedDependencies } = require('./session-publication.cjs');
const io = require('../session-transactions.cjs');
const { validSessionHeader } = require('../session-header.cjs');
const goalReferences = require('./goal-cleanup-references.cjs');

const registrySchema = Type.Object({ session_id: Type.String(), session_path: Type.Union([Type.String(), Type.Null()]) });

const queuedSchema = Type.Object({ version: Type.Literal(1), items: Type.Array(Type.Object({}, { additionalProperties: true })) });

const receiptSchema = Type.Object({ version: Type.Literal(1), sessionId: Type.String() });

function managedPath(root, directory) {
  return assets.validPath(root, directory) && io.inside(path.join(root, 'sessions'), directory);
}

function readTranscript(root, file) {
  const entries = require('../transcript-references.cjs').read(root, file);

  if (!validSessionHeader(entries[0])) throw new Error(`Damaged surviving conversation retained: ${file}`);

  return entries;
}

function observe(root, file, observation, live = true) {
  if (observation.files.has(file)) {
    if (live) observation.sessions.add(observation.files.get(file));

    return;
  }

  const entries = readTranscript(root, file);
  observation.files.set(file, entries[0].id);

  if (live) observation.sessions.add(entries[0].id);
  observeReferences(root, entries, observation);
}

function observeReferences(root, entries, observation) {
  const references = goalReferences.collect(root, entries);
  references.directories.forEach(directory => observation.directories.add(directory));
  observation.missingGoalReferences ||= references.incomplete;
}

function registered(root, observation, deleted) {
  const database = require('../session-database.cjs').open(root);

  try {
    for (const record of database.prepare('SELECT session_id, session_path FROM sessions').all()) observeRegistered(root, record, observation, deleted);

  } finally { database.close(); }
}

function observeRegistered(root, record, observation, deleted) {
  if (!Check(registrySchema, record)) throw new Error('Damaged registry ownership prevents goal asset cleanup');

  if (!record.session_path || deleted.has(record.session_id)) return;

  if (!assets.exists(record.session_path) && observation.sessions.has(record.session_id)) return;
  observe(root, record.session_path, observation);
}

function stagedFiles(root, observation) {
  for (const staged of require('../storage-transaction.cjs').stagedTranscripts(root)) {
    if (staged.state !== 'prepared') continue;

    if (path.dirname(staged.file) !== staged.staging) throw new Error('Ambiguous goal asset transaction references retained');

    if (assets.exists(staged.file)) observe(root, staged.file, observation, false);
  }
}

function surviving(root, deleted) {
  const observation = { files: new Map(), sessions: new Set(), directories: new Set() };
  registered(root, observation, deleted);
  queued(root, observation, deleted);
  external(root, observation);
  stagedFiles(root, observation);
  publicationDiagnostics(root, observation);

  return observation;
}

function queued(root, observation, deleted) {
  for (const row of require('../session-database.cjs').queuedInputs(root)) {
    if (deleted.has(row.session_id)) continue;
    const record = JSON.parse(row.record_json);

    if (!Check(queuedSchema, record)) throw new Error('Damaged queued input prevents goal asset cleanup');
    observation.sessions.add(row.session_id);
    observeReferences(root, [record, ...record.items], observation);
  }
}

function publicationDiagnostics(root, observation) {
  for (const diagnostic of retainedDependencies(root)) {
    if (diagnostic.dependencies) {
      observeReferences(root, [{ goalAssets: diagnostic.dependencies.goalAssets }], observation);
    }

    for (const file of diagnostic.transcriptPaths) observe(root, file, observation, false);
  }
}

function external(root, observation) {
  const records = require('../external-transcripts.cjs');

  for (const row of records.list(root)) {
    const file = records.transcript(row);

    if (assets.exists(file)) observe(root, file, observation);
  }
}

function preparedOwner(root, directory) {
  const receipt = require('./goal-preparations.cjs').read(root, directory);

  if (receipt === undefined) return;

  if (!Check(receiptSchema, receipt)) throw new Error('Damaged prepared goal ownership retained');

  return receipt.sessionId;
}

function candidate(root, directory, candidates, ownerIds) {
  if (!managedPath(root, directory)) {
    console.error(`Goal assets outside managed storage were retained: ${directory}`);

    return;
  }

  const identity = assets.exists(directory) ? assets.identity(directory) : require('./goal-ownership.cjs').savedIdentity(root, directory);

  if (identity === undefined) return;
  const previous = candidates.get(directory);
  const owners = [...new Set([...(previous?.owners ?? []), ...ownerIds])];
  candidates.set(directory, { path: directory, identity, owners });
}

function ownedCandidate(root, directory, deleted, candidates) {
  if (!managedPath(root, directory)) return;

  try {
    const record = assets.readOwners(root, directory);
    const ids = [...record.owners.map(owner => owner.sessionId), ...record.retiredOwners ?? [], preparedOwner(root, directory)].filter(id => deleted.has(id));

    if (ids.length) candidate(root, directory, candidates, ids);
  } catch (error) { console.error(`${directory}: goal ownership could not be established; retained: ${error.message}`); }
}

function plan(root, targets) {
  return assets.locked(root, () => {
    const candidates = new Map();
    const deleted = confirmedDeletions(root);
    targets.forEach(target => deleted.add(target.sessionId));

    for (const target of targets) goalReferences.collect(root, readTranscript(root, target.path)).directories.forEach(directory => candidate(root, directory, candidates, [target.sessionId]));

    for (const directory of require('./goal-ownership.cjs').directories(root)) ownedCandidate(root, directory, deleted, candidates);

    return [...candidates.values()];
  });
}

function confirmedDeletions(root) {
  const deleted = new Set();
  const database = new DatabaseSync(path.join(root, 'sessions.sqlite'), { readOnly: true });

  try {
    const current = database.prepare('SELECT 1 FROM sessions WHERE session_id=?');

    for (const directory of require('./goal-ownership.cjs').directories(root)) {
      try {
        const record = assets.readOwners(root, directory);
        const ids = [...record.owners.map(owner => owner.sessionId), ...record.retiredOwners ?? [], preparedOwner(root, directory)];

        for (const id of ids) if (id && !current.get(id)) deleted.add(id);
      } catch (error) { console.error(`${directory}: goal ownership could not be established; retained: ${error.message}`); }
    }
  } finally { database.close(); }

  return deleted;
}

function validate(root, candidates) {
  for (const candidate of candidates) {
    if (!managedPath(root, candidate.path) || !Check(Type.String(), candidate.identity)) throw new Error('Invalid goal asset deletion journal');

    if (candidate.owners !== undefined && !Check(Type.Array(Type.String()), candidate.owners)) throw new Error('Invalid goal asset owner retirement journal');
  }
}

function retireOwners(root, directory, deleted, observation, origins) {
  const record = assets.readOwners(root, directory);
  const owners = record.owners.filter(owner => !deleted.has(owner.sessionId) || observation.sessions.has(owner.sessionId));
  const retiredOwners = new Set(record.retiredOwners ?? []);
  origins.filter(id => deleted.has(id) && !observation.sessions.has(id)).forEach(id => retiredOwners.add(id));

  if (owners.length !== record.owners.length || retiredOwners.size !== (record.retiredOwners?.length ?? 0)) require('./goal-ownership.cjs').save(root, directory, { ...record, owners, retiredOwners: [...retiredOwners] });

  return owners;
}

function finishCandidate(transaction, candidate, observation, deleted, save) {
  if (candidate.finished) {
    endCandidateReclamation(transaction, candidate);

    return;
  }

  if (!assets.exists(candidate.path)) {
    finishMissingCandidate(transaction, candidate, observation, deleted, save);

    return;
  }

  if (assets.identity(candidate.path) !== candidate.identity) throw new Error(`Goal asset directory was replaced; retained: ${candidate.path}`);

  if (candidate.cleanup && referencedCandidate(observation, candidate)) throw new Error(`Goal assets gained a reference during interrupted reclamation; retained: ${candidate.path}`);

  if (!candidate.cleanup) {
    const owners = retireOwners(transaction.root, candidate.path, deleted, observation, candidate.owners ?? [...deleted]);

    if (owners.length || referencedCandidate(observation, candidate)) {
      completeCandidate(transaction, candidate, save);

      return;
    }

    assets.beginReclamation(transaction.root, candidate.path, candidate.identity);
    candidate.cleanup = io.removalPlan(candidate.path);
    save(transaction);
  }

  io.removeOwned(candidate.path, candidate.cleanup);
  completeCandidate(transaction, candidate, save);
}

function finishMissingCandidate(transaction, candidate, observation, deleted, save) {
  const identity = require('./goal-ownership.cjs').savedIdentity(transaction.root, candidate.path);

  if (identity !== undefined && identity !== candidate.identity) throw new Error(`Saved goal ownership changed; retained: ${candidate.path}`);
  const record = assets.readOwners(transaction.root, candidate.path);
  const retained = referencedCandidate(observation, candidate) || record.owners.some(owner => !deleted.has(owner.sessionId) || observation.sessions.has(owner.sessionId));

  if (retained && candidate.cleanup) throw new Error(`Goal assets gained a reference during interrupted reclamation; retained: ${candidate.path}`);

  if (!retained) {
    assets.beginReclamation(transaction.root, candidate.path, candidate.identity);
    candidate.cleanup ??= [];
  }

  completeCandidate(transaction, candidate, save);
}

function referencedCandidate(observation, candidate) {
  return observation.directories.has(candidate.path) || Boolean(observation.missingGoalReferences);
}

function completeCandidate(transaction, candidate, save) {
  candidate.finished = true;
  save(transaction);

  endCandidateReclamation(transaction, candidate);
}

function endCandidateReclamation(transaction, candidate) {
  if (candidate.cleanup) assets.endReclamation(transaction.root, candidate.path, candidate.identity);
}

function finish(transaction, save) {
  if (!transaction.goalAssets?.length) return;
  validate(transaction.root, transaction.goalAssets);
  assets.locked(transaction.root, () => {
    const deleted = confirmedDeletions(transaction.root);
    transaction.targets.forEach(target => deleted.add(target.sessionId));
    const observation = surviving(transaction.root, deleted);

    for (const candidate of transaction.goalAssets) finishCandidate(transaction, candidate, observation, deleted, save);
  });
}

module.exports = { plan, validate, finish };
