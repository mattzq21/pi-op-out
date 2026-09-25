use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio_tungstenite::{connect_async_with_config, tungstenite::{Message, protocol::WebSocketConfig}};

const MAX_FRAME: usize = 128 * 1024 * 1024;
type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn validate_endpoint(protocol: u32, token: &str, address: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(address).map_err(|error| error.to_string())?;
    if protocol != 1 || token.len() < 32 || url.scheme() != "ws" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]" | "::1")) {
        return Err("SSH must attach to a local Piop daemon endpoint".into());
    }
    Ok(())
}

async fn authenticate_socket(socket: &mut Socket, token: &str) -> Result<Value, String> {
    socket.send(Message::Text(json!({"type":"authenticate","token":token,"scope":"peer"}).to_string().into())).await.map_err(|error| error.to_string())?;
    let reply = socket.next().await.ok_or("Daemon closed during authentication")?.map_err(|error| error.to_string())?;
    let ready: Value = serde_json::from_str(reply.to_text().map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    if ready["type"] != "ready" || ready["peerProtocol"] != 1 || ready["daemonId"].as_str().is_none() { return Err("Upgrade the running Piop daemon to enable peer connections".into()); }
    Ok(ready)
}

async fn open() -> Result<(Socket, Value), String> {
    let endpoint = daemon_endpoint::read()?;
    validate_endpoint(endpoint.protocol, &endpoint.token, &endpoint.url)?;
    tokio::time::timeout(Duration::from_secs(5), async {
        let config = WebSocketConfig::default().max_message_size(Some(MAX_FRAME)).max_frame_size(Some(MAX_FRAME));
        let (mut socket, _) = connect_async_with_config(&endpoint.url, Some(config), false).await.map_err(|error| error.to_string())?;
        let ready = authenticate_socket(&mut socket, &endpoint.token).await?;
        Ok((socket, ready))
    }).await.map_err(|_| "Daemon handshake timed out".to_string())?
}

fn start_daemon() -> Result<PathBuf, String> {
    let directory = daemon_endpoint::directory()?;
    ensure_private_dir(&directory)?;
    let log_path = directory.join("daemon.log");
    let log = OpenOptions::new().create(true).append(true).open(&log_path).map_err(|error| error.to_string())?;
    set_private_file_permissions(&log_path)?;
    let mut command = Command::new(std::env::current_exe().map_err(|error| error.to_string())?);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe { command.pre_exec(|| { if libc::setsid() < 0 { return Err(std::io::Error::last_os_error()); } Ok(()) }); }
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    thread::spawn(move || { let _ = child.wait(); });
    Ok(log_path)
}

async fn connect() -> Result<(Socket, Value), String> {
    if let Ok(socket) = open().await { return Ok(socket); }
    let log_path = start_daemon()?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let mut last_error = String::new();
    while tokio::time::Instant::now() < deadline {
        match open().await { Ok(socket) => return Ok(socket), Err(error) => last_error = error }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!("Could not attach to Piop daemon: {last_error}. See {}", log_path.display()))
}

pub(super) fn run() -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|error| error.to_string())?;
    let result = runtime.block_on(async {
        let (mut socket, ready) = connect().await?;
        let mut stdout = tokio::io::stdout();
        stdout.write_all(format!("{ready}\n").as_bytes()).await.map_err(|error| error.to_string())?;
        stdout.flush().await.map_err(|error| error.to_string())?;
        let mut input = tokio::io::BufReader::new(tokio::io::stdin()).lines();
        let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
        loop {
            let message = tokio::select! {
                line = input.next_line() => match line.map_err(|error| error.to_string())? {
                    Some(line) if line.len() <= 32 * 1024 * 1024 => Message::Text(line.into()),
                    Some(_) => return Err("Daemon request is too large".into()),
                    None => break,
                },
                _ = heartbeat.tick() => Message::Text(json!({"type":"ping"}).to_string().into()),
                incoming = socket.next() => match incoming {
                    Some(Ok(Message::Text(text))) => {
                        stdout.write_all(text.as_bytes()).await.map_err(|error| error.to_string())?;
                        stdout.write_all(b"\n").await.map_err(|error| error.to_string())?;
                        stdout.flush().await.map_err(|error| error.to_string())?;
                        continue;
                    },
                    Some(Ok(Message::Ping(data))) => Message::Pong(data),
                    Some(Ok(Message::Pong(_))) => continue,
                    Some(Err(error)) => return Err(error.to_string()),
                    _ => break,
                },
            };
            tokio::time::timeout(Duration::from_secs(10), socket.send(message)).await.map_err(|_| "Daemon transport stalled".to_string())?.map_err(|error| error.to_string())?;
        }
        let _ = socket.close(None).await;
        Ok(())
    });
    runtime.shutdown_timeout(Duration::from_millis(100));
    result
}
