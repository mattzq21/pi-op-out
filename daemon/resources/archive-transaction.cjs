const fs = require('node:fs');
const checkpointIndex = require('./session-broker/checkpoint-owner-index.cjs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const io = require('./session-transactions.cjs');
const { isDeepStrictEqual } = require('node:util');
const { canonicalTranscriptBasename } = require('./transcript-identity.cjs');
const shared = require('./archive-resource-transactions.cjs');
const checkpoints = require('./archive-checkpoints.cjs');

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function save(transaction) {
  io.write(path.join(transaction.container, 'recovery.json'), JSON.stringify(transaction));
}

function sidecars(file, destination) {
  return sidecarPaths(file, destination).flatMap(([source, target]) => io.exists(source) ? [{ source, destination: target, identity: io.describe(source) }] : []);
}

function archiveDestinations(root, records) {
  const selected = new Set();

  return records.map(record => {
    const destination = path.join(root, 'archived', canonicalTranscriptBasename(record.header));

    if (selected.has(destination)) throw new Error(`Duplicate archive transcript mapping: ${destination}`);
    selected.add(destination);

    for (const target of [destination, ...sidecarPaths(record.file, destination).map(([, target]) => target)]) {
      if (io.exists(target)) throw new Error(`Archive destination already exists: ${target}`);
    }

    return destination;
  });
}

function archiveOwnership(root, id) {
  const key = createHash('sha256').update(id.toLowerCase()).digest('hex').slice(0, 40);
  const file = path.join(root, 'conversation-ownership', key + '.json');

  if (!io.exists(file)) return [];
  const before = fs.readFileSync(file, 'utf8');
  const record = JSON.parse(before);

  return [{ sessionId: id, file, before, after: JSON.stringify({ ...record, deleted: true, client: null }) }];
}

function finishOwnership(transaction) {
  for (const owner of transaction.ownerships ?? []) {
    const current = fs.readFileSync(owner.file, 'utf8');

    if (current !== owner.before && current !== owner.after) throw new Error('Archived conversation ownership changed');
    io.write(owner.file, owner.after);
  }
}

function plan(root, groups, records) {
  const destinations = archiveDestinations(root, records);
  const id = randomUUID();

  const container = path.join(root, 'archive-transactions', id);

  io.mkdir(container);

  const plannedRecords = records.map((record, index) => {
    const destination = destinations[index];

    return {
      file: record.file, sessionId: record.header.id, group: groups.findIndex(group => group.records.includes(record)),
      original: io.describe(record.file), mode: fs.statSync(record.file).mode & 0o777, destination,
      backup: path.join(container, `${index}.original`), prepared: path.join(container, `${index}.prepared`),
      rollbackCopy: path.join(container, `${index}.rollback`), moves: sidecars(record.file, destination),
    };
  });

  const plannedGroups = groups.map((group, index) => {
    const { records: owners, ...location } = group;

    return {
      ...location, storedPath: path.join(root, 'archived-tmp', randomUUID()),
      identity: ['directory', 'git'].includes(group.kind) ? io.describe(group.path) : undefined,
      repositoryIdentity: group.common ? io.identity(group.common) : undefined,
      registrationIdentity: group.own ? io.identity(group.own) : undefined,
      metadata: path.join(container, `${index}.git`), dataBackup: path.join(container, `${index}.directory`), index: path.join(container, `${index}.index`),
      refs: ['git', 'main'].includes(group.kind) ? owners.map(record => `refs/pi-session-snapshots/chats/${record.header.id.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+|\.+$/g, '') || 'session'}/archive/${randomUUID()}`) : [],
    };
  });

  const transaction = { version: 2, kind: 'archive', id, root, container, containerIdentity: io.identity(container), state: 'planned', groups: plannedGroups, records: plannedRecords, ownerships: records.flatMap(record => archiveOwnership(root, record.header.id)) };
  shared.archivePlans(transaction);
  save(transaction);

  return transaction;
}

function validateRecord(transaction, record) {
  const sessions = path.join(transaction.root, 'sessions');

  const archive = path.join(transaction.root, 'archived');

  if (!io.inside(sessions, record.file) || !record.file.endsWith('.jsonl') || path.dirname(record.destination) !== archive) throw new Error('Invalid archive transcript mapping');

  for (const file of [record.backup, record.prepared, record.rollbackCopy]) {
    if (path.dirname(file) !== transaction.container) throw new Error('Invalid archive backup mapping');
  }

  const expected = sidecarPaths(record.file, record.destination);

  for (const move of record.moves) {
    if (!expected.some(([source, destination]) => source === move.source && destination === move.destination)) throw new Error('Invalid archive sidecar mapping');
  }
}

function sidecarPaths(file, destination) {
  return [
    [file.replace(/\.jsonl$/, '.snapshots'), destination.replace(/\.jsonl$/, '.snapshots')],
    [file.replace(/\.jsonl$/, '.diffs.json'), destination.replace(/\.jsonl$/, '.diffs.json')],
    [file.replace(/\.jsonl$/, '.diffs.json.lock'), destination.replace(/\.jsonl$/, '.diffs.json.lock')],
    [`${file}.loop-detection.json`, `${destination}.loop-detection.json`],
  ];
}

function validateGroup(transaction, group) {
  if (!path.isAbsolute(group.path) || path.resolve(group.path) !== group.path || path.dirname(group.storedPath) !== path.join(transaction.root, 'archived-tmp')) throw new Error('Invalid archive directory mapping');

  for (const file of [group.metadata, group.dataBackup, group.index]) {
    if (path.dirname(file) !== transaction.container) throw new Error('Invalid archive Git backup');
  }

  if (group.kind === 'git' && (!path.isAbsolute(group.common) || !path.isAbsolute(group.own))) throw new Error('Invalid archive repository');
  validateRefs(transaction, group);
}

function validateRefs(transaction, group) {
  if (group.commit && !/^[a-f0-9]{40,64}$/.test(group.commit)) throw new Error('Invalid archive commit ownership');

  if (group.branchRef && !group.branchRef.startsWith('refs/heads/')) throw new Error('Invalid archive branch ownership');
  const owners = transaction.records.filter(record => transaction.groups[record.group] === group);

  for (const ref of group.refs) {
    if (group.resource?.ref === ref) continue;

    if (!owners.some(record => {
      const id = record.sessionId.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+|\.+$/g, '') || 'session';
      const prefix = `refs/pi-session-snapshots/chats/${id}/archive/`;

      return ref.startsWith(prefix) && uuid.test(ref.slice(prefix.length));
    })) throw new Error('Invalid archive ref ownership');
  }
}

function load(root, id) {
  if (!uuid.test(id)) throw new Error('Invalid archive transaction identity');
  const container = path.join(root, 'archive-transactions', id);

  const file = path.join(container, 'recovery.json');

  if (!io.exists(file)?.isFile()) throw new Error(`Archive journal is unavailable: ${container}`);
  const transaction = JSON.parse(fs.readFileSync(file, 'utf8'));

  validateIdentity(transaction, root, id, container, file);
  transaction.records.forEach(record => validateRecord(transaction, record));
  transaction.groups.forEach(group => validateGroup(transaction, group));
  shared.validateChanges(transaction, transaction.groups.flatMap(group => group.resource ? [group.resource.change] : []));
  shared.validateArchive(transaction);
  checkpoints.validate(transaction);

  return transaction;
}

function validateIdentity(transaction, root, id, container, file) {
  if (transaction.version !== 2 || transaction.kind !== 'archive' || transaction.id !== id || transaction.root !== root || transaction.container !== container || io.identity(container) !== transaction.containerIdentity) throw new Error(`Invalid archive journal: ${file}`);

  if (fs.realpathSync(container) !== container || !['planned', 'pending', 'committed', 'rolled-back'].includes(transaction.state)) throw new Error(`Invalid archive transaction state: ${file}`);
  validateOwnership(transaction, root);
}

function validateOwnership(transaction, root) {
  for (const owner of transaction.ownerships ?? []) {
    const key = createHash('sha256').update(owner.sessionId.toLowerCase()).digest('hex').slice(0, 40);

    if (owner.file !== path.join(root, 'conversation-ownership', key + '.json') || !transaction.records.some(record => record.sessionId === owner.sessionId)) throw new Error('Invalid archive ownership mapping');
  }
}

function begin(transaction) {
  if (transaction.state !== 'planned') throw new Error('Archive transaction is no longer awaiting execution');

  for (const record of transaction.records) {
    if (!io.matches(record.file, record.original)) throw new Error(`Conversation changed before archiving: ${record.file}`);
  }

  for (const group of transaction.groups.filter(group => group.identity)) {
    if (!io.matches(group.path, group.identity, false)) throw new Error(`Working directory changed before archiving: ${group.path}`);
    group.identity = io.describe(group.path);

    if (group.kind === 'git') {
      registration(group, group.path);
      const pointer = path.join(group.path, '.git');
      group.pointer = { text: fs.readFileSync(pointer, 'utf8'), identity: io.identity(pointer), mode: fs.statSync(pointer).mode & 0o777 };
      group.contents = io.describe(group.path, ['.git']);
    }
  }

  io.write(path.join(transaction.container, 'pending.json'), JSON.stringify({ version: 2, id: transaction.id }));
  transaction.state = 'pending';
  save(transaction);
  io.mkdir(path.join(transaction.root, 'archived'));
  io.mkdir(path.join(transaction.root, 'archived-tmp'));
}

function repository(group) {
  if (io.identity(group.common) !== group.repositoryIdentity) throw new Error(`Archive repository was replaced: ${group.common}`);

  return group.common;
}

function registration(group, directory) {
  repository(group);

  if (io.identity(group.own) !== group.registrationIdentity) throw new Error(`Archive worktree registration was replaced: ${group.own}`);
  const pointer = path.join(directory, '.git');

  if (!io.exists(pointer)?.isFile()) throw new Error(`Archive worktree pointer is unavailable: ${directory}`);
  const value = fs.readFileSync(pointer, 'utf8').trim();

  if (value.startsWith('gitdir: ') && path.resolve(directory, value.slice(8)) === group.own) return;

  if (io.identity(pointer) !== group.pointer?.identity || ![group.pointer.text.trim(), ''].includes(value)) throw new Error(`Archive worktree identity changed: ${directory}`);
}

function repairDirectory(group, directory) {
  registration(group, directory);
  const pointer = path.join(directory, '.git');
  fs.writeFileSync(pointer, `gitdir: ${group.own}\n`);
  fs.chmodSync(pointer, group.pointer.mode);
  io.sync(pointer);
  io.git(group.common, ['worktree', 'repair', directory]);

  if (directory === group.path) {
    fs.writeFileSync(pointer, group.pointer.text);
    fs.chmodSync(pointer, group.pointer.mode);
    io.sync(pointer);
  }

  io.syncTree(pointer);
  io.sync(directory);
  io.syncTree(group.own);
  io.sync(path.dirname(group.own));
}

function moveGroup(transaction, group) {
  io.syncTree(group.path);

  if (group.kind === 'git') registration(group, group.path);
  io.move({ source: group.path, destination: group.storedPath, identity: group.identity });

  if (group.kind === 'git') {
    repairDirectory(group, group.storedPath);
  }

  group.moved = true;
  save(transaction);
}

function publishRecord(transaction, record) {
  if (!io.matches(record.file, record.original) || !io.matches(record.backup, record.backupIdentity) || !io.matches(record.prepared, record.preparedIdentity)) throw new Error(`Archive publication files changed: ${record.file}`);
  fs.renameSync(record.prepared, record.file);
  io.sync(path.dirname(record.file));
  record.trace = { source: record.file, destination: record.destination, identity: record.preparedIdentity };
  save(transaction);

  for (const move of [...record.moves, record.trace]) {
    io.syncTree(move.source);
    io.move(move);
    save(transaction);
  }
}

function commit(transaction) {
  shared.verifyPeers(transaction);

  for (const record of transaction.records) {
    if (!io.matches(record.destination, record.preparedIdentity) || io.exists(record.file)) throw new Error(`Archive commit could not be verified: ${record.file}`);

    for (const move of record.moves) {
      if (!io.matches(move.destination, move.identity) || io.exists(move.source)) throw new Error(`Archive sidecar commit could not be verified: ${move.source}`);
    }
  }

  transaction.state = 'committed';
  save(transaction);
}

function restoreGroup(group) {
  if (!group.identity) return;

  if (io.matches(group.path, group.identity, false) && !io.exists(group.storedPath)) {
    if (group.kind === 'git') repairGroup(group);

    return;
  }

  if (io.exists(group.path) || !io.matches(group.storedPath, group.identity, false)) throw new Error(`Archive directory recovery is ambiguous: ${group.path}`);

  if (group.kind === 'git') registration(group, group.storedPath);
  const identity = io.describe(group.storedPath);
  io.move({ source: group.storedPath, destination: group.path, identity });

  if (group.kind === 'git') repairGroup(group);
}

function repairGroup(group) {
  repairDirectory(group, group.path);
}

function restoreRecord(transaction, record) {
  const trace = { source: record.file, destination: record.destination, identity: record.preparedIdentity };

  if (io.exists(record.destination)) io.undo(trace);

  for (const move of [...record.moves].reverse()) io.undo(move);

  if (io.matches(record.file, record.original) || io.matches(record.file, record.rollbackIdentity)) {
    checkpointIndex.refresh(record.file);

    return;
  }

  if (!io.matches(record.file, record.preparedIdentity) || !io.matches(record.backup, record.backupIdentity)) throw new Error(`Archive transcript recovery is ambiguous: ${record.file}`);

  prepareRollbackCopy(transaction, record);

  if (!io.matches(record.rollbackCopy, record.rollbackIdentity)) throw new Error(`Archive rollback copy changed: ${record.rollbackCopy}`);
  fs.renameSync(record.rollbackCopy, record.file);
  io.sync(path.dirname(record.file));
  checkpointIndex.refresh(record.file);
}

function prepareRollbackCopy(transaction, record) {
  if (record.rollbackIdentity) return;

  if (!io.exists(record.rollbackCopy)) fs.copyFileSync(record.backup, record.rollbackCopy, fs.constants.COPYFILE_EXCL);

  if (!io.sameContents(record.rollbackCopy, record.backupIdentity)) throw new Error(`Archive rollback copy is ambiguous; retained: ${record.rollbackCopy}`);
  io.syncTree(record.rollbackCopy);
  record.rollbackIdentity = io.describe(record.rollbackCopy);
  save(transaction);
}

function complete(transaction) {
  transaction.finished = true;
  save(transaction);
  const pending = path.join(transaction.container, 'pending.json');

  if (io.exists(pending)) fs.unlinkSync(pending);
  io.sync(transaction.container);
}

function verifyRollback(transaction) {
  for (const group of transaction.groups.filter(group => group.identity)) {
    if (!io.matches(group.path, group.identity) || io.exists(group.storedPath)) throw new Error(`Archive directory rollback could not be verified: ${group.path}`);
  }

  for (const record of transaction.records) {
    if (!io.sameContents(record.file, record.original) || io.exists(record.destination)) throw new Error(`Archive transcript rollback could not be verified: ${record.file}`);

    for (const move of record.moves) {
      if (!io.matches(move.source, move.identity) || io.exists(move.destination)) throw new Error(`Archive sidecar rollback could not be verified: ${move.source}`);
    }
  }
}

function rollbackData(transaction) {
  shared.rollbackPeers(transaction, save);

  for (const group of [...transaction.groups].reverse()) restoreGroup(group);

  for (const record of [...transaction.records].reverse()) restoreRecord(transaction, record);
  verifyRollback(transaction);
  transaction.state = 'rolled-back';
  save(transaction);
}

function cleanupRollback(transaction) {
  if (!transaction.cleanup) {
    const files = transaction.records.flatMap(record => [record.backup, record.prepared, record.rollbackCopy]);
    files.push(...transaction.groups.flatMap(group => [group.metadata, group.dataBackup, group.index]));
    files.push(...(transaction.resourcePeers ?? []).flatMap(peer => [peer.backup, peer.prepared, peer.rollback]));
    files.push(...(transaction.checkpointMappings ?? []).map(mapping => mapping.prepared));
    transaction.cleanup = files.flatMap(file => io.exists(file) ? [{ file, entries: io.removalPlan(file) }] : []);
    save(transaction);
  }

  for (const artifact of transaction.cleanup) {
    if (path.dirname(artifact.file) !== transaction.container) throw new Error('Invalid archive cleanup mapping');
    io.removeOwned(artifact.file, artifact.entries);
  }

  const remaining = fs.readdirSync(transaction.container).filter(name => !['recovery.json', 'pending.json'].includes(name));

  if (remaining.length) throw new Error(`Unknown archive transaction artifacts retained: ${remaining.join(', ')}`);

  if (io.exists(path.join(transaction.container, 'pending.json'))) fs.unlinkSync(path.join(transaction.container, 'pending.json'));
  fs.unlinkSync(path.join(transaction.container, 'recovery.json'));
  io.sync(transaction.container);
  fs.rmdirSync(transaction.container);
  io.sync(path.dirname(transaction.container));
}

function rollback(transaction) {
  if (transaction.state !== 'rolled-back') rollbackData(transaction);

  for (const group of transaction.groups.filter(group => group.commit)) {
    for (const ref of group.refs) io.removeRef(repository(group), ref, group.commit);
  }

  cleanupRollback(transaction);
}

function removeBranch(group) {
  if (!group.branchRef) return;
  const common = repository(group);

  const current = io.refValue(common, group.branchRef);

  if (current === null) return;

  if (current !== group.head || io.git(common, ['worktree', 'list', '--porcelain', '-z']).split('\0').includes(`branch ${group.branchRef}`)) {
    console.error(`Archived successfully; branch with a surviving owner retained: ${group.branchRef}`);

    return;
  }

  io.removeRef(common, group.branchRef, group.head);
}

function finishGroup(transaction, group) {
  if (io.exists(group.storedPath)) {
    if (!io.matches(group.storedPath, group.contents) || !io.matches(group.dataBackup, group.dataBackupIdentity) || !io.matches(group.metadata, group.metadataIdentity)) throw new Error(`Archive recovery data changed; retained: ${group.storedPath}`);
    registration(group, group.storedPath);
    io.git(group.common, ['worktree', 'remove', '--force', '--force', group.storedPath]);
    io.sync(path.dirname(group.storedPath));
    io.sync(path.dirname(group.own));
  } else if (io.exists(group.own)) throw new Error(`Archive worktree removal needs repair; registration retained: ${group.own}`);

  removeBranch(group);
  group.removed = true;
  save(transaction);
}

function finish(transaction) {
  return checkpoints.preserve(transaction, transaction.borrowedOwnerIds ?? [], () => finishLocked(transaction));
}

function finishLocked(transaction) {
  require('./session-database.cjs').movePaths(transaction.root, transaction.records.map(record => ({ source: record.file, destination: record.destination })));

  for (const group of transaction.groups.filter(group => group.kind === 'git' && !group.removed)) finishGroup(transaction, group);
  shared.finishArchive(transaction);
  finishOwnership(transaction);
  complete(transaction);

  try { require('./restore-receipts.cjs').prune(transaction.root); }
  catch (error) { console.error(`Archive committed; restore receipt pruning will retry: ${error.message}`); }
}

function replay(transaction) {
  if (transaction.finished || transaction.state === 'planned') return;

  if (transaction.state === 'committed') {
    try { finish(transaction); }
    catch (error) { console.error(`Committed archive recovery retained: ${transaction.container}: ${error.message}`); }

    return;
  }

  if (transaction.state === 'rolled-back') {
    try { rollback(transaction); }
    catch (error) { console.error(`Verified archive rollback cleanup retained: ${transaction.container}: ${error.message}`); }

    return;
  }

  rollback(transaction);
}

function recover(root) {
  const directory = path.join(root, 'archive-transactions');

  const failures = [];

  for (const entry of io.exists(directory) ? fs.readdirSync(directory) : []) {
    if (!uuid.test(entry)) continue;

    try {
      replay(load(root, entry));
    } catch (error) { failures.push(`${path.join(directory, entry)}: ${error.message}`); }
  }

  for (const name of fs.readdirSync(root).filter(name => /^archive-transaction-[a-zA-Z0-9]{6}$/.test(name))) {
    try { legacyRecovery(root, path.join(root, name)); }
    catch (error) { failures.push(`${path.join(root, name)}: ${error.message}`); }
  }

  if (failures.length) throw new Error(failures.join('\n'));
}

const legacyRecovery = (() => {
  const exists = io.exists, identity = io.identity, sync = io.sync, syncTree = io.syncTree;
  const rename = (source, destination) => { fs.renameSync(source, destination); sync(path.dirname(destination)); sync(path.dirname(source)); };

  const write = (file, value) => io.write(file, JSON.stringify(value));
  const git = (common, args) => io.git(common, args);
  const { pruneReceipts } = require('./deletion-retention.cjs');
  const { recoverLegacy } = require('./archive-legacy-recovery.cjs');

function matches(file, expected) { return Boolean(exists(file)) && identity(file) === expected; }

function undoMove(item) {
  if (matches(item.source, item.identity) && !exists(item.destination)) return;

  if (exists(item.source) || !matches(item.destination, item.identity)) throw new Error(`Cannot safely roll back archive: ${item.source}`);
  rename(item.destination, item.source);
}

function reference(common, ref) {
  try { return git(common, ['rev-parse', '--verify', ref]); }
  catch (error) { if (error.status === 128) return undefined; throw error; }
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

function assertRegistration(item, directory) {
  if (!matches(item.registration, item.registrationIdentity)) throw new Error(`Archive worktree registration changed: ${item.registration}`);
  const pointer = path.join(directory, '.git');
  const content = fs.readFileSync(pointer, 'utf8').trim();

  if (!content.startsWith('gitdir: ') || path.resolve(directory, content.slice(8)) !== item.registration) throw new Error(`Archive worktree changed: ${directory}`);
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

return recoverDirectory;
})();

module.exports = { plan, load, begin, save, moveGroup, publishRecord, commit, rollback, finish, recover };
