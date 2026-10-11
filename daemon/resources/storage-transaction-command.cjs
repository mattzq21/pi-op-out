const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { hostScript, delegated } = require('./host-script.cjs');
const { lockStorage } = require('./storage-transaction-lock.cjs');
const { withReferencePublicationLock } = require('./storage-lock.cjs');
const transaction = require('./storage-transaction.cjs');

function areaRoot(target) {
  return fs.realpathSync(target.root || path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop', target.area === 'archived' ? 'archived' : 'sessions'));
}

const busy = { state: 'skipped', reason: 'busy' };

/** Runs operation while this process holds the storage lock. A child process may run this script again to hold it. */
function underStorageLock(root, nonblocking, operation) {
  const state = lockStorage(root, nonblocking);

  if (state === 'delegated') return delegated;

  if (state === 'busy') return busy;

  return operation();
}

async function nonblocking(root, operation) {
  return await withReferencePublicationLock(root, operation, true) ?? busy;
}

async function deleteSessions(request) {
  const targets = request.targets ?? [];

  if (!Array.isArray(targets) || !targets.length) throw new Error('Invalid session deletion targets');
  const roots = new Set(targets.map(target => path.dirname(areaRoot(target))));

  if (roots.size !== 1) throw new Error('Session deletion targets must share storage');
  const [root] = roots;

  return underStorageLock(root, false, () => withReferencePublicationLock(root, () => transaction.deleteSessions(root, request)));
}

async function deleteBlank(target) {
  const blank = require('./blank-session-target.cjs');
  const candidate = blank.prepare(target);

  if (!candidate) return { state: 'skipped', reason: 'not-needed' };

  return underStorageLock(candidate.root, true, () => nonblocking(candidate.root, () => {
    const current = blank.prepare(target);

    if (!current || current.id !== candidate.id || current.target.path !== candidate.target.path) return { state: 'skipped', reason: 'not-needed' };

    return transaction.deleteSessions(current.root, { targets: [current.target], activeSessionIds: [] });
  }));
}

function storageRoot(request) {
  const configured = request.root || process.env.PIOP_RESTORE_ROOT || path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop');

  return fs.existsSync(configured) ? fs.realpathSync(configured) : path.resolve(configured);
}

async function locked(request, operation) {
  const root = storageRoot(request);

  return underStorageLock(root, false, () => withReferencePublicationLock(root, () => operation(root)));
}

async function recover(request) {
  const root = storageRoot(request);

  return underStorageLock(root, true, () => nonblocking(root, () => transaction.recover(root)));
}

async function start(request) {
  if (request.action === 'delete') return request.blank ? deleteBlank(request.blank) : deleteSessions(request);

  if (request.action === 'recover') return recover(request);

  if (request.action === 'archive') return locked(request, root => transaction.archiveSessions(root, request));

  if (request.action === 'restore') return locked(request, root => transaction.restoreSessions(root, request));

  if (request.action === 'result') return locked(request, root => transaction.restoredResult(root, request.path));
  throw new Error(`Unknown storage transaction action: ${request.action}`);
}

/** Committed and skipped outcomes are results. Rolled-back and pending outcomes are failures that carry their state. */
function settle(outcome) {
  if (outcome === delegated || outcome.state === 'committed' || outcome.state === 'skipped') return outcome;

  throw Object.assign(new Error(outcome.error ?? `Storage transaction ${outcome.state}`), { state: outcome.state, warning: outcome.warning });
}

// Every write happens inside a journaled transaction that reports its own state, so an error that reaches here changed nothing.
hostScript(request => start(request).then(settle, error => { throw Object.assign(new Error(error?.message ?? String(error)), { state: 'rolled-back' }); }));
