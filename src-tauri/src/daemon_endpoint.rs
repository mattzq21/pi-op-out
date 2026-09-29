use super::*;

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Endpoint {
    pub url: String,
    pub token: String,
    pub protocol: u32,
}

pub(crate) fn directory() -> Result<PathBuf, String> {
    let root = home_dir()?.join(STORAGE_DIRECTORY);
    if !DEVELOPMENT { return Ok(root); }
    let key = env!("CARGO_MANIFEST_DIR").bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    Ok(root.join("daemons").join(format!("{key:016x}")))
}

pub(crate) fn path() -> Result<PathBuf, String> { Ok(directory()?.join("daemon.json")) }
pub(crate) fn read() -> Result<Endpoint, String> {
    serde_json::from_slice(&fs::read(path()?).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

#[cfg(not(feature = "desktop"))]
pub(crate) fn identity() -> Result<String, String> {
    let path = directory()?.join("daemon-id");
    if !path.exists() { atomic_write_private(&path, Uuid::new_v4().to_string().as_bytes())?; }
    let value = fs::read_to_string(path).map_err(|error| error.to_string())?;
    Uuid::parse_str(value.trim()).map(|id| id.to_string()).map_err(|_| "Invalid daemon identity".into())
}

#[cfg(not(feature = "desktop"))]
pub(crate) fn claim() -> Result<fs::File, String> {
    let directory = directory()?;
    ensure_private_dir(&directory)?;
    let path = directory.join("daemon.lock");
    let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(&path).map_err(|error| error.to_string())?;
    set_private_file_permissions(&path)?;
    file.try_lock().map_err(|_| if DEVELOPMENT { "A Piop debug daemon is already running for this worktree" } else { "A Piop daemon is already running for this configuration directory" }.to_string())?;
    Ok(file)
}

#[cfg(not(feature = "desktop"))]
pub(crate) fn publish(address: std::net::SocketAddr, token: String) -> Result<(), String> {
    let ip = match address.ip() {
        std::net::IpAddr::V4(ip) if ip.is_unspecified() => std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
        std::net::IpAddr::V6(ip) if ip.is_unspecified() => std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
        ip => ip,
    };
    let endpoint = Endpoint { url: format!("ws://{}", std::net::SocketAddr::new(ip, address.port())), token, protocol: 1 };
    atomic_write_private(&path()?, &serde_json::to_vec(&endpoint).map_err(|error| error.to_string())?)
}
