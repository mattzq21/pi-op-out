const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { readStore } = require('./session-broker/git-diff-store.cjs');
const recoveryRecords = require('./snapshot-recovery-records.cjs');

function entries(directory) {
  try { return fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function bootIdentity() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function sync(file) {
  const descriptor = fs.openSync(file, 'r');

  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function alive(processOwner) {
  if (!Number.isSafeInteger(processOwner.pid) || processOwner.pid < 1) throw new Error('Invalid temporary snapshot reader');

  try { process.kill(processOwner.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }

  if (!processOwner.identity) return true;

  try { return fs.readFileSync(`/proc/${processOwner.pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19] === processOwner.identity; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function active(record, boot, released = false) {
  if (record.version !== 1 || !Array.isArray(record.processes) || !record.processes.length) throw new Error('Invalid temporary snapshot ownership');

  if (record.boot && boot && record.boot !== boot) return false;

  return record.processes.some((reader) => (!released || reader.pid !== record.readerPid) && alive(reader));
}

function warn(warnings, file, error) {
  if (warnings.length < 16) warnings.push(`Snapshot recovery preserved ${file}: ${error.message}`);
  else if (warnings.length === 16) warnings.push('Additional snapshot recovery records require inspection. Their files remain preserved.');
}

function protectReference(value, sources) {
  const source = JSON.parse(value).root;

  if (!path.isAbsolute(source)) throw new Error('Invalid snapshot recovery source');
  sources.paths.add(source);
  sources.paths.add(path.dirname(source));
}

function protectRecord(name, record, directory, sources) {
  if (record.sessionPath && path.isAbsolute(record.sessionPath)) sources.stores.add(record.sessionPath.replace(/\.jsonl$/, '.diffs.json'));

  if (name === 'pending-diff.json') {
    sources.paths.add(directory);
    protectComparison(record.capture, sources);
  } else if (name !== 'snapshot.json') {
    for (const value of [record.baseline, record.current, record.originalBaseline].filter(Boolean)) protectReference(value, sources);
  }
}

function protectComparison(capture, sources) {
  if (capture?.source === 'copy') return;
  protectReference(capture?.baseline, sources);
  protectReference(capture?.current, sources);
}

function protectDirectory(directory, sources, warnings) {
  const records = [];
  let uncertain = false;

  for (const name of ['comparison-retry.json', 'pending-diff.json', 'temporary-owner.json', 'snapshot.json']) {
    try {
      const record = read(path.join(directory, name));
      records.push(record);

      if (record) protectRecord(name, record, directory, sources);
    } catch (error) { uncertain = true; warn(warnings, path.join(directory, name), error); }
  }

  if (uncertain) {
    sources.paths.add(directory);
    const identities = new Set(records.flatMap((record) => record?.sessionId && record.sessionId === String(record.sessionId) ? [record.sessionId] : []));

    if (identities.size !== 1) sources.unknown = true;
    else for (const identity of identities) sources.sessions.add(identity);
  }
}

function protectedSources(root, directories, warnings) {
  const sources = { paths: new Set(), sessions: new Set(), stores: new Set(), unknown: false };

  for (const directory of directories) protectDirectory(directory, sources, warnings);

  try {
    for (const session of require('./session-database.cjs').paths(root)) sources.stores.add(session.replace(/\.jsonl$/, '.diffs.json'));
  } catch (error) { sources.unknown = true; warn(warnings, root, error); }

  for (const area of ['deleted-sessions', 'archive-transactions', 'restore-transactions', 'fork-transactions', 'fork-preparations']) {
    try { comparisonStores(path.join(root, area), sources.stores); }
    catch (error) { sources.unknown = true; warn(warnings, path.join(root, area), error); }
  }

  for (const file of sources.stores) protectStore(file, sources, warnings);

  return sources;
}

function comparisonStores(directory, stores) {
  for (const entry of entries(directory)) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory() && !entry.name.endsWith('.snapshots')) comparisonStores(file, stores);
    else if (entry.name.endsWith('.diffs.json')) stores.add(file);
  }
}

function protectStore(file, sources, warnings) {
  try {
    const state = readStore(file, false);

    for (const capture of Object.values(state.pending)) protectComparison(capture, sources);
  } catch (error) { sources.unknown = true; warn(warnings, file, error); }
}

function savedSnapshots(root, snapshots, warnings) {
  for (const session of require('./session-database.cjs').paths(root)) {
    const directory = session.replace(/\.jsonl$/, '.snapshots');

    try { savedSnapshotDirectory(directory, snapshots, warnings); }
    catch (error) { warn(warnings, directory, error); }
  }
}

function savedSnapshotDirectory(directory, snapshots, warnings) {
  for (const name of ['latest', 'previous']) addSavedSnapshot(path.join(directory, name), snapshots, warnings);

  for (const pending of entries(path.join(directory, 'pending'))) {
    if (!pending.isDirectory() || pending.name.startsWith('.')) continue;

    for (const phase of ['before', 'after']) addSavedSnapshot(path.join(directory, 'pending', pending.name, phase), snapshots, warnings);
  }
}

function addSavedSnapshot(directory, snapshots, warnings) {
  try {
    const saved = read(path.join(directory, 'snapshot.json'));

    if (saved?.selfContained && saved.sessionId && /^[a-f0-9]{40,64}$/.test(saved.tree)) snapshots.push({ directory, saved });
  } catch (error) { warn(warnings, directory, error); }
}

function releasedReader(owner, state) {
  if (!/^[a-f0-9-]{36}$/.test(owner?.scope)) return false;
  const receipt = state.releases.get(owner.scope);

  return receipt?.version === 1;
}

function readerEnded(owner, state, released) {
  if (!['building', 'reader'].includes(owner.state)) return false;

  return released || Boolean(owner.boot && state.boot && owner.boot !== state.boot);
}

function blockedSources(directory, owner, state) {
  if (state.protected.unknown) return true;
  const identity = owner?.sessionId || read(path.join(directory, 'snapshot.json'))?.sessionId;

  return state.protected.sessions.has(identity);
}

function usedScopes(directories, warnings) {
  const used = new Set();

  for (const directory of directories) {
    try {
      const owner = read(path.join(directory, 'temporary-owner.json'));

      if (owner?.scope) used.add(owner.scope);
    } catch (error) {
      warn(warnings, directory, error);

      return undefined;
    }
  }

  return used;
}

function pruneReleasedReaders(parent, directories, boot, warnings) {
  if (!boot) return;
  const used = usedScopes(directories, warnings);

  if (!used) return;
  const root = path.dirname(parent);
  const database = require('./session-database.cjs');

  for (const row of database.snapshotReaderReleases(root)) {
    if (used.has(row.scope)) continue;

    try {
      const record = JSON.parse(row.record_json);

      if (record?.boot && record.boot !== boot) database.removeSnapshotReaderRelease(root, row);
    } catch (error) { warn(warnings, row.scope, error); }
  }
}

function objectFiles(directory, visit) {
  const objects = path.join(directory, 'objects');

  for (const entry of entries(objects)) {
    if (!entry.isDirectory() || !/^([a-f0-9]{2}|pack)$/.test(entry.name)) continue;

    for (const object of entries(path.join(objects, entry.name))) {
      if (object.isFile() && object.name.startsWith('.snapshot-dedup-') && object.name.endsWith('.tmp')) fs.rmSync(path.join(objects, entry.name, object.name));

      if (!object.isFile() || !/^([a-f0-9]{38,62}|pack-[a-f0-9]{40,64}\.(pack|idx|rev))$/.test(object.name)) continue;
      const file = path.join(objects, entry.name, object.name);
      const stat = fs.lstatSync(file);
      visit(file, `${entry.name}/${object.name}/${stat.size}`, stat);
    }
  }
}

function equalFiles(first, second) {
  const left = fs.openSync(first, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let right;

  try {
    right = fs.openSync(second, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const a = Buffer.alloc(128 * 1024);
    const b = Buffer.alloc(a.length);
    let length;

    do {
      length = fs.readSync(left, a);

      if (fs.readSync(right, b) !== length || !a.subarray(0, length).equals(b.subarray(0, length))) return false;
    } while (length);

    return true;
  } finally {
    fs.closeSync(left);

    if (right !== undefined) fs.closeSync(right);
  }
}

function shareObject(file, candidate, stat) {
  if (candidate.stat.dev !== stat.dev || candidate.stat.ino === stat.ino || !equalFiles(candidate.file, file)) return;
  const temporary = path.join(path.dirname(file), `.snapshot-dedup-${randomUUID()}.tmp`);

  try {
    fs.linkSync(candidate.file, temporary);
    fs.renameSync(temporary, file);
    sync(path.dirname(file));
  } finally { fs.rmSync(temporary, { force: true }); }
}

function deduplicate(directory, objects) {
  objectFiles(directory, (file, key, stat) => {
    const candidate = objects.get(key);

    if (candidate) shareObject(file, candidate, stat);
    else objects.set(key, { file, stat });
  });
}

function fullyShared(directory, objects) {
  const names = new Set(['objects', 'snapshot.json', 'materialization.json', 'recovery.json', 'index']);

  if (entries(directory).some((entry) => !names.has(entry.name))) return false;

  if (!recognizedObjects(path.join(directory, 'objects'))) return false;
  let count = 0;
  let shared = true;
  objectFiles(directory, (file, key, stat) => {
    const candidate = objects.get(key);
    count++;

    if (!sharesFile(file, candidate, stat)) shared = false;
  });

  return shared && count > 0;
}

function recognizedObjects(directory) {
  return entries(directory).every((entry) => entry.isDirectory() && /^([a-f0-9]{2}|pack)$/.test(entry.name)
    && entries(path.join(directory, entry.name)).every((object) => object.isFile() && /^([a-f0-9]{38,62}|pack-[a-f0-9]{40,64}\.(pack|idx|rev))$/.test(object.name)));
}

function sharesFile(file, candidate, stat) {
  if (!candidate || candidate.file === file) return false;
  const retained = fs.lstatSync(candidate.file);

  return retained.dev === stat.dev && retained.ino === stat.ino;
}

function discard(directory) {
  const parent = path.dirname(directory);
  const destination = path.basename(directory).startsWith('.cleanup-') ? directory : path.join(parent, `.cleanup-${path.basename(directory)}`);

  if (destination !== directory) { fs.renameSync(directory, destination); sync(parent); }

  fs.rmSync(destination, { recursive: true });
  sync(parent);
  recoveryRecords.remove(path.join(parent, path.basename(directory).replace(/^\.cleanup-/, '')));
}

function legacySnapshot(directory, boot, saved) {
  let record = recoveryRecords.read(directory);

  if (!record) {
    record = { version: 1, boot, discoveredAt: Date.now(), reason: 'Reader ownership was not recorded; preserve until duplicate data and an ended reader lifetime can be verified.', sessionId: saved?.sessionId, tree: saved?.tree, repositoryRoot: saved?.repositoryRoot };
    recoveryRecords.write(directory, record);
  }

  return record;
}

function clearRecoveryWrites(directory) {
  for (const entry of entries(directory)) {
    if (entry.isFile() && entry.name.startsWith('.snapshot-recovery-') && entry.name.endsWith('.tmp')) fs.rmSync(path.join(directory, entry.name));
  }
}

function recoverDirectory(directory, state) {
  clearRecoveryWrites(directory);

  if (state.protected.paths.has(directory)) return 0;
  const owner = read(path.join(directory, 'temporary-owner.json'));
  const released = releasedReader(owner, state);

  if (owner && active(owner, state.boot, released)) return 0;
  const blocked = blockedSources(directory, owner, state);

  if (!blocked && owner && readerEnded(owner, state, released)) {
    if (fs.existsSync(path.join(directory, 'comparison-retry.json'))) return 0;
    discard(directory);

    return 0;
  }

  return preserveLegacy(directory, state, owner, blocked);
}

function preserveLegacy(directory, state, owner, blocked) {
  const saved = read(path.join(directory, 'snapshot.json'));
  const recovery = legacySnapshot(directory, state.boot, saved);

  if (!recovery.deduplicated) {
    if (saved?.selfContained) fs.rmSync(path.join(directory, 'index'), { force: true });

    deduplicate(directory, state.objects());
    recoveryRecords.write(directory, { ...recovery, deduplicated: true });
  }

  if (!blocked && !owner && expiredDuplicate(recovery, saved, state) && fullyShared(directory, state.objects())) {
    discard(directory);

    return 0;
  }

  return 1;
}

function expiredDuplicate(recovery, saved, state) {
  if (!recovery.boot || !state.boot || recovery.boot === state.boot || !saved?.selfContained) return false;

  return state.snapshots.some((item) => item.saved.sessionId === saved.sessionId && item.saved.tree === saved.tree);
}

function recoverLocked(root, parent) {
  const children = entries(parent);
  const warnings = [];

  for (const child of children) {
    if (child.isDirectory() && child.name.startsWith('.cleanup-pi-desktop-diff-')) discard(path.join(parent, child.name));
  }

  const directories = children.filter((entry) => entry.isDirectory() && entry.name.startsWith('pi-desktop-diff-')).map((entry) => path.join(parent, entry.name));
  const snapshots = [];

  savedSnapshots(root, snapshots, warnings);

  let objects;

  const releases = new Map(require('./session-database.cjs').snapshotReaderReleases(root).map(row => [row.scope, JSON.parse(row.record_json)]));

  const state = { parent, releases, boot: bootIdentity(), protected: protectedSources(root, directories, warnings), snapshots, objects: () => {
    if (objects) return objects;
    objects = new Map();

    for (const snapshot of snapshots) {
      try { objectFiles(snapshot.directory, (file, key, stat) => objects.set(key, { file, stat })); }
      catch (error) { warn(warnings, snapshot.directory, error); }
    }

    return objects;
  } };

  let preserved = 0;

  for (const directory of directories) {
    try { preserved += recoverDirectory(directory, state); }
    catch (error) { if (error.code !== 'ENOENT') warn(warnings, directory, error); }
  }

  pruneReleasedReaders(parent, directories, state.boot, warnings);

  if (preserved) warnings.push(`${preserved} temporary diff snapshot(s) have uncertain reader ownership or incomplete recovery. Their files and recovery records are preserved in ${parent}.`);

  return warnings;
}

function recoverSnapshotTemps(root) {
  const parent = path.join(root, 'git-snapshots');

  if (!fs.existsSync(parent)) return [];
  let descriptor;

  try {
    if (fs.realpathSync(parent) !== parent) throw new Error('Snapshot storage cannot be a symlink');
    descriptor = fs.openSync(path.join(parent, '.recovery.lock'), fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    const lock = spawnSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', descriptor] });

    if (lock.error) throw lock.error;

    if (lock.status === 1) return [];

    if (lock.status !== 0) throw new Error('Could not lock temporary snapshot recovery');

    return recoverLocked(root, parent);
  } catch (error) { return [`Temporary diff snapshot cleanup is pending: ${error.message}`]; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

module.exports = { recoverSnapshotTemps };
