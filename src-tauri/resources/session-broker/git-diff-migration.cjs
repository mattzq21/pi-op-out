const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createMigration(hooks) {
  const { header, maxRecordBytes, stringValue, snapshotValid, withStoreLock, readStore, digest, saveStore, syncParent, writeAll, recordBytes } = hooks;

  function shardDirectory(filename) { return path.join(filename.replace(/\.diffs\.json$/, '.snapshots'), 'diffs'); }

  function shardFiles(filename) {
    const directory = shardDirectory(filename);
    let metadata;

    try { metadata = fs.lstatSync(directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }

    if (!filename.endsWith('.diffs.json') || !metadata.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Invalid legacy diff shard directory; preserved');

    return fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort().map(name => path.join(directory, name));
  }

  function readShard(file) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

    try {
      const metadata = fs.fstatSync(fd);

      if (!metadata.isFile() || metadata.size > maxRecordBytes) throw new Error('Invalid or oversized diff shard; preserved');
      const record = JSON.parse(fs.readFileSync(fd, 'utf8'));

      if (!stringValue(record.messageId) || `${crypto.createHash('sha256').update(record.messageId).digest('hex')}.json` !== path.basename(file) || !snapshotValid(record.snapshot)) throw new Error('Invalid diff shard identity or snapshot; preserved');

      return { op: 'set', id: record.messageId, snapshot: record.snapshot };
    } finally { fs.closeSync(fd); }
  }

  function migrateShardedStore(filename) {
    const files = shardFiles(filename);

    if (!files.length) { prepareLegacy(filename);

      return; }

    const lockfile = path.join(path.dirname(shardDirectory(filename)), 'diff-write');

    withStoreLock(lockfile, () => {
      prepareLegacy(filename);
      const state = readStore(filename, false);

      for (const file of shardFiles(filename)) importShard(filename, file, state);
    });
  }

  function importShard(filename, file, state) {
    const record = readShard(file);
    const hash = digest(record.snapshot);
    const existing = state.digests[record.id];

    if (existing !== undefined && existing !== hash) throw new Error(`Diff shard conflicts with journal message ${record.id}; both copies preserved at ${file}`);

    if (existing === undefined) {
      if (state.done.has(record.id)) throw new Error(`Diff shard conflicts with a completed journal message ${record.id}; preserved at ${file}`);
      saveStore(filename, { action: 'import' }, state, [record]);
      state.end = fs.statSync(filename).size;
      state.digests[record.id] = hash;
    }

    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }

    syncParent(filename);
    fs.unlinkSync(file); syncParent(file);
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

        for (const file of shardFiles(filename)) writeAll(fd, recordBytes(readShard(file)));
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

  return migrateShardedStore;
}

module.exports = { createMigration };
