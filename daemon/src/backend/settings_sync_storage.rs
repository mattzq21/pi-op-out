use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use std::{path::Path, time::Duration};

fn database_file(root: &Path) -> Result<std::path::PathBuf, String> {
    crate::private_fs::ensure_private_dir(root)?;
    let file = root.join("sessions.sqlite");
    Ok(file)
}

fn open(path: &Path) -> Result<Connection, String> {
    let root = path.parent().ok_or("Settings synchronization record has no directory")?;
    let file = database_file(root)?;
    let db = Connection::open_with_flags(&file, rusqlite::OpenFlags::default() | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW).map_err(|error| error.to_string())?;
    crate::private_fs::set_private_file_permissions(&file)?;
    db.busy_timeout(Duration::from_secs(10)).map_err(|error| error.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS settings_sync_records (name TEXT PRIMARY KEY, record_json TEXT);")
        .map_err(|error| error.to_string())?;
    Ok(db)
}

fn name(path: &Path) -> Result<&str, String> {
    path.file_name().and_then(|name| name.to_str()).ok_or_else(|| "Invalid settings synchronization record name".into())
}


fn saved(db: &Connection, key: &str) -> Result<Option<Option<String>>, String> {
    db.query_row("SELECT record_json FROM settings_sync_records WHERE name=?", [key], |row| row.get(0))
        .optional().map_err(|error| error.to_string())
}

pub(super) fn read<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    let db = open(path)?;
    let key = name(path)?;
    let body = saved(&db, key)?.flatten();
    match body {
        Some(body) => serde_json::from_str(&body).map_err(|error| format!("Could not read settings synchronization record {}: {error}", path.display())),
        None => Ok(T::default()),
    }
}

pub(super) fn write(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let body = serde_json::to_string(value).map_err(|error| error.to_string())?;
    open(path)?.execute("INSERT INTO settings_sync_records VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET record_json=excluded.record_json", params![name(path)?, body])
        .map_err(|error| error.to_string())?;
    Ok(())
}
