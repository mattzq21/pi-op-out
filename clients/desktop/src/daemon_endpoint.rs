use super::*;

pub(crate) const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);

pub(crate) use piop_protocol::Endpoint;

pub(crate) fn directory() -> Result<PathBuf, String> {
    let root = home_dir()?.join(STORAGE_DIRECTORY);
    if !DEVELOPMENT { return Ok(root); }
    let project = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).ok_or("Cannot locate project directory")?;
    Ok(root.join("daemons").join(piop_protocol::development_endpoint_key(project)))
}

mod database;

pub(crate) fn read() -> Result<Endpoint, String> { database::endpoint() }

pub(crate) fn restart_active() -> bool {
    let Ok(status) = database::restart_status() else { return false; };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    matches!(status["phase"].as_str(), Some("preparing" | "armed" | "restarting")) && status["expiresAt"].as_u64().unwrap_or(0) > now
}
