const { acquireReferencePublicationLock } = require('./session-broker/reference-publication-lock.cjs');

function runWithStorageLock(root, operation, nonblocking = false) {
  return Promise.resolve().then(() => require('./storage-transaction-lock.cjs').lockStorage(root, nonblocking) ? operation() : undefined)
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

async function withReferencePublicationLock(root, operation, nonblocking = false) {
  const release = acquireReferencePublicationLock(root, false, nonblocking);

  if (!release) return;

  try { return await operation(); }
  finally { release(); }
}

module.exports = { runWithStorageLock, withReferencePublicationLock, acquireReferencePublicationLock };
