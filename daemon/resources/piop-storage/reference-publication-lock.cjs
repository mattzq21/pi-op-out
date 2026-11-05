const storageLocks = require('../storage-locks.cjs');

// The reference publication lock of a storage folder. Chats that save goal attachments and references take it shared;
// deletion takes it exclusive while it removes chats.
function name(root) { return 'reference-publication:' + root; }

function acquireReferencePublicationLock(root, shared = false, nonblocking = false) {
  return storageLocks.lockSync(name(root), { shared, wait: !nonblocking, busy: 'Chat storage is busy with another change. Try again.' });
}

async function acquireReferencePublicationLockAsync(root) {
  return storageLocks.lock(name(root), { shared: true });
}

module.exports = { acquireReferencePublicationLock, acquireReferencePublicationLockAsync };
