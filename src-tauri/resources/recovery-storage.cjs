const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const kind = 'missing-directory-recovery';

const states = new Set(['allocated', 'ready', 'published']);

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');

  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function writeRecord(container, record) {
  const temporary = path.join(container, `ownership.${randomUUID()}.tmp`);

  const descriptor = fs.openSync(temporary, 'wx', 0o600);

  try {
    fs.writeFileSync(descriptor, JSON.stringify(record));

    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }

  fs.renameSync(temporary, path.join(container, 'ownership.json'));

  syncDirectory(container);
}

function readSession(sessionPath) {
  const line = fs.readFileSync(sessionPath, 'utf8').split('\n').find(entry => entry.trim());

  const header = JSON.parse(line);

  if (header.type !== 'session' || String(header.id) !== header.id || !header.id || !path.isAbsolute(header.cwd ?? '')) throw new Error('Invalid session directory');

  return header;
}

function realDirectory(directory) {
  try {
    const metadata = fs.lstatSync(directory);

    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Recovery directory is not a regular directory: ${directory}`);

    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;

    throw error;
  }
}

function legacyDirectory(cwd) {
  if (/^\/tmp\/piop-session-[a-zA-Z0-9]{6}$/.test(cwd)) return cwd;

  if (/^\/tmp\/piop-recovery-[a-zA-Z0-9]{6}\/workdir$/.test(cwd)) return cwd;

  return null;
}

function existingLegacyDirectory(cwd) {
  const source = legacyDirectory(cwd);

  if (!source) return null;

  if (path.basename(source) === 'workdir' && !realDirectory(path.dirname(source))) return null;

  return realDirectory(source) ? source : null;
}

function syncTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);

    if (entry.isDirectory()) syncTree(target);
    else if (entry.isFile()) {
      const descriptor = fs.openSync(target, 'r');

      try { fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
    }
  }

  syncDirectory(directory);
}

function fileDigest(file) {
  const descriptor = fs.openSync(file, 'r');

  const hash = createHash('sha256');

  const buffer = Buffer.alloc(1024 * 1024);

  try {
    let count;

    while ((count = fs.readSync(descriptor, buffer)) > 0) hash.update(buffer.subarray(0, count));

    return hash.digest('hex');
  } finally { fs.closeSync(descriptor); }
}

function fingerprint(metadata) {
  return `${metadata.dev}:${metadata.ino}:${metadata.mode}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
}

function captureEntry(target, relative, entries) {
  const before = fs.lstatSync(target, { bigint: true });

  let contents;

  if (before.isFile()) contents = fileDigest(target);
  else if (before.isSymbolicLink()) contents = fs.readlinkSync(target);
  else if (!before.isDirectory()) throw new Error(`Cannot safely migrate a special file: ${target}`);

  entries.set(relative, { identity: fingerprint(before), mode: before.mode, contents, symlink: before.isSymbolicLink() });

  if (before.isDirectory()) {
    for (const name of fs.readdirSync(target).sort()) captureEntry(path.join(target, name), path.join(relative, name), entries);
  }

  if (fingerprint(fs.lstatSync(target, { bigint: true })) !== fingerprint(before)) throw new Error('The temporary recovery directory changed while being read. Stop its writers and retry.');
}

function captureTree(directory) {
  const entries = new Map();

  captureEntry(directory, '', entries);

  return entries;
}

function relocatedLinkTarget(target, source, destination, name) {
  const absolute = path.isAbsolute(target);

  const originalTarget = absolute ? target : path.resolve(source, path.dirname(name), target);

  const relative = path.relative(source, originalTarget);

  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return originalTarget;

  return absolute ? path.join(destination, relative) : target;
}

function relocateInternalLinks(entries, source, destination) {
  const unmanagedTemporarySymlinks = [];

  for (const [name, entry] of entries) {
    if (!entry.symlink) continue;

    const replacement = relocatedLinkTarget(entry.contents, source, destination, name);

    if (replacement !== entry.contents) {
      const link = path.join(destination, name);
      fs.unlinkSync(link);
      fs.symlinkSync(replacement, link);
    }

    if (replacement.startsWith('/tmp/')) unmanagedTemporarySymlinks.push(name);
  }

  return unmanagedTemporarySymlinks;
}

function copiedContents(entry, source, destination, name) {
  return entry.symlink ? relocatedLinkTarget(entry.contents, source, destination, name) : entry.contents;
}

function verifyCopy(before, source, destination) {
  const after = captureTree(source);

  const copy = captureTree(destination);

  if (before.size !== after.size || before.size !== copy.size) throw new Error('The temporary recovery directory changed during migration. Its original files have been retained.');

  for (const [name, original] of before) {
    const current = after.get(name);

    const replacement = copy.get(name);

    if (original.identity !== current?.identity || original.contents !== current.contents) throw new Error('The temporary recovery directory changed during migration. Its original files have been retained.');

    if (original.mode !== replacement?.mode || copiedContents(original, source, destination, name) !== replacement.contents) throw new Error('The durable recovery copy could not be verified. Its original files have been retained.');
  }
}

function discoverLegacySessions(profileRoot) {
  const sessions = [];

  const warnings = [];

  const storage = createRecoveryStorage(profileRoot);

  function candidate(header, sessionPath) {
    const exists = Boolean(existingLegacyDirectory(header.cwd));
    const pending = storage.find(header, sessionPath, 'legacy-copy');

    const retainedDirectories = storage.retained(header, sessionPath).map(record => ({ directory: record.directory, state: record.state, mode: record.mode }));

    return { sessionId: header.id, sessionPath, cwd: header.cwd, exists, stagedDirectory: pending?.directory ?? null, retainedDirectories };
  }

  function visit(directory) {
    let entries;

    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if (error.code !== 'ENOENT') warnings.push(`${directory}: ${error.message}`);

      return;
    }

    for (const entry of entries) {
      const file = path.join(directory, entry.name);

      if (entry.isDirectory() && !entry.name.endsWith('.snapshots')) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const header = readSession(file);

          if (legacyDirectory(header.cwd)) sessions.push(candidate(header, file));
        } catch (error) { warnings.push(`${file}: ${error.message}`); }
      }
    }
  }

  visit(path.join(path.dirname(storage.root), 'sessions'));

  visit(path.join(path.dirname(storage.root), 'archived'));

  return { sessions, warnings };
}

function createRecoveryStorage(profileRoot) {
  const profile = fs.existsSync(profileRoot) ? fs.realpathSync(profileRoot) : path.resolve(profileRoot);

  const root = path.join(profile, 'recovery');

  function ensureRoot() {
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });

    try { fs.mkdirSync(root, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }

    if (!realDirectory(root)) throw new Error('The managed recovery root is unavailable');

    syncDirectory(profile);

    syncDirectory(path.dirname(profile));

    return root;
  }

  function containerFor(record) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.id)) throw new Error('Invalid recovery ownership identity');

    const container = path.join(root, record.id);

    if (record.directory !== path.join(container, 'workdir')) throw new Error('Invalid recovery ownership directory');

    if (!realDirectory(root) || !realDirectory(container)) throw new Error('Recovery ownership directory is missing');

    return container;
  }

  function records() {
    if (!realDirectory(root)) return [];

    const result = [];

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      try {
        const ownership = path.join(root, entry.name, 'ownership.json');

        if (!fs.lstatSync(ownership).isFile()) continue;

        const record = JSON.parse(fs.readFileSync(ownership, 'utf8'));

        if (!validRecord(record, entry.name)) continue;

        containerFor(record);

        result.push(record);
      } catch (error) { console.error(`Recovery ownership ${entry.name}: ${error.message}`); }
    }

    return result;
  }

  function validRecord(record, id) {
    return record.version === 1 && record.managedBy === 'piop' && record.kind === kind
      && record.id === id && states.has(record.state) && validOwners(record.owners)
      && path.isAbsolute(record.originalCwd ?? '') && ['empty', 'remote-branch', 'legacy-copy'].includes(record.mode);
  }

  function validOwners(owners) {
    return Array.isArray(owners) && owners.length > 0
      && owners.every(owner => owner && String(owner.sessionId) === owner.sessionId && owner.sessionId.length > 0 && path.isAbsolute(owner.sessionPath ?? ''));
  }

  function allocate(header, sessionPath, mode) {
    ensureRoot();

    const id = randomUUID();

    const container = path.join(root, id);

    fs.mkdirSync(container, { mode: 0o700 });

    const record = {
      version: 1, managedBy: 'piop', kind, id, state: 'allocated', mode,
      directory: path.join(container, 'workdir'), originalCwd: header.cwd,
      owners: [{ sessionId: header.id, sessionPath }], createdAt: Date.now(),
      originalContentsRestored: false,
    };

    writeRecord(container, record);

    syncDirectory(root);

    return record;
  }

  function ready(record, recovered) {
    if (!realDirectory(record.directory)) throw new Error('The durable recovery directory is missing');

    syncTree(record.directory);

    Object.assign(record, { state: 'ready', recovered });

    writeRecord(containerFor(record), record);

    return record;
  }

  function find(header, sessionPath, mode) {
    return retained(header, sessionPath).find(record => record.state !== 'allocated'
      && record.mode === mode && record.originalCwd === header.cwd
      && realDirectory(record.directory));
  }

  function retained(header, sessionPath) {
    if (!path.isAbsolute(sessionPath)) return [];

    return records().filter(record => (record.originalCwd === header.cwd || record.directory === header.cwd)
      && record.owners.some(owner => owner.sessionId === header.id));
  }

  function current(header, sessionPath) {
    return retained(header, sessionPath).find(record => record.state !== 'allocated' && record.directory === header.cwd
      && realDirectory(record.directory));
  }

  function published(record, sessionPath) {
    const header = readSession(sessionPath);

    if (header.cwd !== fs.realpathSync(record.directory)) throw new Error('The conversation does not point to the durable recovery directory');

    if (!record.owners.some(owner => owner.sessionId === header.id)) throw new Error('The conversation does not own this recovery record');

    if (!record.owners.some(owner => owner.sessionId === header.id && owner.sessionPath === sessionPath)) record.owners.push({ sessionId: header.id, sessionPath });

    syncDirectory(path.dirname(sessionPath));

    record.state = 'published';

    record.publishedAt = Date.now();

    writeRecord(containerFor(record), record);
  }

  function migrate(header, sessionPath) {
    const pending = find(header, sessionPath, 'legacy-copy');

    const source = existingLegacyDirectory(header.cwd);

    if (!source && pending) return pending;

    if (!source) throw new Error('The temporary recovery directory is missing. Its contents cannot be migrated; choose an empty directory or the latest remote branch instead.');

    const before = captureTree(source);

    if (pending) {
      try {
        verifyCopy(before, source, pending.directory);

        return pending;
      } catch (error) { console.error(`Retaining an earlier recovery copy at ${pending.directory}: ${error.message}`); }
    }

    const record = allocate(header, sessionPath, 'legacy-copy');

    fs.cpSync(source, record.directory, { recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });

    const unmanagedTemporarySymlinks = relocateInternalLinks(before, source, record.directory);

    verifyCopy(before, source, record.directory);

    ready(record, { sourceCwd: source, sourceRetained: true, unmanagedTemporarySymlinks });

    return record;
  }

  return { root, allocate, ready, find, current, published, migrate, records, retained };
}

module.exports = { createRecoveryStorage, discoverLegacySessions, existingLegacyDirectory, legacyDirectory, readSession };
