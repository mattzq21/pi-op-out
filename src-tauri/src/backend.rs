#[cfg(not(feature = "desktop"))]
mod mobile;
#[cfg(not(feature = "desktop"))]
mod mobile_commands;
mod daemon_clients;
#[cfg(not(feature = "desktop"))]
mod peers;
#[cfg(not(feature = "desktop"))]
mod daemon_stdio;
mod platform;
mod daemon_endpoint;
#[cfg(feature = "desktop")]
mod desktop_daemon;
mod provider_auth;
mod conversation_ownership;
mod session_groups;
mod terminal_lookup;
#[cfg(not(feature = "desktop"))]
mod daemon;
mod dictation;
mod project_files;
#[cfg(not(feature = "desktop"))]
#[cfg(not(feature = "desktop"))]
use session_groups::load_session_groups;
use session_groups::change_session_groups;

use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{mpsc, Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}},
    thread,
    time::{Duration, Instant, SystemTime},
};
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use crate::platform::{AppHandle, State};
#[cfg(feature = "desktop")]
use tauri::{Emitter, Manager};
use uuid::Uuid;
use walkdir::WalkDir;

const STORAGE_DIRECTORY: &str = if cfg!(debug_assertions) { ".piop-dev" } else { ".piop" };
const DEVELOPMENT: bool = cfg!(debug_assertions);
#[cfg(feature = "desktop")]
const APP_TITLE: &str = if DEVELOPMENT { "Piop Dev" } else { "piop" };

fn node_command() -> Command {
    let mut command = Command::new("node");
    command.env("PIOP_STORAGE_DIRECTORY", STORAGE_DIRECTORY);
    command
}

struct PiProcess {
    daemon: Arc<daemon::Daemon>,
    window_label: String,
    blank_cleanup: BlankSessionCleanup,
}

struct BlankSessionCleanup { path: Option<String>, id: Option<String>, host: Option<RemoteHost>, submitted: bool }

fn cleanup_blank_session(target: BlankSessionCleanup) {
    if target.submitted { return; }
    let root = if target.host.is_none() { home_dir().ok().map(|home| home.join(STORAGE_DIRECTORY).join("sessions")) } else { None };
    cleanup_blank_session_at(target, root.as_deref());
}

fn cleanup_blank_session_at(target: BlankSessionCleanup, root: Option<&Path>) {
    if target.submitted { return; }
    let script = include_str!("../resources/cleanup-blank-session.cjs");
    let arguments = json!({"path":target.path,"id":target.id,"root":root}).to_string();
    let result = if let Some(host) = target.host {
        ssh(&host).arg(remote_login_command(&format!("PIOP_STORAGE_DIRECTORY={STORAGE_DIRECTORY} node -e {} {}", shell_quote(script), shell_quote(&arguments)))).output()
    } else { node_command().arg("-e").arg(script).arg(arguments).output() };
    match result {
        Ok(output) if output.status.success() => {},
        Ok(output) => eprintln!("Could not clean up blank session: {}", String::from_utf8_lossy(&output.stderr)),
        Err(error) => eprintln!("Could not clean up blank session: {error}"),
    }
}

#[derive(Clone)]
enum EphemeralSession {
    Local(PathBuf),
    Remote { host: RemoteHost, path: String },
}

struct TerminalProcess {
    generation: Uuid,
    session_key: String,
    cwd: String,
    host_id: String,
    window_label: String,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn PtyChild + Send + Sync>,
    writer: mpsc::SyncSender<String>,
}

#[derive(Default)]
struct TerminalRuntime {
    processes: Arc<Mutex<HashMap<String, TerminalProcess>>>,
    history: Arc<Mutex<HashMap<String, terminal_lookup::Transcript>>>,
}

#[derive(Clone)]
struct CachedSession { fingerprint: String, summary: SessionSummary }

#[derive(Default)]
struct SessionIndexRuntime {
    local: Mutex<HashMap<PathBuf, CachedSession>>,
    remote: Mutex<HashMap<String, HashMap<String, CachedSession>>>,
}

const MAX_TERMINALS: usize = 8;
const MAX_REMOTE_HOSTS: usize = 16;
const BROKER_WORKERS: usize = 8;
const BROKER_QUEUE_DEPTH: usize = 32;
const BROKER_HEADER_BYTES: usize = 16 * 1024;
const BROKER_BODY_BYTES: usize = 1024 * 1024;
const MAX_GIT_CHANGED_PATHS: usize = 4096;
const MAX_GIT_PATH_LIST_BYTES: usize = 1024 * 1024;
const MAX_GIT_SNAPSHOT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_GIT_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_GIT_PATCH_BYTES: usize = 4 * 1024 * 1024;
const MAX_GIT_DIFFS_BYTES: usize = 16 * 1024 * 1024;
const MAX_AGENT_OUTPUT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SESSION_INDEX_BATCH_BYTES: usize = 64 * 1024 * 1024;
const WORKTREE_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
struct WorktreeSetupOwners { setups: HashMap<String, String>, detached: HashSet<String> }

#[derive(Default)]
struct PiRuntime {
    worktree_setups: Mutex<HashMap<String, Arc<AtomicBool>>>,
    worktree_setup_owners: Mutex<WorktreeSetupOwners>,
    ephemeral_sessions: Mutex<HashMap<String, EphemeralSession>>,
    ephemeral_previous: Mutex<HashMap<String, Vec<EphemeralSession>>>,
    ephemeral_keys: Mutex<HashMap<String, String>>,
    processes: Arc<Mutex<HashMap<String, PiProcess>>>,
    daemons: Mutex<HashMap<String, Arc<daemon::Daemon>>>,
    lifecycle: Mutex<()>,
    agent_config_revision: AtomicU64,
    agent_config_revisions: Mutex<HashMap<String, u64>>,
    active_agents: Arc<Mutex<HashMap<String, AgentAddress>>>,
}

#[derive(Clone)]
struct AgentAddress { host_id: String, session_id: Option<String>, session_path: Option<String>, worktree: Option<String>, presence_id: Option<String>, working: bool, messageable: bool }

#[derive(Clone)]
struct BrokerRuntime {
    closing: Arc<AtomicBool>,
    message_count: Arc<Mutex<usize>>,
    port: Arc<Mutex<u16>>,
    token: String,
    busy: Arc<Mutex<HashSet<String>>>,
    jobs: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
    cancelled: Arc<Mutex<HashSet<String>>>,
    operations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl Default for BrokerRuntime {
    fn default() -> Self {
        Self {
            closing: Arc::new(AtomicBool::new(false)), message_count: Arc::new(Mutex::new(0)),
            port: Arc::new(Mutex::new(0)),
            token: Uuid::new_v4().to_string(),
            busy: Arc::new(Mutex::new(HashSet::new())),
            jobs: Arc::new(Mutex::new(HashMap::new())),
            cancelled: Arc::new(Mutex::new(HashSet::new())),
            operations: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

struct BusyAgent { key: String, busy: Arc<Mutex<HashSet<String>>> }

impl Drop for BusyAgent {
    fn drop(&mut self) { if let Ok(mut busy) = self.busy.lock() { busy.remove(&self.key); } }
}

fn claims_dir() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(STORAGE_DIRECTORY).join("session-claims");
    ensure_private_dir(&dir)?;
    Ok(dir)
}

fn claim_session_id(id: &str) -> Result<fs::File, String> {
    let id = Uuid::parse_str(id).map_err(|_| "Invalid session identity")?.to_string();
    let dir = claims_dir()?;
    let name = format!("id-{}.lock", hash_claim_key(id.as_bytes()));
    let file = dir.join(&name);
    let mut options = OpenOptions::new(); options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let handle = options.open(&file).map_err(|error| format!("Could not open a session claim: {error}"))?;
    handle.try_lock().map_err(|error| match error {
        fs::TryLockError::WouldBlock => "This conversation is open in another window or daemon".to_string(),
        fs::TryLockError::Error(error) => format!("Could not lock the session claim: {error}"),
    })?;
    Ok(handle)
}

pub fn run_session_worker() {
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new("--piop-session-worker")) { return; }
    let error = exec_session_worker().unwrap_err();
    eprintln!("piop session: {error}");
    std::process::exit(1);
}

#[cfg(unix)]
fn worker_session_identity(path: &str) -> Result<String, String> {
    let mut line = String::new();
    BufReader::new(fs::File::open(path).map_err(|error| error.to_string())?).take(64 * 1024).read_line(&mut line).map_err(|error| error.to_string())?;
    serde_json::from_str::<Value>(&line).map_err(|error| error.to_string())?["id"].as_str().ok_or("Missing session identity").map(str::to_owned).map_err(str::to_owned)
}

#[cfg(unix)]
fn exec_session_worker() -> Result<(), String> {
    use std::os::{fd::AsRawFd, unix::process::CommandExt};
    let mut arguments = std::env::args_os().skip(2);
    let program = arguments.next().ok_or("Missing Pi executable")?;
    let mut arguments: Vec<_> = arguments.collect();
    let value = |flag: &str| arguments.iter().rposition(|arg| arg == flag).and_then(|index| arguments.get(index + 1)).map(|arg| arg.to_string_lossy().into_owned());
    let id = if let Some(path) = value("--session") {
        worker_session_identity(&path)?
    } else if let Some(id) = value("--session-id") { id } else {
        let id = Uuid::new_v4().to_string();
        arguments.extend(["--session-id".into(), id.clone().into()]);
        id
    };
    let claim = claim_session_id(&id)?;
    let fd = claim.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } < 0 { return Err(std::io::Error::last_os_error().to_string()); }
    Err(Command::new(program).args(arguments).exec().to_string())
}

#[cfg(not(unix))]
fn exec_session_worker() -> Result<(), String> { Err("Session worker locking requires a Unix host".into()) }

fn hash_claim_key(bytes: &[u8]) -> String {
    use sha2::Digest;
    use std::fmt::Write;
    let digest = sha2::Sha256::digest(bytes);
    digest.iter().take(20).fold(String::new(), |mut out, byte| { let _ = write!(out, "{byte:02x}"); out })
}

mod process_cleanup;
use process_cleanup::stop_message_worker;

struct BrokerWriter { child: Arc<Mutex<Child>>, _claim: BusyAgent }

impl Drop for BrokerWriter {
    fn drop(&mut self) {
        let mut child = self.child.lock().unwrap_or_else(|error| error.into_inner());
        stop_message_worker(&mut child);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ProjectKind { NoRepo, Main, Worktree }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSummary {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    subagent_parent_id: Option<String>,
    group_id: Option<String>,
    path: String,
    name: String,
    project: String,
    cwd: String,
    cwd_exists: bool,
    project_kind: Option<ProjectKind>,
    project_root: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    branch_appearance: Option<Value>,
    #[serde(skip)]
    modified_at: u64,
    preview: String,
    message_count: usize,
    last_message_at: u64,
    api_cost: f64,
    host_id: String,
    host_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteHost {
    id: String,
    name: String,
    target: String,
    #[serde(default = "default_pi_path")]
    pi_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexUsage {
    remaining_percent: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    reset_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpencodeGoUsageWindow {
    status: String,
    remaining_percent: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    reset_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpencodeGoUsage {
    rolling: OpencodeGoUsageWindow,
    weekly: OpencodeGoUsageWindow,
    monthly: OpencodeGoUsageWindow,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryListing {
    path: String,
    parent: Option<String>,
    directories: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TemporaryChat {
    cwd: String,
    session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageCategory {
    id: String,
    byte_size: u64,
    item_count: usize,
    #[serde(default)]
    estimated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchivedConversation {
    id: String,
    path: String,
    name: String,
    cwd: String,
    modified_at: u64,
    byte_size: u64,
    deletable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    delete_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    worktree_path: Option<String>,
    #[serde(default)]
    restorable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    restore_error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageInventory {
    categories: Vec<StorageCategory>,
    archives: Vec<ArchivedConversation>,
    #[serde(default)]
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostStorage {
    host_id: String,
    host_name: String,
    categories: Vec<StorageCategory>,
    archives: Vec<ArchivedConversation>,
    warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageReport { hosts: Vec<HostStorage> }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffToolPathMapping { tool_call_id: String, path: String, absolute_path: String, canonical_path: String }

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum GitDiffSnapshot {
    Legacy(String),
    Located {
        patch: String,
        #[serde(rename = "repositoryRoot")]
        repository_root: String,
        #[serde(default, rename = "toolPaths", skip_serializing_if = "Vec::is_empty")]
        tool_paths: Vec<DiffToolPathMapping>,
    },
}

type GitDiffSnapshots = HashMap<String, GitDiffSnapshot>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    #[serde(default)]
    worktree_setup_scripts: Vec<WorktreeSetupScript>,
    #[serde(default = "default_agent")]
    default_agent: String,
    default_model: String,
    #[serde(default)]
    hidden_models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    known_models: Option<Vec<String>>,
    default_thinking: String,
    #[serde(default)]
    default_fast_mode: bool,
    #[serde(default = "default_context_window_cap", deserialize_with = "deserialize_context_window_cap")]
    context_window_cap: u64,
    #[serde(default = "default_context_window_cap_enabled")]
    context_window_cap_enabled: bool,
    #[serde(default = "default_true")]
    auto_retry: bool,
    #[serde(default)]
    debug_mode: bool,
    #[serde(default = "default_keybindings")]
    keybindings: HashMap<String, String>,
    tools: Vec<Value>,
    skills: Vec<Value>,
    #[serde(default)]
    hosts: Vec<RemoteHost>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeSetupScript {
    id: String, name: String, script: String, enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cleanup_script: Option<String>,
    #[serde(default)]
    project_path: Option<String>,
    #[serde(default)]
    host_id: Option<String>,
}

#[cfg(test)]
mod tests;

include!("backend/defaults_usage.rs");
include!("backend/settings_storage.rs");
include!("backend/extensions.rs");
include!("backend/settings.rs");
include!("backend/worktree_setup.rs");
include!("backend/snapshot_capture.rs");
include!("backend/worktrees.rs");
include!("backend/git_diffs.rs");
include!("backend/pi_launch.rs");
include!("backend/pi_runtime.rs");
include!("backend/session_index.rs");
include!("backend/archives.rs");
include!("backend/broker.rs");
include!("backend/lifecycle.rs");
