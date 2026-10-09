const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const diffDatabase = require('./git-diff-database.cjs');
const pages = require('./git-diff-pages.cjs');
const transfers = require('./git-diff-transfer.cjs');
const checkpointIndex = require('./checkpoint-owner-index.cjs');


const maxRecordBytes = 4 * 1024 * 1024 * 6 + 64 * 1024;

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

  if (state.focus !== '*' && state.focus !== record.id) delete capture.snapshot;
  state.pending[record.id] = capture;
}

function completed(state, id) { return state.done.has(id) || Object.hasOwn(state.digests, id); }

function databaseHooks() {
  return {
    profile: () => path.dirname(snapshotParent()), owner: transcriptId, digest, empty: emptyState,
  };
}

function readStore(filename, materialize = true, focus) {
  return diffDatabase.load(filename, databaseHooks(), materialize, focus);
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
  transfers.recoverTransfers(filename, readStore(filename, false), transferHooks(filename));

  return readStore(filename, materialize, focus);
}

function copyRetainedStoreLocked(filename, destination, retainedIds, sessionId, destinationId, preparationOwner) {
  return withStoreLock(filename, () => {
    const state = recoverStore(filename, false);

    if (state.database?.id !== sessionId.toLowerCase()) throw new Error('Fork source session changed; history preserved');
    const pending = [...Object.keys(state.pending), ...discoverComparisons(filename, true).filter(record => !completed(state, record.id)).map(record => record.id)];
    const partial = Object.values(state.transfers).flatMap(transfer => transfer.committed ? [] : [transfer.messageId]);

    if ([...pending, ...partial].some(id => retainedIds.has(id))) throw new Error('Selected source diffs are still pending; recover project changes before forking. Original comparisons were retained.');

    diffDatabase.copy(state, destination, destinationId, retainedIds, preparationOwner);
  });
}

function requestStoreLocked(filename, request) { return withStoreLock(filename, () => requestStore(filename, request)); }

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
  const record = { sessionId: transcriptId(filename), id: request.id, capture: request.capture };
  recordBytes(record);
  checkpointIndex.recordCapture(path.dirname(snapshotParent()), 'pointer', destination, record.sessionId, request.capture);
  require('../session-database.cjs').savePendingDiff(root, record);
  checkpointIndex.replaceCaptures(path.dirname(snapshotParent()), 'pointer', destination, record.sessionId, [request.capture]);

  return null;
}

function readPointer(filename, sessionId, directory, strict) {
  const root = path.join(directory, filename);
  const pointer = path.join(root, 'pending-diff.json');

  try {
    if (fs.realpathSync(root) !== root) return undefined;
    const record = require('../session-database.cjs').pendingDiff(root);

    if (record === undefined) return undefined;
    recordBytes(record);

    if (record.sessionId !== sessionId) return undefined;

    if (!stringValue(record.id) || comparisonRoot(record.capture.baseline) !== root) throw new Error('Invalid pending diff pointer identity');
    comparisonRoot(record.capture.current);

    return record;
  } catch (error) {
    reportPointerError(error, pointer, strict);

    return undefined;
  }
}

function reportPointerError(error, pointer, strict) {
  if (error.code === 'ENOENT') return;
  const message = `Pending diff pointer preserved at ${pointer}: ${error.message}`;

  if (strict) throw new Error(message);
  process.stderr.write(`${message}\n`);
}

function discoverComparisons(filename, strict) {
  const sessionId = transcriptId(filename); const directory = snapshotParent();
  const records = [];

  for (const row of require('../session-database.cjs').pendingDiffs(path.dirname(directory))) {
    if (path.dirname(row.directory) !== directory || !path.basename(row.directory).startsWith('pi-desktop-diff-')) throw new Error('Invalid pending comparison directory');
    const record = readPointer(path.basename(row.directory), sessionId, directory, strict);

    if (record) records.push(record);
  }

  return records;
}

function requestStore(filename, request) {
  if (request.action === 'retain') return retainComparison(filename, request);

  const state = recoverStore(filename, request.action === 'load', request.id);
  const hooks = transferHooks(filename);

  if (request.action === 'discover') return discoverComparisons(filename, false);

  if (request.action === 'part') return transfers.appendPart(filename, request.part, state, hooks);

  if (request.action === 'load') return { snapshots: state.snapshots, pending: state.pending, transfers: state.transfers };

  if (request.action === 'pending_ids') return { ids: Object.keys(state.pending) };

  if (request.action === 'pending_status') return { capture: state.pending[request.id] ?? null, completed: completed(state, request.id) };

  if (request.action === 'page') return diffDatabase.snapshots(state, snapshot => pages.pageDatabase(state, request.cursor, snapshot, { string: stringValue, ordered, maxBytes: maxRecordBytes }));

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
  if (['replace', 'merge'].includes(request.action) && records.length) records.push(...copyPending(state, records));

  if (!records.length) return null;

  for (const record of records) {
    if (record.op === 'pending') checkpointIndex.recordCapture(path.dirname(snapshotParent()), 'diff', filename, transcriptId(filename), record.capture);
  }

  diffDatabase.save(state, records, databaseHooks());
  indexPending(filename, state, records);

  return null;
}

function indexPending(filename, state, records) {
  if (records.some(record => ['pending', 'done', 'remove'].includes(record.op))) {
    const pending = { ...state.pending };

    for (const record of records) {
      if (record.op === 'pending') pending[record.id] = record.capture;
      else if (['done', 'remove'].includes(record.op)) delete pending[record.id];
    }

    checkpointIndex.replaceCaptures(path.dirname(snapshotParent()), 'diff', filename, transcriptId(filename), Object.values(pending));
  }
}

module.exports = { readStore, readStoreLocked, copyRetainedStoreLocked, requestStore, requestStoreLocked };
