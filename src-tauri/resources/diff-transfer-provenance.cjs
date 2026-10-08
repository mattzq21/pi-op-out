const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Type } = require('typebox');
const { Check } = require('typebox/value');

const digest = Type.String({ pattern: '^[a-f0-9]{64}$' });

const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

const partSchema = Type.Object({ digest, length: integer, final: Type.Boolean() }, { additionalProperties: false });

const transferSchema = Type.Object({ owner: Type.String({ pattern: '^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' }), messageId: Type.String({ minLength: 1 }), transferId: digest, digest, nextIndex: integer, offset: integer, parts: Type.Array(partSchema), committed: Type.Boolean() }, { additionalProperties: false });

function progress(transfer) {
  const offset = transfer.parts.reduce((sum, part) => sum + part.length, 0);

  if (!Number.isSafeInteger(offset) || offset !== transfer.offset || transfer.nextIndex !== transfer.parts.length) throw new Error('Invalid durable diff transfer progress; source log and staging retained');

  if (transfer.parts.slice(0, -1).some(part => part.final)) throw new Error('Diff transfer has parts after its final packet; retained');

  if (transfer.committed && !transfer.parts.at(-1)?.final) throw new Error('Committed diff transfer has no final packet; retained');
}

function validateTransfer(key, transfer) {
  if (!Check(transferSchema, transfer)) throw new Error('Invalid durable diff transfer metadata; source log and staging retained');

  if (Buffer.byteLength(transfer.messageId) > 1024 || key !== transfer.messageId + '\n' + transfer.transferId) throw new Error('Diff transfer key does not match its durable identity; retained');
  progress(transfer);

  return transfer;
}

function transferPath(profile, transfer) {
  if (!path.isAbsolute(profile) || path.normalize(profile) !== profile) throw new Error('Diff transfer profile path is not canonical; retained');
  const message = createHash('sha256').update(transfer.messageId).digest('hex');

  return path.join(profile, 'git-diff-transfers', transfer.owner, message + '-' + transfer.transferId + '.part');
}

function inspectStage(file) {
  const namespace = path.dirname(path.dirname(file));

  for (const directory of [namespace, path.dirname(file)]) {
    try {
      if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Diff transfer directory ownership is unavailable or changed; retained: ' + directory);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  let fd;

  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }

  try {
    const metadata = fs.fstatSync(fd, { bigint: true });

    if (!metadata.isFile() || metadata.nlink !== 1n) throw new Error('Diff transfer is not a private regular file; retained: ' + file);

    return { identity: metadata.dev + ':' + metadata.ino, size: Number(metadata.size) };
  } finally { fs.closeSync(fd); }
}

function inspectTransfer(profile, key, value) {
  const transfer = validateTransfer(key, value);
  const file = transferPath(profile, transfer);
  const metadata = inspectStage(file);

  return { transfer, file, metadata };
}

module.exports = { validateTransfer, transferPath, inspectStage, inspectTransfer };
