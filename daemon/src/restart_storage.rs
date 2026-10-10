use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::{fs, path::{Path, PathBuf}, time::Duration};

fn profile(directory: &Path) -> &Path {
    match directory.parent().filter(|parent| parent.file_name().is_some_and(|name| name == "daemons")) {
        Some(parent) => parent.parent().unwrap_or(directory),
        None => directory,
    }
}

fn open(directory: &Path) -> Result<Connection, String> {
    let root = profile(directory);
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let file = root.join("sessions.sqlite");
    let db = Connection::open_with_flags(&file, rusqlite::OpenFlags::default() | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW).map_err(|error| error.to_string())?;
    crate::private_fs::set_private_file_permissions(&file)?;
    db.busy_timeout(Duration::from_secs(10)).map_err(|error| error.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS daemon_restart_records (directory TEXT NOT NULL, name TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(directory, name));


        CREATE TABLE IF NOT EXISTS daemon_restart_backups (directory TEXT NOT NULL, id TEXT NOT NULL, record_json TEXT, PRIMARY KEY(directory, id));
        ").map_err(|error| error.to_string())?;
    Ok(db)
}





pub(crate) fn save_backup(directory: &Path, id: &str, record: &impl Serialize) -> Result<(), String> {
    let db = open(directory)?;
    let body = serde_json::to_string(record).map_err(|error| error.to_string())?;
    db.execute("INSERT INTO daemon_restart_backups VALUES (?, ?, ?) ON CONFLICT(directory, id) DO UPDATE SET record_json=excluded.record_json",
        rusqlite::params![directory.to_string_lossy(), id, body]).map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn read_backup(directory: &Path, id: &str) -> Result<Option<Value>, String> {
    let db = open(directory)?;
    let body: Option<Option<String>> = db.query_row("SELECT record_json FROM daemon_restart_backups WHERE directory=? AND id=?",
        rusqlite::params![directory.to_string_lossy(), id], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    body.flatten().map(|body| serde_json::from_str(&body).map_err(|error| error.to_string())).transpose()
}

pub(crate) fn remove_backup(directory: &Path, id: &str) -> Result<(), String> {
    let db = open(directory)?;
    db.execute("DELETE FROM daemon_restart_backups WHERE directory=? AND id=?", rusqlite::params![directory.to_string_lossy(), id]).map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn backups(directory: &Path) -> Result<Vec<String>, String> {
    let db = open(directory)?;
    let mut statement = db.prepare("SELECT id FROM daemon_restart_backups WHERE directory=? ORDER BY id").map_err(|error| error.to_string())?;
    let rows = statement.query_map([directory.to_string_lossy()], |row| row.get(0)).map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}




fn location(path: &Path) -> Result<(PathBuf, &str), String> {
    let directory = path.parent().ok_or("Restart record has no directory")?;
    let directory = directory.canonicalize().unwrap_or_else(|_| directory.to_path_buf());
    let name = path.file_name().and_then(|value| value.to_str()).ok_or("Invalid restart record name")?;
    Ok((directory, name))
}

fn record_database(directory: &Path, _name: &str) -> Result<Connection, String> {
    let db = open(directory)?;
    Ok(db)
}

pub(crate) fn read(path: &Path) -> Result<Option<Value>, String> {
    let (directory, name) = location(path)?;
    let db = record_database(&directory, name)?;
    let body: Option<String> = db.query_row("SELECT record_json FROM daemon_restart_records WHERE directory=? AND name=?",
        rusqlite::params![directory.to_string_lossy(), name], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    body.map(|body| serde_json::from_str(&body).map_err(|error| error.to_string())).transpose()
}

pub(crate) fn write(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let (directory, name) = location(path)?;
    let db = record_database(&directory, name)?;
    let body = serde_json::to_string(value).map_err(|error| error.to_string())?;
    db.execute("INSERT INTO daemon_restart_records VALUES (?, ?, ?) ON CONFLICT(directory, name) DO UPDATE SET record_json=excluded.record_json",
        rusqlite::params![directory.to_string_lossy(), name, body]).map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn remove(path: &Path) -> Result<(), String> {
    let (directory, name) = location(path)?;
    let db = record_database(&directory, name)?;
    db.execute("DELETE FROM daemon_restart_records WHERE directory=? AND name=?", rusqlite::params![directory.to_string_lossy(), name]).map_err(|error| error.to_string())?;
    Ok(())
}
