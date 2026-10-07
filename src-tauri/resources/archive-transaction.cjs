const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { execFileSync } = require('node:child_process');
const { pruneReceipts } = require('./deletion-retention.cjs');
const { recoverLegacy } = require('./archive-legacy-recovery.cjs');

function exists(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function identity(file) {
  const stat = fs.lstatSync(file, { bigint: true });

  return `${stat.dev}:${stat.ino}`;
}

function matches(file, expected) { return Boolean(exists(file)) && identity(file) === expected; }

function sync(file) {
  const descriptor = fs.openSync(file, 'r');

  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function syncTree(file) {
  const stat = fs.lstatSync(file);

  if (stat.isSymbolicLink()) return;

  if (stat.isDirectory()) for (const name of fs.readdirSync(file)) syncTree(path.join(file, name));
  sync(file);
}

function rename(source, destination) {
  fs.renameSync(source, destination);
  sync(path.dirname(destination));
  sync(path.dirname(source));
}

function write(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);

  try { fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }

  rename(temporary, file);
}

function git(common, args, options = {}) {
  return execFileSync('git', ['-C', common, '-c', 'core.fsmonitor=false', '-c', 'core.fsync=all', '-c', 'core.fsyncMethod=fsync', ...args], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe', 3, 4], ...options,
  }).trim();
}

function move(source, destination) {
  if (exists(destination)) throw new Error(`Archive destination already exists: ${destination}`);

  return { source, destination, identity: identity(source) };
}

function performMove(item) {
  if (!matches(item.source, item.identity) || exists(item.destination)) throw new Error(`Archive files changed: ${item.source}`);
  rename(item.source, item.destination);
}

function undoMove(item) {
  if (matches(item.source, item.identity) && !exists(item.destination)) return;

  if (exists(item.source) || !matches(item.destination, item.identity)) throw new Error(`Cannot safely roll back archive: ${item.source}`);
  rename(item.destination, item.source);
}

function reference(common, ref) {
  try { return git(common, ['rev-parse', '--verify', ref]); }
  catch (error) { if (error.status === 128) return undefined; throw error; }
}

function createReferences(references) {
  for (const { common, ref, commit } of references) git(common, ['update-ref', ref, commit, '0'.repeat(commit.length)]);
}

function releaseReferences(references) {
  for (const { common, ref, commit } of references) {
    const current = reference(common, ref);

    if (!current) continue;

    if (current !== commit) throw new Error(`Archive recovery reference changed: ${ref}`);
    git(common, ['update-ref', '-d', ref, commit]);
  }
}

function assertReferences(references) {
  for (const { common, ref, commit } of references) {
    if (reference(common, ref) !== commit) throw new Error(`Archive recovery reference is missing or changed: ${ref}`);
  }
}

function worktree(group) {
  return {
    ...move(group.path, group.storedPath), common: group.common,
    registration: group.own, registrationIdentity: identity(group.own),
    branchRef: group.branchRef, head: group.head,
  };
}

function assertRegistration(item, directory) {
  if (!matches(item.registration, item.registrationIdentity)) throw new Error(`Archive worktree registration changed: ${item.registration}`);
  const pointer = path.join(directory, '.git');
  const content = fs.readFileSync(pointer, 'utf8').trim();

  if (!content.startsWith('gitdir: ') || path.resolve(directory, content.slice(8)) !== item.registration) throw new Error(`Archive worktree changed: ${directory}`);
}

function moveWorktree(item) {
  if (!matches(item.source, item.identity) || exists(item.destination)) throw new Error(`Archive worktree changed: ${item.source}`);
  assertRegistration(item, item.source);
  git(item.common, ['worktree', 'move', '--force', '--force', item.source, item.destination]);
  syncTree(item.registration);
  sync(path.dirname(item.destination));
  sync(path.dirname(item.source));
}

function undoWorktree(item) {
  if (matches(item.source, item.identity) && !exists(item.destination)) {
    assertRegistration(item, item.source);
  } else {
    if (exists(item.source) || !matches(item.destination, item.identity)) throw new Error(`Cannot safely roll back archived worktree: ${item.source}`);
    assertRegistration(item, item.destination);
    rename(item.destination, item.source);
  }

  git(item.common, ['worktree', 'repair', item.source]);
  syncTree(item.registration);
}

function assertRetiredRegistration(item) {
  if (!exists(item.registration)) return;

  if (!matches(item.registration, item.registrationIdentity)) throw new Error(`Archived worktree registration was replaced: ${item.registration}`);
  const pointer = path.join(item.registration, 'gitdir');

  if (exists(pointer) && fs.readFileSync(pointer, 'utf8').trim() !== path.join(item.destination, '.git')) throw new Error(`Archived worktree registration moved: ${item.registration}`);
}

function removeRetiredWorktree(item) {
  assertRetiredRegistration(item);

  if (exists(item.destination)) {
    if (!matches(item.destination, item.identity)) throw new Error(`Archived worktree was replaced: ${item.destination}`);

    if (exists(path.join(item.destination, '.git'))) assertRegistration(item, item.destination);
    fs.rmSync(item.destination, { recursive: true });
    sync(path.dirname(item.destination));
  }

  if (exists(item.registration)) { fs.rmSync(item.registration, { recursive: true }); sync(path.dirname(item.registration)); }

  if (!item.branchRef || reference(item.common, item.branchRef) !== item.head) return;
  const active = git(item.common, ['worktree', 'list', '--porcelain', '-z']).split('\0');

  if (!active.includes(`branch ${item.branchRef}`)) git(item.common, ['update-ref', '-d', item.branchRef, item.head]);
}

function sessionMoves(record) {
  const sidecars = [
    [record.file.replace(/\.jsonl$/, '.snapshots'), record.destination.replace(/\.jsonl$/, '.snapshots')],
    [record.file.replace(/\.jsonl$/, '.diffs.json'), record.destination.replace(/\.jsonl$/, '.diffs.json')],
    [`${record.file}.loop-detection.json`, `${record.destination}.loop-detection.json`],
  ].flatMap(([source, destination]) => exists(source) ? [move(source, destination)] : []);

  return [...sidecars, move(record.file, record.backup), move(record.prepared, record.destination)];
}

function ownership(root, record) {
  const key = createHash('sha256').update(record.header.id.toLowerCase()).digest('hex').slice(0, 40);
  const file = path.join(root, 'conversation-ownership', `${key}.json`);

  if (!exists(file)) return [];
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));

  return [{ path: file, before, after: { ...before, deleted: true, client: null } }];
}

function transactionPlan(root, groups, records, removable) {
  return {
    version: 2,
    snapshots: groups.flatMap(group => group.kind === 'directory' ? [move(group.preparedDirectory, group.storedPath)] : []),
    directories: removable.flatMap(group => group.kind === 'directory' ? [move(group.path, group.retiredPath)] : []),
    worktrees: removable.flatMap(group => group.kind === 'git' ? [worktree(group)] : []),
    moves: records.flatMap(sessionMoves),
    ownerships: records.flatMap(record => ownership(root, record)),
    references: groups.flatMap(group => (group.refs ?? []).map(ref => ({ common: group.common, ref, commit: group.commit }))),
    previousDirectories: [...new Set(records.flatMap(record => record.previousDirectory ? [record.previousDirectory] : []))],
  };
}

function referencedDirectories(directory, previous) {
  if (!exists(directory)) return;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory()) referencedDirectories(file, previous);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const header = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
      previous.delete(header.worktreeRestore?.storedPath);
    }
  }
}

function cleanupPreviousDirectories(root, directories) {
  const previous = new Set(directories);

  if (!previous.size) return;
  referencedDirectories(path.join(root, 'sessions'), previous);
  referencedDirectories(path.join(root, 'archived'), previous);
  const storage = fs.realpathSync(path.join(root, 'archived-tmp'));

  for (const directory of previous) {
    if (!exists(directory)) continue;
    const canonical = fs.realpathSync(directory);

    if (path.dirname(canonical) !== storage) throw new Error(`Invalid previous archived directory: ${directory}`);
    fs.rmSync(canonical, { recursive: true });
    sync(storage);
  }
}

function cleanup(directory) {
  for (const name of fs.readdirSync(directory)) {
    if (name !== 'recovery.json') fs.rmSync(path.join(directory, name), { recursive: true });
  }

  sync(directory);
  const journal = path.join(directory, 'recovery.json');

  if (exists(journal)) { fs.unlinkSync(journal); sync(directory); }

  fs.rmdirSync(directory);
  sync(path.dirname(directory));
}

function prepare(directory) {
  write(path.join(directory, 'recovery.json'), { version: 2, preparing: true });
  sync(path.dirname(directory));
}

function rollback(transaction) {
  for (const item of [...transaction.moves].reverse()) undoMove(item);

  for (const item of [...transaction.worktrees].reverse()) undoWorktree(item);

  for (const item of [...transaction.directories].reverse()) undoMove(item);

  for (const item of [...transaction.snapshots].reverse()) undoMove(item);
  releaseReferences(transaction.references);
}

function finishCommit(root, transaction, directory) {
  sync(path.join(directory, 'recovery.json'));
  sync(directory);
  sync(root);
  assertReferences(transaction.references);

  for (const owner of transaction.ownerships) {
    const current = JSON.parse(fs.readFileSync(owner.path, 'utf8'));

    if (!isDeepStrictEqual(current, owner.before) && !isDeepStrictEqual(current, owner.after)) throw new Error(`Archived conversation ownership changed: ${owner.path}`);
    write(owner.path, owner.after);
  }

  for (const item of transaction.worktrees) removeRetiredWorktree(item);

  for (const item of transaction.directories) {
    if (!exists(item.destination)) continue;

    if (!matches(item.destination, item.identity)) throw new Error(`Archived directory was replaced: ${item.destination}`);
    fs.rmSync(item.destination, { recursive: true });
    sync(path.dirname(item.destination));
  }

  cleanupPreviousDirectories(root, transaction.previousDirectories);
  pruneReceipts(root);
  cleanup(directory);
}

function publish(transaction) {
  createReferences(transaction.references);

  for (const item of transaction.snapshots) performMove(item);

  for (const item of transaction.directories) performMove(item);

  for (const item of transaction.worktrees) moveWorktree(item);

  for (const item of transaction.moves) performMove(item);
}

function archiveGroup(root, directory, groups, records, removable) {
  const transaction = transactionPlan(root, groups, records, removable);
  const journal = path.join(directory, 'recovery.json');
  syncTree(directory);

  for (const item of [...transaction.moves, ...transaction.directories, ...transaction.worktrees]) syncTree(item.source);
  write(journal, transaction);
  sync(root);

  try {
    publish(transaction);
    write(journal, { ...transaction, committed: true });
  } catch (error) {
    const saved = JSON.parse(fs.readFileSync(journal, 'utf8'));

    if (!saved.committed) {
      try { rollback(saved); write(journal, { ...saved, rolledBack: true }); cleanup(directory); }
      catch (failure) { throw new Error(`${error.message}\nArchive recovery is pending at ${directory}: ${failure.message}`); }

      throw error;
    }
  }

  try { finishCommit(root, transaction, directory); }
  catch (error) { console.error(`Archive committed; cleanup will retry from ${directory}: ${error.message}`); }
}

function recoverDirectory(root, directory) {
  const journal = path.join(directory, 'recovery.json');

  if (!exists(journal)) {
    const unstarted = fs.readdirSync(directory).every(name => /^recovery\.json\.[a-f0-9-]{36}\.tmp$/.test(name));

    if (!unstarted) throw new Error(`Archive recovery data has no journal and needs inspection: ${directory}`);
    cleanup(directory);

    return;
  }

  const transaction = JSON.parse(fs.readFileSync(journal, 'utf8'));

  if (transaction.version === undefined) return recoverLegacy(root, directory, transaction);

  if (transaction.version !== 2) throw new Error(`Unsupported archive transaction: ${journal}`);

  if (transaction.preparing || transaction.rolledBack) return cleanup(directory);

  if (transaction.committed) finishCommit(root, transaction, directory);
  else { rollback(transaction); write(journal, { ...transaction, rolledBack: true }); cleanup(directory); }
}

function recover(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('archive-transaction-')) recoverDirectory(root, path.join(root, entry.name));
  }
}

module.exports = { archiveGroup, cleanup, prepare, recover };
