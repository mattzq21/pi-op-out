const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { directoryInUse } = require('./directory-liveness.cjs');
const { containerContents } = require('./worktree-container.cjs');

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
  const worktree = relative.length === 2 && relative[0] === 'worktrees' && /^[a-f0-9]{4}$/.test(relative[1]);

  const goal = ['sessions', 'archived', 'fork-transactions', 'fork-preparations'].includes(relative[0])
    && relative.at(-2) === 'attachments' && /^goal-[A-Za-z0-9]{6}$/.test(relative.at(-1));

  return worktree || goal;
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

function readRecord(root, file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));

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

  if (metadata(file)) {
    if (readRecord(root, file).origin !== origin) throw new Error('Deferred retention identity was reused');
    sync(file); sync(directory); sync(root);

    return;
  }

  publishRecord(file, { version: 1, id, origin, pending });
}

function publishRecord(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  const descriptor = fs.openSync(temporary, 'wx', 0o600);

  try {
    try { fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }

    fs.renameSync(temporary, file);
    sync(path.dirname(file));
  } finally { fs.rmSync(temporary, { force: true }); }
}

function retentionFiles(directory, errors) {
  const files = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue;
    const file = path.join(directory, entry.name);

    try {
      const info = fs.lstatSync(file);

      if (!info.isFile()) throw new Error('Invalid deferred retention record');
      files.push({ file, modified: info.mtimeMs });
    } catch (error) { errors.push(`${entry.name}: ${error.message}`); }
  }

  return files;
}

function pendingRetentions(root, limit = 8) {
  const directory = path.join(root, 'retention-candidates');

  if (!metadata(directory)) return { records: [], errors: [] };

  if (!fs.lstatSync(directory).isDirectory()) throw new Error('Invalid deferred retention storage');

  const records = [];
  const errors = [];

  const selected = retentionFiles(directory, errors)
    .sort((left, right) => left.modified - right.modified || left.file.localeCompare(right.file)).slice(0, limit);

  for (const { file } of selected) {
    try { records.push(readRecord(root, file)); }
    catch (error) { errors.push(`${path.basename(file)}: ${error.message}`); postponeRecord(file); }
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

    if (!worktreeRemovalReady(candidate, staged)) throw new Error('Deferred worktree storage remains in use or contains files');
    removeStage(candidate, staged);
    sync(path.dirname(staged));
  }
}

function removeStage(candidate, file) {
  if (path.basename(path.dirname(candidate.path)) !== 'worktrees') { fs.rmSync(file, { recursive: true });

    return; }

  const contents = containerContents(file);

  if (!contents) throw new Error('Deferred worktree storage contains files');

  for (const name of contents.files) fs.unlinkSync(path.join(file, name));
  fs.rmdirSync(file);
}

function worktreeRemovalReady(candidate, file) {
  if (path.basename(path.dirname(candidate.path)) !== 'worktrees') return true;

  return Boolean(containerContents(file)) && !directoryInUse(file);
}

function removeCandidate(record, index) {
  const candidate = record.pending.directories[index];

  if (!matches(candidate)) return;

  if (!worktreeRemovalReady(candidate, candidate.path)) return;
  const parent = path.dirname(candidate.path);

  if (fs.realpathSync(parent) !== parent) throw new Error('Deferred retention parent changed');
  const staged = stagePath(record, index);

  if (metadata(staged)) throw new Error('Deferred retention staging path already exists');
  fs.renameSync(candidate.path, staged);
  sync(parent); sync(path.dirname(staged));
  cleanupStages(record);
}

function finishRecord(record, done) {
  if (done) {
    fs.unlinkSync(record.file);
    sync(path.dirname(record.file));
  } else postponeRecord(record.file);
}

function postponeRecord(file) {
  const now = new Date();
  fs.utimesSync(file, now, now);
  sync(file);
}

module.exports = { validateRetention, describeCandidates, recordRetention, pendingRetentions, cleanupStages, matches, removeCandidate, finishRecord };
