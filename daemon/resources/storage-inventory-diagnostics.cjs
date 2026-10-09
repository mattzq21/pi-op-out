const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createInterface } = require('node:readline');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { createObservation, observeEntry, recordGoals } = require('./storage-inventory-owners.cjs');
const { discoverPublicationDiagnostics } = require('./storage-inventory-publications.cjs');

const identitySchema = Type.String({ pattern: '^\\d+:\\d+$' });

const journalSchema = Type.Object({ version: Type.Literal(2), kind: Type.Union([Type.Literal('archive'), Type.Literal('delete')]), id: Type.String({ pattern: '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' }), root: Type.String(), container: Type.String(), containerIdentity: identitySchema, state: Type.String() });

const archiveSchema = Type.Object({ sessionId: Type.String(), backup: Type.String(), prepared: Type.String(), backupIdentity: Type.Optional(Type.Object({ identity: identitySchema })), preparedIdentity: Type.Optional(Type.Object({ identity: identitySchema })) });

const deletedSchema = Type.Object({ source: Type.String(), staged: Type.String(), identity: Type.Object({ identity: identitySchema }) });

const headerSchema = Type.Object({ type: Type.Literal('session'), id: Type.String({ minLength: 1 }) });

function archiveSources(journal) {
  if (!Check(Type.Array(archiveSchema), journal.records)) throw new Error('Invalid archive diagnostic transcript mapping');

  if (journal.resourcePeers !== undefined && !Check(Type.Array(archiveSchema), journal.resourcePeers)) throw new Error('Invalid archived peer diagnostic mapping');
  const records = [...journal.records, ...journal.resourcePeers ?? []];

  return records.flatMap(record => [
    { file: record.backup, sessionId: record.sessionId, identity: record.backupIdentity?.identity },
    { file: record.prepared, sessionId: record.sessionId, identity: record.preparedIdentity?.identity },
    { file: record.rollbackCopy ?? record.rollback, sessionId: record.sessionId, identity: record.rollbackIdentity?.identity },
  ]);
}

function diagnosticSources(journal) {
  if (journal.kind === 'archive') return archiveSources(journal);

  if (!Check(Type.Array(deletedSchema), journal.files)) throw new Error('Invalid deletion diagnostic transcript mapping');

  return journal.files.flatMap(file => file.source.endsWith('.jsonl') ? [{ file: file.staged, identity: file.identity.identity }] : []);
}

function validateLocation(profile, namespace, directory, journal, metadata) {
  if (!Check(journalSchema, journal) || journal.root !== profile || journal.id !== path.basename(directory)) throw new Error('Diagnostic journal ownership is unresolved');

  if (journal.container !== path.join(profile, journal.kind + '-transactions', journal.id) || journal.containerIdentity !== metadata.dev + ':' + metadata.ino) throw new Error('Diagnostic journal container identity changed');

  if (namespace !== journal.kind + '-transactions' && !(journal.kind === 'delete' && namespace === 'deleted-sessions')) throw new Error('Diagnostic journal kind differs from its storage namespace');
}

function verifyHeader(header, source) {
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
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      header ??= entry;
      observeEntry(observation, entry);
    }
  } finally { lines.close(); stream.destroy(); }

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

async function inspectDirectory(profile, namespace, directory, discovery, journal) {
  const metadata = await fs.lstat(directory, { bigint: true });

  if (!metadata.isDirectory() || await fs.realpath(directory) !== directory) throw new Error('Diagnostic journal container has ambiguous ancestry');
  validateLocation(profile, namespace, directory, journal, metadata);

  for (const source of diagnosticSources(journal)) {
    if (!source.file) continue;

    if (path.dirname(source.file) !== journal.container) throw new Error('Diagnostic transcript is outside its journal container');
    const file = path.join(directory, path.basename(source.file));

    try { await transcript(file, source, discovery, 'diagnostic-' + journal.kind + '-' + journal.state); }
    catch (error) { if (error.code !== 'ENOENT') discovery.warnings.push(file + ': diagnostic goal reference coverage unavailable: ' + error.message); }
  }
}

async function discoverGoalDiagnostics(profile, discovery) {
  await discoverPublicationDiagnostics(profile, discovery, transcript);

  for (const { record } of require('./deletion-records.cjs').list(profile)) {
    if (!record) continue;

    const directory = await fs.lstat(record.container).then(() => record.container, error => {
      if (error.code !== 'ENOENT') throw error;

      return record.garbagePath;
    });

    try { await inspectDirectory(profile, path.basename(path.dirname(directory)), directory, discovery, record); }
    catch (error) { if (error.code !== 'ENOENT') discovery.warnings.push(directory + ': diagnostic goal ownership unavailable: ' + error.message); }
  }


  const archives = require('./archive-records.cjs');

  for (const directory of archives.list(profile)) {
    try {
      const record = archives.read(directory);

      if (record) await inspectDirectory(profile, 'archive-transactions', directory, discovery, record);
    } catch (error) { if (error.code !== 'ENOENT') discovery.warnings.push(directory + ': diagnostic goal ownership unavailable: ' + error.message); }
  }
}

module.exports = { discoverGoalDiagnostics };
