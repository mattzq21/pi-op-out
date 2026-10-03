use rusqlite::{params, Connection, TransactionBehavior};
use serde_json::Value;
use std::{fs::OpenOptions, path::Path, time::Duration};

pub(super) fn record(path: &Path, record: &Value) -> Result<(), String> {
    write(path, record).map_err(|error| error.to_string())
}

fn write(path: &Path, record: &Value) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(path.parent().ok_or("Tool failure database has no parent")?)?;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    drop(file);
    let mut connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_millis(250))?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS tool_failures (
            id INTEGER PRIMARY KEY,
            recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            session TEXT NOT NULL,
            epoch TEXT NOT NULL,
            cwd TEXT,
            model TEXT,
            tool_call_id TEXT NOT NULL,
            tool_name TEXT,
            input TEXT,
            result TEXT NOT NULL,
            failure_kind TEXT NOT NULL,
            UNIQUE (epoch, tool_call_id)
        );",
    )?;
    let json = |key: &str| record.get(key).filter(|value| !value.is_null()).map(Value::to_string);
    transaction.execute(
        "INSERT INTO tool_failures
            (session, epoch, cwd, model, tool_call_id, tool_name, input, result, failure_kind)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (epoch, tool_call_id) DO UPDATE SET
            tool_name = COALESCE(excluded.tool_name, tool_failures.tool_name),
            input = COALESCE(excluded.input, tool_failures.input),
            result = excluded.result,
            failure_kind = excluded.failure_kind",
        params![record["session"].as_str(), record["epoch"].as_str(), record["cwd"].as_str(),
            json("model"), record["toolCallId"].as_str(), record["toolName"].as_str(),
            json("input"), record["result"].to_string(), record["failureKind"].as_str()],
    )?;
    transaction.execute(
        "DELETE FROM tool_failures WHERE id NOT IN (SELECT id FROM tool_failures ORDER BY id DESC LIMIT 500)",
        [],
    )?;
    transaction.commit()?;
    Ok(())
}
