const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const tables = require('../session-database.cjs');

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const candidateSchema = Type.Object({ path: Type.String(), identity: Type.String({ pattern: '^\\d+:\\d+$' }) });

const retentionSchema = Type.Object({ directories: Type.Array(candidateSchema), sessionIds: Type.Array(Type.String()) });

const recordSchema = Type.Object({ version: Type.Literal(1), id: Type.String(), origin: Type.String(), pending: retentionSchema });

function metadata(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function identity(info) { return `${info.dev}:${info.ino}`; }

function sync(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function candidatePath(root, file) {
  if (path.resolve(file) !== file) return false;
  const relative = path.relative(root, file).split(path.sep);

  const goal = ['sessions', 'archived'].includes(relative[0])
    && relative.at(-2) === 'attachments' && /^goal-(?:[a-f0-9]{64}|[A-Za-z0-9]{6})$/.test(relative.at(-1));

  return goal;
}

function validateRetention(root, value) {
  if (!Check(retentionSchema, value) || value.sessionIds.some(id => !uuid.test(id))
    || value.directories.some(candidate => !candidatePath(root, candidate.path))) throw new Error('Invalid deferred retention candidates');
}

function describeCandidates(directories, sessionIds) {
  return { directories: directories.map(file => ({ path: file, identity: identity(fs.lstatSync(file, { bigint: true })) })), sessionIds };
}

function storage(root) {
  const directory = path.join(root, 'retention-candidates');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  if (!fs.lstatSync(directory).isDirectory()) throw new Error('Invalid deferred retention storage');
  sync(root);

  return directory;
}

function readRecord(root, file, body) {
  const value = JSON.parse(body);

  if (!Check(recordSchema, value) || !uuid.test(value.id) || path.basename(file) !== value.id + '.json') throw new Error('Invalid deferred retention record');
  validateRetention(root, value.pending);

  if (value.origin !== createHash('sha256').update(JSON.stringify(value.pending)).digest('hex')) throw new Error('Deferred retention record changed');

  return { ...value, file };
}

function recordRetention(root, id, pending) {
  validateRetention(root, pending);

  if (!pending.directories.length && !pending.sessionIds.length) return;

  if (!uuid.test(id)) throw new Error('Invalid deferred retention identity');
  const directory = storage(root);
  const file = path.join(directory, id + '.json');
  const origin = createHash('sha256').update(JSON.stringify(pending)).digest('hex');

  const database = tables.open(root);

  try {
    database.exec('BEGIN IMMEDIATE');
    const previous = database.prepare('SELECT record_json FROM retention_candidates WHERE record_id=?').get(id);

    if (previous) {
      if (readRecord(root, file, previous.record_json).origin !== origin) throw new Error('Deferred retention identity was reused');
    } else {
      database.prepare('INSERT INTO retention_candidates VALUES (?, ?, ?)')
        .run(id, JSON.stringify({ version: 1, id, origin, pending }), Date.now());
    }

    database.exec('COMMIT');
  } finally { database.close(); }
}

function pendingRetentions(root, limit = 8) {
  const directory = storage(root);
  const database = tables.open(root);
  const records = [];
  const errors = [];

  try {
    const selected = database.prepare('SELECT record_id, record_json FROM retention_candidates ORDER BY retry_at, record_id LIMIT ?').all(limit);

    for (const row of selected) {
      const file = path.join(directory, row.record_id + '.json');

      try { records.push(readRecord(root, file, row.record_json)); }
      catch (error) {
        errors.push(`${row.record_id}: ${error.message}`);
        database.prepare('UPDATE retention_candidates SET retry_at=? WHERE record_id=?').run(Date.now(), row.record_id);
      }
    }
  } finally { database.close(); }

  return { records, errors };
}

function stagePath(record, index) { return path.join(path.dirname(record.file), `${record.id}-${index}.staged`); }

function matches(candidate, file = candidate.path) {
  const info = metadata(file);

  return Boolean(info?.isDirectory() && identity(info) === candidate.identity);
}

function cleanupStages(record) {
  for (const [index, candidate] of record.pending.directories.entries()) {
    const staged = stagePath(record, index);

    if (!metadata(staged)) continue;

    if (!matches(candidate, staged)) throw new Error('Deferred retention staging identity changed');

    if (goalStorageProtected(record, candidate, staged)) throw new Error('Deferred goal assets have retained ownership or publication dependencies');

    fs.rmSync(staged, { recursive: true });
    sync(path.dirname(staged));
  }
}

function removeCandidate(record, index) {
  const candidate = record.pending.directories[index];

  if (!matches(candidate)) return;

  if (goalStorageProtected(record, candidate, candidate.path)) return;

  const parent = path.dirname(candidate.path);

  if (fs.realpathSync(parent) !== parent) throw new Error('Deferred retention parent changed');
  const staged = stagePath(record, index);

  if (metadata(staged)) throw new Error('Deferred retention staging path already exists');
  fs.renameSync(candidate.path, staged);
  sync(parent); sync(path.dirname(staged));
  cleanupStages(record);
}

function goalStorageProtected(record, candidate, file) {
  if (path.basename(path.dirname(candidate.path)) !== 'attachments') return false;

  if (['owners.json', 'prepared.json', 'dependencies.json'].some(name => metadata(path.join(file, name)))) return true;
  const root = path.dirname(path.dirname(record.file));

  if (require('./goal-dependencies.cjs').retained(root, candidate.path, candidate.identity)) return true;

  if (require('./goal-preparations.cjs').retained(root, candidate.path, candidate.identity)) return true;

  if (require('./goal-ownership.cjs').retained(root, candidate.path, candidate.identity)) return true;

  const publications = require('./session-publication.cjs').retainedDependencies(root);

  return publications.some(publication => JSON.stringify(publication.dependencies ?? null).includes(candidate.path)
    || publication.transcriptPaths.some(transcript => JSON.stringify(require('../transcript-references.cjs').read(root, transcript)).includes(JSON.stringify(candidate.path).slice(1, -1))));
}

function finishRecord(record, done) {
  const root = path.dirname(path.dirname(record.file));
  const database = tables.open(root);

  try {

    if (done) database.prepare('DELETE FROM retention_candidates WHERE record_id=?').run(record.id);
    else database.prepare('UPDATE retention_candidates SET retry_at=? WHERE record_id=?').run(Date.now(), record.id);
  } finally { database.close(); }
}

module.exports = { validateRetention, describeCandidates, recordRetention, pendingRetentions, cleanupStages, matches, removeCandidate, finishRecord };
