const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const database = require('./session-database.cjs');
const io = require('./session-transactions.cjs');

function open(plan) {
  const db = database.open(path.dirname(path.dirname(plan.container)));
  db.exec('CREATE TABLE IF NOT EXISTS worktree_reference_updates (owner TEXT NOT NULL, kind TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(owner, kind))');

  db.exec('CREATE TABLE IF NOT EXISTS worktree_reference_objects (owner TEXT NOT NULL, object TEXT NOT NULL, PRIMARY KEY(owner, object))');

  return db;
}

function seed(file) {
  fs.rmSync(file, { force: true });
  const fd = fs.openSync(file, 'wx', 0o600);

  try { fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }

  io.sync(path.dirname(file));

  return { file, identity: io.identity(file) };
}

function owned(file, seed) {
  return Boolean(io.exists(file)) && io.identity(file) === seed.identity;
}

function acquire(file, seed) {
  if (!owned(seed.file, seed)) throw new Error('Worktree reference preparation changed; retained');

  try { fs.linkSync(seed.file, file); }
  catch (error) { if (error.code !== 'EEXIST' || !owned(file, seed)) throw new Error('Git reference is locked by another operation'); }

  io.sync(path.dirname(file));
}

function release(file, seed) {
  if (!owned(file, seed)) return;
  fs.unlinkSync(file);
  io.sync(path.dirname(file));
}

function write(seed, contents) {
  const fd = fs.openSync(seed.file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);

  try {
    if (io.identity(seed.file) !== seed.identity) throw new Error('Git reference preparation changed');
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function withoutReference(contents, reference, expected) {
  const suffix = Buffer.from(` ${reference}`);
  const lines = [];
  let start = 0;
  let removed = false;

  while (start < contents.length) {
    const newline = contents.indexOf(10, start);
    const end = newline < 0 ? contents.length : newline + 1;
    const line = contents.subarray(start, end);
    const body = newline < 0 ? line : line.subarray(0, -1);
    const match = body.subarray(-suffix.length).equals(suffix);

    if (match && !expected.includes(body.subarray(0, body.length - suffix.length).toString('ascii'))) throw new Error('Packed worktree reference changed; retained');

    if (!match && !(removed && line[0] === 94)) lines.push(line);
    removed = match;
    start = end;
  }

  return Buffer.concat(lines);
}

function removePacked(plan, record) {
  const destination = path.join(plan.common, 'packed-refs');
  const lock = destination + '.lock';
  acquire(lock, record.packed);
  const contents = io.exists(destination) ? fs.readFileSync(destination) : Buffer.alloc(0);
  const updated = withoutReference(contents, record.ref, record.expectedObjects);

  if (!updated.equals(contents)) {
    if (owned(destination, record.packed)) throw new Error('Published Git reference data changed; retained');
    write(record.packed, updated);
    fs.renameSync(lock, destination);
    io.sync(plan.common);
    acquire(lock, record.packed);
  }
}

function finish(plan, record) {
  const destination = path.join(plan.common, record.ref);
  const lock = destination + '.lock';
  acquire(lock, record.loose);

  try { publishReference(plan, record, destination, lock); }
  finally {
    if (record.packed) release(path.join(plan.common, 'packed-refs.lock'), record.packed);
    release(lock, record.loose);
  }
}

function publishReference(plan, record, destination, lock) {
  if (record.branch) verifyBranch(plan, record, destination);

  if (record.object) {
    if (!owned(destination, record.loose)) write(record.loose, record.object + '\n');
    fs.renameSync(lock, destination);
    io.sync(path.dirname(destination));

    return;
  }

  if (io.exists(destination)) {
    if (!fs.lstatSync(destination).isFile() || fs.readFileSync(destination, 'utf8').trim() !== record.expected) throw new Error('Worktree reference changed; retained');
  }

  removePacked(plan, record);

  if (io.exists(destination)) { fs.unlinkSync(destination); io.sync(path.dirname(destination)); }
}

function verifyBranch(plan, record, destination) {
  try {
    execFileSync('git', ['-C', plan.common, 'symbolic-ref', '--quiet', record.ref], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (error.status === 1) return verifyDirectBranch(plan, record, destination);
    throw error;
  }

  throw new Error('Worktree branch was replaced with a symbolic reference; retained');
}

function verifyDirectBranch(plan, record, destination) {
  let current;

  try { current = execFileSync('git', ['-C', plan.common, 'rev-parse', '--verify', '--quiet', record.ref], { encoding: 'utf8' }).trim(); }
  catch (error) { if (error.status !== 1) throw error; }

  if (!current) return;
  const written = fs.readFileSync(record.loose.file, 'utf8') === record.object + '\n';

  if (current !== record.object || (!owned(destination, record.loose) && !written)) throw new Error('Worktree branch already exists or changed; retained');
}

function prepare(plan, kind, object) {
  const ref = kind === 'branch' ? `refs/heads/${plan.branch}` : `refs/piop-worktree-${kind}/${plan.id}`;
  io.mkdir(path.dirname(path.join(plan.common, ref)));
  const directory = path.join(plan.common, 'piop-reference-updates');
  io.mkdir(directory);
  const prefix = path.join(directory, `${plan.id}-${kind}`);

  const expected = kind === 'creations' ? plan.base : plan.contentObject;

  if (!object && !expected) throw new Error('Worktree reference deletion has no saved value');

  return { ref, object, expected, expectedObjects: [expected], branch: kind === 'branch', loose: seed(prefix + '.ref'), packed: object ? null : seed(prefix + '.packed') };
}

function complete(db, plan, kind, record) {
  if (kind === 'content' && record.object) db.prepare('INSERT OR IGNORE INTO worktree_reference_objects VALUES (?, ?)').run(plan.id, record.object);
  finish(plan, record);

  if (record.branch) return;
  db.prepare('DELETE FROM worktree_reference_updates WHERE owner=? AND kind=?').run(plan.id, kind);
  release(record.loose.file, record.loose);

  if (record.packed) release(record.packed.file, record.packed);

  if (kind === 'content' && !record.object) db.prepare('DELETE FROM worktree_reference_objects WHERE owner=?').run(plan.id);
}

function update(plan, kind, object, descriptor) {
  if (!['creations', 'content', 'branch'].includes(kind) || !/^[a-f0-9-]{36}$/.test(plan.id) || !Number.isInteger(descriptor)) throw new Error('Invalid worktree reference owner');
  const db = open(plan);

  try {
    const previous = db.prepare('SELECT record_json FROM worktree_reference_updates WHERE owner=? AND kind=?').get(plan.id, kind);

    if (previous) {
      const record = JSON.parse(previous.record_json);
      complete(db, plan, kind, record);

      if (record.object === object) return;
    }

    const record = prepare(plan, kind, object);

    if (kind === 'content' && !object) record.expectedObjects = db.prepare('SELECT object FROM worktree_reference_objects WHERE owner=?').all(plan.id).map(row => row.object);
    db.prepare('INSERT INTO worktree_reference_updates VALUES (?, ?, ?)').run(plan.id, kind, JSON.stringify(record));
    complete(db, plan, kind, record);
  } finally { db.close(); }
}

function releaseBranch(plan) {
  const db = open(plan);

  try {
    const row = db.prepare("SELECT record_json FROM worktree_reference_updates WHERE owner=? AND kind='branch'").get(plan.id);

    if (!row) return;
    const record = JSON.parse(row.record_json);
    release(path.join(plan.common, record.ref + '.lock'), record.loose);
    db.prepare("DELETE FROM worktree_reference_updates WHERE owner=? AND kind='branch'").run(plan.id);
    release(record.loose.file, record.loose);
  } finally { db.close(); }
}

function releaseLocks(plan) {
  const db = open(plan);

  try {
    for (const row of db.prepare('SELECT record_json FROM worktree_reference_updates WHERE owner=?').all(plan.id)) {
      const record = JSON.parse(row.record_json);
      release(path.join(plan.common, record.ref + '.lock'), record.loose);

      if (record.packed) release(path.join(plan.common, 'packed-refs.lock'), record.packed);
    }
  } finally { db.close(); }
}

module.exports = { update, releaseBranch, releaseLocks };
