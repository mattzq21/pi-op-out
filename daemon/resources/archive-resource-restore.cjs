const fs = require('node:fs');
const path = require('node:path');
const io = require('./session-transactions.cjs');
const resources = require('./archive-resources.cjs');

function plan(root, file, destination, operationId) {
  const planned = resources.planRestore(root, file, destination, operationId);
  let directoryCopy;

  if (planned.action === 'copy-directory') directoryCopy = {
    source: planned.recovery.storedPath, destination: planned.binding.path,
    sourceProof: { identity: planned.recovery.storedIdentity, directory: true, digest: planned.recovery.digest, excluded: [] },
    staging: path.join(root, 'restore-staging', operationId), recovery: path.join(root, 'restore-recovery', operationId),
  };

  return { ...planned, directoryCopy };
}

function validate(root, transaction) {
  if (!transaction.resource && !transaction.migration) return;
  const record = transaction.resource ? resources.validate(root, transaction.resource) : { kind: transaction.migration.kind, origin: { path: transaction.migration.path }, recovery: transaction.migration.recovery };

  if (transaction.resource && transaction.resource.operationId !== transaction.receiptId) throw new Error('Shared restoration change has another operation identity');

  if (transaction.directoryCopy) validateCopy(root, transaction.directoryCopy, record, transaction.receiptId);
}

function validateCopy(root, copy, record, operationId) {
  if (record.kind !== 'directory' || copy.destination !== record.origin.path || copy.source !== record.recovery?.storedPath) throw new Error('Shared restoration copy has no resource storage proof');

  if (copy.staging !== path.join(root, 'restore-staging', operationId) || copy.recovery !== path.join(root, 'restore-recovery', operationId)) throw new Error('Invalid shared restoration staging ownership');

  if (copy.sourceProof.identity !== record.recovery.storedIdentity || copy.sourceProof.digest !== record.recovery.digest) throw new Error('Shared restoration storage identity changed');
}

function copyDirectory(transaction, journal, publication = transaction) {
  const copy = transaction.directoryCopy;

  if (!copy) return;

  if (!io.matches(copy.source, copy.sourceProof) || io.exists(copy.destination) || io.exists(copy.staging)) throw new Error('Shared directory restoration source or destination changed; retained');
  io.mkdir(path.dirname(copy.staging));
  copy.stagingParentIdentity = io.identity(path.dirname(copy.staging));
  require('./restore-records.cjs').write(journal, JSON.stringify(publication));
  fs.mkdirSync(copy.staging, { mode: 0o700 });
  io.sync(path.dirname(copy.staging));
  copy.stagingIdentity = io.identity(copy.staging);
  require('./restore-records.cjs').write(journal, JSON.stringify(publication));
  fs.cpSync(copy.source, copy.staging, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true, preserveTimestamps: true });
  fs.chmodSync(copy.staging, fs.statSync(copy.source).mode & 0o777);

  if (!io.matches(copy.source, copy.sourceProof) || !io.sameContents(copy.staging, copy.sourceProof)) throw new Error('Shared archived directory changed while copying; retained');
  io.syncTree(copy.staging);
  copy.prepared = io.describe(copy.staging);
  require('./restore-records.cjs').write(journal, JSON.stringify(publication));
  io.mkdir(path.dirname(copy.destination));
  io.move({ source: copy.staging, destination: copy.destination, identity: copy.prepared });
}

function seal(root, transaction, journal, publication = transaction) {
  if (!transaction.resource) return;
  const record = resources.validate(root, transaction.resource);
  transaction.resource = resources.sealRestore(root, transaction.resource, {
    resourceId: record.id, operationId: transaction.receiptId, sessionId: transaction.result.sessionId,
    sourceIdentity: transaction.trace.identity, directoryIdentity: transaction.worktree?.stagingIdentity ?? transaction.directoryCopy?.stagingIdentity ?? record.binding.identity,
    created: Boolean(transaction.worktree || transaction.directoryCopy),
  });
  require('./restore-records.cjs').write(journal, JSON.stringify(publication));
  resources.apply(root, transaction.resource);
}

function retainCopy(copy, directory) {
  if (!io.exists(directory)) return;

  if (!copy.stagingIdentity && directory === copy.staging) return removeEmptyCopy(copy);

  if (!copy.stagingIdentity || io.identity(directory) !== copy.stagingIdentity) throw new Error('Shared restoration copy ownership is ambiguous; retained');

  if (copy.prepared && !io.matches(directory, copy.prepared)) throw new Error('Shared restoration copy changed; retained');
  io.mkdir(copy.recovery);
  io.move({ source: directory, destination: path.join(copy.recovery, path.basename(directory)), identity: io.describe(directory) });
}

function removeEmptyCopy(copy) {
  const parent = path.dirname(copy.staging);
  const info = fs.lstatSync(copy.staging);

  if (!copy.stagingParentIdentity || io.identity(parent) !== copy.stagingParentIdentity || fs.realpathSync(parent) !== parent) throw new Error('Shared restoration staging parent changed; retained');

  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || process.getuid && info.uid !== process.getuid() || fs.readdirSync(copy.staging).length) throw new Error('Unexpected shared restoration staging contents or owner; retained');
  fs.rmdirSync(copy.staging);
  io.sync(parent);
}

function rollback(root, transaction) {
  if (transaction.resource) resources.rollback(root, transaction.resource);

  if (transaction.directoryCopy) {
    retainCopy(transaction.directoryCopy, transaction.directoryCopy.destination);
    retainCopy(transaction.directoryCopy, transaction.directoryCopy.staging);
  }
}

function finish(root, transaction) {
  if (transaction.resource) resources.apply(root, transaction.resource);
}

module.exports = { plan, validate, copyDirectory, seal, rollback, finish };
