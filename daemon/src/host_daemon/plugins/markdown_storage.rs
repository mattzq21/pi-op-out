use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::path::Path;
use uuid::Uuid;

const MAX_BYTES: u64 = 4 * 1024 * 1024;

fn open(path: &Path) -> Result<(Connection, String), String> {
    let root = path.parent().and_then(Path::parent).and_then(Path::parent).ok_or("Note has no storage root")?;
    let name = path.file_stem().and_then(|name| name.to_str()).ok_or("Note has no session identity")?;
    let id = Uuid::parse_str(name).map_err(|_| "Invalid note session identity")?.to_string();
    let db = crate::session_registry::open(root)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS chat_notes (session_id TEXT PRIMARY KEY, content TEXT NOT NULL)").map_err(|error| error.to_string())?;
    Ok((db, id))
}

fn deleted(db: &Connection, id: &str) -> Result<bool, String> {
    db.query_row("SELECT NOT EXISTS(SELECT 1 FROM sessions WHERE session_id=?)", [id], |row| row.get(0)).map_err(|error| error.to_string())
}


fn stored(db: &Connection, id: &str) -> Result<String, String> {
    let saved: Option<String> = db.query_row("SELECT content FROM chat_notes WHERE session_id=?", [id], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    if let Some(body) = saved { return Ok(body); }
    let body = String::new();
    db.execute("INSERT INTO chat_notes VALUES (?, ?)", [id, &body]).map_err(|error| error.to_string())?;
    Ok(body)
}

pub(super) fn read(path: &Path) -> Result<String, String> {
    let (mut db, id) = open(path)?;
    let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let body = if deleted(&transaction, &id)? { String::new() } else { stored(&transaction, &id)? };
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(body)
}

pub(super) fn write(path: &Path, body: &str, expected: &str) -> Result<(), String> {
    if body.len() as u64 > MAX_BYTES { return Err("Notes must be smaller than 4 MB".into()); }
    let (mut db, id) = open(path)?;
    let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    if deleted(&transaction, &id)? { return Err("Cannot save a note for a deleted session".into()); }
    let previous = stored(&transaction, &id)?;
    if format!("{:x}", Sha256::digest(previous.as_bytes())) != expected { return Err("This chat’s note changed. Load it again before saving.".into()); }
    transaction.execute("UPDATE chat_notes SET content=? WHERE session_id=?", [body, &id]).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}
