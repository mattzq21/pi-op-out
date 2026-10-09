use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::{fs, path::Path, time::Duration};

#[derive(serde::Serialize)]
pub(crate) struct Publication {
    committed: bool,
    durable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

fn open(path: &Path) -> Result<Connection, String> {
    let root = path.parent().ok_or("Settings have no storage directory")?;
    crate::private_fs::ensure_private_dir(root)?;
    let file = root.join("sessions.sqlite");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600).custom_flags(libc::O_NOFOLLOW); }
    options.open(&file).map_err(|error| error.to_string())?;
    crate::private_fs::set_private_file_permissions(&file)?;
    let database = Connection::open(file).map_err(|error| error.to_string())?;
    database.busy_timeout(Duration::from_secs(10)).map_err(|error| error.to_string())?;
    database.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS application_settings (name TEXT PRIMARY KEY, body BLOB, legacy_imported INTEGER NOT NULL DEFAULT 0);")
        .map_err(|error| error.to_string())?;
    Ok(database)
}

fn name(path: &Path) -> Result<&str, String> {
    path.file_name().and_then(|name| name.to_str()).ok_or_else(|| "Invalid settings record name".into())
}

fn old_body(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(body) => Ok(Some(body)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn read(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let mut database = open(path)?;
    let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let key = name(path)?;
    let saved: Option<Option<Vec<u8>>> = transaction.query_row("SELECT body FROM application_settings WHERE name=?", [key], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?;
    let body = if let Some(body) = saved { body } else {
        let body = old_body(path)?;
        transaction.execute("INSERT INTO application_settings (name, body) VALUES (?, ?)", params![key, body]).map_err(|error| error.to_string())?;
        body
    };
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(body)
}

pub(super) fn needs_legacy(path: &Path) -> Result<bool, String> {
    if read(path)?.is_some() { return Ok(false); }
    open(path)?.query_row("SELECT legacy_imported=0 FROM application_settings WHERE name=?", [name(path)?], |row| row.get(0)).map_err(|error| error.to_string())
}

pub(super) fn import_legacy(path: &Path, legacy: &Path) -> Result<(), String> {
    let mut database = open(path)?;
    let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let needed: bool = transaction.query_row("SELECT body IS NULL AND legacy_imported=0 FROM application_settings WHERE name=?", [name(path)?], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if needed {
        transaction.execute("UPDATE application_settings SET body=?, legacy_imported=1 WHERE name=?", params![old_body(legacy)?, name(path)?])
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

pub(super) fn publish(path: &Path, body: &[u8]) -> Result<Publication, String> {
    open(path)?.execute("INSERT INTO application_settings VALUES (?, ?, 1) ON CONFLICT(name) DO UPDATE SET body=excluded.body, legacy_imported=1", params![name(path)?, body])
        .map_err(|error| error.to_string())?;
    Ok(Publication { committed: true, durable: true, error: None })
}
