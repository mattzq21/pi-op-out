const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { loadDiffs } = require('./session-diff-store.cjs');
const records = require('./fork-transaction-records.cjs');

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

function inheritedDiffs(source, entries) {
  const diffs = loadDiffs(source);

  if (!Check(diffsSchema, diffs)) throw new Error('Invalid saved fork diffs');
  const ids = retainedIds(entries);

  return JSON.stringify(Object.fromEntries(Object.entries(diffs).filter(([id]) => ids.has(id))));
}

function cleanup(directory) {
  const parent = path.dirname(directory);
  const removing = path.basename(directory).startsWith('.cleanup-') ? directory : path.join(parent, `.cleanup-${path.basename(directory)}`);

  if (removing !== directory && exists(directory)) { fs.renameSync(directory, removing); sync(parent); }

  fs.rmSync(removing, { recursive: true, force: true });

  if (exists(parent)) sync(parent);
  records.remove(path.join(parent, path.basename(directory).replace(/^\.cleanup-/, '')));
  records.remove(removing);
}

function readTransaction(root, directory) {
  const transaction = records.read(directory);

  if (transaction === undefined) return undefined;

  if (transaction.version !== 1 || transaction.destination !== destinationPath(root, transaction.destination)) throw new Error('Invalid fork publication transaction');

  if (transaction.transcript !== identity(path.join(directory, 'session.jsonl')) || transaction.diffs !== identity(path.join(directory, 'diffs.json'))) throw new Error('Fork publication files changed');

  return transaction;
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
    removeOwned(sidecar, transaction.diffs);
    sync(path.dirname(destination));
    forgetPublished(root, destination);
    cleanup(directory);

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

function removeOwned(file, expected) {
  if (!exists(file)) return;

  if (!matches(file, expected)) throw new Error('Fork publication file was replaced');
  fs.unlinkSync(file);
}

function registerPublished(root, destination) {
  const header = JSON.parse(fs.readFileSync(destination, 'utf8').split('\n')[0]);

  if (header.type !== 'session' || !Check(Type.String({ minLength: 1 }), header.id)) throw new Error('Invalid published fork identity');
  require('./session-database.cjs').registerPath(root, header.id, destination);
}

function forgetPublished(root, destination) {
  const database = require('./session-database.cjs').open(root);

  try { database.prepare('DELETE FROM sessions WHERE session_path=?').run(destination); }
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
  const diffs = inheritedDiffs(source, lines.slice(1).map(line => JSON.parse(line)));
  const journals = path.join(root, 'fork-transactions');
  fs.mkdirSync(journals, { recursive: true, mode: 0o700 });
  sync(root);
  const directory = path.join(journals, randomUUID());
  records.allocate(directory);
  fs.mkdirSync(directory, { mode: 0o700 });
  sync(journals);

  try {
    write(path.join(directory, 'session.jsonl'), [JSON.stringify(header), ...lines.slice(1), ''].join('\n'));
    write(path.join(directory, 'diffs.json'), diffs);
    const transaction = { version: 1, destination, transcript: identity(path.join(directory, 'session.jsonl')), diffs: identity(path.join(directory, 'diffs.json')) };
    sync(directory);
    records.save(directory, transaction);

    return { directory, transaction };
  } catch (error) { cleanup(directory); throw error; }
}

function publish(root, request) {
  const { directory, transaction } = prepare(root, request);

  try {
    fs.linkSync(path.join(directory, 'diffs.json'), transaction.destination.replace(/\.jsonl$/, '.diffs.json'));
    sync(path.dirname(transaction.destination));
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
    else write(path.join(directory, 'diffs.json'), '{}');
    const transaction = { version: 1, removing: true, destination, transcript: identity(path.join(directory, 'session.jsonl')), diffs: identity(path.join(directory, 'diffs.json')) };
    sync(directory);
    records.save(directory, transaction);
  } catch (error) { cleanup(directory); throw error; }

  recoverTransaction(root, directory);
}

function published(root, request) {
  const destination = destinationPath(root, request.destination);

  if (!exists(destination)) return false;
  const header = JSON.parse(fs.readFileSync(destination, 'utf8').split('\n')[0]);

  if (header.type !== 'session' || header.id !== request.sessionId) throw new Error('Fork publication destination was replaced');
  const sidecar = destination.replace(/\.jsonl$/, '.diffs.json');

  if (!Check(diffsSchema, JSON.parse(fs.readFileSync(sidecar, 'utf8')))) throw new Error('Fork publication history is unavailable');
  sync(sidecar); sync(destination); sync(path.dirname(destination));
  registerPublished(root, destination);

  return true;
}

module.exports = { publish, recover, remove, published };
