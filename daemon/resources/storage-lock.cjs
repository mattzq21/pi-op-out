const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runWithStorageLock(root, operation, nonblocking = false) {
  return Promise.resolve().then(() => require('./storage-transaction-lock.cjs').lockStorage(root, nonblocking) ? operation() : undefined)
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

function acquireReferencePublicationLock(root, shared = false, nonblocking = false) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(path.join(root, 'reference-publication.lock'), fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);

  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Invalid reference publication lock');

    if (!lockReferenceDescriptor(descriptor, shared, nonblocking)) { fs.closeSync(descriptor);

      return; }

    return () => fs.closeSync(descriptor);
  } catch (error) { fs.closeSync(descriptor); throw error; }
}

function lockReferenceDescriptor(descriptor, shared, nonblocking) {
  const options = nonblocking ? ['--nonblock', '--conflict-exit-code', '75'] : [];
  const locked = spawnSync('flock', [shared ? '--shared' : '--exclusive', ...options, '3'], { stdio: ['ignore', 'pipe', 'pipe', descriptor] });

  if (locked.error) throw locked.error;

  if (nonblocking && locked.status === 75) return false;

  if (locked.status !== 0) throw new Error(locked.stderr.toString().trim() || 'Could not lock reference publication');

  return true;
}

async function withReferencePublicationLock(root, operation, nonblocking = false) {
  const release = acquireReferencePublicationLock(root, false, nonblocking);

  if (!release) return;

  try { return await operation(); }
  finally { release(); }
}

module.exports = { runWithStorageLock, withReferencePublicationLock, acquireReferencePublicationLock };
