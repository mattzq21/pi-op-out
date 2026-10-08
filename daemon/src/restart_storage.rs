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
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    options.open(&file).map_err(|error| error.to_string())?;
    let mut db = Connection::open(file).map_err(|error| error.to_string())?;
    db.busy_timeout(Duration::from_secs(10)).map_err(|error| error.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS daemon_restart_records (directory TEXT NOT NULL, name TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(directory, name));
        CREATE TABLE IF NOT EXISTS daemon_restart_imports (directory TEXT PRIMARY KEY);").map_err(|error| error.to_string())?;
    import(&mut db, directory)?;
    Ok(db)
}

fn import(db: &mut Connection, directory: &Path) -> Result<(), String> {
    let transaction = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let imported: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM daemon_restart_imports WHERE directory=?)", [directory.to_string_lossy()], |row| row.get(0)).map_err(|error| error.to_string())?;
    if !imported {
        for name in ["restart-plan.json", "restart-status.json", "restart-ready.json"] { import_record(&transaction, directory, name)?; }
        transaction.execute("INSERT INTO daemon_restart_imports VALUES (?)", [directory.to_string_lossy()]).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn import_record(db: &Connection, directory: &Path, name: &str) -> Result<(), String> {
    let body = match fs::read_to_string(directory.join(name)) {
        Ok(body) => body,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    db.execute("INSERT INTO daemon_restart_records VALUES (?, ?, ?)", rusqlite::params![directory.to_string_lossy(), name, body]).map_err(|error| error.to_string())?;
    Ok(())
}

fn location(path: &Path) -> Result<(PathBuf, &str), String> {
    let directory = path.parent().ok_or("Restart record has no directory")?;
    let directory = directory.canonicalize().unwrap_or_else(|_| directory.to_path_buf());
    let name = path.file_name().and_then(|value| value.to_str()).ok_or("Invalid restart record name")?;
    Ok((directory, name))
}

pub(crate) fn read(path: &Path) -> Result<Option<Value>, String> {
    let (directory, name) = location(path)?;
    let db = open(&directory)?;
    let body: Option<String> = db.query_row("SELECT record_json FROM daemon_restart_records WHERE directory=? AND name=?",
        rusqlite::params![directory.to_string_lossy(), name], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    body.map(|body| serde_json::from_str(&body).map_err(|error| error.to_string())).transpose()
}

pub(crate) fn write(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let (directory, name) = location(path)?;
    let db = open(&directory)?;
    let body = serde_json::to_string(value).map_err(|error| error.to_string())?;
    db.execute("INSERT INTO daemon_restart_records VALUES (?, ?, ?) ON CONFLICT(directory, name) DO UPDATE SET record_json=excluded.record_json",
        rusqlite::params![directory.to_string_lossy(), name, body]).map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn remove(path: &Path) -> Result<(), String> {
    let (directory, name) = location(path)?;
    let db = open(&directory)?;
    db.execute("DELETE FROM daemon_restart_records WHERE directory=? AND name=?", rusqlite::params![directory.to_string_lossy(), name]).map_err(|error| error.to_string())?;
    Ok(())
}
