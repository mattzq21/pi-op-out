use std::collections::{HashMap, HashSet};
#[path = "broker_output.rs"]
mod output;
use output::MessageOutput;
use crate::stop_message_worker;
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
use std::process::Child;
use std::process::Command;
use std::process::ExitStatus;
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
use crate::{AgentAddress, AppSettings, BROKER_BODY_BYTES, BROKER_HEADER_BYTES, BROKER_QUEUE_DEPTH, BROKER_WORKERS, MAX_AGENT_OUTPUT_BYTES, PiRuntime, SessionIndexRuntime, SessionSummary, TerminalRuntime, conversation_ownership, peers, terminal_lookup};
use crate::process_io::{ensure_desktop_sessions_dir, shell_quote};
use crate::pi_launch::{PiLaunch, build_pi_command};
use crate::session_index::{collect_sessions, list_local_sessions};
use crate::environment::home_dir;
use crate::settings::{load_app_settings};

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
    let command = message_command(broker, &settings, session, client_id)?;
    let job = start_message_job(command, broker, request_id, deadline)?;
    let _writer = BrokerWriter { job: job.clone(), broker, request_id, _claim };
    write_message_input(&job.child, message)?;
    let status = wait_message(broker, request_id, &job.child, &job.output, deadline);
    message_output(&job.output, status)
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
    output::recover();
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
        ("POST", "/cancel") => (|| {
            let value: Value = serde_json::from_slice(&body).map_err(|_| "Invalid cancellation request".to_string())?;
            let request_id = value.get("requestId").and_then(Value::as_str).filter(|value| Uuid::parse_str(value).is_ok()).ok_or("requestId is required")?;
            let mut cancelled = broker.cancelled.lock().map_err(|_| "Broker cancellation lock was poisoned")?;
            if cancelled.len() >= BROKER_QUEUE_DEPTH * 2 { cancelled.clear(); }
            cancelled.insert(request_id.to_string()); drop(cancelled);
            peers::cancel_message(&app, request_id)?;
            let job = broker.jobs.lock().map_err(|_| "Broker job lock was poisoned")?.get(request_id).cloned();
            if let Some(job) = job { stop_locked_message(&job.child); }
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

struct MessageJob { child: Mutex<Child>, output: MessageOutput }

fn start_message_job(mut command: Command, broker: &BrokerRuntime, request_id: &str, deadline: Instant) -> Result<Arc<MessageJob>, String> {
    let mut jobs = broker.jobs.lock().map_err(|_| "Broker job lock was poisoned")?;
    if broker.closing.load(Ordering::SeqCst) { return Err("App is closing".into()); }
    if jobs.contains_key(request_id) { return Err("Agent message request is already running".into()); }
    if Instant::now() >= deadline { return Err("Agent message expired".into()); }
    if broker.cancelled.lock().map_err(|_| "Broker cancellation lock was poisoned")?.remove(request_id) { return Err("Agent message was cancelled".into()); }
    let output = MessageOutput::prepare(&mut command)?;
    let child = command.spawn().map_err(|error| format!("Could not message agent: {error}"));
    drop(command);
    let job = Arc::new(MessageJob { child: Mutex::new(child?), output });
    jobs.insert(request_id.into(), job.clone());
    Ok(job)
}

fn write_message_input(child: &Mutex<Child>, message: &str) -> Result<(), String> {
    let stdin = child.lock().map_err(|_| "Agent process lock was poisoned")?.stdin.take();
    let message = message.to_owned(); thread::spawn(move || { if let Some(mut stdin) = stdin { let _ = stdin.write_all(message.as_bytes()); } });
    Ok(())
}

fn wait_message(broker: &BrokerRuntime, request_id: &str, child: &Mutex<Child>, output: &MessageOutput, deadline: Instant) -> Result<ExitStatus, String> {
    loop {
        if broker.closing.load(Ordering::SeqCst) { return Err("App is closing".into()); }
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

fn message_output(output: &MessageOutput, status: Result<ExitStatus, String>) -> Result<String, String> {
    let status = status?;
    let output_bytes = fs::metadata(&output.stdout).map(|metadata| metadata.len()).unwrap_or(0)
        .saturating_add(fs::metadata(&output.stderr).map(|metadata| metadata.len()).unwrap_or(0));
    if output_bytes > MAX_AGENT_OUTPUT_BYTES { return Err("Agent output exceeded the 16 MiB limit".into()); }
    let stdout = fs::read(&output.stdout).map_err(|error| format!("Could not read agent output: {error}"))?;
    let stderr = fs::read(&output.stderr).map_err(|error| format!("Could not read agent errors: {error}"))?;
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
            collect_sessions(app, &session_index).map(|sessions| json!(sessions.into_iter().filter(|session| session.subagent_parent_id.is_none()).map(|session| json!({"hostId":session.host_id,"sessionId":session.id,"name":session.name,"project":session.project,"cwd":session.cwd,"active":busy.contains(&format!("{}\0{}", session.host_id, session.id)) || active.iter().any(|agent| agent_is_active(&session, agent))})).collect::<Vec<_>>()))
}

fn broker_message_sessions(app: &AppHandle, session_index: &SessionIndexRuntime, host_id: &str) -> Result<Vec<SessionSummary>, String> {
    if host_id == "local" { list_local_sessions(session_index, &ensure_desktop_sessions_dir(&home_dir()?)?) } else { collect_sessions(app, session_index) }
}

fn broker_orchestration(app: &AppHandle, broker: &BrokerRuntime, value: Value) -> Result<Value, String> {
    let host = value["hostId"].as_str().ok_or("hostId is required")?;
    if host != "local" {
        let result = peers::forward_broker(app, host, "/orchestration", value.clone())?;
        return broker_interruption_status(broker, &value, result);
    }
    let (id, action) = orchestration_target(&value)?;
    if matches!(action, "interrupt" | "locate" | "read") {
        let settings = load_app_settings(app.clone())?;
        let runtime = app.state::<PiRuntime>();
        let daemon = crate::daemon::connect(app, &runtime, broker, &settings, host)?;
        let result = daemon.request(json!({"type":"orchestration","action":action,"sessionKey":id,"deliveryId":value["deliveryId"]}))?;
        return broker_interruption_status(broker, &value, result);
    }
    broker_conversation_operation(app, broker, &value, host, id, action)
}

fn broker_conversation_operation(app: &AppHandle, broker: &BrokerRuntime, value: &Value, host: &str, id: &str, action: &str) -> Result<Value, String> {
    let settings = load_app_settings(app.clone())?;
    let runtime = app.state::<PiRuntime>();
    let daemon = crate::daemon::connect(app, &runtime, broker, &settings, host)?;
    let location = daemon.request(json!({"type":"orchestration","action":"locate","sessionKey":id}))?;
    if location["archived"] == true { return Err("This conversation is archived. Restore it before sending another task".into()); }
    let path = location["sessionPath"].as_str().ok_or("Conversation lookup returned no saved path")?;
    let cwd = location["cwd"].as_str().ok_or("Conversation lookup returned no working directory")?;
    let mut packet = json!({"type":"orchestration","action":action,"sessionKey":id,"sessionPath":path,
        "sourceSessionId":value["sourceSessionId"],"sourceHostId":value["sourceHostId"],"message":value["message"],"wake":value["wake"],"clientId":value["clientId"],"deliveryId":value["deliveryId"],"deadline":value["deadline"],"recoveryDepth":value["recoveryDepth"]});
    if matches!(action, "send" | "recover_usage") {
        let mut command = build_pi_command(broker, &settings, host, PiLaunch::Rpc { cwd: Some(cwd), session_path: Some(path), session_id: None, fork_path: None }, daemon.remote_port)?;
        if action == "recover_usage" { command.env("PIOP_USAGE_RECOVERY", "1"); }
        packet["spec"] = crate::daemon::spec(&command);
        packet["cwd"] = json!(cwd);
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
    if !matches!(action, "read" | "send" | "interrupt" | "recover_usage" | "locate") { return Err("Unknown orchestration action".into()); }
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
    jobs: Arc<Mutex<HashMap<String, Arc<MessageJob>>>>,
    cancelled: Arc<Mutex<HashSet<String>>>,
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

struct BrokerWriter<'a> { job: Arc<MessageJob>, broker: &'a BrokerRuntime, request_id: &'a str, _claim: BusyAgent }

impl Drop for BrokerWriter<'_> {
    fn drop(&mut self) {
        let mut child = self.job.child.lock().unwrap_or_else(|error| error.into_inner());
        stop_message_worker(&mut child);
        drop(child);
        self.broker.jobs.lock().unwrap_or_else(|error| error.into_inner()).remove(self.request_id);
        self.broker.cancelled.lock().unwrap_or_else(|error| error.into_inner()).remove(self.request_id);
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
            || !self.deliveries.lock().map_err(|_| "Broker deliveries unavailable")?.is_empty();
        if active { return Err("Wait for active broker requests to finish before restarting the daemon".into()); }
        Ok(())
    }

    pub(super) fn shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        let jobs = self.jobs.lock().unwrap_or_else(|error| error.into_inner()).drain().map(|(_, job)| job).collect::<Vec<_>>();
        for job in jobs {
            let mut child = job.child.lock().unwrap_or_else(|error| error.into_inner());
            stop_message_worker(&mut child);
            job.output.remove();
        }
    }

    pub(super) fn with_uncancelled_request<T>(&self, id: &str, register: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let mut cancelled = self.cancelled.lock().map_err(|_| "Broker cancellation unavailable")?;
        if cancelled.remove(id) { return Err("Agent message was cancelled".into()); }
        register()
    }
}
