-- Exact table definition from daemon/src/host_daemon/tool_failures.rs.
-- From source code, not a running database. Connection settings omitted.

CREATE TABLE IF NOT EXISTS tool_failures (
  id INTEGER PRIMARY KEY,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  cwd TEXT,
  model TEXT,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT,
  input TEXT,
  result TEXT NOT NULL,
  failure_kind TEXT NOT NULL,
  UNIQUE (epoch, tool_call_id)
);
