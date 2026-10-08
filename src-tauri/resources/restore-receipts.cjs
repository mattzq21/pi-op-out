const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const io = require('./session-transactions.cjs');

const receiptSchema = Type.Object({
  trace: Type.Object({ source: Type.String(), destination: Type.String(), identity: Type.String({ pattern: '^\\d+:\\d+$' }) }),
  result: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
});

const transactionSchema = Type.Object({ version: Type.Union([Type.Literal(1), Type.Literal(2)]), committed: Type.Optional(Type.Boolean()) });

const headerSchema = Type.Object({ id: Type.String({ minLength: 1 }) });

const MAX_RECORD_BYTES = 256 * 1024;

const MAX_HEADER_BYTES = 1024 * 1024;

function receiptPath(root, source) {
  return path.join(root, 'restore-receipts', `${createHash('sha256').update(source).digest('hex')}.json`);
}

function canonicalRoot(root) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || fs.realpathSync(root) !== root) throw new Error('Restore receipt storage has ambiguous ancestry');
}

function fingerprint(metadata) {
  return `${metadata.dev}:${metadata.ino}:${metadata.mode}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
}

function sameEntry(file, expected) {
  const metadata = io.exists(file);

  return Boolean(metadata) && fingerprint(fs.lstatSync(file, { bigint: true })) === expected;
}

function assertLocked(root) {
  canonicalRoot(root);
  const lock = path.join(root, 'session-transactions.lock');

  if (!io.exists(lock)?.isFile() || fs.realpathSync(lock) !== lock) throw new Error('Restore receipt cleanup requires the session transaction lock');
  const inherited = fs.fstatSync(3, { bigint: true });

  if (`${inherited.dev}:${inherited.ino}` !== io.identity(lock)) throw new Error('Restore receipt cleanup requires the inherited session transaction lock');
  execFileSync('flock', ['--nonblock', '--exclusive', '3'], { stdio: ['ignore', 'pipe', 'pipe', 3] });
}

function parse(body) {
  try { return JSON.parse(body); }
  catch (_error) { return undefined; }
}

function readRecord(file) {
  const metadata = io.exists(file);

  if (!metadata) return null;

  if (!metadata.isFile() || metadata.size > MAX_RECORD_BYTES || fs.realpathSync(file) !== file) return { file };
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try { return readRecordDescriptor(file, descriptor); }
  finally { fs.closeSync(descriptor); }
}

function readRecordDescriptor(file, descriptor) {
  const before = fs.fstatSync(descriptor, { bigint: true });

  if (!before.isFile() || before.size > MAX_RECORD_BYTES) return { file };
  const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);

  let count = 0;

  while (count < buffer.length) {
    const read = fs.readSync(descriptor, buffer, count, buffer.length - count);

    if (!read) break;
    count += read;
  }

  const saved = fingerprint(before);

  if (count > MAX_RECORD_BYTES || fingerprint(fs.fstatSync(descriptor, { bigint: true })) !== saved || !sameEntry(file, saved)) return { file };
  const body = buffer.subarray(0, count).toString('utf8');

  return { file, fingerprint: saved, body, value: parse(body) };
}

function canonicalLocation(base, file) {
  if (!io.inside(base, file) || file === base || !file.endsWith('.jsonl')) return false;
  let parent = path.dirname(file);

  while (!io.exists(parent)) parent = path.dirname(parent);

  return io.exists(parent).isDirectory() && fs.realpathSync(parent) === parent;
}

function validReceipt(root, receipt) {
  if (!Check(receiptSchema, receipt)) return false;

  return canonicalLocation(path.join(root, 'archived'), receipt.trace.source) && canonicalLocation(path.join(root, 'sessions'), receipt.trace.destination);
}

function ownedReceipt(root, file) {
  const snapshot = readRecord(file);

  if (!snapshot || !validReceipt(root, snapshot.value)) return null;

  return file === receiptPath(root, snapshot.value.trace.source) ? snapshot : null;
}

function readHeader(descriptor) {
  const buffer = Buffer.alloc(32 * 1024);

  const chunks = [];

  let remaining = MAX_HEADER_BYTES;

  while (remaining) {
    const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining));

    if (!count) return parse(Buffer.concat(chunks).toString('utf8'));
    const newline = buffer.subarray(0, count).indexOf(10);

    chunks.push(Buffer.from(buffer.subarray(0, newline < 0 ? count : newline)));

    if (newline >= 0) return parse(Buffer.concat(chunks).toString('utf8'));
    remaining -= count;
  }

  return undefined;
}

function fileState(file, expectedIdentity, sessionId) {
  const metadata = io.exists(file);

  if (!metadata) return { kind: 'stale', proof: 'absent' };

  if (metadata.isSymbolicLink() || fs.realpathSync(file) !== file) return { kind: 'uncertain' };
  const before = fs.lstatSync(file, { bigint: true });

  const proof = fingerprint(before);

  if (!before.isFile() || `${before.dev}:${before.ino}` !== expectedIdentity) return { kind: 'stale', proof };
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try { return headerState(file, descriptor, proof, sessionId); }
  finally { fs.closeSync(descriptor); }
}

function headerState(file, descriptor, proof, sessionId) {
  if (fingerprint(fs.fstatSync(descriptor, { bigint: true })) !== proof) return { kind: 'uncertain' };
  const header = readHeader(descriptor);

  if (!sameEntry(file, proof) || fingerprint(fs.fstatSync(descriptor, { bigint: true })) !== proof || !Check(headerSchema, header)) return { kind: 'uncertain' };

  return { kind: header.id === sessionId ? 'valid' : 'stale', proof };
}

function destinationState(receipt) {
  return fileState(receipt.trace.destination, receipt.trace.identity, receipt.result.sessionId);
}

function restoredResult(root, source) {
  canonicalRoot(root);
  const snapshot = ownedReceipt(root, receiptPath(root, source));

  if (!snapshot || snapshot.value.trace.source !== source) return null;

  return destinationState(snapshot.value).kind === 'valid' && unchanged(snapshot) ? snapshot.value.result : null;
}

function legacyPending(directory) {
  if (!io.exists(directory)) return false;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (/^\.delete-[a-f0-9]{64}\.lock$/.test(entry.name)) return true;

    if (entry.isDirectory() && !entry.name.endsWith('.snapshots') && legacyPending(path.join(directory, entry.name))) return true;
  }

  return false;
}

function pendingDirectory(directory, ignoredJournal) {
  const metadata = io.exists(directory);

  if (!metadata) return false;

  if (!metadata.isDirectory() || fs.realpathSync(directory) !== directory) return true;

  return fs.readdirSync(directory).some(name => path.join(directory, name) !== ignoredJournal);
}

function pending(root, ignoredJournal) {
  if (pendingDirectory(path.join(root, 'restore-transactions'), ignoredJournal)) return true;

  for (const name of ['archive-transactions', 'delete-transactions', 'deleted-sessions']) {
    if (pendingDirectory(path.join(root, name))) return true;
  }

  if (fs.readdirSync(root).some(name => name.startsWith('archive-transaction-'))) return true;

  return legacyPending(path.join(root, 'sessions')) || legacyPending(path.join(root, 'archived'));
}

function unchanged(snapshot) {
  const current = readRecord(snapshot.file);

  return Boolean(current) && current.fingerprint === snapshot.fingerprint && current.body === snapshot.body;
}

function removeReceipt(snapshot) {
  if (!unchanged(snapshot)) return false;
  fs.unlinkSync(snapshot.file);
  io.sync(path.dirname(snapshot.file));

  return true;
}

function rollbackJournal(root, transaction, journal) {
  if (!Check(transactionSchema, transaction) || transaction.committed || !validReceipt(root, transaction)) return null;
  const key = createHash('sha256').update(transaction.result.sessionId.toLowerCase()).digest('hex').slice(0, 40);

  if (journal !== path.join(root, 'restore-transactions', `${key}.json`)) return null;
  const snapshot = readRecord(journal);

  return snapshot && isDeepStrictEqual(snapshot.value, transaction) ? snapshot : null;
}

function matchingReceipt(snapshot, transaction) {
  return Boolean(snapshot) && isDeepStrictEqual(snapshot.value.trace, transaction.trace) && isDeepStrictEqual(snapshot.value.result, transaction.result);
}

function discardRolledBack(root, transaction, journal) {
  assertLocked(root);
  const active = rollbackJournal(root, transaction, journal);

  if (!active || pending(root, journal)) return false;
  const snapshot = ownedReceipt(root, receiptPath(root, transaction.trace.source));

  if (!matchingReceipt(snapshot, transaction)) return false;
  const source = fileState(transaction.trace.source, transaction.trace.identity, transaction.result.sessionId);

  if (source.kind !== 'valid' || io.exists(transaction.trace.destination)) return false;

  if (!unchanged(active) || !sameEntry(transaction.trace.source, source.proof) || io.exists(transaction.trace.destination)) return false;

  return removeReceipt(snapshot);
}

function pruneReceipt(root, file) {
  const snapshot = ownedReceipt(root, file);

  if (!snapshot) return false;
  const state = destinationState(snapshot.value);

  if (state.kind !== 'stale') return false;
  const current = destinationState(snapshot.value);

  if (current.kind !== 'stale' || current.proof !== state.proof) return false;

  return removeReceipt(snapshot);
}

function prune(root) {
  assertLocked(root);
  const directory = path.join(root, 'restore-receipts');

  if (!io.exists(directory)) return { removed: 0, retained: 0, deferred: false };

  if (!io.exists(directory).isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Restore receipt directory has ambiguous ownership');
  const files = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name));

  if (pending(root)) return { removed: 0, retained: files.length, deferred: true };
  let removed = 0;

  for (const name of files) if (pruneReceipt(root, path.join(directory, name))) removed += 1;

  return { removed, retained: files.length - removed, deferred: false };
}

module.exports = { receiptPath, restoredResult, discardRolledBack, prune };
