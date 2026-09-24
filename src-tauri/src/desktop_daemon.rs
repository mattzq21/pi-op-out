use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc as async_mpsc, Mutex as AsyncMutex};
use tokio_tungstenite::{connect_async_with_config, tungstenite::{Message, protocol::WebSocketConfig}};

// Conversation snapshots are sent as one frame and can include long tool histories.
const MAX_DAEMON_RESPONSE: usize = 128 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct DesktopDaemon {
    connections: AsyncMutex<HashMap<String, Arc<Connection>>>,
    runtimes: Mutex<HashMap<String, Arc<Connection>>>,
    startup: AsyncMutex<()>,
}

pub(crate) struct Connection {
    window: String,
    alive: AtomicBool,
    sequence: AtomicU64,
    outgoing: async_mpsc::UnboundedSender<Message>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    terminals: Mutex<std::collections::HashSet<String>>,
}

impl Connection {
    pub(crate) fn invoke(&self, command: &str, args: Value) -> Result<Value, String> {
        if !self.alive.load(Ordering::SeqCst) { return Err("Disconnected from the Piop daemon. Reconnect before retrying.".into()); }
        let terminal = args["terminalId"].as_str().map(str::to_owned);
        let id = self.sequence.fetch_add(1, Ordering::SeqCst);
        let packet = json!({"id":id,"command":command,"args":args}).to_string();
        if packet.len() > 32 * 1024 * 1024 { return Err("This message exceeds the host's 32 MiB request limit. Remove an attachment or shorten the message.".into()); }
        if command == "start_terminal" {
            let mut terminals = self.terminals.lock().map_err(|_| "Terminal registry unavailable")?;
            if !self.alive.load(Ordering::SeqCst) { return Err("Disconnected from the Piop daemon".into()); }
            if let Some(id) = &terminal { terminals.insert(id.clone()); }
        }
        let (sender, receiver) = mpsc::channel();
        {
            let mut pending = self.pending.lock().map_err(|_| "Daemon requests unavailable")?;
            if !self.alive.load(Ordering::SeqCst) { return Err("Disconnected from the Piop daemon".into()); }
            pending.insert(id, sender);
        }
        let result = self.outgoing.send(Message::Text(packet.into())).map_err(|_| "Disconnected from the Piop daemon".to_string())
            .and_then(|_| {
                if command == "run_worktree_setup" { receiver.recv().map_err(|_| "Daemon request interrupted; reconnect before retrying.".to_string())? }
                else { receiver.recv_timeout(Duration::from_secs(660)).map_err(|_| "Daemon request interrupted or timed out; it may have completed. Refresh before retrying.".to_string())? }
            });
        if let Ok(mut pending) = self.pending.lock() { pending.remove(&id); }
        if (command == "close_terminal" && result.is_ok()) || (command == "start_terminal" && result.is_err()) {
            if let (Some(id), Ok(mut terminals)) = (terminal, self.terminals.lock()) { terminals.remove(&id); }
        }
        result
    }

    pub(crate) fn request(&self, packet: Value) -> Result<Value, String> {
        let command = match packet["action"].as_str() {
            Some("configuration") => "voice_configuration",
            Some("start") => "mobile_voice_start",
            Some("stop") => "voice_stop",
            _ => return Err("Unknown voice operation".into()),
        };
        self.invoke(command, packet)
    }

    fn receive(&self, app: &AppHandle, packet: Value) {
        if let Some(event) = packet["event"].as_str() {
            let payload = &packet["payload"];
            if event == "pi://event" && payload["type"] == "terminal_exit" {
                if let (Some(id), Ok(mut terminals)) = (payload["terminalId"].as_str(), self.terminals.lock()) { terminals.remove(id); }
            }
            if event == "pi://voice" && payload["event"]["type"] == "ended" { app.state::<voice::VoiceRuntime>().ended(payload["callId"].as_str().unwrap_or_default()); }
            let _ = app.emit_to(&self.window, event, payload);
        } else if let Some(id) = packet["id"].as_u64() {
            if let Some(sender) = self.pending.lock().ok().and_then(|mut requests| requests.remove(&id)) {
                let _ = sender.send(match packet["error"].as_str() { Some(error) => Err(error.into()), None => Ok(packet["result"].clone()) });
            }
        }
    }

    fn disconnected(&self, app: &AppHandle, reason: &str) {
        self.alive.store(false, Ordering::SeqCst);
        if let Ok(mut terminals) = self.terminals.lock() {
            for id in terminals.drain() { let _ = app.emit_to(&self.window, "pi://event", json!({"type":"terminal_exit", "terminalId":id})); }
        }
        if let Ok(mut pending) = self.pending.lock() { for (_, sender) in pending.drain() { let _ = sender.send(Err(format!("Disconnected from the Piop daemon ({reason}); the command may have completed."))); } }
        let state = app.state::<DesktopDaemon>();
        if let Ok(runtimes) = state.runtimes.lock() {
            for (id, connection) in runtimes.iter().filter(|(_, connection)| std::ptr::eq(Arc::as_ptr(connection), self)) {
                app.state::<voice::VoiceRuntime>().disconnect_runtime(id);
                let _ = app.emit_to(&connection.window, "pi://event", json!({"runtimeId":id,"event":{"type":"disconnected"}}));
            }
        };
    }
}

impl DesktopDaemon {
    async fn connect(&self, app: &AppHandle, window: &str) -> Result<Arc<Connection>, String> {
        let mut connections = self.connections.lock().await;
        if let Some(connection) = connections.get(window).filter(|connection| connection.alive.load(Ordering::SeqCst)) { return Ok(connection.clone()); }
        let _startup = self.startup.lock().await;
        let socket = match configured_endpoint()? {
            Some(endpoint) => open(&endpoint, None).await?,
            None => local_socket(app).await?,
        };
        if app.get_webview_window(window).is_none() { return Err("The client window was closed".into()); }
        let (outgoing, mut incoming) = async_mpsc::unbounded_channel();
        let connection = Arc::new(Connection { window: window.into(), alive: AtomicBool::new(true), sequence: AtomicU64::new(1), outgoing, pending: Mutex::new(HashMap::new()), terminals: Mutex::new(std::collections::HashSet::new()) });
        connections.insert(window.into(), connection.clone());
        let reader = connection.clone(); let app = app.clone();
        tokio::spawn(async move {
            let (mut sink, mut stream) = socket.split();
            let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
            let mut last_seen = tokio::time::Instant::now();
            let mut reason = "connection closed".to_string();
            loop {
                let outgoing = tokio::select! {
                    message = incoming.recv() => message,
                    _ = heartbeat.tick() => {
                        if last_seen.elapsed() > Duration::from_secs(65) { reason = "heartbeat timed out".into(); break; }
                        Some(Message::Text(json!({"type":"ping"}).to_string().into()))
                    },
                    message = stream.next() => { last_seen = tokio::time::Instant::now(); match message {
                        Some(Ok(Message::Text(text))) => { match serde_json::from_str(&text) { Ok(packet) => reader.receive(&app, packet), Err(_) => { reason = "invalid daemon response".into(); break; } }; continue; },
                        Some(Ok(Message::Ping(data))) => Some(Message::Pong(data)),
                        Some(Ok(Message::Pong(_))) => continue,
                        Some(Err(error)) => { reason = error.to_string(); break; },
                        _ => break,
                    } },
                };
                let Some(message) = outgoing else { break; };
                let closing = matches!(message, Message::Close(_));
                match tokio::time::timeout(Duration::from_secs(10), sink.send(message)).await {
                    Ok(Ok(())) => {},
                    Ok(Err(error)) => { reason = error.to_string(); break; },
                    Err(_) => { reason = "sending to daemon timed out".into(); break; },
                }
                if closing { break; }
            }
            eprintln!("Piop daemon connection closed: {reason}");
            reader.disconnected(&app, &reason);
        });
        Ok(connection)
    }

    pub(crate) async fn close_window(&self, app: &AppHandle, window: &str) {
        if let Some(connection) = self.connections.lock().await.remove(window) { connection.alive.store(false, Ordering::SeqCst); let _ = connection.outgoing.send(Message::Close(None)); }
        if let Ok(mut runtimes) = self.runtimes.lock() {
            for (id, _) in runtimes.iter().filter(|(_, connection)| connection.window == window) { app.state::<voice::VoiceRuntime>().disconnect_runtime(id); }
            runtimes.retain(|_, connection| connection.window != window);
        }
    }
    pub(crate) fn for_runtime(&self, runtime_id: &str) -> Result<Arc<Connection>, String> {
        self.runtimes.lock().map_err(|_| "Daemon runtime registry unavailable")?.get(runtime_id).cloned().ok_or("Connect to the conversation before starting voice".into())
    }
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
fn configured_endpoint() -> Result<Option<daemon_endpoint::Endpoint>, String> {
    let Ok(url) = std::env::var("PIOP_DAEMON_URL") else { return Ok(None); };
    let token = std::env::var("PIOP_DAEMON_TOKEN").map_err(|_| "PIOP_DAEMON_TOKEN is required with PIOP_DAEMON_URL")?;
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Invalid daemon URL")?;
    let loopback = parsed.host_str().is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1"));
    if parsed.scheme() != "wss" && !(parsed.scheme() == "ws" && loopback) { return Err("Remote daemons require wss://; ws:// is allowed only on loopback".into()); }
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.query().is_some() || parsed.fragment().is_some() { return Err("Daemon URL must not contain credentials, a query, or a fragment".into()); }
    Ok(Some(daemon_endpoint::Endpoint { url, token, protocol: 1 }))
}
async fn open(endpoint: &daemon_endpoint::Endpoint, expected_build: Option<&str>) -> Result<Socket, String> {
    if endpoint.protocol != 1 || endpoint.token.len() < 32 { return Err("Invalid Piop daemon connection configuration".into()); }
    tokio::time::timeout(Duration::from_secs(5), async {
        let config = WebSocketConfig::default().max_message_size(Some(MAX_DAEMON_RESPONSE)).max_frame_size(Some(MAX_DAEMON_RESPONSE));
        let (mut socket, _) = connect_async_with_config(&endpoint.url, Some(config), false).await.map_err(|_| "Could not connect to the Piop daemon")?;
        socket.send(Message::Text(json!({"type":"authenticate","token":endpoint.token}).to_string().into())).await.map_err(|_| "Could not authenticate with the Piop daemon")?;
        let message = socket.next().await.ok_or("Piop daemon rejected the connection")?.map_err(|_| "Piop daemon rejected the connection")?;
        let reply: Value = serde_json::from_str(message.to_text().map_err(|_| "Invalid daemon handshake")?).map_err(|_| "Invalid daemon handshake")?;
        if reply["type"] != "ready" || reply["backend"] != "daemon" || reply["protocol"] != 1 { return Err("Incompatible Piop daemon; restart it after upgrading".into()); }
        if expected_build.is_some_and(|expected| reply["buildId"].as_str() != Some(expected)) {
            return Err("Piop background service needs restarting after this update. Finish running conversations, stop piop-daemon, then reconnect.".into());
        }
        Ok(socket)
    }).await.map_err(|_| "Piop daemon connection timed out".to_string())?
}
async fn local_socket(app: &AppHandle) -> Result<Socket, String> {
    let executable = daemon_executable(app)?;
    let build_id = daemon_endpoint::executable_identity(&executable)?;
    if let Ok(endpoint) = daemon_endpoint::read() {
        match open(&endpoint, Some(&build_id)).await {
            Ok(socket) => return Ok(socket),
            Err(error) if error.starts_with("Piop background service needs restarting") => return Err(error),
            Err(_) => {},
        }
    }
    let directory = daemon_endpoint::directory()?;
    ensure_private_dir(&directory)?;
    let log_path = directory.join("daemon.log");
    let log = OpenOptions::new().create(true).append(true).open(&log_path).map_err(|error| error.to_string())?;
    set_private_file_permissions(&log_path)?;
    let mut command = Command::new(executable);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(log);
    if DEVELOPMENT { command.arg("--parent-stdin").stdin(Stdio::piped()); }
    #[cfg(unix)]
    { use std::os::unix::process::CommandExt; command.process_group(0); }
    let mut child = command.spawn().map_err(|error| format!("Could not start Piop daemon: {error}"))?;
    thread::spawn(move || {
        // Keep the pipe open for the client's lifetime, even if all windows
        // temporarily detach. OS closure also covers crashes and dev reloads.
        let lifetime = child.stdin.take();
        let _ = child.wait();
        drop(lifetime);
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if let Ok(endpoint) = daemon_endpoint::read() { if let Ok(Ok(socket)) = tokio::time::timeout_at(deadline, open(&endpoint, Some(&build_id))).await { return Ok(socket); } }
    }
    Err(format!("Piop daemon did not start. See {}", log_path.display()))
}
fn daemon_executable(app: &AppHandle) -> Result<PathBuf, String> {
    let name = format!("piop-daemon{}", std::env::consts::EXE_SUFFIX);
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let adjacent = executable.parent().ok_or("Cannot locate application")?.join(&name);
    if adjacent.is_file() { return Ok(adjacent); }
    let bundled = app.path().resource_dir().map_err(|error| error.to_string())?.join(&name);
    if bundled.is_file() { return Ok(bundled); }
    Err("The Piop daemon is missing. Rebuild Piop with its daemon companion.".into())
}

#[tauri::command]
pub(crate) async fn daemon_invoke(app: AppHandle, window: tauri::WebviewWindow, command: String, args: Value) -> Result<Value, String> {
    let state = app.state::<DesktopDaemon>();
    let connection = state.connect(&app, window.label()).await?;
    let runtime_id = args["runtimeId"].as_str().map(str::to_owned);
    let starting = command == "start_pi";
    let stopping = command == "stop_pi";
    let target = connection.clone();
    let result = tokio::task::spawn_blocking(move || target.invoke(&command, args)).await.map_err(|error| error.to_string())?;
    if result.is_ok() {
        if let Some(id) = runtime_id {
            let mut runtimes = state.runtimes.lock().map_err(|_| "Daemon runtime registry unavailable")?;
            if starting { runtimes.insert(id, connection); } else if stopping { runtimes.remove(&id); }
        }
    }
    result
}
