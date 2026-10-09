use std::{fs, path::{Path, PathBuf}};
use rusqlite::{Connection, TransactionBehavior};
use uuid::Uuid;

fn open(root: &Path) -> Result<Connection, String> {
    let profile = root.parent().ok_or("Agent output has no storage root")?;
    let db = crate::session_registry::open(profile)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS broker_output_directories (output_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS broker_output_legacy (path TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS broker_output_legacy_imports (directory TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS broker_output_import_state (id INTEGER PRIMARY KEY CHECK(id=1));")
        .map_err(|error| error.to_string())?;
    Ok(db)
}

pub(super) fn reserve(root: &Path, id: Uuid) -> Result<(), String> {
    open(root)?.execute("INSERT INTO broker_output_directories VALUES (?)", [id.to_string()]).map_err(|error| error.to_string())?;
    Ok(())
}

fn import(db: &mut Connection, root: &Path) -> Result<(), String> {
    let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let imported: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM broker_output_import_state)", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    if !imported {
        for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name();
            let Some(name) = name.to_str().filter(|name| Uuid::parse_str(name).is_ok()) else { continue; };
            transaction.execute("INSERT INTO broker_output_directories VALUES (?) ON CONFLICT DO NOTHING", [name]).map_err(|error| error.to_string())?;
        }
        transaction.execute("INSERT INTO broker_output_import_state VALUES (1)", []).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

pub(super) fn paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut db = open(root)?;
    import(&mut db, root)?;
    let mut query = db.prepare("SELECT output_id FROM broker_output_directories ORDER BY output_id").map_err(|error| error.to_string())?;
    let rows = query.query_map([], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
    rows.map(|row| {
        let name = row.map_err(|error| error.to_string())?;
        Uuid::parse_str(&name).map_err(|_| "Invalid saved agent output directory")?;
        Ok(root.join(name))
    }).collect()
}

pub(super) fn forget_missing(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(error.to_string()),
    }
    let root = path.parent().ok_or("Agent output has no parent")?;
    fs::File::open(root).and_then(|directory| directory.sync_all()).map_err(|error| error.to_string())?;
    let name = path.file_name().and_then(|name| name.to_str()).ok_or("Invalid agent output directory")?;
    open(root)?.execute("DELETE FROM broker_output_directories WHERE output_id=?", [name]).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn import_legacy(db: &mut Connection, temporary: &Path) -> Result<(), String> {
    let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let imported: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM broker_output_legacy_imports WHERE directory=?)", [temporary.to_string_lossy()], |row| row.get(0)).map_err(|error| error.to_string())?;
    if !imported {
        for entry in fs::read_dir(temporary).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if !legacy_name(&entry.path()) { continue; }
            transaction.execute("INSERT INTO broker_output_legacy VALUES (?) ON CONFLICT DO NOTHING", [entry.path().to_string_lossy()]).map_err(|error| error.to_string())?;
        }
        transaction.execute("INSERT INTO broker_output_legacy_imports VALUES (?)", [temporary.to_string_lossy()]).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
fn legacy_name(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()).and_then(|name| name.strip_prefix("pi-desktop-broker-")).is_some_and(|id| Uuid::parse_str(id).is_ok())
}

#[cfg(target_os = "linux")]
pub(super) fn legacy_paths(root: &Path, temporary: &Path) -> Result<Vec<PathBuf>, String> {
    let mut db = open(root)?;
    import_legacy(&mut db, temporary)?;
    let mut query = db.prepare("SELECT path FROM broker_output_legacy ORDER BY path").map_err(|error| error.to_string())?;
    let rows = query.query_map([], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
    rows.map(|row| {
        let path = PathBuf::from(row.map_err(|error| error.to_string())?);
        if !path.is_absolute() || !legacy_name(&path) { return Err("Invalid saved legacy output directory".into()); }
        Ok(path)
    }).collect()
}

#[cfg(target_os = "linux")]
pub(super) fn forget_legacy_missing(root: &Path, path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(error.to_string()),
    }
    let parent = path.parent().ok_or("Legacy agent output has no parent")?;
    fs::File::open(parent).and_then(|directory| directory.sync_all()).map_err(|error| error.to_string())?;
    open(root)?.execute("DELETE FROM broker_output_legacy WHERE path=?", [path.to_string_lossy()]).map_err(|error| error.to_string())?;
    Ok(())
}
