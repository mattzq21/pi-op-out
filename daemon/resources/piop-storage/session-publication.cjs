const stateRecords = require('./session-records.cjs');
const goals = require('./goals.cjs');
const registry = require('../session-registry.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const io = require('./session-publication-io.cjs');
const reviews = require('./review-publication.cjs');
const dependencies = require('./session-publication-dependencies.cjs');
const children = require('../session-broker/session-child-index.cjs');
const database = require('../session-database.cjs');

const identitySchema = Type.String({ pattern: '^\\d+:\\d+$' });

const journalSchema = Type.Object({
  version: Type.Literal(1), kind: Type.Literal('session-publication'), id: io.uuid, root: Type.String(), rootIdentity: identitySchema,
  target: Type.String(), directoryIdentity: identitySchema, temporary: Type.String(), sessionId: io.uuid,
  bytes: Type.Integer({ minimum: 1 }), digest: Type.String({ pattern: '^[a-f0-9]{64}$' }), lock: Type.String(), lockIdentity: identitySchema,
  writer: io.writerSchema, phase: Type.Union(['planned', 'writing', 'ready', 'linked', 'parent-pending', 'quarantined'].map(value => Type.Literal(value))),
  temporaryIdentity: Type.Optional(identitySchema), review: Type.Optional(reviews.reviewSchema),
  state: Type.Array(Type.Unknown()),
  dependencies: Type.Optional(dependencies.contractSchema), preparationComplete: Type.Optional(Type.Boolean()),
  quarantine: Type.Optional(Type.Object({ path: Type.String(), reason: Type.String() })),
});

const recordSchema = Type.Object({ type: Type.String() });

const leases = new Map();

class SessionPublicationError extends Error {
  constructor(message, publicationPending, journalPath) {
    super(message);
    this.name = 'SessionPublicationError';
    this.publicationPending = publicationPending;
    this.journalPath = journalPath;
    this.dependenciesRetained = true;
  }
}

function save(journal) { database.savePublication(journal.root, journal.id, journal); }

function validate(root, journal, file) {
  if (!Check(journalSchema, journal) || journal.root !== root || file !== io.journalPath(root, journal.id)) throw new Error(`Unowned publication journal retained: ${file}`);

  if (journal.rootIdentity !== io.identity(root) || !io.inside(path.join(root, 'sessions'), journal.target)) throw new Error(`Publication storage identity changed; retained: ${file}`);

  if (!io.canonical(path.dirname(journal.target)) || journal.directoryIdentity !== io.identity(path.dirname(journal.target))) throw new Error(`Publication target directory changed; retained: ${file}`);
  validatePaths(journal);
  validateDependencies(journal);
}

function validateDependencies(journal) {
  if (journal.dependencies) dependencies.validate(journal.root, journal.sessionId, journal.dependencies);

  if (journal.quarantine && ![journal.temporary, path.join(journal.root, 'session-publication-quarantine', journal.id, 'transcript.jsonl.part')].includes(journal.quarantine.path)) throw new Error('Publication quarantine mapping is ambiguous; retained');
}

function validatePaths(journal) {
  if (!path.basename(journal.target).endsWith(`_${journal.sessionId}.jsonl`) || journal.temporary !== `${journal.target}.${journal.id}.tmp`) throw new Error('Publication target mapping is ambiguous; retained');

  if (journal.lock !== io.lockPath(journal.root, journal.target) || !io.matches(journal.lock, journal.lockIdentity)) throw new Error('Publication writer lock identity changed; retained');

  if (journal.review && (journal.review.record.sessionId !== journal.sessionId || journal.review.record.publicationId !== journal.id || journal.review.record.sessionPath !== journal.target)) throw new Error('Review publication identity changed; retained');
}

function load(root, file) {
  const journal = database.publication(root, path.basename(file, '.json'));
  validate(root, journal, file);

  return journal;
}

function journalFiles(root) {
  return database.publications(root).map(id => io.journalPath(root, id));
}

function temporaryPaths(root) { return journalFiles(root).map(file => load(root, file).temporary); }

function prepareBody(body, id) {
  if (!body.endsWith('\n')) throw new Error('Session publication requires complete JSONL records');
  const values = body.split('\n').flatMap(line => line ? [JSON.parse(line)] : []);

  const header = values[0];

  if (!Check(io.headerSchema, header) || !values.every(value => Check(recordSchema, value))) throw new Error('Session publication requires a valid session transcript');
  values[0] = { ...header, piopPublicationId: id, piopChildIndexVersion: 1 };

  return { header: values[0], entries: values, body: values.map(value => JSON.stringify(value)).join('\n') + '\n' };
}

function prepare(root, target, body, options) {
  const id = options.review?.record.publicationId ?? randomUUID();

  if (!Check(io.uuid, id)) throw new Error('Invalid session publication identity');
  const prepared = prepareBody(body, id);
  registry.bindSession(root, prepared.header.id, target);


  if (!path.basename(target).endsWith(`_${prepared.header.id}.jsonl`) || io.exists(target)) throw new Error('Session publication target is occupied or does not bind its session identity');
  const lock = io.lockPath(root, target);
  io.mkdir(path.dirname(lock));
  const lease = io.claim(lock);

  if (lease === null) throw new Error('Another writer owns this session publication');

  try { return prepareJournal(root, target, prepared, id, lock, lease, options); }
  catch (error) { fs.closeSync(lease); throw error; }
}

function prepareJournal(root, target, prepared, id, lock, lease, options) {
  const contract = dependencies.plan(root, prepared.entries, options.dependencies);
  if (options.goalSource) goals.copy(options.goalSource, target, prepared.header.id);
  prepared.header = { ...prepared.header, goalAssets: contract.goalAssets };
  prepared.entries[0] = prepared.header;
  prepared.body = stateRecords.stored(prepared.entries).map(value => JSON.stringify(value)).join('\n') + '\n';

  const journal = {
    version: 1, kind: 'session-publication', id, root, rootIdentity: io.identity(root), target, directoryIdentity: io.identity(path.dirname(target)),
    temporary: `${target}.${id}.tmp`, sessionId: prepared.header.id, bytes: Buffer.byteLength(prepared.body), digest: io.hash(prepared.body),
    lock, lockIdentity: io.identity(lock), writer: io.writer(), phase: 'planned', dependencies: contract, state: stateRecords.capture(prepared.entries),
  };

  if (options.beforeWrite) {
    if (!(options.beforeWrite instanceof Function)) throw new Error('Publication preparation must be a callback');
    journal.preparationComplete = false;
  }

  if (options.review) journal.review = reviews.prepare(root, { ...options.review, target }, prepared.header, id, prepared.entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");

  if (database.publication(root, id)) throw new Error('Session publication operation identity is already in use');
  io.sync(lock);
  io.sync(path.dirname(lock));

  try { save(journal); }
  catch (error) { if (database.publication(root, id)) throw failedPublication(journal, error); throw error; }

  return { journal, body: prepared.body, lease };
}

function writeTemporary(operation) {
  const journal = operation.journal;

  const descriptor = fs.openSync(journal.temporary, 'wx', 0o600);

  try {
    journal.temporaryIdentity = io.identity(journal.temporary);
    journal.phase = 'writing';
    save(journal);
    fs.writeFileSync(descriptor, operation.body);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }

  io.sync(path.dirname(journal.temporary));
  journal.phase = 'ready';
  save(journal);
}

function removeTemporary(journal) {
  if (!io.exists(journal.temporary)) return;

  if (!journal.temporaryIdentity || !io.matches(journal.temporary, journal.temporaryIdentity)) throw new Error(`Unowned temporary transcript retained: ${journal.temporary}`);
  fs.unlinkSync(journal.temporary);
  io.sync(path.dirname(journal.temporary));
}

function retire(journal) {
  database.removePublication(journal.root, journal.id);
}

function complete(journal, location) {
  io.sync(location.path);
  io.sync(path.dirname(location.path));
  children.registerTranscript(journal.root, location.path, io.read(location.path).body);
  journal.phase = journal.review ? 'parent-pending' : 'linked';
  save(journal);
  removeTemporary(journal);

  if (!journal.review) retire(journal);
}

function handle(journal, warnings = []) {
  return { id: journal.id, root: journal.root, sessionPath: journal.target, warnings };
}

function linked(journal) {
  let header;

  try { header = io.header(journal.target); }
  catch (error) { throw new SessionPublicationError(`Publication ownership is pending at ${io.journalPath(journal.root, journal.id)}; retain its dependent resources: ${error.message}`, true, io.journalPath(journal.root, journal.id)); }

  return header?.id === journal.sessionId && header.piopPublicationId === journal.id;
}

function failedPublication(journal, error) {
  const file = io.journalPath(journal.root, journal.id);

  try {
    quarantine(journal, `Handled session publication failure: ${error.message}`);

    return new SessionPublicationError(`${error.message}\nSession publication residue is retained at ${file}`, false, file);
  } catch (failure) {
    return new SessionPublicationError(`${error.message}\nPublication disposition is pending at ${file}; retain its dependent resources: ${failure.message}`, true, file);
  }
}

async function publishLocked(root, target, body, options) {
  const operation = prepare(root, target, body, options);

  const journal = operation.journal;

  let retained = false;

  try {
    dependencies.retain(journal);
    stateRecords.seed(journal.target, journal.sessionId, journal.state);

    if (options.beforeWrite) { await options.beforeWrite(); journal.preparationComplete = true; save(journal); }

    writeTemporary(operation);
    children.registerTranscript(root, journal.target, operation.body);
    fs.linkSync(journal.temporary, journal.target);
    complete(journal, { path: journal.target });

    if (journal.review) { leases.set(journal.id, operation.lease); retained = true; }

    return handle(journal);
  } catch (error) {
    if (!linked(journal)) throw failedPublication(journal, error);

    if (journal.review) { leases.set(journal.id, operation.lease); retained = true; }

    const warning = `Session was published; durability or cleanup will retry from ${io.journalPath(root, journal.id)}: ${error.message}`;
    console.error(warning);

    return handle(journal, [warning]);
  } finally { if (!retained) fs.closeSync(operation.lease); }
}

function publish(target, body, withReferences, options = {}) {
  const root = io.rootForTarget(target);

  return io.lockedAsync(root, () => withReferences(() => publishLocked(root, target, body, options)));
}

function quarantine(journal, reason) {
  const owned = journal.temporaryIdentity && io.matches(journal.temporary, journal.temporaryIdentity);

  const destination = owned ? path.join(journal.root, 'session-publication-quarantine', journal.id, 'transcript.jsonl.part') : journal.temporary;
  journal.phase = 'quarantined';
  journal.quarantine = { path: destination, reason };
  save(journal);

  if (owned) moveQuarantine(journal, destination);

  return journal.quarantine;
}

function moveQuarantine(journal, destination) {
  io.mkdir(path.dirname(destination));

  if (!io.exists(destination)) fs.linkSync(journal.temporary, destination);

  if (!io.matches(destination, journal.temporaryIdentity)) throw new Error(`Quarantine destination ownership changed; retained: ${destination}`);
  io.sync(destination);
  io.sync(path.dirname(destination));
  removeTemporary(journal);
}

function recoverUnlinked(journal) {
  if (io.unregistered(journal.root, journal.sessionId, journal.target)) return quarantine(journal, 'This session no longer owns its reserved path; the captured publication was retained');

  if (journal.phase === 'linked' || journal.phase === 'parent-pending') return quarantine(journal, 'Previously published session no longer has an authoritative owned location');

  if (!io.verified(journal.temporary, journal)) return quarantine(journal, 'Incomplete or unowned temporary transcript retained for inspection');

  if (io.exists(journal.target)) return quarantine(journal, 'Publication target belongs to another transcript; both files were retained');
  verifyPreparation(journal);
  dependencies.retain(journal);
  stateRecords.seed(journal.target, journal.sessionId, journal.state);
  journal.temporaryIdentity = io.identity(journal.temporary);
  journal.phase = 'ready';
  save(journal);
  io.sync(journal.temporary);
  io.sync(path.dirname(journal.temporary));
  children.registerTranscript(journal.root, journal.target, io.read(journal.temporary).body);
  fs.linkSync(journal.temporary, journal.target);

  return null;
}

function recoverJournal(journal, result) {
  if (journal.phase === 'quarantined') {
    if (journal.quarantine && journal.quarantine.path !== journal.temporary && io.exists(journal.temporary)) moveQuarantine(journal, journal.quarantine.path);
    result.quarantined.push(journal.quarantine ?? { path: io.journalPath(journal.root, journal.id), reason: 'Publication residue retained' });

    return;
  }

  let location = io.locate(journal.root, journal.sessionId, journal.id);

  if (!location) {
    const retained = recoverUnlinked(journal);

    if (retained) { result.quarantined.push(retained);

    return; }

    location = { path: journal.target };
  }

  complete(journal, location);
  result.recovered.push(location.path);

  if (journal.review) {
    if (reviews.reattach(journal)) retire(journal);
    else result.pendingReviews.push(reviews.currentRecord(journal));
  }
}

function recoverFile(root, file, result) {
  let lease;

  try {
    const journal = load(root, file);
    lease = io.claim(journal.lock, journal.lockIdentity);

    if (lease === null || !io.writerDead(journal.writer)) { result.active.push(file);

    return; }

    recoverJournal(journal, result);
  } catch (error) { result.warnings.push(`${file}: ${error.message}`); }
  finally { if (lease !== undefined && lease !== null) fs.closeSync(lease); }
}

function recover(root) {
  return io.locked(root, () => {
    const result = { recovered: [], pendingReviews: [], quarantined: [], active: [], warnings: [] };

    for (const file of journalFiles(root)) recoverFile(root, file, result);

    return result;
  });
}

function release(publication) {
  const lease = leases.get(publication.id);

  if (lease === undefined) return;
  leases.delete(publication.id);
  fs.closeSync(lease);
}

async function acknowledge(publication) {
  try {
    return await io.lockedAsync(publication.root, () => {
      const journal = load(publication.root, io.journalPath(publication.root, publication.id));

      if (!journal.review || !reviews.acknowledge(journal)) return false;
      const location = io.locate(journal.root, journal.sessionId, journal.id);

      if (!location) return false;
      complete(journal, location);
      retire(journal);

      return true;
    });
  } finally { release(publication); }
}

async function pendingReviews(parentPath, parentId) {
  if (!io.exists(parentPath)) return [];
  const root = io.rootForTarget(parentPath);

  if (!journalFiles(root).length) return [];

  return io.lockedAsync(root, () => {
    if (!io.exists(parentPath)) return [];
    const result = [];

    try {
      for (const file of journalFiles(root)) pendingReview(root, file, parentId, result);

      if (result.length) {
        const parent = io.header(parentPath);

        if (!parent || parent.id !== parentId) throw new Error('Live review publication requires its actual original parent');
      }
    }
    catch (error) { for (const pending of result) release(pending.publication); throw error; }

    return result;
  });
}

function retainedDependencies(root) {
  return io.locked(root, () => journalFiles(root).map(file => {
    const journal = load(root, file);

    const candidates = [journal.target, journal.temporary, journal.quarantine?.path].filter(Boolean);

    const transcriptPaths = [...new Set(candidates)].filter(candidate => io.verified(candidate, journal));

    return { kind: 'publication-diagnostic', sessionId: journal.sessionId, journalPath: file, transcriptPaths, dependencies: journal.dependencies };
  }));
}

function pendingReview(root, file, parentId, result) {
  const journal = load(root, file);

  if (!journal.review || journal.phase === 'quarantined' || journal.review.record.parentSessionId !== parentId) return;

  if (journal.parentRepair) throw new Error(`Review parent repair is pending at ${file}; restart after closing its writer`);
  const lease = io.claim(journal.lock, journal.lockIdentity);

  if (lease === null) return;

  try {
    const record = reviews.currentRecord(journal);
    leases.set(journal.id, lease);
    result.push({ publication: handle(journal), record });
  } catch (error) { fs.closeSync(lease); throw error; }
}

function reviewVisibility(file, parentId) {
  try {
    const root = io.rootForTarget(file);

    return io.locked(root, () => visibleReview(root, file, parentId));
  } catch (_error) { return 'pending'; }
}

function visibleReview(root, file, parentId) {
  const child = io.header(file);

  if (!child) return null;
  const parent = io.locate(root, parentId);

  if (parent) {
    const saved = stateRecords.merge(parent.path, JSON.parse(`[${io.read(parent.path).body.trim().split('\n').join(',')}]`));

    if (saved.some(entry => Check(recordSchema, entry) && entry.type === 'custom' && entry.customType === 'piop-review' && entry.data?.sessionId === child.id && entry.data.parentSessionId === parentId)) return null;
  }

  if (!child.piopPublicationId) return 'legacy';
  const journalFile = io.journalPath(root, child.piopPublicationId);

  if (!database.publication(root, child.piopPublicationId)) return 'pending';
  const journal = load(root, journalFile);

  const lease = io.claim(journal.lock, journal.lockIdentity);

  if (lease === null) return null;
  fs.closeSync(lease);

  return 'pending';
}

module.exports = { temporaryPaths, SessionPublicationError, publish, recover, retainedDependencies, pendingReviews, acknowledge, release, reviewVisibility };

function verifyPreparation(journal) {
  if (journal.preparationComplete === false) throw new Error("Publication preparation is incomplete; retained without replaying its callback");
}
