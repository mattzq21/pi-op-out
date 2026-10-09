use std::{collections::HashMap, sync::{Arc, Mutex, atomic::AtomicU64}};
use crate::broker::claim_agent;
use serde_json::json;
use serde_json::Value;
use std::thread;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::atomic::Ordering;
use crate::platform::AppHandle;
use crate::platform::State;
use uuid::Uuid;
use crate::{AgentAddress, AppSettings, BlankSessionCleanup, BrokerRuntime, BusyAgent, RemoteHost, cleanup_blank_session, daemon};
use crate::archives::{archived_session_file, desktop_session_file};
use crate::pi_launch::{PiLaunch, build_pi_command, remote_host, session_identity};
use crate::session_index::{validate_session_working_directory};
use crate::settings::{load_app_settings};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StartPiOptions { pub(super) runtime_id: String, pub(super) cwd: Option<String>, pub(super) session_path: Option<String>, pub(super) session_id: Option<String>, pub(super) fork_path: Option<String>, pub(super) host_id: Option<String>, pub(super) presence: Option<Value>, pub(super) client_id: String }

struct PreparedPiSession {
    host_id: String,
    session_id: Option<String>,
    session_path: Option<String>,
    fork_path: Option<String>,
}

impl PreparedPiSession {
    fn claim_id(&self, settings: &AppSettings) -> Result<Option<String>, String> {
        if let Some(id) = &self.session_id { return Ok(Some(id.clone())); }
        self.session_path.as_deref().map(|path| session_identity(settings, &self.host_id, path)).transpose()
    }

    fn claim(&self, broker: &BrokerRuntime, claim_id: Option<&str>, presence: Option<&Value>) -> Result<Option<BusyAgent>, String> {
        if presence.is_some_and(|value| value["readOnly"] == true) {
            if self.session_path.is_none() || self.fork_path.is_some() {
                return Err("A read-only view requires a saved conversation".into());
            }
            return Ok(None);
        }
        claim_id.map(|id| claim_agent(broker, &self.host_id, id)).transpose()
    }

    fn launch<'a>(&'a self, options: &'a StartPiOptions) -> PiLaunch<'a> {
        PiLaunch::Rpc {
            cwd: options.cwd.as_deref(),
            session_path: self.session_path.as_deref(),
            session_id: self.session_id.as_deref(),
            fork_path: self.fork_path.as_deref(),
        }
    }
}

fn prepare_pi_session(settings: &AppSettings, host_id: String, options: &StartPiOptions) -> Result<PreparedPiSession, String> {
    let session_id = options.session_id.clone().or_else(|| (options.session_path.is_none() && options.fork_path.is_none()).then(|| Uuid::new_v4().to_string()));
    let session_path = saved_pi_path(settings, &host_id, options)?;
    let fork_path = options.fork_path.as_deref().map(|path| desktop_session_file(settings, &host_id, path)).transpose()?;
    Ok(PreparedPiSession { host_id, session_id, session_path, fork_path })
}

fn saved_pi_path(settings: &AppSettings, host_id: &str, options: &StartPiOptions) -> Result<Option<String>, String> {
    let archived = options.presence.as_ref().is_some_and(|presence| presence["readOnly"] == true && presence["archived"] == true);
    options.session_path.as_deref().map(|path| {
        if archived { archived_session_file(settings, host_id, path) } else { desktop_session_file(settings, host_id, path) }
    }).transpose()
}

pub(super) fn ensure_runtime_owner(runtime: &PiRuntime, runtime_id: &str, owner: &str) -> Result<(), String> {
    if runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get(runtime_id).is_some_and(|process| process.window_label != owner) {
        return Err("Runtime belongs to another connection".into());
    }
    Ok(())
}

fn runtime_is_attached(runtime: &PiRuntime, runtime_id: &str, settings: &AppSettings, host_id: &str) -> Result<bool, String> {
    Ok(runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get(runtime_id).is_some_and(|process| process.daemon.alive.load(Ordering::SeqCst) && process.daemon.matches_connection(settings, host_id)))
}

fn session_launch_settings(app: AppHandle, host_id: &str, cwd: Option<&str>, read_only: bool) -> Result<AppSettings, String> {
    let settings = load_app_settings(app)?;
    if host_id == "local" && !settings.local_enabled { return Err("Local machine is disabled. Enable it in Settings → Machines.".into()); }
    if !read_only { validate_session_working_directory(&settings, host_id, cwd)?; }
    Ok(settings)
}

pub(super) fn start_pi_for_owner(app: AppHandle, owner: String, runtime: State<PiRuntime>, broker: State<BrokerRuntime>, options: StartPiOptions) -> Result<Value, String> {
    let _lifecycle = runtime.lifecycle.lock().map_err(|_| "Runtime lifecycle lock was poisoned")?;
    ensure_runtime_owner(&runtime, &options.runtime_id, &owner)?;
    let host_id = options.host_id.clone().unwrap_or_else(|| "local".into());
    let read_only = options.presence.as_ref().is_some_and(|presence| presence["readOnly"] == true);
    let settings = session_launch_settings(app.clone(), &host_id, options.cwd.as_deref(), read_only)?;
    if runtime_is_attached(&runtime, &options.runtime_id, &settings, &host_id)? { return Ok(json!({"attached":true})); }
    let session = prepare_pi_session(&settings, host_id, &options)?;
    let claim_id = session.claim_id(&settings)?;
    let _agent_claim = session.claim(&broker, claim_id.as_deref(), options.presence.as_ref())?;
    attach_pi_session(&app, owner, &runtime, &broker, &settings, options, (session, claim_id))
}

fn attach_pi_session(app: &AppHandle, owner: String, runtime: &PiRuntime, broker: &BrokerRuntime, settings: &AppSettings, options: StartPiOptions, prepared: (PreparedPiSession, Option<String>)) -> Result<Value, String> {
    let (session, claim_id) = prepared;
    let daemon = daemon::connect(app, runtime, broker, settings, &session.host_id)?;
    let command = build_pi_command(broker, settings, &session.host_id, session.launch(&options), daemon.remote_port)?;
    let StartPiOptions { runtime_id, cwd, presence, client_id, .. } = options;
    let PreparedPiSession { host_id, session_id, session_path, .. } = session;
    let result = daemon.request(json!({"type":"attach","clientId":client_id,"runtimeId":runtime_id,"sessionKey":claim_id.unwrap_or_else(|| runtime_id.clone()),"spec":daemon::spec(&command),"timeout":630_000,"cwd":cwd,"presence":presence.unwrap_or_else(|| json!({}))}))?;
    let blank_cleanup = BlankSessionCleanup { path: session_path.clone(), id: session_id.clone(), host: if host_id == "local" { None } else { Some(remote_host(settings, &host_id)?.clone()) }, submitted: false };
    runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.insert(runtime_id.clone(), PiProcess { daemon, window_label: owner, blank_cleanup });
    runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.insert(runtime_id, AgentAddress { host_id, session_id, session_path, worktree: cwd, working: false, messageable: result["owned"].as_bool() == Some(false) });
    Ok(result)
}

pub(super) fn detach_pi(runtime: &PiRuntime, runtime_id: &str, discard_blank: bool) -> Result<bool, String> {
    detach_pi_with(runtime, runtime_id, discard_blank, false)
}

pub(super) fn detach_pi_with(runtime: &PiRuntime, runtime_id: &str, discard_blank: bool, preserve_running: bool) -> Result<bool, String> {
    let mut stopped = false;
    let process = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.remove(runtime_id);
    if let Some(mut process) = process {
        let result = process.daemon.request(json!({"type":"detach","runtimeId":runtime_id,"discardBlank":discard_blank,"preserveRunning":preserve_running}))?;
        if result["stopped"].as_bool() == Some(true) {
            stopped = true;
            process.blank_cleanup.submitted |= result["submitted"].as_bool().unwrap_or(false);
            if discard_blank { cleanup_blank_session(process.blank_cleanup); }
        }
    }
    runtime.active_agents.lock().map_err(|_| "Active agent lock was poisoned")?.remove(runtime_id);
    Ok(stopped)
}
pub(super) fn stop_pi(runtime: State<PiRuntime>, runtime_id: String, discard_blank: Option<bool>) -> Result<bool, String> {
    detach_pi(&runtime, &runtime_id, discard_blank.unwrap_or(false))
}
pub(super) fn pi_presence(runtime: State<PiRuntime>, runtime_id: String, presence: Value) -> Result<(), String> {
    let daemon = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get(&runtime_id).map(|process| process.daemon.clone());
    if let Some(daemon) = daemon { daemon.request(json!({"type":"presence","runtimeId":runtime_id,"presence":presence}))?; }
    Ok(())
}

fn execute_pi_command(runtime: &PiRuntime, runtime_id: &str, command: Value) -> Result<Value, String> {
    let daemon = runtime.processes.lock().map_err(|_| "Pi runtime lock was poisoned")?.get(runtime_id).map(|process| process.daemon.clone()).ok_or("Pi is not running")?;
    daemon.request(json!({"type":"command","runtimeId":runtime_id,"command":command}))
}
pub(super) fn pi_command(app: AppHandle, runtime: State<PiRuntime>, broker: State<BrokerRuntime>, runtime_id: String, mut command: Value) -> Result<Value, String> {
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
    match command_type { "get_snapshot" | "fork" | "fork_after" | "clone" => result.get("state"), "get_state" => Some(result), _ => None }
}

fn open_system_resource(target: &std::ffi::OsStr) -> Result<(), String> {
    let program = if cfg!(target_os = "macos") { "open" } else if cfg!(target_os = "windows") { "explorer" } else { "xdg-open" };
    let mut child = Command::new(program).arg(target).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|error| format!("Could not open {}: {error}", target.to_string_lossy()))?;
    thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}

pub(super) fn open_project_directory(app: AppHandle, cwd: String, host_id: Option<String>) -> Result<(), String> {
    if host_id.as_deref().unwrap_or("local") != "local" {
        let settings = load_app_settings(app)?;
        let host = remote_host(&settings, host_id.as_deref().unwrap_or_default())?;
        return open_project_directory_with(&cwd, Some(host), open_system_resource);
    }
    open_project_directory_with(&cwd, None, open_system_resource)
}

pub(super) fn open_project_directory_with(cwd: &str, host: Option<&RemoteHost>, open: impl FnOnce(&std::ffi::OsStr) -> Result<(), String>) -> Result<(), String> {
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

pub(super) fn detach_owner(runtime: &PiRuntime, owner: &str, discard_blank: bool) {
    let ids = runtime.processes.lock().map(|processes| processes.iter().filter(|(_, process)| process.window_label == owner).map(|(id, _)| id.clone()).collect::<Vec<_>>()).unwrap_or_default();
    for id in ids { let _ = detach_pi_with(runtime, &id, discard_blank, !discard_blank); }
}

pub(super) fn shutdown(runtime: &PiRuntime) {
    let daemons = runtime.connections.snapshot();
    for daemon in &daemons { daemon.shutdown(); }
    for daemon in daemons { daemon.wait_shutdown(); }
}

pub(super) fn update_runtime_snapshot(runtime: &PiRuntime, runtime_id: &str, state: &Value) -> Result<(), String> {
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

struct PiProcess {
    daemon: Arc<daemon::Daemon>,
    window_label: String,
    blank_cleanup: BlankSessionCleanup,
}

#[derive(Default)]
pub(super) struct PiRuntime {
    pub(super) setups: crate::git_ops::worktree_setup::WorktreeSetups,
    pub(super) connections: daemon::DaemonRegistry,
    processes: Arc<Mutex<HashMap<String, PiProcess>>>,
    pub(super) lifecycle: Mutex<()>,
    pub(super) agent_config_revision: AtomicU64,
    pub(super) agent_config_revisions: Mutex<HashMap<String, u64>>,
    pub(super) active_agents: Arc<Mutex<HashMap<String, AgentAddress>>>,
}

impl PiRuntime {
    pub(super) fn contains_process(&self, id: &str) -> Result<bool, String> {
        Ok(self.processes.lock().map_err(|_| "Runtime registry unavailable")?.contains_key(id))
    }
    pub(super) fn disconnect_daemon(&self, daemon: &Arc<daemon::Daemon>) -> Vec<String> {
        self.processes.lock().map(|mut processes| {
            let ids: Vec<_> = processes.iter().filter(|(_, process)| Arc::ptr_eq(&process.daemon, daemon)).map(|(id, _)| id.clone()).collect();
            for id in &ids { processes.remove(id); } ids
        }).unwrap_or_default()
    }
    pub(super) fn disconnect_process(&self, id: &str, daemon: &Arc<daemon::Daemon>) -> bool {
        self.processes.lock().map(|mut processes| {
            if !processes.get(id).is_some_and(|process| Arc::ptr_eq(&process.daemon, daemon)) { return false; }
            processes.remove(id); true
        }).unwrap_or(false)
    }
}
