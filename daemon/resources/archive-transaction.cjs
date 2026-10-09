const conversationStorage = require('./conversation-storage.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const io = require('./session-transactions.cjs');
const { canonicalTranscriptBasename } = require('./transcript-identity.cjs');
const records = require('./archive-records.cjs');

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function save(transaction) {
  records.save(transaction.container, transaction);
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

  const before = conversationStorage.read(file);

  if (before === null) return [];
  const record = JSON.parse(before);

  return [{ sessionId: id, file, before, after: JSON.stringify({ ...record, deleted: true, client: null }) }];
}

function finishOwnership(transaction) {
  for (const owner of transaction.ownerships ?? []) {
    const current = conversationStorage.required(owner.file);

    if (current !== owner.before && current !== owner.after) throw new Error('Archived conversation ownership changed');
    conversationStorage.write(owner.file, owner.after);
  }
}

function plan(root, records) {
  const destinations = archiveDestinations(root, records);
  const id = randomUUID();

  const container = path.join(root, 'archive-transactions', id);

  require('./archive-records.cjs').allocate(container);
  io.mkdir(container);

  const plannedRecords = records.map((record, index) => {
    const destination = destinations[index];

    return {
      file: record.file, sessionId: record.header.id,
      original: io.describe(record.file), mode: fs.statSync(record.file).mode & 0o777, destination,
      backup: path.join(container, `${index}.original`), prepared: path.join(container, `${index}.prepared`),
      rollbackCopy: path.join(container, `${index}.rollback`), moves: sidecars(record.file, destination),
    };
  });

  const transaction = { version: 3, kind: 'archive', id, root, container, containerIdentity: io.identity(container), state: 'planned', records: plannedRecords, ownerships: records.flatMap(record => archiveOwnership(root, record.header.id)) };
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
    [`${file}.loop-detection.json`, `${destination}.loop-detection.json`],
  ];
}

function load(root, id) {
  if (!uuid.test(id)) throw new Error('Invalid archive transaction identity');
  const container = path.join(root, 'archive-transactions', id);

  const file = container;
  const transaction = records.read(container);

  if (!transaction) throw new Error(`Archive record is unavailable: ${container}`);

  validateIdentity(transaction, root, id, container, file);
  transaction.records.forEach(record => validateRecord(transaction, record));

  return transaction;
}

function validateIdentity(transaction, root, id, container, file) {
  if (transaction.version !== 3 || transaction.kind !== 'archive' || transaction.id !== id || transaction.root !== root || transaction.container !== container || io.identity(container) !== transaction.containerIdentity) throw new Error(`Invalid archive journal: ${file}`);

  if (fs.realpathSync(container) !== container || !['planned', 'preparing', 'pending', 'committed', 'rolled-back'].includes(transaction.state)) throw new Error(`Invalid archive transaction state: ${file}`);
  validateOwnership(transaction, root);
}

function validateOwnership(transaction, root) {
  for (const owner of transaction.ownerships ?? []) {
    const key = createHash('sha256').update(owner.sessionId.toLowerCase()).digest('hex').slice(0, 40);

    if (owner.file !== path.join(root, 'conversation-ownership', key + '.json') || !transaction.records.some(record => record.sessionId === owner.sessionId)) throw new Error('Invalid archive ownership mapping');
  }
}

function prepare(transaction) {
  if (transaction.state !== 'planned') throw new Error('Archive transaction is no longer awaiting preparation');
  transaction.state = 'preparing';
  save(transaction);
}

function begin(transaction) {
  if (transaction.state !== 'preparing') throw new Error('Archive transaction is no longer awaiting execution');

  for (const record of transaction.records) {
    if (!io.matches(record.file, record.original)) throw new Error(`Conversation changed before archiving: ${record.file}`);
  }

  transaction.state = 'pending';
  save(transaction);
  io.mkdir(path.join(transaction.root, 'archived'));
}

function publishRecord(transaction, record) {
  if (!io.matches(record.file, record.original) || !io.matches(record.backup, record.backupIdentity) || !io.matches(record.prepared, record.preparedIdentity)) throw new Error(`Archive publication files changed: ${record.file}`);
  require('./transcript-metadata.cjs').invalidate(record.file);
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

  for (const record of transaction.records) {
    if (!io.matches(record.destination, record.preparedIdentity) || io.exists(record.file)) throw new Error(`Archive commit could not be verified: ${record.file}`);

    for (const move of record.moves) {
      if (!io.matches(move.destination, move.identity) || io.exists(move.source)) throw new Error(`Archive sidecar commit could not be verified: ${move.source}`);
    }
  }

  transaction.state = 'committed';
  save(transaction);
}

function restoreRecord(transaction, record) {
  const trace = { source: record.file, destination: record.destination, identity: record.preparedIdentity };

  if (io.exists(record.destination)) io.undo(trace);

  for (const move of [...record.moves].reverse()) io.undo(move);

  if (io.matches(record.file, record.original) || io.matches(record.file, record.rollbackIdentity)) {
    require('./transcript-metadata.cjs').remember(record.file);

    return;
  }

  if (!io.matches(record.file, record.preparedIdentity) || !io.matches(record.backup, record.backupIdentity)) throw new Error(`Archive transcript recovery is ambiguous: ${record.file}`);

  prepareRollbackCopy(transaction, record);

  if (!io.matches(record.rollbackCopy, record.rollbackIdentity)) throw new Error(`Archive rollback copy changed: ${record.rollbackCopy}`);
  require('./transcript-metadata.cjs').invalidate(record.file);
  fs.renameSync(record.rollbackCopy, record.file);
  io.sync(path.dirname(record.file));
  require('./transcript-metadata.cjs').remember(record.file);
}

function prepareRollbackCopy(transaction, record) {
  if (record.rollbackIdentity) return;

  if (!io.matches(record.backup, record.backupIdentity)) throw new Error('Archive backup changed; retained');

  if (io.exists(record.rollbackCopy) && !io.sameContents(record.rollbackCopy, record.backupIdentity)) {
    if (!fs.lstatSync(record.rollbackCopy).isFile()) throw new Error('Archive rollback copy is not a regular file');
    fs.unlinkSync(record.rollbackCopy);
    io.sync(transaction.container);
  }

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
  cleanupCopies(transaction);
}

function verifyRollback(transaction) {
  for (const record of transaction.records) {
    if (!io.sameContents(record.file, record.original) || io.exists(record.destination)) throw new Error(`Archive transcript rollback could not be verified: ${record.file}`);

    for (const move of record.moves) {
      if (!io.matches(move.source, move.identity) || io.exists(move.destination)) throw new Error(`Archive sidecar rollback could not be verified: ${move.source}`);
    }
  }
}

function rollbackData(transaction) {

  for (const record of [...transaction.records].reverse()) restoreRecord(transaction, record);
  verifyRollback(transaction);
  transaction.state = 'rolled-back';
  save(transaction);
}

function cleanupCopies(transaction) {
  if (!transaction.cleanup) {
    const files = transaction.records.flatMap(record => [record.backup, record.prepared, record.rollbackCopy]);
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
  transaction.retiring = true;
  save(transaction);
  fs.rmSync(path.join(transaction.container, 'recovery.json'), { force: true });
  io.sync(transaction.container);
  fs.rmdirSync(transaction.container);
  io.sync(path.dirname(transaction.container));
  records.remove(transaction.container);
}

function rollback(transaction) {
  if (transaction.state !== 'rolled-back') rollbackData(transaction);

  cleanupCopies(transaction);
}

function finish(transaction) {
  require('./session-database.cjs').movePaths(transaction.root, transaction.records.map(record => ({ source: record.file, destination: record.destination })));

  for (const record of transaction.records) require('./transcript-metadata.cjs').remember(record.destination);
  finishOwnership(transaction);
  complete(transaction);
}

function replay(transaction) {
  if (transaction.finished) {
    if (transaction.state !== 'committed') throw new Error('Invalid completed archive state');

    try { cleanupCopies(transaction); }
    catch (error) { console.error(`Completed archive cleanup retained: ${transaction.container}: ${error.message}`); }

    return;
  }

  if (transaction.state === 'planned') return;

  if (transaction.state === 'preparing') {
    cleanupCopies(transaction);

    return;
  }

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

function recoverRecord(root, directory, container) {
  if (path.dirname(container) !== directory || !uuid.test(path.basename(container))) throw new Error('Invalid registered archive directory');
  const record = records.read(container);

  if (!record) {
    if (io.exists(container)) { fs.rmdirSync(container); io.sync(directory); }

    records.remove(container);

    return;
  }

  if (record.container !== container || record.root !== root) throw new Error('Invalid registered archive identity');

  if (record.retiring === true && !io.exists(container)) {
    records.remove(container);

    return;
  }

  replay(load(root, path.basename(container)));
}

function recover(root) {
  const directory = path.join(root, 'archive-transactions');

  const failures = [];

  for (const container of records.list(root)) {
    try { recoverRecord(root, directory, container); }
    catch (error) { failures.push(`${container}: ${error.message}`); }
  }

  if (failures.length) throw new Error(failures.join('\n'));
}

module.exports = { prepare, plan, load, begin, save, publishRecord, commit, rollback, finish, recover };
