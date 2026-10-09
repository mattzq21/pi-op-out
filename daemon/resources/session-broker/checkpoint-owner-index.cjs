const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function profile(file) {
  let directory = path.dirname(file);

  while (path.dirname(directory) !== directory) {
    if (['sessions', 'archived', 'git-snapshots'].includes(path.basename(directory))) return path.dirname(directory);
    directory = path.dirname(directory);
  }
}

function database(root, operation) {
  if (fs.realpathSync(root) !== root) throw new Error('Invalid checkpoint index storage');
  const file = path.join(root, 'sessions.sqlite');

  if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file)) throw new Error('Invalid checkpoint index database');
  const db = new DatabaseSync(file);

  try {
    fs.chmodSync(file, 0o600);
    db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS checkpoint_owner_links (
        kind TEXT NOT NULL, owner_path TEXT NOT NULL, session_id TEXT NOT NULL,
        repository_root TEXT NOT NULL, ancestor TEXT NOT NULL,
        PRIMARY KEY(kind, owner_path, repository_root, ancestor));
      CREATE INDEX IF NOT EXISTS checkpoint_owner_ancestor ON checkpoint_owner_links(ancestor);
      CREATE INDEX IF NOT EXISTS checkpoint_owner_session ON checkpoint_owner_links(session_id);`);

    return operation(db);
  } finally { db.close(); }
}

function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');

  try {
    const result = operation(); db.exec('COMMIT');

    return result;
  }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function insert(db, kind, file, sessionId, roots) {
  const statement = db.prepare('INSERT OR IGNORE INTO checkpoint_owner_links VALUES (?, ?, ?, ?, ?)');

  for (const root of dependencyRoots(roots)) {
    const repository = path.resolve(root);
    let ancestor = repository;

    for (;;) {
      statement.run(kind, file, sessionId, repository, ancestor);

      if (path.dirname(ancestor) === ancestor) break;
      ancestor = path.dirname(ancestor);
    }
  }
}

function dependencyRoots(roots) {
  const result = new Set();

  for (const root of roots) {
    if (!root || !path.isAbsolute(root)) continue;
    result.add(path.resolve(root));

    try { result.add(fs.realpathSync(root)); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }

  return result;
}

function record(root, kind, file, sessionId, roots, replace = false) {
  database(root, db => transaction(db, () => {
    if (replace) db.prepare('DELETE FROM checkpoint_owner_links WHERE kind = ? AND owner_path = ?').run(kind, file);
    insert(db, kind, file, sessionId, roots);
  }));
}

function recordCheckpoint(file, sessionId, repositoryRoot) {
  const root = profile(file);

  if (root) record(root, 'transcript', file, sessionId, [repositoryRoot]);
}

function recordTranscript(root, file, body) {
  recordEntries(root, file, body.trim().split('\n').map(JSON.parse));
}

function recordEntries(root, file, entries) {
  const header = entries[0];
  const roots = [header.cwd, header.checkpointRepositoryRoot, header.worktreeRestore?.repositoryRoot];

  for (const entry of entries) {
    if (entry.type !== 'custom') continue;

    if (entry.customType === 'pi-project-prompt-checkpoint') roots.push(entry.data?.repositoryRoot ?? header.checkpointRepositoryRoot ?? header.cwd);
    else if (entry.customType === 'pi-project-files-watch-snapshot') roots.push(entry.data?.repositoryRoot);
  }

  record(root, 'transcript', file, header.id, roots, true);
}

function captureRoots(capture) {
  if (capture.ready === true) return [];

  return [capture.cwd, ...[capture.baseline, capture.current].flatMap(token => token ? [JSON.parse(token).repository_root] : [])];
}

function recordCapture(root, kind, file, sessionId, capture) {
  record(root, kind, file, sessionId, captureRoots(capture));
}

function replaceCaptures(root, kind, file, sessionId, captures) {
  record(root, kind, file, sessionId, captures.flatMap(captureRoots), true);
}

function linked(root, targets) {
  if (!targets.length) return [];

  return database(root, db => {
    const statement = db.prepare('SELECT DISTINCT kind, owner_path AS file, session_id AS sessionId FROM checkpoint_owner_links WHERE ancestor = ?');
    const rows = new Map();

    for (const target of targets) for (const row of statement.all(target)) rows.set(`${row.kind}\n${row.file}`, row);

    return [...rows.values()].sort((left, right) => left.file.localeCompare(right.file) || left.kind.localeCompare(right.kind));
  });
}

function refresh(file) {
  const root = profile(file);

  if (root && file.endsWith('.jsonl')) recordEntries(root, file, require('../transcript-references.cjs').read(root, file));
}

function relocate(source, destination) {
  const root = profile(destination);

  if (!root || !source.endsWith('.jsonl')) return;
  database(root, db => transaction(db, () => {
    for (const [before, after] of [[source, destination], [source.replace(/\.jsonl$/, '.diffs.json'), destination.replace(/\.jsonl$/, '.diffs.json')]]) {
      db.prepare('UPDATE OR REPLACE checkpoint_owner_links SET owner_path = ? WHERE owner_path = ?').run(after, before);
    }
  }));
  refresh(destination);
}

module.exports = { profile, recordCheckpoint, recordTranscript, recordCapture, replaceCaptures, linked, refresh, relocate };
