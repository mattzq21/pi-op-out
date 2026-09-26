struct TerminalLaunch { terminal_id: String, session_key: String, cwd: String, cols: u16, rows: u16, host_id: String, window_label: String }

struct StartTerminalOptions { terminal_id: String, session_key: String, cwd: String, cols: u16, rows: u16, host_id: Option<String> }

struct StartPiOptions { runtime_id: String, cwd: Option<String>, session_path: Option<String>, session_id: Option<String>, fork_path: Option<String>, no_session: Option<bool>, host_id: Option<String>, presence: Option<Value>, client_id: String }

#[cfg(feature = "desktop")]
#[tauri::command(async)]
fn start_pi(app: AppHandle, window: tauri::WebviewWindow, runtime: State<PiRuntime>, broker: State<BrokerRuntime>, runtime_id: String, cwd: Option<String>, session_path: Option<String>, session_id: Option<String>, fork_path: Option<String>, no_session: Option<bool>, host_id: Option<String>, presence: Option<Value>, client_id: String) -> Result<Value, String> {
    start_pi_for_owner(app, window.label().into(), runtime, broker, StartPiOptions { runtime_id, cwd, session_path, session_id, fork_path, no_session, host_id, presence, client_id })
}

struct PreparedPiSession {
    host_id: String,
    session_id: Option<String>,
    session_path: Option<String>,
    fork_path: Option<String>,
    ephemeral_path: Option<String>,
    ephemeral: bool,
    created_ephemeral: bool,
}

impl PreparedPiSession {
    fn claim_id(&self, settings: &AppSettings) -> Result<Option<String>, String> {
        if self.ephemeral { return Ok(None); }
        if let Some(id) = &self.session_id { return Ok(Some(id.clone())); }
        self.session_path.as_deref().map(|path| session_identity(settings, &self.host_id, path)).transpose()
    }

    fn claim(&self, broker: &BrokerRuntime, claim_id: Option<&str>, presence: Option<&Value>) -> Result<Option<BusyAgent>, String> {
        if presence.is_some_and(|value| value["readOnly"] == true) {
            if self.session_path.is_none() || self.ephemeral || self.fork_path.is_some() {
                return Err("A read-only view requires a saved conversation".into());
            }
            return Ok(None);
        }
        claim_id.map(|id| claim_agent(broker, &self.host_id, id)).transpose()
    }

    fn launch<'a>(&'a self, options: &'a StartPiOptions) -> PiLaunch<'a> {
        PiLaunch::Rpc {
            cwd: options.cwd.as_deref(),
            session_path: self.ephemeral_path.as_deref().or(self.session_path.as_deref()),
            session_id: self.session_id.as_deref(),
            fork_path: if self.ephemeral_path.is_some() { None } else { self.fork_path.as_deref() },
            no_session: self.ephemeral && self.ephemeral_path.is_none(),
        }
    }
}

fn prepare_pi_session(runtime: &PiRuntime, settings: &AppSettings, host_id: String, options: &StartPiOptions) -> Result<PreparedPiSession, String> {
    let session_id = options.session_id.clone().or_else(|| (options.session_path.is_none() && options.fork_path.is_none()).then(|| Uuid::new_v4().to_string()));
    let ephemeral_key = format!("{}:{}:{}", host_id, options.client_id, options.runtime_id.rsplit(':').next().unwrap_or(&options.runtime_id));
    let saved_ephemeral = runtime.ephemeral_sessions.lock().map_err(|_| "Side conversation lock was poisoned")?.get(&ephemeral_key).cloned();
    let ephemeral = options.no_session.unwrap_or(false) || saved_ephemeral.is_some();
    let session_path = if ephemeral { None } else { options.session_path.as_deref().map(|path| desktop_session_file(settings, &host_id, path)).transpose()? };
    let fork_path = options.fork_path.as_deref().map(|path| desktop_session_file(settings, &host_id, path)).transpose()?;
    let reused_ephemeral = saved_ephemeral.is_some();
    let ephemeral_path = prepare_ephemeral_path(runtime, &ephemeral_key, ephemeral, saved_ephemeral, fork_path.as_deref(), |source_path| create_ephemeral_fork(settings, &host_id, source_path))?;
    let created_ephemeral = !reused_ephemeral && ephemeral_path.is_some();
    if ephemeral_path.is_some() { runtime.ephemeral_keys.lock().map_err(|_| "Side conversation lock was poisoned")?.insert(options.runtime_id.clone(), ephemeral_key); }
    Ok(PreparedPiSession { host_id, session_id, session_path, fork_path, ephemeral_path, ephemeral, created_ephemeral })
}

fn ensure_runtime_owner(runtime: &PiRuntime, runtime_id: &str, owner: &str) -> Result<(), String> {
    if runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get(runtime_id).is_some_and(|process| process.window_label != owner) {
        return Err("Runtime belongs to another connection".into());
    }
    Ok(())
}

fn runtime_is_attached(runtime: &PiRuntime, runtime_id: &str, settings: &AppSettings, host_id: &str) -> Result<bool, String> {
    Ok(runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get(runtime_id).is_some_and(|process| process.daemon.alive.load(Ordering::SeqCst) && process.daemon.matches_connection(settings, host_id)))
}

fn start_pi_for_owner(app: AppHandle, owner: String, runtime: State<PiRuntime>, broker: State<BrokerRuntime>, options: StartPiOptions) -> Result<Value, String> {
    let _lifecycle = runtime.lifecycle.lock().map_err(|_| "Runtime lifecycle lock was poisoned")?;
    ensure_runtime_owner(&runtime, &options.runtime_id, &owner)?;
    let settings = load_app_settings(app.clone())?;
    let host_id = options.host_id.clone().unwrap_or_else(|| "local".into());
    if runtime_is_attached(&runtime, &options.runtime_id, &settings, &host_id)? { return Ok(json!({"attached":true})); }
    let session = prepare_pi_session(&runtime, &settings, host_id, &options)?;
    let created_ephemeral = session.created_ephemeral;
    let runtime_id = options.runtime_id.clone();
    let result = (|| {
        let claim_id = session.claim_id(&settings)?;
        let _agent_claim = session.claim(&broker, claim_id.as_deref(), options.presence.as_ref())?;
        attach_pi_session(&app, owner, &runtime, &broker, &settings, options, (session, claim_id))
    })();
    if result.is_err() && created_ephemeral { cleanup_runtime_ephemeral(&runtime, &runtime_id)?; }
    result
}

fn attach_pi_session(app: &AppHandle, owner: String, runtime: &PiRuntime, broker: &BrokerRuntime, settings: &AppSettings, options: StartPiOptions, prepared: (PreparedPiSession, Option<String>)) -> Result<Value, String> {
    let (session, claim_id) = prepared;
    let daemon = daemon::connect(app, runtime, broker, settings, &session.host_id)?;
    let command = build_pi_command(broker, settings, &session.host_id, session.launch(&options), daemon.remote_port)?;
    let StartPiOptions { runtime_id, cwd, presence, client_id, .. } = options;
    let PreparedPiSession { host_id, session_id, session_path, ephemeral, .. } = session;
    let result = daemon.request(json!({"type":"attach","clientId":client_id,"runtimeId":runtime_id,"sessionKey":claim_id.unwrap_or_else(|| runtime_id.clone()),"spec":daemon::spec(&command),"timeout":630_000,"ephemeral":ephemeral,"cwd":cwd,"presence":presence.unwrap_or_else(|| json!({}))}))?;
    let blank_cleanup = BlankSessionCleanup { path: session_path.clone(), id: session_id.clone(), host: if host_id == "local" { None } else { Some(remote_host(settings, &host_id)?.clone()) }, submitted: ephemeral };
    runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.insert(runtime_id.clone(), PiProcess { daemon, window_label: owner, blank_cleanup });
    runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.insert(runtime_id, AgentAddress { host_id, session_id, session_path, worktree: cwd, presence_id: None, working: false, messageable: result["owned"].as_bool() == Some(false) });
    Ok(result)
}

fn detach_pi(runtime: &PiRuntime, runtime_id: &str, discard_blank: bool) -> Result<bool, String> {
    detach_pi_with(runtime, runtime_id, discard_blank, false)
}

fn detach_pi_with(runtime: &PiRuntime, runtime_id: &str, discard_blank: bool, preserve_running: bool) -> Result<bool, String> {
    let mut stopped = false;
    let process = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.remove(runtime_id);
    if let Some(mut process) = process {
        let result = process.daemon.request(json!({"type":"detach","runtimeId":runtime_id,"discardBlank":discard_blank,"preserveRunning":preserve_running}))?;
        if result["stopped"].as_bool() == Some(true) {
            stopped = true;
            process.blank_cleanup.submitted |= result["submitted"].as_bool().unwrap_or(false);
            if discard_blank { cleanup_blank_session(process.blank_cleanup); }
            cleanup_runtime_ephemeral(runtime, runtime_id)?;
        }
    } else {
        cleanup_runtime_ephemeral(runtime, runtime_id)?;
    }
    runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.remove(runtime_id);
    Ok(stopped)
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
fn stop_pi(runtime: State<PiRuntime>, runtime_id: String, discard_blank: Option<bool>) -> Result<bool, String> {
    detach_pi(&runtime, &runtime_id, discard_blank.unwrap_or(false))
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
fn pi_presence(runtime: State<PiRuntime>, runtime_id: String, presence: Value) -> Result<(), String> {
    let daemon = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get(&runtime_id).map(|process| process.daemon.clone());
    if let Some(daemon) = daemon { daemon.request(json!({"type":"presence","runtimeId":runtime_id,"presence":presence}))?; }
    Ok(())
}

fn execute_pi_command(runtime: &PiRuntime, runtime_id: &str, command: Value) -> Result<Value, String> {
    let daemon = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get(runtime_id).map(|process| process.daemon.clone()).ok_or("Pi is not running")?;
    daemon.request(json!({"type":"command","runtimeId":runtime_id,"command":command}))
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
fn pi_command(app: AppHandle, runtime: State<PiRuntime>, broker: State<BrokerRuntime>, runtime_id: String, mut command: Value) -> Result<Value, String> {
    let command_type = command["type"].as_str().unwrap_or_default().to_owned();
    let _lifecycle = if command_type == "switch_session" { Some(runtime.lifecycle.lock().map_err(|_| "Runtime lifecycle lock was poisoned")?) } else { None };
    let mut _claim = None;
    if command_type == "switch_session" {
        _claim = Some(prepare_session_switch(app, &runtime, &broker, &runtime_id, &mut command)?);
    }
    let result = execute_pi_command(&runtime, &runtime_id, command)?;
    update_command_ownership(&runtime, &runtime_id, &command_type)?;
    let state = command_snapshot(&command_type, &result);
    if let Some(state) = state {
        update_runtime_snapshot(&runtime, &runtime_id, state)?;
    }
    Ok(result)
}

fn command_snapshot<'a>(command_type: &str, result: &'a Value) -> Option<&'a Value> {
    match command_type { "get_snapshot" | "fork" | "fork_after" => result.get("state"), "get_state" => Some(result), _ => None }
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn new_window(app: AppHandle, target: Value) -> Result<String, String> {
    let (label, path) = conversation_window_target(&target)?;
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(path.into()))
        .background_color(tauri::window::Color(24, 24, 23, 255))
        .title(APP_TITLE).inner_size(1280.0, 800.0).min_inner_size(900.0, 640.0)
        .build().map_err(|error| error.to_string())?;
    Ok(label)
}

#[cfg(feature = "desktop")]
fn conversation_window_target(target: &Value) -> Result<(String, String), String> {
    if !target["sessionId"].as_str().is_some_and(|id| !id.trim().is_empty()) { return Err("Select a conversation to open in another window".into()); }
    let label = format!("chat-{}", Uuid::new_v4());
    let mut url = reqwest::Url::parse("https://piop.invalid/").map_err(|error| error.to_string())?;
    url.query_pairs_mut().append_pair("target", &target.to_string());
    let path = format!("index.html{}", url.query().map(|query| format!("?{query}")).unwrap_or_default());
    Ok((label, path))
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn start_terminal(app: AppHandle, window: tauri::WebviewWindow, runtime: State<TerminalRuntime>, terminal_id: String, session_key: String, cwd: String, cols: u16, rows: u16, host_id: Option<String>) -> Result<(), String> {
    start_terminal_for_owner(app, window.label().into(), runtime, StartTerminalOptions { terminal_id, session_key, cwd, cols, rows, host_id })
}

fn start_terminal_for_owner(app: AppHandle, owner: String, runtime: State<TerminalRuntime>, options: StartTerminalOptions) -> Result<(), String> {
    let StartTerminalOptions { terminal_id, session_key, cwd, cols, rows, host_id } = options;
    let session_runtime = app.state::<PiRuntime>();
    let _lifecycle = session_runtime.lifecycle.lock().map_err(|_| "Session lifecycle lock was poisoned")?;
    let host_id = host_id.unwrap_or_else(|| "local".into());
    let event_app = app.clone();
    start_terminal_with(&runtime, TerminalLaunch { terminal_id, session_key, cwd: cwd.clone(), cols, rows, host_id: host_id.clone(), window_label: owner },
        || if host_id == "local" {
            let working_dir = PathBuf::from(&cwd);
            if !working_dir.is_dir() { return Err(format!("Terminal working directory does not exist: {}", working_dir.display())); }
            let mut command = CommandBuilder::new("/bin/bash"); command.cwd(working_dir); Ok(command)
        } else {
            let settings = load_app_settings(app.clone())?; let host = remote_host(&settings, &host_id)?;
            let mut command = CommandBuilder::new("ssh");
            if let Some(config) = user_ssh_config() { command.arg("-F"); command.arg(config); }
            command.args(["-tt", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5", &host.target, &format!("cd {} && exec \"${{SHELL:-/bin/bash}}\" -l", shell_quote(&cwd))]); Ok(command)
        },
        move |packet| { let _ = event_app.emit("pi://event", packet); })
}

fn spawn_terminal_shell(slave: &dyn portable_pty::SlavePty, command: impl FnOnce() -> Result<CommandBuilder, String>) -> Result<Box<dyn PtyChild + Send + Sync>, String> {
    let mut command = command()?;
    command.env("TERM", "xterm-256color"); command.env("COLORTERM", "truecolor");
    slave.spawn_command(command).map_err(|error| format!("Could not start terminal shell: {error}"))
}

fn start_terminal_with(runtime: &TerminalRuntime, launch: TerminalLaunch,
    command: impl FnOnce() -> Result<CommandBuilder, String>, mut emit: impl FnMut(Value) + Send + 'static) -> Result<(), String> {
    let TerminalLaunch { terminal_id, session_key, cwd, cols, rows, host_id, window_label } = launch;
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    if let Some(process) = processes.get(&terminal_id) {
        return if process.window_label == window_label { Ok(()) } else { Err("Terminal belongs to another connection".into()) };
    }
    if processes.values().filter(|process| process.session_key == session_key).count() >= MAX_TERMINALS { return Err(format!("At most {MAX_TERMINALS} terminals may run for one conversation")); }
    let pair = native_pty_system().openpty(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }).map_err(|error| error.to_string())?;
    let child = spawn_terminal_shell(pair.slave.as_ref(), command)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|error| error.to_string())?;
    let event_id = terminal_id.clone(); let terminal_processes = runtime.processes.clone();
    let generation = Uuid::new_v4();
    let terminal_history = runtime.history.clone();
    terminal_lookup::start(runtime, &terminal_id, &session_key, &cwd, &host_id, &window_label, generation)?;
    thread::spawn(move || {
        stream_terminal_output(&mut reader, &event_id, |packet| {
            if let Ok(values) = terminal_processes.lock() {
                if values.get(&event_id).is_some_and(|process| process.generation == generation) {
                    terminal_lookup::record(&terminal_history, &event_id, packet["data"].as_str().unwrap_or_default());
                    emit(packet);
                }
            }
        });
        let finished = terminal_processes.lock().ok().and_then(|mut values| {
            if !values.get(&event_id).is_some_and(|process| process.generation == generation) { return None; }
            let process = values.remove(&event_id);
            terminal_lookup::finish(&terminal_history, &event_id);
            emit(json!({ "type": "terminal_exit", "terminalId": event_id }));
            process
        });
        if let Some(mut process) = finished { let _ = process.child.wait(); }
    });
    let (input, queued) = mpsc::sync_channel::<String>(32);
    thread::spawn(move || write_terminal_queue(&mut writer, queued));
    processes.insert(terminal_id, TerminalProcess { generation, session_key, cwd, host_id, window_label, master: pair.master, child, writer: input });
    Ok(())
}

fn write_terminal_queue(writer: &mut impl Write, queued: mpsc::Receiver<String>) {
    while let Ok(data) = queued.recv() {
        if writer.write_all(data.as_bytes()).and_then(|_| writer.flush()).is_err() { break; }
    }
}

fn stream_terminal_output(reader: &mut impl Read, terminal_id: &str, mut emit: impl FnMut(Value)) {
    let mut buffer = [0_u8; 8192];
    let mut pending_utf8 = Vec::new();
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => {
                let data = decode_terminal_bytes(&mut pending_utf8, &buffer[..length], false);
                if !data.is_empty() { emit(json!({"type":"terminal_output","terminalId":terminal_id,"data":data})); }
            }
            Err(_) => break,
        }
    }
    let tail = decode_terminal_bytes(&mut pending_utf8, &[], true);
    if !tail.is_empty() { emit(json!({"type":"terminal_output","terminalId":terminal_id,"data":tail})); }
}

fn decode_terminal_bytes(pending: &mut Vec<u8>, bytes: &[u8], eof: bool) -> String {
    pending.extend_from_slice(bytes);
    let mut output = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => { output.push_str(text); pending.clear(); break; }
            Err(error) => {
                let valid = error.valid_up_to(); let error_length = error.error_len(); const REPLACEMENT: char = '\u{fffd}';
                if valid > 0 {
                    output.push_str(std::str::from_utf8(&pending[..valid]).expect("validated UTF-8 prefix"));
                    pending.drain(..valid);
                }
                match error_length {
                    Some(length) => { pending.drain(..length.min(pending.len())); output.push(REPLACEMENT); }
                    None => break,
                }
            }
        }
    }
    if eof && !pending.is_empty() { output.push_str(&String::from_utf8_lossy(pending)); pending.clear(); }
    output
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn write_terminal(runtime: State<TerminalRuntime>, terminal_id: String, data: String) -> Result<(), String> {
    write_terminal_input(&runtime, &terminal_id, data)
}

fn write_terminal_input(runtime: &TerminalRuntime, terminal_id: &str, data: String) -> Result<(), String> {
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    let process = processes.get_mut(terminal_id).ok_or("Terminal is not running")?;
    if data.len() > 1024 * 1024 { return Err("Terminal input exceeds 1 MiB; paste a smaller block".into()); }
    process.writer.try_send(data).map_err(|_| "Terminal input is busy; wait or close the terminal".to_string())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn resize_terminal(runtime: State<TerminalRuntime>, terminal_id: String, cols: u16, rows: u16) -> Result<(), String> {
    resize_terminal_pty(&runtime, &terminal_id, cols, rows)
}

fn resize_terminal_pty(runtime: &TerminalRuntime, terminal_id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    let process = processes.get(terminal_id).ok_or("Terminal is not running")?;
    process.master.resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }).map_err(|error| error.to_string())
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
fn close_terminal(runtime: State<TerminalRuntime>, terminal_id: String) -> Result<(), String> {
    if let Some(mut process) = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?.remove(&terminal_id) { let _ = process.child.kill(); let _ = process.child.wait(); }
    runtime.history.lock().map_err(|_| "Terminal history lock was poisoned")?.remove(&terminal_id);
    Ok(())
}

fn stop_terminals(runtime: &TerminalRuntime, terminal_ids: &[String]) -> Result<(), String> {
    let mut processes = runtime.processes.lock().map_err(|_| "Terminal runtime lock was poisoned")?;
    for id in terminal_ids {
        if let Some(mut process) = processes.remove(id) { let _ = process.child.kill(); let _ = process.child.wait(); }
        runtime.history.lock().map_err(|_| "Terminal history lock was poisoned")?.remove(id);
    }
    Ok(())
}

fn open_system_resource(target: &std::ffi::OsStr) -> Result<(), String> {
    let program = if cfg!(target_os = "macos") { "open" } else if cfg!(target_os = "windows") { "explorer" } else { "xdg-open" };
    let mut child = Command::new(program).arg(target).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|error| format!("Could not open {}: {error}", target.to_string_lossy()))?;
    thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
#[cfg(feature = "desktop")]
fn read_dropped_file(path: String) -> Result<Value, String> {
    let path = Path::new(&path);
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() { return Err("Drop files, not folders".to_string()); }
    let limit = 10 * 1024 * 1024;
    if metadata.len() > limit { return Err("Attachment is larger than 10 MB".to_string()); }
    let mut data = Vec::new();
    file.take(limit + 1).read_to_end(&mut data).map_err(|error| error.to_string())?;
    if data.len() as u64 > limit { return Err("Attachment is larger than 10 MB".to_string()); }
    let name = path.file_name().ok_or("Attachment has no filename")?.to_string_lossy();
    Ok(json!({ "name": name, "data": data }))
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
#[cfg(feature = "desktop")]
fn open_external_url(url: String) -> Result<(), String> {
    open_external_url_with(&url, open_system_resource)
}

#[cfg(feature = "desktop")]
fn open_external_url_with(url: &str, open: impl FnOnce(&std::ffi::OsStr) -> Result<(), String>) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Enter a valid HTTP or HTTPS URL")?;
    if !matches!(parsed.scheme(), "http" | "https") || !parsed.has_host() { return Err("Only HTTP and HTTPS links can be opened in the browser".into()); }
    open(std::ffi::OsStr::new(parsed.as_str()))
}

#[cfg_attr(feature = "desktop", tauri::command(async))]
fn open_project_directory(app: AppHandle, cwd: String, host_id: Option<String>) -> Result<(), String> {
    if host_id.as_deref().unwrap_or("local") != "local" {
        let settings = load_app_settings(app)?;
        let host = remote_host(&settings, host_id.as_deref().unwrap_or_default())?;
        return open_project_directory_with(&cwd, Some(host), open_system_resource);
    }
    open_project_directory_with(&cwd, None, open_system_resource)
}

fn open_project_directory_with(cwd: &str, host: Option<&RemoteHost>, open: impl FnOnce(&std::ffi::OsStr) -> Result<(), String>) -> Result<(), String> {
    if let Some(host) = host { return Err(format!("Opening project directories on {} is not supported by the local file manager", host.name)); }
    let path = PathBuf::from(cwd);
    if !path.is_dir() { return Err(format!("Project directory does not exist: {}", path.display())); }
    open(path.as_os_str())
}

fn prepare_session_switch(app: AppHandle, runtime: &PiRuntime, broker: &BrokerRuntime, runtime_id: &str, command: &mut Value) -> Result<BusyAgent, String> {
        let path = command["sessionPath"].as_str().ok_or("Session path is required")?;
        let host_id = runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.get(runtime_id).map(|agent| agent.host_id.clone()).ok_or("Unknown Pi runtime")?;
        let settings = load_app_settings(app)?;
        let path = desktop_session_file(&settings, &host_id, path)?;
        let claim = claim_agent(broker, &host_id, &session_identity(&settings, &host_id, &path)?)?;
        command["sessionPath"] = json!(path);
    Ok(claim)
}

fn update_command_ownership(runtime: &PiRuntime, runtime_id: &str, command_type: &str) -> Result<(), String> {
    if command_type == "take_ownership" {
        if let Some(agent) = runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.get_mut(runtime_id) { agent.messageable = false; }
    }
    Ok(())
}

fn update_ephemeral_snapshot(runtime: &PiRuntime, runtime_id: &str, state: &Value) -> Result<(), String> {
        let key = runtime.ephemeral_keys.lock().map_err(|_| "Side conversation lock was poisoned")?.get(runtime_id).cloned();
        if let (Some(key), Some(path)) = (key, state["sessionFile"].as_str()) {
            let mut sessions = runtime.ephemeral_sessions.lock().map_err(|_| "Side conversation lock was poisoned")?;
            if let Some(session) = sessions.get_mut(&key) {
                if session.path() != path && Path::new(&session.path()).parent() == Path::new(path).parent() {
                    let previous = session.clone();
                    match session { EphemeralSession::Local(current) => *current = path.into(), EphemeralSession::Remote { path: current, .. } => *current = path.into() }
                    runtime.ephemeral_previous.lock().map_err(|_| "Side conversation lock was poisoned")?.entry(key).or_default().push(previous);
                }
            }
        }
    Ok(())
}

fn update_runtime_snapshot(runtime: &PiRuntime, runtime_id: &str, state: &Value) -> Result<(), String> {
        update_ephemeral_snapshot(runtime, runtime_id, state)?;
        if let Some(process) = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get_mut(runtime_id) {
            if let Some(path) = state["sessionFile"].as_str() { process.blank_cleanup.path = Some(path.into()); }
            if let Some(id) = state["sessionId"].as_str() { process.blank_cleanup.id = Some(id.into()); }
        }
        if let Some(agent) = runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.get_mut(runtime_id) {
            agent.session_id = state["sessionId"].as_str().map(str::to_owned);
            agent.session_path = state["sessionFile"].as_str().map(str::to_owned);
            agent.working = state["isStreaming"].as_bool().unwrap_or(false);
        }
    Ok(())
}
