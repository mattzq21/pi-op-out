const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

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

function write(file, value) {
  const temporary = path.join(path.dirname(file), `.snapshot-recovery-${randomUUID()}.tmp`);

  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    sync(temporary);
    fs.renameSync(temporary, file);
    sync(path.dirname(file));
  } finally { fs.rmSync(temporary, { force: true }); }
}

function alive(processOwner) {
  if (!Number.isSafeInteger(processOwner.pid) || processOwner.pid < 1) throw new Error('Invalid temporary snapshot reader');

  try { process.kill(processOwner.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }

  if (!processOwner.identity) return true;

  try { return fs.readFileSync(`/proc/${processOwner.pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19] === processOwner.identity; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function active(record, boot) {
  if (record.version !== 1 || !Array.isArray(record.processes) || !record.processes.length) throw new Error('Invalid temporary snapshot ownership');

  if (record.boot && boot && record.boot !== boot) return false;

  return record.processes.some(alive);
}

function protectedSources(directories) {
  const sources = new Set();

  for (const directory of directories) {
    const fallback = read(path.join(directory, 'comparison-retry.json'));

    if (!fallback) continue;

    for (const value of [fallback.baseline, fallback.current, fallback.originalBaseline].filter(Boolean)) {
      const source = JSON.parse(value).root;

      if (!path.isAbsolute(source)) throw new Error('Invalid snapshot recovery source');
      sources.add(source);
      sources.add(path.dirname(source));
    }
  }

  return sources;
}

function savedSnapshots(directory, snapshots) {
  for (const entry of entries(directory)) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const child = path.join(directory, entry.name);

    if (entry.name.endsWith('.snapshots')) {
      for (const name of ['latest', 'previous']) addSavedSnapshot(path.join(child, name), snapshots);

      for (const pending of entries(path.join(child, 'pending'))) {
        if (!pending.isDirectory() || pending.name.startsWith('.')) continue;

        for (const phase of ['before', 'after']) addSavedSnapshot(path.join(child, 'pending', pending.name, phase), snapshots);
      }
    } else savedSnapshots(child, snapshots);
  }
}

function addSavedSnapshot(directory, snapshots) {
  const saved = read(path.join(directory, 'snapshot.json'));

  if (saved?.selfContained && saved.sessionId && /^[a-f0-9]{40,64}$/.test(saved.tree)) snapshots.push({ directory, saved });
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
}

function legacySnapshot(directory, boot, saved) {
  const file = path.join(directory, 'recovery.json');
  let record = read(file);

  if (!record) {
    record = { version: 1, boot, discoveredAt: Date.now(), reason: 'Reader ownership was not recorded; preserve until duplicate data and an ended reader lifetime can be verified.', sessionId: saved?.sessionId, tree: saved?.tree, repositoryRoot: saved?.repositoryRoot };
    write(file, record);
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

  if (state.protected.has(directory)) return 0;
  const owner = read(path.join(directory, 'temporary-owner.json'));

  if (owner && active(owner, state.boot)) return 0;

  if (owner && ['building', 'reader'].includes(owner.state)) {
    if (fs.existsSync(path.join(directory, 'comparison-retry.json'))) return 0;
    discard(directory);

    return 0;
  }

  return preserveLegacy(directory, state, owner);
}

function preserveLegacy(directory, state, owner) {
  const saved = read(path.join(directory, 'snapshot.json'));
  const recovery = legacySnapshot(directory, state.boot, saved);

  if (!recovery.deduplicated) {
    if (saved?.selfContained) fs.rmSync(path.join(directory, 'index'), { force: true });

    deduplicate(directory, state.objects());
    write(path.join(directory, 'recovery.json'), { ...recovery, deduplicated: true });
  }

  if (!owner && expiredDuplicate(recovery, saved, state) && fullyShared(directory, state.objects())) {
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

  for (const child of children) {
    if (child.isDirectory() && child.name.startsWith('.cleanup-pi-desktop-diff-')) discard(path.join(parent, child.name));
  }

  const directories = children.filter((entry) => entry.isDirectory() && entry.name.startsWith('pi-desktop-diff-')).map((entry) => path.join(parent, entry.name));
  const snapshots = [];

  for (const area of ['sessions', 'archived']) savedSnapshots(path.join(root, area), snapshots);

  let objects;

  const state = { boot: bootIdentity(), protected: protectedSources(directories), snapshots, objects: () => {
    if (objects) return objects;
    objects = new Map();

    for (const snapshot of snapshots) objectFiles(snapshot.directory, (file, key, stat) => objects.set(key, { file, stat }));

    return objects;
  } };

  let preserved = 0;

  for (const directory of directories) {
    try { preserved += recoverDirectory(directory, state); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  return preserved ? [`${preserved} temporary diff snapshot(s) have uncertain reader ownership or incomplete recovery. Their files and recovery records are preserved in ${parent}.`] : [];
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
