use super::*;

pub(crate) const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);

pub(crate) use piop_protocol::Endpoint;

pub(crate) fn directory() -> Result<PathBuf, String> {
    let root = home_dir()?.join(STORAGE_DIRECTORY);
    if !DEVELOPMENT { return Ok(root); }
    let project = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).ok_or("Cannot locate project directory")?;
    Ok(root.join("daemons").join(piop_protocol::development_endpoint_key(project)))
}

pub(crate) fn path() -> Result<PathBuf, String> { Ok(directory()?.join("daemon.json")) }

pub(crate) fn read() -> Result<Endpoint, String> {
    let body = crate::client_settings::records::read(&path()?)?.ok_or("Daemon connection is not available")?;
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
    let file = home_dir()?.join(STORAGE_DIRECTORY).join("sessions.sqlite");
    let db = rusqlite::Connection::open_with_flags(file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error| error.to_string())?;
    db.busy_timeout(Duration::from_secs(2)).map_err(|error| error.to_string())?;
    let body: Option<String> = db.query_row("SELECT record_json FROM daemon_restart_records WHERE directory=? AND name='restart-status.json'",
        [directory.to_string_lossy()], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    serde_json::from_str(&body.ok_or("Restart status is missing")?).map_err(|error| error.to_string())
}
