const storageLocks = require('../storage-locks.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { Type } = require('typebox');
const { Check } = require('typebox/value');

const uuid = Type.String({ pattern: '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' });

const headerSchema = Type.Object({ type: Type.Literal('session'), id: uuid, cwd: Type.String(), version: Type.Integer({ minimum: 1 }), piopPublicationId: Type.Optional(uuid) });

function exists(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function identity(file) {
  const metadata = fs.lstatSync(file, { bigint: true });

  return `${metadata.dev}:${metadata.ino}`;
}

function fingerprint(metadata) {
  return `${metadata.dev}:${metadata.ino}:${metadata.mode}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
}

function hash(body) { return createHash('sha256').update(body).digest('hex'); }

function inside(root, file) { return path.isAbsolute(file) && path.resolve(file) === file && file.startsWith(root + path.sep); }

function canonical(file) { return fs.realpathSync(file) === file; }

function sync(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function mkdir(directory) {
  const metadata = exists(directory);

  if (metadata) {
    if (!metadata.isDirectory() || !canonical(directory)) throw new Error(`Publication directory has ambiguous ownership: ${directory}`);

    return;
  }

  mkdir(path.dirname(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  sync(path.dirname(directory));
}

function read(file) {
  if (!exists(file)?.isFile() || !canonical(file)) throw new Error(`Publication record is unavailable or ambiguous: ${file}`);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try {
    const before = fingerprint(fs.fstatSync(descriptor, { bigint: true }));

    const bytes = fs.readFileSync(descriptor);

    const body = bytes.toString('utf8');

    if (fingerprint(fs.fstatSync(descriptor, { bigint: true })) !== before || fingerprint(fs.lstatSync(file, { bigint: true })) !== before) throw new Error(`Publication file changed during reading: ${file}`);

    return { body, bytes, fingerprint: before };
  } finally { fs.closeSync(descriptor); }
}

function proof(file) {
  if (!exists(file)?.isFile() || !canonical(file)) throw new Error(`Publication dependency is unavailable or ambiguous: ${file}`);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try {
    const metadata = fs.fstatSync(descriptor, { bigint: true });

    const before = fingerprint(metadata);

    const digest = createHash('sha256');

    const buffer = Buffer.alloc(65536);
    let bytes = 0;

    for (;;) {
      const count = fs.readSync(descriptor, buffer);

      if (!count) break;
      digest.update(buffer.subarray(0, count));
      bytes += count;
    }

    if (fingerprint(fs.fstatSync(descriptor, { bigint: true })) !== before || fingerprint(fs.lstatSync(file, { bigint: true })) !== before) throw new Error(`Publication dependency changed during verification: ${file}`);

    return { identity: `${metadata.dev}:${metadata.ino}`, bytes, digest: digest.digest('hex'), fingerprint: before };
  } finally { fs.closeSync(descriptor); }
}

function header(file) {
  if (!exists(file)?.isFile() || !canonical(file)) return null;
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try {
    const buffer = Buffer.alloc(65536);

    const chunks = [];

    for (;;) {
      const count = fs.readSync(descriptor, buffer);

      if (!count) return null;
      const end = buffer.subarray(0, count).indexOf(10);

      chunks.push(Buffer.from(buffer.subarray(0, end < 0 ? count : end)));

      if (end >= 0) {
        return parsedHeader(Buffer.concat(chunks).toString('utf8'));
      }
    }
  } finally { fs.closeSync(descriptor); }
}

function parsedHeader(body) {
  try {
    const value = JSON.parse(body);

    return Check(headerSchema, value) ? value : null;
  } catch (error) { if (error instanceof SyntaxError) return null; throw error; }
}

function canonicalRoot(root) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || !canonical(root) || !exists(root).isDirectory()) throw new Error('Publication storage root has ambiguous ownership');
}

function rootForTarget(target) {
  if (!path.isAbsolute(target) || path.resolve(target) !== target || !canonical(path.dirname(target))) throw new Error('Session publication requires a canonical target directory');
  let current = path.dirname(target);

  while (path.dirname(current) !== current) {
    if (path.basename(current) === 'sessions') {
      const root = path.dirname(current);

      const configured = fs.realpathSync(path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop'));

      if (root !== configured) throw new Error('Session publication target is outside Piop-controlled storage');

      return root;
    }

    current = path.dirname(current);
  }

  throw new Error('Session publication target is outside Piop-controlled session storage');
}

// The publication lock of one chat, or the parent locks of a link: the exclusive lock name when it is free. Returns its
// release, or null.
function claim(name) { return storageLocks.lockSync(name, { wait: false }) ?? null; }

function transactionName(root) { return 'session-transactions:' + root; }

// Runs operation under the session transaction lock of root, or fails when another change holds it.
function locked(root, operation) {
  canonicalRoot(root);
  const release = storageLocks.lockSync(transactionName(root), { wait: false });

  if (!release) throw storageBusy();

  try { return operation(); }
  finally { release(); }
}

// Runs operation under the session transaction lock of root, and waits up to 5 seconds for it.
async function lockedAsync(root, operation) {
  canonicalRoot(root);
  const release = await storageLocks.lock(transactionName(root), { timeoutMs: 5000 });

  if (!release) throw storageBusy();

  try { return await operation(); }
  finally { release(); }
}

// True when this flow holds the session transaction lock of root.
function holdsTransactionLock(root) { return storageLocks.holds(transactionName(root)); }

function storageBusy() { return new Error('Session storage is busy; retry publication after the current transaction'); }

// The name of the lock that the writer of a new chat holds until it is published or given back.
function lockName(target) { return 'session-publication:' + hash(target); }

function journalPath(root, id) { return path.join(root, 'session-publications', `${id}.json`); }

function matches(file, expected) { return Boolean(exists(file)?.isFile()) && canonical(file) && identity(file) === expected; }

function verified(file, journal) {
  if (!exists(file)?.isFile() || !canonical(file)) return false;
  const metadata = header(file);

  if (!metadata || metadata.id !== journal.sessionId || metadata.piopPublicationId !== journal.id) return false;
  const snapshot = proof(file);

  return snapshot.bytes === journal.bytes && snapshot.digest === journal.digest;
}

function locate(root, id, nonce) {
  const file = require('../session-database.cjs').lookup(root, id);

  if (!file) return;

  if (!inside(path.join(root, 'sessions'), file)) throw new Error('Conversation database path is outside session storage');
  const value = header(file);

  if (value?.id === id && (!nonce || value.piopPublicationId === nonce)) return { path: file, header: value };
}

function unregistered(root, id, target) {
  const file = path.join(root, 'sessions.sqlite');

  if (!exists(file)) return false;

  return !require('../session-database.cjs').connection(root).prepare('SELECT 1 FROM sessions WHERE session_id=? AND session_path=?').get(id, target);
}

module.exports = { uuid, headerSchema, exists, identity, fingerprint, hash, inside, canonical, sync, mkdir, read, proof, header, canonicalRoot, rootForTarget, claim, locked, lockedAsync, holdsTransactionLock, lockName, journalPath, matches, verified, locate, unregistered };
