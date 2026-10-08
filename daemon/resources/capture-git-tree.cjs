const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const git = (args, env = process.env) => execFileSync('git', args, { env, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

const owner = process.argv[1] ? JSON.parse(process.argv[1]) : undefined;

const treePattern = /^[a-f0-9]{40,64}$/;

const turnPattern = /^[a-zA-Z0-9_-]{1,128}$/;

let snapshot;

let preparing;

function storageRoot() {
  return path.join(os.homedir(), process.env.PIOP_STORAGE_DIRECTORY || '.piop');
}

function sessionStorage(session) {
  const storage = fs.realpathSync(storageRoot());

  if (!['sessions', 'archived'].some((area) => session.startsWith(path.join(storage, area) + path.sep)) || !session.endsWith('.jsonl')) return undefined;
  const header = JSON.parse(fs.readFileSync(session, 'utf8').split('\n').find((line) => line.trim()));

  if (header.type !== 'session' || !header.id || (owner.sessionId && header.id !== owner.sessionId)) throw new Error('Snapshot session identity changed');
  owner.sessionId = header.id;

  return session.replace(/\.jsonl$/, '.snapshots');
}

function snapshotStorage() {
  if (!owner?.sessionPath || owner.ephemeral) return undefined;
  let session;

  try { session = fs.realpathSync(owner.sessionPath); }
  catch (error) { if (error.code === 'ENOENT' && !owner.action) return undefined; throw error; }

  return sessionStorage(session);
}

function syncPath(file) {
  const descriptor = fs.openSync(file, 'r');

  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function syncTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory()) syncTree(file);
    else syncPath(file);
  }

  syncPath(directory);
}

function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  syncPath(temporary);
  fs.renameSync(temporary, file);
  syncPath(path.dirname(file));
}

function copySnapshot(source, destination) {
  linkSnapshot(source, destination);
}

function linkSnapshot(source, destination) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (['comparison-retry.json', 'retry-before', 'materialization.json', 'temporary-owner.json', 'recovery.json', 'index', 'index.lock', '.previous-objects', '.sealed-objects', '.pack-status', '.reachable-objects'].includes(entry.name) || entry.name.endsWith('.tmp')) continue;
    const file = path.join(source, entry.name);
    const target = path.join(destination, entry.name);

    if (entry.isDirectory()) linkSnapshot(file, target);
    else if (entry.isFile()) linkFile(file, target);
    else throw new Error('Comparison snapshots cannot contain symbolic links');
  }
}

function linkFile(source, target) {
  try { fs.linkSync(source, target); }
  catch (error) {
    if (!['EXDEV', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error;
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
  }
}

function checkedDirectory(directory) {
  if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) throw new Error('Snapshot storage cannot be a symlink');

  return directory;
}

function ensureStorage(retained) {
  fs.mkdirSync(retained, { recursive: true, mode: 0o700 });
  checkedDirectory(retained);
  syncPath(path.dirname(retained));
}

function lockedCapture() {
  if (owner?.action === 'release') return releaseReader();
  const retained = snapshotStorage();

  if (!retained) return main(retained);
  ensureStorage(retained);
  const descriptor = fs.openSync(path.join(retained, 'capture.lock'), fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);

  try {
    const lock = spawnSync('flock', ['--exclusive', '3'], { stdio: ['ignore', 'pipe', 'pipe', descriptor] });

    if (lock.error) throw lock.error;

    if (lock.status !== 0) throw new Error(lock.stderr.toString().trim() || 'Could not lock comparison storage');
    clearPreparations(retained);
    main(retained);
  } finally { fs.closeSync(descriptor); }
}

function releaseReader() {
  if (!/^[a-f0-9-]{36}$/.test(owner.scope)) throw new Error('Invalid comparison reader scope');
  const boot = fs.existsSync('/proc/sys/kernel/random/boot_id') ? fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() : null;
  require('./session-database.cjs').releaseSnapshotReader(storageRoot(), owner.scope, { version: 1, boot, releasedAt: Date.now() });
  console.log('null');
}

function clearPreparations(retained) {
  for (const directory of [retained, path.join(retained, 'pending')]) {
    if (!fs.existsSync(directory)) continue;

    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('.preparing-')) fs.rmSync(path.join(directory, entry.name), { recursive: true });
    }
  }
}

function readSnapshot(directory) {
  checkedDirectory(directory);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'snapshot.json'), 'utf8'));

  if (saved.sessionId !== owner.sessionId || !treePattern.test(saved.tree) || !path.isAbsolute(saved.repositoryRoot)) throw new Error('Invalid saved comparison baseline');

  return saved;
}

function readPending(retained) {
  const queue = path.join(retained, 'pending');

  if (!fs.existsSync(queue)) return [];
  checkedDirectory(queue);

  for (const entry of fs.readdirSync(queue, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('.acknowledged-')) cleanupAcknowledged(path.join(queue, entry.name));
  }

  return fs.readdirSync(queue, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name.startsWith('.')) return [];

    return [readPendingRecord(queue, entry.name)];
  }).sort((left, right) => left.createdAt - right.createdAt || left.turnId.localeCompare(right.turnId));
}

function readPendingRecord(queue, name) {
    const directory = checkedDirectory(path.join(queue, name));
    const record = JSON.parse(fs.readFileSync(path.join(directory, 'comparison.json'), 'utf8'));

    if (record.version !== 1 || record.sessionId !== owner.sessionId || record.turnId !== name || !turnPattern.test(record.turnId)) throw new Error('Invalid pending comparison identity');

    if (!Number.isSafeInteger(record.createdAt) || record.messageId !== String(record.messageId) || !record.messageId || !path.isAbsolute(record.cwd)) throw new Error('Invalid pending comparison metadata');
    readSnapshot(path.join(directory, 'before'));
    readSnapshot(path.join(directory, 'after'));

    return { ...record, directory };
}

function retainedBaselines(retained) {
  const directories = ['latest', 'previous'].map((name) => path.join(retained, name));
  const pending = readPending(retained).map((record) => path.join(record.directory, 'after'));

  return [...directories, ...pending].flatMap((directory) => {
    try { return [{ directory, saved: readSnapshot(directory) }]; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }).sort((left, right) => (right.saved.capturedAt || 0) - (left.saved.capturedAt || 0));
}

function removeTemporary(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
  require('./session-database.cjs').removeSnapshotDirectory(directory);
}

function temporarySnapshot() {
  const parent = path.join(storageRoot(), 'git-snapshots');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(parent, 'pi-desktop-diff-'));

  try { ownTemporary(directory, owner?.phase === 'end' ? 'recoverable' : owner?.sessionId ? 'reader' : 'external'); }
  catch (error) { removeTemporary(directory); throw error; }

  return directory;
}

function ownTemporary(directory, state) {
  const pids = [process.pid, process.ppid, Number(process.env.PIOP_GIT_CAPTURE_READER_PID)].filter((pid) => Number.isSafeInteger(pid) && pid > 1);
  const processes = [...new Set(pids)].map((pid) => ({ pid, identity: processIdentity(pid) }));
  const boot = fs.existsSync('/proc/sys/kernel/random/boot_id') ? fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() : null;
  require('./session-database.cjs').saveSnapshotOwner(directory, { version: 1, state, boot, processes, readerPid: Number(process.env.PIOP_GIT_CAPTURE_READER_PID) || null, scope: process.env.PIOP_GIT_CAPTURE_READER_SCOPE, sessionId: owner?.sessionId, turnId: owner?.turnId, sessionPath: owner?.sessionPath, messageId: owner?.messageId, baseline: owner?.baseline });
  syncPath(path.dirname(directory));
}

function materialize(directory, repositoryRoot) {
  const saved = readSnapshot(directory);
  const temporary = temporarySnapshot();

  try {
    copySnapshot(directory, temporary);
    ownTemporary(temporary, 'reader');
  }
  catch (error) { removeTemporary(temporary); throw error; }

  return { root: temporary, tree: saved.tree, repository_root: repositoryRoot || saved.repositoryRoot };
}

function promoteBaseline(retained, source) {
  const saved = readSnapshot(source);
  const latest = path.join(retained, 'latest');
  const previous = path.join(retained, 'previous');
  const existing = [latest, previous].flatMap((directory) => fs.existsSync(directory) ? [readSnapshot(directory)] : []);

  if (existing.some((baseline) => (baseline.capturedAt || 0) >= saved.capturedAt)) return;
  preparing = fs.mkdtempSync(path.join(retained, '.preparing-'));
  copySnapshot(source, preparing);
  syncTree(preparing);
  fs.rmSync(previous, { recursive: true, force: true });

  if (fs.existsSync(latest)) fs.renameSync(latest, previous);

  try { fs.renameSync(preparing, latest); }
  catch (error) { if (fs.existsSync(previous)) fs.renameSync(previous, latest); throw error; }

  preparing = undefined;
  syncPath(retained);
  fs.rmSync(previous, { recursive: true, force: true });
}

function nextComparison(retained) {
  importFallbacks(retained);
  const record = readPending(retained)[0];

  if (!record) return null;

  return { turnId: record.turnId, messageId: record.messageId, cwd: record.cwd };
}

function pendingPatch(retained) {
  const record = readPending(retained).find((entry) => entry.turnId === owner.turnId);

  if (!record) {
    if (Object.hasOwn(completedComparisons(retained), owner.turnId)) return null;
    throw new Error('Pending comparison is missing');
  }

  const before = path.join(record.directory, 'before');
  const after = path.join(record.directory, 'after');
  const baseline = readSnapshot(before);
  const current = readSnapshot(after);
  const env = { ...process.env, GIT_OBJECT_DIRECTORY: path.join(after, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(before, 'objects') };
  const patch = execFileSync(process.execPath, ['-e', owner.diffScript, baseline.tree, current.tree], { cwd: record.cwd, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });

  return patch.trim() ? patch : null;
}

function acknowledgeComparison(retained) {
  if (!turnPattern.test(owner.turnId)) throw new Error('Invalid comparison turn');
  const record = readPending(retained).find((item) => item.turnId === owner.turnId);

  if (!record) return;
  promoteBaseline(retained, path.join(record.directory, 'after'));
  require('./session-database.cjs').completedComparisons(storageRoot(), owner.sessionId, retained, record);
  const queue = path.dirname(record.directory);
  const acknowledged = path.join(queue, `.acknowledged-${record.turnId}`);
  fs.renameSync(record.directory, acknowledged);
  syncPath(queue);
  cleanupAcknowledged(acknowledged);
}

function completedComparisons(retained) {
  return require('./session-database.cjs').completedComparisons(storageRoot(), owner.sessionId, retained);
}

function cleanupAcknowledged(directory) {
  const file = path.join(directory, 'comparison.json');

  if (fs.existsSync(file)) {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));

    if (record.sessionId !== owner.sessionId) throw new Error('Acknowledged comparison identity changed');

    for (const [index, token] of (record.sources || []).entries()) {
      const source = JSON.parse(token);

      if (!fs.existsSync(source.root)) continue;
      validateToken(source);
      const saved = readSnapshot(source.root);

      if (saved.tree !== source.tree) throw new Error('Acknowledged comparison snapshot changed');
      fs.renameSync(source.root, path.join(directory, `source-${index}`));
      syncPath(path.dirname(source.root));
      syncPath(directory);
      require('./session-database.cjs').removeSnapshotDirectory(source.root);
    }
  }

  fs.rmSync(directory, { recursive: true });
}

function snapshotAction(retained) {
  if (!retained) throw new Error('Only piop session comparisons can be accessed');

  if (!fs.existsSync(retained)) return console.log('null');
  checkedDirectory(retained);

  if (owner.action === 'next') return console.log(JSON.stringify(nextComparison(retained)));

  if (owner.action === 'diff') return console.log(JSON.stringify(pendingPatch(retained)));

  if (owner.action === 'retain') {
    retainRequested(retained, owner);
    console.log('null');

    return;
  }

  if (owner.action !== 'ack') throw new Error('Invalid comparison operation');
  acknowledgeComparison(retained);
  console.log('null');
}

function validateToken(source) {
  const parent = fs.realpathSync(path.join(storageRoot(), 'git-snapshots'));
  const directory = checkedDirectory(source.root);
  const container = path.basename(directory) === 'retry-before' ? path.dirname(directory) : directory;

  if (path.dirname(container) !== parent || !path.basename(container).startsWith('pi-desktop-diff-') || !treePattern.test(source.tree) || !path.isAbsolute(source.repository_root)) throw new Error('Invalid comparison snapshot');

  return directory;
}

function sourceSnapshot(token, retained) {
  const source = JSON.parse(token);
  const directory = validateToken(source);
  const saved = snapshotMetadata(source, retained);

  if (saved.tree !== source.tree) throw new Error('Comparison snapshot identity changed');

  if (!saved.selfContained) {
    const repositoryObjects = fs.realpathSync(git(['-C', source.repository_root, 'rev-parse', '--path-format=absolute', '--git-path', 'objects']).toString().trim());
    const env = { ...process.env, GIT_INDEX_FILE: path.join(directory, 'index'), GIT_OBJECT_DIRECTORY: path.join(directory, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjects };
    sealSnapshot(source, env, retained);
  }

  return directory;
}

function retainComparison(retained, token, request) {
  const baseline = sourceSnapshot(request.baseline, retained);
  sourceSnapshot(JSON.stringify(token), retained);
  const queue = path.join(retained, 'pending');
  fs.mkdirSync(queue, { recursive: true, mode: 0o700 });
  checkedDirectory(queue);
  syncPath(retained);
  preparing = fs.mkdtempSync(path.join(queue, '.preparing-'));
  copySnapshot(baseline, path.join(preparing, 'before'));
  copySnapshot(token.root, path.join(preparing, 'after'));
  const saved = readSnapshot(token.root);
  const sources = [...new Set([request.baseline, JSON.stringify(token), request.originalBaseline].filter(Boolean))];
  const record = { version: 1, sessionId: owner.sessionId, turnId: request.turnId, messageId: request.messageId, cwd: token.repository_root, createdAt: saved.capturedAt, sources };
  fs.writeFileSync(path.join(preparing, 'comparison.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  syncTree(preparing);
  fs.renameSync(preparing, path.join(queue, request.turnId));
  preparing = undefined;
  syncPath(queue);
}

function sealSnapshot(token, env, retained) {
  const saved = snapshotMetadata(token, retained);
  const objects = path.join(token.root, 'objects');
  const previous = path.join(token.root, '.previous-objects');
  const prepared = path.join(token.root, '.sealed-objects');

  if (!fs.existsSync(objects) && fs.existsSync(previous)) fs.renameSync(previous, objects);
  fs.rmSync(prepared, { recursive: true, force: true });
  fs.mkdirSync(prepared, { mode: 0o700 });
  shareObjects(retained, prepared);
  unpackTree(token, env, prepared);
  pruneObjects(token, prepared);
  syncTree(prepared);
  fs.rmSync(previous, { recursive: true, force: true });
  fs.renameSync(objects, previous);
  fs.renameSync(prepared, objects);
  syncPath(token.root);
  fs.rmSync(path.join(token.root, 'index'), { force: true });
  syncTree(token.root);
  writeJson(path.join(token.root, 'snapshot.json'), { ...saved, selfContained: true });
  fs.rmSync(previous, { recursive: true, force: true });
}

function shareObjects(retained, prepared) {
  const baseline = retained ? retainedBaselines(retained)[0] : undefined;

  if (!baseline) return;
  const objects = path.join(baseline.directory, 'objects');

  for (const prefix of fs.readdirSync(objects, { withFileTypes: true })) {
    if (prefix.isDirectory() && /^[a-f0-9]{2}$/.test(prefix.name)) linkSnapshot(path.join(objects, prefix.name), path.join(prepared, prefix.name));
  }
}

function unpackTree(token, env, destination) {
  const status = path.join(token.root, '.pack-status');
  const command = '{ git pack-objects --revs --stdout; echo $? > "$1"; } | GIT_OBJECT_DIRECTORY="$2" GIT_ALTERNATE_OBJECT_DIRECTORIES= git unpack-objects -q; result=$?; [ "$(cat "$1")" = 0 ] && [ "$result" = 0 ]';

  try { execFileSync('sh', ['-c', command, 'piop-snapshot', status, destination], { cwd: token.repository_root, env, input: token.tree + '\n', maxBuffer: 1024 * 1024 }); }
  finally { fs.rmSync(status, { force: true }); }
}

function pruneObjects(token, objects) {
  const list = path.join(token.root, '.reachable-objects');
  const descriptor = fs.openSync(list, 'w', 0o600);
  const env = { ...process.env, GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: '' };

  try { execFileSync('git', ['-C', token.repository_root, 'rev-list', '--objects', '--no-object-names', token.tree], { env, stdio: ['ignore', descriptor, 'pipe'] }); }
  finally { fs.closeSync(descriptor); }

  const retained = new Set(fs.readFileSync(list, 'utf8').trim().split('\n'));
  fs.rmSync(list);

  for (const prefix of fs.readdirSync(objects)) {
    if (!/^[a-f0-9]{2}$/.test(prefix)) continue;

    for (const suffix of fs.readdirSync(path.join(objects, prefix))) {
      if (!retained.has(prefix + suffix)) fs.rmSync(path.join(objects, prefix, suffix));
    }
  }
}

function snapshotMetadata(token, retained) {
  if (fs.existsSync(path.join(token.root, 'snapshot.json'))) return readSnapshot(token.root);
  const previous = retained ? retainedBaselines(retained)[0]?.saved.capturedAt || 0 : 0;
  const saved = { sessionId: owner?.sessionId, tree: token.tree, repositoryRoot: token.repository_root, capturedAt: Math.max(Date.now(), previous + 1) };
  writeJson(path.join(token.root, 'snapshot.json'), saved);

  return saved;
}

function retainRequested(retained, request) {
  if (!turnPattern.test(request.turnId) || request.messageId !== String(request.messageId) || !request.messageId) throw new Error('Missing comparison identity');
  const completed = completedComparisons(retained);

  if (Object.hasOwn(completed, request.turnId)) {
    if (completed[request.turnId] !== request.messageId) throw new Error('Completed comparison identity changed');

    return;
  }

  const current = JSON.parse(request.current);
  const existing = readPending(retained).find((record) => record.turnId === request.turnId);

  if (existing) {
    if (existing.messageId !== request.messageId || readSnapshot(path.join(existing.directory, 'after')).tree !== current.tree) throw new Error('Pending comparison identity changed');
  } else retainFallback(retained, current, request);

  removeFallback(current, request.turnId);
}

function retainFallback(retained, current, request) {
  const fallback = ownedFallback(current.root);

  if (!fallback) return retainComparison(retained, current, request);

  if (fallback.turnId !== request.turnId || fallback.messageId !== request.messageId) throw new Error('Comparison recovery identity changed');
  retainComparison(retained, current, fallback);
}

function removeFallback(current, turnId) {
  const record = require('./session-database.cjs').comparisonRetry(current.root);

  if (record) {
    if (record.sessionId !== owner.sessionId || record.turnId !== turnId) throw new Error('Comparison recovery identity changed');
    require('./session-database.cjs').removeComparisonRetry(current.root);
  }
}

function storeFallback(token, retained) {
  snapshotMetadata(token, retained);
  const original = JSON.parse(owner.baseline);
  const baseline = { ...original, root: path.join(token.root, 'retry-before') };

  try {
    linkSnapshot(validateToken(original), baseline.root);
    syncTree(token.root);
    const record = { version: 1, sessionId: owner.sessionId, sessionPath: owner.sessionPath, turnId: owner.turnId, messageId: owner.messageId, cwd: token.repository_root, baseline: JSON.stringify(baseline), originalBaseline: owner.baseline, current: JSON.stringify(token) };
    require('./session-database.cjs').saveComparisonRetry(token.root, record);
    syncPath(path.dirname(token.root));
  } catch (error) {
    if (!require('./session-database.cjs').comparisonRetry(token.root)) fs.rmSync(baseline.root, { recursive: true, force: true });
    throw error;
  }
}

function ownedFallback(directory) {
  const record = require('./session-database.cjs').comparisonRetry(directory);

  if (!record) return undefined;

  if (record.sessionId !== owner.sessionId) return undefined;

  if (record.version !== 1 || JSON.parse(record.current).root !== directory) throw new Error('Invalid comparison recovery metadata');

  return record;
}

function importFallbacks(retained) {
  const parent = path.join(storageRoot(), 'git-snapshots');

  if (!fs.existsSync(parent)) return;

  for (const row of require('./session-database.cjs').snapshotDirectories(storageRoot())) {
    const directory = row.directory;

    if (path.dirname(directory) !== parent || !path.basename(directory).startsWith('pi-desktop-diff-')) continue;

    const record = ownedFallback(directory);

    if (record) retainRequested(retained, record);
  }
}

function processIdentity(pid) {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19]; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function checkCaptureSize() {
  const paths = new Set(Buffer.concat([git(['ls-files', '-z', '-m', '-o', '--exclude-standard']), git(['diff', '--cached', '--name-only', '-z'])]).toString().split('\0').filter(Boolean));

  if (paths.size > 4096) process.exit(6);
  let total = 0;

  for (const file of paths) {
    let stat;

    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }

    total += stat.size;

    if (stat.size > 16 * 1024 * 1024 || total > 32 * 1024 * 1024) process.exit(6);
  }
}

function captureSnapshot(root, retained) {
  checkCaptureSize();
  const seed = git(['write-tree']).toString().trim();
  const repositoryObjects = fs.realpathSync(git(['rev-parse', '--git-path', 'objects']).toString().trim());
  snapshot = temporarySnapshot();
  fs.mkdirSync(path.join(snapshot, 'objects'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(snapshot, 'index'), GIT_OBJECT_DIRECTORY: path.join(snapshot, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjects };
  git(['read-tree', seed], env);
  git(['add', '-A', '--', '.'], env);
  const token = { root: snapshot, tree: git(['write-tree'], env).toString().trim(), repository_root: root };
  fs.rmSync(path.join(snapshot, 'index'), { force: true });

  try {
    if (owner?.sessionId) retainCapture(token, env, retained);
    else snapshotMetadata(token, retained);
  }
  catch (error) {
    if (preparing) fs.rmSync(preparing, { recursive: true, force: true });
    preparing = undefined;
    token.retentionError = error.message;
  }

  return token;
}

function retainCapture(token, env, retained) {
  if (owner.phase === 'end' && retained) storeFallback(token, retained);
  sealSnapshot(token, env, retained);

  if (!retained) {
    if (owner.ephemeral) ownTemporary(token.root, 'reader');

    return;
  }

  ensureStorage(retained);

  if (owner.phase === 'end') {
    retainRequested(retained, { ...owner, current: JSON.stringify(token) });
    token.durable = true;
  } else promoteBaseline(retained, snapshot);

  ownTemporary(token.root, 'reader');

}

function main(retained) {
  if (owner?.action) return snapshotAction(retained);
  let root;

  try { root = fs.realpathSync(git(['rev-parse', '--show-toplevel']).toString().trim()); } catch { process.exit(3); }

  process.chdir(root);

  if (owner?.phase === 'start' && retained) {
    importFallbacks(retained);
    const baseline = retainedBaselines(retained)[0];

    if (baseline) {
      console.log(JSON.stringify(materialize(baseline.directory, root)));

      return;
    }
  }

  console.log(JSON.stringify(captureSnapshot(root, retained)));
}

try { lockedCapture(); }
catch (error) {
  if (preparing) fs.rmSync(preparing, { recursive: true, force: true });

  if (snapshot) removeTemporary(snapshot);
  console.error(error.message);
  process.exitCode = 5;
}
