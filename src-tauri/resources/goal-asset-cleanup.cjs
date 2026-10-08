const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const assets = require('./session-broker/goal-assets.cjs');
const io = require('./session-transactions.cjs');
const { validSessionHeader } = require('./checkpoint-schemas.cjs');

const registrySchema = Type.Object({ session_id: Type.String(), session_path: Type.Union([Type.String(), Type.Null()]) });

const receiptSchema = Type.Object({ version: Type.Literal(1), sessionId: Type.String() });

function managedPath(root, directory) {
  return assets.validPath(root, directory) && io.inside(path.join(root, 'sessions'), directory);
}

function readTranscript(file) {
  if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) throw new Error(`Cannot verify surviving goal history: ${file}`);
  const entries = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(JSON.parse);

  if (!validSessionHeader(entries[0])) throw new Error(`Damaged surviving conversation retained: ${file}`);

  return entries;
}

function walk(directory, visit) {
  if (!assets.exists(directory)) return;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory() && entry.name !== 'attachments' && !entry.name.endsWith('.snapshots')) walk(file, visit);
    else if (/\.jsonl(?:\.[a-f0-9-]+\.tmp)?$/.test(entry.name)) visit(file);
  }
}

function observe(root, file, observation) {
  if (observation.files.has(file)) return;
  const entries = readTranscript(file);
  observation.files.add(file);
  observation.sessions.add(entries[0].id);
  assets.references(entries, root).forEach(directory => observation.directories.add(directory));
}

function registered(root, observation, deleted) {
  const file = path.join(root, 'sessions.sqlite');

  if (!assets.exists(file)) return;
  const database = new DatabaseSync(file, { readOnly: true });

  try {
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_repositories'").get();

    if (!table) return;

    for (const record of database.prepare('SELECT session_id, session_path FROM session_repositories').all()) observeRegistered(root, record, observation, deleted);
  } finally { database.close(); }
}

function observeRegistered(root, record, observation, deleted) {
  if (!Check(registrySchema, record)) throw new Error('Damaged registry ownership prevents goal asset cleanup');

  if (!record.session_path || deleted.has(record.session_id)) return;

  if (!assets.exists(record.session_path) && observation.sessions.has(record.session_id)) return;
  observe(root, record.session_path, observation);
}

function transactionFiles(root, kind, observation) {
  const parent = path.join(root, `${kind}-transactions`);

  if (!assets.exists(parent)) return;

  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(parent, entry.name);
    const journal = path.join(directory, 'recovery.json');

    if (!assets.exists(journal)?.isFile()) continue;
    const transaction = JSON.parse(fs.readFileSync(journal, 'utf8'));
    const files = recoveryFiles(transaction, kind);

    for (const file of files) {
      if (path.dirname(file) !== directory) throw new Error('Ambiguous goal asset transaction references retained');

      if (assets.exists(file)) observe(root, file, observation);
    }
  }
}

function recoveryFiles(transaction, kind) {
  if (transaction.kind !== kind || transaction.version !== 2) throw new Error('Unrecognized session recovery prevents goal cleanup');

  if (kind === 'archive') return transaction.records.flatMap(record => [record.backup, record.prepared, record.rollbackCopy]);

  return transaction.files.filter(file => file.source.endsWith('.jsonl')).map(file => file.staged);
}

function surviving(root, deleted) {
  const observation = { files: new Set(), sessions: new Set(), directories: new Set() };
  walk(path.join(root, 'sessions'), file => observe(root, file, observation));
  walk(path.join(root, 'archived'), file => observe(root, file, observation));
  registered(root, observation, deleted);
  transactionFiles(root, 'archive', observation);
  transactionFiles(root, 'delete', observation);

  return observation;
}

function walkAssets(directory, visit) {
  if (!assets.exists(directory)) return;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.endsWith('.snapshots')) continue;
    const file = path.join(directory, entry.name);

    if (entry.name !== 'attachments') walkAssets(file, visit);
    else for (const goal of fs.readdirSync(file, { withFileTypes: true })) {
      if (goal.isDirectory()) visit(path.join(file, goal.name));
    }
  }
}

function preparedOwner(directory) {
  const file = path.join(directory, 'prepared.json');

  if (!assets.exists(file)) return;

  if (!assets.exists(file).isFile()) throw new Error('Prepared goal ownership is not a regular file');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (!Check(receiptSchema, receipt)) throw new Error('Damaged prepared goal ownership retained');

  return receipt.sessionId;
}

function candidate(root, directory, candidates) {
  if (!managedPath(root, directory)) {
    console.error(`Goal assets outside managed storage were retained: ${directory}`);

    return;
  }

  if (assets.exists(directory)) candidates.set(directory, { path: directory, identity: assets.identity(directory) });
}

function ownedCandidate(root, directory, deleted, candidates) {
  if (!managedPath(root, directory)) return;

  try {
    const owners = assets.readOwners(directory).owners;

    if (owners.some(owner => deleted.has(owner.sessionId)) || deleted.has(preparedOwner(directory))) candidate(root, directory, candidates);
  } catch (error) { console.error(`${directory}: goal ownership could not be established; retained: ${error.message}`); }
}

function plan(root, targets) {
  return assets.locked(root, () => {
    const candidates = new Map();
    const deleted = new Set(targets.map(target => target.sessionId));

    for (const target of targets) assets.references(readTranscript(target.path), root).forEach(directory => candidate(root, directory, candidates));
    walkAssets(path.join(root, 'sessions'), directory => ownedCandidate(root, directory, deleted, candidates));

    return [...candidates.values()];
  });
}

function validate(root, candidates) {
  for (const candidate of candidates) {
    if (!managedPath(root, candidate.path) || !Check(Type.String(), candidate.identity)) throw new Error('Invalid goal asset deletion journal');
  }
}

function retireOwners(directory, deleted, observation) {
  const record = assets.readOwners(directory);
  const owners = record.owners.filter(owner => !deleted.has(owner.sessionId) || observation.sessions.has(owner.sessionId));

  if (owners.length !== record.owners.length) assets.write(path.join(directory, 'owners.json'), { ...record, owners });

  return owners;
}

function finishCandidate(transaction, candidate, observation, deleted, save) {
  if (candidate.finished) {
    if (candidate.cleanup) assets.endReclamation(transaction.root, candidate.path, candidate.identity);

    return;
  }

  if (!assets.exists(candidate.path)) { completeCandidate(transaction, candidate, save); return; }

  if (assets.identity(candidate.path) !== candidate.identity) throw new Error(`Goal asset directory was replaced; retained: ${candidate.path}`);

  if (candidate.cleanup && observation.directories.has(candidate.path)) throw new Error(`Goal assets gained a reference during interrupted reclamation; retained: ${candidate.path}`);

  if (!candidate.cleanup) {
    const owners = retireOwners(candidate.path, deleted, observation);

    if (owners.length || observation.directories.has(candidate.path)) { completeCandidate(transaction, candidate, save); return; }
    assets.beginReclamation(transaction.root, candidate.path, candidate.identity);
    candidate.cleanup = io.removalPlan(candidate.path);
    save(transaction);
  }

  io.removeOwned(candidate.path, candidate.cleanup);
  completeCandidate(transaction, candidate, save);
}

function completeCandidate(transaction, candidate, save) {
  candidate.finished = true;
  save(transaction);

  if (candidate.cleanup) assets.endReclamation(transaction.root, candidate.path, candidate.identity);
}

function finish(transaction, save) {
  if (!transaction.goalAssets?.length) return;
  validate(transaction.root, transaction.goalAssets);
  assets.locked(transaction.root, () => {
    const deleted = new Set(transaction.targets.map(target => target.sessionId));
    const observation = surviving(transaction.root, deleted);

    for (const candidate of transaction.goalAssets) finishCandidate(transaction, candidate, observation, deleted, save);
  });
}

module.exports = { plan, validate, finish };
