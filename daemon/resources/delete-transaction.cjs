const conversationStorage = require('./conversation-storage.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const io = require('./session-transactions.cjs');
const goalAssets = require('./goal-asset-cleanup.cjs');
const shared = require('./archive-resource-transactions.cjs');

const records = require('./deletion-records.cjs');

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function location(transaction) {
  return io.exists(transaction.container) ? transaction.container : transaction.garbagePath;
}

function save(transaction) {
  records.save(transaction);
}

function ownership(root, targets) {
  return targets.flatMap(target => {
    const key = createHash('sha256').update(target.sessionId.toLowerCase()).digest('hex').slice(0, 40);

    const file = path.join(root, 'conversation-ownership', `${key}.json`);

    const before = conversationStorage.read(file);

    if (before === null) return [];

    const record = JSON.parse(before);

    return [{ file, before, after: JSON.stringify({ ...record, deleted: true, client: null }), sessionId: target.sessionId }];
  });
}

function create(root, files, repositories, sources) {
  const id = randomUUID();

  const container = path.join(root, 'delete-transactions', id);

  records.allocate(root, container);
  io.mkdir(container);

  const targets = sources.map(file => ({ path: file, sessionId: require('./transcript-references.cjs').read(root, file)[0].id }));

  const transaction = {
    version: 2, kind: 'delete', id, root, container, containerIdentity: io.identity(container), state: 'pending',
    garbagePath: path.join(root, 'deleted-sessions', id), targets, ownership: ownership(root, targets),
    goalAssets: goalAssets.plan(root, targets),
    files: files.flatMap((saved, index) => plannedFile(saved, index, container)),
    repositories: repositories.map((repository, index) => ({
      cwd: repository.cwd, identity: io.identity(repository.cwd),
      refs: repository.refs.map((ref, refIndex) => ({ ...ref, reservation: `refs/piop-delete-transactions/${id}/${index}/${refIndex}` })),
    })),
  };

  shared.deletePlans(transaction);
  validate(transaction, root, container);
  save(transaction);

  return transaction;
}

function plannedFile(saved, index, container) {
  const metadata = io.exists(saved.file);

  if (!metadata && saved.note) return [];

  if (!metadata || ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs'].some(key => metadata[key] !== saved.metadata[key])) throw new Error(`Deletion source changed before journaling: ${saved.file}`);

  const identity = io.describe(saved.file);

  if (saved.body && !fs.readFileSync(saved.file).equals(saved.body)) throw new Error(`Deletion contents changed before journaling: ${saved.file}`);

  return [{ source: saved.file, staged: path.join(container, `${index}.staged`), identity, optional: Boolean(saved.note) }];
}

function validSource(root, source) {
  return ['sessions', 'archived', path.join('notes', 'chats'), 'archived-tmp', 'queued-input'].some(name => io.inside(path.join(root, name), source) && source !== path.join(root, name));
}

function validRef(transaction, ref) {
  return transaction.targets.some(target => {
    const id = target.sessionId.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+|\.+$/g, '') || 'session';

    return ref === `refs/pi-session-snapshots/${id}` || ref.startsWith(`refs/pi-session-snapshots/chats/${id}/`);
  });
}

function validateIdentity(transaction, root, directory) {
  if (transaction.version !== 2 || transaction.kind !== 'delete' || !uuid.test(transaction.id ?? '') || transaction.root !== root) throw new Error('Unsupported deletion recovery journal');
  validateLocation(transaction, root, directory);
}

function validateLocation(transaction, root, directory) {
  if (transaction.container !== path.join(root, 'delete-transactions', transaction.id) || transaction.garbagePath !== path.join(root, 'deleted-sessions', transaction.id)) throw new Error('Invalid deletion recovery location');

  if (![transaction.container, transaction.garbagePath].includes(directory) || io.identity(directory) !== transaction.containerIdentity) throw new Error('Deletion recovery directory was replaced');

  if (fs.realpathSync(directory) !== directory) throw new Error('Deletion recovery directory has ambiguous ancestry');
}

function validateFile(transaction, file) {
  if (!validSource(transaction.root, file.source) || path.dirname(file.staged) !== transaction.container || !/^\d+\.staged$/.test(path.basename(file.staged))) throw new Error('Invalid deletion recovery file mapping');
}

function validateRepository(transaction, repository) {
  if (!path.isAbsolute(repository.cwd)) throw new Error('Invalid deletion recovery repository');

  for (const ref of repository.refs) {
    if (!validRef(transaction, ref.ref) || !/^[a-f0-9]{40,64}$/.test(ref.oid) || !ref.reservation.startsWith(`refs/piop-delete-transactions/${transaction.id}/`)) throw new Error('Invalid deletion recovery ref ownership');
  }
}

function validate(transaction, root, directory) {
  validateIdentity(transaction, root, directory);
  transaction.files.forEach(file => validateFile(transaction, file));
  transaction.repositories.forEach(repository => validateRepository(transaction, repository));
  goalAssets.validate(root, transaction.goalAssets ?? []);
  shared.validateDelete(transaction);

  for (const owner of transaction.ownership) {
    const key = createHash('sha256').update(owner.sessionId.toLowerCase()).digest('hex').slice(0, 40);

    if (owner.file !== path.join(root, 'conversation-ownership', `${key}.json`)) throw new Error('Invalid deletion ownership mapping');
  }
}

function repositoryDirectory(repository) {
  if (io.identity(repository.cwd) !== repository.identity) throw new Error(`Deletion repository was replaced: ${repository.cwd}`);

  return repository.cwd;
}

function stagedPath(transaction, file) {
  return path.join(location(transaction), path.basename(file.staged));
}

function stageFile(transaction, file) {
  if (!io.matches(file.source, file.identity)) {
    if (!file.optional || io.exists(file.source)) throw new Error(`Deletion source changed: ${file.source}`);
    file.skipped = true;
    save(transaction);

    return;
  }

  io.syncTree(file.source);
  io.move({ source: file.source, destination: file.staged, identity: file.identity });
  file.stagedComplete = true;
  save(transaction);
}

function stageRepository(transaction, repository) {
  const cwd = repositoryDirectory(repository);
  repository.attempted = true;
  save(transaction);
  const reserve = ['start', ...repository.refs.map(ref => `create ${ref.reservation} ${ref.oid}`), 'prepare', 'commit', ''].join('\n');
  io.git(cwd, ['update-ref', '--stdin'], reserve);
  const remove = ['start', ...repository.refs.map(ref => `delete ${ref.ref} ${ref.oid}`), 'prepare', 'commit', ''].join('\n');
  io.git(cwd, ['update-ref', '--stdin'], remove);
  repository.removed = true;
  save(transaction);
}

function stage(transaction) {
  for (const file of transaction.files) stageFile(transaction, file);

  for (const repository of transaction.repositories) stageRepository(transaction, repository);
}

function commit(transaction) {
  io.mkdir(path.dirname(transaction.garbagePath));
  transaction.state = 'commit-intent';
  save(transaction);
  io.move({ source: transaction.container, destination: transaction.garbagePath, identity: io.describe(transaction.container) });
  transaction.state = 'committed';
  save(transaction);
}

function committed(transaction) {
  return Boolean(io.exists(transaction.garbagePath)) && io.identity(transaction.garbagePath) === transaction.containerIdentity;
}

function restoreRepository(repository) {
  if (!repository.attempted) return;
  const cwd = repositoryDirectory(repository);

  for (const ref of repository.refs) {
    const current = io.refValue(cwd, ref.ref);

    if (current === ref.oid) continue;

    if (current !== null || io.refValue(cwd, ref.reservation) !== ref.oid) throw new Error(`Checkpoint recovery is ambiguous; retained: ${ref.ref}`);
    io.git(cwd, ['update-ref', ref.ref, ref.oid, '0'.repeat(ref.oid.length)]);
  }
}

function releaseReservations(transaction) {
  for (const repository of transaction.repositories.filter(repository => repository.attempted)) {
    for (const ref of repository.refs) io.removeRef(repositoryDirectory(repository), ref.reservation, ref.oid);
  }
}

function restoreFile(transaction, file) {
  if (file.skipped) return;
  const destination = stagedPath(transaction, file);

  if (!io.exists(destination) && io.exists(file.source)) return;
  io.undo({ source: file.source, destination, identity: file.identity });
}

function retire(transaction) {
  const directory = location(transaction);

  const unexpected = fs.readdirSync(directory).filter(name => name !== 'recovery.json');

  if (unexpected.length) throw new Error(`Unresolved recovery files retained: ${unexpected.join(', ')}`);
  transaction.retiring = true;
  save(transaction);
  fs.rmSync(path.join(directory, 'recovery.json'), { force: true });
  io.sync(directory);
  fs.rmdirSync(directory);
  io.sync(path.dirname(directory));
  records.remove(transaction.root, transaction.container);
}

function rollback(transaction) {
  if (transaction.state === 'rolled-back') {
    releaseReservations(transaction);
    retire(transaction);

    return;
  }

  const failures = [];

  for (const repository of transaction.repositories) {
    try { restoreRepository(repository); }
    catch (error) { failures.push(error.message); }
  }

  for (const file of [...transaction.files].reverse()) {
    try { restoreFile(transaction, file); }
    catch (error) { failures.push(error.message); }
  }

  if (failures.length) throw new Error(failures.join('\n'));
  transaction.state = 'rolled-back';
  save(transaction);
  releaseReservations(transaction);
  retire(transaction);
}

function finishOwnership(transaction) {
  for (const owner of transaction.ownership) {
    const current = conversationStorage.read(owner.file);

    if (current === null) continue;

    if (current === owner.after || JSON.parse(current).deleted === true) continue;

    if (current !== owner.before) throw new Error(`Deletion ownership changed; retained: ${owner.file}`);
    conversationStorage.write(owner.file, owner.after);
  }
}

function finish(transaction) {
  transaction.state = 'committed';
  save(transaction);
  finishOwnership(transaction);
  require('./registry-deletion.cjs').forget(transaction.root, transaction.targets);
  shared.finishDelete(transaction);
  goalAssets.finish(transaction, save);

  for (const file of transaction.files.filter(file => !file.skipped)) {
    const staged = stagedPath(transaction, file);

    if (!io.exists(staged)) continue;

    if (!file.cleanup) {
      if (!io.matches(staged, file.identity)) throw new Error(`Committed deletion recovery data changed; retained: ${staged}`);
      file.cleanup = io.removalPlan(staged);
      save(transaction);
    }

    io.removeOwned(staged, file.cleanup);
  }

  releaseReservations(transaction);
  retire(transaction);

  try { require('./restore-receipts.cjs').prune(transaction.root); }
  catch (error) { console.error(`Deletion committed; restore receipt pruning will retry: ${error.message}`); }
}

function discardAllocation(root, directory) {
  if (io.exists(directory)) { fs.rmdirSync(directory); io.sync(path.dirname(directory)); }

  records.remove(root, directory);
}

function recoverRecord(root, entry) {
  const { directory, record: transaction } = entry;

  if (path.dirname(directory) !== path.join(root, 'delete-transactions') || !uuid.test(path.basename(directory))) throw new Error('Invalid registered deletion directory');

  if (!transaction) {
    discardAllocation(root, directory);

    return;
  }

  if (transaction.root !== root || transaction.container !== directory) throw new Error('Invalid registered deletion identity');
  const current = location(transaction);

  if (transaction.retiring === true && !io.exists(current)) {
    records.remove(root, directory);

    return;
  }

  validate(transaction, root, current);

  if (transaction.retiring === true) retire(transaction);

  else if (committed(transaction)) finish(transaction);

  else rollback(transaction);
}

function recover(root) {
  const failures = [];

  for (const entry of records.list(root)) {
    try { recoverRecord(root, entry); }
    catch (error) { failures.push(`${entry.directory}: ${error.message}`); }
  }

  if (failures.length) throw new Error(failures.join('\n'));
}

module.exports = { create, stage, commit, committed, rollback, finish, recover };
