import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import * as tables from '../session-database.ts';
import { onMainThread } from '../main-thread.ts';
import * as GoalDependencies from './goal-dependencies.ts';
import * as GoalPreparations from './goal-preparations.ts';
import * as GoalOwnership from './goal-ownership.ts';
import * as SessionPublication from './session-publication.ts';
import * as TranscriptReferences from '../transcript-references.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const candidateSchema = Type.Object({ path: Type.String(), identity: Type.String({ pattern: '^\\d+:\\d+$' }) });

const retentionSchema = Type.Object({ directories: Type.Array(candidateSchema), sessionIds: Type.Array(Type.String()) });

const recordSchema = Type.Object({ version: Type.Literal(1), id: Type.String(), origin: Type.String(), pending: retentionSchema });

type Retention = Static<typeof retentionSchema>;

type RetentionRecord = Static<typeof recordSchema> & { file: string };

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
    && relative.at(-2) === 'attachments' && /^goal-(?:[a-f0-9]{64}|[A-Za-z0-9]{6})$/.test(relative.at(-1) ?? '');

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

function readRecord(root, file, body: string): RetentionRecord {
  const value = JSON.parse(body);

  if (!Check(recordSchema, value) || !uuid.test(value.id) || path.basename(file) !== value.id + '.json') throw new Error('Invalid deferred retention record');
  validateRetention(root, value.pending);

  if (value.origin !== createHash('sha256').update(JSON.stringify(value.pending)).digest('hex')) throw new Error('Deferred retention record changed');

  return { ...value, file };
}

const recordRetention = onMainThread('retention-candidates.recordRetention', (root: string, id: string, pending: Retention) => {
  validateRetention(root, pending);

  if (!pending.directories.length && !pending.sessionIds.length) return;

  if (!uuid.test(id)) throw new Error('Invalid deferred retention identity');
  const directory = storage(root);
  const file = path.join(directory, id + '.json');
  const origin = createHash('sha256').update(JSON.stringify(pending)).digest('hex');

  const database = tables.connection(root);

  tables.transaction(database, 'IMMEDIATE', () => {
    const previous = database.prepare('SELECT record_json FROM retention_candidates WHERE record_id=?').get(id) as { record_json: string } | undefined;

    if (previous) {
      if (readRecord(root, file, previous.record_json).origin !== origin) throw new Error('Deferred retention identity was reused');
    } else {
      database.prepare('INSERT INTO retention_candidates VALUES (?, ?, ?)')
        .run(id, JSON.stringify({ version: 1, id, origin, pending }), Date.now());
    }
  });
});

const retryLater = onMainThread('retention-candidates.retryLater', (root: string, id: string) => {
  tables.connection(root).prepare('UPDATE retention_candidates SET retry_at=? WHERE record_id=?').run(Date.now(), id);
});

function pendingRetentions(root, limit = 8) {
  const directory = storage(root);
  const database = tables.connection(root);
  const records: RetentionRecord[] = [];
  const errors: string[] = [];
  const selected = database.prepare('SELECT record_id, record_json FROM retention_candidates ORDER BY retry_at, record_id LIMIT ?').all(limit) as { record_id: string; record_json: string }[];

  for (const row of selected) {
    const file = path.join(directory, row.record_id + '.json');

    try { records.push(readRecord(root, file, row.record_json)); }
    catch (error) {
      errors.push(`${row.record_id}: ${error.message}`);
      retryLater(root, row.record_id);
    }
  }

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

  if (GoalDependencies.retained(root, candidate.path, candidate.identity)) return true;

  if (GoalPreparations.retained(root, candidate.path, candidate.identity)) return true;

  if (GoalOwnership.retained(root, candidate.path, candidate.identity)) return true;

  const publications = SessionPublication.retainedDependencies(root);

  return publications.some(publication => JSON.stringify(publication.dependencies ?? null).includes(candidate.path)
    || publication.transcriptPaths.some(transcript => JSON.stringify(TranscriptReferences.read(root, transcript)).includes(JSON.stringify(candidate.path).slice(1, -1))));
}

const finishRecord = onMainThread('retention-candidates.finishRecord', (record: RetentionRecord, done: boolean) => {
  const root = path.dirname(path.dirname(record.file));
  const database = tables.connection(root);

  if (done) database.prepare('DELETE FROM retention_candidates WHERE record_id=?').run(record.id);
  else database.prepare('UPDATE retention_candidates SET retry_at=? WHERE record_id=?').run(Date.now(), record.id);
});

export { validateRetention, describeCandidates, recordRetention, pendingRetentions, cleanupStages, matches, removeCandidate, finishRecord };
