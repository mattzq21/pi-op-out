const { shellLock, bunExecutable } = require('./file-lock.cjs');
const { readRequestText, scriptLoader } = require('./host-script.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** Returns 'locked' when this process holds the storage lock, 'delegated' when a child process held it and wrote the reply, or 'busy'. */
function lockStorage(root, nonblocking = false) {
  if (process.argv.at(-1) === '--storage-transaction-locked') {
    process.argv.pop();

    return 'locked';
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

    const script = fs.openSync(process.argv[1], 'r');
    descriptors.push(script);
    const command = [4, 5, 3, 6].map(fd => `${shellLock(fd, nonblocking)} || exit $?`).join('; ') + '; exec "$@"';
    const child = spawnSync('sh', ['-c', command, 'piop-storage', process.execPath, '-e', scriptLoader, '--', '/proc/self/fd/7', ...process.argv.slice(2), '--storage-transaction-locked'], { env: { ...process.env, PIOP_BUN: bunExecutable() }, input: readRequestText(), stdio: ['pipe', 'inherit', 'inherit', ...descriptors] });

    if (child.error) throw child.error;

    if (nonblocking && child.status === 75) return 'busy';
    process.exitCode = child.status ?? 1;

    return 'delegated';
  } finally { descriptors.forEach(descriptor => fs.closeSync(descriptor)); }
}

module.exports = { lockStorage };
