use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use std::{fs, path::Path, time::Duration};

fn database_file(root: &Path) -> Result<std::path::PathBuf, String> {
    crate::private_fs::ensure_private_dir(root)?;
    let file = root.join("sessions.sqlite");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options.open(&file).map_err(|error| error.to_string())?;
    crate::private_fs::set_private_file_permissions(&file)?;
    Ok(file)
}

fn open(path: &Path) -> Result<Connection, String> {
    let root = path.parent().ok_or("Settings synchronization record has no directory")?;
    let db = Connection::open(database_file(root)?).map_err(|error| error.to_string())?;
    db.busy_timeout(Duration::from_secs(10)).map_err(|error| error.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS settings_sync_records (name TEXT PRIMARY KEY, record_json TEXT);")
        .map_err(|error| error.to_string())?;
    Ok(db)
}

fn name(path: &Path) -> Result<&str, String> {
    path.file_name().and_then(|name| name.to_str()).ok_or_else(|| "Invalid settings synchronization record name".into())
}

fn legacy(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(body) => Ok(Some(body)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn saved(db: &Connection, key: &str) -> Result<Option<Option<String>>, String> {
    db.query_row("SELECT record_json FROM settings_sync_records WHERE name=?", [key], |row| row.get(0))
        .optional().map_err(|error| error.to_string())
}

pub(super) fn read<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    let db = open(path)?;
    let key = name(path)?;
    let body = match saved(&db, key)? {
        Some(body) => body,
        None => {
            db.execute("INSERT INTO settings_sync_records VALUES (?, ?) ON CONFLICT(name) DO NOTHING", params![key, legacy(path)?])
                .map_err(|error| error.to_string())?;
            saved(&db, key)?.flatten()
        }
    };
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
