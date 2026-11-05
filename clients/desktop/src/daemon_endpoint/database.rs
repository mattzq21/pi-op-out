// The only owner of the daemon's database file and connection. The daemon is the only writer, so the app opens it read-only.
use super::*;
use rusqlite::OptionalExtension;

const FILE_NAME: &str = "sessions.sqlite";

fn open(busy_timeout: Duration) -> Result<rusqlite::Connection, String> {
    let file = directory()?.join(FILE_NAME);
    if !file.exists() { return Err("Daemon connection is not available".into()); }
    let db = rusqlite::Connection::open_with_flags(file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error| error.to_string())?;
    db.busy_timeout(busy_timeout).map_err(|error| error.to_string())?;
    Ok(db)
}

pub(super) fn endpoint() -> Result<Endpoint, String> {
    let body: Option<Option<Vec<u8>>> = open(Duration::from_secs(10))?
        .query_row("SELECT body FROM application_settings WHERE name='daemon'", [], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?;
    let body = body.flatten().ok_or("Daemon connection is not available")?;
    serde_json::from_slice(&body).map_err(|error| error.to_string())
}

pub(super) fn restart_status() -> Result<Value, String> {
    let body: Option<String> = open(Duration::from_secs(2))?
        .query_row("SELECT record_json FROM restart_records WHERE name='status'", [], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?;
    serde_json::from_str(&body.ok_or("Restart status is missing")?).map_err(|error| error.to_string())
}
