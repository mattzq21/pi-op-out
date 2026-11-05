use super::*;

pub(crate) const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);

pub(crate) use piop_protocol::Endpoint;

pub(crate) fn directory() -> Result<PathBuf, String> {
    let root = home_dir()?.join(STORAGE_DIRECTORY);
    if !DEVELOPMENT { return Ok(root); }
    let project = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).ok_or("Cannot locate project directory")?;
    Ok(root.join("daemons").join(piop_protocol::development_endpoint_key(project)))
}


// What the daemon program reports for a client that has no connection yet. Only the daemon reads its database.
#[derive(Deserialize)]
pub(crate) struct Connection {
    pub(crate) endpoint: Option<Endpoint>,
    pub(crate) restarting: bool,
}

pub(crate) async fn connection(executable: &Path) -> Result<Connection, String> {
    let output = tokio::time::timeout(Duration::from_secs(10), tokio::process::Command::new(executable)
        .arg("--connection").stdin(Stdio::null()).kill_on_drop(true).output()).await
        .map_err(|_| "Reading the Piop daemon connection timed out")?
        .map_err(|error| format!("Could not read the Piop daemon connection: {error}"))?;
    if !output.status.success() {
        return Err(format!("Could not read the Piop daemon connection: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    serde_json::from_slice(&output.stdout).map_err(|error| format!("The Piop daemon connection is not valid: {error}"))
}
