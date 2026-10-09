const records = require('./fork-preparation-records.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { Type } = require('typebox');
const { Check } = require('typebox/value');

const ownerSchema = Type.Object({ sessionId: Type.String({ pattern: '^[a-zA-Z0-9_-]+$' }), roots: Type.Array(Type.String()), repositories: Type.Optional(Type.Array(Type.String())), destination: Type.Optional(Type.String()) });

const sessionSchema = Type.Object({ type: Type.Literal('session'), id: Type.String() });

function sync(directory) {
  const file = fs.openSync(directory, 'r');

  try { fs.fsyncSync(file); } finally { fs.closeSync(file); }
}

function savedIdentity(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try {
    const buffer = Buffer.alloc(64 * 1024);
    const count = fs.readSync(descriptor, buffer);
    let header;

    try { header = JSON.parse(buffer.subarray(0, count).toString().split('\n')[0]); }
    catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }

    return Check(sessionSchema, header) ? header.id : undefined;
  } finally { fs.closeSync(descriptor); }
}

function savedOwners(root) {
  const database = require('./session-database.cjs').open(root);

  try {
    return new Set(database.prepare(`SELECT session_id FROM sessions WHERE session_path IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM session_deletion_tombstones WHERE session_id=lower(sessions.session_id))`)
      .all().map(row => row.session_id));
  } finally { database.close(); }
}

function git(root, args, input) {
  return execFileSync('git', ['-C', root, '-c', 'core.fsync=all', '-c', 'core.fsyncMethod=fsync', ...args], { encoding: 'utf8', input, timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function commonRepository(root) {
  if (!path.isAbsolute(root)) throw new Error('Invalid preparatory checkpoint repository');

  try { return git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']); }
  catch (error) {
    if (error.status === 128 && /not a git repository|No such file or directory/.test(String(error.stderr))) return undefined;
    throw error;
  }
}

function removeRefs(record) {
  const prefix = `refs/pi-session-snapshots/chats/${record.sessionId}/`;
  const legacy = `refs/pi-session-snapshots/${record.sessionId}`;
  const resolved = (record.repositories ?? record.roots).map(commonRepository);
  const repositories = new Set(resolved.filter(Boolean));

  for (const repository of repositories) {
    const references = git(repository, ['for-each-ref', '--format=%(refname) %(objectname)', prefix, legacy]).split('\n')
      .map(line => line.split(' ')).filter(([ref]) => ref.startsWith(prefix) || ref === legacy);

    if (references.length) git(repository, ['update-ref', '--stdin'], ['start', ...references.map(([ref, commit]) => `delete ${ref} ${commit}`), 'prepare', 'commit', ''].join('\n'));
  }

  return resolved.every(Boolean);
}

function removeCheckpoints(directory, published) {
  let complete = true;

  for (const row of require('./fork-preparation-records.cjs').read(directory)) {
    const record = JSON.parse(row.record_json);

    if (!Check(ownerSchema, record) || row.session_id !== record.sessionId) throw new Error('Invalid preparatory checkpoint owner');

    if (!published.has(record.sessionId) && !publishedDestination(record) && !removeRefs(record)) complete = false;
  }

  return complete;
}

function publishedDestination(record) {
  if (!record.destination) return false;

  if (!path.isAbsolute(record.destination) || !record.destination.endsWith('.jsonl')) throw new Error('Invalid prepared fork destination');

  try {
    const id = savedIdentity(record.destination);

    return id === undefined || id === record.sessionId;
  }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function removeDirectory(directory) {
  const parent = path.dirname(directory);
  const removing = path.basename(directory).startsWith('.cleanup-') ? directory : path.join(parent, `.cleanup-${path.basename(directory)}`);

  if (removing !== directory) { fs.renameSync(directory, removing); sync(parent); }

  fs.rmSync(removing, { recursive: true });
  sync(parent);
  records.remove(path.join(parent, path.basename(directory).replace(/^\.cleanup-/, '')));
  records.remove(removing);
}

function recoverDirectory(directory, owners) {
  const descriptor = fs.openSync(path.join(directory, 'active.lock'), fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);

  try {
    const locked = spawnSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', descriptor] });

    if (locked.error) throw locked.error;

    if (locked.status === 1) return;

    if (locked.status !== 0) throw new Error(locked.stderr.toString().trim() || 'Could not lock fork preparation');

    if (removeCheckpoints(directory, owners())) removeDirectory(directory);
  } finally { fs.closeSync(descriptor); }
}

function regularDirectory(directory) {
  try {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('Invalid fork preparation storage');

    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function existingPreparation(directory) {
  if (regularDirectory(directory)) return directory;
  const removing = path.join(path.dirname(directory), `.cleanup-${path.basename(directory)}`);

  return regularDirectory(removing) ? removing : undefined;
}

function recover(root) {
  const directory = path.join(root, 'fork-preparations');
  let published;

  const owners = () => {
    if (published) return published;
    published = savedOwners(root);

    return published;
  };

  for (const saved of require('./fork-preparation-records.cjs').list(root)) {
    if (path.dirname(saved) !== directory) throw new Error('Invalid fork preparation location');
    const preparation = existingPreparation(saved);

    if (!preparation) { require('./fork-preparation-records.cjs').remove(saved); continue; }

    if (path.basename(preparation).startsWith('.cleanup-')) removeDirectory(preparation);
    else recoverDirectory(preparation, owners);
  }
}

module.exports = { recover };
