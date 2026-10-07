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
  fs.cpSync(source, destination, { recursive: true, filter: (file) => file === source || !['comparison-retry.json', 'retry-before'].includes(path.basename(file)) });
}

function linkSnapshot(source, destination) {
  fs.mkdirSync(destination, { mode: 0o700 });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (['comparison-retry.json', 'retry-before'].includes(entry.name)) continue;
    const file = path.join(source, entry.name);
    const target = path.join(destination, entry.name);

    if (entry.isDirectory()) linkSnapshot(file, target);
    else if (entry.isFile()) fs.linkSync(file, target);
    else throw new Error('Comparison snapshots cannot contain symbolic links');
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

function temporarySnapshot() {
  const parent = path.join(storageRoot(), 'git-snapshots');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });

  return fs.mkdtempSync(path.join(parent, 'pi-desktop-diff-'));
}

function materialize(directory, repositoryRoot) {
  const saved = readSnapshot(directory);
  const temporary = temporarySnapshot();

  try { copySnapshot(directory, temporary); }
  catch (error) { fs.rmSync(temporary, { recursive: true, force: true }); throw error; }

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
  const baseline = materialize(path.join(record.directory, 'before'));

  try {
    const current = materialize(path.join(record.directory, 'after'));

    return { turnId: record.turnId, messageId: record.messageId, cwd: record.cwd, baseline: JSON.stringify(baseline), current: JSON.stringify(current) };
  } catch (error) { fs.rmSync(baseline.root, { recursive: true, force: true }); throw error; }
}

function acknowledgeComparison(retained) {
  if (!turnPattern.test(owner.turnId)) throw new Error('Invalid comparison turn');
  const record = readPending(retained).find((item) => item.turnId === owner.turnId);

  if (!record) return;
  promoteBaseline(retained, path.join(record.directory, 'after'));
  const completed = { ...completedComparisons(retained), [record.turnId]: record.messageId };
  writeJson(path.join(retained, 'completed.json'), completed);
  const queue = path.dirname(record.directory);
  const acknowledged = path.join(queue, `.acknowledged-${record.turnId}`);
  fs.renameSync(record.directory, acknowledged);
  syncPath(queue);
  cleanupAcknowledged(acknowledged);
}

function completedComparisons(retained) {
  const file = path.join(retained, 'completed.json');

  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
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
    }
  }

  fs.rmSync(directory, { recursive: true });
}

function snapshotAction(retained) {
  if (!retained) throw new Error('Only piop session comparisons can be accessed');

  if (!fs.existsSync(retained)) return console.log('null');
  checkedDirectory(retained);

  if (owner.action === 'next') return console.log(JSON.stringify(nextComparison(retained)));

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
  const sources = [request.baseline, JSON.stringify(token)];
  const record = { version: 1, sessionId: owner.sessionId, turnId: request.turnId, messageId: request.messageId, cwd: token.repository_root, createdAt: saved.capturedAt, sources };
  fs.writeFileSync(path.join(preparing, 'comparison.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  syncTree(preparing);
  fs.renameSync(preparing, path.join(queue, request.turnId));
  preparing = undefined;
  syncPath(queue);
}

function sealSnapshot(token, env, retained) {
  const saved = snapshotMetadata(token, retained);
  fs.mkdirSync(path.join(token.root, 'objects', 'pack'), { recursive: true });
  execFileSync('git', ['-C', token.repository_root, 'pack-objects', '--revs', path.join(token.root, 'objects', 'pack', 'snapshot')], {
    env, input: token.tree + '\n', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
  });

  for (const name of fs.readdirSync(path.join(token.root, 'objects'))) {
    if (/^[a-f0-9]{2}$/.test(name)) fs.rmSync(path.join(token.root, 'objects', name), { recursive: true });
  }

  syncTree(token.root);
  writeJson(path.join(token.root, 'snapshot.json'), { ...saved, selfContained: true });
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
  const fallback = path.join(current.root, 'comparison-retry.json');

  if (fs.existsSync(fallback)) {
    const record = JSON.parse(fs.readFileSync(fallback, 'utf8'));

    if (record.sessionId !== owner.sessionId || record.turnId !== turnId) throw new Error('Comparison recovery identity changed');
    fs.rmSync(fallback);
    syncPath(current.root);
  }
}

function storeFallback(token, retained) {
  snapshotMetadata(token, retained);
  const original = JSON.parse(owner.baseline);
  const baseline = { ...original, root: path.join(token.root, 'retry-before') };

  try {
    linkSnapshot(validateToken(original), baseline.root);
    syncTree(token.root);
    const record = { version: 1, sessionId: owner.sessionId, sessionPath: owner.sessionPath, turnId: owner.turnId, messageId: owner.messageId, cwd: token.repository_root, baseline: JSON.stringify(baseline), current: JSON.stringify(token) };
    writeJson(path.join(token.root, 'comparison-retry.json'), record);
    syncPath(path.dirname(token.root));
  } catch (error) {
    if (!fs.existsSync(path.join(token.root, 'comparison-retry.json'))) fs.rmSync(baseline.root, { recursive: true, force: true });
    throw error;
  }
}

function ownedFallback(directory) {
  const file = path.join(directory, 'comparison-retry.json');

  if (!fs.existsSync(file)) return undefined;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (record.sessionId !== owner.sessionId) return undefined;

  if (record.version !== 1 || JSON.parse(record.current).root !== directory) throw new Error('Invalid comparison recovery metadata');

  return record;
}

function importFallbacks(retained) {
  const parent = path.join(storageRoot(), 'git-snapshots');

  if (!fs.existsSync(parent)) return;

  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('pi-desktop-diff-')) continue;
    const record = ownedFallback(path.join(parent, entry.name));

    if (record) retainRequested(retained, record);
  }
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

  if (!owner?.sessionId) return token;

  try { retainCapture(token, env, retained); }
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

  if (!retained) return;
  ensureStorage(retained);

  if (owner.phase === 'end') {
    retainRequested(retained, { ...owner, current: JSON.stringify(token) });
    token.durable = true;
  } else promoteBaseline(retained, snapshot);

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

  if (snapshot) fs.rmSync(snapshot, { recursive: true, force: true });
  console.error(error.message);
  process.exitCode = 5;
}
