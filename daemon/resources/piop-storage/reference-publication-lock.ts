import * as storageLocks from '../storage-locks.ts';

// The reference publication lock of a storage folder. Chats that save goal attachments and references take it shared;
// archive, restore and delete take it exclusive while they move chats.
function name(root) { return 'reference-publication:' + root; }

function acquireReferencePublicationLock(root: string, shared?: boolean, nonblocking?: false): () => void;
function acquireReferencePublicationLock(root: string, shared: boolean, nonblocking: boolean): (() => void) | undefined;
function acquireReferencePublicationLock(root: string, shared = false, nonblocking = false): (() => void) | undefined {
  return storageLocks.lockSync(name(root), { shared, wait: !nonblocking, busy: 'Chat storage is busy with another change. Try again.' });
}

async function acquireReferencePublicationLockAsync(root): Promise<() => void> {
  // It waits without a time limit, so it always gets the lock.
  return storageLocks.lock(name(root), { shared: true }) as Promise<() => void>;
}

export { acquireReferencePublicationLock, acquireReferencePublicationLockAsync };
