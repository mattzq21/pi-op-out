const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validReceipt } = require('./deletion-retention.cjs');
const transactionIO = require('./session-transactions.cjs');
const goalAssets = require('./session-broker/goal-assets.cjs');
const receipts = require('./restore-receipts.cjs');
const shared = require('./archive-resource-restore.cjs');
const migration = require('./archive-resource-migration.cjs');
const ownerLocks = require('./transaction-owner-locks.cjs');
const { lockStorage } = require('./storage-transaction-lock.cjs');
const checkpointIndex = require('./session-broker/checkpoint-owner-index.cjs');

function exists(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function sync(file) {
  const fd = fs.openSync(file, 'r');

  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function syncTree(file) {
  const metadata = fs.lstatSync(file);

  if (metadata.isSymbolicLink()) return;

  if (metadata.isDirectory()) for (const name of fs.readdirSync(file)) syncTree(path.join(file, name));
  sync(file);
}

function syncParents(directory) {
  sync(directory);
  const parent = path.dirname(directory);

  if (parent !== directory) syncParents(parent);
}

function write(file, body) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);

  try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }

  fs.renameSync(temporary, file);
  sync(path.dirname(file));
  checkpointIndex.refresh(file);
}

function rename(source, destination) {
  const expected = identity(source);
  execFileSync('mv', ['--no-clobber', '--no-copy', '--no-target-directory', '--', source, destination], { stdio: ['ignore', 'pipe', 'pipe', 3, 4, 5, 6] });
  sync(path.dirname(destination));
  sync(path.dirname(source));

  if (exists(source) || !matches(destination, expected)) throw new Error(`Restoration move could not be verified: ${source}`);
  checkpointIndex.relocate(source, destination);
}

function identity(file) {
  const stat = fs.lstatSync(file, { bigint: true });

  return `${stat.dev}:${stat.ino}`;
}

function matches(file, expected) { return Boolean(exists(file)) && identity(file) === expected; }

function move(source, destination) {
  if (exists(destination)) throw new Error(`Restoration destination already exists: ${destination}`);

  return { source, destination, identity: identity(source) };
}

function performMove(item) {
  if (!matches(item.source, item.identity) || exists(item.destination)) throw new Error(`Restoration files changed: ${item.source}`);
  rename(item.source, item.destination);
}

function undoMove(item) {
  if (matches(item.source, item.identity) && !exists(item.destination)) return;

  if (exists(item.source) || !matches(item.destination, item.identity)) throw new Error(`Cannot safely roll back restoration: ${item.source}`);
  rename(item.destination, item.source);
}

function prepareDirectory(directory, transaction, journal) {
  if (!directory.persistent) {
    syncTree(directory.source); syncParents(path.dirname(directory.destination)); performMove(directory);

    return;
  }

  if (!matches(directory.source, directory.identity) || exists(directory.destination) || exists(directory.staging)) throw new Error(`Restoration files changed: ${directory.source}`);

  verifyDirectoryContents(directory);
  fs.mkdirSync(directory.staging, { mode: 0o700 });
  directory.stagingIdentity = identity(directory.staging);
  require('./restore-records.cjs').write(journal, JSON.stringify(transaction));
  fs.cpSync(directory.source, directory.staging, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });

  if (!matches(directory.source, directory.identity)) throw new Error(`Restoration files changed: ${directory.source}`);

  verifyDirectoryContents(directory, directory.staging);
  syncTree(directory.staging);
  syncParents(path.dirname(directory.destination));
  performMove({ source: directory.staging, destination: directory.destination, identity: directory.stagingIdentity });
}

function verifyDirectoryContents(directory, staging) {
  if (!directory.sourceProof) return;

  if (!transactionIO.matches(directory.source, directory.sourceProof) || staging && !transactionIO.sameContents(staging, directory.sourceProof)) throw new Error('Archived directory contents changed during restoration');
}

function undoDirectory(directory) {
  if (!directory.persistent) return undoMove(directory);

  if (!directory.stagingIdentity) {
    if (exists(directory.destination)) throw new Error(`Restored directory changed: ${directory.destination}`);

    if (exists(directory.staging)) { fs.rmdirSync(directory.staging); sync(path.dirname(directory.staging)); }

    return;
  }

  for (const file of [directory.destination, directory.staging]) {
    if (!exists(file)) continue;

    if (!matches(file, directory.stagingIdentity)) throw new Error(`Restored directory changed: ${file}`);
    transactionIO.mkdir(directory.recovery);
    rename(file, path.join(directory.recovery, path.basename(file)));
  }
}

function git(plan, args) {
  return execFileSync('git', ['-C', plan.repositoryRoot, '-c', 'core.fsync=all', '-c', 'core.fsyncMethod=fsync', ...args], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe', 3, 4, 5, 6] }).trim();
}

function branchCommit(plan) {
  try { return git(plan, ['rev-parse', '--verify', `refs/heads/${plan.branch}`]); }
  catch (error) { if (error.status === 128) return undefined; throw error; }
}

function conversationDirectoryParts(root, relative) {
  const target = path.resolve(root, relative);
  const boundary = path.relative(root, target);

  if (boundary === '..' || boundary.startsWith('..' + path.sep) || path.isAbsolute(boundary)) throw new Error('The conversation working directory is outside its recovery checkout');

  return boundary.split(path.sep).filter(Boolean);
}

function prepareConversationDirectories(plan) {
  for (const relative of plan.conversationDirectories ?? []) {
    let directory = plan.staging;

    for (const component of conversationDirectoryParts(plan.staging, relative)) {
      directory = path.join(directory, component);

      if (!exists(directory)) fs.mkdirSync(directory, { mode: 0o700 });

      if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Invalid restored conversation directory: ${directory}`);
    }
  }
}

function prepareReusedDirectory(directory, transaction, journal) {
  if (exists(directory)) {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Invalid restored conversation directory: ${directory}`);

    return;
  }

  const parent = path.dirname(directory);
  const item = { source: path.join(parent, `.piop-restore-${randomUUID()}`), destination: directory, parentIdentity: identity(parent) };
  transaction.createdDirectories.push(item);
  require('./restore-records.cjs').write(journal, JSON.stringify(transaction));
  fs.mkdirSync(item.source, { mode: 0o700 });
  item.identity = identity(item.source);
  sync(item.source); sync(parent);
  require('./restore-records.cjs').write(journal, JSON.stringify(transaction));
  performMove(item);
}

function prepareReusedWorktrees(transaction, journal) {
  for (const plan of transaction.reusedWorktrees) {
    if (!matches(plan.path, plan.directoryIdentity) || !fs.lstatSync(plan.path).isDirectory()) throw new Error(`Invalid restored checkout: ${plan.path}`);

    for (const relative of plan.conversationDirectories) {
      let directory = plan.path;

      for (const component of conversationDirectoryParts(plan.path, relative)) {
        directory = path.join(directory, component);
        prepareReusedDirectory(directory, transaction, journal);
      }
    }
  }
}

function undoCreatedDirectory(item) {
  const remaining = [item.destination, item.source].filter(directory => exists(directory));

  if (!remaining.length) return;
  const parent = path.dirname(item.destination);

  if (!matches(parent, item.parentIdentity)) throw new Error(`Restored conversation directory parent changed: ${parent}`);

  for (const directory of remaining) {
    if (!item.identity && directory === item.destination) continue;

    if (item.identity && !matches(directory, item.identity)) throw new Error(`Restored conversation directory changed: ${directory}`);
    fs.rmdirSync(directory);
    sync(parent);
  }
}

function undoCreatedDirectories(transaction) {
  for (const directory of [...(transaction.createdDirectories ?? [])].reverse()) undoCreatedDirectory(directory);
}

function prepareWorktree(plan, transaction, journal) {
  transactionIO.mkdir(path.dirname(plan.staging));
  fs.mkdirSync(plan.staging, { mode: 0o700 });
  sync(path.dirname(plan.staging));
  plan.stagingIdentity = identity(plan.staging);
  require('./restore-records.cjs').write(journal, JSON.stringify(transaction));
  git(plan, ['update-ref', plan.reservation, plan.commit, '0'.repeat(plan.commit.length)]);
  const common = git(plan, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  syncTree(path.join(common, 'refs'));
  sync(common);
  git(plan, ['update-ref', '--create-reflog', '-m', plan.reservation, `refs/heads/${plan.branch}`, plan.commit, '0'.repeat(plan.commit.length)]);
  git(plan, ['worktree', 'add', plan.staging, plan.branch]);
  prepareConversationDirectories(plan);
  syncTree(plan.staging);
  git(plan, ['worktree', 'move', plan.staging, plan.path]);
  const gitDirectory = fs.readFileSync(path.join(plan.path, '.git'), 'utf8').trim().slice('gitdir: '.length);
  syncTree(gitDirectory);
  sync(path.dirname(gitDirectory));
  syncTree(path.join(common, 'refs'));
  sync(common);
  syncParents(path.dirname(plan.path));
}

function registrationMatches(plan, registration) {
  const pointer = path.join(registration, 'gitdir');

  if (!exists(pointer)) return path.basename(registration) === path.basename(plan.staging);
  const destination = fs.readFileSync(pointer, 'utf8').trim();

  return destination === path.join(plan.staging, '.git') || destination === path.join(plan.path, '.git');
}

function removeWorktree(plan, directory, registrations) {
  if (!exists(directory)) return;

  if (!plan.stagingIdentity || identity(directory) !== plan.stagingIdentity) throw new Error(`Restoration directory ownership is ambiguous; retained: ${directory}`);
  const pointer = path.join(directory, '.git');

  if (exists(pointer)) {
    const content = fs.readFileSync(pointer, 'utf8').trim();
    const registration = content.startsWith('gitdir: ') ? path.resolve(directory, content.slice(8)) : '';

    if (!registrations.includes(registration)) throw new Error(`Restored worktree was replaced: ${directory}`);
  } else if (directory !== plan.staging) throw new Error(`Restored worktree was replaced: ${directory}`);
  transactionIO.mkdir(plan.recovery);
  rename(directory, path.join(plan.recovery, directory === plan.staging ? 'staging' : 'checkout'));
}

function undoCheckout(plan, common) {
  const worktrees = path.join(common, 'worktrees');

  const registrations = exists(worktrees) ? fs.readdirSync(worktrees).flatMap(name => {
    const registration = path.join(worktrees, name);

    return registrationMatches(plan, registration) ? [registration] : [];
  }) : [];

  for (const registration of registrations) {
    const head = path.join(registration, 'HEAD');

    if (exists(head) && ![`ref: refs/heads/${plan.branch}`, plan.commit, ''].includes(fs.readFileSync(head, 'utf8').trim())) throw new Error(`Restored worktree changed: ${registration}`);
  }

  removeWorktree(plan, plan.path, registrations);
  removeWorktree(plan, plan.staging, registrations);

  for (const registration of registrations) {
    const retained = path.join(plan.recovery, 'registrations');
    transactionIO.mkdir(retained);
    rename(registration, path.join(retained, path.basename(registration)));
  }

  if (exists(worktrees)) sync(worktrees);
}

function hasReservation(plan) {
  try { git(plan, ['show-ref', '--verify', '--quiet', plan.reservation]);

  return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
}

function undoWorktree(plan) {
  if (!hasReservation(plan)) {
    if (exists(plan.staging)) {
      if (!plan.stagingIdentity) throw new Error(`Restoration staging ownership is ambiguous; retained: ${plan.staging}`);

      if (identity(plan.staging) !== plan.stagingIdentity) throw new Error(`Restoration staging ownership changed; retained: ${plan.staging}`);
      transactionIO.mkdir(plan.recovery);
      rename(plan.staging, path.join(plan.recovery, 'staging'));
    }

    return;
  }

  const commit = branchCommit(plan);
  const common = git(plan, ['rev-parse', '--path-format=absolute', '--git-common-dir']);

  if (commit && commit !== plan.commit) throw new Error(`Restored branch changed: ${plan.branch}`);

  if (commit && git(plan, ['reflog', 'show', '-1', '--format=%gs', `refs/heads/${plan.branch}`]) !== plan.reservation) throw new Error(`Restored branch is no longer owned by this transaction: ${plan.branch}`);
  undoCheckout(plan, common);

  if (commit) git(plan, ['update-ref', '-d', `refs/heads/${plan.branch}`, plan.commit]);
  syncTree(path.join(common, 'refs'));
}

function worktrees(transaction) { return transaction.worktrees ?? (transaction.worktree ? [transaction.worktree] : []); }

function directories(transaction) { return transaction.directories ?? (transaction.directory ? [transaction.directory] : []); }

function ownerships(transaction) { return transaction.ownerships ?? [transaction.ownership]; }

function releaseReservation(transaction) {
  for (const plan of worktrees(transaction)) {
    if (plan.recovery && exists(plan.recovery)) {
      console.error(`Restore rollback data and its reservation ref were retained: ${plan.recovery}`);
      continue;
    }

    if (hasReservation(plan)) git(plan, ['update-ref', '-d', plan.reservation, plan.commit]);
  }
}

function committed(transaction) { return matches(transaction.trace.destination, transaction.trace.identity); }

function receiptPath(root, source) {
  return path.join(root, 'restore-receipts', `${createHash('sha256').update(source).digest('hex')}.json`);
}

function restoredResult(root, source) {
  const result = receipts.result(root, source);

  if (result?.sessions && !validReceipt(receiptPath(root, source), new Set())) return null;

  return result;
}

function rollback(root, transaction, journal) {
  validateRollbackSource(transaction);

  for (const item of [...transaction.moves].reverse()) undoRestorationMove(transaction, item);

  for (const resource of [...resourceTransactions(transaction)].reverse()) migration.rollback(resource, journal, transaction);

  for (const resource of [...resourceTransactions(transaction)].reverse()) shared.rollback(root, resource);
  undoCreatedDirectories(transaction);

  for (const directory of [...directories(transaction)].reverse()) undoDirectory(directory);

  for (const worktree of [...worktrees(transaction)].reverse()) undoWorktree(worktree);

  for (const ownership of ownerships(transaction)) {
    const current = fs.readFileSync(ownership.path, 'utf8');

    if (![ownership.initial, ownership.before, ownership.after].includes(current)) throw new Error('Session ownership changed during restoration');
    write(ownership.path, ownership.before);
  }
}

function validateRollbackSource(transaction) {
  if ((!matches(transaction.trace.source, transaction.trace.identity) && !resourceTransactions(transaction).some(resource => migration.sourcePresent(resource))) || exists(transaction.trace.destination)) throw new Error('Session files changed during restoration; recovery retained');
}

function undoRestorationMove(transaction, item) {
  const peers = resourceTransactions(transaction).flatMap(resource => resource.resourcePeers ?? []);
  const peer = peers.find(record => record.file === item.source);

  if (peer && !exists(item.destination) && [peer.original, peer.preparedIdentity, peer.rollbackIdentity].some(proof => transactionIO.matches(item.source, proof))) return;
  undoMove(item);
}

function cleanup(journal) { require('./restore-records.cjs').remove(journal); }

function finishCommit(transaction, journal) {
  const root = path.dirname(path.dirname(journal));
  require('./session-database.cjs').movePaths(root, [transaction.trace, ...transaction.moves].filter(item => item.destination.endsWith('.jsonl')));

  for (const item of [transaction.trace, ...transaction.moves]) {
    if (item.destination.endsWith('.jsonl')) checkpointIndex.relocate(item.source, item.destination);
  }

  for (const resource of resourceTransactions(transaction)) shared.finish(root, resource);

  if (!transaction.committed) {
    sync(path.dirname(transaction.trace.destination));
    sync(path.dirname(transaction.trace.source));
    transaction.committed = true;
    require('./restore-records.cjs').write(journal, JSON.stringify(transaction));
  }

  try { releaseReservation(transaction); retireMigrations(transaction, journal); cleanup(journal); }
  catch (error) { console.error(`Restore committed; cleanup will retry: ${error.message}`); }
}

function recover(root) {
  for (const journal of require('./restore-records.cjs').list(root)) {
    const transaction = require('./restore-records.cjs').read(journal).value;

    validateTransaction(root, transaction, journal);

    const ids = resourceTransactions(transaction).flatMap(resource => (resource.migration?.owners ?? []).map(owner => owner.sessionId));
    ownerLocks.withOwners(root, ids, [], () => {
      if (transaction.committed || committed(transaction)) finishCommit(transaction, journal);
      else { prepareLegacyRollback(root, transaction, journal); finishRollback(root, transaction, journal); }
    });
  }
}

function prepareLegacyRollback(root, transaction, journal) {
  for (const plan of worktrees(transaction)) {
    if (plan.recovery) continue;
    plan.recovery = path.join(root, 'restore-recovery', randomUUID());
    const directory = [plan.path, plan.staging].find(file => exists(file));

    if (directory) plan.stagingIdentity = identity(directory);
  }

  for (const directory of directories(transaction)) directory.recovery ??= path.join(root, 'restore-recovery', randomUUID());
  require('./restore-records.cjs').write(journal, JSON.stringify(transaction));
}

function sessionTransaction(root, { header, file, destination, result }) {
  const key = createHash('sha256').update(header.id.toLowerCase()).digest('hex').slice(0, 40);
  const ownershipPath = path.join(root, 'conversation-ownership', `${key}.json`);
  const record = JSON.parse(fs.readFileSync(ownershipPath, 'utf8'));

  return {
    result: { ...result, sessionId: header.id },
    trace: move(file, destination),
    moves: [
      [file.replace(/\.jsonl$/, '.snapshots'), destination.replace(/\.jsonl$/, '.snapshots')],
      [file.replace(/\.jsonl$/, '.diffs.json'), destination.replace(/\.jsonl$/, '.diffs.json')],
      [file.replace(/\.jsonl$/, '.diffs.json.lock'), destination.replace(/\.jsonl$/, '.diffs.json.lock')],
      [`${file}.loop-detection.json`, `${destination}.loop-detection.json`],
    ].flatMap(([source, target]) => exists(source) ? [move(source, target)] : []),
    ownership: {
      initial: fs.readFileSync(ownershipPath, 'utf8'),
      path: ownershipPath,
      before: JSON.stringify({ ...record, path: file, deleted: true, client: null }),
      after: JSON.stringify({ ...record, path: destination, deleted: false, client: null }),
    },
  };
}

function publishRestoration(root, transaction, journal) {
  for (const resource of transaction.resources) migration.preparePin(resource, journal, transaction);

  for (const worktree of transaction.worktrees) prepareWorktree(worktree, transaction, journal);

  for (const resource of transaction.resources) shared.copyDirectory(resource, journal, transaction);

  for (const directory of transaction.directories) prepareDirectory(directory, transaction, journal);

  prepareReusedWorktrees(transaction, journal);

  for (const directory of transaction.workingDirectories) {
    if (!fs.statSync(directory).isDirectory()) throw new Error(`The conversation working directory is unavailable: ${directory}`);
  }

  for (const resource of transaction.resources) {
    shared.seal(root, resource, journal, transaction);
    migration.seal(root, resource, journal, transaction);
  }

  reconcileMigrationTraces(transaction);
  require('./restore-records.cjs').write(journal, JSON.stringify(transaction));

  for (const item of transaction.moves) { syncTree(item.source); performMove(item); }

  for (const ownership of transaction.ownerships) write(ownership.path, ownership.after);
  syncTree(transaction.trace.source);
  receipts.publish(root, transaction);
  performMove(transaction.trace);
}

function reconcileMigrationTraces(transaction) {
  const peers = transaction.resources.flatMap(resource => resource.resourcePeers ?? []);

  for (const trace of [transaction.trace, ...transaction.moves]) {
    const peer = peers.find(record => record.file === trace.source);

    if (peer) trace.identity = peer.preparedIdentity.identity;
  }
}

function restoreGroup(root, records, directoryPlans, worktreePlans, reusedWorktrees, resources) {
  const ids = resources.flatMap(resource => (resource.migration?.owners ?? []).map(owner => owner.sessionId));

  return ownerLocks.withOwners(root, ids, records.map(record => record.header.id), () => restoreGroupLocked(root, records, directoryPlans, worktreePlans, reusedWorktrees, resources));
}

function restoreGroupLocked(root, records, directoryPlans, worktreePlans, reusedWorktrees, resources) {
  const sessions = records.map(record => sessionTransaction(root, record));
  const primary = sessions[0];

  const transaction = {
    version: 2, root, receiptId: randomUUID(),
    resources,
    ownership: primary.ownership,
    result: { ...primary.result, sessions: sessions.map(session => ({ ...session.result, sourcePath: session.trace.source })) },
    trace: primary.trace,
    moves: [...sessions.flatMap(session => session.moves), ...sessions.slice(1).map(session => session.trace)],
    ownerships: sessions.map(session => session.ownership),
    directories: directoryPlans.map(directory => ({ ...directory, ...move(directory.source, directory.destination),
      sourceProof: transactionIO.describe(directory.source), recovery: path.join(root, 'restore-recovery', randomUUID()) })),
    workingDirectories: [...new Set(records.map(record => record.header.cwd))],
    worktrees: worktreePlans.map(plan => ({ ...plan, recovery: path.join(root, 'restore-recovery', randomUUID()) })),
    reusedWorktrees,
    createdDirectories: [],
  };

  if (Buffer.byteLength(JSON.stringify(transaction.result)) + 1 > 64 * 1024 * 1024) throw new Error('Restore group is too large; restore fewer conversations at a time');

  const journalDirectory = path.join(root, 'restore-transactions');
  fs.mkdirSync(journalDirectory, { recursive: true, mode: 0o700 });
  sync(root);

  const key = createHash('sha256').update(primary.result.sessionId.toLowerCase()).digest('hex').slice(0, 40);

  const journal = path.join(journalDirectory, `${key}.json`);

  for (const resource of resources) resource.worktree = transaction.worktrees.find(plan => plan.path === resource.worktree?.path);
  require('./restore-records.cjs').write(journal, JSON.stringify(transaction));

  try {
    for (const record of records) goalAssets.retainHistory(root, record.entries, record.header.id, record.destination);

    for (const ownership of transaction.ownerships) write(ownership.path, ownership.before);
    publishRestoration(root, transaction, journal);
  } catch (error) {
    if (!committed(transaction)) {
      try { finishRollback(root, transaction, journal); }
      catch (failure) { throw new Error(`${error.message}\nRestore recovery is pending: ${failure.message}`); }

      throw error;
    }
  }

  try { finishCommit(transaction, journal); }
  catch (error) { console.error(`Restore committed; recovery will retry: ${error.message}`); }

  return transaction.result;
}

function restore(root, header, file, destination, result, directory, worktree, resource) {
  const ids = (resource?.migration?.owners ?? []).map(owner => owner.sessionId);

  return ownerLocks.withOwners(root, ids, [header.id], () => restoreLocked(root, header, file, destination, result, directory, worktree, resource));
}

function finishRollback(root, transaction, journal) {
  rollback(root, transaction, journal);
  releaseReservation(transaction);
  receipts.discardRolledBack(root, transaction, journal);
  retireMigrations(transaction, journal);
  cleanup(journal);

  try { receipts.prune(root); }
  catch (error) { console.error(`Restore rolled back; receipt pruning will retry: ${error.message}`); }
}

function retireMigrations(transaction, journal) {
  for (const resource of resourceTransactions(transaction)) migration.retire(resource, journal, transaction);
}

function restorePlan(root, header, file, destination, result, directory, worktree, resource) {
  const key = createHash('sha256').update(header.id.toLowerCase()).digest('hex').slice(0, 40);
  const ownershipPath = path.join(root, 'conversation-ownership', `${key}.json`);
  const record = JSON.parse(fs.readFileSync(ownershipPath, 'utf8'));
  const journalDirectory = path.join(root, 'restore-transactions');
  fs.mkdirSync(journalDirectory, { recursive: true, mode: 0o700 });
  sync(root);

  if (worktree) worktree.recovery = path.join(root, 'restore-recovery', randomUUID());

  const transaction = {
    version: 2, root,
    receiptId: receiptIdentity(resource),
    result: { ...result, sessionId: header.id },
    trace: move(file, destination),
    moves: [
      [file.replace(/\.jsonl$/, '.snapshots'), destination.replace(/\.jsonl$/, '.snapshots')],
      [file.replace(/\.jsonl$/, '.diffs.json'), destination.replace(/\.jsonl$/, '.diffs.json')],
      [file.replace(/\.jsonl$/, '.diffs.json.lock'), destination.replace(/\.jsonl$/, '.diffs.json.lock')],
      [`${file}.loop-detection.json`, `${destination}.loop-detection.json`],
    ].flatMap(([source, target]) => exists(source) ? [move(source, target)] : []),
    ownership: {
      path: ownershipPath,
      initial: fs.readFileSync(ownershipPath, 'utf8'),
      before: JSON.stringify({ ...record, path: file, deleted: true, client: null }),
      after: JSON.stringify({ ...record, path: destination, deleted: false, client: null }),
    },
    directory: directory ? move(directory.source, directory.destination) : undefined,
    worktree,
    ...resourceFields(resource),
  };

  const journal = path.join(journalDirectory, `${key}.json`);
  require('./restore-records.cjs').write(journal, JSON.stringify(transaction));

  return { transaction, journal };
}

function receiptIdentity(resource) { return resource?.change?.operationId ?? resource?.migration?.operationId ?? randomUUID(); }

function resourceFields(resource) {
  return { resource: resource?.change, directoryCopy: resource?.directoryCopy, migration: resource?.migration, container: resource?.migration?.container };
}

function restoreLocked(root, header, file, destination, result, directory, worktree, resource) {
  const { transaction, journal } = restorePlan(root, header, file, destination, result, directory, worktree, resource);
  const entries = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(JSON.parse);
  const ownershipPath = transaction.ownership.path;

  try {
    goalAssets.retainHistory(root, entries, header.id, destination);
    write(ownershipPath, transaction.ownership.before);
    migration.preparePin(transaction, journal);

    if (worktree) prepareWorktree(worktree, transaction, journal);
    shared.copyDirectory(transaction, journal);

    if (transaction.directory) { transactionIO.mkdir(path.dirname(transaction.directory.destination)); syncTree(transaction.directory.source); syncParents(path.dirname(transaction.directory.destination)); performMove(transaction.directory); }

    for (const item of transaction.moves) { syncTree(item.source); performMove(item); }

    write(ownershipPath, transaction.ownership.after);
    shared.seal(root, transaction, journal);
    migration.seal(root, transaction, journal);
    syncTree(file);
    receipts.publish(root, transaction);
    performMove(transaction.trace);
  } catch (error) {
    if (!committed(transaction)) {
      try { finishRollback(root, transaction, journal); }
      catch (failure) { throw new Error(`${error.message}\nRestore recovery is pending: ${failure.message}`); }

      throw error;
    }
  }

  try { finishCommit(transaction, journal); }
  catch (error) { console.error(`Restore committed; recovery will retry: ${error.message}`); }

  return transaction.result;
}

function resourceTransactions(transaction) { return transaction.resources ?? [transaction]; }

function validateTransaction(root, transaction, journal) {
  if (![1, 2, 3].includes(transaction.version)) throw new Error(`Unsupported restore transaction: ${journal}`);
  const sessions = transaction.result.sessions ?? [{ ...transaction.result, sourcePath: transaction.trace.source }];

  validateSessions(root, transaction, sessions);
  const allowed = sessions.flatMap(session => restoreMappings(session.sourcePath, session.sessionPath));

  if (transaction.moves.some(move => !allowed.some(([source, destination]) => move.source === source && move.destination === destination))) throw new Error('Invalid restore sidecar mapping');

  for (const directory of directories(transaction)) validateDirectory(root, { directory });

  for (const worktree of worktrees(transaction)) validateDirectory(root, { worktree });

  for (const resource of resourceTransactions(transaction)) { shared.validate(root, resource); migration.validate(root, resource); }
}

function validateSessions(root, transaction, sessions) {
  for (const [index, session] of sessions.entries()) {
    if (!transactionIO.inside(path.join(root, 'archived'), session.sourcePath) || !transactionIO.inside(path.join(root, 'sessions'), session.sessionPath)) throw new Error('Invalid restore transcript mapping');
    const key = createHash('sha256').update(session.sessionId.toLowerCase()).digest('hex').slice(0, 40);

    if (ownerships(transaction)[index]?.path !== path.join(root, 'conversation-ownership', `${key}.json`)) throw new Error('Invalid restore ownership mapping');
  }

}

function restoreMappings(source, destination) {
  return [['', ''], ['.snapshots', '.snapshots'], ['.diffs.json', '.diffs.json'], ['.diffs.json.lock', '.diffs.json.lock']].map(([left, right]) =>
    [left ? source.replace(/\.jsonl$/, left) : source, right ? destination.replace(/\.jsonl$/, right) : destination])
    .concat([[`${source}.loop-detection.json`, `${destination}.loop-detection.json`]]);
}

function validateDirectory(root, transaction) {
  const directory = transaction.directory;

  if (directory && (path.dirname(directory.source) !== path.join(root, 'archived-tmp') || !path.isAbsolute(directory.destination))) throw new Error('Invalid restore directory mapping');
  const worktree = transaction.worktree;

  if (!worktree) return;

  if (!path.isAbsolute(worktree.path) || !path.isAbsolute(worktree.repositoryRoot) || !worktree.reservation.startsWith('refs/piop-restore-transactions/')) throw new Error('Invalid restore worktree ownership');

  if (worktree.recovery && path.dirname(worktree.recovery) !== path.join(root, 'restore-recovery')) throw new Error('Invalid restore recovery directory');
}

module.exports = { exists, recover, restore, restoreGroup, restoredResult, lockStorage };
