use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::{path::Path, time::Duration};

#[derive(serde::Serialize)]
pub(crate) struct Publication {
    committed: bool,
    durable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

pub(super) fn open(path: &Path) -> Result<Connection, String> {
    let root = path.parent().ok_or("Settings have no storage directory")?;
    crate::private_fs::ensure_private_dir(root)?;
    let file = root.join("sessions.sqlite");
    let database = Connection::open_with_flags(&file, rusqlite::OpenFlags::default() | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW).map_err(|error| error.to_string())?;
    crate::private_fs::set_private_file_permissions(&file)?;
    database.busy_timeout(Duration::from_secs(10)).map_err(|error| error.to_string())?;
    database.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS application_settings (name TEXT PRIMARY KEY, body BLOB);")
        .map_err(|error| error.to_string())?;
    Ok(database)
}

pub(super) fn name(path: &Path) -> Result<&str, String> {
    path.file_name().and_then(|name| name.to_str()).ok_or_else(|| "Invalid settings record name".into())
}

pub(crate) fn read(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let mut database = open(path)?;
    let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let key = name(path)?;
    let saved: Option<Option<Vec<u8>>> = transaction.query_row("SELECT body FROM application_settings WHERE name=?", [key], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?;
    let body = saved.flatten();
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(body)
}

pub(crate) fn publish(path: &Path, body: &[u8]) -> Result<Publication, String> {
    open(path)?.execute("INSERT INTO application_settings (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body=excluded.body", params![name(path)?, body])
        .map_err(|error| error.to_string())?;
    Ok(Publication { committed: true, durable: true, error: None })
}
