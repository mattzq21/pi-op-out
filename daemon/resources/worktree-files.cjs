const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const io = require('./session-transactions.cjs');
const references = require('./worktree-references.cjs');

function git(plan, args, options = {}) {
  return execFileSync('git', ['-C', plan.source, '-c', 'core.fsync=all', '-c', 'core.fsyncMethod=fsync', ...args], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options });
}

function split(buffer, separator = 0) {
  const result = [];
  let start = 0;

  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== separator) continue;
    result.push(buffer.subarray(start, index));
    start = index + 1;
  }

  if (start < buffer.length) result.push(buffer.subarray(start));

  return result;
}

function parts(name) {
  const components = split(name, 47);

  if (!name.length || name.includes(0) || components.some(part => !part.length || ['.', '..', '.git'].some(value => part.equals(Buffer.from(value))))) throw new Error('Invalid worktree file path');

  return components;
}

function join(root, name) {
  parts(name);

  return Buffer.concat([Buffer.from(root), Buffer.from('/'), name]);
}

function info(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return; throw error; }
}

function directory(root, components) {
  return components.length ? join(root, Buffer.concat(components.flatMap((part, index) => index ? [Buffer.from('/'), part] : [part]))) : Buffer.from(root);
}

function baseFiles(plan) {
  if (!plan.base) return [];

  return split(git(plan, ['ls-tree', '-rz', '--full-tree', plan.base])).map(entry => {
    const tab = entry.indexOf(9);
    const [mode, , object] = entry.subarray(0, tab).toString('ascii').split(' ');
    const name = entry.subarray(tab + 1);
    parts(name);

    return { name: name.toString('base64'), mode, object, checkout: true };
  });
}

function excluded(plan) {
  const result = new Map();

  for (const entry of split(git(plan, ['ls-files', '--stage', '-t', '-z']))) {
    const tab = entry.indexOf(9);
    const [tag, mode, object, stage] = entry.subarray(0, tab).toString('ascii').split(' ');

    if (tag !== 'S' || stage !== '0') continue;
    const name = entry.subarray(tab + 1).toString('base64');
    result.set(name, { name, mode, object, checkout: true });
  }

  return result;
}

function blob(plan, file, metadata, lock) {
  if (metadata.isSymbolicLink()) return git(plan, ['hash-object', '-w', '--stdin', '--no-filters'], { input: fs.readlinkSync(file, { encoding: 'buffer' }), stdio: ['pipe', 'pipe', 'pipe', lock] }).toString('ascii').trim();

  if (!metadata.isFile()) throw new Error('Unsupported worktree file type');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try {
    const before = fs.fstatSync(fd, { bigint: true });
    const object = git(plan, ['hash-object', '-w', '--stdin', '--no-filters'], { stdio: [fd, 'pipe', 'pipe', lock] }).toString('ascii').trim();
    const after = fs.lstatSync(file, { bigint: true });

    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) throw new Error('Worktree file changed during capture');

    return object;
  } finally { fs.closeSync(fd); }
}

function captureFile(plan, raw, files, submodules, excludedFiles, lock) {
  const name = raw.at(-1) === 47 ? raw.subarray(0, -1) : raw;
  const components = parts(name);

  for (let count = 1; count < components.length; count++) {
    const ancestor = directory(plan.source, components.slice(0, count));

    if (!info(ancestor)?.isSymbolicLink()) continue;
    captureFile(plan, ancestor.subarray(Buffer.byteLength(plan.source) + 1), files, submodules, excludedFiles, lock);

    return;
  }

  captureEntry(plan, name, files, submodules, excludedFiles, lock);
}

function captureEntry(plan, name, files, submodules, excludedFiles, lock) {
  const key = name.toString('base64');

  if (files.has(key)) return;

  const file = join(plan.source, name);
  const metadata = info(file);

  if (submodules.has(key) && metadata?.isDirectory()) {
    files.set(key, submodules.get(key));

    return;
  }

  if (!metadata) {
    if (excludedFiles.has(key)) files.set(key, excludedFiles.get(key));

    return;
  }

  if (metadata.isDirectory()) {
    files.set(key, { name: key, mode: '040000', object: null });

    return;
  }

  const mode = metadata.isSymbolicLink() ? '120000' : metadata.mode & 0o111 ? '100755' : '100644';
  files.set(key, { name: key, mode, object: blob(plan, file, metadata, lock) });
}

function tree(plan, files, lock) {
  const root = new Map();

  for (const file of files) {
    const components = parts(Buffer.from(file.name, 'base64'));
    let entries = root;

    for (const part of components.slice(0, -1)) {
      const key = part.toString('base64');

      if (!entries.has(key)) entries.set(key, { entries: new Map() });
      const parent = entries.get(key);

      if (!parent.entries) throw new Error('Worktree file conflicts with its parent');
      entries = parent.entries;
    }

    const key = components.at(-1).toString('base64');

    if (file.mode === '040000') { if (!entries.has(key)) entries.set(key, { entries: new Map() }); }
    else entries.set(key, file);
  }

  return writeTree(plan, root, lock);
}

function writeTree(plan, entries, lock) {
  const records = [];

  for (const [name, entry] of entries) {
    const object = entry.entries ? writeTree(plan, entry.entries, lock) : entry.object;
    const mode = entry.entries ? '040000' : entry.mode;
    const kind = entry.entries ? 'tree' : mode === '160000' ? 'commit' : 'blob';
    records.push(Buffer.from(`${mode} ${kind} ${object}\t`), Buffer.from(name, 'base64'), Buffer.from([0]));
  }

  return git(plan, ['mktree', '-z', '--missing'], { input: Buffer.concat(records), stdio: ['pipe', 'pipe', 'pipe', lock] }).toString('ascii').trim();
}

function capture(plan, lock) {
  const baseline = baseFiles(plan);
  let files = baseline;

  if (plan.copy) {
    const captured = new Map();
    const submodules = new Map(baseline.filter(file => file.mode === '160000').map(file => [file.name, file]));
    const excludedFiles = excluded(plan);

    for (const name of split(git(plan, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))) captureFile(plan, name, captured, submodules, excludedFiles, lock);
    files = [...captured.values()];
  }

  let symlinks = true;

  try { symlinks = git(plan, ['config', '--bool', 'core.symlinks']).toString('ascii').trim() !== 'false'; }
  catch (error) { if (error.status !== 1) throw error; }

  if (!symlinks) for (const file of files) { if (file.checkout && file.mode === '120000') { file.mode = '100644'; delete file.checkout; } }

  const object = tree(plan, files, lock);
  references.update(plan, 'content', object, lock);
  convertCheckout(plan, files, object, lock);
  const converted = tree(plan, files, lock);
  references.update(plan, 'content', converted, lock);

  return files;
}

function convertCheckout(plan, files, object, lock) {
  const scratch = path.join(plan.container, 'checkout-conversion');
  fs.rmSync(scratch, { recursive: true, force: true });
  const convertedFiles = files.filter(file => file.checkout && ['100644', '100755'].includes(file.mode));

  if (!convertedFiles.length) return;
  fs.mkdirSync(scratch, { mode: 0o700 });
  const env = { ...process.env, GIT_DIR: plan.common, GIT_WORK_TREE: scratch, GIT_INDEX_FILE: path.join(scratch, 'index'), GIT_ATTR_SOURCE: object };
  const options = { env, stdio: ['pipe', 'pipe', 'pipe', lock] };
  const context = { ...plan, source: scratch };
  git(context, ['read-tree', object], options);

  for (const file of convertedFiles) {
    const name = Buffer.from(file.name, 'base64');
    const output = git(context, ['checkout-index', '--temp', '--stdin', '-z'], { ...options, input: Buffer.concat([name, Buffer.from([0])]) });
    const tab = output.indexOf(9);
    const temporary = output.subarray(0, tab);

    if (tab < 1 || temporary.includes(47) || !output.subarray(tab + 1).equals(Buffer.concat([name, Buffer.from([0])]))) throw new Error('Invalid Git checkout result');
    const source = join(scratch, temporary);
    file.object = blob(plan, source, fs.lstatSync(source), lock);
    delete file.checkout;
    fs.unlinkSync(source);
  }

  fs.rmSync(scratch, { recursive: true });
  io.sync(plan.container);
}

function prepareParents(plan, name) {
  const components = parts(name);

  for (let count = 1; count < components.length; count++) {
    const parent = directory(plan.target, components.slice(0, count));

    if (!info(parent)) { fs.mkdirSync(parent); io.sync(directory(plan.target, components.slice(0, count - 1))); }

    if (!info(parent)?.isDirectory()) throw new Error('Worktree file parent changed');
  }

  return directory(plan.target, components.slice(0, -1));
}

function matches(plan, file, destination, lock) {
  const metadata = info(destination);
  const mode = metadata?.isSymbolicLink() ? '120000' : metadata?.isFile() ? metadata.mode & 0o111 ? '100755' : '100644' : '';

  return mode === file.mode && blob(plan, destination, metadata, lock) === file.object;
}

function write(plan, file, index, lock) {
  const name = Buffer.from(file.name, 'base64');
  const destination = join(plan.target, name);
  const parent = prepareParents(plan, name);

  if (['040000', '160000'].includes(file.mode)) {
    if (!info(destination)) { fs.mkdirSync(destination); io.sync(parent); }

    if (!info(destination)?.isDirectory()) throw new Error('Worktree directory changed');

    return;
  }

  if (info(destination)) {
    if (!matches(plan, file, destination, lock)) throw new Error('Worktree file changed; preserved');

    return;
  }

  const temporary = path.join(plan.container, `copy-${index}`);
  fs.rmSync(temporary, { force: true });
  writeBlob(plan, file, temporary, lock);
  fs.linkSync(temporary, destination);
  fs.unlinkSync(temporary);
  io.sync(parent);
  io.sync(plan.container);
}

function writeBlob(plan, file, temporary, lock) {
  if (file.mode === '120000') {
    fs.symlinkSync(git(plan, ['cat-file', 'blob', file.object]), temporary);

    return;
  }

  const mode = file.mode === '100755' ? 0o755 : 0o644;
  const fd = fs.openSync(temporary, 'wx', mode);

  try {
    fs.fchmodSync(fd, mode);
    git(plan, ['cat-file', 'blob', file.object], { stdio: ['ignore', fd, 'pipe', lock] });
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function sync(file) {
  const metadata = fs.lstatSync(file);

  if (metadata.isSymbolicLink()) return;

  if (metadata.isDirectory()) {
    for (const child of fs.readdirSync(file, { encoding: 'buffer' })) sync(Buffer.concat([Buffer.from(file), Buffer.from('/'), child]));
  }

  io.sync(file);
}

module.exports = { capture, write, sync };
