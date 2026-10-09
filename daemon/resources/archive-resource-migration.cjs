const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const io = require('./session-transactions.cjs');
const ownership = require('./archive-resource-owners.cjs');
const resources = require('./archive-resources.cjs');
const peers = require('./archive-resource-transactions.cjs');
const checkpoints = require('./worktree-checkpoint-preservation.cjs');

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function plan(root, file, destination, header, operationId) {
  const saved = header.worktreeRestore;

  if (!['git', 'directory'].includes(saved?.kind) || !path.isAbsolute(saved.path ?? '') || io.exists(saved.path)) throw new Error('Legacy archive requires explicit migration: the original directory has no durable shared restoration identity; existing data retained');

  const migration = { version: 1, resourceId: randomUUID(), operationId, kind: saved.kind, path: saved.path, destination, owners: [],
    container: path.join(root, 'restore-resource-transactions', operationId) };

  migration.recovery = recovery(root, saved, migration);
  discover(root, migration);

  if (!migration.owners.some(owner => owner.sessionPath === file && owner.sessionId === header.id)) throw new Error('Legacy restoration source could not be reconciled');
  verifyRegistry(root, migration);
  io.mkdir(migration.container);
  migration.containerIdentity = io.identity(migration.container);

  return migration;
}

function recovery(root, saved, migration) {
  if (saved.kind === 'directory') {
    if (path.dirname(saved.storedPath ?? '') !== path.join(root, 'archived-tmp') || fs.realpathSync(saved.storedPath) !== saved.storedPath) throw new Error('Legacy directory storage has ambiguous ownership; explicit migration required');
    const stored = io.describe(saved.storedPath);

    if (!stored.directory) throw new Error('Legacy archive storage is not a directory');

    return { kind: 'directory', path: saved.path, storedPath: saved.storedPath, storedIdentity: stored.identity, digest: stored.digest };
  }

  const common = checkpoints.canonicalRepository(saved.repositoryRoot);

  checkpoints.verifyCheckpoint(common, saved.ref, saved.commit);

  return { kind: 'git', path: saved.path, repositoryRoot: common, repositoryIdentity: io.identity(common),
    ref: `refs/piop-archive-resources/${migration.resourceId}/${migration.operationId}`, commit: saved.commit, branch: saved.branch };
}

function discover(root, migration) {
  for (const file of require('./session-database.cjs').paths(root)) {
    const archived = io.inside(path.join(root, 'archived'), file);

    if (archived || io.inside(path.join(root, 'sessions'), file)) observe(file, archived, migration);
  }
}

function observe(file, archived, migration) {
  const { header, identity } = ownership.headerAt(file);
  const saved = header.worktreeRestore;

  if (!potentialOwner(header, migration)) return;

  if (!archived || header.archiveResourceId || saved?.kind !== migration.kind || saved.path !== migration.path) throw new Error('Legacy directory has an active or unresolved co-owner; explicit migration required');
  verifyOwnerRecovery(header, saved, migration);
  appendOwner(file, header, saved, identity, migration);
}

function potentialOwner(header, migration) {
  const saved = header.worktreeRestore;

  return io.inside(migration.path, header.cwd) || saved?.path === migration.path || migration.kind === 'directory' && saved?.storedPath === migration.recovery.storedPath;
}

function appendOwner(file, header, saved, identity, migration) {
  const cwd = saved.conversationPath ?? header.cwd;

  if (!io.inside(migration.path, cwd) || migration.owners.some(owner => owner.sessionId === header.id)) throw new Error('Legacy co-owner location or identity is ambiguous');
  migration.owners.push({ sessionId: header.id, sessionPath: file, area: 'archived', relative: path.relative(migration.path, cwd), identity });
}

function verifyOwnerRecovery(header, saved, migration) {
  const recovery = migration.recovery;

  if (migration.kind === 'directory') {
    if (saved.storedPath !== recovery.storedPath) throw new Error('Legacy co-owners have different stored directories; explicit migration required');

    return;
  }

  const owner = header.id.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+|\.+$/g, '') || 'session';

  if (checkpoints.canonicalRepository(saved.repositoryRoot) !== recovery.repositoryRoot || saved.commit !== recovery.commit || !saved.ref.startsWith(`refs/pi-session-snapshots/chats/${owner}/`)) throw new Error('Legacy co-owner checkpoint ownership is ambiguous');

  checkpoints.verifyCheckpoint(recovery.repositoryRoot, saved.ref, saved.commit);
}

function verifyRegistry(root, migration) {
  const file = path.join(root, 'sessions.sqlite');

  if (!io.exists(file)) return;
  ownership.canonical(file);
  const database = new DatabaseSync(file, { readOnly: true });

  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();

    if (!tables.some(table => table.name === 'session_repositories')) return;
    const exclusion = tables.some(table => table.name === 'session_deletion_tombstones') ? ' WHERE NOT EXISTS (SELECT 1 FROM session_deletion_tombstones t WHERE t.session_id = lower(r.session_id))' : '';

    for (const row of database.prepare('SELECT session_id, cwd FROM session_repositories r' + exclusion).all()) {
      if (io.inside(migration.path, row.cwd) && !migration.owners.some(owner => owner.sessionId.toLowerCase() === row.session_id.toLowerCase())) throw new Error('Registry contains an unresolved legacy directory owner; explicit migration required');
    }
  } finally { database.close(); }
}

function validate(root, transaction) {
  const migration = transaction.migration;

  if (!migration) return;

  validateIdentity(root, transaction, migration);
  validateRecovery(root, migration);

  if (io.exists(migration.container) ? io.identity(migration.container) !== migration.containerIdentity : !migration.retired) throw new Error('Legacy shared restoration staging ownership changed');

  for (const owner of migration.owners) {
    if (!io.inside(path.join(root, 'archived'), owner.sessionPath) || !io.inside(migration.path, path.resolve(migration.path, owner.relative))) throw new Error('Invalid legacy shared owner mapping');
  }

  peers.validatePeers(transaction);
}

function validateIdentity(root, transaction, migration) {
  if (migration.version !== 1 || !uuid.test(migration.operationId) || !uuid.test(migration.resourceId) || migration.operationId !== transaction.receiptId || migration.container !== path.join(root, 'restore-resource-transactions', migration.operationId)) throw new Error('Invalid legacy shared restoration journal ownership');
}

function validateRecovery(root, migration) {
  const recovery = migration.recovery;

  if (!path.isAbsolute(migration.path) || path.resolve(migration.path) !== migration.path || recovery.kind !== migration.kind || recovery.path !== migration.path) throw new Error('Invalid legacy shared resource origin');

  if (migration.kind === 'git') {
    validatePin(migration);
  } else if (migration.kind !== 'directory' || path.dirname(recovery.storedPath) !== path.join(root, 'archived-tmp')) throw new Error('Invalid legacy migration stored directory ownership');
}

function validatePin(migration) {
  const recovery = migration.recovery;

  if (!/^[a-f0-9]{40,64}$/.test(recovery.commit) || recovery.ref !== `refs/piop-archive-resources/${migration.resourceId}/${migration.operationId}` || !path.isAbsolute(recovery.repositoryRoot)) throw new Error('Invalid legacy migration checkpoint ownership');
}

function preparePin(transaction, journal, publication = transaction) {
  const migration = transaction.migration;

  if (!migration || migration.kind !== 'git') return;
  const pin = migration.recovery;
  migration.pinAttempted = true;
  require('./restore-records.cjs').write(journal, JSON.stringify(publication));

  if (io.identity(pin.repositoryRoot) !== pin.repositoryIdentity) throw new Error('Legacy checkpoint repository changed');
  io.git(pin.repositoryRoot, ['update-ref', pin.ref, pin.commit, '0'.repeat(pin.commit.length)]);
}

function seal(root, transaction, journal, publication = transaction) {
  const migration = transaction.migration;

  if (!migration) return;
  transaction.resource = resources.adoptRestore(root, migration, { resourceId: migration.resourceId, operationId: migration.operationId,
    sessionId: transaction.result.sessionId, sourceIdentity: transaction.trace.identity, directoryIdentity: transaction.worktree?.stagingIdentity ?? transaction.directoryCopy?.stagingIdentity, created: true });
  transaction.container = migration.container;
  selectGroupOwners(transaction, publication);
  const record = resources.validate(root, transaction.resource);
  const selected = selectedMigrationOwners(transaction, publication);
  const updates = resources.headerUpdates(root, transaction.resource);

  for (const owner of selected) updates.push({ sessionId: owner.sessionId, sessionPath: owner.sessionPath, identity: owner.identity, archiveResourceId: record.id,
    checkpointRepositoryRoot: record.binding.git?.root ?? null, worktreeRestore: { ...record.recovery, resourceId: record.id, conversationPath: path.join(migration.path, owner.relative) } });
  const save = () => require('./restore-records.cjs').write(journal, JSON.stringify(publication));
  peers.planUpdates(transaction, updates, save);
  peers.preparePeers(transaction, save);
  const source = transaction.resourcePeers.find(peer => peer.file === transaction.trace.source);
  transaction.trace.identity = source.preparedIdentity.identity;
  save(transaction);
  peers.publishPeers(transaction);
  resources.apply(root, transaction.resource);
}

function selectedMigrationOwners(transaction, publication) {
  const ids = new Set((publication.result.sessions ?? [publication.result]).map(session => session.sessionId));

  return transaction.migration.owners.filter(owner => ids.has(owner.sessionId));
}

function selectGroupOwners(transaction, publication) {
  const sessions = new Map((publication.result.sessions ?? [publication.result]).map(session => [session.sessionId, session.sessionPath]));
  const record = JSON.parse(transaction.resource.after);

  for (const owner of record.owners) {
    if (!sessions.has(owner.sessionId)) continue;
    owner.sessionPath = sessions.get(owner.sessionId);
    owner.area = 'active';
    owner.identity = null;
  }

  transaction.resource.after = JSON.stringify(record);
}

function rollback(transaction, journal, publication = transaction) {
  if (!transaction.migration) return;
  peers.rollbackPeers(transaction, () => require('./restore-records.cjs').write(journal, JSON.stringify(publication)));
  const migration = transaction.migration;

  if (migration.pinAttempted) {
    const pin = migration.recovery;

    if (io.identity(pin.repositoryRoot) !== pin.repositoryIdentity) throw new Error('Legacy checkpoint repository changed; pin retained');
    io.removeRef(pin.repositoryRoot, pin.ref, pin.commit);
  }
}

function sourcePresent(transaction) {
  const peer = transaction.resourcePeers?.find(saved => saved.file === transaction.trace.source);

  return Boolean(peer && [peer.original, peer.preparedIdentity, peer.rollbackIdentity].some(proof => io.matches(peer.file, proof)));
}

function retire(transaction, journal, publication) {
  if (!transaction.migration) return;
  const container = transaction.migration.container;

  if (transaction.migration.retired && !io.exists(container)) return;

  if (io.identity(container) !== transaction.migration.containerIdentity) throw new Error('Legacy restoration staging container changed; retained');

  if (!transaction.migration.cleanup) {
    const files = (transaction.resourcePeers ?? []).flatMap(peer => [peer.backup, peer.prepared, peer.rollback]);
    transaction.migration.cleanup = files.flatMap(file => io.exists(file) ? [{ file, entries: io.removalPlan(file) }] : []);
    require('./restore-records.cjs').write(journal, JSON.stringify(publication));
  }

  for (const artifact of transaction.migration.cleanup) {
    if (path.dirname(artifact.file) !== container) throw new Error('Invalid legacy restoration cleanup ownership');
    io.removeOwned(artifact.file, artifact.entries);
  }

  if (fs.readdirSync(container).length) throw new Error('Unknown legacy restoration staging contents retained');
  transaction.migration.retired = true;
  require('./restore-records.cjs').write(journal, JSON.stringify(publication));
  fs.rmdirSync(container);
  io.sync(path.dirname(container));
}

module.exports = { plan, validate, preparePin, seal, rollback, sourcePresent, retire };
