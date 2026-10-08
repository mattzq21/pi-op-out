const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const inside = (parent, child) => path.isAbsolute(child) && path.resolve(child) === child && (child === parent || child.startsWith(parent + path.sep));

function exists(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function sync(file) {
  const descriptor = fs.openSync(file, 'r');

  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function syncTree(file) {
  const metadata = fs.lstatSync(file);

  if (metadata.isSymbolicLink()) return;

  if (metadata.isDirectory()) for (const name of fs.readdirSync(file)) syncTree(path.join(file, name));
  sync(file);
}

function mkdir(directory) {
  if (exists(directory)) {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Transaction storage is not a regular directory: ${directory}`);

    return;
  }

  mkdir(path.dirname(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  sync(path.dirname(directory));
}

function write(file, body) {
  const temporary = `${file}.${randomUUID()}.tmp`;

  const descriptor = fs.openSync(temporary, 'wx', 0o600);

  try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }

  fs.renameSync(temporary, file);
  sync(path.dirname(file));
}

function identity(file) {
  const metadata = fs.lstatSync(file, { bigint: true });

  return `${metadata.dev}:${metadata.ino}`;
}

function fingerprint(metadata) {
  return `${metadata.dev}:${metadata.ino}:${metadata.mode}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
}

function hashFile(file) {
  const descriptor = fs.openSync(file, 'r');

  const hash = createHash('sha256');

  const buffer = Buffer.alloc(1024 * 1024);

  try {
    let count;

    while ((count = fs.readSync(descriptor, buffer)) > 0) hash.update(buffer.subarray(0, count));

    return hash.digest('hex');
  } finally { fs.closeSync(descriptor); }
}

function hashEntry(file, relative, hash, excluded) {
  const before = fs.lstatSync(file, { bigint: true });

  let contents;

  if (before.isFile()) contents = hashFile(file);
  else if (before.isSymbolicLink()) contents = fs.readlinkSync(file);
  else if (!before.isDirectory()) throw new Error(`Cannot journal a special filesystem entry: ${file}`);

  hash.update(JSON.stringify([relative, String(before.mode), contents ?? null]));

  if (before.isDirectory()) for (const name of fs.readdirSync(file).sort()) {
    const child = path.join(relative, name);

    if (!excluded.includes(child)) hashEntry(path.join(file, name), child, hash, excluded);
  }

  if (fingerprint(fs.lstatSync(file, { bigint: true })) !== fingerprint(before)) throw new Error(`Files changed while preparing a transaction: ${file}`);
}

function describe(file, excluded = []) {
  const metadata = fs.lstatSync(file);

  const hash = createHash('sha256');

  hashEntry(file, '', hash, excluded);

  return { identity: identity(file), directory: metadata.isDirectory(), digest: hash.digest('hex'), excluded };
}

function matches(file, expected, contents = true) {
  const metadata = exists(file);

  if (!metadata || !expected || identity(file) !== expected.identity || metadata.isDirectory() !== expected.directory) return false;

  return !contents || describe(file, expected.excluded).digest === expected.digest;
}

function sameContents(file, expected) {
  return Boolean(exists(file)) && describe(file, expected.excluded).digest === expected.digest;
}

function move(item) {
  if (matches(item.destination, item.identity) && !exists(item.source)) return;

  if (!matches(item.source, item.identity)) throw new Error(`Transaction source changed: ${item.source}`);

  if (exists(item.destination)) {
    if (!item.identity.directory && matches(item.destination, item.identity)) {
      fs.unlinkSync(item.source);
      sync(path.dirname(item.source));

      return;
    }

    throw new Error(`Transaction destination already exists: ${item.destination}`);
  }

  if (item.identity.directory) execFileSync('mv', ['--no-clobber', '--no-copy', '--no-target-directory', '--', item.source, item.destination], { stdio: ['ignore', 'pipe', 'pipe', 3] });
  else {
    fs.linkSync(item.source, item.destination);
    sync(path.dirname(item.destination));
    fs.unlinkSync(item.source);
  }

  sync(path.dirname(item.destination));
  sync(path.dirname(item.source));

  if (!matches(item.destination, item.identity) || exists(item.source)) throw new Error(`Transaction move could not be verified: ${item.source}`);
}

function undo(item) {
  if (matches(item.source, item.identity) && !exists(item.destination)) return;

  move({ source: item.destination, destination: item.source, identity: item.identity });
}

function removalPlan(root, relative = '', entries = []) {
  const file = path.join(root, relative);
  const metadata = fs.lstatSync(file);

  if (metadata.isDirectory()) for (const name of fs.readdirSync(file)) removalPlan(root, path.join(relative, name), entries);
  entries.push({ relative, identity: metadata.isDirectory() ? { identity: identity(file), directory: true } : describe(file) });

  return entries;
}

function removalParents(root, file, entries) {
  let directory = path.dirname(file);

  while (inside(root, directory)) {
    const expected = entries.find(entry => path.join(root, entry.relative) === directory)?.identity;

    if (!expected?.directory || !matches(directory, expected, false)) throw new Error(`Cleanup parent ownership changed; retained: ${directory}`);

    if (directory === root) break;
    directory = path.dirname(directory);
  }
}

function removeOwned(root, entries) {
  for (const entry of entries) {
    const file = path.resolve(root, entry.relative);

    if (!inside(root, file) || path.relative(root, file) !== entry.relative) throw new Error('Invalid owned cleanup mapping');

    if (!exists(file)) continue;
    removalParents(root, file, entries);

    if (!matches(file, entry.identity, !entry.identity.directory)) throw new Error(`Cleanup ownership changed; retained: ${file}`);

    if (entry.identity.directory) fs.rmdirSync(file);
    else fs.unlinkSync(file);
    sync(path.dirname(file));
  }
}

function git(cwd, args, input) {
  return execFileSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'core.fsync=all', '-c', 'core.fsyncMethod=fsync', ...args], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe', 3], input,
  }).trim();
}

function refValue(cwd, ref) {
  try { return git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', ref]); }
  catch (error) { if (error.status === 1) return null; throw error; }
}

function removeRef(cwd, ref, oid) {
  const actual = refValue(cwd, ref);

  if (actual === null) return;

  if (actual !== oid) throw new Error(`Transaction ref changed; retained: ${ref}`);
  git(cwd, ['update-ref', '-d', ref, oid]);
}

function lock(root) {
  if (process.argv.at(-1) === '--transaction-locked') {
    process.argv.pop();

    return true;
  }

  mkdir(root);
  const file = path.join(root, 'session-transactions.lock');

  if (exists(file) && !fs.lstatSync(file).isFile()) throw new Error('Invalid session transaction lock');
  const descriptor = fs.openSync(file, 'a', 0o600);

  const child = spawnSync('sh', ['-c', 'flock --exclusive 3 || exit $?; exec "$@"', 'piop-transactions', process.execPath, ...process.execArgv, '--', ...process.argv.slice(1), '--transaction-locked'], { stdio: ['inherit', 'inherit', 'inherit', descriptor] });
  fs.closeSync(descriptor);

  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;

  return false;
}

function recover(root) {
  const failures = [];

  for (const replay of [require('./archive-transaction.cjs').recover, require('./delete-transaction.cjs').recover, require('./restore-transaction.cjs').recover]) {
    try { replay(root); }
    catch (error) { failures.push(error.message); }
  }

  if (failures.length) throw new Error(`Session transaction recovery is pending:\n${failures.join('\n')}`);
}

module.exports = { inside, exists, sync, syncTree, mkdir, write, identity, describe, matches, sameContents, move, undo, removalPlan, removeOwned, git, refValue, removeRef, lock, recover };
