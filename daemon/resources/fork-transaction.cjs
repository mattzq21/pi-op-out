const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { loadDiffs } = require('./session-diff-store.cjs');
const { copyRetainedStoreLocked } = require('./session-broker/git-diff-store.cjs');
const diffDatabase = require('./session-broker/git-diff-database.cjs');
const records = require('./fork-transaction-records.cjs');
const transcriptRecords = require('./transcript-references.cjs');

const diffsSchema = Type.Record(Type.String(), Type.Union([Type.String(), Type.Object({ patch: Type.String(), toolPaths: Type.Optional(Type.Array(Type.Unknown())) })]));

function exists(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function sync(file) {
  const descriptor = fs.openSync(file, 'r');

  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function write(file, content) {
  const descriptor = fs.openSync(file, 'wx', 0o600);

  try { fs.writeFileSync(descriptor, content); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function identity(file) {
  const stat = fs.lstatSync(file, { bigint: true });

  if (!stat.isFile()) throw new Error('Fork publication requires regular files');

  return `${stat.dev}:${stat.ino}`;
}

function matches(file, expected) { return Boolean(exists(file)) && identity(file) === expected; }

function destinationPath(root, candidate) {
  const sessions = fs.realpathSync(path.join(root, 'sessions'));

  if (!Check(Type.String(), candidate) || !path.isAbsolute(candidate) || !candidate.endsWith('.jsonl')) throw new Error('Invalid fork destination');
  const directory = fs.realpathSync(path.dirname(candidate));

  if (directory !== sessions && !directory.startsWith(sessions + path.sep)) throw new Error('Fork destination is outside session storage');

  return path.join(directory, path.basename(candidate));
}

function retainedIds(entries) {
  const byId = new Map(entries.flatMap(entry => Check(Type.String(), entry.id) ? [[entry.id, entry]] : []));
  const retained = new Set();
  let entry = entries.at(-1);

  while (entry && !retained.has(entry.id)) {
    retained.add(entry.id);
    entry = byId.get(entry.parentId);
  }

  return retained;
}

function cleanup(directory) {
  const parent = path.dirname(directory);
  const removing = path.basename(directory).startsWith('.cleanup-') ? directory : path.join(parent, `.cleanup-${path.basename(directory)}`);

  if (removing !== directory && exists(directory)) { fs.renameSync(directory, removing); sync(parent); }

  fs.rmSync(removing, { recursive: true, force: true });

  if (exists(parent)) sync(parent);
  const original = path.join(parent, path.basename(directory).replace(/^\.cleanup-/, ''));
  records.remove(original);
  records.remove(removing);
}

function readTransaction(root, directory) {
  const transaction = records.read(directory);

  if (transaction === undefined) return undefined;

  if (![1, 2].includes(transaction.version) || transaction.destination !== destinationPath(root, transaction.destination)) throw new Error('Invalid fork publication transaction');

  if (transaction.transcript !== identity(path.join(directory, 'session.jsonl'))) throw new Error('Fork publication transcript changed');

  verifyLegacyHistory(transaction, directory);

  if (transaction.version === 2 && transaction.sessionId !== transcriptHeader(root, path.join(directory, 'session.jsonl')).id) throw new Error('Fork preparation session changed');

  return transaction;
}

function verifyLegacyHistory(transaction, directory) {
  if (transaction.version === 1 && !transaction.diffs) throw new Error('Legacy fork history identity is missing');

  if (transaction.diffs && transaction.diffs !== identity(path.join(directory, 'diffs.json'))) throw new Error('Fork publication history file changed');
}

function recoverTransaction(root, directory) {
  const transaction = readTransaction(root, directory);

  if (transaction === undefined) {
    cleanup(directory);

    return;
  }

  const destination = transaction.destination;
  const sidecar = destination.replace(/\.jsonl$/, '.diffs.json');

  if (transaction.removing) {
    removeOwned(destination, transaction.transcript);

    if (transaction.diffs) removeOwned(sidecar, transaction.diffs);
    sync(path.dirname(destination));
    forgetPublished(root, destination, transcriptHeader(root, path.join(directory, 'session.jsonl')).id);
    cleanup(directory);

    return;
  }

  if (transaction.version === 2) {
    recoverDatabaseFork(root, directory, transaction);

    return;
  }

  if (exists(destination)) {
    if (!matches(destination, transaction.transcript)) throw new Error('Fork publication destination was replaced');

    if (!exists(sidecar)) fs.linkSync(path.join(directory, 'diffs.json'), sidecar);
    registerPublished(root, destination);
  } else if (exists(sidecar)) {
    if (!matches(sidecar, transaction.diffs)) throw new Error('Fork publication sidecar was replaced');
    fs.unlinkSync(sidecar);
  }

  sync(path.dirname(destination));
  cleanup(directory);
}

function recoverDatabaseFork(root, directory, transaction) {
  if (exists(transaction.destination)) {
    if (!matches(transaction.destination, transaction.transcript) || !transaction.historyReady) throw new Error('Published fork does not match its preparation; retained');
    diffDatabase.revision(root, transaction.sessionId);
    sync(transaction.destination); sync(path.dirname(transaction.destination));
    registerPublished(root, transaction.destination);
  } else {
    diffDatabase.discardPreparation(root, transaction.sessionId, directory);
  }

  cleanup(directory);
}

function transcriptHeader(root, file) {
  const header = transcriptRecords.read(root, file)[0];

  if (header.type !== 'session' || !Check(Type.String({ pattern: '^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' }), header.id)) throw new Error('Invalid fork session identity');

  return header;
}

function removeOwned(file, expected) {
  if (!exists(file)) return;

  if (!matches(file, expected)) throw new Error('Fork publication file was replaced');
  fs.unlinkSync(file);
}

function registerPublished(root, destination) {
  const header = transcriptRecords.read(root, destination)[0];

  if (header.type !== 'session' || !Check(Type.String({ minLength: 1 }), header.id)) throw new Error('Invalid published fork identity');
  require('./session-database.cjs').registerPath(root, header.id, destination);
  require('./transcript-metadata.cjs').remember(destination);
}

function forgetPublished(root, destination, sessionId) {
  const database = require('./session-database.cjs').open(root);

  try {
    database.exec('BEGIN IMMEDIATE');
    const registered = database.prepare('SELECT session_path FROM sessions WHERE lower(session_id)=lower(?)').get(sessionId);

    if (registered?.session_path && registered.session_path !== destination) throw new Error('Removed fork moved to another location; database records retained');

    for (const table of ['session_diff_state', 'session_diff_transfers', 'transcript_references']) {
      if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) database.prepare(`DELETE FROM ${table} WHERE session_id=lower(?)`).run(sessionId);
    }

    database.prepare('DELETE FROM sessions WHERE session_path=?').run(destination);
    database.exec('COMMIT');
  }
  finally { database.close(); }
}

function recover(root) {
  const directory = path.join(root, 'fork-transactions');

  for (const journal of records.list(root)) {
    if (path.dirname(journal) !== directory) throw new Error('Invalid fork publication location');

    if (!exists(journal) || path.basename(journal).startsWith('.cleanup-')) cleanup(journal);
    else {
      if (!exists(journal).isDirectory()) throw new Error('Invalid fork publication journal');
      recoverTransaction(root, journal);
    }
  }
}

function prepare(root, request) {
  const destination = destinationPath(root, request.destination);
  const source = fs.realpathSync(request.source);

  if (source !== destinationPath(root, source)) throw new Error('Invalid fork source');

  if (exists(destination) || exists(destination.replace(/\.jsonl$/, '.diffs.json'))) throw new Error('Fork destination already exists');
  const lines = fs.readFileSync(request.inline ? 0 : request.branch, 'utf8').split('\n').filter(line => line.trim());
  const header = JSON.parse(lines[0]);

  if (header.type !== 'session' || header.id !== request.sessionId) throw new Error('Fork session identity changed');
  header.parentSession = source;
  const sourceId = transcriptHeader(root, source).id;
  const selected = retainedIds(lines.slice(1).map(line => JSON.parse(line)));
  const journals = path.join(root, 'fork-transactions');
  fs.mkdirSync(journals, { recursive: true, mode: 0o700 });
  sync(root);
  const directory = path.join(journals, randomUUID());
  records.allocate(directory);
  fs.mkdirSync(directory, { mode: 0o700 });
  sync(journals);

  try {
    write(path.join(directory, 'session.jsonl'), [JSON.stringify(header), ...lines.slice(1), ''].join('\n'));
    const transaction = { version: 2, destination, sessionId: header.id, transcript: identity(path.join(directory, 'session.jsonl')), historyReady: false };
    sync(directory);
    records.save(directory, transaction);
    copyRetainedStoreLocked(source.replace(/\.jsonl$/, '.diffs.json'), destination.replace(/\.jsonl$/, '.diffs.json'), selected, sourceId, header.id, directory);
    transaction.historyReady = true;
    records.save(directory, transaction);

    return { directory, transaction };
  } catch (error) { recoverTransaction(root, directory); throw error; }
}

function publish(root, request) {
  const { directory, transaction } = prepare(root, request);

  try {
    if (diffDatabase.revision(root, transaction.sessionId) !== 1) throw new Error('Prepared fork history changed; retained');
    fs.linkSync(path.join(directory, 'session.jsonl'), transaction.destination);
    sync(path.dirname(transaction.destination));
    registerPublished(root, transaction.destination);
  } catch (error) {
    const committed = matches(transaction.destination, transaction.transcript);
    recoverTransaction(root, directory);

    if (!committed) throw error;

    return;
  }

  try { cleanup(directory); }
  catch (error) { console.error(`Fork published; cleanup will retry: ${error.message}`); }
}

function remove(root, request) {
  const destination = destinationPath(root, request.destination);
  const journals = path.join(root, 'fork-transactions');
  fs.mkdirSync(journals, { recursive: true, mode: 0o700 });
  sync(root);
  const directory = path.join(journals, randomUUID());
  records.allocate(directory);
  fs.mkdirSync(directory, { mode: 0o700 });
  sync(journals);

  try {
    fs.linkSync(destination, path.join(directory, 'session.jsonl'));
    const sidecar = destination.replace(/\.jsonl$/, '.diffs.json');

    if (exists(sidecar)) fs.linkSync(sidecar, path.join(directory, 'diffs.json'));
    const transaction = { version: 2, removing: true, destination, sessionId: transcriptHeader(root, destination).id, transcript: identity(path.join(directory, 'session.jsonl')), diffs: exists(sidecar) ? identity(path.join(directory, 'diffs.json')) : undefined };
    sync(directory);
    records.save(directory, transaction);
  } catch (error) { cleanup(directory); throw error; }

  recoverTransaction(root, directory);
}

function published(root, request) {
  const destination = destinationPath(root, request.destination);

  if (!exists(destination)) return false;
  const header = transcriptRecords.read(root, destination)[0];

  if (header.type !== 'session' || header.id !== request.sessionId) throw new Error('Fork publication destination was replaced');

  if (!exists(destination.replace(/\.jsonl$/, '.diffs.json'))) diffDatabase.revision(root, header.id);

  if (!Check(diffsSchema, loadDiffs(destination))) throw new Error('Fork publication history is unavailable');
  sync(destination); sync(path.dirname(destination));
  registerPublished(root, destination);

  return true;
}

module.exports = { publish, recover, remove, published };
