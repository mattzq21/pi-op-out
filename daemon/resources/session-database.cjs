function initialize(db) {
  db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;`);

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, session_path TEXT);
      CREATE TABLE IF NOT EXISTS session_deletion_tombstones (session_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL, session_path TEXT NOT NULL);`);
    const columns = db.prepare('PRAGMA table_info(session_repositories)').all();

    if (columns.some(column => column.name === 'session_path')) {
      db.exec(`INSERT INTO sessions SELECT session_id, session_path FROM session_repositories WHERE true ON CONFLICT(session_id) DO NOTHING;
        ALTER TABLE session_repositories RENAME TO session_repositories_previous;`);
    }

    db.exec(`CREATE TABLE IF NOT EXISTS session_repositories (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, cwd TEXT NOT NULL,
      repository_root TEXT, remote_name TEXT, remote_url TEXT, branch TEXT, upstream_branch TEXT,
      head_commit TEXT, checked_at INTEGER NOT NULL, observed_at INTEGER, directory_exists INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_sidebar (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL, modified_at INTEGER NOT NULL, summary_json TEXT NOT NULL);`);

    if (columns.some(column => column.name === 'session_path')) {
      db.exec(`INSERT INTO session_repositories SELECT session_id, cwd, repository_root, remote_name, remote_url,
        branch, upstream_branch, head_commit, checked_at, observed_at, directory_exists FROM session_repositories_previous;
        DROP TABLE session_repositories_previous;`);
    }

    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function repositoryQuery(db, columns, suffix = '') {
  const legacy = db.prepare('PRAGMA table_info(session_repositories)').all().some(column => column.name === 'session_path');
  const fields = columns.map(column => `${column === 'session_path' && !legacy ? 's' : 'r'}.${column}`).join(', ');

  return `SELECT ${fields} FROM session_repositories r${legacy ? '' : ' JOIN sessions s USING(session_id)'}${suffix}`;
}

function movePaths(root, moves) {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(root, 'sessions.sqlite');

  if (!fs.existsSync(file)) return;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);

  try {
    initialize(db);
    db.exec('BEGIN IMMEDIATE');
    const move = db.prepare('UPDATE sessions SET session_path = ? WHERE session_path = ?');
    const clear = db.prepare('DELETE FROM session_sidebar WHERE session_id IN (SELECT session_id FROM sessions WHERE session_path = ?)');

    for (const item of moves) {
      clear.run(item.source);
      move.run(item.destination, item.source);
    }

    db.exec('COMMIT');
  } finally { db.close(); }
}

module.exports = { initialize, repositoryQuery, movePaths };
