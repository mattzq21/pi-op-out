const { lockSync } = require('./file-lock.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const io = require('./session-transactions.cjs');
const { heldTransactionLock } = require('./piop-storage/session-publication-io.cjs');
const database = require('./session-database.cjs');

const traceSchema = Type.Object({ source: Type.String(), destination: Type.String(), identity: Type.String({ pattern: '^\\d+:\\d+$' }) });

const operationIdSchema = Type.String({ pattern: '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' });

const receiptSchema = Type.Object({
  version: Type.Literal(1), operationId: operationIdSchema, trace: traceSchema,
  result: Type.Object({
    sessionId: Type.String({ minLength: 1 }), sessionPath: Type.String(), path: Type.String(),
    sessions: Type.Array(Type.Object({ sessionId: Type.String({ minLength: 1 }), sessionPath: Type.String() }), { minItems: 1 }),
  }),
});

const headerSchema = Type.Object({ type: Type.Literal('session'), id: Type.String({ minLength: 1 }) });

function key(source) { return createHash('sha256').update(source).digest('hex'); }

function withDatabase(root, operation) {
  const db = database.open(root);

  try { return operation(db); }
  finally { db.close(); }
}

function readReceipt(root, id) {
  const row = withDatabase(root, db => db.prepare('SELECT record_json FROM session_restore_receipts WHERE record_id=?').get(id));

  return row ? { id, body: row.record_json, value: parse(row.record_json) } : null;
}

function receiptIds(root) {
  return withDatabase(root, db => db.prepare('SELECT record_id FROM session_restore_receipts ORDER BY record_id').all().map(row => row.record_id));
}

function unchanged(root, snapshot) { return readReceipt(root, snapshot.id)?.body === snapshot.body; }

function removeReceipt(root, snapshot) {
  return withDatabase(root, db => db.prepare('DELETE FROM session_restore_receipts WHERE record_id=? AND record_json=?').run(snapshot.id, snapshot.body).changes === 1);
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
  const held = heldTransactionLock(lock);

  if (held === undefined) throw new Error('Restore receipt cleanup requires the held session transaction lock');
  if (!lockSync(held, false, true)) throw new Error('Restore receipt cleanup requires the session transaction lock');
}

function parse(body) {
  try { return JSON.parse(body); }
  catch (_error) { return undefined; }
}

function canonicalLocation(base, file) {
  if (!io.inside(base, file) || file === base || !file.endsWith('.jsonl')) return false;
  let parent = path.dirname(file);

  while (!io.exists(parent)) parent = path.dirname(parent);

  return io.exists(parent).isDirectory() && fs.realpathSync(parent) === parent;
}

function validReceipt(root, receipt) {
  if (!Check(receiptSchema, receipt) || receipt.result.sessionPath !== receipt.trace.destination || !path.isAbsolute(receipt.result.path)) return false;

  return canonicalLocation(path.join(root, 'archived'), receipt.trace.source) && canonicalLocation(path.join(root, 'sessions'), receipt.trace.destination);
}

function ownedReceipt(root, id) {
  const snapshot = readReceipt(root, id);

  return snapshot && validReceipt(root, snapshot.value) && key(snapshot.value.trace.source) === id ? snapshot : null;
}

function sessionsSurvive(root, receipt) {
  const { survivingSession } = require('./piop-storage/maintenance.cjs');

  return receipt.result.sessions.every(session => survivingSession(root, session.sessionPath, session.sessionId, new Set()));
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
  const snapshot = ownedReceipt(root, key(source));

  if (!snapshot || snapshot.value.trace.source !== source) return null;

  if (destinationState(snapshot.value).kind !== 'valid' || !sessionsSurvive(root, snapshot.value)) return null;

  return unchanged(root, snapshot) ? snapshot.value.result : null;
}

function record(root, journal) {
  assertLocked(root);
  const receipt = parse(JSON.stringify({ version: 1, operationId: journal.id, trace: journal.trace, result: journal.result }));

  if (!validReceipt(root, receipt)) throw new Error('Invalid restore receipt publication');

  if (destinationState(receipt).kind !== 'valid') return;

  withDatabase(root, db => db.prepare('INSERT INTO session_restore_receipts VALUES (?, ?) ON CONFLICT(record_id) DO UPDATE SET record_json=excluded.record_json')
    .run(key(receipt.trace.source), JSON.stringify(receipt)));
}

function pruneReceipt(root, id) {
  const snapshot = readReceipt(root, id);

  if (!snapshot) return false;

  if (!ownedReceipt(root, id)) return removeReceipt(root, snapshot);
  const state = destinationState(snapshot.value);

  if (state.kind === 'uncertain') return false;

  if (state.kind === 'valid') return sessionsSurvive(root, snapshot.value) ? false : removeReceipt(root, snapshot);
  const current = destinationState(snapshot.value);

  if (current.kind !== 'stale' || current.proof !== state.proof) return false;

  return removeReceipt(root, snapshot);
}

function prune(root) {
  assertLocked(root);
  const ids = receiptIds(root);

  if (require('./storage-transaction.cjs').pending(root)) return { removed: 0, retained: ids.length, deferred: true };
  let removed = 0;

  for (const id of ids) if (pruneReceipt(root, id)) removed += 1;

  return { removed, retained: ids.length - removed, deferred: false };
}

module.exports = { record, result, prune };
