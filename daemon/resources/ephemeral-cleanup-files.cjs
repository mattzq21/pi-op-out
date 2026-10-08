const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function exists(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function sync(file) {
  const descriptor = fs.openSync(file, 'r');

  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function directory(file) {
  const metadata = exists(file);

  if (metadata) {
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Cleanup storage is not a regular directory: ${file}`);

    return;
  }

  directory(path.dirname(file));
  fs.mkdirSync(file, { mode: 0o700 });
  sync(path.dirname(file));
}

function identity(file) {
  const metadata = fs.lstatSync(file, { bigint: true });

  return `${metadata.dev}:${metadata.ino}`;
}

function fingerprint(file) {
  const metadata = fs.lstatSync(file, { bigint: true });

  return `${metadata.dev}:${metadata.ino}:${metadata.mode}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
}

function hashFile(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);

  try {
    let count;

    while ((count = fs.readSync(descriptor, buffer)) > 0) hash.update(buffer.subarray(0, count));

    return hash.digest('hex');
  } finally { fs.closeSync(descriptor); }
}

function nodeDigest(mode, content) { return createHash('sha256').update(JSON.stringify([mode, content])).digest('hex'); }

function hashEntry(file, relative, hash, entries) {
  const before = fingerprint(file);
  const metadata = fs.lstatSync(file);

  if (metadata.isSymbolicLink() || !metadata.isDirectory() && !metadata.isFile()) throw new Error(`Unsafe cleanup entry retained: ${file}`);
  const content = metadata.isFile() ? hashFile(file) : null;

  hash.update(JSON.stringify([relative, metadata.mode, content]));
  entries.push({ relative, identity: identity(file), directory: metadata.isDirectory(), digest: nodeDigest(metadata.mode, content) });

  if (metadata.isDirectory()) for (const name of fs.readdirSync(file).sort()) hashEntry(path.join(file, name), path.join(relative, name), hash, entries);

  if (fingerprint(file) !== before) throw new Error(`Cleanup contents changed while being recorded: ${file}`);
}

function describe(file) {
  const hash = createHash('sha256');
  const entries = [];

  hashEntry(file, '', hash, entries);

  return { path: file, identity: identity(file), directory: fs.lstatSync(file).isDirectory(), digest: hash.digest('hex'), entries };
}

function treePath(root, relative) {
  const file = path.resolve(root, relative);

  if (path.relative(root, file) !== relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('Cleanup manifest contains an unowned snapshot entry; retained');

  return file;
}

function treePaths(item) {
  const root = item.entries[0];

  if (!root || root.relative !== '' || root.identity !== item.identity || !root.directory) throw new Error('Cleanup snapshot root identity is unavailable; retained');

  return new Set(item.entries.map(entry => treePath(item.path, entry.relative)));
}

function verifyNodeIdentity(file, entry, metadata) {
  if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile()) || metadata.isDirectory() !== entry.directory || identity(file) !== entry.identity) throw new Error(`Cleanup snapshot identity changed; retained: ${file}`);
}

function verifyNode(file, entry, known) {
  const metadata = exists(file);

  if (!metadata) return;

  verifyNodeIdentity(file, entry, metadata);
  const content = metadata.isFile() ? hashFile(file) : null;

  if (nodeDigest(metadata.mode, content) !== entry.digest) throw new Error(`Cleanup snapshot contents changed; retained: ${file}`);

  if (metadata.isDirectory()) for (const name of fs.readdirSync(file)) {
    if (!known.has(path.join(file, name))) throw new Error(`New cleanup snapshot entry appeared; retained: ${path.join(file, name)}`);
  }
}

function verifyTree(item) {
  const known = treePaths(item);

  for (const entry of item.entries) verifyNode(treePath(item.path, entry.relative), entry, known);
}

function removeTree(item) {
  const known = treePaths(item);

  for (const entry of [...item.entries].reverse()) {
    const file = treePath(item.path, entry.relative);

    if (!exists(file)) continue;
    verifyNode(file, entry, known);

    if (entry.directory) fs.rmdirSync(file);
    else fs.unlinkSync(file);
    sync(path.dirname(file));
  }
}

function verify(item) {
  if (!exists(item.path)) return;

  if (item.directory && item.entries !== undefined) {
    verifyTree(item);

    return;
  }

  const actual = describe(item.path);

  if (actual.identity !== item.identity || actual.directory !== item.directory || actual.digest !== item.digest) throw new Error(`Cleanup artifact identity changed; retained: ${item.path}`);
}

function remove(item) {
  if (!exists(item.path)) return;
  verify(item);

  if (item.directory && item.entries !== undefined) {
    removeTree(item);

    return;
  }

  fs.rmSync(item.path, { recursive: item.directory, force: false });
  sync(path.dirname(item.path));
}

module.exports = { exists, sync, directory, identity, describe, verify, remove };
