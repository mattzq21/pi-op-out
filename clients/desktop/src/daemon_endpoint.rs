use super::*;

pub(crate) const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);

pub(crate) use piop_protocol::Endpoint;

pub(crate) fn directory() -> Result<PathBuf, String> {
    let root = home_dir()?.join(STORAGE_DIRECTORY);
    if !DEVELOPMENT { return Ok(root); }
    let project = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).ok_or("Cannot locate project directory")?;
    Ok(root.join("daemons").join(piop_protocol::development_endpoint_key(project)))
}


// The daemon's connection record. The daemon is the only writer of its database, so the app opens it read-only.
pub(crate) fn read() -> Result<Endpoint, String> {
    use rusqlite::OptionalExtension;
    let file = directory()?.join("sessions.sqlite");
    if !file.exists() { return Err("Daemon connection is not available".into()); }
    let db = rusqlite::Connection::open_with_flags(file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error| error.to_string())?;
    db.busy_timeout(Duration::from_secs(10)).map_err(|error| error.to_string())?;
    let body: Option<Option<Vec<u8>>> = db.query_row("SELECT body FROM application_settings WHERE name='daemon'", [], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?;
    let body = body.flatten().ok_or("Daemon connection is not available")?;
    serde_json::from_slice(&body).map_err(|error| error.to_string())
}

pub(crate) fn restart_active() -> bool {
    let Ok(directory) = directory() else { return false; };
    let Ok(status) = restart_status(&directory) else { return false; };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    matches!(status["phase"].as_str(), Some("preparing" | "armed" | "restarting")) && status["expiresAt"].as_u64().unwrap_or(0) > now
}

fn restart_status(directory: &Path) -> Result<Value, String> {
    use rusqlite::OptionalExtension;
    let directory = directory.canonicalize().map_err(|error| error.to_string())?;
    let file = directory.join("sessions.sqlite");
    let db = rusqlite::Connection::open_with_flags(file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error| error.to_string())?;
    db.busy_timeout(Duration::from_secs(2)).map_err(|error| error.to_string())?;
    let body: Option<String> = db.query_row("SELECT record_json FROM restart_records WHERE name='status'", [], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?;
    serde_json::from_str(&body.ok_or("Restart status is missing")?).map_err(|error| error.to_string())
}
