const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const checkpointIndex = require('./session-broker/checkpoint-owner-index.cjs');

const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

const digest = body => createHash('sha256').update(body).digest('hex');

// oxlint-disable-next-line anti-slop/no-runtime-typeof
const string = value => typeof value === 'string';

function git(root, args, input) {
  return execFileSync('git', ['-C', root, '-c', 'core.fsmonitor=false', '-c', 'core.fsync=all', '-c', 'core.fsyncMethod=fsync', ...args], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function canonicalRepository(root) {
  return fs.realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}

function lostRoot(root, target, common) {
  if (!string(root) || !path.isAbsolute(root)) return false;
  let canonical;

  try { canonical = fs.realpathSync(root); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }

  return inside(target, canonical) && canonicalRepository(canonical) === common;
}

function validCommit(commit) {
  return string(commit) && /^[a-f0-9]{40,64}$/.test(commit);
}

function verifyCheckpoint(common, ref, commit) {
  if (!string(ref) || !ref.startsWith('refs/pi-session-snapshots/') || !validCommit(commit)) throw new Error('Invalid checkpoint identity');
  git(common, ['check-ref-format', ref]);

  if (git(common, ['rev-parse', '--verify', '--end-of-options', ref]) !== commit) throw new Error(`Checkpoint ref does not match its recorded commit: ${ref}`);
  git(common, ['cat-file', '-e', `${commit}^{commit}`]);

  return { ref, commit };
}

function promptRef(header, data) {
  if (!string(data.key) || !/^[a-zA-Z0-9-]+$/.test(data.key)) throw new Error('Invalid prompt checkpoint key');
  const id = header.id.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+|\.+$/g, '') || 'session';

  return `refs/pi-session-snapshots/chats/${id}/prompts/${data.key}`;
}

function checkpointRoot(entry, header) {
  if (entry.type !== 'custom' || !entry.data) return undefined;

  if (entry.customType === 'pi-project-prompt-checkpoint') return entry.data.repositoryRoot ?? header.checkpointRepositoryRoot ?? header.cwd;

  if (entry.customType === 'pi-project-files-watch-snapshot') return entry.data.repositoryRoot;

  return undefined;
}

function remapEntry(entry, header, target, common, refs) {
  const root = checkpointRoot(entry, header);

  if (!lostRoot(root, target, common)) return false;

  if (entry.data.unavailable) return remapPendingPrompt(entry, header, common, refs);
  const ref = entry.customType === 'pi-project-prompt-checkpoint' ? promptRef(header, entry.data) : entry.data.ref;

  refs.push(verifyCheckpoint(common, ref, entry.data.commit));
  entry.data.repositoryRoot = common;

  return true;
}

function remapPendingPrompt(entry, header, common, refs) {
  if (entry.customType !== 'pi-project-prompt-checkpoint' || entry.data.pending !== true) return false;
  const ref = promptRef(header, entry.data);
  let commit;

  try { commit = git(common, ['rev-parse', '--verify', '--quiet', '--end-of-options', ref]); }
  catch (error) { if (error.status === 1) return false; throw error; }

  refs.push(verifyCheckpoint(common, ref, commit));
  entry.data.repositoryRoot = common;

  return true;
}

function lastResponseSnapshot(entries) {
  const byId = new Map(entries.flatMap(entry => entry.id ? [[entry.id, entry]] : []));
  const visited = new Set();
  let cursor = entries.at(-1);

  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);

    if (cursor.type === 'message' && cursor.message?.role === 'assistant') return entries.findLast(entry => entry.type === 'custom'
      && entry.customType === 'pi-project-files-watch-snapshot' && entry.data?.responseEntryIds?.includes(cursor.id));
    cursor = byId.get(cursor.parentId);
  }

  return undefined;
}

function remapRestore(header, entries, archived, target, common, refs) {
  const restore = header.worktreeRestore;

  if (restore?.kind === 'git') {
    if (!lostRoot(restore.repositoryRoot, target, common)) return false;
    refs.push(verifyCheckpoint(common, restore.ref, restore.commit));
    restore.repositoryRoot = common;

    return true;
  }

  if (!archived || !lostRoot(header.cwd, target, common)) return false;
  const snapshot = lastResponseSnapshot(entries)?.data;

  if (!snapshot || snapshot.unavailable) throw new Error('The archived conversation has no completed checkpoint for its last response');
  refs.push(verifyCheckpoint(common, snapshot.ref, snapshot.commit));
  header.worktreeRestore = { kind: 'git', path: target, conversationPath: fs.realpathSync(header.cwd), repositoryRoot: common, ref: snapshot.ref, commit: snapshot.commit };

  return true;
}

function remapCheckpointRoots(header, entries, archived, target, common) {
  const refs = [];
  let changed = remapRestore(header, entries, archived, target, common, refs);

  for (const entry of entries) if (remapEntry(entry, header, target, common, refs)) changed = true;

  return { changed, refs };
}

function metadataIdentity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function readTranscript(file, archived) {
  const before = fs.lstatSync(file, { bigint: true });

  if (!before.isFile()) throw new Error(`Conversation is not a regular file: ${file}`);
  const body = fs.readFileSync(file);
  const entries = body.toString('utf8').split('\n').filter(line => line.trim()).map(JSON.parse);
  const header = entries[0];

  if (header?.type !== 'session' || !string(header.id) || !header.id || !string(header.cwd)) throw new Error(`Invalid conversation header: ${file}`);

  if (metadataIdentity(before) !== metadataIdentity(fs.lstatSync(file, { bigint: true }))) throw new Error(`Conversation changed while reading: ${file}`);

  return { file, archived, entries, header, identity: metadataIdentity(before), digest: digest(body), mode: Number(before.mode) & 0o777 };
}

function comparisonUsesWorktree(capture, target, common) {
  if (capture.ready === true) return false;

  if (lostRoot(capture.cwd, target, common)) return true;

  return [capture.baseline, capture.current].some(token => token && lostRoot(JSON.parse(token).repository_root, target, common));
}

function checkPendingDiffs(record, target, common, readDiffStore) {
  const file = record.file.replace(/\.jsonl$/, '.diffs.json');

  const locks = [];

  try {
    lock(`${file}.lock`, locks);
    const pending = readDiffStore(file, false).pending;

    if (Object.values(pending).some(capture => comparisonUsesWorktree(capture, target, common))) throw new Error(`Pending diff comparisons require this worktree; recover project changes before removal: ${file}`);
  } finally { for (const fd of locks) fs.closeSync(fd); }
}

function checkPendingPointers(storage, target, common) {
  for (const { file: pointer, kind } of checkpointIndex.linked(storage, [target])) {
    if (kind !== 'pointer') continue;

    try {
      const record = require('./session-database.cjs').pendingDiff(path.dirname(pointer));

      if (record === undefined) continue;

      if (comparisonUsesWorktree(record.capture, target, common)) throw new Error(`Pending diff recovery still requires this worktree: ${pointer}`);
    } catch (error) { throw new Error(`Pending diff pointer preserved at ${pointer}: ${error.message}`); }
  }
}

function inspectTranscript(file, archived, target, common, records, readDiffStore, sessionId) {
  try {
    const record = readTranscript(file, archived);

    if (record.header.id !== sessionId) throw new Error('Checkpoint owner index identity changed');

    checkPendingDiffs(record, target, common, readDiffStore);
    const mapping = remapCheckpointRoots(record.header, record.entries, archived, target, common);

    if (mapping.changed) records.push({ ...record, refs: mapping.refs });
  } catch (error) { throw new Error(`Cannot preserve checkpoints in ${file}; file retained: ${error.message}`); }
}

function scan(storage, target, common, readDiffStore) {
  const records = [];

  for (const link of checkpointIndex.linked(storage, [target])) {
    if (!fs.existsSync(link.file)) continue;

    if (link.kind === 'diff') {
      checkPendingDiffs({ file: link.file.replace(/\.diffs\.json$/, '.jsonl') }, target, common, readDiffStore);
      continue;
    }

    if (link.kind !== 'transcript') continue;
    const archived = inside(path.join(storage, 'archived'), link.file);

    if (!archived && !inside(path.join(storage, 'sessions'), link.file)) throw new Error('Checkpoint owner index points outside conversation storage');
    inspectTranscript(link.file, archived, target, common, records, readDiffStore, link.sessionId);
  }

  checkPendingPointers(storage, target, common);

  return records.sort((left, right) => left.file.localeCompare(right.file));
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');

  try { fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function lock(file, locks) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  if (fs.realpathSync(path.dirname(file)) !== path.dirname(file)) throw new Error(`Invalid checkpoint lock directory: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  const result = spawnSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });

  if (result.error || result.status !== 0) {
    fs.closeSync(fd);
    throw new Error(`Checkpoint owner is busy; close its conversation before removing the worktree: ${file}`);
  }

  locks.push(fd);
}

function lockOwners(storage, records, locks) {
  const ids = [...new Set(records.map(record => record.header.id.toLowerCase()))].sort();

  for (const id of ids) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error(`Cannot lock checkpoint owner with invalid conversation identity: ${id}`);
    const key = createHash('sha256').update(id).digest('hex').slice(0, 40);

    lock(path.join(storage, 'conversation-ownership', `${key}.lock`), locks);
    lock(path.join(storage, 'session-claims', `id-${key}.lock`), locks);
  }
}

function verifyTranscript(record) {
  const stat = fs.lstatSync(record.file, { bigint: true });

  if (!stat.isFile() || metadataIdentity(stat) !== record.identity || digest(fs.readFileSync(record.file)) !== record.digest) throw new Error(`Conversation changed while preserving checkpoints; retained: ${record.file}`);
}

function publish(record, common) {
  const refs = new Map(record.refs.map(ref => [ref.ref, ref.commit]));

  git(common, ['update-ref', '--stdin'], ['start', ...Array.from(refs, ([ref, commit]) => `verify ${ref} ${commit}`), 'prepare', 'commit', ''].join('\n'));
  const temporary = `${record.file}.${randomUUID()}.tmp`;
  let fd;

  try {
    fd = fs.openSync(temporary, 'wx', record.mode);
    fs.writeFileSync(fd, record.entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    verifyTranscript(record);
    require('./transcript-metadata.cjs').invalidate(record.file);
    fs.renameSync(temporary, record.file);
    syncDirectory(path.dirname(record.file));
    checkpointIndex.refresh(record.file);
    require('./transcript-metadata.cjs').remember(record.file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

function samePlan(before, after) {
  if (before.length !== after.length) return false;

  return before.every((record, index) => record.file === after[index].file && record.identity === after[index].identity && record.digest === after[index].digest);
}

function authorizeWorktreeRemoval() {
  fs.writeSync(1, 'ready\n');
  const acknowledgement = Buffer.alloc(1);

  if (fs.readSync(0, acknowledgement, 0, 1) !== 1 || acknowledgement[0] !== 49) throw new Error('Worktree removal cancelled after checkpoint preservation');
}

function preserveAndRemoveWorktree(targetPath, authorizeRemoval, readDiffStore) {
  const target = fs.realpathSync(targetPath);
  const common = canonicalRepository(target);
  const own = fs.realpathSync(git(target, ['rev-parse', '--absolute-git-dir']));

  if (own === common || inside(target, common)) throw new Error('The main checkout or its durable checkpoint repository cannot be removed');
  const storagePath = path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop');

  fs.mkdirSync(storagePath, { recursive: true, mode: 0o700 });
  const storage = fs.realpathSync(storagePath);
  const locks = [];

  try {
    lock(path.join(storage, 'session-transactions.lock'), locks);
    const records = scan(storage, target, common, readDiffStore);

    lockOwners(storage, records, locks);

    if (!samePlan(records, scan(storage, target, common, readDiffStore))) throw new Error('Checkpoint owners changed; retry worktree removal');

    for (const record of records) publish(record, common);

    if (scan(storage, target, common, readDiffStore).length) throw new Error('New checkpoint owners still use the worktree; retry removal');
    authorizeRemoval();
    git(common, ['worktree', 'remove', '--', target]);
  } finally { for (const fd of locks.reverse()) fs.closeSync(fd); }
}

module.exports = { canonicalRepository, verifyCheckpoint, remapCheckpointRoots, preserveAndRemoveWorktree, authorizeWorktreeRemoval };
