'use strict';

// Loaded before user code, including ESM, through a NODE_OPTIONS preload.
const fs = require('node:fs');
const promises = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');
const raw = Object.fromEntries([
  'lstatSync', 'openSync', 'fstatSync', 'readSync', 'closeSync', 'mkdirSync',
  'writeFileSync', 'renameSync', 'rmdirSync', 'statSync', 'readlinkSync', 'opendirSync',
].map(name => [name, fs[name]]));
const realpath = fs.realpathSync.native;
const root = process.env.PIOP_DIFF_JOURNAL;
// Background descendants may outlive the command's journal.
if (!root || !path.isAbsolute(root) || !fs.existsSync(root)) return;
const lock = path.join(root, 'lock');
const lockWait = new Int32Array(new SharedArrayBuffer(4));
const statePath = path.join(root, 'state.json');
const maxFile = 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const descriptors = new Map();
const attempted = new Set();
const handlePrototypes = new WeakSet();
let active = false;

function observe(action) {
  if (active) return;
  active = true;
  try { return action(); } catch { unavailable(); }
  finally { active = false; }
}

function nativePath(value) {
  if (value instanceof URL) return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return decoder.decode(value);
  if (typeof value === 'string' && value.length) return value;
  throw new TypeError('not a filesystem path');
}

function canonical(value, follow = true, depth = 0) {
  if (depth > 40) throw new Error('symlink chain is too long');
  const name = nativePath(value);
  // Resolve symlinks before interpreting .., without path.resolve normalizing it first.
  if (follow) {
    try { return realpath(name); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A write through a dangling symlink creates its target, not the link.
      const target = danglingTarget(name, depth);
      if (target !== undefined) return target;
    }
  }
  const parent = path.dirname(name);
  if (parent === name) return realpath(name);
  // Recursive copies can create several missing ancestors. Resolve the nearest
  // existing ancestor (including its symlinks) before appending missing names.
  return path.join(canonical(parent, true, depth), path.basename(name));
}

function danglingTarget(name, depth) {
  try {
    if (raw.lstatSync(name).isSymbolicLink()) {
      const target = raw.readlinkSync(name);
      return canonical(path.isAbsolute(target) ? target : path.dirname(name) + path.sep + target, true, depth + 1);
    }
  } catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
}

function readBytes(name, limit) {
  const metadata = raw.lstatSync(name);
  if (!metadata.isFile() || metadata.size > limit) throw new Error('not a small regular file');
  const fd = raw.openSync(name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    | (fs.constants.O_NONBLOCK || 0));
  try {
    if (!raw.fstatSync(fd).isFile()) throw new Error('not a regular file');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = raw.readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > limit) throw new Error('oversized file');
    return bytes.subarray(0, length);
  } finally { raw.closeSync(fd); }
}

function skippedPath(name) {
  return path.join(root, `skipped-${createHash('sha256').update(name).digest('hex')}`);
}

function unavailable(name) {
  // These markers do not need the shared lock and invalidate late baselines.
  const markers = [path.join(root, 'incomplete')];
  if (name !== undefined) markers.push(skippedPath(name));
  for (const marker of markers) {
    try { raw.writeFileSync(marker, '', { flag: 'wx', mode: 0o600 }); } catch { /* Already marked or the journal has expired. */ }
  }
}

function acquireLock(name) {
  const deadline = Date.now() + 100;
  for (; ;) {
    try { raw.mkdirSync(lock); return true; }
    catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) { unavailable(name); return false; }
      // The original filesystem operation has not run yet.
      Atomics.wait(lockWait, 0, 0, 2);
    }
  }
}

function snapshotState() {
  try { return JSON.parse(decoder.decode(readBytes(statePath, 256 * 1024))); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { paths: [], bytes: 0 };
  }
}

function snapshotContent(name) {
  let content = null;
  let skip = false;
  try {
    const bytes = readBytes(name, maxFile);
    if (bytes.includes(0)) skip = true;
    else content = decoder.decode(bytes);
  } catch (error) { skip = error.code !== 'ENOENT'; }
  return { content, skip };
}

function canSnapshot(name) {
  if (name === root || name.startsWith(root + path.sep)) return false;
  // Never capture a later, already-truncated state after the first attempt failed.
  if (attempted.has(name)) return false;
  if (attempted.size >= 32) { unavailable(name); return false; }
  return true;
}

function snapshot(name) {
  if (!canSnapshot(name)) return;
  attempted.add(name);
  if (!acquireLock(name)) return;
  try {
    if (fs.existsSync(skippedPath(name))) return;
    const state = snapshotState();
    if (state.paths.includes(name)) return;
    if (state.paths.length >= 32) { unavailable(name); return; }
    const { content, skip } = snapshotContent(name);
    const record = Buffer.from(JSON.stringify({ path: name, content, skip, capturedAt: Date.now() }));
    if (state.bytes + record.length > 8 * maxFile) { unavailable(name); return; }
    const temporary = path.join(root, 'pending.json');
    raw.writeFileSync(temporary, record, { flag: 'wx', mode: 0o600 });
    raw.renameSync(temporary, path.join(root, `${state.paths.length}.json`));
    state.paths.push(name);
    state.bytes += record.length;
    raw.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    raw.renameSync(temporary, statePath);
  } catch { unavailable(name); }
  finally { raw.rmdirSync(lock); }
}

function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function descriptorPath(fd) {
  const metadata = raw.fstatSync(fd, { bigint: true });
  if (!metadata.isFile()) return;
  // Linux also exposes inherited descriptors, and follows renames of open files.
  if (process.platform === 'linux') {
    try {
      const name = raw.readlinkSync(`/proc/self/fd/${fd}`);
      const current = raw.statSync(name, { bigint: true });
      if (sameFile(current, metadata)) return canonical(name);
    } catch { /* Use the open-time identity when procfs is unavailable. */ }
  }
  const entry = descriptors.get(fd);
  if (entry && sameFile(entry, metadata)) {
    const current = raw.statSync(entry.path, { bigint: true });
    if (sameFile(current, metadata)) return entry.path;
  }
  descriptors.delete(fd);
}

function before(value, follow = true) {
  observe(() => {
    const fd = typeof value === 'number' ? value : value?.fd;
    const name = Number.isInteger(fd) ? descriptorPath(fd) : canonical(value, follow);
    if (name) snapshot(name);
  });
}

function remember(fd, value) {
  observe(() => {
    const metadata = raw.fstatSync(fd, { bigint: true });
    if (!metadata.isFile()) return;
    const name = canonical(value);
    const current = raw.statSync(name, { bigint: true });
    if (current.dev !== metadata.dev || current.ino !== metadata.ino) return;
    if (descriptors.size >= 1024) descriptors.delete(descriptors.keys().next().value);
    descriptors.set(fd, { path: name, dev: metadata.dev, ino: metadata.ino });
  });
}

function writable(flags) {
  return typeof flags === 'number'
    ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC))
    : typeof flags === 'string' && /[wa+]/.test(flags);
}

function wrap(object, name, beforeCall) {
  const original = object[name];
  if (typeof original !== 'function') return;
  const wrapper = function(...args) {
    try { beforeCall.call(this, args); } catch { /* Keep the original call authoritative. */ }
    return Reflect.apply(original, this, args);
  };
  // Preserve Node's callback promisification metadata, such as write's named results.
  for (const symbol of Object.getOwnPropertySymbols(original)) {
    Object.defineProperty(wrapper, symbol, Object.getOwnPropertyDescriptor(original, symbol));
  }
  object[name] = wrapper;
}

function instrumentHandle(handle) {
  observe(() => {
    const prototype = Object.getPrototypeOf(handle);
    if (handlePrototypes.has(prototype)) return;
    handlePrototypes.add(prototype);
    for (const name of ['write', 'writev', 'writeFile', 'appendFile', 'truncate', 'createWriteStream']) {
      wrap(prototype, name, function() { before(this.fd); });
    }
  });
  const fd = handle.fd;
  const entry = descriptors.get(fd);
  handle.once('close', () => {
    if (descriptors.get(fd) === entry) descriptors.delete(fd);
  });
  return handle;
}

const openSync = fs.openSync;
fs.openSync = function(...args) {
  if (writable(args[1])) before(args[0]);
  const fd = Reflect.apply(openSync, this, args);
  remember(fd, args[0]);
  return fd;
};
const open = fs.open;
fs.open = function(...args) {
  if (writable(args[1])) before(args[0]);
  const callback = args.at(-1);
  if (typeof callback === 'function') {
    args[args.length - 1] = function(error, fd) {
      if (!error) remember(fd, args[0]);
      return Reflect.apply(callback, this, arguments);
    };
  }
  return Reflect.apply(open, this, args);
};
const promiseOpen = promises.open;
promises.open = function(...args) {
  if (writable(args[1])) before(args[0]);
  return Reflect.apply(promiseOpen, this, args).then(handle => {
    remember(handle.fd, args[0]);
    return instrumentHandle(handle);
  });
};

const closeSync = fs.closeSync;
fs.closeSync = function(fd) {
  const result = Reflect.apply(closeSync, this, arguments);
  descriptors.delete(fd);
  return result;
};
const close = fs.close;
fs.close = function(...args) {
  const callback = args.at(-1);
  const entry = descriptors.get(args[0]);
  if (typeof callback === 'function') {
    args[args.length - 1] = function(error) {
      if (!error && descriptors.get(args[0]) === entry) descriptors.delete(args[0]);
      return Reflect.apply(callback, this, arguments);
    };
  }
  return Reflect.apply(close, this, args);
};

function enqueueDirectory(input, output, pending, entries, deadline) {
  const directory = raw.opendirSync(input, { encoding: 'buffer' });
  try {
    let child;
    for (; ;) {
      if (pending.length + entries >= 4096 || Date.now() >= deadline) { unavailable(); break; }
      child = directory.readSync();
      if (child === null) break;
      const name = nativePath(child.name);
      pending.push([path.join(input, name), path.join(output, name)]);
    }
  } finally { directory.closeSync(); }
}

function beforeTree(source, destination, moving = false) {
  observe(() => {
    const from = canonical(source, false);
    const to = destination === undefined ? from : canonical(destination, false);
    const pending = [[from, to]];
    const deadline = Date.now() + 2000;
    let entries = 0;
    while (pending.length) {
      if (entries >= 4096 || Date.now() >= deadline) { unavailable(); break; }
      entries++;
      const [input, output] = pending.pop();
      const metadata = raw.lstatSync(input);
      if (metadata.isDirectory()) {
        enqueueDirectory(input, output, pending, entries, deadline);
      } else if (metadata.isFile()) {
        if (moving) snapshot(input);
        snapshot(output);
      }
    }
  });
}

for (const object of [fs, promises]) {
  for (const name of ['writeFile', 'appendFile', 'truncate', 'write', 'writev', 'ftruncate']) {
    for (const suffix of ['', 'Sync']) wrap(object, name + suffix, args => before(args[0]));
  }
  for (const name of ['copyFile', 'link']) {
    for (const suffix of ['', 'Sync']) wrap(object, name + suffix, args => before(args[1]));
  }
  for (const suffix of ['', 'Sync']) {
    wrap(object, 'unlink' + suffix, args => before(args[0], false));
    wrap(object, 'rename' + suffix, args => beforeTree(args[0], args[1], true));
    wrap(object, 'rm' + suffix, args => beforeTree(args[0]));
    wrap(object, 'cp' + suffix, args => beforeTree(args[0], args[1]));
  }
}

function beforeStream(args) {
  const options = args[1];
  if (options?.fs) return; // A custom filesystem need not refer to local files.
  if (options?.fd != null) before(options.fd);
  else if (writable(options?.flags ?? 'w')) before(args[0]);
}
wrap(fs, 'createWriteStream', beforeStream);
fs.WriteStream = new Proxy(fs.WriteStream, {
  construct(target, args, newTarget) {
    try { beforeStream(args); } catch { /* Preserve native constructor errors. */ }
    return Reflect.construct(target, args, newTarget);
  },
  apply(target, receiver, args) {
    try { beforeStream(args); } catch { /* Preserve native constructor errors. */ }
    return Reflect.apply(target, receiver, args);
  },
});
fs.FileWriteStream = fs.WriteStream;
syncBuiltinESMExports();
