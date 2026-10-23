const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const kind = 'missing-directory-recovery';

const states = new Set(['allocated', 'ready', 'published']);

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');

  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function writeRecord(container, record, reserve = false) {
  require('./session-database.cjs').saveRecoveryRecord(path.dirname(path.dirname(container)), record, reserve);
}

function readSession(profile, sessionPath) {
  const header = require('./transcript-references.cjs').read(profile, sessionPath)[0];

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

    if (!realDirectory(root) || !realDirectory(container) && record.state !== 'allocated') throw new Error('Recovery ownership directory is missing');

    return container;
  }

  function records() {
    if (!realDirectory(root)) return [];

    const result = [];

    for (const row of require('./session-database.cjs').recoveryRecords(profile)) {
      try {
        const record = JSON.parse(row.record_json);

        if (!validRecord(record, row.record_id)) continue;
        containerFor(record);
        result.push(record);
      } catch (error) { console.error(`Recovery ownership ${row.record_id}: ${error.message}`); }
    }

    return result;
  }

  function validRecord(record, id) {
    return record.version === 1 && record.managedBy === 'piop' && record.kind === kind
      && record.id === id && states.has(record.state) && validOwners(record.owners)
      && path.isAbsolute(record.originalCwd ?? '') && record.mode === 'empty';
  }

  function validOwners(owners) {
    return Array.isArray(owners) && owners.length > 0
      && owners.every(owner => owner && String(owner.sessionId) === owner.sessionId && owner.sessionId.length > 0 && path.isAbsolute(owner.sessionPath ?? ''));
  }

  function allocate(header, sessionPath, mode) {
    ensureRoot();

    const id = randomUUID();

    const container = path.join(root, id);

    const record = {
      version: 1, managedBy: 'piop', kind, id, state: 'allocated', mode,
      directory: path.join(container, 'workdir'), originalCwd: header.cwd,
      owners: [{ sessionId: header.id, sessionPath }], createdAt: Date.now(),
      originalContentsRestored: false,
    };

    writeRecord(container, record, true);
    fs.mkdirSync(container, { mode: 0o700 });

    syncDirectory(root);

    return record;
  }

  function ready(record, recovered) {
    if (!realDirectory(record.directory)) throw new Error('The durable recovery directory is missing');

    syncTree(record.directory);
    // The directory entry itself lives in the parent; sync it so the folder survives power loss once the record says ready.
    syncDirectory(path.dirname(record.directory));

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
    const header = readSession(profile, sessionPath);

    if (header.cwd !== fs.realpathSync(record.directory)) throw new Error('The conversation does not point to the durable recovery directory');

    if (!record.owners.some(owner => owner.sessionId === header.id)) throw new Error('The conversation does not own this recovery record');

    if (!record.owners.some(owner => owner.sessionId === header.id && owner.sessionPath === sessionPath)) record.owners.push({ sessionId: header.id, sessionPath });

    syncDirectory(path.dirname(sessionPath));

    record.state = 'published';

    record.publishedAt = Date.now();

    writeRecord(containerFor(record), record);
  }

  return { root, allocate, ready, find, current, published, records, retained };
}

module.exports = { createRecoveryStorage, readSession };
