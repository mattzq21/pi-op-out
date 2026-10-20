const sessionStorage = require('./piop-storage/maintenance.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const io = require('./session-transactions.cjs');
const database = require('./session-database.cjs');
const { validSessionHeader } = require('./session-header.cjs');
const { Type } = require('typebox');
const { Check } = require('typebox/value');

const labels = { archive: 'Archive', delete: 'Deletion', restore: 'Restore' };

const stepSchema = Type.Object({ type: Type.String() });

const moveSchema = Type.Object({ type: Type.Literal('move'), source: Type.String(), staged: Type.String(), identity: Type.Object({ identity: Type.String() }) });

const journalSchema = Type.Object({
  version: Type.Literal(1), id: Type.String(), kind: Type.Union([Type.Literal('archive'), Type.Literal('delete'), Type.Literal('restore')]),
  state: Type.Union([Type.Literal('prepared'), Type.Literal('committed')]), root: Type.String(), staging: Type.String(),
  targets: Type.Array(Type.Object({ path: Type.String(), sessionId: Type.String({ minLength: 1 }), destination: Type.Optional(Type.String()) })), steps: Type.Array(stepSchema), finish: Type.Array(stepSchema),
});

class Rejected extends Error {}

let writes = 0;

/** Starts the crash test count again for one storage transaction. */
function resetCrashPoint() { writes = 0; }

function point() {
  const limit = process.env.PIOP_STORAGE_TRANSACTION_CRASH_AFTER;

  if (limit !== undefined && writes++ >= Number(limit)) process.kill(process.pid, 'SIGKILL');
}

function withDatabase(root, operation) {
  const db = database.open(root);

  try { return operation(db); }
  finally { db.close(); }
}

function insert(journal) {
  withDatabase(journal.root, db => db.prepare('INSERT INTO storage_transactions VALUES (?, ?, ?, ?)').run(journal.id, journal.kind, journal.state, JSON.stringify(journal)));
  point();
}

function save(journal) {
  point();
  withDatabase(journal.root, db => {
    if (db.prepare('UPDATE storage_transactions SET state=?, journal_json=? WHERE id=?').run(journal.state, JSON.stringify(journal), journal.id).changes !== 1) throw new Error('Storage transaction is not registered');
  });
  point();
}

function retire(journal) {
  if (io.exists(journal.staging)) {
    const left = fs.readdirSync(journal.staging);

    if (left.length) throw new Error(`Unresolved staged files retained in ${journal.staging}: ${left.join(', ')}`);
    fs.rmdirSync(journal.staging);
    io.sync(path.dirname(journal.staging));
  }

  point();
  withDatabase(journal.root, db => {
    db.exec('BEGIN IMMEDIATE');

    try {
      require('./transcript-references.cjs').removeDirectory(db, journal.staging);
      db.prepare('DELETE FROM storage_transactions WHERE id=?').run(journal.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  point();
}

function rows(root) {
  return withDatabase(root, db => db.prepare('SELECT id, kind, state, journal_json FROM storage_transactions ORDER BY id').all())
    .map(row => {
      try {
        const journal = JSON.parse(row.journal_json);

        return Check(journalSchema, journal) ? { ...row, journal } : { ...row, damaged: 'Invalid storage transaction journal' };
      }
      catch (error) { return { ...row, damaged: `Damaged storage transaction journal: ${error.message}` }; }
    });
}

const steps = {
  'inspect-storage': {
    run(step, journal) {
      step.contract = sessionStorage.inspectSession(journal.root, step.source, step.sessionId);
      save(journal);
    },
    undo() {},
    done(step) { return Boolean(step.contract); },
  },
  move: {
    run(step) { io.syncTree(step.source); io.move({ source: step.source, destination: step.staged, identity: step.identity }); },
    undo(step) {
      if (!step.applied || !io.exists(step.staged)) return;
      io.undo({ source: step.source, destination: step.staged, identity: step.identity });
    },
    done(step) { return !io.exists(step.source) && io.matches(step.staged, step.identity); },
  },
  place: {
    run(step, journal) {
      io.syncTree(step.source);
      io.mkdir(path.dirname(step.destination));

      if (!step.identity) {
        step.identity = io.describe(step.source);
        save(journal);
      }

      io.move(step);
    },
    undo(step) {
      if (!step.applied || !step.identity || !io.exists(step.destination)) return;
      io.undo(step);
    },
    done(step) { return !io.exists(step.source) && io.matches(step.destination, step.identity); },
  },
  'prepare-transcript': {
    run(step, journal) {
      const inspected = journal.steps.find(other => other.type === 'inspect-storage' && other.source === step.source);

      if (!inspected?.contract) throw new Error(`Session storage was not inspected: ${step.source}`);
      const body = sessionStorage.archiveContent(step.source, step.sessionId, step.header, inspected.contract);
      fs.writeFileSync(step.prepared, body, { flag: 'wx', mode: step.mode });
      io.syncTree(step.prepared);
      io.sync(path.dirname(step.prepared));
    },
    undo(step) {
      if (!step.applied || !io.exists(step.prepared)) return;

      if (!fs.lstatSync(step.prepared).isFile()) throw new Error(`Prepared archive copy is not a regular file: ${step.prepared}`);
      fs.unlinkSync(step.prepared);
      io.sync(path.dirname(step.prepared));
    },
    done(step) { return !io.exists(step.prepared); },
  },
  'prepare-restored': {
    run(step) {
      const lines = fs.readFileSync(step.source, 'utf8').split('\n');
      const index = lines.findIndex(line => line.trim());
      const header = JSON.parse(lines[index]);

      if (header.cwd !== step.from) throw new Error(`Restored session folder changed: ${step.source}`);
      lines[index] = JSON.stringify({ ...header, cwd: step.cwd });
      fs.writeFileSync(step.prepared, lines.join('\n'), { flag: 'wx', mode: step.mode });
      io.syncTree(step.prepared);
      io.sync(path.dirname(step.prepared));
    },
    undo(step) {
      if (!step.applied || !io.exists(step.prepared)) return;

      if (!fs.lstatSync(step.prepared).isFile()) throw new Error(`Prepared restore copy is not a regular file: ${step.prepared}`);
      fs.unlinkSync(step.prepared);
      io.sync(path.dirname(step.prepared));
    },
    done(step) { return !io.exists(step.prepared); },
  },
  'write-record': {
    run(step) {
      const storage = require('./conversation-storage.cjs');
      const current = storage.read(step.file);

      if (current === step.after) return;

      if (current !== step.before) throw new Error(`Record changed: ${step.file}`);
      storage.write(step.file, step.after);
    },
    undo(step) {
      if (!step.applied) return;
      const storage = require('./conversation-storage.cjs');

      if (storage.read(step.file) === step.after) storage.write(step.file, step.before);
    },
    done(step) { return require('./conversation-storage.cjs').read(step.file) === step.after; },
  },
};

const finishSteps = {
  'forget-registry'(journal) { require('./registry-deletion.cjs').forget(journal.root, journal.targets); },
  'storage-removal'(journal) { sessionStorage.finishRemoval(journal, save); },
  'temporary-chats'(journal) { database.markCleanup(journal.root, 'temporary-chat'); },
  'move-paths'(journal) { database.movePaths(journal.root, journal.targets.map(target => ({ source: target.path, destination: target.destination }))); },
  'remember-metadata'(journal) { for (const target of journal.targets) require('./transcript-metadata.cjs').remember(target.destination); },
  'publish-receipt'(journal) {
    if (!journal.trace.identity) journal.trace.identity = journal.steps.find(step => step.type === 'place' && step.destination === journal.trace.destination).identity.identity;
    require('./restore-receipts.cjs').record(journal.root, journal);
  },
  'remove-staged'(journal) {
    for (const step of journal.steps.filter(step => step.type === 'move')) {
      if (!io.exists(step.staged)) continue;

      if (!step.cleanup) {
        if (!io.matches(step.staged, step.identity)) throw new Error(`Committed staged data changed; retained: ${step.staged}`);
        step.cleanup = io.removalPlan(step.staged);
        save(journal);
      }

      io.removeOwned(step.staged, step.cleanup);
      point();
    }
  },
};

function rollback(journal) {
  const failures = [];

  for (const step of [...journal.steps].reverse()) {
    try { steps[step.type].undo(step, journal); point(); }
    catch (error) { failures.push(error.message); }
  }

  if (failures.length) throw new Error(keepPending(journal, failures.join('\n')));
  retire(journal);
}

function finish(journal) {
  try {
    for (const step of journal.finish) {
      if (step.done) continue;

      try { finishSteps[step.type](journal, step); }
      catch (error) { return keepPending(journal, `${step.type}: ${error.message}`); }

      step.done = true;
      delete journal.lastError;
      save(journal);
    }

    retire(journal);
  } catch (error) { return keepPending(journal, error.message); }
}

function keepPending(journal, message) {
  journal.lastError = message;

  try { save(journal); }
  catch (error) { return `${message}\nRecovery record could not be updated: ${error.message}`; }

  return message;
}

function execute(journal) {
  const label = labels[journal.kind];

  insert(journal);

  try {
    io.mkdir(journal.staging);
    point();

    for (const step of journal.steps) {
      step.applied = true;
      save(journal);
      steps[step.type].run(step, journal);
      point();
    }

    const unchecked = journal.steps.find(step => !steps[step.type].done(step));

    if (unchecked) throw new Error(`Step could not be checked: ${unchecked.type} ${unchecked.source ?? unchecked.file}`);
    save({ ...journal, state: 'committed' });
    journal.state = 'committed';
  } catch (error) {
    try { rollback(journal); }
    catch (failure) {
      return { state: 'pending', error: `${label} failed: ${error.message}\n${label} recovery is pending: ${failure.message}` };
    }

    return { state: 'rolled-back', error: `${label} failed: ${error.message}` };
  }

  const failure = finish(journal);

  return failure ? { state: 'committed', warning: `${label} committed; cleanup will retry: ${failure}` } : { state: 'committed' };
}

function rejected(kind, error) {
  return { state: 'rolled-back', error: `${labels[kind]} failed: ${error.message}` };
}

function inside(parent, file) { return io.inside(parent, file) && file !== parent; }

function deleteSource(root, target) {
  const area = target.area === 'archived' ? 'archived' : 'sessions';
  const parent = fs.realpathSync(target.root || path.join(root, area));
  const source = fs.realpathSync(target.path);

  if (!inside(parent, source) || path.extname(source) !== '.jsonl' || !inside(root, source)) {
    throw new Rejected('Only Piop sessions can have their supporting data deleted');
  }

  return source;
}

function readHeader(file) {
  const metadata = fs.lstatSync(file);

  if (!metadata.isFile()) throw new Rejected(`Refusing to delete a non-regular file: ${file}`);
  const line = fs.readFileSync(file, 'utf8').split('\n').find(text => text.trim());
  let header;

  try { header = JSON.parse(line); }
  catch { header = undefined; }

  if (!validSessionHeader(header)) throw new Rejected('Invalid session header; nothing was deleted');

  return header;
}

function supportingFiles(source) {
  const snapshots = source.replace(/\.jsonl$/, '.snapshots');

  if (!io.exists(snapshots)) return [];

  if (!fs.lstatSync(snapshots).isDirectory()) throw new Rejected(`Invalid snapshot directory: ${snapshots}`);

  return [snapshots];
}

function ownershipFile(root, sessionId) {
  const key = createHash('sha256').update(sessionId.toLowerCase()).digest('hex').slice(0, 40);

  return path.join(root, 'conversation-ownership', `${key}.json`);
}

function supportingPaths(source) { return [source, source.replace(/\.jsonl$/, '.snapshots')]; }

function ownershipRecord(root, sessionId) {
  const file = ownershipFile(root, sessionId);
  const before = require('./conversation-storage.cjs').read(file);

  if (before === null) return [];

  return [{ type: 'write-record', file, before, after: JSON.stringify({ ...JSON.parse(before), deleted: true, client: null }) }];
}

function planDelete(root, request) {
  const list = request.targets ?? [];

  if (!Array.isArray(list) || !list.length) throw new Rejected('Invalid session deletion targets');
  const sources = list.map(target => deleteSource(root, target));

  if (new Set(sources).size !== sources.length) throw new Rejected('Invalid session deletion targets');
  const active = request.activeSessionIds ?? [];

  const targets = sources.map(source => {
    const header = readHeader(source);

    if (active.includes(header.id)) throw new Rejected('Close the session before deleting it');

    return { path: source, sessionId: header.id };
  });

  const id = randomUUID();
  const staging = path.join(root, 'storage-transactions', id);
  const files = targets.flatMap(target => [{ file: target.path, sessionId: target.sessionId }, ...supportingFiles(target.path).map(file => ({ file }))]);
  const storage = sessionStorage.planRemoval(root, targets, files);
  const moves = files.map((saved, index) => ({ type: 'move', source: saved.file, staged: path.join(staging, `${index}.staged`), identity: io.describe(saved.file) }));

  return {
    version: 1, id, kind: 'delete', state: 'prepared', root, staging, targets, storage,
    steps: [...moves, ...targets.flatMap(target => ownershipRecord(root, target.sessionId))],
    finish: [{ type: 'forget-registry' }, { type: 'storage-removal' }, { type: 'temporary-chats' }, { type: 'remove-staged' }],
  };
}

function placements(target) {
  const destinations = supportingPaths(target.destination);

  return supportingPaths(target.path).map((source, index) => [source, destinations[index]]);
}

function placeSteps(targets) {
  const steps = targets.flatMap(target => existingPlacements(placements(target)));

  return [...steps.filter(step => !step.source.endsWith('.jsonl')), ...steps.filter(step => step.source.endsWith('.jsonl'))];
}

function existingPlacements(pairs) {
  return pairs.filter(([source]) => io.exists(source)).map(([source, destination]) => ({ type: 'place', source, destination, identity: io.describe(source) }));
}

function selectedFiles(files, message) {
  if (!Check(Type.Array(Type.String(), { minItems: 1 }), files)) throw new Rejected(message);

  return [...new Set(files.map(file => fs.realpathSync(file)))];
}

function inspectStorageStep(target) {
  return { type: 'inspect-storage', source: target.path, sessionId: target.sessionId, sessionPath: target.destination };
}

function archiveSteps(staging, target, index) {
  const prepared = path.join(staging, `${index}.prepared`);

  return [
    inspectStorageStep(target),
    { type: 'prepare-transcript', source: target.path, sessionId: target.sessionId, prepared, mode: target.mode, header: { archiveSessionPath: target.path } },
    { type: 'move', source: target.path, staged: path.join(staging, `${index}.staged`), identity: io.describe(target.path) },
    ...existingPlacements(placements(target).slice(1)),
    { type: 'place', source: prepared, destination: target.destination },
  ];
}

function planArchive(root, request) {
  const planned = require('./archive-plan.cjs').planTargets(root, selectedFiles(request.paths, 'No sessions selected'));
  const targets = planned.map(target => ({ path: target.path, sessionId: target.sessionId, destination: target.destination }));
  const id = randomUUID();
  const staging = path.join(root, 'storage-transactions', id);

  return {
    version: 1, id, kind: 'archive', state: 'prepared', root, staging, targets,
    steps: [...planned.flatMap((target, index) => archiveSteps(staging, target, index)), ...targets.flatMap(target => ownershipRecord(root, target.sessionId))],
    finish: [{ type: 'move-paths' }, { type: 'remember-metadata' }, { type: 'remove-staged' }],
  };
}

function restoreRecord(root, sessionId, destination) {
  const file = ownershipFile(root, sessionId);
  const before = require('./conversation-storage.cjs').read(file);

  if (before === null) throw new Rejected(`Session ownership record is missing: ${sessionId}`);

  return { type: 'write-record', file, before, after: JSON.stringify({ ...JSON.parse(before), path: destination, deleted: false, client: null }) };
}

function planRestore(root, request) {
  const planned = require('./restore-plan.cjs').planTargets(root, selectedFiles(request.paths, 'No archived sessions selected'));
  const moved = folderMoves(request.cwdMoves);
  const cwdOf = target => moved.get(target.cwd) ?? target.cwd;
  const targets = planned.map(target => ({ path: target.path, sessionId: target.sessionId, destination: target.destination }));
  const sessions = planned.map(target => ({ path: cwdOf(target), sessionPath: target.destination, sessionId: target.sessionId, sourcePath: target.path }));
  const result = { path: sessions[0].path, sessionPath: sessions[0].sessionPath, sessionId: sessions[0].sessionId, sessions };

  if (Buffer.byteLength(JSON.stringify({ state: 'committed', result })) + 1 > 64 * 1024 * 1024) throw new Rejected('Restore group is too large; restore fewer sessions at a time');
  const id = randomUUID();
  const staging = path.join(root, 'storage-transactions', id);
  const placed = placeSteps(targets);
  const transcripts = planned.flatMap((target, index) => {
    const own = placed.find(step => step.source === target.path);

    if (cwdOf(target) === target.cwd) return [own];
    const prepared = path.join(staging, `${index}.restored`);

    return [
      { type: 'prepare-restored', source: target.path, prepared, from: target.cwd, cwd: cwdOf(target), mode: fs.statSync(target.path).mode & 0o777 },
      { type: 'move', source: target.path, staged: path.join(staging, `${index}.staged`), identity: own.identity },
      { type: 'place', source: prepared, destination: target.destination },
    ];
  });
  const steps = [...targets.map(inspectStorageStep), ...placed.filter(step => !step.source.endsWith('.jsonl')), ...transcripts, ...targets.map(target => restoreRecord(root, target.sessionId, target.destination))];
  const first = steps.find(step => step.type === 'place' && step.source === targets[0].path);

  return {
    version: 1, id, kind: 'restore', state: 'prepared', root, staging, targets, result,
    trace: { source: targets[0].path, destination: targets[0].destination, identity: first ? first.identity.identity : null },
    steps, finish: [{ type: 'move-paths' }, { type: 'remember-metadata' }, { type: 'publish-receipt' }, ...(steps.some(step => step.type === 'move') ? [{ type: 'remove-staged' }] : [])],
  };
}

/** Reads the folder moves of a restore: each restored session whose folder is from gets the folder to instead. */
function folderMoves(value) {
  const moves = new Map();

  if (value === undefined) return moves;

  if (!Check(Type.Array(Type.Object({ from: Type.String(), to: Type.String() })), value)) throw new Rejected('Invalid restore folder moves');

  for (const { from, to } of value) {
    if (!path.isAbsolute(from) || !path.isAbsolute(to) || moves.has(from)) throw new Rejected('Invalid restore folder moves');

    if (!fs.existsSync(to) || !fs.statSync(to).isDirectory()) throw new Rejected(`Restored folder does not exist: ${to}`);
    moves.set(from, to);
  }

  return moves;
}

function recoverEarlier(root, kind) {
  try { recoverStorage(root); }
  catch (error) { return { state: 'rolled-back', error: `${labels[kind]} failed: earlier storage recovery is pending: ${error.message}` }; }
}

function recoverStorage(root) {
  io.recover(root);
}

function run(root, kind, plan, resultOf) {
  const earlier = recoverEarlier(root, kind);
  let journal;

  if (earlier) return earlier;

  try { journal = plan(); }
  catch (error) { return rejected(kind, error); }

  const outcome = execute(journal);

  if (outcome.state !== 'committed') return outcome;
  afterCommit(root, outcome);

  return { ...outcome, result: resultOf(journal) };
}

function deleteSessions(root, request) {
  return run(root, 'delete', () => planDelete(root, request), journal => ({ sessionIds: journal.targets.map(target => target.sessionId) }));
}

function restoreSessions(root, request) {
  return run(root, 'restore', () => planRestore(root, request), journal => journal.result);
}

function archiveSessions(root, request) {
  return run(root, 'archive', () => planArchive(root, request), journal => ({ sessions: journal.targets.map(target => ({ sessionId: target.sessionId, sourcePath: target.path, sessionPath: target.destination })) }));
}

function restoredResult(root, source) {
  const earlier = recoverEarlier(root, 'restore');

  if (earlier) return { state: 'pending', error: earlier.error };

  return { state: 'committed', result: require('./restore-receipts.cjs').result(root, source) };
}

function afterCommit(root, outcome) {
  const warnings = outcome.warning ? [outcome.warning] : [];

  try { require('./restore-receipts.cjs').prune(root); }
  catch (error) { warnings.push(`Restore receipt pruning will retry: ${error.message}`); }

  try { sessionStorage.collectUnused(root); }
  catch (error) { warnings.push(`Deferred retention cleanup will retry: ${error.message}`); }

  const temporary = cleanupTemporaryChats(root);

  if (temporary) warnings.push(temporary);

  if (warnings.length) outcome.warning = warnings.join('\n');
}

function cleanupTemporaryChats(root) {
  try {
    const revision = database.cleanupRequest(root, 'temporary-chat');

    if (revision === undefined) return;
    const result = require('./temporary-chat.cjs').cleanupDeleted(root);

    if (result?.pending) return result.warning;
    database.finishCleanup(root, 'temporary-chat', revision);
  } catch (error) { return `Temporary folder cleanup will retry: ${error.message}`; }
}

function validTargets(root, journal) {
  return journal.targets.every(target => path.extname(target.path) === '.jsonl' && inside(root, target.path) && !inside(journal.staging, target.path) && validDestination(root, journal.kind, target));
}

const areas = { archive: ['sessions', 'archived'], restore: ['archived', 'sessions'] };

function validDestination(root, kind, target) {
  if (!areas[kind]) return target.destination === undefined;
  const [from, to] = areas[kind];

  return Boolean(target.destination?.endsWith('.jsonl')) && inside(path.join(root, to), target.destination) && inside(path.join(root, from), target.path);
}

function preparedPlacement(journal, target, step) {
  const preparation = { archive: 'prepare-transcript', restore: 'prepare-restored' }[journal.kind];

  return Boolean(preparation) && step.destination === target.destination && journal.steps.some(other => other.type === preparation && other.prepared === step.source && other.source === target.path);
}

function validPlacement(journal, target, step) {
  return placements(target).some(([source, destination]) => step.source === source && step.destination === destination) || preparedPlacement(journal, target, step);
}

const stepChecks = {
  'inspect-storage': (journal, step) => journal.kind !== 'delete' && journal.targets.some(target => target.path === step.source && target.sessionId === step.sessionId && target.destination === step.sessionPath),
  move: (journal, step) => path.dirname(step.staged) === journal.staging && (journal.kind === 'restore'
    ? journal.steps.some(other => other.type === 'prepare-restored' && other.source === step.source)
    : journal.targets.some(target => supportingPaths(target.path).includes(step.source))),
  place: (journal, step) => journal.kind !== 'delete' && journal.targets.some(target => validPlacement(journal, target, step)),
  'prepare-transcript': (journal, step) => journal.kind === 'archive' && path.dirname(step.prepared) === journal.staging && journal.targets.some(target => target.path === step.source),
  'prepare-restored': (journal, step) => journal.kind === 'restore' && path.dirname(step.prepared) === journal.staging && journal.targets.some(target => target.path === step.source),
  'write-record': (journal, step) => journal.targets.some(target => step.file === ownershipFile(journal.root, target.sessionId)),
};

function validStep(journal, step) { return Boolean(stepChecks[step.type]?.(journal, step)); }

function validJournal(root, row) {
  const journal = row.journal;

  if (journal.id !== row.id || journal.kind !== row.kind || journal.state !== row.state) return false;

  if (journal.root !== root || journal.staging !== path.join(root, 'storage-transactions', row.id) || !validTargets(root, journal)) return false;

  return journal.steps.every(step => validStep(journal, step)) && journal.finish.every(step => finishSteps[step.type]);
}

function recoverJournals(root) {
  const failures = [];

  for (const row of rows(root)) {
    try {
      if (row.damaged || !validJournal(root, row)) throw new Error(row.damaged ?? 'Unsupported storage transaction journal');

      if (row.state === 'prepared') rollback(row.journal);
      else if (row.state === 'committed') {
        const failure = finish(row.journal);

        if (failure) console.error(`${labels[row.kind]} committed; cleanup will retry: ${failure}`);
      } else throw new Error(`Unknown storage transaction state: ${row.state}`);
    } catch (error) {
      failures.push(`${row.id}: ${error.message}`);
    }
  }

  if (failures.length) throw new Error(failures.join('\n'));
}

function recover(root) {
  const failures = [];

  for (const replay of [recoverStorage, sessionStorage.collectUnused]) {
    try { replay(root); }
    catch (error) { failures.push(error.message); }
  }

  for (const journal of stuck(root)) failures.push(`${labels[journal.kind]} cleanup is pending: ${journal.error}`);

  const temporary = cleanupTemporaryChats(root);

  return failures.length ? { state: 'pending', error: failures.join('\n'), warning: temporary } : { state: 'committed', warning: temporary };
}

function pending(root) { return withDatabase(root, db => database.pending(db, 'transaction')); }

function stuck(root) {
  return rows(root).filter(row => row.damaged || row.journal.lastError).map(row => ({ id: row.id, kind: row.kind, error: row.damaged ?? row.journal.lastError }));
}

function temporaryCleanupPending(root) { return database.cleanupRequest(root, 'temporary-chat') !== undefined; }

function stagedTranscripts(root) {
  const list = rows(root);
  const damaged = list.find(row => row.damaged);

  if (damaged) throw new Error(`${damaged.id}: ${damaged.damaged}`);

  return list.flatMap(row => row.journal.steps
    .filter(step => Check(moveSchema, step) && step.source.endsWith('.jsonl'))
    .map(step => ({ id: row.id, kind: row.kind, state: row.state, root: row.journal.root, staging: row.journal.staging, file: step.staged, identity: step.identity.identity, sessionId: row.journal.targets.find(target => target.path === step.source)?.sessionId })));
}

module.exports = { archiveSessions, deleteSessions, restoreSessions, restoredResult, recover, recoverJournals, pending, stuck, temporaryCleanupPending, stagedTranscripts, resetCrashPoint };
