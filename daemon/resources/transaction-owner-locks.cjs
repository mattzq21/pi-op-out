const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const io = require('./session-transactions.cjs');

const held = new Set();

function lock(file) {
  io.mkdir(path.dirname(file));

  if (fs.realpathSync(path.dirname(file)) !== path.dirname(file)) throw new Error('Transaction owner lock directory has ambiguous ancestry');
  const descriptor = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);

  if (!fs.fstatSync(descriptor).isFile()) { fs.closeSync(descriptor); throw new Error('Transaction owner lock is not a regular file'); }

  const result = spawnSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', descriptor] });

  if (result.error || result.status !== 0) {
    fs.closeSync(descriptor);
    throw new Error('A transaction owner is busy; close its conversation and retry: ' + file);
  }

  return descriptor;
}

function withFile(file, operation) {
  const descriptor = lock(file);

  try { return operation(); }
  finally { fs.closeSync(descriptor); }
}

function profileLocked(root) {
  const file = path.join(root, 'session-transactions.lock');
  const metadata = fs.fstatSync(3, { bigint: true });

  if (`${metadata.dev}:${metadata.ino}` !== io.identity(file)) throw new Error('Transaction owner mutation requires the inherited profile lock');
}

function withOwners(root, ids, borrowedIds, operation) {
  profileLocked(root);
  const borrowed = new Set(borrowedIds.map(id => id.toLowerCase()));
  const descriptors = [];
  const acquired = [];

  try {
    for (const id of [...new Set(ids.map(value => value.toLowerCase()))].sort()) acquireOwner(root, id, borrowed, descriptors, acquired);

    return operation();
  } finally {
    for (const descriptor of descriptors.reverse()) fs.closeSync(descriptor);

    for (const key of acquired) held.delete(key);
  }
}

function acquireOwner(root, id, borrowed, descriptors, acquired) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid transaction owner identity');
  const key = root + ':' + id;

  if (borrowed.has(id) || held.has(key)) return;
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 40);
  descriptors.push(lock(path.join(root, 'conversation-ownership', hash + '.lock')));
  descriptors.push(lock(path.join(root, 'session-claims', 'id-' + hash + '.lock')));
  held.add(key);
  acquired.push(key);
}

async function withOwnersAsync(root, ids, operation) {
  profileLocked(root);
  const descriptors = [];
  const acquired = [];

  try {
    for (const id of [...new Set(ids.map(value => value.toLowerCase()))].sort()) acquireOwner(root, id, new Set(), descriptors, acquired);

    return await operation();
  } finally {
    for (const descriptor of descriptors.reverse()) fs.closeSync(descriptor);

    for (const key of acquired) held.delete(key);
  }
}

module.exports = { withFile, withOwners, withOwnersAsync };
