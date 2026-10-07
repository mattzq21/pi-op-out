const { runWithStorageLock } = require('./storage-lock.cjs');
const { recoverStorage } = require('./storage-recovery.cjs');
const { publish, remove } = require('./fork-transaction.cjs');

const request = JSON.parse(process.argv[1]);

runWithStorageLock(request.root, () => {
  recoverStorage(request.root);

  if (request.action === 'remove') remove(request.root, request);
  else publish(request.root, request);
});
