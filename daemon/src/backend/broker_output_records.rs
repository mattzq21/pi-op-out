use std::{fs, path::{Path, PathBuf}};
use rusqlite::{Connection};
use uuid::Uuid;

fn open(root: &Path) -> Result<Connection, String> {
    let profile = root.parent().ok_or("Agent output has no storage root")?;
    let db = crate::session_registry::open(profile)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS broker_output_directories (output_id TEXT PRIMARY KEY);
")
        .map_err(|error| error.to_string())?;
    Ok(db)
}

pub(super) fn reserve(root: &Path, id: Uuid) -> Result<(), String> {
    open(root)?.execute("INSERT INTO broker_output_directories VALUES (?)", [id.to_string()]).map_err(|error| error.to_string())?;
    Ok(())
}


pub(super) fn paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    let db = open(root)?;
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
