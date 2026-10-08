const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const header = 'PIOP-DIFFS-1\n';

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
  return stringValue(snapshot) || objectValue(snapshot) && stringValue(snapshot.patch) && stringValue(snapshot.repositoryRoot) && (snapshot.toolPaths === undefined || Array.isArray(snapshot.toolPaths) && snapshot.toolPaths.every(mappingValid));
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
    default: throw new Error('Unknown diff log operation; file preserved');
  }
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

  for (const [id, capture] of Object.entries(transaction.pending)) state.pending[id] = capture;

  for (const id of transaction.removed) { delete state.snapshots[id]; delete state.digests[id]; delete state.positions[id]; }

  for (const id of transaction.done) delete state.pending[id];
}

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

    return { snapshots, digests, pending: Object.create(null), end: 0, legacy: true };
  } finally { fs.closeSync(fd); }
}

function emptyState() { return { snapshots: Object.create(null), digests: Object.create(null), positions: Object.create(null), pending: Object.create(null), end: 0, legacy: false }; }

function readStoreLocked(filename) {
  const fd = fs.openSync(`${filename}.lock`, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);

  try {
    const result = spawnSync('flock', ['--exclusive', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 30000 });

    if (result.error) throw result.error;

    if (result.status !== 0) throw new Error(`Could not lock source diffs: ${result.stderr.toString('utf8').trim()}`);

    return readStore(filename);
  } finally { fs.closeSync(fd); }
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

function prepareLegacy(filename) {
  let source;

  try { source = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }

  try {
    const prefix = Buffer.alloc(5); const count = fs.readSync(source, prefix, 0, prefix.length, 0);

    if (count && prefix.toString() !== 'PIOP-') migrateLegacy(filename, source);
  } finally { fs.closeSync(source); }
}

function migrateLegacy(filename, source) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;

  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);

    try {
      writeAll(fd, Buffer.from(`${header}{"op":"begin"}\n`));
      streamLegacy(source, record => writeAll(fd, recordBytes(record)));
      writeAll(fd, Buffer.from('{"op":"commit"}\n')); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }

    fs.renameSync(temporary, filename); syncParent(filename);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function streamLegacy(source, publish) {
  const frame = { started: false, done: false, quoted: false, escaped: false, depth: 0, segments: [], size: 0, entries: false, separator: false };
  const buffer = Buffer.alloc(64 * 1024); let position = 0;

  for (;;) {
    const count = fs.readSync(source, buffer, 0, buffer.length, position);

    if (!count) break;
    position += count;
    legacyChunk(frame, buffer.subarray(0, count), publish);
  }

  if (!frame.done) throw new Error('Incomplete legacy diff map; file preserved');
}

function legacyChunk(frame, buffer, publish) {
  let start = 0;

  for (let index = 0; index < buffer.length; index++) {
    const boundary = legacyBoundary(frame, buffer[index]);

    if (boundary === 'start') start = index + 1;
    else if (boundary === 'entry' || boundary === 'end') {
      legacyEntry(frame, buffer.subarray(start, index), boundary, publish);
      frame.done = boundary === 'end'; frame.separator = boundary === 'entry'; start = index + 1;
    }
  }

  if (frame.started && !frame.done) legacySegment(frame, buffer.subarray(start));
}

function legacyBoundary(frame, byte) {
  if (!frame.started) {
    if (byte === 123) {
      frame.started = true;

      return 'start';
    }

    if (![9, 10, 13, 32].includes(byte)) throw new Error('Legacy diff storage must be an object; file preserved');

    return undefined;
  }

  if (frame.done) {
    if (![9, 10, 13, 32].includes(byte)) throw new Error('Trailing legacy diff data; file preserved');

    return undefined;
  }

  if (frame.quoted) {
    legacyQuote(frame, byte);

    return undefined;
  }

  if (byte === 34) {
    frame.quoted = true;

    return undefined;
  }

  return legacyNesting(frame, byte);
}

function legacyQuote(frame, byte) {
  if (frame.escaped) frame.escaped = false;
  else if (byte === 92) frame.escaped = true;
  else if (byte === 34) frame.quoted = false;
}

function legacyNesting(frame, byte) {
  if (byte === 44 && frame.depth === 0) return 'entry';

  if (byte === 125 && frame.depth === 0) return 'end';

  if (byte === 123 || byte === 91) frame.depth++;
  else if (byte === 125 || byte === 93) frame.depth--;

  if (frame.depth < 0) throw new Error('Invalid legacy diff nesting; file preserved');

  return undefined;
}

function legacySegment(frame, part) {
  frame.size += part.length;

  if (frame.size > maxRecordBytes) throw new Error('Permanent diff limit: individual legacy record is too large; file preserved');
  frame.segments.push(Buffer.from(part));
}

function legacyEntry(frame, part, boundary, publish) {
  legacySegment(frame, part);
  const text = Buffer.concat(frame.segments, frame.size).toString('utf8').trim();
  frame.segments = []; frame.size = 0;

  if (!text && boundary === 'end' && !frame.entries && !frame.separator) return;
  const entries = Object.entries(JSON.parse(`{${text}}`));

  if (entries.length !== 1 || !snapshotValid(entries[0][1])) throw new Error('Invalid legacy diff entry; file preserved');
  const [id, snapshot] = entries[0];
  publish({ op: 'set', id, snapshot }); frame.entries = true; frame.separator = false;
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
  else if (Object.hasOwn(state.digests, request.id)) return [];

  return [{ op: 'pending', id: request.id, capture: request.capture }];
}

function copyPending(state, records) {
  return records.map(record => {
    if (state.pending[record.id] && state.pending[record.id].source !== 'copy') throw new Error('An unfinished comparison owns this message; copy retained for retry');

    return { op: 'pending', id: record.id, capture: { source: 'copy', ready: true, snapshot: record.snapshot ?? null, remove: record.op === 'remove' } };
  });
}

function snapshotParent() {
  return path.join(process.env.PIOP_DIFF_HOME || os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop', 'git-snapshots');
}

function transcriptId(filename) {
  const fd = fs.openSync(filename.replace(/\.diffs\.json$/, '.jsonl'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try {
    const buffer = Buffer.alloc(16 * 1024);
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

function readPointer(filename, sessionId, directory) {
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
    if (error.code !== 'ENOENT') process.stderr.write(`Pending diff pointer preserved at ${pointer}: ${error.message}\n`);

    return undefined;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function discoverComparisons(filename) {
  const sessionId = transcriptId(filename); const directory = snapshotParent();
  let entries;

  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }

  const records = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('pi-desktop-diff-')) continue;
    const record = readPointer(entry.name, sessionId, directory);

    if (record) records.push(record);
  }

  return records;
}

function requestStore(filename, request) {
  if (request.action === 'retain') return retainComparison(filename, request);

  if (request.action === 'discover') return discoverComparisons(filename);

  prepareLegacy(filename);
  const state = readStore(filename, request.action === 'load', request.id);

  if (request.action === 'load') return { snapshots: state.snapshots, pending: state.pending };

  if (request.action === 'pending_ids') return { ids: Object.keys(state.pending) };

  if (request.action === 'pending_status') return { capture: state.pending[request.id] ?? null, completed: Object.hasOwn(state.digests, request.id) };

  if (request.action === 'page') return pageStore(filename, state, request.cursor);

  if (request.action === 'finish') return finishStore(filename, request, state);

  const records = validatedOperations(state, request);

  return saveStore(filename, request, state, records);
}

function validatedOperations(state, request) {
  const records = operations(state, request);

  for (const record of records) { apply({ snapshots: Object.create(null), pending: Object.create(null) }, record); recordBytes(record); }

  return records;
}

function finishStore(filename, request, state) {
  if (!equal(state.pending[request.id], request.capture)) return { finished: !Object.hasOwn(state.pending, request.id) };
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

    try { appendChanges(filename, request, state, records, append); }
    finally { fs.closeSync(append); }

    syncParent(filename);
  } finally { fs.closeSync(fd); }

  return null;
}

function appendChanges(filename, request, state, records, append) {
  if (['replace', 'merge'].includes(request.action) && records.length) {
    const pending = copyPending(state, records);

    for (const record of pending) recordBytes(record);
    transaction(append, pending); syncParent(filename);

    for (const record of pending) records.push({ op: 'done', id: record.id });
  }

  if (records.length) transaction(append, records);
  fs.fsyncSync(append);
}

function pageStore(filename, state, cursor) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try {
    const metadata = fs.fstatSync(fd, { bigint: true });
    const revision = `${state.end}:${metadata.size}:${metadata.mtimeNs}:${metadata.ino}`;
    const after = pageCursor(cursor, revision);

    return collectPage(fd, state, after, revision);
  } finally { fs.closeSync(fd); }
}

function pageCursor(cursor, revision) {
  if (!stringValue(cursor)) throw new Error('Invalid diff page cursor');

  if (!cursor) return undefined;
  const value = JSON.parse(cursor);

  if (value.revision !== revision) throw new Error('Diff history changed while paging; retry from the first page');

  if (!stringValue(value.after)) throw new Error('Invalid diff page message ID');

  return value.after;
}

function collectPage(fd, state, after, revision) {
  const ids = Object.keys(state.positions).filter(id => after === undefined || id > after).sort();
  const snapshots = Object.create(null); let bytes = 0; let last;

  for (const id of ids) {
    const snapshot = indexedSnapshot(fd, state.positions[id], id);
    const size = Buffer.byteLength(JSON.stringify({ [id]: snapshot }));

    if (last !== undefined && bytes + size > 8 * 1024 * 1024) return { snapshots, next: JSON.stringify({ after: last, revision }) };
    snapshots[id] = snapshot; bytes += size; last = id;
  }

  return { snapshots, next: null };
}

function indexedSnapshot(fd, position, id) {
  const buffer = Buffer.alloc(64 * 1024); const pieces = []; let size = 0;

  while (size <= maxRecordBytes) {
    const count = fs.readSync(fd, buffer, 0, buffer.length, position + size);

    if (!count) throw new Error('Diff index ended before its saved record; file preserved');
    const end = buffer.subarray(0, count).indexOf(10);
    const piece = buffer.subarray(0, end >= 0 ? end + 1 : count);
    pieces.push(Buffer.from(piece)); size += piece.length;

    if (end >= 0) {
      const record = JSON.parse(Buffer.concat(pieces, size).toString('utf8'));

      if (record.op !== 'set' || record.id !== id) throw new Error('Diff index did not match the saved record; file preserved');

      return record.snapshot;
    }
  }

  throw new Error('Permanent diff limit: individual page record is too large');
}

module.exports = { readStore, readStoreLocked, requestStore };
