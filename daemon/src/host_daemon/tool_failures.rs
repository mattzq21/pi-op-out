use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::{fs::OpenOptions, path::{Path, PathBuf}, sync::{mpsc, Mutex}, time::Duration};

pub(super) struct Writer {
    sender: Mutex<Option<mpsc::Sender<Value>>>,
    finished: tokio::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}

impl Writer {
    pub fn start(path: PathBuf, output: mpsc::Sender<Value>) -> Result<Self, String> {
        let (sender, records) = mpsc::channel::<Value>();
        let (finished, completion) = tokio::sync::oneshot::channel();
        std::thread::Builder::new().name("piop-tool-failures".into()).spawn(move || {
            for record in records {
                if let Err(error) = write(&path, &record) {
                    let _ = output.send(json!({"type":"diagnostic","line":format!("Could not record tool failure: {error}")}));
                }
            }
            let _ = finished.send(());
        }).map_err(|error| error.to_string())?;
        Ok(Self { sender: Mutex::new(Some(sender)), finished: tokio::sync::Mutex::new(Some(completion)) })
    }

    pub fn record(&self, record: Value) -> Result<(), String> {
        let sender = self.sender.lock().unwrap_or_else(|error| error.into_inner());
        sender.as_ref().ok_or("Tool failure writer has stopped")?
            .send(record).map_err(|_| "Tool failure writer disconnected".into())
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        self.sender.lock().unwrap_or_else(|error| error.into_inner()).take();
        let mut finished = self.finished.lock().await;
        if let Some(completion) = finished.take() {
            completion.await.map_err(|_| "Tool failure writer stopped before draining its queue")?;
        }
        Ok(())
    }
}

fn merge_missing(original: &mut Value, additional: Value) {
    if let (Value::Object(original), Value::Object(additional)) = (original, additional) {
        for (key, value) in additional {
            match original.entry(key) {
                serde_json::map::Entry::Vacant(entry) => { entry.insert(value); }
                serde_json::map::Entry::Occupied(mut entry) => merge_missing(entry.get_mut(), value),
            }
        }
    }
}

fn prepare_database_file(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
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
    Ok(())
}

fn retained_result(transaction: &rusqlite::Transaction<'_>, record: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    let previous: Option<String> = transaction.query_row(
        "SELECT result FROM tool_failures WHERE epoch = ?1 AND tool_call_id = ?2",
        params![record["epoch"].as_str(), record["toolCallId"].as_str()],
        |row| row.get(0),
    ).optional()?;
    let mut result = record["result"].clone();
    if let Some(previous) = previous {
        let mut original = serde_json::from_str(&previous)?;
        merge_missing(&mut original, result);
        result = original;
    }
    Ok(result)
}

fn prepare_table(transaction: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS tool_failures (
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
        );",
    )?;
    let old_column: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('tool_failures') WHERE name = 'session')",
        [], |row| row.get(0),
    )?;
    if old_column {
        transaction.execute_batch("ALTER TABLE tool_failures RENAME COLUMN session TO session_id;")?;
    }
    Ok(())
}

fn write(path: &Path, record: &Value) -> Result<(), Box<dyn std::error::Error>> {
    prepare_database_file(path)?;
    let mut connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_millis(250))?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    prepare_table(&transaction)?;
    let result = retained_result(&transaction, record)?;
    let json = |key: &str| record.get(key).filter(|value| !value.is_null()).map(Value::to_string);
    transaction.execute(
        "INSERT INTO tool_failures
            (session_id, epoch, cwd, model, tool_call_id, tool_name, input, result, failure_kind)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (epoch, tool_call_id) DO UPDATE SET
            tool_name = COALESCE(excluded.tool_name, tool_failures.tool_name),
            input = COALESCE(excluded.input, tool_failures.input),
            result = excluded.result,
            failure_kind = excluded.failure_kind",
        params![record["sessionId"].as_str(), record["epoch"].as_str(), record["cwd"].as_str(),
            json("model"), record["toolCallId"].as_str(), record["toolName"].as_str(),
            json("input"), result.to_string(), record["failureKind"].as_str()],
    )?;
    transaction.execute(
        "DELETE FROM tool_failures WHERE id NOT IN (SELECT id FROM tool_failures ORDER BY id DESC LIMIT 500)",
        [],
    )?;
    transaction.commit()?;
    Ok(())
}
