use super::*;

#[cfg(all(test, unix))]
#[path = "daemon_tests.rs"]
mod tests;

enum CaptureWork {
    Packet(Value),
    Drain(mpsc::Sender<()>),
}

pub(crate) struct Daemon {
    pub(crate) alive: AtomicBool,
    pub(crate) remote_port: Option<u16>,
    connection_config: Option<(String, String)>,
    host: Option<RemoteHost>,
    agent_prefix: String,
    events: Mutex<()>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    events_worker: Mutex<Option<thread::JoinHandle<()>>>,
    input: Mutex<tokio::sync::mpsc::UnboundedSender<Value>>,
    pending: Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>,
    captures: Mutex<HashMap<String, mpsc::Sender<CaptureWork>>>,
}

impl Daemon {
    fn notify(&self, packet: Value) -> Result<(), String> {
        let input = self.input.lock().map_err(|_| "Daemon input lock was poisoned")?;
        input.send(packet).map_err(|_| "Host supervisor disconnected".into())
    }
    fn configure(&self, runtime: &PiRuntime, settings: &AppSettings, host_id: &str) -> Result<(), String> {
        let agent_revision = runtime.agent_config_revisions.lock().map_err(|_| "Agent configuration lock was poisoned")?.get(host_id).copied().unwrap_or(0);
        let settings_value = runtime_settings(settings);
         self.request(json!({"type":"configure","configuration":{"settings":settings_value,"autoCompaction":true,"autoRetry":settings.auto_retry,"agentRevision":agent_revision}})).map(|_| ())
    }

    pub(crate) fn matches_connection(&self, settings: &AppSettings, host_id: &str) -> bool {
        connection_config(settings, host_id).is_ok_and(|config| config == self.connection_config)
    }

    fn disconnect(self: &Arc<Self>, app: &AppHandle, runtime: &PiRuntime) {
        let _events = self.events.lock().unwrap_or_else(|error| error.into_inner());
        self.alive.store(false, Ordering::SeqCst);
        if let Ok(captures) = self.captures.lock() {
            for sender in captures.values() { let _ = sender.send(CaptureWork::Packet(json!({"phase":"closed"}))); }
        }
        if let Ok(mut pending) = self.pending.lock() { for (_, sender) in pending.drain() { let _ = sender.send(Err("Host daemon disconnected".into())); } }
        let ids = runtime.processes.lock().map(|mut processes| {
            let ids: Vec<_> = processes.iter().filter(|(_, process)| Arc::ptr_eq(&process.daemon, self)).map(|(id, _)| id.clone()).collect();
            for id in &ids { processes.remove(id); } ids
        }).unwrap_or_default();
        if let Ok(mut agents) = runtime.active_agents.lock() { agents.retain(|key, _| !key.starts_with(&self.agent_prefix) && !ids.contains(key)); }
        for id in ids { let _ = app.emit("pi://event", json!({"runtimeId":id,"event":{"type":"disconnected"}})); }
    }

    pub(crate) fn request(&self, mut packet: Value) -> Result<Value, String> {
        if !self.alive.load(Ordering::SeqCst) { return Err("Host daemon disconnected".into()); }
        let id = Uuid::new_v4().to_string();
        packet["id"] = json!(id);
        let (sender, receiver) = mpsc::channel();
        {
            let mut pending = self.pending.lock().map_err(|_| "Daemon request lock was poisoned")?;
            if !self.alive.load(Ordering::SeqCst) { return Err("Host daemon disconnected".into()); }
            pending.insert(id.clone(), sender);
        }
        let write = (|| {
            let input = self.input.lock().map_err(|_| "Daemon input lock was poisoned")?;
            if !self.alive.load(Ordering::SeqCst) { return Err("Host daemon disconnected".into()); }
            input.send(packet).map_err(|_| "Host supervisor disconnected".into())
        })();
        let result = write.and_then(|_| receiver.recv_timeout(Duration::from_secs(660)).map_err(|_| "Host daemon request timed out".to_string())?);
        self.pending.lock().ok().map(|mut pending| pending.remove(&id));
        result
    }

    pub(crate) fn shutdown(&self) {
        let _ = self.notify(json!({"type":"shutdown"}));
    }

    pub(crate) fn wait_shutdown(&self) {
        let worker = self.worker.lock().unwrap_or_else(|error| error.into_inner()).take();
        if let Some(worker) = worker { let _ = worker.join(); }
        let events = self.events_worker.lock().unwrap_or_else(|error| error.into_inner()).take();
        if let Some(events) = events { let _ = events.join(); }
    }

    pub(crate) fn drain_captures(&self, session_key: Option<&str>) -> Result<(), String> {
        let writers = self.captures.lock().map_err(|_| "Capture queue lock was poisoned")?.iter()
            .filter(|(key, _)| session_key.is_none_or(|session_key| key.as_str() == session_key))
            .map(|(_, sender)| sender.clone()).collect::<Vec<_>>();
        let deadline = Instant::now() + Duration::from_secs(660);
        let mut completions = Vec::new();
        for writer in writers {
            let (sender, receiver) = mpsc::channel();
            writer.send(CaptureWork::Drain(sender)).map_err(|_| "The project changes writer stopped before finishing")?;
            completions.push(receiver);
        }
        for completion in completions {
            completion.recv_timeout(deadline.saturating_duration_since(Instant::now())).map_err(|_| "Could not finish saving project changes before moving the conversation")?;
        }
        Ok(())
    }
}

fn connection_config(settings: &AppSettings, host_id: &str) -> Result<Option<(String, String)>, String> {
    if host_id == "local" { return Ok(None); }
    let host = remote_host(settings, host_id)?;
    Ok(Some((host.target.clone(), host.pi_path.clone())))
}

pub(crate) fn invalidate_changed(app: &AppHandle, runtime: &PiRuntime, settings: &AppSettings) -> Result<(), String> {
    let mut daemons = runtime.daemons.lock().map_err(|_| "Daemon registry lock was poisoned")?;
    let changed: Vec<_> = daemons.iter().filter(|(host_id, daemon)| !daemon.matches_connection(settings, host_id)).map(|(host_id, _)| host_id.clone()).collect();
    for host_id in changed {
        if let Some(daemon) = daemons.get(&host_id) { daemon.disconnect(app, runtime); daemon.shutdown(); daemon.wait_shutdown(); daemon.drain_captures(None)?; }
        daemons.remove(&host_id);
    }
    Ok(())
}

pub(crate) fn update_settings(app: &AppHandle, runtime: &PiRuntime, settings: &AppSettings) -> Result<(), String> {
    let daemons = runtime.daemons.lock().map_err(|_| "Daemon registry lock was poisoned")?.iter().map(|(host, daemon)| (host.clone(), daemon.clone())).collect::<Vec<_>>();
    for (host_id, daemon) in daemons {
        if let Err(error) = daemon.configure(runtime, settings, &host_id) {
            daemon.disconnect(app, runtime); daemon.shutdown();
            let _ = app.emit("pi://daemon-error", json!({"hostId":host_id,"line":format!("Could not synchronize settings: {error}")}));
        }
    }
    Ok(())
}

pub(crate) fn connect(app: &AppHandle, runtime: &PiRuntime, _broker: &BrokerRuntime, settings: &AppSettings, host_id: &str) -> Result<Arc<Daemon>, String> {
    if host_id != "local" { return Err("Remote workers must be managed through their Piop daemon".into()); }
    let mut daemons = runtime.daemons.lock().map_err(|_| "Daemon registry lock was poisoned")?;
    let connection_config = connection_config(settings, host_id)?;
    let host = if host_id == "local" { None } else { Some(remote_host(settings, host_id)?.clone()) };
    if let Some(daemon) = reuse_connection(&mut daemons, app, runtime, settings, host_id, &connection_config)? { return Ok(daemon); }
    let (daemon, packets) = spawn_connection(host_id, connection_config, host)?;
    daemons.insert(host_id.into(), daemon.clone());
    let configuration_host_id = host_id.to_owned();
    let failure_app = app.clone();
    let connection = daemon.clone(); let app = app.clone(); let host_id = host_id.to_owned();
    let events_worker = thread::spawn(move || read_packets(app, connection, host_id, packets));
    *daemon.events_worker.lock().unwrap_or_else(|error| error.into_inner()) = Some(events_worker);
    if let Err(error) = daemon.configure(runtime, settings, &configuration_host_id) {
        daemon.disconnect(&failure_app, runtime);
        daemon.shutdown();
        daemon.wait_shutdown();
        daemons.remove(&configuration_host_id);
        return Err(error);
    }
    Ok(daemon)
}

fn persist_capture(app: &AppHandle, daemon: &Arc<Daemon>, host_id: &str, packet: Value) {
    let Some(key) = packet["sessionKey"].as_str() else { return; };
    let Ok(mut captures) = daemon.captures.lock() else { return; };
    let sender = captures.entry(key.into()).or_insert_with(|| {
        let (sender, receiver) = mpsc::channel::<CaptureWork>();
        let host = daemon.host.clone();
        let app = app.clone(); let daemon = Arc::downgrade(daemon); let host_id = host_id.to_owned();
        thread::spawn(move || {
            let mut baselines = HashMap::<String, String>::new();
            while let Ok(work) = receiver.recv() {
                let packet = match work {
                    CaptureWork::Packet(packet) => packet,
                    CaptureWork::Drain(completion) => { let _ = completion.send(()); continue; }
                };
                if update_capture_baseline(&mut baselines, &packet, host.as_ref()) { continue; }
                let Some(turn_id) = packet["turnId"].as_str() else { continue; };
                let baseline = baselines.remove(turn_id);
                let current = packet["current"].as_str();
                let result = (|| -> Result<(), String> {
                    let (Some(baseline), Some(current), Some(cwd), Some(path), Some(id)) = (baseline.as_deref(), current, packet["cwd"].as_str(), packet["sessionPath"].as_str(), packet["messageId"].as_str()) else { return Ok(()); };
                    if let Some(diff) = load_git_diff_between_at_host(cwd, baseline, current, host.as_ref())? {
                        if packet["ephemeral"] == true {
                            let _ = app.emit("pi://event", json!({"type":"turn_diff","hostId":host_id,"sessionPath":path,"messageId":id,"snapshot":diff}));
                            return Ok(());
                        }
                        let mut diffs = load_git_diffs_at_host(path, host.as_ref())?;
                        diffs.insert(id.into(), diff);
                        save_git_diffs_at_host(path, diffs, host.as_ref())?;
                        if daemon.upgrade().is_some_and(|daemon| daemon.alive.load(Ordering::SeqCst)) { let _ = app.emit("pi://event", json!({"type":"diffs_changed","hostId":host_id,"sessionPath":path})); }
                    }
                    Ok(())
                })();
                if let Some(baseline) = baseline { let _ = discard_git_tree_at_host(&baseline, host.as_ref()); }
                if let Some(current) = current { let _ = discard_git_tree_at_host(current, host.as_ref()); }
                if let Err(error) = result { if daemon.upgrade().is_some_and(|daemon| daemon.alive.load(Ordering::SeqCst)) { let _ = app.emit("pi://daemon-error", json!({"hostId":host_id,"line":format!("Could not save project changes: {error}")})); } }
            }
            for baseline in baselines.into_values() { let _ = discard_git_tree_at_host(&baseline, host.as_ref()); }
        });
        sender
    });
    let _ = sender.send(CaptureWork::Packet(packet));
}

pub(crate) fn spec(command: &Command) -> Value {
    json!({
        "program": command.get_program().to_string_lossy(),
        "args": command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>(),
        "cwd": command.get_current_dir().map(|path| path.to_string_lossy()),
        "env": command.get_envs().filter_map(|(key, value)| value.map(|value| (key.to_string_lossy().into_owned(), value.to_string_lossy().into_owned()))).collect::<HashMap<_, _>>(),
    })
}

fn handle_event(app: &AppHandle, connection: &Arc<Daemon>, packet: &Value) {
    update_agent_event(app, packet);
                    if packet["event"]["type"].as_str() == Some("disconnected") {
                        if let Some(id) = packet["runtimeId"].as_str() {
                            let runtime = app.state::<PiRuntime>();
                            let owned = runtime.processes.lock().map(|mut processes| {
                                if !processes.get(id).is_some_and(|process| Arc::ptr_eq(&process.daemon, connection)) { return false; }
                                processes.remove(id); true
                            }).unwrap_or(false);
                            if !owned { return; }
                            if let Ok(mut agents) = runtime.active_agents.lock() { agents.remove(id); };
                        }
                    }
                    let _ = app.emit("pi://event", json!({"runtimeId":packet["runtimeId"],"event":packet["event"]}));
}

fn handle_session_state(app: &AppHandle, connection: &Arc<Daemon>, host_id: &str, packet: &Value) {
                    let state = &packet["state"];
                    if !state.is_object() { return; }
                    let key = format!("{}{}", connection.agent_prefix, packet["sessionKey"].as_str().unwrap_or_default());
                    let runtime = app.state::<PiRuntime>();
                    if let Ok(mut agents) = runtime.active_agents.lock() {
                        if let Some(session_id) = state["sessionId"].as_str() {
                            for agent in agents.values_mut().filter(|agent| agent.host_id == host_id && agent.session_id.as_deref() == Some(session_id)) {
                                agent.working = packet["working"].as_bool().unwrap_or(false);
                            }
                        }
                        agents.insert(key, AgentAddress { host_id: host_id.to_owned(), session_id: state["sessionId"].as_str().map(str::to_owned), session_path: state["sessionFile"].as_str().map(str::to_owned), worktree: packet["worktree"].as_str().map(str::to_owned), presence_id: packet["presenceId"].as_str().map(str::to_owned), working: packet["working"].as_bool().unwrap_or(false), messageable: packet["messageable"].as_bool().unwrap_or(false) });
                    };
                    let _ = app.emit("pi://sessions-changed", ());
}

fn handle_session_closed(app: &AppHandle, connection: &Arc<Daemon>, packet: &Value) {
                    let runtime = app.state::<PiRuntime>();
                    if let Some(key) = packet["sessionKey"].as_str() { if let Ok(captures) = connection.captures.lock() { if let Some(sender) = captures.get(key) { let _ = sender.send(CaptureWork::Packet(json!({"phase":"closed"}))); } } }
                    if let Ok(mut agents) = runtime.active_agents.lock() { agents.remove(&format!("{}{}", connection.agent_prefix, packet["sessionKey"].as_str().unwrap_or_default())); };
                    let _ = app.emit("pi://sessions-changed", ());
}

fn handle_notice(app: &AppHandle, host_id: &str, packet: &Value) {
    match packet["type"].as_str() {
                Some("stderr") => { let _ = app.emit("pi://stderr", packet.clone()); },
                Some("provider_auth_changed") => { let _ = app.emit("pi://provider-auth-changed", json!({"hostId":host_id})); },
                Some("diagnostic") => { let _ = app.emit("pi://daemon-error", json!({"hostId":host_id,"line":packet["line"]})); },
        _ => {},
    }
}

fn read_packets(app: AppHandle, connection: Arc<Daemon>, host_id: String, packets: mpsc::Receiver<Value>) {
        for packet in packets {
            let _events = connection.events.lock().unwrap_or_else(|error| error.into_inner());
            if !connection.alive.load(Ordering::SeqCst) { continue; }
            handle_packet(&app, &connection, &host_id, packet);
        }
        let runtime = app.state::<PiRuntime>();
        connection.disconnect(&app, &runtime);
}

fn reuse_connection(daemons: &mut HashMap<String, Arc<Daemon>>, app: &AppHandle, runtime: &PiRuntime, settings: &AppSettings, host_id: &str, connection_config: &Option<(String, String)>) -> Result<Option<Arc<Daemon>>, String> {
    if let Some(daemon) = daemons.get(host_id).filter(|daemon| daemon.alive.load(Ordering::SeqCst) && &daemon.connection_config == connection_config) { daemon.configure(runtime, settings, host_id)?; return Ok(Some(daemon.clone())); }
    if let Some(daemon) = daemons.get(host_id) { daemon.disconnect(app, runtime); daemon.shutdown(); daemon.wait_shutdown(); daemon.drain_captures(None)?; }
    daemons.remove(host_id);
    Ok(None)
}

fn spawn_connection(host_id: &str, connection_config: Option<(String, String)>, host: Option<RemoteHost>) -> Result<(Arc<Daemon>, mpsc::Receiver<Value>), String> {
    let auth_executable = pi_executable().to_string_lossy().into_owned();
    let (output, packets) = mpsc::channel();
    let supervisor = crate::host_supervisor::start(home_dir()?, STORAGE_DIRECTORY.into(), auth_executable, output)?;
    let daemon = Arc::new(Daemon { alive: AtomicBool::new(true), remote_port: None, connection_config, host, agent_prefix: format!("daemon:{host_id}:{}:", Uuid::new_v4()), events: Mutex::new(()), worker: Mutex::new(Some(supervisor.worker)), events_worker: Mutex::new(None), input: Mutex::new(supervisor.input), pending: Mutex::new(HashMap::new()), captures: Mutex::new(HashMap::new()) });
    Ok((daemon, packets))
}

fn update_agent_event(app: &AppHandle, packet: &Value) {
    let Some(id) = packet["runtimeId"].as_str() else { return; };
    let runtime = app.state::<PiRuntime>();
    let Ok(mut agents) = runtime.active_agents.lock() else { return; };
    let Some(agent) = agents.get_mut(id) else { return; };
    match packet["event"]["type"].as_str() {
        Some("agent_start") => agent.working = true,
        Some("agent_settled") => agent.working = false,
        Some("ownership_lost") => { agent.working = false; agent.messageable = true; },
        _ => {},
    }
}

fn handle_packet(app: &AppHandle, connection: &Arc<Daemon>, host_id: &str, packet: Value) {
            match packet["type"].as_str() {
                Some("ownership_drain") => {
                    let connection = connection.clone();
                    thread::spawn(move || {
                        let error = connection.drain_captures(packet["sessionKey"].as_str()).err();
                        let _ = connection.notify(json!({"type":"ownership_drained","requestId":packet["id"],"error":error}));
                    });
                },
                Some("response") => if let Some(sender) = packet["id"].as_str().and_then(|id| connection.pending.lock().ok()?.remove(id)) {
                    let _ = sender.send(if let Some(error) = packet["error"].as_str() { Err(error.into()) } else { Ok(packet["data"].clone()) });
                },
                Some("event") => handle_event(app, connection, &packet),
                Some("session_state") => handle_session_state(app, connection, host_id, &packet),
                Some("session_closed") => handle_session_closed(app, connection, &packet),
                Some("turn_capture") => persist_capture(app, connection, host_id, packet.clone()),
                _ => handle_notice(app, host_id, &packet),
            }
}

fn update_capture_baseline(baselines: &mut HashMap<String, String>, packet: &Value, host: Option<&RemoteHost>) -> bool {
                if packet["phase"].as_str() == Some("closed") {
                    for (_, baseline) in baselines.drain() { let _ = discard_git_tree_at_host(&baseline, host); }
                    return true;
                }
                let Some(turn_id) = packet["turnId"].as_str() else { return true; };
                if packet["phase"].as_str() == Some("start") {
                    if let Some(baseline) = packet["baseline"].as_str() {
                        if let Some(previous) = baselines.insert(turn_id.into(), baseline.into()) { let _ = discard_git_tree_at_host(&previous, host); }
                    }
                    return true;
                }
    false
}
