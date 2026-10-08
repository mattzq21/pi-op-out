const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const hash = body => crypto.createHash('sha256').update(body).digest('hex');

function validPart(part, hooks) {
  if (!hooks.string(part.messageId) || !part.messageId || Buffer.byteLength(part.messageId) > 1024) throw new Error('Invalid diff part message ID');

  validDigest(part.transferId, hooks); validDigest(part.digest, hooks);

  if (!Number.isSafeInteger(part.index) || part.index < 0 || !hooks.string(part.content) || part.content.length > 512 * 1024) throw new Error('Invalid diff part index or size');

  if (![true, false].includes(part.final) || part.content !== Buffer.from(part.content).toString('utf8')) throw new Error('Diff part contains an incomplete Unicode character');
}

function validDigest(value, hooks) {
  if (!hooks.string(value) || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid diff transfer digest or identity');
}

function validTransfer(filename, key, transfer, hooks) {
  if (!hooks.string(transfer.messageId) || !transfer.messageId || Buffer.byteLength(transfer.messageId) > 1024) throw new Error('Invalid staged diff message ID');
  validDigest(transfer.transferId, hooks); validDigest(transfer.digest, hooks);

  if (transfer.owner !== hooks.owner(filename) || key !== `${transfer.messageId}\n${transfer.transferId}`) throw new Error('Staged diff belongs to another identity; preserved');
  validProgress(transfer, hooks);

  if (transfer.committed && transfer.parts.at(-1)?.final !== true) throw new Error('Committed diff has no final receipt; preserved');
}

function validProgress(transfer, hooks) {
  if (!Number.isSafeInteger(transfer.offset) || transfer.offset < 0 || transfer.offset > hooks.maxBytes) throw new Error('Invalid staged diff byte count; preserved');

  if (!Array.isArray(transfer.parts) || transfer.nextIndex !== transfer.parts.length || ![true, false].includes(transfer.committed)) throw new Error('Invalid staged diff receipt state; preserved');
  let size = 0;

  for (let index = 0; index < transfer.parts.length; index += 1) {
    const part = transfer.parts[index];
    validReceipt(part, index === transfer.parts.length - 1, hooks); size += part.length;
  }

  if (size !== transfer.offset) throw new Error('Staged diff receipts do not match their byte count; preserved');
}

function validReceipt(part, last, hooks) {
  validDigest(part.digest, hooks);

  if (!Number.isSafeInteger(part.length) || part.length < 0 || part.length > 3 * 512 * 1024) throw new Error('Invalid staged diff receipt size; preserved');

  if (![true, false].includes(part.final) || part.final && !last) throw new Error('Invalid staged diff final receipt; preserved');
}

function sync(directory) {
  const fd = fs.openSync(directory, 'r');

  try { fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function directory(root) {
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { mode: 0o700 });
    sync(path.dirname(root));
  }

  if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root) throw new Error(`Invalid diff transfer directory; preserved: ${root}`);
}

function transferPath(transfer, hooks) {
  if (!hooks.string(transfer.owner) || !/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(transfer.owner)) throw new Error('Invalid diff transfer owner');

  if (!hooks.string(transfer.transferId) || !/^[a-f0-9]{64}$/.test(transfer.transferId) || !hooks.string(transfer.messageId)) throw new Error('Invalid diff transfer provenance');
  const root = path.join(fs.realpathSync(hooks.profile()), 'git-diff-transfers');

  directory(root);
  const owner = path.join(root, transfer.owner);

  directory(owner);

  return path.join(owner, `${hash(transfer.messageId)}-${transfer.transferId}.part`);
}

function ownerRecord(key, transfer) { return { op: 'transfer', id: transfer.messageId, key, transfer }; }

function initialTransfer(filename, part, key, state, hooks) {
  const previous = state.transfers[key];

  if (previous) {
    validTransfer(filename, key, previous, hooks);

    for (const field of ['messageId', 'transferId', 'digest']) if (previous[field] !== part[field]) throw new Error('Diff transfer identity changed; staged contents preserved');

    if (previous.owner !== hooks.owner(filename)) throw new Error('Diff transfer belongs to another conversation; preserved');

    return previous;
  }

  if (part.index !== 0) throw new Error('Diff transfer must start with index zero');
  const transfer = { owner: hooks.owner(filename), messageId: part.messageId, transferId: part.transferId, digest: part.digest, nextIndex: 0, offset: 0, parts: [], committed: false };
  const file = transferPath(transfer, hooks);

  if (fs.existsSync(file)) throw new Error(`Unattributed diff transfer contents preserved: ${file}`);
  hooks.save([ownerRecord(key, transfer)]);

  return transfer;
}

function openTransfer(file, transfer) {
  const flags = fs.constants.O_RDWR | fs.constants.O_NOFOLLOW;
  let fd;

  try { fd = fs.openSync(file, flags); }
  catch (error) {
    if (error.code !== 'ENOENT' || transfer.offset !== 0) throw error;
    fd = fs.openSync(file, flags | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.fsyncSync(fd); sync(path.dirname(file));
  }

  if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).nlink !== 1) { fs.closeSync(fd); throw new Error(`Diff transfer is not a private regular file: ${file}`); }

  return fd;
}

function verifyPrefix(fd, transfer) {
  if (fs.fstatSync(fd).size < transfer.offset) throw new Error('Staged diff prefix is incomplete; preserved');
  let offset = 0;

  for (const part of transfer.parts) {
    const bytes = Buffer.alloc(part.length);
    let count = 0;

    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, offset + count);

      if (!read) throw new Error('Staged diff prefix ended unexpectedly; preserved');
      count += read;
    }

    if (hash(bytes) !== part.digest) throw new Error('Staged diff prefix changed; preserved');
    offset += bytes.length;
  }

  if (offset !== transfer.offset) throw new Error('Invalid staged diff progress; preserved');
}

function appendBytes(fd, body, offset) {
  let written = 0;

  while (written < body.length) written += fs.writeSync(fd, body, written, body.length - written, offset + written);
}

function acceptPart(fd, transfer, part, key, hooks) {
  const body = Buffer.from(part.content);
  const description = { digest: hash(body), length: body.length, final: part.final };

  if (part.index < transfer.nextIndex) {
    if (JSON.stringify(transfer.parts[part.index]) !== JSON.stringify(description)) throw new Error('Retried diff part changed; staged contents preserved');

    return transfer;
  }

  if (part.index !== transfer.nextIndex || transfer.parts.at(-1)?.final) throw new Error('Diff part is out of order; staged contents preserved');

  if (transfer.offset + body.length > hooks.maxBytes) throw new Error('Permanent diff limit: staged snapshot is too large; contents preserved');
  fs.ftruncateSync(fd, transfer.offset);
  appendBytes(fd, body, transfer.offset); fs.fsyncSync(fd);
  const updated = { ...transfer, nextIndex: transfer.nextIndex + 1, offset: transfer.offset + body.length, parts: [...transfer.parts, description] };

  hooks.save([ownerRecord(key, updated)]);

  return updated;
}

function completedSnapshot(fd, transfer, hooks) {
  verifyPrefix(fd, transfer);
  const body = Buffer.alloc(transfer.offset);

  let count = 0;

  while (count < body.length) {
    const read = fs.readSync(fd, body, count, body.length - count, count);

    if (!read) throw new Error('Staged diff ended before completion; preserved');
    count += read;
  }

  if (hash(body) !== transfer.digest) throw new Error('Diff transfer digest mismatch; staged contents preserved');
  const snapshot = JSON.parse(body.toString('utf8'));

  if (!hooks.snapshotValid(snapshot)) throw new Error('Invalid completed diff snapshot; staged contents preserved');

  return snapshot;
}

function commitTransfer(fd, transfer, key, state, hooks) {
  const snapshot = completedSnapshot(fd, transfer, hooks);
  const previous = state.digests[transfer.messageId];

  if (previous !== undefined && previous !== hooks.digest(snapshot)) throw new Error('Immutable diff message already has different contents; transfer preserved');

  if (state.pending[transfer.messageId]) throw new Error('A pending comparison owns this diff message; transfer preserved');
  const records = [];

  if (previous === undefined) records.push({ op: 'set', id: transfer.messageId, snapshot });
  records.push(ownerRecord(key, { ...transfer, committed: true }));
  hooks.save(records);
}

function retire(transfer, hooks) {
  const file = transferPath(transfer, hooks);
  let fd;

  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }

  try {
    validFinalFile(fd, transfer, hooks);
    completedSnapshot(fd, transfer, hooks);
  } finally { fs.closeSync(fd); }

  fs.unlinkSync(file); sync(path.dirname(file));
}

function appendPart(filename, part, state, hooks) {
  validPart(part, hooks);
  const key = `${part.messageId}\n${part.transferId}`;
  const transfer = initialTransfer(filename, part, key, state, hooks);

  if (transfer.committed) {
    const description = { digest: hash(Buffer.from(part.content)), length: Buffer.byteLength(part.content), final: part.final };

    if (JSON.stringify(transfer.parts[part.index]) !== JSON.stringify(description)) throw new Error('Retried committed diff part changed');
    retire(transfer, hooks);

    return { complete: true };
  }

  const file = transferPath(transfer, hooks);
  const fd = openTransfer(file, transfer);
  let updated;

  try {
    verifyPrefix(fd, transfer);
    updated = acceptPart(fd, transfer, part, key, hooks);

    if (updated.parts.at(-1)?.final) commitTransfer(fd, updated, key, state, hooks);
  } finally { fs.closeSync(fd); }

  if (!updated.parts.at(-1)?.final) return { complete: false };
  retire(updated, hooks);

  return { complete: true };
}

function validFinalFile(fd, transfer, hooks) {
  const metadata = fs.fstatSync(fd);

  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== transfer.offset || transfer.offset > hooks.maxBytes) throw new Error('Completed diff transfer is not its private staged file; preserved');
}

function recoverFinalTransfer(key, transfer, hooks) {
  const fd = fs.openSync(transferPath(transfer, hooks), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try {
    validFinalFile(fd, transfer, hooks);
    commitTransfer(fd, transfer, key, hooks.load(), hooks);
  } finally { fs.closeSync(fd); }

  retire(transfer, hooks);
}

function recoverTransfers(filename, state, hooks) {
  for (const [key, transfer] of Object.entries(state.transfers)) {
    try {
      validTransfer(filename, key, transfer, hooks);

      if (transfer.committed) retire(transfer, hooks);
      else if (transfer.parts.at(-1)?.final === true) recoverFinalTransfer(key, transfer, hooks);
    } catch (error) { process.stderr.write(`Diff transfer recovery retained for ${filename}, ${key}: ${error.message}\n`); }
  }
}

module.exports = { appendPart, recoverTransfers };
