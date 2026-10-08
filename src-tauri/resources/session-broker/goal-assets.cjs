const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Type } = require('typebox');
const { Check } = require('typebox/value');

const ownerSchema = Type.Object({ sessionId: Type.String({ minLength: 1 }), sessionPath: Type.Optional(Type.String()) });

const ownershipSchema = Type.Object({ version: Type.Literal(1), kind: Type.Literal('goal-assets'), owners: Type.Array(ownerSchema) });

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

  try { fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }

  try { fs.renameSync(temporary, file); sync(path.dirname(file)); }
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

function references(entries, root) {
  const directories = new Set();
  visitStrings(entries, text => {
    for (const match of text.matchAll(/\/attachments\/goal-[a-zA-Z0-9_-]+(?=\/)/g)) {
      const start = text.lastIndexOf(root + path.sep, match.index);

      if (start < 0) throw new Error('Goal assets reference another storage profile; preserve their original files before transferring this conversation');
      directories.add(text.slice(start, match.index + match[0].length));
    }
  });

  for (const entry of entries) {
    if (entry.goalAssets === undefined) continue;

    if (!Check(contractSchema, entry.goalAssets)) throw new Error('Damaged goal asset dependency contract retained');
    entry.goalAssets.directories.forEach(directory => directories.add(directory.path));
  }

  return directories;
}

function claimDirectory(root, directory, sessionId, sessionPath) {
  if (!validPath(root, directory)) throw new Error(`Goal assets are outside their shared storage: ${directory}`);

  if (exists(reclamationPath(root, directory))) throw new Error(`Goal asset deletion is pending; cannot publish a new owner: ${directory}`);
  const expected = identity(directory);
  const record = readOwners(directory);
  const owners = record.owners.filter(owner => owner.sessionId !== sessionId);
  owners.push({ sessionId, sessionPath });
  write(path.join(directory, 'owners.json'), { ...record, owners });

  return { path: directory, identity: expected };
}

function claim(root, directory, sessionId, sessionPath) {
  return locked(root, () => claimDirectory(root, directory, sessionId, sessionPath));
}

function retainHistory(root, entries, sessionId, sessionPath) {
  return locked(root, () => {
    verifyContract(root, entries[0]?.goalAssets);
    const directories = [...references(entries, root)].map(directory => claimDirectory(root, directory, sessionId, sessionPath));

    return { version: 1, policy: 'shared-profile', directories };
  });
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

function reclamationPath(root, directory) {
  const key = createHash('sha256').update(directory).digest('hex');

  return path.join(root, 'goal-asset-reclamations', `${key}.json`);
}

function beginReclamation(root, directory, expected) {
  const file = reclamationPath(root, directory);

  if (exists(file)) {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));

    if (record.path !== directory || record.identity !== expected) throw new Error(`Ambiguous goal reclamation retained: ${file}`);

    return;
  }

  if (!exists(path.dirname(file))) { fs.mkdirSync(path.dirname(file), { mode: 0o700 }); sync(root); }
  write(file, { path: directory, identity: expected });
}

function endReclamation(root, directory, expected) {
  const file = reclamationPath(root, directory);

  if (!exists(file)) return;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (record.path !== directory || record.identity !== expected) throw new Error(`Ambiguous goal reclamation retained: ${file}`);
  fs.unlinkSync(file);
  sync(path.dirname(file));
}

module.exports = { rootForDirectory, acquire, locked, exists, identity, validPath, readOwners, write, references, claim, retainHistory, verifyContract, releaseHistory, discardPreparation, beginReclamation, endReclamation };
