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
    serde_json::from_slice(&fs::read(path()?).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

pub(crate) fn restart_active() -> bool {
    let Ok(directory) = directory() else { return false; };
    let Ok(bytes) = fs::read(directory.join("restart-status.json")) else { return false; };
    let Ok(status) = serde_json::from_slice::<Value>(&bytes) else { return false; };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    matches!(status["phase"].as_str(), Some("preparing" | "armed" | "restarting")) && status["expiresAt"].as_u64().unwrap_or(0) > now
}
