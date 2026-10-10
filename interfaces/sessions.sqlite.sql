-- Definitions from daemon/resources/session-database.cjs.
-- Temporary table from daemon/src/backend/sidebar_storage.rs.

CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, session_path TEXT); CREATE INDEX IF NOT EXISTS sessions_path ON sessions(session_path);

CREATE TABLE IF NOT EXISTS session_sidebar (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL, modified_at INTEGER NOT NULL, summary_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session_child_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  complete INTEGER NOT NULL CHECK(complete IN (0, 1)));
CREATE TABLE IF NOT EXISTS session_children (
  parent_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('subagent', 'review')),
  PRIMARY KEY(parent_id, child_id));
CREATE INDEX IF NOT EXISTS session_children_child ON session_children(child_id);
CREATE TABLE IF NOT EXISTS session_mailbox_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS session_mailbox (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL, sequence INTEGER NOT NULL, fingerprint TEXT NOT NULL,
  message_json TEXT NOT NULL, PRIMARY KEY(session_id, delivery_id));
CREATE INDEX IF NOT EXISTS session_mailbox_order ON session_mailbox(session_id, sequence);
CREATE TABLE IF NOT EXISTS session_subagent_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS session_subagent_runs (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL, started_at REAL NOT NULL, run_json TEXT NOT NULL,
  PRIMARY KEY(session_id, run_id));
CREATE INDEX IF NOT EXISTS session_subagent_order ON session_subagent_runs(session_id, started_at);
CREATE TABLE IF NOT EXISTS session_group_state (id INTEGER PRIMARY KEY CHECK(id=1), initialized INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS session_groups (
  group_id TEXT PRIMARY KEY, position INTEGER NOT NULL, name TEXT NOT NULL, cwd TEXT,
  host_id TEXT, host_name TEXT);
CREATE TABLE IF NOT EXISTS session_group_assignments (session_key TEXT PRIMARY KEY, group_id TEXT);
CREATE TABLE IF NOT EXISTS session_group_removed_projects (project_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS session_publications (publication_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session_restorations (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session_restore_receipts (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS retention_candidates (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, retry_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS retention_retry_order ON retention_candidates(retry_at, record_id);
CREATE TABLE IF NOT EXISTS cleanup_requests (kind TEXT PRIMARY KEY, revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS recovery_directories (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS goal_asset_dependencies (directory TEXT NOT NULL, identity TEXT NOT NULL, record_json TEXT, PRIMARY KEY(directory, identity));
CREATE TABLE IF NOT EXISTS goal_asset_reclamations (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS external_transcripts (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS queued_inputs (session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session_directories (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, cwd TEXT NOT NULL, checked_at INTEGER NOT NULL, directory_exists INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS archive_records (directory TEXT PRIMARY KEY, record_json TEXT);
CREATE TABLE IF NOT EXISTS deletion_records (directory TEXT PRIMARY KEY, record_json TEXT);

CREATE TEMP TABLE IF NOT EXISTS sidebar_seen (session_id TEXT PRIMARY KEY);
