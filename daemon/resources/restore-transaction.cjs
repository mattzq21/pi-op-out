const conversationStorage = require('./conversation-storage.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validReceipt } = require('./deletion-retention.cjs');
const transactionIO = require('./session-transactions.cjs');
const goalAssets = require('./session-broker/goal-assets.cjs');
const receipts = require('./restore-receipts.cjs');
const ownerLocks = require('./transaction-owner-locks.cjs');
const { lockStorage } = require('./storage-transaction-lock.cjs');

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

function rename(source, destination) {
  const expected = identity(source);
  execFileSync('mv', ['--no-clobber', '--no-copy', '--no-target-directory', '--', source, destination], { stdio: ['ignore', 'pipe', 'pipe', 3, 4, 5, 6] });
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

function ownerships(transaction) { return transaction.ownerships ?? [transaction.ownership]; }

function committed(transaction) { return matches(transaction.trace.destination, transaction.trace.identity); }

function receiptPath(root, source) {
  return path.join(root, 'restore-receipts', `${createHash('sha256').update(source).digest('hex')}.json`);
}

function restoredResult(root, source) {
  const result = receipts.result(root, source);

  if (result?.sessions && !validReceipt(receiptPath(root, source), new Set())) return null;

  return result;
}

function rollback(transaction) {
  validateRollbackSource(transaction);

  for (const item of [...transaction.moves].reverse()) undoMove(item);

  for (const ownership of ownerships(transaction)) {
    const current = conversationStorage.required(ownership.path);

    if (![ownership.initial, ownership.before, ownership.after].includes(current)) throw new Error('Session ownership changed during restoration');
    conversationStorage.write(ownership.path, ownership.before);
  }
}

function validateRollbackSource(transaction) {
  if (!matches(transaction.trace.source, transaction.trace.identity) || exists(transaction.trace.destination)) throw new Error('Session files changed during restoration; recovery retained');
}

function cleanup(journal) { require('./restore-records.cjs').remove(journal); }

function finishCommit(transaction, journal) {
  const root = path.dirname(path.dirname(journal));
  require('./session-database.cjs').movePaths(root, [transaction.trace, ...transaction.moves].filter(item => item.destination.endsWith('.jsonl')));

  for (const item of [transaction.trace, ...transaction.moves]) {
    if (!item.destination.endsWith('.jsonl')) continue;
    require('./transcript-metadata.cjs').remember(item.destination);
  }

  if (!transaction.committed) {
    sync(path.dirname(transaction.trace.destination));
    sync(path.dirname(transaction.trace.source));
    transaction.committed = true;
    require('./restore-records.cjs').write(journal, JSON.stringify(transaction));
  }

  cleanup(journal);
}

function recover(root) {
  for (const journal of require('./restore-records.cjs').list(root)) {
    const transaction = require('./restore-records.cjs').read(journal).value;

    validateTransaction(root, transaction, journal);

    const ids = [];
    ownerLocks.withOwners(root, ids, [], () => {
      if (transaction.committed || committed(transaction)) finishCommit(transaction, journal);
      else { finishRollback(root, transaction, journal); }
    });
  }
}

function sessionTransaction(root, { header, file, destination, result }) {
  const key = createHash('sha256').update(header.id.toLowerCase()).digest('hex').slice(0, 40);
  const ownershipPath = path.join(root, 'conversation-ownership', `${key}.json`);
  const record = JSON.parse(conversationStorage.required(ownershipPath));

  return {
    result: { ...result, sessionId: header.id },
    trace: move(file, destination),
    moves: [
      [file.replace(/\.jsonl$/, '.snapshots'), destination.replace(/\.jsonl$/, '.snapshots')],
      [`${file}.loop-detection.json`, `${destination}.loop-detection.json`],
    ].flatMap(([source, target]) => exists(source) ? [move(source, target)] : []),
    ownership: {
      initial: conversationStorage.required(ownershipPath),
      path: ownershipPath,
      before: JSON.stringify({ ...record, path: file, deleted: true, client: null }),
      after: JSON.stringify({ ...record, path: destination, deleted: false, client: null }),
    },
  };
}

function publishRestoration(root, transaction) {
  for (const item of transaction.moves) { syncTree(item.source); performMove(item); }

  for (const ownership of transaction.ownerships) conversationStorage.write(ownership.path, ownership.after);
  syncTree(transaction.trace.source);
  receipts.publish(root, transaction);
  performMove(transaction.trace);
}

function restoreGroup(root, records) {
  const ids = [];

  return ownerLocks.withOwners(root, ids, records.map(record => record.header.id), () => restoreGroupLocked(root, records));
}

function restoreGroupLocked(root, records) {
  const sessions = records.map(record => sessionTransaction(root, record));
  const primary = sessions[0];

  const transaction = {
    version: 3, root, receiptId: randomUUID(),
    ownership: primary.ownership,
    result: { ...primary.result, sessions: sessions.map(session => ({ ...session.result, sourcePath: session.trace.source })) },
    trace: primary.trace,
    moves: [...sessions.flatMap(session => session.moves), ...sessions.slice(1).map(session => session.trace)],
    ownerships: sessions.map(session => session.ownership),
  };

  if (Buffer.byteLength(JSON.stringify(transaction.result)) + 1 > 64 * 1024 * 1024) throw new Error('Restore group is too large; restore fewer conversations at a time');

  const journalDirectory = path.join(root, 'restore-transactions');
  fs.mkdirSync(journalDirectory, { recursive: true, mode: 0o700 });
  sync(root);

  const key = createHash('sha256').update(primary.result.sessionId.toLowerCase()).digest('hex').slice(0, 40);

  const journal = path.join(journalDirectory, `${key}.json`);

  require('./restore-records.cjs').write(journal, JSON.stringify(transaction));

  try {
    for (const record of records) goalAssets.retainHistory(root, record.entries, record.header.id, record.destination);

    for (const ownership of transaction.ownerships) conversationStorage.write(ownership.path, ownership.before);
    publishRestoration(root, transaction);
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

function finishRollback(root, transaction, journal) {
  rollback(transaction);
  receipts.discardRolledBack(root, transaction, journal);
  cleanup(journal);

  try { receipts.prune(root); }
  catch (error) { console.error(`Restore rolled back; receipt pruning will retry: ${error.message}`); }
}

function validateTransaction(root, transaction, journal) {
  if (transaction.version !== 3) throw new Error(`Unsupported restore transaction: ${journal}`);
  const sessions = transaction.result.sessions ?? [{ ...transaction.result, sourcePath: transaction.trace.source }];

  validateSessions(root, transaction, sessions);
  const allowed = sessions.flatMap(session => restoreMappings(session.sourcePath, session.sessionPath));

  if (transaction.moves.some(move => !allowed.some(([source, destination]) => move.source === source && move.destination === destination))) throw new Error('Invalid restore sidecar mapping');

}

function validateSessions(root, transaction, sessions) {
  for (const [index, session] of sessions.entries()) {
    if (!transactionIO.inside(path.join(root, 'archived'), session.sourcePath) || !transactionIO.inside(path.join(root, 'sessions'), session.sessionPath)) throw new Error('Invalid restore transcript mapping');
    const key = createHash('sha256').update(session.sessionId.toLowerCase()).digest('hex').slice(0, 40);

    if (ownerships(transaction)[index]?.path !== path.join(root, 'conversation-ownership', `${key}.json`)) throw new Error('Invalid restore ownership mapping');
  }

}

function restoreMappings(source, destination) {
  return [['', ''], ['.snapshots', '.snapshots']].map(([left, right]) =>
    [left ? source.replace(/\.jsonl$/, left) : source, right ? destination.replace(/\.jsonl$/, right) : destination])
    .concat([[`${source}.loop-detection.json`, `${destination}.loop-detection.json`]]);
}

module.exports = { exists, recover, restoreGroup, restoredResult, lockStorage };
