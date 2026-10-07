const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { Type } = require('typebox');
const { Check } = require('typebox/value');

const ownerSchema = Type.Object({ sessionId: Type.String({ pattern: '^[a-zA-Z0-9_-]+$' }), roots: Type.Array(Type.String()) });

const sessionSchema = Type.Object({ type: Type.Literal('session'), id: Type.String() });

function sync(directory) {
  const file = fs.openSync(directory, 'r');

  try { fs.fsyncSync(file); } finally { fs.closeSync(file); }
}

function children(directory) {
  try { return fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function savedIdentity(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try {
    const buffer = Buffer.alloc(64 * 1024);
    const count = fs.readSync(descriptor, buffer);
    const header = JSON.parse(buffer.subarray(0, count).toString().split('\n')[0]);

    return Check(sessionSchema, header) ? header.id : undefined;
  } finally { fs.closeSync(descriptor); }
}

function savedOwners(directory, owners) {
  for (const entry of children(directory)) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory() && !entry.name.endsWith('.snapshots')) savedOwners(file, owners);

    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const id = savedIdentity(file);

    if (id) owners.add(id);
  }
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
  const repositories = new Set(record.roots.map(commonRepository).filter(Boolean));

  for (const repository of repositories) {
    const references = git(repository, ['for-each-ref', '--format=%(refname) %(objectname)', prefix, legacy]).split('\n')
      .map(line => line.split(' ')).filter(([ref]) => ref.startsWith(prefix) || ref === legacy);

    if (references.length) git(repository, ['update-ref', '--stdin'], ['start', ...references.map(([ref, commit]) => `delete ${ref} ${commit}`), 'prepare', 'commit', ''].join('\n'));
  }
}

function removeCheckpoints(directory, published) {
  const owners = path.join(directory, 'checkpoint-owners');

  for (const entry of children(owners)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const record = JSON.parse(fs.readFileSync(path.join(owners, entry.name), 'utf8'));

    if (!Check(ownerSchema, record) || entry.name !== `${record.sessionId}.json`) throw new Error('Invalid preparatory checkpoint owner');

    if (!published.has(record.sessionId)) removeRefs(record);
  }
}

function removeDirectory(directory) {
  const parent = path.dirname(directory);
  const removing = path.basename(directory).startsWith('.cleanup-') ? directory : path.join(parent, `.cleanup-${path.basename(directory)}`);

  if (removing !== directory) { fs.renameSync(directory, removing); sync(parent); }

  fs.rmSync(removing, { recursive: true });
  sync(parent);
}

function recoverDirectory(directory, owners) {
  const descriptor = fs.openSync(path.join(directory, 'active.lock'), fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);

  try {
    const locked = spawnSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', descriptor] });

    if (locked.error) throw locked.error;

    if (locked.status === 1) return;

    if (locked.status !== 0) throw new Error(locked.stderr.toString().trim() || 'Could not lock fork preparation');
    removeCheckpoints(directory, owners());
    removeDirectory(directory);
  } finally { fs.closeSync(descriptor); }
}

function recover(root) {
  const directory = path.join(root, 'fork-preparations');
  let published;
  const owners = () => {
    if (published) return published;
    published = new Set();
    savedOwners(path.join(root, 'sessions'), published);
    savedOwners(path.join(root, 'archived'), published);

    return published;
  };

  for (const entry of children(directory)) {
    if (!entry.isDirectory()) throw new Error('Invalid fork preparation storage');
    const preparation = path.join(directory, entry.name);

    if (entry.name.startsWith('.cleanup-')) removeDirectory(preparation);
    else recoverDirectory(preparation, owners);
  }
}

module.exports = { recover };
