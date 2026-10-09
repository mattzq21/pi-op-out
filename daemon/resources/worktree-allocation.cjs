const fs = require('node:fs');
const path = require('node:path');
const database = require('./session-database.cjs');
const { execFileSync } = require('node:child_process');

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

function locked(root, operation, optional = false) {
  const fd = fs.openSync(path.join(root, 'worktree-allocation.lock'), fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);

  try {
    try { execFileSync('flock', ['--exclusive', ...(optional ? ['--nonblock'] : []), '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] }); }
    catch (error) { if (optional && error.status === 1) return; throw error; }

    return operation();
  } finally { fs.closeSync(fd); }
}

function create(container, target, branch, parentBranch) {
  return locked(path.dirname(path.dirname(container)), () => createLocked(container, target, branch, parentBranch));
}

function createLocked(container, target, branch, parentBranch) {
  if (path.dirname(target) !== container || path.normalize(target) !== target) throw new Error('Invalid worktree target');
  const root = path.dirname(path.dirname(container));

  if (path.dirname(container) !== path.join(root, 'worktrees') || !/^[a-f0-9]{4}$/.test(path.basename(container))) throw new Error('Invalid worktree container');
  const db = database.open(root);
  const parent = path.dirname(container);
  const parentInfo = fs.lstatSync(parent, { bigint: true });

  if (!parentInfo.isDirectory() || fs.realpathSync(parent) !== parent) throw new Error('Invalid worktree allocation parent');
  const pending = JSON.stringify({ creating: true, parentIdentity: `${parentInfo.dev}:${parentInfo.ino}`, branch, parentBranch, allocation: { version: 1, target } });

  try {
    reserve(db, container, pending);
    db.exec('BEGIN IMMEDIATE');

    if (db.prepare('SELECT metadata_json FROM worktree_allocations WHERE container=?').get(container)?.metadata_json !== pending) throw new Error('Worktree allocation was recovered before creation');
    const identity = createDirectory(container);
    const record = { branch, parentBranch, containerIdentity: identity, allocation: { version: 1, identity, target } };
    const saved = db.prepare('UPDATE worktree_allocations SET metadata_json=? WHERE container=? AND metadata_json=?').run(JSON.stringify(record), container, pending);

    if (saved.changes !== 1) throw new Error('Worktree creation record changed');
    db.exec('COMMIT');
  } finally { db.close(); }
}

function metadata(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
}

function removeEmpty(container, expected) {
  const info = metadata(container);

  if (!info) {
    const parent = path.dirname(container);
    sync(metadata(parent) ? parent : path.dirname(parent));

    return true;
  }

  if (!info.isDirectory() || `${info.dev}:${info.ino}` !== expected) return false;
  const entries = fs.readdirSync(container, { withFileTypes: true });

  if (!entries.every(entry => entry.isFile() && entry.name === 'parent.json')) return false;

  for (const entry of entries) fs.unlinkSync(path.join(container, entry.name));

  try { fs.rmdirSync(container); }
  catch (error) { if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) return false; throw error; }

  sync(path.dirname(container));

  return true;
}

function cleanup(target) {
  const container = path.dirname(target);
  const root = path.dirname(path.dirname(container));

  if (path.dirname(container) !== path.join(root, 'worktrees') || !/^[a-f0-9]{4}$/.test(path.basename(container))) throw new Error('Invalid worktree container');

  if (metadata(target)) return;
  const db = database.open(root);

  try {
    db.exec('BEGIN IMMEDIATE');
    cleanupRecord(db, container, target);
    db.exec('COMMIT');
  } finally { db.close(); }
}

function cleanupRecord(db, container, target) {
  if (metadata(target)) return;
  const row = db.prepare('SELECT metadata_json FROM worktree_allocations WHERE container=?').get(container);

  if (!row) return;
  const saved = JSON.parse(row.metadata_json);

  if (saved.creating || !saved.containerIdentity) return;

  if (saved.allocation && saved.allocation.target !== target) return;

  if (removeEmpty(container, saved.containerIdentity)) db.prepare('DELETE FROM worktree_allocations WHERE container=? AND metadata_json=?').run(container, row.metadata_json);
}

function recover(root) {
  return locked(root, () => recoverLocked(root), true);
}

function recoverLocked(root) {
  const db = database.open(root);

  try {
    db.exec('BEGIN IMMEDIATE');

    for (const row of db.prepare('SELECT container, metadata_json FROM worktree_allocations').all()) recoverAllocation(db, root, row);
    db.exec('COMMIT');
  } finally { db.close(); }
}

function emptyOwnedDirectory(directory, info) {
  return info.isDirectory() && (Number(info.mode) & 0o777) === 0o700
    && (!process.getuid || Number(info.uid) === process.getuid()) && fs.readdirSync(directory).length === 0;
}

function recoverAllocation(db, root, row) {
  const saved = JSON.parse(row.metadata_json);

  if (!saved.creating) return;
  const parent = path.join(root, 'worktrees');

  if (path.dirname(row.container) !== parent || !/^[a-f0-9]{4}$/.test(path.basename(row.container))) throw new Error('Invalid pending worktree allocation');
  const info = metadata(row.container);
  const parentInfo = metadata(parent);

  if (!parentInfo || `${parentInfo.dev}:${parentInfo.ino}` !== saved.parentIdentity || fs.realpathSync(parent) !== parent) return;

  if (info) {
    if (!emptyOwnedDirectory(row.container, info)) return;
    fs.rmdirSync(row.container);
  }

  sync(parent);
  db.prepare('DELETE FROM worktree_allocations WHERE container=? AND metadata_json=?').run(row.container, row.metadata_json);
}

module.exports = { create, cleanup, recover };
