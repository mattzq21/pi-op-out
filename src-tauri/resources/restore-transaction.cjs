const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validReceipt, discardReceipt } = require('./deletion-retention.cjs');

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
  fs.renameSync(source, destination);
  sync(path.dirname(destination));
  sync(path.dirname(source));
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
  fs.mkdirSync(directory.staging, { mode: 0o700 });
  directory.stagingIdentity = identity(directory.staging);
  write(journal, JSON.stringify(transaction));
  fs.cpSync(directory.source, directory.staging, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });

  if (!matches(directory.source, directory.identity)) throw new Error(`Restoration files changed: ${directory.source}`);
  syncTree(directory.staging);
  syncParents(path.dirname(directory.destination));
  performMove({ source: directory.staging, destination: directory.destination, identity: directory.stagingIdentity });
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
    fs.rmSync(file, { recursive: true });
    sync(path.dirname(file));
  }
}

function git(plan, args) {
  return execFileSync('git', ['-C', plan.repositoryRoot, '-c', 'core.fsync=all', '-c', 'core.fsyncMethod=fsync', ...args], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe', 3, 4] }).trim();
}

function branchCommit(plan) {
  try { return git(plan, ['rev-parse', '--verify', `refs/heads/${plan.branch}`]); }
  catch (error) { if (error.status === 128) return undefined; throw error; }
}

function prepareWorktree(plan) {
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
  const pointer = path.join(directory, '.git');

  if (exists(pointer)) {
    const content = fs.readFileSync(pointer, 'utf8').trim();
    const registration = content.startsWith('gitdir: ') ? path.resolve(directory, content.slice(8)) : '';

    if (!registrations.includes(registration)) throw new Error(`Restored worktree was replaced: ${directory}`);
  } else if (directory !== plan.staging) throw new Error(`Restored worktree was replaced: ${directory}`);
  fs.rmSync(directory, { recursive: true });
  sync(path.dirname(directory));
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

  for (const registration of registrations) fs.rmSync(registration, { recursive: true });

  if (exists(worktrees)) sync(worktrees);
}

function hasReservation(plan) {
  try { git(plan, ['show-ref', '--verify', '--quiet', plan.reservation]);

  return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
}

function undoWorktree(plan) {
  if (!hasReservation(plan)) return;

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
    if (hasReservation(plan)) git(plan, ['update-ref', '-d', plan.reservation, plan.commit]);
  }
}

function committed(transaction) { return matches(transaction.trace.destination, transaction.trace.identity); }

function receiptPath(root, source) {
  return path.join(root, 'restore-receipts', `${createHash('sha256').update(source).digest('hex')}.json`);
}

function restoredResult(root, source) {
  const receipt = receiptPath(root, source);

  if (!exists(receipt)) return null;

  if (!validReceipt(receipt, new Set())) { discardReceipt(receipt);

    return null; }

  return JSON.parse(fs.readFileSync(receipt, 'utf8')).result;
}

function rollback(transaction) {
  if (!matches(transaction.trace.source, transaction.trace.identity) || exists(transaction.trace.destination)) throw new Error('Session files changed during restoration; recovery retained');

  for (const item of [...transaction.moves].reverse()) undoMove(item);

  for (const directory of [...directories(transaction)].reverse()) undoDirectory(directory);

  for (const worktree of [...worktrees(transaction)].reverse()) undoWorktree(worktree);

  for (const ownership of ownerships(transaction)) {
    const current = fs.readFileSync(ownership.path, 'utf8');

    if (current !== ownership.before && current !== ownership.after) throw new Error('Session ownership changed during restoration');
    write(ownership.path, ownership.before);
  }
}

function cleanup(journal) { fs.unlinkSync(journal); sync(path.dirname(journal)); }

function finishCommit(transaction, journal) {
  if (!transaction.committed) {
    sync(path.dirname(transaction.trace.destination));
    sync(path.dirname(transaction.trace.source));
    write(journal, JSON.stringify({ ...transaction, committed: true }));
  }

  try { releaseReservation(transaction); cleanup(journal); }
  catch (error) { console.error(`Restore committed; cleanup will retry: ${error.message}`); }
}

function recover(root) {
  const directory = path.join(root, 'restore-transactions');

  if (!exists(directory)) return;

  for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
    const journal = path.join(directory, name);
    const transaction = JSON.parse(fs.readFileSync(journal, 'utf8'));

    if (![1, 2, 3].includes(transaction.version)) throw new Error(`Unsupported restore transaction: ${journal}`);

    if (transaction.committed || committed(transaction)) finishCommit(transaction, journal);
    else { rollback(transaction); releaseReservation(transaction); cleanup(journal); }
  }
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
      [`${file}.loop-detection.json`, `${destination}.loop-detection.json`],
    ].flatMap(([source, target]) => exists(source) ? [move(source, target)] : []),
    ownership: {
      path: ownershipPath,
      before: JSON.stringify({ ...record, path: file, deleted: true, client: null }),
      after: JSON.stringify({ ...record, path: destination, deleted: false, client: null }),
    },
  };
}

function publishRestoration(root, transaction, journal) {
  for (const worktree of transaction.worktrees) prepareWorktree(worktree);

  for (const directory of transaction.directories) prepareDirectory(directory, transaction, journal);

  for (const directory of transaction.workingDirectories) {
    if (!fs.statSync(directory).isDirectory()) throw new Error(`The conversation working directory is unavailable: ${directory}`);
  }

  for (const item of transaction.moves) { syncTree(item.source); performMove(item); }

  for (const ownership of transaction.ownerships) write(ownership.path, ownership.after);
  syncTree(transaction.trace.source);
  fs.mkdirSync(path.join(root, 'restore-receipts'), { recursive: true, mode: 0o700 });
  sync(root);
  write(receiptPath(root, transaction.trace.source), JSON.stringify({ trace: transaction.trace, result: transaction.result }));
  performMove(transaction.trace);
}

function restoreGroup(root, records, directoryPlans = [], worktreePlans = []) {
  const sessions = records.map(record => sessionTransaction(root, record));
  const primary = sessions[0];

  const transaction = {
    version: 3,
    result: { ...primary.result, sessions: sessions.map(session => ({ ...session.result, sourcePath: session.trace.source })) },
    trace: primary.trace,
    moves: [...sessions.flatMap(session => session.moves), ...sessions.slice(1).map(session => session.trace)],
    ownerships: sessions.map(session => session.ownership),
    directories: directoryPlans.map(directory => ({ ...directory, ...move(directory.source, directory.destination) })),
    workingDirectories: [...new Set(records.map(record => record.header.cwd))],
    worktrees: worktreePlans,
  };

  if (Buffer.byteLength(JSON.stringify(transaction.result)) + 1 > 64 * 1024 * 1024) throw new Error('Restore group is too large; restore fewer conversations at a time');

  const journalDirectory = path.join(root, 'restore-transactions');
  fs.mkdirSync(journalDirectory, { recursive: true, mode: 0o700 });
  sync(root);

  const key = createHash('sha256').update(primary.result.sessionId.toLowerCase()).digest('hex').slice(0, 40);

  const journal = path.join(journalDirectory, `${key}.json`);

  for (const ownership of transaction.ownerships) write(ownership.path, ownership.before);
  write(journal, JSON.stringify(transaction));

  try {
    publishRestoration(root, transaction, journal);
  } catch (error) {
    if (!committed(transaction)) {
      try { rollback(transaction); releaseReservation(transaction); cleanup(journal); }
      catch (failure) { throw new Error(`${error.message}\nRestore recovery is pending: ${failure.message}`); }

      throw error;
    }
  }

  try { finishCommit(transaction, journal); }
  catch (error) { console.error(`Restore committed; recovery will retry: ${error.message}`); }

  return transaction.result;
}

function restore(root, header, file, destination, result, directory, worktree) {
  return restoreGroup(root, [{ header, file, destination, result }], directory ? [directory] : [], worktree ? [worktree] : []);
}

module.exports = { exists, recover, restore, restoreGroup, restoredResult };
