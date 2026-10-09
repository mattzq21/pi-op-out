const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const io = require('./session-transactions.cjs');
const ownership = require('./archive-resource-owners.cjs');
const records = require('./archive-resource-records.cjs');

const identitySchema = Type.String({ pattern: '^\\d+:\\d+$' });

const commitSchema = Type.String({ pattern: '^[a-f0-9]{40,64}$' });

const gitSchema = Type.Object({ root: Type.String(), identity: identitySchema, registration: Type.String(), registrationIdentity: identitySchema });

const bindingSchema = Type.Object({ path: Type.String(), identity: identitySchema, git: Type.Union([gitSchema, Type.Null()]) });

const storedSchema = Type.Object({ path: Type.String(), identity: identitySchema, digest: Type.String({ pattern: '^[a-f0-9]{64}$' }) });

const pinSchema = Type.Object({ root: Type.String(), identity: identitySchema, ref: Type.String(), commit: commitSchema });

const recoverySchema = Type.Union([
  Type.Object({ kind: Type.Literal('directory'), path: Type.String(), storedPath: Type.String(), storedIdentity: identitySchema, digest: Type.String({ pattern: '^[a-f0-9]{64}$' }) }),
  Type.Object({ kind: Type.Literal('git'), path: Type.String(), repositoryRoot: Type.String(), repositoryIdentity: identitySchema, ref: Type.String(), commit: commitSchema, branch: Type.Optional(Type.String()) }),
]);

const restoredSchema = Type.Object({ operationId: ownership.resourceIdSchema, sessionId: Type.String({ minLength: 1 }), sourcePath: Type.String(), sourceIdentity: identitySchema, binding: bindingSchema });

const resourceSchema = Type.Object({ version: Type.Literal(1), managedBy: Type.Literal('piop'), kind: Type.Union([Type.Literal('git'), Type.Literal('directory')]), id: ownership.resourceIdSchema, revision: Type.Integer({ minimum: 1 }), state: Type.Union(['retained', 'archived', 'restored', 'retired'].map(value => Type.Literal(value))), origin: bindingSchema, binding: bindingSchema, owners: Type.Array(ownership.ownerSchema), recovery: Type.Union([recoverySchema, Type.Null()]), restored: Type.Union([restoredSchema, Type.Null()]), storage: Type.Array(storedSchema), pins: Type.Array(pinSchema) });

const changeSchema = Type.Object({ version: Type.Literal(1), operationId: ownership.resourceIdSchema, resourceId: ownership.resourceIdSchema, file: Type.String(), before: Type.Union([Type.String(), Type.Null()]), after: Type.String() });

const locationSchema = Type.Object({ kind: Type.Union([Type.Literal('git'), Type.Literal('directory')]), path: Type.String() });

const moveSchema = Type.Object({ source: Type.String(), destination: Type.String(), sessionId: Type.String({ minLength: 1 }) });

const creationSchema = Type.Object({ resourceId: ownership.resourceIdSchema, operationId: ownership.resourceIdSchema, sessionId: Type.String({ minLength: 1 }), sourceIdentity: identitySchema, directoryIdentity: identitySchema, created: Type.Boolean() });

function rootDirectory(root) {
  ownership.canonical(root);

  if (!fs.lstatSync(root).isDirectory()) throw new Error('Shared resource profile is not a regular directory');

  return path.join(root, 'archive-resources');
}

function resourcePath(root, id) {
  if (!Check(ownership.resourceIdSchema, id)) throw new Error('Invalid shared archive resource identity');

  return path.join(rootDirectory(root), id + '.json');
}

function normalized(file) { return path.isAbsolute(file) && path.resolve(file) === file; }

function validateBinding(binding) {
  if (!normalized(binding.path)) throw new Error('Shared resource directory path is invalid');

  if (binding.git && (!normalized(binding.git.root) || !normalized(binding.git.registration) || !io.inside(path.join(binding.git.root, 'worktrees'), binding.git.registration))) throw new Error('Shared resource Git registration is invalid');
}

function validateOwners(record) {
  const seen = new Set();

  for (const owner of record.owners) {
    if (seen.has(owner.sessionId)) throw new Error('Duplicate shared resource owner identity');
    seen.add(owner.sessionId);

    if (owner.sessionPath !== null && !normalized(owner.sessionPath)) throw new Error('Invalid shared resource owner path');

    if (owner.relative !== null && !io.inside(record.origin.path, path.resolve(record.origin.path, owner.relative))) throw new Error('Shared resource owner is outside its directory');
  }
}

function validateRecord(root, record) {
  if (!Check(resourceSchema, record)) throw new Error('Invalid shared archive resource record');
  validateBinding(record.origin);
  validateBinding(record.binding);

  validateOrigin(record);

  for (const stored of record.storage) {
    if (!normalized(stored.path) || path.dirname(stored.path) !== path.join(root, 'archived-tmp')) throw new Error('Shared resource storage is outside the archive namespace');
  }

  for (const pin of record.pins) {
    validatePin(record, pin);
  }

  validateOwners(record);
  validateRecovery(record);
}

function validateOrigin(record) {
  if (record.origin.path !== record.binding.path || (record.kind === 'git') !== Boolean(record.binding.git) || Boolean(record.origin.git) !== Boolean(record.binding.git)) throw new Error('Shared resource binding changed its directory or kind');

  if (record.binding.git && (record.origin.git.root !== record.binding.git.root || record.origin.git.identity !== record.binding.git.identity)) throw new Error('Shared resource changed its original checkpoint repository');
}

function validatePin(record, pin) {
  const prefix = 'refs/piop-archive-resources/' + record.id + '/';

  if (!record.origin.git || pin.root !== record.origin.git.root || pin.identity !== record.origin.git.identity || !pin.ref.startsWith(prefix) || !Check(ownership.resourceIdSchema, pin.ref.slice(prefix.length))) throw new Error('Shared resource checkpoint ownership is invalid');
}

function validateRecovery(record) {
  if (record.recovery && (record.recovery.kind !== record.kind || record.recovery.path !== record.origin.path)) throw new Error('Shared recovery does not belong to its resource');

  validateRecoveryStorage(record);
  validateRecoveryPin(record);

  if (record.restored) {
    validateBinding(record.restored.binding);

    if (JSON.stringify(record.restored.binding) !== JSON.stringify(record.binding)) throw new Error('Shared restoration receipt no longer matches its binding');
  }
}

function validateRecoveryStorage(record) {
  if (record.recovery?.kind === 'directory' && !record.storage.some(stored => stored.path === record.recovery.storedPath && stored.identity === record.recovery.storedIdentity && stored.digest === record.recovery.digest)) throw new Error('Shared recovery storage proof is missing');
}

function validateRecoveryPin(record) {
  if (record.recovery?.kind === 'git' && !record.pins.some(pin => pin.root === record.recovery.repositoryRoot && pin.identity === record.recovery.repositoryIdentity && pin.ref === record.recovery.ref && pin.commit === record.recovery.commit)) throw new Error('Shared recovery checkpoint proof is missing');
}

function load(root, id) {
  const file = resourcePath(root, id);
  const body = records.read(file);

  if (body === null) throw new Error('Shared resource record is unavailable: ' + file);
  const record = JSON.parse(body);

  validateRecord(root, record);

  if (record.id !== id) throw new Error('Shared resource record filename changed its identity');

  return { file, body, record };
}

function list(root) {
  rootDirectory(root);

  return records.list(root).map(id => load(root, id));
}

function captureBinding(location) {
  if (!Check(locationSchema, location)) throw new Error('Invalid shared archive source location');
  ownership.canonical(location.path);

  if (!fs.lstatSync(location.path).isDirectory()) throw new Error('Shared archive source is not a directory');
  const binding = { path: location.path, identity: io.identity(location.path), git: null };

  if (location.kind === 'directory') {
    verifyOrdinary(location.path);

    return binding;
  }

  const top = fs.realpathSync(io.git(location.path, ['rev-parse', '--show-toplevel']));
  const root = fs.realpathSync(io.git(location.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const registration = fs.realpathSync(io.git(location.path, ['rev-parse', '--absolute-git-dir']));

  if (top !== location.path || root === registration || io.inside(location.path, root) || !io.inside(path.join(root, 'worktrees'), registration)) throw new Error('Only the verified linked worktree can bind a shared Git resource');
  binding.git = { root, identity: io.identity(root), registration, registrationIdentity: io.identity(registration) };

  return binding;
}

function verifyOrdinary(directory) {
  try { io.git(directory, ['rev-parse', '--absolute-git-dir']); }
  catch (error) {
    if (String(error.stderr).includes('not a git repository')) return;
    throw error;
  }

  throw new Error('Ordinary shared directory became a Git checkout; its restoration binding is unavailable');
}

function sameBinding(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function verifyBinding(binding, kind) {
  const actual = captureBinding({ kind, path: binding.path });

  if (!sameBinding(actual, binding)) throw new Error('Shared restored directory was replaced; retained: ' + binding.path);

  return actual;
}

function packageChange(root, before, record, operationId) {
  validateRecord(root, record);

  if (!Check(ownership.resourceIdSchema, operationId)) throw new Error('Shared resource mutation requires its journal operation identity');

  return { version: 1, operationId, resourceId: record.id, file: resourcePath(root, record.id), before, after: JSON.stringify(record) };
}

function changedRecord(root, change) {
  if (!Check(changeSchema, change) || change.file !== resourcePath(root, change.resourceId)) throw new Error('Invalid shared resource journal change');
  const record = JSON.parse(change.after);

  validateRecord(root, record);

  if (record.id !== change.resourceId) throw new Error('Shared resource journal changed its resource identity');
  validatePrevious(root, change, record);

  return record;
}

function validatePrevious(root, change, record) {
  if (change.before === null) {
    if (record.revision !== 1) throw new Error('New shared resource has an invalid journal revision');

    return;
  }

  const before = JSON.parse(change.before);

  validateRecord(root, before);

  if (before.id !== record.id || before.revision + 1 !== record.revision || !sameBinding(before.origin, record.origin)) throw new Error('Shared resource journal changed its origin or expected revision');
}

function initialRecord(binding, kind) {
  return { version: 1, managedBy: 'piop', kind, id: randomUUID(), revision: 1, state: 'retained', origin: binding, binding, owners: [], recovery: null, restored: null, storage: [], pins: [] };
}

function planArchive(root, location, moves, operationId) {
  if (!Check(Type.Array(moveSchema, { minItems: 1 }), moves)) throw new Error('Shared archive requires verified transcript relocation mappings');
  const binding = captureBinding(location);

  if (io.inside(binding.path, root)) throw new Error('Shared resource contains its own profile storage');
  const candidates = list(root).filter(item => item.record.state !== 'retired' && sameBinding(item.record.binding, binding));

  if (candidates.length > 1) throw new Error('Multiple shared resources claim the same directory identity');
  const previous = candidates[0];
  const record = previous ? structuredClone(previous.record) : initialRecord(binding, location.kind);
  record.owners = ownership.discover(root, binding, record.id, record.owners);

  for (const move of moves) archiveOwner(root, record, move);
  const removable = record.owners.every(owner => owner.area === 'archived');
  record.revision += previous ? 1 : 0;
  record.state = removable ? 'archived' : 'retained';
  record.restored = null;
  const change = packageChange(root, previous?.body ?? null, record, operationId);

  return { change, removable, ref: 'refs/piop-archive-resources/' + record.id + '/' + operationId };
}

function planMissingArchive(root, location, moves, operationId) {
  const ids = new Set(moves.map(move => ownership.headerAt(move.source, move.sessionId).header.archiveResourceId).filter(Boolean));

  if (!ids.size) return null;

  if (ids.size !== 1 || io.exists(location.path)) throw new Error('Missing archive directory ownership is ambiguous');
  const previous = load(root, [...ids][0]);
  const record = structuredClone(previous.record);

  if (record.binding.path !== location.path || record.state === 'retired') throw new Error('Missing directory does not match saved archive ownership');
  verifyRecovery(record);
  record.owners = ownership.discover(root, record.binding, record.id, record.owners);

  for (const move of moves) archiveOwner(root, record, move);
  record.revision += 1;
  record.state = record.owners.every(owner => owner.area === 'archived') ? 'archived' : 'retained';
  record.restored = null;

  return { change: packageChange(root, previous.body, record, operationId), removable: false, ref: 'refs/piop-archive-resources/' + record.id + '/' + operationId };
}

function archiveOwner(root, record, move) {
  const owner = record.owners.find(saved => saved.sessionId === move.sessionId && saved.sessionPath === move.source);

  if (!owner || owner.area !== 'active' || owner.relative === null || !io.inside(path.join(root, 'sessions'), move.source) || !io.inside(path.join(root, 'archived'), move.destination)) throw new Error('Shared archive owner or destination cannot be verified');
  owner.sessionPath = move.destination;
  owner.area = 'archived';
  owner.identity = null;
}

function sealArchive(root, change, recovery) {
  const record = changedRecord(root, change);

  if (record.owners.some(owner => owner.area !== 'archived')) {
    if (recovery !== null) throw new Error('A surviving active or unresolved owner prevents shared directory removal');

    return change;
  }

  if (!Check(recoverySchema, recovery) || recovery.kind !== record.kind || recovery.path !== record.origin.path) throw new Error('Shared archive recovery proof is required before directory removal');

  if (recovery.kind === 'directory') retainStorage(root, record, recovery);
  else retainPin(record, recovery, change.operationId);
  record.recovery = recovery;

  return packageChange(root, change.before, record, change.operationId);
}

function assertArchiveOwners(root, change, moves) {
  const record = changedRecord(root, change);

  if (!Check(Type.Array(moveSchema), moves) || record.owners.some(owner => owner.area !== 'archived')) throw new Error('Active or unresolved shared owners prevent directory removal');
  const actual = ownership.discover(root, record.binding, record.id, record.owners);

  for (const owner of actual) {
    const planned = record.owners.find(item => item.sessionId === owner.sessionId);

    if (!planned || owner.area === 'unresolved') throw new Error('Shared directory gained an unknown owner after journaling');
    const moving = moves.some(move => move.sessionId === owner.sessionId && move.source === owner.sessionPath && move.destination === planned.sessionPath);

    if (owner.sessionPath !== planned.sessionPath && !moving) throw new Error('Shared owner moved outside its archive transaction');
  }

  verifyBinding(record.binding, record.kind);
}

function refreshArchive(root, change, moves) {
  const record = changedRecord(root, change);
  const actual = ownership.discover(root, record.binding, record.id, record.owners);

  if (actual.length !== record.owners.length || actual.some(owner => !record.owners.some(planned => planned.sessionId === owner.sessionId))) throw new Error('Shared archive gained another owner after planning');
  record.owners = actual;

  for (const move of moves) archiveOwner(root, record, move);

  return packageChange(root, change.before, record, change.operationId);
}

function retainStorage(root, record, recovery) {
  if (!normalized(recovery.storedPath) || path.dirname(recovery.storedPath) !== path.join(root, 'archived-tmp') || recovery.storedIdentity !== record.binding.identity) throw new Error('Archived directory is not the moved shared resource');
  const expected = { identity: recovery.storedIdentity, directory: true, digest: recovery.digest, excluded: [] };
  const source = io.exists(recovery.storedPath) ? recovery.storedPath : record.binding.path;

  ownership.canonical(source);

  if (!io.matches(source, expected)) throw new Error('Shared ordinary archive storage changed; retained');
  const stored = { path: recovery.storedPath, identity: recovery.storedIdentity, digest: recovery.digest };

  if (!record.storage.some(item => item.path === stored.path)) record.storage.push(stored);
}

function retainPin(record, recovery, operationId) {
  const git = record.binding.git;

  if (!git || recovery.repositoryRoot !== git.root || recovery.repositoryIdentity !== git.identity || recovery.ref !== 'refs/piop-archive-resources/' + record.id + '/' + operationId) throw new Error('Shared archive pin is outside its verified repository or resource namespace');

  if (io.identity(git.root) !== git.identity || io.refValue(git.root, recovery.ref) !== recovery.commit) throw new Error('Shared archive pin changed before publication');
  io.git(git.root, ['cat-file', '-e', recovery.commit + '^{commit}']);

  if (!record.pins.some(pin => pin.ref === recovery.ref && pin.root === git.root)) record.pins.push({ root: git.root, identity: git.identity, ref: recovery.ref, commit: recovery.commit });
}

function headerUpdates(root, change) {
  const record = changedRecord(root, change);

  return record.owners.flatMap(owner => owner.area === 'archived' && owner.sessionPath !== null && owner.relative !== null ? [{
    sessionId: owner.sessionId, sessionPath: owner.sessionPath, identity: owner.identity, archiveResourceId: record.id, checkpointRepositoryRoot: record.binding.git?.root ?? null,
    worktreeRestore: record.recovery ? { ...record.recovery, resourceId: record.id, conversationPath: path.join(record.origin.path, owner.relative) } : null,
  }] : []);
}

function resolveOwner(root, file) {
  if (!io.inside(path.join(root, 'archived'), file)) throw new Error('Shared restoration requires an archived transcript');
  const observed = ownership.headerAt(file);

  if (!observed.header.archiveResourceId) throw new Error('Archive has no shared resource identity; use the legacy restoration contract');
  const loaded = load(root, observed.header.archiveResourceId);
  const owner = loaded.record.owners.find(item => item.sessionId === observed.header.id && item.sessionPath === file && item.area === 'archived');

  if (!owner || owner.relative === null) throw new Error('Archived session does not have a verified shared resource owner binding');

  return { ...loaded, owner, observed };
}

function verifyRecovery(record) {
  const recovery = record.recovery;

  if (!recovery) throw new Error('Shared recovery descriptor is unavailable; retained');

  if (recovery.kind === 'directory') {
    ownership.canonical(recovery.storedPath);

    if (!io.matches(recovery.storedPath, { identity: recovery.storedIdentity, directory: true, digest: recovery.digest, excluded: [] })) throw new Error('Shared ordinary recovery storage changed; retained');
  } else if (io.identity(recovery.repositoryRoot) !== recovery.repositoryIdentity || io.refValue(recovery.repositoryRoot, recovery.ref) !== recovery.commit) throw new Error('Shared recovery Git root or pin changed; retained');

  return recovery;
}

function restoreAction(record) {
  if (io.exists(record.binding.path)) {
    if (record.state === 'archived' || record.state === 'retired') throw new Error('Existing restoration destination has no matching shared restoration receipt');
    verifyBinding(record.binding, record.kind);

    if (record.state === 'restored' && !record.restored) throw new Error('Shared restoration receipt is unavailable');

    return 'reuse';
  }

  if (record.owners.some(owner => owner.area !== 'archived')) throw new Error('A surviving active or unresolved resource owner has an unavailable directory; retained');
  verifyRecovery(record);

  return record.kind === 'directory' ? 'copy-directory' : 'create-git';
}

function planRestore(root, file, destination, operationId) {
  const loaded = resolveOwner(root, file);
  const record = structuredClone(loaded.record);
  const action = restoreAction(record);

  if (!io.inside(path.join(root, 'sessions'), destination) || io.exists(destination)) throw new Error('Shared restoration transcript destination is invalid or occupied');
  record.owners = ownership.discover(root, record.binding, record.id, record.owners);
  const owner = record.owners.find(item => item.sessionId === loaded.owner.sessionId && item.sessionPath === file);

  if (!owner || owner.area !== 'archived') throw new Error('Shared archive owner changed during restoration planning');
  owner.sessionPath = destination;
  owner.area = 'active';
  owner.identity = null;
  record.revision += 1;
  const change = packageChange(root, loaded.body, record, operationId);

  return { change, action, recovery: record.recovery, binding: record.binding, sourceIdentity: loaded.observed.identity, sessionId: owner.sessionId, conversationPath: path.join(record.origin.path, owner.relative) };
}

function sealRestore(root, change, proof) {
  const record = changedRecord(root, change);

  if (!Check(creationSchema, proof) || proof.resourceId !== record.id || proof.operationId !== change.operationId) throw new Error('Restored resource requires matching transaction creation proof');
  const previous = JSON.parse(change.before);
  const observed = restorationSource(previous, record, proof);
  const binding = captureBinding({ kind: record.kind, path: record.origin.path });

  verifyCreation(previous, binding, proof);
  record.binding = binding;
  record.restored = { operationId: change.operationId, sessionId: proof.sessionId, sourcePath: observed.path, sourceIdentity: observed.identity, binding };
  record.state = 'restored';

  return packageChange(root, change.before, record, change.operationId);
}

function adoptRestore(root, migration, proof) {
  if (!Check(creationSchema, proof) || !proof.created || proof.resourceId !== migration.resourceId || proof.operationId !== migration.operationId) throw new Error('Legacy shared restoration has no matching creation proof');
  const binding = captureBinding({ kind: migration.kind, path: migration.path });

  if (binding.identity !== proof.directoryIdentity) throw new Error('Legacy restored directory ownership changed');
  const record = initialRecord(binding, migration.kind);
  record.id = migration.resourceId;
  record.state = 'restored';
  record.owners = migration.owners.map(owner => ({ ...owner, sessionPath: owner.sessionId === proof.sessionId ? migration.destination : owner.sessionPath, area: owner.sessionId === proof.sessionId ? 'active' : 'archived' }));
  const source = migration.owners.find(owner => owner.sessionId === proof.sessionId);

  if (!source || source.identity !== proof.sourceIdentity) throw new Error('Legacy restoration source identity changed');
  record.restored = { operationId: migration.operationId, sessionId: proof.sessionId, sourcePath: source.sessionPath, sourceIdentity: source.identity, binding };
  record.recovery = migration.recovery;

  if (migration.kind === 'directory') record.storage.push({ path: migration.recovery.storedPath, identity: migration.recovery.storedIdentity, digest: migration.recovery.digest });
  else retainPin(record, migration.recovery, migration.operationId);

  return packageChange(root, null, record, migration.operationId);
}

function restorationSource(previous, record, proof) {
  const owner = previous.owners.find(item => item.sessionId === proof.sessionId && item.area === 'archived');
  const active = record.owners.find(item => item.sessionId === proof.sessionId && item.area === 'active');

  if (!owner || !active || !owner.sessionPath) throw new Error('Restoration transaction does not bind the archived session to this resource');
  const { header, identity } = ownership.headerAt(owner.sessionPath);

  if (header.id !== proof.sessionId || header.archiveResourceId !== record.id || identity !== proof.sourceIdentity) throw new Error('Restoration source no longer owns this resource');

  return { path: owner.sessionPath, identity };
}

function verifyCreation(previous, binding, proof) {
  if (binding.identity !== proof.directoryIdentity || !proof.created && !sameBinding(binding, previous.binding)) throw new Error('Restored directory lacks its transaction or prior resource identity proof');

  if (binding.git && (binding.git.root !== previous.binding.git?.root || binding.git.identity !== previous.binding.git?.identity)) throw new Error('Restored checkout uses a different checkpoint repository');
}

function selectedOwners(record, targets) {
  const selected = new Set();

  for (const target of targets) {
    if (record.owners.some(owner => owner.sessionId === target.sessionId && owner.sessionPath === target.path)) selected.add(target.sessionId);
  }

  return selected;
}

function planDelete(root, targets, operationId) {
  if (!Check(Type.Array(Type.Object({ path: Type.String(), sessionId: Type.String({ minLength: 1 }) })), targets)) throw new Error('Shared resource deletion requires explicit session identities');
  const changes = [];

  for (const loaded of list(root)) {
    if (loaded.record.state === 'retired') continue;
    const record = structuredClone(loaded.record);
    record.owners = ownership.discover(root, record.binding, record.id, record.owners);
    const selected = selectedOwners(record, targets);

    if (!selected.size && JSON.stringify(record.owners) === JSON.stringify(loaded.record.owners)) continue;
    record.owners = record.owners.filter(owner => !selected.has(owner.sessionId));
    record.revision += 1;

    if (!record.owners.length) record.state = 'retired';
    changes.push(packageChange(root, loaded.body, record, operationId));
  }

  return changes;
}

function cleanupPlan(root, change) {
  const record = changedRecord(root, change);

  if (record.state !== 'retired' || record.owners.length) return { storage: [], pins: [] };
  const previous = JSON.parse(change.before);
  const selected = new Set(previous.owners.map(owner => owner.sessionId));
  const surviving = ownership.discover(root, previous.binding, previous.id, []);

  if (surviving.some(owner => !selected.has(owner.sessionId))) throw new Error('A new durable shared resource owner prevents cleanup');

  for (const stored of record.storage) {
    if (!io.matches(stored.path, { identity: stored.identity, directory: true, digest: stored.digest, excluded: [] })) throw new Error('Shared archive storage cleanup proof changed; retained');
  }

  for (const pin of record.pins) {
    if (io.identity(pin.root) !== pin.identity || io.refValue(pin.root, pin.ref) !== pin.commit) throw new Error('Shared archive pin cleanup proof changed; retained');
  }

  return { storage: record.storage, pins: record.pins };
}

function apply(root, change) {
  const record = changedRecord(root, change);
  const current = records.read(change.file);

  if (current === change.after) return;

  if (current !== change.before) throw new Error('Shared resource changed after journaling; retained for reconciliation');

  if (record.state === 'archived') {
    if (io.exists(record.binding.path)) throw new Error('Shared archive directory removal has not committed');
    verifyRecovery(record);
  }

  records.change(change.file, change.before, change.after);
}

function rollback(root, change) {
  changedRecord(root, change);
  const current = records.read(change.file);

  if (current === change.before) return;

  if (current !== change.after) throw new Error('Shared resource rollback has conflicting ownership; retained');

  records.change(change.file, change.after, change.before);
}

module.exports = { load, list, validate: changedRecord, planArchive, planMissingArchive, assertArchiveOwners, refreshArchive, sealArchive, headerUpdates, planRestore, sealRestore, adoptRestore, planDelete, cleanupPlan, apply, rollback };
