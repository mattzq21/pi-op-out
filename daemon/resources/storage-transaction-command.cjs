const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { lockStorage } = require('./storage-transaction-lock.cjs');
const { withReferencePublicationLock } = require('./storage-lock.cjs');
const transaction = require('./storage-transaction.cjs');

function areaRoot(target) {
  return fs.realpathSync(target.root || path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop', target.area === 'archived' ? 'archived' : 'sessions'));
}

function report(outcome) {
  if (!outcome) return;
  process.stdout.write(JSON.stringify(outcome) + '\n');
  process.exitCode = ['committed', 'skipped'].includes(outcome.state) ? 0 : 1;
}

function lock(root, nonblocking = false) {
  return lockStorage(root, nonblocking, () => report({ state: 'skipped', reason: 'busy' }));
}

async function nonblocking(root, operation) {
  return await withReferencePublicationLock(root, operation, true) ?? { state: 'skipped', reason: 'busy' };
}

async function deleteSessions(request) {
  const targets = request.targets ?? [];

  if (!Array.isArray(targets) || !targets.length) throw new Error('Invalid session deletion targets');
  const roots = new Set(targets.map(target => path.dirname(areaRoot(target))));

  if (roots.size !== 1) throw new Error('Session deletion targets must share storage');
  const [root] = roots;

  if (!lock(root)) return;

  return withReferencePublicationLock(root, () => transaction.deleteSessions(root, request));
}

async function deleteBlank(target) {
  const blank = require('./blank-session-target.cjs');
  const candidate = blank.prepare(target);

  if (!candidate) return { state: 'skipped', reason: 'not-needed' };
  if (!lock(candidate.root, true)) return;

  return nonblocking(candidate.root, () => {
    const current = blank.prepare(target);

    if (!current || current.id !== candidate.id || current.target.path !== candidate.target.path) return { state: 'skipped', reason: 'not-needed' };

    return transaction.deleteSessions(current.root, { targets: [current.target], activeSessionIds: [] });
  });
}

function storageRoot(request) {
  const configured = request.root || process.env.PIOP_RESTORE_ROOT || path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop');

  return fs.existsSync(configured) ? fs.realpathSync(configured) : path.resolve(configured);
}

async function locked(request, operation) {
  const root = storageRoot(request);

  if (!lock(root)) return;

  return withReferencePublicationLock(root, () => operation(root));
}

async function recover(request) {
  const root = storageRoot(request);

  if (!lock(root, true)) return;

  return nonblocking(root, () => transaction.recover(root));
}

async function start() {
  const request = JSON.parse(process.argv.slice(1).find(argument => argument.startsWith('{')) ?? 'null') ?? {};

  if (request.action === 'delete') return request.blank ? deleteBlank(request.blank) : deleteSessions(request);

  if (request.action === 'recover') return recover(request);

  if (request.action === 'archive') return locked(request, root => transaction.archiveSessions(root, request));

  if (request.action === 'restore') return locked(request, root => transaction.restoreSessions(root, request));

  if (request.action === 'result') return locked(request, root => transaction.restoredResult(root, request.path));
  throw new Error(`Unknown storage transaction action: ${request.action}`);
}

start().then(report, error => report({ state: 'pending', error: error.message }));
