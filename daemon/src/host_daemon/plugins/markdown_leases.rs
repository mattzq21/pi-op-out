use rusqlite::{Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use uuid::Uuid;

fn open(root: &Path) -> Result<Connection, String> {
    let db = crate::session_registry::open(root)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS note_editor_leases (session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL)").map_err(|error| error.to_string())?;
    Ok(db)
}




fn identity(path: &Path) -> Result<String, String> {
    let name = path.file_stem().and_then(|name| name.to_str()).ok_or("Missing note session identity")?;
    Uuid::parse_str(name).map(|id| id.to_string()).map_err(|_| "Invalid note session identity".into())
}

fn root(path: &Path) -> Result<&Path, String> {
    path.parent().and_then(Path::parent).and_then(Path::parent).ok_or_else(|| "Note editor record has no storage root".into())
}

pub(super) fn read(path: &Path) -> Result<Option<String>, String> {
    open(root(path)?)?.query_row("SELECT record_json FROM note_editor_leases WHERE session_id=?", [identity(path)?], |row| row.get(0))
        .optional().map_err(|error| error.to_string())
}

pub(super) fn write(path: &Path, body: Option<&str>) -> Result<(), String> {
    let db = open(root(path)?)?;
    let id = identity(path)?;
    if let Some(body) = body {
        let written = db.execute("INSERT INTO note_editor_leases SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM sessions WHERE session_id=?1) ON CONFLICT(session_id) DO UPDATE SET record_json=excluded.record_json", [id.as_str(), body])
            .map_err(|error| error.to_string())?;
        if written == 0 { return Err("Cannot assign a note editor to a deleted session".into()); }
    } else {
        db.execute("DELETE FROM note_editor_leases WHERE session_id=?", [id]).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(super) fn list(root: &Path) -> Result<Vec<PathBuf>, String> {
    let db = open(root)?;
    let mut statement = db.prepare("SELECT session_id FROM note_editor_leases ORDER BY session_id").map_err(|error| error.to_string())?;
    let ids = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(ids.into_iter().map(|id| root.join("notes").join("leases").join(format!("{id}.json"))).collect())
}
