const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const pages = require('./git-diff-pages.cjs');
const transfers = require('./git-diff-transfer.cjs');
const { createMigration } = require('./git-diff-migration.cjs');

const header = 'PIOP-DIFFS-1\n';

const maxRecordBytes = 4 * 1024 * 1024 * 6 + 64 * 1024;

const migrateShardedStore = createMigration({ header, maxRecordBytes, stringValue, snapshotValid, withStoreLock, readStore, digest, saveStore, syncParent, writeAll, recordBytes });

function stringValue(value) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Standalone JSON boundary validation.
  return typeof value === 'string';
}

function objectValue(value) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Standalone JSON boundary validation.
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ordered(_key, value) {
  return objectValue(value) ? Object.fromEntries(Object.entries(value).sort(([first], [second]) => first.localeCompare(second))) : value;
}

function equal(first, second) { return JSON.stringify(first, ordered) === JSON.stringify(second, ordered); }

function digest(snapshot) { return crypto.createHash('sha256').update(JSON.stringify(snapshot, ordered)).digest('hex'); }

function mappingValid(mapping) {
  return objectValue(mapping) && (['toolCallId', 'path', 'absolutePath', 'canonicalPath'].every(key => stringValue(mapping[key])) || ['tool_call_id', 'path', 'absolute_path', 'canonical_path'].every(key => stringValue(mapping[key])));
}

function recordBytes(record) {
  const body = Buffer.from(`${JSON.stringify(record)}\n`);

  if (body.length > maxRecordBytes) throw new Error('Permanent diff limit: individual record is too large; comparison retained');

  return body;
}

function snapshotValid(snapshot) {
  return stringValue(snapshot) || objectValue(snapshot) && stringValue(snapshot.patch) && (snapshot.repositoryRoot === undefined || stringValue(snapshot.repositoryRoot)) && (snapshot.toolPaths === undefined || Array.isArray(snapshot.toolPaths) && snapshot.toolPaths.every(mappingValid));
}

function apply(state, record) {
  if (!stringValue(record.id)) throw new Error('Diff record has no message ID');

  switch (record.op) {
    case 'set':
      applySnapshot(state, record);
      break;
    case 'remove': delete state.snapshots[record.id]; delete state.digests?.[record.id]; state.removed?.add(record.id); break;
    case 'pending': {
      applyPending(state, record);
      break;
    }

    case 'done': delete state.pending[record.id]; state.done?.add(record.id); break;
    case 'transfer':
      applyTransfer(state, record);
      break;
    default: throw new Error('Unknown diff log operation; file preserved');
  }
}

function applyTransfer(state, record) {
  if (!stringValue(record.key) || !objectValue(record.transfer)) throw new Error('Invalid diff transfer metadata; file preserved');
  state.transfers[record.key] = record.transfer;
}

function applySnapshot(state, record) {
  if (!snapshotValid(record.snapshot)) throw new Error('Invalid diff snapshot; file preserved');
  state.removed?.delete(record.id);

  if (state.digests) state.digests[record.id] = digest(record.snapshot);

  if (state.materialize) state.snapshots[record.id] = record.snapshot;
}

function applyPending(state, record) {
  if (!objectValue(record.capture)) throw new Error('Invalid pending comparison; file preserved');
  state.done?.delete(record.id);
  const capture = { ...record.capture };

  if (state.focus !== record.id) delete capture.snapshot;
  state.pending[record.id] = capture;
}

function readLog(fd, materialize, focus) {
  const state = { ...emptyState(), materialize, focus, end: Buffer.byteLength(header) };
  const buffer = Buffer.alloc(64 * 1024);
  let tail = Buffer.alloc(0); let offset = state.end; let position = state.end; let transaction;

  for (;;) {
    const count = fs.readSync(fd, buffer, 0, buffer.length, position);

    if (!count) break;
    position += count;
    tail = Buffer.concat([tail, buffer.subarray(0, count)]);
    let end;

    while ((end = tail.indexOf(10)) >= 0) {
      const line = tail.subarray(0, end + 1);

      if (line.length > maxRecordBytes) throw new Error('Permanent diff limit: individual log record is too large; file preserved');
      const record = JSON.parse(line.toString('utf8'));
      offset += line.length;
      transaction = consumeRecord(state, record, transaction, offset, offset - line.length);
      tail = tail.subarray(end + 1);
    }

    if (tail.length > maxRecordBytes) throw new Error('Permanent diff limit: individual log record is too large; file preserved');
  }

  return state;
}

function consumeRecord(state, record, transaction, offset, start) {
  if (record.op === 'begin') {
    if (transaction) throw new Error('Nested diff transaction; file preserved');

    return { ...emptyState(), materialize: state.materialize, focus: state.focus, removed: new Set(), done: new Set() };
  }

  if (!transaction) throw new Error('Diff operation outside transaction; file preserved');

  if (record.op === 'commit') {
    merge(state, transaction);
    state.end = offset;

    return undefined;
  }

  apply(transaction, record);

  if (record.op === 'set') transaction.positions[record.id] = start;

  return transaction;
}

function merge(state, transaction) {
  for (const [id, snapshot] of Object.entries(transaction.snapshots)) state.snapshots[id] = snapshot;

  for (const [id, digest] of Object.entries(transaction.digests)) state.digests[id] = digest;

  for (const [id, position] of Object.entries(transaction.positions)) state.positions[id] = position;

  for (const [id, capture] of Object.entries(transaction.pending)) if (!state.done.has(id) || capture.source === 'copy') state.pending[id] = capture;

  Object.assign(state.transfers, transaction.transfers);

  for (const id of transaction.removed) { delete state.snapshots[id]; delete state.digests[id]; delete state.positions[id]; }

  for (const id of transaction.done) { delete state.pending[id]; state.done.add(id); }
}

function completed(state, id) { return state.done.has(id) || Object.hasOwn(state.digests, id); }

function readStore(filename, materialize = true, focus) {
  let fd;

  try { fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return emptyState(); throw error; }

  try {
    const prefix = Buffer.alloc(Buffer.byteLength(header));
    const count = fs.readSync(fd, prefix, 0, prefix.length, 0);

    if (!count) return emptyState();

    if (prefix.subarray(0, 5).toString() === 'PIOP-') {
      if (prefix.toString() !== header) throw new Error('Unknown diff storage version; file preserved');

      return readLog(fd, materialize, focus);
    }

    const snapshots = JSON.parse(fs.readFileSync(fd, 'utf8'));

    if (!objectValue(snapshots) || !Object.values(snapshots).every(snapshotValid)) throw new Error('Invalid legacy diff map; file preserved');

    const digests = Object.fromEntries(Object.entries(snapshots).map(([id, snapshot]) => [id, digest(snapshot)]));

    return { ...emptyState(), snapshots, digests, legacy: true };
  } finally { fs.closeSync(fd); }
}

function emptyState() { return { snapshots: Object.create(null), digests: Object.create(null), positions: Object.create(null), pending: Object.create(null), transfers: Object.create(null), done: new Set(), end: 0, legacy: false }; }

function withStoreLock(filename, operation) {
  const fd = fs.openSync(`${filename}.lock`, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);

  try {
    const result = spawnSync('flock', ['--exclusive', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 30000 });

    if (result.error) throw result.error;

    if (result.status !== 0) throw new Error(`Could not lock source diffs: ${result.stderr.toString('utf8').trim()}`);

    return operation();
  } finally { fs.closeSync(fd); }
}

function readStoreLocked(filename) { return withStoreLock(filename, () => recoverStore(filename, true)); }

function recoverStore(filename, materialize, focus) {
  migrateShardedStore(filename);
  transfers.recoverTransfers(filename, readStore(filename, false), transferHooks(filename));

  return readStore(filename, materialize, focus);
}

function copyRetainedStoreLocked(filename, destination, retainedIds, sessionId) {
  validateRetainedSource(filename, sessionId);

  return withStoreLock(filename, () => {
    validateRetainedSource(filename, sessionId);
    const state = recoverStore(filename, false);
    const pending = [...Object.keys(state.pending), ...discoverComparisons(filename, true).filter(record => !completed(state, record.id)).map(record => record.id)];
    const partial = Object.values(state.transfers).flatMap(transfer => transfer.committed ? [] : [transfer.messageId]);

    if ([...pending, ...partial].some(id => retainedIds.has(id))) throw new Error('Selected source diffs are still pending; recover project changes before forking. Original comparisons were retained.');

    publishRetained(filename, destination, state, retainedIds);
  });
}

function publishRetained(filename, destination, state, retainedIds) {
  const positions = Object.entries(state.positions).filter(([id]) => retainedIds.has(id));
  const source = positions.length ? fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) : undefined;

  try {
    const fd = fs.openSync(destination, 'wx', 0o600);

    try {
      writeAll(fd, Buffer.from(header));

      for (const [id, position] of positions) transaction(fd, [{ op: 'set', id, snapshot: pages.indexedSnapshot(source, position, id, maxRecordBytes) }]);

      for (const id of state.done) if (retainedIds.has(id)) transaction(fd, [{ op: 'done', id }]);

      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }

    syncParent(destination);
  } finally { if (source !== undefined) fs.closeSync(source); }
}

function validateRetainedSource(filename, sessionId) {
  if (path.basename(filename).startsWith('pi-desktop-btw-')) validateEphemeralTranscript(filename, { ephemeralSessionId: sessionId });
}

function requestStoreLocked(filename, request) { return withStoreLock(filename, () => requestStore(filename, request)); }

const ephemeralUuid = /^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/;

function ephemeralTranscriptPath(filename) {
  const session = filename.replace(/\.diffs\.json$/, '.jsonl');
  const id = path.basename(session).slice('pi-desktop-btw-'.length, -'.jsonl'.length);

  if (!filename.endsWith('.diffs.json') || !path.isAbsolute(session) || path.normalize(session) !== session || !path.basename(session).startsWith('pi-desktop-btw-') || !ephemeralUuid.test(id)) throw new Error('Invalid temporary transcript namespace');

  return session;
}

function validateEphemeralTranscript(filename, request) {
  const session = ephemeralTranscriptPath(filename);
  const temporary = process.env.PIOP_DIFF_EPHEMERAL_TMP || os.tmpdir();

  if (!stringValue(request.ephemeralSessionId) || !ephemeralUuid.test(request.ephemeralSessionId)) throw new Error('Invalid temporary transcript stable identity');
  const parent = path.dirname(session);
  const canonical = fs.realpathSync(temporary);

  if (parent !== temporary && parent !== canonical) throw new Error('Temporary transcript is outside the temporary conversation namespace');

  if (fs.realpathSync(parent) !== canonical || !fs.lstatSync(session).isFile()) throw new Error('Temporary transcript must be a regular file in the temporary namespace');

  if (transcriptId(filename) !== request.ephemeralSessionId) throw new Error('Temporary transcript stable identity changed; recovery retained');
}

function requestEphemeralStore(filename, request) {
  const permitted = ['ephemeral_validate', 'retain', 'discover', 'pending_ids', 'pending_status', 'pending', 'finish', 'page'];

  if (!permitted.includes(request.action)) throw new Error('Temporary transcript diff access permits pending recovery only');
  validateEphemeralTranscript(filename, request);

  if (request.action === 'ephemeral_validate') return null;

  return withStoreLock(filename, () => {
    validateEphemeralTranscript(filename, request);

    return requestStore(filename, request);
  });
}

function writeAll(fd, body) {
  let offset = 0;

  while (offset < body.length) offset += fs.writeSync(fd, body, offset, body.length - offset);
}

function transaction(fd, records) {
  for (const record of records) recordBytes(record);
  writeAll(fd, Buffer.from('{"op":"begin"}\n'));

  for (const record of records) writeAll(fd, recordBytes(record));

  writeAll(fd, Buffer.from('{"op":"commit"}\n'));
  fs.fsyncSync(fd);
}

function syncParent(filename) {
  const fd = fs.openSync(path.dirname(filename), 'r');

  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function migrate(filename, state) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;

  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);

    try {
      writeAll(fd, Buffer.from(header));

      for (const [id, snapshot] of Object.entries(state.snapshots)) transaction(fd, [{ op: 'set', id, snapshot }]);

      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }

    fs.renameSync(temporary, filename); syncParent(filename);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function operations(state, request) {
  if (request.action === 'replace') return replacement(state, request.snapshots);

  if (request.action === 'merge') return updates(state, request.snapshots);

  if (request.action === 'pending') return pendingOperation(state, request);

  if (request.action === 'finish') {
    if (!equal(state.pending[request.id], request.capture)) return [];

    const records = [];

    if (request.capture.remove) records.push({ op: 'remove', id: request.id });
    else if (request.snapshot !== null) records.push({ op: 'set', id: request.id, snapshot: request.snapshot });
    records.push({ op: 'done', id: request.id });

    return records;
  }

  throw new Error('Unknown diff storage request');
}

function replacement(state, snapshots) {
  const records = updates(state, snapshots);

  for (const id of Object.keys(state.digests)) if (!Object.hasOwn(snapshots, id)) records.push({ op: 'remove', id });

  return records;
}

function updates(state, snapshots) {
  const records = [];

  if (!objectValue(snapshots)) throw new Error('Diff snapshots must be an object');

  for (const [id, snapshot] of Object.entries(snapshots)) if (state.digests[id] !== digest(snapshot)) records.push({ op: 'set', id, snapshot });

  return records;
}

function pendingOperation(state, request) {
  const previous = state.pending[request.id];

  if (previous) {
    if (previous.baseline !== request.capture.baseline || previous.current !== request.capture.current) throw new Error('A different pending comparison already owns this message; snapshots preserved');

    if (previous.ready === true && request.capture.ready !== true) return [];

    if (request.capture.ready !== true && !request.capture.failure) return [];
  }
  else if (completed(state, request.id)) return [];

  return [{ op: 'pending', id: request.id, capture: request.capture }];
}

function copyPending(state, records) {
  return records.map(record => {
    if (state.pending[record.id] && state.pending[record.id].source !== 'copy') throw new Error('An unfinished comparison owns this message; copy retained for retry');

    return { op: 'done', id: record.id };
  });
}

function snapshotParent() {
  return path.join(process.env.PIOP_DIFF_HOME || os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop', 'git-snapshots');
}

function transcriptId(filename) {
  const fd = fs.openSync(filename.replace(/\.diffs\.json$/, '.jsonl'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try {
    const buffer = Buffer.alloc(64 * 1024);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, count).indexOf(10);

    if (newline < 0) throw new Error('Conversation header is incomplete');
    const value = JSON.parse(buffer.subarray(0, newline).toString('utf8'));

    if (value.type !== 'session' || !stringValue(value.id) || !value.id) throw new Error('Invalid conversation identity for pending diff recovery');

    return value.id;
  } finally { fs.closeSync(fd); }
}

function comparisonRoot(token) {
  const value = JSON.parse(token);

  if (!stringValue(value.root) || !stringValue(value.repository_root) || !stringValue(value.tree) || !/^[a-fA-F0-9]{40,64}$/.test(value.tree)) throw new Error('Invalid pending comparison token');
  const root = fs.realpathSync(value.root);

  if (root !== value.root || path.dirname(root) !== fs.realpathSync(snapshotParent()) || !path.basename(root).startsWith('pi-desktop-diff-')) throw new Error('Invalid pending comparison location');

  return root;
}

function retainComparison(filename, request) {
  const root = comparisonRoot(request.capture.baseline);
  comparisonRoot(request.capture.current);
  const destination = path.join(root, 'pending-diff.json');
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  const body = recordBytes({ sessionId: transcriptId(filename), id: request.id, capture: request.capture });

  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);

    try { writeAll(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }

    fs.renameSync(temporary, destination); syncParent(destination);
  } finally { fs.rmSync(temporary, { force: true }); }

  return null;
}

function readPointer(filename, sessionId, directory, strict) {
  const root = path.join(directory, filename);
  const pointer = path.join(root, 'pending-diff.json');
  let fd;

  try {
    if (fs.realpathSync(root) !== root) return undefined;
    fd = fs.openSync(pointer, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

    if (fs.fstatSync(fd).size > maxRecordBytes) throw new Error('Pending diff pointer exceeds the per-record limit');
    const record = JSON.parse(fs.readFileSync(fd, 'utf8'));

    if (record.sessionId !== sessionId) return undefined;

    if (!stringValue(record.id) || comparisonRoot(record.capture.baseline) !== root) throw new Error('Invalid pending diff pointer identity');
    comparisonRoot(record.capture.current);

    return record;
  } catch (error) {
    reportPointerError(error, pointer, strict);

    return undefined;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function reportPointerError(error, pointer, strict) {
  if (error.code === 'ENOENT') return;
  const message = `Pending diff pointer preserved at ${pointer}: ${error.message}`;

  if (strict) throw new Error(message);
  process.stderr.write(`${message}\n`);
}

function discoverComparisons(filename, strict) {
  const sessionId = transcriptId(filename); const directory = snapshotParent();
  let entries;

  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }

  const records = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('pi-desktop-diff-')) continue;
    const record = readPointer(entry.name, sessionId, directory, strict);

    if (record) records.push(record);
  }

  return records;
}

function requestStore(filename, request) {
  if (request.action === 'retain') return retainComparison(filename, request);

  const state = recoverStore(filename, request.action === 'load', request.id);
  const hooks = transferHooks(filename);

  if (request.action === 'discover') return discoverComparisons(filename, request.ephemeralSessionId !== undefined);

  if (request.action === 'part') return transfers.appendPart(filename, request.part, state, hooks);

  if (request.action === 'load') return { snapshots: state.snapshots, pending: state.pending, transfers: state.transfers };

  if (request.action === 'pending_ids') return { ids: Object.keys(state.pending) };

  if (request.action === 'pending_status') return { capture: state.pending[request.id] ?? null, completed: completed(state, request.id) };

  if (request.action === 'page') return pages.pageStore(filename, state, request.cursor, { string: stringValue, ordered, maxBytes: maxRecordBytes });

  if (request.action === 'finish') return finishStore(filename, request, state);

  const records = validatedOperations(state, request);

  return saveStore(filename, request, state, records);
}

function transferHooks(filename) {
  return {
    string: stringValue, digest, snapshotValid, owner: transcriptId, maxBytes: maxRecordBytes,
    profile: () => path.dirname(snapshotParent()),
    load: () => readStore(filename, false),
    save: records => {
      for (const record of records) recordBytes(record);
      saveStore(filename, { action: 'part' }, readStore(filename, false), records);
    },
  };
}

function validatedOperations(state, request) {
  const records = operations(state, request);

  for (const record of records) { apply({ snapshots: Object.create(null), pending: Object.create(null) }, record); recordBytes(record); }

  return records;
}

function finishStore(filename, request, state) {
  if (!equal(state.pending[request.id], request.capture)) return { finished: !Object.hasOwn(state.pending, request.id) && completed(state, request.id) };
  saveStore(filename, request, state, validatedOperations(state, request));

  return { finished: true };
}

function saveStore(filename, request, state, records) {
  if (state.legacy || !state.end) migrate(filename, state);
  const fd = fs.openSync(filename, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);

  try {
    const end = state.legacy || !state.end ? fs.fstatSync(fd).size : state.end;
    fs.ftruncateSync(fd, end);

    const append = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);

    try { appendChanges(request, state, records, append); }
    finally { fs.closeSync(append); }

    syncParent(filename);
  } finally { fs.closeSync(fd); }

  return null;
}

function appendChanges(request, state, records, append) {
  if (['replace', 'merge'].includes(request.action) && records.length) {
    records.push(...copyPending(state, records));
  }

  if (records.length) transaction(append, records);
  fs.fsyncSync(append);
}

module.exports = { readStore, readStoreLocked, copyRetainedStoreLocked, requestStore, requestStoreLocked, requestEphemeralStore };
