use super::*;

#[cfg(target_os = "linux")]
async fn host_login() -> Result<String, String> {
    let mut command = tokio::process::Command::new("/usr/bin/tailscale");
    command.args(["status", "--json"]).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(5), command.output()).await
        .map_err(|_| "Tailscale status timed out")?.map_err(|_| "Tailscale is not installed")?;
    if !output.status.success() { return Err("Cannot read the host's Tailscale identity".into()); }
    let status: Value = serde_json::from_slice(&output.stdout).map_err(|_| "Invalid Tailscale status")?;
    if status["BackendState"] != "Running" || status["Self"]["Tags"].as_array().is_some_and(|tags| !tags.is_empty()) {
        return Err("Sign the host into a personal Tailscale account to enable mobile access".into());
    }
    let id = status["Self"]["UserID"].as_u64().ok_or("Missing Tailscale host user")?.to_string();
    status["User"][&id]["LoginName"].as_str().filter(|login| !login.is_empty() && login.is_ascii())
        .map(str::to_owned).ok_or("Missing Tailscale host login".into())
}

#[cfg(target_os = "linux")]
fn prepare_listener() -> Result<(std::os::unix::net::UnixListener, PathBuf), String> {
    let directory = daemon_endpoint::directory()?;
    ensure_private_dir(&directory)?;
    let path = directory.join("tailscale.sock");
    remove_previous_socket(&path)?;
    let listener = std::os::unix::net::UnixListener::bind(&path).map_err(|error| error.to_string())?;
    set_private_file_permissions(&path)?;
    listener.set_nonblocking(true).map_err(|error| error.to_string())?;
    Ok((listener, path))
}

#[cfg(target_os = "linux")]
fn remove_previous_socket(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::FileTypeExt;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_socket() => fs::remove_file(path).map_err(|error| error.to_string()),
        Ok(_) => Err("Tailscale socket path is occupied by a non-socket file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(target_os = "linux")]
pub(super) fn start(app: AppHandle, events: broadcast::Sender<Value>, connections: Arc<Semaphore>, jobs: Arc<Semaphore>) -> Result<(), String> {
    let (listener, path) = prepare_listener()?;
    crate::platform::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::UnixListener::from_std(listener) else { return; };
        while let Ok((stream, _)) = listener.accept().await {
            let Ok(permit) = connections.clone().try_acquire_owned() else { continue; };
            let app = app.clone(); let events = events.clone(); let jobs = jobs.clone();
            tokio::spawn(async move {
                let _permit = permit;
                match authenticate(stream).await {
                    Ok(socket) => { let _ = serve_connection(app, socket, events, jobs).await; },
                    Err(error) => eprintln!("Tailscale connection rejected: {error}"),
                }
            });
        }
    });
    eprintln!("Tailscale authentication enabled at unix:{} (host Tailscale account only)", path.display());
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub(super) fn start(_: AppHandle, _: broadcast::Sender<Value>, _: Arc<Semaphore>, _: Arc<Semaphore>) -> Result<(), String> { Ok(()) }

#[cfg(target_os = "linux")]
async fn verify_proxy_peer(stream: &tokio::net::UnixStream) -> Result<(), String> {
    let peer = stream.peer_cred().map_err(|error| error.to_string())?;
    let pid = peer.pid().ok_or("Missing proxy peer PID")?;
    if peer.uid() != 0 { return Err("Untrusted Tailscale proxy peer".into()); }
    let mut command = tokio::process::Command::new("/usr/bin/systemctl");
    command.args(["--system", "show", "tailscaled.service", "--property=MainPID", "--value"]).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(5), command.output()).await
        .map_err(|_| "Tailscale service lookup timed out")?.map_err(|_| "Cannot verify tailscaled system service")?;
    let service_pid = std::str::from_utf8(&output.stdout).ok().and_then(|value| value.trim().parse::<i32>().ok());
    if !output.status.success() || service_pid != Some(pid) || pid <= 0 { return Err("Untrusted Tailscale proxy peer".into()); }
    Ok(())
}

#[cfg(target_os = "linux")]
async fn authenticate(stream: tokio::net::UnixStream) -> Result<tokio_tungstenite::WebSocketStream<tokio::net::UnixStream>, String> {
    verify_proxy_peer(&stream).await?;
    let allowed_login = host_login().await?;
    let callback = TailscaleIdentity { login: allowed_login };
    let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE)).max_frame_size(Some(MAX_MESSAGE));
    let mut socket = tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::accept_hdr_async_with_config(stream, callback, Some(config))).await.map_err(|_| "Handshake timeout")?.map_err(|error| error.to_string())?;
    authenticate_mode(&mut socket).await?;
    Ok(socket)
}

#[cfg(target_os = "linux")]
async fn authenticate_mode(socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::UnixStream>) -> Result<(), String> {
    let first = tokio::time::timeout(Duration::from_secs(10), socket.next()).await.map_err(|_| "Authentication timeout")?.ok_or("Connection closed")?.map_err(|error| error.to_string())?;
    let packet: Value = serde_json::from_str(first.to_text().map_err(|_| "Expected authentication")?).map_err(|_| "Invalid authentication")?;
    if packet["type"] != "authenticate" || packet["mode"] != "tailscale" { let _ = socket.close(None).await; return Err("Select Tailscale authentication".into()); }
    Ok(())
}

#[cfg(target_os = "linux")]
struct TailscaleIdentity { login: String }

#[cfg(target_os = "linux")]
impl tokio_tungstenite::tungstenite::handshake::server::Callback for TailscaleIdentity {
    fn on_request(self, request: &tokio_tungstenite::tungstenite::handshake::server::Request, response: tokio_tungstenite::tungstenite::handshake::server::Response) -> Result<tokio_tungstenite::tungstenite::handshake::server::Response, tokio_tungstenite::tungstenite::handshake::server::ErrorResponse> {
        use tokio_tungstenite::tungstenite::handshake::server::Response;
        let headers = request.headers();
        let login = headers.get("tailscale-user-login").and_then(|value| value.to_str().ok());
        let origin_allowed = match headers.get("origin") {
            None => true,
            Some(value) => matches!(value.to_str(), Ok("https://localhost" | "capacitor://localhost")),
        };
        if headers.contains_key("tailscale-funnel-request") || !origin_allowed || login != Some(self.login.as_str()) {
            return Err(Response::builder().status(403).body(Some("Tailscale identity is not authorized".into())).unwrap());
        }
        Ok(response)
    }
}
