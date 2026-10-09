const records = require('./archive-records.cjs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const assets = require('./session-broker/goal-assets.cjs');
const { retainedDependencies } = require('./session-broker/session-publication.cjs');
const io = require('./session-transactions.cjs');
const { validSessionHeader } = require('./checkpoint-schemas.cjs');

const registrySchema = Type.Object({ session_id: Type.String(), session_path: Type.Union([Type.String(), Type.Null()]) });

const receiptSchema = Type.Object({ version: Type.Literal(1), sessionId: Type.String() });

const ephemeralSchema = Type.Object({ version: Type.Literal(1), sessionId: Type.String(), location: Type.Object({ kind: Type.Union([Type.Literal('local'), Type.Literal('remote')]), path: Type.String() }) });

function managedPath(root, directory) {
  return assets.validPath(root, directory) && io.inside(path.join(root, 'sessions'), directory);
}

function readTranscript(root, file) {
  const entries = require('./transcript-references.cjs').read(root, file);

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
  assets.references(entries, root).forEach(directory => observation.directories.add(directory));
  assets.directReferences(entries, root).forEach(directory => observation.directories.add(directory));
}

function registered(root, observation, deleted) {
  const database = require('./session-database.cjs').open(root);

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

function deletionFiles(root, observation) {
  for (const { record } of require('./deletion-records.cjs').list(root)) {
    if (!record || !assets.exists(record.container)) continue;

    for (const file of recoveryFiles(record, 'delete')) {
      if (path.dirname(file) !== record.container) throw new Error('Ambiguous goal asset transaction references retained');

      if (assets.exists(file)) observe(root, file, observation, false);
    }
  }
}

function transactionFiles(root, kind, observation) {
  if (kind === 'delete') return deletionFiles(root, observation);


  for (const directory of records.list(root)) {
    const transaction = records.read(directory);

    if (!transaction) continue;
    const files = recoveryFiles(transaction, kind);

    for (const file of files) {
      if (path.dirname(file) !== directory) throw new Error('Ambiguous goal asset transaction references retained');

      if (assets.exists(file)) observe(root, file, observation, false);
    }
  }
}

function recoveryFiles(transaction, kind) {
  if (transaction.kind !== kind || transaction.version !== 2) throw new Error('Unrecognized session recovery prevents goal cleanup');

  if (kind === 'archive') {
    if (transaction.resourcePeers !== undefined && !Array.isArray(transaction.resourcePeers)) throw new Error('Damaged archive peer mapping prevents goal cleanup');

    return [...transaction.records, ...transaction.resourcePeers ?? []].flatMap(record => [record.backup, record.prepared, record.rollbackCopy ?? record.rollback]);
  }

  return transaction.files.filter(file => file.source.endsWith('.jsonl')).map(file => file.staged);
}

function surviving(root, deleted) {
  const observation = { files: new Map(), sessions: new Set(), directories: new Set() };
  registered(root, observation, deleted);
  ephemeral(root, observation);
  external(root, observation);
  transactionFiles(root, 'archive', observation);
  transactionFiles(root, 'delete', observation);
  publicationDiagnostics(root, observation);

  return observation;
}

function publicationDiagnostics(root, observation) {
  for (const diagnostic of retainedDependencies(root)) {
    if (diagnostic.dependencies) {
      assets.references([{ goalAssets: diagnostic.dependencies.goalAssets }], root).forEach(directory => observation.directories.add(directory));
    }

    for (const file of diagnostic.transcriptPaths) observe(root, file, observation, false);
  }
}

function ephemeral(root, observation) {
  for (const row of require('./session-database.cjs').ephemeralOwners(root)) {
    const record = JSON.parse(row.record_json);

    if (!Check(ephemeralSchema, record)) throw new Error('Unresolved ephemeral ownership prevents goal asset cleanup');

    if (record.location.kind === 'local') observe(root, record.location.path, observation);
  }
}

function external(root, observation) {
  const records = require('./external-transcripts.cjs');

  for (const row of records.list(root)) {
    const file = records.transcript(row);

    if (assets.exists(file)) observe(root, file, observation);
  }
}

function preparedOwner(root, directory) {
  const receipt = require('./session-broker/goal-preparations.cjs').read(root, directory);

  if (receipt === undefined) return;

  if (!Check(receiptSchema, receipt)) throw new Error('Damaged prepared goal ownership retained');

  return receipt.sessionId;
}

function candidate(root, directory, candidates, ownerIds) {
  if (!managedPath(root, directory)) {
    console.error(`Goal assets outside managed storage were retained: ${directory}`);

    return;
  }

  const identity = assets.exists(directory) ? assets.identity(directory) : require('./session-broker/goal-ownership.cjs').savedIdentity(root, directory);

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

    for (const target of targets) assets.references(readTranscript(root, target.path), root).forEach(directory => candidate(root, directory, candidates, [target.sessionId]));

    for (const directory of require('./session-broker/goal-ownership.cjs').directories(root)) ownedCandidate(root, directory, deleted, candidates);

    return [...candidates.values()];
  });
}

function confirmedDeletions(root) {
  const deleted = new Set();
  const file = path.join(root, 'sessions.sqlite');

  if (!assets.exists(file)) return deleted;
  const database = new DatabaseSync(file, { readOnly: true });

  try {
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_deletion_tombstones'").get();

    if (!table) return deleted;

    for (const row of database.prepare('SELECT session_id FROM session_deletion_tombstones').all()) {
      if (!Check(Type.String(), row.session_id)) throw new Error('Damaged deletion evidence prevents goal asset cleanup');
      deleted.add(row.session_id);
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

  if (owners.length !== record.owners.length || retiredOwners.size !== (record.retiredOwners?.length ?? 0)) require('./session-broker/goal-ownership.cjs').save(root, directory, { ...record, owners, retiredOwners: [...retiredOwners] });

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

  if (candidate.cleanup && observation.directories.has(candidate.path)) throw new Error(`Goal assets gained a reference during interrupted reclamation; retained: ${candidate.path}`);

  if (!candidate.cleanup) {
    const owners = retireOwners(transaction.root, candidate.path, deleted, observation, candidate.owners ?? [...deleted]);

    if (owners.length || observation.directories.has(candidate.path)) {
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
  const identity = require('./session-broker/goal-ownership.cjs').savedIdentity(transaction.root, candidate.path);

  if (identity !== undefined && identity !== candidate.identity) throw new Error(`Saved goal ownership changed; retained: ${candidate.path}`);
  const record = assets.readOwners(transaction.root, candidate.path);
  const retained = missingReferences(observation) || observation.directories.has(candidate.path) || record.owners.some(owner => !deleted.has(owner.sessionId) || observation.sessions.has(owner.sessionId));

  if (retained && candidate.cleanup) throw new Error(`Goal assets gained a reference during interrupted reclamation; retained: ${candidate.path}`);

  if (!retained) {
    assets.beginReclamation(transaction.root, candidate.path, candidate.identity);
    candidate.cleanup ??= [];
  }

  completeCandidate(transaction, candidate, save);
}

function missingReferences(observation) {
  return [...observation.directories].some(directory => !assets.exists(directory));
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
