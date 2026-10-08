use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{broadcast, Semaphore};
use tokio_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};

const MAX_MESSAGE: usize = piop_protocol::MAX_REQUEST_BYTES;

#[path = "tailscale_auth.rs"]
mod tailscale_auth;

pub(super) fn start(app: AppHandle) -> Result<(), String> {
    let token = std::env::var("PIOP_MOBILE_TOKEN").unwrap_or_else(|_| daemon_endpoint::read().map(|endpoint| endpoint.token).unwrap_or_else(|_| format!("{}{}", Uuid::new_v4(), Uuid::new_v4())));
    if token.len() < 32 { return Err("PIOP_MOBILE_TOKEN must contain at least 32 characters".into()); }
    let bind = std::env::var("PIOP_MOBILE_BIND").unwrap_or_else(|_| if DEVELOPMENT || cfg!(feature = "test-home") { "127.0.0.1:0" } else { "127.0.0.1:9847" }.into());
    let listener = TcpListener::bind(&bind).map_err(|error| format!("Mobile endpoint: {error}"))?;
    listener.set_nonblocking(true).map_err(|error| error.to_string())?;
    daemon_endpoint::publish(listener.local_addr().map_err(|error| error.to_string())?, token.clone())?;
    let (events, _) = broadcast::channel::<Value>(1024);
    for name in ["pi://event", "pi://stderr", "pi://settings-changed", "pi://groups-changed", "pi://dictation", "pi://sessions-changed", "pi://daemon-error", "pi://provider-auth-changed", "pi://chatgpt-changed", "pi://session-removed", "pi://session-restored", "pi://host-settings-changed", "pi://plugins-changed", "pi://daemon-restarting"] {
        let events = events.clone();
        app.listen_any(name, move |event| {
            if let Ok(payload) = serde_json::from_str::<Value>(event.payload()) {
                if let Ok(packet) = serde_json::to_value(piop_protocol::Event { event: name.into(), payload }) { let _ = events.send(packet); }
            }
        });
    }
    let connections = Arc::new(Semaphore::new(8));
    let jobs = Arc::new(Semaphore::new(16));
    tailscale_auth::start(app.clone(), events.clone(), connections.clone(), jobs.clone())?;
    #[cfg(debug_assertions)]
    start_debug(app.clone(), events.clone(), connections.clone(), jobs.clone())?;
    crate::platform::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { return; };
        while let Ok((stream, _)) = listener.accept().await {
            let Ok(permit) = connections.clone().try_acquire_owned() else { continue; };
            let app = app.clone(); let token = token.clone(); let events = events.clone(); let jobs = jobs.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let _ = connection(app, stream, token, events, jobs).await;
            });
        }
    });
    eprintln!("Piop daemon listening on {bind} (TLS proxy required)");
    Ok(())
}

#[cfg(debug_assertions)]
fn start_debug(app: AppHandle, events: broadcast::Sender<Value>, connections: Arc<Semaphore>, jobs: Arc<Semaphore>) -> Result<(), String> {
    let listener = TcpListener::bind(std::env::var("PIOP_DEBUG_MOBILE_BIND").unwrap_or_else(|_| "127.0.0.1:0".into())).map_err(|error| error.to_string())?;
    listener.set_nonblocking(true).map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    let endpoint = json!({"url":format!("ws://{address}"), "protocol":1});
    atomic_write_private(&daemon_endpoint::directory()?.join("debug-mobile.json"), &serde_json::to_vec(&endpoint).map_err(|error| error.to_string())?)?;
    crate::platform::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { return; };
        while let Ok((stream, _)) = listener.accept().await {
            let Ok(permit) = connections.clone().try_acquire_owned() else { continue; };
            let app = app.clone(); let events = events.clone(); let jobs = jobs.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE)).max_frame_size(Some(MAX_MESSAGE));
                if let Ok(Ok(socket)) = tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::accept_async_with_config(stream, Some(config))).await {
                    let _ = serve_connection(app, socket, events, jobs).await;
                }
            });
        }
    });
    Ok(())
}

fn authenticated(value: &Value, expected: &str) -> bool {
    let Some(token) = value.get("token").and_then(Value::as_str) else { return false; };
    let mut difference = token.len() ^ expected.len();
    for (index, byte) in expected.bytes().enumerate() { difference |= usize::from(byte ^ token.as_bytes().get(index).copied().unwrap_or(0)); }
    difference == 0 && value.get("type").and_then(Value::as_str) == Some("authenticate")
}

async fn authenticate_socket(stream: tokio::net::TcpStream, token: &str) -> Result<(tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>, bool, bool), String> {
    let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE)).max_frame_size(Some(MAX_MESSAGE));
    let mut socket = tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::accept_async_with_config(stream, Some(config))).await.map_err(|_| "Handshake timeout")?.map_err(|error| error.to_string())?;
    let first = tokio::time::timeout(Duration::from_secs(10), socket.next()).await.map_err(|_| "Authentication timeout")?.ok_or("Connection closed")?.map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_str(first.to_text().map_err(|_| "Expected authentication")?).map_err(|_| "Invalid authentication")?;
    if !authenticated(&value, token) { let _ = socket.close(None).await; return Err("Unauthorized".into()); }
    Ok((socket, value["scope"] == "peer", value["scope"] == "control"))
}

async fn connection(app: AppHandle, stream: tokio::net::TcpStream, token: String, events: broadcast::Sender<Value>, jobs: Arc<Semaphore>) -> Result<(), String> {
    let local = stream.peer_addr().map_err(|error| error.to_string())?.ip().is_loopback();
    let (socket, peer, control) = authenticate_socket(stream, &token).await?;
    if control {
        if !local { return Err("Daemon control requires a local connection".into()); }
        return control_connection(app, socket).await;
    }
    serve_connection_mode(app, socket, events, jobs, peer).await
}

async fn control_connection(app: AppHandle, mut socket: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>) -> Result<(), String> {
    send_ready(&mut socket).await?;
    let request = read_control(&mut socket).await?;
    let clients = app.state::<daemon_clients::DaemonClients>();
    let action = request["action"].as_str().ok_or("Missing control action")?;
    match action { "start" => clients.persist()?, "stop" => {}, _ => return Err("Unknown control action".into()) }
    let result = socket.send(Message::Text(json!({"type":"controlled","action":action}).to_string().into())).await;
    if action == "stop" { clients.stop(); }
    result.map_err(|error| error.to_string())
}

async fn read_control(socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>) -> Result<Value, String> {
    let message = tokio::time::timeout(Duration::from_secs(10), socket.next()).await.map_err(|_| "Control timeout")?.ok_or("Connection closed")?.map_err(|error| error.to_string())?;
    serde_json::from_str(message.to_text().map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

async fn serve_connection<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(app: AppHandle, socket: tokio_tungstenite::WebSocketStream<S>, events: broadcast::Sender<Value>, jobs: Arc<Semaphore>) -> Result<(), String> {
    serve_connection_mode(app, socket, events, jobs, false).await
}

async fn serve_connection_mode<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(app: AppHandle, socket: tokio_tungstenite::WebSocketStream<S>, events: broadcast::Sender<Value>, jobs: Arc<Semaphore>, peer: bool) -> Result<(), String> {
    let _client = app.state::<daemon_clients::DaemonClients>().connect()?;
    serve_client(app, socket, events, jobs, peer).await
}

async fn serve_client<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(app: AppHandle, mut socket: tokio_tungstenite::WebSocketStream<S>, events: broadcast::Sender<Value>, jobs: Arc<Semaphore>, peer: bool) -> Result<(), String> {
    let controls = Arc::new(Semaphore::new(2));
    let mut events = events.subscribe();
    send_ready(&mut socket).await?;
    let (responses, mut receiver) = tokio::sync::mpsc::channel::<Value>(32);
    let mut pending = tokio::task::JoinSet::new();
    let owner = format!("client:{}", Uuid::new_v4());
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    let mut last_seen = Instant::now();
    loop {
        let mut restart_id = None;
        let outgoing = tokio::select! {
            incoming = socket.next() => {
                last_seen = Instant::now();
                let Some(Ok(message)) = incoming else { break; };
                match message {
                    Message::Close(_) => break,
                    Message::Ping(data) => Some(Message::Pong(data)),
                    Message::Text(text) => {
                        let Ok(request) = serde_json::from_str::<Value>(&text) else { break; };
                        if request.get("type").and_then(Value::as_str) == Some("ping") {
                            if !matches!(tokio::time::timeout(Duration::from_secs(10), socket.send(Message::Text(json!({"type":"pong"}).to_string().into()))).await, Ok(Ok(()))) { break; }
                            continue;
                        }
                        let Ok(piop_protocol::Request { id, command, args }) = serde_json::from_value(request) else { break; };
                        match request_permit(&jobs, &controls, &command, &args) {
                            Ok(permit) => {
                                let app = app.clone(); let responses = responses.clone(); let owner = owner.clone();
                                pending.spawn(async move {
                                    let _permit = permit;
                                    let result = if peer { super::mobile_commands::dispatch_peer(app, owner, command, args).await } else { super::mobile_commands::dispatch(app, owner, command, args).await };
                                    let response = serde_json::to_value(piop_protocol::Response::from_result(id, result)).expect("RPC response is serializable");
                                    let _ = responses.send(response).await;
                                });
                                None
                            },
                            Err(_) => Some(Message::Text(json!({"id":id,"error":"Host is busy; try again"}).to_string().into())),
                        }
                    },
                    _ => None,
                }
            },
            event = events.recv() => match event {
                Ok(event) if peer && (event["payload"]["_peer"] == true || event["event"] == "pi://groups-changed") => None,
                Ok(event) => Some(Message::Text(event.to_string().into())), Err(_) => break
            },
            Some(response) = receiver.recv() => {
                restart_id = response["result"]["restartId"].as_str().map(str::to_owned);
                Some(Message::Text(response.to_string().into()))
            },
            Some(_) = pending.join_next(), if !pending.is_empty() => None,
            _ = heartbeat.tick() => {
                if last_seen.elapsed() > Duration::from_secs(65) { break; }
                Some(Message::Ping(Vec::new().into()))
            },
        };
        if !send_outgoing(&mut socket, outgoing, &app, restart_id).await { break; }
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), socket.close(None)).await;
    drop(receiver);
    detach_connection(app, owner, pending).await
}

fn request_permit(jobs: &Arc<Semaphore>, controls: &Arc<Semaphore>, command: &str, args: &Value) -> Result<tokio::sync::OwnedSemaphorePermit, tokio::sync::TryAcquireError> {
    let control = matches!(command, "cancel_worktree_setup" | "stop_pi") || command == "pi_command" && args["command"]["type"] == "abort";
    jobs.clone().try_acquire_owned().or_else(|error| if control { controls.clone().try_acquire_owned() } else { Err(error) })
}

async fn detach_connection(app: AppHandle, owner: String, mut pending: tokio::task::JoinSet<()>) -> Result<(), String> {
    let cleanup_app = app.clone(); let cleanup_owner = owner.clone();
    tokio::task::spawn_blocking(move || detach_owner(&cleanup_app, &cleanup_owner, false)).await.map_err(|error| error.to_string())?;
    tokio::spawn(async move {
        while pending.join_next().await.is_some() {}
        let _ = tokio::task::spawn_blocking(move || {
            detach_owner(&app, &owner, false);
            app.state::<PiRuntime>().setups.attach_owner(&owner);
        }).await;
    });
    Ok(())
}

async fn send_ready<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> Result<(), String> {
    let packet = json!({"type":"ready", "protocol":piop_protocol::PROTOCOL_VERSION, "backend":"daemon", "peerProtocol":piop_protocol::PEER_PROTOCOL_VERSION, "daemonId":daemon_endpoint::identity()?});
    #[cfg(debug_assertions)]
    let packet = {
        let mut packet = packet;
        packet["debugProcessId"] = json!(std::process::id());
        packet["debugRuntime"] = tokio::task::spawn_blocking(daemon_endpoint::debug_runtime).await.map_err(|error| error.to_string())??;
        packet
    };
    let message = Message::Text(packet.to_string().into());
    socket.send(message).await.map_err(|error| error.to_string())
}

async fn send_outgoing<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(socket: &mut tokio_tungstenite::WebSocketStream<S>, message: Option<Message>, app: &AppHandle, restart_id: Option<String>) -> bool {
    let sent = match message {
        Some(message) => matches!(tokio::time::timeout(Duration::from_secs(10), socket.send(message)).await, Ok(Ok(()))),
        None => true,
    };
    if sent { if let Some(id) = restart_id { crate::daemon_restart::commit(app.clone(), &id); } }
    sent
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_remains_available_when_work_capacity_is_full() {
        let jobs = Arc::new(Semaphore::new(1));
        let controls = Arc::new(Semaphore::new(2));
        let _work = request_permit(&jobs, &controls, "create_worktree", &json!({})).unwrap();
        assert!(request_permit(&jobs, &controls, "create_worktree", &json!({})).is_err());
        let _cancel = request_permit(&jobs, &controls, "cancel_worktree_setup", &json!({})).expect("cancellation must reach the running job");
        let _stop = request_permit(&jobs, &controls, "pi_command", &json!({"command":{"type":"abort"}})).unwrap();
        assert!(request_permit(&jobs, &controls, "stop_pi", &json!({})).is_err(), "control capacity is bounded too");
    }
    #[test]
    fn authentication_requires_exact_secret_and_message_type() {
        let token = "a-private-secret-with-at-least-32-characters";
        assert!(authenticated(&json!({"type":"authenticate","token":token}), token));
        for value in [json!({}), json!({"token":token}), json!({"type":"authenticate","token":"wrong"}), json!({"type":"authenticate","token":format!("{token}x")})] { assert!(!authenticated(&value, token)); }
    }
    #[tokio::test]
    async fn websocket_rejects_commands_before_authentication() {
        for accepted in [true, false] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                authenticate_socket(stream, "secret").await.is_ok()
            });
            let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}")).await.unwrap();
            let message = if accepted { json!({"type":"authenticate","token":"secret"}) } else { json!({"id":1,"command":"pi_command","args":{}}) };
            socket.send(Message::Text(message.to_string().into())).await.unwrap();
            assert_eq!(server.await.unwrap(), accepted);
        }
    }

}
