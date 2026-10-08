-- Exact table definitions from daemon/resources/session-database.cjs and
-- daemon/resources/session-broker/checkpoint-owner-index.cjs.
-- Temporary table from daemon/src/backend/sidebar_storage.rs.
-- From source code, not a running database. Upgrade steps and connection settings omitted.

CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, session_path TEXT);
CREATE TABLE IF NOT EXISTS session_deletion_tombstones (session_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL, session_path TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS session_repositories (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, cwd TEXT NOT NULL,
  repository_root TEXT, remote_name TEXT, remote_url TEXT, branch TEXT, upstream_branch TEXT,
  head_commit TEXT, checked_at INTEGER NOT NULL, observed_at INTEGER, directory_exists INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS session_sidebar (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL, modified_at INTEGER NOT NULL, summary_json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS checkpoint_owner_links (
  kind TEXT NOT NULL, owner_path TEXT NOT NULL, session_id TEXT NOT NULL,
  repository_root TEXT NOT NULL, ancestor TEXT NOT NULL,
  PRIMARY KEY(kind, owner_path, repository_root, ancestor));
CREATE INDEX IF NOT EXISTS checkpoint_owner_ancestor ON checkpoint_owner_links(ancestor);
CREATE INDEX IF NOT EXISTS checkpoint_owner_session ON checkpoint_owner_links(session_id);

CREATE TEMP TABLE IF NOT EXISTS sidebar_seen (session_id TEXT PRIMARY KEY);
