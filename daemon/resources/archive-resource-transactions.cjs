const fs = require('node:fs');
const path = require('node:path');
const io = require('./session-transactions.cjs');
const resources = require('./archive-resources.cjs');
const checkpointIndex = require('./session-broker/checkpoint-owner-index.cjs');

function validateChanges(transaction, changes) {
  for (const change of changes) {
    resources.validate(transaction.root, change);

    if (change.operationId !== transaction.id) throw new Error('Shared resource change belongs to another transaction');
  }
}

function validateArchive(transaction) {
  for (const group of transaction.groups.filter(group => group.resource)) {
    const record = resources.validate(transaction.root, group.resource.change);

    if (group.resource.change.operationId !== transaction.id || group.resource.ref !== `refs/piop-archive-resources/${record.id}/${transaction.id}` || record.origin.path !== group.path) throw new Error('Invalid shared archive resource binding');
  }

  validatePeers(transaction);
}

function assertArchiveOwners(transaction) {
  for (const group of transaction.groups.filter(group => group.resource?.removable)) {
    const moves = transaction.records.filter(record => transaction.groups[record.group] === group).map(record => ({ source: record.file, destination: record.destination, sessionId: record.sessionId }));
    resources.assertArchiveOwners(transaction.root, group.resource.change, moves);
  }
}

function archivePlans(transaction) {
  for (const group of transaction.groups) {
    const kind = group.resourceKind ?? group.kind;

    if (!['git', 'directory'].includes(kind)) continue;
    const moves = transaction.records.filter(record => transaction.groups[record.group] === group).map(record => ({ source: record.file, destination: record.destination, sessionId: record.sessionId }));
    group.resource = resources.planArchive(transaction.root, { kind, path: group.path }, moves, transaction.id);

    if (!group.resource.removable) {
      group.resourceKind = kind;
      group.kind = 'shared';
      delete group.identity;
      group.refs = [];
    } else if (kind === 'git') group.refs.push(group.resource.ref);
  }
}

function sealArchive(transaction, group) {
  if (!group.resource) return;
  const moves = transaction.records.filter(record => transaction.groups[record.group] === group).map(record => ({ source: record.file, destination: record.destination, sessionId: record.sessionId }));
  group.resource.change = resources.refreshArchive(transaction.root, group.resource.change, moves);
  let recovery = null;

  if (group.kind === 'directory') recovery = { kind: 'directory', path: group.path, storedPath: group.storedPath, storedIdentity: group.identity.identity, digest: group.identity.digest };

  if (group.kind === 'git') recovery = { kind: 'git', path: group.path, repositoryRoot: group.common, repositoryIdentity: group.repositoryIdentity, ref: group.resource.ref, commit: group.commit, branch: group.branchRef?.slice('refs/heads/'.length) };
  group.resource.change = resources.sealArchive(transaction.root, group.resource.change, recovery);
}

function updateHeader(header, update) {
  header.archiveResourceId = update.archiveResourceId;

  if (update.checkpointRepositoryRoot) header.checkpointRepositoryRoot = update.checkpointRepositoryRoot;

  if (update.worktreeRestore) header.worktreeRestore = update.worktreeRestore;
  else delete header.worktreeRestore;
}

function archiveHeader(transaction, group, record) {
  if (!group.resource) return;
  const update = resources.headerUpdates(transaction.root, group.resource.change).find(owner => owner.sessionId === record.sessionId && owner.sessionPath === record.destination);

  if (!update) throw new Error('Shared archive transcript is absent from its resource ownership plan');
  updateHeader(record.header, update);
}

function planPeers(transaction, save) {
  const selected = new Set(transaction.records.map(record => record.destination));
  const updates = transaction.groups.flatMap(group => group.resource ? resources.headerUpdates(transaction.root, group.resource.change) : []);
  planUpdates(transaction, updates.filter(update => !selected.has(update.sessionPath)), save);
}

function planUpdates(transaction, updates, save) {
  transaction.resourcePeers = updates.map((update, index) => peerPlan(transaction, update, index));
  save(transaction);
}

function peerPlan(transaction, update, index) {
  const original = io.describe(update.sessionPath);

  if (update.identity !== original.identity) throw new Error('Shared archived owner changed before its update was journaled');
  const entries = fs.readFileSync(update.sessionPath, 'utf8').split('\n').filter(line => line.trim()).map(JSON.parse);

  if (entries[0]?.type !== 'session' || entries[0].id !== update.sessionId) throw new Error('Shared archived owner identity changed');

  updateHeader(entries[0], update);

  return { file: update.sessionPath, sessionId: update.sessionId, original, mode: fs.statSync(update.sessionPath).mode & 0o777,
    backup: path.join(transaction.container, `peer-${index}.original`), prepared: path.join(transaction.container, `peer-${index}.prepared`), rollback: path.join(transaction.container, `peer-${index}.rollback`),
    body: entries.map(entry => JSON.stringify(entry)).join('\n') + '\n' };
}

function preparePeers(transaction, save) {
  for (const peer of transaction.resourcePeers ?? []) {
    if (!io.matches(peer.file, peer.original)) throw new Error('Shared archived owner changed before publication');
    fs.copyFileSync(peer.file, peer.backup, fs.constants.COPYFILE_EXCL);
    io.syncTree(peer.backup);
    peer.backupIdentity = io.describe(peer.backup);

    if (!io.sameContents(peer.backup, peer.original) || !io.matches(peer.file, peer.original)) throw new Error('Shared archived owner changed while backing up');
    save(transaction);
    fs.writeFileSync(peer.prepared, peer.body, { flag: 'wx', mode: peer.mode });
    io.syncTree(peer.prepared);
    peer.preparedIdentity = io.describe(peer.prepared);
    delete peer.body;
    save(transaction);
  }
}

function publishPeers(transaction) {
  for (const peer of transaction.resourcePeers ?? []) {
    if (!io.matches(peer.file, peer.original) || !io.matches(peer.backup, peer.backupIdentity) || !io.matches(peer.prepared, peer.preparedIdentity)) throw new Error('Shared archive publication changed; recovery retained');
    require('./transcript-metadata.cjs').invalidate(peer.file);
    fs.renameSync(peer.prepared, peer.file);
    io.sync(path.dirname(peer.file));
    checkpointIndex.refresh(peer.file);
    require('./transcript-metadata.cjs').remember(peer.file);
  }
}

function verifyPeers(transaction) {
  for (const peer of transaction.resourcePeers ?? []) {
    if (!io.matches(peer.file, peer.preparedIdentity)) throw new Error('Shared archive owner publication could not be verified');
  }
}

function rollbackPeers(transaction, save) {
  for (const peer of [...(transaction.resourcePeers ?? [])].reverse()) {
    if (io.matches(peer.file, peer.original) || io.matches(peer.file, peer.rollbackIdentity)) {
      checkpointIndex.refresh(peer.file);
      require('./transcript-metadata.cjs').remember(peer.file);
      continue;
    }

    if (!io.matches(peer.file, peer.preparedIdentity) || !io.matches(peer.backup, peer.backupIdentity)) throw new Error('Shared archived owner rollback is ambiguous; retained');

    preparePeerRollback(transaction, peer, save);

    if (!io.matches(peer.rollback, peer.rollbackIdentity)) throw new Error('Shared archive rollback copy ownership changed');
    require('./transcript-metadata.cjs').invalidate(peer.file);
    fs.renameSync(peer.rollback, peer.file);
    io.sync(path.dirname(peer.file));
    checkpointIndex.refresh(peer.file);
    require('./transcript-metadata.cjs').remember(peer.file);
  }
}

function preparePeerRollback(transaction, peer, save) {
  if (peer.rollbackIdentity) return;

  if (!io.exists(peer.rollback)) fs.copyFileSync(peer.backup, peer.rollback, fs.constants.COPYFILE_EXCL);

  if (!io.sameContents(peer.rollback, peer.original)) throw new Error('Shared archived owner rollback copy changed; retained');
  io.syncTree(peer.rollback);
  peer.rollbackIdentity = io.describe(peer.rollback);
  save(transaction);
}

function validatePeers(transaction) {
  for (const peer of transaction.resourcePeers ?? []) {
    if (!io.inside(path.join(transaction.root, 'archived'), peer.file) || !peer.file.endsWith('.jsonl')) throw new Error('Invalid shared archived owner mapping');

    for (const file of [peer.backup, peer.prepared, peer.rollback]) {
      if (path.dirname(file) !== transaction.container || !/^peer-\d+\.(original|prepared|rollback)$/.test(path.basename(file))) throw new Error('Invalid shared archive owner backup');
    }
  }
}

function finishArchive(transaction) {
  for (const group of transaction.groups.filter(group => group.resource)) resources.apply(transaction.root, group.resource.change);
}

function deletePlans(transaction) {
  transaction.resources = resources.planDelete(transaction.root, transaction.targets, transaction.id);
  transaction.resourceCleanup = transaction.resources.map(change => {
    const planned = resources.cleanupPlan(transaction.root, change);

    return { resourceId: change.resourceId, storage: planned.storage.map(stored => ({ ...stored, entries: io.removalPlan(stored.path) })), pins: planned.pins };
  });
}

function validateDelete(transaction) {
  validateChanges(transaction, transaction.resources ?? []);

  for (const cleanup of transaction.resourceCleanup ?? []) {
    const change = transaction.resources.find(saved => saved.resourceId === cleanup.resourceId);

    if (!change) throw new Error('Shared resource cleanup has no journaled ownership change');
    const record = resources.validate(transaction.root, change);

    if (record.state !== 'retired' && (cleanup.storage.length || cleanup.pins.length)) throw new Error('Shared resource still has surviving owners');
    validateCleanup(record, cleanup);
  }
}

function validateCleanup(record, cleanup) {
  for (const stored of cleanup.storage) {
    if (!record.storage.some(owned => owned.path === stored.path && owned.identity === stored.identity && owned.digest === stored.digest)) throw new Error('Shared storage cleanup is outside its resource ownership proof');
  }

  for (const pin of cleanup.pins) {
    if (!record.pins.some(owned => JSON.stringify(owned) === JSON.stringify(pin))) throw new Error('Shared checkpoint cleanup is outside its resource ownership proof');
  }
}

function finishDelete(transaction) {
  for (const change of transaction.resources ?? []) resources.apply(transaction.root, change);

  for (const cleanup of transaction.resourceCleanup ?? []) {
    for (const stored of cleanup.storage) io.removeOwned(stored.path, stored.entries);

    for (const pin of cleanup.pins) {
      if (io.identity(pin.root) !== pin.identity) throw new Error('Shared checkpoint repository changed; cleanup retained');
      io.removeRef(pin.root, pin.ref, pin.commit);
    }
  }
}

module.exports = { validateChanges, validateArchive, assertArchiveOwners, archivePlans, sealArchive, archiveHeader, planPeers, planUpdates, preparePeers, publishPeers, verifyPeers, rollbackPeers, validatePeers, finishArchive, deletePlans, validateDelete, finishDelete };
