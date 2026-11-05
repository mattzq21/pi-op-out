const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const database = require('./session-database.cjs');
const { onMainThread } = require('./main-thread.cjs');
const { folderNames, ownsFolder, uuid } = require('./temporary-chat-inventory.cjs');

function directoryExists(directory) {
  try {
    const info = fs.lstatSync(directory);

    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Temporary chat path must be a directory, not a link');

    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function sync(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);

  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

// Saves which folder belongs to the temporary chat id, or returns the one it has.
const allocate = onMainThread('temporary-chat.allocate', (root, id) => {
  return database.transaction(root, 'IMMEDIATE', () => {
    let directory = database.temporaryChatFolder(root, id);

    if (directory === undefined) {
      directory = folderNames(id).map(name => path.join(root, 'tmp', name)).find(candidate => database.temporaryChatOwner(root, candidate) === undefined && !directoryExists(candidate));

      if (directory === undefined) throw new Error('Every folder name for this temporary chat is in use');
      database.insertTemporaryChatFolder(root, id, directory);
    } else if (!ownsFolder(root, id, directory)) throw new Error('Temporary chat directory does not match its saved record');

    return directory;
  });
});

function create(root, id) {
  const tmp = path.join(root, 'tmp');
  const directory = allocate(root, id);

  if (!directoryExists(tmp)) fs.mkdirSync(tmp);

  if (!directoryExists(directory)) fs.mkdirSync(directory);
  sync(tmp);
  sync(root);

  return directory;
}

function firstLine(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);

  try {
    if (!fs.fstatSync(descriptor).isFile()) return null;
    const chunks = [];
    const buffer = Buffer.alloc(4096);

    for (let total = 0; total < 65536;) {
      const size = fs.readSync(descriptor, buffer, 0, buffer.length, null);

      if (!size) return null;
      total += size;
      const newline = buffer.subarray(0, size).indexOf(10);
      chunks.push(Buffer.from(buffer.subarray(0, newline < 0 ? size : newline)));

      if (newline >= 0) return Buffer.concat(chunks).toString('utf8');
    }

    return null;
  } finally { fs.closeSync(descriptor); }
}

function deferReference(file, reason) {
  return { deferred: `Temporary folder cleanup deferred: cannot read the working folder from ${file}: ${reason}` };
}

// The saved chats and queued messages that the references come from. When they are unchanged, so are the references.
function referenceSources(root) {
  const sessions = database.temporaryChatSessionRows(root);
  const queued = database.temporaryChatQueuedTexts(root);

  return { sessions, queued, version: createHash('sha256').update(JSON.stringify([sessions, queued])).digest('hex') };
}

const unchanged = onMainThread('temporary-chat.unchanged', (root, version) => referenceSources(root).version === version);

function references(root, excluded) {
  const { version, sessions: rows, queued: texts } = referenceSources(root);
  const directories = [];

  for (const row of rows) {
    if (row.session_id === excluded) continue;

    try {
      const line = firstLine(row.session_path);

      if (line === null) return deferReference(row.session_path, 'missing, oversized, or non-regular chat header');
      const cwd = JSON.parse(line).cwd;

      if (!path.isAbsolute(cwd)) return deferReference(row.session_path, 'working folder path is not absolute');
      directories.push(path.resolve(cwd));
    } catch (error) {
      if (error.code === 'ENOENT') continue;

      return deferReference(row.session_path, error.message);
    }
  }

  const queued = texts.filter(row => row.session_id !== excluded).map(row => row.text);

  return { version, directories, queued };
}

function inUse(snapshot, directory) {
  return snapshot.directories.some(cwd => cwd === directory || cwd.startsWith(directory + path.sep))
    || snapshot.queued.some(body => body.includes(directory));
}

function removeChecked(root, directory, id) {
  const snapshot = references(root, id);

  if (snapshot.deferred) console.error(snapshot.deferred);

  if (snapshot.deferred || inUse(snapshot, directory) || !unchanged(root, snapshot.version)) return;
  remove(root, directory, id);
}

function cleanupDeleted(root) {
  if (!directoryExists(path.join(root, 'tmp'))) return;
  const candidates = database.orphanTemporaryChatAllocations(root);

  if (!candidates.length) return;
  const snapshot = references(root);

  if (snapshot.deferred) throw new Error(snapshot.deferred);
  if (!unchanged(root, snapshot.version)) throw new Error('Temporary folder cleanup deferred: session storage changed while references were checked');
  const failures = removeCandidates(root, snapshot, candidates);

  if (failures.length) throw new Error(`Temporary folder cleanup failed: ${failures.join('; ')}`);
  const pending = database.orphanTemporaryChatAllocations(root).map(row => row.original_path).filter(directory => !inUse(snapshot, directory));

  return pending.length ? { pending: true, warning: `Temporary folder cleanup deferred: ${pending.join('; ')}` } : { pending: false };
}

function removeCandidates(root, snapshot, candidates) {
  const failures = [];

  for (const candidate of candidates) {
    const directory = candidate.original_path;

    if (!ownsFolder(root, candidate.session_id, directory) || inUse(snapshot, directory)) continue;

    try { remove(root, directory, candidate.session_id); }
    catch (error) { failures.push(`${directory}: ${error.message}`); }
  }

  return failures;
}

const forgetAllocation = onMainThread('temporary-chat.forgetAllocation', (root, directory, id) => {
  database.transaction(root, 'IMMEDIATE', () => {
    database.removeTemporaryChatAllocation(root, id, directory);
    database.removeReservedSessionId(root, id);
  });
});

function remove(root, directory, id) {
  const allocated = database.temporaryChatFolder(root, id);
  const deleted = !database.temporaryChatSessionExists(root, id);

  if (directoryExists(directory)) {
    try {
      if (deleted && allocated === directory) fs.rmSync(directory, { recursive: true });
      else fs.rmdirSync(directory);
    }
    catch (error) {
      if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) return;

      if (error.code !== 'ENOENT') throw error;
    }
  }

  if (directoryExists(path.dirname(directory))) sync(path.dirname(directory));
  forgetAllocation(root, directory, id);
}

function temporaryChat(request) {
  if (!['create', 'remove'].includes(request.action)) throw new Error('Invalid temporary chat action');
  if (typeof request.root !== 'string' || !path.isAbsolute(request.root)) throw new Error('Invalid temporary chat profile directory');
  const root = path.resolve(request.root);

  if (request.action === 'create' && !uuid.test(request.id)) throw new Error('Invalid temporary chat session ID');

  if (request.action === 'remove' && (typeof request.path !== 'string' || path.dirname(request.path) !== path.join(root, 'tmp'))) throw new Error('Refusing to remove a directory outside the temporary chat root');

  if (!directoryExists(root)) {
    if (request.action === 'remove') return null;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  directoryExists(path.join(root, 'tmp'));

  if (request.action === 'create') return create(root, request.id);
  const id = database.temporaryChatOwner(root, request.path);

  if (id === undefined) return null;

  if (!ownsFolder(root, id, request.path)) throw new Error('Temporary chat directory does not match its saved record');
  removeChecked(root, request.path, id);

  return null;
}

module.exports = { temporaryChat, cleanupDeleted };
