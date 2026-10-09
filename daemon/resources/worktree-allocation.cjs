const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');

function absent(directory) {
  try { fs.lstatSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }

  throw new Error(`Worktree directory already exists: ${directory}`);
}

function reserve(db, container, body) {
  db.exec('BEGIN IMMEDIATE');
  absent(container);
  const previous = db.prepare('SELECT metadata_json FROM worktree_allocations WHERE container=?').get(container);

  if (previous && JSON.parse(previous.metadata_json).creating) throw new Error(`Worktree creation is unfinished: ${container}`);
  db.prepare('INSERT INTO worktree_allocations VALUES (?, ?) ON CONFLICT(container) DO UPDATE SET metadata_json=excluded.metadata_json').run(container, body);
  db.exec('COMMIT');
}

function sync(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);

  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function createDirectory(container) {
  fs.mkdirSync(container, { mode: 0o700 });
  const info = fs.lstatSync(container, { bigint: true });

  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Worktree creation directory changed');

  for (const directory of [container, path.dirname(container), path.dirname(path.dirname(container))]) sync(directory);

  return `${info.dev}:${info.ino}`;
}

function create(container, target, branch, parentBranch) {
  if (path.dirname(target) !== container || path.normalize(target) !== target) throw new Error('Invalid worktree target');
  const root = path.dirname(path.dirname(container));

  if (path.dirname(container) !== path.join(root, 'worktrees') || !/^[a-f0-9]{4}$/.test(path.basename(container))) throw new Error('Invalid worktree container');
  const db = database.open(root);
  const pending = JSON.stringify({ creating: true, branch, parentBranch, allocation: { version: 1, target } });

  try {
    reserve(db, container, pending);
    const identity = createDirectory(container);
    const record = { branch, parentBranch, containerIdentity: identity, allocation: { version: 1, identity, target } };
    const saved = db.prepare('UPDATE worktree_allocations SET metadata_json=? WHERE container=? AND metadata_json=?').run(JSON.stringify(record), container, pending);

    if (saved.changes !== 1) throw new Error('Worktree creation record changed');
  } finally { db.close(); }
}

module.exports = { create };
