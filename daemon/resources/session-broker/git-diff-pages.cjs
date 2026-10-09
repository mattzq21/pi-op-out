const fs = require('node:fs');

const pageBytes = 8 * 1024 * 1024 - 64 * 1024;

function pageCursor(cursor, revision, hooks) {
  if (!hooks.string(cursor)) throw new Error('Invalid diff page cursor');

  if (!cursor) return { after: undefined, offset: 0 };
  const value = JSON.parse(cursor);

  if (value.revision !== revision) throw new Error('Diff history changed while paging; retry from the first page');

  if (value.after !== null && !hooks.string(value.after)) throw new Error('Invalid diff page message ID');
  const offset = value.offset ?? 0;

  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid diff fragment offset');

  return { after: value.after ?? undefined, offset };
}

function nextCursor(after, revision, offset) { return JSON.stringify({ after: after ?? null, revision, offset }); }

function fragment(id, snapshot, cursor, revision, more, hooks) {
  const body = Buffer.from(JSON.stringify(snapshot, hooks.ordered));
  const offset = cursor.offset;

  if (offset >= body.length || (body[offset] & 0xc0) === 0x80) throw new Error('Invalid diff fragment offset');
  let end = Math.min(body.length, offset + 1024 * 1024);

  while (end < body.length && (body[end] & 0xc0) === 0x80) end -= 1;
  let content = body.subarray(offset, end).toString('utf8');

  if (content.length > 512 * 1024) {
    let units = 512 * 1024;
    const last = content.charCodeAt(units - 1);

    if (last >= 0xd800 && last <= 0xdbff) units -= 1;
    content = content.slice(0, units); end = offset + Buffer.byteLength(content);
  }

  const complete = end === body.length;
  const next = complete ? (more ? nextCursor(id, revision, 0) : null) : nextCursor(cursor.after, revision, end);

  return { snapshots: {}, next, fragment: { messageId: id, content, complete } };
}

function collect(read, state, cursor, revision, hooks) {
  const ids = Object.keys(state.positions).filter(id => cursor.after === undefined || id > cursor.after).sort();
  const snapshots = Object.create(null); let bytes = 0; let last;

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const snapshot = read(id);
    const size = Buffer.byteLength(JSON.stringify({ [id]: snapshot }, hooks.ordered));

    if (last !== undefined && bytes + size > pageBytes) return { snapshots, next: nextCursor(last, revision, 0) };

    if (size > pageBytes || cursor.offset > 0) return fragment(id, snapshot, cursor, revision, index + 1 < ids.length, hooks);
    snapshots[id] = snapshot; bytes += size; last = id;
  }

  if (cursor.offset) throw new Error('Diff fragment cursor has no snapshot');

  return { snapshots, next: null };
}

function pageStore(filename, state, cursor, hooks) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try {
    const metadata = fs.fstatSync(fd, { bigint: true });
    const revision = `${state.end}:${metadata.size}:${metadata.mtimeNs}:${metadata.ino}`;

    return collect(id => indexedSnapshot(fd, state.positions[id], id, hooks.maxBytes), state, pageCursor(cursor, revision, hooks), revision, hooks);
  } finally { fs.closeSync(fd); }
}

function pageDatabase(state, cursor, read, hooks) {
  const revision = `${state.database?.id ?? ''}:${state.end}`;

  return collect(read, state, pageCursor(cursor, revision, hooks), revision, hooks);
}

function indexedSnapshot(fd, position, id, maxBytes) {
  const buffer = Buffer.alloc(64 * 1024); const pieces = []; let size = 0;

  while (size <= maxBytes) {
    const count = fs.readSync(fd, buffer, 0, buffer.length, position + size);

    if (!count) throw new Error('Diff index ended before its saved record; file preserved');
    const end = buffer.subarray(0, count).indexOf(10);
    const piece = buffer.subarray(0, end >= 0 ? end + 1 : count);
    pieces.push(Buffer.from(piece)); size += piece.length;

    if (size > maxBytes) throw new Error('Permanent diff limit: individual page record is too large');

    if (end >= 0) {
      const record = JSON.parse(Buffer.concat(pieces, size).toString('utf8'));

      if (record.op !== 'set' || record.id !== id) throw new Error('Diff index did not match the saved record; file preserved');

      return record.snapshot;
    }
  }

  throw new Error('Permanent diff limit: individual page record is too large');
}

module.exports = { pageStore, indexedSnapshot, pageDatabase };
