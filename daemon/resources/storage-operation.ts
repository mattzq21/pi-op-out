import fs from 'node:fs';
import path from 'node:path';
import * as storageLocks from './storage-locks.ts';
import { withStorage } from './piop-storage/maintenance.ts';
import * as transaction from './storage-transaction.ts';
import * as BlankSessionTarget from './blank-session-target.ts';

const busy = { state: 'skipped', reason: 'busy' };

const cancelled = { state: 'cancelled' };

// The restore and session transaction locks of root. Code that the operation calls takes the transaction lock again.
function lockAll(root, nonblocking) {
  const restore = storageLocks.lockSync('restore:' + root, { wait: !nonblocking });

  if (!restore) return undefined;
  const transactions = storageLocks.lockSync('session-transactions:' + root, { wait: !nonblocking });

  if (!transactions) { restore(); return undefined; }

  return () => { transactions(); restore(); };
}

async function underStorageLock(context, nonblocking, operation) {
  const release = lockAll(context.root, nonblocking);

  if (!release) return busy;

  try {
    if (!context.begin()) return cancelled;

    return await operation();
  } finally { release(); }
}

async function nonblocking(root, operation) {
  return await withStorage(root, operation, true) ?? busy;
}

function checkTarget(context, target) {
  if (!['sessions', 'archived'].includes(target?.area) || typeof target.path !== 'string') throw new Error('Invalid session deletion target');

  if (path.dirname(fs.realpathSync(path.join(context.root, target.area))) !== context.root) throw new Error('Session deletion targets must share storage');
}

async function deleteSessions(context, request) {
  const targets = request.targets ?? [];

  if (!Array.isArray(targets) || !targets.length) throw new Error('Invalid session deletion targets');
  targets.forEach(target => checkTarget(context, target));
  const root = context.root;

  return underStorageLock(context, false, () => withStorage(root, () => transaction.deleteSessions(root, request)));
}

async function deleteBlank(context, target) {
  const blank = BlankSessionTarget;
  const request = { ...target, root: path.join(context.root, 'sessions') };
  const candidate = blank.prepare(request);

  if (!candidate) return { state: 'skipped', reason: 'not-needed' };

  if (candidate.root !== context.root) throw new Error('Blank session is outside the locked storage');

  return underStorageLock(context, true, () => nonblocking(candidate.root, () => {
    const current = blank.prepare(request);

    if (!current || current.id !== candidate.id || current.target.path !== candidate.target.path) return { state: 'skipped', reason: 'not-needed' };

    return transaction.deleteSessions(current.root, { targets: [current.target], activeSessionIds: [] });
  }));
}

async function locked(context, operation) {
  return underStorageLock(context, false, () => withStorage(context.root, () => operation(context.root)));
}

async function recover(context) {
  return underStorageLock(context, true, () => nonblocking(context.root, () => transaction.recover(context.root)));
}

async function start(context, request) {
  if (request.action === 'delete') return request.blank ? deleteBlank(context, request.blank) : deleteSessions(context, request);

  if (request.action === 'recover') return recover(context);

  if (request.action === 'archive') return locked(context, root => transaction.archiveSessions(root, request));

  if (request.action === 'restore') return locked(context, root => transaction.restoreSessions(root, request));

  if (request.action === 'result') return locked(context, root => transaction.restoredResult(root, request.path));
  throw new Error(`Unknown storage transaction action: ${request.action}`);
}

function settle(outcome) {
  if (outcome.state === 'committed' || outcome.state === 'skipped' || outcome.state === 'cancelled') return outcome;

  throw Object.assign(new Error(outcome.error ?? `Storage transaction ${outcome.state}`), { state: outcome.state, warning: outcome.warning });
}

function runStorageTransaction(context, request) {
  transaction.resetCrashPoint();

  return start(context, request).then(settle, error => { throw Object.assign(new Error(error?.message ?? String(error)), { state: 'rolled-back' }); });
}

export { runStorageTransaction };
