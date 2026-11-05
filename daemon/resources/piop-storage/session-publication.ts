import * as stateRecords from './session-records.ts';
import * as goals from './goals.ts';
import * as registry from '../session-registry.ts';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import * as io from './session-publication-io.ts';
import * as links from './auxiliary-link-publication.ts';
import * as dependencies from './session-publication-dependencies.ts';
import * as children from '../session-broker/session-child-index.ts';
import * as names from '../session-broker/session-names.ts';
import * as database from '../session-database.ts';

// Where an auxiliary chat of a plugin is saved, as its parent records it.
export interface AuxiliaryLinkRecord {
  kind: string;
  sessionId: string;
  sessionPath: string;
  cwd: string;
  parentSessionId: string;
  hostId: string;
  publicationId: string;
}

export interface PublicationOptions {
  name?: string;
  goalSource?: string;
  // Publishes an auxiliary chat, then links it from its parent with a core record and the plugin's own message.
  link?: { record: AuxiliaryLinkRecord; parentSessionPath: string; message: { customType: string; content: string } };
  dependencies?: {
    workspace?: { path: string; kind: "existing" | "created-directory" };
  };
  beforeWrite?: () => void | Promise<void>;
}

export interface PublicationDependencies {
  version: 1;
  workspace: { path: string; kind: "existing" | "created-directory"; identity: string };
  goalAssets: { version: 1; policy: "shared-profile"; directories: { path: string; identity: string }[] };
}

export interface DiagnosticPublication {
  kind: "publication-diagnostic";
  sessionId: string;
  journalPath: string;
  transcriptPaths: string[];
  dependencies?: PublicationDependencies;
}

export interface SessionPublication {
  id: string;
  root: string;
  sessionPath: string;
  warnings: string[];
}

export interface PublicationRecovery {
  recovered: string[];
  pendingLinks: AuxiliaryLinkRecord[];
  quarantined: { path: string; reason: string }[];
  active: string[];
  warnings: string[];
}


const identitySchema = Type.String({ pattern: '^\\d+:\\d+$' });

const journalSchema = Type.Object({
  version: Type.Literal(1), kind: Type.Literal('session-publication'), id: io.uuid, root: Type.String(), rootIdentity: identitySchema,
  target: Type.String(), directoryIdentity: identitySchema, temporary: Type.String(), sessionId: io.uuid,
  bytes: Type.Integer({ minimum: 1 }), digest: Type.String({ pattern: '^[a-f0-9]{64}$' }), lock: Type.String(),
  phase: Type.Union([Type.Literal('planned'), Type.Literal('writing'), Type.Literal('ready'), Type.Literal('linked'), Type.Literal('parent-pending'), Type.Literal('quarantined')]),
  temporaryIdentity: Type.Optional(identitySchema), link: Type.Optional(links.linkSchema),
  state: Type.Array(Type.Unknown()), name: Type.Optional(Type.String({ minLength: 1 })),
  dependencies: Type.Optional(dependencies.contractSchema), preparationComplete: Type.Optional(Type.Boolean()),
  quarantine: Type.Optional(Type.Object({ path: Type.String(), reason: Type.String() })),
});

type PublicationJournal = Static<typeof journalSchema> & { parentRepair?: unknown };

const recordSchema = Type.Object({ type: Type.String() });

const leases = new Map();

class SessionPublicationError extends Error {
  publicationPending: boolean;
  dependenciesRetained: boolean;
  journalPath: string;

  constructor(message: string, publicationPending: boolean, journalPath: string) {
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

  if (journal.lock !== io.lockName(journal.target)) throw new Error('Publication writer lock changed; retained');

  if (journal.link && (journal.link.record.sessionId !== journal.sessionId || journal.link.record.publicationId !== journal.id || journal.link.record.sessionPath !== journal.target)) throw new Error('Auxiliary chat publication identity changed; retained');
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

function seedState(journal) {
  stateRecords.seed(journal.target, journal.sessionId, journal.state);
  if (journal.name !== undefined) names.nameSession(journal.target, journal.sessionId, journal.name);
}

function prepare(root, target, body, options) {
  const id = options.link?.record.publicationId ?? randomUUID();

  if (!Check(io.uuid, id)) throw new Error('Invalid session publication identity');
  const prepared = prepareBody(body, id);
  registry.bindSession(root, prepared.header.id, target);


  if (!path.basename(target).endsWith(`_${prepared.header.id}.jsonl`) || io.exists(target)) throw new Error('Session publication target is occupied or does not bind its session identity');
  const lock = io.lockName(target);
  const lease = io.claim(lock);

  if (lease === null) throw new Error('Another writer owns this session publication');

  try { return prepareJournal(root, target, prepared, id, lock, lease, options); }
  catch (error) { lease(); throw error; }
}

function prepareJournal(root, target, prepared, id, lock, lease, options) {
  if (prepared.entries.some(stateRecords.isName)) throw new Error('A new chat gets its name from the publication name, not from its entries');
  const name = options.name === undefined ? undefined : names.validName(options.name);
  const contract = dependencies.plan(root, prepared.entries, options.dependencies);
  if (options.goalSource) goals.copy(options.goalSource, target, prepared.header.id);
  prepared.header = { ...prepared.header, goalAssets: contract.goalAssets };
  prepared.entries[0] = prepared.header;
  prepared.body = stateRecords.stored(prepared.entries).map(value => JSON.stringify(value)).join('\n') + '\n';

  const journal: PublicationJournal = {
    version: 1, kind: 'session-publication', id, root, rootIdentity: io.identity(root), target, directoryIdentity: io.identity(path.dirname(target)),
    temporary: `${target}.${id}.tmp`, sessionId: prepared.header.id, bytes: Buffer.byteLength(prepared.body), digest: io.hash(prepared.body),
    lock, phase: 'planned', dependencies: contract, state: stateRecords.capture(prepared.entries), ...name ? { name } : {},
  };

  if (options.beforeWrite) {
    if (!(options.beforeWrite instanceof Function)) throw new Error('Publication preparation must be a callback');
    journal.preparationComplete = false;
  }

  if (options.link) journal.link = links.prepare(root, { ...options.link, target }, prepared.header, id, prepared.entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");

  if (database.publication(root, id)) throw new Error('Session publication operation identity is already in use');

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
  journal.phase = journal.link ? 'parent-pending' : 'linked';
  save(journal);
  removeTemporary(journal);

  if (!journal.link) retire(journal);
}

function handle(journal, warnings: string[] = []) {
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
    seedState(journal);

    if (options.beforeWrite) { await options.beforeWrite(); journal.preparationComplete = true; save(journal); }

    writeTemporary(operation);
    children.registerTranscript(root, journal.target, operation.body);
    fs.linkSync(journal.temporary, journal.target);
    complete(journal, { path: journal.target });

    if (journal.link) { leases.set(journal.id, operation.lease); retained = true; }

    return handle(journal);
  } catch (error) {
    if (!linked(journal)) throw failedPublication(journal, error);

    if (journal.link) { leases.set(journal.id, operation.lease); retained = true; }

    const warning = `Session was published; durability or cleanup will retry from ${io.journalPath(root, journal.id)}: ${error.message}`;
    console.error(warning);

    return handle(journal, [warning]);
  } finally { if (!retained) operation.lease(); }
}

function publish(target: string, body: string, withReferences: (operation: () => Promise<SessionPublication>) => Promise<SessionPublication>, options: PublicationOptions = {}): Promise<SessionPublication> {
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
  seedState(journal);
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

  let location: { path: string } | undefined = io.locate(journal.root, journal.sessionId, journal.id);

  if (!location) {
    const retained = recoverUnlinked(journal);

    if (retained) { result.quarantined.push(retained);

    return; }

    location = { path: journal.target };
  }

  complete(journal, location);
  result.recovered.push(location.path);

  if (journal.link) {
    if (links.reattach(journal)) retire(journal);
    else result.pendingLinks.push(links.currentRecord(journal));
  }
}

function recoverFile(root, file, result) {
  let lease;

  try {
    const journal = load(root, file);
    lease = io.claim(journal.lock);

    // A writer in this daemon holds the lock while it works on the publication.
    if (lease === null) { result.active.push(file);

    return; }

    recoverJournal(journal, result);
  } catch (error) { result.warnings.push(`${file}: ${error.message}`); }
  finally { lease?.(); }
}

function recover(root: string): PublicationRecovery {
  return io.locked(root, () => {
    const result = { recovered: [], pendingLinks: [], quarantined: [], active: [], warnings: [] };

    for (const file of journalFiles(root)) recoverFile(root, file, result);

    return result;
  });
}

function release(publication: Pick<SessionPublication, 'id' | 'root'>): void {
  const lease = leases.get(publication.id);

  if (lease === undefined) return;
  leases.delete(publication.id);
  lease();
}

async function acknowledge(publication: SessionPublication): Promise<boolean> {
  try {
    return await io.lockedAsync(publication.root, () => {
      const journal = load(publication.root, io.journalPath(publication.root, publication.id));

      if (!journal.link || !links.acknowledge(journal)) return false;
      const location = io.locate(journal.root, journal.sessionId, journal.id);

      if (!location) return false;
      complete(journal, location);
      retire(journal);

      return true;
    });
  } finally { release(publication); }
}

// The auxiliary chats of one kind whose link to this parent is not saved yet.
async function pendingLinks(parentPath: string, parentId: string, kind: string): Promise<{ publication: SessionPublication; record: AuxiliaryLinkRecord }[]> {
  if (!io.exists(parentPath)) return [];
  const root = io.rootForTarget(parentPath);

  if (!journalFiles(root).length) return [];

  return io.lockedAsync(root, () => {
    if (!io.exists(parentPath)) return [];
    const result: { publication: SessionPublication; record: AuxiliaryLinkRecord }[] = [];

    try {
      for (const file of journalFiles(root)) pendingLink(root, file, parentId, kind, result);

      if (result.length) {
        const parent = io.header(parentPath);

        if (!parent || parent.id !== parentId) throw new Error('Live auxiliary chat publication requires its actual original parent');
      }
    }
    catch (error) { for (const pending of result) release(pending.publication); throw error; }

    return result;
  });
}

function retainedDependencies(root: string): DiagnosticPublication[] {
  return io.locked(root, () => readRetainedDependencies(root));
}

function awaitRetainedDependencies(root: string): Promise<DiagnosticPublication[]> {
  return io.lockedAsync(root, () => readRetainedDependencies(root));
}

function readRetainedDependencies(root) {
  return journalFiles(root).map(file => {
    const journal = load(root, file);

    const candidates = [journal.target, journal.temporary, journal.quarantine?.path].filter(Boolean);

    const transcriptPaths = [...new Set(candidates)].filter(candidate => io.verified(candidate, journal));

    return { kind: 'publication-diagnostic', sessionId: journal.sessionId, journalPath: file, transcriptPaths, dependencies: journal.dependencies };
  });
}

function pendingLink(root, file, parentId, kind, result) {
  const journal = load(root, file);

  if (!journal.link || journal.phase === 'quarantined' || journal.link.record.parentSessionId !== parentId || journal.link.record.kind !== kind) return;

  if (journal.parentRepair) throw new Error(`Auxiliary chat parent repair is pending at ${file}; restart after closing its writer`);
  const lease = io.claim(journal.lock);

  if (lease === null) return;

  try {
    const record = links.currentRecord(journal);
    leases.set(journal.id, lease);
    result.push({ publication: handle(journal), record });
  } catch (error) { lease(); throw error; }
}

export { temporaryPaths, SessionPublicationError, publish, recover, retainedDependencies, awaitRetainedDependencies, pendingLinks, acknowledge, release };

function verifyPreparation(journal) {
  if (journal.preparationComplete === false) throw new Error("Publication preparation is incomplete; retained without replaying its callback");
}
