use super::*;

pub(super) fn configuration() -> Result<Option<Vec<String>>, String> {
    match std::env::var("PIOP_MOBILE_AUTH").as_deref().unwrap_or("token") {
        "token" => Ok(None),
        "tailscale" => {
            if !cfg!(target_os = "linux") { return Err("Tailscale authentication currently requires a Linux host".into()); }
            let users: Vec<_> = std::env::var("PIOP_TAILSCALE_USERS").unwrap_or_default().split(',').map(str::trim).filter(|user| !user.is_empty()).map(str::to_owned).collect();
            if users.is_empty() || users.iter().any(|user| !user.is_ascii() || user.contains('*') || user.chars().any(char::is_whitespace)) {
                return Err("Set PIOP_TAILSCALE_USERS to an explicit comma-separated list of Tailscale login names (no wildcards)".into());
            }
            Ok(Some(users))
        },
        _ => Err("PIOP_MOBILE_AUTH must be token or tailscale".into()),
    }
}

#[cfg(target_os = "linux")]
pub(super) fn start(users: Option<Vec<String>>, app: AppHandle, events: broadcast::Sender<Value>, connections: Arc<Semaphore>, jobs: Arc<Semaphore>) -> Result<(), String> {
    use std::os::unix::fs::FileTypeExt;
    let Some(users) = users else { return Ok(()); };
    let directory = home_dir()?.join(STORAGE_DIRECTORY);
    ensure_private_dir(&directory)?;
    let path = directory.join("tailscale.sock");
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_socket() => fs::remove_file(&path).map_err(|error| error.to_string())?,
        Ok(_) => return Err("Tailscale socket path is occupied by a non-socket file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(error.to_string()),
    }
    // The daemon instance lock is already held. Only this user and root can
    // reach this socket; peer credentials further restrict it to tailscaled.
    let listener = std::os::unix::net::UnixListener::bind(&path).map_err(|error| error.to_string())?;
    set_private_file_permissions(&path)?;
    listener.set_nonblocking(true).map_err(|error| error.to_string())?;
    crate::platform::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::UnixListener::from_std(listener) else { return; };
        while let Ok((stream, _)) = listener.accept().await {
            let Ok(permit) = connections.clone().try_acquire_owned() else { continue; };
            let app = app.clone(); let events = events.clone(); let jobs = jobs.clone(); let users = users.clone();
            tokio::spawn(async move {
                let _permit = permit;
                if let Ok(socket) = authenticate(stream, &users).await { let _ = serve_connection(app, socket, events, jobs).await; }
            });
        }
    });
    eprintln!("Tailscale authentication enabled at unix:{} (explicit user allowlist)", path.display());
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub(super) fn start(_: Option<Vec<String>>, _: AppHandle, _: broadcast::Sender<Value>, _: Arc<Semaphore>, _: Arc<Semaphore>) -> Result<(), String> { Ok(()) }

#[cfg(target_os = "linux")]
async fn authenticate(stream: tokio::net::UnixStream, users: &[String]) -> Result<tokio_tungstenite::WebSocketStream<tokio::net::UnixStream>, String> {
    use std::os::unix::fs::MetadataExt;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response, ErrorResponse};
    let peer = stream.peer_cred().map_err(|error| error.to_string())?;
    let pid = peer.pid().ok_or("Missing proxy peer PID")?;
    let executable = fs::read_link(format!("/proc/{pid}/exe")).map_err(|_| "Cannot verify Tailscale proxy")?;
    let expected = fs::canonicalize("/usr/sbin/tailscaled").map_err(|_| "Expected root-owned /usr/sbin/tailscaled")?;
    let metadata = fs::metadata(format!("/proc/{pid}/exe")).map_err(|_| "Cannot inspect Tailscale proxy")?;
    if peer.uid() != 0 || executable != expected || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 { return Err("Untrusted Tailscale proxy peer".into()); }
    let callback = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        let headers = request.headers();
        let login = headers.get("tailscale-user-login").and_then(|value| value.to_str().ok());
        // A web page must not borrow the browser's tailnet identity to control
        // Pi. These are the packaged Capacitor origins; native clients omit it.
        let origin_allowed = match headers.get("origin") {
            None => true,
            Some(value) => matches!(value.to_str(), Ok("https://localhost" | "capacitor://localhost")),
        };
        if headers.contains_key("tailscale-funnel-request") || !origin_allowed || !login.is_some_and(|login| users.iter().any(|user| user == login)) {
            return Err(Response::builder().status(403).body(Some("Tailscale identity is not authorized".into())).unwrap());
        }
        Ok(response)
    };
    let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE)).max_frame_size(Some(MAX_MESSAGE));
    let mut socket = tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::accept_hdr_async_with_config(stream, callback, Some(config))).await.map_err(|_| "Handshake timeout")?.map_err(|error| error.to_string())?;
    let first = tokio::time::timeout(Duration::from_secs(10), socket.next()).await.map_err(|_| "Authentication timeout")?.ok_or("Connection closed")?.map_err(|error| error.to_string())?;
    let packet: Value = serde_json::from_str(first.to_text().map_err(|_| "Expected authentication")?).map_err(|_| "Invalid authentication")?;
    if packet["type"] != "authenticate" || packet["mode"] != "tailscale" { let _ = socket.close(None).await; return Err("Select Tailscale authentication".into()); }
    Ok(socket)
}
