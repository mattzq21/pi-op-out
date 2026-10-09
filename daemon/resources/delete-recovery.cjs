const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const { cleanupRegistry } = require("./deletion-retention.cjs");
const { validateRetention, recordRetention } = require("./retention-candidates.cjs");

const lockPattern = /^\.delete-[a-f0-9]{64}\.lock$/;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function exists(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

function identity(file) {
  const metadata = fs.lstatSync(file, { bigint: true });

  return `${metadata.dev}:${metadata.ino}`;
}

function sync(file) {
  const descriptor = fs.openSync(file, "r");

  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function syncTree(file) {
  const metadata = fs.lstatSync(file);

  if (metadata.isSymbolicLink()) return;

  if (metadata.isDirectory()) for (const entry of fs.readdirSync(file)) syncTree(path.join(file, entry));
  sync(file);
}

function rename(source, destination) {
  fs.renameSync(source, destination);
  sync(path.dirname(destination));
  sync(path.dirname(source));
}

function write(file, body, directory = path.dirname(file)) {
  const temporary = path.join(directory, `.recovery-${randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);

  try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }

  rename(temporary, file);
}

function git(repository, args, input) {
  return execFileSync("git", ["-C", repository.cwd, "-c", "core.fsync=all", "-c", "core.fsyncMethod=fsync", ...args], {
    encoding: "utf8", input, timeout: 120000, maxBuffer: 4 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe", 3, 4],
  }).trim();
}

function updateRefs(repository, updates) {
  if (updates.length) git(repository, ["update-ref", "--stdin"], ["start", ...updates, "prepare", "commit", ""].join("\n"));
}

function currentRefs(repository) {
  const refs = repository.refs.flatMap(ref => [ref.ref, ...(ref.reservation ? [ref.reservation] : [])]);
  const output = git(repository, ["for-each-ref", "--format=%(refname) %(objectname)", ...refs]);

  return new Map(output.split("\n").filter(Boolean).map(line => line.split(" ")));
}

function restoreRepository(repository) {
  const current = currentRefs(repository);
  const updates = [];

  for (const ref of repository.refs) {
    const oid = current.get(ref.ref);

    if (oid === undefined) updates.push(`create ${ref.ref} ${ref.oid}`);
    else if (oid !== ref.oid) throw new Error(`Refusing to overwrite a changed checkpoint: ${ref.ref}`);
  }

  updateRefs(repository, updates);
}

function releaseReservations(repository) {
  if (!repository.refs.some(ref => ref.reservation)) return;
  const current = currentRefs(repository);
  const updates = [];

  for (const { reservation, oid } of repository.refs) {
    if (!reservation || !current.has(reservation)) continue;

    if (current.get(reservation) !== oid) throw new Error(`Deletion checkpoint reservation changed: ${reservation}`);
    updates.push(`delete ${reservation} ${oid}`);
  }

  updateRefs(repository, updates);
}

function contained(root, file) {
  const relative = path.relative(root, file);

  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateFile(root, file) {
  if (!path.isAbsolute(file.path) || !contained(root, file.path) || !/^\d+\.staged$/.test(file.staged)) throw new Error("Invalid deletion recovery file");

  if (file.identity !== undefined && !/^\d+:\d+$/.test(file.identity)) throw new Error("Invalid deletion file identity");
}

function validateOwnership(root, record) {
  if (path.dirname(record.path) !== path.join(root, "conversation-ownership") || !/^[a-f0-9]{40}\.json$/.test(path.basename(record.path))) throw new Error("Invalid deletion ownership record");
  JSON.parse(record.before);
  const after = JSON.parse(record.after);

  if (after.deleted !== true || after.client !== null) throw new Error("Invalid deleted conversation ownership");
}

function validateRepository(repository) {
  if (!path.isAbsolute(repository.cwd) || !Array.isArray(repository.refs) || !repository.refs.length) throw new Error("Invalid deletion checkpoint repository");

  for (const ref of repository.refs) {
    if (!/^refs\/pi-session-snapshots\/[^\s]+$/.test(ref.ref) || !/^[a-f0-9]{40,64}$/.test(ref.oid)) throw new Error("Invalid deletion checkpoint");

    if (ref.reservation && !/^refs\/piop-deletions\/[a-f0-9-]+\/\d+\/\d+$/.test(ref.reservation)) throw new Error("Invalid deletion checkpoint reservation");
  }
}

function verifyJournalDirectory(root, directory, journal) {
  if (journal.version !== 2) return;

  if (journal.root !== root || journal.locks?.[0]?.identity !== identity(directory)) throw new Error(`Deletion recovery directory changed: ${directory}`);
}

function validateRetentionMetadata(root, journal) {
  if (journal.registryIds !== undefined && (!Array.isArray(journal.registryIds) || journal.registryIds.some(id => !uuidPattern.test(id)))) throw new Error("Invalid deleted registry sessions");

  if (journal.retention !== undefined) validateRetention(root, journal.retention);
}

function readJournal(root, directory) {
  const journal = JSON.parse(fs.readFileSync(path.join(directory, "recovery.json"), "utf8"));

  if (journal.kind === "delete") return null;

  if (journal.version !== undefined && journal.version !== 2) throw new Error("Unsupported deletion recovery journal");

  if (!Array.isArray(journal.files) || !journal.files.length || !Array.isArray(journal.repositories)) throw new Error("Invalid deletion recovery journal");
  journal.files.forEach(file => validateFile(root, file));
  journal.repositories.forEach(validateRepository);
  (journal.ownership ?? []).forEach(record => validateOwnership(root, record));

  validateRetentionMetadata(root, journal);

  verifyJournalDirectory(root, directory, journal);

  return journal;
}

function validStaged(file, staged) {
  const metadata = exists(staged);

  if (!metadata) return false;

  if (file.identity && identity(staged) !== file.identity) throw new Error(`Deletion recovery file changed: ${staged}`);

  if (!metadata.isFile() && !metadata.isDirectory()) throw new Error(`Invalid deletion recovery file: ${staged}`);

  return true;
}

function restoreFile(directory, file) {
  const staged = path.join(directory, file.staged);
  const source = exists(file.path);

  if (!validStaged(file, staged)) {
    if (!source) throw new Error(`Deleted file has no recovery copy: ${file.path}`);

    if (file.identity && identity(file.path) !== file.identity) throw new Error(`Deleted file was replaced: ${file.path}`);

    return;
  }

  if (!source) {
    if (fs.realpathSync(path.dirname(file.path)) !== path.dirname(file.path)) throw new Error(`Deleted file parent directory changed: ${file.path}`);

    if (fs.lstatSync(staged).isDirectory()) {
      rename(staged, file.path);

      return;
    }

    fs.linkSync(staged, file.path);
    sync(path.dirname(file.path));
  }

  if (identity(file.path) !== identity(staged)) throw new Error(`Refusing to overwrite a replacement created during deletion: ${file.path}`);
  fs.unlinkSync(staged);
  sync(directory);
}

function inferredLocks(journal) {
  return journal.files.flatMap(file => file.path.endsWith(".jsonl") ? [{
    path: path.join(path.dirname(file.path), `.delete-${createHash("sha256").update(file.path).digest("hex")}.lock`),
  }] : []);
}

function removeLocks(root, directory, journal) {
  for (const lock of journal.locks ?? inferredLocks(journal)) {
    if (lock.path === directory || !exists(lock.path)) continue;

    if (!contained(root, lock.path) || !lockPattern.test(path.basename(lock.path))) throw new Error("Invalid deletion recovery lock");

    if (lock.identity && identity(lock.path) !== lock.identity) throw new Error(`Deletion lock was replaced: ${lock.path}`);
    fs.rmdirSync(lock.path);
    sync(path.dirname(lock.path));
  }
}

function reconcileOwnership(directory, journal) {
  for (const record of journal.ownership ?? []) {
    const current = exists(record.path) ? fs.readFileSync(record.path, "utf8") : undefined;

    if (current && isDeepStrictEqual(JSON.parse(current), JSON.parse(record.after))) continue;

    if (current !== record.before) throw new Error(`Conversation ownership changed during deletion recovery: ${record.path}`);
    write(record.path, record.after, directory);
  }
}

function rollback(root, directory, journal) {
  for (const repository of journal.repositories) restoreRepository(repository);

  for (const file of journal.files) restoreFile(directory, file);

  for (const repository of journal.repositories) releaseReservations(repository);
  removeLocks(root, directory, journal);
  fs.rmSync(directory, { recursive: true });
  sync(path.dirname(directory));
}

function legacyDirectory(root, directory, registered) {
  const records = require('./legacy-deletion-records.cjs');

  if (path.dirname(directory) !== path.join(root, 'deleted-sessions')) throw new Error('Invalid registered legacy deletion location');

  if (!uuidPattern.test(path.basename(directory)) || registered.has(directory) || !exists(directory)) {
    records.remove(root, directory);

    return false;
  }

  if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Legacy deletion directory was replaced');

  return true;
}

function cleanupCommitted(root) {
  const registered = new Set(require('./deletion-records.cjs').list(root).flatMap(({ record }) => record ? [record.garbagePath] : []));
  const garbageRoot = path.join(root, "deleted-sessions");

  const records = require('./legacy-deletion-records.cjs');

  for (const directory of records.list(root)) {
    if (!legacyDirectory(root, directory, registered)) continue;

    if (!exists(path.join(directory, "recovery.json"))) {
      fs.rmSync(directory, { recursive: true }); sync(garbageRoot);
      records.remove(root, directory);

      continue;
    }

    const journal = readJournal(root, directory);

    if (!journal) { records.remove(root, directory); continue; }

    sync(garbageRoot);

    for (const lock of journal.locks ?? inferredLocks(journal)) sync(path.dirname(lock.path));
    reconcileOwnership(directory, journal);
    cleanupCommittedRetention(root, journal);
    removeLocks(root, directory, journal);

    for (const repository of journal.repositories) releaseReservations(repository);
    fs.rmSync(directory, { recursive: true });
    sync(garbageRoot);
    records.remove(root, directory);
  }
}

function cleanupCommittedRetention(root, journal) {
  if (journal.retention) recordRetention(root, journal.id, journal.retention);
  cleanupRegistry(root, journal.registryIds ?? []);
}

function removeUnstarted(directory) {
  const entries = fs.readdirSync(directory);

  if (entries.some(name => !/^\.recovery-[a-f0-9-]+\.tmp$/.test(name))) throw new Error(`Deletion recovery journal is missing: ${directory}`);
  fs.rmSync(directory, { recursive: true });
  sync(path.dirname(directory));
}

function recover(root) {
  if (!exists(root)) return;
  root = fs.realpathSync(root);
  cleanupCommitted(root);
  const records = require('./legacy-deletion-locks.cjs');
  const locks = records.list(root);

  for (const directory of locks) {
    if (exists(path.join(directory, "recovery.json"))) rollback(root, directory, readJournal(root, directory));
  }

  for (const directory of locks) if (exists(directory)) removeUnstarted(directory);
  records.list(root);
}

module.exports = { recover, cleanupCommitted, sync, syncTree };
