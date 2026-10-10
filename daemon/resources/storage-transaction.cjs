const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const io = require('./session-transactions.cjs');
const database = require('./session-database.cjs');
const { validSessionHeader } = require('./session-header.cjs');

const labels = { archive: 'Archive', delete: 'Deletion', restore: 'Restore' };

class Rejected extends Error {}

let writes = 0;

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
    .map(row => ({ ...row, journal: JSON.parse(row.journal_json) }));
}

const steps = {
  move: {
    run(step) { io.syncTree(step.source); io.move({ source: step.source, destination: step.staged, identity: step.identity }); },
    undo(step) { if (io.exists(step.source) || io.exists(step.staged)) io.undo({ source: step.source, destination: step.staged, identity: step.identity }); },
    done(step) { return !io.exists(step.source) && io.matches(step.staged, step.identity); },
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
      const storage = require('./conversation-storage.cjs');
      const current = storage.read(step.file);

      if (current === step.before) return;

      if (current !== step.after) throw new Error(`Record changed during rollback: ${step.file}`);
      storage.write(step.file, step.before);
    },
    done(step) { return require('./conversation-storage.cjs').read(step.file) === step.after; },
  },
};

const finishSteps = {
  'forget-registry'(journal) { require('./registry-deletion.cjs').forget(journal.root, journal.targets); },
  'goal-assets'(journal) { require('./goal-asset-cleanup.cjs').finish(journal, save); },
  'record-retention'(journal, step) { require('./retention-candidates.cjs').recordRetention(journal.root, journal.id, step.pending); },
  'temporary-chats'(journal) { require('./temporary-chat.cjs').cleanupDeleted(journal.root); },
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
    try { steps[step.type].undo(step); point(); }
    catch (error) { failures.push(error.message); }
  }

  if (failures.length) throw new Error(failures.join('\n'));
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
      steps[step.type].run(step);
      point();
    }

    const unchecked = journal.steps.find(step => !steps[step.type].done(step));

    if (unchecked) throw new Error(`Step could not be checked: ${unchecked.type} ${unchecked.source ?? unchecked.file}`);
    journal.state = 'committed';
    save(journal);
  } catch (error) {
    try { rollback(journal); }
    catch (failure) {
      return { state: 'pending', error: `${label} failed: ${error.message}\n${label} recovery is pending: ${failure.message}` };
    }

    return { state: 'rolled-back', error: `${label} failed: ${error.message}\n${label} was rolled back.` };
  }

  const failure = finish(journal);

  return failure ? { state: 'committed', warning: `${label} committed; cleanup will retry: ${failure}` } : { state: 'committed' };
}

function rejected(kind, error) {
  return { state: 'rolled-back', error: `${labels[kind]} failed: ${error.message}\n${labels[kind]} was rolled back.` };
}

function inside(parent, file) { return io.inside(parent, file) && file !== parent; }

function deleteSource(root, target) {
  const area = target.area === 'archived' ? 'archived' : 'sessions';
  const parent = fs.realpathSync(target.root || path.join(root, area));
  const source = fs.realpathSync(target.path);

  if (!inside(parent, source) || path.extname(source) !== '.jsonl' || ![path.join(root, 'sessions'), path.join(root, 'archived'), parent].some(directory => inside(directory, source))) {
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
  const files = [];
  const snapshots = source.replace(/\.jsonl$/, '.snapshots');
  const loop = `${source}.loop-detection.json`;

  if (io.exists(snapshots)) {
    if (!fs.lstatSync(snapshots).isDirectory()) throw new Rejected(`Invalid snapshot directory: ${snapshots}`);
    files.push(snapshots);
  }

  if (io.exists(loop)) {
    if (!fs.lstatSync(loop).isFile()) throw new Rejected(`Refusing to delete a non-regular file: ${loop}`);
    files.push(loop);
  }

  return files;
}

function ownershipRecord(root, sessionId) {
  const key = createHash('sha256').update(sessionId.toLowerCase()).digest('hex').slice(0, 40);
  const file = path.join(root, 'conversation-ownership', `${key}.json`);
  const before = require('./conversation-storage.cjs').read(file);

  if (before === null) return [];

  return [{ type: 'write-record', file, before, after: JSON.stringify({ ...JSON.parse(before), deleted: true, client: null }) }];
}

function planDelete(root, request) {
  const list = request.targets ?? [];

  if (!Array.isArray(list) || !list.length) throw new Rejected('Invalid conversation deletion targets');
  const sources = list.map(target => deleteSource(root, target));

  if (new Set(sources).size !== sources.length) throw new Rejected('Invalid conversation deletion targets');
  const active = request.activeSessionIds ?? [];

  const targets = sources.map(source => {
    const header = readHeader(source);

    if (active.includes(header.id)) throw new Rejected('Close the session before deleting it');

    return { path: source, sessionId: header.id };
  });

  const id = randomUUID();
  const staging = path.join(root, 'storage-transactions', id);
  const files = targets.flatMap(target => [{ file: target.path, sessionId: target.sessionId }, ...supportingFiles(target.path).map(file => ({ file }))]);
  const goalAssets = require('./goal-asset-cleanup.cjs').plan(root, targets);
  const retention = require('./deletion-retention.cjs').collectRetention(root, sources, files);
  const moves = files.map((saved, index) => ({ type: 'move', source: saved.file, staged: path.join(staging, `${index}.staged`), identity: io.describe(saved.file) }));

  return {
    version: 1, id, kind: 'delete', state: 'prepared', root, staging, targets, goalAssets,
    steps: [...moves, ...targets.flatMap(target => ownershipRecord(root, target.sessionId))],
    finish: [{ type: 'forget-registry' }, { type: 'goal-assets' }, { type: 'record-retention', pending: retention.deferred }, { type: 'temporary-chats' }, { type: 'remove-staged' }],
  };
}

function deleteSessions(root, request) {
  let journal;

  try {
    io.recover(root);
    require('./storage-recovery.cjs').recoverStorage(root);
    journal = planDelete(root, request);
  }
  catch (error) { return rejected('delete', error); }

  const outcome = execute(journal);

  if (outcome.state === 'committed') afterCommit(root, outcome);

  return { ...outcome, result: outcome.state === 'committed' ? { sessionIds: journal.targets.map(target => target.sessionId) } : undefined };
}

function afterCommit(root, outcome) {
  const warnings = outcome.warning ? [outcome.warning] : [];

  try { require('./restore-receipts.cjs').prune(root); }
  catch (error) { warnings.push(`Restore receipt pruning will retry: ${error.message}`); }

  try { require('./retention-collection.cjs').collectDeferredRetention(root); }
  catch (error) { warnings.push(`Deferred retention cleanup will retry: ${error.message}`); }

  if (warnings.length) outcome.warning = warnings.join('\n');
}

function validJournal(root, row) {
  const journal = row.journal;

  return journal.version === 1 && journal.id === row.id && journal.kind === row.kind && journal.state === row.state && labels[row.kind]
    && journal.root === root && journal.staging === path.join(root, 'storage-transactions', row.id)
    && journal.steps.every(step => steps[step.type] && (step.type !== 'move' || path.dirname(step.staged) === journal.staging))
    && journal.finish.every(step => finishSteps[step.type]);
}

function recoverJournals(root) {
  const failures = [];

  for (const row of rows(root)) {
    try {
      if (!validJournal(root, row)) throw new Error('Unsupported storage transaction journal');

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

  for (const replay of [io.recover, require('./storage-recovery.cjs').recoverStorage, require('./retention-collection.cjs').collectDeferredRetention]) {
    try { replay(root); }
    catch (error) { failures.push(error.message); }
  }

  for (const journal of stuck(root)) failures.push(`${labels[journal.kind]} cleanup is pending: ${journal.error}`);

  return failures.length ? { state: 'pending', error: failures.join('\n') } : { state: 'committed' };
}

function pending(root) { return rows(root).length > 0; }

function stuck(root) {
  return rows(root).filter(row => row.state === 'committed' && row.journal.lastError).map(row => ({ id: row.id, kind: row.kind, error: row.journal.lastError }));
}

function stagedTranscripts(root) {
  return rows(root).flatMap(row => row.journal.steps
    .filter(step => step.type === 'move' && step.source.endsWith('.jsonl'))
    .map(step => ({ id: row.id, kind: row.kind, state: row.state, root: row.journal.root, staging: row.journal.staging, file: step.staged, identity: step.identity.identity, sessionId: row.journal.targets.find(target => target.path === step.source)?.sessionId })));
}

module.exports = { deleteSessions, recover, recoverJournals, pending, stuck, stagedTranscripts };
