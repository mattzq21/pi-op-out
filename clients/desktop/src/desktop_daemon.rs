use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc as async_mpsc, Mutex as AsyncMutex};
use tokio_tungstenite::{connect_async_with_config, tungstenite::{Message, protocol::WebSocketConfig}};

const MAX_DAEMON_RESPONSE: usize = piop_protocol::MAX_RESPONSE_BYTES;

#[derive(Default)]
pub(crate) struct DesktopDaemon {
    connections: AsyncMutex<HashMap<String, Arc<Connection>>>,
    runtimes: Mutex<HashMap<String, Arc<Connection>>>,
    startup: AsyncMutex<()>,
}

pub(crate) struct Connection {
    window: String,
    alive: AtomicBool,
    restarting: AtomicBool,
    sequence: AtomicU64,
    outgoing: async_mpsc::UnboundedSender<Message>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    terminals: Mutex<std::collections::HashSet<String>>,
    log_statuses: Mutex<HashMap<String, Value>>,
}

impl Connection {
    fn log_statuses(&self) -> std::sync::MutexGuard<'_, HashMap<String, Value>> {
        self.log_statuses.lock().unwrap_or_else(|error| {
            eprintln!("Piop daemon log status lock was poisoned; recovering stored states");
            error.into_inner()
        })
    }

    fn register_terminal(&self, terminal: &Option<String>) -> Result<(), String> {
        let mut terminals = self.terminals.lock().map_err(|_| "Terminal registry unavailable")?;
        if !self.alive.load(Ordering::SeqCst) { return Err("Disconnected from the Piop daemon".into()); }
        if let Some(id) = terminal { terminals.insert(id.clone()); }
        Ok(())
    }

    fn update_terminal(&self, command: &str, terminal: Option<String>, succeeded: bool) {
        if (command == "close_terminal" && succeeded) || (command == "start_terminal" && !succeeded) {
            if let (Some(id), Ok(mut terminals)) = (terminal, self.terminals.lock()) { terminals.remove(&id); }
        }
    }

    pub(crate) fn invoke(&self, command: &str, args: Value) -> Result<Value, String> {
        if !self.alive.load(Ordering::SeqCst) { return Err("Disconnected from the Piop daemon. Reconnect before retrying.".into()); }
        let terminal = args["terminalId"].as_str().map(str::to_owned);
        let id = self.sequence.fetch_add(1, Ordering::SeqCst);
        let packet = serde_json::to_string(&piop_protocol::Request { id, command: command.into(), args }).map_err(|error| error.to_string())?;
        if packet.len() > piop_protocol::MAX_REQUEST_BYTES { return Err("This message exceeds the host's 32 MiB request limit. Remove an attachment or shorten the message.".into()); }
        if command == "start_terminal" {
            self.register_terminal(&terminal)?;
        }
        let (sender, receiver) = mpsc::channel();
        {
            let mut pending = self.pending.lock().map_err(|_| "Daemon requests unavailable")?;
            if !self.alive.load(Ordering::SeqCst) { return Err("Disconnected from the Piop daemon".into()); }
            pending.insert(id, sender);
        }
        let result = self.outgoing.send(Message::Text(packet.into())).map_err(|_| "Disconnected from the Piop daemon".to_string())
            .and_then(|_| {
                receiver.recv_timeout(Duration::from_secs(660)).map_err(|_| "Daemon request interrupted or timed out; it may have completed. Refresh before retrying.".to_string())?
            });
        if let Ok(mut pending) = self.pending.lock() { pending.remove(&id); }
        self.update_terminal(command, terminal, result.is_ok());
        result
    }

    fn receive_event(&self, app: &AppHandle, event: &str, payload: &Value) {
            if event == "pi://daemon-log-status" {
                let Some(host_id) = payload["hostId"].as_str() else {
                    eprintln!("Piop daemon sent a log status without a hostId: {payload}");
                    return;
                };
                let mut statuses = self.log_statuses();
                if !self.alive.load(Ordering::SeqCst) { return; }
                statuses.insert(host_id.into(), payload.clone());
                if let Err(error) = app.emit_to(&self.window, event, payload) {
                    eprintln!("Could not forward daemon log status for {host_id}: {error}");
                }
                return;
            }
            if event == "pi://daemon-restarting" && payload["hostId"] == "local" { self.restarting.store(true, Ordering::SeqCst); }
            if event == "pi://event" && payload["type"] == "terminal_exit" {
                if let (Some(id), Ok(mut terminals)) = (payload["terminalId"].as_str(), self.terminals.lock()) { terminals.remove(id); }
            }
            let _ = app.emit_to(&self.window, event, payload);
    }

    fn receive(&self, app: &AppHandle, packet: Value) {
        if let Some(event) = packet["event"].as_str() {
            self.receive_event(app, event, &packet["payload"]);
        } else if let Some(id) = packet["id"].as_u64() {
            if let Some(sender) = self.pending.lock().ok().and_then(|mut requests| requests.remove(&id)) {
                let _ = sender.send(match packet["error"].as_str() { Some(error) => Err(error.into()), None => Ok(packet["result"].clone()) });
            }
        }
    }

    fn disconnected(&self, app: &AppHandle, reason: &str) {
        {
            let mut statuses = self.log_statuses();
            for (host_id, _) in statuses.drain() {
                if let Err(error) = app.emit_to(&self.window, "pi://daemon-log-status", json!({"hostId":host_id,"failure":null})) {
                    eprintln!("Could not clear daemon log status for {host_id}: {error}");
                }
            }
            self.alive.store(false, Ordering::SeqCst);
        }
        if let Ok(mut terminals) = self.terminals.lock() {
            for id in terminals.drain() { let _ = app.emit_to(&self.window, "pi://event", json!({"type":"terminal_exit", "terminalId":id})); }
        }
        if let Ok(mut pending) = self.pending.lock() { for (_, sender) in pending.drain() { let _ = sender.send(Err(format!("Disconnected from the Piop daemon ({reason}); the command may have completed."))); } }
        let state = app.state::<DesktopDaemon>();
        if let Ok(runtimes) = state.runtimes.lock() {
            for (id, connection) in runtimes.iter().filter(|(_, connection)| std::ptr::eq(Arc::as_ptr(connection), self)) {
                let _ = app.emit_to(&connection.window, "pi://event", json!({"runtimeId":id,"event":{"type":"disconnected"}}));
            }
        };
    }
}

impl DesktopDaemon {
    pub(crate) async fn connect(&self, app: &AppHandle, window: &str) -> Result<Arc<Connection>, String> {
        let mut connections = self.connections.lock().await;
        if let Some(connection) = connections.get(window).filter(|connection| connection.alive.load(Ordering::SeqCst)) { return Ok(connection.clone()); }
        let reconnecting = connections.contains_key(window);
        let _startup = self.startup.lock().await;
        let socket = match configured_endpoint()? {
            Some(endpoint) => open(&endpoint).await?,
            None => local_socket(app).await?,
        };
        if app.get_webview_window(window).is_none() { return Err("The client window was closed".into()); }
        let (outgoing, incoming) = async_mpsc::unbounded_channel();
        let connection = Arc::new(Connection { window: window.into(), alive: AtomicBool::new(true), restarting: AtomicBool::new(false), sequence: AtomicU64::new(1), outgoing, pending: Mutex::new(HashMap::new()), terminals: Mutex::new(std::collections::HashSet::new()), log_statuses: Mutex::new(HashMap::new()) });
        connections.insert(window.into(), connection.clone());
        let reader = connection.clone();
        tokio::spawn(run_connection(socket, incoming, reader, app.clone()));
        if reconnecting { let _ = app.emit_to(window, "pi://event", json!({"type":"connection_restored"})); }
        Ok(connection)
    }

    pub(crate) async fn close_window(&self, _app: &AppHandle, window: &str) {
        if let Some(connection) = self.connections.lock().await.remove(window) {
            {
                let mut statuses = connection.log_statuses();
                statuses.clear();
                connection.alive.store(false, Ordering::SeqCst);
            }
            let _ = connection.outgoing.send(Message::Close(None));
        }
        if let Ok(mut runtimes) = self.runtimes.lock() {
            runtimes.retain(|_, connection| connection.window != window);
        }
    }
}

async fn run_connection(socket: Socket, mut incoming: async_mpsc::UnboundedReceiver<Message>, reader: Arc<Connection>, app: AppHandle) {
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
    if reader.restarting.load(Ordering::SeqCst) { reconnect_after_restart(app, reader.window.clone()); }
}

fn reconnect_after_restart(app: AppHandle, window: String) {
    tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if app.get_webview_window(&window).is_none() { break; }
            if app.state::<DesktopDaemon>().connect(&app, &window).await.is_ok() { break; }
        }
    });
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
fn configured_endpoint() -> Result<Option<daemon_endpoint::Endpoint>, String> {
    let Ok(url) = std::env::var("PIOP_DAEMON_URL") else { return Ok(None); };
    let token = std::env::var("PIOP_DAEMON_TOKEN").map_err(|_| "PIOP_DAEMON_TOKEN is required with PIOP_DAEMON_URL")?;
    let parsed = tauri::Url::parse(&url).map_err(|_| "Invalid daemon URL")?;
    let loopback = parsed.host_str().is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1"));
    if parsed.scheme() != "wss" && !(parsed.scheme() == "ws" && loopback) { return Err("Remote daemons require wss://; ws:// is allowed only on loopback".into()); }
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.query().is_some() || parsed.fragment().is_some() { return Err("Daemon URL must not contain credentials, a query, or a fragment".into()); }
    Ok(Some(daemon_endpoint::Endpoint { url, token, protocol: piop_protocol::PROTOCOL_VERSION }))
}
async fn open(endpoint: &daemon_endpoint::Endpoint) -> Result<Socket, String> {
    if endpoint.protocol != piop_protocol::PROTOCOL_VERSION || endpoint.token.len() < 32 { return Err("Invalid Piop daemon connection configuration".into()); }
    tokio::time::timeout(Duration::from_secs(5), async {
        let config = WebSocketConfig::default().max_message_size(Some(MAX_DAEMON_RESPONSE)).max_frame_size(Some(MAX_DAEMON_RESPONSE));
        let (mut socket, _) = connect_async_with_config(&endpoint.url, Some(config), false).await.map_err(|_| "Could not connect to the Piop daemon")?;
        socket.send(Message::Text(json!({"type":"authenticate","token":endpoint.token}).to_string().into())).await.map_err(|_| "Could not authenticate with the Piop daemon")?;
        let message = socket.next().await.ok_or("Piop daemon rejected the connection")?.map_err(|_| "Piop daemon rejected the connection")?;
        let reply = parse_handshake(&message)?;
        validate_handshake(&reply)?;
        Ok(socket)
    }).await.map_err(|_| "Piop daemon connection timed out".to_string())?
}

fn parse_handshake(message: &Message) -> Result<Value, String> {
    serde_json::from_str(message.to_text().map_err(|_| "Invalid daemon handshake")?).map_err(|_| "Invalid daemon handshake".into())
}

fn validate_handshake(reply: &Value) -> Result<(), String> {
    if reply["type"] != "ready" || reply["backend"] != "daemon" || reply["protocol"] != piop_protocol::PROTOCOL_VERSION { return Err("Incompatible Piop daemon; restart it after upgrading".into()); }
    Ok(())
}
async fn existing_local_socket() -> Result<Option<Socket>, String> {
    if let Ok(endpoint) = daemon_endpoint::read() {
        match open(&endpoint).await {
            Ok(socket) => return Ok(Some(socket)),
            Err(error) if error.starts_with("Incompatible Piop daemon") => return Err(error),
            Err(_) => {},
        }
    }
    Ok(None)
}

async fn local_socket(app: &AppHandle) -> Result<Socket, String> {
    if let Some(socket) = existing_local_socket().await? { return Ok(socket); }
    while daemon_endpoint::restart_active() {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if let Some(socket) = existing_local_socket().await? { return Ok(socket); }
    }
    #[cfg(debug_assertions)]
    tokio::task::spawn_blocking(ensure_development_daemon).await.map_err(|error| error.to_string())??;
    let executable = daemon_executable(app)?;
    let (log_path, mut child) = spawn_local_daemon(app, &executable)?;
    let result = wait_local_socket(app, &log_path, &executable, &mut child).await;
    thread::spawn(move || { let _ = child.wait(); });
    result
}

async fn wait_local_socket(app: &AppHandle, log_path: &Path, executable: &Path, child: &mut std::process::Child) -> Result<Socket, String> {
    let deadline = tokio::time::Instant::now() + daemon_endpoint::STARTUP_TIMEOUT;
    let mut retry_delay = Duration::from_millis(10);
    while tokio::time::Instant::now() < deadline {
        if let Ok(endpoint) = daemon_endpoint::read() { if let Ok(Ok(socket)) = tokio::time::timeout_at(deadline, open(&endpoint)).await { return Ok(socket); } }
        if child.try_wait().map_err(|error| error.to_string())?.is_some() {
            tokio::time::sleep(Duration::from_millis(400)).await;
            *child = spawn_local_daemon(app, executable)?.1;
        }
        tokio::time::sleep(retry_delay).await;
        retry_delay = (retry_delay * 2).min(Duration::from_millis(100));
    }
    Err(format!("Piop daemon did not start. See {}", log_path.display()))
}
fn spawn_local_daemon(_app: &AppHandle, executable: &Path) -> Result<(PathBuf, std::process::Child), String> {
    let mut command = Command::new(executable);
    command.arg("--exit-on-disconnect").stdin(Stdio::null()).stdout(Stdio::null());
    let log_path = crate::daemon_log::configure(&mut command, executable)?;
    let child = crate::daemon_log::spawn(command)?;
    Ok((log_path, child))
}

#[cfg(debug_assertions)]
fn ensure_development_daemon() -> Result<(), String> {
    static BUILD: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
    BUILD.get_or_init(|| {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).ok_or("Cannot locate Cargo workspace")?;
        if !manifest.join("Cargo.toml").is_file() { return Ok(()); }
        let prepared = std::env::var_os("PIOP_PREBUILT_DAEMON_FOR").is_some_and(|path| Path::new(&path) == manifest);
        if prepared && manifest.join("target/debug/piopd").is_file() { return Ok(()); }
        let output = Command::new("bun")
            .args(["scripts/build-daemon.mjs", "--debug", "--skip-extensions", "--skip-copy"])
            .current_dir(manifest).output()
            .map_err(|error| format!("Could not rebuild the development daemon: {error}"))?;
        if !output.status.success() {
            return Err(format!("Could not rebuild the development daemon:\n{}", String::from_utf8_lossy(&output.stderr)));
        }
        Ok(())
    }).clone()
}

fn daemon_executable(app: &AppHandle) -> Result<PathBuf, String> {
    let name = "piopd";
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let adjacent = executable.parent().ok_or("Cannot locate application")?.join(name);
    if adjacent.is_file() { return Ok(adjacent); }
    let bundled = app.path().resource_dir().map_err(|error| error.to_string())?.join(name);
    if bundled.is_file() { return Ok(bundled); }
    Err("The Piop daemon is missing. Rebuild Piop with its daemon companion.".into())
}

#[tauri::command]
pub(crate) async fn daemon_log_statuses(app: AppHandle, window: tauri::WebviewWindow) -> Vec<Value> {
    let state = app.state::<DesktopDaemon>();
    let connections = state.connections.lock().await;
    connections.get(window.label()).map(|connection| connection.log_statuses().values().cloned().collect()).unwrap_or_default()
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
