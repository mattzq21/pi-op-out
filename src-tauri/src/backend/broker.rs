use std::collections::{HashMap, HashSet};
use crate::{change_session_groups, stop_message_worker};
use serde_json::json;
use serde_json::Value;
use std::fs;
use std::thread;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::ExitStatus;
use std::process::Stdio;
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use crate::platform::AppHandle;
use uuid::Uuid;
use crate::{AgentAddress, AppSettings, BROKER_BODY_BYTES, BROKER_HEADER_BYTES, BROKER_QUEUE_DEPTH, BROKER_WORKERS, MAX_AGENT_OUTPUT_BYTES, PiRuntime, ProjectKind, SessionIndexRuntime, SessionSummary, TerminalRuntime, conversation_ownership, peers, session_groups, terminal_lookup};
use crate::worktrees::{create_git_worktree, remove_git_worktree_cancellable};
use crate::worktree_setup::{WorktreeScriptPhase, ensure_desktop_sessions_dir, run_worktree_scripts, shell_quote};
use crate::pi_launch::{PiLaunch, build_pi_command};
use crate::session_index::{collect_sessions, list_local_sessions};
use crate::environment::home_dir;
use crate::settings::{load_app_settings};
use crate::settings_storage::{ensure_private_dir};

pub(super) fn resolve_agent<'a>(sessions: &'a [SessionSummary], host_id: &str, session_id: &str) -> Result<&'a SessionSummary, String> {
    sessions.iter().find(|session| session.host_id == host_id && session.id == session_id).ok_or_else(|| format!("Agent {host_id}/{session_id} was not found"))
}

pub(super) fn agent_is_active(session: &SessionSummary, agent: &AgentAddress) -> bool {
    !agent.messageable && agent.host_id == session.host_id && (agent.session_id.as_deref() == Some(session.id.as_str()) || agent.session_path.as_deref() == Some(session.path.as_str()))
}

fn dispatch_agent_message(app: &AppHandle, broker: &BrokerRuntime, session: &SessionSummary, message: &str, request_id: &str, deadline_ms: u64, client_id: &str) -> Result<String, String> {
    let deadline = message_deadline(broker, deadline_ms)?;
    let (settings, _claim, _ownership) = message_context(app, broker, session, client_id)?;
    if Instant::now() >= deadline { return Err("Agent message expired".into()); }
    let mut command = message_command(broker, &settings, session, client_id)?;
    let output = MessageOutput::prepare(&mut command)?;
    let child = spawn_message(&mut command, &output, broker, request_id, deadline)?;
    let _writer = BrokerWriter { child: child.clone(), _claim };
    register_message_job(broker, request_id, &child, &output)?;
    write_message_input(&child, message)?;
    let status = wait_message(broker, request_id, &child, &output, deadline);
    broker.jobs.lock().ok().map(|mut jobs| jobs.remove(request_id));
    broker.cancelled.lock().ok().map(|mut cancelled| cancelled.remove(request_id));
    message_output(output, status)
}

pub(super) fn broker_response(mut stream: TcpStream, status: &str, body: Value) {
    let payload = body.to_string();
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len());
}

pub(super) fn read_broker_line(reader: &mut BufReader<TcpStream>, remaining: &mut usize) -> Result<String, String> {
    if *remaining == 0 { return Err("Request headers are too large".into()); }
    let mut line = String::new();
    let count = reader.take((*remaining + 1) as u64).read_line(&mut line).map_err(|error| error.to_string())?;
    if count > *remaining { return Err("Request headers are too large".into()); }
    *remaining -= count;
    Ok(line)
}

fn broker_worktree_operation(broker: &BrokerRuntime, value: &Value, work: impl FnOnce(&AtomicBool) -> Result<Value, String>) -> Result<Value, String> {
    let id = value["requestId"].as_str().filter(|id| Uuid::parse_str(id).is_ok()).ok_or("requestId is required")?;
    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let deadline = value["deadline"].as_u64().unwrap_or(now).min(now + 120_000);
    let cancelled = Arc::new(AtomicBool::new(deadline <= now));
    {
        let mut operations = broker.operations.lock().map_err(|_| "Broker operations unavailable")?;
        if operations.contains_key(id) { return Err("Worktree operation already running".into()); }
        operations.insert(id.into(), cancelled.clone());
    }
    if broker.cancelled.lock().map_err(|_| "Broker cancellation unavailable")?.contains(id) { cancelled.store(true, Ordering::SeqCst); }
    let done = Arc::new(AtomicBool::new(false));
    let finished = done.clone(); let flag = cancelled.clone(); let closing = broker.closing.clone();
    thread::spawn(move || {
        while !finished.load(Ordering::SeqCst) {
            if closing.load(Ordering::SeqCst) || SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis() as u64 >= deadline { flag.store(true, Ordering::SeqCst); break; }
            thread::sleep(Duration::from_millis(50));
        }
    });
    let result = if cancelled.load(Ordering::SeqCst) { Err("Worktree operation cancelled".into()) } else { work(&cancelled) };
    done.store(true, Ordering::SeqCst);
    if let Ok(mut operations) = broker.operations.lock() { operations.remove(id); }
    if let Ok(mut cancelled) = broker.cancelled.lock() { cancelled.remove(id); }
    result
}

pub(super) fn handle_broker_request(app: AppHandle, broker: BrokerRuntime, stream: TcpStream) -> Result<(), String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
    let mut header_bytes = BROKER_HEADER_BYTES;
    let request_line = read_broker_line(&mut reader, &mut header_bytes)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or(""); let path = parts.next().unwrap_or("");
    let (authorized, content_length) = read_broker_headers(&mut reader, &mut header_bytes, &broker)?;
    if !authorized { broker_response(stream, "401 Unauthorized", json!({"error":"Unauthorized"})); return Ok(()); }
    if content_length > BROKER_BODY_BYTES { broker_response(stream, "413 Payload Too Large", json!({"error":"Message is too large"})); return Ok(()); }
    let mut body = vec![0; content_length]; reader.read_exact(&mut body).map_err(|error| error.to_string())?;
    if method == "POST" && matches!(path, "/message" | "/orchestration") {
        return enqueue_broker_message(app, broker, stream, body, path == "/orchestration");
    }
    respond_broker_request(app, broker, stream, method, path, body)
}

fn with_broker_access<T>(app: &AppHandle, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let state = app.state::<crate::daemon_restart::Runtime>();
    let _guard = state.gate.try_read().map_err(|_| "The daemon is preparing a restart")?;
    if crate::daemon_restart::blocking() || app.state::<crate::daemon_clients::DaemonClients>().closing() {
        return Err("The daemon is restarting or shutting down. Reconnect before retrying.".into());
    }
    work()
}

pub(super) fn start_session_broker(app: AppHandle, broker: BrokerRuntime) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| format!("Could not start session broker: {error}"))?;
    *broker.port.lock().map_err(|_| "Session broker lock was poisoned")? = listener.local_addr().map_err(|error| error.to_string())?.port();
    thread::spawn(move || {
        let (sender, receiver) = mpsc::sync_channel::<TcpStream>(BROKER_QUEUE_DEPTH);
        let receiver = Arc::new(Mutex::new(receiver));
        for _ in 0..BROKER_WORKERS {
            let receiver = receiver.clone(); let app = app.clone(); let broker = broker.clone();
            thread::spawn(move || loop {
                let stream = match receiver.lock() { Ok(receiver) => receiver.recv(), Err(_) => return };
                let Ok(stream) = stream else { return };
                let _ = handle_broker_request(app.clone(), broker.clone(), stream);
            });
        }
        for stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
            if let Err(mpsc::TrySendError::Full(stream)) = sender.try_send(stream) { broker_response(stream, "503 Service Unavailable", json!({"error":"Session broker is busy"})); }
        }
    });
    Ok(())
}

fn read_broker_headers(reader: &mut BufReader<TcpStream>, header_bytes: &mut usize, broker: &BrokerRuntime) -> Result<(bool, usize), String> {
    let mut authorized = false; let mut content_length = 0usize;
    loop {
        let line = read_broker_line(reader, header_bytes)?;
        if line == "\r\n" || line.is_empty() { break; }
        let Some((name, value)) = line.split_once(':') else { continue };
        if name.eq_ignore_ascii_case("authorization") { authorized = value.trim() == format!("Bearer {}", broker.token); }
        if name.eq_ignore_ascii_case("content-length") { content_length = value.trim().parse().unwrap_or(0); }
    }
    Ok((authorized, content_length))
}

fn enqueue_broker_message(app: AppHandle, broker: BrokerRuntime, stream: TcpStream, body: Vec<u8>, orchestration: bool) -> Result<(), String> {
        let delivery = if orchestration { BrokerDelivery::register(&broker, &body)? } else { None };
        let mut count = broker.message_count.lock().map_err(|_| "Broker job count lock was poisoned")?;
        if *count >= BROKER_WORKERS || broker.closing.load(Ordering::SeqCst) { broker_response(stream, "503 Service Unavailable", json!({"error":"Session broker is busy"})); return Ok(()); }
        *count += 1; drop(count);
        thread::spawn(move || {
            let _delivery = delivery;
            let result = with_broker_access(&app, || if orchestration {
                serde_json::from_slice(&body).map_err(|_| "Invalid orchestration request".into())
                    .and_then(|value| broker_orchestration(&app, &broker, value))
            } else { process_broker_message(&app, &broker, &body) });
            if let Ok(mut count) = broker.message_count.lock() { *count = count.saturating_sub(1); }
            match result { Ok(data) => broker_response(stream, "200 OK", json!({"data":data})), Err(error) => broker_response(stream, "400 Bad Request", json!({"error":error})) }
        });
        Ok(())
}

fn broker_terminal_lookup(app: &AppHandle, body: &[u8]) -> Result<Value, String> {
            let value: Value = serde_json::from_slice(body).map_err(|_| "Invalid terminal lookup request")?;
            let host_id = value["hostId"].as_str().ok_or("hostId is required")?;
            #[cfg(not(feature = "desktop"))]
            if host_id != "local" { return peers::forward_broker(app, host_id, "/terminals", value.clone()); }
            terminal_lookup::lookup(&app.state::<TerminalRuntime>(), &value, host_id)
}

fn respond_broker_request(app: AppHandle, broker: BrokerRuntime, stream: TcpStream, method: &str, path: &str, body: Vec<u8>) -> Result<(), String> {
    let result = with_broker_access(&app, || match (method, path) {
        ("GET", "/agent-definitions") => (|| {
            let daemon = app.state::<PiRuntime>().connections.get("local")?.ok_or("Agent definitions are unavailable")?;
            daemon.request(json!({"type":"agent_definitions"}))
        })(),
        ("POST", "/fast-capabilities") => (|| {
            let value: Value = serde_json::from_slice(&body).map_err(|_| "Invalid Fast mode capability request")?;
            let host_id = value["hostId"].as_str().ok_or("hostId is required")?;
            crate::provider_auth::for_owner(app.clone(), "fast-mode-discovery".into(), Some(host_id.into()), json!({"action":"fast_capabilities"}))
        })(),
        ("POST", "/terminals") => broker_terminal_lookup(&app, &body),
        ("GET", "/agents") => {
            broker_agents(&app, &broker)
        },
        ("POST", "/worktrees/create") => (|| {
            let value: Value = serde_json::from_slice(&body).map_err(|_| "Invalid worktree request")?;
            let host_id = value["hostId"].as_str().ok_or("hostId is required")?;
            #[cfg(not(feature = "desktop"))]
            if host_id != "local" { return peers::forward_broker(&app, host_id, "/worktrees/create", value.clone()); }
            let cwd = value["cwd"].as_str().ok_or("cwd is required")?;
            let name = value["name"].as_str().ok_or("name is required")?;
            broker_worktree_operation(&broker, &value, |cancelled| {
            let settings = load_app_settings(app.clone())?;
            let created = create_git_worktree(app.clone(), cwd.into(), name.into(), Some(host_id.into()))?;
            let group = session_groups::SessionGroup { id: format!("{host_id}:{}", created.path), name: created.branch.clone(), cwd: Some(created.path.clone()), host_id: Some(host_id.into()), host_name: Some(settings.hosts.iter().find(|host| host.id == host_id).map(|host| host.name.clone()).unwrap_or_else(|| host_id.into())), project_kind: Some(ProjectKind::Worktree), branch: None };
            let group_error = change_session_groups(app.clone(), session_groups::GroupChange::Project { project: group, key: None }).err();
            let setup = run_worktree_scripts(&settings, cwd, &created.path, host_id, cancelled, WorktreeScriptPhase::Setup);
            Ok(json!({"path":created.path,"branch":created.branch,"setupError":setup.err(),"groupError":group_error}))
            })
        })(),
        ("POST", "/worktrees/remove") => (|| {
            let value: Value = serde_json::from_slice(&body).map_err(|_| "Invalid worktree request")?;
            let host_id = value["hostId"].as_str().ok_or("hostId is required")?;
            #[cfg(not(feature = "desktop"))]
            if host_id != "local" { return peers::forward_broker(&app, host_id, "/worktrees/remove", value.clone()); }
            let cwd = value["cwd"].as_str().ok_or("cwd is required")?;
            broker_worktree_operation(&broker, &value, |cancelled| {
            let removed = remove_git_worktree_cancellable(app.clone(), cwd.into(), Some(host_id.into()), value["deleteBranch"].as_bool().unwrap_or(false), cancelled)?;
            serde_json::to_value(removed).map_err(|error| error.to_string())
            })
        })(),
        ("POST", "/cancel") => (|| {
            let value: Value = serde_json::from_slice(&body).map_err(|_| "Invalid cancellation request".to_string())?;
            let request_id = value.get("requestId").and_then(Value::as_str).filter(|value| Uuid::parse_str(value).is_ok()).ok_or("requestId is required")?;
            let mut cancelled = broker.cancelled.lock().map_err(|_| "Broker cancellation lock was poisoned")?;
            if cancelled.len() >= BROKER_QUEUE_DEPTH * 2 { cancelled.clear(); }
            cancelled.insert(request_id.to_string()); drop(cancelled);
            if let Some(operation) = broker.operations.lock().map_err(|_| "Broker operations unavailable")?.get(request_id) { operation.store(true, Ordering::SeqCst); }
            #[cfg(not(feature = "desktop"))]
            peers::cancel_message(&app, request_id)?;
            let child = broker.jobs.lock().map_err(|_| "Broker job lock was poisoned")?.get(request_id).cloned();
            if let Some(child) = child { stop_locked_message(&child); }
            Ok(json!({"cancelled":true}))
        })(),
        _ => Err("Unknown session broker endpoint".into()),
    });
    finish_broker_response(stream, result)
}

fn finish_broker_response(stream: TcpStream, result: Result<Value, String>) -> Result<(), String> {
    match result { Ok(data) => broker_response(stream, "200 OK", json!({"data":data})), Err(error) => broker_response(stream, "400 Bad Request", json!({"error":error})) }
    Ok(())
}


fn message_context(app: &AppHandle, broker: &BrokerRuntime, session: &SessionSummary, client_id: &str) -> Result<(AppSettings, BusyAgent, conversation_ownership::MutationGuard), String> {
    let runtime = app.state::<PiRuntime>();
    let claim = claim_agent(broker, &session.host_id, &session.id)?;
    let ownership = conversation_ownership::MutationGuard::acquire(app, &session.host_id, &session.path, client_id, false, "message")?;
    let context = {
        let settings = load_app_settings(app.clone())?;
        let daemon = runtime.connections.get(&session.host_id)?;
        if let Some(daemon) = daemon.filter(|daemon| daemon.alive.load(Ordering::SeqCst)) {
            daemon.request(json!({"type":"retire","sessionKey":session.id,"sessionPath":session.path}))?;
        }
        (settings, claim, ownership)
    };
    Ok(context)
}

fn message_command(broker: &BrokerRuntime, settings: &AppSettings, session: &SessionSummary, client_id: &str) -> Result<Command, String> {
    let mut command = build_pi_command(broker, settings, &session.host_id, PiLaunch::Print { cwd: &session.cwd, session_path: &session.path }, None)?;
    if session.host_id != "local" {
        let mut args: Vec<_> = command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        let script = args.last_mut().ok_or("Missing remote agent command")?;
        *script = format!("export PIOP_CONVERSATION_CLIENT={}; {}", shell_quote(client_id), script);
        let mut inherited = Command::new(command.get_program()); inherited.args(args);
        for (key, value) in command.get_envs() { if let Some(value) = value { inherited.env(key, value); } else { inherited.env_remove(key); } }
        command = inherited;
    }
    command.env("PIOP_CONVERSATION_CLIENT", client_id);
    Ok(command)
}

struct MessageOutput { root: PathBuf, stdout: PathBuf, stderr: PathBuf }

impl MessageOutput {
    fn prepare(command: &mut Command) -> Result<Self, String> {
    let output_root = std::env::temp_dir().join(format!("pi-desktop-broker-{}", Uuid::new_v4()));
    ensure_private_dir(&output_root).map_err(|error| format!("Could not prepare agent message: {error}"))?;
    let stdout_path = output_root.join("stdout"); let stderr_path = output_root.join("stderr");
    let stdout = fs::File::create(&stdout_path).map_err(|error| format!("Could not capture agent output: {error}"))?;
    let stderr = fs::File::create(&stderr_path).map_err(|error| format!("Could not capture agent errors: {error}"))?;
    command.stdin(Stdio::piped()).stdout(Stdio::from(stdout)).stderr(Stdio::from(stderr));
        Ok(Self { root: output_root, stdout: stdout_path, stderr: stderr_path })
    }
}

fn spawn_message(command: &mut Command, output: &MessageOutput, broker: &BrokerRuntime, request_id: &str, deadline: Instant) -> Result<Arc<Mutex<Child>>, String> {
    if Instant::now() >= deadline { let _ = fs::remove_dir_all(&output.root); return Err("Agent message expired".into()); }
    if broker.cancelled.lock().map_err(|_| "Broker cancellation lock was poisoned")?.remove(request_id) { let _ = fs::remove_dir_all(&output.root); return Err("Agent message was cancelled".into()); }
    let spawned = command.spawn();
    let child = match spawned { Ok(child) => Arc::new(Mutex::new(child)), Err(error) => { let _ = fs::remove_dir_all(&output.root); return Err(format!("Could not message agent: {error}")); } };
    Ok(child)
}

fn register_message_job(broker: &BrokerRuntime, request_id: &str, child: &Arc<Mutex<Child>>, output: &MessageOutput) -> Result<(), String> {
    match broker.jobs.lock() { Ok(mut jobs) => { if broker.closing.load(Ordering::SeqCst) { stop_locked_message(child); return Err("App is closing".into()); } jobs.insert(request_id.to_string(), child.clone()); }, Err(_) => { stop_locked_message(child); let _ = fs::remove_dir_all(&output.root); return Err("Broker job lock was poisoned".into()); } }
    Ok(())
}

fn write_message_input(child: &Mutex<Child>, message: &str) -> Result<(), String> {
    let stdin = child.lock().map_err(|_| "Agent process lock was poisoned")?.stdin.take();
    let message = message.to_owned(); thread::spawn(move || { if let Some(mut stdin) = stdin { let _ = stdin.write_all(message.as_bytes()); } });
    Ok(())
}

fn wait_message(broker: &BrokerRuntime, request_id: &str, child: &Mutex<Child>, output: &MessageOutput, deadline: Instant) -> Result<ExitStatus, String> {
    loop {
        if broker.cancelled.lock().map_err(|_| "Broker cancellation lock was poisoned")?.contains(request_id) {
            stop_locked_message(child);
            break Err("Agent message was cancelled".to_string());
        }
        let status = child.lock().map_err(|_| "Agent process lock was poisoned")?.try_wait().map_err(|error| format!("Could not wait for agent: {error}"))?;
        if let Some(status) = status { break Ok(status); }
        if let Some(error) = message_limit_error(output, deadline) {
            stop_locked_message(child);
            break Err(error.into());
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn message_output(output: MessageOutput, status: Result<ExitStatus, String>) -> Result<String, String> {
    let status = match status { Ok(status) => status, Err(error) => { let _ = fs::remove_dir_all(&output.root); return Err(error); } };
    let output_bytes = fs::metadata(&output.stdout).map(|metadata| metadata.len()).unwrap_or(0)
        .saturating_add(fs::metadata(&output.stderr).map(|metadata| metadata.len()).unwrap_or(0));
    if output_bytes > MAX_AGENT_OUTPUT_BYTES { let _ = fs::remove_dir_all(&output.root); return Err("Agent output exceeded the 16 MiB limit".into()); }
    let stdout = fs::read(&output.stdout).unwrap_or_default(); let stderr = fs::read(&output.stderr).unwrap_or_default(); let _ = fs::remove_dir_all(&output.root);
    if !status.success() { return Err(String::from_utf8_lossy(&stderr).trim().to_string()); }
    Ok(String::from_utf8_lossy(&stdout).trim().to_string())
}

fn message_deadline(broker: &BrokerRuntime, deadline_ms: u64) -> Result<Instant, String> {
    let remaining = deadline_ms.saturating_sub(SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis() as u64);
    if remaining == 0 || broker.closing.load(Ordering::SeqCst) { return Err("Agent message expired or app is closing".into()); }
    let deadline = Instant::now() + Duration::from_millis(remaining.min(600_000));
    Ok(deadline)
}


fn message_limit_error(output: &MessageOutput, deadline: Instant) -> Option<&'static str> {
        let output_bytes = fs::metadata(&output.stdout).map(|metadata| metadata.len()).unwrap_or(0)
            .saturating_add(fs::metadata(&output.stderr).map(|metadata| metadata.len()).unwrap_or(0));
        if output_bytes > MAX_AGENT_OUTPUT_BYTES {
            return Some("Agent output exceeded the 16 MiB limit");
        }
        if Instant::now() >= deadline {
            return Some("Agent message exceeded its deadline");
        }
    None
}

fn stop_locked_message(child: &Mutex<Child>) {
    if let Ok(mut child) = child.lock() { stop_message_worker(&mut child); }
}


fn process_broker_message(app: &AppHandle, broker: &BrokerRuntime, body: &[u8]) -> Result<Value, String> {
    let session_index = app.state::<SessionIndexRuntime>();
            let value: Value = serde_json::from_slice(body).map_err(|_| "Invalid message request".to_string())?;
            let BrokerMessage { request_id, host_id, session_id, message } = parse_broker_message(&value)?;
            #[cfg(not(feature = "desktop"))]
            if host_id != "local" { return peers::forward_broker(app, host_id, "/message", value.clone()); }
            let sessions = broker_message_sessions(app, &session_index, host_id)?;
            let session = resolve_agent(&sessions, host_id, session_id)?;
            dispatch_agent_message(app, broker, session, message, request_id, value.get("deadline").and_then(Value::as_u64).unwrap_or_else(|| SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis() as u64 + 120_000), value["clientId"].as_str().ok_or("Conversation client is missing")?).map(|reply| json!({"reply":reply}))
}

struct BrokerMessage<'a> { request_id: &'a str, host_id: &'a str, session_id: &'a str, message: &'a str }

fn parse_broker_message(value: &Value) -> Result<BrokerMessage<'_>, String> {
            let request_id = value.get("requestId").and_then(Value::as_str).filter(|value| Uuid::parse_str(value).is_ok()).ok_or("requestId is required")?;
            let host_id = value.get("hostId").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).ok_or("hostId is required")?;
            let session_id = value.get("sessionId").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).ok_or("sessionId is required")?;
            let message = value.get("message").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).ok_or("message is required")?;
    Ok(BrokerMessage { request_id, host_id, session_id, message })
}

fn broker_agents(app: &AppHandle, broker: &BrokerRuntime) -> Result<Value, String> {
    let session_index = app.state::<SessionIndexRuntime>();
            let active: Vec<_> = app.state::<PiRuntime>().active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.values().cloned().collect();
            let busy = broker.busy.lock().map_err(|_| "Broker claim lock was poisoned")?.clone();
            collect_sessions(app, &session_index).map(|sessions| json!(sessions.into_iter().map(|session| json!({"hostId":session.host_id,"sessionId":session.id,"name":session.name,"project":session.project,"cwd":session.cwd,"active":busy.contains(&format!("{}\0{}", session.host_id, session.id)) || active.iter().any(|agent| agent_is_active(&session, agent))})).collect::<Vec<_>>()))
}

fn broker_message_sessions(app: &AppHandle, session_index: &SessionIndexRuntime, host_id: &str) -> Result<Vec<SessionSummary>, String> {
    if host_id == "local" { list_local_sessions(session_index, &ensure_desktop_sessions_dir(&home_dir()?)?) } else { collect_sessions(app, session_index) }
}

fn broker_orchestration(app: &AppHandle, broker: &BrokerRuntime, value: Value) -> Result<Value, String> {
    let host = value["hostId"].as_str().ok_or("hostId is required")?;
    #[cfg(not(feature = "desktop"))]
    if host != "local" {
        let result = peers::forward_broker(app, host, "/orchestration", value.clone())?;
        return broker_interruption_status(broker, &value, result);
    }
    let (id, action) = orchestration_target(&value)?;
    if action == "interrupt" {
        let settings = load_app_settings(app.clone())?;
        let runtime = app.state::<PiRuntime>();
        let daemon = crate::daemon::connect(app, &runtime, broker, &settings, host)?;
        let result = daemon.request(json!({"type":"orchestration","action":action,"sessionKey":id,"deliveryId":value["deliveryId"]}))?;
        return broker_interruption_status(broker, &value, result);
    }
    broker_conversation_operation(app, broker, &value, host, id, action)
}

fn broker_conversation_operation(app: &AppHandle, broker: &BrokerRuntime, value: &Value, host: &str, id: &str, action: &str) -> Result<Value, String> {
    let sessions = broker_message_sessions(app, &app.state::<SessionIndexRuntime>(), host)?;
    let session = resolve_agent(&sessions, host, id)?;
    let settings = load_app_settings(app.clone())?;
    let runtime = app.state::<PiRuntime>();
    let daemon = crate::daemon::connect(app, &runtime, broker, &settings, host)?;
    let mut packet = json!({"type":"orchestration","action":action,"sessionKey":id,"sessionPath":session.path,
        "sourceSessionId":value["sourceSessionId"],"sourceHostId":value["sourceHostId"],"message":value["message"],"wake":value["wake"],"clientId":value["clientId"],"deliveryId":value["deliveryId"]});
    if action == "send" {
        let command = build_pi_command(broker, &settings, host, PiLaunch::Rpc { cwd: Some(&session.cwd), session_path: Some(&session.path), session_id: None, fork_path: None, no_session: false }, daemon.remote_port)?;
        packet["spec"] = crate::daemon::spec(&command);
        packet["cwd"] = json!(session.cwd);
    }
    daemon.request(packet)
}
fn broker_interruption_status(broker: &BrokerRuntime, request: &Value, mut result: Value) -> Result<Value, String> {
    if request["action"] == "interrupt" {
        let host = request["hostId"].as_str().ok_or("hostId is required")?;
        let id = request["sessionId"].as_str().ok_or("sessionId is required")?;
        if broker.deliveries.lock().map_err(|_| "Broker delivery lock was poisoned")?.contains_key(&format!("{host}\0{id}")) {
            result["completed"] = json!(false);
        }
    }
    Ok(result)
}

fn orchestration_target(value: &Value) -> Result<(&str, &str), String> {
    let id = value["sessionId"].as_str().ok_or("sessionId is required")?;
    let action = value["action"].as_str().ok_or("action is required")?;
    if !matches!(action, "read" | "send" | "interrupt") { return Err("Unknown orchestration action".into()); }
    Ok((id, action))
}

#[derive(Clone)]
pub(super) struct BrokerRuntime {
    closing: Arc<AtomicBool>,
    message_count: Arc<Mutex<usize>>,
    deliveries: Arc<Mutex<HashMap<String, usize>>>,
    pub(super) port: Arc<Mutex<u16>>,
    pub(super) token: String,
    pub(super) busy: Arc<Mutex<HashSet<String>>>,
    jobs: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
    cancelled: Arc<Mutex<HashSet<String>>>,
    operations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl Default for BrokerRuntime {
    fn default() -> Self {
        Self {
            closing: Arc::new(AtomicBool::new(false)), message_count: Arc::new(Mutex::new(0)), deliveries: Arc::new(Mutex::new(HashMap::new())),
            port: Arc::new(Mutex::new(0)),
            token: Uuid::new_v4().to_string(),
            busy: Arc::new(Mutex::new(HashSet::new())),
            jobs: Arc::new(Mutex::new(HashMap::new())),
            cancelled: Arc::new(Mutex::new(HashSet::new())),
            operations: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

pub(super) struct BusyAgent { key: String, busy: Arc<Mutex<HashSet<String>>> }

struct BrokerDelivery { key: String, pending: Arc<Mutex<HashMap<String, usize>>> }

impl BrokerDelivery {
    fn register(broker: &BrokerRuntime, body: &[u8]) -> Result<Option<Self>, String> {
        let value: Value = serde_json::from_slice(body).map_err(|_| "Invalid orchestration request")?;
        if value["action"] != "send" { return Ok(None); }
        let host = value["hostId"].as_str().ok_or("hostId is required")?;
        let id = value["sessionId"].as_str().ok_or("sessionId is required")?;
        let key = format!("{host}\0{id}");
        *broker.deliveries.lock().map_err(|_| "Broker delivery lock was poisoned")?.entry(key.clone()).or_default() += 1;
        Ok(Some(Self { key, pending: broker.deliveries.clone() }))
    }
}

impl Drop for BrokerDelivery {
    fn drop(&mut self) {
        let mut pending = self.pending.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(count) = pending.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 { pending.remove(&self.key); }
        }
    }
}

impl Drop for BusyAgent {
    fn drop(&mut self) { if let Ok(mut busy) = self.busy.lock() { busy.remove(&self.key); } }
}

struct BrokerWriter { child: Arc<Mutex<Child>>, _claim: BusyAgent }

impl Drop for BrokerWriter {
    fn drop(&mut self) {
        let mut child = self.child.lock().unwrap_or_else(|error| error.into_inner());
        stop_message_worker(&mut child);
    }
}

pub(super) fn broker_environment(broker: &BrokerRuntime) -> Result<(u16, String), String> {
    let port = *broker.port.lock().map_err(|_| "Session broker lock was poisoned")?;
    if port == 0 { return Err("Session broker is not ready".into()); }
    Ok((port, broker.token.clone()))
}

pub(super) fn claim_agent(broker: &BrokerRuntime, host_id: &str, session_id: &str) -> Result<BusyAgent, String> {
    let key = format!("{host_id}\0{session_id}");
    let mut busy = broker.busy.lock().map_err(|_| "Session broker lock was poisoned")?;
    if !busy.insert(key.clone()) { return Err(format!("Agent {host_id}/{session_id} is already responding")); }
    Ok(BusyAgent { key, busy: broker.busy.clone() })
}

impl BrokerRuntime {
    pub(super) fn ensure_idle(&self) -> Result<(), String> {
        let active = *self.message_count.lock().map_err(|_| "Broker job count unavailable")? > 0
            || !self.jobs.lock().map_err(|_| "Broker jobs unavailable")?.is_empty()
            || !self.operations.lock().map_err(|_| "Broker operations unavailable")?.is_empty()
            || !self.deliveries.lock().map_err(|_| "Broker deliveries unavailable")?.is_empty();
        if active { return Err("Wait for active broker requests to finish before restarting the daemon".into()); }
        Ok(())
    }

    pub(super) fn shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        let jobs = self.jobs.lock().map(|mut jobs| jobs.drain().map(|(_, child)| child).collect::<Vec<_>>()).unwrap_or_default();
        for child in jobs { if let Ok(mut child) = child.lock() { stop_message_worker(&mut child); } }
    }

    pub(super) fn with_uncancelled_request<T>(&self, id: &str, register: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let mut cancelled = self.cancelled.lock().map_err(|_| "Broker cancellation unavailable")?;
        if cancelled.remove(id) { return Err("Agent message was cancelled".into()); }
        register()
    }
}
