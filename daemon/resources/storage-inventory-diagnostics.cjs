const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { lines: lfLines } = require('./lf-lines.cjs');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { discoverPublicationDiagnostics } = require('./storage-inventory-publications.cjs');

const headerSchema = Type.Object({ type: Type.Literal('session'), id: Type.String({ minLength: 1 }) });

function verifyHeader(header, source) {
  if (!Check(headerSchema, header) || source.sessionId && source.sessionId !== header.id) throw new Error('Diagnostic transcript header differs from its journal');

  if (source.publicationId && header.piopPublicationId !== source.publicationId) throw new Error('Diagnostic transcript publication identity differs from its journal');
}

function stable(before, after) { return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key]); }

async function readTranscript(handle, source) {
  const digest = createHash('sha256');
  let bytes = 0;
  let header;
  const stream = handle.createReadStream({ autoClose: false });
  stream.on('data', chunk => { digest.update(chunk); bytes += chunk.length; });

  try {
    for await (const line of lfLines(stream)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      header ??= entry;
    }
  } finally { stream.destroy(); }

  if (source.digest && (digest.digest('hex') !== source.digest || bytes !== source.bytes)) throw new Error('Diagnostic transcript bytes differ from its exact-digest publication proof');

  return header;
}

async function transcript(file, source) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const metadata = await handle.stat({ bigint: true });

    if (!metadata.isFile() || await fs.realpath(file) !== file) throw new Error('Diagnostic transcript is not a canonical regular file');

    if (source.identity && source.identity !== metadata.dev + ':' + metadata.ino) throw new Error('Diagnostic transcript inode differs from its journal');
    const header = await readTranscript(handle, source);
    verifyHeader(header, source);

    if (!stable(metadata, await handle.stat({ bigint: true })) || !stable(metadata, await fs.lstat(file, { bigint: true }))) throw new Error('Diagnostic transcript changed during discovery');
  } finally { await handle.close(); }
}

async function discoverDiagnostics(profile, discovery) {
  await discoverPublicationDiagnostics(profile, discovery, transcript);
  discoverTemporaryCleanup(profile, discovery);
}

function discoverTemporaryCleanup(profile, discovery) {
  if (require('./session-database.cjs').cleanupRequest(profile, 'temporary-chat') !== undefined) discovery.warnings.push('Temporary folder cleanup for deleted sessions is pending');
}

module.exports = { discoverDiagnostics };
