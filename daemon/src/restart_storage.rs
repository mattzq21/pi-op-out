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
        CREATE TABLE IF NOT EXISTS daemon_restart_imports (directory TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS daemon_plugin_imports (directory TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS daemon_restart_backups (directory TEXT NOT NULL, id TEXT NOT NULL, record_json TEXT, PRIMARY KEY(directory, id));
        CREATE TABLE IF NOT EXISTS daemon_restart_backup_imports (directory TEXT PRIMARY KEY);").map_err(|error| error.to_string())?;
    import(&mut db, directory)?;
    import_backups(&mut db, directory)?;
    Ok(db)
}

fn import_backups(db: &mut Connection, directory: &Path) -> Result<(), String> {
    let transaction = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let imported: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM daemon_restart_backup_imports WHERE directory=?)", [directory.to_string_lossy()], |row| row.get(0)).map_err(|error| error.to_string())?;
    if !imported {
        import_backup_directory(&transaction, directory)?;
        transaction.execute("INSERT INTO daemon_restart_backup_imports VALUES (?)", [directory.to_string_lossy()]).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn import_backup_directory(db: &Connection, directory: &Path) -> Result<(), String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let filename = entry.file_name();
        let Some(id) = backup_id(&filename.to_string_lossy()) else { continue; };
        import_backup(db, directory, &id)?;
    }
    Ok(())
}

fn backup_id(name: &str) -> Option<String> {
    let name = name.strip_prefix("restart-")?;
    let id = name.strip_suffix(".artifact.json").or_else(|| name.strip_suffix(std::env::consts::EXE_SUFFIX))?;
    let parsed = uuid::Uuid::parse_str(id).ok()?.to_string();
    (parsed == id).then_some(parsed)
}

fn import_backup(db: &Connection, directory: &Path, id: &str) -> Result<(), String> {
    let body = match fs::read_to_string(directory.join(format!("restart-{id}.artifact.json"))) {
        Ok(body) => Some(body),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    db.execute("INSERT OR IGNORE INTO daemon_restart_backups VALUES (?, ?, ?)", rusqlite::params![directory.to_string_lossy(), id, body]).map_err(|error| error.to_string())?;
    Ok(())
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

fn import(db: &mut Connection, directory: &Path) -> Result<(), String> {
    let transaction = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let imported: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM daemon_restart_imports WHERE directory=?)", [directory.to_string_lossy()], |row| row.get(0)).map_err(|error| error.to_string())?;
    if !imported {
        for name in ["restart-plan.json", "restart-status.json", "restart-ready.json"] { import_record(&transaction, directory, name)?; }
        transaction.execute("INSERT INTO daemon_restart_imports VALUES (?)", [directory.to_string_lossy()]).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn import_plugins(db: &mut Connection, directory: &Path) -> Result<(), String> {
    let transaction = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let imported: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM daemon_plugin_imports WHERE directory=?)", [directory.to_string_lossy()], |row| row.get(0)).map_err(|error| error.to_string())?;
    if !imported {
        import_record(&transaction, directory, "plugins.json")?;
        transaction.execute("INSERT INTO daemon_plugin_imports VALUES (?)", [directory.to_string_lossy()]).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn import_record(db: &Connection, directory: &Path, name: &str) -> Result<(), String> {
    let saved: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM daemon_restart_records WHERE directory=? AND name=?)", rusqlite::params![directory.to_string_lossy(), name], |row| row.get(0)).map_err(|error| error.to_string())?;
    if saved { return Ok(()); }
    let body = match fs::read_to_string(directory.join(name)) {
        Ok(body) => body,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    db.execute("INSERT INTO daemon_restart_records VALUES (?, ?, ?) ON CONFLICT(directory, name) DO NOTHING", rusqlite::params![directory.to_string_lossy(), name, body]).map_err(|error| error.to_string())?;
    Ok(())
}

fn location(path: &Path) -> Result<(PathBuf, &str), String> {
    let directory = path.parent().ok_or("Restart record has no directory")?;
    let directory = directory.canonicalize().unwrap_or_else(|_| directory.to_path_buf());
    let name = path.file_name().and_then(|value| value.to_str()).ok_or("Invalid restart record name")?;
    Ok((directory, name))
}

fn record_database(directory: &Path, name: &str) -> Result<Connection, String> {
    let mut db = open(directory)?;
    if name == "plugins.json" { import_plugins(&mut db, directory)?; }
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
