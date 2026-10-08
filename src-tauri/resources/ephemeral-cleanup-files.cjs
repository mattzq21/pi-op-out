const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

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

function write(file, value) {
  directory(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);

  try { fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }

  fs.renameSync(temporary, file);
  sync(path.dirname(file));
}

function read(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try { return JSON.parse(fs.readFileSync(descriptor, 'utf8')); }
  finally { fs.closeSync(descriptor); }
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

function hashEntry(file, relative, hash) {
  const before = fingerprint(file);
  const metadata = fs.lstatSync(file);

  if (metadata.isSymbolicLink() || !metadata.isDirectory() && !metadata.isFile()) throw new Error(`Unsafe cleanup entry retained: ${file}`);
  hash.update(JSON.stringify([relative, metadata.mode, metadata.isFile() ? hashFile(file) : null]));

  if (metadata.isDirectory()) for (const name of fs.readdirSync(file).sort()) hashEntry(path.join(file, name), path.join(relative, name), hash);

  if (fingerprint(file) !== before) throw new Error(`Cleanup contents changed while being recorded: ${file}`);
}

function describe(file) {
  const hash = createHash('sha256');

  hashEntry(file, '', hash);

  return { path: file, identity: identity(file), directory: fs.lstatSync(file).isDirectory(), digest: hash.digest('hex') };
}

function verify(item) {
  if (!exists(item.path)) return;
  const actual = describe(item.path);

  if (actual.identity !== item.identity || actual.directory !== item.directory || actual.digest !== item.digest) throw new Error(`Cleanup artifact identity changed; retained: ${item.path}`);
}

function remove(item) {
  if (!exists(item.path)) return;
  verify(item);
  fs.rmSync(item.path, { recursive: item.directory, force: false });
  sync(path.dirname(item.path));
}

module.exports = { exists, sync, directory, write, read, identity, describe, verify, remove };
