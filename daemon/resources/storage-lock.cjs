const { acquireReferencePublicationLock } = require('./session-broker/reference-publication-lock.cjs');

async function withReferencePublicationLock(root, operation, nonblocking = false) {
  const release = acquireReferencePublicationLock(root, false, nonblocking);

  if (!release) return;

  try { return await operation(); }
  finally { release(); }
}

module.exports = { withReferencePublicationLock, acquireReferencePublicationLock };
