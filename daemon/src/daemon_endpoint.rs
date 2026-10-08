use super::*;

pub(crate) const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);

pub(crate) use piop_protocol::Endpoint;

pub(crate) fn directory() -> Result<PathBuf, String> {
    let root = home_dir()?.join(STORAGE_DIRECTORY);
    if !DEVELOPMENT { return Ok(root); }
    let project = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(1).ok_or("Cannot locate project directory")?;
    Ok(root.join("daemons").join(piop_protocol::development_endpoint_key(project)))
}

pub(crate) fn path() -> Result<PathBuf, String> { Ok(directory()?.join("daemon.json")) }

#[cfg(debug_assertions)]
pub(crate) fn debug_runtime() -> Result<Value, String> {
    static RUNTIME: std::sync::OnceLock<Result<Value, String>> = std::sync::OnceLock::new();
    RUNTIME.get_or_init(|| {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let binary = if cfg!(target_os = "linux") { PathBuf::from("/proc/self/exe") } else { executable.clone() };
        let extension_root = crate::extensions::generated_extension_root()?;
        Ok(json!({
            "processId":std::process::id(),
            "project":Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(1),
            "executable":executable,
            "buildIdentity":debug_binary_identity(&binary)?,
            "profileHome":home_dir()?,
            "daemonDirectory":directory()?,
            "daemonLog":directory()?.join("daemon.log"),
            "extensionRoot":extension_root,
            "runtimeSettingsPath":extension_root.join("runtime-settings.json")
        }))
    }).clone()
}

#[cfg(debug_assertions)]
fn debug_binary_identity(path: &Path) -> Result<String, String> {
    use sha2::Digest;
    use std::io::Read;
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hash = sha2::Sha256::new();
    let mut buffer = [0u8; 65_536];
    loop {
        let length = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if length == 0 { break; }
        hash.update(&buffer[..length]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(crate) fn read() -> Result<Endpoint, String> {
    serde_json::from_slice(&fs::read(path()?).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

pub(crate) fn restart_active() -> bool {
    let Ok(directory) = directory() else { return false; };
    let Ok(Some(status)) = crate::restart_storage::read(&directory.join("restart-status.json")) else { return false; };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    matches!(status["phase"].as_str(), Some("preparing" | "armed" | "restarting")) && status["expiresAt"].as_u64().unwrap_or(0) > now
}

pub(crate) fn identity() -> Result<String, String> {
    let path = directory()?.join("daemon-id");
    if !path.exists() { atomic_write_private(&path, Uuid::new_v4().to_string().as_bytes())?; }
    let value = fs::read_to_string(path).map_err(|error| error.to_string())?;
    Uuid::parse_str(value.trim()).map(|id| id.to_string()).map_err(|_| "Invalid daemon identity".into())
}

pub(crate) fn claim() -> Result<fs::File, String> {
    let directory = directory()?;
    ensure_private_dir(&directory)?;
    let path = directory.join("daemon.lock");
    let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(&path).map_err(|error| error.to_string())?;
    set_private_file_permissions(&path)?;
    file.try_lock().map_err(|_| if DEVELOPMENT { "A Piop debug daemon is already running for this worktree" } else { "A Piop daemon is already running for this configuration directory" }.to_string())?;
    Ok(file)
}

pub(crate) fn publish(address: std::net::SocketAddr, token: String) -> Result<(), String> {
    let ip = match address.ip() {
        std::net::IpAddr::V4(ip) if ip.is_unspecified() => std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
        std::net::IpAddr::V6(ip) if ip.is_unspecified() => std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
        ip => ip,
    };
    let endpoint = Endpoint { url: format!("ws://{}", std::net::SocketAddr::new(ip, address.port())), token, protocol: piop_protocol::PROTOCOL_VERSION };
    atomic_write_private(&path()?, &serde_json::to_vec(&endpoint).map_err(|error| error.to_string())?)
}
