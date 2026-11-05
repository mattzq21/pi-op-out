import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lines as lfLines } from './lf-lines.ts';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { createObservation, observeEntry, recordGoals } from './storage-inventory-owners.ts';
import { discoverPublicationDiagnostics } from './storage-inventory-publications.ts';
import * as StorageTransaction from './storage-transaction.ts';

const headerSchema = Type.Object({ type: Type.Literal('session'), id: Type.String({ minLength: 1 }) });

function verifyHeader(header: { piopPublicationId?: unknown }, source) {
  if (!Check(headerSchema, header) || source.sessionId && source.sessionId !== header.id) throw new Error('Diagnostic transcript header differs from its journal');

  if (source.publicationId && header.piopPublicationId !== source.publicationId) throw new Error('Diagnostic transcript publication identity differs from its journal');
}

function stable(before, after) { return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key]); }

async function readTranscript(handle, observation, source) {
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
      observeEntry(observation, entry);
    }
  } finally { stream.destroy(); }

  if (source.digest && (digest.digest('hex') !== source.digest || bytes !== source.bytes)) throw new Error('Diagnostic transcript bytes differ from its exact-digest publication proof');

  return header;
}

async function transcript(file, source, discovery, kind) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const observation = createObservation();

  try {
    const metadata = await handle.stat({ bigint: true });

    if (!metadata.isFile() || await fs.realpath(file) !== file) throw new Error('Diagnostic transcript is not a canonical regular file');

    if (source.identity && source.identity !== metadata.dev + ':' + metadata.ino) throw new Error('Diagnostic transcript inode differs from its journal');
    const header = await readTranscript(handle, observation, source);
    verifyHeader(header, source);

    if (!stable(metadata, await handle.stat({ bigint: true })) || !stable(metadata, await fs.lstat(file, { bigint: true }))) throw new Error('Diagnostic transcript changed during discovery');
    recordGoals(discovery, { observation, readable: true }, { sessionId: header.id, sessionPath: file, kind }, { file, kind });
  } finally { await handle.close(); }
}

async function discoverGoalDiagnostics(profile, discovery) {
  await discoverPublicationDiagnostics(profile, discovery, transcript);
  await discoverTransactionDiagnostics(profile, discovery);
}

async function discoverTransactionDiagnostics(profile, discovery) {
  const storageTransactions = StorageTransaction;
  let staged: ReturnType<typeof storageTransactions.stagedTranscripts> = [];

  try { staged = storageTransactions.stagedTranscripts(profile); }
  catch (error) { discovery.warnings.push('Storage transaction diagnostics unavailable: ' + error.message); }

  for (const entry of staged) {
    if (entry.root !== profile || path.dirname(entry.file) !== entry.staging) {
      discovery.warnings.push(entry.file + ': diagnostic transcript is outside its journal staging folder');
      continue;
    }

    try { await transcript(entry.file, { identity: entry.identity, sessionId: entry.sessionId }, discovery, 'diagnostic-' + entry.kind + '-' + entry.state); }
    catch (error) { if (error.code !== 'ENOENT') discovery.warnings.push(entry.file + ': diagnostic goal reference coverage unavailable: ' + error.message); }
  }

  for (const journal of storageTransactions.stuck(profile)) discovery.warnings.push('Storage transaction ' + journal.id + ' (' + journal.kind + ') is pending: ' + journal.error);

  if (storageTransactions.temporaryCleanupPending(profile)) discovery.warnings.push('Temporary folder cleanup for deleted sessions is pending');
}

export { discoverGoalDiagnostics };
