const { shellLock, bunExecutable } = require('./file-lock.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function lockStorage(root, nonblocking = false) {
  if (process.argv.at(-1) === '--storage-transaction-locked') {
    process.argv.pop();

    return true;
  }

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const notes = path.join(root, 'notes');
  fs.mkdirSync(notes, { recursive: true, mode: 0o700 });

  if (!fs.lstatSync(notes).isDirectory()) throw new Error('Invalid notes storage directory');
  const descriptors = [];

  try {
    for (const file of [path.join(root, 'session-transactions.lock'), path.join(notes, 'ownership.lock'), path.join(root, 'restore.lock'), path.join(root, 'note-mutations.lock')]) {
      const descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
      descriptors.push(descriptor);

      if (!fs.fstatSync(descriptor).isFile()) throw new Error('Invalid storage transaction lock');
    }

    const command = [4, 5, 3, 6].map(fd => `${shellLock(fd, nonblocking)} || exit $?`).join('; ') + '; exec "$@"';
    const child = spawnSync('sh', ['-c', command, 'piop-storage', process.execPath, ...process.execArgv, '--', ...process.argv.slice(1), '--storage-transaction-locked'], { env: { ...process.env, PIOP_BUN: bunExecutable() }, stdio: ['inherit', 'inherit', 'inherit', ...descriptors] });

    if (child.error) throw child.error;
    process.exitCode = transactionExitCode(child.status, nonblocking);

    return false;
  } finally { descriptors.forEach(descriptor => fs.closeSync(descriptor)); }
}

function transactionExitCode(status, nonblocking) { return nonblocking && status === 75 ? 0 : status ?? 1; }

module.exports = { lockStorage };
