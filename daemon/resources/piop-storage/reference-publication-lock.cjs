const { lockSync, lock } = require('../file-lock.cjs');
const fs = require('node:fs');
const path = require('node:path');

function openReference(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(path.join(root, 'reference-publication.lock'), fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);

  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Invalid reference publication lock');

    return descriptor;
  } catch (error) { fs.closeSync(descriptor); throw error; }
}

function finish(descriptor, status, stderr, nonblocking) {
  if (nonblocking && status === 75) { fs.closeSync(descriptor);

    return; }

  if (status !== 0) throw new Error(stderr.trim() || 'Could not lock reference publication');

  return () => fs.closeSync(descriptor);
}

function acquireReferencePublicationLock(root, shared = false, nonblocking = false) {
  const descriptor = openReference(root);

  try {
    return finish(descriptor, lockSync(descriptor, shared, nonblocking) ? 0 : 75, '', nonblocking);
  } catch (error) { fs.closeSync(descriptor); throw error; }
}

async function acquireReferencePublicationLockAsync(root) {
  const descriptor = openReference(root);

  try {
    return finish(descriptor, await lock(descriptor, true) ? 0 : 75, '', false);
  } catch (error) { fs.closeSync(descriptor); throw error; }
}

module.exports = { acquireReferencePublicationLock, acquireReferencePublicationLockAsync };
