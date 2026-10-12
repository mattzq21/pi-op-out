const { lockSync } = require('../file-lock.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { Type } = require('typebox');
const { Check } = require('typebox/value');

const uuid = Type.String({ pattern: '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' });

const headerSchema = Type.Object({ type: Type.Literal('session'), id: uuid, cwd: Type.String(), version: Type.Integer({ minimum: 1 }), piopPublicationId: Type.Optional(uuid) });

const writerSchema = Type.Object({ pid: Type.Integer({ minimum: 1 }), boot: Type.Optional(Type.String()), start: Type.Optional(Type.String()) });

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

function lockDescriptor(descriptor) {
  return lockSync(descriptor, false, true, 5000);
}

function claim(file, expected) {
  const flags = fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | (expected ? 0 : fs.constants.O_CREAT);

  const descriptor = fs.openSync(file, flags, 0o600);

  try {
    const metadata = fs.fstatSync(descriptor, { bigint: true });

    const opened = `${metadata.dev}:${metadata.ino}`;

    if (!metadata.isFile() || !canonical(file) || identity(file) !== opened) throw new Error(`Invalid publication lock: ${file}`);

    if (expected && opened !== expected) throw new Error(`Publication lock identity changed: ${file}`);

    if (lockDescriptor(descriptor)) return descriptor;
  } catch (error) { fs.closeSync(descriptor); throw error; }

  fs.closeSync(descriptor);

  return null;
}

/** The session transaction lock that the storage operation running in this thread holds, as { file, descriptor }. */
let heldLock;

/** Lets nested storage code in this thread use descriptor, which already holds the session transaction lock of root. Returns the release function. */
function holdTransactionLock(root, descriptor) {
  const file = path.join(root, 'session-transactions.lock');
  const metadata = fs.fstatSync(descriptor, { bigint: true });

  if (`${metadata.dev}:${metadata.ino}` !== identity(file)) throw new Error('Held session storage lock does not match its file');

  if (heldLock) throw new Error('This thread already holds a session storage lock');
  heldLock = { file, descriptor };

  return () => { heldLock = undefined; };
}

/** Returns the held descriptor for the session transaction lock file, or undefined. */
function heldTransactionLock(file) {
  if (heldLock?.file !== file) return;
  const metadata = fs.fstatSync(heldLock.descriptor, { bigint: true });

  if (!exists(file)?.isFile() || `${metadata.dev}:${metadata.ino}` !== identity(file)) throw new Error('Held session storage lock no longer matches its file');

  return heldLock.descriptor;
}

function transactionLock(root) {
  canonicalRoot(root);
  const file = path.join(root, 'session-transactions.lock');

  const held = heldTransactionLock(file);

  const borrowed = held !== undefined;

  const descriptor = borrowed ? held : claim(file);

  if (descriptor === null) return null;

  if (borrowed && !lockDescriptor(descriptor)) throw new Error('Held session storage lock is unavailable');

  return { descriptor, borrowed };
}

function locked(root, operation) {
  const lock = transactionLock(root);

  if (!lock) throw storageBusy();
  const { descriptor, borrowed } = lock;

  try {
    return operation();
  }
  finally { if (!borrowed) fs.closeSync(descriptor); }
}

async function lockedAsync(root, operation) {
  const { descriptor, borrowed } = await waitForTransactionLock(root);

  try { return await operation(); }
  finally { if (!borrowed) fs.closeSync(descriptor); }
}

function storageBusy() { return new Error('Session storage is busy; retry publication after the current transaction'); }

async function waitForTransactionLock(root) {
  const deadline = performance.now() + 5000;

  for (;;) {
    const lock = transactionLock(root);

    if (lock) return lock;

    if (performance.now() >= deadline) throw storageBusy();
    await delay(50);
  }
}

function processStart(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');

  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

function writer() {
  if (process.platform !== 'linux') return { pid: process.pid };

  return { pid: process.pid, boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), start: processStart(process.pid) };
}

function writerDead(owner) {
  if (!Check(writerSchema, owner)) return false;

  try {
    if (process.platform === 'linux' && owner.boot && owner.start) {
      if (fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== owner.boot) return true;

      return processStart(owner.pid) !== owner.start;
    }

    process.kill(owner.pid, 0);

    return false;
  } catch (error) { return ['ENOENT', 'ESRCH'].includes(error.code); }
}

function lockPath(root, target) { return path.join(root, 'session-publication-locks', `${hash(target)}.lock`); }

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

  if (!inside(path.join(root, 'sessions'), file) && !inside(path.join(root, 'archived'), file)) throw new Error('Conversation database path is outside session storage');
  const value = header(file);

  if (value?.id === id && (!nonce || value.piopPublicationId === nonce)) return { path: file, header: value };
}

function unregistered(root, id, target) {
  const file = path.join(root, 'sessions.sqlite');

  if (!exists(file)) return false;
  const { DatabaseSync } = require('node:sqlite');

  const database = new DatabaseSync(file, { readOnly: true });

  try {
    return !database.prepare('SELECT 1 FROM sessions WHERE session_id=? AND session_path=?').get(id, target);
  } finally { database.close(); }
}

module.exports = { uuid, headerSchema, writerSchema, exists, identity, fingerprint, hash, inside, canonical, sync, mkdir, read, proof, header, canonicalRoot, rootForTarget, claim, locked, lockedAsync, holdTransactionLock, heldTransactionLock, writer, writerDead, lockPath, journalPath, matches, verified, locate, unregistered };
