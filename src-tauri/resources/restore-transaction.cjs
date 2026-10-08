const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const transactionIO = require('./session-transactions.cjs');
const goalAssets = require('./session-broker/goal-assets.cjs');
const receipts = require('./restore-receipts.cjs');
const shared = require('./archive-resource-restore.cjs');
const migration = require('./archive-resource-migration.cjs');
const ownerLocks = require('./transaction-owner-locks.cjs');

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
}

function rename(source, destination) {
  const expected = identity(source);
  execFileSync('mv', ['--no-clobber', '--no-copy', '--no-target-directory', '--', source, destination], { stdio: ['ignore', 'pipe', 'pipe', 3] });
  sync(path.dirname(destination));
  sync(path.dirname(source));

  if (exists(source) || !matches(destination, expected)) throw new Error(`Restoration move could not be verified: ${source}`);
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

function git(plan, args) {
  return execFileSync('git', ['-C', plan.repositoryRoot, '-c', 'core.fsync=all', '-c', 'core.fsyncMethod=fsync', ...args], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe', 3] }).trim();
}

function branchCommit(plan) {
  try { return git(plan, ['rev-parse', '--verify', `refs/heads/${plan.branch}`]); }
  catch (error) { if (error.status === 128) return undefined; throw error; }
}

function prepareWorktree(plan, transaction, journal) {
  transactionIO.mkdir(path.dirname(plan.staging));
  fs.mkdirSync(plan.staging, { mode: 0o700 });
  sync(path.dirname(plan.staging));
  plan.stagingIdentity = identity(plan.staging);
  write(journal, JSON.stringify(transaction));
  git(plan, ['update-ref', plan.reservation, plan.commit, '0'.repeat(plan.commit.length)]);
  const common = git(plan, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  syncTree(path.join(common, 'refs'));
  sync(common);
  git(plan, ['update-ref', '--create-reflog', '-m', plan.reservation, `refs/heads/${plan.branch}`, plan.commit, '0'.repeat(plan.commit.length)]);
  git(plan, ['worktree', 'add', plan.staging, plan.branch]);
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

function releaseReservation(transaction) {
  if (transaction.worktree?.recovery && exists(transaction.worktree.recovery)) {
    console.error(`Restore rollback data and its reservation ref were retained: ${transaction.worktree.recovery}`);

    return;
  }

  if (transaction.worktree && hasReservation(transaction.worktree)) git(transaction.worktree, ['update-ref', '-d', transaction.worktree.reservation, transaction.worktree.commit]);
}

function committed(transaction) { return matches(transaction.trace.destination, transaction.trace.identity); }

function restoredResult(root, source) {
  return receipts.result(root, source);
}

function rollback(root, transaction, journal) {
  if (!matches(transaction.trace.source, transaction.trace.identity) && !migration.sourcePresent(transaction)) throw new Error('Session files changed during restoration; recovery retained');

  if (exists(transaction.trace.destination)) throw new Error('Restoration destination changed; recovery retained');

  for (const item of [...transaction.moves].reverse()) undoMove(item);
  migration.rollback(transaction, journal);
  shared.rollback(root, transaction);

  if (transaction.directory) undoMove(transaction.directory);

  if (transaction.worktree) undoWorktree(transaction.worktree);
  const current = fs.readFileSync(transaction.ownership.path, 'utf8');

  if (![transaction.ownership.initial, transaction.ownership.before, transaction.ownership.after].includes(current)) throw new Error('Session ownership changed during restoration');
  write(transaction.ownership.path, transaction.ownership.before);
}

function cleanup(journal) { fs.unlinkSync(journal); sync(path.dirname(journal)); }

function finishRollback(root, transaction, journal) {
  rollback(root, transaction, journal);
  releaseReservation(transaction);
  receipts.discardRolledBack(root, transaction, journal);
  migration.retire(transaction, journal);
  cleanup(journal);

  try { receipts.prune(root); }
  catch (error) { console.error(`Restore rolled back; receipt pruning will retry: ${error.message}`); }
}

function finishCommit(transaction, journal) {
  shared.finish(path.dirname(path.dirname(journal)), transaction);

  if (!transaction.committed) {
    sync(path.dirname(transaction.trace.destination));
    sync(path.dirname(transaction.trace.source));
    transaction.committed = true;
    write(journal, JSON.stringify(transaction));
  }

  try { releaseReservation(transaction); migration.retire(transaction, journal); cleanup(journal); }
  catch (error) { console.error(`Restore committed; cleanup will retry: ${error.message}`); }
}

function recover(root) {
  const directory = path.join(root, 'restore-transactions');

  if (!exists(directory)) return;

  for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
    const journal = path.join(directory, name);
    const transaction = JSON.parse(fs.readFileSync(journal, 'utf8'));

    validateTransaction(root, transaction, journal);

    const ids = (transaction.migration?.owners ?? []).map(owner => owner.sessionId);
    ownerLocks.withOwners(root, ids, [], () => {
      if (transaction.committed || committed(transaction)) finishCommit(transaction, journal);
      else finishRollback(root, transaction, journal);
    });
  }
}

function validateTransaction(root, transaction, journal) {
  if (![1, 2].includes(transaction.version)) throw new Error(`Unsupported restore transaction: ${journal}`);

  if (!transactionIO.inside(path.join(root, 'archived'), transaction.trace.source) || !transactionIO.inside(path.join(root, 'sessions'), transaction.trace.destination)) throw new Error('Invalid restore transcript mapping');
  const key = createHash('sha256').update(transaction.result.sessionId.toLowerCase()).digest('hex').slice(0, 40);

  if (transaction.ownership.path !== path.join(root, 'conversation-ownership', `${key}.json`)) throw new Error('Invalid restore ownership mapping');
  const trace = transaction.trace;

  const allowed = ['.snapshots', '.diffs.json', '.diffs.json.lock'].map(suffix => [trace.source.replace(/\.jsonl$/, suffix), trace.destination.replace(/\.jsonl$/, suffix)]);
  allowed.push([`${trace.source}.loop-detection.json`, `${trace.destination}.loop-detection.json`]);

  if (transaction.moves.some(move => !allowed.some(([source, destination]) => move.source === source && move.destination === destination))) throw new Error('Invalid restore sidecar mapping');
  validateDirectory(root, transaction);
  shared.validate(root, transaction);
  migration.validate(root, transaction);
}

function validateDirectory(root, transaction) {
  const directory = transaction.directory;

  if (directory && (path.dirname(directory.source) !== path.join(root, 'archived-tmp') || !path.isAbsolute(directory.destination))) throw new Error('Invalid restore directory mapping');
  const worktree = transaction.worktree;

  if (!worktree) return;

  if (!path.isAbsolute(worktree.path) || !path.isAbsolute(worktree.repositoryRoot) || !worktree.reservation.startsWith('refs/piop-restore-transactions/')) throw new Error('Invalid restore worktree ownership');

  if (worktree.recovery && path.dirname(worktree.recovery) !== path.join(root, 'restore-recovery')) throw new Error('Invalid restore recovery directory');
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
  write(journal, JSON.stringify(transaction));

  return { transaction, journal };
}

function receiptIdentity(resource) { return resource?.change?.operationId ?? resource?.migration?.operationId ?? randomUUID(); }

function resourceFields(resource) {
  return { resource: resource?.change, directoryCopy: resource?.directoryCopy, migration: resource?.migration, container: resource?.migration?.container };
}

function restore(root, header, file, destination, result, directory, worktree, resource) {
  const ids = (resource?.migration?.owners ?? []).map(owner => owner.sessionId);

  return ownerLocks.withOwners(root, ids, [header.id], () => restoreLocked(root, header, file, destination, result, directory, worktree, resource));
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

module.exports = { exists, recover, restore, restoredResult };
