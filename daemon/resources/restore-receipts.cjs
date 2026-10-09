const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const io = require('./session-transactions.cjs');

const traceSchema = Type.Object({ source: Type.String(), destination: Type.String(), identity: Type.String({ pattern: '^\\d+:\\d+$' }) });

const receiptSchema = Type.Object({
  trace: traceSchema,
  result: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
});

const operationIdSchema = Type.String({ pattern: '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' });

const publishedSchema = Type.Object({
  version: Type.Literal(1), operationId: operationIdSchema, trace: traceSchema,
  result: Type.Object({ sessionId: Type.String({ minLength: 1 }), sessionPath: Type.String(), path: Type.String(), branch: Type.Union([Type.String(), Type.Null()]) }),
});

const transactionSchema = Type.Object({ version: Type.Union([Type.Literal(1), Type.Literal(2)]), committed: Type.Optional(Type.Boolean()) });

const headerSchema = Type.Object({ type: Type.Literal('session'), id: Type.String({ minLength: 1 }) });

const finishedArchiveSchema = Type.Object({
  version: Type.Literal(2), kind: Type.Literal('archive'), id: operationIdSchema, root: Type.String(),
  container: Type.String(), containerIdentity: Type.String({ pattern: '^\\d+:\\d+$' }), state: Type.Literal('committed'), finished: Type.Literal(true),
});

const archivePendingSchema = Type.Object({ version: Type.Literal(2), id: operationIdSchema });

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
  if (['restore-transactions', 'restore-receipts'].includes(path.basename(path.dirname(file)))) return require('./restore-records.cjs').read(file);
  const metadata = io.exists(file);

  if (!metadata) return null;

  if (!metadata.isFile() || fs.realpathSync(file) !== file) return { file };
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try { return readRecordDescriptor(file, descriptor); }
  finally { fs.closeSync(descriptor); }
}

function readRecordDescriptor(file, descriptor) {
  const before = fs.fstatSync(descriptor, { bigint: true });

  if (!before.isFile()) return { file };
  const body = fs.readFileSync(descriptor, 'utf8');

  const saved = fingerprint(before);

  if (fingerprint(fs.fstatSync(descriptor, { bigint: true })) !== saved || !sameEntry(file, saved)) return { file };

  return { file, fingerprint: saved, body, value: parse(body) };
}

function canonicalLocation(base, file) {
  if (!io.inside(base, file) || file === base || !file.endsWith('.jsonl')) return false;
  let parent = path.dirname(file);

  while (!io.exists(parent)) parent = path.dirname(parent);

  return io.exists(parent).isDirectory() && fs.realpathSync(parent) === parent;
}

function recognizedReceipt(receipt) {
  if (!Check(receiptSchema, receipt)) return false;

  if (!Object.hasOwn(receipt, 'version') && !Object.hasOwn(receipt, 'operationId')) return true;

  return Check(publishedSchema, receipt) && receipt.result.sessionPath === receipt.trace.destination && path.isAbsolute(receipt.result.path);
}

function validReceipt(root, receipt) {
  if (!recognizedReceipt(receipt)) return false;

  return canonicalLocation(path.join(root, 'archived'), receipt.trace.source) && canonicalLocation(path.join(root, 'sessions'), receipt.trace.destination);
}

function ownsReceipt(root, snapshot) {
  if (!snapshot || !validReceipt(root, snapshot.value)) return false;

  return snapshot.file === receiptPath(root, snapshot.value.trace.source);
}

function ownedReceipt(root, file) {
  const snapshot = readRecord(file);

  return ownsReceipt(root, snapshot) ? snapshot : null;
}

function readHeader(descriptor) {
  const buffer = Buffer.alloc(32 * 1024);

  const chunks = [];

  for (;;) {
    const count = fs.readSync(descriptor, buffer);

    if (!count) return parse(Buffer.concat(chunks).toString('utf8'));
    const newline = buffer.subarray(0, count).indexOf(10);

    chunks.push(Buffer.from(buffer.subarray(0, newline < 0 ? count : newline)));

    if (newline >= 0) return parse(Buffer.concat(chunks).toString('utf8'));
  }
}

function fileState(file, expectedIdentity, sessionId) {
  const metadata = io.exists(file);

  if (!metadata) return { kind: 'stale', proof: 'absent' };

  if (metadata.isSymbolicLink() || fs.realpathSync(file) !== file) return { kind: 'uncertain' };
  const before = fs.lstatSync(file, { bigint: true });

  const proof = fingerprint(before);

  if (!before.isFile() || `${before.dev}:${before.ino}` !== expectedIdentity) return { kind: 'stale', proof };
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try { return headerState(file, descriptor, proof, expectedIdentity, sessionId); }
  finally { fs.closeSync(descriptor); }
}

function currentIdentity(file, expectedIdentity) {
  return Boolean(io.exists(file)) && io.identity(file) === expectedIdentity;
}

function headerState(file, descriptor, proof, expectedIdentity, sessionId) {
  const before = fs.fstatSync(descriptor, { bigint: true });

  if (`${before.dev}:${before.ino}` !== expectedIdentity) return { kind: 'uncertain' };
  const header = readHeader(descriptor);

  const after = fs.fstatSync(descriptor, { bigint: true });

  if (!Check(headerSchema, header) || !currentIdentity(file, expectedIdentity)) return { kind: 'uncertain' };

  if (header.id === sessionId) return { kind: 'valid', proof: fingerprint(after) };

  if (!sameEntry(file, proof) || fingerprint(after) !== proof) return { kind: 'uncertain' };

  return { kind: 'stale', proof };
}

function destinationState(receipt) {
  return fileState(receipt.trace.destination, receipt.trace.identity, receipt.result.sessionId);
}

function result(root, source) {
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

function finishedArchiveMarker(directory, id) {
  const marker = readRecord(path.join(directory, 'pending.json'));

  if (!marker) return true;

  return Check(archivePendingSchema, marker.value) && marker.value.id === id && unchanged(marker);
}

function finishedArchive(root, directory, snapshot) {
  if (!snapshot || !Check(finishedArchiveSchema, snapshot.value)) return false;
  const transaction = snapshot.value;

  if (transaction.root !== root || transaction.container !== directory || directory !== path.join(root, 'archive-transactions', transaction.id)) return false;

  if (fs.realpathSync(directory) !== directory || io.identity(directory) !== transaction.containerIdentity) return false;

  return finishedArchiveMarker(directory, transaction.id) && unchanged(snapshot);
}

function archivePending(root) {
  const directory = path.join(root, 'archive-transactions');

  try {
    const metadata = io.exists(directory);

    if (!metadata) return false;

    if (!metadata.isDirectory() || fs.realpathSync(directory) !== directory) return true;

    for (const name of fs.readdirSync(directory)) {
      const container = path.join(directory, name);

      if (!io.exists(container)?.isDirectory()) return true;

      if (!finishedArchive(root, container, readRecord(path.join(container, 'recovery.json')))) return true;
    }

    return false;
  } catch (_error) { return true; }
}

function pending(root, ignoredJournal) {
  if (require('./restore-records.cjs').list(root).some(file => file !== ignoredJournal)) return true;

  if (archivePending(root) || require('./deletion-records.cjs').list(root).length) return true;

  for (const name of ['delete-transactions', 'deleted-sessions']) {
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
  require('./restore-records.cjs').remove(snapshot.file);

  return true;
}

function operationJournal(root, transaction, journal) {
  if (!Check(transactionSchema, transaction) || transaction.committed) return null;

  if (!validReceipt(root, { trace: transaction.trace, result: transaction.result })) return null;

  if (!Check(operationIdSchema, transaction.receiptId)) return null;
  const key = createHash('sha256').update(transaction.result.sessionId.toLowerCase()).digest('hex').slice(0, 40);

  if (journal !== path.join(root, 'restore-transactions', `${key}.json`)) return null;
  const snapshot = readRecord(journal);

  return snapshot && isDeepStrictEqual(snapshot.value, parse(JSON.stringify(transaction))) ? snapshot : null;
}

function matchingReceipt(snapshot, transaction) {
  if (!snapshot || !Check(publishedSchema, snapshot.value) || snapshot.value.operationId !== transaction.receiptId) return false;
  const expected = parse(JSON.stringify({ trace: transaction.trace, result: transaction.result }));

  return isDeepStrictEqual(snapshot.value.trace, expected.trace) && isDeepStrictEqual(snapshot.value.result, expected.result);
}

function discardRolledBack(root, transaction, journal) {
  assertLocked(root);
  const active = operationJournal(root, transaction, journal);

  if (!active || pending(root, journal)) return false;
  const snapshot = ownedReceipt(root, receiptPath(root, transaction.trace.source));

  if (!matchingReceipt(snapshot, transaction)) return false;
  const source = fileState(transaction.trace.source, transaction.trace.identity, transaction.result.sessionId);

  if (source.kind !== 'valid' || io.exists(transaction.trace.destination)) return false;

  if (!unchanged(active) || !sameEntry(transaction.trace.source, source.proof) || io.exists(transaction.trace.destination)) return false;

  return removeReceipt(snapshot);
}

function previousReceipt(root, file, receipt, active) {
  const previous = readRecord(file);

  if (!previous) return;

  if (!ownsReceipt(root, previous)) throw new Error(`Existing restore receipt has ambiguous ownership; retained: ${file}`);

  if (isDeepStrictEqual(previous.value, receipt)) return;

  if (previous.value.operationId === receipt.operationId) throw new Error('Restore receipt operation identity was reused with different contents');

  if (pending(root, active.file)) throw new Error('Existing restore receipt is protected by unresolved session transactions');
  const state = destinationState(previous.value);

  if (state.kind !== 'stale' || !unchanged(previous)) throw new Error(`Existing restore receipt is still valid or uncertain; retained: ${file}`);
  const current = destinationState(previous.value);

  if (current.kind !== 'stale' || current.proof !== state.proof) throw new Error('Restore receipt destination changed during publication');
}

function publish(root, transaction) {
  assertLocked(root);
  const receipt = parse(JSON.stringify({ version: 1, operationId: transaction.receiptId, trace: transaction.trace, result: transaction.result }));

  if (!Check(publishedSchema, receipt) || !validReceipt(root, receipt)) throw new Error('Invalid restore receipt publication');
  const key = createHash('sha256').update(receipt.result.sessionId.toLowerCase()).digest('hex').slice(0, 40);

  const active = operationJournal(root, transaction, path.join(root, 'restore-transactions', `${key}.json`));

  if (!active) throw new Error('Restore receipt publication requires its persisted operation journal');
  const source = fileState(receipt.trace.source, receipt.trace.identity, receipt.result.sessionId);

  if (source.kind !== 'valid' || io.exists(receipt.trace.destination)) throw new Error('Restore receipt source or destination changed before publication');
  const file = receiptPath(root, receipt.trace.source);

  previousReceipt(root, file, receipt, active);

  if (!unchanged(active) || !sameEntry(receipt.trace.source, source.proof) || io.exists(receipt.trace.destination)) throw new Error('Restore operation changed before receipt publication');
  require('./restore-records.cjs').write(file, JSON.stringify(receipt));
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
  const files = require('./restore-records.cjs').list(root, true);

  if (pending(root)) return { removed: 0, retained: files.length, deferred: true };
  let removed = 0;

  for (const file of files) if (pruneReceipt(root, file)) removed += 1;

  return { removed, retained: files.length - removed, deferred: false };
}

module.exports = { publish, result, discardRolledBack, prune };
