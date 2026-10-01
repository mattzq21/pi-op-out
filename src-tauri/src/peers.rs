use super::*;

#[derive(Default)]
pub(crate) struct PeerRuntime {
    connections: Mutex<HashMap<String, (RemoteHost, Arc<Connection>)>>,
    starting: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    routes: Mutex<HashMap<(String, String), Route>>,
    messages: Mutex<HashMap<String, Arc<Connection>>>,
    running: Mutex<HashSet<(String, String)>>,
    errors: Mutex<HashMap<String, String>>,
}

#[derive(Clone)]
struct Route { owner: String, host_id: String, connection: Arc<Connection> }

pub(crate) struct Connection {
    daemon_id: String,
    prefix: String,
    alive: AtomicBool,
    sequence: AtomicU64,
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
}

impl Connection {
    pub(crate) fn invoke(&self, command: &str, args: Value) -> Result<Value, String> {
        if !self.alive.load(Ordering::SeqCst) { return Err("Remote daemon disconnected; reconnect before retrying".into()); }
        let id = self.sequence.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        {
            let mut pending = self.pending.lock().map_err(|_| "Peer requests unavailable")?;
            if !self.alive.load(Ordering::SeqCst) { return Err("Remote daemon disconnected".into()); }
            pending.insert(id, sender);
        }
        let result = (|| {
            let mut stdin = self.stdin.lock().map_err(|_| "Peer input unavailable")?;
            serde_json::to_writer(&mut *stdin, &json!({"id":id,"command":command,"args":args})).map_err(|error| error.to_string())?;
            stdin.write_all(b"\n").and_then(|_| stdin.flush()).map_err(|error| error.to_string())
        })().and_then(|_| {
            if command == "run_worktree_setup" { receiver.recv().map_err(|_| "Peer request interrupted; reconnect before retrying.".to_string())? }
            else { receiver.recv_timeout(Duration::from_secs(660)).map_err(|_| "Peer request timed out; it may have completed. Reconnect and refresh before retrying.".to_string())? }
        });
        if let Ok(mut pending) = self.pending.lock() { pending.remove(&id); }
        result
    }

    fn close(&self) { if let Ok(mut child) = self.child.lock() { let _ = child.kill(); } }

    fn disconnected(&self, app: &AppHandle) {
        if !self.alive.swap(false, Ordering::SeqCst) { return; }
        if let Ok(mut pending) = self.pending.lock() { for (_, sender) in pending.drain() { let _ = sender.send(Err("SSH disconnected; the remote command may have completed. Running sessions remain on the remote daemon.".into())); } }
        let state = app.state::<PeerRuntime>();
        let routes = state.routes.lock().map(|routes| routes.iter().filter(|(_, route)| std::ptr::eq(Arc::as_ptr(&route.connection), self)).map(|(key, route)| (key.clone(), route.host_id.clone())).collect::<Vec<_>>()).unwrap_or_default();
        for ((kind, id), host_id) in routes {
            if kind == "runtimeId" { let _ = app.emit("pi://event", json!({"runtimeId":id,"hostId":host_id,"_peer":true,"event":{"type":"disconnected"}})); }
            if kind == "terminalId" { let _ = app.emit("pi://event", json!({"_peer":true,"type":"terminal_exit","terminalId":id})); }
        }
        let _ = app.emit("pi://sessions-changed", json!({"_peer":true}));
    }

    fn map_resources(&self, state: &PeerRuntime, payload: &mut Value) -> Result<Option<String>, ()> {
        let mut host_id = None;
        for kind in ["runtimeId", "terminalId"] {
            if let Some(wire_id) = payload[kind].as_str() {
                let Some(id) = wire_id.strip_prefix(&self.prefix).map(str::to_owned) else { return Err(()); };
                let route = state.routes.lock().ok().and_then(|routes| routes.get(&(kind.into(), id.clone())).cloned());
                let Some(route) = route.filter(|route| std::ptr::eq(Arc::as_ptr(&route.connection), self)) else { return Err(()); };
                host_id = Some(route.host_id); payload[kind] = json!(id);
            }
        }
        Ok(host_id)
    }

    fn receive_reply(&self, packet: &Value) -> bool {
        if let Some(id) = packet["id"].as_u64() {
            if let Some(sender) = self.pending.lock().ok().and_then(|mut pending| pending.remove(&id)) {
                let _ = sender.send(match packet["error"].as_str() { Some(error) => Err(error.into()), None => Ok(packet["result"].clone()) });
            }
            return true;
        }
        false
    }

    fn receive(&self, app: &AppHandle, packet: Value) {
        if self.receive_reply(&packet) { return; }
        let Some(event) = packet["event"].as_str() else { return; };
        if matches!(event, "pi://groups-changed" | "pi://dictation") || packet["payload"]["_peer"] == true { return; }
        let event = if event == "pi://settings-changed" { "pi://host-settings-changed" } else { event };
        let state = app.state::<PeerRuntime>();
        let mut payload = packet["payload"].clone();
        if !payload.is_object() { payload = json!({}); }
        let Ok(host_id) = self.map_resources(&state, &mut payload) else { return; };
        payload["_peer"] = json!(true);
        if let Some(host_id) = host_id { payload["hostId"] = json!(host_id); let _ = app.emit(event, payload); return; }
        let aliases = state.connections.lock().map(|connections| connections.iter().filter(|(_, (_, connection))| std::ptr::eq(Arc::as_ptr(connection), self)).map(|(id, _)| id.clone()).collect::<Vec<_>>()).unwrap_or_default();
        for host_id in aliases { payload["hostId"] = json!(host_id); let _ = app.emit(event, &payload); }
    }
}

fn executable(host: &RemoteHost) -> String {
    let path = if host.pi_path == "pi" { "piopd".into() }
        else if host.pi_path.ends_with("/pi") { format!("{}piopd", &host.pi_path[..host.pi_path.len() - 2]) }
        else { host.pi_path.clone() };
    path.strip_prefix("~/").map(|rest| format!("\"$HOME\"/{}", shell_quote(rest))).unwrap_or_else(|| shell_quote(&path))
}

pub(crate) fn connect(app: &AppHandle, host_id: &str) -> Result<Arc<Connection>, String> {
    let host = configured_host(app, host_id)?;
    let state = app.state::<PeerRuntime>();
    let startup = state.starting.lock().map_err(|_| "Peer startup unavailable")?.entry(host_id.into()).or_default().clone();
    let _startup = startup.lock().map_err(|_| "Peer startup unavailable")?;
    if let Some(connection) = cached_connection(&state, host_id, &host)? { return Ok(connection); }
    let PeerProcess { mut child, stdin, stdout, diagnostics } = spawn_peer(&host)?;
    let (daemon_id, reader) = peer_handshake(&mut child, stdout, &host, &diagnostics)?;
    let connection = Arc::new(Connection { daemon_id, prefix: format!("peer-{}:", Uuid::new_v4()), alive: AtomicBool::new(true), sequence: AtomicU64::new(1), child: Mutex::new(child), stdin: Mutex::new(stdin), pending: Mutex::new(HashMap::new()) });
    if let Some(existing) = install_connection(&state, host_id, host, &connection)? { return Ok(existing); }
    let reading = connection.clone(); let app = app.clone();
    thread::spawn(move || {
        for line in reader.lines().map_while(Result::ok) {
            let Ok(packet) = serde_json::from_str::<Value>(&line) else { break; };
            reading.receive(&app, packet);
        }
        reading.disconnected(&app);
        if let Ok(mut child) = reading.child.lock() { let _ = child.wait(); }
    });
    Ok(connection)
}

pub(crate) fn local_sessions(app: &AppHandle) -> Result<Value, String> {
    if !load_app_settings(app.clone())?.local_enabled { return Ok(json!([])); }
    enabled_local_sessions(app)
}

fn enabled_local_sessions(app: &AppHandle) -> Result<Value, String> {
    let root = ensure_desktop_sessions_dir(&home_dir()?)?;
    let mut sessions = list_local_sessions(&app.state::<SessionIndexRuntime>(), &root)?;
    session_groups::attach_assignments(&mut sessions)?;
    let id = daemon_endpoint::identity()?;
    let active = app.state::<PiRuntime>().active_agents.lock().map_err(|_| "Agent registry unavailable")?.values().filter(|agent| agent.host_id == "local" && agent.working).filter_map(|agent| agent.session_id.clone()).collect::<HashSet<_>>();
    let mut value = serde_json::to_value(sessions).map_err(|error| error.to_string())?;
    for session in value.as_array_mut().unwrap() { session["daemonId"] = json!(id); session["isRunning"] = json!(session["id"].as_str().is_some_and(|id| active.contains(id))); }
    Ok(value)
}

pub(crate) fn all_summaries(app: &AppHandle, index: &SessionIndexRuntime) -> Result<Vec<SessionSummary>, String> {
    let settings = load_app_settings(app.clone())?;
    let sessions = if settings.local_enabled { list_local_sessions(index, &ensure_desktop_sessions_dir(&home_dir()?)?)? } else { Vec::new() };
    let hosts = settings.hosts;
    let successful = Mutex::new(HashMap::new());
    let mut result = collect_host_sessions(sessions, hosts.clone(), |host| {
        let result = connect(app, &host.id).and_then(|connection| connection.invoke("list_sessions", json!({})).map(|value| (connection, value)));
        let (connection, value) = report_peer_listing(app, host, result)?;
        update_running_sessions(app, &connection, &value)?;
        let mut rows: Vec<SessionSummary> = serde_json::from_value(value).map_err(|error| error.to_string())?;
        for row in &mut rows { row.host_id = host.id.clone(); row.host_name = host.name.clone(); row.group_id = None; }
        successful.lock().map_err(|_| "Peer listings unavailable")?.insert(host.id.clone(), connection.daemon_id.clone());
        Ok(rows)
    }, session_groups::attach_assignments)?;
    let successful = successful.lock().map_err(|_| "Peer listings unavailable")?;
    let mut canonical = HashMap::new();
    for host in hosts { if let Some(daemon_id) = successful.get(&host.id) { canonical.entry(daemon_id.clone()).or_insert(host.id); } }
    result.retain(|session| session.host_id == "local" || successful.get(&session.host_id).is_some_and(|daemon_id| canonical.get(daemon_id) == Some(&session.host_id)));
    Ok(result)
}

fn register(state: &PeerRuntime, kind: &str, id: &str, route: Route) -> Result<(), String> {
    let mut routes = state.routes.lock().map_err(|_| "Peer routes unavailable")?;
    let key = (kind.into(), id.into());
    if routes.get(&key).is_some_and(|previous| previous.owner != route.owner) { return Err("Resource belongs to another connection".into()); }
    if routes.get(&key).is_some_and(|previous| previous.connection.alive.load(Ordering::SeqCst) && !Arc::ptr_eq(&previous.connection, &route.connection)) { return Err("Detach the resource before moving it to another daemon".into()); }
    routes.insert(key, route); Ok(())
}

pub(crate) fn route(app: &AppHandle, owner: &str, command: &str, args: &Value) -> Result<Option<Value>, String> {
    let mut routed_args = args.clone();
    if command == "provider_auth" && args["request"]["flowId"].is_string() { routed_args["flowId"] = args["request"]["flowId"].clone(); }
    let args = &routed_args;
    let state = app.state::<PeerRuntime>();
    if command == "storage_report" { return route_storage_report(app); }
    if command == "list_sessions" { return route_list_sessions(app); }
    let existing = existing_route(&state, owner, args)?;
    let Some(route) = select_route(app, owner, command, args, existing)? else { return Ok(None); };
    let stale_terminals = check_route_resources(&state, owner, command, args, &route)?;
    check_local_collisions(app, args)?;
    register_started_resource(&state, command, args, &route)?;
    let mut forwarded = forwarded_arguments(args, &route, &stale_terminals);
    if command == "shared_terminal" { forwarded["terminalConnectionId"] = json!(owner); }
    invoke_route(&state, command, args, route, forwarded)
}

pub(crate) fn detach_owner(app: &AppHandle, owner: &str) {
    let state = app.state::<PeerRuntime>();
    let connections = state.connections.lock().map(|connections| connections.values().map(|(_, connection)| connection.clone()).collect::<Vec<_>>()).unwrap_or_default();
    for connection in connections {
        let _ = connection.invoke("shared_terminal", json!({"action":"discard_drafts","terminalConnectionId":owner,"hostId":"local"}));
    }
    let routes = state.routes.lock().map(|mut routes| {
        let owned = routes.iter().filter(|(_, route)| route.owner == owner).map(|(key, route)| (key.clone(), route.clone())).collect::<Vec<_>>();
        routes.retain(|_, route| route.owner != owner); owned
    }).unwrap_or_default();
    for ((kind, id), route) in routes {
        if kind == "flowId" { let _ = route.connection.invoke("provider_auth", json!({"hostId":"local","request":{"action":"cancel","flowId":id}})); continue; }
        let command = match kind.as_str() { "runtimeId" => "stop_pi", "terminalId" => "close_terminal", "setupId" => "cancel_worktree_setup", _ => continue };
        let id = if matches!(kind.as_str(), "runtimeId" | "terminalId") { format!("{}{id}", route.connection.prefix) } else { id };
        let mut args = json!({"discardBlank":false,"preserveRunning":true}); args[&kind] = json!(id);
        let _ = route.connection.invoke(command, args);
    }
}

pub(crate) fn invalidate(app: &AppHandle) {
    let Ok(settings) = load_app_settings(app.clone()) else { return; };
    let state = app.state::<PeerRuntime>();
    if let Ok(mut connections) = state.connections.lock() {
        let mut removed = Vec::new();
        connections.retain(|id, (previous, connection)| {
            let keep = settings.hosts.iter().any(|host| host.enabled && &host.id == id && host.target == previous.target && host.pi_path == previous.pi_path);
            if !keep { removed.push(connection.clone()); } keep
        });
        removed.retain(|connection| !connections.values().any(|(_, retained)| Arc::ptr_eq(connection, retained)));
        drop(connections);
        for connection in removed { connection.close(); }
    };
}

pub(crate) fn shutdown(app: &AppHandle) {
    if let Ok(connections) = app.state::<PeerRuntime>().connections.lock() { for (_, connection) in connections.values() { connection.close(); } }
}

pub(crate) fn forward_broker(app: &AppHandle, host_id: &str, path: &str, mut body: Value) -> Result<Value, String> {
    let connection = connect(app, host_id)?;
    body["hostId"] = json!("local");
    let request_id = matches!(path, "/message" | "/worktrees/create" | "/worktrees/remove").then(|| body["requestId"].as_str().map(str::to_owned)).flatten();
    if let Some(id) = &request_id {
        let broker = app.state::<BrokerRuntime>();
        broker.with_uncancelled_request(id, || {
            let state = app.state::<PeerRuntime>();
            let mut messages = state.messages.lock().map_err(|_| "Peer messages unavailable")?;
            if messages.contains_key(id) { return Err("This agent message is already in progress".into()); }
            messages.insert(id.clone(), connection.clone());
            Ok(())
        })?;
    }
    let result = connection.invoke("broker_request", json!({"path":path,"body":body}));
    if let Some(id) = &request_id { if let Ok(mut messages) = app.state::<PeerRuntime>().messages.lock() { messages.remove(id); } }
    result
}

pub(crate) fn cancel_message(app: &AppHandle, request_id: &str) -> Result<(), String> {
    let connection = app.state::<PeerRuntime>().messages.lock().map_err(|_| "Peer messages unavailable")?.get(request_id).cloned();
    if let Some(connection) = connection { connection.invoke("broker_request", json!({"path":"/cancel","body":{"requestId":request_id}}))?; }
    Ok(())
}

pub(crate) fn local_broker_request(app: &AppHandle, path: &str, body: &Value) -> Result<Value, String> {
    if !matches!(path, "/message" | "/cancel" | "/worktrees/create" | "/worktrees/remove" | "/terminals") || body["hostId"].as_str().is_some_and(|id| id != "local") { return Err("Peer broker requests must target this machine".into()); }
    let broker = app.state::<BrokerRuntime>();
    let (port, token) = broker_environment(&broker)?;
    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|error| error.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(610))).map_err(|error| error.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(10))).map_err(|error| error.to_string())?;
    let body = body.to_string();
    write!(stream, "POST {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).map_err(|error| error.to_string())?;
    let mut response = String::new(); stream.take(MAX_AGENT_OUTPUT_BYTES + 65536).read_to_string(&mut response).map_err(|error| error.to_string())?;
    broker_response(&response)
}

fn route_storage_report(app: &AppHandle) -> Result<Option<Value>, String> {
        let mut hosts = vec![serde_json::to_value(inspect_storage(None).unwrap_or_else(|error| failed_storage("local".into(), "Local".into(), error))).map_err(|error| error.to_string())?];
        let mut seen = HashSet::from([daemon_endpoint::identity()?]);
        for host in load_app_settings(app.clone())?.hosts.into_iter().filter(|host| host.enabled) {
            let result = (|| {
                let connection = connect(app, &host.id)?;
                if !seen.insert(connection.daemon_id.clone()) { return Ok(None); }
                let report = connection.invoke("storage_report", json!({}))?;
                let mut entry = report["hosts"].as_array().and_then(|hosts| hosts.first()).cloned().ok_or("Peer returned no local storage report")?;
                entry["hostId"] = json!(host.id); entry["hostName"] = json!(host.name);
                Ok(Some(entry))
            })();
            match result { Ok(Some(entry)) => hosts.push(entry), Ok(None) => {}, Err(error) => hosts.push(serde_json::to_value(failed_storage(host.id, host.name, error)).map_err(|error| error.to_string())?) }
        }
        Ok(Some(json!({"hosts":hosts})))
}

fn route_list_sessions(app: &AppHandle) -> Result<Option<Value>, String> {
    let state = app.state::<PeerRuntime>();
        let mut value = serde_json::to_value(all_summaries(app, &app.state::<SessionIndexRuntime>())?).map_err(|error| error.to_string())?;
        let local_id = daemon_endpoint::identity()?;
        let connections = state.connections.lock().map_err(|_| "Peer connections unavailable")?;
        let running = state.running.lock().map_err(|_| "Peer activity unavailable")?;
        let local_running = app.state::<PiRuntime>().active_agents.lock().map_err(|_| "Agent registry unavailable")?.values().filter(|agent| agent.host_id == "local" && agent.working).filter_map(|agent| agent.session_id.clone()).collect::<HashSet<_>>();
        for row in value.as_array_mut().unwrap() {
            row["daemonId"] = json!(connections.get(row["hostId"].as_str().unwrap_or("local")).map(|(_, connection)| connection.daemon_id.as_str()).unwrap_or(&local_id));
            let daemon_id = row["daemonId"].as_str().unwrap_or_default(); let id = row["id"].as_str().unwrap_or_default();
            row["isRunning"] = json!(if daemon_id == local_id { local_running.contains(id) } else { running.contains(&(daemon_id.into(), id.into())) });
        }
        Ok(Some(value))
}

fn existing_route(state: &PeerRuntime, owner: &str, args: &Value) -> Result<Option<Route>, String> {
        let routes = state.routes.lock().map_err(|_| "Peer routes unavailable")?;
        let mut existing: Option<Route> = None;
        for kind in ["runtimeId", "terminalId", "setupId", "flowId"] {
            if let Some(route) = args[kind].as_str().and_then(|id| routes.get(&(kind.into(), id.into()))) {
                if route.owner != owner { return Err("Resource belongs to another connection".into()); }
                if existing.as_ref().is_some_and(|previous| !Arc::ptr_eq(&previous.connection, &route.connection)) { return Err("Resources belong to different daemons".into()); }
                existing = Some(route.clone());
            }
        }
        Ok(existing)
}

fn select_route(app: &AppHandle, owner: &str, command: &str, args: &Value, existing: Option<Route>) -> Result<Option<Route>, String> {
    if existing.as_ref().is_some_and(|route| route.owner != owner) { return Err("Resource belongs to another connection".into()); }
    let explicit = args["hostId"].as_str().filter(|id| *id != "local");
    let route = if let Some(host_id) = explicit {
        if matches!(command, "save_app_settings" | "load_app_settings" | "change_session_groups" | "load_session_groups") { return Err("Settings belong to the local daemon".into()); }
        Route { owner: owner.into(), host_id: host_id.into(), connection: connect(app, host_id)? }
    } else if let Some(route) = existing { route } else { return Ok(None); };
    Ok(Some(route))
}

fn check_route_resources(state: &PeerRuntime, owner: &str, command: &str, args: &Value, route: &Route) -> Result<HashSet<String>, String> {
    let stale_terminals;
    {
        let routes = state.routes.lock().map_err(|_| "Peer routes unavailable")?;
        for kind in ["runtimeId", "terminalId", "setupId"] {
            let creating = matches!((command, kind), ("start_pi", "runtimeId") | ("start_terminal", "terminalId"));
            if let Some(id) = args[kind].as_str() {
                if !creating && !routes.get(&(kind.into(), id.into())).is_some_and(|saved| saved.owner == owner && Arc::ptr_eq(&saved.connection, &route.connection)) { return Err("Reconnect to the resource on its owning daemon".into()); }
            }
        }
        stale_terminals = check_terminal_routes(&routes, owner, args, route)?;
    }
    Ok(stale_terminals)
}

fn check_local_collisions(app: &AppHandle, args: &Value) -> Result<(), String> {
    for kind in ["runtimeId", "terminalId"] {
        if let Some(id) = args[kind].as_str() {
            let collision = if kind == "runtimeId" { app.state::<PiRuntime>().contains_process(id)? }
                else { app.state::<TerminalRuntime>().contains_process(id)? };
            if collision { return Err("Resource is already attached locally".into()); }
        }
    }
    Ok(())
}

fn register_started_resource(state: &PeerRuntime, command: &str, args: &Value, route: &Route) -> Result<(), String> {
    if command == "start_pi" { register(state, "runtimeId", args["runtimeId"].as_str().ok_or("Missing runtimeId")?, route.clone())?; }
    if command == "start_terminal" { register(state, "terminalId", args["terminalId"].as_str().ok_or("Missing terminalId")?, route.clone())?; }
    Ok(())
}

fn forwarded_arguments(args: &Value, route: &Route, stale_terminals: &HashSet<String>) -> Value {
    let mut forwarded = args.clone();
    forwarded["hostId"] = json!("local");
    for kind in ["runtimeId", "terminalId"] { if let Some(id) = args[kind].as_str() { forwarded[kind] = json!(format!("{}{id}", route.connection.prefix)); } }
    if let Some(ids) = args["terminalIds"].as_array() { forwarded["terminalIds"] = json!(ids.iter().filter_map(Value::as_str).filter(|id| !stale_terminals.contains(*id)).map(|id| if id.starts_with("shared-terminal-") { id.to_string() } else { format!("{}{id}", route.connection.prefix) }).collect::<Vec<_>>()); }
    forwarded
}

fn invoke_route(state: &PeerRuntime, command: &str, args: &Value, route: Route, forwarded: Value) -> Result<Option<Value>, String> {
    let result = if !route.connection.alive.load(Ordering::SeqCst) && matches!(command, "stop_pi" | "close_terminal") { Ok(json!(false)) } else { route.connection.invoke(command, forwarded) };
    remove_closed_route(state, command, args, &result)?;
    if command == "prepare_worktree_setup" { if let Ok(Value::String(id)) = &result { register(state, "setupId", id, route.clone())?; } }
    update_auth_route(state, command, route, &result)?;
    result.map(Some)
}

fn remove_closed_route(state: &PeerRuntime, command: &str, args: &Value, result: &Result<Value, String>) -> Result<(), String> {
    let closing = match command { "stop_pi" => Some("runtimeId"), "close_terminal" => Some("terminalId"), "cancel_worktree_setup" | "run_worktree_setup" => Some("setupId"), _ => None };
    if result.is_ok() { if let Some(kind) = closing { if let Some(id) = args[kind].as_str() { state.routes.lock().map_err(|_| "Peer routes unavailable")?.remove(&(kind.into(), id.into())); } } }
    Ok(())
}

fn update_auth_route(state: &PeerRuntime, command: &str, route: Route, result: &Result<Value, String>) -> Result<(), String> {
    if command == "provider_auth" {
        if let Ok(value) = result {
            if let Some(id) = value["flowId"].as_str() {
                if value["status"] == "pending" { register(state, "flowId", id, route)?; }
                else { state.routes.lock().map_err(|_| "Peer routes unavailable")?.remove(&("flowId".into(), id.into())); }
            }
        }
    }
    Ok(())
}

fn check_terminal_routes(routes: &HashMap<(String, String), Route>, owner: &str, args: &Value, route: &Route) -> Result<HashSet<String>, String> {
    let mut stale_terminals = HashSet::new();
        if let Some(ids) = args["terminalIds"].as_array() { for id in ids.iter().filter_map(Value::as_str) {
            if id.starts_with("shared-terminal-") { continue; }
            let saved = routes.get(&("terminalId".into(), id.into())).ok_or("Terminal belongs to another connection")?;
            if saved.owner != owner { return Err("Terminal belongs to another connection".into()); }
            if !Arc::ptr_eq(&saved.connection, &route.connection) {
                if saved.connection.alive.load(Ordering::SeqCst) || saved.connection.daemon_id != route.connection.daemon_id { return Err("Terminal belongs to another connection".into()); }
                stale_terminals.insert(id.to_string());
            }
        } }
    Ok(stale_terminals)
}

fn broker_response(response: &str) -> Result<Value, String> {
    let (_, body) = response.split_once("\r\n\r\n").ok_or("Invalid broker response")?;
    let value: Value = serde_json::from_str(body).map_err(|error| error.to_string())?;
    if let Some(error) = value["error"].as_str() { return Err(error.into()); }
    Ok(value["data"].clone())
}

fn report_peer_listing(app: &AppHandle, host: &RemoteHost, result: Result<(Arc<Connection>, Value), String>) -> Result<(Arc<Connection>, Value), String> {
        let value = match result {
            Ok(result) => { if let Ok(mut errors) = app.state::<PeerRuntime>().errors.lock() { errors.remove(&host.id); } result },
            Err(error) => {
                let changed = app.state::<PeerRuntime>().errors.lock().map(|mut errors| errors.insert(host.id.clone(), error.clone()).as_ref() != Some(&error)).unwrap_or(false);
                if changed { let _ = app.emit("pi://daemon-error", json!({"hostId":host.id,"line":error,"_peer":true})); }
                return Err(error);
            }
        };
    Ok(value)
}

fn update_running_sessions(app: &AppHandle, connection: &Connection, value: &Value) -> Result<(), String> {
        {
            let state = app.state::<PeerRuntime>();
            let mut running = state.running.lock().map_err(|_| "Peer activity unavailable")?;
            running.retain(|(daemon, _)| daemon != &connection.daemon_id);
            for row in value.as_array().ok_or("Invalid peer session list")? { if row["isRunning"] == true { if let Some(id) = row["id"].as_str() { running.insert((connection.daemon_id.clone(), id.into())); } } }
        }
    Ok(())
}

fn cached_connection(state: &PeerRuntime, host_id: &str, host: &RemoteHost) -> Result<Option<Arc<Connection>>, String> {
    if let Some((saved, connection)) = state.connections.lock().map_err(|_| "Peer connections unavailable")?.get(host_id) {
        if saved.target == host.target && saved.pi_path == host.pi_path && connection.alive.load(Ordering::SeqCst) { return Ok(Some(connection.clone())); }
    }
    Ok(None)
}

struct PeerProcess { child: Child, stdin: ChildStdin, stdout: std::process::ChildStdout, diagnostics: Arc<Mutex<String>> }

fn spawn_peer(host: &RemoteHost) -> Result<PeerProcess, String> {
    let mut command = ssh_base();
    command.args(["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"]);
    command.arg(&host.target);
    command.arg(remote_login_command(&format!("exec {} --stdio-client", executable(host))));
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|error| format!("Could not connect to {}: {error}", host.name))?;
    let stdin = child.stdin.take().ok_or("SSH input unavailable")?;
    let stdout = child.stdout.take().ok_or("SSH output unavailable")?;
    let stderr = child.stderr.take().ok_or("SSH diagnostics unavailable")?;
    let diagnostics = Arc::new(Mutex::new(String::new()));
    let errors = diagnostics.clone();
    thread::spawn(move || { for line in BufReader::new(stderr).lines().map_while(Result::ok) { if let Ok(mut text) = errors.lock() { if text.len() < 8192 { text.push_str(&line); text.push('\n'); } } } });
    Ok(PeerProcess { child, stdin, stdout, diagnostics })
}

fn peer_handshake(child: &mut Child, stdout: std::process::ChildStdout, host: &RemoteHost, diagnostics: &Mutex<String>) -> Result<(String, BufReader<std::process::ChildStdout>), String> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout); let mut line = String::new();
        let result = reader.by_ref().take(1024 * 1024).read_line(&mut line).map_err(|error| error.to_string()).and_then(|_| serde_json::from_str::<Value>(&line).map_err(|_| "The remote Piop daemon did not return a peer handshake".to_string()));
        let _ = sender.send((result, reader));
    });
    let handshake = receiver.recv_timeout(Duration::from_secs(30));
    let (ready, reader) = match handshake {
        Ok((Ok(ready), reader)) if ready["peerProtocol"] == 1 && ready["daemonId"].as_str().is_some() => (ready, reader),
        _ => {
            let _ = child.kill(); let _ = child.wait();
            return Err(format!("Could not attach to {}. Install or upgrade piopd on that machine. {}", host.name, diagnostics.lock().map(|text| text.trim().to_string()).unwrap_or_default()));
        }
    };
    let daemon_id = ready["daemonId"].as_str().unwrap().to_owned();
    if daemon_id == daemon_endpoint::identity()? { let _ = child.kill(); let _ = child.wait(); return Err("This SSH target is the current daemon; use Local".into()); }
    Ok((daemon_id, reader))
}

fn install_connection(state: &PeerRuntime, host_id: &str, host: RemoteHost, connection: &Arc<Connection>) -> Result<Option<Arc<Connection>>, String> {
    let mut connections = state.connections.lock().map_err(|_| "Peer connections unavailable")?;
    if let Some(existing) = connections.values().map(|(_, connection)| connection).find(|other| other.daemon_id == connection.daemon_id && other.alive.load(Ordering::SeqCst)).cloned() {
        connection.close();
        if let Ok(mut child) = connection.child.lock() { let _ = child.wait(); }
        connections.insert(host_id.into(), (host, existing.clone()));
        return Ok(Some(existing));
    }
    if let Some((_, previous)) = connections.insert(host_id.into(), (host, connection.clone())) { previous.close(); }
    drop(connections);
    Ok(None)
}

fn configured_host(app: &AppHandle, host_id: &str) -> Result<RemoteHost, String> {
    let settings = load_app_settings(app.clone())?;
    remote_host(&settings, host_id).cloned()
}
