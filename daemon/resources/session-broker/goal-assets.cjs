const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Type } = require('typebox');
const { Check } = require('typebox/value');

const ownerSchema = Type.Object({ sessionId: Type.String({ minLength: 1 }), sessionPath: Type.Optional(Type.String()) });

const ownershipSchema = Type.Object({ version: Type.Literal(1), kind: Type.Literal('goal-assets'), owners: Type.Array(ownerSchema), retiredOwners: Type.Optional(Type.Array(Type.String())) });

const dependencySchema = Type.Object({ path: Type.String(), identity: Type.String() });

const contractSchema = Type.Object({ version: Type.Literal(1), policy: Type.Literal('shared-profile'), directories: Type.Array(dependencySchema) });

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

function write(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);

  try {
    try { fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }

    fs.renameSync(temporary, file);
    sync(path.dirname(file));
  }
  finally { if (exists(temporary)) fs.unlinkSync(temporary); }
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
    const result = spawnSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'pipe', descriptor], timeout: 5000 });

    if (result.error) throw result.error;

    if (result.status !== 0) throw new Error('Goal assets are in use by another storage operation. Retry after it finishes.');

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

function readOwners(directory) {
  const file = path.join(directory, 'owners.json');
  const metadata = exists(file);

  if (!metadata) return { version: 1, kind: 'goal-assets', owners: [] };

  if (!metadata.isFile()) throw new Error(`Goal ownership is not a regular file: ${file}`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (!Check(ownershipSchema, record)) throw new Error(`Damaged goal ownership retained: ${file}`);

  return record;
}

function visitStrings(value, visit) {
  if (Check(Type.String(), value)) visit(value);
  else if (Array.isArray(value)) value.forEach(item => visitStrings(item, visit));
  else if (value && Check(Type.Object({}, { additionalProperties: true }), value)) Object.values(value).forEach(item => visitStrings(item, visit));
}

function directReferences(entries, root) {
  const directories = new Set();
  visitStrings(entries, text => {
    for (const match of text.matchAll(/\/attachments\/goal-[a-zA-Z0-9_-]+(?=\/)/g)) {
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

function assetText(file) {
  if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) throw new Error(`Goal asset text has ambiguous ownership: ${file}`);

  return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
}

function savedDependencies(root, directory) {
  const file = path.join(directory, 'dependencies.json');

  if (!exists(file)) return [];
  const contract = JSON.parse(assetText(file));
  verifyContract(root, contract);

  return contract.directories;
}

function textDependencies(root, directory) {
  const texts = [];

  for (const entry of fs.readdirSync(directory)) {
    if (entry === 'goal-objective.md' || /^attachment-\d+\.txt$/.test(entry)) texts.push(assetText(path.join(directory, entry)));
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
  const parents = new Set(entries.flatMap(entry => entry?.type === 'session' && Check(Type.String(), entry.parentSession) ? [entry.parentSession] : []));
  const directories = new Set();

  for (const file of parents) {
    if (!path.isAbsolute(file) || !exists(file)) continue;
    const saved = JSON.parse(`[${assetText(file).split('\n').filter(line => line.trim()).join(',')}]`);
    dependencyClosure(root, directReferences(saved, root)).forEach(directory => directories.add(directory));
  }

  return directories;
}

function claimSnapshots(root, directories) {
  return [...directories].map(directory => ({ directory, identity: claimableDirectory(root, directory), record: readOwners(directory), existed: Boolean(exists(path.join(directory, 'owners.json'))) }));
}

function claimDirectory(root, directory, sessionId, sessionPath, expectedIdentity) {
  const expected = claimableDirectory(root, directory);

  if (expectedIdentity !== undefined && expected !== expectedIdentity) throw new Error(`Goal dependency changed before publication: ${directory}`);
  const record = readOwners(directory);
  write(path.join(directory, 'owners.json'), claimedRecord(record, sessionId, sessionPath));

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
    write(path.join(directory, 'dependencies.json'), { version: 1, policy: 'shared-profile', directories: dependencies });
    publishClaims(root, snapshots, sessionId, sessionPath);

    return { path: directory, identity: identity(directory) };
  });
}

function retainHistory(root, entries, sessionId, sessionPath) {
  return locked(root, () => {
    verifyContract(root, entries[0]?.goalAssets);
    const referencesToKeep = references(entries, root);
    ownedDirectories(root, sessionId).forEach(directory => referencesToKeep.add(directory));
    const snapshots = claimSnapshots(root, dependencyClosure(root, referencesToKeep));

    return publishClaims(root, snapshots, sessionId, sessionPath);
  });
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
      try { undoClaim(snapshot, sessionId, sessionPath); }
      catch (failure) { failures.push(String(failure)); }
    }

    if (failures.length) throw new Error(`${String(error)}\nGoal ownership rollback is pending; claims retained: ${failures.join('; ')}`);
    throw error;
  }
}

function undoClaim(snapshot, sessionId, sessionPath) {
  if (identity(snapshot.directory) !== snapshot.identity) throw new Error(`Goal claim directory changed: ${snapshot.directory}`);
  const file = path.join(snapshot.directory, 'owners.json');

  if (!exists(file) && !snapshot.existed) return;
  const current = JSON.stringify(readOwners(snapshot.directory));

  if (current === JSON.stringify(snapshot.record)) return;

  if (current !== JSON.stringify(claimedRecord(snapshot.record, sessionId, sessionPath))) throw new Error(`Goal claim ownership changed: ${snapshot.directory}`);

  if (snapshot.existed) write(file, snapshot.record);
  else { fs.unlinkSync(file); sync(snapshot.directory); }
}

function walkDirectories(directory, visit) {
  if (!exists(directory)) return;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.endsWith('.snapshots')) continue;
    const file = path.join(directory, entry.name);

    if (entry.name !== 'attachments') walkDirectories(file, visit);
    else for (const goal of fs.readdirSync(file, { withFileTypes: true })) {
      if (goal.isDirectory()) visit(path.join(file, goal.name));
    }
  }
}

function ownedDirectories(root, sessionId) {
  const directories = [];

  const visit = directory => {
    if (!validPath(root, directory)) return;

    try { if (readOwners(directory).owners.some(owner => owner.sessionId === sessionId)) directories.push(directory); }
    catch (error) { console.error(`${directory}: damaged goal ownership retained: ${error.message}`); }
  };

  walkDirectories(path.join(root, 'sessions'), visit);

  if (path.basename(root) !== 'sessions' && exists(path.join(root, 'attachments'))) {
    for (const entry of fs.readdirSync(path.join(root, 'attachments'), { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(root, 'attachments', entry.name));
    }
  }

  return directories;
}

function verifyContract(root, contract) {
  if (contract === undefined) return;

  if (!Check(contractSchema, contract)) throw new Error('Invalid goal asset dependency contract');

  for (const dependency of contract.directories) {
    if (!validPath(root, dependency.path) || identity(dependency.path) !== dependency.identity) throw new Error(`Archived goal assets changed or are missing: ${dependency.path}`);
  }
}

function releaseHistory(root, contract, sessionId) {
  return locked(root, () => {
    verifyContract(root, contract);

    for (const directory of contract.directories) {
      const record = readOwners(directory.path);
      write(path.join(directory.path, 'owners.json'), { ...record, owners: record.owners.filter(owner => owner.sessionId !== sessionId) });
    }
  });
}

function discardPreparation(root, directory, sessionId) {
  return locked(root, () => {
    if (!validPath(root, directory)) throw new Error('Invalid unpublished goal asset directory');
    identity(directory);
    const record = readOwners(directory);

    if (record.owners.some(owner => owner.sessionId !== sessionId)) return;
    fs.rmSync(directory, { recursive: true });
    sync(path.dirname(directory));
  });
}

function reclamationKey(directory) { return createHash('sha256').update(directory).digest('hex'); }

function reclamationPending(root, directory) {
  const database = require('../session-database.cjs').open(root);

  try { return Boolean(database.prepare('SELECT 1 FROM goal_asset_reclamations WHERE record_id=?').get(reclamationKey(directory))); }
  finally { database.close(); }
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

    if (removing) database.prepare('DELETE FROM goal_asset_reclamations WHERE record_id=?').run(key);
    else if (!row) database.prepare('INSERT INTO goal_asset_reclamations VALUES (?, ?)').run(key, JSON.stringify({ path: directory, identity: expected }));
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  finally { database.close(); }
}

function beginReclamation(root, directory, expected) { updateReclamation(root, directory, expected, false); }

function endReclamation(root, directory, expected) { updateReclamation(root, directory, expected, true); }

module.exports = { rootForDirectory, acquire, locked, exists, identity, validPath, readOwners, write, references, claim, retainHistory, ownedDirectories, verifyContract, releaseHistory, discardPreparation, beginReclamation, endReclamation };
