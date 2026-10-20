const { lockSync } = require('../file-lock.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const goalDependencies = require('./goal-dependencies.cjs');
const goalOwnership = require('./goal-ownership.cjs');

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const validOwnership = value => object(value) && value.version === 1 && value.kind === 'goal-assets'
  && Array.isArray(value.owners) && value.owners.every(owner => object(owner) && typeof owner.sessionId === 'string' && owner.sessionId.length > 0 && (owner.sessionPath === undefined || typeof owner.sessionPath === 'string'))
  && (value.retiredOwners === undefined || strings(value.retiredOwners));
const validContract = value => object(value) && value.version === 1 && value.policy === 'shared-profile'
  && Array.isArray(value.directories) && value.directories.every(item => object(item) && typeof item.path === 'string' && typeof item.identity === 'string');

const inside = (root, file) => path.isAbsolute(file) && path.resolve(file) === file && file.startsWith(root + path.sep);

function exists(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function sync(file) {
  const descriptor = fs.openSync(file, 'r');

  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function rootForDirectory(directory) {
  const canonical = fs.realpathSync(directory);
  let current = canonical;

  while (path.dirname(current) !== current) {
    if (path.basename(current) === 'sessions') return path.dirname(current);
    current = path.dirname(current);
  }

  return canonical;
}

function acquire(root) {
  if (fs.realpathSync(root) !== root) throw new Error('Goal asset storage has ambiguous ancestry');
  const file = path.join(root, 'goal-assets.lock');
  const descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);

  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Invalid goal asset lock');
    const result = lockSync(descriptor, false, true, 5000);

    if (!result) throw new Error('Goal assets are in use by another storage operation. Retry after it finishes.');

    return () => fs.closeSync(descriptor);
  } catch (error) { fs.closeSync(descriptor); throw error; }
}

function locked(root, operation) {
  const release = acquire(root);

  try { return operation(); }
  finally { release(); }
}

function identity(directory) {
  const metadata = fs.lstatSync(directory, { bigint: true });

  if (!metadata.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error(`Goal asset directory is unavailable or was replaced: ${directory}`);

  return `${metadata.dev}:${metadata.ino}`;
}

function validPath(root, directory) {
  return inside(root, directory) && path.basename(path.dirname(directory)) === 'attachments'
    && /^goal-[a-zA-Z0-9_-]+$/.test(path.basename(directory)) && !/-pending-[a-zA-Z0-9]+$/.test(directory);
}

function readOwners(root, directory) {
  const record = goalOwnership.read(root, directory);

  if (record === undefined) return { version: 1, kind: 'goal-assets', owners: [] };

  if (!validOwnership(record)) throw new Error(`Damaged goal ownership retained: ${directory}`);

  return record;
}

function visitStrings(value, visit) {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) value.forEach(item => visitStrings(item, visit));
  else if (value && object(value)) Object.values(value).forEach(item => visitStrings(item, visit));
}

function directReferences(entries, root) {
  const directories = new Set();
  visitStrings(entries, text => {
    for (const match of text.matchAll(/\/attachments\/goal-[a-zA-Z0-9_-]+(?=\/|$|[\s"'`),.;:!?\]}>])/g)) {
      const start = text.lastIndexOf(root + path.sep, match.index);

      if (start < 0) continue;
      directories.add(text.slice(start, match.index + match[0].length));
    }
  });

  for (const entry of entries) {
    if (entry.goalAssets === undefined) continue;

    verifyContract(root, entry.goalAssets);
    entry.goalAssets.directories.forEach(directory => directories.add(directory.path));
  }

  return directories;
}

function savedDependencies(root, directory) {
  const contract = goalDependencies.read(root, directory);

  if (contract === undefined) return [];
  verifyContract(root, contract);

  return contract.directories;
}

function textDependencies(root, directory) {
  const texts = [];

  for (const entry of goalDependencies.textContents(root, directory)) {
    if (entry.name === 'goal-objective.md' || /^attachment-\d+\.txt$/.test(entry.name)) texts.push(entry.text);
  }

  return directReferences(texts, root);
}

function dependencyClosure(root, seeds) {
  const directories = new Set(seeds);

  for (const directory of directories) {
    if (!validPath(root, directory)) throw new Error(`Goal dependency is outside shared storage: ${directory}`);

    if (!exists(directory)) continue;
    identity(directory);
    savedDependencies(root, directory).forEach(dependency => directories.add(dependency.path));
    textDependencies(root, directory).forEach(dependency => directories.add(dependency));
  }

  return directories;
}

function references(entries, root) {
  const directories = dependencyClosure(root, directReferences(entries, root));

  if (![...directories].some(directory => !exists(directory))) return directories;
  const historical = inheritedReferences(entries, root);

  for (const directory of directories) if (!exists(directory) && historical.has(directory)) directories.delete(directory);

  return directories;
}

function inheritedReferences(entries, root) {
  const parents = new Set(entries.flatMap(entry => entry?.type === 'session' && typeof entry.parentSession === 'string' ? [entry.parentSession] : []));
  const directories = new Set();

  for (const file of parents) {
    if (!path.isAbsolute(file) || !exists(file)) continue;
    const saved = require('../transcript-references.cjs').read(root, file);
    dependencyClosure(root, directReferences(saved, root)).forEach(directory => directories.add(directory));
  }

  return directories;
}

function claimSnapshots(root, directories) {
  return [...directories].map(directory => ({ directory, identity: claimableDirectory(root, directory), record: readOwners(root, directory), existed: goalOwnership.read(root, directory) !== undefined }));
}

function claimDirectory(root, directory, sessionId, sessionPath, expectedIdentity) {
  const expected = claimableDirectory(root, directory);

  if (expectedIdentity !== undefined && expected !== expectedIdentity) throw new Error(`Goal dependency changed before publication: ${directory}`);
  const record = readOwners(root, directory);
  goalOwnership.save(root, directory, claimedRecord(record, sessionId, sessionPath));

  return { path: directory, identity: expected };
}

function claimableDirectory(root, directory) {
  if (!validPath(root, directory)) throw new Error(`Goal assets are outside their shared storage: ${directory}`);

  if (reclamationPending(root, directory)) throw new Error(`Goal asset deletion is pending; cannot publish a new owner: ${directory}`);

  return identity(directory);
}

function claimedRecord(record, sessionId, sessionPath) {
  const owners = record.owners.filter(owner => owner.sessionId !== sessionId);
  owners.push({ sessionId, sessionPath });

  return { ...record, owners };
}

function claim(root, directory, sessionId, sessionPath, objective) {
  return locked(root, () => {
    const directories = dependencyClosure(root, [directory, ...directReferences([objective], root)]);
    const snapshots = claimSnapshots(root, directories);
    const dependencies = snapshots.flatMap(snapshot => snapshot.directory === directory ? [] : [{ path: snapshot.directory, identity: snapshot.identity }]);
    goalDependencies.save(root, directory, { version: 1, policy: 'shared-profile', directories: dependencies });
    publishClaims(root, snapshots, sessionId, sessionPath);

    return { path: directory, identity: identity(directory) };
  });
}

function retainHistory(root, entries, sessionId, sessionPath) {
  return locked(root, () => {
    const snapshots = historySnapshots(root, entries, sessionId);

    return publishClaims(root, snapshots, sessionId, sessionPath);
  });
}

function historySnapshots(root, entries, sessionId) {
  verifyContract(root, entries[0]?.goalAssets);
  const referencesToKeep = references(entries, root);
  ownedDirectories(root, sessionId).forEach(directory => referencesToKeep.add(directory));

  return claimSnapshots(root, dependencyClosure(root, referencesToKeep));
}

function historyContract(root, entries, sessionId) {
  const snapshots = historySnapshots(root, entries, sessionId);
  return { version: 1, policy: 'shared-profile', directories: snapshots.filter(snapshot => snapshot.record.owners.some(owner => owner.sessionId === sessionId)).map(snapshot => ({ path: snapshot.directory, identity: snapshot.identity })) };
}

function publishClaims(root, snapshots, sessionId, sessionPath) {
  const attempted = [];
  const directories = [];

  try {
    for (const snapshot of snapshots) {
      attempted.push(snapshot);
      directories.push(claimDirectory(root, snapshot.directory, sessionId, sessionPath, snapshot.identity));
    }

    return { version: 1, policy: 'shared-profile', directories };
  } catch (error) {
    const failures = [];

    for (const snapshot of attempted.reverse()) {
      try { undoClaim(root, snapshot, sessionId, sessionPath); }
      catch (failure) { failures.push(String(failure)); }
    }

    if (failures.length) throw new Error(`${String(error)}\nGoal ownership rollback is pending; claims retained: ${failures.join('; ')}`);
    throw error;
  }
}

function undoClaim(root, snapshot, sessionId, sessionPath) {
  if (identity(snapshot.directory) !== snapshot.identity) throw new Error(`Goal claim directory changed: ${snapshot.directory}`);
  const current = JSON.stringify(readOwners(root, snapshot.directory));

  if (current === JSON.stringify(snapshot.record)) return;

  if (current !== JSON.stringify(claimedRecord(snapshot.record, sessionId, sessionPath))) throw new Error(`Goal claim ownership changed: ${snapshot.directory}`);

  goalOwnership.save(root, snapshot.directory, snapshot.existed ? snapshot.record : undefined);
}

function ownedDirectories(root, sessionId) {
  const directories = [];

  for (const directory of goalOwnership.directories(root, sessionId)) {
    if (!validPath(root, directory)) continue;

    try { if (readOwners(root, directory).owners.some(owner => owner.sessionId === sessionId)) directories.push(directory); }
    catch (error) { console.error(`${directory}: damaged goal ownership retained: ${error.message}`); }
  }

  return directories;
}

function verifyContract(root, contract) {
  if (contract === undefined) return;

  if (!validContract(contract)) throw new Error('Invalid goal asset dependency contract');

  for (const dependency of contract.directories) {
    if (!validPath(root, dependency.path) || !goalDependencies.matchesDirectory(root, dependency.path, dependency.identity, identity(dependency.path))) throw new Error(`Archived goal assets changed or are missing: ${dependency.path}`);
  }
}

function releaseHistory(root, contract, sessionId) {
  return locked(root, () => {
    verifyContract(root, contract);

    for (const directory of contract.directories) {
      const record = readOwners(root, directory.path);
      goalOwnership.save(root, directory.path, { ...record, owners: record.owners.filter(owner => owner.sessionId !== sessionId) });
    }
  });
}

function discardPreparation(root, directory, sessionId) {
  return locked(root, () => {
    if (!validPath(root, directory)) throw new Error('Invalid unpublished goal asset directory');
    const expected = identity(directory);
    const record = readOwners(root, directory);

    if (record.owners.some(owner => owner.sessionId !== sessionId)) return;
    fs.rmSync(directory, { recursive: true });
    sync(path.dirname(directory));
    endReclamation(root, directory, expected);
  });
}

function reclamationKey(directory) { return createHash('sha256').update(directory).digest('hex'); }

function reclamationPending(root, directory) {
  const database = require('../session-database.cjs').open(root);

  try { return Boolean(database.prepare('SELECT 1 FROM goal_asset_reclamations WHERE record_id=?').get(reclamationKey(directory))); }
  finally { database.close(); }
}

function removeRecoveryRecords(database, directory, expected) {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goal_directory_recoveries'").get()) return;
  const rows = database.prepare("SELECT directory, record_json FROM goal_directory_recoveries WHERE json_extract(record_json, '$.staging')=? AND json_extract(record_json, '$.current')=?").all(directory, expected);

  for (const row of rows) {
    if (exists(row.directory)) continue;
    database.prepare('DELETE FROM goal_directory_recoveries WHERE directory=? AND record_json=?').run(row.directory, row.record_json);
  }
}

function removeDirectoryRecords(database, directory, expected) {
  if (exists(directory)) return;

  for (const table of ['goal_asset_dependencies', 'goal_text_files', 'goal_text_contents', 'goal_preparations', 'goal_ownership']) {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    database.prepare(`DELETE FROM ${table} WHERE directory=? AND identity=?`).run(directory, expected);
  }

  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goal_directory_history'").get()) database.prepare('DELETE FROM goal_directory_history WHERE directory=? AND current_identity=?').run(directory, expected);
  removeRecoveryRecords(database, directory, expected);
}

function updateReclamation(root, directory, expected, removing) {
  const database = require('../session-database.cjs').open(root);
  const key = reclamationKey(directory);
  database.exec('BEGIN IMMEDIATE');

  try {
    const row = database.prepare('SELECT record_json FROM goal_asset_reclamations WHERE record_id=?').get(key);

    if (row) {
      const record = JSON.parse(row.record_json);

      if (record.path !== directory || record.identity !== expected) throw new Error(`Ambiguous goal reclamation retained: ${directory}`);
    }

    if (removing) {
      removeDirectoryRecords(database, directory, expected);
      database.prepare('DELETE FROM goal_asset_reclamations WHERE record_id=?').run(key);
    }
    else if (!row) database.prepare('INSERT INTO goal_asset_reclamations VALUES (?, ?)').run(key, JSON.stringify({ path: directory, identity: expected }));
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  finally { database.close(); }
}

function beginReclamation(root, directory, expected) { updateReclamation(root, directory, expected, false); }

function endReclamation(root, directory, expected) {
  updateReclamation(root, directory, expected, true);
}

module.exports = { rootForDirectory, acquire, locked, exists, identity, validPath, readOwners, directReferences, references, claim, retainHistory, historyContract, ownedDirectories, verifyContract, releaseHistory, discardPreparation, beginReclamation, endReclamation };
