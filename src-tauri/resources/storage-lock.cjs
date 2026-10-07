const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function lockedProcess(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const notes = path.join(root, 'notes');
  fs.mkdirSync(notes, { recursive: true, mode: 0o700 });

  if (!fs.lstatSync(notes).isDirectory()) throw new Error('Invalid notes storage directory');
  const descriptors = [];

  try {
    for (const file of [path.join(notes, 'ownership.lock'), path.join(root, 'restore.lock')]) descriptors.push(fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600));
    const child = spawnSync('sh', ['-c', 'flock --exclusive 3 || exit $?; flock --exclusive 4 || exit $?; exec "$@"', 'piop-storage', process.execPath, ...process.execArgv, '--', ...process.argv.slice(1), '--locked'], { stdio: ['inherit', 'inherit', 'inherit', ...descriptors] });

    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } finally { descriptors.forEach(descriptor => fs.closeSync(descriptor)); }
}

function runWithStorageLock(root, operation) {
  return Promise.resolve().then(() => process.argv.at(-1) === '--locked' ? operation() : lockedProcess(root))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

function acquireReferencePublicationLock(root, shared = false) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(path.join(root, 'reference-publication.lock'), fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);

  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Invalid reference publication lock');
    const locked = spawnSync('flock', [shared ? '--shared' : '--exclusive', '3'], { stdio: ['ignore', 'pipe', 'pipe', descriptor] });

    if (locked.error) throw locked.error;

    if (locked.status !== 0) throw new Error(locked.stderr.toString().trim() || 'Could not lock reference publication');

    return () => fs.closeSync(descriptor);
  } catch (error) { fs.closeSync(descriptor); throw error; }
}

async function withReferencePublicationLock(root, operation) {
  const release = acquireReferencePublicationLock(root);

  try { return await operation(); }
  finally { release(); }
}

module.exports = { runWithStorageLock, withReferencePublicationLock, acquireReferencePublicationLock };
